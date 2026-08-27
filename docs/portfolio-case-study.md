# Sentinel — Portfolio Case Study

**One-line pitch:** An API gateway that protects backend services with configurable rate limiting and explainable, rule-based abuse detection — built to demonstrate backend engineering, distributed-systems tradeoffs, and security thinking, not just CRUD.

---

## The problem

Most portfolio projects that touch "rate limiting" bolt a single fixed-window counter onto an Express app and call it done. That doesn't demonstrate much — it doesn't show you understand *why* there are multiple algorithms, what happens when your rate-limit store goes down, or how you'd tell a real attack pattern from a slow day. Sentinel exists to show that thinking, end to end, in working code.

## What it does

Sentinel sits in front of a backend API and, on every request:

1. Resolves the caller's identity (IP and/or API key)
2. Checks whether that identity is already temporarily blocked
3. Evaluates it against configurable rate-limit policies (which algorithm, what limit, what window — chosen per route)
4. Runs it through rule-based abuse detection (burst traffic, repeated failed logins, endpoint scanning, high error rates) and computes a live, explainable risk score
5. Forwards the request to the real backend if it's allowed, or rejects it with a proper `429`/`403` and machine-readable error body if not
6. Automatically issues a temporary block if the risk score crosses a critical threshold — no human in the loop needed
7. Logs everything, feeds a live metrics dashboard, and records security events with a durable audit trail

All of it is real: real Redis-backed atomic counters, a real reverse proxy to a real backend, a real Postgres schema for policies/keys/audit history, and a real Next.js dashboard reading live data — not mocked numbers.

## Architecture at a glance

```
Client → Sentinel Gateway (Fastify) → Backend API
              │
     ┌────────┴────────┐
     ▼                 ▼
   Redis            PostgreSQL
(rate limits,     (policies, API keys,
 risk scores,      security events,
 temp blocks)      request logs)
```

A TypeScript monorepo (npm workspaces) with clean package boundaries: `shared` (pure types/logic), `redis` and `database` (typed data-access), `rate-limiter` and `abuse-detector` (the actual algorithms, each independently unit-testable), and three apps — the gateway itself, a small demo backend to protect, and the dashboard.

## Technical decisions worth talking about

**Three rate-limiting strategies, chosen deliberately per policy, not just one.** Fixed-window for cheap, high-volume catch-all limits. Sliding-window (Redis sorted sets, pruned live) for precision-sensitive routes like login, where the fixed-window boundary-burst problem (up to 2x the limit right at a window edge) is unacceptable. Token bucket for APIs that should tolerate legitimate short bursts. All three are single Lua scripts, so the check-and-increment is atomic under concurrent load — not "atomic in my application code," which is a common bug.

**Abuse detection is explainable, not a black box.** Every point added to a risk score traces to a named rule with a human-readable reason (`"6 requests within 2000ms (threshold 5)"`), stored and queryable. Deliberately avoided anything that looks like "AI abuse detection" with unexplainable scores — the goal was a system I could defend line-by-line in an interview, not a magic number.

**Redis vs. Postgres was a real design decision, not a default.** High-frequency, disposable state (counters, risk scores, blocks) lives in Redis with TTLs. Durable configuration and audit history (policies, API keys, security events) lives in Postgres. Documented explicitly in `docs/system-design.md`, including what happens to each when its store goes down.

## Bugs I actually found and fixed (not just "it worked first try")

This is the part I'm most proud of, because it's what separates "I wrote code that compiles" from "I built a system I understand." All four were caught through manual load-testing and writing the test suite, not code review:

1. **A read-only "check current risk" function was silently mutating the score.** `getCurrentAssessment` was meant to be a side-effect-free pre-request check, but shared code with `recordAndAssess` that incremented the persisted score in Redis — meaning just *checking* an identity's risk inflated it. Found while writing tests that called it twice in a row and got different answers.
2. **A genuine race condition under concurrent load.** Firing 25 simultaneous requests at a client already near the block threshold produced *two* duplicate block records in Postgres — a classic check-then-act race (both requests saw "not blocked yet" before either wrote the block). Fixed by making the block-write atomic (`SET NX` in Redis) so only the request that wins the race persists the audit record.
3. **An auth middleware that leaked scope.** A Fastify `preHandler` hook meant to protect only `/admin/*` routes was accidentally applying to `/health` and the public proxy route too, because it wasn't registered inside an encapsulated plugin context.
4. **A route-registration collision** between my catch-all proxy handler and the CORS plugin's own OPTIONS route registration.

## Results

- 46 automated tests (unit + integration), all passing against real Redis and Postgres — not mocks.
- Verified end-to-end by hand: fired real burst traffic, real credential-stuffing attempts, and real endpoint-scanning patterns through the running gateway and watched the dashboard update live.
- A one-click traffic simulator in the dashboard that sends genuine HTTP requests through the gateway for five attack scenarios, for easy interview demonstration.

## Honest limitations

Documented explicitly rather than glossed over (see `docs/interview-guide.md` for the full breakdown): metrics are in-process rather than shipped to Prometheus, the dashboard's auth token uses `localStorage` rather than an httpOnly cookie, and abuse-detection thresholds are global rather than adaptive per-policy. I'd rather name these clearly than have them surface as surprises in an interview.

## Tech stack

TypeScript, Node.js, Fastify, Redis (Lua scripts for atomicity), PostgreSQL, Next.js, Tailwind CSS, Vitest, Docker Compose.

---

*For the technical Q&A version of this (the kind of questions an interviewer would actually ask), see [`docs/interview-guide.md`](../docs/interview-guide.md). For the full architecture writeup, see [`docs/system-design.md`](../docs/system-design.md).*
