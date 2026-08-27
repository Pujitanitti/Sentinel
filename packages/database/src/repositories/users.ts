import type { DbPool } from "../pool.js";

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: Date;
}

function toRecord(row: UserRow): UserRecord {
  return { id: row.id, email: row.email, passwordHash: row.password_hash, createdAt: row.created_at.toISOString() };
}

export class UserRepository {
  constructor(private pool: DbPool) {}

  async findByEmail(email: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query<UserRow>(`SELECT * FROM users WHERE email = $1`, [email]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async create(email: string, passwordHash: string): Promise<UserRecord> {
    const { rows } = await this.pool.query<UserRow>(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING *`,
      [email, passwordHash]
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to create user");
    return toRecord(row);
  }

  /** Idempotent bootstrap: creates the admin user only if one doesn't already exist for this email. */
  async ensureAdmin(email: string, passwordHash: string): Promise<UserRecord> {
    const existing = await this.findByEmail(email);
    if (existing) return existing;
    return this.create(email, passwordHash);
  }
}
