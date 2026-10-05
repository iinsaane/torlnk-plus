import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdir, chmod, writeFile, readFile, rm, stat, chown } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import type { RouteStatus, VpnProfileSummary } from "../contracts.js";
import { loadPlusConfig, savePlusConfig } from "../config.js";
import { loadProfile } from "./profiles.js";

export interface DockerRuntimeOptions {
  projectDir: string; stateDir: string; downloadDirs: string[]; uid?: number; gid?: number;
  workerToken: string; qbitPassword: string; runner?: (args: string[]) => Promise<string | void>;
  workerPort?: number; qbitPort?: number; healthWaitMs?: number; forwardedPort?: number;
}
type RuntimeMode = "direct" | "vpn";
type ComposeSpec = Record<string, unknown>;

const GLUETUN_IMAGE = "qmcgaw/gluetun:v3.41.3@sha256:fa19cc76b2af13d57a8d3dc3066f2ada061b1c761b8aecf989b3877c0486e027";
const DIRECT_IMAGE = "alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0";
const QBIT_IMAGE = "qbittorrentofficial/qbittorrent-nox:5.2.4-1@sha256:92bfd78d731e254ba64f62b77b0696add6447a33642ee5feda106a26b285aa7f";

function shellDocker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let error = "";
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString(); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(output.trim()) : reject(new Error(`Docker command failed (${code}): ${error.trim().slice(-1500)}`)));
  });
}

function quotePath(p: string): string { return path.resolve(p); }

export class DockerRuntime {
  readonly projectName: string;
  readonly composePath: string;
  readonly controllerUrl: string;
  readonly qbitUrl: string;
  private readonly run: (args: string[]) => Promise<string | void>;
  private current: RouteStatus = { mode: "direct", state: "Blocked", message: "Runtime not started" };
  private readonly opts: DockerRuntimeOptions;

  constructor(options: DockerRuntimeOptions) {
    this.opts = options;
    this.run = options.runner ?? shellDocker;
    this.projectName = `torlnk-plus-${createHash("sha1").update(path.resolve(options.stateDir)).digest("hex").slice(0, 9)}`;
    this.composePath = path.join(path.resolve(options.stateDir), "compose.json");
    this.controllerUrl = `http://127.0.0.1:${options.workerPort ?? 9162}`;
    this.qbitUrl = `http://127.0.0.1:${options.qbitPort ?? 8080}`;
  }

  getEndpoints() { return { controller: this.controllerUrl, qbittorrent: this.qbitUrl }; }

