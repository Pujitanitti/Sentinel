import type { PolicyRepository } from "@sentinel/database";
import type { Logger } from "@sentinel/logger";
import type { Policy } from "@sentinel/shared";
import { matchesMethod, matchesRoute } from "@sentinel/shared";

const REFRESH_INTERVAL_MS = 5000;

export class PolicyCache {
  private policies: Policy[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private repo: PolicyRepository,
    private logger: Logger
  ) {}

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => {
      this.refresh().catch((err) => {
        this.logger.error({ err: String(err) }, "policy cache refresh failed — keeping previous policies");
      });
    }, REFRESH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh(): Promise<void> {
    this.policies = await this.repo.listEnabled();
  }

  /** Returns every enabled policy whose route+method pattern matches this request. */
  matchingPolicies(path: string, method: string): Policy[] {
    return this.policies.filter((p) => matchesRoute(p.route, path) && matchesMethod(p.method, method));
  }

  all(): Policy[] {
    return this.policies;
  }
}
