import type { RequestLogRepository } from "@sentinel/database";
import type { RequestLogEntry } from "@sentinel/shared";
import type { Logger } from "@sentinel/logger";

const FLUSH_INTERVAL_MS = 250;
const MAX_BUFFER_SIZE = 500;

/**
 * Request logs are high-volume, low-value-per-row telemetry — losing a few
 * under extreme load is an acceptable tradeoff for not exhausting the
 * Postgres connection pool. This buffers writes in memory and flushes them
 * in a single batched INSERT on an interval, so write volume no longer
 * scales 1:1 with request volume (which matters most exactly during the
 * burst traffic this system is built to detect).
 *
 * Security events are NOT run through this buffer — they're lower-volume
 * (already deduped per identity+type with a 30s cooldown) and higher-value,
 * so they keep their existing immediate-write behavior deliberately.
 *
 * If the buffer fills up (sustained extreme load, or Postgres is slow/down),
 * new entries are dropped rather than growing memory unboundedly or blocking
 * the request path — a deliberate, documented "safe dropping" strategy for
 * this specific low-value data.
 */
export class RequestLogBuffer {
  private buffer: RequestLogEntry[] = [];
  private droppedCount = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private repo: RequestLogRepository,
    private logger: Logger
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      this.flush().catch((err) => this.logger.error({ err: String(err) }, "request log buffer flush failed"));
    }, FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  push(entry: RequestLogEntry): void {
    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      this.droppedCount += 1;
      if (this.droppedCount === 1 || this.droppedCount % 100 === 0) {
        this.logger.warn(
          { droppedCount: this.droppedCount },
          "request log buffer full — dropping entries (low-value telemetry, not security events)"
        );
      }
      return;
    }
    this.buffer.push(entry);
  }

  /** Flushes whatever is currently buffered. Called on the interval, and once more on graceful shutdown. */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    await this.repo.createMany(batch);
  }
}
