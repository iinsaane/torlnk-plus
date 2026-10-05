export type BackendKind = "webtorrent" | "qbittorrent";
export type TorrentState = "metadata" | "checking" | "queued" | "downloading" | "paused" | "seeding" | "completed" | "failed";
export type RouteMode = "direct" | "vpn";
export type RouteState = "Direct" | "Connecting" | "Protected" | "Switching" | "Blocked";
export type PieceState = "missing" | "active" | "verified" | "unknown";

export interface TorrentInput {
  magnet?: string;
  torrentBase64?: string;
  id?: string;
  name?: string;
  savePath: string;
  paused?: boolean;
  backend?: BackendKind;
}
export interface TrackerSnapshot { url: string; status?: string; message?: string }
export interface FileSnapshot { path: string; size: number; downloaded?: number; progress?: number; priority?: number }
export interface PieceSnapshot { states: PieceState[]; pieceLength: number; lastPieceLength: number }
export interface TorrentSnapshot {
  id: string;
  backend: BackendKind;
  name: string;
  state: TorrentState;
  progress: number;
  total: number;
  downloaded: number;
  uploaded: number;
  downloadSpeed: number;
  uploadSpeed: number;
  peers?: number;
  seeders?: number;
  etaSeconds?: number;
  ratio?: number;
  addedAt?: number;
  completedAt?: number;
  savePath: string;
  error?: string;
}
export interface TorrentDetails { torrent: TorrentSnapshot; files: FileSnapshot[]; trackers: TrackerSnapshot[]; availability?: number }
export interface BackendSettings {
  downloadLimitKiB: number;
  uploadLimitKiB: number;
  maxDownloads: number;
  maxConnections: number;
  dht: boolean;
  pex: boolean;
  utp: boolean;
  listenPort: number;
  seedRatio: number;
  seedTimeMinutes: number;
  completionAction: "seed" | "pause";
  trackers: string[];
}
export interface BackendCapabilities { settings: (keyof BackendSettings)[]; recheck: boolean; files: boolean; pieces: boolean; export: boolean }
export interface TorrentBackend {
  readonly kind: BackendKind;
  readonly capabilities: BackendCapabilities;
  start(): Promise<void>;
  list(): Promise<TorrentSnapshot[]>;
  add(input: TorrentInput): Promise<string>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  remove(id: string, deleteData?: boolean): Promise<void>;
  recheck(id: string): Promise<void>;
  exportTorrent(id: string): Promise<Uint8Array>;
  details(id: string): Promise<TorrentDetails>;
  pieces(id: string): Promise<PieceSnapshot | null>;
  applySettings(settings: Partial<BackendSettings>): Promise<{ restartRequired: string[] }>;
  checkpoint(): Promise<void>;
  stop(): Promise<void>;
}
export interface RouteStatus { mode: RouteMode; state: RouteState; profileId?: string; message?: string; publicIp?: string }
export interface BackendHealth { backend: BackendKind; available: boolean; message?: string }
export interface ServiceHealth { service: "supervisor" | "controller" | "gateway" | "search" | BackendKind; state: "healthy" | "starting" | "stopped" | "unavailable" | "blocked"; checkedAt: number; lastSuccessAt?: number; message?: string }
export interface ControllerSnapshot { torrents: TorrentSnapshot[]; backends: BackendHealth[]; route: RouteStatus }
export interface VpnProfileSummary { id: string; name: string; provider: "windscribe" | "custom"; protocol: "wireguard" | "openvpn" | "stealth"; endpoint: string; port: number }
