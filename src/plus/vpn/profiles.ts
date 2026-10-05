import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isIPv4 } from "node:net";
import type { VpnProfileSummary } from "../contracts.js";

export interface ImportProfileOptions {
  name?: string;
  provider?: "windscribe" | "custom";
  protocol?: "wireguard" | "openvpn" | "stealth";
  tlsEndpoint?: string;
  serverName?: string;
  username?: string;
  password?: string;
}

type StoredProfile = VpnProfileSummary & { file: string; tlsEndpoint?: string; serverName?: string };
const metadataName = "profile.json";

function parseEndpoint(value: string): { host: string; port: number } {
  const m = value.match(/^\[([0-9a-f:]+)]:(\d{1,5})$/i) ?? value.match(/^([a-z0-9.-]+):(\d{1,5})$/i);
  if (!m) throw new Error("VPN profile must contain a valid host:port endpoint");
  const port = Number(m[2]);
  if (port < 1 || port > 65535) throw new Error("VPN endpoint port is out of range");
  return { host: m[1]!, port };
}

function rejectUnsafeOpenVpn(config: string): void {
  const bad = /^(?:config|include|up|down|route-up|route-pre-down|ipchange|client-connect|client-disconnect|learn-address|tls-verify|tls-crypt-v2-verify|iproute|engine|pkcs11-providers|dev-node|auth-user-pass-verify|plugin|management|daemon|log|log-append|writepid|chroot|script-security|http-proxy|socks-proxy|askpass|status|capath|tls-export-cert|client-config-dir|secret|replay-persist|setenv|setenv-safe|cd|tmp-dir)\b/i;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim().replace(/^--/, "").replace(/^['"]|['"]$/g, "");
    if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("<")) continue;
    if (bad.test(line)) throw new Error(`Unsupported or unsafe OpenVPN directive: ${line.split(/\s/)[0]}`);
    if (/^auth-user-pass\s+\S+/i.test(line)) throw new Error("External OpenVPN credential paths are not supported");
    if (/^(?:ca|cert|key|tls-auth|tls-crypt|tls-crypt-v2|crl-verify|dh|pkcs12)\s+\S+/i.test(line)) throw new Error("External OpenVPN credential and certificate paths are not supported; inline the material in the profile");
    if (/^remote\s+/i.test(line) && !/^remote\s+(?:\[[0-9a-f:]+]|[a-z0-9.-]+)\s+\d{1,5}(?:\s+\w+)?$/i.test(line)) {
      throw new Error("Malformed OpenVPN remote directive");
    }
  }
  if (!/^\s*client\b/m.test(config) || !/^\s*remote\s+/mi.test(config)) throw new Error("OpenVPN profile needs client and remote directives");
}

