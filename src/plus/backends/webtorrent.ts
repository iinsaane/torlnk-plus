import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import WebTorrent, { type Torrent } from "webtorrent";
import type { BackendCapabilities, BackendSettings, FileSnapshot, PieceSnapshot, TorrentBackend, TorrentDetails, TorrentInput, TorrentSnapshot, TorrentState, TrackerSnapshot } from "../contracts";

type Persisted = { id: string; source: string; name?: string; savePath: string; paused: boolean; addedAt: number; uploaded?: number; completedAt?: number };
type Manifest = { torrents: Persisted[]; settings?: Partial<BackendSettings> };
type RuntimeTorrent = { torrent: Torrent; record: Persisted; addedAt: number; completedAt?: number; uploadedBase?: number; checking?: boolean; error?: string };
type ClientFactory = (options?: Record<string, unknown>) => WebTorrent;
type TorrentParser = (source: unknown) => Promise<{ infoHash: string }>;

const capabilities: BackendCapabilities = { settings: ["downloadLimitKiB", "uploadLimitKiB", "maxConnections", "dht", "utp", "listenPort", "trackers"], recheck: true, files: true, pieces: true, export: true };
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const parseSource = async (source: unknown) => ((await import("parse-torrent")).default as TorrentParser)(source);

/** WebTorrent adapter with crash-safe metadata and source ownership. */
export class WebTorrentBackend implements TorrentBackend {
  readonly kind = "webtorrent" as const;
  readonly capabilities = capabilities;
  private client: WebTorrent | null = null;
  private items = new Map<string, RuntimeTorrent>();
  private starting: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private manifest: Manifest = { torrents: [] };
  private settings: Partial<BackendSettings> = {};
  private manifestWrite: Promise<void> = Promise.resolve();
  private readonly metadataDir: string;
  private readonly manifestPath: string;

