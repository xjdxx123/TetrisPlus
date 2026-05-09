// 3D rotation primitive for tetracubes (plan_gameplay_2.md §2.1, archived
// plan_gameplay_1.md §6.4).
//
// In 2D Tetris, a piece has 4 rotation states (one per quarter-turn around
// the gravity axis). In 3D, the cube rotation group has 24 elements — six
// face-up choices times four spins around the up axis. Pieces with
// rotational symmetry collapse some of those 24 into fewer unique visual
// states (the I-tetracube has 3 unique orientations; the chiral screws
// have 12 each).
//
// This module provides:
//
//   - `rotateX` / `rotateY` / `rotateZ`: a single 90° rotation around the
//     given axis. Sign convention: positive angle, right-handed (looking
//     down the +axis toward the origin, the rotation is counter-clockwise).
//   - `normalize`: translate cells so min(x)=min(y)=min(z)=0. Restoration
//     of the same invariant the base orientations satisfy in `tetracubes.js`.
//   - `canonicalize`: a stable string key for a cell set (after normalize)
//     so distinct rotations can be deduped.
//   - `enumerateRotations`: every unique rotation of a cell set. Returns
//     up to 24 entries; tetracubes with internal symmetry yield fewer.
//
// Pure module. Inputs are integer cell triples; outputs are integer cell
// triples. No floating-point error possible because all rotations are
// 90° axis-aligned and the data is integer-valued throughout.

/**
 * @typedef {[number, number, number]} Cell
 */

/**
 * Rotate cells 90° around X. (x, y, z) → (x, -z, y).
 * @param {readonly Cell[]} cells
 * @returns {Cell[]}
 */
export function rotateX(cells) {
  return cells.map(([x, y, z]) => [x, -z, y]);
}

/**
 * Rotate cells 90° around Y. (x, y, z) → (z, y, -x).
 * @param {readonly Cell[]} cells
 * @returns {Cell[]}
 */
export function rotateY(cells) {
  return cells.map(([x, y, z]) => [z, y, -x]);
}

/**
 * Rotate cells 90° around Z. (x, y, z) → (-y, x, z).
 * @param {readonly Cell[]} cells
 * @returns {Cell[]}
 */
export function rotateZ(cells) {
  return cells.map(([x, y, z]) => [-y, x, z]);
}

/**
 * Translate cells so the bounding box's min corner is at the origin.
 * Mutates a copy; the input is left unchanged.
 *
 * @param {readonly Cell[]} cells
 * @returns {Cell[]}
 */
export function normalize(cells) {
  if (cells.length === 0) return [];
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  for (const [x, y, z] of cells) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
  }
  return cells.map(([x, y, z]) => [x - minX, y - minY, z - minZ]);
}

/**
 * A stable string key for a cell set. The set is normalized + sorted so
 * cells differing only by translation collapse to the same key.
 *
 * @param {readonly Cell[]} cells
 * @returns {string}
 */
export function canonicalize(cells) {
  const norm = normalize(cells);
  norm.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]));
  return norm.map((c) => `${c[0]},${c[1]},${c[2]}`).join('|');
}

/**
 * Enumerate every unique rotation of a tetracube under the cube
 * rotation group (24 elements). Returns an array of normalized cell
 * sets, deduped by canonical key.
 *
 * Implementation: brute-force iterate (rotateX^a · rotateY^b · rotateZ^c)
 * for a, b, c ∈ {0, 1, 2, 3}. That's 64 combinations; some are
 * equivalent rotations of the cube (e.g., rotateX^4 = identity), so
 * the dedup pass collapses them. The resulting set is ≤ 24 (full
 * cube rotation group) and = 24 minus piece symmetry collapse.
 *
 * Performance: this runs at boot for the 8 tetracubes (8 × 64 = 512
 * rotations, each touching 4 cells). Negligible.
 *
 * @param {readonly Cell[]} cells
 * @returns {Cell[][]}   Each entry is a normalized cell set.
 */
export function enumerateRotations(cells) {
  const seen = new Set();
  const out = [];
  // Convert to a plain mutable array of plain arrays once at the
  // start — Object.freeze on the source data otherwise blocks the
  // map() chain inside the rotate functions.
  const seed = cells.map((c) => [c[0], c[1], c[2]]);
  for (let a = 0; a < 4; a++) {
    for (let b = 0; b < 4; b++) {
      for (let c = 0; c < 4; c++) {
        let r = seed;
        for (let i = 0; i < a; i++) r = rotateX(r);
        for (let i = 0; i < b; i++) r = rotateY(r);
        for (let i = 0; i < c; i++) r = rotateZ(r);
        const norm = normalize(r);
        const key = canonicalize(norm);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(norm);
      }
    }
  }
  return out;
}

/**
 * Number of unique rotations a tetracube has. Cheap enough to compute
 * eagerly; cached per piece in the host's piece registry if needed.
 *
 * @param {readonly Cell[]} cells
 * @returns {number}
 */
export function rotationOrder(cells) {
  return enumerateRotations(cells).length;
}
