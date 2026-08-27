"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { clearToken, getToken, metricsStreamUrl } from "@/lib/api";

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/traffic", label: "Traffic" },
  { href: "/security", label: "Security" },
  { href: "/policies", label: "Policies" },
  { href: "/api-keys", label: "API Keys" },
  { href: "/logs", label: "Logs" },
  { href: "/simulator", label: "Simulator" },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
    }
  }, [router]);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    // A bare EventSource can't send an Authorization header, so we pass the
    // token as a query param for this one read-only stream endpoint.
    const es = new EventSource(`${metricsStreamUrl()}?token=${encodeURIComponent(token)}`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);

  if (pathname === "/login") return <>{children}</>;

  return (
    <div className="flex min-h-screen bg-base-bg">
      <aside className="w-56 shrink-0 border-r border-base-border bg-base-surface flex flex-col">
        <div className="px-5 py-5 border-b border-base-border">
          <div className="font-mono text-sm tracking-widest text-accent">SENTINEL</div>
          <div className="text-[11px] text-text-muted mt-0.5">API Gateway Console</div>
        </div>
        <nav className="flex-1 py-3">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`block px-5 py-2.5 text-sm border-l-2 transition-colors ${
                  active
                    ? "border-accent text-text-primary bg-base-raised"
                    : "border-transparent text-text-secondary hover:text-text-primary hover:bg-base-raised/50"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="px-5 py-4 border-t border-base-border">
          <button
            onClick={() => {
              clearToken();
              router.replace("/login");
            }}
            className="text-xs text-text-muted hover:text-text-secondary transition-colors"
          >
            Sign out
          </button>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b border-base-border bg-base-surface/60 backdrop-blur flex items-center justify-between px-6 shrink-0">
          <div className="text-sm text-text-secondary">{NAV.find((n) => n.href === pathname)?.label ?? ""}</div>
          <div className="flex items-center gap-2">
            <span
              className={`live-dot h-2 w-2 rounded-full ${connected ? "bg-signal-nominal" : "bg-text-muted"}`}
            />
            <span className="text-[11px] font-mono uppercase tracking-wide text-text-muted">
              {connected ? "live" : "connecting"}
            </span>
          </div>
        </header>
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
