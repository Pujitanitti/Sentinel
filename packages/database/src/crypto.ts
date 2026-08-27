import { randomBytes, createHash } from "node:crypto";

const KEY_PREFIX = "sk_live_";

/** Generates a new raw API key. Only ever shown to the caller once, at creation time. */
export function generateApiKey(): { rawKey: string; keyPrefix: string; keyHash: string } {
  const secret = randomBytes(24).toString("base64url");
  const rawKey = `${KEY_PREFIX}${secret}`;
  const keyPrefix = rawKey.slice(0, KEY_PREFIX.length + 6); // e.g. "sk_live_ab12cd" for display in the UI
  const keyHash = hashApiKey(rawKey);
  return { rawKey, keyPrefix, keyHash };
}

/** We only ever store/compare this hash — the raw key is never persisted. */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}
