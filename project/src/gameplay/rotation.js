// SRS wall-kick offsets (plan_gameplay_1.md §12.5 M1).
//
// "SRS" is the Super Rotation System — the rotation behavior every modern
// Tetris guideline implementation uses (TETR.IO, Puyo Puyo Tetris, Tetris
// 99, Jstris). When a rotation would collide with the wall/floor/stack at
// its in-place position, SRS tries up to four additional offset positions
// before giving up. The exact offsets depend on the piece (JLSTZ share a
// table; I has its own; O has none) AND on the rotation pair (e.g. a CW
// rotation from spawn behaves differently than a CW rotation from R).
//
// Coordinates: `dCol` is positive-right (matches `piece.col`). `dRow` is
// positive-UP (matches `piece.row` — board[0] is the bottom row in our
// convention). This is the standard guideline coordinate system; the
// tables below are copied verbatim from the published SRS reference.
//
// Public API:
//   getKickOffsets(pieceKey, fromRot, toRot) → readonly Array<{dCol, dRow}>
//
// Tests should call this rather than reach into the constants directly,
// so that future tweaks (3D piece kicks, "no-180 spin" rule packs, etc.)
// can swap implementations without rewriting call-sites.

// Rotation states:
//   0 = spawn       (canonical visual orientation)
//   1 = R  ("right-rotated")  — one CW step from spawn
//   2 = 2  ("180 spin")        — two CW steps from spawn
//   3 = L  ("left-rotated")    — three CW steps from spawn (equiv. one CCW)

// Standard SRS JLSTZ kick offsets. First row of each pair is always (0,0)
// — the in-place test. Subsequent rows are wall/floor kicks.
//
// Source: harddrop.com/wiki/SRS — the published Tetris guideline tables.
const SRS_KICKS_JLSTZ = Object.freeze({
  0: { // from rotation 0
    1: Object.freeze([
      Object.freeze({ dCol:  0, dRow:  0 }),
      Object.freeze({ dCol: -1, dRow:  0 }),
      Object.freeze({ dCol: -1, dRow: +1 }),
      Object.freeze({ dCol:  0, dRow: -2 }),
      Object.freeze({ dCol: -1, dRow: -2 }),
    ]),
    3: Object.freeze([
      Object.freeze({ dCol:  0, dRow:  0 }),
      Object.freeze({ dCol: +1, dRow:  0 }),
      Object.freeze({ dCol: +1, dRow: +1 }),
      Object.freeze({ dCol:  0, dRow: -2 }),
      Object.freeze({ dCol: +1, dRow: -2 }),
    ]),
  },
  1: { // from rotation R
    0: Object.freeze([
      Object.freeze({ dCol:  0, dRow:  0 }),
      Object.freeze({ dCol: +1, dRow:  0 }),
      Object.freeze({ dCol: +1, dRow: -1 }),
      Object.freeze({ dCol:  0, dRow: +2 }),
      Object.freeze({ dCol: +1, dRow: +2 }),
    ]),
    2: Object.freeze([
      Object.freeze({ dCol:  0, dRow:  0 }),
      Object.freeze({ dCol: +1, dRow:  0 }),
      Object.freeze({ dCol: +1, dRow: -1 }),
      Object.freeze({ dCol:  0, dRow: +2 }),
      Object.freeze({ dCol: +1, dRow: +2 }),
    ]),
  },
  2: { // from rotation 2 (180)
    1: Object.freeze([
      Object.freeze({ dCol:  0, dRow:  0 }),
      Object.freeze({ dCol: -1, dRow:  0 }),
      Object.freeze({ dCol: -1, dRow: +1 }),
      Object.freeze({ dCol:  0, dRow: -2 }),
      Object.freeze({ dCol: -1, dRow: -2 }),
    ]),
    3: Object.freeze([
      Object.freeze({ dCol:  0, dRow:  0 }),
      Object.freeze({ dCol: +1, dRow:  0 }),
      Object.freeze({ dCol: +1, dRow: +1 }),
      Object.freeze({ dCol:  0, dRow: -2 }),
      Object.freeze({ dCol: +1, dRow: -2 }),
    ]),
  },
  3: { // from rotation L
    2: Object.freeze([
      Object.freeze({ dCol:  0, dRow:  0 }),
      Object.freeze({ dCol: -1, dRow:  0 }),
      Object.freeze({ dCol: -1, dRow: -1 }),
      Object.freeze({ dCol:  0, dRow: +2 }),
      Object.freeze({ dCol: -1, dRow: +2 }),
    ]),
    0: Object.freeze([
      Object.freeze({ dCol:  0, dRow:  0 }),
      Object.freeze({ dCol: -1, dRow:  0 }),
      Object.freeze({ dCol: -1, dRow: -1 }),
      Object.freeze({ dCol:  0, dRow: +2 }),
      Object.freeze({ dCol: -1, dRow: +2 }),
    ]),
  },
});

