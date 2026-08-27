import { Redis } from "ioredis";
import type { Logger } from "@sentinel/logger";

export type RedisClient = Redis;

export interface RedisClientOptions {
  url: string;
  logger: Logger;
}

/**
 * Creates a single ioredis connection shared by all rate-limiter/abuse-detector
 * calls. `maxRetriesPerRequest: 1` + `enableOfflineQueue: false` are deliberate:
 * we want individual commands to fail fast (so the caller can apply the
 * documented fail-open/fail-closed fallback) instead of queueing forever
 * while Redis is down.
 */
export function createRedisClient(opts: RedisClientOptions): RedisClient {
  const client = new Redis(opts.url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy(times: number) {
      // Reconnect attempts continue in the background with backoff,
      // capped at 5s, so the gateway recovers automatically once Redis returns.
      return Math.min(times * 200, 5000);
    },
    lazyConnect: false,
  });

  client.on("error", (err: Error) => {
    opts.logger.error({ err: err.message }, "redis connection error");
  });

  client.on("connect", () => {
    opts.logger.info("redis connected");
  });

  client.on("reconnecting", () => {
    opts.logger.warn("redis reconnecting");
  });

  return client;
}
