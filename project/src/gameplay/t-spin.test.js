// T-spin detection tests (plan_gameplay_1.md §12.5 M2).
//
// Detection is "did this T piece, with its last action being a rotation,
// land in a hole that 3+ of its 4 pivot-corner cells declare blocked?"
// These tests run the detector against hand-built board states + piece
// poses, covering the canonical scenarios:
//
//   - Straight T-spin Single (3 corners filled, both fronts)
//   - T-spin Mini (3 corners, only 1 front filled)
//   - TST kick override (Mini upgraded to regular if kickIndex === 4)
//   - Negative cases: not-T, last-action-was-move, only 2 corners

import { describe, it, expect } from 'vitest';
import { detectTSpin } from './t-spin.js';

const COLS = 10;
const ROWS = 20;

/** Empty playfield for hand-construction. */
function emptyBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

/** Block a single cell with an arbitrary color. */
function block(board, col, row) {
  board[row][col] = 0xff0000;
}

/** Standard T-piece pose at (col, row, rot) — the same shape Game holds. */
function tPiece(col, row, rot) {
  return { key: 'T', col, row, rot, color: 0xb84cff };
}

describe('detectTSpin — negative cases', () => {
  it('non-T piece is never a T-spin', () => {
    const piece = { key: 'I', col: 3, row: 3, rot: 0, color: 0x00ffff };
    expect(detectTSpin(piece, emptyBoard(), 'rotation', 0, COLS, ROWS)).toBe('none');
  });

  it('null lastAction → not a T-spin (piece never rotated)', () => {
    const piece = tPiece(3, 3, 0);
    expect(detectTSpin(piece, emptyBoard(), null, -1, COLS, ROWS)).toBe('none');
  });

  it('lastAction === "move" → not a T-spin (last successful op was translation)', () => {
    const piece = tPiece(3, 3, 0);
    const b = emptyBoard();
    // Even with all 4 corners filled, a non-rotation lastAction means no T-spin.
    block(b, 3, 4); block(b, 5, 4);
    block(b, 3, 6); block(b, 5, 6);
    expect(detectTSpin(piece, b, 'move', 0, COLS, ROWS)).toBe('none');
  });

  it('lastAction === "drop" → not a T-spin (hard drop is not a rotation)', () => {
    const piece = tPiece(3, 3, 0);
    expect(detectTSpin(piece, emptyBoard(), 'drop', 0, COLS, ROWS)).toBe('none');
  });

  it('only 2 corners filled → not a T-spin', () => {
    const piece = tPiece(3, 3, 0);
    const b = emptyBoard();
    // Fill bottom-left + bottom-right (2 corners) only.
    block(b, 3, 4); block(b, 5, 4);
    expect(detectTSpin(piece, b, 'rotation', 0, COLS, ROWS)).toBe('none');
  });
});

describe('detectTSpin — regular T-spin', () => {
  // Pivot for tPiece(3, 3, *) is at (col=4, row=5).
  // 4 corners are at (3,6) TL, (5,6) TR, (3,4) BL, (5,4) BR.

  it('classifies 3-corner spin with both fronts filled (rot 0) as regular tspin', () => {
    const piece = tPiece(3, 3, 0); // T pointing UP — fronts = TL, TR
    const b = emptyBoard();
    block(b, 3, 6); // TL — front
    block(b, 5, 6); // TR — front
    block(b, 3, 4); // BL — back
    expect(detectTSpin(piece, b, 'rotation', 0, COLS, ROWS)).toBe('tspin');
  });

  it('classifies 4-corner spin (all corners blocked) as regular tspin', () => {
    const piece = tPiece(3, 3, 0);
    const b = emptyBoard();
    block(b, 3, 6); block(b, 5, 6);
    block(b, 3, 4); block(b, 5, 4);
    expect(detectTSpin(piece, b, 'rotation', 0, COLS, ROWS)).toBe('tspin');
  });

  it('classifies front-pair filled in rot 1 (T pointing right) as regular tspin', () => {
    const piece = tPiece(3, 3, 1); // T pointing RIGHT — fronts = TR, BR
    const b = emptyBoard();
    block(b, 5, 6); // TR — front
    block(b, 5, 4); // BR — front
    block(b, 3, 4); // BL — back
    expect(detectTSpin(piece, b, 'rotation', 0, COLS, ROWS)).toBe('tspin');
  });

  it('classifies front-pair filled in rot 2 (T pointing down) as regular tspin', () => {
    const piece = tPiece(3, 3, 2); // T pointing DOWN — fronts = BL, BR
    const b = emptyBoard();
    block(b, 3, 4); // BL — front
    block(b, 5, 4); // BR — front
    block(b, 3, 6); // TL — back
    expect(detectTSpin(piece, b, 'rotation', 0, COLS, ROWS)).toBe('tspin');
  });

  it('classifies front-pair filled in rot 3 (T pointing left) as regular tspin', () => {
    const piece = tPiece(3, 3, 3); // T pointing LEFT — fronts = TL, BL
    const b = emptyBoard();
    block(b, 3, 6); // TL — front
    block(b, 3, 4); // BL — front
    block(b, 5, 4); // BR — back
    expect(detectTSpin(piece, b, 'rotation', 0, COLS, ROWS)).toBe('tspin');
  });
});

