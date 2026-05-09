// Pure Physics — layer detection (plan_gameplay_2.md §2.3, archived
// plan_gameplay_1.md §8.5).
//
// In classic Tetris, "row clear" is a discrete grid query: every cell in
// row R has a non-null value. Physics mode breaks that — cubes are rigid
// bodies that lean, slip, and settle wedged. The "row clear" replacement:
//
//   A "layer" is a connected component of N≥COL_COUNT cubes that are
//   face-touching (within X-distance threshold) AND whose Y centers all
//   fall within a tolerance band (±0.4 of a cell, total range ≤ 0.8).
//
// This produces emergent slightly-tilted "rows" — a player can clear a
// layer that's settled wedged a quarter-cell off-grid. Per archived
// plan_gameplay_1.md §8.5, that's the **good** surprise of physics mode,
// not a bug to suppress.
//
// Pure module. Operates on `[{x, y, z}, ...]` position arrays — no THREE,
// no Rapier dependency. The Rapier integration (next phase) will pass
// position snapshots from the rigid-body world; this module decides what
// gets cleared.

// Default thresholds, calibrated for a 10-wide playfield with 1.0-unit
// cells:
//   - Two cubes "face-touch" in X when |dx| < 1.4 (cell width plus a 40%
//     tolerance for lean / slip).
//   - Two cubes "face-touch" in Y when |dy| < 0.8 (a tighter band — the
//     layer is supposed to be roughly horizontal).
//   - Layer Y-RANGE check is ≤ 0.8 across the entire component (so a
//     diagonal staircase whose pairwise dy<0.8 doesn't qualify as a
//     "row" if its overall span is wider).
//   - Min size = 10 (one full row of a standard 10-column playfield).
//
// All thresholds are tunable via `opts` — callers can experiment without
// editing this file.
const DEFAULT_OPTS = Object.freeze({
  xLink:    1.4,
  yLink:    0.8,
  yBand:    0.8,
  minSize:  10,
  zLink:    1.4, // 3D-aware; current 2D Tetris has cubes at constant z so this is a no-op
});

/**
 * @typedef {Object} CubePosition
 * @property {number} x
 * @property {number} y
 * @property {number} z
 */

/**
 * @typedef {Object} Layer
 * @property {number[]} cubeIndices   Indices into the input `cubes` array.
 * @property {number} centerY         Mean Y of the cubes in this layer.
 * @property {number} minY
 * @property {number} maxY
 */

/**
 * Find layers in a set of physics cube positions. A layer is a connected
 * component of ≥ minSize cubes (face-touching pairwise) whose total Y
 * range is within yBand.
 *
 * Performance: O(n²) for the adjacency build. With ~500 cubes (a busy
 * physics-mode stack), that's 250k pairs — well within frame budget at
 * 60Hz. For larger boards, a spatial-hash bucketing pass would drop this
 * to O(n) but isn't needed for the experimental tier.
 *
 * @param {CubePosition[]} cubes
 * @param {Partial<typeof DEFAULT_OPTS>} [opts]
 * @returns {Layer[]}
 */
export function detectLayers(cubes, opts = {}) {
  const { xLink, yLink, yBand, minSize, zLink } = { ...DEFAULT_OPTS, ...opts };
  const n = cubes.length;
  if (n < minSize) return [];

  // Build adjacency list. Two cubes are "linked" when face-touching in
  // all three axes within their respective tolerances. The Y constraint
  // here is PAIRWISE — the per-component Y-range check is a separate
  // post-filter (see below).
  const adj = new Array(n);
  for (let i = 0; i < n; i++) adj[i] = [];
  for (let i = 0; i < n; i++) {
    const ci = cubes[i];
    for (let j = i + 1; j < n; j++) {
      const cj = cubes[j];
      if (Math.abs(ci.x - cj.x) >= xLink) continue;
      if (Math.abs(ci.y - cj.y) >= yLink) continue;
      if (Math.abs((ci.z || 0) - (cj.z || 0)) >= zLink) continue;
      adj[i].push(j);
      adj[j].push(i);
    }
  }

  // BFS connected components. Iterative queue (depth-first push/pop is
  // fine — order doesn't matter for membership).
  const visited = new Uint8Array(n);
  const components = [];
  for (let start = 0; start < n; start++) {
    if (visited[start]) continue;
    const comp = [];
    const queue = [start];
    while (queue.length) {
      const k = queue.pop();
      if (visited[k]) continue;
      visited[k] = 1;
      comp.push(k);
      for (const nb of adj[k]) if (!visited[nb]) queue.push(nb);
    }
    components.push(comp);
  }

  // Filter components: must have ≥ minSize cubes AND total Y range ≤
  // yBand. The Y-range filter is what rejects diagonal staircases —
  // pairwise dy < 0.8 can chain into a wider total span. Layers should
  // be roughly horizontal.
  const layers = [];
  for (const comp of components) {
    if (comp.length < minSize) continue;
    let minY = Infinity, maxY = -Infinity, sumY = 0;
    for (const idx of comp) {
      const y = cubes[idx].y;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      sumY += y;
    }
    if (maxY - minY > yBand) continue;
    layers.push({
      cubeIndices: comp,
      centerY: sumY / comp.length,
      minY,
      maxY,
    });
  }
  // Stable order: bottom layers first, so multi-layer clears apply
  // bottom-up (matches gravity intuition).
  layers.sort((a, b) => a.centerY - b.centerY);
  return layers;
}

/**
 * Convenience: aggregate the indices of all cubes that belong to ANY
 * detected layer, deduped. Useful for "which cubes should I despawn?"
 * after a single detectLayers() call.
 *
 * @param {Layer[]} layers
 * @returns {number[]}   Sorted unique indices.
 */
export function indicesToClear(layers) {
  const set = new Set();
  for (const layer of layers) {
    for (const idx of layer.cubeIndices) set.add(idx);
  }
  return [...set].sort((a, b) => a - b);
}

// Test / introspection accessors.
export const _DEFAULT_OPTS = DEFAULT_OPTS;
