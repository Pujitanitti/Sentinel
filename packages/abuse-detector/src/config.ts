export interface AbuseDetectionConfig {
  /** How many recent requests per identity to retain for pattern analysis. */
  historyMaxLen: number;
  /** How long history/risk-score keys live in Redis before expiring (score "decay"). */
  riskScoreTtlSeconds: number;

  // Burst detection: N+ requests within a short rolling window.
  burstThresholdRequests: number;
  burstWindowMs: number;
  burstPoints: number;

  // Repeated auth failures (401s on auth-ish routes) within recent history.
  authFailureThreshold: number;
  authFailurePoints: number;

  // Endpoint scanning: many distinct routes hit within recent history.
  scanDistinctEndpointThreshold: number;
  scanPoints: number;

  // High error rate within recent history (needs a minimum sample to avoid false positives on 1-2 requests).
  errorRateThreshold: number; // 0..1
  errorRateMinSamples: number;
  errorRatePoints: number;

  // Applied once when the identity is already in the durable blocklist.
  knownBlockedPoints: number;
}

export const DEFAULT_ABUSE_CONFIG: AbuseDetectionConfig = {
  historyMaxLen: 50,
  riskScoreTtlSeconds: 300,

  burstThresholdRequests: 20,
  burstWindowMs: 3000,
  burstPoints: 10,

  authFailureThreshold: 5,
  authFailurePoints: 15,

  scanDistinctEndpointThreshold: 8,
  scanPoints: 20,

  errorRateThreshold: 0.7,
  errorRateMinSamples: 10,
  errorRatePoints: 15,

  knownBlockedPoints: 30,
};
