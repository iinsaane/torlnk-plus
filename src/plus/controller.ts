import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { BackendHealth, BackendKind, BackendSettings, ControllerSnapshot, RouteStatus, TorrentBackend, TorrentDetails, TorrentInput, TorrentSnapshot } from "./contracts";
import { writeJsonAtomic } from "../util/atomic";
import parseTorrent from "parse-torrent";

type HistoryRecord = { id: string; backend: BackendKind; name: string; savePath: string; addedAt: number; completedAt?: number; removedAt?: number };
type Owner = { id: string; backend: BackendKind };
type PolicyState = { settings: Partial<BackendSettings>; queued: string[]; completedAt: Record<string, number> };
type Options = { defaultBackend: BackendKind; stateDir: string; suspended?: boolean };
export type ActiveToken = { backend: BackendKind; id: string };

export class PlusController {
  private readonly byKind: Map<BackendKind, TorrentBackend>;
  private readonly ownersFile: string;
  private readonly policyFile: string;
  private readonly historyFile: string;
  private history: HistoryRecord[] = [];
  private historyWrite: Promise<void> = Promise.resolve();
  private historyDirty = false;
  private owners = new Map<string, BackendKind>();
  private policy: PolicyState = { settings: {}, queued: [], completedAt: {} };
  private ownersWrite: Promise<void> = Promise.resolve();
  private policyWrite: Promise<void> = Promise.resolve();
  private health: BackendHealth[] = [];
  private readonly route: RouteStatus = { mode: "direct", state: "Direct" };
  private readonly operationLocks = new Map<string, Promise<unknown>>();
  constructor(private readonly backends: TorrentBackend[], private readonly options: Options) {
    this.policySuspended = Boolean(options.suspended);
    this.byKind = new Map(backends.map(b => [b.kind, b]));
    this.ownersFile = path.join(options.stateDir, "ownership.json");
    this.policyFile = path.join(options.stateDir, "policy.json");
    this.historyFile = path.join(options.stateDir, "history.json");
  }
  async start(): Promise<ControllerSnapshot> {
    await fs.mkdir(this.options.stateDir, { recursive: true });
    try { const rows = JSON.parse(await fs.readFile(this.ownersFile, "utf8")) as Owner[]; this.owners = new Map(rows.map(x => [x.id.toLowerCase(), x.backend])); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    try { const saved = JSON.parse(await fs.readFile(this.policyFile, "utf8")) as PolicyState; this.policy = { settings: saved.settings || {}, queued: saved.queued || [], completedAt: saved.completedAt || {} }; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    try { this.history = JSON.parse(await fs.readFile(this.historyFile, "utf8")); if (!Array.isArray(this.history)) throw new Error("Invalid controller history"); await fs.chmod(this.historyFile, 0o600); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    this.health = await Promise.all(this.backends.map(async b => { try { await b.start(); return { backend: b.kind, available: true }; } catch (e) { return { backend: b.kind, available: false, message: this.error(e) }; } }));
    await this.reconcile();
    return this.snapshot();
  }
  private error(e: unknown): string { return e instanceof Error ? e.message : String(e); }
  private backend(kind: BackendKind): TorrentBackend { const b = this.byKind.get(kind); if (!b) throw new Error(`Backend unavailable: ${kind}`); return b; }
  private saveOwners(): Promise<void> {
    const rows = [...this.owners].map(([id, backend]) => ({ id, backend }));
    this.ownersWrite = this.ownersWrite.catch(() => {}).then(() => writeJsonAtomic(this.ownersFile, rows));
    return this.ownersWrite;
  }
  private savePolicy(): Promise<void> {
    this.policyWrite = this.policyWrite.catch(() => {}).then(async () => {
      const temporary = `${this.policyFile}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, JSON.stringify(this.policy, null, 2), { mode: 0o600 }); await fs.rename(temporary, this.policyFile); }
      finally { await fs.rm(temporary, { force: true }); }
    });
    return this.policyWrite;
  }
  private updateHistory(change: () => boolean): Promise<void> {
    const write = this.historyWrite.catch(() => {}).then(async () => {
      if (!change() && !this.historyDirty && this.history.length <= 1000) return;
      this.historyDirty = true;
      this.history = this.history.slice(-1000);
      const temporary = `${this.historyFile}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, JSON.stringify(this.history, null, 2), { mode: 0o600 }); await fs.rename(temporary, this.historyFile); this.historyDirty = false; }
      finally { await fs.rm(temporary, { force: true }); }
    });
    this.historyWrite = write;
    return write;
  }
  private observeHistory(rows: TorrentSnapshot[]): Promise<void> {
    return this.updateHistory(() => {
      let changed = false;
      for (const row of rows) {
        const id = row.id.toLowerCase();
        // A snapshot taken before removal must not recreate a removed record.
        if (this.owners.get(id) !== row.backend) continue;
        let record = this.history.findLast(x => x.id === id && x.backend === row.backend && !x.removedAt);
        if (!record) { record = { id, backend: row.backend, name: row.name, savePath: row.savePath, addedAt: row.addedAt || Date.now() }; this.history.push(record); changed = true; }
        if (record.name !== row.name || record.savePath !== row.savePath) { record.name = row.name; record.savePath = row.savePath; changed = true; }
        if (!record.completedAt && (row.progress >= 1 || row.state === "seeding" || row.state === "completed")) { record.completedAt = row.completedAt || Date.now(); changed = true; }
      }
      return changed;
    });
  }
  private async reconcile(): Promise<void> {
    const live = new Map<string, { backend: TorrentBackend; torrent: TorrentSnapshot }>();
    for (const b of this.backends) {
      if (this.health.find(x => x.backend === b.kind)?.available === false) continue;
      try {
        for (const t of await b.list()) {
          const id = t.id.toLowerCase(); const existing = live.get(id);
          if (existing) {
            const retained = this.owners.get(id) || existing.backend.kind;
            // Stop both copies before attempting destructive duplicate cleanup.
            await Promise.all([b.pause(id), existing.backend.pause(id)]);
            const duplicate = b.kind !== retained ? b : existing.backend;
            try { await duplicate.remove(id); } catch (e) { throw new Error(`Duplicate torrent ${id} exists on ${existing.backend.kind} and ${b.kind}; both were paused, but duplicate cleanup failed: ${this.error(e)}`); }
            if (b.kind !== retained) continue;
          }
          live.set(id, { backend: b, torrent: t });
          this.owners.set(id, b.kind);
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("Duplicate torrent ")) throw e;
        const health = this.health.find(x => x.backend === b.kind);
        if (health) { health.available = false; health.message = this.error(e); }
      }
    }
    await this.saveOwners();
  }
  async snapshot(): Promise<ControllerSnapshot> {
    const torrents: TorrentSnapshot[] = []; let recovered = false;
    for (const b of this.backends) {
      const health = this.health.find(x => x.backend === b.kind);
      try { torrents.push(...await b.list()); if (health && !health.available) recovered = true; if (health) { health.available = true; health.message = undefined; } }
      catch (e) { if (health) { health.available = false; health.message = this.error(e); } }
    }
    if (recovered) { await this.reconcile(); return this.snapshot(); }
    await this.applyPolicy(torrents);
    await this.observeHistory(torrents);
    return { torrents, backends: this.health.map(x => ({ ...x })), route: { ...this.route } };
  }
  private policySuspended: boolean;
  private policyLock: Promise<void> = Promise.resolve();
  private async applyPolicy(rows: TorrentSnapshot[]): Promise<void> {
    const work = this.policyLock.catch(() => {}).then(async () => {
      if (this.policySuspended) return;
      const max = this.policy.settings.maxDownloads || 0;
      const autoQueued = new Set(this.policy.queued.map(x => x.toLowerCase()));
      const now = Date.now();
      for (const t of rows) {
        const id = t.id.toLowerCase();
        if (t.progress >= 1 || t.state === "seeding" || t.state === "completed") {
          autoQueued.delete(id);
          if (!this.policy.completedAt[id]) this.policy.completedAt[id] = t.completedAt || now;
          t.completedAt = this.policy.completedAt[id];
          const settings = this.policy.settings;
          const elapsed = (now - this.policy.completedAt[id]) / 60_000;
          const threshold = (settings.seedRatio || 0) > 0 && (t.ratio || 0) >= (settings.seedRatio || 0) || (settings.seedTimeMinutes || 0) > 0 && elapsed >= (settings.seedTimeMinutes || 0);
          if ((settings.completionAction === "pause" || threshold) && t.state !== "paused" && t.state !== "checking") { await this.owner(id).pause(t.id); t.state = "paused"; }
        }
      }
      const occupiesSlot = (state: TorrentSnapshot["state"]) => ["downloading", "metadata", "checking", "queued"].includes(state);
      let active = rows.filter(t => occupiesSlot(t.state) && !autoQueued.has(t.id.toLowerCase())).length;
      if (max > 0 && active > max) {
        for (const t of rows) {
          if (active <= max) break;
          if (!occupiesSlot(t.state) || autoQueued.has(t.id.toLowerCase())) continue;
          const id = t.id.toLowerCase();
          await this.owner(id).pause(t.id);
          t.state = "queued";
          autoQueued.add(id);
          active--;
        }
      }
      for (const t of rows) {
        const id = t.id.toLowerCase();
        if (!autoQueued.has(id)) continue;
        // Explicit user pauses remove ids from policy. A paused state alone is
        // also how adapters represent controller-owned queued downloads.
        if (t.state !== "paused" && t.state !== "queued" && t.state !== "downloading") { autoQueued.delete(id); continue; }
        if (max === 0 || active < max) {
          await this.owner(id).resume(t.id); t.state = "downloading"; active++; autoQueued.delete(id);
        } else t.state = "queued";
      }
      this.policy.queued = [...autoQueued];
      await this.savePolicy();
    });
    this.policyLock = work;
    await work;
  }
  async list(): Promise<TorrentSnapshot[]> { return (await this.snapshot()).torrents; }
  add(input: TorrentInput): Promise<string> { return this.operation("controller:add", async () => {
    const kind = input.backend || this.options.defaultBackend;
    const known = new Map<string, BackendKind>(this.owners);
    for (const b of this.backends) { try { for (const t of await b.list()) known.set(t.id.toLowerCase(), t.backend); } catch {} }
    const parsed = input.magnet ? await parseTorrent(input.magnet) : input.torrentBase64 ? await parseTorrent(Buffer.from(input.torrentBase64, "base64")) : null;
    const hash = parsed?.infoHash.toLowerCase() || input.id?.toLowerCase();
    if (hash && known.has(hash)) return hash;
    const max = this.policy.settings.maxDownloads || 0;
    let active = 0;
    for (const b of this.backends) { try { active += (await b.list()).filter(t => !this.policy.queued.includes(t.id.toLowerCase()) && ["downloading", "metadata", "checking", "queued"].includes(t.state)).length; } catch {} }
    const autoQueue = max > 0 && active >= max;
    const id = await this.backend(kind).add(autoQueue ? { ...input, paused: true } : input);
    const existingKind = known.get(id.toLowerCase());
    if (existingKind) {
      if (existingKind !== kind) { try { await this.backend(kind).remove(id); } catch {} }
      return id;
    }
    const previous = this.owners.get(id.toLowerCase());
    if (previous && previous !== kind) { try { await this.backend(kind).remove(id); } catch {} throw new Error(`Torrent ${id} is already owned by ${previous}`); }
    this.owners.set(id.toLowerCase(), kind);
    if (autoQueue && !input.paused) { this.policy.queued.push(id.toLowerCase()); await this.savePolicy(); }
    await this.saveOwners();
    await this.updateHistory(() => {
      if (this.history.some(x => x.id === id.toLowerCase() && x.backend === kind && !x.removedAt)) return false;
      this.history.push({ id: id.toLowerCase(), backend: kind, name: input.name || parsed?.name || id, savePath: input.savePath, addedAt: Date.now() }); return true;
    });
    return id;
  }); }
  private owner(id: string): TorrentBackend {
    const kind = this.owners.get(id.toLowerCase());
    if (kind) return this.backend(kind);
    throw new Error(`Torrent not found: ${id}`);
  }
  private async operation<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const old = this.operationLocks.get(key); if (old) await old.catch(() => {});
    const task = fn(); this.operationLocks.set(key, task);
    try { return await task; } finally { if (this.operationLocks.get(key) === task) this.operationLocks.delete(key); }
  }
  pause(id: string): Promise<void> { return this.operation(id, async () => { await this.owner(id).pause(id); this.policy.queued = this.policy.queued.filter(x => x !== id.toLowerCase()); await this.savePolicy(); }); }
  resume(id: string): Promise<void> { return this.operation(id, async () => {
    const key = id.toLowerCase();
    if (this.policySuspended) { await this.owner(id).resume(id); return; }
    const max = this.policy.settings.maxDownloads || 0;
    if (max > 0) {
      let active = 0;
      for (const b of this.backends) { try { active += (await b.list()).filter(t => t.id.toLowerCase() !== key && !this.policy.queued.includes(t.id.toLowerCase()) && ["downloading", "metadata", "checking", "queued"].includes(t.state)).length; } catch {} }
      if (active >= max) {
        if (!this.policy.queued.includes(key)) this.policy.queued.push(key);
        await this.owner(id).pause(id);
        await this.savePolicy();
        return;
      }
    }
    this.policy.queued = this.policy.queued.filter(x => x !== key);
    await this.owner(id).resume(id);
    await this.savePolicy();
  }); }
  async remove(id: string, deleteData = false): Promise<void> { await this.operation(id, async () => {
    const backend = this.owner(id); await backend.remove(id, deleteData);
    this.owners.delete(id.toLowerCase()); this.policy.queued = this.policy.queued.filter(x => x !== id.toLowerCase()); delete this.policy.completedAt[id.toLowerCase()];
    await Promise.all([this.saveOwners(), this.savePolicy(), this.updateHistory(() => { const record = this.history.findLast(x => x.id === id.toLowerCase() && x.backend === backend.kind && !x.removedAt); if (!record) return false; record.removedAt = Date.now(); return true; })]);
  }); }
  recheck(id: string): Promise<void> { return this.owner(id).recheck(id); }
  exportTorrent(id: string): Promise<Uint8Array> { return this.owner(id).exportTorrent(id); }
  details(id: string): Promise<TorrentDetails> { return this.owner(id).details(id); }
  pieces(id: string) { return this.owner(id).pieces(id); }
  async checkpoint(): Promise<void> { await Promise.all(this.backends.map(b => b.checkpoint())); await this.saveOwners(); await this.updateHistory(() => false); }
  async stop(): Promise<void> { await Promise.all(this.backends.map(async b => { try { await b.stop(); } catch (e) { const h = this.health.find(x => x.backend === b.kind); if (h) { h.available = false; h.message = this.error(e); } } })); }
  async pauseActive(): Promise<ActiveToken[]> {
    this.policySuspended = true;
    await this.policyLock.catch(() => {});
    const tokens: ActiveToken[] = [];
    for (const b of this.backends) for (const t of await b.list()) if (["downloading", "seeding", "queued", "checking", "metadata"].includes(t.state) && !this.policy.queued.includes(t.id.toLowerCase())) { await b.pause(t.id); tokens.push({ backend: b.kind, id: t.id }); }
    return tokens;
  }
  async activatePolicy(): Promise<void> { if (this.policySuspended) await this.resumeActive([]); }
  async resumeActive(tokens: ActiveToken[]): Promise<void> {
    for (const t of tokens) if (this.owners.get(t.id.toLowerCase()) === t.backend) await this.backend(t.backend).resume(t.id);
    this.policySuspended = false;
    const rows: TorrentSnapshot[] = [];
    for (const b of this.backends) { try { rows.push(...await b.list()); } catch {} }
    await this.applyPolicy(rows);
  }
  async applySettings(settings: Partial<BackendSettings>): Promise<Record<BackendKind, { restartRequired: string[] } | undefined>> {
    const result: Record<BackendKind, { restartRequired: string[] } | undefined> = { webtorrent: undefined, qbittorrent: undefined };
    this.policy.settings = { ...this.policy.settings, ...Object.fromEntries(Object.entries(settings).filter(([k]) => ["maxDownloads", "seedRatio", "seedTimeMinutes", "completionAction"].includes(k))) };
    await this.savePolicy();
    await Promise.all(this.backends.map(async b => {
      const supported: Partial<BackendSettings> = {};
      for (const k of b.capabilities.settings) if (k in settings && !( ["maxDownloads", "seedRatio", "seedTimeMinutes", "completionAction"].includes(k))) Object.assign(supported, { [k]: settings[k] });
      if (b.kind === "qbittorrent" && "maxDownloads" in settings && b.capabilities.settings.includes("maxDownloads")) supported.maxDownloads = 0;
      if (Object.keys(supported).length) result[b.kind] = await b.applySettings(supported);
    }));
    const rows: TorrentSnapshot[] = [];
    for (const b of this.backends) { try { rows.push(...await b.list()); } catch {} }
    await this.applyPolicy(rows);
    return result;
  }
}

export { PlusController as TorrentController };
