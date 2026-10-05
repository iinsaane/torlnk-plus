import { mkdtemp, readFile, stat, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { importVpnProfile, listProfiles, loadProfile, removeProfile } from "./profiles.js";

const roots: string[] = [];
async function fixture() { const root = await mkdtemp(path.join(os.tmpdir(), "torlnk-vpn-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

it("imports a WireGuard profile with private config and redacted metadata", async () => {
  const root = await fixture(); const src = path.join(root, "private.conf"); const dir = path.join(root, "profiles");
  const secret = Buffer.alloc(32, 7).toString("base64");
  await writeFile(src, `[Interface]\nPrivateKey = ${secret}\nAddress = 10.0.0.2/32\n[Peer]\nPublicKey = ${Buffer.alloc(32, 8).toString("base64")}\nEndpoint = vpn.example.org:51820\nAllowedIPs = 0.0.0.0/0\n`);
  const summary = await importVpnProfile(src, dir, { name: "Amsterdam", provider: "windscribe" });
  expect(summary).toMatchObject({ name: "Amsterdam", endpoint: "vpn.example.org", port: 51820, protocol: "wireguard" });
  expect(JSON.stringify(await listProfiles(dir))).not.toContain(secret);
  const loaded = await loadProfile(summary.id, dir);
  expect((await readFile(loaded.filePath, "utf8"))).toContain(secret);
  expect((await stat(loaded.filePath)).mode & 0o777).toBe(0o600);
  await removeProfile(summary.id, dir);
  expect(await listProfiles(dir)).toEqual([]);
});

it("rejects hooks, external includes, and malformed endpoints", async () => {
  const root = await fixture(); const dir = path.join(root, "profiles"); const src = path.join(root, "unsafe.ovpn");
  for (const bad of [
    "client\nremote vpn.example.org 1194\nscript-security 2\nup /tmp/pwn\n",
    "client\nremote vpn.example.org 1194\nconfig /tmp/other.ovpn\n",
    "client\nremote ../../evil 1194\n",
    "client\nremote vpn.example.org 1194\ntls-crypt-v2-verify /tmp/pwn\n",
    "client\nremote vpn.example.org 1194\niproute /tmp/pwn\n",
    "client\nremote vpn.example.org 1194\n--up /tmp/pwn\n",
  ]) {
    await writeFile(src, bad);
    await expect(importVpnProfile(src, dir, { protocol: "openvpn" })).rejects.toThrow();
  }
  expect(await listProfiles(dir)).toEqual([]);
});

it("stores OpenVPN inline credentials and requires explicit port 443 for stealth", async () => {
  const root = await fixture(); const dir = path.join(root, "profiles"); const src = path.join(root, "custom.ovpn");
  const conf = "client\ndev tun\nproto tcp-client\nremote vpn.example.org 1194\nremote-cert-tls server\nauth-nocache\n<ca>\ncertificate\n</ca>\n";
  await writeFile(src, conf);
  const regular = await importVpnProfile(src, dir, { username: "user", password: "secret" });
  const loaded = await loadProfile(regular.id, dir);
  expect(await readFile(loaded.filePath, "utf8")).toContain("<auth-user-pass>\nuser\nsecret\n</auth-user-pass>");
  await expect(importVpnProfile(src, dir, { username: "user\nscript-security 2", password: "secret" })).rejects.toThrow("single-line");
  await expect(importVpnProfile(src, dir, { protocol: "stealth", tlsEndpoint: "relay.example.org:444" })).rejects.toThrow("port 443");
  const stealth = await importVpnProfile(src, dir, { protocol: "stealth", tlsEndpoint: "relay.example.org:443", serverName: "vpn.example.org" });
  expect(stealth).toMatchObject({ protocol: "stealth", endpoint: "relay.example.org", port: 443 });
});
