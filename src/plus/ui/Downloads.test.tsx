import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { useInput } from "ink";
import { renderUI } from "../../ui/testHarness";
import { PlusDownloads } from "./Downloads";
import type { PieceSnapshot, RouteStatus, TorrentDetails, TorrentSnapshot } from "../contracts";

const torrent: TorrentSnapshot = {
  id: "id-1", backend: "webtorrent", name: "Example torrent with a readable filename", state: "downloading", progress: 0.425,
  total: 1_000_000, downloaded: 425_000, uploaded: 20_000, downloadSpeed: 100_000, uploadSpeed: 5_000, peers: 3, etaSeconds: 20,
  savePath: "/downloads", addedAt: Date.now() - 60_000,
};
const route: RouteStatus = { mode: "vpn", state: "Protected" };
const pieces: PieceSnapshot = { states: ["verified", "active", "missing"], pieceLength: 10, lastPieceLength: 4 };
const props = (overrides: Partial<React.ComponentProps<typeof PlusDownloads>> = {}) => ({
  torrents: [torrent], route, width: 80, height: 18, compact: false, showLegend: true,
  onCommand: vi.fn(async () => {}), getDetails: vi.fn(async () => ({ torrent, files: [], trackers: [] })),
  getPieces: vi.fn(async () => pieces), ...overrides,
});
const tick = (ms = 15) => new Promise(resolve => setTimeout(resolve, ms));

function MutableDownloads({ initial, selected, onAction, seedingOnly = false }: { initial: TorrentSnapshot[]; selected: (torrent: TorrentSnapshot | undefined) => void; onAction?: (action: "pause" | "resume" | "remove" | "recheck" | "export", id: string) => void; seedingOnly?: boolean }) {
  const [rows, setRows] = useState(initial);
  const onCommand = async (action: "pause" | "resume" | "remove" | "recheck" | "export", id: string) => {
    onAction?.(action, id);
    if (action === "remove") setRows(current => current.filter(row => row.id !== id));
  };
  return <PlusDownloads {...props({ torrents: rows, onCommand, onSelectionChange: selected, seedingOnly })} />;
}

function ToggleDownloads({ getDetails }: { getDetails: (id: string) => Promise<TorrentDetails> }) {
  const [token, setToken] = useState(0);
  useInput(input => { if (input === "u") setToken(value => value + 1); });
  return <PlusDownloads {...props({ detailsToggle: token, getDetails })} />;
}

function OverlayDownloads({ getDetails, onCommand }: { getDetails: (id: string) => Promise<TorrentDetails>; onCommand: (action: "pause" | "resume" | "remove" | "recheck" | "export", id: string) => Promise<void> }) {
  const [active, setActive] = useState(true);
  useInput(input => { if (input === "o") setActive(value => !value); });
  return <PlusDownloads {...props({ active, getDetails, onCommand })} />;
}

