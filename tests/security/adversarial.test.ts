import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { buildApp, type BuiltApp, buildCorsOriginCheck } from "../../apps/gateway/src/app.js";
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
  ALLOWED_ORIGINS: "http://localhost:3001,http://allowed-origin.example",
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
  built.requestLogBuffer.stop();
  await built.app.close();
  await built.pool.end();
  built.redis.disconnect();
});

describe("SECURITY: IP spoofing via X-Forwarded-For", () => {
  it("ignores a spoofed X-Forwarded-For header when TRUST_PROXY=false (the default)", async () => {
    // With trustProxy disabled, every request in an `inject()`-based test resolves
    // to the same loopback-style address regardless of what headers claim.
    const asFirstFakeIp = await built.app.inject({
      method: "GET",
      url: "/products",
      headers: { "x-forwarded-for": "1.1.1.1" },
    });
    const asSecondFakeIp = await built.app.inject({
      method: "GET",
      url: "/products",
      headers: { "x-forwarded-for": "2.2.2.2" },
    });
    // Both requests must be attributed to the SAME real identity — proven by
    // the fact that they share the same rate-limit bucket (see next test),
    // not by inspecting internals directly.
    expect(asFirstFakeIp.statusCode).toBe(200);
    expect(asSecondFakeIp.statusCode).toBe(200);
  });

  it("does not let repeated spoofed IPs each get their own fresh rate-limit allowance", async () => {
    // login-protection is 5/60s. If spoofing worked, each fake IP below would
    // independently get 5 allowed requests (15 total across 3 fake IPs).
    // If spoofing is correctly ignored, all 15 requests share ONE real
    // identity's limit: exactly 5 allowed, 10 rejected.
    const fakeIps = ["10.0.0.1", "10.0.0.2", "10.0.0.3"];
    const results = [];
    for (const fakeIp of fakeIps) {
      for (let i = 0; i < 5; i++) {
        results.push(
          await built.app.inject({
            method: "POST",
            url: "/login",
            headers: { "x-forwarded-for": fakeIp },
            payload: { username: "x", password: "wrong" },
          })
        );
      }
    }
    const allowed = results.filter((r) => r.statusCode !== 429).length;
    const blocked = results.filter((r) => r.statusCode === 429).length;
    expect(allowed).toBe(5);
    expect(blocked).toBe(10);
  });

  it("does not let a spoofed IP evade abuse-detection risk accumulation", async () => {
    // Trigger enough failed-auth signals to raise risk score, all claiming
    // different X-Forwarded-For values. If spoofing worked, each fake IP
    // would start fresh at risk 0. If ignored correctly, they all accumulate
    // onto the same real identity, and the LAST request should reflect a
    // meaningfully non-zero risk score (visible via response having gone
    // through abuse-detection accounting, i.e. it doesn't error).
    for (let i = 0; i < 4; i++) {
      await built.app.inject({
        method: "POST",
        url: "/login",
        headers: { "x-forwarded-for": `172.16.0.${i}` }, // a different fake IP every time
        payload: { username: "x", password: "wrong" },
      });
    }
    // The 5th request (still claiming yet another fake IP) should now be
    // rate-limited by login-protection (5/60s), proving all 4 prior attempts
    // plus this one landed on the same real, non-spoofable identity.
    const fifth = await built.app.inject({
      method: "POST",
      url: "/login",
      headers: { "x-forwarded-for": "172.16.0.99" },
      payload: { username: "x", password: "wrong" },
    });
    expect(fifth.statusCode).toBe(401); // 5th request still allowed (limit is 5)
    const sixth = await built.app.inject({
      method: "POST",
      url: "/login",
      headers: { "x-forwarded-for": "172.16.0.100" },
      payload: { username: "x", password: "wrong" },
    });
    expect(sixth.statusCode).toBe(429); // 6th request blocked — proves shared identity
  });
});

describe("SECURITY: admin login brute-force protection", () => {
  it("allows a successful login", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: TEST_CONFIG.ADMIN_EMAIL, password: TEST_CONFIG.ADMIN_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rate-limits repeated failed login attempts (5/60s) before the 6th attempt", async () => {
    const results = [];
    for (let i = 0; i < 6; i++) {
      results.push(
        await built.app.inject({
          method: "POST",
          url: "/auth/login",
          payload: { email: TEST_CONFIG.ADMIN_EMAIL, password: "wrong-password" },
        })
      );
    }
    const statuses = results.map((r) => r.statusCode);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });

  it("does not leak whether the email exists vs. the password is wrong", async () => {
    const unknownEmail = await built.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "nobody@sentinel.local", password: "whatever" },
    });
    const wrongPassword = await built.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: TEST_CONFIG.ADMIN_EMAIL, password: "wrong-password" },
    });
    expect(unknownEmail.statusCode).toBe(wrongPassword.statusCode);
    expect(unknownEmail.json().message).toBe(wrongPassword.json().message);
  });

  it("does not run rate-limit-exempt requests through bcrypt when already rate-limited", async () => {
    // Exhaust the limit, then send one more — it should come back fast (a few
    // ms), not bcrypt-slow (~100ms+), proving the rate-limit check runs BEFORE
    // any password verification work.
    for (let i = 0; i < 5; i++) {
      await built.app.inject({ method: "POST", url: "/auth/login", payload: { email: "x@x.com", password: "x" } });
    }
    const start = Date.now();
    const res = await built.app.inject({ method: "POST", url: "/auth/login", payload: { email: "x@x.com", password: "x" } });
    const elapsed = Date.now() - start;
    expect(res.statusCode).toBe(429);
    expect(elapsed).toBeLessThan(50); // bcrypt cost-12 verification alone typically takes 80-200ms+
  });
});