function parseWireGuard(config: string): { host: string; port: number } {
  const allowed = new Set(["privatekey", "address", "dns", "mtu", "listenport", "publickey", "presharedkey", "endpoint", "allowedips", "persistentkeepalive"]);
  let section = "";
  const sections: string[] = [];
  const seen = new Set<string>();
  let privateKey = "";
  let publicKey = "";
  let presharedKey = "";
  let hasV4Default = false;
  let hasV4Address = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";") || line.startsWith("//")) continue;
    const sectionMatch = line.match(/^\[([a-z]+)]$/i);
    if (sectionMatch) { section = sectionMatch[1]!.toLowerCase(); if (!["interface", "peer"].includes(section) || sections.includes(section)) throw new Error("WireGuard profile must have one Interface and one Peer section"); sections.push(section); continue; }
    const keyValue = line.match(/^([a-z]+)\s*=\s*(.*?)\s*$/i);
    if (!keyValue || !section) throw new Error("Malformed WireGuard configuration line");
    const key = keyValue[1]!.toLowerCase(); const value = keyValue[2]!;
    if (seen.has(section + ":" + key)) throw new Error("Duplicate WireGuard configuration key");
    seen.add(section + ":" + key);
    if (!allowed.has(key) || (section === "interface" && ["publickey", "presharedkey", "endpoint", "allowedips", "persistentkeepalive"].includes(key)) || (section === "peer" && ["privatekey", "address", "dns", "mtu", "listenport"].includes(key))) throw new Error("Unsupported or unsafe WireGuard directive");
    if (key === "privatekey") privateKey = value;
    if (key === "publickey") publicKey = value;
    if (key === "presharedkey") presharedKey = value;
    if (key === "address" && section === "interface") hasV4Address = value.split(",").some(address => { const [ip, prefix] = address.trim().split("/"); return !!ip && !!prefix && isIPv4(ip) && Number(prefix) >= 0 && Number(prefix) <= 32; });
    if (key === "allowedips" && value.split(",").some(cidr => cidr.trim() === "0.0.0.0/0")) hasV4Default = true;
  }
  const validKey = (value: string) => { try { return Buffer.from(value, "base64").length === 32 && Buffer.from(value, "base64").toString("base64") === value; } catch { return false; } };
  if (!sections.includes("interface") || !sections.includes("peer") || !validKey(privateKey) || !validKey(publicKey) || !hasV4Address) throw new Error("WireGuard profile needs an IPv4 interface address and one peer with valid 32-byte keys");
  if (presharedKey && !validKey(presharedKey)) throw new Error("WireGuard preshared key must be a valid 32-byte base64 key");
  if (!hasV4Default) throw new Error("WireGuard profile must route IPv4 traffic through the tunnel (AllowedIPs = 0.0.0.0/0)");
  const endpoints = [...config.matchAll(/^\s*Endpoint\s*=\s*(\S+)\s*$/gmi)];
  if (endpoints.length !== 1) throw new Error("WireGuard profile needs exactly one Endpoint");
  return parseEndpoint(endpoints[0]![1]!);
}

export async function importVpnProfile(sourcePath: string, profilesDir: string, options: ImportProfileOptions = {}): Promise<VpnProfileSummary> {
  const raw = await readFile(sourcePath, "utf8");
  const protocol = options.protocol ?? (raw.includes("[Interface]") ? "wireguard" : "openvpn");
  const provider = options.provider ?? "custom";
  let endpoint: string;
  let port: number;
  let output = raw;
  if (protocol === "wireguard") {
    const ep = parseWireGuard(raw); endpoint = ep.host; port = ep.port;
  } else if (protocol === "openvpn" || protocol === "stealth") {
    if (options.serverName && !/^(?:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|(?:[0-9]{1,3}\\.){3}[0-9]{1,3})$/i.test(options.serverName)) throw new Error("Invalid TLS server name");
      rejectUnsafeOpenVpn(raw);
    if (!/<ca>[\s\S]*?<\/ca>/i.test(raw) || !/^\s*remote-cert-tls\s+server\s*$/mi.test(raw)) throw new Error("OpenVPN profiles must retain inline CA data and remote-cert-tls server verification");
    const remote = raw.match(/^\s*remote\s+(\S+)\s+(\d{1,5})/mi)!;
    endpoint = remote[1]!.replace(/^\[|]$/g, ""); port = Number(remote[2]);
    if (port < 1 || port > 65535) throw new Error("OpenVPN endpoint port is out of range");
    if (protocol === "stealth") {
      if (!options.tlsEndpoint) throw new Error("Stealth profiles require an explicit TLS endpoint");
      const remotes = [...raw.matchAll(/^\s*remote\s+(\S+)\s+(\d{1,5})(?:\s+(\S+))?/gmi)];
      if (remotes.length !== 1) throw new Error("Stealth profiles require exactly one OpenVPN remote endpoint");
      if (!/^\s*proto\s+tcp(?:-client|4-client)?\s*$/mi.test(raw)) throw new Error("Stealth requires a TCP OpenVPN profile");
      if (!/^\s*remote-cert-tls\s+server\s*$/mi.test(raw) || !/<ca>[\s\S]*?<\/ca>/i.test(raw)) throw new Error("Stealth profiles must retain inline CA data and remote-cert-tls server verification");
      const tls = parseEndpoint(options.tlsEndpoint); endpoint = tls.host; port = tls.port;
      if (port !== 443) throw new Error("Stealth TLS endpoint must use port 443");
      if (/^(?:up|down|route-up|plugin|management)\b/im.test(raw)) throw new Error("Unsafe directive in stealth profile");
    }
    if (options.username || options.password) {
      if (!options.username || !options.password) throw new Error("Both OpenVPN username and password are required");
      if (/[\r\n\0]/.test(options.username) || /[\r\n\0]/.test(options.password)) throw new Error("OpenVPN credentials must be single-line values");
      if (/^\s*auth-user-pass\s+\S+/mi.test(output)) throw new Error("External auth-user-pass paths are not supported");
      output = output.replace(/^\s*auth-user-pass\s*$/mi, "").trimEnd() + `\n<auth-user-pass>\n${options.username}\n${options.password}\n</auth-user-pass>\n`;
    }
  } else throw new Error("Unsupported VPN protocol");

  const id = createHash("sha256").update(randomUUID()).digest("hex").slice(0, 16);
  const name = (options.name ?? path.basename(sourcePath, path.extname(sourcePath))).trim().slice(0, 80) || "VPN profile";
  await mkdir(profilesDir, { recursive: true, mode: 0o700 });
  const dir = path.join(profilesDir, id);
  await mkdir(dir, { mode: 0o700 });
  const extension = protocol === "wireguard" ? ".conf" : ".ovpn";
  const file = `profile${extension}`;
  await writeFile(path.join(dir, file), output, { mode: 0o600, flag: "wx" });
  await chmod(path.join(dir, file), 0o600);
  const summary: StoredProfile = { id, name, provider, protocol, endpoint, port, file, ...(options.tlsEndpoint ? { tlsEndpoint: options.tlsEndpoint } : {}), ...(options.serverName ? { serverName: options.serverName } : {}) };
  await writeFile(path.join(dir, metadataName), JSON.stringify(summary), { mode: 0o600, flag: "wx" });
  await chmod(path.join(dir, metadataName), 0o600);
  return { id, name, provider, protocol, endpoint, port };
}

