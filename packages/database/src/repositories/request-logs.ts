import type { DbPool } from "../pool.js";
import type { GatewayDecision, RequestLogEntry } from "@sentinel/shared";

interface RequestLogRow {
  id: string;
  request_id: string;
  method: string;
  path: string;
  status: number;
  latency_ms: number;
  identity: string;
  decision: string;
  policy_name: string | null;
  risk_score: number | null;
  created_at: Date;
}

function toEntry(row: RequestLogRow): RequestLogEntry {
  return {
    timestamp: row.created_at.toISOString(),
    requestId: row.request_id,
    method: row.method,
    path: row.path,
    status: row.status,
    latencyMs: row.latency_ms,
    identity: row.identity,
    decision: row.decision as GatewayDecision,
    policyName: row.policy_name ?? undefined,
    riskScore: row.risk_score ?? undefined,
  };
}

export interface RequestLogFilters {
  path?: string;
  identity?: string;
  decision?: string;
  status?: number;
  limit?: number;
}

export class RequestLogRepository {
  constructor(private pool: DbPool) {}

  async create(entry: RequestLogEntry & { policyName?: string; riskScore?: number }): Promise<void> {
    await this.pool.query(
      `INSERT INTO request_logs (request_id, method, path, status, latency_ms, identity, decision, policy_name, risk_score)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.requestId,
        entry.method,
        entry.path,
        entry.status,
        entry.latencyMs,
        entry.identity,
        entry.decision,
        entry.policyName ?? null,
        entry.riskScore ?? null,
      ]
    );
  }

  async search(filters: RequestLogFilters): Promise<RequestLogEntry[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.path) {
      params.push(`%${filters.path}%`);
      clauses.push(`path ILIKE $${params.length}`);
    }
    if (filters.identity) {
      params.push(`%${filters.identity}%`);
      clauses.push(`identity ILIKE $${params.length}`);
    }
    if (filters.decision) {
      params.push(filters.decision);
      clauses.push(`decision = $${params.length}`);
    }
    if (filters.status) {
      params.push(filters.status);
      clauses.push(`status = $${params.length}`);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(filters.limit ?? 100);

    const { rows } = await this.pool.query<RequestLogRow>(
      `SELECT * FROM request_logs ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    return rows.map(toEntry);
  }
}
