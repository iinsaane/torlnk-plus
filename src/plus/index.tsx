import path from "node:path";
import { stat } from "node:fs/promises";
import packageInfo from "../../package.json";
import { DEFAULT_STATE_DIR } from "./config";
import { doctorPassed, runDoctor } from "./preflight";

const args = process.argv.slice(2);
const command = args[0];
const version = packageInfo.version;
let initialInput: string | undefined;

async function validateInitialInput(): Promise<boolean> {
  if (!command || args.length !== 1) return false;
  if (command.startsWith("magnet:?")) {
    try {
      const magnet = new URL(command);
      if (magnet.protocol === "magnet:" && magnet.searchParams.get("xt")) { initialInput = command; return true; }
    } catch { /* report as an unknown command below */ }
  }
  if (command.toLowerCase().endsWith(".torrent")) {
    try {
      const target = path.resolve(command);
      if ((await stat(target)).isFile()) { initialInput = target; return true; }
    } catch { throw new Error(`Torrent file does not exist or cannot be read: ${command}`); }
    throw new Error(`Torrent path is not a file: ${command}`);
  }
  return false;
}

function usage() {
  console.log(`torlnk-plus v${version}\n\n  torlnk-plus [magnet|torrent-file]\n  torlnk-plus start\n  torlnk-plus status\n  torlnk-plus stop\n  torlnk-plus doctor [--json]\n  torlnk-plus vpn on|off [profile-id]\n  torlnk-plus profile import <file> [wireguard|openvpn|stealth] [TLS-host:443] [SNI]\n  torlnk-plus search <query>\n  torlnk-plus migrate <legacy-config-dir> <legacy-data-dir>\n  torlnk-plus --version\n\nSettings and service health are in the terminal UI. Closing it keeps downloads running.\nState: ${DEFAULT_STATE_DIR}\nwatch, serve, files, attach and upstream update are deferred in this fork.`);
}

if (command === "--help" || command === "-h" || command === "help") usage();
else if (command === "--version" || command === "-V") console.log(`torlnk-plus v${version}`);
else if (command === "doctor" || command === "--doctor") {
  if (args.length > 2 || (args[1] !== undefined && args[1] !== "--json")) throw new Error("Use doctor [--json]");
  const checks = await runDoctor();
  if (args[1] === "--json") console.log(JSON.stringify({ name: "torlnk-plus", version, checks, ok: doctorPassed(checks) }, null, 2));
  else {
    console.log(`torlnk-plus v${version} runtime preflight`);
    for (const check of checks) console.log(`${check.status.toUpperCase().padEnd(4)} ${check.name}: ${check.message}`);
    console.log(doctorPassed(checks) ? "Preflight passed." : "Preflight failed. Resolve the failed checks before starting the service.");
  }
  if (!doctorPassed(checks)) process.exitCode = 1;
} else {
  const isInitialInput = await validateInitialInput();
  if (["watch", "serve", "files", "attach", "update", "seed"].includes(command ?? "")) throw new Error(`${command} is not available in the interactive-first fork. Use the terminal UI for downloads and seeding.`);
  const known = new Set([undefined, "start", "status", "stop", "vpn", "profile", "search", "migrate"]);
  if (!isInitialInput && !known.has(command)) throw new Error(`Unknown command: ${command}`);
  if (!isInitialInput && args.some(a => a.startsWith("--"))) throw new Error(`Unknown option: ${args.find(a => a.startsWith("--"))}`);
  if (isInitialInput && args.length !== 1) throw new Error("Use one magnet URI or .torrent file path");
  if (["start", "status", "stop"].includes(command ?? "") && args.length !== 1) throw new Error(`Use ${command}`);
  if (command === "vpn" && (!(["on", "off"].includes(args[1] ?? "")) || args.length > 3)) throw new Error("Use vpn on|off [profile-id]");
  if (command === "profile" && (args[1] !== "import" || !args[2] || args.length > 6)) throw new Error("Use profile import <file> [protocol] [TLS-host:443] [SNI]");
  if (command === "search" && args.length < 2) throw new Error("Use search <query>");
  if (command === "migrate" && args.length !== 3) throw new Error("Use migrate <legacy-config-dir> <legacy-data-dir>");

  if (command !== "status" && command !== "stop") {
    const checks = await runDoctor();
    const failures = checks.filter(c => c.status === "fail");
    if (failures.length) throw new Error(`Runtime preflight failed: ${failures.map(c => `${c.name}: ${c.message}`).join("; ")}. Run torlnk-plus doctor for details.`);
  }

  const [{ render }, { promises: fs }, { connectService }, { PlusApp }, config, { importLegacy }] = await Promise.all([
    import("ink"), import("node:fs"), import("./client"), import("./ui/App"), import("./config"), import("./migrate"),
  ]);
  const { loadPlusConfig, savePlusConfig } = config;
  if (command === "migrate") {
    try { await connectService(false); throw new Error("Stop the background service before importing legacy data"); } catch (error) { if (!(error instanceof Error) || !error.message.includes("not running")) throw error; }
    const result = await importLegacy(path.resolve(args[1]!), path.resolve(args[2]!), DEFAULT_STATE_DIR);
    const cfg = await loadPlusConfig(DEFAULT_STATE_DIR);
    const legacy = (result.config ?? {}) as { downloadDir?: string; trackers?: string[] };
    if (legacy.downloadDir) cfg.downloadDir = legacy.downloadDir;
    const manifestPath = path.join(DEFAULT_STATE_DIR, "webtorrent", "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    cfg.extraDownloadDirs = [...new Set<string>((manifest.torrents ?? []).map((t: { savePath: string }) => t.savePath))].filter(p => p !== cfg.downloadDir);
    if (legacy.trackers) cfg.backendSettings.trackers = legacy.trackers;
    await savePlusConfig(DEFAULT_STATE_DIR, cfg);
    await fs.mkdir(path.join(DEFAULT_STATE_DIR, "controller"), { recursive: true });
    await fs.copyFile(path.join(DEFAULT_STATE_DIR, "ownership.json"), path.join(DEFAULT_STATE_DIR, "controller", "ownership.json"));
    console.log(`Imported ${result.torrents.length} WebTorrent records. Backup: ${result.backupDir}. Select routing before resuming.`);
  } else {
    const client = await connectService(command !== "stop" && command !== "status");
    if (command === "start") console.log("Background service started. Open torlnk-plus to choose routing and manage transfers.");
    else if (command === "status") console.log(JSON.stringify(await client.request("/state"), null, 2));
    else if (command === "stop") { await client.request("/stop", {}); console.log("Background service stopped"); }
    else if (command === "vpn") {
      const state = await client.request<{ config: Awaited<ReturnType<typeof loadPlusConfig>> }>("/state");
      await client.request("/route", { mode: args[1] === "off" ? "direct" : "vpn", profileId: args[2] ?? state.config.network.profileId }); console.log("Routing changed");
    } else if (command === "profile") {
      console.log(JSON.stringify(await client.request("/profiles/import", { path: path.resolve(args[2]!), options: { provider: /windscribe/i.test(args[2]!) ? "windscribe" : "custom", ...(args[3] ? { protocol: args[3] } : {}), ...(args[4] ? { tlsEndpoint: args[4] } : {}), ...(args[5] ? { serverName: args[5] } : {}) } }), null, 2));
    } else if (command === "search") console.log(JSON.stringify(await client.request("/search", { query: args.slice(1).join(" ") }), null, 2));
    else { const app = render(<PlusApp client={client} initial={initialInput ?? command} />); await app.waitUntilExit(); }
  }
}
