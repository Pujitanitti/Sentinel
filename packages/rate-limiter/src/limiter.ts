import type { RedisClient } from "@sentinel/redis";
import type { RateLimitConfig, RateLimitKey, RateLimitResult } from "@sentinel/shared";
import type { Logger } from "@sentinel/logger";
import { fixedWindowCheck } from "./fixed-window.js";
import { slidingWindowCheck } from "./sliding-window.js";
import { tokenBucketCheck } from "./token-bucket.js";

export interface RateLimiterOptions {
  client: RedisClient;
  logger: Logger;
  /**
   * What to do when Redis is unreachable:
   * - "fail-open": allow the request through (availability over strictness —
   *   the default, since an outage in Redis shouldn't take down the whole API).
   * - "fail-closed": block the request (strictness over availability — pick
   *   this for security-critical routes like /login where "unlimited requests"
   *   is worse than "temporarily unavailable").
   */
  fallbackMode: "fail-open" | "fail-closed";
}

export interface RateLimiter {
  check(key: RateLimitKey, config: RateLimitConfig): Promise<RateLimitResult>;
}

function toRedisKey(key: RateLimitKey): string {
  return `sentinel:rl:${key.policyName}:${key.identity.type}:${key.identity.value}`;
}

function fallbackResult(config: RateLimitConfig, allowed: boolean): RateLimitResult {
  return {
    allowed,
    limit: config.limit,
    remaining: allowed ? config.limit : 0,
    resetAt: Math.floor(Date.now() / 1000) + config.windowSeconds,
    strategy: config.strategy,
    ...(allowed ? {} : { retryAfterSeconds: config.windowSeconds }),
  };
}

export function createRateLimiter(opts: RateLimiterOptions): RateLimiter {
  const { client, logger, fallbackMode } = opts;

  return {
    async check(key: RateLimitKey, config: RateLimitConfig): Promise<RateLimitResult> {
      const redisKey = toRedisKey(key);

      try {
        switch (config.strategy) {
          case "fixed-window":
            return await fixedWindowCheck(client, redisKey, config.limit, config.windowSeconds);
          case "sliding-window":
            return await slidingWindowCheck(client, redisKey, config.limit, config.windowSeconds);
          case "token-bucket":
            return await tokenBucketCheck(
              client,
              redisKey,
              config.limit,
              config.windowSeconds,
              config.burstCapacity,
              config.refillRatePerSecond
            );
          default: {
            const _exhaustive: never = config.strategy;
            throw new Error(`Unknown rate limit strategy: ${_exhaustive}`);
          }
        }
      } catch (err) {
        logger.error(
          { err: err instanceof Error ? err.message : String(err), redisKey, fallbackMode },
          "rate limiter redis call failed — applying fallback"
        );
        return fallbackResult(config, fallbackMode === "fail-open");
      }
    },
  };
}