  constructor(readonly stateDir: string, private readonly createClient: ClientFactory = opts => new WebTorrent({ natPmp: process.platform !== "darwin", ...opts } as never)) {
    this.metadataDir = path.join(stateDir, "metadata");
    this.manifestPath = path.join(stateDir, "manifest.json");
  }
  async start(): Promise<void> {
    if (this.client) return;
    if (this.starting) return this.starting;
    this.starting = this.startImpl();
    try { await this.starting; } finally { this.starting = null; }
  }
  private async startImpl(): Promise<void> {
    await fs.mkdir(this.metadataDir, { recursive: true });
    try { this.manifest = JSON.parse(await fs.readFile(this.manifestPath, "utf8")) as Manifest; this.settings = { ...this.settings, ...this.manifest.settings }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; this.manifest = { torrents: [] }; }
    // The controller assigns qBittorrent its configured port; WebTorrent takes the next port.
    const listenPort = this.settings.listenPort ? (this.settings.listenPort === 65535 ? 1024 : this.settings.listenPort + 1) : undefined;
    const client = this.createClient({ dht: this.settings.dht, utp: this.settings.utp, maxConns: this.settings.maxConnections, torrentPort: listenPort });
    client.on("error", () => {});
    this.client = client;
    for (const record of this.manifest.torrents) {
      try { await this.attach(record.id, this.sourceFromRecord(record.source), record, true); }
      catch (e) { this.items.set(record.id, { torrent: null as unknown as Torrent, record, addedAt: record.addedAt, error: message(e) }); }
    }
    this.applyLiveLimits();
  }
  private sourceFromRecord(source: string): string | Uint8Array {
    return source.startsWith("base64:") ? Buffer.from(source.slice(7), "base64") : source;
  }
  /** Parsing identifies magnets and .torrent bytes without waiting for peers. */
  private async attach(id: string, source: string | Uint8Array, record: Persisted, restoring = false, checking = false): Promise<string> {
    if (!this.client) throw new Error("WebTorrent backend is stopped");
    const client = this.client;
    const torrent = client.add(source as string, {
      path: record.savePath, paused: record.paused,
      ...(this.settings.trackers?.length ? { announce: this.settings.trackers } : {}),
    } as never);
    const hash = id.toLowerCase();
    const rt: RuntimeTorrent = { torrent, record: { ...record, id: hash, name: record.name || torrent.name }, addedAt: record.addedAt || Date.now(), completedAt: record.completedAt, uploadedBase: record.uploaded || 0, checking };
    this.items.set(hash, rt);
    torrent.on("error", (e: unknown) => { rt.error = message(e); void this.persist().catch(() => {}); });
    torrent.on("metadata", () => {
      rt.record.name = torrent.name || rt.record.name;
      void this.saveMetadata(hash).catch(e => { rt.error = message(e); });
    });
    torrent.on("done", () => { rt.completedAt ??= Date.now(); rt.record.completedAt = rt.completedAt; void this.persist().catch(() => {}); });
    torrent.once("ready", () => { rt.checking = false; });
    if (!restoring && this.hasMetadata(torrent)) await this.saveMetadata(hash);
    return hash;
  }
  private hasMetadata(torrent: Torrent): boolean { return !!(torrent as unknown as { metadata?: Uint8Array }).metadata?.byteLength; }
  private async saveMetadata(id: string): Promise<void> {
    const rt = this.items.get(id);
    if (!rt?.torrent || !this.hasMetadata(rt.torrent)) return;
    const file = path.join(this.metadataDir, `${id}.torrent`);
    await this.atomicWrite(file, Buffer.from(rt.torrent.torrentFile));
    rt.record.source = file;
    await this.persist();
  }
  private async atomicWrite(file: string, data: Uint8Array | string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  }
  private async persist(): Promise<void> {
    for (const x of this.items.values()) { if (x.torrent) x.record.uploaded = (x.uploadedBase || 0) + (x.torrent.uploaded || 0); if (x.completedAt) x.record.completedAt = x.completedAt; }
    this.manifest = { torrents: [...this.items.values()].map(x => x.record), settings: this.settings };
    const content = JSON.stringify(this.manifest, null, 2);
    this.manifestWrite = this.manifestWrite.catch(() => {}).then(() => this.atomicWrite(this.manifestPath, content));
    await this.manifestWrite;
  }
  async list(): Promise<TorrentSnapshot[]> { return [...this.items.values()].map(x => this.snapshot(x)); }
  private snapshot(x: RuntimeTorrent): TorrentSnapshot {
    const t = x.torrent;
    if (!t) return { id: x.record.id, backend: this.kind, name: x.record.name || x.record.id, state: "failed", progress: 0, total: 0, downloaded: 0, uploaded: 0, downloadSpeed: 0, uploadSpeed: 0, savePath: x.record.savePath, addedAt: x.addedAt, error: x.error };
    try {
      const state: TorrentState = x.error ? "failed" : x.record.paused || t.paused ? "paused" : x.checking ? "checking" : !t.ready ? "metadata" : t.done ? "seeding" : "downloading";
      return { id: x.record.id, backend: this.kind, name: t.name || x.record.name || x.record.id, state, progress: t.progress || 0, total: t.length || 0, downloaded: t.downloaded || 0, uploaded: (x.uploadedBase || 0) + (t.uploaded || 0), downloadSpeed: t.downloadSpeed || 0, uploadSpeed: t.uploadSpeed || 0, peers: t.numPeers || 0, etaSeconds: Number.isFinite(t.timeRemaining) ? Math.ceil(t.timeRemaining / 1000) : undefined, ratio: t.length ? ((x.uploadedBase || 0) + (t.uploaded || 0)) / t.length : undefined, addedAt: x.addedAt, completedAt: x.completedAt, savePath: x.record.savePath, error: x.error };
    } catch (e) {
      x.error = message(e);
      return { id: x.record.id, backend: this.kind, name: x.record.name || x.record.id, state: "failed", progress: 0, total: 0, downloaded: 0, uploaded: 0, downloadSpeed: 0, uploadSpeed: 0, savePath: x.record.savePath, error: x.error, addedAt: x.addedAt };
    }
  }
  async add(input: TorrentInput): Promise<string> {
    const source = input.magnet || (input.torrentBase64 ? Buffer.from(input.torrentBase64, "base64") : null);
    if (!source) throw new Error("A magnet or torrentBase64 is required");
    const parsed = await parseSource(source);
    const id = parsed.infoHash.toLowerCase();
    if (this.items.has(id)) return id;
    const storedSource = input.magnet || `base64:${input.torrentBase64}`;
    const record: Persisted = { id, source: storedSource, name: input.name, savePath: input.savePath, paused: !!input.paused, addedAt: Date.now() };
    await this.attach(id, source, record);
    await this.persist();
    return id;
  }
  private get(id: string): RuntimeTorrent { const x = this.items.get(id.toLowerCase()); if (!x) throw new Error(`Torrent not found: ${id}`); if (!x.torrent) throw new Error(x.error || `Torrent unavailable: ${id}`); return x; }
  async pause(id: string): Promise<void> {
    const x = this.get(id); x.torrent.pause();
    const peers = (x.torrent as unknown as { _peers?: Map<unknown, { destroy?: () => void }> })._peers;
    for (const peer of peers?.values() || []) { try { peer.destroy?.(); } catch {} }
    x.record.paused = true; await this.persist();
  }
  async resume(id: string): Promise<void> { const x = this.get(id); x.record.paused = false; x.torrent.resume(); await this.persist(); }
  async remove(id: string, deleteData = false): Promise<void> {
    const x = this.items.get(id.toLowerCase());
    if (!x) throw new Error(`Torrent not found: ${id}`);
    if ((!x.torrent || (x.torrent as Torrent & { destroyed?: boolean }).destroyed) && deleteData) throw new Error("Cannot delete files without torrent metadata; remove the record without deleting data");
    if (x.torrent && !(x.torrent as Torrent & { destroyed?: boolean }).destroyed) await new Promise<void>((resolve, reject) => (this.client!.remove as unknown as (hash: string, options: unknown, cb: (e?: Error) => void) => void)(x.record.id, { destroyStore: deleteData }, (e?: Error) => e ? reject(e) : resolve()));
    this.items.delete(x.record.id); await fs.rm(path.join(this.metadataDir, `${x.record.id}.torrent`), { force: true }); await this.persist();
  }
  async recheck(id: string): Promise<void> {
    const x = this.get(id);
    const wasPaused = x.record.paused || x.torrent.paused;
    const record = { ...x.record, uploaded: (x.uploadedBase || 0) + (x.torrent.uploaded || 0), paused: wasPaused };
    const source = this.sourceFromRecord(record.source);
    await this.persist();
    await new Promise<void>((resolve, reject) => (this.client!.remove as unknown as (hash: string, options: unknown, cb: (e?: Error) => void) => void)(record.id, { destroyStore: false }, (e?: Error) => e ? reject(e) : resolve()));
    this.items.delete(record.id);
    await this.attach(record.id, source, record, false, true);
    await this.persist();
  }
  async exportTorrent(id: string): Promise<Uint8Array> { const x = this.get(id); if (!this.hasMetadata(x.torrent)) throw new Error("Torrent metadata is not available yet"); return new Uint8Array(x.torrent.torrentFile); }
  async details(id: string): Promise<TorrentDetails> {
    const x = this.get(id); const torrent = this.snapshot(x);
    const files: FileSnapshot[] = (x.torrent.files || []).map(f => ({ path: f.path, size: f.length, progress: (f as unknown as { progress?: number }).progress }));
    const trackers: TrackerSnapshot[] = ((x.torrent as unknown as { announce?: string[] }).announce || []).map(url => ({ url }));
    return { torrent, files, trackers };
  }
  async pieces(id: string): Promise<PieceSnapshot | null> {
    const t = this.get(id).torrent as unknown as { pieceLength?: number; length?: number; pieces?: unknown[]; bitfield?: { get(i: number): boolean }; _reservations?: unknown[][] };
    if (!t.pieces || !t.pieceLength) return null;
    const pieceLength = t.pieceLength; const count = t.pieces.length; const lastPieceLength = (t.length || 0) % pieceLength || pieceLength;
    return { states: Array.from({ length: count }, (_, i) => { try { return t.bitfield?.get(i) ? "verified" : (t._reservations?.[i]?.some(Boolean) ? "active" : "missing"); } catch { return "unknown"; } }), pieceLength, lastPieceLength };
  }
  private applyLiveLimits(): void {
    const client = this.client as unknown as { throttleDownload?: (n: number) => void; throttleUpload?: (n: number) => void; maxConns?: number } | null;
    if (this.settings.downloadLimitKiB !== undefined) client?.throttleDownload?.(this.settings.downloadLimitKiB <= 0 ? -1 : this.settings.downloadLimitKiB * 1024);
    if (this.settings.uploadLimitKiB !== undefined) client?.throttleUpload?.(this.settings.uploadLimitKiB <= 0 ? -1 : this.settings.uploadLimitKiB * 1024);
    if (this.settings.maxConnections !== undefined && client) client.maxConns = this.settings.maxConnections;
  }
  async applySettings(settings: Partial<BackendSettings>): Promise<{ restartRequired: string[] }> {
    if (!this.client) {
      try { this.manifest = JSON.parse(await fs.readFile(this.manifestPath, "utf8")) as Manifest; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      this.settings = { ...this.manifest.settings, ...this.settings, ...settings };
      const content = JSON.stringify({ ...this.manifest, settings: this.settings }, null, 2);
      await this.atomicWrite(this.manifestPath, content);
      return { restartRequired: [] };
    }
    this.settings = { ...this.settings, ...settings };
    this.applyLiveLimits(); await this.persist();
    return { restartRequired: Object.keys(settings).filter(k => ["dht", "utp", "listenPort", "trackers"].includes(k)) };
  }
  async checkpoint(): Promise<void> {
    for (const [id, x] of this.items) {
      try { if (x.torrent && this.hasMetadata(x.torrent)) { await this.atomicWrite(path.join(this.metadataDir, `${id}.torrent`), Buffer.from(x.torrent.torrentFile)); x.record.source = path.join(this.metadataDir, `${id}.torrent`); } }
      catch (e) { x.error = message(e); }
    }
    await this.persist();
  }
  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => { if (this.starting) await this.starting.catch(() => {}); if (!this.client) return; await this.checkpoint(); const client = this.client; this.client = null; await new Promise<void>(resolve => client.destroy(() => resolve())); })();
    try { await this.stopping; } finally { this.stopping = null; }
  }
}
