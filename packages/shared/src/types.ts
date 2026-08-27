/**
 * Shared domain types for Sentinel.
 * These are the contracts every package/app agrees on — kept dependency-free
 * so packages/shared never pulls in Express/Fastify/Redis/pg types.
 */

export type RateLimitStrategy = "fixed-window" | "sliding-window" | "token-bucket";

export type IdentityType = "ip" | "api-key" | "user" | "route";

/**
 * A resolved identity for a single incoming request. A request can be
 * evaluated against several identities at once (e.g. IP AND api-key).
 */
export interface Identity {
  type: IdentityType;
  value: string;
}

/** Uniquely addresses a (policy, identity) pair for counter storage. */
export interface RateLimitKey {
  policyName: string;
  identity: Identity;
}

export interface RateLimitConfig {
  limit: number;
  windowSeconds: number;
  strategy: RateLimitStrategy;
  /** Only used by token-bucket: how many tokens refill per second. Defaults to limit/windowSeconds. */
  refillRatePerSecond?: number;
  /** Only used by token-bucket: max bucket size. Defaults to `limit`. */
  burstCapacity?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds when the window/bucket resets (or next token is available). */
  resetAt: number;
  /** Seconds the client should wait before retrying, only set when blocked. */
  retryAfterSeconds?: number;
  strategy: RateLimitStrategy;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD" | "*";

/**
 * A configurable policy. `route` supports a trailing `/*` wildcard,
 * e.g. "/api/*" matches "/api/anything/nested".
 */
export interface Policy {
  id: string;
  name: string;
  route: string;
  method: HttpMethod;
  limit: number;
  windowSeconds: number;
  strategy: RateLimitStrategy;
  /** Which identity types this policy limits on. Defaults to ["ip"]. */
  identityTypes: IdentityType[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PolicyInput = Omit<Policy, "id" | "createdAt" | "updatedAt">;

export type RiskBand = "normal" | "suspicious" | "high-risk" | "critical";

export type GatewayDecision = "ALLOW" | "ALLOW_MONITOR" | "THROTTLE" | "BLOCK";

export interface RiskScoreBreakdownEntry {
  rule: string;
  points: number;
  reason: string;
}

export interface RiskAssessment {
  identity: Identity;
  score: number;
  band: RiskBand;
  decision: GatewayDecision;
  breakdown: RiskScoreBreakdownEntry[];
  evaluatedAt: string;
}

export type SecurityEventType =
  | "RATE_LIMIT_EXCEEDED"
  | "ABUSE_DETECTED"
  | "TEMPORARY_BLOCK"
  | "API_KEY_REVOKED"
  | "AUTH_FAILURE"
  | "ENDPOINT_SCANNING"
  | "HIGH_ERROR_RATE";

export interface SecurityEvent {
  id: string;
  type: SecurityEventType;
  identityType: IdentityType;
  identityValue: string;
  route: string | null;
  riskScore: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface TemporaryBlock {
  identity: Identity;
  reason: string;
  blockedAt: number;
  expiresAt: number;
}

export interface RequestLogEntry {
  timestamp: string;
  requestId: string;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  identity: string;
  decision: GatewayDecision;
  policyName?: string;
  riskScore?: number;
}

export interface TimeSeriesPoint {
  timestamp: string;
  total: number;
  allowed: number;
  blocked: number;
  avgLatencyMs: number;
}

export interface GatewayMetricsSnapshot {
  totalRequests: number;
  allowedRequests: number;
  blockedRequests: number;
  rateLimitedRequests: number;
  abuseDetections: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  count4xx: number;
  count5xx: number;
  requestsByEndpoint: Record<string, number>;
  requestsByApiKey: Record<string, number>;
  requestsByIp: Record<string, number>;
  windowStart: string;
  windowEnd: string;
  timeSeries: TimeSeriesPoint[];
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  /** SHA-256 hash of the full key. The raw key is only ever returned once, at creation. */
  keyHash: string;
  policyNames: string[];
  revoked: boolean;
  createdAt: string;
  revokedAt: string | null;
}

/** Standard machine-readable error body returned by the gateway when it blocks a request. */
export interface GatewayErrorBody {
  error: "RATE_LIMIT_EXCEEDED" | "ABUSE_BLOCKED" | "UNAUTHORIZED" | "BAD_GATEWAY" | "INVALID_POLICY";
  message: string;
  retryAfter?: number;
  requestId: string;
}
