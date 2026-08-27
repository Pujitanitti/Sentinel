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
