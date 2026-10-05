import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { importVpnProfile } from "./profiles.js";
import { DockerRuntime } from "./runtime.js";

const roots: string[] = [];
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), "torlnk-runtime-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

it("generates an isolated direct Compose project and exposes loopback services", async () => {
  const root = await fixture(); const stateDir = path.join(root, "state"); const calls: string[][] = [];
  const runtime = new DockerRuntime({ projectDir: root, stateDir, downloadDirs: [path.join(root, "downloads")], uid: 1200, gid: 1300, workerToken: "w".repeat(32), qbitPassword: "q".repeat(32), runner: async args => { calls.push(args); } });
  const status = await runtime.start("direct");
  expect(status.state).toBe("Direct");
  expect(runtime.getEndpoints()).toEqual({ controller: "http://127.0.0.1:9162", qbittorrent: "http://127.0.0.1:8080" });
  expect(calls[0]).toContain("--force-recreate");
  const compose = JSON.parse(await readFile(runtime.composePath, "utf8"));
  expect(compose.services.gateway.cap_add).toBeUndefined();
  expect(compose.services.gateway.devices).toBeUndefined();
  expect(compose.services.controller.network_mode).toBe("service:gateway");
  expect(compose.services.controller.cap_drop).toEqual(["ALL"]);
  expect(compose.services.webtorrent.environment.TORLNK_PLUS_PORT).toBe("9163");
  expect(compose.services.qbittorrent.network_mode).toBe("service:gateway");
  expect(compose.services.qbittorrent.image).toBe("qbittorrentofficial/qbittorrent-nox:5.2.4-1@sha256:92bfd78d731e254ba64f62b77b0696add6447a33642ee5feda106a26b285aa7f");
  expect(compose.services.qbittorrent.cap_drop).toEqual(["ALL"]);
  expect(compose.services.gateway.image).toBe("alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0");
  expect(compose.services.gateway.environment).toBeUndefined();
  await runtime.stop();
});

it("mounts imported config read-only in VPN mode and blocks app services until tunnel health is proven", async () => {
  const root = await fixture(); const stateDir = path.join(root, "state"); const profileDir = path.join(stateDir, "profiles");
  const source = path.join(root, "vpn.conf");
  await writeFile(source, `[Interface]\nPrivateKey = ${Buffer.alloc(32, 7).toString("base64")}\nAddress = 10.0.0.2/32, fd54:4::1/128\n[Peer]\nPublicKey = ${Buffer.alloc(32, 8).toString("base64")}\nEndpoint = 198.51.100.7:51820\nAllowedIPs = 0.0.0.0/0, ::/0\n`);
  const profile = await importVpnProfile(source, profileDir);
  const calls: string[][] = [];
  const runtime = new DockerRuntime({ projectDir: root, stateDir, downloadDirs: [], workerToken: "w", qbitPassword: "q", healthWaitMs: 1, runner: async args => { calls.push(args); if (args.includes("healthcheck")) throw new Error("not ready"); } });
  expect((await runtime.start("vpn", profile)).state).toBe("Blocked");
  const compose = JSON.parse(await readFile(runtime.composePath, "utf8"));
  expect(compose.services.gateway.environment.VPN_TYPE).toBe("wireguard");
  expect(compose.services.gateway.image).toBe("qmcgaw/gluetun:v3.41.3@sha256:fa19cc76b2af13d57a8d3dc3066f2ada061b1c761b8aecf989b3877c0486e027");
  expect(compose.services.gateway.environment.FIREWALL).toBe("on");
  expect(compose.services.gateway.volumes[0]).toMatch(/\/gluetun\/wireguard\/wg0\.conf:ro$/);
  expect(await readFile(path.join(stateDir, "wireguard-active.conf"), "utf8")).toContain("Endpoint = 198.51.100.7:51820");
  expect(await readFile(path.join(stateDir, "wireguard-active.conf"), "utf8")).not.toContain("fd54:");
  expect(await readFile(path.join(stateDir, "wireguard-active.conf"), "utf8")).not.toContain("::/0");
  expect(compose.services.gateway.cap_add).toEqual(["NET_ADMIN", "DAC_OVERRIDE"]);
  expect(compose.services.gateway.cap_drop).toEqual(["ALL"]);
  expect(compose.services.gateway.devices).toEqual(["/dev/net/tun:/dev/net/tun"]);
  expect(compose.services.controller.cap_add).toBeUndefined();
  expect((await runtime.status()).state).toBe("Blocked");
});

it("blocks VPN status immediately when the live tun interface drops", async () => {
  const root = await fixture(); const stateDir = path.join(root, "state"); const source = path.join(root, "vpn.conf");
  await writeFile(source, `[Interface]\nPrivateKey = ${Buffer.alloc(32, 7).toString("base64")}\nAddress = 10.0.0.2/32\n[Peer]\nPublicKey = ${Buffer.alloc(32, 8).toString("base64")}\nEndpoint = 198.51.100.7:51820\nAllowedIPs = 0.0.0.0/0\n`);
  const profile = await importVpnProfile(source, path.join(stateDir, "profiles")); let tunUp = true;
  const runtime = new DockerRuntime({ projectDir: root, stateDir, downloadDirs: [], workerToken: "w", qbitPassword: "q", runner: async args => args.includes("link") ? `3: tun0: <POINTOPOINT,NOARP,${tunUp ? "UP,LOWER_UP" : ""}> mtu 1420` : undefined });
  expect((await runtime.start("vpn", profile)).state).toBe("Protected");
  tunUp = false;
  expect((await runtime.status()).state).toBe("Blocked");
});

it("uses a TLS relay through an exact endpoint firewall and starts app services after health", async () => {
  const root = await fixture(); const stateDir = path.join(root, "state"); const source = path.join(root, "x.ovpn");
  await writeFile(source, "client\ndev tun\nproto tcp-client\nremote vpn.example.org 1194\nremote-cert-tls server\n<ca>\ncertificate\n</ca>\n");
  const profile = await importVpnProfile(source, path.join(stateDir, "profiles"), { protocol: "stealth", tlsEndpoint: "127.0.0.1:443", serverName: "relay.example.org" });
  const calls: string[][] = [];
  const runtime = new DockerRuntime({ projectDir: root, stateDir, downloadDirs: [], workerToken: "w", qbitPassword: "q", runner: async args => { calls.push(args); return args.includes("link") ? "3: tun0: <POINTOPOINT,NOARP,UP,LOWER_UP> mtu 1420" : undefined; } });
  expect((await runtime.start("vpn", profile)).state).toBe("Protected");
  const compose = JSON.parse(await readFile(runtime.composePath, "utf8"));
  expect(compose.services.wstunnel.command).toContain("https://relay.example.org:443");
  expect(compose.services.wstunnel.command).toContain("2");
  expect(compose.services.wstunnel.extra_hosts).toEqual(["relay.example.org:127.0.0.1"]);
  expect(compose.services.gateway.volumes).toContain(`${stateDir}/stealth-iptables.txt:/iptables/post-rules.txt:ro`);
  expect(await readFile(path.join(stateDir, "stealth-iptables.txt"), "utf8")).toContain("iptables -A OUTPUT -o eth0 -d 127.0.0.1/32 -p tcp --dport 443 -j ACCEPT");
  expect(await readFile(path.join(stateDir, "stealth-active.ovpn"), "utf8")).toContain("remote 127.0.0.1 65479 tcp-client");
  expect(calls[0]).toContain("gateway");
  expect(calls[0]).toContain("wstunnel");
  expect(calls.at(-1)).toContain("qbittorrent");
});
