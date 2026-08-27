import { z } from "zod";
import type { FastifyReply } from "fastify";

const RATE_LIMIT_STRATEGIES = ["fixed-window", "sliding-window", "token-bucket"] as const;
const IDENTITY_TYPES = ["ip", "api-key", "user", "route"] as const;
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "*"] as const;

export const PolicyInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  route: z.string().trim().min(1).max(200).refine((r) => r.startsWith("/") || r === "*", {
    message: "route must start with '/' or be '*'",
  }),
  method: z.enum(HTTP_METHODS).default("*"),
  limit: z.number().int().positive().max(1_000_000),
  windowSeconds: z.number().int().positive().max(86_400), // max 24h window
  strategy: z.enum(RATE_LIMIT_STRATEGIES),
  identityTypes: z.array(z.enum(IDENTITY_TYPES)).min(1).default(["ip"]),
  enabled: z.boolean().default(true),
});
export type ValidatedPolicyInput = z.infer<typeof PolicyInputSchema>;

export const PolicyUpdateSchema = PolicyInputSchema.partial();

export const ApiKeyCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  policyNames: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
});

export const BlockCreateSchema = z.object({
  identityType: z.enum(["ip", "api-key"]),
  identityValue: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(500),
  ttlSeconds: z.number().int().positive().max(86_400).default(300),
});

export const LoginSchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
});

export const LogFilterSchema = z.object({
  path: z.string().trim().max(200).optional(),
  identity: z.string().trim().max(200).optional(),
  decision: z.enum(["ALLOW", "ALLOW_MONITOR", "THROTTLE", "BLOCK"]).optional(),
  status: z.coerce.number().int().min(100).max(599).optional(),
  limit: z.coerce.number().int().positive().max(1000).default(100),
});

/**
 * Parses `input` against `schema`. On failure, sends a clean 400 with a
 * consistent error shape (never a raw Postgres/Zod internal error) and
 * returns null so the caller can `if (!parsed) return;`.
 */
export function parseOrReject<T extends z.ZodTypeAny>(schema: T, input: unknown, reply: FastifyReply): z.infer<T> | null {
  const result = schema.safeParse(input);
  if (!result.success) {
    reply.code(400).send({
      error: "VALIDATION_ERROR",
      message: "Request body failed validation",
      details: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
    return null;
  }
  return result.data;
}
