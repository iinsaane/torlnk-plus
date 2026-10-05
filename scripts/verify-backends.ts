import { spawnSync } from "node:child_process";
import { QbittorrentBackend } from "../src/plus/backends/qbittorrent";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const wt = spawnSync(npm, ["test", "--", "src/plus/backends/webtorrent.integration.test.ts"], { stdio: "inherit" });
if (wt.error) throw wt.error;
if (wt.status !== 0) process.exit(wt.status ?? 1);
console.log("WebTorrent: real local peer transfer and no-peer metadata checks passed.");

const baseUrl = process.env.QBIT_BASE_URL;
const password = process.env.QBIT_PASSWORD;
if (baseUrl && password) {
  const backend = new QbittorrentBackend({ baseUrl, username: process.env.QBIT_USERNAME || "admin", password });
  await backend.start();
  const torrents = await backend.list();
  console.log(`qBittorrent: authenticated WebUI check passed (${torrents.length} torrents visible).`);
} else {
  console.log("qBittorrent: skipped (set QBIT_BASE_URL and QBIT_PASSWORD to enable the live WebUI check).");
}
