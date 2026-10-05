import React, { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderUI, type RenderedUI } from "../../ui/testHarness";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";

const settle = () => new Promise(resolve => setTimeout(resolve, 35));
const commands: PaletteCommand[] = [
  { id: "settings", label: "Open settings", description: "Change preferences and defaults.", keywords: "preferences options" },
  { id: "search", label: "Search catalog", description: "Find a title to download.", keywords: "find browse" },
  { id: "backend", label: "Switch backend", description: "Choose qBittorrent or WebTorrent." },
  { id: "vpn", label: "Connect VPN", description: "Choose a saved profile.", disabled: "Install a VPN profile first." },
];
const mounted: RenderedUI[] = [];
afterEach(() => { for (const view of mounted.splice(0)) view.unmount(); });
const mount = (overrides: Partial<React.ComponentProps<typeof CommandPalette>> = {}) => {
  const view = renderUI(<CommandPalette commands={commands} width={80} height={22} onSelect={vi.fn()} onClose={vi.fn()} {...overrides} />, { cols: overrides.width ?? 80, rows: overrides.height ?? 22 });
  mounted.push(view);
  return view;
};
const press = async (view: RenderedUI, key: string) => { view.press(key); await settle(); };

describe("CommandPalette", () => {
  it("filters label, description, and keywords without case sensitivity and selects the match", async () => {
    const onSelect = vi.fn();
    const view = mount({ onSelect });
    await press(view, "PREF");
    expect(view.frame()).toContain("Open settings");
    expect(view.frame()).not.toContain("Search catalog");
    expect(view.frame()).toContain("1 / 1 commands");
    await press(view, "\r");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("settings");
  });

  it("shows disabled explanations, skips no command on Enter, then selects an enabled command", async () => {
    const onSelect = vi.fn();
    const view = mount({ onSelect });
    await press(view, "\u001b[B");
    await press(view, "\u001b[B");
    await press(view, "\u001b[B");
    expect(view.frame()).toContain("Install a VPN profile first.");
    await press(view, "\r");
    expect(onSelect).not.toHaveBeenCalled();
    await press(view, "\u001b[A");
    await press(view, "\r");
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("backend");
  });

  it("reports no matches and Ctrl+U clears the search", async () => {
    const view = mount();
    await press(view, "nothing-matches");
    expect(view.frame()).toContain("No matching commands");
    expect(view.frame()).toContain("No commands match this search");
    await press(view, "\u0015");
    expect(view.frame()).toContain("Open settings");
    expect(view.frame()).toContain("> ▏");
  });

  it("strips terminal controls from pasted query text", async () => {
    const view = mount();
    await press(view, "P\u0085REF");
    expect(view.frame()).toContain("Open settings");
    expect(view.frame()).toContain("1 / 1 commands");
  });

  it("right-aligns command shortcuts", () => {
    const view = mount({ commands: [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta", shortcut: "Ctrl+B" },
    ] });
    const lines = view.frame().split("\n");
    const alpha = lines.find(line => line.includes("Alpha"))!;
    const beta = lines.find(line => line.includes("Beta"))!;
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    expect(alpha.length).toBe(beta.length);
    expect(beta.indexOf("Ctrl+B")).toBeGreaterThan(beta.indexOf("Beta"));
    expect(beta.indexOf("Ctrl+B")).toBe(alpha.length - "Ctrl+B".length - 2);
  });

  it("sanitizes command text and clamps selection when the command list changes", async () => {
    const initial: PaletteCommand[] = [
      { id: "alpha", label: "Al\u001b[31mpha", description: "First\u001b]52;c;bad\u0007" },
      { id: "beta", label: "Beta", description: "Second" },
      { id: "gamma", label: "Gamma", description: "Third" },
      { id: "shrink", label: "Shrink list", shortcut: "Alt\u001b[2JEnter" },
    ];
    function ChangingPalette() {
      const [rows, setRows] = useState(initial);
      return <CommandPalette commands={rows} width={80} height={22} onClose={vi.fn()} onSelect={id => {
        if (id === "shrink") setRows(initial.slice(0, 2));
      }} />;
    }
    const view = renderUI(<ChangingPalette />, { cols: 80, rows: 22 });
    mounted.push(view);
    expect(view.frame()).toContain("Alpha");
    expect(view.frame()).not.toContain("\u001b");
    expect(view.frame()).toContain("First");
    expect(view.frame()).not.toContain("52;c;bad");
    for (let index = 0; index < 3; index++) await press(view, "\u001b[B");
    expect(view.frame()).toContain("4 / 4 commands");
    await press(view, "\r");
    expect(view.frame()).toContain("2 / 2 commands");
    expect(view.frame()).toContain("› Beta");
    await press(view, "\u001b[A");
    expect(view.frame()).toContain("› Alpha");
    expect(view.frame()).toContain("1 / 2 commands");
    expect(view.frame()).not.toContain("Untitled");
  });

  it("supports Home, Left, Right, Backspace, and Delete in the query", async () => {
    const view = mount();
    await press(view, "xOpen");
    expect(view.frame()).toContain("No matching commands");
    await press(view, "\u001b[H");
    await press(view, "\u001b[3~");
    expect(view.frame()).toContain("Open settings");
    await press(view, "\u001b[F");
    await press(view, "\u001b[D");
    await press(view, "\u007f");
    expect(view.frame()).toContain("No matching commands");
    await press(view, "\u001b[C");
    await press(view, "\u0015");
    expect(view.frame()).toContain("Open settings");
  });

  it.each([[32, 14], [48, 18], [80, 22]])("fits %ix%i and scrolls the last command into view", async (width, height) => {
    const many: PaletteCommand[] = Array.from({ length: 16 }, (_, index) => ({ id: `cmd-${index}`, label: `Command ${index + 1}`, description: index === 15 ? "Last result remains visible." : `Description ${index + 1}` }));
    const view = mount({ commands: many, width, height });
    for (let index = 0; index < many.length - 1; index++) await press(view, "\u001b[B");
    const frame = view.frame();
    const lines = frame.split("\n");
    expect(frame).toContain("Command 16");
    expect(frame).toContain("Last result remains visible.");
    expect(lines.length).toBeLessThanOrEqual(height);
    expect(lines.every(line => line.length <= width)).toBe(true);
  });

  it("closes on Escape and Ctrl+P", async () => {
    const onClose = vi.fn();
    const view = mount({ onClose });
    await press(view, "\u001b");
    expect(onClose).toHaveBeenCalledTimes(1);
    const secondClose = vi.fn();
    const second = mount({ onClose: secondClose });
    await press(second, "\u0010");
    expect(secondClose).toHaveBeenCalledTimes(1);
  });
});
