import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import type { SentinelEnv } from "@sentinel/config";
import { createLogger } from "@sentinel/logger";
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
import { registerAuthRoutes } from "./routes/auth.js";
import { registerAdminRoutes } from "./routes/admin.js";

export interface BuiltApp {
  app: FastifyInstance;
  redis: RedisClient;
  pool: DbPool;
  policyCache: PolicyCache;
  metrics: MetricsStore;
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

  const app = Fastify({ logger: false, trustProxy: true });
  await app.register(cors, { origin: true });

  const pipelineDeps: PipelineDeps = {
    redis,
    policyCache,
    rateLimiter,
    abuseDetector,
    apiKeys,
    securityEvents,
    requestLogs,
    blocks,
    metrics,
    logger,
    backendUrl: config.BACKEND_URL,
  };

  registerAuthRoutes(app, { users, jwtSecret: config.JWT_SECRET });

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

  return { app, redis, pool, policyCache, metrics };
}
