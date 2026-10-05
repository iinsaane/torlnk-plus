import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { importLegacy } from "./migrate";

describe("importLegacy", () => {
  it("preserves source hashes, makes a backup, and marks legacy infohashes as webtorrent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plus-migrate-"));
    try {
      const config = path.join(root, "old-config"); const data = path.join(root, "old-data"); const dest = path.join(root, "new");
      await mkdir(config); await mkdir(data); await mkdir(path.join(data, "torrents"));
      await writeFile(path.join(config, "config.json"), '{"downloadDir":"/downloads","trackers":["udp://tracker"]}');
      const hash = "0123456789abcdef0123456789abcdef01234567";
      await writeFile(path.join(data, "seeds.json"), JSON.stringify([{ infoHash: hash, magnet: `magnet:?xt=urn:btih:${hash}`, name: "seed" }]));
      await writeFile(path.join(data, "history.json"), '[{"name":"completed"}]');
      const before = await Promise.all([path.join(config, "config.json"), path.join(data, "seeds.json"), path.join(data, "history.json")].map(async f => createHash("sha256").update(await readFile(f)).digest("hex")));
      const result = await importLegacy(config, data, dest);
      const after = await Promise.all([path.join(config, "config.json"), path.join(data, "seeds.json"), path.join(data, "history.json")].map(async f => createHash("sha256").update(await readFile(f)).digest("hex")));
      expect(after).toEqual(before);
      expect(result.torrents).toEqual([{ id: "0123456789abcdef0123456789abcdef01234567", backend: "webtorrent" }]);
      const wtManifest = JSON.parse(await readFile(path.join(dest, "webtorrent", "manifest.json"), "utf8"));
      expect(wtManifest.torrents[0].savePath).toBe("/downloads");
      expect(await readFile(path.join(result.backupDir, "config", "config.json"), "utf8")).toContain("downloadDir");
      expect(await importLegacy(config, data, dest)).toEqual(result);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("resumes an interrupted migration and refuses different sources or an unrelated destination", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "plus-migrate-restart-"));
    try {
      const config = path.join(root, "config"); const data = path.join(root, "data"); const dest = path.join(root, "state");
      await mkdir(config); await mkdir(data); await mkdir(dest);
      await writeFile(path.join(config, "config.json"), '{"downloadDir":"/legacy"}');
      await writeFile(path.join(data, "seeds.json"), "[]");
      await writeFile(path.join(dest, "migration.json"), JSON.stringify({ version: 1, status: "copying", configDir: config, dataDir: data, backupDir: path.join(dest, "legacy-backup"), config: { downloadDir: "/legacy" }, torrents: [] }));
      const result = await importLegacy(config, data, dest);
      expect(result.config?.downloadDir).toBe("/legacy");
      expect(JSON.parse(await readFile(path.join(dest, "migration.json"), "utf8")).status).toBe("complete");
      await expect(importLegacy(config, path.join(root, "different-data"), dest)).rejects.toThrow("source paths differ");

      const unrelated = path.join(root, "existing-state"); await mkdir(unrelated);
      await writeFile(path.join(unrelated, "controller.json"), "keep");
      await expect(importLegacy(config, data, unrelated)).rejects.toThrow("Refusing to import over existing destination state");
      expect(await readFile(path.join(unrelated, "controller.json"), "utf8")).toBe("keep");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
