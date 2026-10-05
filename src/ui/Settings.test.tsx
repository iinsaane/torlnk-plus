import React, { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlusSettings } from "./Settings";
import { defaultPlusConfig, type PlusConfig } from "../plus/config";
import { renderUI, type RenderedUI } from "./testHarness";

const settle = () => new Promise(resolve => setTimeout(resolve, 60));
const props = (overrides: Partial<React.ComponentProps<typeof PlusSettings>> = {}) => ({
  config: defaultPlusConfig(), profiles: [],
  onSave: vi.fn(async (_config: PlusConfig) => {}),
  onImportProfile: vi.fn(async () => {}), onRemoveProfile: vi.fn(async () => {}),
  onReconnect: vi.fn(async () => {}), onStop: vi.fn(async () => {}), onClose: vi.fn(),
  width: 80, height: 20, ...overrides,
});
const press = async (view: RenderedUI, key: string) => { view.press(key); await settle(); };
const moveDown = async (view: RenderedUI, count: number) => { for (let i = 0; i < count; i++) await press(view, "j"); };
const mounted: RenderedUI[] = [];
afterEach(() => { for (const view of mounted.splice(0)) view.unmount(); });
const mount = (p: React.ComponentProps<typeof PlusSettings>, cols = p.width, rows = p.height) => {
  const view = renderUI(<PlusSettings {...p} />, { cols, rows });
  mounted.push(view);
  return view;
};

