import type { ApiKeyRepository } from "@sentinel/database";
import type { Identity } from "@sentinel/shared";

export interface ResolvedIdentity {
  ip: Identity;
  apiKey: (Identity & { revoked: boolean; recordId: string }) | null;
}

/**
 * Small in-memory TTL cache so every proxied request doesn't hit Postgres
 * just to validate an API key. Correctness note: a revoked key can remain
 * "valid" here for up to CACHE_TTL_MS — acceptable for a demo gateway, and
 * documented as a tradeoff (a production system would use a Redis-backed
 * cache invalidated on revoke instead).
 */
const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { record: Awaited<ReturnType<ApiKeyRepository["findByRawKey"]>>; expiresAt: number }>();

async function lookupApiKey(apiKeys: ApiKeyRepository, rawKey: string) {
  const cached = cache.get(rawKey);
  if (cached && cached.expiresAt > Date.now()) return cached.record;

  const record = await apiKeys.findByRawKey(rawKey);
  cache.set(rawKey, { record, expiresAt: Date.now() + CACHE_TTL_MS });
  return record;
}

export async function resolveIdentity(
  ip: string,
  rawApiKeyHeader: string | undefined,
  apiKeys: ApiKeyRepository
): Promise<ResolvedIdentity> {
  const ipIdentity: Identity = { type: "ip", value: ip };

  if (!rawApiKeyHeader) {
    return { ip: ipIdentity, apiKey: null };
  }

  const record = await lookupApiKey(apiKeys, rawApiKeyHeader);
  if (!record) {
    return { ip: ipIdentity, apiKey: null };
  }

  return {
    ip: ipIdentity,
    apiKey: { type: "api-key", value: record.keyPrefix, revoked: record.revoked, recordId: record.id },
  };
}
