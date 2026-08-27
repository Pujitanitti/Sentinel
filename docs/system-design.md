# Sentinel — System Design

## 1. Architecture

Sentinel is a monorepo of small, independently testable packages composed into a Fastify gateway process, plus a Next.js dashboard and a small demo backend for end-to-end demonstration.

```
                    ┌──────────────┐
                    │   Dashboard   │  (Next.js, :3001)
                    │  reads admin  │
                    │  API + SSE    │
                    └──────┬───────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  ▼                  │
        │         ┌─────────────────┐         │
Client ─┼────────▶│  Sentinel        │────────┼───▶ demo-api (:4000)
        │         │  Gateway (:3000) │         │
        │         └────────┬─────────┘         │
        │                  │                   │
        │        ┌─────────┴─────────┐         │
        ▼        ▼                   ▼         ▼
     Redis (:6379)              PostgreSQL (:5432)
   rate limits, risk        policies, api keys,
   scores, blocks,          security events,
   request history          request logs, users
```

### Package boundaries

- **`@sentinel/shared`** — pure types and pure functions (route matching, risk-band mapping). Zero runtime dependencies, so every other package can depend on it without pulling in Express/Redis/pg.
- **`@sentinel/redis`** / **`@sentinel/database`** — thin, typed wrappers around ioredis/pg. All Redis mutations that need atomicity (rate-limit checks, block-setting) are single Lua scripts, not multi-command sequences, so concurrent requests can't race each other.
- **`@sentinel/rate-limiter`** — the three strategies, each a pure function of (Redis client, key, config) → result. Fully unit-testable in isolation from the gateway.
- **`@sentinel/abuse-detector`** — rule evaluation is a pure function over a history array (unit-testable without Redis); the orchestrator wires that to Redis-backed history/score storage.
- **`apps/gateway`** — composition root. `app.ts` builds a fully-wired Fastify instance (used both by the real server and by integration tests via `fastify.inject`); `server.ts` is a thin process bootstrap (port binding, signal handlers).

## 2. Request lifecycle

```
1. Assign request ID (UUID)
2. Resolve identity: IP (always) + API key (if x-api-key header present and valid)
3. Check temporary block (Redis) for each identity → 403 if blocked
4. Match enabled policies against (path, method) → evaluate rate limiter
   for each (policy, identity-type) pair → 429 if any exceeded
5. Pre-request abuse assessment (read-only) → 403 if already BLOCK band,
   add throttle delay if THROTTLE band
6. Forward to backend → 502 if unreachable
7. Post-response abuse accounting: record this request's real outcome,
   recompute risk score, possibly trigger a NEW temporary block
8. Emit security events (deduped), write metrics + structured log +
   Postgres request log (fire-and-forget)
```

The split between step 5 (pre-request, read-only) and step 7 (post-response, mutates score) is deliberate: a risk assessment used purely to decide "should I let this request through" must not itself change the score, or checking becomes indistinguishable from acting. This was actually a bug caught during test-writing — see `packages/abuse-detector/src/detector.ts`.

## 3. Rate limiting

All three strategies are implemented as single Lua scripts (`packages/redis/src/scripts.ts`) so the read-check-write sequence is atomic in Redis, not just atomic in application code. This matters because two concurrent requests from the same client must not both see "9/10 used" and both get allowed.

- **Fixed window**: `INCR` + conditional `EXPIRE`. O(1) memory. Known boundary-burst tradeoff: a client can send `limit` requests at `t=59.9s` and another `limit` at `t=60.1s`, briefly exceeding the intended rate by up to 2x.
- **Sliding window**: sorted set of request timestamps, pruned to the current window on every check via `ZREMRANGEBYSCORE`. No boundary burst, but O(window size) memory per identity.
- **Token bucket**: a Redis hash storing `{tokens, timestamp}`, refilled lazily on each check based on elapsed time. Allows a client to "save up" burst capacity while still enforcing a long-run average.

## 4. Abuse detection & risk scoring

Risk score is a **deterministic sum of rule hits** stored in a TTL'd Redis key (so it decays — an identity that stops misbehaving gradually returns to `normal` once the TTL expires, rather than being permanently flagged). Rules are pure functions over a capped request-history ring buffer (`packages/abuse-detector/src/rules.ts`), independently unit-tested:

- Burst detection, repeated auth failures, endpoint scanning, high error rate.

This is explicitly **not** a machine-learned or black-box score — every point added is traceable to a named rule with a human-readable reason, which is both more debuggable and avoids the "AI abuse detection with random scores" anti-pattern called out in the original spec.

## 5. Failure modes

| Dependency | Failure behavior |
|---|---|
| Redis unreachable | Configurable: `fail-open` (allow, log loudly) or `fail-closed` (block). Rate limiter and abuse detector both catch and fall back rather than throwing. |
| Postgres unreachable | Admin/config operations return errors; the hot path (rate limiting, proxying) does not depend on Postgres per-request, so proxying degrades gracefully — request logs simply fail to persist (caught, logged, non-fatal). |
| Backend unreachable | `502 Bad Gateway`, structured error body, request still logged and counted in metrics. |
| Invalid/revoked API key | `401 Unauthorized`. |
| Rate limit exceeded | `429 Too Many Requests` with `Retry-After` and `X-RateLimit-*` headers. |

## 6. Concurrency correctness

A real race condition was found and fixed during manual load-testing (not just unit tests): under a burst of concurrent requests from one identity, multiple requests could each read "not currently blocked" before any of them wrote the block, resulting in duplicate block records in Postgres. Fixed by making the block-write atomic (`SET NX`) and only the request that wins the race persists the audit record — see `packages/redis/src/state.ts::setTemporaryBlock` and `apps/gateway/src/pipeline.ts`.

## 7. Scaling considerations

- **Horizontal scaling of the gateway**: because all rate-limit counters, risk scores, and blocks live in Redis (not in gateway process memory), running N gateway instances behind a load balancer works correctly today — every instance sees the same shared state. This is real distributed rate limiting, not per-instance approximation.
- **What doesn't scale automatically**: the in-process `MetricsStore` (dashboard metrics) is per-instance. A multi-instance deployment would need to either aggregate metrics centrally (e.g. Prometheus scraping each instance) or move the store into Redis/a time-series DB.
- **At 100K req/sec**: the Lua-script rate-limit checks are O(1) (fixed window, token bucket) or O(log n) (sliding window's sorted-set operations) per request — Redis itself becomes the bottleneck before the gateway's own CPU does. The standard mitigation is Redis Cluster (sharding by identity key) plus read replicas for the abuse-detector's history lookups.

## 8. Security notes

- Passwords are bcrypt-hashed (cost factor 12), never stored or logged in plaintext.
- API keys are stored as SHA-256 hashes; the raw key is shown exactly once, at creation.
- The logger has redaction hard-wired at the pino level (not left to call-sites) for `password`, `apiKey`, `token`, and `authorization` fields.
- Admin routes require a valid JWT; the auth-check hook is scoped to an encapsulated Fastify plugin context so it can't accidentally leak onto public routes (this was in fact a bug caught during manual testing — the hook briefly applied to `/health` and the proxy route).

## 9. Observability

Metrics (`apps/gateway/src/metrics.ts`) are computed from real request data — total/allowed/blocked/rate-limited counts, latency percentiles from a rolling sample, and a genuine rolling time-series (5-second buckets, 10 minutes of history) so the dashboard's Traffic page shows real trends rather than only cumulative totals. No number is fabricated; an idle gateway reports all zeros.
