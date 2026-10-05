import type {
  BackendCapabilities, BackendSettings, FileSnapshot, PieceSnapshot, TorrentBackend,
  TorrentDetails, TorrentInput, TorrentSnapshot, TorrentState, TrackerSnapshot,
} from "../contracts.js";
import parseTorrent from "parse-torrent";

export interface QbittorrentOptions {
  baseUrl: string;
  username: string;
  password: string;
  fetch?: typeof fetch;
}

type QbTorrent = Record<string, unknown> & { hash: string; name?: string; state?: string };
type QbPrefs = Record<string, unknown>;
const capabilities: BackendCapabilities = {
  settings: ["downloadLimitKiB", "uploadLimitKiB", "maxDownloads", "maxConnections", "dht", "pex", "utp", "listenPort", "seedRatio", "seedTimeMinutes", "trackers"],
  recheck: true, files: true, pieces: true, export: true,
};

const str = (v: unknown, fallback = "") => typeof v === "string" ? v : fallback;
const num = (v: unknown, fallback = 0) => typeof v === "number" && Number.isFinite(v) ? v : fallback;
const stateOf = (raw: QbTorrent): TorrentState => {
  const s = str(raw.state).toLowerCase();
  if (s.includes("error") || s === "missingfiles") return "failed";
  if (s.startsWith("meta")) return "metadata";
  if (s.includes("check") || s === "allocating" || s === "moving") return "checking";
  if (s.endsWith("up") && !s.startsWith("paused") && !s.startsWith("stopped") && !s.startsWith("queued")) return "seeding";
  if (s.startsWith("queued") || s.startsWith("stalled") || s === "unknown") return "queued";
  if (s.startsWith("paused") || s.startsWith("stopped")) return num(raw.progress) >= 1 ? "completed" : "paused";
  if (s.includes("upload")) return "seeding";
  if (num(raw.progress) >= 1) return "completed";
  return "downloading";
};
const snapshot = (t: QbTorrent): TorrentSnapshot => {
  const progress = Math.max(0, Math.min(1, num(t.progress)));
  const completion = num(t.completion_on, -1);
  return {
    id: t.hash, backend: "qbittorrent", name: str(t.name, t.hash), state: stateOf(t), progress,
    total: num(t.size), downloaded: num(t.downloaded), uploaded: num(t.uploaded),
    downloadSpeed: num(t.dlspeed), uploadSpeed: num(t.upspeed), peers: num(t.num_leechs) + num(t.num_seeds),
    seeders: num(t.num_seeds), etaSeconds: num(t.eta, -1) >= 0 && num(t.eta) < 8640000 ? num(t.eta) : undefined,
    ratio: num(t.ratio), addedAt: num(t.added_on) > 0 ? num(t.added_on) * 1000 : undefined, completedAt: completion > 0 ? completion * 1000 : undefined,
    savePath: str(t.save_path), error: stateOf(t) === "failed" ? str(t.state) : undefined,
  };
};

export class QbittorrentBackend implements TorrentBackend {
  readonly kind = "qbittorrent" as const;
  readonly capabilities = capabilities;
  private readonly base: URL;
  private readonly fetcher: typeof fetch;
  private cookie?: string;
  private loginPromise?: Promise<void>;

  constructor(private readonly options: QbittorrentOptions) {
    this.base = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    this.fetcher = options.fetch ?? fetch;
  }

  private url(path: string): URL { return new URL(`api/v2/${path.replace(/^\//, "")}`, this.base); }
  private originHeaders(): { Referer: string; Origin: string } { return { Referer: this.base.href, Origin: this.base.origin }; }
  private async login(): Promise<void> {
    if (this.loginPromise) return this.loginPromise;
    const run = async () => {
      const body = new URLSearchParams({ username: this.options.username, password: this.options.password });
      let res: Response;
      try { res = await this.fetcher(this.url("auth/login"), { method: "POST", signal: AbortSignal.timeout(15000), headers: { ...this.originHeaders(), "Content-Type": "application/x-www-form-urlencoded" }, body }); }
      catch { throw new Error("Could not reach qBittorrent WebUI during login"); }
      if (!res.ok) throw new Error(`qBittorrent login failed (HTTP ${res.status})`);
      const text = (await res.text()).trim();
      const setCookie = res.headers.get("set-cookie") ?? "";
      const sid = setCookie.match(/(?:^|,\s*)((?:QBT_)?SID(?:_\d+)?=([^; ,]+))/i)?.[1];
      if (!(text === "Ok." || res.status === 204) || !sid) throw new Error(text === "Fails." ? "qBittorrent login rejected credentials" : "qBittorrent login response did not include a SID cookie");
      this.cookie = sid;
    };
    this.loginPromise = run();
    try { await this.loginPromise; } finally { this.loginPromise = undefined; }
  }

