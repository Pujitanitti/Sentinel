import type { FastifyInstance } from "fastify";
import type {
  ApiKeyRepository,
  BlockRepository,
  PolicyRepository,
  RequestLogRepository,
  SecurityEventRepository,
} from "@sentinel/database";
import { removeTemporaryBlock, setTemporaryBlock, type RedisClient } from "@sentinel/redis";
import { requireAdminAuth } from "../admin-auth.js";
import { MetricsStore } from "../metrics.js";
import { PolicyCache } from "../policy-cache.js";
import { ApiKeyCreateSchema, BlockCreateSchema, LogFilterSchema, PolicyInputSchema, PolicyUpdateSchema, parseOrReject } from "../validation.js";

export interface AdminRouteDeps {
  policies: PolicyRepository;
  apiKeys: ApiKeyRepository;
  blocks: BlockRepository;
  securityEvents: SecurityEventRepository;
  requestLogs: RequestLogRepository;
  metrics: MetricsStore;
  policyCache: PolicyCache;
  redis: RedisClient;
  jwtSecret: string;
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  app.addHook("preHandler", requireAdminAuth(deps.jwtSecret));

  // ---- Metrics -----------------------------------------------------------

  app.get("/admin/metrics", async () => deps.metrics.snapshot());

  app.get("/admin/metrics/stream", (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const send = () => {
      reply.raw.write(`data: ${JSON.stringify(deps.metrics.snapshot())}\n\n`);
    };
    send();
    const interval = setInterval(send, 2000);

    req.raw.on("close", () => clearInterval(interval));
  });

  // ---- Security events -----------------------------------------------------

  app.get("/admin/security-events", async (req) => {
    const query = req.query as { limit?: string };
    const limit = query.limit ? Math.min(1000, Math.max(1, parseInt(query.limit, 10) || 100)) : 100;
    const [events, topIdentities, topEndpoints] = await Promise.all([
      deps.securityEvents.listRecent(limit),
      deps.securityEvents.topSuspiciousIdentities(10),
      deps.securityEvents.topTargetedEndpoints(10),
    ]);
    return { events, topSuspiciousIdentities: topIdentities, topTargetedEndpoints: topEndpoints };
  });

  // ---- Request logs ----------------------------------------------------

  app.get("/admin/logs", async (req, reply) => {
    const parsed = parseOrReject(LogFilterSchema, req.query, reply);
    if (!parsed) return;
    const logs = await deps.requestLogs.search(parsed);
    return { logs };
  });

  // ---- Policies ----------------------------------------------------------

  app.get("/admin/policies", async () => ({ policies: await deps.policies.listAll() }));

  app.post("/admin/policies", async (req, reply) => {
    const parsed = parseOrReject(PolicyInputSchema, req.body, reply);
    if (!parsed) return;
    const policy = await deps.policies.create(parsed);
    return reply.code(201).send({ policy });
  });

  app.put<{ Params: { id: string } }>("/admin/policies/:id", async (req, reply) => {
    const parsed = parseOrReject(PolicyUpdateSchema, req.body, reply);
    if (!parsed) return;
    const policy = await deps.policies.update(req.params.id, parsed);
    if (!policy) return reply.code(404).send({ error: "NOT_FOUND", message: "Policy not found" });
    return { policy };
  });

  app.delete<{ Params: { id: string } }>("/admin/policies/:id", async (req, reply) => {
    const deleted = await deps.policies.delete(req.params.id);
    if (!deleted) return reply.code(404).send({ error: "NOT_FOUND", message: "Policy not found" });
    return reply.code(204).send();
  });

  // ---- API keys ------------------------------------------------------------

  app.get("/admin/api-keys", async () => ({ apiKeys: await deps.apiKeys.list() }));

  app.post("/admin/api-keys", async (req, reply) => {
    const parsed = parseOrReject(ApiKeyCreateSchema, req.body, reply);
    if (!parsed) return;
    const { record, rawKey } = await deps.apiKeys.create(parsed.name, parsed.policyNames);
    // rawKey is returned exactly once — the caller must copy it now.
    return reply.code(201).send({ apiKey: record, rawKey });
  });

  app.delete<{ Params: { id: string } }>("/admin/api-keys/:id", async (req, reply) => {
    const revoked = await deps.apiKeys.revoke(req.params.id);
    if (!revoked) return reply.code(404).send({ error: "NOT_FOUND", message: "API key not found or already revoked" });
    return reply.code(204).send();
  });

  // ---- Blocks --------------------------------------------------------------

  app.get("/admin/blocks", async () => ({ blocks: await deps.blocks.listRecent(100) }));

  app.post("/admin/blocks", async (req, reply) => {
    const parsed = parseOrReject(BlockCreateSchema, req.body, reply);
    if (!parsed) return;
    const { identityType, identityValue, reason, ttlSeconds } = parsed;
    await setTemporaryBlock(deps.redis, `${identityType}:${identityValue}`, reason, ttlSeconds);
    const record = await deps.blocks.record({
      identityType,
      identityValue,
      reason,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    });
    return reply.code(201).send({ block: record });
  });

  app.delete<{ Params: { id: string }; Body: { identityType: "ip" | "api-key"; identityValue: string } }>(
    "/admin/blocks/:id",
    async (req, reply) => {
      const { identityType, identityValue } = req.body ?? {};
      if (identityType && identityValue) {
        await removeTemporaryBlock(deps.redis, `${identityType}:${identityValue}`);
      }
      await deps.blocks.markRemoved(req.params.id);
      return reply.code(204).send();
    }
  );
}
