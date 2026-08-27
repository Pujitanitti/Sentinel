import type { FastifyInstance } from "fastify";
import type { UserRepository } from "@sentinel/database";
import { issueAdminToken, verifyPassword } from "../admin-auth.js";

export interface AuthRouteDeps {
  users: UserRepository;
  jwtSecret: string;
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  app.post<{ Body: { email: string; password: string } }>("/auth/login", async (req, reply) => {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      return reply.code(400).send({ error: "BAD_REQUEST", message: "email and password are required" });
    }

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