  private async request(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
    if (!this.cookie) await this.login();
    const headers = new Headers(this.originHeaders());
    new Headers(init.headers).forEach((v, k) => headers.set(k, v));
    if (this.cookie) headers.set("Cookie", this.cookie);
    let res: Response;
    const sentCookie = this.cookie;
    try { res = await this.fetcher(this.url(path), { ...init, signal: init.signal ?? AbortSignal.timeout(15000), headers }); }
    catch { throw new Error(`Could not reach qBittorrent WebUI at ${this.base.origin}`); }
    // qBittorrent signals an expired session as HTTP 401/403 or the plain text Not Ok response.
    if (retry && (res.status === 401 || res.status === 403 || (res.ok && (await res.clone().text()).trim() === "Fails."))) {
      if (this.cookie === sentCookie) this.cookie = undefined;
      await this.login();
      return this.request(path, init, false);
    }
    if (!res.ok) throw new Error(`qBittorrent API ${path} failed (HTTP ${res.status})`);
    if (!path.includes("/export") && res.headers.get("content-type")?.includes("text/plain") && (await res.clone().text()).trim() === "Fails.") throw new Error(`qBittorrent API ${path} returned a failure response`);
    return res;
  }
  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.request(path, init);
    try { return await res.json() as T; }
    catch { throw new Error(`qBittorrent API ${path} returned invalid JSON`); }
  }
  private async post(path: string, fields: Record<string, string | number | boolean>): Promise<void> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) body.set(k, String(v));
    const res = await this.request(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const text = (await res.text()).trim();
    if (text && text !== "Ok.") throw new Error(`qBittorrent API ${path} rejected the request`);
  }
  private async formPost(path: string, body: FormData): Promise<void> {
    const res = await this.request(path, { method: "POST", body });
    const text = (await res.text()).trim();
    if (text && text !== "Ok.") {
      let outcome: { success_count?: number; pending_count?: number; failure_count?: number };
      try { outcome = JSON.parse(text); } catch { throw new Error(`qBittorrent API ${path} rejected the request`); }
      if ((outcome.success_count ?? 0) + (outcome.pending_count ?? 0) < 1) throw new Error(`qBittorrent API ${path} reported a failed torrent import (success ${outcome.success_count ?? "unknown"}, pending ${outcome.pending_count ?? "unknown"}, failure ${outcome.failure_count ?? "unknown"})`);
    }
  }
  private async all(): Promise<QbTorrent[]> { return this.json<QbTorrent[]>("torrents/info"); }
  private async get(id: string): Promise<QbTorrent> {
    const item = (await this.json<QbTorrent[]>(`torrents/info?hashes=${encodeURIComponent(id)}`))[0];
    if (!item) throw new Error(`Torrent ${id} was not found in qBittorrent`);
    return item;
  }

  async start(): Promise<void> {
    await this.login();
    const version = (await this.request("app/version")).text();
    const [v, api] = await Promise.all([version, this.request("app/webapiVersion").then(r => r.text())]);
    const major = Number(v.trim().replace(/^v/i, "").split(".")[0]);
    if (!Number.isFinite(major) || major < 5) throw new Error(`qBittorrent 5.0+ required; server reports ${v.trim() || "an unknown version"}`);
    if (!/^\s*2\./.test(api)) throw new Error(`Unsupported qBittorrent Web API version: ${api.trim()}`);
    await this.all();
  }
  async list(): Promise<TorrentSnapshot[]> { return (await this.all()).map(snapshot); }
  async add(input: TorrentInput): Promise<string> {
    if (!input.magnet && !input.torrentBase64) throw new Error("Provide a magnet link or torrent file");
    let canonicalHash: string;
    try {
      if (input.magnet) canonicalHash = (await parseTorrent(input.magnet)).infoHash.toLowerCase();
      else {
        let bytes: Uint8Array;
        try { bytes = Uint8Array.from(atob(input.torrentBase64!), c => c.charCodeAt(0)); }
        catch { throw new Error("torrentBase64 is not valid base64"); }
        canonicalHash = (await parseTorrent(bytes)).infoHash.toLowerCase();
      }
    } catch (error) {
      if (error instanceof Error && error.message === "torrentBase64 is not valid base64") throw error;
      throw new Error("Could not parse torrent identifier or file");
    }
    if (input.id && input.id.toLowerCase() !== canonicalHash) throw new Error("Torrent ID does not match the supplied magnet or file");
    const form = new FormData();
    form.set("savepath", input.savePath);
    form.set("paused", String(Boolean(input.paused)));
    form.set("stopped", String(Boolean(input.paused)));
    if (input.name) form.set("rename", input.name);
    if (input.magnet) form.set("urls", input.magnet);
    if (input.torrentBase64) {
      let data: Uint8Array;
      try { data = Uint8Array.from(atob(input.torrentBase64), c => c.charCodeAt(0)); }
      catch { throw new Error("torrentBase64 is not valid base64"); }
      form.append("torrents", new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer], { type: "application/x-bittorrent" }), "upload.torrent");
    }
    await this.formPost("torrents/add", form);
    for (let i = 0; i < 50; i++) {
      const items = await this.all();
      const found = items.find(t => t.hash.toLowerCase() === canonicalHash);
      if (found) return found.hash;
      if (i < 49) await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("qBittorrent accepted the torrent but it did not appear in the torrent list");
  }
  async pause(id: string): Promise<void> { await this.post("torrents/stop", { hashes: id }); }
  async resume(id: string): Promise<void> { await this.post("torrents/start", { hashes: id }); }
  async remove(id: string, deleteData = false): Promise<void> { await this.post("torrents/delete", { hashes: id, deleteFiles: deleteData }); }
  async recheck(id: string): Promise<void> { await this.post("torrents/recheck", { hashes: id }); }
  async exportTorrent(id: string): Promise<Uint8Array> {
    const res = await this.request(`torrents/export?hash=${encodeURIComponent(id)}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  async details(id: string): Promise<TorrentDetails> {
    const [torrent, files, trackers, props] = await Promise.all([
      this.get(id), this.json<Record<string, unknown>[]>(`torrents/files?hash=${encodeURIComponent(id)}`),
      this.json<Record<string, unknown>[]>(`torrents/trackers?hash=${encodeURIComponent(id)}`),
      this.json<Record<string, unknown>>(`torrents/properties?hash=${encodeURIComponent(id)}`),
    ]);
    const mappedFiles: FileSnapshot[] = files.map(f => ({ path: str(f.name), size: num(f.size), downloaded: num(f.size) * num(f.progress), progress: num(f.progress), priority: num(f.priority) }));
    const normalized = snapshot(torrent);
    if (!normalized.completedAt && num(props.completion_date) > 0) normalized.completedAt = num(props.completion_date) * 1000;
    if (!normalized.savePath) normalized.savePath = str(props.save_path);
    return {
      torrent: normalized, files: mappedFiles,
      trackers: trackers.map(t => ({ url: str(t.url), status: typeof t.status === "number" ? ["disabled", "not contacted", "working", "updating", "not working"][t.status] ?? "unknown" : str(t.status) || "unknown", message: str(t.msg) || undefined })),
      availability: num(torrent.availability, -1) >= 0 ? num(torrent.availability) : undefined,
    };
  }
  async pieces(id: string): Promise<PieceSnapshot | null> {
    const [t, props, raw] = await Promise.all([
      this.get(id), this.json<Record<string, unknown>>(`torrents/properties?hash=${encodeURIComponent(id)}`),
      this.json<number[]>(`torrents/pieceStates?hash=${encodeURIComponent(id)}`),
    ]);
    const pieceLength = num(props.piece_size);
    if (pieceLength <= 0) return null;
    return { states: raw.map(s => s === 0 ? "missing" : s === 1 ? "active" : s === 2 ? "verified" : "unknown"), pieceLength, lastPieceLength: pieceLength > 0 ? num(t.size) % pieceLength || pieceLength : 0 };
  }
  async applySettings(settings: Partial<BackendSettings>): Promise<{ restartRequired: string[] }> {
    const pref: QbPrefs = {};
    if (settings.downloadLimitKiB !== undefined) await this.post("transfer/setDownloadLimit", { limit: settings.downloadLimitKiB * 1024 });
    if (settings.uploadLimitKiB !== undefined) await this.post("transfer/setUploadLimit", { limit: settings.uploadLimitKiB * 1024 });
    if (settings.maxDownloads !== undefined) Object.assign(pref, { queueing_enabled: true, max_active_downloads: settings.maxDownloads || -1, max_active_torrents: -1, max_active_uploads: -1 });
    if (settings.maxConnections !== undefined) pref.max_connec = settings.maxConnections;
    if (settings.dht !== undefined) pref.dht = settings.dht;
    if (settings.pex !== undefined) pref.pex = settings.pex;
    if (settings.utp !== undefined) pref.bittorrent_protocol = settings.utp ? 0 : 1;
    if (settings.listenPort !== undefined) pref.listen_port = settings.listenPort;
    if (settings.seedRatio !== undefined) Object.assign(pref, { max_ratio_enabled: settings.seedRatio > 0, max_ratio: settings.seedRatio || -1, max_ratio_act: 0 });
    if (settings.seedTimeMinutes !== undefined) Object.assign(pref, { max_seeding_time_enabled: settings.seedTimeMinutes > 0, max_seeding_time: settings.seedTimeMinutes || -1 });
    if (settings.trackers !== undefined) {
      Object.assign(pref, { add_trackers_enabled: settings.trackers.length > 0, add_trackers: settings.trackers.join("\n") });
      const current = await this.all();
      for (const t of current) if (settings.trackers.length) await this.post("torrents/addTrackers", { hash: t.hash, urls: settings.trackers.join("\n") });
    }
    if (Object.keys(pref).length) {
      await this.post("app/setPreferences", { json: JSON.stringify(pref) });
    }
    return { restartRequired: [] };
  }
  async checkpoint(): Promise<void> { /* qBittorrent persists its own state; do not shut down the shared daemon. */ }
  async stop(): Promise<void> { this.cookie = undefined; }
}
