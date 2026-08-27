import type { RedisClient } from "@sentinel/redis";
import { evalSlidingWindow } from "@sentinel/redis";
import type { RateLimitResult } from "@sentinel/shared";

/**
 * Sliding window log: tracks the actual timestamp of every request in a
 * Redis sorted set and counts how many fall within the last `windowSeconds`,
 * recomputed on every call. Accurate (no boundary-burst problem like fixed
 * window) at the cost of O(log n) per request and more memory (one sorted-set
 * entry per request in the window).
 */
export async function slidingWindowCheck(
  client: RedisClient,
  redisKey: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const windowMs = windowSeconds * 1000;

  const { allowed, count, oldestTimestampMs, nowMs } = await evalSlidingWindow(client, redisKey, windowMs, limit);

  const remaining = Math.max(0, limit - count);
  const resetAt = Math.floor((oldestTimestampMs > 0 ? oldestTimestampMs + windowMs : nowMs + windowMs) / 1000);
  const retryAfterSeconds = Math.max(1, resetAt - Math.floor(nowMs / 1000));

  return {
    allowed,
    limit,
    remaining,
    resetAt,
    strategy: "sliding-window",
    ...(allowed ? {} : { retryAfterSeconds }),
  };
}
