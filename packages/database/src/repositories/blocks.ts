import type { DbPool } from "../pool.js";
import type { IdentityType } from "@sentinel/shared";

export interface BlockRecord {
  id: string;
  identityType: IdentityType;
  identityValue: string;
  reason: string;
  permanent: boolean;
  blockedAt: string;
  expiresAt: string | null;
  removedAt: string | null;
}

interface BlockRow {
  id: string;
  identity_type: string;
  identity_value: string;
  reason: string;
  permanent: boolean;
  blocked_at: Date;
  expires_at: Date | null;
  removed_at: Date | null;
}

function toRecord(row: BlockRow): BlockRecord {
  return {
    id: row.id,
    identityType: row.identity_type as IdentityType,
    identityValue: row.identity_value,
    reason: row.reason,
    permanent: row.permanent,
    blockedAt: row.blocked_at.toISOString(),
    expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
    removedAt: row.removed_at ? row.removed_at.toISOString() : null,
  };
}

/**
 * This table is the durable audit trail of blocking decisions (who, why, when).
 * The actual live enforcement — "is this request blocked right now" — is a
 * Redis lookup (fast, TTL-based). This repository is for history/admin UI,
 * not the hot path.
 */
export class BlockRepository {
  constructor(private pool: DbPool) {}

  async record(input: {
    identityType: IdentityType;
    identityValue: string;
    reason: string;
    permanent?: boolean;
    expiresAt?: Date | null;
  }): Promise<BlockRecord> {
    const { rows } = await this.pool.query<BlockRow>(
      `INSERT INTO blocked_entities (identity_type, identity_value, reason, permanent, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input.identityType, input.identityValue, input.reason, input.permanent ?? false, input.expiresAt ?? null]
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to record block");
    return toRecord(row);
  }

  async markRemoved(id: string): Promise<boolean> {
    const result = await this.pool.query(`UPDATE blocked_entities SET removed_at = now() WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async listRecent(limit = 50): Promise<BlockRecord[]> {
    const { rows } = await this.pool.query<BlockRow>(
      `SELECT * FROM blocked_entities ORDER BY blocked_at DESC LIMIT $1`,
      [limit]
    );
    return rows.map(toRecord);
  }
}
