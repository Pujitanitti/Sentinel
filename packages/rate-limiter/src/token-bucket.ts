import type { RedisClient } from "@sentinel/redis";
import { evalTokenBucket } from "@sentinel/redis";
import type { RateLimitResult } from "@sentinel/shared";

/**
 * Token bucket: a bucket holds up to `burstCapacity` tokens, refilling at
 * `refillRatePerSecond`. Each request consumes one token. Unlike fixed/sliding
 * window, this allows short legitimate bursts (a client that saved up tokens)
 * while still enforcing a long-run average rate — the standard choice for
 * "public API" style policies where some burstiness is expected.
 */
export async function tokenBucketCheck(
  client: RedisClient,
  redisKey: string,
  limit: number,
  windowSeconds: number,
  burstCapacity?: number,
  refillRatePerSecond?: number
): Promise<RateLimitResult> {
  const capacity = burstCapacity ?? limit;
  const refillRate = refillRatePerSecond ?? limit / windowSeconds;
  // Idle buckets expire after 2x the time to refill from empty, so we don't
  // hold Redis memory for clients that stopped sending requests long ago.
  const ttlSeconds = Math.max(windowSeconds * 2, Math.ceil((capacity / refillRate) * 2));

  const { allowed, tokensRemaining, nowMs } = await evalTokenBucket(client, redisKey, capacity, refillRate, 1, ttlSeconds);

  const remaining = Math.floor(tokensRemaining);
  const secondsToNextToken = allowed ? 0 : Math.max(1, Math.ceil((1 - tokensRemaining) / refillRate));
  const resetAt = Math.floor(nowMs / 1000) + secondsToNextToken;

  return {
    allowed,
    limit: capacity,
    remaining,
    resetAt,
    strategy: "token-bucket",
    ...(allowed ? {} : { retryAfterSeconds: secondsToNextToken }),
  };
}
