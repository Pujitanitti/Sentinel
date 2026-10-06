# Sentinel

A configurable API gateway demonstrating atomic Redis-backed rate limiting, rule-based abuse detection, temporary enforcement, and operational visibility — built as a portfolio project, not a production security platform.

---

## Why Sentinel Exists

Any backend that accepts public traffic eventually needs to answer two related but distinct questions: *"is this client sending too many requests?"* (rate limiting) and *"is this client's behavior pattern suspicious, even if each individual request is within limits?"* (abuse detection). Most tutorial-level projects only tackle the first, usually with a single naive counter that doesn't hold up under concurrency.

Sentinel exists to demonstrate both, correctly:

- **Rate limiting** as a genuine distributed-systems problem — atomic operations under concurrency, multiple algorithms with real tradeoffs, and documented failure behavior when the backing store is unavailable.
- **Abuse detection** as a separate, complementary layer — a client can be within every rate limit and still be behaving suspiciously (scanning endpoints, racking up auth failures, generating an abnormal error rate). Sentinel scores that behavior with explainable, rule-based logic.
- **An API gateway** as the natural place to enforce both, since it sits in front of a backend and can make allow/throttle/block decisions before a request ever reaches application code.

This is a portfolio project built to interview-level depth: every rate limit, every abuse-detection rule, and every dashboard number is backed by real code and real data, not mocked. See [`docs/interview-guide.md`](docs/interview-guide.md) for detailed Q&A and [`docs/portfolio-case-study.md`](docs/portfolio-case-study.md) for the narrative version.

---

## What Sentinel Does

```
Client
  │
  ▼
Sentinel Gateway
  ├── Identity Resolution      (IP from raw socket; API key from x-api-key header)
  ├── Temporary Block Check    (Redis, per identity)
  ├── Rate Limiting            (policy-matched, per identity, atomic Lua scripts)
  ├── Abuse Detection          (pre-request risk check, per identity)
  ├── Proxy                    (forwards to the real backend)
  ├── Abuse Accounting         (post-response risk update, may create a new block)
  └── Audit / Metrics          (structured logs, security events, live metrics)
       │
       ▼
   Demo Backend (apps/demo-api)
```

