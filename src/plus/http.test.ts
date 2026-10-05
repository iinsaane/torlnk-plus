import { expect, it } from "vitest";
import { once } from "node:events";
import { authenticatedServer, JsonClient } from "./http";
it("protects real management HTTP requests and does not dispatch unauthorized or invalid methods", async () => {
  let calls = 0;
  const server = authenticatedServer("t".repeat(64), async (_url, body) => { calls++; if (body.fail) throw new Error("controlled failure"); return body; });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    expect((await fetch(base)).status).toBe(401);
    expect((await fetch(base, { headers: { Authorization: "Bearer " + "é".repeat(64) } })).status).toBe(401);
    expect(calls).toBe(0);
    const client = new JsonClient(base, "t".repeat(64));
    expect(await client.request("/command", { hello: "world" })).toEqual({ hello: "world" });
    await expect(client.request("/command", { fail: true })).rejects.toThrow("controlled failure");
    expect((await fetch(base, { method: "DELETE", headers: { Authorization: "Bearer " + "t".repeat(64) } })).status).toBe(405);
  } finally { server.close(); await once(server, "close"); }
});
