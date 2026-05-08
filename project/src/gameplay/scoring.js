// Scoring rules — pure functions only. No state.
//
// Standard Tetris scoring: line value scales with simultaneous-clear count,
// then is multiplied by current level. Level advances every 10 cleared lines.

const LINE_VALUE = Object.freeze([0, 100, 300, 500, 800]);

// Points awarded for clearing N rows in a single lock at the given level.
// rowCount > 4 falls back to the 4-row value (won't happen with standard
// tetrominoes but keeps the function total).
export function lineClearScore(rowCount, level) {
  const base = LINE_VALUE[rowCount] ?? 800;
  return base * level;
}

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
