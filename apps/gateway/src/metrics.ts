import type { GatewayDecision, GatewayMetricsSnapshot, TimeSeriesPoint } from "@sentinel/shared";

/**
 * Metrics live in-process (not Redis/Postgres) because they're read far more
 * often than the underlying counters change meaning, and losing them on
 * restart is an acceptable tradeoff for a demo/portfolio gateway — a real
 * production deployment would ship these to Prometheus/StatsD instead.
 * Latency percentiles use a capped rolling sample (not every request kept
 * forever) to bound memory.
 */
const MAX_LATENCY_SAMPLES = 5000;
const BUCKET_MS = 5000;
const MAX_BUCKETS = 120; // 10 minutes of 5s buckets

export interface RecordRequestInput {
  path: string;
  status: number;
  latencyMs: number;
  decision: GatewayDecision;
  apiKeyId?: string;
  ip: string;
}

interface TimeBucket {
  bucketStart: number;
  total: number;
  allowed: number;
  blocked: number;
  latencySum: number;
}

export class MetricsStore {
  private totalRequests = 0;
  private allowedRequests = 0;
  private blockedRequests = 0;
  private rateLimitedRequests = 0;
  private abuseDetections = 0;
  private count4xx = 0;
  private count5xx = 0;
  private latencies: number[] = [];
  private requestsByEndpoint = new Map<string, number>();
  private requestsByApiKey = new Map<string, number>();
  private requestsByIp = new Map<string, number>();
  private readonly windowStart = new Date();
  private buckets: TimeBucket[] = [];

  private currentBucket(now: number): TimeBucket {
    const bucketStart = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    const last = this.buckets[this.buckets.length - 1];
    if (last && last.bucketStart === bucketStart) return last;

    const bucket: TimeBucket = { bucketStart, total: 0, allowed: 0, blocked: 0, latencySum: 0 };
    this.buckets.push(bucket);
    if (this.buckets.length > MAX_BUCKETS) this.buckets.shift();
    return bucket;
  }

  recordRequest(input: RecordRequestInput): void {
    this.totalRequests += 1;

    if (input.decision === "BLOCK") this.blockedRequests += 1;
    else this.allowedRequests += 1;

    if (input.status === 429) this.rateLimitedRequests += 1;
    if (input.decision === "THROTTLE" || input.decision === "ALLOW_MONITOR") this.abuseDetections += 1;

    if (input.status >= 400 && input.status < 500) this.count4xx += 1;
    if (input.status >= 500) this.count5xx += 1;

    this.latencies.push(input.latencyMs);
    if (this.latencies.length > MAX_LATENCY_SAMPLES) this.latencies.shift();

    this.bump(this.requestsByEndpoint, input.path);
    this.bump(this.requestsByIp, input.ip);
    if (input.apiKeyId) this.bump(this.requestsByApiKey, input.apiKeyId);

    const bucket = this.currentBucket(Date.now());
    bucket.total += 1;
    bucket.latencySum += input.latencyMs;
    if (input.decision === "BLOCK") bucket.blocked += 1;
    else bucket.allowed += 1;
  }

  private bump(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  private percentile(p: number): number {
    if (this.latencies.length === 0) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx] ?? 0;
  }

  private mapToRecord(map: Map<string, number>, topN = 20): Record<string, number> {
    return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN));
  }

  timeSeries(): TimeSeriesPoint[] {
    return this.buckets.map((b) => ({
      timestamp: new Date(b.bucketStart).toISOString(),
      total: b.total,
      allowed: b.allowed,
      blocked: b.blocked,
      avgLatencyMs: b.total > 0 ? Math.round(b.latencySum / b.total) : 0,
    }));
  }

  snapshot(): GatewayMetricsSnapshot {
    const avgLatencyMs =
      this.latencies.length === 0 ? 0 : Math.round(this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length);

    return {
      totalRequests: this.totalRequests,
      allowedRequests: this.allowedRequests,
      blockedRequests: this.blockedRequests,
      rateLimitedRequests: this.rateLimitedRequests,
      abuseDetections: this.abuseDetections,
      avgLatencyMs,
      p95LatencyMs: Math.round(this.percentile(95)),
      p99LatencyMs: Math.round(this.percentile(99)),
      count4xx: this.count4xx,
      count5xx: this.count5xx,
      requestsByEndpoint: this.mapToRecord(this.requestsByEndpoint),
      requestsByApiKey: this.mapToRecord(this.requestsByApiKey),
      requestsByIp: this.mapToRecord(this.requestsByIp),
      windowStart: this.windowStart.toISOString(),
      windowEnd: new Date().toISOString(),
      timeSeries: this.timeSeries(),
    };
  }
}
