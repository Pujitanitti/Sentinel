import type { RedisClient } from "@sentinel/redis";

const COOLDOWN_SECONDS = 30;

/**
 * Returns true the first time a given (type, identity) fires within the
 * cooldown window, false on repeats. Without this, a client sitting at a
 * sustained high error rate would generate a HIGH_ERROR_RATE security event
 * on every single request — technically accurate, but useless noise for
 * the security event log / dashboard.
 */
export async function shouldEmitEvent(client: RedisClient, type: string, identity: string): Promise<boolean> {
  const key = `sentinel:eventflag:${type}:${identity}`;
  try {
    const result = await client.set(key, "1", "EX", COOLDOWN_SECONDS, "NX");
    return result === "OK";
  } catch {
    // If Redis is unavailable, fail open on dedupe (emit the event) rather
    // than silently dropping security events.
    return true;
  }
}
