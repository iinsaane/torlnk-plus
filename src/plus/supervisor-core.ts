import { promises as fs } from "node:fs";
import path from "node:path";
import { JsonClient } from "./http";
import { defaultPlusConfig, loadPlusConfig, savePlusConfig, type PlusConfig } from "./config";
import { DockerRuntime } from "./vpn/runtime";
import { importVpnProfile, listProfiles, removeProfile, type ImportProfileOptions } from "./vpn/profiles";
import type { ActiveToken } from "./controller";
import type { ControllerSnapshot, RouteStatus, RouteMode, BackendCapabilities, BackendKind, ServiceHealth } from "./contracts";

export interface Credentials { token: string; workerToken: string; qbitPassword: string }
export class Supervisor {
  private runtime?: DockerRuntime;
  private worker?: JsonClient;
  private switching?: Promise<void>;
  private route: RouteStatus = { mode: "vpn", state: "Blocked", message: "Choose VPN or direct mode in Settings" };
  private monitor?: ReturnType<typeof setInterval>;
  private monitoring = false;
  private lastSuccess = new Map<string, number>();
  constructor(readonly projectDir: string, readonly stateDir: string, readonly credentials: Credentials) {}
  private async writeRoute(route: RouteStatus) {
    this.route = route;
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const target = path.join(this.stateDir, "network-status.json");
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(route), { mode: 0o600 }); await fs.rename(tmp, target);
    await fs.mkdir(path.join(this.stateDir, "public"), { recursive: true, mode: 0o700 });
    const shared = path.join(this.stateDir, "public", "network-status.json"); const sharedTmp = `${shared}.${process.pid}.tmp`;
    await fs.writeFile(sharedTmp, JSON.stringify(route), { mode: 0o600 }); await fs.rename(sharedTmp, shared);
  }
  async start() {
    const config = await loadPlusConfig(this.stateDir);
    if (config.network.mode) await this.setRouting(config.network.mode, config.network.profileId).catch(() => {});
    this.monitor = setInterval(() => void this.checkHealth(), 2000);
    this.monitor.unref();
  }
  private async checkHealth() {
    if (this.switching || !this.runtime || this.monitoring) return;
    this.monitoring = true;
    try {
      const live = await this.runtime.status();
      await this.writeRoute({ ...live, mode: this.route.mode, profileId: this.route.profileId });
      const snapshot = await this.worker?.request<ControllerSnapshot>("/snapshot");
      if (snapshot && snapshot.backends.some(b => !b.available)) this.route.message = "A torrent backend is unavailable; other transfers may continue";
    } catch { await this.writeRoute({ ...this.route, state: "Blocked", message: "Service or tunnel unavailable; retry the connection" }); }
    finally { this.monitoring = false; }
  }
  async state(): Promise<{ config: PlusConfig; profiles: Awaited<ReturnType<typeof listProfiles>>; snapshot: ControllerSnapshot; capabilities: Partial<Record<BackendKind, BackendCapabilities>>; services: ServiceHealth[] }> {
    let snapshot: ControllerSnapshot = { torrents: [], backends: [{ backend: "qbittorrent", available: false }, { backend: "webtorrent", available: false }], route: this.route };
    let capabilities = {}; let workerResponded = false; let searchAvailable = false;
    if (this.worker) {
      try { snapshot = await this.worker.request<ControllerSnapshot>("/snapshot"); capabilities = await this.worker.request("/capabilities"); workerResponded = true; searchAvailable = (await this.worker.request<{ available: boolean }>("/searchHealth")).available; }
      catch { snapshot = { ...snapshot, torrents: snapshot.torrents, backends: snapshot.backends.map(b => ({ ...b, available: false })), route: { ...this.route, state: "Blocked", message: this.switching ? "Switching routing" : "Background worker unavailable" } }; }
    }
    if (!this.worker || snapshot.backends.some(b => b.available)) snapshot.route = { ...this.route };
    const now = Date.now();
    const health = (service: ServiceHealth['service'], state: ServiceHealth['state'], message?: string): ServiceHealth => {
      if (state === 'healthy') this.lastSuccess.set(service, now);
      return { service, state, checkedAt: now, lastSuccessAt: this.lastSuccess.get(service), message };
    };
    const services: ServiceHealth[] = [health('supervisor', 'healthy', 'Local management service responds'), health('controller', workerResponded ? 'healthy' : 'unavailable', workerResponded ? 'Controller responds' : 'Controller worker unavailable'), health('gateway', ['Protected', 'Direct'].includes(this.route.state) ? 'healthy' : this.route.state === 'Connecting' || this.route.state === 'Switching' ? 'starting' : 'blocked', this.route.message), health('search', !['Direct', 'Protected'].includes(snapshot.route.state) ? 'blocked' : searchAvailable ? 'healthy' : 'unavailable', 'Search worker shares the selected gateway network'), ...snapshot.backends.map(b => health(b.backend, b.available ? 'healthy' : 'unavailable', b.message))];
    return { services, config: await loadPlusConfig(this.stateDir), profiles: await listProfiles(path.join(this.stateDir, "profiles")), snapshot, capabilities };
  }
  async setRouting(mode: RouteMode, profileId?: string): Promise<void> {
    if (mode !== "direct" && mode !== "vpn") throw new Error("Choose direct or vpn routing");
    if (this.switching) throw new Error("A routing change is already in progress");
    this.switching = this.transition(mode, profileId);
    try { await this.switching; } finally { this.switching = undefined; }
  }
  private async transition(mode: RouteMode, profileId?: string) {
    const config = await loadPlusConfig(this.stateDir);
    profileId ??= config.network.profileId;
    const profiles = await listProfiles(path.join(this.stateDir, "profiles"));
    const profile = mode === "vpn" ? profiles.find(p => p.id === profileId) : undefined;
    if (mode === "vpn" && !profile) throw new Error("Select an imported VPN profile");
    await this.writeRoute({ mode, state: "Switching", profileId, message: "Pausing workers and changing their network" });
    const transitionPath = path.join(this.stateDir, "transition.json");
    let tokens: ActiveToken[] = [];
    try { tokens = JSON.parse(await fs.readFile(transitionPath, "utf8")).tokens ?? []; } catch {}
    try {
      if (this.worker) {
        try { tokens = await this.worker.request<ActiveToken[]>("/command", { action: "pauseActive" }); await fs.writeFile(transitionPath, JSON.stringify({ mode, profileId, tokens }), { mode: 0o600 }); await this.worker.request("/command", { action: "checkpoint" }); }
        catch { await this.runtime?.stop(); throw new Error("Could not checkpoint transfers; workers stopped. Retry the routing change."); }
      }
      await fs.writeFile(transitionPath, JSON.stringify({ mode, profileId, tokens }), { mode: 0o600 });
      config.network = { ...config.network, mode, profileId };
      await savePlusConfig(this.stateDir, config);
      if (this.runtime) await this.runtime.stop();
      this.worker = undefined;
      this.runtime = new DockerRuntime({ projectDir: this.projectDir, stateDir: this.stateDir, downloadDirs: [config.downloadDir, ...config.extraDownloadDirs], workerToken: this.credentials.workerToken, qbitPassword: this.credentials.qbitPassword, forwardedPort: config.network.forwardedPort, workerPort: Number(process.env.TORLNK_PLUS_WORKER_PORT ?? 9162), qbitPort: Number(process.env.TORLNK_PLUS_QBIT_PORT ?? 8080) });
      await this.writeRoute({ mode, state: "Connecting", profileId, message: "Starting managed services" });
      const route = await this.runtime.start(mode, profile);
      if (mode === "vpn" && route.state !== "Protected") throw new Error("VPN tunnel is not ready; traffic remains blocked");
      await this.writeRoute(route);
      const worker = new JsonClient(this.runtime.getEndpoints().controller, this.credentials.workerToken, 5000);
      let ready = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        try { const state = await worker.request<ControllerSnapshot>("/snapshot"); if (state.backends.every(b => b.available)) { ready = true; break; } }
        catch {}
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!ready) throw new Error("Torrent backends did not become ready. Check the service logs and retry.");
      this.worker = new JsonClient(this.runtime.getEndpoints().controller, this.credentials.workerToken, Math.max(30000, config.searchTimeoutMs + 5000));
      await worker.request("/command", { action: "applySettings", settings: { ...config.backendSettings, ...(config.network.forwardedPort ? { listenPort: config.network.forwardedPort } : {}) } });
      await worker.request("/command", { action: "resumeActive", tokens });
      await fs.rm(transitionPath, { force: true });
    } catch (err) {
      await this.runtime?.stop().catch(() => {}); this.worker = undefined;
      await this.writeRoute({ mode, state: "Blocked", profileId, message: err instanceof Error ? err.message : "Routing change failed" });
      throw err;
    }
  }
  async saveConfig(config: PlusConfig) {
    const before = await loadPlusConfig(this.stateDir);
    await savePlusConfig(this.stateDir, config);
    await savePlusConfig(path.join(this.stateDir, "public"), config);
    const networkChanged = JSON.stringify(before.network) !== JSON.stringify(config.network);
    const workerRestart = ["dht", "pex", "utp", "listenPort", "maxConnections", "trackers"].some(key => JSON.stringify(before.backendSettings[key as keyof typeof before.backendSettings]) !== JSON.stringify(config.backendSettings[key as keyof typeof config.backendSettings]));
    const mountsChanged = before.downloadDir !== config.downloadDir || JSON.stringify(before.extraDownloadDirs) !== JSON.stringify(config.extraDownloadDirs);
    if (config.network.mode && (networkChanged || mountsChanged || workerRestart || !this.worker)) await this.setRouting(config.network.mode, config.network.profileId);
    else if (this.worker) return this.worker.request("/command", { action: "applySettings", settings: config.backendSettings });
  }
  async importProfile(sourcePath: string, options?: ImportProfileOptions) { return importVpnProfile(sourcePath, path.join(this.stateDir, "profiles"), options); }
  async removeProfile(id: string) {
    const config = await loadPlusConfig(this.stateDir);
    if (config.network.profileId === id && config.network.mode === "vpn") throw new Error("Switch to direct mode or another profile before removing the active profile");
    await removeProfile(id, path.join(this.stateDir, "profiles"));
  }
  async command(body: Record<string, unknown>) {
    if (!this.worker || this.switching) throw new Error(this.route.message ?? "Background service unavailable");
    return this.worker.request("/command", body);
  }
  async search(query: string) {
    if (!this.worker || this.switching || !["Direct", "Protected"].includes(this.route.state)) throw new Error("Search is blocked until routing is ready");
    return this.worker.request("/search", { query });
  }
  async stop() {
    if (this.monitor) clearInterval(this.monitor);
    if (this.switching) await this.switching.catch(() => {});
    await this.worker?.request("/command", { action: "checkpoint" }).catch(() => {});
    await this.runtime?.stop(); this.worker = undefined;
    await this.writeRoute({ ...this.route, state: "Blocked", message: "Background service stopped" });
  }
}
