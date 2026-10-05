import { describe, it, expect, vi } from "vitest";
import { renderUI, type RenderedUI } from "../../ui/testHarness";
import { PlusApp } from "./App";
import { defaultPlusConfig } from "../config";
import type { AppState } from "../client";
import type { JsonClient } from "../http";
import type { TorrentSnapshot } from "../contracts";
import type { TorrentResult } from "../../sources/types";

const wait = () => new Promise(resolve => setTimeout(resolve, 40));
async function press(ui: RenderedUI, key: string) { ui.press(key); await wait(); }
const result: TorrentResult = { infoHash: "a".repeat(40), name: "Controlled sample", source: "yts", sizeBytes: 500000, seeders: 20, leechers: 0, magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}` };
function fixture() {
  const config = defaultPlusConfig(); config.network.mode = "direct";
  const services: AppState["services"] = ["supervisor", "controller", "gateway", "search", "qbittorrent", "webtorrent"].map(service => ({ service: service as never, state: "healthy", checkedAt: Date.now(), lastSuccessAt: Date.now(), message: "Responding" }));
  const state: AppState = { config, services, profiles: [], capabilities: {}, snapshot: { torrents: [], backends: [{ backend: "qbittorrent", available: true }, { backend: "webtorrent", available: true }], route: { mode: "direct", state: "Direct" } } };
  const request = vi.fn(async (route: string, body?: any): Promise<any> => {
    if (route === "/state") return state;
    if (route === "/search") return { results: [result], errors: [] };
    if (route === "/route") {
      state.config = { ...state.config, network: { ...state.config.network, mode: body.mode } };
      state.snapshot.route = { mode: body.mode, state: body.mode === "vpn" ? "Protected" : "Direct" };
      return null;
    }
    if (route === "/config") { state.config = body.config; return null; }
    if (route === "/command" && body?.action === "remove") { state.snapshot.torrents = state.snapshot.torrents.filter(t => t.id !== body.id); return null; }
    return null;
  });
  return { state, request, client: { request } as unknown as JsonClient };
}

describe("search-first application and page navigation", () => {
  it.each([[32, 16], [48, 24], [80, 24], [100, 30]])("opens with a focused search and one bottom status row at %ix%i", async (cols, rows) => {
    const f = fixture(); const ui = renderUI(<PlusApp client={f.client} />, { cols, rows });
    try {
      await wait(); const frame = ui.frame(); const lines = frame.trimEnd().split("\n");
      expect(frame).toContain("Search"); expect(ui.rawFrame()).toContain("\x1b[7m");
      expect(lines.at(-1)).toContain("Direct"); expect(lines.at(-1)).toContain("6/6 healthy");
      expect(frame.match(/Direct/g)).toHaveLength(1);
      expect(frame).not.toContain("SETTINGS");
      expect(frame.split("\n").every(line => line.length <= cols)).toBe(true);
      expect(lines.length).toBeLessThanOrEqual(rows);
    } finally { ui.unmount(); }
  });
  it("keeps the search home on an unconfigured first run and allows Health during polling", async () => {
    const f = fixture(); f.state.config.network.mode = null; f.state.config.display.refreshMs = 30;
    f.state.snapshot.route = { mode: "vpn", state: "Blocked" };
    const ui = renderUI(<PlusApp client={f.client} />);
    try { await wait(); expect(ui.frame()).toContain("Search"); expect(ui.frame()).toContain("choose VPN or Direct"); await press(ui, "5"); await wait(); expect(ui.frame()).toContain("Service health"); expect(ui.frame()).not.toContain("SETTINGS"); }
    finally { ui.unmount(); }
  });
  it("accepts 1, 2, 3, 4, 5 in sequence without requiring Escape from Settings", async () => {
    const f = fixture(); const ui = renderUI(<PlusApp client={f.client} />);
    try {
      await wait(); await press(ui, "1"); await press(ui, "2"); expect(ui.frame()).toContain("No downloads yet.");
      await press(ui, "3"); expect(ui.frame()).toContain("Nothing seeding yet.");
      await press(ui, "4"); expect(ui.frame()).toContain("SETTINGS");
      await press(ui, "5"); expect(ui.frame()).toContain("Service health"); expect(ui.frame()).not.toContain("SETTINGS");
    } finally { ui.unmount(); }
  });
  it("keeps numeric keys in the Settings editor and restores navigation when editing ends", async () => {
    const f = fixture(); const ui = renderUI(<PlusApp client={f.client} />);
    try {
      await wait(); await press(ui, "4"); for (let i = 0; i < 4; i++) await press(ui, "j");
      await press(ui, "\r"); await press(ui, "\x15");
      for (const digit of "12345") await press(ui, digit);
      expect(ui.frame()).toContain("12345▏"); expect(ui.frame()).toContain("SETTINGS");
      await press(ui, "\x15"); await press(ui, "5"); await press(ui, "\r"); await press(ui, "s");
      expect(f.request).toHaveBeenCalledWith("/config", expect.objectContaining({ config: expect.objectContaining({ backendSettings: expect.objectContaining({ maxDownloads: 5 }) }) }));
      await press(ui, "5"); expect(ui.frame()).toContain("Service health");
    } finally { ui.unmount(); }
  });
  it("preserves unsaved Settings changes across page switches", async () => {
    const f = fixture(); const ui = renderUI(<PlusApp client={f.client} />);
    try {
      await wait(); await press(ui, "4"); await press(ui, " "); await press(ui, "5"); await press(ui, "4"); await press(ui, "s");
      expect(f.request).toHaveBeenCalledWith("/config", expect.objectContaining({ config: expect.objectContaining({ defaultBackend: "webtorrent" }) }));
    } finally { ui.unmount(); }
  });
  it.each(["Interstellar", "Blade Runner", "V for Vendetta", "Quantum Leap"])("types %s immediately without triggering letter shortcuts", async query => {
    const f = fixture(); const ui = renderUI(<PlusApp client={f.client} />);
    try {
      await wait(); for (const char of query) await press(ui, char); await press(ui, "\r");
      expect(f.request).toHaveBeenCalledWith("/search", { query });
      expect(f.request).not.toHaveBeenCalledWith("/route", expect.anything());
      expect(f.request).not.toHaveBeenCalledWith("/command", expect.anything());
    } finally { ui.unmount(); }
  });
  it("keeps a typed query when Tab leaves the home search", async () => {
    const f = fixture(); const ui = renderUI(<PlusApp client={f.client} />);
    try { await wait(); await press(ui, "sample title"); await press(ui, "\t"); expect(f.request).toHaveBeenCalledWith("/search", { query: "sample title" }); }
    finally { ui.unmount(); }
  });
  it("supports numeric queries, caret editing and page keys after leaving the search editor", async () => {
    const f = fixture(); const ui = renderUI(<PlusApp client={f.client} />);
    try {
      await wait(); await press(ui, "/"); await press(ui, "1984"); await press(ui, "\x1b[D"); await press(ui, "\x1b[3~"); await press(ui, "5"); await press(ui, "\r");
      expect(f.request).toHaveBeenCalledWith("/search", { query: "1985" });
      await press(ui, "2"); await press(ui, "1"); await press(ui, "4"); await press(ui, "5"); expect(ui.frame()).toContain("Service health");
    } finally { ui.unmount(); }
  });
  it("browses on empty Enter and respects a backend override when adding a result", async () => {
    const f = fixture(); const ui = renderUI(<PlusApp client={f.client} />);
    try {
      await wait(); await press(ui, "\r"); expect(f.request).toHaveBeenCalledWith("/search", { query: "" });
      expect(ui.frame()).toContain("download · B client");
      await press(ui, "b"); expect(ui.frame()).toContain("Next download: WebTorrent"); await press(ui, "\r");
      expect(f.request).toHaveBeenCalledWith("/command", expect.objectContaining({ action: "add", input: expect.objectContaining({ backend: "webtorrent", magnet: result.magnet }) }));
      expect(ui.frame()).toContain("No downloads yet.");
    } finally { ui.unmount(); }
  });
});

describe("service health interface", () => {
  it.each([48, 100])("shows independent search failure at %i columns", async cols => {
    const f = fixture(); const failed = f.state.services.find(s => s.service === "search")!;
    failed.state = "unavailable"; failed.lastSuccessAt = undefined;
    const ui = renderUI(<PlusApp client={f.client} />, { cols, rows: 30 });
    try {
      await wait(); await press(ui, "5"); const frame = ui.frame();
      for (const service of f.state.services) expect(frame).toContain(`${service.service} · ${service.state}`);
      expect(frame).toContain("Last success unknown"); expect(frame.trimEnd().split("\n").at(-1)).toContain("search unavailable");
      expect(frame.split("\n").every(line => line.length <= cols)).toBe(true);
    } finally { ui.unmount(); }
  });
});

const testTorrent: TorrentSnapshot = { id: "b".repeat(40), name: "Controlled download", backend: "qbittorrent", state: "downloading", progress: .5, downloaded: 500, total: 1000, uploaded: 0, downloadSpeed: 0, uploadSpeed: 0, savePath: "/downloads" };

describe("command palette and entry removal", () => {
  it.each([[32, 16], [48, 24], [80, 24]])("opens globally, fits %ix%i, filters commands and navigates", async (cols, rows) => {
    const f = fixture(); const ui = renderUI(<PlusApp client={f.client} />, { cols, rows });
    try {
      await wait(); await press(ui, "\x10"); expect(ui.frame()).toContain("Command Palette");
      const lines = ui.frame().split("\n"); expect(lines.length).toBeLessThanOrEqual(rows); expect(lines.every(line => line.length <= cols)).toBe(true);
      await press(ui, "health"); await press(ui, "\r"); expect(ui.frame()).toContain("Service health"); expect(ui.frame()).not.toContain("Command Palette");
    } finally { ui.unmount(); }
  });
  it("captures palette input without changing the underlying search text", async () => {
    const f = fixture(); const ui = renderUI(<PlusApp client={f.client} />);
    try {
      await wait(); await press(ui, "Blade "); await press(ui, "\x10"); await press(ui, "qvpx123");
      expect(f.request).not.toHaveBeenCalledWith("/command", expect.anything()); expect(f.request).not.toHaveBeenCalledWith("/route", expect.anything());
      await press(ui, "\x1b"); expect(ui.frame()).toContain("Blade "); await press(ui, "Runner"); await press(ui, "\r"); expect(f.request).toHaveBeenCalledWith("/search", { query: "Blade Runner" });
    } finally { ui.unmount(); }
  });
  it("preserves an in-progress Settings field while the palette captures input", async () => {
    const f = fixture(); const ui = renderUI(<PlusApp client={f.client} />);
    try {
      await wait(); await press(ui, "4"); for (let i = 0; i < 4; i++) await press(ui, "j");
      await press(ui, "\r"); await press(ui, "\x15"); await press(ui, "12");
      await press(ui, "\x10"); await press(ui, "345s"); await press(ui, "\x10"); expect(ui.frame()).toContain("12▏");
      await press(ui, "\x15"); await press(ui, "5"); await press(ui, "\r"); await press(ui, "s");
      expect(f.request).toHaveBeenCalledWith("/config", expect.objectContaining({ config: expect.objectContaining({ backendSettings: expect.objectContaining({ maxDownloads: 5 }) }) }));
    } finally { ui.unmount(); }
  });
  it("keeps unsaved preferences while a palette VPN toggle updates the Settings route", async () => {
    const f = fixture(); f.state.config.network.profileId = "a".repeat(16);
    const ui = renderUI(<PlusApp client={f.client} />);
    try {
      await wait(); await press(ui, "4"); await press(ui, " "); await press(ui, "\x10"); await press(ui, "turn vpn on"); await press(ui, "\r");
      expect(f.request).toHaveBeenCalledWith("/route", { mode: "vpn", profileId: "a".repeat(16) });
      await press(ui, "s");
      expect(f.request).toHaveBeenCalledWith("/config", expect.objectContaining({ config: expect.objectContaining({ defaultBackend: "webtorrent", network: expect.objectContaining({ mode: "vpn" }) }) }));
    } finally { ui.unmount(); }
  });
  it.each(["qbittorrent", "webtorrent"] as const)("deletes a selected %s download with the Delete key and keeps files", async backend => {
    const f = fixture(); f.state.snapshot.torrents = [{ ...testTorrent, backend }];
    const ui = renderUI(<PlusApp client={f.client} />);
    try {
      await wait(); await press(ui, "2"); await press(ui, "\x1b[3~");
      expect(f.request).toHaveBeenCalledWith("/command", { action: "remove", id: testTorrent.id, deleteData: false });
      expect(ui.frame()).toContain("No downloads yet."); expect(ui.frame()).toContain("Removed · files kept");
    } finally { ui.unmount(); }
  });
  it.each([
    ["qbittorrent", "downloading", .5, "2"], ["webtorrent", "downloading", .5, "2"],
    ["qbittorrent", "seeding", 1, "3"], ["webtorrent", "paused", 1, "3"],
  ] as const)("removes %s %s from page %s through the palette", async (backend, state, progress, page) => {
    const f = fixture(); f.state.snapshot.torrents = [{ ...testTorrent, backend, state, progress }];
    const ui = renderUI(<PlusApp client={f.client} />);
    try {
      await wait(); await press(ui, page); await press(ui, "\x10");
      expect(f.request).not.toHaveBeenCalledWith("/command", expect.objectContaining({ action: "pause" }));
      await press(ui, "delete"); expect(ui.frame()).toContain("Remove selected entry"); expect(ui.frame()).toContain("Keep files");
      await press(ui, "\r"); expect(f.request).toHaveBeenCalledWith("/command", { action: "remove", id: testTorrent.id, deleteData: false });
      expect(ui.frame()).toContain(page === "2" ? "No downloads yet." : "Nothing seeding yet.");
      await press(ui, page === "2" ? "3" : "2"); expect(ui.frame()).not.toContain(testTorrent.name);
    } finally { ui.unmount(); }
  });
  it("does not expose hidden download actions after visiting an empty Seeding page", async () => {
    const f = fixture(); f.state.snapshot.torrents = [{ ...testTorrent }];
    const ui = renderUI(<PlusApp client={f.client} />);
    try {
      await wait(); await press(ui, "2"); await press(ui, "5"); await press(ui, "3"); await press(ui, "\x10"); await press(ui, "delete"); await press(ui, "\r");
      expect(ui.frame()).toContain("Select an entry in Downloads or Seeding"); expect(f.request).not.toHaveBeenCalledWith("/command", expect.objectContaining({ action: "remove" }));
    } finally { ui.unmount(); }
  });
  it("keeps disabled actions open and does not call the backend", async () => {
    const f = fixture(); const ui = renderUI(<PlusApp client={f.client} />);
    try {
      await wait(); await press(ui, "\x10"); await press(ui, "delete"); await press(ui, "\r");
      expect(ui.frame()).toContain("Command Palette"); expect(ui.frame()).toContain("Select an entry in Downloads or Seeding"); expect(f.request).not.toHaveBeenCalledWith("/command", expect.anything());
    } finally { ui.unmount(); }
  });
  it("keeps the entry and reports backend removal errors", async () => {
    const f = fixture(); f.state.snapshot.torrents = [{ ...testTorrent }];
    f.request.mockImplementation(async (route, body) => {
      if (route === "/state") return f.state;
      if (route === "/command" && body?.action === "remove") throw new Error("backend unavailable");
      return null;
    });
    const ui = renderUI(<PlusApp client={f.client} />);
    try {
      await wait(); await press(ui, "2"); await press(ui, "\x10"); await press(ui, "remove selected"); await press(ui, "\r");
      expect(ui.frame()).toContain(testTorrent.name); expect(ui.frame()).toContain("backend unavailable");
    } finally { ui.unmount(); }
  });
  it("routes palette details to the selected torrent without running other commands", async () => {
    const f = fixture(); f.state.snapshot.torrents = [{ ...testTorrent }];
    const ui = renderUI(<PlusApp client={f.client} />);
    try {
      await wait(); await press(ui, "2"); await press(ui, "\x10"); await press(ui, "show / hide"); await press(ui, "\r");
      expect(ui.frame()).toContain("Torrent details"); expect(f.request).toHaveBeenCalledWith("/command", { action: "details", id: testTorrent.id });
    } finally { ui.unmount(); }
  });
});
