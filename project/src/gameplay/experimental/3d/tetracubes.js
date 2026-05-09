// Tetracubes — 4-cell polycube piece library for 3D Tetris (plan
// plan_gameplay_2.md §2.1, archived plan_gameplay_1.md §6.3.3).
//
// There are exactly **8 free tetracubes** (4-cell connected polycubes).
// Five of them are "flat" — they live in a single plane and reduce to
// the standard 2D tetrominoes when projected. Three are genuinely 3D:
// the branch (a flat tromino with one cube rising at its midpoint) and
// the chiral screw pair (right and left). The chirality matters —
// no rotation of the cube group transforms a right screw into a left
// screw, so they are distinct pieces in the bag.
//
// Pure data: cells are stored as sparse `[x, y, z]` integer triples in
// a small base orientation. The `rotation.js` module enumerates the
// 24-element cube rotation group on top of these base orientations to
// produce all unique visual states. Storing sparse cell arrays (rather
// than 3D bool tensors) keeps the rotation logic obvious — `rotate3d`
// is a per-cell coordinate transform, not a tensor reshape.
//
// Pure module. No THREE, no DOM, no rendering dependency. The renderer
// will read these cell lists at instancing time; gameplay reads them
// for collision / lock.

/**
 * @typedef {[number, number, number]} Cell  Integer (x, y, z) coords.
 */

/**
 * @typedef {Object} Tetracube
 * @property {string} key                 One-letter / short identifier.
 * @property {Cell[]} cells               Base orientation (sparse).
 * @property {string} kind                'flat' | 'branch' | 'screw'.
 * @property {('R'|'L')|null} chirality   'R' / 'L' for screws, null otherwise.
 */

// Each shape is given in a base orientation with cells in [0, max] for
// each axis (i.e., already translated to the origin corner of its
// bounding box). The renderer/game can apply a spawn translation on
// top; rotation modules normalize after rotating.
//
// Axes: x = horizontal width, y = vertical (gravity axis), z = depth.

/** I — 4-in-a-row along X (1×1×4 in some orientation). */
const I = Object.freeze({
  key: 'I',
  cells: Object.freeze([[0,0,0], [1,0,0], [2,0,0], [3,0,0]]),
  kind: 'flat',
  chirality: null,
});

/** O — 2×2 square in the XY plane (the only piece that is flat in two senses: planar and rotation-symmetric). */
const O = Object.freeze({
  key: 'O',
  cells: Object.freeze([[0,0,0], [1,0,0], [0,1,0], [1,1,0]]),
  kind: 'flat',
  chirality: null,
});

/** T — flat T in XY plane; pivot cell is the bottom-middle. */
const T = Object.freeze({
  key: 'T',
  cells: Object.freeze([[0,0,0], [1,0,0], [2,0,0], [1,1,0]]),
  kind: 'flat',
  chirality: null,
});

/**
 * L — flat L in XY plane. In 3D, J (the mirror) is reachable via a
 * 180° rotation around Y; the bag therefore ships only L.
 */
const L = Object.freeze({
  key: 'L',
  cells: Object.freeze([[0,0,0], [1,0,0], [2,0,0], [2,1,0]]),
  kind: 'flat',
  chirality: null,
});

/**
 * S — flat S/N in XY plane. Z is reachable via 180° rotation around Y
 * (same logic as L vs J), so the bag ships only S.
 */
const S = Object.freeze({
  key: 'S',
  cells: Object.freeze([[0,0,0], [1,0,0], [1,1,0], [2,1,0]]),
  kind: 'flat',
  chirality: null,
});

/**
 * Branch — three-in-a-row flat along X with one cube rising at the
 * midpoint. The "3D T" shape; rotational symmetry is C2 (about the
 * upright cube's vertical axis).
 */
const BRANCH = Object.freeze({
  key: 'B',
  cells: Object.freeze([[0,0,0], [1,0,0], [2,0,0], [1,0,1]]),
  kind: 'branch',
  chirality: null,
});

/**
 * Right screw — 3D corner staircase climbing through all three axes.
 * Cells: a 2-along-X base, then a corner that turns up and over into
 * Y and Z. Right-handed chirality (no rotation maps it to the left
 * screw, only a reflection).
 *
 * Layout (X right, Y up, Z out of page):
 *
 *     z=0:  ##
 *           .#
 *     z=1:  ..
 *           .#
 */
const SCREW_R = Object.freeze({
  key: 'SR',
  cells: Object.freeze([[0,0,0], [1,0,0], [1,1,0], [1,1,1]]),
  kind: 'screw',
  chirality: 'R',
});

/**
 * Left screw — mirror of the right screw across the X-axis. Distinct
 * piece in the bag because the cube rotation group does NOT include
 * reflections.
 *
 *     z=0:  ##
 *           #.
 *     z=1:  ..
 *           #.
 */
const SCREW_L = Object.freeze({
  key: 'SL',
  cells: Object.freeze([[0,0,0], [1,0,0], [0,1,0], [0,1,1]]),
  kind: 'screw',
  chirality: 'L',
});

/**
 * The full 8-tetracube library, in a stable order. Bag-randomization
 * (analogous to the standard 7-bag) lives in the host or in a
 * gameplay/rng layer; this module is just the data.
 */
export const TETRACUBES = Object.freeze({
  I, O, T, L, S, B: BRANCH, SR: SCREW_R, SL: SCREW_L,
});

export const TETRACUBE_KEYS = Object.freeze(Object.keys(TETRACUBES));

/**
 * Suggested colors per piece. Reuses 2D PIECE_COLORS where the shape
 * has a clean correspondence (I, O, T, L, S) and adds three new hues
 * for the genuinely-3D pieces (Branch, both screws). Colors are hex
 * 0xRRGGBB to match the 2D PIECE_COLORS scheme.
 */
export const TETRACUBE_COLORS = Object.freeze({
  I:  0x22e6ff, // cyan (matches 2D I)
  O:  0xffd400, // yellow (matches 2D O)
  T:  0xb84cff, // violet (matches 2D T)
  L:  0xff8a1c, // orange (matches 2D L)
  S:  0x39ff7a, // green (matches 2D S)
  B:  0xfff0a0, // pale gold — the only "rises out of the plane" piece
  SR: 0xff5fb1, // hot pink — right-handed screw
  SL: 0x5fb1ff, // sky blue — left-handed screw
});
