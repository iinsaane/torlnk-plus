import { useCallback, useEffect, useState, useRef } from "react";
import { Box, Text, useInput, useApp, useStdout } from "ink";
import { promises as fs } from "node:fs";
import path from "node:path";
import { PlusSettings } from "../../ui/Settings";
import { Logo } from "../../ui/components/Logo";
import { Panel } from "../../ui/components/Panel";
import { PlusDownloads, type TorrentAction } from "./Downloads";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";
import { PlusSearch } from "./Search";
import { StatusBar } from "./StatusBar";
import { COLOR } from "../../ui/theme";
import { cleanText, stripControl, truncate } from "../../util/format";
import { insertAt, deleteAt, deleteBefore, deleteWordBefore, deleteWordAfter, wordLeft, wordRight } from "../../ui/components/TextField";
import { parseInput } from "../../sources/magnet";
import { resolveTorrentPath } from "../../sources/torrentPath";
import { writeClipboard } from "../../util/clipboard";
import type { TorrentResult } from "../../sources/types";
import type { JsonClient } from "../http";
import type { AppState } from "../client";
import type { PlusConfig } from "../config";
import type { BackendKind, TorrentDetails, PieceSnapshot, TorrentSnapshot } from "../contracts";
import type { SearchResponse } from "../search";

type Page = "search" | "downloads" | "seeding" | "settings" | "health";
const PAGES: Page[] = ["search", "downloads", "seeding", "settings", "health"];
const PAGE_NAMES = { search: "Search", downloads: "Downloads", seeding: "Seeding", settings: "Settings", health: "Health" };