// Standard SRS I-piece kick offsets — different magnitudes (±2 in places)
// because the I-piece is 4 cells long and its rotation pivot sits between
// cells.
const SRS_KICKS_I = Object.freeze({
  0: {
    1: Object.freeze([
      Object.freeze({ dCol:  0, dRow:  0 }),
      Object.freeze({ dCol: -2, dRow:  0 }),
      Object.freeze({ dCol: +1, dRow:  0 }),
      Object.freeze({ dCol: -2, dRow: -1 }),
      Object.freeze({ dCol: +1, dRow: +2 }),
    ]),
    3: Object.freeze([
      Object.freeze({ dCol:  0, dRow:  0 }),
      Object.freeze({ dCol: -1, dRow:  0 }),
      Object.freeze({ dCol: +2, dRow:  0 }),
      Object.freeze({ dCol: -1, dRow: +2 }),
      Object.freeze({ dCol: +2, dRow: -1 }),
    ]),
  },
  1: {
    0: Object.freeze([
      Object.freeze({ dCol:  0, dRow:  0 }),
      Object.freeze({ dCol: +2, dRow:  0 }),
      Object.freeze({ dCol: -1, dRow:  0 }),
      Object.freeze({ dCol: +2, dRow: +1 }),
      Object.freeze({ dCol: -1, dRow: -2 }),
    ]),
    2: Object.freeze([
      Object.freeze({ dCol:  0, dRow:  0 }),
      Object.freeze({ dCol: -1, dRow:  0 }),
      Object.freeze({ dCol: +2, dRow:  0 }),
      Object.freeze({ dCol: -1, dRow: +2 }),
      Object.freeze({ dCol: +2, dRow: -1 }),
    ]),
  },
  2: {
    1: Object.freeze([
      Object.freeze({ dCol:  0, dRow:  0 }),
      Object.freeze({ dCol: +1, dRow:  0 }),
      Object.freeze({ dCol: -2, dRow:  0 }),
      Object.freeze({ dCol: +1, dRow: -2 }),
      Object.freeze({ dCol: -2, dRow: +1 }),
    ]),
    3: Object.freeze([
      Object.freeze({ dCol:  0, dRow:  0 }),
      Object.freeze({ dCol: +2, dRow:  0 }),
      Object.freeze({ dCol: -1, dRow:  0 }),
      Object.freeze({ dCol: +2, dRow: +1 }),
      Object.freeze({ dCol: -1, dRow: -2 }),
    ]),
  },
  3: {
    2: Object.freeze([
      Object.freeze({ dCol:  0, dRow:  0 }),
      Object.freeze({ dCol: -2, dRow:  0 }),
      Object.freeze({ dCol: +1, dRow:  0 }),
      Object.freeze({ dCol: -2, dRow: -1 }),
      Object.freeze({ dCol: +1, dRow: +2 }),
    ]),
    0: Object.freeze([
      Object.freeze({ dCol:  0, dRow:  0 }),
      Object.freeze({ dCol: +1, dRow:  0 }),
      Object.freeze({ dCol: -2, dRow:  0 }),
      Object.freeze({ dCol: +1, dRow: -2 }),
      Object.freeze({ dCol: -2, dRow: +1 }),
    ]),
  },
});

