import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { aggregatePieces, PieceMap } from "./Pieces";
import type { PieceSnapshot } from "../contracts";

describe("aggregatePieces", () => {
  it("weights a short final piece by its actual byte length", () => {
    const cells = aggregatePieces({ states: ["verified", "missing"], pieceLength: 9, lastPieceLength: 1 }, 2);
    expect(cells).toHaveLength(2);
    expect(cells[1]!.fractions.verified).toBeCloseTo(0.8);
    expect(cells[1]!.fractions.missing).toBeCloseTo(0.2);
  });
  it("preserves sparse mixed states and an active indicator", () => {
    const [cell] = aggregatePieces({ states: ["verified", "active", "unknown", "missing"], pieceLength: 3, lastPieceLength: 3 }, 1);
    expect(cell!.fractions).toEqual({ missing: 0.25, active: 0.25, verified: 0.25, unknown: 0.25 });
    expect(cell!.active).toBe(true);
    expect(cell!.glyph).toBe("▎");
  });
  it("changes map resolution without changing total coverage", () => {
    const snapshot: PieceSnapshot = { states: ["verified", "missing", "active"], pieceLength: 8, lastPieceLength: 2 };
    const narrow = aggregatePieces(snapshot, 2), wide = aggregatePieces(snapshot, 10);
    expect(narrow).toHaveLength(2);
    expect(wide).toHaveLength(10);
    const verifiedWeight = (cells: typeof wide) => cells.reduce((sum, c) => sum + c.fractions.verified / cells.length, 0);
    expect(verifiedWeight(narrow)).toBeCloseTo(verifiedWeight(wide));
  });
  it("shows unknown metadata as unknown cells", () => {
    expect(aggregatePieces(null, 3).map(c => c.glyph)).toEqual(["?", "?", "?"]);
    const view = render(<PieceMap pieces={null} width={3} />);
    expect(view.lastFrame()).toContain("? ? ?");
  });
  it("prints an active marker beside the mixed fraction glyph", () => {
    const view = render(<PieceMap pieces={{ states: ["verified", "active"], pieceLength: 1, lastPieceLength: 1 }} width={2} />);
    expect(view.lastFrame()).toContain("!");
  });
});
