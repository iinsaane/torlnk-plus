import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import envPaths from "env-paths";
import type { BackendKind, BackendSettings, RouteMode } from "./contracts";
import { SOURCES } from "../sources/registry";

export const DEFAULT_STATE_DIR = process.env.TORLNK_PLUS_STATE_DIR ?? envPaths("torlnk-plus", { suffix: "" }).data;
export interface PlusConfig {
  version: 1;
  defaultBackend: BackendKind;
  downloadDir: string;
  extraDownloadDirs: string[];
  network: { mode: RouteMode | null; profileId?: string; forwardedPort?: number };
  backendSettings: BackendSettings;
  enabledSources: string[];
  category: "all" | "games" | "movies" | "tv" | "anime";
  searchTimeoutMs: number;
  display: { compact: boolean; refreshMs: number; pieceRefreshMs: number; legend: boolean; reducedAnimation: boolean };
}
export function defaultPlusConfig(): PlusConfig {
  return {
    version: 1, defaultBackend: "qbittorrent", downloadDir: path.join(os.homedir(), "Downloads", "torlnk-plus"), extraDownloadDirs: [],
    network: { mode: null },
    backendSettings: { downloadLimitKiB: 0, uploadLimitKiB: 0, maxDownloads: 3, maxConnections: 100, dht: true, pex: true, utp: true, listenPort: 6881, seedRatio: 0, seedTimeMinutes: 0, completionAction: "seed", trackers: [] },
    enabledSources: SOURCES.map(s => s.id), category: "all", searchTimeoutMs: 15000,
    display: { compact: false, refreshMs: 1000, pieceRefreshMs: 2000, legend: true, reducedAnimation: true },
  };
}

function fail(field: string, expectation: string): never { throw new Error(`Invalid settings field ${field}: ${expectation}.`); }
function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(field, "expected an object");
  return value as Record<string, unknown>;
}
function checkKeys(value: Record<string, unknown>, allowed: string[], field: string): void {
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) fail(`${field}.${extra}`, "unknown setting");
}
function str(value: unknown, field: string, absolute = false): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return fail(field, "expected a non-empty string");
  if (absolute && !path.isAbsolute(value)) return fail(field, "expected an absolute path");
  return value;
}
function number(value: unknown, field: string, min: number, max: number, integer = true): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) return fail(field, `expected ${integer ? "an integer" : "a number"} from ${min} to ${max}`);
  return value;
}
function boolean(value: unknown, field: string): boolean { if (typeof value !== "boolean") return fail(field, "expected true or false"); return value; }
function strings(value: unknown, field: string, nonempty = false): string[] {
  if (!Array.isArray(value)) return fail(field, "expected a list");
  const list = value.map((v, i) => str(v, `${field}[${i}]`));
  if (nonempty && list.length === 0) return fail(field, "select at least one source");
  return list;
}

