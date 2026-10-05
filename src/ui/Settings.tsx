import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { deleteAt, deleteBefore, insertAt } from "./components/TextField";
import { COLOR } from "./theme";
import type { BackendCapabilities, BackendKind, VpnProfileSummary } from "../plus/contracts";
import type { PlusConfig } from "../plus/config";

type Props = {
  config: PlusConfig; profiles: VpnProfileSummary[]; capabilities?: Partial<Record<BackendKind, BackendCapabilities>>;
  onSave: (config: PlusConfig) => Promise<void>;
  onImportProfile: (path: string, options?: { protocol?: "wireguard" | "openvpn" | "stealth"; tlsEndpoint?: string; serverName?: string; provider?: "windscribe" | "custom"; username?: string; password?: string }) => Promise<void>;
  onRemoveProfile: (id: string) => Promise<void>; onReconnect: () => Promise<void>; onStop: () => Promise<void>; onClose: () => void; width: number; height: number;
  active?: boolean;
  initialDraft?: PlusConfig;
  onDraftChange?: (draft: PlusConfig) => void;
  onEditingChange?: (editing: boolean) => void;
};
type Row = { label: string; value: string; tab: "Everyday" | "Advanced"; description?: string; disabled?: string; masked?: boolean; edit?: () => void; cycle?: () => void; action?: () => Promise<void> };
const clone = (config: PlusConfig): PlusConfig => JSON.parse(JSON.stringify(config)) as PlusConfig;
const cursorWindow = (value: string, cursor: number, width: number): string => {
  if (width <= 0) return "";
  const textWidth = Math.max(0, width - 1);
  if (textWidth === 0) return "▏";
  let start = Math.max(0, cursor - Math.floor(textWidth / 2));
  start = Math.min(start, Math.max(0, value.length - textWidth));
  const before = value.slice(start, cursor);
  const after = value.slice(cursor, cursor + Math.max(0, textWidth - before.length));
  return `${before}▏${after}`;
};

