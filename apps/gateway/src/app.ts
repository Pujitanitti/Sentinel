import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import cors from "@fastify/cors";
import type { SentinelEnv } from "@sentinel/config";
import { createLogger, type Logger } from "@sentinel/logger";
import { createRedisClient, type RedisClient } from "@sentinel/redis";
import {
  createPool,
  runMigrations,
  PolicyRepository,
  ApiKeyRepository,
  SecurityEventRepository,
  RequestLogRepository,
  BlockRepository,
  UserRepository,
  type DbPool,
} from "@sentinel/database";
import { createRateLimiter } from "@sentinel/rate-limiter";
import { createAbuseDetector } from "@sentinel/abuse-detector";
import { hashPassword } from "./admin-auth.js";
import { PolicyCache } from "./policy-cache.js";
import { MetricsStore } from "./metrics.js";
import { handleProxyRequest, type PipelineDeps } from "./pipeline.js";
import { RequestLogBuffer } from "./log-buffer.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAdminRoutes } from "./routes/admin.js";

/**
 * Builds the CORS origin-check function from a comma-separated allowlist.
 * Requests with no Origin header (curl, server-to-server, same-origin) are
 * always allowed — CORS only governs browser cross-origin requests.
 */
export function buildCorsOriginCheck(allowedOriginsCsv: string) {
  const allowedOrigins = allowedOriginsCsv
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  return (origin: string | undefined, cb: (err: Error | null, allow: boolean) => void) => {
    if (!origin || allowedOrigins.includes(origin)) {
      cb(null, true);
      return;
    }
    cb(new Error("Not allowed by CORS"), false);
  };
}

export interface BuiltApp {
  app: FastifyInstance;
  redis: RedisClient;
  pool: DbPool;
  policyCache: PolicyCache;
  metrics: MetricsStore;
  requestLogBuffer: RequestLogBuffer;
}

/**
 * Turns the TRUST_PROXY env string into what Fastify expects.
 * SECURITY: this is the control point that decides whether a client can pick
 * its own identity via X-Forwarded-For. "true" trusts it unconditionally and
 * must only be used behind a reverse proxy that overwrites that header itself
 * — see the README's "Threat Model" section. Defaults to "false" because this
 * project's docker-compose exposes the gateway directly, with no such proxy.
 */
function parseTrustProxy(value: string, logger: Logger): boolean | string {
  if (value === "false" || value === "") return false;
  if (value === "true") {
    logger.warn(
      "TRUST_PROXY=true trusts X-Forwarded-For unconditionally. This is only safe behind a reverse proxy " +
        "that overwrites client-supplied X-Forwarded-For. If Sentinel is directly internet-facing, an " +
        "attacker can spoof their identity and bypass all IP-based rate limiting and abuse detection."
    );
    return true;
  }
  // Anything else is treated as a trusted CIDR/IP (or comma-separated list),
  // Fastify's underlying proxy-addr library handles the parsing/matching.
  return value;
}

/**
 * Builds a fully-wired Sentinel gateway Fastify instance without binding a
 * port or registering process signal handlers — used by both `server.ts`
 * (which adds those) and the integration test suite (which uses
 * `app.inject()` instead of a real socket).
 */
export async function buildApp(config: SentinelEnv): Promise<BuiltApp> {
  const logger = createLogger({ name: "gateway", pretty: config.NODE_ENV !== "production" });

  await runMigrations(config.DATABASE_URL);

  const redis = createRedisClient({ url: config.REDIS_URL, logger });
  const pool = createPool({ connectionString: config.DATABASE_URL, logger });

  const policies = new PolicyRepository(pool);
  const apiKeys = new ApiKeyRepository(pool);
  const securityEvents = new SecurityEventRepository(pool);
  const requestLogs = new RequestLogRepository(pool);
  const blocks = new BlockRepository(pool);
  const users = new UserRepository(pool);

  const adminPasswordHash = await hashPassword(config.ADMIN_PASSWORD);
  await users.ensureAdmin(config.ADMIN_EMAIL, adminPasswordHash);

  const policyCache = new PolicyCache(policies, logger);
  await policyCache.start();

  const rateLimiter = createRateLimiter({ client: redis, logger, fallbackMode: config.REDIS_FALLBACK_MODE });
  const abuseDetector = createAbuseDetector({ client: redis, logger });
  const metrics = new MetricsStore();
  const requestLogBuffer = new RequestLogBuffer(requestLogs, logger);
  requestLogBuffer.start();

  const app = Fastify({ logger: false, trustProxy: parseTrustProxy(config.TRUST_PROXY, logger) });

  // Global error handler: anything that throws past this point (a Postgres
  // constraint violation, an unexpected null, etc.) gets a consistent JSON
  // shape and a request-appropriate status — never a raw stack trace or raw
  // driver error message leaked to the client.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    // Fastify's own body-parsing/schema-validation errors are already safe to
    // pass through with their statusCode (they don't leak internals).
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) {
      reply.code(statusCode).send({ error: "BAD_REQUEST", message: err.message });
      return;
    }

    logger.error({ err: err.message, stack: err.stack, path: req.url, method: req.method }, "unhandled error");
    reply.code(500).send({ error: "INTERNAL_ERROR", message: "An unexpected error occurred" });
  });

  await app.register(cors, { origin: buildCorsOriginCheck(config.ALLOWED_ORIGINS) });

  const pipelineDeps: PipelineDeps = {
    redis,
    policyCache,
    rateLimiter,
    abuseDetector,
    apiKeys,
    securityEvents,
    requestLogs,
    requestLogBuffer,
    blocks,
    metrics,
    logger,
    backendUrl: config.BACKEND_URL,
  };

  registerAuthRoutes(app, { users, jwtSecret: config.JWT_SECRET, rateLimiter });

  await app.register(async (adminScope) => {
    registerAdminRoutes(adminScope, {
      policies,
      apiKeys,
      blocks,
      securityEvents,
      requestLogs,
      metrics,
      policyCache,
      redis,
      jwtSecret: config.JWT_SECRET,
    });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.route({
    method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
    url: "/*",
    handler: async (req, reply) => {
      await handleProxyRequest(req, reply, pipelineDeps);
    },
  });

  return { app, redis, pool, policyCache, metrics, requestLogBuffer };
}
