// T-spin detection (plan_gameplay_1.md §12.5 M2).
//
// "T-spin" is a competitive Tetris technique where a T piece slots into a
// gap that wasn't reachable by translation alone — the player rotated the
// T into a hole only the rotation could fit. Modern guideline games
// (TETR.IO / Puyo Puyo Tetris / Tetris 99) award score and combat-garbage
// bonuses for T-spins, on a scale that makes them the highest-value
// technique in skilled play.
//
// Detection rule (the "3-corner rule"):
//   1. The piece is T.
//   2. The last successful action was a rotation (not a move/drop).
//   3. Of the 4 cells diagonally adjacent to the T's pivot, ≥3 are
//      "filled" (board cell occupied OR off the playfield).
//
// Variant — "T-Spin Mini":
//   Even with 3+ corners filled, the spin is classified as Mini if only
//   ONE of the two "front" corners (the side the T's tip points toward)
//   is filled. The standard exception: if the rotation used the
//   index-4 SRS kick (the "TST kick"), the spin is always upgraded
//   from Mini to a regular T-spin — that kick is hard enough to
//   execute that the guideline rewards the player with full credit.
//
// Pure module. No THREE, no DOM. Returns 'none' / 'tspin' / 'mini'.

// T's pivot cell offset relative to (piece.col, piece.row). For our
// codebase the T body is centered on the same anchor across all 4
// rotations: (col + 1, row + 2). See pieces.js for the rotation grids.
const T_PIVOT_OFFSET = Object.freeze({ dCol: 1, dRow: 2 });

// Diagonal corners around the pivot, indexed [TL, TR, BL, BR].
//   TL = top-left  : (-1, +1)
//   TR = top-right : (+1, +1)
//   BL = bot-left  : (-1, -1)
//   BR = bot-right : (+1, -1)
// "Top" means higher row index (closer to the spawn area).
const CORNER_OFFSETS = Object.freeze([
  Object.freeze({ dCol: -1, dRow: +1 }), // 0 — TL
  Object.freeze({ dCol: +1, dRow: +1 }), // 1 — TR
  Object.freeze({ dCol: -1, dRow: -1 }), // 2 — BL
  Object.freeze({ dCol: +1, dRow: -1 }), // 3 — BR
]);

// Which 2 of the 4 corners are "front" — i.e. on the side the T's tip
// points toward — given the T's rotation state. Indexed [rot 0..3].
//   rot 0 (T pointing UP)    → front = TL, TR
//   rot 1 (T pointing RIGHT) → front = TR, BR
//   rot 2 (T pointing DOWN)  → front = BL, BR
//   rot 3 (T pointing LEFT)  → front = TL, BL
const FRONT_CORNERS_BY_ROT = Object.freeze([
  Object.freeze([0, 1]),
  Object.freeze([1, 3]),
  Object.freeze([2, 3]),
  Object.freeze([0, 2]),
]);

// Inline helper — true if (col, row) is "filled" for corner-check
// purposes. Off-board cells (out of column range OR below the floor)
// count as filled because they bound the rotation; the buffer zone
// above the visible field (row >= rows) does NOT count as filled.
function isFilled(board, col, row, cols, rows) {
  if (col < 0 || col >= cols) return true;
  if (row < 0) return true;
  if (row >= rows) return false;
  return board[row][col] !== null;
}

/**
 * Classify a piece-lock as a T-spin / T-spin Mini / neither.
 *
 * Call right BEFORE writing the piece's cells into the board: the corner
 * check looks at the board state at lock time, which is "what surrounded
 * the T as it landed". (The T's own cells aren't part of the corner
 * check — corners are the diagonals of the pivot, not the body — so
 * detection works either way, but pre-write is the natural ordering.)
 *
 * @param {{key: string, col: number, row: number, rot: 0|1|2|3}} piece
 * @param {Array<Array<number|null>>} board
 *   Board indexed [row][col]; row 0 is the BOTTOM (matches Game's
 *   convention).
 * @param {string|null} lastAction
 *   The most recent successful piece action: 'rotation', 'move', 'drop',
 *   or null. T-spin requires 'rotation'.
 * @param {number} kickIndex
 *   The SRS test index (0..4) that succeeded for the last rotation.
 *   -1 if the piece hasn't rotated since spawn. Index 4 (TST kick)
 *   upgrades a Mini classification to a regular T-spin.
 * @param {number} cols
 * @param {number} rows
 * @returns {'none'|'tspin'|'mini'}
 */
export function detectTSpin(piece, board, lastAction, kickIndex, cols, rows) {
  if (!piece || piece.key !== 'T') return 'none';
  if (lastAction !== 'rotation') return 'none';

  const pivotCol = piece.col + T_PIVOT_OFFSET.dCol;
  const pivotRow = piece.row + T_PIVOT_OFFSET.dRow;

  const cornerFilled = CORNER_OFFSETS.map(({ dCol, dRow }) =>
    isFilled(board, pivotCol + dCol, pivotRow + dRow, cols, rows));

  let totalFilled = 0;
  for (const c of cornerFilled) if (c) totalFilled++;
  if (totalFilled < 3) return 'none';

  // TST kick (index 4) always = regular T-spin, regardless of which
  // corners are filled. Reflects guideline-spec "the deepest kick is
  // hard enough to deserve full credit".
  if (kickIndex === 4) return 'tspin';

  const [frontA, frontB] = FRONT_CORNERS_BY_ROT[piece.rot];
  const frontFilled = (cornerFilled[frontA] ? 1 : 0) + (cornerFilled[frontB] ? 1 : 0);

  // Both front corners filled → regular T-spin. Otherwise (only one
  // front corner OR zero, with both backs filled) → Mini.
  return frontFilled >= 2 ? 'tspin' : 'mini';
}

// ─── Test / introspection accessors ───────────────────────────────────
export const _T_PIVOT_OFFSET       = T_PIVOT_OFFSET;
export const _CORNER_OFFSETS       = CORNER_OFFSETS;
export const _FRONT_CORNERS_BY_ROT = FRONT_CORNERS_BY_ROT;
