// Garbage primitives — pure functions for the Versus garbage pipeline
// (plan_gameplay_1.md §3.6).
//
// This module owns the *math*: how many garbage rows a line clear sends,
// where the hole goes, and how a garbage row mutates a board. The host
// (main.js / future app/versus.js) owns the orchestration: what triggers
// emission, when to apply queued garbage, and how meshes follow board
// state.
//
// Pure module. No THREE, no DOM. Tested in pure Node.

import { createSeededRng } from '../shared/random/seeded.js';

// Module-private fallback PRNG so callers that omit `rngFn` still get a
// deterministic stream — required by §3.7 sub-phase 7f's no-Math.random
// rule. Hosts that want fresh entropy at boot pass their own seeded
// source. Tests stub `rngFn` directly and never see this fallback.
const _defaultRng = createSeededRng((Date.now() | 0) >>> 0);

// Standard Tetris garbage table (plan_gameplay_1.md §3.6 #3).
// 1 line = 0 garbage   (no point sending — would just be a swap).
// 2 lines = 1 row.
// 3 lines = 2 rows.
// 4 lines (Tetris) = 4 rows — the dramatic burst the table is built around.
const TABLE = Object.freeze([
  /* 0 */ 0,
  /* 1 */ 0,
  /* 2 */ 1,
  /* 3 */ 2,
  /* 4 */ 4,
]);

// Modern-rules combo step table (plan §12.5 M4). Indexed by `comboStep`
// — the count of CONSECUTIVE prior clears (0 = first clear of a streak).
// Modern guideline (TETR.IO / Tetris 99): combo singles DO contribute
// once the streak gets long enough. The pre-§12 table coupled combo
// bonus to "base > 0" (so 1-line clears never sent combo garbage); this
// table decouples them.
//
// Source: TETR.IO defaults — gentle ramp at low combos, plateau at 4–5.
const COMBO_STEP_GARBAGE = Object.freeze([0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 4]);
// All comboStep ≥ 11 send 5 (the plateau).
const COMBO_STEP_PLATEAU = 5;

/**
 * Compute the number of garbage rows to send when the player clears
 * `rowsCleared` rows simultaneously, with `comboStep` consecutive prior
 * clears (0 = first clear of the streak — no combo bonus yet).
 *
 * Modern-rules behaviour (plan §12 M4):
 *   - Base garbage from the per-row table (0/0/1/2/4 for 0/1/2/3/4 rows).
 *   - + per-step combo bonus from `COMBO_STEP_GARBAGE`. The combo
 *     bonus applies regardless of base — so combo singles eventually
 *     accumulate into the outgoing queue once the streak passes step 2.
 *
 * @param {number} rowsCleared   1..4 (anything ≥4 caps at 4).
 * @param {number} [comboStep]   Consecutive prior clears (0 = solo).
 * @returns {number}
 */
export function garbageForLineCount(rowsCleared, comboStep = 0) {
  const r = Math.max(0, Math.min(4, rowsCleared | 0));
  const base = TABLE[r];
  const c = Math.max(0, comboStep | 0);
  const bonus = c >= COMBO_STEP_GARBAGE.length
    ? COMBO_STEP_PLATEAU
    : COMBO_STEP_GARBAGE[c];
  return base + bonus;
}

/**
 * Pick a hole column for a fresh garbage row given a deterministic
 * source. `rngFn` should return a number in [0, 1). Tests inject a
 * stub; production callers either inherit the module-private seeded
 * fallback or pass an `rngFn` from createSeededRng() so replay /
 * online versus stay reproducible.
 *
 * @param {number} cols
 * @param {() => number} [rngFn]
 * @returns {number}
 */
export function pickHoleColumn(cols, rngFn) {
  if (!Number.isFinite(cols) || cols <= 0) throw new Error('pickHoleColumn requires positive cols');
  const rng = (typeof rngFn === 'function') ? rngFn : _defaultRng;
  return Math.floor(rng() * cols) % cols;
}

/**
 * Mutate `board` in place: pop `rows` rows from the top, unshift `rows`
 * fresh garbage rows at the bottom. Each garbage row is filled with
 * `garbageColor` except for `holeColumn` which is null.
 *
 * Returns `{ overflowed }` — true when any popped top row had non-null
 * cells, meaning the player's stack overflowed the playfield (the host
 * will trigger topout on the next spawn attempt; this is the canonical
 * "garbage killed me" outcome).
 *
 * Does NOT manage rendering meshes — the host wraps this with the
 * cellMeshes/stackGroup mutation.
 *
 * @param {Array<Array<number|null>>} board   Mutated.
 * @param {number} rows                       Garbage rows to apply.
 * @param {number} holeColumn                 Same hole for all `rows` (single-stream garbage).
 * @param {number} garbageColor               Hex color used for filled cells.
 * @returns {{ overflowed: boolean }}
 */
export function applyGarbageToBoard(board, rows, holeColumn, garbageColor) {
  if (!Array.isArray(board) || board.length === 0) return { overflowed: false };
  if (!Number.isFinite(rows) || rows <= 0) return { overflowed: false };
  const cols = board[0].length;
  const safeHole = ((holeColumn % cols) + cols) % cols;
  let overflowed = false;
  for (let i = 0; i < rows; i++) {
    const top = board.pop();
    if (top && top.some(cell => cell !== null && cell !== undefined)) {
      overflowed = true;
    }
    const newRow = new Array(cols).fill(garbageColor);
    newRow[safeHole] = null;
    board.unshift(newRow);
  }
  return { overflowed };
}

export const _GARBAGE_TABLE      = TABLE;
export const _COMBO_STEP_GARBAGE = COMBO_STEP_GARBAGE;
export const _COMBO_STEP_PLATEAU = COMBO_STEP_PLATEAU;
