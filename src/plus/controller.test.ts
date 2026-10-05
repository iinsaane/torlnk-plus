import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BackendCapabilities, TorrentBackend, TorrentSnapshot } from "./contracts";
import { TorrentController } from "./controller";

const caps: BackendCapabilities = { settings: ["dht"], recheck: true, files: true, pieces: true, export: true };
function fake(kind: "webtorrent" | "qbittorrent", state: "downloading" | "paused" = "downloading"): TorrentBackend {
  const rows: TorrentSnapshot[] = [{ id: "a".repeat(40), backend: kind, name: "demo", state, progress: 0, total: 10, downloaded: 0, uploaded: 0, downloadSpeed: 0, uploadSpeed: 0, savePath: "/tmp" }];
  return { kind, capabilities: caps, start: vi.fn(async () => {}), list: vi.fn(async () => rows), add: vi.fn(async () => rows[0]!.id), pause: vi.fn(async id => { const row = rows.find(x => x.id === id); if (row) row.state = "paused"; }), resume: vi.fn(async id => { const row = rows.find(x => x.id === id); if (row) row.state = "downloading"; }), remove: vi.fn(async id => { const i = rows.findIndex(x => x.id === id); if (i >= 0) rows.splice(i, 1); }), recheck: vi.fn(async () => {}), exportTorrent: vi.fn(async () => new Uint8Array()), details: vi.fn(async () => ({ torrent: rows[0]!, files: [], trackers: [] })), pieces: vi.fn(async () => null), applySettings: vi.fn(async () => ({ restartRequired: [] })), checkpoint: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
}
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });
async function temp() { const d = await mkdtemp(path.join(os.tmpdir(), "plus-controller-")); dirs.push(d); return d; }

