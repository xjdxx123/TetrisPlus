// Pure Physics rules pack — experimental mode (plan v2 §2.3, archived
// plan_gameplay_1.md §8.6).
//
// Physics mode breaks the discrete-grid contract every other rule pack
// assumes. Instead of "row clear", a connected-component layer detector
// (see `./layer-detection.js`) decides when settled cubes form a clearable
// horizontal slab. The rules pack itself stays small — almost everything
// it cares about is "what to score, when to stop, what shape does the HUD
// render?".
//
// Design choices kept from the archived spec (§8.6):
//
//   - `lineScore`: layers cleared × 100, no level multiplier, no
//     clearType-aware path. Physics is its own thing — the §12 modern
//     rules (T-spin / B2B / PC) all assume a discrete grid; cubes wedged
//     mid-air don't have a meaningful "T-spin pivot" or "Tetris-shape".
//     `goalMultiplier: 1.0` to make this explicit at the rules level.
//   - `endCondition`: a cube rests at Y > 22 (stack overflow). The grid
//     "topout" path doesn't apply; the host inspects body positions
//     (passed via `state.physicsHighestY`) and asks the rules pack on
//     each tick.
//   - `resetsHighScoreSlot: false`: physics scores don't compete with
//     classic. Per-mode best slot only.
//
// The rules pack does NOT own the physics world or the layer-detection
// step itself — that's the host's job (Rapier integration is the next
// implementation phase). The pack is the same kind of pure declarative
// shape as the other rules packs; it stays Three.js-free, Rapier-free,
// and runs in pure Node tests.

import { SOFT_DROP_POINTS_PER_CELL, HARD_DROP_POINTS_PER_CELL, levelForLines } from '../../scoring.js';

const PHYSICS_FALL_INTERVAL_DEFAULT = 0.85; // matches classic baseline; gravity in physics mode is dominated by the rigid-body world, not the grid timer
const PHYSICS_LAYER_SCORE = 100;            // flat per-layer (no level multiplier)
const PHYSICS_TOPOUT_Y    = 22;             // a cube resting above this height ends the run

/**
 * Per-layer score: rowCount × PHYSICS_LAYER_SCORE. clearType is
 * intentionally ignored — physics mode doesn't track T-spin / B2B / PC,
 * since none of those are well-defined for a continuous body simulation.
 *
 * @param {number} rowCount   Number of layers cleared simultaneously.
 * @param {number} _level     Ignored — physics has no level multiplier.
 * @param {string} [_clearType]  Ignored — physics doesn't recognize §12 clearTypes.
 * @returns {number}
 */
function physicsLineScore(rowCount, _level, _clearType) {
  const r = Math.max(0, rowCount | 0);
  return r * PHYSICS_LAYER_SCORE;
}

/**
 * Build a physics rules pack.
 *
 * @param {Object} [opts]
 * @param {() => number} [opts.gravityScalar]
 *   Live-tweak gravity slider. Affects the GRID's fall timer for the
 *   active piece (still grid-driven before lock); does NOT affect
 *   Rapier's world gravity, which the host owns separately.
 * @param {{emit:(topic:string,payload:any)=>void}} [opts.bus]
 *   Unused at this layer — physics emissions (cube settle, layer
 *   detected) come from the host's Rapier integration, not the rules
 *   pack.
 * @returns {import('../../rules.js').Rules}
 */
export function buildPhysicsRules(opts = {}) {
  const gravityScalar = opts.gravityScalar || (() => 1.0);

  return Object.freeze({
    key:               'physics',

    // Flat per-layer score, no §12 multiplier path. The signature
    // matches the rest of the rules engine (rowCount, level, clearType)
    // for type-shape uniformity, but the implementation ignores the
    // last two args — see physicsLineScore() above for the rationale.
    lineScore:         physicsLineScore,

    softDropPerCell:   SOFT_DROP_POINTS_PER_CELL,
    hardDropPerCell:   HARD_DROP_POINTS_PER_CELL,
    fallIntervalSec:   (/* level */) => PHYSICS_FALL_INTERVAL_DEFAULT / gravityScalar(),

    // Level isn't really meaningful in physics mode (gravity comes
    // from Rapier, not from the grid timer's curve). We still expose
    // a level counter via `levelForLines` so the existing HUD code
    // doesn't NaN out when reading state.level — every 10 layers
    // cleared advances the cosmetic level.
    levelForLines:     levelForLines,

    resetsHighScoreSlot: false, // physics scores live in their own slot only
    goalMultiplier:    1.0,     // explicitly opt out of any §12 multiplier paths

    // Physics-specific topout: a body rests above PHYSICS_TOPOUT_Y.
    // The host populates `state.physicsHighestY` from its Rapier world
    // each frame; the rules pack just declares the threshold.
    endCondition: (state) => {
      const highest = state && Number.isFinite(state.physicsHighestY)
        ? state.physicsHighestY
        : -Infinity;
      if (highest > PHYSICS_TOPOUT_Y) {
        return { reason: 'topout' };
      }
      return null;
    },

    // No modern-rules onLinesCleared hook — physics doesn't fire
    // GARBAGE_SENT (single-player only, can't run in versus per
    // archived §8.11) and doesn't track combo / B2B.
    onLinesCleared:    null,
    onTick:            null,

    // The HUD reads `state.modeView` for the Physics-specific badge.
    // `settledCubes` and `layersCleared` are surfaced by the host via
    // a per-frame view update — the pack just declares the shape.
    initialModeView: Object.freeze({
      kind:           'physics',
      settledCubes:   0,
      layersCleared:  0,
      bodyOverflow:   false, // true when topout threshold was crossed
    }),

    // Custom best-slot updater (plan v2 §2.3 Phase E). Physics tracks
    // `bestLayersCleared` (highest single-run total) and
    // `totalLayersCleared` (Zen-style cumulative across all attempts).
    // The default score-based updater would write the score field too,
    // but we override here so the slot stays focused on the
    // physics-specific metric. The host populates
    // `summary.physicsLayersCleared` from session.layersClearedTotal
    // before calling recordEndOfRun.
    updateBest: (best, summary) => {
      const layers = (summary && Number.isFinite(summary.physicsLayersCleared))
        ? summary.physicsLayersCleared | 0
        : 0;
      best.bestLayersCleared = Math.max(best.bestLayersCleared || 0, layers);
      best.totalLayersCleared = (best.totalLayersCleared || 0) + layers;
      // Score also recorded — physics IS scored, just not via the
      // standard score-best path. Higher single-run score wins.
      if (summary && Number.isFinite(summary.score) && summary.score > (best.score || 0)) {
        best.score = summary.score;
      }
    },

    // Pure-physics constants surfaced for tests / HUDs.
    physicsTopoutY:        PHYSICS_TOPOUT_Y,
    physicsLayerScore:     PHYSICS_LAYER_SCORE,
  });
}

// Test / introspection accessors.
export const _PHYSICS_TOPOUT_Y    = PHYSICS_TOPOUT_Y;
export const _PHYSICS_LAYER_SCORE = PHYSICS_LAYER_SCORE;
