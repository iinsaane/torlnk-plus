import { promises as fs } from "node:fs";
import path from "node:path";
import { renderUI } from "../src/ui/testHarness";
import { ansiToSvg } from "./ansi-to-svg";
import { PlusApp } from "../src/plus/ui/App";
import { defaultPlusConfig } from "../src/plus/config";
import type { AppState } from "../src/plus/client";
import type { JsonClient } from "../src/plus/http";
const config = defaultPlusConfig(); config.network.mode = "vpn"; config.network.profileId = "a".repeat(16);
const hash = "1".repeat(40);
const fixture: AppState = { config, profiles: [{ id: config.network.profileId, name: "Amsterdam · Windscribe", provider: "windscribe", protocol: "wireguard", endpoint: "VPN endpoint", port: 443 }], capabilities: { qbittorrent: { settings: Object.keys(config.backendSettings) as never, recheck: true, files: true, pieces: true, export: true } }, snapshot: { route: { mode: "vpn", state: "Protected", message: "Windscribe WireGuard · UDP 443" }, backends: [{ backend: "qbittorrent", available: true }, { backend: "webtorrent", available: true }], torrents: [{ id: hash, name: "Controlled engineering dataset", backend: "qbittorrent", state: "downloading", progress: .62, downloaded: 620000000, total: 1000000000, uploaded: 32000000, downloadSpeed: 8200000, uploadSpeed: 123000, peers: 18, etaSeconds: 47, ratio: .052, addedAt: Date.now() - 300000, savePath: "/home/user/Downloads/torlnk-plus" }] }, services: ["supervisor", "controller", "gateway", "search", "qbittorrent", "webtorrent"].map(service => ({ service: service as never, state: "healthy", checkedAt: Date.now(), lastSuccessAt: Date.now(), message: "Responding" })) };
fixture.snapshot.torrents.push({ ...fixture.snapshot.torrents[0]!, id: "3".repeat(40), name: "Reference sample collection", backend: "webtorrent", state: "seeding", progress: 1, downloaded: 1000000000, uploaded: 1450000000, downloadSpeed: 0, uploadSpeed: 230000, ratio: 1.45, etaSeconds: 0 });
const client = { request: async (route: string, body?: { action?: string; id?: string }) => {
  if (route === "/state") return fixture;
  if (route === "/search") return { results: [
    { source: "yts", name: "Controlled engineering dataset", seeders: 218, leechers: 12, sizeBytes: 1000000000, infoHash: hash, magnet: `magnet:?xt=urn:btih:${hash}`, url: "https://example.test/torrent" },
    { source: "yts", name: "Reference sample collection", seeders: 64, leechers: 3, sizeBytes: 520000000, infoHash: "2".repeat(40), magnet: `magnet:?xt=urn:btih:${"2".repeat(40)}`, url: "https://example.test/torrent" },
  ], errors: [] };
  if (body?.action === "pieces") return { states: Array.from({ length: 120 }, (_, i) => body.id === "3".repeat(40) ? "verified" : i % 11 === 0 ? "active" : i % 4 === 0 ? "missing" : "verified"), pieceLength: 1024, lastPieceLength: 400 };
  if (body?.action === "details") return { torrent: fixture.snapshot.torrents.find(t => t.id === body.id), files: [{ path: "dataset.bin", size: 1000000000, progress: .62 }], trackers: [{ url: "https://tracker.example/announce", status: "working" }] };
  return null;
} } as unknown as JsonClient;
const destination = path.resolve("preview/plus"); await fs.mkdir(destination, { recursive: true });
for (const cols of [32, 48, 80, 100]) {
  const rows = cols === 32 ? 16 : cols === 100 ? 30 : 24;
  const screens = cols === 32 ? [["home", ""], ["palette", "\x10"], ["settings", "4"], ["health", "5"]] : [["home", ""], ["palette", "\x10"], ["palette-remove", "2\x10delete"], ["results", "sample\r"], ["downloads", "2"], ["seeding", "3"], ["details", "2\r"], ...(cols === 100 ? [["compact", "2"]] : []), ["settings", "4"], ["advanced", "4a"], ["health", "5"]];
  for (const [label, keys] of screens) {
    fixture.config.display.compact = label === "compact";
    const ui = renderUI(<PlusApp client={client} />, { cols, rows });
    await new Promise(r => setTimeout(r, 70));
    for (const char of keys!) { ui.press(char); await new Promise(r => setTimeout(r, 55)); }
    const raw = ui.rawFrame();
    const frame = ui.frame().split("\n").map(line => line.trimEnd()).join("\n");
    ui.unmount();
    await fs.writeFile(path.join(destination, `${label}-${cols}.txt`), frame);
    await fs.writeFile(path.join(destination, `${label}-${cols}.svg`), ansiToSvg(raw, { cols, title: "torlnk-plus" }));
    console.log(`${label}-${cols}: ${frame.split("\n").length} rows`);
  }
}