describe("TorrentController", () => {
  it("reconciles live backend records, deduplicates infohash and selectively applies capabilities", async () => {
    const stateDir = await temp(); const web = fake("webtorrent"); const qb = fake("qbittorrent");
    const c = new TorrentController([web, qb], { defaultBackend: "webtorrent", stateDir });
    const started = await c.start();
    expect(started.torrents).toHaveLength(1); expect(started.backends.every(x => x.available)).toBe(true);
    expect(await c.add({ magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`, savePath: "/tmp" })).toBe("a".repeat(40));
    expect(web.add).not.toHaveBeenCalled();
    await c.applySettings({ dht: false, seedRatio: 1 });
    expect(web.applySettings).toHaveBeenCalledWith({ dht: false });
    expect(await c.pauseActive()).toEqual([]);
  });
  it("reports an unavailable backend separately and does not prevent the other backend starting", async () => {
    const stateDir = await temp(); const good = fake("webtorrent"); const bad = fake("qbittorrent"); vi.mocked(bad.start).mockRejectedValue(new Error("connection refused"));
    vi.mocked(bad.list).mockRejectedValue(new Error("connection refused"));
    const c = new TorrentController([good, bad], { defaultBackend: "webtorrent", stateDir });
    const snapshot = await c.start();
    expect(snapshot.backends).toContainEqual({ backend: "qbittorrent", available: false, message: "connection refused" });
    expect(snapshot.torrents).toHaveLength(1);
  });
  it("enforces a shared download limit, releases its queued torrents, and persists policy", async () => {
    const stateDir = await temp(); const web = fake("webtorrent"); const qb = fake("qbittorrent");
    const current = (await web.list())[0]!; const other = { ...current, id: "b".repeat(40), backend: "qbittorrent" as const, state: "paused" as TorrentSnapshot["state"] };
    let present = false;
    vi.mocked(qb.list).mockImplementation(async () => present ? [other] : []);
    vi.mocked(qb.add).mockImplementation(async input => { present = true; other.state = input.paused ? "paused" : "downloading"; return other.id; });
    const c = new TorrentController([web, qb], { defaultBackend: "webtorrent", stateDir }); await c.start();
    await c.applySettings({ maxDownloads: 1, seedRatio: 2, seedTimeMinutes: 30, completionAction: "pause" });
    const id = await c.add({ id: "b".repeat(40), savePath: "/tmp", backend: "qbittorrent" });
    expect(id).toBe("b".repeat(40));
    expect(other.state).toBe("paused");
    current.progress = 1; current.state = "seeding"; current.ratio = 0;
    const snap = await c.snapshot();
    expect(snap.torrents.find(t => t.id === other.id)?.state).toBe("downloading");
    expect(current.state).toBe("paused");
    expect(JSON.parse(await readFile(path.join(stateDir, "policy.json"), "utf8"))).toMatchObject({ settings: { maxDownloads: 1, seedRatio: 2, seedTimeMinutes: 30, completionAction: "pause" }, queued: [] });
    const restarted = new TorrentController([web, qb], { defaultBackend: "webtorrent", stateDir }); await restarted.start();
    await restarted.applySettings({ dht: false });
    expect(JSON.parse(await readFile(path.join(stateDir, "policy.json"), "utf8")).settings).toMatchObject({ maxDownloads: 1, completionAction: "pause" });
  });
  it("does not auto-resume a manually paused torrent", async () => {
    const stateDir = await temp(); const web = fake("webtorrent"); const qb = fake("qbittorrent");
    const current = (await web.list())[0]!; const queued = { ...current, id: "b".repeat(40), backend: "qbittorrent" as const, state: "paused" as TorrentSnapshot["state"] };
    let present = false;
    vi.mocked(qb.list).mockImplementation(async () => present ? [queued] : []);
    vi.mocked(qb.add).mockImplementation(async () => { present = true; return queued.id; });
    const c = new TorrentController([web, qb], { defaultBackend: "webtorrent", stateDir }); await c.start();
    await c.applySettings({ maxDownloads: 1 }); await c.add({ id: queued.id, savePath: "/tmp", backend: "qbittorrent" });
    await c.pause(queued.id); current.state = "completed"; current.progress = 1;
    await c.snapshot();
    expect(qb.resume).not.toHaveBeenCalled();
  });
  it("counts metadata and checking work against the shared limit for new adds", async () => {
    const stateDir = await temp(); const web = fake("webtorrent"); const qb = fake("qbittorrent");
    const metadata = { ...(await web.list())[0]!, state: "metadata" as const };
    vi.mocked(web.list).mockResolvedValue([metadata]);
    let added = false; let addPaused: boolean | undefined;
    const queued = { ...metadata, id: "b".repeat(40), backend: "qbittorrent" as const, state: "paused" as TorrentSnapshot["state"] };
    vi.mocked(qb.list).mockImplementation(async () => added ? [queued] : []);
    vi.mocked(qb.add).mockImplementation(async input => { added = true; addPaused = input.paused; queued.state = input.paused ? "paused" : "downloading"; return queued.id; });
    const c = new TorrentController([web, qb], { defaultBackend: "webtorrent", stateDir }); await c.start();
    await c.applySettings({ maxDownloads: 1 });
    await c.add({ id: queued.id, savePath: "/tmp", backend: "qbittorrent" });
    expect(addPaused).toBe(true);
    expect(queued.state).toBe("paused");
  });
  it("queues surplus active transfers across backends when the limit is lowered", async () => {
    const stateDir = await temp(); const web = fake("webtorrent"); const qb = fake("qbittorrent");
    const a = { ...(await web.list())[0]!, state: "downloading" as const };
    const b = { ...(await qb.list())[0]!, id: "b".repeat(40), backend: "qbittorrent" as const, state: "checking" as const };
    vi.mocked(web.list).mockResolvedValue([a]); vi.mocked(qb.list).mockResolvedValue([b]);
    const c = new TorrentController([web, qb], { defaultBackend: "webtorrent", stateDir }); await c.start();
    await c.applySettings({ maxDownloads: 1 });
    const snapshot = await c.snapshot();
    expect(snapshot.torrents.filter(t => ["downloading", "metadata", "checking"].includes(t.state))).toHaveLength(1);
    expect(snapshot.torrents.some(t => t.state === "queued")).toBe(true);
    expect(JSON.parse(await readFile(path.join(stateDir, "policy.json"), "utf8")).queued).toContain(a.id);
  });
  it("queues an explicit resume at capacity, then releases it when a slot opens", async () => {
    const stateDir = await temp(); const web = fake("webtorrent"); const qb = fake("qbittorrent");
    const active = (await web.list())[0]!; const manual = { ...active, id: "b".repeat(40), backend: "qbittorrent" as const, state: "paused" as const };
    vi.mocked(web.list).mockResolvedValue([active]); vi.mocked(qb.list).mockResolvedValue([manual]);
    const c = new TorrentController([web, qb], { defaultBackend: "webtorrent", stateDir }); await c.start();
    await c.applySettings({ maxDownloads: 1 });
    await c.resume(manual.id);
    expect(qb.resume).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(path.join(stateDir, "policy.json"), "utf8")).queued).toContain(manual.id);
    active.state = "completed"; active.progress = 1;
    await c.snapshot();
    expect(qb.resume).toHaveBeenCalledWith(manual.id);
  });
  it("leaves queued transfers paused while policy is suspended", async () => {
    const stateDir = await temp(); const web = fake("webtorrent"); const qb = fake("qbittorrent");
    const active = (await web.list())[0]!; const queued = { ...active, id: "b".repeat(40), backend: "qbittorrent" as const, state: "paused" as const };
    vi.mocked(web.list).mockResolvedValue([active]); vi.mocked(qb.list).mockResolvedValue([queued]);
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "policy.json"), JSON.stringify({ settings: { maxDownloads: 1 }, queued: [queued.id], completedAt: {} }));
    const c = new TorrentController([web, qb], { defaultBackend: "webtorrent", stateDir, suspended: true }); await c.start();
    expect(qb.resume).not.toHaveBeenCalled();
    expect(queued.state).toBe("paused");
  });
  it("reconciles ownership after a backend recovers from an outage", async () => {
    const stateDir = await temp(); const web = fake("webtorrent"); const qb = fake("qbittorrent");
    const recovered = { ...(await qb.list())[0]!, id: "b".repeat(40), backend: "qbittorrent" as const };
    vi.mocked(qb.start).mockRejectedValueOnce(new Error("temporarily offline"));
    vi.mocked(qb.list).mockRejectedValueOnce(new Error("temporarily offline")).mockResolvedValue([recovered]);
    const c = new TorrentController([web, qb], { defaultBackend: "webtorrent", stateDir }); await c.start();
    expect((await c.snapshot()).backends.find(x => x.backend === "qbittorrent")?.available).toBe(true);
    await c.pause(recovered.id);
    expect(qb.pause).toHaveBeenCalledWith(recovered.id);
  });
});


describe("controller download history", () => {
  it("retains completion and removal through restart, and creates a new generation on re-add", async () => {
    const stateDir = await temp(); const qb = fake("qbittorrent"); const row = (await qb.list())[0]!;
    let present = false;
    vi.mocked(qb.list).mockImplementation(async () => present ? [row] : []);
    vi.mocked(qb.add).mockImplementation(async () => { present = true; row.progress = 0; row.state = "downloading"; row.completedAt = undefined; return row.id; });
    vi.mocked(qb.remove).mockImplementation(async () => { present = false; });
    const historyPath = path.join(stateDir, "history.json");
    const history = async () => JSON.parse(await readFile(historyPath, "utf8"));
    const c = new TorrentController([qb], { defaultBackend: "qbittorrent", stateDir }); await c.start();
    await c.add({ id: row.id, name: row.name, savePath: row.savePath });
    expect((await stat(historyPath)).mode & 0o777).toBe(0o600);
    row.progress = 1; row.state = "seeding"; await c.snapshot();
    const completed = (await history())[0];
    expect(completed).toMatchObject({ id: row.id, backend: "qbittorrent", name: "demo", savePath: "/tmp" });
    expect(completed.completedAt).toBeGreaterThan(0);
    const restarted = new TorrentController([qb], { defaultBackend: "qbittorrent", stateDir }); await restarted.start();
    expect(await history()).toEqual([completed]);
    await restarted.remove(row.id, false);
    const removed = (await history())[0]; expect(removed.removedAt).toBeGreaterThan(0); expect(removed.completedAt).toBe(completed.completedAt);
    await restarted.add({ id: row.id, name: row.name, savePath: row.savePath });
    const records = await history(); expect(records).toHaveLength(2); expect(records[0]).toEqual(removed); expect(records[1].removedAt).toBeUndefined(); expect(records[1].completedAt).toBeUndefined();
  });
  it("does not recreate removed history from a stale backend snapshot", async () => {
    const stateDir = await temp(); const web = fake("webtorrent"); const row = (await web.list())[0]!;
    const c = new TorrentController([web], { defaultBackend: "webtorrent", stateDir }); await c.start();
    await c.remove(row.id);
    vi.mocked(web.list).mockResolvedValue([row]); await c.snapshot();
    const records = JSON.parse(await readFile(path.join(stateDir, "history.json"), "utf8"));
    expect(records).toHaveLength(1); expect(records[0].removedAt).toBeGreaterThan(0);
  });
  it("bounds persisted history to the latest 1000 records", async () => {
    const stateDir = await temp(); const historyPath = path.join(stateDir, "history.json");
    const old = Array.from({ length: 1001 }, (_, i) => ({ id: i.toString(16).padStart(40, "0"), backend: "webtorrent", name: "old", savePath: "/tmp", addedAt: i + 1, removedAt: i + 2 }));
    await writeFile(historyPath, JSON.stringify(old));
    const web = fake("webtorrent"); const c = new TorrentController([web], { defaultBackend: "webtorrent", stateDir }); await c.start();
    const records = JSON.parse(await readFile(historyPath, "utf8"));
    expect(records).toHaveLength(1000); expect(records[0].id).toBe(old[2]!.id); expect(records.at(-1).id).toBe("a".repeat(40));
    expect((await stat(historyPath)).mode & 0o777).toBe(0o600);
  });
});


it("retries a failed history save without losing the observed completion", async () => {
  const stateDir = await temp(); const web = fake("webtorrent"); const row = (await web.list())[0]!;
  const historyPath = path.join(stateDir, "history.json");
  const c = new TorrentController([web], { defaultBackend: "webtorrent", stateDir }); await c.start();
  await rm(historyPath); await mkdir(historyPath);
  row.progress = 1; row.state = "seeding";
  await expect(c.snapshot()).rejects.toThrow();
  await rm(historyPath, { recursive: true }); await c.checkpoint();
  const records = JSON.parse(await readFile(historyPath, "utf8"));
  expect(records).toHaveLength(1); expect(records[0].completedAt).toBeGreaterThan(0);
});


it("persists policy when settings saves overlap snapshot polling", async () => {
  const stateDir = await temp(); const web = fake("webtorrent");
  const c = new TorrentController([web], { defaultBackend: "webtorrent", stateDir }); await c.start();
  await Promise.all(Array.from({ length: 10 }, (_, i) => i % 2 ? c.snapshot() : c.applySettings({ maxDownloads: 3 })));
  const policyPath = path.join(stateDir, "policy.json");
  expect(JSON.parse(await readFile(policyPath, "utf8")).settings.maxDownloads).toBe(3);
  expect((await stat(policyPath)).mode & 0o777).toBe(0o600);
});