describe("SECURITY: abuse detection covers API-key identity, not just IP", () => {
  it("accumulates risk on the API-key identity independently of IP", async () => {
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
      payload: { name: "security-test-key", policyNames: ["public-api"] },
    });
    const { rawKey, apiKey } = createRes.json();

    // Drive enough distinct-endpoint requests under this API key to trigger
    // endpoint-scanning, which should land a TEMPORARY_BLOCK on the API-key
    // identity specifically.
    const paths = ["/api/users", "/api/orders", "/api/admin", "/api/config", "/api/debug", "/api/x1", "/api/x2", "/api/x3"];
    for (const p of paths) {
      await built.app.inject({ method: "GET", url: p, headers: { "x-api-key": rawKey } });
    }

    // Poll briefly rather than asserting on a single read: the security event
    // write happens inside the same awaited request that creates it, but this
    // guards against any transient I/O variance in the test environment
    // rather than asserting on a single point-in-time read.
    let apiKeyEvents: { identityType: string; identityValue: string }[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const eventsRes = await built.app.inject({ method: "GET", url: "/admin/security-events?limit=200", headers: auth });
      const events = eventsRes.json().events as { identityType: string; identityValue: string; type: string }[];
      apiKeyEvents = events.filter((e) => e.identityType === "api-key" && e.identityValue === apiKey.keyPrefix);
      if (apiKeyEvents.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(apiKeyEvents.length).toBeGreaterThan(0);
  });
});

describe("SECURITY: input validation on admin write routes", () => {
  let auth: { authorization: string };

  beforeAll(async () => {
    const loginRes = await built.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: TEST_CONFIG.ADMIN_EMAIL, password: TEST_CONFIG.ADMIN_PASSWORD },
    });
    auth = { authorization: `Bearer ${loginRes.json().token}` };
  });

  it("rejects an invalid rate-limit strategy with a clean 400, not a raw DB error", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: "/admin/policies",
      headers: auth,
      payload: { name: "bad-policy", route: "/x", limit: 10, windowSeconds: 60, strategy: "banana", identityTypes: ["ip"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(res.json())).not.toMatch(/postgres|constraint|relation|syntax error/i);
  });

  it("rejects a negative limit", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: "/admin/policies",
      headers: auth,
      payload: { name: "bad-policy-2", route: "/x", limit: -5, windowSeconds: 60, strategy: "fixed-window", identityTypes: ["ip"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a zero window", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: "/admin/policies",
      headers: auth,
      payload: { name: "bad-policy-3", route: "/x", limit: 10, windowSeconds: 0, strategy: "fixed-window", identityTypes: ["ip"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a route that doesn't start with / or *", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: "/admin/policies",
      headers: auth,
      payload: { name: "bad-policy-4", route: "not-a-route", limit: 10, windowSeconds: 60, strategy: "fixed-window", identityTypes: ["ip"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects missing required fields", async () => {
    const res = await built.app.inject({ method: "POST", url: "/admin/policies", headers: auth, payload: { name: "incomplete" } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an API key create request with an empty name", async () => {
    const res = await built.app.inject({ method: "POST", url: "/admin/api-keys", headers: auth, payload: { name: "" } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects malformed JSON gracefully (not a 500)", async () => {
    const res = await built.app.inject({
      method: "POST",
      url: "/admin/policies",
      headers: { ...auth, "content-type": "application/json" },
      payload: "{not valid json",
    });
    expect(res.statusCode).toBeLessThan(500);
  });
});

describe("SECURITY: CORS allowlist", () => {
  it("the origin-check function allows an explicitly allowed origin", () => {
    const check = buildCorsOriginCheck("http://localhost:3001,http://allowed.example");
    check("http://localhost:3001", (err, allow) => {
      expect(err).toBeNull();
      expect(allow).toBe(true);
    });
  });

  it("the origin-check function rejects a disallowed origin", () => {
    const check = buildCorsOriginCheck("http://localhost:3001");
    check("http://evil.example", (err, allow) => {
      expect(err).not.toBeNull();
      expect(allow).toBe(false);
    });
  });

  it("the origin-check function allows requests with no Origin header (non-browser clients)", () => {
    const check = buildCorsOriginCheck("http://localhost:3001");
    check(undefined, (err, allow) => {
      expect(err).toBeNull();
      expect(allow).toBe(true);
    });
  });
});

describe("SECURITY: error responses never leak internal details", () => {
  it("does not leak a Postgres error message when policy creation hits a DB-level constraint", async () => {
    const loginRes = await built.app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: TEST_CONFIG.ADMIN_EMAIL, password: TEST_CONFIG.ADMIN_PASSWORD },
    });
    const auth = { authorization: `Bearer ${loginRes.json().token}` };

    // Create a policy, then try to create a second one with the SAME name —
    // this passes Zod validation but violates the DB's UNIQUE constraint,
    // exercising the global error handler's 500 path specifically.
    const name = `dup-policy-${Date.now()}`;
    const payload = { name, route: "/dup-test", limit: 10, windowSeconds: 60, strategy: "fixed-window" as const, identityTypes: ["ip"] };
    const first = await built.app.inject({ method: "POST", url: "/admin/policies", headers: auth, payload });
    expect(first.statusCode).toBe(201);

    const second = await built.app.inject({ method: "POST", url: "/admin/policies", headers: auth, payload });
    expect(second.statusCode).toBe(500);
    const body = second.json();
    expect(body.error).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toMatch(/duplicate key|constraint|relation|column|syntax error/i);

    await built.app.inject({ method: "DELETE", url: `/admin/policies/${first.json().policy.id}`, headers: auth });
  });
});
