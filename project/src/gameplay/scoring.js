// Scoring rules — pure functions only. No state.
//
// Standard Tetris scoring: line value scales with simultaneous-clear count,
// then is multiplied by current level. Level advances every 10 cleared lines.
//
// Modern guideline (plan §12) extends `lineClearScore` with a third
// `clearType` argument: 'normal' (default), 'tspin', or 'mini'. T-spins
// have their own value tables — including a 0-row "no-clear" case which
// awards a flat bonus when a T-spin happens without filling a row.

const LINE_VALUE = Object.freeze([0, 100, 300, 500, 800]);

// T-Spin (regular) line values, indexed by rows cleared (0..3).
//   no-clear = 400 ×lvl ; single = 800 ×lvl ; double = 1200 ×lvl ; triple = 1600 ×lvl
// Source: TETR.IO defaults (matches the modern guideline).
const T_SPIN_LINE_VALUE = Object.freeze([400, 800, 1200, 1600]);

// T-Spin Mini line values, indexed by rows cleared (0 or 1).
//   no-clear = 100 ×lvl ; single = 200 ×lvl
// Mini double / triple are physically impossible with the standard T
// piece geometry; the table only defines values up to single.
const T_SPIN_MINI_LINE_VALUE = Object.freeze([100, 200]);

/**
 * Points awarded for clearing N rows in a single lock at the given level.
 * Optional `clearType` selects the score table:
 *   - 'normal' (default): standard values (0/100/300/500/800 × level)
 *   - 'tspin' : T-spin values, incl. no-clear bonus
 *   - 'mini'  : T-spin Mini values
 *
 * rowCount > table-length falls back to the largest defined value
 * (preserves a total function over all integer inputs).
 *
 * @param {number} rowCount
 * @param {number} level
 * @param {'normal'|'tspin'|'mini'} [clearType]
 */
export function lineClearScore(rowCount, level, clearType = 'normal') {
  const r = Math.max(0, rowCount | 0);
  if (clearType === 'tspin') {
    const i = Math.min(r, T_SPIN_LINE_VALUE.length - 1);
    return T_SPIN_LINE_VALUE[i] * level;
  }
  if (clearType === 'mini') {
    // A "Mini Double/Triple" doesn't exist in the standard guideline.
    // If a caller threads one through, fall back to the regular T-spin
    // table — an upgraded value rather than a silent zero.
    if (r >= T_SPIN_MINI_LINE_VALUE.length) {
      const i = Math.min(r, T_SPIN_LINE_VALUE.length - 1);
      return T_SPIN_LINE_VALUE[i] * level;
    }
    return T_SPIN_MINI_LINE_VALUE[r] * level;
  }
  // Normal clear.
  const i = Math.min(r, LINE_VALUE.length - 1);
  return LINE_VALUE[i] * level;
}

// Test / introspection accessors.
export const _LINE_VALUE             = LINE_VALUE;
export const _T_SPIN_LINE_VALUE      = T_SPIN_LINE_VALUE;
export const _T_SPIN_MINI_LINE_VALUE = T_SPIN_MINI_LINE_VALUE;

// Points awarded for a soft-drop tick (one cell of player-driven descent).
export const SOFT_DROP_POINTS_PER_CELL = 1;

// Points awarded per cell of hard-drop distance.
export const HARD_DROP_POINTS_PER_CELL = 2;

// Level corresponding to a given total cleared-line count. Level starts at 1
// and advances every 10 lines. Pure function — gameplay calls it after every
// line clear and emits LEVEL_UP if the result exceeds the previous level.
export function levelForLines(totalLines) {
  return Math.floor(totalLines / 10) + 1;
}
