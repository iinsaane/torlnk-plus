import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import createTorrent from "create-torrent";
import parseTorrent from "parse-torrent";
import WebTorrent from "webtorrent";
import { WebTorrentBackend } from "./webtorrent";

const timeoutMs = 25_000;
const dirs: string[] = [];
const clients: WebTorrent[] = [];
const backends: WebTorrentBackend[] = [];
const waitFor = async (condition: () => boolean, description: string) => {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
};
const client = () => {
  const c = new WebTorrent({ dht: false, tracker: false, lsd: false, utp: false, torrentPort: 0 } as never);
  clients.push(c);
  return c;
};
const seedFile = (c: WebTorrent, filePath: string) => new Promise<any>((resolve, reject) => {
  c.seed(filePath, { announce: [] }, (torrent: any) => resolve(torrent)).on("error", reject);
});
const makeTorrent = (filePath: string) => new Promise<Buffer>((resolve, reject) => {
  createTorrent(filePath, { announce: [], pieceLength: 16 * 1024 }, (err, torrent) => err ? reject(err) : resolve(Buffer.from(torrent)));
});

afterEach(async () => {
  await Promise.all(backends.splice(0).map(b => b.stop().catch(() => {})));
  await Promise.all(clients.splice(0).filter(c => !(c as any).destroyed).map(c => new Promise<void>(resolve => c.destroy(() => resolve()))));
  await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
});