describe("PlusDownloads", () => {
  it.each([[48, 18], [80, 18], [100, 18], [48, 12], [80, 12], [100, 12]])("keeps the bordered list within %ix%i", async (width, height) => {
    const ui = renderUI(<PlusDownloads {...props({ width, height })} />, { cols: width, rows: height });
    try {
      await tick();
      const frame = ui.frame();
      expect(frame.split("\n").length).toBeLessThanOrEqual(height);
      expect(frame.split("\n").every(line => line.length <= width)).toBe(true);
      expect(frame).toContain("Example torrent");
      expect(frame).toContain("WebTorrent");
      expect(frame).toContain("Downloading");
      expect(frame).not.toContain("Protected");
      expect(frame).toContain("Delete/x remove");
    } finally { ui.unmount(); }
  });

  it("keeps the selected row, transfer stats, and live piece map readable", async () => {
    const p = props();
    const ui = renderUI(<PlusDownloads {...p} />, { cols: 80, rows: 18 });
    try {
      await tick();
      const frame = ui.frame();
      expect(frame).toContain("❯");
      expect(frame).toContain("43%");
      expect(frame).toContain("█");
      expect(frame).toContain("↓ 98 KB/s");
      expect(p.getPieces).toHaveBeenCalledWith("id-1");
    } finally { ui.unmount(); }
  });

  it("preserves keyboard actions, capability checks, details timing, and command errors", async () => {
    const onCommand = vi.fn(async (_action: "pause" | "resume" | "remove" | "recheck" | "export", _id: string) => {});
    const p = props({ onCommand });
    const ui = renderUI(<PlusDownloads {...p} />, { cols: 100, rows: 18 });
    try {
      ui.press("p"); await tick();
      ui.press("x"); await tick();
      ui.press("r"); await tick();
      ui.press("e"); await tick();
      expect(onCommand.mock.calls.map(c => c[0])).toEqual(["pause", "remove", "recheck", "export"]);
      ui.press("\r"); await tick();
      expect(p.getDetails).toHaveBeenCalledWith("id-1");
    } finally { ui.unmount(); }

    const fail = vi.fn(async () => { throw new Error("backend offline"); });
    const errorUi = renderUI(<PlusDownloads {...props({ onCommand: fail })} />, { cols: 80, rows: 18 });
    try {
      errorUi.press("p"); await tick(40);
      expect(errorUi.frame()).toContain("backend offline");
    } finally { errorUi.unmount(); }
  });

  it("shows useful empty guidance and filters seeding-only rows", () => {
    const empty = renderUI(<PlusDownloads {...props({ torrents: [] })} />, { cols: 80, rows: 18 });
    try { expect(empty.frame()).toContain("1 Search · Enter a result to download."); expect(empty.frame()).toContain("i import a magnet link"); } finally { empty.unmount(); }
    const seeding = renderUI(<PlusDownloads {...props({ seedingOnly: true })} />, { cols: 80, rows: 18 });
    try { expect(seeding.frame()).toContain("Nothing seeding yet."); } finally { seeding.unmount(); }
  });

  it("announces an empty initial selection once so stale palette selection is cleared", async () => {
    const selected = vi.fn();
    const ui = renderUI(<PlusDownloads {...props({ torrents: [], onSelectionChange: selected })} />, { cols: 80, rows: 18 });
    try {
      await tick();
      expect(selected).toHaveBeenCalledTimes(1);
      expect(selected).toHaveBeenCalledWith(undefined);
    } finally { ui.unmount(); }
  });

  it("keeps missing peers, ETA, and piece data unknown", async () => {
    const ui = renderUI(<PlusDownloads {...props({ torrents: [{ ...torrent, peers: undefined, etaSeconds: undefined }], getPieces: vi.fn(async () => null) })} />, { cols: 48, rows: 12 });
    try { await tick(); expect(ui.frame()).toContain("unknown pee"); expect(ui.frame()).toContain("ETA unknown"); expect(ui.frame()).toContain("?"); } finally { ui.unmount(); }
  });

  it("preserves zero speeds and reserves the right edge for client and state on long titles", () => {
    const ui = renderUI(<PlusDownloads {...props({ width: 80, torrents: [{ ...torrent, backend: "qbittorrent", name: "A very long filename that must not hide the client name or torrent state", downloadSpeed: 0, uploadSpeed: 0 }] })} />, { cols: 80, rows: 18 });
    try {
      const frame = ui.frame();
      expect(frame).toContain("qBittorrent · Downloading");
      expect(frame).toContain("0 B/s");
    } finally { ui.unmount(); }
  });

  it("uses two-line compact rows to show more records without dropping stats or the piece map", async () => {
    const torrents = Array.from({ length: 6 }, (_, i) => ({ ...torrent, id: `compact-${i}`, name: `Torrent-${i}` }));
    const render = async (compact: boolean) => {
      const ui = renderUI(<PlusDownloads {...props({ width: 100, height: 18, compact, torrents })} />, { cols: 100, rows: 18 });
      await tick();
      return ui;
    };
    const regular = await render(false), condensed = await render(true);
    try {
      const regularFrame = regular.frame(), compactFrame = condensed.frame();
      const namesShown = (frame: string) => (frame.match(/Torrent-\d/g) ?? []).length;
      const compactLines = compactFrame.split("\n");
      const compactRows = compactLines.filter(line => line.includes("3 peers"));
      expect(namesShown(compactFrame)).toBeGreaterThan(namesShown(regularFrame));
      expect(compactFrame).toContain("ETA 20s");
      expect(compactFrame).toContain("3 peers");
      expect(compactFrame).toContain("43%");
      expect(compactFrame).toContain("↑/k ↓/j move");
      expect(compactLines.some(line => line.includes("╰"))).toBe(true);
      expect(compactRows).toHaveLength(namesShown(compactFrame));
      expect(compactRows.every(line => line.includes("█") && line.includes("43%"))).toBe(true);
      expect(compactLines.length).toBeLessThanOrEqual(18);
      expect(compactLines.every(line => line.length <= 100)).toBe(true);
    } finally { regular.unmount(); condensed.unmount(); }
  });

  it("pages through expanded file and tracker details while keeping j/k torrent navigation", async () => {
    const manyFiles = Array.from({ length: 8 }, (_, i) => ({ path: `folder/file-${i}.mkv`, size: 1000, downloaded: 500 }));
    const p = props({ width: 100, height: 24, torrents: [torrent, { ...torrent, id: "id-2", name: "Next torrent" }], getDetails: vi.fn(async () => ({ torrent, files: manyFiles, trackers: [{ url: "udp://tracker.final.test:80/announce", status: "Working" }] })) });
    const ui = renderUI(<PlusDownloads {...p} />, { cols: 100, rows: 24 });
    try {
      ui.press("\r"); await tick();
      expect(ui.frame()).toContain("PgUp/PgDn details");
      expect(ui.frame()).toContain("file-0.mkv");
      expect(ui.frame().split("\n").length).toBeLessThanOrEqual(24);
      ui.press("\u001b[6~"); await tick();
      expect(ui.frame()).toContain("tracker.final.test");
      expect(ui.frame().split("\n").length).toBeLessThanOrEqual(24);
      ui.press("j"); await tick();
      expect(ui.frame()).toContain("Next torrent");
    } finally { ui.unmount(); }
  });

  it("keeps the expanded panel and footer inside a 48 by 18 terminal", async () => {
    const p = props({ width: 48, height: 18, getDetails: vi.fn(async () => ({ torrent, files: Array.from({ length: 5 }, (_, i) => ({ path: `folder/file-${i}.mkv`, size: 1000 })), trackers: [] })) });
    const ui = renderUI(<PlusDownloads {...p} />, { cols: 48, rows: 18 });
    try {
      ui.press("\r"); await tick();
      expect(ui.frame()).toContain("Torrent details");
      expect(ui.frame()).toContain("Delete/x remove");
      expect(ui.frame().split("\n").length).toBeLessThanOrEqual(18);
      expect(ui.frame().split("\n").every(line => line.length <= 48)).toBe(true);
    } finally { ui.unmount(); }
  });

  it("retries the latest visible piece window after an older poll settles", async () => {
    let release!: (value: PieceSnapshot | null) => void;
    const first = new Promise<PieceSnapshot | null>(resolve => { release = resolve; });
    const two = { ...torrent, id: "id-2", name: "Second torrent" };
    const three = { ...torrent, id: "id-3", name: "Third torrent" };
    const getPieces = vi.fn().mockReturnValueOnce(first).mockResolvedValue(pieces);
    const ui = renderUI(<PlusDownloads {...props({ width: 100, height: 12, torrents: [torrent, two, three], compact: false, showLegend: false, pieceRefreshMs: 5, getPieces })} />, { cols: 100, rows: 12 });
    try {
      ui.press("j"); await tick(); ui.press("j");
      await vi.waitFor(() => expect(ui.frame()).toContain("Third torrent"), { timeout: 100 });
      expect(ui.frame()).toContain("Third torrent");
      release(null);
      await vi.waitFor(() => expect(getPieces.mock.calls.map(([id]) => id)).toContain("id-3"), { timeout: 500 });
    } finally { ui.unmount(); }
  });

  it.each(["webtorrent", "qbittorrent"] as const)("Delete removes the selected %s torrent and selects the next row", async backend => {
    const first = { ...torrent, id: `${backend}-first`, backend };
    const next = { ...torrent, id: `${backend}-next`, name: "Next selection" };
    const selection = vi.fn(), command = vi.fn();
    const ui = renderUI(<MutableDownloads initial={[first, next]} selected={selection} onAction={command} />, { cols: 80, rows: 18 });
    try {
      await tick();
      ui.press("\u001b[3~");
      await vi.waitFor(() => expect(ui.frame()).toContain("Next selection"));
      await vi.waitFor(() => expect(selection.mock.calls.some(([row]) => row?.id === next.id)).toBe(true));
      expect(command).toHaveBeenCalledWith("remove", first.id);
    } finally { ui.unmount(); }
  });

  it.each([
    { state: "completed" as const, name: "completed" },
    { state: "paused" as const, name: "paused" },
  ])("Delete removes $name entries from the seeding view", async ({ state }) => {
    const item = { ...torrent, id: `seed-${state}`, state, progress: 1 };
    const selection = vi.fn(), command = vi.fn();
    const ui = renderUI(<MutableDownloads initial={[item]} selected={selection} onAction={command} seedingOnly />, { cols: 80, rows: 18 });
    try {
      await tick();
      ui.press("\u001b[3~");
      await vi.waitFor(() => expect(command).toHaveBeenCalledWith("remove", item.id));
      await vi.waitFor(() => expect(selection.mock.calls.some(([row]) => row === undefined)).toBe(true));
    } finally { ui.unmount(); }
  });

  it("suppresses shortcuts and piece polling while an overlay owns input", async () => {
    const onCommand = vi.fn(async () => {}), getPieces = vi.fn(async () => pieces);
    const ui = renderUI(<PlusDownloads {...props({ active: false, onCommand, getPieces })} />, { cols: 80, rows: 18 });
    try {
      await tick();
      ui.press("p"); ui.press("x"); ui.press("\u001b[3~"); ui.press("\r");
      await tick();
      expect(onCommand).not.toHaveBeenCalled();
      expect(getPieces).not.toHaveBeenCalled();
    } finally { ui.unmount(); }
  });

  it("changes details from the palette token without using the keyboard listener", async () => {
    const getDetails = vi.fn(async () => ({ torrent, files: [], trackers: [] }));
    const ui = renderUI(<ToggleDownloads getDetails={getDetails} />, { cols: 80, rows: 18 });
    try {
      await tick();
      expect(getDetails).not.toHaveBeenCalled();
      ui.press("u");
      await vi.waitFor(() => expect(getDetails).toHaveBeenCalledWith("id-1"));
      expect(ui.frame()).toContain("Torrent details");
    } finally { ui.unmount(); }
  });

  it("keeps the scrolled details window across an inactive palette overlay and resumes input", async () => {
    const files = Array.from({ length: 8 }, (_, i) => ({ path: `folder/file-${i}.mkv`, size: 1000, downloaded: 500 }));
    const getDetails = vi.fn(async () => ({ torrent, files, trackers: [{ url: "udp://last-tracker.test:80/announce", status: "Working" }] }));
    const onCommand = vi.fn(async () => {});
    const ui = renderUI(<OverlayDownloads getDetails={getDetails} onCommand={onCommand} />, { cols: 100, rows: 18 });
    try {
      ui.press("\r");
      await vi.waitFor(() => expect(getDetails).toHaveBeenCalled());
      ui.press("\u001b[6~"); await tick();
      ui.press("\u001b[6~"); await tick();
      expect(ui.frame()).toContain("last-tracker.test");
      ui.press("o"); await tick();
      ui.press("o"); await tick();
      expect(ui.frame()).toContain("last-tracker.test");
      ui.press("p");
      await vi.waitFor(() => expect(onCommand).toHaveBeenCalledWith("pause", "id-1"));
    } finally { ui.unmount(); }
  });

  it("does not treat Ctrl+P as the pause shortcut", async () => {
    const onCommand = vi.fn(async () => {});
    const ui = renderUI(<PlusDownloads {...props({ onCommand })} />, { cols: 80, rows: 18 });
    try { ui.press("\u0010"); await tick(); expect(onCommand).not.toHaveBeenCalled(); } finally { ui.unmount(); }
  });
});
