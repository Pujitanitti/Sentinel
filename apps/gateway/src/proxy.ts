// Hop-by-hop headers must not be forwarded (RFC 7230 §6.1) — forwarding
// `connection`, `content-length`, etc. verbatim from the backend response
// causes issues with Node's http layer recomputing them.
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

export interface ProxyRequestInput {
  backendUrl: string;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer | undefined;
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export type ProxyResult = { ok: true; response: ProxyResponse } | { ok: false; error: string };

/**
 * Forwards a request to the demo backend (or any configured BACKEND_URL).
 * Returns `{ ok: false }` on network failure so the caller can respond with
 * 502 Bad Gateway rather than letting the error propagate and crash the request.
 */
export async function forwardToBackend(input: ProxyRequestInput): Promise<ProxyResult> {
  const url = new URL(input.path, input.backendUrl);

  const outgoingHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.headers)) {
    if (value === undefined) continue;
    if (key.toLowerCase() === "host") continue; // let fetch set the correct host for the backend
    outgoingHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
  }

  try {
    const res = await fetch(url, {
      method: input.method,
      headers: outgoingHeaders,
      body: input.method === "GET" || input.method === "HEAD" ? undefined : input.body,
    });

    const bodyBuffer = Buffer.from(await res.arrayBuffer());
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      if (!HOP_BY_HOP_HEADERS.has(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });

    return { ok: true, response: { status: res.status, headers: responseHeaders, body: bodyBuffer } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
