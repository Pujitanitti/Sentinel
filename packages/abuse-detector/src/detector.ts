import type { RedisClient, RequestHistoryEvent } from "@sentinel/redis";
import { pushRequestEvent, getRequestHistory, incrRiskScore, getRiskScore, getTemporaryBlock } from "@sentinel/redis";
import type { Identity, RiskAssessment } from "@sentinel/shared";
import { bandToDecision, clampScore, scoreToBand } from "@sentinel/shared";
import type { Logger } from "@sentinel/logger";
import { DEFAULT_ABUSE_CONFIG, type AbuseDetectionConfig } from "./config.js";
import { knownBlockedEntry, runAllRules } from "./rules.js";

export interface AbuseDetectorOptions {
  client: RedisClient;
  logger: Logger;
  config?: Partial<AbuseDetectionConfig>;
}

export interface RecordAndAssessInput {
  identity: Identity;
  path: string;
  method: string;
  status: number;
}

export interface AbuseDetector {
  /**
   * Records the just-completed request in the identity's history and
   * recomputes its risk assessment. Called from response-finish middleware
   * (after status is known) so error-rate/auth-failure rules see real outcomes.
   */
  recordAndAssess(input: RecordAndAssessInput): Promise<RiskAssessment>;

  /** Cheap pre-request check: is this identity already over a block threshold? */
  getCurrentAssessment(identity: Identity): Promise<RiskAssessment>;
}

function identityKey(identity: Identity): string {
  return `${identity.type}:${identity.value}`;
}

export function createAbuseDetector(opts: AbuseDetectorOptions): AbuseDetector {
  const { client, logger } = opts;
  const cfg: AbuseDetectionConfig = { ...DEFAULT_ABUSE_CONFIG, ...opts.config };

  /** Shared, read-only: computes which rules fire against a history snapshot, without touching the stored score. */
  async function computeBreakdown(identity: Identity, history: RequestHistoryEvent[], now: number) {
    const key = identityKey(identity);
    const breakdown = runAllRules(history, now, cfg);

    const block = await getTemporaryBlock(client, key).catch(() => null);
    if (block) {
      breakdown.push(knownBlockedEntry(cfg));
    }
    return breakdown;
  }

  function toAssessment(identity: Identity, score: number, breakdown: ReturnType<typeof knownBlockedEntry>[], now: number): RiskAssessment {
    const band = scoreToBand(score);
    return {
      identity,
      score,
      band,
      decision: bandToDecision(band),
      breakdown,
      evaluatedAt: new Date(now).toISOString(),
    };
  }

  return {
    async recordAndAssess({ identity, path, method, status }) {
      const key = identityKey(identity);
      const now = Date.now();
      const event: RequestHistoryEvent = { path, method, status, ts: now };

      await pushRequestEvent(client, key, event, cfg.historyMaxLen, cfg.riskScoreTtlSeconds).catch((err) => {
        logger.error({ err: String(err) }, "failed to record request history for abuse detection");
      });

      const history = await getRequestHistory(client, key).catch(() => [] as RequestHistoryEvent[]);
      const breakdown = await computeBreakdown(identity, history, now);
      const pointsThisEvaluation = breakdown.reduce((sum, b) => sum + b.points, 0);

      // This is the ONLY place the persisted risk score is mutated — a single
      // real request (with a known outcome) is what should move the score.
      let score: number;
      if (pointsThisEvaluation > 0) {
        score = await incrRiskScore(client, key, pointsThisEvaluation, cfg.riskScoreTtlSeconds).catch((err) => {
          logger.error({ err: String(err) }, "failed to persist risk score increment — falling back to existing score");
          return 0;
        });
      } else {
        score = await getRiskScore(client, key).catch(() => 0);
      }

      return toAssessment(identity, clampScore(score), breakdown, now);
    },

    async getCurrentAssessment(identity: Identity) {
      // Read-only: reflects current history/score for a pre-request decision,
      // but never increments the score itself (that only happens once the
      // request's real outcome is known, in recordAndAssess).
      const key = identityKey(identity);
      const now = Date.now();
      const history = await getRequestHistory(client, key).catch(() => [] as RequestHistoryEvent[]);
      const breakdown = await computeBreakdown(identity, history, now);
      const score = await getRiskScore(client, key).catch(() => 0);
      return toAssessment(identity, clampScore(score), breakdown, now);
    },
  };
}
