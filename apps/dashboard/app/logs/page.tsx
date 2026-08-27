"use client";

import { useEffect, useState } from "react";
import { api, type RequestLogEntry } from "@/lib/api";
import { Panel, Input, Select, Button, EmptyState, DecisionBadge, StatusCodeBadge } from "@/components/ui";

export default function LogsPage() {
  const [logs, setLogs] = useState<RequestLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [path, setPath] = useState("");
  const [identity, setIdentity] = useState("");
  const [decision, setDecision] = useState("");

  async function load() {
    setLoading(true);
    const { logs } = await api.logs({ path: path || undefined, identity: identity || undefined, decision: decision || undefined, limit: 200 });
    setLogs(logs);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-6">
      <Panel title="Filters">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            load();
          }}
          className="flex flex-wrap items-end gap-3"
        >
          <div>
            <label className="block text-[11px] text-text-muted mb-1">Path contains</label>
            <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/login" />
          </div>
          <div>
            <label className="block text-[11px] text-text-muted mb-1">Identity contains</label>
            <Input value={identity} onChange={(e) => setIdentity(e.target.value)} placeholder="127.0.0.1" />
          </div>
          <div>
            <label className="block text-[11px] text-text-muted mb-1">Decision</label>
            <Select value={decision} onChange={(e) => setDecision(e.target.value)}>
              <option value="">Any</option>
              <option value="ALLOW">ALLOW</option>
              <option value="ALLOW_MONITOR">ALLOW_MONITOR</option>
              <option value="THROTTLE">THROTTLE</option>
              <option value="BLOCK">BLOCK</option>
            </Select>
          </div>
          <Button type="submit">Apply</Button>
        </form>
      </Panel>

      <Panel title={`Request Logs${logs.length > 0 ? ` (${logs.length})` : ""}`}>
        {loading ? (
          <EmptyState message="Loading logs…" />
        ) : logs.length === 0 ? (
          <EmptyState message="No matching requests found." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-muted border-b border-base-border">
                  <th className="pb-2 font-normal">Time</th>
                  <th className="pb-2 font-normal">Method</th>
                  <th className="pb-2 font-normal">Path</th>
                  <th className="pb-2 font-normal">Status</th>
                  <th className="pb-2 font-normal">Latency</th>
                  <th className="pb-2 font-normal">Identity</th>
                  <th className="pb-2 font-normal">Decision</th>
                  <th className="pb-2 font-normal">Policy</th>
                  <th className="pb-2 font-normal">Risk</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.requestId} className="border-b border-base-borderMuted">
                    <td className="py-2 text-xs text-text-muted whitespace-nowrap">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="py-2 font-mono text-xs text-text-secondary">{log.method}</td>
                    <td className="py-2 font-mono text-xs text-text-primary">{log.path}</td>
                    <td className="py-2">
                      <StatusCodeBadge status={log.status} />
                    </td>
                    <td className="py-2 font-mono text-xs text-text-secondary">{log.latencyMs}ms</td>
                    <td className="py-2 font-mono text-xs text-text-secondary">{log.identity}</td>
                    <td className="py-2">
                      <DecisionBadge decision={log.decision} />
                    </td>
                    <td className="py-2 font-mono text-xs text-text-muted">{log.policyName ?? "—"}</td>
                    <td className="py-2 font-mono text-xs text-text-muted">{log.riskScore ?? "—"}</td>
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
