import "dotenv/config";
import { z } from "zod";

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Gateway
  GATEWAY_PORT: z.coerce.number().int().positive().default(3000),
  BACKEND_URL: z.string().url().default("http://localhost:4000"),

  // Demo API
  DEMO_API_PORT: z.coerce.number().int().positive().default(4000),

  // Dashboard
  DASHBOARD_PORT: z.coerce.number().int().positive().default(3001),

  // Postgres
  DATABASE_URL: z
    .string()
    .default("postgresql://sentinel:sentinel@localhost:5432/sentinel"),

  // Redis
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // Auth
  JWT_SECRET: z
    .string()
    .min(16, "JWT_SECRET must be at least 16 characters")
    .default("dev-only-insecure-secret-change-me-please"),
  ADMIN_EMAIL: z.string().email().default("admin@sentinel.local"),
  ADMIN_PASSWORD: z.string().min(8).default("changeme123"),

  // Failure-handling behavior
  REDIS_FALLBACK_MODE: z.enum(["fail-open", "fail-closed"]).default("fail-open"),

  // Proxy trust model — see SECURITY note in README before changing this.
  // "false": trust nothing but the raw socket connection (correct default when
  //   the gateway is directly internet-facing, as in this project's docker-compose).
  // "true": trust X-Forwarded-For unconditionally — ONLY correct if a real,
  //   properly-configured reverse proxy sits in front and strips/overwrites
  //   any client-supplied X-Forwarded-For before it reaches Sentinel.
  // A CIDR string or comma-separated list of CIDRs: trust X-Forwarded-For only
  //   when the immediate connecting peer is within that range (the standard,
  //   safest way to use a specific known reverse proxy).
  TRUST_PROXY: z.string().default("false"),

  // CORS: comma-separated list of allowed origins for the admin API/dashboard.
  ALLOWED_ORIGINS: z.string().default("http://localhost:3001"),
});

export type SentinelEnv = z.infer<typeof EnvSchema>;

let cached: SentinelEnv | null = null;

/**
 * Loads and validates environment variables once per process.
 * Throws with a readable message on first access if config is invalid,
 * rather than letting bad config silently propagate into runtime behavior.
 */
export function loadConfig(): SentinelEnv {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  cached = parsed.data;
  return cached;
}

/** Test-only helper to reset the cached config between test cases. */
export function __resetConfigCacheForTests(): void {
  cached = null;
}
