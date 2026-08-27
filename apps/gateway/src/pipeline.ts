import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RedisClient } from "@sentinel/redis";
import { getTemporaryBlock, setTemporaryBlock } from "@sentinel/redis";
import type { ApiKeyRepository, BlockRepository, RequestLogRepository, SecurityEventRepository } from "@sentinel/database";
import type { RateLimiter } from "@sentinel/rate-limiter";
import type { AbuseDetector } from "@sentinel/abuse-detector";
import type { GatewayDecision, GatewayErrorBody, Identity, RateLimitResult, SecurityEventType } from "@sentinel/shared";
import type { Logger } from "@sentinel/logger";
import { PolicyCache } from "./policy-cache.js";
import { resolveIdentity } from "./identity.js";
import { forwardToBackend } from "./proxy.js";
import { MetricsStore } from "./metrics.js";
import { shouldEmitEvent } from "./event-dedupe.js";

export interface PipelineDeps {
  redis: RedisClient;
  policyCache: PolicyCache;
  rateLimiter: RateLimiter;
  abuseDetector: AbuseDetector;
  apiKeys: ApiKeyRepository;
  securityEvents: SecurityEventRepository;
  requestLogs: RequestLogRepository;
  blocks: BlockRepository;
  metrics: MetricsStore;
  logger: Logger;
  backendUrl: string;
}

const TEMP_BLOCK_TTL_SECONDS = 300; // 5 minutes, per spec's temporary-blocking example
const THROTTLE_DELAY_MS = 400;

const RULE_TO_EVENT_TYPE: Record<string, SecurityEventType> = {
  "burst-detection": "ABUSE_DETECTED",
  "repeated-auth-failures": "AUTH_FAILURE",
  "endpoint-scanning": "ENDPOINT_SCANNING",
  "high-error-rate": "HIGH_ERROR_RATE",
};

function identityString(id: Identity): string {
  return `${id.type}:${id.value}`;
}

function pickMostRestrictive(results: RateLimitResult[]): RateLimitResult | null {
  if (results.length === 0) return null;
  const blocked = results.find((r) => !r.allowed);
  if (blocked) return blocked;
  return results.reduce((min, r) => (r.remaining < min.remaining ? r : min), results[0]!);
}

function sendError(reply: FastifyReply, status: number, body: GatewayErrorBody): void {
  reply.code(status).send(body);
}