export function PlusApp({ client, initial }: { client: JsonClient; initial?: string }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [size, setSize] = useState({ width: stdout.columns || 80, height: stdout.rows || 24 });
  const [state, setState] = useState<AppState>();
  const [offline, setOffline] = useState(false);
  const [page, setPage] = useState<Page>("search");
  const [home, setHome] = useState(true);
  const [notice, setNotice] = useState("");
  const [input, setInput] = useState({ kind: "search" as "search" | "import", value: "", caret: 0 });
  const [searchFocused, setSearchFocused] = useState(true);
  const [explicitCapture, setExplicitCapture] = useState(false);
  const [results, setResults] = useState<TorrentResult[]>([]);
  const [cursor, setCursor] = useState(0);
  const [backend, setBackend] = useState<BackendKind>();
  const [busy, setBusy] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [selectedTorrentId, setSelectedTorrentId] = useState<string>();
  const [detailsToggle, setDetailsToggle] = useState(0);
  const torrentCommandBusy = useRef(false);
  const onTorrentSelection = useCallback((torrent: TorrentSnapshot | undefined) => setSelectedTorrentId(torrent?.id), []);
  const [settingsEditing, setSettingsEditing] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<PlusConfig>();
  const launched = useRef(false), polling = useRef(false);

  const refresh = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try { const next = await client.request<AppState>("/state"); setState(next); setOffline(false); return next; }
    catch { setOffline(true); }
    finally { polling.current = false; }
  }, [client]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), state?.config.display.refreshMs ?? 1000);
    return () => clearInterval(timer);
  }, [refresh, state?.config.display.refreshMs]);
  useEffect(() => {
    const resize = () => setSize({ width: stdout.columns || 80, height: stdout.rows || 24 });
    stdout.on("resize", resize);
    return () => { stdout.off("resize", resize); };
  }, [stdout]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 8000); return () => clearTimeout(timer); }, [notice]);

  function navigate(next: Page) {
    setPage(next); setSettingsEditing(false); setExplicitCapture(false);
    setSearchFocused(next === "search" && !input.value && results.length === 0);
    if (next === "search") { setHome(results.length === 0); setInput(old => ({ ...old, kind: "search" })); }
  }
  async function act(fn: () => Promise<unknown>, success = "") {
    setBusy(true);
    try { await fn(); if (success) setNotice(success); await refresh(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Action failed"); }
    finally { setBusy(false); }
  }
  async function add(source: string, name?: string) {
    if (!state) return;
    const parsed = parseInput(source);
    const torrentBase64 = parsed ? undefined : (await fs.readFile(resolveTorrentPath(source) ?? source)).toString("base64");
    await client.request("/command", { action: "add", input: {
      ...(parsed ? { magnet: parsed.magnet } : { torrentBase64 }), name: name ?? parsed?.name,
      backend: backend ?? state.config.defaultBackend, savePath: state.config.downloadDir,
    } });
    setBackend(undefined); setHome(false); navigate("downloads");
  }
  function submit(value: string) {
    if (busy) return;
    if (!state) { setNotice("Connecting to background service…"); return; }
    const query = value.trim();
    setHome(false); setSearchFocused(false); setExplicitCapture(false);
    void act(async () => {
      if (input.kind === "import" || parseInput(query) || resolveTorrentPath(query)) { await add(query); setNotice("Torrent added"); }
      else {
        const response = await client.request<SearchResponse>("/search", { query });
        setResults(response.results); setCursor(0);
        setNotice(response.errors.length ? `${response.results.length} results · ${response.errors.length} sources unavailable` : `${response.results.length} results`);
      }
    });
  }
  useEffect(() => {
    if (!state || !initial || launched.current || !["Direct", "Protected"].includes(state.snapshot.route.state)) return;
    launched.current = true; void act(() => add(initial), "Torrent added");
  }, [state?.snapshot.route.state]);

  useInput((value, key) => {
    if (key.ctrl && (value === "c" || value === "q")) { exit(); return; }
    if (key.ctrl && value === "p") { if (!paletteOpen) setPaletteOpen(true); return; }
    if (paletteOpen) return;
    const capturingSearch = page === "search" && searchFocused && (explicitCapture || Boolean(input.value) || input.kind === "import");
    if (value === ":" && !settingsEditing && (page !== "search" || !searchFocused)) { setPaletteOpen(true); return; }
    // Page navigation is global outside text editors. Actual text keeps digits.
    if (!settingsEditing && !capturingSearch && /^[1-5]$/.test(value)) { navigate(PAGES[Number(value) - 1]!); return; }
    if (page === "settings") return;
    const commandMode = page !== "search" || !searchFocused;
    if (commandMode && value === "q") { exit(); return; }
    if (commandMode && value === "v" && state && !busy) {
      void act(async () => {
        await client.request("/route", { mode: state.config.network.mode === "vpn" ? "direct" : "vpn", profileId: state.config.network.profileId });
        setSettingsDraft(undefined);
      }, "Routing changed"); return;
    }
    if ((!capturingSearch || !searchFocused) && value === "/") {
      setPage("search"); setInput({ kind: "search", value: "", caret: 0 }); setSearchFocused(true); setExplicitCapture(true); return;
    }
    if (commandMode && value === "i") {
      setPage("search"); setInput({ kind: "import", value: "", caret: 0 }); setSearchFocused(true); setExplicitCapture(true); return;
    }
    if (commandMode && value === "b" && page === "search") {
      const next = (backend ?? state?.config.defaultBackend) === "qbittorrent" ? "webtorrent" : "qbittorrent";
      setBackend(next); setNotice(`Next download: ${next === "qbittorrent" ? "qBittorrent" : "WebTorrent"}`); return;
    }
    if (page !== "search") return;
    if (key.escape) {
      if (searchFocused) { setSearchFocused(false); setExplicitCapture(false); }
      else { setHome(true); setInput({ kind: "search", value: "", caret: 0 }); setSearchFocused(true); }
      return;
    }
    if (searchFocused) {
      if (key.tab || key.downArrow) {
        setSearchFocused(false); setExplicitCapture(false);
        if (home && input.kind === "search") submit(input.value);
        return;
      }
      if (key.return) { submit(input.value); return; }
      if (key.leftArrow || key.rightArrow) {
        setInput(old => ({ ...old, caret: key.leftArrow ? key.ctrl || key.meta ? wordLeft(old.value, old.caret) : Math.max(0, old.caret - 1) : key.ctrl || key.meta ? wordRight(old.value, old.caret) : Math.min(old.value.length, old.caret + 1) })); return;
      }
      if (key.home || key.end) { setInput(old => ({ ...old, caret: key.home ? 0 : old.value.length })); return; }
      const edit = (next: { value: string; cursor: number }) => { setInput({ ...input, value: next.value, caret: next.cursor }); setExplicitCapture(true); };
      if (key.backspace) { edit(key.ctrl || key.meta ? deleteWordBefore(input.value, input.caret) : deleteBefore(input.value, input.caret)); return; }
      if (key.delete) { edit(key.ctrl || key.meta ? deleteWordAfter(input.value, input.caret) : deleteAt(input.value, input.caret)); return; }
      if (key.ctrl) {
        if (value === "u") edit({ value: "", cursor: 0 });
        else if (value === "w") edit(deleteWordBefore(input.value, input.caret));
        else if (value === "a") setInput({ ...input, caret: 0 });
        else if (value === "e") setInput({ ...input, caret: input.value.length });
        return;
      }
      if (!key.meta && value) {
        const text = value.replace(/\x1b\[20[01]~/g, "").replace(/[\r\n]+/g, "");
        const safe = stripControl(text);
        if (safe) edit(insertAt(input.value, input.caret, safe));
      }
      return;
    }
    if (key.tab) { setSearchFocused(true); setExplicitCapture(true); return; }
    if (key.upArrow || value === "k") setCursor(v => Math.max(0, v - 1));
    if (key.downArrow || value === "j") setCursor(v => Math.min(Math.max(0, results.length - 1), v + 1));
    if (key.return && results[cursor] && !busy) { const item = results[cursor]!; void act(() => add(item.magnet, item.name), "Torrent added"); }
    if (value === "m" && results[cursor]) void act(() => writeClipboard(results[cursor]!.magnet), "Magnet copied");
  });

  const width = Math.max(10, size.width - 2), totalHeight = Math.max(4, size.height - 1);
  const splash = page === "search" && home;
  const headerHeight = splash ? 0 : size.height < 18 ? 1 : 4;
  const bodyHeight = Math.max(1, totalHeight - headerHeight - 1);
  const services = state?.services ?? [];
  async function command(action: TorrentAction, id: string) {
    if (!state) throw new Error("Background service is not ready");
    if (torrentCommandBusy.current) throw new Error("A torrent action is already running");
    torrentCommandBusy.current = true; setBusy(true);
    try {
      if (action === "export") {
        const base64 = await client.request<string>("/command", { action, id });
        const destination = path.join(state.config.downloadDir, `${id}.torrent`);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, Buffer.from(base64, "base64"), { flag: "wx" }); setNotice(`Exported ${destination}`);
      } else {
        await client.request("/command", { action, id, ...(action === "remove" ? { deleteData: false } : {}) });
        if (action === "remove") setNotice("Removed · files kept");
      }
      await refresh();
    } finally { torrentCommandBusy.current = false; setBusy(false); }
  }
  const selectedTorrent = page === "downloads" || page === "seeding" ? state?.snapshot.torrents.find(t => t.id === selectedTorrentId && (page === "downloads" || t.state === "seeding" || t.state === "completed" || t.state === "paused" && t.progress >= 1)) : undefined;
  const unavailable = !state || offline ? "Background service is unavailable" : busy ? "An action is running" : undefined;
  const torrentDisabled = unavailable ?? (selectedTorrent ? undefined : "Select an entry in Downloads or Seeding");
  const pauseAction = selectedTorrent?.state === "paused" || selectedTorrent?.state === "completed" ? "resume" : "pause";
  const selectedCaps = selectedTorrent && state?.capabilities[selectedTorrent.backend];
  function newSearch(kind: "search" | "import" = "search") {
    setPage("search"); setHome(true); setInput({ kind, value: "", caret: 0 }); setSearchFocused(true); setExplicitCapture(true);
  }
  function toggleRoute() {
    if (!state) return;
    void act(async () => {
      await client.request("/route", { mode: state.config.network.mode === "vpn" ? "direct" : "vpn", profileId: state.config.network.profileId });
      setSettingsDraft(undefined);
    }, "Routing changed");
  }
  function chooseBackend(kind: BackendKind) { setBackend(kind); setNotice(`Next download: ${kind === "qbittorrent" ? "qBittorrent" : "WebTorrent"}`); }
  const paletteCommands: Array<PaletteCommand & { run: () => void }> = [
    ...PAGES.map((target, i) => ({ id: `page-${target}`, label: `Go to ${PAGE_NAMES[target]}`, shortcut: String(i + 1), run: () => navigate(target) })),
    { id: "new-search", label: "New search", description: "Search titles or paste a magnet link", shortcut: "/", run: () => newSearch() },
    { id: "import", label: "Import torrent", description: "Paste a magnet link or the path to a .torrent file", shortcut: "I", run: () => newSearch("import") },
    { id: "backend-qbit", label: "Next download: qBittorrent", description: "Use qBittorrent for the next added torrent", keywords: "client backend", run: () => chooseBackend("qbittorrent") },
    { id: "backend-wt", label: "Next download: WebTorrent", description: "Use WebTorrent for the next added torrent", keywords: "client backend", run: () => chooseBackend("webtorrent") },
    { id: "vpn-toggle", label: state?.config.network.mode === "vpn" ? "Turn VPN off (Direct)" : "Turn VPN on", description: "Switch routing for searches and both torrent clients", shortcut: "V", disabled: unavailable ?? (state?.config.network.mode !== "vpn" && !state?.config.network.profileId ? "Import and select a VPN profile in Settings first" : undefined), run: toggleRoute },
    { id: "reconnect", label: "Reconnect services", description: "Recreate workers using the selected routing mode", disabled: unavailable ?? (state?.config.network.mode === null ? "Choose routing in Settings first" : undefined), run: () => { if (state) void act(() => client.request("/route", { mode: state.config.network.mode, profileId: state.config.network.profileId }), "Reconnected"); } },
    { id: "refresh", label: "Refresh service health", description: "Update service and transfer status", run: () => { void refresh(); } },
    { id: "details", label: "Show / hide torrent details", description: "Files, trackers, piece counts and transfer history", shortcut: "Enter", disabled: torrentDisabled, run: () => setDetailsToggle(v => v + 1) },
    { id: "pause", label: `${pauseAction === "pause" ? "Pause" : "Resume"} selected torrent`, description: selectedTorrent?.name, shortcut: "P", disabled: torrentDisabled, run: () => { if (selectedTorrent) void act(() => command(pauseAction, selectedTorrent.id)); } },
    { id: "remove", label: "Remove selected entry", description: "Keep files; stop transfer and remove entry.", keywords: "delete download seed torrent", shortcut: "Delete / X", disabled: torrentDisabled, run: () => { if (selectedTorrent) void act(() => command("remove", selectedTorrent.id)); } },
    { id: "recheck", label: "Recheck selected torrent", description: "Verify downloaded pieces against the torrent", shortcut: "R", disabled: torrentDisabled ?? (selectedCaps?.recheck === false ? "This backend does not support rechecking" : undefined), run: () => { if (selectedTorrent) void act(() => command("recheck", selectedTorrent.id)); } },
    { id: "export", label: "Export selected torrent", description: "Save its .torrent metadata in the download folder", shortcut: "E", disabled: torrentDisabled ?? (selectedCaps?.export === false ? "This backend does not support metadata export" : undefined), run: () => { if (selectedTorrent) void act(() => command("export", selectedTorrent.id)); } },
    { id: "close", label: "Close interface", description: "Downloads and seeds continue in the background", shortcut: "Ctrl+Q", run: exit },
  ];
  function selectCommand(id: string) {
    const item = paletteCommands.find(c => c.id === id);
    if (!item || item.disabled) return;
    setPaletteOpen(false); item.run();
  }
  const search = <PlusSearch width={width} height={bodyHeight} home={home} value={input.value} caret={input.caret}
    editing={searchFocused} inputKind={input.kind} busy={busy} results={results} cursor={cursor}
    backend={backend ?? state?.config.defaultBackend ?? "qbittorrent"} onSubmit={submit}
    onChange={value => setInput({ ...input, value, caret: value.length })} onExitDown={() => setSearchFocused(false)} />;
  return <Box flexDirection="column" paddingX={1} width={size.width} height={totalHeight}>
    {!splash && <Box flexDirection="column" height={headerHeight} overflow="hidden">
      {headerHeight > 1 && <Box height={3}><Logo /></Box>}
      <Text wrap="truncate-end">{PAGES.map((name, i) => <Text key={name} color={page === name ? COLOR.accent : COLOR.alt} bold={page === name}>{width < 42 ? ({ search: "1Find", downloads: "2DL", seeding: "3Seed", settings: "4Set", health: "5Health" })[name] : `${i + 1} ${width < 60 ? ({ search: "Search", downloads: "DL", seeding: "Seed", settings: "Set", health: "Health" })[name] : PAGE_NAMES[name]}`}{i < 4 ? width < 42 ? " " : "  " : ""}</Text>)}</Text>
    </Box>}
    <Box height={bodyHeight} width={width} flexDirection="column" overflow="hidden">
      <Box display={paletteOpen ? "none" : "flex"} height={bodyHeight} width={width} flexDirection="column">
      {page === "search" ? search : !state ? <Text dimColor>Connecting to background service…</Text>
        : page === "settings" ? <PlusSettings active={!paletteOpen} config={state.config} initialDraft={settingsDraft} onDraftChange={setSettingsDraft} onEditingChange={setSettingsEditing}
          profiles={state.profiles} capabilities={state.capabilities} width={width} height={bodyHeight}
          onSave={async config => { await client.request("/config", { config }); await refresh(); setSettingsDraft(config); }}
          onImportProfile={async (profilePath, options) => { await client.request("/profiles/import", { path: profilePath, options }); await refresh(); }}
          onRemoveProfile={async id => { await client.request("/profiles/remove", { id }); await refresh(); }}
          onReconnect={async () => { await client.request("/route", { mode: state.config.network.mode, profileId: state.config.network.profileId }); await refresh(); }}
          onStop={async () => { await client.request("/stop", {}); setOffline(true); }} onClose={() => navigate("search")} />
        : page === "downloads" || page === "seeding" ? <PlusDownloads active={!paletteOpen} onSelectionChange={onTorrentSelection} detailsToggle={detailsToggle} torrents={state.snapshot.torrents} route={state.snapshot.route} width={width} height={bodyHeight}
          compact={state.config.display.compact} showLegend={state.config.display.legend} pieceRefreshMs={state.config.display.pieceRefreshMs}
          seedingOnly={page === "seeding"} capabilities={state.capabilities} onCommand={command}
          getDetails={id => client.request<TorrentDetails>("/command", { action: "details", id })}
          getPieces={id => client.request<PieceSnapshot | null>("/command", { action: "pieces", id })} />
        : <Panel title="service health" width={width} height={Math.max(1, bodyHeight - 1)}>
          {services.map(s => <Box key={s.service} flexDirection="column" marginTop={bodyHeight >= services.length * 4 + 2 ? 1 : 0}>
            <Text color={offline || s.state !== "healthy" ? COLOR.warn : COLOR.good}>{s.service} · {offline ? "unavailable" : s.state}</Text>
            {bodyHeight >= services.length * 3 + 2 && <Text dimColor wrap="truncate-end">{truncate(s.message ? cleanText(s.message) : "", width - 4)}</Text>}
            {bodyHeight >= services.length * 2 + 2 && <Text dimColor wrap="truncate-end">{truncate(`Checked ${new Date(s.checkedAt).toLocaleTimeString()} · Last success ${s.lastSuccessAt ? new Date(s.lastSuccessAt).toLocaleTimeString() : "unknown"}`, width - 4)}</Text>}
          </Box>)}
        </Panel>}
      </Box>
      {paletteOpen && <Box width={width} height={bodyHeight} justifyContent="center" alignItems="center"><CommandPalette commands={paletteCommands} width={Math.min(72, width)} height={Math.min(18, bodyHeight)} onSelect={selectCommand} onClose={() => setPaletteOpen(false)} /></Box>}
    </Box>
    <StatusBar inputMode={paletteOpen ? "palette" : settingsEditing ? "setting" : page === "search" && searchFocused ? "search" : page === "search" && !home ? "results" : "none"} state={state} offline={offline} busy={busy} notice={notice} width={width} backend={backend ?? state?.config.defaultBackend ?? "qbittorrent"} />
  </Box>;
}
