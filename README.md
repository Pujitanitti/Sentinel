# Sentinel

**Sentinel** is an API gateway that protects backend services using configurable rate limiting and explainable, rule-based abuse detection. It uses Redis for high-frequency request state, PostgreSQL for durable configuration and security-event history, and ships with an observability dashboard and a real traffic simulator for demonstrating gateway behavior end to end.

This is a portfolio/interview project. It is a real, working system — every rate limit, every abuse-detection rule, and every dashboard number is backed by live code and live data, not mocked. See [`docs/interview-guide.md`](docs/interview-guide.md) for an honest breakdown of what's production-ready versus simplified for local development, or [`docs/portfolio-case-study.md`](docs/portfolio-case-study.md) for the narrative version (what it does, why it's built this way, and the real bugs found along the way).

```
Client
  |
  v
+------------------------+
|        SENTINEL         |
|  Auth · Rate Limiting   |
|  Abuse Detection        |
|  Policy Engine          |
|  Logging & Metrics      |
+------------------------+
  |
  v
Backend API (demo-api)
```

## What it does

- **Rate limiting** — fixed-window, sliding-window, and token-bucket strategies, each independently selectable per policy.
- **Policy engine** — route/method-matched policies (`/login`, `/api/*`, wildcards) evaluated live, editable at runtime with no restart.
- **Abuse detection** — rule-based risk scoring (burst detection, repeated auth failures, endpoint scanning, high error rate), with deterministic, explainable scores — no black-box "AI" scoring.
- **Automatic temporary blocking** — identities that cross the critical risk threshold are blocked for a configurable window, enforced atomically in Redis.
- **Reverse proxy** — actually forwards requests to a backend and returns its response; not a stub.
- **Admin API + dashboard** — policies, API keys, blocks, security events, request logs, and live metrics (via Server-Sent Events).
- **Traffic simulator** — one-click scenarios (burst, credential stuffing, endpoint scanning, error flood) that send real HTTP requests through the gateway.

## Architecture

```
sentinel/
├── apps/
│   ├── gateway/       # Fastify gateway: pipeline, policy engine, admin API
│   ├── demo-api/      # Small Express backend Sentinel protects
│   └── dashboard/     # Next.js observability console
├── packages/
│   ├── shared/        # Domain types + pure logic (route matching, risk bands)
│   ├── config/        # zod-validated environment config
│   ├── logger/        # pino structured logging with secret redaction
│   ├── redis/         # Lua scripts for atomic rate-limit/risk-score/block state
│   ├── database/      # Postgres schema, migrations, repositories
│   ├── rate-limiter/  # Fixed-window / sliding-window / token-bucket
│   └── abuse-detector/# Rule-based risk scoring
├── docker/            # Per-service Dockerfiles
├── docs/              # System design + interview prep
├── tests/             # Unit + integration tests
└── docker-compose.yml
```

See [`docs/system-design.md`](docs/system-design.md) for the full request lifecycle, data-flow diagrams, and design tradeoffs.

## Request lifecycle

```
Request → Request ID → Identity resolution (IP / API key)
        → Temporary block check
        → Policy-driven rate limit check
        → Abuse risk pre-check
        → Forward to backend
        → Post-response abuse accounting (may trigger a new block)
        → Metrics + structured log + security events
```

## Rate limiting algorithms

| Strategy | How it works | Tradeoff |
|---|---|---|
| **Fixed window** | `INCR` a counter per window, `EXPIRE` on first hit | Simple, O(1), but allows up to 2x the limit right at a window boundary |
| **Sliding window** | Redis sorted set of request timestamps, pruned on every check | Accurate, no boundary burst, but more memory (one entry per request in-window) |
| **Token bucket** | Bucket refills continuously at a fixed rate; each request consumes a token | Allows legitimate short bursts while enforcing a long-run average rate |

All three are implemented as single Lua scripts so the check-and-increment is atomic under concurrent requests — see [`packages/redis/src/scripts.ts`](packages/redis/src/scripts.ts).

## Abuse detection

Risk score is a deterministic sum of rule hits, decaying via a TTL'd Redis key (not stored forever):

| Rule | Points | Trigger |
|---|---|---|
| Burst detection | +10 | N+ requests within a short rolling window |
| Repeated auth failures | +15 | N+ `401`s in recent history |
| Endpoint scanning | +20 | N+ distinct routes hit in recent history |
| High error rate | +15 | Error ratio ≥ threshold over a minimum sample size |
| Known blocked identity | +30 | Already on the active block list |

| Score | Band | Action |
|---|---|---|
| 0–29 | Normal | Allow |
| 30–59 | Suspicious | Allow + monitor |
| 60–79 | High risk | Throttle (added latency) |
| 80–100 | Critical | Block (temporary, auto-expiring) |