/** Validate and normalize a config while allowing omitted fields for older config versions. */
export function validatePlusConfig(input: unknown): PlusConfig {
  const base = defaultPlusConfig();
  const raw = object(input, "config");
  checkKeys(raw, Object.keys(base), "config");
  if (raw.version !== undefined && raw.version !== 1) fail("version", "only version 1 is supported");
  const backend = raw.defaultBackend ?? base.defaultBackend;
  if (backend !== "webtorrent" && backend !== "qbittorrent") fail("defaultBackend", "unsupported backend");
  const netRaw = object(raw.network === undefined ? base.network : { ...base.network, ...object(raw.network, "network") }, "network");
  checkKeys(netRaw, ["mode", "profileId", "forwardedPort"], "network");
  const mode = netRaw.mode;
  if (mode !== null && mode !== "direct" && mode !== "vpn") fail("network.mode", "choose direct or vpn");
  const network: PlusConfig["network"] = { mode };
  if (netRaw.profileId !== undefined) { network.profileId = str(netRaw.profileId, "network.profileId"); if (!/^[a-f0-9]{16}$/.test(network.profileId)) fail("network.profileId", "expected an imported profile ID"); }
  if (netRaw.forwardedPort !== undefined) network.forwardedPort = number(netRaw.forwardedPort, "network.forwardedPort", 1, 65535);
  const bRaw = object(raw.backendSettings === undefined ? base.backendSettings : { ...base.backendSettings, ...object(raw.backendSettings, "backendSettings") }, "backendSettings");
  checkKeys(bRaw, Object.keys(base.backendSettings), "backendSettings");
  if (bRaw.completionAction !== "seed" && bRaw.completionAction !== "pause") fail("backendSettings.completionAction", "choose seed or pause");
  const trackers = strings(bRaw.trackers, "backendSettings.trackers");
  for (const tracker of trackers) { try { const u = new URL(tracker); if (!["http:", "https:", "udp:", "ws:", "wss:"].includes(u.protocol)) throw new Error(); } catch { fail("backendSettings.trackers", "expected tracker URLs"); } }
  const backendSettings: BackendSettings = {
    downloadLimitKiB: number(bRaw.downloadLimitKiB, "backendSettings.downloadLimitKiB", 0, 2_147_483_647), uploadLimitKiB: number(bRaw.uploadLimitKiB, "backendSettings.uploadLimitKiB", 0, 2_147_483_647),
    maxDownloads: number(bRaw.maxDownloads, "backendSettings.maxDownloads", 1, 1000), maxConnections: number(bRaw.maxConnections, "backendSettings.maxConnections", 1, 100_000),
    dht: boolean(bRaw.dht, "backendSettings.dht"), pex: boolean(bRaw.pex, "backendSettings.pex"), utp: boolean(bRaw.utp, "backendSettings.utp"), listenPort: number(bRaw.listenPort, "backendSettings.listenPort", 1, 65535),
    seedRatio: number(bRaw.seedRatio, "backendSettings.seedRatio", 0, 100_000, false), seedTimeMinutes: number(bRaw.seedTimeMinutes, "backendSettings.seedTimeMinutes", 0, 52_560_000), completionAction: bRaw.completionAction, trackers,
  };
  const dRaw = object(raw.display === undefined ? base.display : { ...base.display, ...object(raw.display, "display") }, "display");
  checkKeys(dRaw, Object.keys(base.display), "display");
  const sources = strings(raw.enabledSources ?? base.enabledSources, "enabledSources", true);
  const sourceIds = new Set<string>(SOURCES.map(s => s.id));
  for (const source of sources) if (!sourceIds.has(source)) fail("enabledSources", `unknown source '${source}'`);
  const category = raw.category ?? base.category;
  if (!["all", "games", "movies", "tv", "anime"].includes(String(category))) fail("category", "unsupported category");
  return {
    version: 1, defaultBackend: backend, downloadDir: str(raw.downloadDir ?? base.downloadDir, "downloadDir", true),
    extraDownloadDirs: strings(raw.extraDownloadDirs ?? base.extraDownloadDirs, "extraDownloadDirs").map((v, i) => str(v, `extraDownloadDirs[${i}]`, true)),
    network, backendSettings, enabledSources: sources, category: category as PlusConfig["category"], searchTimeoutMs: number(raw.searchTimeoutMs ?? base.searchTimeoutMs, "searchTimeoutMs", 100, 600_000),
    display: { compact: boolean(dRaw.compact, "display.compact"), refreshMs: number(dRaw.refreshMs, "display.refreshMs", 100, 60_000), pieceRefreshMs: number(dRaw.pieceRefreshMs, "display.pieceRefreshMs", 100, 60_000), legend: boolean(dRaw.legend, "display.legend"), reducedAnimation: boolean(dRaw.reducedAnimation, "display.reducedAnimation") },
  };
}

export async function loadPlusConfig(stateDir = DEFAULT_STATE_DIR): Promise<PlusConfig> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(stateDir, "config.json"), "utf8"));
    return validatePlusConfig(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultPlusConfig();
    throw new Error(`Settings could not be read or validated. The original config was preserved. ${error instanceof Error ? error.message : "Invalid config."}`);
  }
}
export async function savePlusConfig(stateDir: string, config: PlusConfig): Promise<void> {
  const normalized = validatePlusConfig(config);
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const destination = path.join(stateDir, "config.json");
  const tmp = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(normalized, null, 2), { mode: 0o600, flag: "wx" });
    await fs.rename(tmp, destination);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
