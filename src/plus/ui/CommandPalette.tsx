import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { deleteAt, deleteBefore, insertAt } from "../../ui/components/TextField";
import { Panel } from "../../ui/components/Panel";
import { COLOR } from "../../ui/theme";
import { cleanText, stripControl } from "../../util/format";

export interface PaletteCommand {
  id: string;
  label: string;
  description?: string;
  shortcut?: string;
  keywords?: string;
  disabled?: string;
}

interface CommandPaletteProps {
  commands: PaletteCommand[];
  width: number;
  height: number;
  onSelect: (id: string) => void;
  onClose: () => void;
}

const fit = (value: string, width: number) => value.length <= width ? value : width <= 1 ? value.slice(0, width) : `${value.slice(0, width - 1)}…`;
function safeText(value?: string): string {
  if (!value) return "";
  const withoutOsc = value.replace(/(?:\u001b\]|\u009d)(?:[^\u0007\u001b]|\u001b(?!\\))*(?:\u0007|\u001b\\|$)/g, "");
  const withoutEscapes = withoutOsc.replace(/(?:\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~])/g, "");
  return withoutEscapes.trim() ? cleanText(withoutEscapes) : "";
}

function queryWindow(value: string, cursor: number, width: number): string {
  if (width <= 0) return "";
  const textWidth = Math.max(0, width - 1);
  if (textWidth === 0) return "▏";
  let start = Math.max(0, cursor - Math.floor(textWidth / 2));
  start = Math.min(start, Math.max(0, value.length - textWidth));
  const before = value.slice(start, cursor);
  const after = value.slice(cursor, cursor + Math.max(0, textWidth - before.length));
  return `${before}▏${after}`;
}

export function CommandPalette({ commands, width, height, onSelect, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(0);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const safeCommands = commands.map(command => ({
      ...command,
      label: safeText(command.label),
      description: safeText(command.description),
      keywords: safeText(command.keywords),
      shortcut: safeText(command.shortcut),
      disabled: safeText(command.disabled),
    }));
    if (!needle) return safeCommands;
    return safeCommands.filter(command => `${command.label} ${command.description} ${command.keywords}`.toLocaleLowerCase().includes(needle));
  }, [commands, query]);
  const activeIndex = filtered.length ? Math.max(0, Math.min(selected, filtered.length - 1)) : 0;
  const current = filtered[activeIndex];
  const panelWidth = Math.max(18, width);
  const innerWidth = Math.max(1, panelWidth - 4);
  const resultLimit = Math.max(1, Math.min(filtered.length || 1, Math.max(1, height - 7)));
  const resultStart = Math.max(0, Math.min(activeIndex - Math.floor(resultLimit / 2), filtered.length - resultLimit));

  useInput((input, key) => {
    if ((key.ctrl && input === "p") || key.escape) { onClose(); return; }
    if (key.return) {
      if (current && !current.disabled) onSelect(current.id);
      return;
    }
    if (key.downArrow) { setSelected(activeIndex < filtered.length - 1 ? activeIndex + 1 : activeIndex); return; }
    if (key.upArrow) { setSelected(Math.max(0, activeIndex - 1)); return; }
    if (key.home || (key.ctrl && input === "a")) { setCursor(0); return; }
    if (key.end || (key.ctrl && input === "e")) { setCursor(query.length); return; }
    if (key.leftArrow) { setCursor(n => Math.max(0, n - 1)); return; }
    if (key.rightArrow) { setCursor(n => Math.min(query.length, n + 1)); return; }
    if (key.ctrl && input === "u") { setQuery(""); setCursor(0); setSelected(0); return; }
    if (key.backspace) {
      const next = deleteBefore(query, cursor);
      setQuery(next.value); setCursor(next.cursor); setSelected(0);
      return;
    }
    if (key.delete) {
      const next = deleteAt(query, cursor);
      setQuery(next.value); setCursor(next.cursor); setSelected(0);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      const next = insertAt(query, cursor, stripControl(input).replace(/[\r\n]/g, ""));
      setQuery(next.value); setCursor(next.cursor); setSelected(0);
    }
  });

  const queryLine = fit(`> ${queryWindow(query, cursor, Math.max(1, innerWidth - 2))}`, innerWidth);
  const count = filtered.length ? `${activeIndex + 1} / ${filtered.length} commands` : "No commands match this search";
  const detail = current?.disabled || current?.description || (current ? "Press Enter to run this command." : "Clear the search or try another word.");

  return <Panel title="Command Palette" width={panelWidth} focused height={Math.max(5, height - 1)}>
    <Box flexDirection="column" width={innerWidth}>
      <Text color={COLOR.accent} bold wrap="truncate-end">{queryLine}</Text>
      <Text color={COLOR.alt} dimColor wrap="truncate-end">{fit(count, innerWidth)}</Text>
      <Box flexDirection="column" height={resultLimit}>
        {filtered.length ? filtered.slice(resultStart, resultStart + resultLimit).map((command, index) => {
          const absolute = resultStart + index;
          const active = absolute === activeIndex;
          const shortcut = command.shortcut ? `  ${command.shortcut}` : "";
          const labelWidth = Math.max(1, innerWidth - shortcut.length);
          const label = fit(`${active ? "›" : " "} ${command.label}${command.disabled ? "  (disabled)" : ""}`, labelWidth);
          const line = `${label}${" ".repeat(Math.max(0, labelWidth - label.length))}${shortcut ? fit(shortcut, Math.max(0, innerWidth - labelWidth)) : ""}`;
          return <Text key={command.id} color={active ? COLOR.accent : command.disabled ? COLOR.alt : COLOR.text} backgroundColor={active ? "#30263f" : undefined} bold={active} dimColor={Boolean(command.disabled)} wrap="truncate-end">{fit(line, innerWidth)}</Text>;
        }) : <Text color={COLOR.warn} wrap="truncate-end">{fit("No matching commands", innerWidth)}</Text>}
      </Box>
      <Text color={current?.disabled ? COLOR.warn : COLOR.text} dimColor={!current?.disabled && !current?.description} wrap="truncate-end">{fit(detail, innerWidth)}</Text>
      <Text color={COLOR.alt} dimColor wrap="truncate-end">{fit("↑↓ choose · Enter run · Esc/Ctrl+P close", innerWidth)}</Text>
    </Box>
  </Panel>;
}
