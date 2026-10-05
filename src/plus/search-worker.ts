import { promises as fs } from "node:fs";
import path from "node:path";
import { authenticatedServer } from "./http";
import { loadPlusConfig } from "./config";
import { search } from "./search";
import type { RouteStatus } from "./contracts";
const settingsDir = process.env.TORLNK_PLUS_CONFIG_DIR ?? "/state";
const searches = new Set<AbortController>();
const server = authenticatedServer(process.env.TORLNK_PLUS_WORKER_TOKEN ?? "", async (url, body) => {
  if (url.pathname === "/health") return { ready: true };
  if (url.pathname === "/pause") { for (const cancel of searches) cancel.abort(); return null; }
  if (url.pathname !== "/search" || typeof body.query !== "string" || body.query.length > 500) throw new Error("Invalid search request");
  const route: RouteStatus = JSON.parse(await fs.readFile(path.join(settingsDir, "network-status.json"), "utf8"));
  if (!["Direct", "Protected"].includes(route.state)) throw new Error("Search is blocked until routing is ready");
  const cancel = new AbortController(); searches.add(cancel);
  try { return await search(body.query, await loadPlusConfig(settingsDir), cancel.signal); }
  finally { searches.delete(cancel); }
});
server.listen(9164, "127.0.0.1");
function stop() { for (const cancel of searches) cancel.abort(); server.close(); process.exit(0); }
process.on("SIGTERM", stop); process.on("SIGINT", stop);
