import { JsonClient } from "../http";
import type { BackendKind, BackendCapabilities, TorrentBackend, TorrentInput, TorrentSnapshot, TorrentDetails, PieceSnapshot, BackendSettings } from "../contracts";
export class RpcBackend implements TorrentBackend {
  readonly kind: BackendKind = "webtorrent";
  capabilities: BackendCapabilities = { settings: [], recheck: true, files: true, pieces: true, export: true };
  private client: JsonClient;
  constructor(baseUrl: string, token: string) { this.client = new JsonClient(baseUrl, token); }
  private call<T>(method: string, ...args: unknown[]): Promise<T> { return this.client.request<T>("/rpc", { method, args }); }
  async start() { this.capabilities = await this.call<BackendCapabilities>("capabilities"); }
  async list() { if (!this.capabilities.settings.length) await this.start(); return this.call<TorrentSnapshot[]>("list"); }
  add(input: TorrentInput) { return this.call<string>("add", input); }
  pause(id: string) { return this.call<void>("pause", id); }
  resume(id: string) { return this.call<void>("resume", id); }
  remove(id: string, deleteData = false) { return this.call<void>("remove", id, deleteData); }
  recheck(id: string) { return this.call<void>("recheck", id); }
  async exportTorrent(id: string) { return Buffer.from(await this.call<string>("exportTorrent", id), "base64"); }
  details(id: string) { return this.call<TorrentDetails>("details", id); }
  pieces(id: string) { return this.call<PieceSnapshot | null>("pieces", id); }
  applySettings(settings: Partial<BackendSettings>) { return this.call<{ restartRequired: string[] }>("applySettings", settings); }
  checkpoint() { return this.call<void>("checkpoint"); }
  stop() { return this.call<void>("stop"); }
}
