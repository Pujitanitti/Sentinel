"use client";

import { useEffect, useState } from "react";
import { api, type Policy, type RateLimitStrategy, type IdentityType } from "@/lib/api";
import { Panel, Button, Input, Select, EmptyState } from "@/components/ui";

const STRATEGIES: RateLimitStrategy[] = ["fixed-window", "sliding-window", "token-bucket"];
const IDENTITY_OPTIONS: IdentityType[] = ["ip", "api-key", "user"];

export default function PoliciesPage() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  async function load() {
    const { policies } = await api.policies();
    setPolicies(policies);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  async function toggleEnabled(policy: Policy) {
    await api.updatePolicy(policy.id, { enabled: !policy.enabled });
    load();
  }

  async function remove(id: string) {
    await api.deletePolicy(id);
    load();
  }

  return (
    <div className="space-y-6">
      <Panel
        title="Policies"
        action={
          <Button onClick={() => setShowForm((s) => !s)} variant="secondary">
            {showForm ? "Cancel" : "New Policy"}
          </Button>
        }
      >
        {showForm && (
          <NewPolicyForm
            onCreated={() => {
              setShowForm(false);
              load();
            }}
          />
        )}

        {loading ? (
          <EmptyState message="Loading policies…" />
        ) : policies.length === 0 ? (
          <EmptyState message="No policies configured yet." />
        ) : (
          <div className="overflow-x-auto mt-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-text-muted border-b border-base-border">
                  <th className="pb-2 font-normal">Name</th>
                  <th className="pb-2 font-normal">Route</th>
                  <th className="pb-2 font-normal">Method</th>
                  <th className="pb-2 font-normal">Limit</th>
                  <th className="pb-2 font-normal">Window</th>
                  <th className="pb-2 font-normal">Strategy</th>
                  <th className="pb-2 font-normal">Identities</th>
                  <th className="pb-2 font-normal">Status</th>
                  <th className="pb-2 font-normal"></th>
                </tr>
              </thead>
              <tbody>
                {policies.map((p) => (
                  <tr key={p.id} className="border-b border-base-borderMuted">
                    <td className="py-2 font-mono text-xs text-text-primary">{p.name}</td>
                    <td className="py-2 font-mono text-xs text-text-secondary">{p.route}</td>
                    <td className="py-2 font-mono text-xs text-text-secondary">{p.method}</td>
                    <td className="py-2 font-mono text-xs text-text-secondary">{p.limit}</td>
                    <td className="py-2 font-mono text-xs text-text-secondary">{p.windowSeconds}s</td>
                    <td className="py-2 font-mono text-xs text-text-secondary">{p.strategy}</td>
                    <td className="py-2 font-mono text-xs text-text-secondary">{p.identityTypes.join(", ")}</td>
                    <td className="py-2">
                      <button
                        onClick={() => toggleEnabled(p)}
                        className={`text-xs font-mono px-1.5 py-0.5 rounded border ${
                          p.enabled
                            ? "text-signal-nominal border-signal-nominal/30 bg-signal-nominal/10"
                            : "text-text-muted border-base-border"
                        }`}
                      >
                        {p.enabled ? "enabled" : "disabled"}
                      </button>
                    </td>
                    <td className="py-2 text-right">
                      <button onClick={() => remove(p.id)} className="text-xs text-signal-critical hover:underline">
                        delete
                      </button>
                    </td>
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

function NewPolicyForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [route, setRoute] = useState("/api/*");
  const [method, setMethod] = useState("*");
  const [limit, setLimit] = useState(100);
  const [windowSeconds, setWindowSeconds] = useState(60);
  const [strategy, setStrategy] = useState<RateLimitStrategy>("fixed-window");
  const [identityTypes, setIdentityTypes] = useState<IdentityType[]>(["ip"]);
  const [error, setError] = useState<string | null>(null);

  function toggleIdentity(type: IdentityType) {
    setIdentityTypes((prev) => (prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim() || identityTypes.length === 0) {
      setError("Name and at least one identity type are required.");
      return;
    }
    try {
      await api.createPolicy({
        name: name.trim(),
        route,
        method: method as Policy["method"],
        limit,
        windowSeconds,
        strategy,
        identityTypes,
        enabled: true,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create policy");
    }
  }

  return (
    <form onSubmit={submit} className="mb-4 grid grid-cols-2 md:grid-cols-4 gap-3 p-3 rounded border border-base-border bg-base-bg">
      <Field label="Name">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="checkout-protection" className="w-full" />
      </Field>
      <Field label="Route">
        <Input value={route} onChange={(e) => setRoute(e.target.value)} placeholder="/api/*" className="w-full" />
      </Field>
      <Field label="Method">
        <Select value={method} onChange={(e) => setMethod(e.target.value)} className="w-full">
          {["*", "GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Strategy">
        <Select value={strategy} onChange={(e) => setStrategy(e.target.value as RateLimitStrategy)} className="w-full">
          {STRATEGIES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Limit">
        <Input
          type="number"
          min={1}
          value={limit}
          onChange={(e) => setLimit(parseInt(e.target.value, 10) || 1)}
          className="w-full"
        />
      </Field>
      <Field label="Window (seconds)">
        <Input
          type="number"
          min={1}
          value={windowSeconds}
          onChange={(e) => setWindowSeconds(parseInt(e.target.value, 10) || 1)}
          className="w-full"
        />
      </Field>
      <Field label="Identity types">
        <div className="flex gap-3 pt-1.5">
          {IDENTITY_OPTIONS.map((type) => (
            <label key={type} className="flex items-center gap-1.5 text-xs text-text-secondary">
              <input type="checkbox" checked={identityTypes.includes(type)} onChange={() => toggleIdentity(type)} />
              {type}
            </label>
          ))}
        </div>
      </Field>
      <div className="flex items-end">
        <Button type="submit">Create Policy</Button>
      </div>
      {error && <div className="col-span-full text-xs text-signal-critical">{error}</div>}
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] text-text-muted mb-1">{label}</label>
      {children}
    </div>
  );
}
