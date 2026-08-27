import type { RedisClient } from "./client.js";
import { FIXED_WINDOW_SCRIPT, SLIDING_WINDOW_SCRIPT, TOKEN_BUCKET_SCRIPT } from "./scripts.js";

export interface FixedWindowResult {
  count: number;
  ttlSeconds: number;
}

export async function evalFixedWindow(
  client: RedisClient,
  key: string,
  windowSeconds: number
): Promise<FixedWindowResult> {
  const [count, ttl] = (await client.eval(FIXED_WINDOW_SCRIPT, 1, key, String(windowSeconds))) as [
    number,
    number
  ];
  return { count, ttlSeconds: ttl };
}

export interface SlidingWindowResult {
  allowed: boolean;
  count: number;
  oldestTimestampMs: number;
}

export async function evalSlidingWindow(
  client: RedisClient,
  key: string,
  nowMs: number,
  windowMs: number,
  limit: number
): Promise<SlidingWindowResult> {
  const member = `${nowMs}-${Math.random().toString(36).slice(2, 10)}`;
  const [allowed, count, oldest] = (await client.eval(
    SLIDING_WINDOW_SCRIPT,
    1,
    key,
    String(nowMs),
    String(windowMs),
    String(limit),
    member
  )) as [number, number, number];
  return { allowed: allowed === 1, count, oldestTimestampMs: oldest };
}

export interface TokenBucketResult {
  allowed: boolean;
  tokensRemaining: number;
}

export async function evalTokenBucket(
  client: RedisClient,
  key: string,
  nowSeconds: number,
  capacity: number,
  refillRatePerSecond: number,
  requested: number,
  ttlSeconds: number
): Promise<TokenBucketResult> {
  const [allowed, tokensX1000] = (await client.eval(
    TOKEN_BUCKET_SCRIPT,
    1,
    key,
    String(nowSeconds),
    String(capacity),
    String(refillRatePerSecond),
    String(requested),
    String(ttlSeconds)
  )) as [number, number];
  return { allowed: allowed === 1, tokensRemaining: tokensX1000 / 1000 };
}

// ---------------------------------------------------------------------------
// Risk scoring state
// ---------------------------------------------------------------------------

const riskKey = (identity: string) => `sentinel:risk:${identity}`;

/** Risk scores decay by living in a TTL'd key rather than growing forever. */
export async function incrRiskScore(
  client: RedisClient,
  identity: string,
  points: number,
  ttlSeconds: number
): Promise<number> {
  const key = riskKey(identity);
  const score = await client.incrby(key, points);
  await client.expire(key, ttlSeconds);
  return score;
}

export async function getRiskScore(client: RedisClient, identity: string): Promise<number> {
  const val = await client.get(riskKey(identity));
  return val ? parseInt(val, 10) : 0;
}

// ---------------------------------------------------------------------------
// Temporary blocks
// ---------------------------------------------------------------------------

const blockKey = (identity: string) => `sentinel:block:${identity}`;

/**
 * Atomically sets a block only if one doesn't already exist. Returns true if
 * this call actually created the block (the caller should then record it in
 * Postgres / emit a security event); false if a block was already active
 * (another concurrent request won the race, or it was already set earlier).
 */
export async function setTemporaryBlock(
  client: RedisClient,
  identity: string,
  reason: string,
  ttlSeconds: number
): Promise<boolean> {
  const result = await client.set(
    blockKey(identity),
    JSON.stringify({ reason, blockedAt: Date.now() }),
    "EX",
    ttlSeconds,
    "NX"
  );
  return result === "OK";
}

export async function getTemporaryBlock(
  client: RedisClient,
  identity: string
): Promise<{ reason: string; blockedAt: number; ttlSeconds: number } | null> {
  const key = blockKey(identity);
  const [val, ttl] = await Promise.all([client.get(key), client.ttl(key)]);
  if (!val) return null;
  const parsed = JSON.parse(val) as { reason: string; blockedAt: number };
  return { ...parsed, ttlSeconds: ttl };
}

export async function removeTemporaryBlock(client: RedisClient, identity: string): Promise<void> {
  await client.del(blockKey(identity));
}

// ---------------------------------------------------------------------------
// Recent request history (used by abuse-detector for burst/scan/error-rate rules)
// ---------------------------------------------------------------------------

export interface RequestHistoryEvent {
  path: string;
  method: string;
  status: number;
  ts: number;
}

const historyKey = (identity: string) => `sentinel:history:${identity}`;

/**
 * Appends a request event to a capped list (most recent MAX_HISTORY events).
 * This is intentionally a fixed-size ring buffer, not an ever-growing log —
 * abuse detection only needs a recent window of behavior.
 */
export async function pushRequestEvent(
  client: RedisClient,
  identity: string,
  event: RequestHistoryEvent,
  maxLen: number,
  ttlSeconds: number
): Promise<void> {
  const key = historyKey(identity);
  const pipeline = client.pipeline();
  pipeline.lpush(key, JSON.stringify(event));
  pipeline.ltrim(key, 0, maxLen - 1);
  pipeline.expire(key, ttlSeconds);
  await pipeline.exec();
}

export async function getRequestHistory(client: RedisClient, identity: string): Promise<RequestHistoryEvent[]> {
  const raw = await client.lrange(historyKey(identity), 0, -1);
  return raw.map((r) => JSON.parse(r) as RequestHistoryEvent);
}
