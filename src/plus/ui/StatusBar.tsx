import { Box, Text } from "ink";
import type { AppState } from "../client";
import type { BackendKind } from "../contracts";
import { COLOR } from "../../ui/theme";
import { cleanText, formatBytesPerSec, truncate } from "../../util/format";

export function StatusBar({ state, offline, busy, notice, width, backend, inputMode = "none" }: {
  state?: AppState; offline: boolean; busy: boolean; notice: string; width: number; backend: BackendKind; inputMode?: "search" | "results" | "setting" | "palette" | "none";
}) {
  const route = offline ? "Unavailable" : state?.snapshot.route.state ?? "Connecting";
  const services = state?.services ?? [];
  const healthy = services.filter(s => s.state === "healthy").length;
  const failed = services.filter(s => s.state !== "healthy");
  const labels: Record<string, string> = { supervisor: "service", controller: "controller", gateway: "gateway", search: "search", qbittorrent: "qB", webtorrent: "WT" };
  const health = offline ? "service offline" : !state ? "starting services" : failed.length ? `${labels[failed[0]!.service]} ${failed[0]!.state}` : `${healthy}/${services.length || 6} healthy`;
  const prefix = `${route} · ${health}`;
  const transfers = state?.snapshot.torrents ?? [];
  const download = transfers.reduce((n, t) => n + (Number.isFinite(t.downloadSpeed) ? t.downloadSpeed : 0), 0);
  const upload = transfers.reduce((n, t) => n + (Number.isFinite(t.uploadSpeed) ? t.uploadSpeed : 0), 0);
  let context = busy ? "Working…" : inputMode === "palette" ? "Command palette" : notice ? cleanText(notice) : state?.config.network.mode === null
    ? "4 Settings: choose VPN or Direct"
    : `${backend === "qbittorrent" ? "qB" : "WT"}${download || upload ? ` · ↓${formatBytesPerSec(download)} ↑${formatBytesPerSec(upload)}` : ` · ${transfers.length} torrents`}`;
  const shortcuts = busy || inputMode === "palette" || (notice && !(inputMode === "results" && /^\d+ results/.test(notice))) || state?.config.network.mode === null ? ""
    : inputMode === "setting" ? width < 60 ? "Enter · Esc" : "Enter apply · Esc cancel · Ctrl+P"
    : width < 60 ? "Ctrl+P commands"
    : inputMode === "results" ? "Ctrl+P · ↵ download · B client"
    : "Ctrl+P commands · 1–5 pages";
  // Route and service failure always get first claim on the only status row.
  const detailRoom = Math.max(0, width - prefix.length - shortcuts.length - (shortcuts ? 6 : 3));
  if (!busy && !notice && inputMode !== "palette" && state?.config.network.mode !== null && context.length > detailRoom) {
    context = `${backend === "qbittorrent" ? "qB" : "WT"} · ${transfers.length} torrent${transfers.length === 1 ? "" : "s"}`;
    if (context.length > detailRoom) context = backend === "qbittorrent" ? "qB" : "WT";
  }
  const detail = detailRoom >= 6 ? ` · ${truncate(context, detailRoom)}` : "";
  let line = `${prefix}${detail}`;
  const room = width - line.length;
  if (shortcuts && room >= shortcuts.length + 3) line += `${" ".repeat(room - shortcuts.length)}${shortcuts}`;
  else if (!detail && (notice || busy || state?.config.network.mode === null)) line += ` · ${truncate(context, Math.max(0, width - line.length - 3))}`;
  line = truncate(line, width).padEnd(width);
  const color = offline || route === "Blocked" ? COLOR.bad : route === "Protected" ? COLOR.good : route === "Direct" ? COLOR.warn : COLOR.alt;
  return <Box width={width} height={1}><Text backgroundColor="#211c2d" wrap="truncate-end"><Text color={color} bold>{route}</Text><Text color={COLOR.alt}>{line.slice(route.length)}</Text></Text></Box>;
}