export async function handleProxyRequest(req: FastifyRequest, reply: FastifyReply, deps: PipelineDeps): Promise<void> {
  const startedAt = Date.now();
  const requestId = randomUUID();
  reply.header("X-Request-ID", requestId);

  const path = req.url.split("?")[0] ?? req.url;
  const method = req.method;
  const ip = req.ip;

  const { ip: ipIdentity, apiKey } = await resolveIdentity(ip, req.headers["x-api-key"] as string | undefined, deps.apiKeys);

  if (apiKey?.revoked) {
    sendError(reply, 401, { error: "UNAUTHORIZED", message: "API key has been revoked", requestId });
    return;
  }

  const identities: Identity[] = apiKey ? [ipIdentity, apiKey] : [ipIdentity];
  const primaryIdentityStr = identityString(apiKey ?? ipIdentity);

  let decision: GatewayDecision = "ALLOW";
  let finalStatus: number;
  let matchedPolicyName: string | undefined;
  let mostRestrictive: RateLimitResult | null = null;

  // 1. Temporary block check (checks IP and API key identities, whichever are present).
  for (const identity of identities) {
    const block = await getTemporaryBlock(deps.redis, identityString(identity)).catch(() => null);
    if (block) {
      decision = "BLOCK";
      finalStatus = 403;
      sendError(reply, 403, {
        error: "ABUSE_BLOCKED",
        message: `Temporarily blocked: ${block.reason}`,
        retryAfter: block.ttlSeconds,
        requestId,
      });
      await finalize({ deps, req, requestId, path, method, ip, identityStr: primaryIdentityStr, decision, status: finalStatus, startedAt, policyName: matchedPolicyName, riskScore: undefined, apiKeyId: apiKey?.recordId });
      return;
    }
  }

  // 2. Policy-driven rate limiting — evaluate every matching enabled policy against every
  // identity type it cares about, and enforce the most restrictive result.
  const policies = deps.policyCache.matchingPolicies(path, method);
  const results: RateLimitResult[] = [];

  for (const policy of policies) {
    for (const identity of identities) {
      if (!policy.identityTypes.includes(identity.type)) continue;
      const result = await deps.rateLimiter.check(
        { policyName: policy.name, identity },
        {
          limit: policy.limit,
          windowSeconds: policy.windowSeconds,
          strategy: policy.strategy,
        }
      );
      results.push(result);
      if (!result.allowed) matchedPolicyName = policy.name;
    }
  }

  mostRestrictive = pickMostRestrictive(results);
  if (mostRestrictive) {
    reply.header("X-RateLimit-Limit", String(mostRestrictive.limit));
    reply.header("X-RateLimit-Remaining", String(mostRestrictive.remaining));
    reply.header("X-RateLimit-Reset", String(mostRestrictive.resetAt));
  }

  const rateLimitExceeded = results.some((r) => !r.allowed);
  if (rateLimitExceeded) {
    decision = "BLOCK";
    finalStatus = 429;
    const retryAfter = mostRestrictive?.retryAfterSeconds ?? 60;
    reply.header("Retry-After", String(retryAfter));
    sendError(reply, 429, {
      error: "RATE_LIMIT_EXCEEDED",
      message: "Too many requests",
      retryAfter,
      requestId,
    });

    if (await shouldEmitEvent(deps.redis, "RATE_LIMIT_EXCEEDED", primaryIdentityStr)) {
      await deps.securityEvents
        .create({
          type: "RATE_LIMIT_EXCEEDED",
          identityType: (apiKey ?? ipIdentity).type,
          identityValue: (apiKey ?? ipIdentity).value,
          route: path,
          metadata: { policyName: matchedPolicyName },
        })
        .catch((err) => deps.logger.error({ err: String(err) }, "failed to record security event"));
    }

    await finalize({ deps, req, requestId, path, method, ip, identityStr: primaryIdentityStr, decision, status: finalStatus, startedAt, policyName: matchedPolicyName, riskScore: undefined, apiKeyId: apiKey?.recordId });
    return;
  }

  // 3. Pre-request abuse assessment (cheap check based on existing history/score).
  const preAssessment = await deps.abuseDetector.getCurrentAssessment(ipIdentity);
  if (preAssessment.decision === "BLOCK") {
    decision = "BLOCK";
    finalStatus = 403;
    sendError(reply, 403, {
      error: "ABUSE_BLOCKED",
      message: "Request blocked due to high abuse risk score",
      requestId,
    });
    await finalize({ deps, req, requestId, path, method, ip, identityStr: primaryIdentityStr, decision, status: finalStatus, startedAt, policyName: matchedPolicyName, riskScore: preAssessment.score, apiKeyId: apiKey?.recordId });
    return;
  }
  if (preAssessment.decision === "THROTTLE") {
    decision = "THROTTLE";
    await new Promise((resolve) => setTimeout(resolve, THROTTLE_DELAY_MS));
  } else if (preAssessment.decision === "ALLOW_MONITOR") {
    decision = "ALLOW_MONITOR";
  }

  // 4. Forward to backend. Fastify parses JSON bodies into objects by default;
  // re-serialize so the backend receives an equivalent request body.
  const rawBody =
    req.body === undefined || req.body === null ? undefined : Buffer.from(JSON.stringify(req.body), "utf-8");
  const proxyResult = await forwardToBackend({
    backendUrl: deps.backendUrl,
    method,
    path: req.url,
    headers: req.headers as Record<string, string | string[] | undefined>,
    body: rawBody,
  });

  if (!proxyResult.ok) {
    finalStatus = 502;
    reply.code(502).send({ error: "BAD_GATEWAY", message: "Backend is unreachable", requestId } satisfies GatewayErrorBody);
  } else {
    finalStatus = proxyResult.response.status;
    for (const [key, value] of Object.entries(proxyResult.response.headers)) {
      reply.header(key, value);
    }
    reply.code(finalStatus).send(proxyResult.response.body);
  }

  // 5. Post-response abuse accounting — this is what actually updates history/score
  // for the NEXT request, and is where new blocks get triggered.
  const postAssessment = await deps.abuseDetector.recordAndAssess({
    identity: ipIdentity,
    path,
    method,
    status: finalStatus,
  });

  if (postAssessment.decision === "BLOCK") {
    const key = identityString(ipIdentity);
    const reason = postAssessment.breakdown.map((b) => b.rule).join(", ") || "risk score threshold exceeded";
    const wonRace = await setTemporaryBlock(deps.redis, key, reason, TEMP_BLOCK_TTL_SECONDS).catch((err) => {
      deps.logger.error({ err: String(err) }, "failed to set temporary block");
      return false;
    });

    // Only the request that actually created the block (SET NX succeeded)
    // persists the audit record and emits the event — otherwise concurrent
    // requests hitting BLOCK at the same time would each write a duplicate row.
    if (wonRace) {
      await deps.blocks
        .record({
          identityType: ipIdentity.type,
          identityValue: ipIdentity.value,
          reason,
          expiresAt: new Date(Date.now() + TEMP_BLOCK_TTL_SECONDS * 1000),
        })
        .catch((err) => deps.logger.error({ err: String(err) }, "failed to persist block record"));

      if (await shouldEmitEvent(deps.redis, "TEMPORARY_BLOCK", key)) {
        await deps.securityEvents
          .create({
            type: "TEMPORARY_BLOCK",
            identityType: ipIdentity.type,
            identityValue: ipIdentity.value,
            route: path,
            riskScore: postAssessment.score,
            metadata: { breakdown: postAssessment.breakdown },
          })
          .catch(() => undefined);
      }
    }
  }

  for (const entry of postAssessment.breakdown) {
    const eventType = RULE_TO_EVENT_TYPE[entry.rule];
    if (!eventType) continue;
    const key = identityString(ipIdentity);
    if (await shouldEmitEvent(deps.redis, eventType, key)) {
      await deps.securityEvents
        .create({
          type: eventType,
          identityType: ipIdentity.type,
          identityValue: ipIdentity.value,
          route: path,
          riskScore: postAssessment.score,
          metadata: { rule: entry.rule, reason: entry.reason },
        })
        .catch(() => undefined);
    }
  }

  await finalize({
    deps,
    req,
    requestId,
    path,
    method,
    ip,
    identityStr: primaryIdentityStr,
    decision,
    status: finalStatus,
    startedAt,
    policyName: matchedPolicyName,
    riskScore: postAssessment.score,
    apiKeyId: apiKey?.recordId,
  });
}

