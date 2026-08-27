import type { DbPool } from "../pool.js";
import type { HttpMethod, IdentityType, Policy, PolicyInput, RateLimitStrategy } from "@sentinel/shared";

interface PolicyRow {
  id: string;
  name: string;
  route: string;
  method: string;
  limit: number;
  window_seconds: number;
  strategy: string;
  identity_types: string[];
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

function toPolicy(row: PolicyRow): Policy {
  return {
    id: row.id,
    name: row.name,
    route: row.route,
    method: row.method as HttpMethod,
    limit: row.limit,
    windowSeconds: row.window_seconds,
    strategy: row.strategy as RateLimitStrategy,
    identityTypes: row.identity_types as IdentityType[],
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PolicyRepository {
  constructor(private pool: DbPool) {}

  async listEnabled(): Promise<Policy[]> {
    const { rows } = await this.pool.query<PolicyRow>(
      `SELECT * FROM policies WHERE enabled = true ORDER BY created_at ASC`
    );
    return rows.map(toPolicy);
  }

  async listAll(): Promise<Policy[]> {
    const { rows } = await this.pool.query<PolicyRow>(`SELECT * FROM policies ORDER BY created_at ASC`);
    return rows.map(toPolicy);
  }

  async getById(id: string): Promise<Policy | null> {
    const { rows } = await this.pool.query<PolicyRow>(`SELECT * FROM policies WHERE id = $1`, [id]);
    return rows[0] ? toPolicy(rows[0]) : null;
  }

  async create(input: PolicyInput): Promise<Policy> {
    const { rows } = await this.pool.query<PolicyRow>(
      `INSERT INTO policies (name, route, method, "limit", window_seconds, strategy, identity_types, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.name,
        input.route,
        input.method,
        input.limit,
        input.windowSeconds,
        input.strategy,
        input.identityTypes,
        input.enabled,
      ]
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to create policy");
    return toPolicy(row);
  }

  async update(id: string, input: Partial<PolicyInput>): Promise<Policy | null> {
    const existing = await this.getById(id);
    if (!existing) return null;

    const merged: PolicyInput = {
      name: input.name ?? existing.name,
      route: input.route ?? existing.route,
      method: input.method ?? existing.method,
      limit: input.limit ?? existing.limit,
      windowSeconds: input.windowSeconds ?? existing.windowSeconds,
      strategy: input.strategy ?? existing.strategy,
      identityTypes: input.identityTypes ?? existing.identityTypes,
      enabled: input.enabled ?? existing.enabled,
    };

    const { rows } = await this.pool.query<PolicyRow>(
      `UPDATE policies
       SET name = $1, route = $2, method = $3, "limit" = $4, window_seconds = $5,
           strategy = $6, identity_types = $7, enabled = $8, updated_at = now()
       WHERE id = $9
       RETURNING *`,
      [
        merged.name,
        merged.route,
        merged.method,
        merged.limit,
        merged.windowSeconds,
        merged.strategy,
        merged.identityTypes,
        merged.enabled,
        id,
      ]
    );
    return rows[0] ? toPolicy(rows[0]) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM policies WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }
}
