import { access, readFile, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { DEFAULT_STATE_DIR, defaultPlusConfig, validatePlusConfig } from "./config";
import type { PlusConfig } from "./config";

export type Check = { name: string; status: "pass" | "warn" | "fail"; message: string };
export interface Probe {
  platform: string; arch: string; node: string;
  command(args: string[]): Promise<string>;
  writable(path: string): Promise<boolean>;
  portAvailable(port: number): Promise<boolean>;
  readConfig(stateDir: string): Promise<unknown | undefined>;
  authenticatedSupervisor(): Promise<boolean>;
  tunAvailable(): Promise<boolean>;
  rootless(): Promise<boolean | null>;
}

const command = (args: string[]) => new Promise<string>((resolve, reject) => {
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", chunk => { out += chunk.toString(); });
  child.once("error", reject);
  child.once("close", code => code === 0 ? resolve(out.trim()) : reject(new Error("command unavailable")));
  const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("command timed out")); }, 10_000);
  child.once("close", () => clearTimeout(timer));
});
const defaultProbe: Probe = {
  platform: process.platform, arch: process.arch, node: process.versions.node,
  command,
  async writable(target) {
    let dir = path.resolve(target);
    try { const exact = await stat(dir); if (!exact.isDirectory()) return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    while (true) {
      try { const info = await stat(dir); if (info.isDirectory()) break; dir = path.dirname(dir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; const parent = path.dirname(dir); if (parent === dir) return false; dir = parent; }
    }
    try { await access(dir, 2); return true; } catch { return false; }
  },
  portAvailable(port) { return new Promise(resolve => { const server = net.createServer(); server.once("error", () => resolve(false)); server.listen(port, "127.0.0.1", () => server.close(() => resolve(true))); }); },
  async readConfig(stateDir) { try { return JSON.parse(await readFile(path.join(stateDir, "config.json"), "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } },
  async authenticatedSupervisor() {
    try {
      const stateDir = DEFAULT_STATE_DIR;
      const credentials = JSON.parse(await readFile(path.join(stateDir, "credentials.json"), "utf8")) as { token?: unknown };
      if (typeof credentials.token !== "string") return false;
      const port = Number(process.env.TORLNK_PLUS_PORT ?? 9161);
      const response = await fetch(`http://127.0.0.1:${port}/state`, { headers: { Authorization: `Bearer ${credentials.token}` }, signal: AbortSignal.timeout(2000) });
      return response.ok;
    } catch { return false; }
  },
  async tunAvailable() { try { await access("/dev/net/tun"); return true; } catch { return false; } },
  async rootless() { try { return /rootless/i.test(await command(["info", "--format", "{{json .SecurityOptions}}"])); } catch { return null; } },
};

function versionAtLeast(actual: string, required: number[]): boolean {
  const got = actual.split(/[.-]/).slice(0, 3).map(x => Number(x) || 0);
  for (let i = 0; i < required.length; i++) { if ((got[i] ?? 0) > required[i]!) return true; if ((got[i] ?? 0) < required[i]!) return false; }
  return true;
}

export function supportsNpm12Node(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split(/[.-]/).slice(0, 3).map(part => Number(part) || 0);
  return major === 22 ? minor > 22 || (minor === 22 && patch >= 2)
    : major === 24 ? minor >= 15
      : major >= 26;
}

export async function runDoctor(options: { stateDir?: string; probe?: Probe } = {}): Promise<Check[]> {
  const probe = options.probe ?? defaultProbe;
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, message: string, unsupported = false) => checks.push({ name, status: ok ? "pass" : unsupported ? "warn" : "fail", message });
  const supported = probe.platform === "linux" && probe.arch === "x64";
  add("platform", supported, supported ? "Linux x64 alpha target" : `Unsupported alpha platform: ${probe.platform}/${probe.arch}; alpha supports Linux x64 only`);
  const nodeOk = supportsNpm12Node(probe.node);
  add("node", nodeOk, nodeOk ? `Node.js ${probe.node} is supported` : `Node.js ${probe.node}; NPM 12 requires ^22.22.2, ^24.15.0, or >=26.0.0`);

  let dockerVersion = "";
  try { dockerVersion = await probe.command(["version", "--format", "{{.Server.Version}}"]); } catch {}
  const dockerOk = !!dockerVersion && versionAtLeast(dockerVersion, [28, 0, 0]);
  add("docker", dockerOk, dockerOk ? `Docker daemon ${dockerVersion}` : dockerVersion ? `Docker daemon ${dockerVersion}; requires 28 or newer` : "Docker daemon unavailable; start Docker and check access to its socket");
  let compose = "";
  try { compose = await probe.command(["compose", "version", "--short"]); } catch {}
  const composeMajor = Number(compose.match(/^v?(\d+)/)?.[1]);
  const composeOk = !!compose && Number.isFinite(composeMajor) && composeMajor >= 2;
  add("compose", composeOk, composeOk ? `Docker Compose v2 ${compose}` : compose ? `Docker Compose ${compose}; version 2 or newer is required` : "Docker Compose v2 unavailable");
  const rootless = dockerVersion ? await probe.rootless() : null;
  add("docker-rootless", rootless === false, rootless === true ? "Rootless Docker is unsupported by the alpha runtime" : rootless === false ? "Rootful Docker runtime" : "Docker security mode could not be determined");
  let cfg: PlusConfig = defaultPlusConfig();
  try { const raw = await probe.readConfig(stateDir); if (raw !== undefined) cfg = validatePlusConfig(raw); }
  catch { checks.push({ name: "config", status: "fail", message: "Settings file could not be read or validated" }); }
  const dirs = [...new Set([stateDir, cfg.downloadDir, ...cfg.extraDownloadDirs])];
  for (const dir of dirs) {
    const colon = dir.includes(":");
    const ok = !colon && await probe.writable(dir).catch(() => false);
    const where = dir === stateDir ? "state-directory" : "download-directory";
    add(where, ok, ok ? `${dir} is writable` : colon ? `${dir} contains ':' and cannot be used as a Docker bind path` : `${dir} is not a writable directory (or its nearest existing directory is not writable)`);
  }
  if (cfg.network.mode === "vpn") {
    const tun = await probe.tunAvailable();
    add("tun-device", tun, tun ? "/dev/net/tun is available" : "VPN is configured but /dev/net/tun is unavailable");
  }

  const supervisorRunning = await probe.authenticatedSupervisor();
  const servicePorts = [Number(process.env.TORLNK_PLUS_PORT ?? 9161), Number(process.env.TORLNK_PLUS_WORKER_PORT ?? 9162), Number(process.env.TORLNK_PLUS_QBIT_PORT ?? 8080)];
  const effectivePeerPort = cfg.network.forwardedPort ?? cfg.backendSettings.listenPort;
  const webtorrentPeerPort = effectivePeerPort + 1;
  const allPorts = [...servicePorts, effectivePeerPort, webtorrentPeerPort];
  const validPorts = allPorts.filter(p => Number.isInteger(p) && p >= 1 && p <= 65535);
  add("port-ranges", validPorts.length === allPorts.length, validPorts.length === allPorts.length ? "Host and effective peer ports are in range 1-65535" : "A configured port is outside 1-65535 (WebTorrent uses effective peer port + 1)");
  const hostDuplicates = servicePorts.filter((p, i) => servicePorts.indexOf(p) !== i);
  const internalPorts = new Set([9162, 9163, 9164, servicePorts[2]!]);
  const peerConflicts = [effectivePeerPort, webtorrentPeerPort].filter(p => internalPorts.has(p));
  add("port-duplicates", hostDuplicates.length === 0 && peerConflicts.length === 0, hostDuplicates.length || peerConflicts.length ? `Conflicting host or managed-runtime ports: ${[...new Set([...hostDuplicates, ...peerConflicts])].join(", ")}` : "Host and managed-runtime ports do not conflict");
  for (const p of new Set(servicePorts.filter(p => Number.isInteger(p) && p >= 1 && p <= 65535))) {
    if (supervisorRunning) { add(`port-${p}`, true, `Port ${p} belongs to the authenticated running torlnk-plus service`); continue; }
    const ok = await probe.portAvailable(p).catch(() => false);
    add(`port-${p}`, ok, ok ? `Port ${p} is available` : `Port ${p} is already in use`);
  }
  return checks;
}

export function doctorPassed(checks: Check[]): boolean { return checks.every(c => c.status !== "fail"); }
