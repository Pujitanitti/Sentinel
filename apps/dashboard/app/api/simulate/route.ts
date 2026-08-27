import { NextResponse } from "next/server";

// This route runs on the dashboard's Next.js SERVER, not in the browser.
// NEXT_PUBLIC_GATEWAY_URL is the browser-facing address (e.g. http://localhost:3000),
// which does not resolve from inside a Docker container. GATEWAY_INTERNAL_URL
// lets docker-compose point server-side calls at the gateway's service name instead.
const GATEWAY_URL = process.env.GATEWAY_INTERNAL_URL ?? process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:3000";

type Scenario = "normal" | "burst" | "failed-login" | "endpoint-scanner" | "high-error";

interface SimulatedCall {
  path: string;
  method: string;
  body?: unknown;
}

function buildCalls(scenario: Scenario): SimulatedCall[] {
  switch (scenario) {
    case "normal":
      return Array.from({ length: 8 }, () => ({ path: "/products", method: "GET" }));
    case "burst":
      return Array.from({ length: 30 }, () => ({ path: "/products", method: "GET" }));
    case "failed-login":
      return Array.from({ length: 8 }, () => ({
        path: "/login",
        method: "POST",
        body: { username: "attacker", password: "guess" + Math.random().toString(36).slice(2, 6) },
      }));
    case "endpoint-scanner":
      return ["/api/users", "/api/orders", "/api/admin", "/api/config", "/api/debug", "/api/users", "/api/orders"].map(
        (path) => ({ path, method: "GET" })
      );
    case "high-error":
      return Array.from({ length: 15 }, () => ({ path: "/error", method: "GET" }));
    default:
      return [];
  }
}

export async function POST(req: Request) {
  const { scenario } = (await req.json()) as { scenario: Scenario };
  const calls = buildCalls(scenario);

  if (calls.length === 0) {
    return NextResponse.json({ error: "Unknown scenario" }, { status: 400 });
  }

  const concurrent = scenario === "burst";

  const statusCounts: Record<string, number> = {};

  async function fire(call: SimulatedCall) {
    try {
      const res = await fetch(`${GATEWAY_URL}${call.path}`, {
        method: call.method,
        headers: call.body ? { "Content-Type": "application/json" } : undefined,
        body: call.body ? JSON.stringify(call.body) : undefined,
        // Distinguish the simulator's own traffic in gateway logs without
        // affecting rate-limit/abuse identity (it's just an IP like any other caller).
        cache: "no-store",
      });
      statusCounts[res.status] = (statusCounts[res.status] ?? 0) + 1;
    } catch {
      statusCounts["error"] = (statusCounts["error"] ?? 0) + 1;
    }
  }

  if (concurrent) {
    await Promise.all(calls.map(fire));
  } else {
    for (const call of calls) {
      await fire(call);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }

  return NextResponse.json({ scenario, requestsSent: calls.length, statusCounts });
}
