import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { FastifyReply, FastifyRequest } from "fastify";

const SALT_ROUNDS = 12;
const TOKEN_TTL = "8h";

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export interface AdminTokenPayload {
  sub: string;
  email: string;
}

export function issueAdminToken(payload: AdminTokenPayload, secret: string): string {
  return jwt.sign(payload, secret, { expiresIn: TOKEN_TTL });
}

export function verifyAdminToken(token: string, secret: string): AdminTokenPayload | null {
  try {
    return jwt.verify(token, secret) as AdminTokenPayload;
  } catch {
    return null;
  }
}

/** Fastify preHandler guard for all /admin/* routes except /auth/login. */
export function requireAdminAuth(secret: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    const queryToken = (req.query as Record<string, string | undefined> | undefined)?.token;

    let token: string | undefined;
    if (header?.startsWith("Bearer ")) {
      token = header.slice("Bearer ".length);
    } else if (queryToken) {
      // EventSource (used by the SSE metrics stream) cannot set custom
      // headers, so it's the one place a token-in-query fallback is needed.
      token = queryToken;
    }

    if (!token) {
      return reply.code(401).send({ error: "UNAUTHORIZED", message: "Missing bearer token" });
    }
    const payload = verifyAdminToken(token, secret);
    if (!payload) {
      return reply.code(401).send({ error: "UNAUTHORIZED", message: "Invalid or expired token" });
    }
    (req as FastifyRequest & { admin: AdminTokenPayload }).admin = payload;
  };
}
