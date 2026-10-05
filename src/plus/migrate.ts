import { promises as fs } from "node:fs";
import path from "node:path";
import { writeJsonAtomic } from "../util/atomic";
import parseTorrent from "parse-torrent";

type LegacyTorrent = { id: string; backend: "webtorrent"; source: string; name?: string; savePath: string; paused: boolean; addedAt: number };
export type LegacyImportResult = { imported: boolean; backupDir: string; config: Record<string, unknown> | null; torrents: { id: string; backend: "webtorrent" }[] };
type MigrationManifest = { version: 1; status: "copying" | "complete"; configDir: string; dataDir: string; backupDir: string; config: Record<string, unknown> | null; torrents: { id: string; backend: "webtorrent" }[] };

/** Copies legacy configuration and data without modifying either source tree. */
export async function importLegacy(sourceConfigDir: string, sourceDataDir: string, destinationDir: string): Promise<LegacyImportResult> {
  const dest = path.resolve(destinationDir);
  const sourceConfig = path.resolve(sourceConfigDir);
  const sourceData = path.resolve(sourceDataDir);
  if (dest === sourceConfig || dest === sourceData || dest.startsWith(`${sourceConfig}${path.sep}`) || dest.startsWith(`${sourceData}${path.sep}`)) throw new Error("Destination must be outside legacy source directories");
  const backupDir = path.join(dest, "legacy-backup");
  const manifestFile = path.join(dest, "migration.json");
  let existing: MigrationManifest | undefined;
  try {
    existing = JSON.parse(await fs.readFile(manifestFile, "utf8")) as MigrationManifest;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    try {
      const entries = await fs.readdir(dest);
      if (entries.length) throw new Error("Refusing to import over existing destination state without a migration manifest");
    } catch (dirError) { if ((dirError as NodeJS.ErrnoException).code !== "ENOENT") throw dirError; }
  }
  if (existing && (existing.configDir !== sourceConfig || existing.dataDir !== sourceData)) throw new Error("Migration source paths differ from the existing migration manifest");
  if (existing?.status === "complete") return { imported: true, backupDir, config: existing.config, torrents: existing.torrents };
  const config = await readLegacyConfig(sourceConfig);
  const fallbackSavePath = typeof config?.downloadDir === "string" && config.downloadDir ? config.downloadDir : process.cwd();
  const legacy = await discoverTorrents(sourceData, fallbackSavePath);
  const manifest: MigrationManifest = existing || { version: 1, status: "copying", configDir: sourceConfig, dataDir: sourceData, backupDir, config, torrents: [] };
  manifest.status = "copying";
  await fs.mkdir(dest, { recursive: true });
  await writeJsonAtomic(manifestFile, manifest);
  await fs.mkdir(backupDir, { recursive: true });
  await copyTree(sourceConfig, path.join(backupDir, "config"));
  await copyTree(sourceData, path.join(backupDir, "data"));
  const metadataDir = path.join(dest, "webtorrent", "metadata");
  await fs.mkdir(metadataDir, { recursive: true });
  const records: LegacyTorrent[] = [];
  for (const t of legacy) {
    const metadata = t.source.startsWith("magnet:") ? "" : t.source;
    let source = t.source;
    if (metadata) {
      try { await fs.access(metadata); const target = path.join(metadataDir, `${t.id}.torrent`); await fs.copyFile(metadata, target); source = target; }
      catch { continue; }
    }
    records.push({ ...t, source });
  }
  const torrents = records.map(({ id }) => ({ id, backend: "webtorrent" as const }));
  await writeJsonAtomic(path.join(dest, "ownership.json"), torrents);
  await writeJsonAtomic(path.join(dest, "webtorrent", "manifest.json"), { torrents: records, settings: {} });
  manifest.torrents = torrents;
  manifest.status = "complete";
  await writeJsonAtomic(manifestFile, manifest);
  return { imported: true, backupDir, config, torrents };
}

async function readLegacyConfig(dir: string): Promise<Record<string, unknown> | null> {
  try { const value: unknown = JSON.parse(await fs.readFile(path.join(dir, "config.json"), "utf8")); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
  catch { return null; }
}

async function copyTree(source: string, destination: string): Promise<void> {
  let st;
  try { st = await fs.stat(source); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  if (!st.isDirectory()) throw new Error(`Legacy source is not a directory: ${source}`);
  await fs.cp(source, destination, { recursive: true, force: true, errorOnExist: false, preserveTimestamps: true });
}

async function discoverTorrents(dataDir: string, fallbackSavePath: string): Promise<LegacyTorrent[]> {
  const out = new Map<string, LegacyTorrent>();
  for (const filename of ["queue.json", "seeds.json"]) {
    let json: unknown;
    try { json = JSON.parse(await fs.readFile(path.join(dataDir, filename), "utf8")); } catch { continue; }
    const records = Array.isArray(json) ? json : json && typeof json === "object" ? Object.values(json as Record<string, unknown>) : [];
    for (const rec of records) {
      if (!rec || typeof rec !== "object") continue;
      const r = rec as Record<string, unknown>;
      const rawSource = [r.magnet, r.magnetURI, r.source].find((x): x is string => typeof x === "string" && x.startsWith("magnet:"));
      let id: string | undefined;
      try { if (rawSource) id = (await parseTorrent(rawSource)).infoHash.toLowerCase(); } catch { /* malformed old entry */ }
      if (!id) for (const raw of [r.infoHash, r.infohash, r.hash, r.id]) if (typeof raw === "string" && /^[a-f\d]{40}(?:[a-f\d]{24})?$/i.test(raw)) { id = raw.toLowerCase(); break; }
      if (!id) continue;
      const metadata = path.join(dataDir, "torrents", `${id}.torrent`);
      if (!rawSource) { try { await fs.access(metadata); } catch { continue; } }
      const savePath = [r.dir, r.savePath, r.path, r.downloadPath].find((x): x is string => typeof x === "string") || fallbackSavePath;
      out.set(id, { id, backend: "webtorrent", source: rawSource || metadata, name: typeof r.name === "string" ? r.name : undefined, savePath, paused: r.paused === true || r.state === "paused" || r.status === "paused" || r.status === "missing", addedAt: typeof r.addedAt === "number" ? r.addedAt : Date.now() });
    }
  }
  // If the legacy metadata directory uses hashed names, carry those owners too.
  try {
    for (const entry of await fs.readdir(path.join(dataDir, "torrents"), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".torrent")) continue;
      const bytes = await fs.readFile(path.join(dataDir, "torrents", entry.name));
      const id = entry.name.slice(0, -8).toLowerCase();
      try {
        const hash = (await parseTorrent(bytes)).infoHash.toLowerCase();
        const existing = out.get(hash);
        out.set(hash, existing ? { ...existing, source: path.join(dataDir, "torrents", entry.name) } : { id: hash, backend: "webtorrent", source: path.join(dataDir, "torrents", entry.name), name: undefined, savePath: fallbackSavePath, paused: true, addedAt: Date.now() });
      } catch { /* ignore invalid metadata */ }
    }
  } catch { /* no metadata directory */ }
  return [...out.values()];
}
