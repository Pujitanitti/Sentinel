import type { RedisClient } from "@sentinel/redis";
import { evalFixedWindow } from "@sentinel/redis";
import type { RateLimitResult } from "@sentinel/shared";

/**
 * Fixed window: counts requests in discrete, non-overlapping windows
 * (e.g. "the 14:32:00–14:33:00 minute"). Simple and cheap, but allows a
 * burst of up to 2x the limit right at a window boundary (e.g. 100 requests
 * at 14:32:59 + 100 more at 14:33:01). Documented as a known tradeoff.
 */
export async function fixedWindowCheck(
  client: RedisClient,
  redisKey: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const { count, ttlSeconds } = await evalFixedWindow(client, redisKey, windowSeconds);
  const allowed = count <= limit;
  const remaining = Math.max(0, limit - count);
  const resetAt = Math.floor(Date.now() / 1000) + ttlSeconds;

  return {
    allowed,
    limit,
    remaining,
    resetAt,
    strategy: "fixed-window",
    ...(allowed ? {} : { retryAfterSeconds: ttlSeconds }),
  };
}
