import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { BackendCapabilities, BackendKind, FileSnapshot, PieceSnapshot, RouteStatus, TorrentDetails, TorrentSnapshot } from "../contracts";
import { COLOR, ICON } from "../../ui/theme";
import { cleanText, formatBytes, formatBytesPerSec, formatEtaShort, truncate } from "../../util/format";
import { Panel } from "../../ui/components/Panel";
import { PieceMap } from "./Pieces";

export type TorrentAction = "pause" | "resume" | "remove" | "recheck" | "export";
export interface PlusDownloadsProps {
  torrents: TorrentSnapshot[]; route: RouteStatus; width: number; height: number; compact: boolean; showLegend: boolean;
  onCommand: (action: TorrentAction, id: string) => Promise<void>; getDetails: (id: string) => Promise<TorrentDetails>;
  getPieces: (id: string) => Promise<PieceSnapshot | null>; pieceRefreshMs?: number; seedingOnly?: boolean;
  capabilities?: Partial<Record<BackendKind, BackendCapabilities>>; active?: boolean;
  onSelectionChange?: (torrent: TorrentSnapshot | undefined) => void;
  detailsToggle?: number;
}

function elapsed(added?: number): string {
  if (!added || !Number.isFinite(added)) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - added) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}
function pct(n: number): string { return Number.isFinite(n) ? `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%` : "?"; }
function fileLine(file: FileSnapshot, width: number): string {
  const done = file.downloaded ?? (file.progress === undefined ? undefined : file.progress * file.size);
  const tail = `${done === undefined ? "?" : pct(file.size ? done / file.size : 0)}  ${file.size > 0 ? formatBytes(file.size) : "unknown size"}`;
  return truncate(`${cleanText(file.path)}  ${tail}`, width);
}

const STATE_LABEL: Record<TorrentSnapshot["state"], string> = {
  metadata: "Metadata", checking: "Checking", queued: "Queued", downloading: "Downloading",
  paused: "Paused", seeding: "Seeding", completed: "Complete", failed: "Failed",
};

function stateColor(state: TorrentSnapshot["state"]): string {
  if (state === "failed") return COLOR.bad;
  if (state === "seeding" || state === "completed") return COLOR.good;
  if (state === "paused" || state === "queued") return COLOR.warn;
  return COLOR.text;
}
function stateIcon(state: TorrentSnapshot["state"]): string {
  if (state === "failed") return ICON.error;
  if (state === "seeding" || state === "completed") return ICON.up;
  if (state === "paused") return ICON.pause;
  if (state === "downloading") return ICON.down;
  return ICON.pending;
}

