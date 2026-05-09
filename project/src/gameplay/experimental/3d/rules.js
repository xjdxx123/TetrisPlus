// 3D Tetris rules pack — experimental mode (plan_gameplay_2.md §2.1,
// archived plan_gameplay_1.md §6.8).
//
// 3D Tetris reuses the rules-engine contract every other mode plays
// through, with three deviations:
//
//   1. **Dimensions.** The playfield is COLS × ROWS × DEPTH (10 × 20 × 10
//      by default). The `dimensions` field on the rules pack is what the
//      host's board representation reads — 2D modes use depth=1 and
//      collapse the loop. The rules engine itself is depth-agnostic;
//      this is the only place the third axis is declared.
//
//   2. **Layer scoring.** "Lines" become "layers" — a full Y-slab of
//      COLS × DEPTH cells. A single-layer clear is 1000 (10× a 2D
//      single) because filling a 10×10 layer is much harder than a
//      10-wide row. The full table comes from
//      `./layer-detection.js#LAYER_CLEAR_SCORE`.
//
//   3. **No §12 modern rules.** T-spin / B2B / Perfect Clear all assume
//      a discrete-grid 2D piece geometry (T-spin's 4-corner check is
//      ill-defined around a 3D pivot — see plan v2 §2.1's risk note).
//      `goalMultiplier: 1.0`; `clearType` arg ignored on `lineScore`.
//      If 3D promotes out of experimental, a future revision can
//      generalize §12 — but Phase A scopes 3D as 2D-rules-only.
//
// Pure module. No THREE, no DOM, no Rapier. Cell representation comes
// in via cell-list snapshots (see `./layer-detection.js`).

import { SOFT_DROP_POINTS_PER_CELL, HARD_DROP_POINTS_PER_CELL, levelForLines } from '../../scoring.js';
import { LAYER_CLEAR_SCORE } from './layer-detection.js';

// Default playfield: 10 wide × 20 tall × 10 deep, per archived §6.2.
const DEFAULT_DIMENSIONS = Object.freeze({ COLS: 10, ROWS: 20, DEPTH: 10 });

// Slightly more forgiving fall interval than classic at level 1. Filling
// a 10×10 layer is much harder than a 10-wide row, so the player needs
// extra placement time per piece (archived §6.11 risk-mitigation note).
const FALL_INTERVAL_BASE_3D = 1.10;

/**
 * Layer-clear score: indexes into LAYER_CLEAR_SCORE (1..4 layers
 * cleared in one lock). `clearType` is intentionally ignored — 3D
 * mode opts out of §12 modern rules (see file header).
 *
 * @param {number} layers   Number of full Y-slabs cleared in one lock.
 * @param {number} level
 * @param {string} [_clearType]   Ignored.
 * @returns {number}
 */
function layerScore(layers, level, _clearType) {
  const i = Math.max(0, Math.min(LAYER_CLEAR_SCORE.length - 1, layers | 0));
  return LAYER_CLEAR_SCORE[i] * Math.max(1, level | 0);
}

/**
 * Build the 3D rules pack.
 *
 * @param {Object} [opts]
 * @param {() => number} [opts.gravityScalar]  Live tweak slider; defaults to 1.0.
 * @param {{ COLS:number, ROWS:number, DEPTH:number }} [opts.dimensions]
 *   Override the default 10×20×10 footprint (e.g., a 6×6 advanced
 *   variant from archived §6.11). Validated for positive integers.
 * @param {{emit:(topic:string,payload:any)=>void}} [opts.bus]
 *   Unused at this layer — the host wires lifecycle events.
 * @returns {import('../../rules.js').Rules}
 */