See [`packages/abuse-detector/src/rules.ts`](packages/abuse-detector/src/rules.ts) for the exact, unit-tested logic.

## Redis vs. PostgreSQL

- **Redis** — anything that changes on every request: rate-limit counters, token-bucket state, risk scores, request history (for pattern rules), and active temporary blocks. All TTL'd so nothing grows unbounded.
- **PostgreSQL** — anything that must survive a restart and be queried historically: policies, API keys, the durable block audit trail, security events, and request logs.

If Redis is unreachable, the gateway does **not** crash — it applies a configurable fallback (`fail-open` allows requests through, `fail-closed` blocks them), logged clearly so it's visible in monitoring.

## Local setup (₹0 — everything runs locally)

### Option A: Docker Compose (recommended)

```bash
cp .env.example .env
docker compose up --build
```

This starts Postgres, Redis, the demo backend, the gateway, and the dashboard together. Gateway on `:3000`, dashboard on `:3001`, demo API on `:4000`.

> **Note on verification:** Docker Engine and Docker Compose were both installed and run in the environment this project was built in, and `docker compose config` confirms the compose file resolves correctly — right service dependencies, health-gated startup order, internal DNS names, env var wiring. However, that sandbox's network policy blocks Docker Hub itself (`registry-1.docker.io` returns 403), so the actual image pulls (`node:22-slim`, `postgres:16-alpine`, `redis:7-alpine`) could not be tested end-to-end — confirmed by trying a bare `docker pull node:22-slim`, which fails the same way. The Dockerfiles were hand-reviewed for workspace/dependency-order correctness (and one real lockfile-mismatch bug was caught and fixed this way). Please run `docker compose up --build` on your machine — it should work, but this is the one piece I couldn't fully verify myself.

### Option B: Run natively

Requires Node 20+, a local Postgres, and a local Redis.

```bash
npm install
cp .env.example .env   # edit DATABASE_URL / REDIS_URL if not using localhost defaults

# migrations run automatically on gateway boot, or run manually:
npm run db:migrate

npm run dev:demo-api     # terminal 1
npm run dev:gateway      # terminal 2
npm run dev:dashboard    # terminal 3
```

Dashboard login: the email/password from `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env` (defaults: `admin@sentinel.local` / `changeme123`).

## Environment variables

See [`.env.example`](.env.example) for the full list with defaults. Key ones:

- `REDIS_FALLBACK_MODE` — `fail-open` or `fail-closed` when Redis is unreachable.
- `BACKEND_URL` — where the gateway proxies to (defaults to the demo API).
- `JWT_SECRET` — **change this** for anything beyond local demo use.

## Running tests

```bash
npm test
```

52 tests across unit (rate-limiter strategies, abuse-detection rules, temporary blocking, policy matching, API-key hashing, config validation) and integration (full gateway pipeline via `fastify.inject`, admin API CRUD flows, unmatched-policy behavior) — all run against real Redis/Postgres, not mocks. See [`docs/interview-guide.md`](docs/interview-guide.md) for what's covered and what isn't.

## Running the demo attack scenarios

Use the **Simulator** page in the dashboard, or hit the gateway directly:

```bash
# Burst attack
for i in $(seq 1 30); do curl -s -o /dev/null http://localhost:3000/products & done; wait

# Login abuse (5/min policy — the 6th+ gets 429)
for i in $(seq 1 7); do curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/login \
  -H "Content-Type: application/json" -d '{"username":"x","password":"wrong"}'; done

# Endpoint scanning
for p in /api/users /api/orders /api/admin /api/config /api/debug; do curl -s -o /dev/null http://localhost:3000$p; done

# Error flood
for i in $(seq 1 15); do curl -s -o /dev/null http://localhost:3000/error; done
```

Watch the Overview/Traffic/Security pages in the dashboard update in real time.

## Screenshots

Not included in this build — generating them required a headless browser, which wasn't obtainable in the sandboxed environment this project was built in (confirmed: both Playwright's Chromium download and Ubuntu's `chromium-browser` package require network hosts outside that environment's allowlist). Run `npm run dev:dashboard` and open `http://localhost:3001` to see it live; it's a genuinely rendered Next.js app, not a mockup.

## System design decisions & tradeoffs

See [`docs/system-design.md`](docs/system-design.md).

## Future improvements

- Distributed rate limiting across multiple gateway instances is already correct today (Redis is the shared source of truth) — a real deployment would add gateway horizontal scaling behind a load balancer and verify with multi-instance load tests.
- Metrics currently live in-process; production would ship them to Prometheus/StatsD so they survive restarts and support alerting.
- The admin JWT is a simple bearer token; production should use httpOnly cookies and refresh-token rotation.
- API-key identity resolution uses a short in-memory TTL cache per gateway instance; a revoked key can remain valid for a few seconds after revocation — acceptable for a demo, but a production system would invalidate via a Redis pub/sub signal instead.