Admin authentication (`/auth/login`) and the admin API (`/admin/*`) are separate, JWT-protected routes that sit outside this pipeline — see [Request Lifecycle](#request-lifecycle) below for exactly where each piece fits.

---

## Architecture

| Component | Role | Why this technology |
|---|---|---|
| **Gateway** (Fastify) | Request pipeline, policy engine, proxy, admin API | Fast, has first-class async/plugin support, minimal overhead for a system where the framework itself shouldn't be the bottleneck |
| **Redis** | Rate-limit counters, risk scores, temporary blocks, request history | All of this is high-frequency, short-lived, and needs atomic read-modify-write — exactly what Redis + Lua scripting is built for |
| **PostgreSQL** | Policies, API keys, security-event history, request-log archive | This data needs to survive restarts, be queried historically, and have real relational structure (foreign-key-shaped relationships even where not formally declared) |
| **Dashboard** (Next.js) | Operational visibility: metrics, security events, policy/API-key management, log search, traffic simulator | Server + client rendering in one framework, live-updating metrics via Server-Sent Events (2s interval) without a separate WebSocket layer |
| **Demo API** (Express) | The backend Sentinel protects | Deliberately simple — its only job is to give the gateway something real to proxy to |

Full package-by-package breakdown is in [Project Structure](#project-structure).

---

## Request Lifecycle

For a request to a proxied route (e.g. `GET /products`):

1. **Request ID** assigned (UUID), attached as `X-Request-ID` on the response.
2. **Identity resolved**: IP address from the raw socket connection (see [Threat Model](#threat-model) for why this isn't taken from `X-Forwarded-For` by default), plus an API-key identity if a valid `x-api-key` header is present.
3. **Temporary block check** — Redis lookup per identity. If blocked, `403` immediately, nothing else runs.
4. **Rate-limit policy matching** — every enabled policy whose route/method pattern matches this request is evaluated against every identity type it applies to. If any check fails, `429` with `Retry-After` and `X-RateLimit-*` headers.
5. **Pre-request abuse assessment** — a read-only check of each identity's current risk score/band. `BLOCK` → `403`. `THROTTLE` → a deliberate ~400ms delay is added before continuing (a low-effort way to make abusive traffic more costly without a hard block). `ALLOW_MONITOR` → continues normally, flagged in logs.
6. **Proxy** — the request is forwarded to `BACKEND_URL`. Unreachable backend → `502`.
7. **Post-response abuse accounting** — now that the real status code is known, every resolved identity's history is updated and risk re-scored. This is the only place risk scores are mutated (see [Identity Model](#identity-model)), and it's where a *new* temporary block gets created if a score crosses the critical threshold.
8. **Audit** — structured log line, buffered request-log write (see [Logging Backpressure](#observability)), and any newly-triggered security events (deduped per identity+type with a 30s cooldown so sustained abuse doesn't flood the event log).

For `/auth/login` (admin login) specifically: a dedicated rate-limit check runs *before* any database lookup or password verification — see [Authentication & Security](#authentication--security).

---

## Rate Limiting

Three strategies, selectable per policy, each implemented as a single atomic Redis Lua script (not a read-then-write sequence in application code, which would race under concurrency):

### Fixed window
`INCR` a counter, `EXPIRE` it on first hit. O(1) memory and one round-trip per check.
**Tradeoff**: a client can send up to 2× the limit right at a window boundary (e.g. the full limit at `t=59.9s`, then the full limit again at `t=60.1s`). Used for cheap, high-volume catch-all limits where this is an acceptable cost.

### Sliding window
A Redis sorted set holds every request's timestamp; each check prunes entries outside the window (`ZREMRANGEBYSCORE`) and counts what's left (`ZCARD`).
**Tradeoff**: accurate (no boundary-burst problem), but O(window size) memory per identity. Used for `/login` protection, where precision matters more than raw cheapness.

### Token bucket
A Redis hash stores `{tokens, timestamp}`, refilling lazily on each check based on elapsed time.
**Tradeoff**: allows a client to "save up" burst capacity while still enforcing a long-run average rate. Used for the general public-API policy, where some burstiness from legitimate clients is expected.

All three scripts use **Redis's own `TIME` command** for "now", not a timestamp passed in from the calling Node process — see [Distributed Rate Limiting](#distributed-rate-limiting) for why that matters.

```lua
-- Simplified sliding-window shape:
local now = redis.call('TIME')  -- Redis's own clock, not the caller's
redis.call('ZREMRANGEBYSCORE', key, 0, now - windowMs)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, uniqueRequestId)
  return ALLOWED
else
  return REJECTED
end
```

---

## Distributed Rate Limiting

**What "distributed" means here, precisely**: because every rate-limit counter, risk score, and temporary block lives in Redis rather than in gateway process memory, running multiple gateway instances behind a load balancer is architecturally correct — every instance reads and writes the same shared state, so a client can't get a fresh limit just by landing on a different instance.

**What this claim does *not* include**: this has not been empirically load-tested with multiple concurrent gateway instances. The correctness argument is a design argument (shared state + atomic Lua scripts + Redis's own clock for time-sensitive algorithms), not a benchmark result. If asked "have you tested this at scale," the honest answer is no — the design supports it, and that's as far as the evidence goes today.

**Time source**: the sliding-window and token-bucket algorithms depend on "now" for their core arithmetic. Earlier in development, "now" was `Date.now()` from the calling Node process — meaning correctness would have degraded if two gateway instances' system clocks drifted. This was changed to use Redis's own `TIME` command, so every instance shares one authoritative clock regardless of their own clock sync.

---

## Abuse Detection

Sentinel calls this **rule-based abuse-pattern detection**, deliberately — see [Threat Model](#threat-model) for what that phrase does and doesn't promise.

| Rule | Signal | Threshold (default) | Points | Rationale |
|---|---|---|---|---|
| Burst detection | Requests within a short rolling window | 20 requests / 3s | +10 | Catches naive scripted flooding |
| Repeated auth failures | `401` responses in recent history | 5 | +15 | Catches credential-guessing patterns |
| Endpoint scanning | Distinct routes hit in recent history | 8 | +20 | Catches reconnaissance/probing behavior |
| High error rate | Error ratio over a minimum sample | 70% of ≥10 requests | +15 | Catches clients hammering broken/forbidden endpoints |
| Known blocked identity | Already on the active block list | — | +30 | Reinforces an existing block if traffic continues |

Score maps to a band and an action:

| Score | Band | Action |
|---|---|---|
| 0–29 | Normal | Allow |
| 30–59 | Suspicious | Allow + monitor |
| 60–79 | High risk | Throttle (added latency) |
| 80–100 | Critical | Temporary block (auto-expiring) |

**Limitations, stated plainly:**
- Thresholds are global constants, not per-policy or adaptive — a burst threshold sensible for a public read endpoint may be too sensitive (or not sensitive enough) for a different route.
- The history window is small and time-boxed; an attacker who paces requests just under a threshold, or spreads a scan out over a longer period, will not trigger these rules. This is not resistant to a patient or sophisticated attacker.
- Risk score decays via Redis TTL rather than any deliberate decay curve — an identity that stops misbehaving returns to "normal" once the TTL lapses, not gradually.

This is real, tested, deterministic code — not a placeholder — but it is explicitly a teaching-grade implementation of rule-based detection, not an adversarially-hardened one.

---

## Identity Model

Sentinel resolves up to two identities per request:

- **IP** — always resolved, from the raw socket connection.
- **API key** — resolved from the `x-api-key` header, if present and valid.

(The `Identity` type also defines `user` and `route` as identity kinds for future extension; neither is currently populated by the gateway.)

**Both resolved identities are assessed independently for abuse detection and rate limiting** — each keeps its own separate risk score and request history in Redis. This is deliberate, not double-counting: the same request is a real signal from two different observation angles. An IP-scoped score catches abuse from anonymous or shared-IP traffic (e.g. many requests from behind one NAT); an API-key-scoped score catches an authenticated abuser even if they rotate source IPs. A client behaving abnormally on either identity can be blocked, independently of the other.

---

## Temporary Blocks

Created automatically when an identity's post-request risk assessment reaches the critical band (score ≥ 80). Stored in Redis with a 5-minute TTL via `SET key value EX 300 NX` — the `NX` flag makes block-creation atomic, which matters under concurrent bursty traffic.

**The race condition this fixes, and how it was found**: under a burst of simultaneous requests from one identity, a naive "check if blocked, then set if not" sequence lets multiple concurrent requests each see "not yet blocked" before any of them writes the block — resulting in duplicate block records. This was caught during manual load testing (firing 25 concurrent requests and finding two identical block rows in Postgres, not by reasoning about it in advance), and fixed by making the block-write itself atomic, so only the request that actually wins the race persists the audit record and emits the security event.

Blocks expire automatically via Redis TTL; there's also a durable audit record in Postgres (`blocked_entities`) for history, independent of the live enforcement mechanism.

---

## Authentication & Security

- **Admin passwords**: bcrypt-hashed (cost factor 12), never logged or returned.
- **API keys**: SHA-256 hashed at rest; the raw key is shown exactly once, at creation.
- **Admin sessions**: JWT (HS256), 8-hour expiry, verified via `Authorization: Bearer` header (or a query-param fallback used only by the SSE metrics stream, since `EventSource` can't set custom headers — see [Known Limitations](#known-limitations)).
- **Login rate limiting**: `/auth/login` has a dedicated 5-requests-per-60-seconds sliding-window check, evaluated *before* any database lookup or bcrypt verification, so an attacker can't spend the server's CPU (bcrypt is intentionally slow) by simply sending requests fast enough. 5/60s was chosen because a real password has enough entropy that 5 guesses/minute isn't a meaningful attack surface, while still tolerating an admin mistyping their password a couple of times.
- **Input validation**: every admin write route (policy create/update, API-key create, block create, login) is validated against a Zod schema before touching the database — invalid input gets a clean `400` with field-level detail, never a raw database error.
- **CORS**: an explicit origin allowlist (`ALLOWED_ORIGINS` env var), not a wildcard.
- **Trusted-proxy configuration**: see [Threat Model](#threat-model) — this is the single most important security control in the whole system, and it defaults to the safe setting for this project's actual deployment topology.
- **Error handling**: a global error handler ensures unexpected exceptions (e.g. a database constraint violation) never leak internal details (stack traces, driver error messages, schema names) to the client — they become a generic `500` with the specifics logged server-side only.
- **Secret redaction**: the logger has hard-coded redaction for `password`, `apiKey`, `token`, and `authorization` fields at the logging-library configuration level, not left to individual call sites to remember.

---

## Threat Model

**What Sentinel is designed to protect against:**
- Accidental traffic spikes from a single client (a misbehaving script, a retry loop with no backoff).
- Naive, unsophisticated brute-force traffic (repeated login attempts, simple credential stuffing at a steady rate).
- Excessive API usage beyond a configured policy.
- Simple automated abuse patterns: bursts, endpoint scanning, sustained high error rates — all from a client using a stable, consistent identity (IP or API key).

**What Sentinel explicitly does NOT guarantee, and should not be described as providing:**
- **Protection against IP spoofing, unless deployed correctly.** By default (`TRUST_PROXY=false`), Sentinel identifies clients by their raw socket IP, which cannot be spoofed by the client. If `TRUST_PROXY` is set to trust `X-Forwarded-For` (either unconditionally, or from a specific reverse-proxy CIDR), correctness depends entirely on that reverse proxy actually stripping/overwriting any client-supplied `X-Forwarded-For` before it reaches Sentinel. **If Sentinel is deployed directly internet-facing with `TRUST_PROXY=true` and no such proxy in front, an attacker can trivially set their own `X-Forwarded-For` value and defeat every IP-based rate limit and abuse rule in the system.** This was found and fixed during development — the default is `false` specifically because this project's own `docker-compose.yml` exposes the gateway directly with no reverse proxy in front.
- **Sophisticated, distributed, or botnet-scale attacks.** Rate limiting and abuse detection here are per-identity; there is no cross-identity correlation, no IP-reputation feed, and no botnet attribution.
- **Advanced behavioral or anomaly detection.** The abuse rules are fixed-threshold and rule-based, not adaptive or learned — see [Abuse Detection](#abuse-detection) limitations above.
- **WAF functionality.** Sentinel does not inspect request bodies for injection attempts, malformed payloads, or application-layer exploits — its input validation protects Sentinel's own admin API, not the backend it proxies to.
- **DDoS mitigation.** There's no volumetric-attack handling, no upstream scrubbing, no anycast — a sufficiently large distributed flood would exhaust the gateway or its dependencies the same way it would exhaust any single-region application server.
- **Enterprise threat intelligence.** No IP reputation databases, no shared threat feeds, no integration with external security services.

If you're evaluating Sentinel for anything beyond a portfolio/learning context: it demonstrates the *patterns* production rate-limiting and abuse-detection systems use, correctly, at the scope of a single-region deployment with a small number of gateway instances. It is not a substitute for a CDN-level WAF/DDoS layer in front of a real production service.

---

## Data Model

PostgreSQL holds everything that must survive a restart and be queried historically:

| Table | Purpose | Notable constraints/indexes |
|---|---|---|
| `policies` | Rate-limit policy definitions | `UNIQUE(name)`, `CHECK` on strategy/limit/window, index on `enabled` |
| `api_keys` | Hashed API keys + associated policy names | `UNIQUE(key_hash)`, index on `revoked` |
| `blocked_entities` | Durable audit trail of every block ever issued | Index on `(identity_type, identity_value)` |
| `security_events` | Every abuse/rate-limit/auth event, with risk score and metadata | Indexes on `created_at DESC`, `identity`, `type` |
| `request_logs` | Per-request audit log (method, path, status, latency, decision) | Indexes on `created_at DESC`, `path`, `identity` |
| `users` | Admin accounts | `UNIQUE(email)` |

Migrations are plain SQL files, applied in order and tracked in a `schema_migrations` table, each wrapped in a transaction (`BEGIN`/`COMMIT`/`ROLLBACK` on failure) — see `packages/database/src/migrate.ts`.

---

## Redis Data Model

| Key pattern | Holds | TTL |
|---|---|---|
| `sentinel:rl:{policy}:{identity}` | Rate-limit counter/sorted-set/hash state | Matches the policy window (or 2× the refill time for token buckets) |
| `sentinel:risk:{identity}` | Current risk score | 300s, refreshed on every point added (this is the score's "decay") |
| `sentinel:block:{identity}` | Active temporary block | 300s (configurable) |
| `sentinel:history:{identity}` | Ring buffer of recent request events (path, status, timestamp) | Same as risk-score TTL, capped at 50 entries |
| `sentinel:eventflag:{type}:{identity}` | Dedupe flag preventing repeated identical security events | 30s cooldown |

Everything here is disposable by design — losing it (a Redis restart) means rate limits/risk scores reset to zero, which is an acceptable failure mode for this kind of ephemeral enforcement state.

---

## PostgreSQL vs Redis

| | Redis | PostgreSQL |
|---|---|---|
| **What lives here** | Rate-limit counters, risk scores, temporary blocks, request history | Policies, API keys, security events, request-log archive, users |
| **Why** | High-frequency mutation, needs atomic read-modify-write, doesn't need to survive a restart | Needs durability, historical queryability, and real constraints/relationships |
| **Consistency model** | Single-node atomicity via Lua scripts | ACID transactions (used for migrations) |

---

## API Reference

### Gateway (proxied routes)
```
ANY /* (except /auth/*, /admin/*, /health)

Purpose: forwards to BACKEND_URL after the full rate-limit/abuse pipeline
Authentication: none required (identity is IP and/or optional x-api-key)
Response: whatever the backend returns, or 429/403/502 if the gateway rejects it
```

### Admin authentication
```
POST /auth/login
Purpose: issue an admin JWT
Authentication: none (this IS the login endpoint) — but rate-limited, 5/60s per IP
Request: { "email": string, "password": string }
Response: { "token": string, "expiresIn": "8h" }
Errors: 400 (invalid body), 401 (bad credentials), 429 (rate limited)
```

### Admin API (all require `Authorization: Bearer <token>`)
```
GET    /admin/metrics                Current metrics snapshot
GET    /admin/metrics/stream         Server-Sent Events stream, updates every 2s

GET    /admin/security-events        Recent events + top suspicious identities/endpoints
GET    /admin/logs                   Search request logs (filters: path, identity, decision, status)

GET    /admin/policies               List all policies
POST   /admin/policies               Create a policy (Zod-validated)
PUT    /admin/policies/:id           Update a policy
DELETE /admin/policies/:id           Delete a policy

GET    /admin/api-keys               List API keys (hashes only, never raw keys)
POST   /admin/api-keys               Create a key — response includes the raw key ONCE
DELETE /admin/api-keys/:id           Revoke a key

GET    /admin/blocks                 List recent blocks
POST   /admin/blocks                 Manually create a block
DELETE /admin/blocks/:id             Remove a block
```

---

## Configuration

See [`.env.example`](.env.example) for the full list. Key variables:

| Variable | Default | Meaning |
|---|---|---|
| `TRUST_PROXY` | `false` | See [Threat Model](#threat-model) — controls whether `X-Forwarded-For` is trusted |
| `ALLOWED_ORIGINS` | `http://localhost:3001` | Comma-separated CORS allowlist |
| `REDIS_FALLBACK_MODE` | `fail-open` | `fail-open` (allow requests) or `fail-closed` (block requests) if Redis is unreachable |
| `BACKEND_URL` | `http://localhost:4000` | Where the gateway proxies to |
| `JWT_SECRET` | (dev default) | **Change this** for anything beyond local use |
| `DATABASE_URL` / `REDIS_URL` | local defaults | Connection strings |

No real secrets are ever committed — `.env` is gitignored, `.env.example` only holds development-safe defaults.

---

## Local Development

```bash
npm install
npm run db:migrate      # applies schema; also runs automatically on gateway boot

npm run dev:demo-api    # terminal 1 — the backend Sentinel protects, :4000
npm run dev:gateway     # terminal 2 — the gateway itself, :3000
npm run dev:dashboard   # terminal 3 — the admin console, :3001
```

Dashboard login: `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env` (defaults: `admin@sentinel.local` / `changeme123`).

### Database Setup
Requires a local PostgreSQL and Redis (or use `docker-compose.yml` to run both). Migrations are idempotent — safe to run repeatedly. There's no scripted "reset" command; to start clean, drop and recreate the database, then re-run `npm run db:migrate`.

---

## Testing

**71 automated tests**, all run against real Redis and real PostgreSQL — no mocked data stores:

- **Unit** (41 tests): all three rate-limit strategies (including concurrent-request and TTL-expiry behavior), abuse-detection rules as pure functions, temporary-block set/get/expire/atomicity, policy route/method matching, API-key hashing, config validation.
- **Integration** (11 tests): the full gateway pipeline via `fastify.inject()` — proxying, the seeded login-protection policy, backend-unreachable→502, unmatched-policy behavior, and full admin API CRUD flows (policies, API keys).
- **Security** (19 tests): IP-spoofing resistance (proven by firing requests with different forged `X-Forwarded-For` values and confirming they share one rate-limit bucket), login brute-force protection (including a timing assertion that bcrypt never runs on a rate-limited request), API-key-scoped abuse detection, input-validation rejection cases, CORS allowlist behavior, and confirmation that a real database constraint violation never leaks internal details through the API.

No coverage percentage is claimed because none has been measured — test count and what's covered (above) is the honest signal here, not a synthetic metric.

**Cold-state verified**: `npm install`, `npm run db:migrate`, `npm run typecheck`, `npm run build`, and `npm test` have all been run from a genuinely wiped state (`node_modules`, `dist/`, `.tsbuildinfo`, and `.next` all deleted first) — not just "it worked before."

---

## Build & Typecheck

This is a TypeScript project-references monorepo (`tsc -b`), which requires every package to build in dependency order and emit `.d.ts` files so downstream packages can type-check against them.

**An engineering lesson worth naming directly**: `npm run typecheck` was broken from a fresh checkout for a while without anyone (including automated testing) noticing, because a root `tsconfig.json` didn't exist for `tsc -b` to build against, and separately, the script used `--noEmit`, which is fundamentally incompatible with composite project references (they *need* to emit `.d.ts` files for the references to resolve). This was masked every time it was tested, because leftover `dist/` folders from a previous build meant `tsc -b` had nothing left to do and exited cleanly. It was only caught by deliberately deleting every `dist/` folder and `.tsbuildinfo` file and re-running from scratch. Fixed by adding the root `tsconfig.json` and removing `--noEmit`; re-verified cold afterward.

---

## Failure Behavior

| Dependency down | Behavior |
|---|---|
| Redis unreachable | Configurable: `fail-open` (default — requests allowed through, loudly logged) or `fail-closed` (requests blocked). Verified with tests that point the rate limiter at an unreachable Redis instance in both modes. |
| PostgreSQL unreachable | Admin/config operations return errors; request logging fails silently (buffered, dropped if the buffer fills — see below) rather than blocking the proxy path. |
| Backend unreachable | `502 Bad Gateway` with a machine-readable JSON body. |
| Rate limit exceeded | `429` with `Retry-After` and `X-RateLimit-*` headers. |
| Abuse threshold exceeded | `403` (pre-existing block) or the request completes and a *new* block is created for subsequent requests. |
| Invalid admin input | `400` with field-level validation detail. |
| Authentication failure | `401`, generic message (does not reveal whether the email exists). |

---

## Observability

- **Structured logs** (pino) with request IDs, hard secret redaction, and a consistent shape across every log line.
- **Metrics**: total/allowed/blocked/rate-limited counts, latency percentiles (rolling sample), and a genuine rolling time-series (5-second buckets, 10 minutes of history) — computed from real request data, not fabricated. An idle gateway reports all zeros.
- **Security events**: a durable, queryable audit trail with risk scores and human-readable reasons for every rule that fired.
- **Logging backpressure**: request logs are buffered in memory and flushed to Postgres in batches every 250ms, rather than one INSERT per request. This decouples write volume from request volume specifically so burst traffic (the exact pattern this system defends against) can't exhaust the small (10-connection) Postgres pool via unbounded concurrent writes. If the buffer fills under sustained extreme load, new entries are dropped — a deliberate tradeoff, since request logs are high-volume/low-value-per-row telemetry. **Security events are intentionally NOT part of this buffer** — they're lower-volume (already deduped) and higher-value, so they keep immediate-write semantics.
- No Prometheus/Grafana integration exists. Metrics are exposed via a JSON snapshot endpoint and an SSE stream for the dashboard, and nothing more.

---

## Performance & Scalability

- Rate-limit operations are O(1) (fixed window, token bucket) or O(log n) (sliding window's sorted-set operations) per request.
- No load-testing has been performed beyond manual bursts of ~30 concurrent requests during development (which is what surfaced the temporary-block race condition). No formal benchmark numbers are reported because none were measured under controlled conditions — reporting invented numbers would be worse than reporting none.
- Connection pooling: Postgres pool capped at 10 connections; Redis uses a single shared connection with fast-fail settings (`maxRetriesPerRequest: 1`) so the gateway doesn't hang waiting on a degraded Redis instance.
- Multi-instance considerations are discussed in [Distributed Rate Limiting](#distributed-rate-limiting) above.

---

## Security Considerations

- ✅ Parameterized SQL everywhere (no string-concatenated queries)
- ✅ Passwords bcrypt-hashed, never logged
- ✅ API keys SHA-256 hashed at rest, shown raw exactly once
- ✅ Centralized Zod input validation on all admin write routes
- ✅ JWT-based admin authentication with a rate-limited login endpoint
- ✅ Configurable trusted-proxy handling (defaults safe for this project's topology)
- ✅ Explicit CORS allowlist
- ✅ Secret redaction in logs, enforced at the logger-config level
- ✅ Global error handler — no leaked stack traces or database internals
- ⚠️ No WAF, no DDoS mitigation, no IP reputation — see [Threat Model](#threat-model)

---

## Known Limitations

- Abuse-detection thresholds are global constants, not per-policy or adaptive.
- No multi-instance load testing has been performed — distributed correctness is a design argument, not a benchmark result.
- The dashboard's admin JWT is stored in `localStorage`, not an httpOnly cookie — a real XSS-exposure tradeoff made for portfolio-scope simplicity.
- The SSE metrics endpoint accepts the JWT as a query parameter (since `EventSource` can't set custom headers), which means it can appear in server access logs — a deliberate, documented tradeoff rather than an oversight.
- API-key validation uses a 10-second in-memory cache per gateway instance; a revoked key can remain valid on that instance for up to 10 seconds after revocation.
- Docker Compose was structurally validated (`docker compose config` resolves correctly: service dependencies, health-gated startup, internal DNS, env wiring) but the full `docker compose up --build` was not run to completion in the environment this project was built in, because that sandbox's network policy blocked Docker Hub image pulls entirely (confirmed with a bare `docker pull node:22-slim` failing identically) — not something specific to this project's Dockerfiles.
- The dashboard's authenticated pages were not visually verified in a modern browser during this build (no browser was obtainable in that sandbox — confirmed after trying Playwright, apt Chromium, and Firefox, all blocked by the same network/snapd constraints). A real WebKit engine (`wkhtmltoimage`, from Ubuntu's own package archive) *was* used to render and screenshot the public login page successfully, confirming the actual design renders correctly — but it could not execute the modern JS needed to get past the client-side auth gate for the authenticated pages. Every route was confirmed to server-render valid, substantial, non-error HTML, which is real but weaker evidence than a full interactive walkthrough.

---

## Design Tradeoffs

**Redis vs Postgres** — disposable, high-frequency state vs. durable, queryable history. Covered above.

**Lua atomicity vs application logic** — a single atomic script vs. a read-then-write sequence that races under concurrency. The former costs more upfront complexity; the latter is simply incorrect under load.

**Fail-open vs fail-closed** — availability vs. strictness when Redis is down. Made configurable rather than picking one, because the right answer genuinely depends on what's being protected (a public read endpoint vs. a login route).

**Rule-based detection vs ML** — deterministic and explainable, at the cost of being evadable by a patient attacker. The right choice for a system where every decision needs to be defensible ("why was this blocked?") rather than a black box.

**IP identity vs API-key identity** — both are tracked independently rather than picking one, because they catch different abuse patterns (anonymous/shared-IP vs. authenticated-identity-with-rotating-IP).

**Durable logs vs request-path latency** — request logs are buffered and batched rather than written synchronously per request, specifically so burst traffic can't turn the audit trail into a self-inflicted denial-of-service against the database pool.

---

## Testing & Engineering Lessons

**The concurrency race condition**: found by deliberately firing 25 simultaneous requests at an identity already near the block threshold, and finding two duplicate block records in Postgres afterward — not by reasoning about it in advance. Fixed by making the block-write atomic (`SET NX`).

**The cold-state TypeScript build failure**: `npm run typecheck` and `npm run build` both worked in every prior manual test, but only because leftover `dist/` folders masked a missing root `tsconfig.json` and an incompatible `--noEmit` flag. Caught by deliberately wiping all build artifacts and testing from scratch — a habit worth having regardless of how confident "it worked before" feels.

**The adversarial security audit**: an earlier pass tested that the system *worked* (endpoints return correct status codes, rate limits enforce correctly) but not that it *couldn't be broken*. A subsequent adversarial pass — asking "how would I personally defeat this" rather than "does this pass its own tests" — found that `X-Forwarded-For` could be used to spoof identity, that `/auth/login` had no brute-force protection, and that abuse detection silently only covered IP identity despite the data model supporting API keys. All three were real, meaningful gaps that a green test suite did not surface, because nobody had written a test for "what if the client lies."

---

## Project Structure

```
sentinel/
├── apps/
│   ├── gateway/          # Fastify gateway: pipeline, policy engine, admin API, auth
│   ├── demo-api/         # Small Express backend Sentinel protects
│   └── dashboard/        # Next.js observability console + traffic simulator
├── packages/
│   ├── shared/           # Domain types + pure logic (route matching, risk bands)
│   ├── config/           # zod-validated environment config
│   ├── logger/           # pino structured logging with secret redaction
│   ├── redis/            # Lua scripts for atomic rate-limit/risk/block state
│   ├── database/         # Postgres schema, migrations, repositories
│   ├── rate-limiter/     # Fixed-window / sliding-window / token-bucket
│   └── abuse-detector/   # Rule-based risk scoring
├── docker/               # Per-service Dockerfiles
├── docs/                 # System design, interview guide, portfolio case study
├── tests/
│   ├── unit/             # Pure-function and single-package tests
│   ├── integration/      # Full gateway pipeline via fastify.inject()
│   └── security/         # Adversarial regression tests
└── docker-compose.yml
```

---

## How To Run

```bash
npm install && npm run db:migrate
npm run dev:demo-api & npm run dev:gateway & npm run dev:dashboard
```
(Or use separate terminals — see [Local Development](#local-development).) Then open `http://localhost:3001` and sign in with the admin credentials from `.env`.

---

## Demo

- **Gateway**: `http://localhost:3000`
- **Dashboard**: `http://localhost:3001`
- **Demo API** (via the gateway, not directly): `http://localhost:3000/products`, `/api/users`, `/api/orders`, `/login`, `/slow`, `/error`

## Example Scenarios

**Rate-limit exceeded** (the seeded `login-protection` policy is 5/60s):
```bash
for i in $(seq 1 7); do curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/login \
  -H "Content-Type: application/json" -d '{"username":"x","password":"wrong"}'; done
# Expect: 401 401 401 401 401 429 429
```

**Spoofed forwarded IP — correctly ignored** (with the default `TRUST_PROXY=false`):
```bash
curl -s -H "X-Forwarded-For: 1.2.3.4" http://localhost:3000/products   # still resolves to your real IP
curl -s -H "X-Forwarded-For: 5.6.7.8" http://localhost:3000/products   # same rate-limit bucket, not a fresh one
```

**Endpoint scanning**:
```bash
for p in /api/users /api/orders /api/admin /api/config /api/debug; do
  curl -s -o /dev/null http://localhost:3000$p
done
# Check the dashboard's Security page — an ENDPOINT_SCANNING event should appear once the threshold is crossed
```

Or use the **Simulator** page in the dashboard for one-click versions of these scenarios, plus burst traffic and error-flood patterns.