describe("WebTorrentBackend real local transfers", () => {
  it("downloads verified pieces from a local seed and preserves the imported torrent metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plus-wt-transfer-")); dirs.push(root);
    const source = path.join(root, "source.bin");
    const bytes = Buffer.alloc(256 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 73 + (i >>> 3) * 19) & 255;
    await writeFile(source, bytes);
    const torrentBytes = await makeTorrent(source);
    const parsed: any = await parseTorrent(torrentBytes);
    const seeder = client();
    const seed = await seedFile(seeder, source);
    await waitFor(() => seed.ready && seeder.torrentPort > 0, "seed listen socket");

    const stateDir = path.join(root, "state");
    let backendClient: WebTorrent | undefined;
    const backend = new WebTorrentBackend(stateDir, opts => {
      backendClient = new WebTorrent({ ...opts, dht: false, tracker: false, lsd: false, utp: false, torrentPort: 0 } as never);
      clients.push(backendClient);
      return backendClient;
    });
    backends.push(backend);
    await backend.start();
    const id = await backend.add({ torrentBase64: torrentBytes.toString("base64"), savePath: path.join(root, "download") });
    expect(id).toBe(parsed.infoHash.toLowerCase());
    const active = backendClient!.torrents[0] as any;
    active.addPeer(`127.0.0.1:${seeder.torrentPort}`);
    await waitFor(() => active.done, "all transferred pieces to pass their hashes");

    const output = await readFile(path.join(root, "download", path.basename(source)));
    expect(createHash("sha256").update(output).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
    const exported = Buffer.from(await backend.exportTorrent(id));
    expect((await parseTorrent(exported)).infoHash).toBe(parsed.infoHash);
    const exportedMeta: any = await parseTorrent(exported);
    expect(exportedMeta).toMatchObject({ infoHash: parsed.infoHash, name: parsed.name, length: parsed.length, pieceLength: parsed.pieceLength });
    expect(exportedMeta.files?.map((file: {path: string; length: number}) => [file.path, file.length])).toEqual(parsed.files?.map((file: {path: string; length: number}) => [file.path, file.length]));
    expect((await backend.pieces(id))?.states.every(state => state === "verified")).toBe(true);
  }, 30_000);

  it("accepts a magnet without peers or metadata and returns before discovery", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plus-wt-no-peers-")); dirs.push(root);
    let backendClient: WebTorrent | undefined;
    const backend = new WebTorrentBackend(path.join(root, "state"), opts => {
      backendClient = new WebTorrent({ ...opts, dht: false, tracker: false, lsd: false, utp: false, torrentPort: 0 } as never);
      clients.push(backendClient);
      return backendClient;
    });
    backends.push(backend);
    await backend.start();
    const id = await backend.add({ magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`, savePath: path.join(root, "download") });
    expect(id).toBe("a".repeat(40));
    expect((await backend.list())[0]?.state).toBe("metadata");
    expect(backendClient!.torrents[0]?.ready).toBe(false);
  }, 30_000);

  it("keeps a paused partial transfer stopped across restart, resumes it, then rechecks and repairs a corrupted file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plus-wt-restart-")); dirs.push(root);
    const source = path.join(root, "restart.bin");
    const bytes = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 61 + (i >>> 5) * 23) & 255;
    await writeFile(source, bytes);
    const torrentBytes = await makeTorrent(source);
    const parsed: any = await parseTorrent(torrentBytes);
    const seeder = client();
    const seed = await seedFile(seeder, source);
    await waitFor(() => seed.ready && seeder.torrentPort > 0, "restart test seed listen socket");

    const stateDir = path.join(root, "state");
    const savePath = path.join(root, "download");
    const makeBackend = () => {
      let instance: WebTorrent | undefined;
      const backend = new WebTorrentBackend(stateDir, opts => {
        instance = new WebTorrent({ ...opts, dht: false, tracker: false, lsd: false, utp: false, torrentPort: 0 } as never);
        clients.push(instance);
        return instance;
      });
      backends.push(backend);
      return { backend, get client() { return instance!; } };
    };
    const first = makeBackend();
    await first.backend.start();
    await first.backend.applySettings({ downloadLimitKiB: 64 });
    const id = await first.backend.add({ torrentBase64: torrentBytes.toString("base64"), savePath });
    let downloading = first.client.torrents[0] as any;
    downloading.addPeer(`127.0.0.1:${seeder.torrentPort}`);
    await waitFor(() => downloading.downloaded >= 16 * 1024 && downloading.downloaded < bytes.length, "partial bytes before pause");
    await first.backend.pause(id);
    const pausedAt = downloading.downloaded;
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(downloading.downloaded).toBe(pausedAt);
    await first.backend.stop();

    const restored = makeBackend();
    // Regression guard: configuring a backend before start must not overwrite its queue manifest.
    await restored.backend.applySettings({ downloadLimitKiB: 64 });
    await restored.backend.start();
    expect((await restored.backend.list()).map(t => t.id)).toContain(id);
    downloading = restored.client.torrents[0] as any;
    await waitFor(() => downloading.ready, "restored torrent metadata and piece validation");
    expect(downloading.paused).toBe(true);
    const stillPausedAt = downloading.downloaded;
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(downloading.downloaded).toBe(stillPausedAt);
    // The first phase is deliberately capped for a deterministic live pause; lift the cap to keep
    // the resume and corruption-repair checks fast while still testing actual piece verification.
    await restored.backend.applySettings({ downloadLimitKiB: 0 });
    await restored.backend.resume(id);
    downloading.addPeer(`127.0.0.1:${seeder.torrentPort}`);
    await waitFor(() => downloading.done, "resumed transfer completion");
    const outputPath = path.join(savePath, path.basename(source));
    const correct = await readFile(outputPath);
    expect(createHash("sha256").update(correct).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));

    await restored.backend.pause(id);
    const damaged = Buffer.from(await readFile(outputPath));
    damaged[0] = damaged[0]! ^ 0xff;
    await writeFile(outputPath, damaged);
    await restored.backend.stop();

    const repair = makeBackend();
    await repair.backend.applySettings({ downloadLimitKiB: 64 });
    await repair.backend.start();
    expect((await repair.backend.list()).map(t => t.id)).toContain(id);
    let checking = repair.client.torrents[0] as any;
    await waitFor(() => checking.ready, "corrupted file native recheck");
    expect(checking.done).toBe(false);
    const state = await repair.backend.pieces(id);
    expect(state?.states).toContain("missing");
    await repair.backend.applySettings({ downloadLimitKiB: 0 });
    await repair.backend.resume(id);
    checking.addPeer(`127.0.0.1:${seeder.torrentPort}`);
    await waitFor(() => checking.done, "redownload of corrupted piece");
    const repaired = await readFile(outputPath);
    expect(createHash("sha256").update(repaired).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
  }, 30_000);
  it("removes an errored restored torrent whose metadata file is missing without deleting data", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plus-wt-missing-")); dirs.push(root);
    const state = path.join(root,"state"); await (await import("node:fs/promises")).mkdir(state);
    const id="c".repeat(40);
    await writeFile(path.join(state,"manifest.json"),JSON.stringify({torrents:[{id,source:path.join(root,"missing.torrent"),savePath:root,paused:true,addedAt:Date.now()}]}));
    const backend = new WebTorrentBackend(state, opts => {
      const c=new WebTorrent({...opts,dht:false,tracker:false,lsd:false,utp:false,torrentPort:0} as never);clients.push(c);return c;
    });backends.push(backend);await backend.start();
    const until=Date.now()+5000;while(Date.now()<until && (await backend.list())[0]?.state!=="failed")await new Promise(r=>setTimeout(r,20));
    expect((await backend.list())[0]?.state).toBe("failed");
    await backend.remove(id,false);expect(await backend.list()).toEqual([]);
  });

});