export function build3DRules(opts = {}) {
  const gravityScalar = opts.gravityScalar || (() => 1.0);
  const dims = normalizeDimensions(opts.dimensions);

  return Object.freeze({
    key:               '3d',

    lineScore:         layerScore,
    softDropPerCell:   SOFT_DROP_POINTS_PER_CELL,
    hardDropPerCell:   HARD_DROP_POINTS_PER_CELL,

    fallIntervalSec:   (level) =>
      Math.max(0.05, (FALL_INTERVAL_BASE_3D * Math.pow(0.85, Math.max(0, level - 1))) / gravityScalar()),

    levelForLines:     levelForLines,

    // Classic-style topout: a piece spawning into an occupied cell
    // ends the run. Same shape as Classic / Marathon; the host is
    // responsible for the spawn-collision check, so the rules pack's
    // `endCondition` is a no-op (returns null on every tick — runs
    // are ended via the host's topout path, not via the rules hook).
    endCondition:      () => null,

    onLinesCleared:    null,
    onTick:            null,

    resetsHighScoreSlot: false, // 3D scores live in their own slot, like physics

    // Explicitly opt out of §12 paths (PC bonus / B2B chain) — see
    // file header. The host's modern-rules code branches on this
    // multiplier path; 1.0 keeps a 3D Tetris (4-layer clear) at
    // 8000 × level rather than promoting into B2B Tetris territory.
    goalMultiplier:    1.0,

    // 3D-specific declaration the engine and host read.
    dimensions:        dims,
    pieceSet:          'tetracubes', // host's piece registry switch

    initialModeView: Object.freeze({
      kind:           '3d',
      layersCleared:  0,
      level:          1,
      bestLayerCount: 0, // largest single-lock clear seen this run
    }),

    // Per-mode-best updater — same shape as physics's slot (cumulative
    // total + max-of-runs single-clear + highest score). The host
    // populates `summary.layersClearedThisRun` and
    // `summary.bestLayerCountThisRun` from session counters before
    // calling `recordEndOfRun`. See `gameplay/end-of-run.js#updateBest`
    // for the contract.
    updateBest: (best, summary) => {
      const total = (summary && Number.isFinite(summary.layersClearedThisRun))
        ? summary.layersClearedThisRun | 0
        : 0;
      const peak = (summary && Number.isFinite(summary.bestLayerCountThisRun))
        ? summary.bestLayerCountThisRun | 0
        : 0;
      best.totalLayersCleared = (best.totalLayersCleared || 0) + total;
      best.bestLayerCount = Math.max(best.bestLayerCount || 0, peak);
      if (summary && Number.isFinite(summary.score) && summary.score > (best.score || 0)) {
        best.score = summary.score;
      }
    },
  });
}

/**
 * Validate and normalize the dimensions option. Each axis must be a
 * positive integer ≥ 4 (smaller boards become unplayable for tetracubes
 * which can have a 4-cell I-bar). Falls back to the archived default
 * on any invalid input — same posture as the rules engine's "unknown
 * key falls back to classic" rule.
 *
 * @param {unknown} dims
 * @returns {{ COLS:number, ROWS:number, DEPTH:number }}
 */
function normalizeDimensions(dims) {
  if (!dims || typeof dims !== 'object') return DEFAULT_DIMENSIONS;
  const cols  = Number.isInteger(dims.COLS)  && dims.COLS  >= 4 ? dims.COLS  : DEFAULT_DIMENSIONS.COLS;
  const rows  = Number.isInteger(dims.ROWS)  && dims.ROWS  >= 4 ? dims.ROWS  : DEFAULT_DIMENSIONS.ROWS;
  const depth = Number.isInteger(dims.DEPTH) && dims.DEPTH >= 4 ? dims.DEPTH : DEFAULT_DIMENSIONS.DEPTH;
  return Object.freeze({ COLS: cols, ROWS: rows, DEPTH: depth });
}

// Test / introspection accessors.
export const _DEFAULT_DIMENSIONS    = DEFAULT_DIMENSIONS;
export const _FALL_INTERVAL_BASE_3D = FALL_INTERVAL_BASE_3D;
