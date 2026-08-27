import type { DbPool } from "../pool.js";
import type { ApiKeyRecord } from "@sentinel/shared";
import { generateApiKey, hashApiKey } from "../crypto.js";

interface ApiKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  key_hash: string;
  policy_names: string[];
  revoked: boolean;
  created_at: Date;
  revoked_at: Date | null;
}

function toRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    keyHash: row.key_hash,
    policyNames: row.policy_names,
    revoked: row.revoked,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  };
}

export class ApiKeyRepository {
  constructor(private pool: DbPool) {}

  /** Returns the raw key exactly once — callers must show it to the user immediately. */
  async create(name: string, policyNames: string[]): Promise<{ record: ApiKeyRecord; rawKey: string }> {
    const { rawKey, keyPrefix, keyHash } = generateApiKey();
    const { rows } = await this.pool.query<ApiKeyRow>(
      `INSERT INTO api_keys (name, key_prefix, key_hash, policy_names)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, keyPrefix, keyHash, policyNames]
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to create API key");
    return { record: toRecord(row), rawKey };
  }

  async list(): Promise<ApiKeyRecord[]> {
    const { rows } = await this.pool.query<ApiKeyRow>(`SELECT * FROM api_keys ORDER BY created_at DESC`);
    return rows.map(toRecord);
  }

  async findByRawKey(rawKey: string): Promise<ApiKeyRecord | null> {
    const keyHash = hashApiKey(rawKey);
    const { rows } = await this.pool.query<ApiKeyRow>(`SELECT * FROM api_keys WHERE key_hash = $1`, [keyHash]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async revoke(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE api_keys SET revoked = true, revoked_at = now() WHERE id = $1 AND revoked = false`,
      [id]
    );
    return (result.rowCount ?? 0) > 0;
  }
}
