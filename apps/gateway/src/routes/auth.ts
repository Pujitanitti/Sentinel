import type { FastifyInstance } from "fastify";
import type { UserRepository } from "@sentinel/database";
import type { RateLimiter } from "@sentinel/rate-limiter";
import { issueAdminToken, verifyPassword } from "../admin-auth.js";
import { LoginSchema, parseOrReject } from "../validation.js";

export interface AuthRouteDeps {
  users: UserRepository;
  jwtSecret: string;
  rateLimiter: RateLimiter;
}

// Dedicated, hardcoded policy for the admin login endpoint — deliberately NOT
// exposed as an admin-configurable Policy row, since this protects the one
// account that controls every other policy. 5/60s sliding-window: tight enough
// to make online brute-forcing impractical (a real password has enough entropy
// that 5 guesses/minute is not a meaningful attack surface), loose enough that
// a legitimate admin mistyping their password a couple of times isn't locked out.
const LOGIN_RATE_LIMIT = { limit: 5, windowSeconds: 60, strategy: "sliding-window" as const };

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  app.post<{ Body: { email: string; password: string } }>("/auth/login", async (req, reply) => {
    // Rate limit BEFORE any DB lookup or bcrypt verification — an attacker
    // shouldn't be able to spend our CPU (bcrypt is intentionally slow) just
    // by sending requests fast enough; the limiter check itself is cheap.
    const rateLimitResult = await deps.rateLimiter.check(
      { policyName: "auth-login-protection", identity: { type: "ip", value: req.ip } },
      LOGIN_RATE_LIMIT
    );
    if (!rateLimitResult.allowed) {
      reply.header("Retry-After", String(rateLimitResult.retryAfterSeconds ?? 60));
      return reply.code(429).send({
        error: "RATE_LIMIT_EXCEEDED",
        message: "Too many login attempts. Try again later.",
        retryAfter: rateLimitResult.retryAfterSeconds ?? 60,
      });
    }

    const parsed = parseOrReject(LoginSchema, req.body, reply);
    if (!parsed) return;
    const { email, password } = parsed;

    const user = await deps.users.findByEmail(email);
    if (!user) {
      return reply.code(401).send({ error: "UNAUTHORIZED", message: "Invalid email or password" });
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return reply.code(401).send({ error: "UNAUTHORIZED", message: "Invalid email or password" });
    }

    const token = issueAdminToken({ sub: user.id, email: user.email }, deps.jwtSecret);
    return reply.send({ token, expiresIn: "8h" });
  });
}
