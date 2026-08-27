import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp, type BuiltApp } from "../../apps/gateway/src/app.js";
import type { SentinelEnv } from "@sentinel/config";

const TEST_CONFIG: SentinelEnv = {
  NODE_ENV: "test",
  GATEWAY_PORT: 0,
  BACKEND_URL: process.env.TEST_BACKEND_URL ?? "http://localhost:4000",
  DEMO_API_PORT: 4000,
  DASHBOARD_PORT: 3001,
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://sentinel:sentinel@localhost:5432/sentinel",
  REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://localhost:6379",
  JWT_SECRET: "test-secret-at-least-16-chars",
  ADMIN_EMAIL: "admin@sentinel.local",
  ADMIN_PASSWORD: "changeme123",
  REDIS_FALLBACK_MODE: "fail-open",
};

let built: BuiltApp;

beforeAll(async () => {
  built = await buildApp(TEST_CONFIG);
});

beforeEach(async () => {
  await built.redis.flushall();
});

afterAll(async () => {
  built.policyCache.stop();
  await built.app.close();
  await built.pool.end();
  built.redis.disconnect();
});

describe("gateway pipeline integration", () => {
  it("responds to /health without going through the proxy pipeline", async () => {
    const res = await built.app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("proxies a request to the backend and returns its response with rate-limit headers", async () => {
    const res = await built.app.inject({ method: "GET", url: "/products" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBeDefined();
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
  });

  it("enforces the seeded login-protection policy (5 requests / 60s)", async () => {
    const results = [];
    for (let i = 0; i < 7; i++) {
      results.push(
        await built.app.inject({
          method: "POST",
          url: "/login",
          payload: { username: "x", password: "wrong" },
        })
      );
    }
    const allowed = results.filter((r) => r.statusCode !== 429).length;
    const blocked = results.filter((r) => r.statusCode === 429).length;
    expect(allowed).toBe(5);
    expect(blocked).toBe(2);
  });

  it("returns 502 when the backend is unreachable", async () => {
    const brokenApp = await buildApp({ ...TEST_CONFIG, BACKEND_URL: "http://localhost:1" });
    const res = await brokenApp.app.inject({ method: "GET", url: "/products" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("BAD_GATEWAY");
    brokenApp.policyCache.stop();
    await brokenApp.app.close();
    await brokenApp.pool.end();
    brokenApp.redis.disconnect();
  });

  it("does not error on an unknown API key (falls back to IP-based identity)", async () => {
    const res = await built.app.inject({ method: "GET", url: "/products", headers: { "x-api-key": "sk_live_bogus" } });
    expect(res.statusCode).toBe(200);
  });
});

describe("admin API integration", () => {
  it("rejects admin routes without a token", async () => {
    const res = await built.app.inject({ method: "GET", url: "/admin/metrics" });
    expect(res.statusCode).toBe(401);
  });

  it("logs in and accesses a protected admin route", async () => {
    const loginRes = await built.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: TEST_CONFIG.ADMIN_EMAIL, password: TEST_CONFIG.ADMIN_PASSWORD },
    });
    expect(loginRes.statusCode).toBe(200);
    const { token } = loginRes.json();
    expect(typeof token).toBe("string");

    const metricsRes = await built.app.inject({
      method: "GET",
      url: "/admin/metrics",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(metricsRes.statusCode).toBe(200);
    expect(metricsRes.json()).toHaveProperty("totalRequests");
  });

  it("rejects login with the wrong password", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: TEST_CONFIG.ADMIN_EMAIL, password: "wrong-password" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("creates, lists, and revokes an API key end to end", async () => {
    const loginRes = await built.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: TEST_CONFIG.ADMIN_EMAIL, password: TEST_CONFIG.ADMIN_PASSWORD },
    });
    const { token } = loginRes.json();
    const auth = { authorization: `Bearer ${token}` };

    const createRes = await built.app.inject({
      method: "POST",
      url: "/admin/api-keys",
      headers: auth,
      payload: { name: "integration-test-key", policyNames: ["public-api"] },
    });
    expect(createRes.statusCode).toBe(201);
    const { apiKey, rawKey } = createRes.json();
    expect(rawKey).toMatch(/^sk_live_/);

    const listRes = await built.app.inject({ method: "GET", url: "/admin/api-keys", headers: auth });
    expect(listRes.json().apiKeys.some((k: { id: string }) => k.id === apiKey.id)).toBe(true);

    const revokeRes = await built.app.inject({ method: "DELETE", url: `/admin/api-keys/${apiKey.id}`, headers: auth });
    expect(revokeRes.statusCode).toBe(204);

    const proxyRes = await built.app.inject({ method: "GET", url: "/products", headers: { "x-api-key": rawKey } });
    expect(proxyRes.statusCode).toBe(401);
  });

  it("creates and deletes a policy end to end", async () => {
    const loginRes = await built.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: TEST_CONFIG.ADMIN_EMAIL, password: TEST_CONFIG.ADMIN_PASSWORD },
    });
    const { token } = loginRes.json();
    const auth = { authorization: `Bearer ${token}` };

    const createRes = await built.app.inject({
      method: "POST",
      url: "/admin/policies",
      headers: auth,
      payload: {
        name: `test-policy-${Date.now()}`,
        route: "/test-only",
        method: "GET",
        limit: 2,
        windowSeconds: 60,
        strategy: "fixed-window",
        identityTypes: ["ip"],
        enabled: true,
      },
    });
    expect(createRes.statusCode).toBe(201);
    const { policy } = createRes.json();

    const deleteRes = await built.app.inject({ method: "DELETE", url: `/admin/policies/${policy.id}`, headers: auth });
    expect(deleteRes.statusCode).toBe(204);
  });
});
