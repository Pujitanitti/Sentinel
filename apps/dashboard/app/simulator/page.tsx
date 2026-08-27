"use client";

import { useState } from "react";
import { Panel, Button, EmptyState } from "@/components/ui";

interface Scenario {
  id: string;
  title: string;
  description: string;
  expect: string;
}

const SCENARIOS: Scenario[] = [
  {
    id: "normal",
    title: "Normal Traffic",
    description: "8 ordinary GET /products requests, spaced out.",
    expect: "All requests allowed. No security events.",
  },
  {
    id: "burst",
    title: "Burst Traffic",
    description: "30 concurrent GET /products requests.",
    expect: "Burst detection fires; risk score rises; possible throttle/block.",
  },
  {
    id: "failed-login",
    title: "Failed Login Attack",
    description: "8 rapid POST /login attempts with bad credentials.",
    expect: "login-protection policy rate-limits after 5; auth-failure rule fires.",
  },
  {
    id: "endpoint-scanner",
    title: "Endpoint Scanner",
    description: "Probes /api/users, /api/orders, /api/admin, /api/config, /api/debug.",
    expect: "Endpoint-scanning rule fires once enough distinct routes are hit.",
  },
  {
    id: "high-error",
    title: "High Error Traffic",
    description: "15 rapid GET /error requests (always returns 500).",
    expect: "High-error-rate rule fires once error ratio crosses threshold.",
  },
];

interface RunResult {
  scenario: string;
  requestsSent: number;
  statusCounts: Record<string, number>;
}

export default function SimulatorPage() {
  const [running, setRunning] = useState<string | null>(null);
  const [results, setResults] = useState<RunResult[]>([]);

  async function run(scenario: string) {
    setRunning(scenario);
    try {
      const res = await fetch("/api/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario }),
      });
      const data = await res.json();
      setResults((prev) => [data, ...prev].slice(0, 10));
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="space-y-6">
      <Panel title="Traffic Simulator">
        <p className="text-sm text-text-secondary mb-4">
          Each button below sends real HTTP requests through the Sentinel gateway — nothing here is faked or
          pre-recorded. Watch the Overview, Traffic, and Security pages update as these run.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {SCENARIOS.map((s) => (
            <div key={s.id} className="rounded border border-base-border bg-base-bg p-4 flex flex-col">
              <div className="text-sm font-medium text-text-primary">{s.title}</div>
              <div className="text-xs text-text-secondary mt-1 flex-1">{s.description}</div>
              <div className="text-[11px] text-text-muted mt-2 italic">Expect: {s.expect}</div>
              <div className="mt-3">
                <Button onClick={() => run(s.id)} disabled={running !== null} variant="secondary">
                  {running === s.id ? "Running…" : "Run"}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Run History">
        {results.length === 0 ? (
          <EmptyState message="Run a scenario above to see results here." />
        ) : (
          <div className="space-y-2">
            {results.map((r, i) => (
              <div key={i} className="flex items-center justify-between text-sm border-b border-base-borderMuted pb-2">
                <span className="text-text-primary">{r.scenario}</span>
                <span className="font-mono text-xs text-text-secondary">
                  {r.requestsSent} sent —{" "}
                  {Object.entries(r.statusCounts)
                    .map(([code, count]) => `${code}:${count}`)
                    .join(" ")}
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
