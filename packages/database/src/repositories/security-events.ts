import type { DbPool } from "../pool.js";
import type { IdentityType, SecurityEvent, SecurityEventType } from "@sentinel/shared";

interface SecurityEventRow {
  id: string;
  type: string;
  identity_type: string;
  identity_value: string;
  route: string | null;
  risk_score: number | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

function toEvent(row: SecurityEventRow): SecurityEvent {
  return {
    id: row.id,
    type: row.type as SecurityEventType,
    identityType: row.identity_type as IdentityType,
    identityValue: row.identity_value,
    route: row.route,
    riskScore: row.risk_score,
    metadata: row.metadata,
    createdAt: row.created_at.toISOString(),
  };
}

export interface CreateSecurityEventInput {
  type: SecurityEventType;
  identityType: IdentityType;
  identityValue: string;
  route?: string | null;
  riskScore?: number | null;
  metadata?: Record<string, unknown>;
}

export class SecurityEventRepository {
  constructor(private pool: DbPool) {}

  async create(input: CreateSecurityEventInput): Promise<SecurityEvent> {
    const { rows } = await this.pool.query<SecurityEventRow>(
      `INSERT INTO security_events (type, identity_type, identity_value, route, risk_score, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.type,
        input.identityType,
        input.identityValue,
        input.route ?? null,
        input.riskScore ?? null,
        JSON.stringify(input.metadata ?? {}),
      ]
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to create security event");
    return toEvent(row);
  }

  async listRecent(limit = 100): Promise<SecurityEvent[]> {
    const { rows } = await this.pool.query<SecurityEventRow>(
      `SELECT * FROM security_events ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return rows.map(toEvent);
  }

  async topSuspiciousIdentities(limit = 10): Promise<{ identityType: string; identityValue: string; eventCount: number }[]> {
    const { rows } = await this.pool.query<{ identity_type: string; identity_value: string; event_count: string }>(
      `SELECT identity_type, identity_value, COUNT(*) as event_count
       FROM security_events
       WHERE created_at > now() - interval '24 hours'
       GROUP BY identity_type, identity_value
       ORDER BY event_count DESC
       LIMIT $1`,
      [limit]
    );
    return rows.map((r) => ({
      identityType: r.identity_type,
      identityValue: r.identity_value,
      eventCount: parseInt(r.event_count, 10),
    }));
  }

  async topTargetedEndpoints(limit = 10): Promise<{ route: string; eventCount: number }[]> {
    const { rows } = await this.pool.query<{ route: string; event_count: string }>(
      `SELECT route, COUNT(*) as event_count
       FROM security_events
       WHERE route IS NOT NULL AND created_at > now() - interval '24 hours'
       GROUP BY route
       ORDER BY event_count DESC
       LIMIT $1`,
      [limit]
    );
    return rows.map((r) => ({ route: r.route, eventCount: parseInt(r.event_count, 10) }));
  }
}
