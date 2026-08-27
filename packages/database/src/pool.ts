import pg from "pg";
import type { Logger } from "@sentinel/logger";

const { Pool } = pg;
export type DbPool = pg.Pool;

export interface CreatePoolOptions {
  connectionString: string;
  logger: Logger;
}

export function createPool(opts: CreatePoolOptions): DbPool {
  const pool = new Pool({ connectionString: opts.connectionString, max: 10 });

  pool.on("error", (err: Error) => {
    // A single idle client erroring must not crash the whole process —
    // admin routes will surface a 5xx for that request instead.
    opts.logger.error({ err: err.message }, "unexpected postgres pool error");
  });

  return pool;
}
