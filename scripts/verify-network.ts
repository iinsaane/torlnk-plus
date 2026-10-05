import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";
import { DEFAULT_STATE_DIR, loadPlusConfig } from "../src/plus/config";
import { inspectFirewallRules } from "../src/plus/vpn/firewall";

const exec = promisify(execFile);
const docker = async (...args: string[]) => (await exec("docker", args, { timeout: 15_000, maxBuffer: 2_000_000 })).stdout.trim();
const checks: { name: string; passed: boolean; detail: string }[] = [];
const add = (name: string, passed: boolean, detail: string) => checks.push({ name, passed, detail });
let mode: string | null = null;
try {
  const config = await loadPlusConfig(DEFAULT_STATE_DIR);
  mode = config.network.mode;
  if (!mode) throw new Error("Choose routing and start services before inspection");
  if (process.argv.includes("--require-vpn") && mode !== "vpn") throw new Error("This check requires explicit VPN mode");
  const project = `torlnk-plus-${createHash("sha1").update(path.resolve(DEFAULT_STATE_DIR)).digest("hex").slice(0, 9)}`;
  const ids = (await docker("ps", "-q", "--filter", `label=com.docker.compose.project=${project}`)).split(/\s+/).filter(Boolean);
  if (!ids.length) throw new Error("The selected managed stack is not running");
  // Select fields before returning Docker output; never emit environment or profile contents.
  const format = '{"id":{{json .Id}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"networkMode":{{json .HostConfig.NetworkMode}},"caps":{{json .HostConfig.CapAdd}},"bindings":{{json .HostConfig.PortBindings}}}';
  const containers = await Promise.all(ids.map(async id => JSON.parse(await docker("inspect", "--format", format, id)) as {
    id: string; service: string; networkMode: string; caps: string[] | null;
    bindings: Record<string, { HostIp: string; HostPort: string }[] | null> | null;
  }));
  const gateway = containers.find(c => c.service === "gateway");
  if (!gateway) throw new Error("The selected managed gateway is not running");
  const workers = containers.filter(c => c.service !== "gateway");
  add("workers", ["controller", "search", "webtorrent", "qbittorrent"].every(service => workers.some(c => c.service === service)), "Controller, search, WebTorrent, and qBittorrent must be running");
  add("network namespace", workers.every(c => c.networkMode === `container:${gateway.id}`), "All application workers share the selected gateway namespace");
  add("worker privileges", workers.every(c => !(c.caps ?? []).some(cap => /(?:^|_)NET_ADMIN$|(?:^|_)SYS_ADMIN$|ALL/.test(cap))), "Application workers have no added network or system administration capability");
  const bindings = containers.flatMap(c => Object.values(c.bindings ?? {}).flatMap(entries => entries ?? []));
  add("management bindings", bindings.length >= 2 && bindings.every(b => b.HostIp === "127.0.0.1"), "Published management ports bind to IPv4 localhost only");
  const ipv6 = await docker("exec", gateway.id, "sh", "-c", "cat /proc/sys/net/ipv6/conf/all/disable_ipv6 /proc/sys/net/ipv6/conf/default/disable_ipv6");
  add("IPv6", ipv6.split(/\s+/).length === 2 && ipv6.split(/\s+/).every(v => v === "1"), "Managed IPv6 is disabled");
  if (mode === "vpn") {
    const firewall = inspectFirewallRules(await docker("exec", gateway.id, "iptables-save"));
    add("default firewall policies", firewall.defaultDrop.length === 3, "VPN INPUT, FORWARD, and OUTPUT default to DROP");
    add("tunnel egress", firewall.tunnelEgress, "VPN permits application egress through tun0");
    const link = await docker("exec", gateway.id, "ip", "-o", "link", "show", "dev", "tun0");
    add("tunnel interface", /^\d+:\s*tun0:.*<[^>]*\bUP\b[^>]*>/m.test(link), "VPN tunnel interface is up");
    await docker("exec", gateway.id, "/gluetun-entrypoint", "healthcheck");
    add("gateway health", true, "VPN gateway health check passes");
  } else add("direct routing", true, "Direct routing was explicitly selected; VPN firewall requirements do not apply");
} catch (error) {
  add("inspection", false, error instanceof Error && /^(Choose routing|This check requires|The selected managed)/.test(error.message) ? error.message : "Network inspection could not complete; verify Docker access and managed service health");
}
const report = { mode, passed: checks.length > 0 && checks.every(c => c.passed), checks, limitation: "Read-only configuration and live rule inspection. Does not establish crash/startup leak-test coverage or validate every allowed exception." };
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else { for (const check of checks) console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`); console.log(report.limitation); }
if (!report.passed) process.exitCode = 1;
