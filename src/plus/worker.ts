import { promises as fs } from "node:fs";
import path from "node:path";
import { TorrentController } from "./controller";
import { QbittorrentBackend } from "./backends/qbittorrent";
import { RpcBackend } from "./backends/rpc";
import { authenticatedServer, JsonClient } from "./http";
import { loadPlusConfig } from "./config";
import type { BackendSettings, RouteStatus, TorrentInput } from "./contracts";
import type { ActiveToken } from "./controller";

const stateDir = process.env.TORLNK_PLUS_STATE_DIR ?? "/state";
const token = process.env.TORLNK_PLUS_WORKER_TOKEN ?? "";
const settingsDir = process.env.TORLNK_PLUS_CONFIG_DIR ?? stateDir;
const cfg = await loadPlusConfig(settingsDir);
const searchWorker = new JsonClient("http://127.0.0.1:9164", token, cfg.searchTimeoutMs + 5000);
const qbit = new QbittorrentBackend({ baseUrl: `http://127.0.0.1:${process.env.TORLNK_PLUS_QBIT_PORT ?? 8080}`, username: "admin", password: process.env.TORLNK_PLUS_QBIT_PASSWORD ?? "" });
const wt = new RpcBackend("http://127.0.0.1:9163", token);
const controller = new TorrentController([qbit, wt], { defaultBackend: cfg.defaultBackend, suspended: true, stateDir: path.join(stateDir, "controller") });
async function routeStatus(): Promise<RouteStatus> {
  try { return JSON.parse(await fs.readFile(path.join(settingsDir, "network-status.json"), "utf8")); }
  catch { return { mode: cfg.network.mode ?? "vpn", state: "Blocked", message: "Waiting for routing verification" }; }
}
async function permitted() { const r = await routeStatus(); if (r.state !== "Protected" && r.state !== "Direct") throw new Error("Traffic is blocked while routing changes"); }
const startup = controller.start().then(async snapshot => {
  const route = await routeStatus();
  // A container restart in an established namespace must restore controller policy.
  if (["Direct", "Protected"].includes(route.state)) await controller.resumeActive([]);
  return snapshot;
});
const server = authenticatedServer(token, async (url, body, request) => {
  await startup;
  if (url.pathname === "/snapshot" && request.method === "GET") {
    const route = await routeStatus();
    if (["Direct", "Protected"].includes(route.state)) await controller.activatePolicy();
    const snapshot = await controller.snapshot(); snapshot.route = route; return snapshot;
  }
  if (url.pathname === "/searchHealth") { try { await searchWorker.request("/health"); return { available: true }; } catch { return { available: false, message: "Search worker unavailable" }; } }
  if (url.pathname === "/capabilities") {
    const common: (keyof BackendSettings)[] = ["maxDownloads", "seedRatio", "seedTimeMinutes", "completionAction"];
    return Object.fromEntries([qbit, wt].map(b => [b.kind, { ...b.capabilities, settings: [...new Set([...b.capabilities.settings, ...common])] }]));
  }
  if (url.pathname === "/search" && request.method === "POST") {
    await permitted();
    if (typeof body.query !== "string" || body.query.length > 500) throw new Error("Invalid search query");
    const config = await loadPlusConfig(settingsDir);
    return new JsonClient("http://127.0.0.1:9164", token, config.searchTimeoutMs + 5000).request("/search", { query: body.query });
  }
  if (url.pathname !== "/command" || request.method !== "POST") throw new Error("Unknown endpoint");
  const id = typeof body.id === "string" && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(body.id) ? body.id : "";
  if (["pause", "resume", "remove", "recheck", "export", "details", "pieces"].includes(String(body.action)) && !id) throw new Error("Invalid torrent hash");
  switch (body.action) {
    case "add": {
      await permitted(); const input = body.input as TorrentInput;
      const config = await loadPlusConfig(settingsDir);
      if (!input || ![config.downloadDir, ...config.extraDownloadDirs].includes(input.savePath)) throw new Error("Download folder is not mounted");
      return controller.add({ ...input, backend: input.backend ?? config.defaultBackend });
    }
    case "pause": return controller.pause(id);
    case "resume": await permitted(); return controller.resume(id);
    case "remove": return controller.remove(id, body.deleteData === true);
    case "recheck": return controller.recheck(id);
    case "export": return Buffer.from(await controller.exportTorrent(id)).toString("base64");
    case "details": return controller.details(id);
    case "pieces": return controller.pieces(id);
    case "checkpoint": return controller.checkpoint();
    case "pauseActive": await searchWorker.request("/pause", {}).catch(() => {}); return controller.pauseActive();
    case "resumeActive": await permitted(); return controller.resumeActive(body.tokens as ActiveToken[]);
    case "applySettings": return controller.applySettings(body.settings as Partial<BackendSettings>);
    default: throw new Error("Unknown command");
  }
});
server.listen(9162, "0.0.0.0");
async function shutdown() { await searchWorker.request("/pause", {}).catch(() => {}); await controller.checkpoint().catch(() => {}); server.close(); process.exit(0); }
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
