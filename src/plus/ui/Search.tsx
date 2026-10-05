import { Box, Text } from "ink";
import { Logo } from "../../ui/components/Logo";
import { Panel } from "../../ui/components/Panel";
import { COLOR, ICON, sourceStyle } from "../../ui/theme";
import { LOGO_TEXT, LOGO_WIDTH } from "../../ui/logo";
import { sourcesByGroup, getSource } from "../../sources/registry";
import type { TorrentResult } from "../../sources/types";
import type { BackendKind } from "../contracts";
import { cleanText, stripControl, formatBytes, truncate } from "../../util/format";

export interface PlusSearchProps {
  width: number;
  height: number;
  home: boolean;
  value: string;
  editing: boolean;
  caret?: number;
  inputKind: "search" | "import";
  busy: boolean;
  results: TorrentResult[];
  cursor: number;
  backend: BackendKind;
  onSubmit: (value: string) => void;
  onChange: (value: string) => void;
  onExitDown: () => void;
}

const CATEGORIES = sourcesByGroup().map((g) => g.group.toLowerCase()).join(`  ${ICON.dot}  `);

function SearchInput({ width, value, editing, inputKind, caret = value.length }: Pick<PlusSearchProps, "width" | "value" | "editing" | "inputKind" | "caret">) {
  const room = Math.max(1, width - 6);
  const cursor = Math.max(0, Math.min(value.length, caret));
  const start = editing ? Math.max(0, cursor - room + 2) : 0;
  const before = stripControl(value.slice(start, cursor));
  const at = value[cursor] ?? " ";
  const after = stripControl(value.slice(cursor + 1, start + room));
  const placeholder = inputKind === "import" ? "Drop a .torrent or paste its path…" : "Search or paste a magnet link…";
  return <Panel title={inputKind === "import" ? "add torrent" : "search"} width={width} focused={editing} height={2}>
    <Box><Text color={COLOR.accent}>{`${ICON.pointer} `}</Text><Text wrap="truncate-end">
      {value ? editing ? <>{before}<Text inverse>{at}</Text>{after}</> : stripControl(truncate(value, room))
        : editing ? <><Text inverse>{placeholder[0]}</Text><Text dimColor>{placeholder.slice(1, room)}</Text></>
        : <Text dimColor>{placeholder.slice(0, room)}</Text>}
    </Text></Box>
  </Panel>;
}
function columns(width: number) {
  const inner = Math.max(8, width - 4);
  const sourceWidth = Math.min(5, Math.max(3, Math.floor(inner * .16)));
  const seedWidth = Math.min(5, Math.max(3, Math.floor(inner * .15)));
  const sizeWidth = Math.min(9, Math.max(6, Math.floor(inner * .22)));
  return { inner, sourceWidth, seedWidth, sizeWidth, nameWidth: Math.max(1, inner - sourceWidth - seedWidth - sizeWidth - 2) };
}

function ResultRow({ result, selected, width }: { result: TorrentResult; selected: boolean; width: number }) {
  const style = sourceStyle(result.source);
  const healthKnown = getSource(result.source).reportsHealth;
  const { inner, sourceWidth, seedWidth, sizeWidth, nameWidth } = columns(width);
  const seed = healthKnown ? String(result.seeders) : "?";
  const size = result.sizeBytes > 0 ? formatBytes(result.sizeBytes) : "?";
  const title = truncate(cleanText(result.name), nameWidth);
  return (
    <Box width={inner}>
      <Text color={selected ? COLOR.accent : style.color} bold={selected}>{style.tag.padEnd(sourceWidth).slice(0, sourceWidth)}</Text>
      <Text color={healthKnown && result.seeders > 0 ? COLOR.good : undefined} dimColor={!healthKnown}>{seed.padStart(seedWidth)}</Text>
      <Text dimColor> {size.padStart(sizeWidth).slice(-sizeWidth)}</Text>
      <Text bold={selected} inverse={selected} wrap="truncate-end"> {title.padEnd(nameWidth).slice(0, nameWidth)}</Text>
    </Box>
  );
}

export function PlusSearch(props: PlusSearchProps) {
  const width = Math.max(10, Math.floor(props.width));
  const height = Math.max(1, Math.floor(props.height));
  if (props.home) {
    const showLogo = width >= LOGO_WIDTH + 6 && height >= 13;
    const compact = height < 13;
    const searchWidth = Math.max(10, Math.min(width, 62));
    return (
      <Box width={width} height={height} flexDirection="column" justifyContent="center" alignItems="center" overflow="hidden">
        {showLogo ? <Logo /> : <Text bold color={COLOR.accent}>{LOGO_TEXT}</Text>}
        {!compact && width >= 58 ? <Box marginTop={1}><Text color={COLOR.text}>A curated, terminal-native torrent downloader.</Text></Box> : null}
        {height >= 10 && width >= 38 ? <Text dimColor>{CATEGORIES}</Text> : null}
        <Box marginTop={1} width={searchWidth}>
          <SearchInput width={searchWidth} value={props.value} editing={props.editing} inputKind={props.inputKind} caret={props.caret} />
        </Box>
        {height >= 8 ? <Box marginTop={1}><Text color={COLOR.alt}>↵</Text><Text dimColor> search  ·  </Text><Text color={COLOR.alt}>Tab</Text><Text dimColor> browse</Text></Box> : null}
      </Box>
    );
  }

  const searchHeight = 3;
  const resultArea = Math.max(0, height - searchHeight - 1);
  const visibleCount = Math.max(0, resultArea - 3 - (props.busy ? 1 : 0));
  const count = props.results.length ? `${props.results.length}` : undefined;
  const first = Math.max(0, Math.min(props.cursor - Math.floor(visibleCount / 2), props.results.length - visibleCount));
  const visible = props.results.slice(first, first + visibleCount);
  const tableWidth = width;
  const header = columns(width);
  return (
    <Box width={width} height={height} flexDirection="column" overflow="hidden">
      <SearchInput width={width} value={props.value} editing={props.editing} inputKind={props.inputKind} caret={props.caret} />
      {resultArea > 0 ? (
        <Box flexDirection="column" width={tableWidth} height={resultArea}>
          <Panel title="results" width={tableWidth} count={count} height={Math.max(0, resultArea - 1)} focused={false}>
            {props.busy && props.results.length === 0 ? <Text dimColor>Searching sources…</Text> : null}
            {!props.busy && props.results.length === 0 ? <Text dimColor>{props.value ? "No results found." : "Search for a title to find torrents."}</Text> : null}
            {props.results.length > 0 ? <>
              <Text dimColor>{"FROM".slice(0, header.sourceWidth).padEnd(header.sourceWidth)}{"SEEDS".slice(0, header.seedWidth).padStart(header.seedWidth)} {"SIZE".padStart(header.sizeWidth)} TITLE</Text>
              {visible.map((result, i) => <ResultRow key={`${result.infoHash}-${first + i}`} result={result} selected={first + i === props.cursor} width={tableWidth} />)}
              {props.busy ? <Text dimColor>Searching more sources…</Text> : null}
            </> : null}
          </Panel>
        </Box>
      ) : null}
    </Box>
  );
}
