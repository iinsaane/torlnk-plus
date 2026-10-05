import { WebTorrentBackend } from "./backends/webtorrent";
import { authenticatedServer } from "./http";
import type { BackendSettings, TorrentInput } from "./contracts";
import path from "node:path";
import { loadPlusConfig } from "./config";
const stateDir = process.env.TORLNK_PLUS_STATE_DIR ?? "/state";
const backend = new WebTorrentBackend(path.join(stateDir, "webtorrent"));
const config = await loadPlusConfig(process.env.TORLNK_PLUS_CONFIG_DIR ?? stateDir);
await backend.applySettings({ ...config.backendSettings, ...(config.network.forwardedPort ? { listenPort: config.network.forwardedPort } : {}) });
await backend.start();
const server = authenticatedServer(process.env.TORLNK_PLUS_WORKER_TOKEN ?? "", async (url, body, req) => {
  if (url.pathname !== "/rpc" || req.method !== "POST" || !Array.isArray(body.args)) throw new Error("Invalid RPC");
  const args = body.args as unknown[];
  const id = typeof args[0] === "string" ? args[0] : "";
  switch (body.method) {
    case "capabilities": return backend.capabilities;
    case "list": return backend.list();
    case "add": return backend.add(args[0] as TorrentInput);
    case "pause": return backend.pause(id);
    case "resume": return backend.resume(id);
    case "remove": return backend.remove(id, args[1] === true);
    case "recheck": return backend.recheck(id);
    case "exportTorrent": return Buffer.from(await backend.exportTorrent(id)).toString("base64");
    case "details": return backend.details(id);
    case "pieces": return backend.pieces(id);
    case "applySettings": return backend.applySettings(args[0] as Partial<BackendSettings>);
    case "checkpoint": return backend.checkpoint();
    case "stop": return backend.stop();
    default: throw new Error("Unknown RPC operation");
  }
});
server.listen(9163, "127.0.0.1");
async function shutdown() { await backend.stop(); server.close(); process.exit(0); }
process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
