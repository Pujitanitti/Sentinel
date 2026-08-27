"use client";

import { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import { getToken, metricsStreamUrl, type GatewayMetricsSnapshot } from "@/lib/api";
import { Panel, EmptyState } from "@/components/ui";

const AXIS_COLOR = "#5F6B7A";
const GRID_COLOR = "#1A1F26";

export default function TrafficPage() {
  const [metrics, setMetrics] = useState<GatewayMetricsSnapshot | null>(null);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    const es = new EventSource(`${metricsStreamUrl()}?token=${encodeURIComponent(token)}`);
    es.onmessage = (event) => setMetrics(JSON.parse(event.data));
    return () => es.close();
  }, []);

  if (!metrics) return <EmptyState message="Connecting to Sentinel metrics stream…" />;

  const chartData = metrics.timeSeries.map((point) => ({
    time: new Date(point.timestamp).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" }),
    Allowed: point.allowed,
    Blocked: point.blocked,
    "Avg Latency (ms)": point.avgLatencyMs,
  }));

  if (chartData.length === 0) {
    return <EmptyState message="No traffic recorded yet. Send some requests through the gateway, or use the Simulator." />;
  }

  return (
    <div className="space-y-6">
      <Panel title="Requests Over Time">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={chartData}>
            <CartesianGrid stroke={GRID_COLOR} vertical={false} />
            <XAxis dataKey="time" stroke={AXIS_COLOR} fontSize={11} tickLine={false} />
            <YAxis stroke={AXIS_COLOR} fontSize={11} tickLine={false} />
            <Tooltip contentStyle={{ background: "#12161C", border: "1px solid #232A33", fontSize: 12 }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line type="monotone" dataKey="Allowed" stroke="#3ED598" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="Blocked" stroke="#F0555C" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </Panel>

      <Panel title="Average Latency Over Time">
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData}>
            <CartesianGrid stroke={GRID_COLOR} vertical={false} />
            <XAxis dataKey="time" stroke={AXIS_COLOR} fontSize={11} tickLine={false} />
            <YAxis stroke={AXIS_COLOR} fontSize={11} tickLine={false} unit="ms" />
            <Tooltip contentStyle={{ background: "#12161C", border: "1px solid #232A33", fontSize: 12 }} />
            <Line type="monotone" dataKey="Avg Latency (ms)" stroke="#F5C244" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </Panel>
    </div>
  );
}