export function PlusSettings(props: Props) {
  const [draft, setDraft] = useState(() => clone(props.initialDraft ?? props.config));
  const incomingNetwork = JSON.stringify(props.config.network);
  const previousIncomingNetwork = useRef(incomingNetwork);
  const [tab, setTab] = useState<"Everyday" | "Advanced">("Everyday");
  const [selected, setSelected] = useState(0);
  const [edit, setEdit] = useState<{ value: string; cursor: number; commit: (value: string) => void; numeric?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [profilePath, setProfilePath] = useState("");
  const [protocol, setProtocol] = useState<"wireguard" | "openvpn" | "stealth">("wireguard");
  const [tlsEndpoint, setTlsEndpoint] = useState("");
  const [serverName, setServerName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [provider, setProvider] = useState<"windscribe" | "custom">("windscribe");
  const editingCallback = useRef(props.onEditingChange);
  const draftCallback = useRef(props.onDraftChange);
  useEffect(() => {
    if (previousIncomingNetwork.current === incomingNetwork) return;
    previousIncomingNetwork.current = incomingNetwork;
    const network = JSON.parse(incomingNetwork) as PlusConfig["network"];
    setDraft(old => ({ ...old, network }));
  }, [incomingNetwork]);
  useEffect(() => { editingCallback.current = props.onEditingChange; draftCallback.current = props.onDraftChange; });
  useEffect(() => { draftCallback.current?.(draft); }, [draft]);
  useEffect(() => { editingCallback.current?.(edit !== null); }, [edit !== null]);
  useEffect(() => () => { editingCallback.current?.(false); }, []);
  const update = (f: (c: PlusConfig) => void) => setDraft(old => { const c = clone(old); f(c); return c; });
  const cap = props.capabilities?.[draft.defaultBackend];
  const supports = (key: keyof PlusConfig["backendSettings"]) => cap?.settings.includes(key) ?? true;
  const profiles = props.profiles;
  const rows: Row[] = useMemo(() => {
    const numeric = (label: string, value: number, tab: Row["tab"], commit: (n: number) => void, description?: string): Row => ({ label, value: String(value), tab, description, edit: () => start(String(value), v => { const n = Number(v); if (!Number.isFinite(n)) throw new Error("Enter a valid number."); commit(n); }, true) });
    const text = (label: string, value: string, tab: Row["tab"], commit: (v: string) => void, description?: string): Row => ({ label, value, tab, description, edit: () => start(value, commit) });
    const toggle = (label: string, value: boolean, commit: (b: boolean) => void, tab: Row["tab"] = "Advanced"): Row => ({ label, value: value ? "On" : "Off", tab, cycle: () => commit(!value) });
    const choose = (label: string, value: string, options: string[], commit: (v: string) => void, tab: Row["tab"] = "Everyday"): Row => ({ label, value, tab, cycle: () => { const next = options[(options.indexOf(value) + 1) % options.length]; if (next !== undefined) commit(next); } });
    const backend = (key: keyof PlusConfig["backendSettings"], row: Row): Row => supports(key) ? row : { ...row, disabled: `${draft.defaultBackend} does not support this setting` };
    return [
      choose("Download backend", draft.defaultBackend, ["qbittorrent", "webtorrent"], v => update(c => { c.defaultBackend = v as BackendKind; })),
      { ...choose("Global routing [restart]", draft.network.mode ?? "choose on first run", ["direct", "vpn"], v => update(c => { c.network.mode = v as "direct" | "vpn"; })), description: "Restart required for routing changes. Choose direct or VPN explicitly." },
      { label: "VPN profile [restart]", value: profileLabel(currentProfile()), tab: "Everyday", cycle: () => { const index = profiles.findIndex(p => p.id === draft.network.profileId); const next = profiles[(index + 1) % profiles.length]; if (next) setProfile(next.id); }, description: "Restart required for VPN profile changes." },
      text("Download folder [restart]", draft.downloadDir, "Everyday", v => update(c => { c.downloadDir = v; }), "Restart required after changing the folder."),
      backend("maxDownloads", numeric("Maximum active downloads", draft.backendSettings.maxDownloads, "Everyday", v => update(c => { c.backendSettings.maxDownloads = v; }))),
      backend("downloadLimitKiB", numeric("Download limit (KiB/s, 0 = unlimited)", draft.backendSettings.downloadLimitKiB, "Everyday", v => update(c => { c.backendSettings.downloadLimitKiB = v; }))),
      backend("uploadLimitKiB", numeric("Upload limit (KiB/s, 0 = unlimited)", draft.backendSettings.uploadLimitKiB, "Everyday", v => update(c => { c.backendSettings.uploadLimitKiB = v; }))),
      backend("seedRatio", numeric("Seed ratio threshold (0 = disabled)", draft.backendSettings.seedRatio, "Everyday", v => update(c => { c.backendSettings.seedRatio = v; }))),
      backend("seedTimeMinutes", numeric("Seed time threshold (minutes, 0 = disabled)", draft.backendSettings.seedTimeMinutes, "Everyday", v => update(c => { c.backendSettings.seedTimeMinutes = v; }))),
      backend("completionAction", choose("After completion", draft.backendSettings.completionAction, ["seed", "pause"], v => update(c => { c.backendSettings.completionAction = v as "seed" | "pause"; }))),
      choose("Search category", draft.category, ["all", "games", "movies", "tv", "anime"], v => update(c => { c.category = v as PlusConfig["category"]; })),
      text("Enabled provider IDs (comma separated)", draft.enabledSources.join(","), "Everyday", v => update(c => { c.enabledSources = v.split(",").map(s => s.trim()).filter(Boolean); })),
      numeric("Search timeout (ms)", draft.searchTimeoutMs, "Everyday", v => update(c => { c.searchTimeoutMs = v; })),
      { label: "Restart backend", value: "Reconnect", tab: "Everyday", action: props.onReconnect },
      { label: "Stop background service", value: "Stop", tab: "Everyday", action: props.onStop },
      { label: "Remove selected profile", value: profileLabel(currentProfile()), tab: "Everyday", action: async () => { const p = currentProfile(); if (p) await props.onRemoveProfile(p.id); } },
      text("Import profile path", profilePath, "Advanced", setProfilePath, "Import only profiles you trust."),
      choose("Import protocol", protocol, ["wireguard", "openvpn", "stealth"], v => setProtocol(v as typeof protocol), "Advanced"),
      text("Stealth TLS endpoint", tlsEndpoint, "Advanced", setTlsEndpoint, "Required for stealth; explicit host:port."),
      text("Stealth server name (optional SNI)", serverName, "Advanced", setServerName),
      text("OpenVPN username (optional)", username, "Advanced", setUsername),
      { ...text("OpenVPN password (optional)", "", "Advanced", setPassword), edit: () => start("", setPassword), masked: true },
      choose("Profile provider", provider, ["custom", "windscribe"], v => setProvider(v as typeof provider), "Advanced"),
      { label: "Import profile", value: "Import", tab: "Advanced", action: async () => { if (!profilePath) throw new Error("Enter a profile path first."); await props.onImportProfile(profilePath, { protocol, ...(tlsEndpoint ? { tlsEndpoint } : {}), ...(serverName ? { serverName } : {}), ...(username ? { username } : {}), ...(password ? { password } : {}), provider }); } },
      backend("maxConnections", numeric("Maximum connections", draft.backendSettings.maxConnections, "Advanced", v => update(c => { c.backendSettings.maxConnections = v; }))),
      backend("listenPort", numeric("Listen port [restart]", draft.backendSettings.listenPort, "Advanced", v => update(c => { c.backendSettings.listenPort = v; }), "Restart required after changing the listen port.")),
      numeric("Forwarded port [restart]", draft.network.forwardedPort ?? 0, "Advanced", v => update(c => { c.network.forwardedPort = v || undefined; }), "0 disables forwarding. Restart required after changes."),
      backend("dht", toggle("DHT", draft.backendSettings.dht, v => update(c => { c.backendSettings.dht = v; }))),
      backend("pex", toggle("Peer exchange", draft.backendSettings.pex, v => update(c => { c.backendSettings.pex = v; }))),
      backend("utp", toggle("uTP", draft.backendSettings.utp, v => update(c => { c.backendSettings.utp = v; }))),
      backend("trackers", text("Extra trackers [restart] (URLs)", draft.backendSettings.trackers.join(","), "Advanced", v => update(c => { c.backendSettings.trackers = v.split(",").map(x => x.trim()).filter(Boolean); }))),
      toggle("Compact display", draft.display.compact, v => update(c => { c.display.compact = v; }), "Advanced"),
      numeric("Refresh interval (ms)", draft.display.refreshMs, "Advanced", v => update(c => { c.display.refreshMs = v; })),
      numeric("Piece refresh interval (ms)", draft.display.pieceRefreshMs, "Advanced", v => update(c => { c.display.pieceRefreshMs = v; })),
      toggle("Show legend", draft.display.legend, v => update(c => { c.display.legend = v; }), "Advanced"),
      toggle("Reduced animation", draft.display.reducedAnimation, v => update(c => { c.display.reducedAnimation = v; }), "Advanced"),
    ];
  }, [draft, profiles, profilePath, protocol, tlsEndpoint, serverName, username, password, provider, cap]);
  function start(value: string, commit: (value: string) => void, numeric = false) { setEdit({ value, cursor: value.length, commit, numeric }); }
  function currentProfile() { return profiles.find(p => p.id === draft.network.profileId); }
  function profileLabel(profile: VpnProfileSummary | undefined) {
    if (!profile) return profiles.length ? "Choose a profile" : "No profiles installed";
    return profiles.filter(p => p.name === profile.name).length > 1 ? `${profile.name}#${profile.id.slice(-4)}` : profile.name;
  }
  function setProfile(id: string) { const profile = profiles.find(p => p.id === id); if (profile) update(c => { c.network.profileId = profile.id; }); }
  const visible = rows.filter(r => r.tab === tab);
  const clamp = (n: number) => Math.max(0, Math.min(visible.length - 1, n));
  const contentWidth = Math.max(1, props.width);
  const fit = (value: string, max: number) => value.length <= max ? value : max <= 1 ? value.slice(0, max) : `${value.slice(0, max - 1)}…`;
  const framed = contentWidth >= 36 && props.height >= 10;
  const innerWidth = Math.max(1, contentWidth - (framed ? 2 : 0));
  const rowCount = Math.max(1, Math.min(visible.length || 1, props.height - (framed ? 6 : 3)));
  const rowStart = Math.max(0, Math.min(selected - Math.floor(rowCount / 2), visible.length - rowCount));
  useInput((input, key) => {
    if (edit) {
      if (key.escape) { setEdit(null); return; }
      if (key.return) { try { edit.commit(edit.value); setNotice("Edited. Save to apply settings."); } catch (e) { setNotice(e instanceof Error ? e.message : "Invalid value."); } setEdit(null); return; }
      if (key.home || (key.ctrl && input === "a")) { setEdit({ ...edit, cursor: 0 }); return; }
      if (key.end || (key.ctrl && input === "e")) { setEdit({ ...edit, cursor: edit.value.length }); return; }
      if (key.leftArrow) { setEdit({ ...edit, cursor: Math.max(0, edit.cursor - 1) }); return; }
      if (key.rightArrow) { setEdit({ ...edit, cursor: Math.min(edit.value.length, edit.cursor + 1) }); return; }
      if (key.ctrl && input === "u") { setEdit({ ...edit, value: "", cursor: 0 }); return; }
      if (key.backspace) {
        const next = deleteBefore(edit.value, edit.cursor);
        setEdit({ ...edit, ...next });
        return;
      }
      if (key.delete) {
        const next = deleteAt(edit.value, edit.cursor);
        setEdit({ ...edit, ...next });
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        let value = edit.value;
        let cursor = edit.cursor;
        for (const char of input) {
          if (edit.numeric && (!/[0-9.]/.test(char) || (char === "." && value.includes(".")))) continue;
          const next = insertAt(value, cursor, char);
          value = next.value;
          cursor = next.cursor;
        }
        if (value !== edit.value) setEdit({ ...edit, value, cursor });
      }
      return;
    }
    if (key.escape || input === "q") { props.onClose(); return; }
    if (key.tab || input === "a" || input === "e") { setTab(tab === "Everyday" ? "Advanced" : "Everyday"); setSelected(0); return; }
    if (key.upArrow || input === "k") { setSelected(clamp(selected - 1)); return; }
    if (key.downArrow || input === "j") { setSelected(clamp(selected + 1)); return; }
    if (input === "s") { setBusy(true); void props.onSave(draft).then(() => setNotice("Settings saved.")).catch(e => setNotice(e instanceof Error ? e.message : "Could not save settings.")).finally(() => setBusy(false)); return; }
    if (input === "r") { setBusy(true); void props.onReconnect().then(() => setNotice("Reconnected.")).catch(e => setNotice(String(e))).finally(() => setBusy(false)); return; }
    if (input === " ") { const row = visible[selected]; if (row?.disabled) { setNotice(row.disabled); return; } if (row?.cycle) row.cycle(); else if (row?.action) { setBusy(true); void row.action().then(() => setNotice("Done.")).catch(e => setNotice(String(e))).finally(() => setBusy(false)); } else row?.edit?.(); return; }
    if (key.return) { const row = visible[selected]; if (row?.disabled) { setNotice(row.disabled); return; } if (row?.edit) row.edit(); else if (row?.cycle) row.cycle(); else if (row?.action) { setBusy(true); void row.action().then(() => setNotice("Done.")).catch(e => setNotice(String(e))).finally(() => setBusy(false)); } }
  }, { isActive: props.active !== false });
  const tabText = `${tab === "Everyday" ? "◆ Everyday" : "Everyday"}  ${tab === "Advanced" ? "◆ Advanced" : "Advanced"}`;
  const hint = fit(contentWidth < 40 ? "↑↓ move · Enter edit · Tab more" : "↑↓ select · Enter edit · Space change · Tab switch · Esc close", innerWidth);
  const footer = fit(busy ? "Working…" : notice || (visible[selected]?.disabled ?? visible[selected]?.description ?? ""), innerWidth);
  return <Box flexDirection="column" width={contentWidth} height={Math.max(6, props.height)} borderStyle={framed ? "round" : undefined} borderColor={framed ? COLOR.accent : undefined}>
    <Text bold color={COLOR.accent} wrap="truncate-end">{fit(`SETTINGS  ${tabText}`, innerWidth)}</Text>
    <Text dimColor wrap="truncate-end">{hint}</Text>
    <Box flexDirection="column" height={rowCount}>
      {visible.slice(rowStart, rowStart + rowCount).map((row, i) => {
        const index = i + rowStart; const active = index === selected;
        const marker = active ? "› " : "  ";
        const available = Math.max(1, innerWidth - marker.length);
        const labelWidth = Math.min(Math.max(3, Math.floor(available * 0.58)), available);
        const valueWidth = Math.max(0, available - labelWidth - 2);
        const label = fit(row.label + (row.disabled ? " (off)" : ""), labelWidth);
        const rawValue = edit && active ? (row.masked ? "•".repeat(edit.value.length) : edit.value) : (row.masked ? "•".repeat(password.length) : row.value);
        const value = edit && active ? cursorWindow(rawValue, edit.cursor, valueWidth) : fit(rawValue, valueWidth);
        const line = `${marker}${label}${valueWidth > 0 ? `${" ".repeat(Math.max(1, labelWidth - label.length + 1))}${value}` : ""}`;
        return <Text key={`${row.label}-${index}`} color={active ? COLOR.accent : row.disabled ? COLOR.alt : undefined} backgroundColor={active ? "#30263f" : undefined} bold={active} dimColor={Boolean(row.disabled)} wrap="truncate-end">{fit(line, innerWidth)}</Text>;
      })}
    </Box>
    <Text color={notice ? COLOR.warn : COLOR.alt} dimColor={!notice} wrap="truncate-end">{footer}</Text>
    {contentWidth >= 40 ? <Text dimColor wrap="truncate-end">{fit("S save · A tabs · 1–5 main views", innerWidth)}</Text> : null}
  </Box>;
}
