import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defaultPlusConfig, loadPlusConfig, savePlusConfig, validatePlusConfig } from "./config";

describe("Plus settings config", () => {
  it("uses explicit first-run routing and the intended defaults", () => {
    const config = defaultPlusConfig();
    expect(config.network.mode).toBeNull();
    expect(config.defaultBackend).toBe("qbittorrent");
    expect(config.display).toMatchObject({ refreshMs: 1000, pieceRefreshMs: 2000 });
  });
  it("rejects malformed values, unknown keys, invalid sources, and relative directories", () => {
    const c = defaultPlusConfig();
    expect(() => validatePlusConfig({ ...c, surprise: true })).toThrow(/unknown setting/);
    expect(() => validatePlusConfig({ ...c, downloadDir: "relative" })).toThrow(/absolute path/);
    expect(() => validatePlusConfig({ ...c, enabledSources: ["not-a-source"] })).toThrow(/unknown source/);
    expect(() => validatePlusConfig({ ...c, network: { mode: "vpn", forwardedPort: 70000 } })).toThrow(/forwardedPort/);
  });
  it("preserves malformed on-disk config and validates before writing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "plus-config-"));
    const file = path.join(dir, "config.json");
    try {
      await writeFile(file, '{"downloadDir":"relative"}');
      await expect(loadPlusConfig(dir)).rejects.toThrow(/original config was preserved/);
      expect(await readFile(file, "utf8")).toBe('{"downloadDir":"relative"}');
      await expect(savePlusConfig(dir, { ...defaultPlusConfig(), downloadDir: "relative" })).rejects.toThrow(/absolute path/);
      expect(await readFile(file, "utf8")).toBe('{"downloadDir":"relative"}');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("round trips validated settings through an atomic save", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "plus-config-"));
    try {
      const c = defaultPlusConfig(); c.network.mode = "direct"; c.backendSettings.maxDownloads = 7;
      await savePlusConfig(dir, c);
      expect(await loadPlusConfig(dir)).toEqual(c);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
