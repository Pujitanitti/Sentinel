"use client";

import { useEffect, useState } from "react";
import { getToken, metricsStreamUrl, type GatewayMetricsSnapshot } from "@/lib/api";
import { Panel, StatCard, EmptyState } from "@/components/ui";

export default function OverviewPage() {
  const [metrics, setMetrics] = useState<GatewayMetricsSnapshot | null>(null);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    const es = new EventSource(`${metricsStreamUrl()}?token=${encodeURIComponent(token)}`);
    es.onmessage = (event) => setMetrics(JSON.parse(event.data));
    return () => es.close();
  }, []);

  if (!metrics) {
    return <EmptyState message="Connecting to Sentinel metrics stream…" />;
  }

  const blockRate = metrics.totalRequests > 0 ? Math.round((metrics.blockedRequests / metrics.totalRequests) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Requests" value={metrics.totalRequests.toLocaleString()} />
        <StatCard label="Allowed" value={metrics.allowedRequests.toLocaleString()} tone="nominal" />
        <StatCard label="Blocked" value={metrics.blockedRequests.toLocaleString()} tone={blockRate > 10 ? "critical" : "high"} sublabel={`${blockRate}% of traffic`} />
        <StatCard label="Rate Limited" value={metrics.rateLimitedRequests.toLocaleString()} tone="suspicious" />
        <StatCard label="Abuse Detections" value={metrics.abuseDetections.toLocaleString()} tone="high" />
        <StatCard label="Avg Latency" value={`${metrics.avgLatencyMs}ms`} />
        <StatCard label="p95 Latency" value={`${metrics.p95LatencyMs}ms`} />
        <StatCard label="p99 Latency" value={`${metrics.p99LatencyMs}ms`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Panel title="Response Codes">
          <div className="space-y-2">
            <Row label="2xx / 3xx" value={metrics.totalRequests - metrics.count4xx - metrics.count5xx} tone="nominal" />
            <Row label="4xx" value={metrics.count4xx} tone="high" />
            <Row label="5xx" value={metrics.count5xx} tone="critical" />
          </div>
        </Panel>

        <Panel title="Top Endpoints">
          <TopList data={metrics.requestsByEndpoint} emptyMessage="No traffic yet." />
        </Panel>

        <Panel title="Top Client IPs">
          <TopList data={metrics.requestsByIp} emptyMessage="No traffic yet." />
        </Panel>
      </div>

      <div className="text-xs text-text-muted font-mono">
        window: {new Date(metrics.windowStart).toLocaleTimeString()} – {new Date(metrics.windowEnd).toLocaleTimeString()}
      </div>
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: number; tone: "nominal" | "high" | "critical" }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className={`font-mono text-signal-${tone}`}>{value.toLocaleString()}</span>
    </div>
  );
}

function TopList({ data, emptyMessage }: { data: Record<string, number>; emptyMessage: string }) {
  const entries = Object.entries(data);
  if (entries.length === 0) return <EmptyState message={emptyMessage} />;
  return (
    <div className="space-y-2">
      {entries.slice(0, 8).map(([key, count]) => (
        <div key={key} className="flex items-center justify-between text-sm">
          <span className="text-text-secondary font-mono truncate max-w-[70%]">{key}</span>
          <span className="text-text-primary font-mono">{count.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}
