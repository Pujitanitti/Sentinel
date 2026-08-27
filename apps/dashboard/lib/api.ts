"use client";

const GATEWAY_URL = process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:3000";
const TOKEN_STORAGE_KEY = "sentinel_admin_token";

// NOTE (documented simplification): the token lives in localStorage for this
// portfolio build, which is vulnerable to XSS reading it. A production
// deployment should issue the JWT as an httpOnly, Secure, SameSite cookie
// instead so client-side JS never touches it directly.
export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });

  if (res.status === 401) {
    clearToken();
    if (typeof window !== "undefined") window.location.href = "/login";
    throw new ApiError(401, "Unauthorized");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: res.statusText }));
    throw new ApiError(res.status, body.message ?? "Request failed");
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; expiresIn: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  metrics: () => request<GatewayMetricsSnapshot>("/admin/metrics"),

  securityEvents: (limit = 100) =>
    request<{
      events: SecurityEvent[];
      topSuspiciousIdentities: { identityType: string; identityValue: string; eventCount: number }[];
      topTargetedEndpoints: { route: string; eventCount: number }[];
    }>(`/admin/security-events?limit=${limit}`),

  logs: (params: { path?: string; identity?: string; decision?: string; status?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, String(v));
    return request<{ logs: RequestLogEntry[] }>(`/admin/logs?${qs.toString()}`);
  },

  policies: () => request<{ policies: Policy[] }>("/admin/policies"),
  createPolicy: (input: PolicyInput) =>
    request<{ policy: Policy }>("/admin/policies", { method: "POST", body: JSON.stringify(input) }),
  updatePolicy: (id: string, input: Partial<PolicyInput>) =>
    request<{ policy: Policy }>(`/admin/policies/${id}`, { method: "PUT", body: JSON.stringify(input) }),
  deletePolicy: (id: string) => request<void>(`/admin/policies/${id}`, { method: "DELETE" }),

  apiKeys: () => request<{ apiKeys: ApiKeyRecord[] }>("/admin/api-keys"),
  createApiKey: (name: string, policyNames: string[]) =>
    request<{ apiKey: ApiKeyRecord; rawKey: string }>("/admin/api-keys", {
      method: "POST",
      body: JSON.stringify({ name, policyNames }),
    }),
  revokeApiKey: (id: string) => request<void>(`/admin/api-keys/${id}`, { method: "DELETE" }),

  blocks: () => request<{ blocks: BlockRecord[] }>("/admin/blocks"),
};

export function metricsStreamUrl(): string {
  return `${GATEWAY_URL}/admin/metrics/stream`;
}

export function gatewayBaseUrl(): string {
  return GATEWAY_URL;
}

// ---- Types mirrored from @sentinel/shared (kept local so the dashboard has
// zero build-time dependency on the backend workspace packages) ----------

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

export interface SecurityEvent {
  id: string;
  type: string;
  identityType: string;
  identityValue: string;
  route: string | null;
  riskScore: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface RequestLogEntry {
  timestamp: string;
  requestId: string;
  method: string;
  path: string;
  status: number;
  latencyMs: number;
  identity: string;
  decision: string;
  policyName?: string;
  riskScore?: number;
}

export type RateLimitStrategy = "fixed-window" | "sliding-window" | "token-bucket";
export type IdentityType = "ip" | "api-key" | "user" | "route";

export interface Policy {
  id: string;
  name: string;
  route: string;
  method: string;
  limit: number;
  windowSeconds: number;
  strategy: RateLimitStrategy;
  identityTypes: IdentityType[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PolicyInput = Omit<Policy, "id" | "createdAt" | "updatedAt">;

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  policyNames: string[];
  revoked: boolean;
  createdAt: string;
  revokedAt: string | null;
}

export interface BlockRecord {
  id: string;
  identityType: string;
  identityValue: string;
  reason: string;
  permanent: boolean;
  blockedAt: string;
  expiresAt: string | null;
  removedAt: string | null;
}
