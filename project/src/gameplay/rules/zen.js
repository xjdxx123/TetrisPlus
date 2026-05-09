// Zen rules pack — practice mode, no topout (plan_gameplay_1.md §3.5).
//
// Design choices kept from the plan:
//
// - **Gentler gravity** — `(lvl) => max(0.4, 1.0 * 0.92^(lvl-1))`. The
//   floor (0.4s) is forgiving even at very high level. The base interval
//   is 1.0s (vs 0.85s for classic) so even level-1 Zen is calmer.
// - **Topout intercepted**: instead of ending the run, the host removes
//   the bottom N rows (default 4) and the player respawns. The host
//   emits `ZEN_RESCUE { rowsRemoved }` for the VFX layer to render a
//   restorative cascade. This pack only declares the *policy*
//   (`onTopOut`); the host owns the board mutation.
// - **Score never enters the global high score** — `resetsHighScoreSlot:
//   false`. Zen scores are recorded per-mode but don't compete with
//   Classic. (Versus would also override this differently — the rules
//   pack header note in plan §3.6 calls this out.)
// - **End is opt-in only** — `endCondition` always returns null. The
//   only way out is `Mode.stop('forfeit')` from the Stop Session button,
//   which the host routes through MODE_END { reason: 'forfeit' }.
//
// Custom `updateBest` hook: Zen's leaderboard metric is *longest session*,
// not highest score. The host's end-of-run helper consults this hook to
// override the default score-based "best" update.
//
// Pure module. No THREE, no DOM, no AudioContext.

import { lineClearScore, levelForLines, SOFT_DROP_POINTS_PER_CELL, HARD_DROP_POINTS_PER_CELL } from '../scoring.js';

const ZEN_RESCUE_ROWS = 4;
const ZEN_BASE_INTERVAL = 1.0;
const ZEN_DECAY        = 0.92;
const ZEN_FLOOR        = 0.4;

const ZEN_FALL_INTERVAL = (level, gravityScalar = 1.0) =>
  Math.max(ZEN_FLOOR, (ZEN_BASE_INTERVAL * Math.pow(ZEN_DECAY, level - 1)) / gravityScalar);

/**
 * @param {Object} [opts]
 * @param {() => number} [opts.gravityScalar]
 * @param {{emit:(topic:string,payload:any)=>void}} [opts.bus]    Unused — Zen has no progress emissions.
 */
export function buildZenRules(opts = {}) {
  const gravityScalar = opts.gravityScalar || (() => 1.0);

  return Object.freeze({
    key:               'zen',
    lineScore:         (rowCount, level) => lineClearScore(rowCount, level),
    softDropPerCell:   SOFT_DROP_POINTS_PER_CELL,
    hardDropPerCell:   HARD_DROP_POINTS_PER_CELL,
    fallIntervalSec:   (level) => ZEN_FALL_INTERVAL(level, gravityScalar()),
    levelForLines:     levelForLines,
    resetsHighScoreSlot: false,
    goalMultiplier:    1.0,

    // Zen never naturally ends — the run terminates only when the player
    // hits "Stop session", which routes through Mode.stop('forfeit') →
    // host's onStop handler → endRun({ reason: 'forfeit' }).
    endCondition:      () => null,
    onLinesCleared:    null,
    onTick:            null,

    // Topout interceptor — the host calls this from spawnPiece's collision
    // path. `{ end: false, shift: 4 }` tells the host to shift the stack
    // down 4 rows + retry spawn. Default rules packs return `{ end: true }`
    // (or omit the hook), preserving the topout-ends-the-run behaviour.
    onTopOut: (/* state */) => ({ end: false, shift: ZEN_RESCUE_ROWS }),

    // Custom best-slot updater — see plan §3.5 #5. The host's end-of-run
    // helper calls this with `(best, summary)`. Zen tracks longest session
    // + cumulative total lines; score/lines/level are NOT recorded.
    //
    // Both fields are unconditionally initialized to a number (0 if absent
    // on either side), so callers reading the slot after this call always
    // see a numeric value rather than undefined.
    updateBest: (best, summary) => {
      const dur = summary && Number.isFinite(summary.runTimeMs) ? summary.runTimeMs : 0;
      best.longestSessionMs = Math.max(best.longestSessionMs || 0, dur);
      best.totalLines = (best.totalLines || 0) + ((summary && summary.linesClearedThisRun) || 0);
    },

    initialModeView: Object.freeze({
      kind:                  'zen',
      shiftDownsTriggered:   0,
    }),

    // Exposed for the HUD / tests.
    rescueRows: ZEN_RESCUE_ROWS,
  });
}

export const ZEN_RESCUE_ROW_COUNT = ZEN_RESCUE_ROWS;
export const ZEN_FALL_INTERVAL_FN = ZEN_FALL_INTERVAL;