// O piece — every rotation is visually identical to spawn. Kick logic
// trivially succeeds at (0,0); returning a 1-test array (vs. an empty one)
// keeps the `for (const off of offsets)` loop in Game.tryRotate non-empty
// and avoids a special-case branch.
const SRS_KICKS_O_ANY = Object.freeze([Object.freeze({ dCol: 0, dRow: 0 })]);
const SRS_KICKS_O = Object.freeze({
  0: { 1: SRS_KICKS_O_ANY, 3: SRS_KICKS_O_ANY },
  1: { 0: SRS_KICKS_O_ANY, 2: SRS_KICKS_O_ANY },
  2: { 1: SRS_KICKS_O_ANY, 3: SRS_KICKS_O_ANY },
  3: { 0: SRS_KICKS_O_ANY, 2: SRS_KICKS_O_ANY },
});

// Map piece key → kick table.
const PIECE_TABLE = Object.freeze({
  I: SRS_KICKS_I,
  O: SRS_KICKS_O,
  T: SRS_KICKS_JLSTZ,
  S: SRS_KICKS_JLSTZ,
  Z: SRS_KICKS_JLSTZ,
  J: SRS_KICKS_JLSTZ,
  L: SRS_KICKS_JLSTZ,
});

/**
 * Get the SRS kick offsets to try when rotating `pieceKey` from rotation
 * `fromRot` to rotation `toRot`. Returns a frozen array of 5 (or 1, for O)
 * `{dCol, dRow}` objects. Caller iterates them in order, applies each as
 * a candidate position offset, and accepts the first non-colliding one.
 *
 * Throws on unknown piece key. Adjacent rotation pair (|to-from| ∈ {1,3})
 * is required — 180-spin (|diff|=2) is not part of standard SRS and falls
 * back to the in-place-only kick array.
 *
 * @param {'I'|'O'|'T'|'S'|'Z'|'J'|'L'} pieceKey
 * @param {0|1|2|3} fromRot
 * @param {0|1|2|3} toRot
 * @returns {ReadonlyArray<{dCol: number, dRow: number}>}
 */
export function getKickOffsets(pieceKey, fromRot, toRot) {
  const table = PIECE_TABLE[pieceKey];
  if (!table) throw new Error(`getKickOffsets: unknown piece key "${pieceKey}"`);
  const fromTable = table[fromRot];
  if (!fromTable) return SRS_KICKS_O_ANY; // safety: in-place-only fallback
  const offsets = fromTable[toRot];
  if (!offsets) return SRS_KICKS_O_ANY;
  return offsets;
}

// Direction-to-rotation-delta. A `+1` direction increments rotation, `-1`
// (or any non-positive) decrements (modulo 4).
export function rotationDelta(direction) {
  return direction > 0 ? 1 : 3;
}

// Compute the next rotation index given current rotation and direction.
export function nextRotation(currentRotation, direction) {
  return (currentRotation + rotationDelta(direction)) % 4;
}

// ─── Deprecated 1D kick alias ─────────────────────────────────────────
//
// Pre-§12 callers used a single 1D column-offset list `[0,-1,1,-2,2]`.
// New code should use `getKickOffsets(...)` which returns proper 2D
// offsets per the SRS guideline. Kept as a frozen export so legacy tests
// and any external integrations keep building until they migrate.
export const KICK_OFFSETS = Object.freeze([0, -1, 1, -2, 2]);

// ─── Test / introspection accessors ───────────────────────────────────
export const _SRS_KICKS_JLSTZ = SRS_KICKS_JLSTZ;
export const _SRS_KICKS_I     = SRS_KICKS_I;
export const _SRS_KICKS_O     = SRS_KICKS_O;
