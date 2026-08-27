"use client";

import { useEffect, useState } from "react";
import { api, type SecurityEvent } from "@/lib/api";
import { Panel, EmptyState } from "@/components/ui";

const EVENT_COLOR: Record<string, string> = {
  RATE_LIMIT_EXCEEDED: "text-signal-suspicious",
  ABUSE_DETECTED: "text-signal-high",
  TEMPORARY_BLOCK: "text-signal-critical",
  API_KEY_REVOKED: "text-text-secondary",
  AUTH_FAILURE: "text-signal-high",
  ENDPOINT_SCANNING: "text-signal-critical",
  HIGH_ERROR_RATE: "text-signal-high",
};

export default function SecurityPage() {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.securityEvents>> | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const result = await api.securityEvents(200);
      setData(result);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const interval = setInterval(load, 4000);
    return () => clearInterval(interval);
  }, []);

  if (loading && !data) return <EmptyState message="Loading security events…" />;
  if (!data) return <EmptyState message="Unable to load security events." />;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Panel title="Top Suspicious Identities (24h)">
          {data.topSuspiciousIdentities.length === 0 ? (
            <EmptyState message="No suspicious activity recorded." />
          ) : (
            <div className="space-y-2">
              {data.topSuspiciousIdentities.map((item) => (
                <div key={`${item.identityType}:${item.identityValue}`} className="flex items-center justify-between text-sm">
                  <span className="font-mono text-text-secondary">
                    {item.identityType}:{item.identityValue}
                  </span>
                  <span className="font-mono text-signal-high">{item.eventCount} events</span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Top Targeted Endpoints (24h)">
          {data.topTargetedEndpoints.length === 0 ? (
            <EmptyState message="No targeted endpoints recorded." />
          ) : (
            <div className="space-y-2">
              {data.topTargetedEndpoints.map((item) => (
                <div key={item.route} className="flex items-center justify-between text-sm">
                  <span className="font-mono text-text-secondary">{item.route}</span>
                  <span className="font-mono text-signal-high">{item.eventCount} events</span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Recent Security Events">
        {data.events.length === 0 ? (
          <EmptyState message="No security events yet. Try the Simulator to generate some real traffic patterns." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-muted border-b border-base-border">
                  <th className="pb-2 font-normal">Type</th>
                  <th className="pb-2 font-normal">Identity</th>
                  <th className="pb-2 font-normal">Route</th>
                  <th className="pb-2 font-normal">Risk Score</th>
                  <th className="pb-2 font-normal">When</th>
                </tr>
              </thead>
              <tbody>
                {data.events.map((event: SecurityEvent) => (
                  <tr key={event.id} className="border-b border-base-borderMuted">
                    <td className={`py-2 font-mono text-xs ${EVENT_COLOR[event.type] ?? "text-text-secondary"}`}>
                      {event.type}
                    </td>
                    <td className="py-2 font-mono text-xs text-text-secondary">
                      {event.identityType}:{event.identityValue}
                    </td>
                    <td className="py-2 font-mono text-xs text-text-secondary">{event.route ?? "—"}</td>
                    <td className="py-2 font-mono text-xs text-text-primary">{event.riskScore ?? "—"}</td>
                    <td className="py-2 text-xs text-text-muted">{new Date(event.createdAt).toLocaleTimeString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
