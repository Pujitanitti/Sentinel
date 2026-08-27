import type { RequestHistoryEvent } from "@sentinel/redis";
import type { RiskScoreBreakdownEntry } from "@sentinel/shared";
import type { AbuseDetectionConfig } from "./config.js";

/**
 * Burst detection: counts how many of the identity's recent requests fall
 * within the last `burstWindowMs`. History is newest-first (see pushRequestEvent).
 */
export function detectBurst(
  history: RequestHistoryEvent[],
  now: number,
  cfg: AbuseDetectionConfig
): RiskScoreBreakdownEntry | null {
  const withinWindow = history.filter((e) => now - e.ts <= cfg.burstWindowMs).length;
  if (withinWindow >= cfg.burstThresholdRequests) {
    return {
      rule: "burst-detection",
      points: cfg.burstPoints,
      reason: `${withinWindow} requests within ${cfg.burstWindowMs}ms (threshold ${cfg.burstThresholdRequests})`,
    };
  }
  return null;
}

/**
 * Repeated failed authentication: counts 401s in history. In a real deployment
 * this would be scoped to auth routes specifically; the gateway only calls
 * this rule with history that includes route info, so callers can pre-filter
 * if they want route-specific auth-failure tracking.
 */
export function detectAuthFailures(
  history: RequestHistoryEvent[],
  cfg: AbuseDetectionConfig
): RiskScoreBreakdownEntry | null {
  const failures = history.filter((e) => e.status === 401).length;
  if (failures >= cfg.authFailureThreshold) {
    return {
      rule: "repeated-auth-failures",
      points: cfg.authFailurePoints,
      reason: `${failures} authentication failures in recent history (threshold ${cfg.authFailureThreshold})`,
    };
  }
  return null;
}

/**
 * Endpoint scanning: a client hitting many distinct routes in a short span
 * (e.g. probing /api/users, /api/orders, /api/admin, /api/config, ...).
 */
export function detectEndpointScanning(
  history: RequestHistoryEvent[],
  cfg: AbuseDetectionConfig
): RiskScoreBreakdownEntry | null {
  const distinctPaths = new Set(history.map((e) => e.path)).size;
  if (distinctPaths >= cfg.scanDistinctEndpointThreshold) {
    return {
      rule: "endpoint-scanning",
      points: cfg.scanPoints,
      reason: `${distinctPaths} distinct endpoints requested recently (threshold ${cfg.scanDistinctEndpointThreshold})`,
    };
  }
  return null;
}

/**
 * High error rate: most of the identity's recent requests are failing
 * (4xx/5xx). Requires a minimum sample size so a single failed request
 * doesn't trigger a 100% "error rate".
 */
export function detectHighErrorRate(
  history: RequestHistoryEvent[],
  cfg: AbuseDetectionConfig
): RiskScoreBreakdownEntry | null {
  if (history.length < cfg.errorRateMinSamples) return null;
  const errorCount = history.filter((e) => e.status >= 400).length;
  const ratio = errorCount / history.length;
  if (ratio >= cfg.errorRateThreshold) {
    return {
      rule: "high-error-rate",
      points: cfg.errorRatePoints,
      reason: `${errorCount}/${history.length} recent requests returned 4xx/5xx (${Math.round(ratio * 100)}%, threshold ${Math.round(cfg.errorRateThreshold * 100)}%)`,
    };
  }
  return null;
}

export function knownBlockedEntry(cfg: AbuseDetectionConfig): RiskScoreBreakdownEntry {
  return {
    rule: "known-blocked-identity",
    points: cfg.knownBlockedPoints,
    reason: "identity is on the active temporary block list",
  };
}

/** Runs every history-based rule and returns only the ones that fired. */
export function runAllRules(
  history: RequestHistoryEvent[],
  now: number,
  cfg: AbuseDetectionConfig
): RiskScoreBreakdownEntry[] {
  const results = [
    detectBurst(history, now, cfg),
    detectAuthFailures(history, cfg),
    detectEndpointScanning(history, cfg),
    detectHighErrorRate(history, cfg),
  ];
  return results.filter((r): r is RiskScoreBreakdownEntry => r !== null);
}