describe("PlusSettings", () => {
  it("renders clear Everyday and Advanced tabs, with main-view shortcuts left available", async () => {
    const onClose = vi.fn();
    const view = mount(props({ onClose }));
    expect(view.frame()).toContain("SETTINGS");
    expect(view.frame()).toContain("Everyday");
    await moveDown(view, 14);
    expect(view.frame()).toContain("Stop background service");
    await press(view, "12345");
    expect(onClose).not.toHaveBeenCalled();
    await press(view, "a");
    expect(view.frame()).toContain("Advanced");
    expect(view.frame()).toContain("Import protocol");
    expect(view.frame()).toContain("Stealth TLS endpoint");
  });

  it("starts from initialDraft, reports draft edits, and brackets numeric editing", async () => {
    const config = defaultPlusConfig();
    const initialDraft = defaultPlusConfig();
    initialDraft.backendSettings.maxDownloads = 1;
    initialDraft.network.mode = "vpn";
    const drafts: PlusConfig[] = [];
    const editing: boolean[] = [];
    const view = mount(props({ config, initialDraft, onDraftChange: draft => drafts.push(draft), onEditingChange: value => editing.push(value) }));
    await settle();
    expect(drafts.at(-1)?.backendSettings.maxDownloads).toBe(1);
    expect(drafts.at(-1)?.network.mode).toBe("vpn");
    await moveDown(view, 4);
    await press(view, "\r");
    expect(editing.at(-1)).toBe(true);
    await press(view, "2");
    await press(view, "\r");
    expect(drafts.at(-1)?.backendSettings.maxDownloads).toBe(12);
    expect(editing.at(-1)).toBe(false);
  });

  it("merges an external network change without losing the draft or active field text", async () => {
    const saved = vi.fn(async (_config: PlusConfig) => {});
    function ParentFixture() {
      const [config, setConfig] = useState<PlusConfig>(() => ({ ...defaultPlusConfig(), network: { mode: "direct" } }));
      const [externalChangeQueued, setExternalChangeQueued] = useState(false);
      const onDraftChange = (draft: PlusConfig) => {
        if (draft.backendSettings.maxDownloads === 7 && !externalChangeQueued) {
          setExternalChangeQueued(true);
        }
      };
      useEffect(() => {
        if (!externalChangeQueued) return;
        const timer = setTimeout(() => setConfig(old => ({ ...old, network: { mode: "vpn", profileId: "externally-selected" } })), 500);
        return () => clearTimeout(timer);
      }, [externalChangeQueued]);
      return <PlusSettings {...props({ config, onDraftChange, onSave: saved })} />;
    }
    const view = renderUI(<ParentFixture />, { cols: 80, rows: 20 });
    mounted.push(view);

    await moveDown(view, 4);
    await press(view, "\r");
    await press(view, "\u0015");
    await press(view, "7");
    await press(view, "\r");
    await press(view, "\u001b[A");
    await press(view, "\r");
    await press(view, "\u0015");
    await press(view, "/tmp/in-progress-path");
    expect(view.frame()).toContain("/tmp/in-progress-path▏");

    await new Promise(resolve => setTimeout(resolve, 600));
    expect(view.frame()).toContain("/tmp/in-progress-path▏");
    await press(view, "\r");
    await press(view, "s");
    expect(saved).toHaveBeenCalledWith(expect.objectContaining({
      network: { mode: "vpn", profileId: "externally-selected" },
      backendSettings: expect.objectContaining({ maxDownloads: 7 }),
      downloadDir: "/tmp/in-progress-path",
    }));
  });

  it("filters invalid text while accepting numeric input", async () => {
    const drafts: PlusConfig[] = [];
    const initialDraft = defaultPlusConfig();
    initialDraft.backendSettings.maxDownloads = 6;
    const view = mount(props({ initialDraft, onDraftChange: draft => drafts.push(draft) }));
    await moveDown(view, 4);
    await press(view, "\r");
    await press(view, "x.");
    await press(view, "7");
    await press(view, ".");
    expect(view.frame()).toContain("6.7▏");
    await press(view, "\r");
    expect(drafts.at(-1)?.backendSettings.maxDownloads).toBe(6.7);
  });

  it("keeps the caret visible in long fields and supports cursor movement, Ctrl+U, and save", async () => {
    const initialDraft = defaultPlusConfig();
    initialDraft.downloadDir = "/home/user/Documents/a/very/long/download/path/ending-0123456789";
    const drafts: PlusConfig[] = [];
    const onSave = vi.fn(async (_config: PlusConfig) => {});
    const view = mount(props({ width: 48, height: 18, initialDraft, onDraftChange: draft => drafts.push(draft), onSave }), 48, 18);
    await moveDown(view, 3);
    await press(view, "\r");
    expect(view.frame()).toContain("0123456789▏");
    await press(view, "\u001b[H");
    await press(view, "X");
    await press(view, "\u001b[C");
    await press(view, "\u007f");
    expect(view.frame()).toContain("X▏home");
    await press(view, "\u001b[H");
    await press(view, "\u001b[3~");
    expect(view.frame()).toContain("▏home");
    await press(view, "\u001b[F");
    await press(view, "\u001b[D");
    await press(view, "\u001b[C");
    expect(view.frame()).toContain("0123456789▏");
    await press(view, "\u0015");
    expect(view.frame()).toContain("▏");
    expect(view.frame()).not.toContain("0123456789");
    await press(view, "\r");
    expect(drafts.at(-1)?.downloadDir).toBe("");
    await press(view, "s");
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ downloadDir: "" }));
  });

  it("signals editing end when cancelled and when unmounted during an edit", async () => {
    const editing: boolean[] = [];
    const view = mount(props({ onEditingChange: value => editing.push(value) }));
    await moveDown(view, 4);
    await press(view, "\r");
    expect(editing.at(-1)).toBe(true);
    await press(view, "\u001b");
    expect(editing.at(-1)).toBe(false);
    await press(view, "\r");
    expect(editing.at(-1)).toBe(true);
    view.unmount();
    expect(editing.at(-1)).toBe(false);
  });

  it("keeps profile passwords masked in the Advanced tab while editing", async () => {
    const view = mount(props({ width: 60, height: 18 }), 60, 18);
    await press(view, "a");
    await moveDown(view, 5);
    await press(view, "\r");
    await press(view, "sensitive-value");
    expect(view.frame()).not.toContain("sensitive-value");
    expect(view.frame()).toContain("•••••••••••••••");
  });

  it.each([[32, 12], [48, 18], [80, 20]])("fits a %ix%i settings panel within its terminal", (width, height) => {
    const view = mount(props({ width, height }), width, height);
    const lines = view.frame().split("\n");
    expect(lines.length).toBeLessThanOrEqual(height);
    expect(lines.every(line => line.length <= width)).toBe(true);
  });
});
