import http from "node:http";
import { timingSafeEqual } from "node:crypto";

export type Handler = (url: URL, body: Record<string, unknown>, request: http.IncomingMessage) => Promise<unknown>;
export function authenticatedServer(token: string, handler: Handler): http.Server {
  if (token.length < 32) throw new Error("A private management token is required");
  return http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    const value = req.headers.authorization ?? "";
    const expected = `Bearer ${token}`;
    const givenBytes = Buffer.from(value), expectedBytes = Buffer.from(expected);
    if (givenBytes.length !== expectedBytes.length || !timingSafeEqual(givenBytes, expectedBytes)) {
      res.writeHead(401); res.end(JSON.stringify({ error: "Unauthorized" })); return;
    }
    try {
      if (req.method !== "GET" && req.method !== "POST") { res.writeHead(405); res.end('{}'); return; }
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) throw new Error("Request exceeds 16 MiB");
        chunks.push(Buffer.from(chunk));
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      if (!body || Array.isArray(body) || typeof body !== "object") throw new Error("Expected a JSON object");
      const result = await handler(new URL(req.url ?? "/", "http://127.0.0.1"), body, req);
      res.end(JSON.stringify({ result: result ?? null }));
    } catch (err) {
      res.writeHead(400); res.end(JSON.stringify({ error: err instanceof Error ? err.message : "Request failed" }));
    }
  });
}
export class JsonClient {
  constructor(readonly baseUrl: string, private token: string, private timeoutMs = 15000) {}
  async request<T = unknown>(route: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${route}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(body === undefined ? Math.min(this.timeoutMs, 5000) : this.timeoutMs) });
    const response = await res.json() as { result?: T; error?: string };
    if (!res.ok || response.error) throw new Error(response.error ?? `Service HTTP ${res.status}`);
    return response.result as T;
  }
}
