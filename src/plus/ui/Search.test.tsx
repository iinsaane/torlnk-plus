import { describe, expect, it } from "vitest";
import { renderUI } from "../../ui/testHarness";
import type { TorrentResult } from "../../sources/types";
import { PlusSearch } from "./Search";

const row: TorrentResult = {
  infoHash: "abc123", name: "A deliberately long torrent title for truncation", sizeBytes: 2_147_483_648,
  seeders: 42, leechers: 3, source: "yts", magnet: "magnet:?xt=urn:btih:abc123",
};
const callbacks = { onSubmit: () => {}, onChange: () => {}, onExitDown: () => {} };

describe("PlusSearch", () => {
  it.each([[48, 24], [80, 24], [100, 30], [32, 16]])("fits the centered home layout at %ix%i", (width, height) => {
    const ui = renderUI(<PlusSearch {...callbacks} width={width} height={height} home value="" editing inputKind="search" busy={false} results={[]} cursor={0} backend="webtorrent" />, { cols: width, rows: height });
    try {
      const lines = ui.frame().split("\n");
      expect(lines.length).toBeLessThanOrEqual(height);
      expect(lines.every((line) => line.length <= width)).toBe(true);
      expect(ui.frame()).toContain(width >= 36 ? "▀█▀" : "torlnk+");
      expect(ui.frame()).toContain("search");
    } finally { ui.unmount(); }
  });

  it("shows source, known swarm counts, size, and the selected result", () => {
    const ui = renderUI(<PlusSearch {...callbacks} width={80} height={24} home={false} value="movie" editing={false} inputKind="search" busy={false} results={[row]} cursor={0} backend="webtorrent" />, { cols: 80, rows: 24 });
    try {
      const frame = ui.frame();
      expect(frame).toContain("YTS");
      expect(frame).toContain("42");
      expect(frame).toMatch(/42 +2.00 GB/);
      expect(frame).toContain("2.00 GB");
      expect(frame).toContain("A deliberately long torrent title");
      expect(ui.rawFrame()).toContain("\u001b[7m");
    } finally { ui.unmount(); }
  });

  it("keeps a selected result visible at the end of a long list", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ ...row, infoHash: String(i), name: `Result ${i}` }));
    const ui = renderUI(<PlusSearch {...callbacks} width={48} height={14} home={false} value="sample" editing={false} inputKind="search" busy={false} results={rows} cursor={39} backend="qbittorrent" />, { cols: 48, rows: 14 });
    try { expect(ui.frame()).toContain("Result 39"); expect(ui.frame().split("\n").length).toBeLessThanOrEqual(14); }
    finally { ui.unmount(); }
  });

  it("labels unavailable seed counts as unknown and explains an empty search", () => {
    const ui = renderUI(<PlusSearch {...callbacks} width={48} height={16} home={false} value="query" editing={false} inputKind="search" busy={false} results={[{ ...row, source: "fitgirl", seeders: 0 }]} cursor={0} backend="qbittorrent" />, { cols: 48, rows: 16 });
    try { expect(ui.frame()).toContain("?"); } finally { ui.unmount(); }
    const empty = renderUI(<PlusSearch {...callbacks} width={48} height={16} home={false} value="query" editing={false} inputKind="search" busy={false} results={[]} cursor={0} backend="qbittorrent" />, { cols: 48, rows: 16 });
    try { expect(empty.frame()).toContain("No results found."); } finally { empty.unmount(); }
  });
});
