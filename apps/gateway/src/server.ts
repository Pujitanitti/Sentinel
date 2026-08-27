import { loadConfig } from "@sentinel/config";
import { createLogger } from "@sentinel/logger";
import { buildApp } from "./app.js";

async function main() {
  const config = loadConfig();
  const logger = createLogger({ name: "gateway-bootstrap", pretty: config.NODE_ENV !== "production" });

  logger.info("running database migrations");
  const { app, redis, pool, policyCache, requestLogBuffer } = await buildApp(config);

  await app.listen({ port: config.GATEWAY_PORT, host: "0.0.0.0" });
  logger.info({ port: config.GATEWAY_PORT, backend: config.BACKEND_URL }, "sentinel gateway listening");

  const shutdown = async () => {
    logger.info("shutting down gracefully");
    policyCache.stop();
    requestLogBuffer.stop();
    await requestLogBuffer.flush().catch(() => undefined);
    await app.close();
    await pool.end();
    redis.disconnect();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("Fatal error starting gateway:", err);
  process.exit(1);
});
