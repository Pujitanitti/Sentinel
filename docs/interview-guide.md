# Sentinel — Interview Guide

Answers below are grounded in what's actually implemented, not aspirational. Where something is simplified for local development, that's said explicitly.

---

**Why did you use Redis for rate limiting instead of Postgres?**

Rate limiting needs to answer "how many requests has this identity made in the last N seconds" on every single request, with sub-millisecond latency, and the counters churn constantly. Redis keeps this in memory with atomic increment/expire primitives (`INCR`, sorted sets, hashes) purpose-built for exactly this. Postgres could technically do it with row-level locking, but you'd be paying disk-durability and MVCC overhead for data that's disposable by design — a rate-limit counter doesn't need to survive a restart. I used Postgres for the data that *does* need to survive: policies, API keys, the block audit trail, security events.

**How does sliding-window rate limiting work?**

Every request's timestamp is added to a Redis sorted set keyed by identity+policy. On each check, I first remove entries older than the window (`ZREMRANGEBYSCORE`), then count what's left (`ZCARD`). If it's under the limit, the new timestamp is added and the request is allowed. Because it's the actual timestamps rather than a bucket counter, there's no boundary-burst problem — unlike fixed window, a client can't send 2x the limit by timing requests around a window edge.

**Why token bucket for the public-API policy specifically?**

Token bucket is the right fit when you want to tolerate short legitimate bursts (a client that's been quiet building up capacity) while still capping the long-run average rate. I store `{tokens, timestamp}` in a Redis hash and lazily refill based on elapsed time on each check — no background job needed.

**What are the tradeoffs between fixed and sliding window?**

Fixed window is O(1) memory and one Redis round-trip, but allows up to 2x the limit right at a window boundary. Sliding window is accurate — no boundary burst — but costs O(window size) memory per identity (one sorted-set entry per request in-window) and a log-n operation per check. For something like login-attempt limiting where precision matters more than raw throughput, I used sliding window; for a generic catch-all policy, fixed window's cheapness wins.

**How would Sentinel scale to 100K requests/sec?**

The gateway itself is stateless — all shared state (rate-limit counters, risk scores, blocks) lives in Redis — so you scale by running more gateway instances behind a load balancer; they all see the same Redis state, so rate limiting stays correct across instances (this is real distributed rate limiting, verified by the fact that nothing in the rate-limiter depends on process-local memory). At that volume, Redis itself becomes the constraint before gateway CPU does — the standard answer is Redis Cluster, sharding by identity key so no single node is the bottleneck.

**What happens if Redis goes down?**

It's configurable via `REDIS_FALLBACK_MODE`: `fail-open` lets requests through (availability wins — appropriate for most traffic, since an outage shouldn't take down the whole API), or `fail-closed` blocks everything (strictness wins — appropriate for something like a login endpoint where "temporarily unavailable" beats "temporarily unlimited"). Either way it's a deliberate, logged decision, not a crash — I verified this with a test that points the rate limiter at an unreachable Redis and checks both modes behave as documented.

**How would you prevent API-key abuse?**

Today: API keys are subject to the same rate-limit policies as IPs (a policy can require both identity types), and abuse detection tracks request history per identity regardless of type. A key making too many requests, hitting too many distinct endpoints, or generating too many errors accumulates risk score the same way an IP does. What I'd add for production: per-key spend/quota tracking (not just rate, but a daily cap), and anomaly detection on *usage pattern changes* (a key that's suddenly used from a new geography or a 10x request-volume jump), which is out of scope for this build.

**How would you distribute rate limiting across multiple servers?**

It already is distributed correctly, because the counters live in Redis rather than in-process. What I did *not* build is multi-instance load testing to confirm behavior under real concurrent load across multiple gateway processes — the atomicity guarantee comes from Redis's Lua-script execution model, not from anything gateway-instance-specific, so it should hold, but "should hold by design" and "verified under load" are different claims and I'd want to run that test before calling it production-proven.

**How would you reduce false positives in abuse detection?**

Two levers I'd add: (1) allow rules to be scoped per-policy rather than global (a burst threshold that makes sense for a public read endpoint is way too sensitive for a webhook receiver), and (2) track a rolling baseline per identity instead of fixed global thresholds, so "normal for this client" adapts over time. Right now thresholds are global constants (`DEFAULT_ABUSE_CONFIG`), which is simple and explainable but not adaptive.

**How would you secure the gateway itself?**

Admin routes require a JWT (bcrypt-hashed passwords, never logged); API keys are stored as SHA-256 hashes, never in plaintext; the logger has hard redaction for password/token/apiKey/authorization fields at the pino config level, not left to individual call-sites to remember. What's simplified for the demo: the JWT is a bearer token in `localStorage` on the dashboard rather than an httpOnly cookie, which is a real XSS exposure I'd fix before shipping this as anything but a portfolio piece.

**How would you monitor Sentinel in production?**

Today, metrics are in-process (`MetricsStore`) and exposed via a JSON snapshot endpoint plus an SSE stream for the dashboard — accurate, but per-instance and lost on restart. Production would ship these to Prometheus (via a `/metrics` endpoint in the standard exposition format) so they survive restarts, aggregate across instances, and support alerting rules (e.g. page on-call if block rate exceeds X% for Y minutes).

---

## What's actually implemented vs. simplified

**Fully implemented and tested:**
- All three rate-limiting strategies, atomic under concurrency, verified with real timing tests against real Redis.
- Rule-based abuse detection (burst, auth failures, endpoint scanning, high error rate), unit-tested as pure functions and integration-tested against real Redis.
- Policy engine with live reload (no gateway restart needed to add/edit/disable a policy).
- Full admin API (policies, API keys, blocks, metrics, logs, security events) with JWT auth, and a dashboard consuming all of it live.
- Real reverse proxy — verified end-to-end against a real backend, including a genuine 502 test for backend-unreachable.
- Temporary auto-blocking with a real fixed race condition (concurrent duplicate-block writes), caught via manual load testing, not just theorized.
- 46 automated tests (unit + integration) covering rate limiter, abuse detector, config, policy matching, API-key hashing, and the full gateway pipeline via `fastify.inject`.

**Known simplifications (would change for production):**
- Metrics are in-process, not shipped to a real time-series backend.
- Dashboard auth token lives in `localStorage`, not an httpOnly cookie.
- API-key validation has a short in-memory TTL cache per gateway instance, so a revoked key can remain valid for a few seconds on that instance.
- Abuse-detection thresholds are global constants, not per-policy or adaptive.
- Docker Compose: the daemon and CLI were actually run and `docker compose config` confirms the file resolves correctly (service dependencies, health checks, env wiring, internal DNS all correct). The one thing not verified is the actual image build/run, because that sandbox's network blocks Docker Hub entirely (confirmed with a bare `docker pull node:22-slim` failing the same way) — not something particular to this project's Dockerfiles.

**Not built (explicitly out of scope for this pass):**
- Multi-instance load testing to empirically confirm distributed rate-limiting correctness under concurrent load (the design supports it; it hasn't been load-tested).
- Prometheus/Grafana integration.
- Per-key quota/spend tracking beyond shared rate-limit policies.
