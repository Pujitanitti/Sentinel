"use client";

import { useEffect, useState } from "react";
import { api, type ApiKeyRecord } from "@/lib/api";
import { Panel, Button, Input, EmptyState } from "@/components/ui";

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { apiKeys } = await api.apiKeys();
    setKeys(apiKeys);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return;
    try {
      const { rawKey } = await api.createApiKey(name.trim(), ["public-api"]);
      setFreshKey(rawKey);
      setName("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create key");
    }
  }

  async function revoke(id: string) {
    await api.revokeApiKey(id);
    load();
  }

  return (
    <div className="space-y-6">
      <Panel title="Create API Key">
        <form onSubmit={create} className="flex items-end gap-3">
          <div className="flex-1 max-w-xs">
            <label className="block text-[11px] text-text-muted mb-1">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="mobile-app-prod" className="w-full" />
          </div>
          <Button type="submit">Create Key</Button>
        </form>
        {error && <div className="mt-2 text-xs text-signal-critical">{error}</div>}
        {freshKey && (
          <div className="mt-4 rounded border border-signal-suspicious/30 bg-signal-suspicious/10 p-3">
            <div className="text-xs text-signal-suspicious font-medium mb-1">
              Copy this key now — it won&apos;t be shown again.
            </div>
            <code className="text-sm font-mono text-text-primary break-all">{freshKey}</code>
          </div>
        )}
      </Panel>

      <Panel title="API Keys">
        {loading ? (
          <EmptyState message="Loading API keys…" />
        ) : keys.length === 0 ? (
          <EmptyState message="No API keys created yet." />
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-muted border-b border-base-border">
                <th className="pb-2 font-normal">Name</th>
                <th className="pb-2 font-normal">Prefix</th>
                <th className="pb-2 font-normal">Policies</th>
                <th className="pb-2 font-normal">Created</th>
                <th className="pb-2 font-normal">Status</th>
                <th className="pb-2 font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id} className="border-b border-base-borderMuted">
                  <td className="py-2 text-text-primary">{k.name}</td>
                  <td className="py-2 font-mono text-xs text-text-secondary">{k.keyPrefix}…</td>
                  <td className="py-2 font-mono text-xs text-text-secondary">{k.policyNames.join(", ") || "—"}</td>
                  <td className="py-2 text-xs text-text-muted">{new Date(k.createdAt).toLocaleDateString()}</td>
                  <td className="py-2">
                    <span
                      className={`text-xs font-mono px-1.5 py-0.5 rounded border ${
                        k.revoked
                          ? "text-signal-critical border-signal-critical/30 bg-signal-critical/10"
                          : "text-signal-nominal border-signal-nominal/30 bg-signal-nominal/10"
                      }`}
                    >
                      {k.revoked ? "revoked" : "active"}
                    </span>
                  </td>
                  <td className="py-2 text-right">
                    {!k.revoked && (
                      <button onClick={() => revoke(k.id)} className="text-xs text-signal-critical hover:underline">
                        revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
