import type { GatewayDecision, HttpMethod, RiskBand } from "./types.js";

/**
 * Risk score -> band mapping. Kept as a pure function so it's trivially
 * unit-testable and so the thresholds live in exactly one place.
 */
export function scoreToBand(score: number): RiskBand {
  if (score >= 80) return "critical";
  if (score >= 60) return "high-risk";
  if (score >= 30) return "suspicious";
  return "normal";
}

export function bandToDecision(band: RiskBand): GatewayDecision {
  switch (band) {
    case "critical":
      return "BLOCK";
    case "high-risk":
      return "THROTTLE";
    case "suspicious":
      return "ALLOW_MONITOR";
    case "normal":
    default:
      return "ALLOW";
  }
}

export function clampScore(score: number): number {
  return Math.max(0, Math.min(100, score));
}

/**
 * Matches a request path against a policy route pattern.
 * Supports exact match ("/login") and trailing wildcard ("/api/*").
 */
export function matchesRoute(pattern: string, path: string): boolean {
  if (pattern === "*" || pattern === "/*") return true;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    return path === prefix || path.startsWith(prefix + "/");
  }
  return pattern === path;
}

export function matchesMethod(policyMethod: HttpMethod, requestMethod: string): boolean {
  return policyMethod === "*" || policyMethod === requestMethod.toUpperCase();
}