interface FinalizeInput {
  deps: PipelineDeps;
  req: FastifyRequest;
  requestId: string;
  path: string;
  method: string;
  ip: string;
  identityStr: string;
  decision: GatewayDecision;
  status: number;
  startedAt: number;
  policyName?: string;
  riskScore?: number;
  apiKeyId?: string;
}

async function finalize(input: FinalizeInput): Promise<void> {
  const latencyMs = Date.now() - input.startedAt;

  input.deps.metrics.recordRequest({
    path: input.path,
    status: input.status,
    latencyMs,
    decision: input.decision,
    apiKeyId: input.apiKeyId,
    ip: input.ip,
  });

  input.deps.logger.info(
    {
      requestId: input.requestId,
      method: input.method,
      path: input.path,
      status: input.status,
      latencyMs,
      identity: input.identityStr,
      decision: input.decision,
      policyName: input.policyName,
      riskScore: input.riskScore,
    },
    "request handled"
  );

  await input.deps.requestLogs
    .create({
      timestamp: new Date().toISOString(),
      requestId: input.requestId,
      method: input.method,
      path: input.path,
      status: input.status,
      latencyMs,
      identity: input.identityStr,
      decision: input.decision,
      policyName: input.policyName,
      riskScore: input.riskScore,
    })
    .catch((err) => input.deps.logger.error({ err: String(err) }, "failed to persist request log"));
}
