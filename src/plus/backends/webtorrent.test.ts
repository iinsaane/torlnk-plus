import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const fake = vi.hoisted(() => ({ clients: [] as unknown[] }));
vi.mock("webtorrent", async () => {
  const { EventEmitter } = await import("node:events");
  class TorrentFake extends EventEmitter {
    infoHash = "a".repeat(40); name = "waiting for metadata"; ready = false; length = 0; downloaded = 0; uploaded = 0; downloadSpeed = 0; uploadSpeed = 0; progress = 0; numPeers = 0; timeRemaining = Infinity; done = false; paused = false; path = "/tmp"; files: never[] = []; torrentFile = new Uint8Array([100,101]); metadata: Uint8Array | null = null;
    pause() { this.paused = true; } resume() { this.paused = false; } addPeer() { return false; } destroy(cb?: (err?: Error) => void) { cb?.(); }
  }
  class ClientFake extends EventEmitter {
    torrents: TorrentFake[] = []; addOptions: unknown[] = []; removeOptions: unknown[] = []; constructor() { super(); fake.clients.push(this); }
    add(_source: unknown, opts: unknown) { const t = new TorrentFake(); t.paused = !!(opts as { paused?: boolean }).paused; this.torrents.push(t); this.addOptions.push(opts); return t; }
    get() { return null; } remove(_id: string, opts: unknown, cb?: (err?: Error) => void) { this.removeOptions.push(opts); cb?.(); }
    destroy(cb?: (err?: Error) => void) { cb?.(); }
  }
  return { default: ClientFake };
});
import { WebTorrentBackend } from "./webtorrent";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); fake.clients.length = 0; });

describe("WebTorrentBackend", () => {
  it("returns for a parsed magnet before peers or metadata arrive and checkpoints its source", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "plus-webtorrent-")); dirs.push(stateDir);
    const backend = new WebTorrentBackend(stateDir);
    await backend.start();
    const id = await backend.add({ magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`, savePath: "/tmp/downloads" });
    expect(id).toBe("a".repeat(40));
    expect((await backend.list())[0]?.state).toBe("metadata");
    await expect(backend.exportTorrent(id)).rejects.toThrow("metadata");
    await backend.checkpoint();
    const manifest = JSON.parse(await readFile(path.join(stateDir, "manifest.json"), "utf8"));
    expect(manifest.torrents[0]).toMatchObject({ id, source: `magnet:?xt=urn:btih:${"a".repeat(40)}`, savePath: "/tmp/downloads", paused: false });
    await backend.stop();
  });

  it("rechecks through native restore while retaining an explicit pause", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "plus-webtorrent-recheck-")); dirs.push(stateDir);
    const backend = new WebTorrentBackend(stateDir);
    await backend.start();
    const id = await backend.add({ magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`, savePath: "/tmp/downloads" });
    await backend.pause(id);
    await backend.recheck(id);
    expect(backend.capabilities.recheck).toBe(true);
    expect((await backend.list())[0]?.state).toBe("paused");
    const client = fake.clients[0] as { addOptions: { paused: boolean }[]; removeOptions: { destroyStore: boolean }[] };
    expect(client.addOptions.at(-1)?.paused).toBe(true);
    expect(client.removeOptions.at(-1)).toEqual({ destroyStore: false });
  });
  it("restores a manually paused metadata-less magnet and lifetime upload totals", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "plus-webtorrent-pause-")); dirs.push(stateDir);
    const backend = new WebTorrentBackend(stateDir); await backend.start();
    const id = await backend.add({ magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`, savePath: "/tmp/downloads", paused: true });
    const client = fake.clients[0] as { torrents: { uploaded: number }[] };
    client.torrents[0]!.uploaded = 500;
    await backend.stop();
    const restored = new WebTorrentBackend(stateDir); await restored.start();
    expect((await restored.list())[0]).toMatchObject({ state: "paused", uploaded: 500 });
    const next = fake.clients[1] as { torrents: { uploaded: number }[] };
    next.torrents[0]!.uploaded = 100;
    expect((await restored.list())[0]?.uploaded).toBe(600);
    await restored.stop();
  });

  it("marks only live reservations active after requests finish or are cancelled", async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), "plus-webtorrent-pieces-")); dirs.push(stateDir);
    const backend = new WebTorrentBackend(stateDir); await backend.start();
    const id = await backend.add({ magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`, savePath: "/tmp/downloads" });
    const client=fake.clients[0] as {torrents: object[]};
    Object.assign(client.torrents[0]!,{pieces:[{},{},{}],pieceLength:16,length:40,bitfield:{get:(i:number)=>i===2},_reservations:[[null],[null,{}],[{}]]});
    expect(await backend.pieces(id)).toEqual({states:["missing","active","verified"],pieceLength:16,lastPieceLength:8});
    await backend.stop();
  });

});