  async start(mode: RuntimeMode, profile?: VpnProfileSummary & { id: string }): Promise<RouteStatus> {
    if (mode === "vpn" && !profile) throw new Error("A VPN profile is required for protected routing");
    const stateDir = quotePath(this.opts.stateDir);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
    await rm(path.join(stateDir, "network-status.json"), { force: true });
    try {
      await stat(this.composePath);
      await this.run(["compose", "-p", this.projectName, "-f", this.composePath, "down", "--remove-orphans"]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const downloadDirs = [...new Set(this.opts.downloadDirs.map(quotePath))];
    for (const d of downloadDirs) await mkdir(d, { recursive: true });
    const hostUid = process.getuid?.() ?? 1000;
    const hostGid = process.getgid?.() ?? 1000;
    const uid = this.opts.uid ?? (hostUid === 0 ? Number(process.env.SUDO_UID) || 1000 : hostUid);
    const gid = this.opts.gid ?? (hostGid === 0 ? Number(process.env.SUDO_GID) || 1000 : hostGid);
    await this.prepareQbittorrent(stateDir, uid, gid);
    const sharedConfig = await loadPlusConfig(stateDir);
    if (!sharedConfig.network.mode) { sharedConfig.network.mode = mode; sharedConfig.downloadDir = downloadDirs[0] ?? sharedConfig.downloadDir; }
    await savePlusConfig(path.join(stateDir, "public"), sharedConfig);
    await Promise.all(["controller", "webtorrent"].map(name => mkdir(path.join(stateDir, name), { recursive: true, mode: 0o700 })));
    const compose = await this.makeCompose(mode, profile, stateDir, downloadDirs, uid, gid);
    await writeFile(this.composePath, JSON.stringify(compose, null, 2), { mode: 0o600 });
    await chmod(this.composePath, 0o600);
    this.current = mode === "direct"
      ? { mode: "direct", state: "Direct", message: "Services started in direct mode" }
      : { mode: "vpn", state: "Connecting", profileId: profile!.id, message: "Waiting for the tunnel health check" };
    if (mode === "direct") {
      await this.run(["compose", "-p", this.projectName, "-f", this.composePath, "up", "-d", "--build", "--force-recreate", "gateway", "webtorrent"]);
      await this.waitForWebtorrent();
      await this.run(["compose", "-p", this.projectName, "-f", this.composePath, "up", "-d", "--build", "search", "controller", "qbittorrent"]);
      return this.status();
    }
    const bootstrapServices = profile!.protocol === "stealth" ? ["gateway", "wstunnel"] : ["gateway"];
    await this.run(["compose", "-p", this.projectName, "-f", this.composePath, "up", "-d", "--force-recreate", ...bootstrapServices]);
    const ready = await this.waitForTunnel(profile!.id);
    if (ready.state !== "Protected") return ready;
    await this.run(["compose", "-p", this.projectName, "-f", this.composePath, "up", "-d", "--build", "webtorrent"]);
    await this.waitForWebtorrent();
    await this.run(["compose", "-p", this.projectName, "-f", this.composePath, "up", "-d", "--build", "search", "controller", "qbittorrent"]);
    return this.current;
  }

  private async prepareQbittorrent(stateDir: string, uid: number, gid: number): Promise<void> {
    const configDir = path.join(stateDir, "qbittorrent", "qBittorrent", "config");
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const configPath = path.join(configDir, "qBittorrent.conf");
    let config = "";
    try { config = await readFile(configPath, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const existing = config.match(/^WebUI\\\\Password_PBKDF2=@ByteArray\\(([^:]+):([^)]*)\\)$/m);
    let encoded: string;
    if (existing) {
      const salt = Buffer.from(existing[1]!, "base64");
      const expected = Buffer.from(existing[2]!, "base64");
      const actual = pbkdf2Sync(this.opts.qbitPassword, salt, 100_000, 64, "sha512");
      encoded = actual.length === expected.length && actual.equals(expected) ? `@ByteArray(${existing[1]}:${existing[2]})` : "";
    } else encoded = "";
    if (!encoded) {
      const salt = randomBytes(16);
      const passwordHash = pbkdf2Sync(this.opts.qbitPassword, salt, 100_000, 64, "sha512");
      encoded = `@ByteArray(${salt.toString("base64")}:${passwordHash.toString("base64")})`;
    }
    if (!/^\[Preferences\]\s*$/m.test(config)) config = `${config.trimEnd()}\n\n[Preferences]\n`;
    const values = [["WebUI\\Username", "admin"], ["WebUI\\Password_PBKDF2", encoded], ["WebUI\\AuthSubnetWhitelistEnabled", "false"], ["WebUI\\LocalHostAuth", "true"]] as const;
    for (const [key, value] of values) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`^${escaped}=.*$`, "m");
      config = re.test(config) ? config.replace(re, `${key}=${value}`) : config.replace(/^\[Preferences\]\s*$/m, `[Preferences]\n${key}=${value}`);
    }
    await writeFile(configPath, config, { mode: 0o600 });
    await chmod(configPath, 0o600);
    if (process.getuid?.() === 0) { await chown(configDir, uid, gid); await chown(configPath, uid, gid); }
  }

  private async waitForTunnel(profileId: string): Promise<RouteStatus> {
    const end = Date.now() + (this.opts.healthWaitMs ?? 30_000);
    while (Date.now() < end) {
      try {
        await this.run(["compose", "-p", this.projectName, "-f", this.composePath, "exec", "-T", "gateway", "/gluetun-entrypoint", "healthcheck"]);
        await this.assertTunnelInterfaceUp();
        this.current = { mode: "vpn", state: "Protected", profileId, message: "VPN gateway health check passed" };
        return this.current;
      } catch { await new Promise(resolve => setTimeout(resolve, Math.min(1_000, Math.max(1, end - Date.now())))); }
    }
    this.current = { mode: "vpn", state: "Blocked", profileId, message: "VPN gateway did not pass its health check; application services were not started" };
    return this.current;
  }

  private async assertTunnelInterfaceUp(): Promise<void> {
    const output = await this.run(["compose", "-p", this.projectName, "-f", this.composePath, "exec", "-T", "gateway", "ip", "-o", "link", "show", "dev", "tun0"]);
    if (typeof output !== "string" || !/^\d+:\s*tun0:.*<[^>]*\bUP\b[^>]*>/m.test(output)) throw new Error("VPN tunnel interface is down");
  }

  private async waitForWebtorrent(): Promise<void> {
    const end = Date.now() + 15_000;
    const probe = "fetch('http://127.0.0.1:9163/rpc',{method:'POST'}).then(r=>process.exit(r.status===401?0:1)).catch(()=>process.exit(1))";
    while (Date.now() < end) {
      try {
        await this.run(["compose", "-p", this.projectName, "-f", this.composePath, "exec", "-T", "webtorrent", "node", "-e", probe]);
        return;
      } catch { await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    throw new Error("WebTorrent worker did not become ready; controller and qBittorrent were not started");
  }

  private async makeCompose(mode: RuntimeMode, profile: VpnProfileSummary | undefined, stateDir: string, downloadDirs: string[], uid: number, gid: number): Promise<ComposeSpec> {
    const workerPort = this.opts.workerPort ?? 9162;
    const qbitPort = this.opts.qbitPort ?? 8080;
    const environment = { TORLNK_PLUS_WORKER_TOKEN: this.opts.workerToken, NODE_ENV: "production", TORLNK_PLUS_LISTEN_HOST: "0.0.0.0", TORLNK_PLUS_PORT: "9162", TORLNK_PLUS_QBIT_PORT: String(qbitPort), TORLNK_PLUS_CONFIG_DIR: "/settings", TORLNK_PLUS_QBIT_PASSWORD: this.opts.qbitPassword };
    const downloads = downloadDirs.map(d => `${d}:${d}`);
    const settings = `${stateDir}/public:/settings:ro`;
    const controllerBinds = [`${stateDir}/controller:/state/controller`, settings, ...downloads];
    const webtorrentBinds = [`${stateDir}/webtorrent:/state/webtorrent`, `${stateDir}/webtorrent:${stateDir}/webtorrent`, settings, ...downloads];
    const gateway: Record<string, unknown> = {
      image: mode === "direct" ? DIRECT_IMAGE : GLUETUN_IMAGE,
      ports: [`127.0.0.1:${workerPort}:9162/tcp`, `127.0.0.1:${qbitPort}:${qbitPort}/tcp`],
      sysctls: { "net.ipv6.conf.all.disable_ipv6": "1", "net.ipv6.conf.default.disable_ipv6": "1" },
      restart: "unless-stopped",
    };
    if (mode === "direct") Object.assign(gateway, { command: ["sh", "-c", "while :; do sleep 3600; done"] });
    else {
      Object.assign(gateway, { cap_add: ["NET_ADMIN", "DAC_OVERRIDE"], cap_drop: ["ALL"], devices: ["/dev/net/tun:/dev/net/tun"] });
      const loaded = await loadProfile(profile!.id, path.join(stateDir, "profiles"));
      let openVpnFile = loaded.filePath;
      if (loaded.summary.protocol === "stealth") openVpnFile = await this.prepareStealth(loaded, stateDir);
      if (loaded.summary.protocol === "wireguard") openVpnFile = await this.prepareWireGuard(loaded.filePath, stateDir);
      const vpnVolumes = [loaded.summary.protocol === "wireguard" ? openVpnFile + ":/gluetun/wireguard/wg0.conf:ro" : openVpnFile + ":/gluetun/profile.ovpn:ro"];
      if (loaded.summary.protocol === "stealth") vpnVolumes.push(path.join(stateDir, "stealth-iptables.txt") + ":/iptables/post-rules.txt:ro");
      gateway.volumes = vpnVolumes;
      const protocolEnv = loaded.summary.protocol === "wireguard"
        ? { VPN_SERVICE_PROVIDER: "custom", VPN_TYPE: "wireguard" }
        : { VPN_SERVICE_PROVIDER: "custom", VPN_TYPE: "openvpn", OPENVPN_CUSTOM_CONFIG: "/gluetun/profile.ovpn" };
      Object.assign(gateway, { environment: { ...protocolEnv, FIREWALL: "on", FIREWALL_INPUT_PORTS: `9162,${qbitPort}`, HEALTH_VPN_DURATION_INITIAL: "30s", HEALTH_VPN_DURATION_ADDITION: "10s", ...(this.opts.forwardedPort ? { FIREWALL_VPN_INPUT_PORTS: String(this.opts.forwardedPort) } : {}) } });
    }
    const services: Record<string, unknown> = {
      gateway,
      controller: { build: { context: path.resolve(this.opts.projectDir), dockerfile: "containers/worker.Dockerfile" }, network_mode: "service:gateway", depends_on: { gateway: { condition: "service_started" } }, environment, volumes: controllerBinds, read_only: true, tmpfs: ["/tmp:size=16m,noexec,nosuid,nodev"], cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"], user: `${uid}:${gid}`, restart: "unless-stopped", command: ["node", "dist/worker.js"] },
      webtorrent: { build: { context: path.resolve(this.opts.projectDir), dockerfile: "containers/worker.Dockerfile" }, network_mode: "service:gateway", depends_on: { gateway: { condition: "service_started" } }, environment: { ...environment, TORLNK_PLUS_PORT: "9163", TORLNK_PLUS_LISTEN_HOST: "127.0.0.1" }, volumes: webtorrentBinds, read_only: true, tmpfs: ["/tmp:size=16m,noexec,nosuid,nodev"], cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"], user: `${uid}:${gid}`, restart: "unless-stopped", command: ["node", "dist/webtorrent-worker.js"] },
      qbittorrent: { image: QBIT_IMAGE, network_mode: "service:gateway", depends_on: { gateway: { condition: "service_started" } }, environment: { QBT_LEGAL_NOTICE: "confirm", QBT_WEBUI_PORT: String(qbitPort), UMASK: "002" }, user: `${uid}:${gid}`, volumes: [`${stateDir}/qbittorrent:/config`, ...downloadDirs.map(d => `${d}:${d}`)], cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"], restart: "unless-stopped" },
    };
    services.search = { ...(services.controller as Record<string, unknown>), command: ["node", "dist/search-worker.js"], volumes: [settings], environment: { TORLNK_PLUS_WORKER_TOKEN: this.opts.workerToken, TORLNK_PLUS_CONFIG_DIR: "/settings", NODE_ENV: "production" } };
    if (mode === "vpn" && profile!.protocol === "stealth") {
      const loaded = await loadProfile(profile!.id, path.join(stateDir, "profiles"));
      const inner = (await readFile(loaded.filePath, "utf8")).match(/^\s*remote\s+\S+\s+(\d{1,5})/mi);
      if (!inner) throw new Error("Stealth profile has no valid inner OpenVPN port");
      const sni = loaded.serverName ?? loaded.summary.endpoint;
      services.wstunnel = { build: { context: path.resolve(this.opts.projectDir), dockerfile: "containers/wstunnel.Dockerfile" }, network_mode: "service:gateway", depends_on: { gateway: { condition: "service_started" } }, command: ["-f", "/tmp/wstunnel.log", "-l", "127.0.0.1:65479", "-r", "https://" + sni + ":443", "-t", "2", "-m", "1500"], extra_hosts: [sni + ":" + await this.resolveIPv4Endpoint(loaded.summary.endpoint)], read_only: true, tmpfs: ["/tmp:size=8m,noexec,nosuid,nodev"], cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"], restart: "unless-stopped" };
    }
    return { services, networks: { default: { enable_ipv6: false } } };
  }

  private async resolveIPv4Endpoint(host: string): Promise<string> {
    if (isIPv4(host)) return host;
    const result = await lookup(host, { family: 4 });
    if (!isIPv4(result.address)) throw new Error("VPN endpoint must resolve to IPv4 because container IPv6 is disabled");
    return result.address;
  }

  private async prepareWireGuard(sourcePath: string, stateDir: string): Promise<string> {
    const original = await readFile(sourcePath, "utf8");
    const match = original.match(/^\s*Endpoint\s*=\s*(?:\[([0-9a-f:]+)]|([^:\s]+)):(\d{1,5})\s*$/mi);
    if (!match) throw new Error("WireGuard profile has no valid peer endpoint");
    const host = match[1] ?? match[2]!;
    const port = Number(match[3]);
    const ip = await this.resolveIPv4Endpoint(host);
    let active = original.replace(/^\s*Endpoint\s*=\s*.*$/mi, `Endpoint = ${ip}:${port}`);
    active = active.replace(/^\s*(Address|AllowedIPs)\s*=\s*(.+)$/gmi, (_line, directive: string, values: string) => {
      const filtered = values.split(",").map((item: string) => item.trim()).filter((item: string) => !isIPv6(item.split("/")[0]!));
      if (directive.toLowerCase() === "address" && filtered.length === 0) throw new Error("WireGuard profile needs an IPv4 interface address");
      if (directive.toLowerCase() === "allowedips" && filtered.length === 0) return "";
      return `${directive} = ${filtered.join(", ")}`;
    });
    active = active.replace(/^\s*DNS\s*=\s*(.+)$/gmi, (_line, values: string) => {
      const dns = values.split(",").map((item: string) => item.trim()).filter((item: string) => !isIPv6(item));
      return dns.length ? `DNS = ${dns.join(", ")}` : "";
    });
    const target = path.join(stateDir, "wireguard-active.conf");
    await writeFile(target, active, { mode: 0o600 });
    await chmod(target, 0o600);
    return target;
  }

  private async prepareStealth(profile: Awaited<ReturnType<typeof loadProfile>>, stateDir: string): Promise<string> {
    const original = await readFile(profile.filePath, "utf8");
    const remote = original.match(/^\s*remote\s+\S+\s+(\d{1,5})/mi);
    if (!remote) throw new Error("Stealth profile needs one OpenVPN endpoint");
    const ip = await this.resolveIPv4Endpoint(profile.summary.endpoint);
    const config = original.replace(/^\s*remote\s+\S+\s+\d{1,5}.*$/mi, "remote 127.0.0.1 65479 tcp-client");
    const runtimeConfig = path.join(stateDir, "stealth-active.ovpn");
    await writeFile(runtimeConfig, config, { mode: 0o600 });
    await chmod(runtimeConfig, 0o600);
    await writeFile(path.join(stateDir, "stealth-iptables.txt"), "iptables -A OUTPUT -o eth0 -d " + ip + "/32 -p tcp --dport 443 -j ACCEPT\n", { mode: 0o600 });
    await chmod(path.join(stateDir, "stealth-iptables.txt"), 0o600);
    return runtimeConfig;
  }

  async stop(): Promise<void> {
    await this.run(["compose", "-p", this.projectName, "-f", this.composePath, "down", "--remove-orphans"]);
    this.current = { mode: "direct", state: "Blocked", message: "Runtime stopped" };
  }

  async status(): Promise<RouteStatus> {
    if (this.current.state === "Blocked" || this.current.state === "Connecting" || this.current.state === "Protected" || this.current.state === "Direct") {
      try {
        if (this.current.mode === "vpn") {
          await this.run(["compose", "-p", this.projectName, "-f", this.composePath, "exec", "-T", "gateway", "/gluetun-entrypoint", "healthcheck"]);
          await this.assertTunnelInterfaceUp();
          this.current = { ...this.current, state: "Protected", message: "VPN gateway health check passed" };
        } else {
          await this.run(["compose", "-p", this.projectName, "-f", this.composePath, "exec", "-T", "gateway", "true"]);
          this.current = { mode: "direct", state: "Direct", message: "Direct gateway is running" };
        }
      } catch {
        this.current = { mode: this.current.mode, state: "Blocked", profileId: this.current.profileId, message: this.current.mode === "vpn" ? "VPN tunnel health check failed; application services are blocked" : "Direct gateway is not running" };
      }
    }
    return this.current;
  }
}
