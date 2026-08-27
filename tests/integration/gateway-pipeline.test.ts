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
  TRUST_PROXY: "false",
  ALLOWED_ORIGINS: "http://localhost:3001,http://test-origin.example",
};

let built: BuiltApp;

beforeAll(async () => {
  built = await buildApp(TEST_CONFIG);

  // Defense in depth: ensure every existing policy starts enabled, regardless
  // of what a previous (possibly crashed) test run may have left behind. The
  // try/finally in the "zero policies" test below is the primary fix; this is
  // a second line of defense so the suite is self-healing either way.
  const loginRes = await built.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: TEST_CONFIG.ADMIN_EMAIL, password: TEST_CONFIG.ADMIN_PASSWORD },
  });
  const { token } = loginRes.json();
  const { policies } = (await built.app.inject({ method: "GET", url: "/admin/policies", headers: { authorization: `Bearer ${token}` } })).json();
  await Promise.all(
    policies
      .filter((p: { enabled: boolean }) => !p.enabled)
      .map((p: { id: string }) =>
        built.app.inject({ method: "PUT", url: `/admin/policies/${p.id}`, headers: { authorization: `Bearer ${token}` }, payload: { enabled: true } })
      )
  );
  await built.policyCache.forceRefresh();
});

beforeEach(async () => {
  await built.redis.flushall();
});

afterAll(async () => {
  built.policyCache.stop();
  built.requestLogBuffer.stop();
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
    brokenApp.requestLogBuffer.stop();
    await brokenApp.requestLogBuffer.flush().catch(() => undefined);
    await brokenApp.app.close();
    await brokenApp.pool.end();
    brokenApp.redis.disconnect();
  });

  it("does not error on an unknown API key (falls back to IP-based identity)", async () => {
    const res = await built.app.inject({ method: "GET", url: "/products", headers: { "x-api-key": "sk_live_bogus" } });
    expect(res.statusCode).toBe(200);
  });

  it("forwards a request with no rate-limit headers when it happens to match zero policies", async () => {
    // The seeded policies are login-protection (/login), public-api (/api/*), and
    // default-catch-all (/*) — so in practice every route matches at least the
    // catch-all. This test disables all policies to exercise the genuinely
    // unrestricted path: no matching policy should mean "forward normally",
    // not "error" or "deny by default".
    const loginRes = await built.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: TEST_CONFIG.ADMIN_EMAIL, password: TEST_CONFIG.ADMIN_PASSWORD },
    });
    const { token } = loginRes.json();
    const auth = { authorization: `Bearer ${token}` };

    const { policies } = (
      await built.app.inject({ method: "GET", url: "/admin/policies", headers: auth })
    ).json();

    // try/finally: if the assertion below throws, policies MUST still be
    // restored — otherwise a single failed test run corrupts the shared
    // Postgres database for every subsequent test run (this happened once
    // during development: an unrelated backend outage failed this test
    // mid-way, left every policy disabled, and cascaded into two unrelated
    // test failures on the next run).
    try {
      await Promise.all(
        policies.map((p: { id: string }) => built.app.inject({ method: "PUT", url: `/admin/policies/${p.id}`, headers: auth, payload: { enabled: false } }))
      );
      // Policy cache refreshes on a 5s interval in production; force it here.
      await built.policyCache.forceRefresh();

      const res = await built.app.inject({ method: "GET", url: "/products" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
    } finally {
      await Promise.all(
        policies.map((p: { id: string }) => built.app.inject({ method: "PUT", url: `/admin/policies/${p.id}`, headers: auth, payload: { enabled: true } }))
      );
      await built.policyCache.forceRefresh();
    }
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