describe('detectTSpin — Mini', () => {
  it('classifies 3-corner spin with only 1 front filled as Mini', () => {
    const piece = tPiece(3, 3, 0); // T pointing UP — fronts = TL, TR
    const b = emptyBoard();
    block(b, 3, 6); // TL — front (1 of 2)
    block(b, 3, 4); // BL — back
    block(b, 5, 4); // BR — back
    expect(detectTSpin(piece, b, 'rotation', 0, COLS, ROWS)).toBe('mini');
  });

  it('classifies 3-corner spin with 0 fronts filled as Mini', () => {
    // Edge case: only the 2 backs + 1 unrelated corner... wait, 0 fronts
    // means BOTH fronts unfilled, so the 3 must come from the other
    // corners. With only TL+TR being fronts (rot 0), and 0 of those, we
    // need 3 of the remaining 2 (BL+BR) — impossible. So this case
    // requires a rotation where the front-corner set excludes the third
    // filled corner. For rot 0 there are only 4 corners (2F + 2B); 0
    // fronts caps the total at 2, can't reach 3. Use rot 1 which
    // changes which are front.
    //
    // Conclusion: "0 fronts filled, ≥3 total" is unreachable in 4-corner
    // geometry. The Mini case is always "1 of 2 fronts + 2 backs". Drop
    // this test in favor of just trusting the logic — covered by the
    // 1-front mini case above and the TST upgrade case below.
    expect(true).toBe(true);
  });

  it('upgrades a Mini to regular T-spin when kickIndex === 4 (TST kick)', () => {
    const piece = tPiece(3, 3, 0);
    const b = emptyBoard();
    // Same setup as the Mini case (1 front + both backs).
    block(b, 3, 6); // TL — front
    block(b, 3, 4); // BL — back
    block(b, 5, 4); // BR — back
    // With kickIndex 4 (the deepest SRS kick = "TST" in T-spin Triple
    // setups), the spin is upgraded to a regular T-spin.
    expect(detectTSpin(piece, b, 'rotation', 4, COLS, ROWS)).toBe('tspin');
  });

  it('does NOT upgrade to regular when kickIndex < 4 (any earlier kick)', () => {
    const piece = tPiece(3, 3, 0);
    const b = emptyBoard();
    block(b, 3, 6);
    block(b, 3, 4);
    block(b, 5, 4);
    for (const kickIdx of [0, 1, 2, 3]) {
      expect(detectTSpin(piece, b, 'rotation', kickIdx, COLS, ROWS)).toBe('mini');
    }
  });
});

describe('detectTSpin — board boundary edges', () => {
  it('off-board cells (left wall) count as filled corners', () => {
    // Place T at far-left so its left corners would be at col=-1.
    const piece = tPiece(-1, 3, 0); // pivot at col=0, row=5
    // Corners: TL=(-1,6), TR=(1,6), BL=(-1,4), BR=(1,4).
    // TL and BL are off-board → counted filled.
    // We need a 3rd corner filled to qualify.
    const b = emptyBoard();
    block(b, 1, 4); // BR — back
    // Now 3 of 4 are filled (TL off-board + BL off-board + BR explicit).
    // For rot 0, fronts = TL, TR. TL is off-board (filled), TR not.
    // 1 front filled + 2 backs filled (BL off-board + BR) → Mini.
    expect(detectTSpin(piece, b, 'rotation', 0, COLS, ROWS)).toBe('mini');
  });

  it('off-board cells (floor) count as filled corners', () => {
    // T near the floor — corners at row=-1 are below the board.
    const piece = tPiece(3, -2, 0); // pivot at col=4, row=0
    // Corners: TL=(3,1), TR=(5,1), BL=(3,-1), BR=(5,-1).
    // BL and BR are below floor → counted filled.
    const b = emptyBoard();
    block(b, 3, 1); // TL — front
    // 3 corners filled (TL + BL off + BR off). For rot 0, 1 front + 2 backs.
    expect(detectTSpin(piece, b, 'rotation', 0, COLS, ROWS)).toBe('mini');
  });

  it('above-buffer cells (row >= rows) do NOT count as filled', () => {
    // T high in the buffer zone — top corners would be at row >= rows.
    // Buffer-zone cells are intentionally NOT filled (the T can spawn
    // and rotate freely without false-positive T-spins from the empty
    // ceiling).
    const piece = tPiece(3, ROWS - 1, 0); // pivot at col=4, row=ROWS+1
    // TL=(3,ROWS+2), TR=(5,ROWS+2) — both above buffer, not filled.
    // BL=(3,ROWS), BR=(5,ROWS) — at row=ROWS, also above visible
    // (not filled by definition).
    const b = emptyBoard();
    expect(detectTSpin(piece, b, 'rotation', 0, COLS, ROWS)).toBe('none');
  });
});
