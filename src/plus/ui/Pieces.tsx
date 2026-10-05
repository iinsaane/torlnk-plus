import { Box, Text } from "ink";
import type { PieceSnapshot, PieceState } from "../contracts";
import { COLOR } from "../../ui/theme";

export type PieceCell = { fractions: Record<PieceState, number>; state: PieceState; active: boolean; glyph: string };

/** Resample piece byte spans into terminal cells. Short final pieces contribute only their real byte weight. */
export function aggregatePieces(snapshot: PieceSnapshot | null | undefined, width: number): PieceCell[] {
  const n = Math.max(0, Math.floor(width));
  const states: PieceState[] = ["missing", "active", "verified", "unknown"];
  const empty = (): Record<PieceState, number> => ({ missing: 0, active: 0, verified: 0, unknown: 0 });
  if (!snapshot || !Number.isFinite(snapshot.pieceLength) || snapshot.pieceLength <= 0 || !snapshot.states.length) {
    return Array.from({ length: n }, () => ({ fractions: empty(), state: "unknown", active: false, glyph: "?" }));
  }
  const last = Number.isFinite(snapshot.lastPieceLength) && snapshot.lastPieceLength > 0
    ? Math.min(snapshot.lastPieceLength, snapshot.pieceLength) : snapshot.pieceLength;
  const total = (snapshot.states.length - 1) * snapshot.pieceLength + last;
  if (total <= 0) return Array.from({ length: n }, () => ({ fractions: empty(), state: "unknown", active: false, glyph: "?" }));
  return Array.from({ length: n }, (_, col) => {
    const from = col * total / n, to = (col + 1) * total / n;
    const fractions = empty();
    // Walk only the pieces that intersect this terminal cell. Runtime is
    // proportional to visible cells plus actual overlaps, not width * pieces.
    let i = Math.min(snapshot.states.length - 1, Math.floor(from / snapshot.pieceLength));
    while (i < snapshot.states.length) {
      const start = i * snapshot.pieceLength, end = start + (i === snapshot.states.length - 1 ? last : snapshot.pieceLength);
      if (start >= to) break;
      const overlap = Math.max(0, Math.min(to, end) - Math.max(from, start));
      const state = states.includes(snapshot.states[i]!) ? snapshot.states[i]! : "unknown";
      fractions[state] += overlap / (to - from);
      if (end >= to) break;
      i++;
    }
    const state = states.reduce((best, s) => fractions[s] > fractions[best] ? s : best, "unknown" as PieceState);
    const verified = fractions.verified;
    const active = fractions.active > 0;
    const eighth = Math.round(verified * 8);
    const blocks = ["·", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];
    let glyph = state === "unknown" && verified === 0 && fractions.missing === 0 && fractions.active === 0 ? "?" : blocks[eighth]!;
    if (verified === 0 && fractions.missing >= 0.999) glyph = "·";
    return { fractions, state, active, glyph };
  });
}

export function PieceMap({ pieces, width }: { pieces?: PieceSnapshot | null; width: number }) {
  const cells = aggregatePieces(pieces, width);
  return <Box>
    {cells.map((cell, i) => {
      const color = cell.active ? COLOR.warn : cell.fractions.verified > 0 ? COLOR.good : cell.fractions.missing > 0 ? "#514d59" : "#77727f";
      return <Text key={i} color={color}>{cell.glyph}{cell.active ? "!" : " "}</Text>;
    })}
  </Box>;
}
