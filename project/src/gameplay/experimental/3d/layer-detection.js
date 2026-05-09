// 3D Tetris — layer (Y-slab) detection on a discrete grid (plan
// plan_gameplay_2.md §2.1, archived plan_gameplay_1.md §6.5).
//
// Unlike the physics-mode layer detector (`../physics/layer-detection.js`),
// 3D Tetris cells live on integer grid coordinates — no continuous-body
// drift, no pairwise distance threshold. A "layer" here is a Y-slab where
// every (x, z) cell in the COLS × DEPTH footprint is occupied. The check
// is just a per-Y count.
//
// The 10 × 10 × 20 footprint (archived §6.2) means a full layer needs 100
// cells. That's harder than the 2D row clear (10 cells) — exponential
// scoring in `rules.js#lineScore` compensates.
//
// Pure module. Cells are integer `[x, y, z]` triples. The host owns the
// board representation; this module operates on cell snapshots and
// returns layers / settled cell lists. No THREE, no DOM.

/**
 * @typedef {[number, number, number]} Cell
 */

/**
 * Find every full Y-slab in the cell list.
 *
 * A layer Y is full iff for every (x, z) with 0 ≤ x < cols and
 * 0 ≤ z < depth, there exists a cell at (x, Y, z).
 *
 * @param {readonly Cell[]} cells
 * @param {number} cols   Playfield width in cells (default 10).
 * @param {number} depth  Playfield depth in cells (default 10).
 * @returns {number[]}    Sorted ascending list of full layer Y values.
 */
export function detectFullLayers(cells, cols = 10, depth = 10) {
  const expected = cols * depth;
  if (expected <= 0) return [];

  // Map from Y → Set of unique "x,z" keys at that Y. Set (not count)
  // because the cell list could in principle contain duplicates from
  // upstream bugs — the layer detector should still report correctly.
  /** @type {Map<number, Set<string>>} */
  const buckets = new Map();
  for (const [x, y, z] of cells) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) continue;
    if (x < 0 || x >= cols) continue;
    if (z < 0 || z >= depth) continue;
    let s = buckets.get(y);
    if (!s) { s = new Set(); buckets.set(y, s); }
    s.add(`${x},${z}`);
  }

  const full = [];
  for (const [y, s] of buckets) {
    if (s.size === expected) full.push(y);
  }
  full.sort((a, b) => a - b);
  return full;
}

/**
 * Remove cells at the given Y-slabs and settle the stack above. The
 * "settle" operation drops every surviving cell down by the count of
 * cleared layers strictly below it — same intuition as 2D Tetris row
 * clear, generalized to 3D.
 *
 * The result is a new cell list; the input is left unchanged.
 *
 * Example: clearing Y=0 and Y=2 from cells at Y=0,1,2,3 leaves cells
 * originally at Y=1 (drop 1 → Y=0) and Y=3 (drop 2 → Y=1).
 *
 * @param {readonly Cell[]} cells
 * @param {readonly number[]} clearYs   Y values to remove (need not be sorted).
 * @returns {Cell[]}                    Surviving cells, with Y reindexed.
 */
export function settleAfterClear(cells, clearYs) {
  if (clearYs.length === 0) {
    return cells.map(([x, y, z]) => [x, y, z]);
  }
  const cleared = new Set(clearYs);
  // Pre-sort the Y values so the "count strictly below" lookup is a
  // simple linear scan. For the typical 1–4 cleared layers per lock,
  // this loop is trivial; even 10 cleared layers is negligible.
  const sortedClears = [...clearYs].sort((a, b) => a - b);

  const survivors = [];
  for (const [x, y, z] of cells) {
    if (cleared.has(y)) continue;
    let drop = 0;
    for (const cy of sortedClears) {
      if (cy < y) drop++;
      else break;
    }
    survivors.push([x, y - drop, z]);
  }
  return survivors;
}

/**
 * Per-layer-count score multiplier table (archived §6.5):
 *
 *   1 layer  →  1000
 *   2 layers →  3000
 *   3 layers →  5000
 *   4 layers →  8000
 *
 * Steeper than 2D's [0, 100, 300, 500, 800] because a 10×10 layer is
 * vastly harder to fill than a 10-wide row. The rules pack reads from
 * this table via `lineScore`; exposed here so the HUD / VFX can check
 * "is this a 4-layer clear?" without re-deriving the curve.
 */
export const LAYER_CLEAR_SCORE = Object.freeze([0, 1000, 3000, 5000, 8000]);
