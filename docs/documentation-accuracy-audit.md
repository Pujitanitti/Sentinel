# Documentation Accuracy Audit

Performed after the README rewrite, specifically checking every claim that could plausibly be overstated. Format: claim → what was actually checked → verified.

| README claim | Checked against | Verified? |
|---|---|---|
| "71 automated tests" | `npm test` output, run 3 times consecutively | ✅ Yes — 71/71, stable |
| "5-second buckets, 10 minutes of history" (metrics) | `apps/gateway/src/metrics.ts`: `BUCKET_MS = 5000`, `MAX_BUCKETS = 120` (120 × 5s = 600s = 10min) | ✅ Yes |
| "10-connection pool" | `packages/database/src/pool.ts`: `max: 10` | ✅ Yes |
| "30s cooldown" (event dedupe) | `apps/gateway/src/event-dedupe.ts`: `COOLDOWN_SECONDS = 30` | ✅ Yes |
| "10-second in-memory cache" (API key) | `apps/gateway/src/identity.ts`: `CACHE_TTL_MS = 10_000` | ✅ Yes |
| "250ms" flush interval (log buffer) | `apps/gateway/src/log-buffer.ts`: `FLUSH_INTERVAL_MS = 250`, `MAX_BUFFER_SIZE = 500` | ✅ Yes |
| Abuse rule thresholds/points table (burst 20/3s, auth-failure 5, scan 8, error-rate 70%/10, points 10/15/20/15/30) | `packages/abuse-detector/src/config.ts` `DEFAULT_ABUSE_CONFIG` | ✅ Yes, every value matches exactly |
| "5-minute" temporary block TTL | `apps/gateway/src/pipeline.ts`: `TEMP_BLOCK_TTL_SECONDS = 300` | ✅ Yes |
| "5 requests/60s" login rate limit | `apps/gateway/src/routes/auth.ts`: `LOGIN_RATE_LIMIT = { limit: 5, windowSeconds: 60, strategy: "sliding-window" }` | ✅ Yes |
| "risk score TTL 300s" | `packages/abuse-detector/src/config.ts`: `riskScoreTtlSeconds: 300` | ✅ Yes |
| "distributed" rate limiting | Claim is scoped explicitly to "shared Redis state makes this architecturally correct"; explicitly disclaims empirical multi-instance testing in the same section and again in Known Limitations | ✅ Accurately scoped, not overclaimed |
| "abuse detection" | Section explicitly labeled "rule-based abuse-pattern detection" with a dedicated Limitations subsection (evadable by pacing, global thresholds, small history window) | ✅ Accurately scoped |
| "real-time" (dashboard) | Changed to "live-updating... (2s interval)" — SSE polls every 2 seconds, not sub-second push | ✅ Fixed during this audit |
| "protects" (used only in Threat Model framing, not as a bare claim) | Threat Model section explicitly enumerates what is and isn't protected against | ✅ Scoped via dedicated section |
| "secure" | Only appears as a section heading ("Security Considerations"), never as a standalone claim about the system | ✅ Not used as an unqualified claim |
| No instance of "production-ready" | `grep -in "production-ready" README.md` | ✅ Confirmed absent |
| No instance of "enterprise-grade" | `grep -in "enterprise-grade" README.md` | ✅ Confirmed absent |
| No instance of "high performance" | `grep -in "high performance" README.md` | ✅ Confirmed absent |
| No instance of "fault-tolerant" (unqualified) | `grep -in "fault.tolerant" README.md` | ✅ Confirmed absent |
| "scalable" | Not used as a bare adjective anywhere in the README | ✅ Confirmed absent |
| Request lifecycle (8 numbered steps) | Compared directly against `apps/gateway/src/pipeline.ts` control flow | ✅ Matches actual code order |
| Race-condition story (concurrent block creation) | Cross-checked against the actual fix (`SET ... NX` in `packages/redis/src/state.ts::setTemporaryBlock`) and the original manual test that found it | ✅ Matches |
| Cold-state build failure story | Re-reproduced in this session by wiping `dist/`/`.tsbuildinfo` and confirming the fix still holds | ✅ Re-verified, not just cited from memory |
| IP-spoofing threat model claim (`TRUST_PROXY=false` default ignores `X-Forwarded-For`) | Live-tested in this session: identical spoofed-header requests correctly collapsed into one real rate-limit bucket | ✅ Empirically re-confirmed, not just described |
| "no coverage percentage is claimed because none has been measured" | Confirmed no `--coverage` run has been reported/committed anywhere in docs prior to this statement | ✅ Accurate — coverage tooling exists in `vitest.config.ts` but was never run and reported |

## Net result

No claim in the rewritten README exceeds what the implementation and testing actually support. Where earlier internal notes used looser language ("this is real distributed rate limiting"), the README now states the same underlying fact with the empirical gap named explicitly in the same sentence or the same section.