export function PlusDownloads({ torrents, route: _route, width, height, compact, showLegend, onCommand, getDetails, getPieces, pieceRefreshMs = 2000, seedingOnly = false, capabilities, active = true, onSelectionChange, detailsToggle }: PlusDownloadsProps) {
  const list = useMemo(() => seedingOnly ? torrents.filter(t => t.state === "seeding" || t.state === "completed" || t.state === "paused" && t.progress >= 1) : torrents, [torrents, seedingOnly]);
  const [cursor, setCursor] = useState(0), [expanded, setExpanded] = useState(false), [detailScroll, setDetailScroll] = useState(0);
  const index = Math.min(cursor, Math.max(0, list.length - 1));
  const selected = list[index];
  const [pieces, setPieces] = useState<Record<string, PieceSnapshot | null | undefined>>({});
  const [details, setDetails] = useState<TorrentDetails | null>(null), [detailsFor, setDetailsFor] = useState(""), [detailError, setDetailError] = useState("");
  const [commandError, setCommandError] = useState("");
  const pieceBusy = useRef(false), detailBusy = useRef(false), commandBusy = useRef(false);
  const commandRef = useRef(onCommand), detailsRef = useRef(getDetails), piecesRef = useRef(getPieces);
  commandRef.current = onCommand; detailsRef.current = getDetails; piecesRef.current = getPieces;
  const selectionCallback = useRef(onSelectionChange), lastSelection = useRef<string | undefined>(undefined);
  const selectionInitialized = useRef(false);
  const detailsToggleRef = useRef(detailsToggle);
  const detailsToggleInitialized = useRef(false);
  selectionCallback.current = onSelectionChange;

  const w = Math.max(10, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const narrow = w < 70;
  const compactWide = compact && w >= 90;
  const inner = Math.max(1, w - 6);
  const mapWidth = compactWide ? 8 : Math.max(1, Math.min(42, Math.floor(Math.max(1, inner - 10) / 2)));
  const rowsPerTorrent = compactWide ? 2 : narrow ? 5 : 3;
  const footerRows = 1 + (showLegend && h >= 15 ? 1 : 0) + (commandError ? 1 : 0);
  const contentBudget = Math.max(1, h - 5 - footerRows);
  const visibleCount = expanded ? 1 : Math.max(1, Math.floor(contentBudget / rowsPerTorrent));
  const start = Math.max(0, Math.min(index - Math.floor(visibleCount / 2), list.length - visibleCount));
  const visible = list.slice(start, start + visibleCount);
  const visibleIds = visible.map(t => t.id);
  const detailRoom = Math.max(0, h - 5 - rowsPerTorrent - footerRows);
  const detailPageRows = Math.max(1, detailRoom - 2);

  const selectedDetails = selected && detailsFor === selected.id && details ? [
    `Files ${details.files.length}   Trackers ${details.trackers.length}   Pieces ${pieces[selected.id]?.states.filter(s => s === "verified").length ?? "?"}/${pieces[selected.id]?.states.length ?? "?"}`,
    `Uploaded ${formatBytes(selected.uploaded)}   Ratio ${selected.ratio === undefined ? "unknown" : selected.ratio.toFixed(2)}`,
    `Elapsed ${elapsed(selected.addedAt)}`,
    `Path ${cleanText(selected.savePath || "unknown")}`,
    ...(selected.error ? [`Error: ${cleanText(selected.error)}`] : []),
    ...details.files.map(file => fileLine(file, inner)),
    ...details.trackers.map(tracker => truncate(cleanText(`${tracker.status ?? "Tracker"}: ${tracker.message ?? tracker.url}`), inner)),
  ] : [];

  useEffect(() => {
    const id = selected?.id;
    if (!selectionInitialized.current) {
      selectionInitialized.current = true;
      lastSelection.current = id;
      selectionCallback.current?.(selected);
      return;
    }
    if (id !== lastSelection.current) {
      selectionCallback.current?.(selected);
      lastSelection.current = id;
    } else if (selected) {
      // These fields are the live values consumed by the global command palette.
      selectionCallback.current?.(selected);
    }
  }, [selected?.id, selected?.state, selected?.progress]);

  useEffect(() => {
    if (!detailsToggleInitialized.current) {
      detailsToggleInitialized.current = true;
      detailsToggleRef.current = detailsToggle;
      return;
    }
    if (detailsToggle !== detailsToggleRef.current) {
      detailsToggleRef.current = detailsToggle;
      setExpanded(value => !value);
    }
  }, [detailsToggle]);

  useInput((input, key) => {
    if (key.ctrl || key.meta) return;
    if (expanded && key.pageUp) setDetailScroll(v => Math.max(0, v - detailPageRows));
    else if (expanded && key.pageDown) setDetailScroll(v => Math.min(Math.max(0, selectedDetails.length - detailPageRows), v + detailPageRows));
    else if (key.upArrow || input === "k") setCursor(v => Math.max(0, v - 1));
    else if (key.downArrow || input === "j") setCursor(v => Math.min(list.length - 1, v + 1));
    else if ((key.return || input === "\r") && selected) setExpanded(v => !v);
    else if (selected && !commandBusy.current) {
      const caps = capabilities?.[selected.backend];
      let action: TorrentAction | undefined;
      if (input === "p") action = selected.state === "paused" || selected.state === "completed" ? "resume" : "pause";
      else if (input === "x" || key.delete) action = "remove";
      else if (input === "r" && caps?.recheck !== false) action = "recheck";
      else if (input === "e" && caps?.export !== false) action = "export";
      if (action) {
        commandBusy.current = true;
        setCommandError("");
        void commandRef.current(action, selected.id)
          .catch(e => setCommandError(e instanceof Error ? e.message : `${action} failed`))
          .finally(() => { commandBusy.current = false; });
      }
    }
  }, { isActive: active && list.length > 0 });

  // Keep polling only the currently visible window, on a trailing 2-second timer.
  useEffect(() => {
    if (!active) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (cancelled) return;
      if (!pieceBusy.current) {
        pieceBusy.current = true;
        try {
          await Promise.all(visibleIds.map(async id => {
            try { const value = await piecesRef.current(id); if (!cancelled) setPieces(old => ({ ...old, [id]: value })); }
            catch { if (!cancelled) setPieces(old => ({ ...old, [id]: undefined })); }
          }));
        } finally { pieceBusy.current = false; }
      }
      if (!cancelled) timer = setTimeout(poll, Math.max(1, pieceRefreshMs));
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [visibleIds.join("\0"), pieceRefreshMs, active]);

  useEffect(() => {
    setDetails(null); setDetailsFor(""); setDetailError(""); setDetailScroll(0);
  }, [expanded, selected?.id]);

  useEffect(() => {
    if (!active || !expanded || !selected) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!detailBusy.current) {
        detailBusy.current = true;
        try { const result = await detailsRef.current(selected.id); if (!cancelled) { setDetails(result); setDetailsFor(selected.id); setDetailError(""); } }
        catch (e) { if (!cancelled) { setDetails(null); setDetailError(e instanceof Error ? e.message : "Details unavailable"); } }
        finally { detailBusy.current = false; }
      }
      if (!cancelled) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [active, expanded, selected?.id]);

  const title = seedingOnly ? "seeding" : "downloads";
  if (!list.length) {
    return <Panel title={title} width={w} focused height={Math.max(1, h - 1)}>
      <Text color={COLOR.text}>{seedingOnly ? "Nothing seeding yet." : "No downloads yet."}</Text>
      <Text dimColor>{seedingOnly ? "Completed torrents that remain active will show here." : "1 Search · Enter a result to download."}</Text>
      {!seedingOnly ? <Text dimColor>i import a magnet link or .torrent path.</Text> : null}
    </Panel>;
  }

  const legend = showLegend && h >= 15 ? "· missing  ! active  █ verified  ? unknown" : "";
  const hints = w < 60
    ? expanded ? "Delete/x remove Enter close PgUp/Dn ↑↓move" : "Delete/x remove Enter info ↑↓move"
    : expanded ? "Delete/x remove  Enter close  PgUp/PgDn details  ↑/k ↓/j move"
      : selected?.state === "paused" || selected?.state === "completed"
        ? "Delete/x remove  Enter details  ↑/k ↓/j move  p resume  r recheck  e export"
        : "Delete/x remove  Enter details  ↑/k ↓/j move  p pause  r recheck  e export";
  const bodyHeight = Math.max(1, h - 1);

  return <Panel title={title} width={w} focused height={bodyHeight} count={`${list.length}`}>
    {visible.map((torrent, i) => {
      const actual = start + i, chosen = actual === index;
      const map = pieces[torrent.id];
      const name = cleanText(torrent.name || "(metadata pending)");
      const state = STATE_LABEL[torrent.state];
      const backend = torrent.backend === "qbittorrent" ? "qBittorrent" : "WebTorrent";
      const downloaded = formatBytes(torrent.downloaded);
      const total = torrent.total > 0 ? formatBytes(torrent.total) : "unknown";
      const down = torrent.downloadSpeed === undefined || !Number.isFinite(torrent.downloadSpeed) ? "unknown" : formatBytesPerSec(torrent.downloadSpeed) || "0 B/s";
      const up = torrent.uploadSpeed === undefined || !Number.isFinite(torrent.uploadSpeed) ? "unknown" : formatBytesPerSec(torrent.uploadSpeed) || "0 B/s";
      const eta = formatEtaShort(torrent.etaSeconds) || "unknown";
      const peers = torrent.peers === undefined ? "unknown peers" : `${torrent.peers} peers`;
      const statsWide = `${downloaded} / ${total}  ↓ ${down}  ↑ ${up}  ETA ${eta}  ${peers}`;
      const statsCompactWide = `${downloaded}/${total} ↓${down} ↑${up} ETA ${eta} ${peers} ${pct(torrent.progress)}`;
      const statsNarrow = `${downloaded}/${total}  ↓ ${down}`;
      const icon = stateIcon(torrent.state);
      const sc = stateColor(torrent.state);
      const marker = chosen ? ICON.pointer : " ";
      const suffixWidth = backend.length + state.length + 3;
      const fileRoom = Math.max(1, inner - 6 - (narrow ? 0 : suffixWidth));
      const detailsForThis = chosen && expanded;
      const showDetailLines = detailsForThis ? Math.max(0, detailRoom - 2) : 0;
      return <Box key={torrent.id} flexDirection="column" width={inner}>
        <Box width={inner}>
          <Text color={chosen ? COLOR.accent : "#6b6577"} bold={chosen}>{marker} </Text>
          <Text color={sc}>{icon} </Text>
          <Text bold={chosen} color={chosen ? COLOR.accent : COLOR.text} wrap="truncate-end">{truncate(name, fileRoom)}</Text>
          {!narrow ? <Text color={sc} dimColor={!chosen}>  {backend} · {state}</Text> : null}
        </Box>
        {narrow ? <Box width={inner}><Text dimColor>   </Text><Text color={sc}>{backend} · {state} · {pct(torrent.progress)}</Text></Box> : null}
        {compactWide ? <Box width={inner}>
          <Text dimColor>   {truncate(statsCompactWide, Math.max(1, inner - mapWidth * 2 - 5))}  </Text>
          {map === undefined ? <Text color={torrent.error ? COLOR.warn : COLOR.alt} dimColor={!torrent.error}>{torrent.error ? "Piece map unavailable" : "Loading piece map…"}</Text> : <PieceMap pieces={map} width={mapWidth} />}
        </Box> : narrow ? <>
          <Box width={inner}><Text dimColor>   {truncate(statsNarrow, inner - 3)}</Text></Box>
          <Box width={inner}><Text dimColor>   {truncate(`↑ ${up}  ETA ${eta}  ${peers}`, inner - 3)}</Text></Box>
        </> : <Box width={inner}><Text dimColor>   {truncate(statsWide, inner - 3)}</Text></Box>}
        {!compactWide ? <Box width={inner}><Text dimColor>   </Text>{map === undefined
          ? <Text color={torrent.error ? COLOR.warn : COLOR.alt} dimColor={!torrent.error}>{torrent.error ? "Piece map unavailable" : "Loading piece map…"}</Text>
          : <PieceMap pieces={map} width={mapWidth} />}{!narrow ? <Text dimColor>  {pct(torrent.progress)}</Text> : null}</Box> : null}
        {detailsForThis ? <Box flexDirection="column" width={inner}>
          <Panel title="torrent details" width={Math.max(10, inner)} focused={false} height={Math.max(2, showDetailLines + 2)}>
            {detailError ? <Text color={COLOR.warn}>{truncate(`Details unavailable: ${cleanText(detailError)}`, inner - 4)}</Text>
              : detailsFor !== torrent.id ? <Text dimColor>Loading details…</Text>
              : selectedDetails.slice(detailScroll, detailScroll + showDetailLines).map((line, li) => <Text key={detailScroll + li} dimColor wrap="truncate-end">{truncate(line, inner - 4)}</Text>)}
          </Panel>
        </Box> : null}
      </Box>;
    })}
    {commandError ? <Text color={COLOR.bad} wrap="truncate-end">{truncate(`Command failed: ${cleanText(commandError)}`, inner)}</Text> : null}
    {legend ? <Text dimColor>{truncate(legend, inner)}</Text> : null}
    <Text color={COLOR.alt} dimColor>{truncate(hints, inner)}</Text>
  </Panel>;
}

export default PlusDownloads;