export async function listProfiles(profilesDir: string): Promise<VpnProfileSummary[]> {
  let entries: string[];
  try { entries = await readdir(profilesDir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const profiles: VpnProfileSummary[] = [];
  for (const entry of entries) {
    try {
      const value = JSON.parse(await readFile(path.join(profilesDir, entry, metadataName), "utf8")) as StoredProfile;
      if (["wireguard", "openvpn", "stealth"].includes(value.protocol) && ["custom", "windscribe"].includes(value.provider)) {
        profiles.push({ id: value.id, name: value.name, provider: value.provider, protocol: value.protocol, endpoint: value.endpoint, port: value.port });
      }
    } catch { /* Ignore incomplete or unrelated entries. */ }
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

export async function removeProfile(id: string, profilesDir: string): Promise<void> {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("Invalid VPN profile id");
  await rm(path.join(profilesDir, id), { recursive: true, force: true });
}

export async function loadProfile(id: string, profilesDir: string): Promise<{ summary: VpnProfileSummary; filePath: string; tlsEndpoint?: string; serverName?: string }> {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error("Invalid VPN profile id");
  const base = path.resolve(profilesDir, id);
  const data = JSON.parse(await readFile(path.join(base, metadataName), "utf8")) as StoredProfile;
  if (path.basename(data.file) !== data.file || !["profile.conf", "profile.ovpn"].includes(data.file)) throw new Error("Invalid stored VPN profile");
  const filePath = path.join(base, data.file);
  const expected = data.protocol === "wireguard" ? "profile.conf" : "profile.ovpn";
  if (data.file !== expected) throw new Error("Stored VPN profile type does not match its configuration");
  return { summary: { id: data.id, name: data.name, provider: data.provider, protocol: data.protocol, endpoint: data.endpoint, port: data.port }, filePath, tlsEndpoint: data.tlsEndpoint, serverName: data.serverName };
}
