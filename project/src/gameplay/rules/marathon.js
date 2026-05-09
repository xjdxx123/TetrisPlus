// Marathon rules pack — clear 150 lines for a 1.5× score multiplier
// (plan_gameplay_1.md §3.2).
//
// Engine seam decisions (kept from the plan; documented here so future
// re-balancing doesn't have to re-derive them):
//
// - Multiplier (1.5×) lives in this pack as `goalMultiplier`. Tunable here;
//   `gameplay/end-of-run.js` is the consumer that applies it on
//   `MODE_END { reason: 'goal' }` only — topouts skip the multiplier.
// - The multiplier scales the WHOLE run score (line clears + soft-drop +
//   hard-drop). Per the plan: simpler reasoning beats per-source bookkeeping.
// - Milestone events fire every 10 cleared lines (10, 20, …, 140). The
//   150-line crossing is intentionally NOT emitted as a milestone — the
//   `endCondition` reads the same threshold and fires `MODE_END`, which is
//   the louder signal HUDs and the director should react to.
// - This pack reads `state.linesCleared` (not `state.lines`) — they happen
//   to be the same today but the contract in §2.1 names them as separate
//   fields for future modes that count lines differently.
//
// Pure module. No THREE, no DOM, no AudioContext. Tested in pure Node.

import { lineClearScore, levelForLines, SOFT_DROP_POINTS_PER_CELL, HARD_DROP_POINTS_PER_CELL } from '../scoring.js';
import { EVENTS } from '../events.js';

const TARGET_LINES        = 150;
const GOAL_MULTIPLIER     = 1.5;
const MILESTONE_INTERVAL  = 10;

// Mirrors gameplay/rules.js#DEFAULT_FALL_INTERVAL — duplicated so this file
// has no inward dependency on the host module. Trivially small; refactoring
// these few lines into a shared `shared/gravity.js` is a future cleanup
// once 3-4 modes share the same curve.
const DEFAULT_FALL_INTERVAL = (level, gravityScalar = 1.0) =>
  Math.max(0.04, (0.85 * Math.pow(0.85, level - 1)) / gravityScalar);

/**
 * @param {Object} [opts]
 * @param {() => number} [opts.gravityScalar]
 * @param {{emit:(topic:string,payload:any)=>void}} [opts.bus]
 *   Optional. When provided, `onLinesCleared` emits `MODE_GOAL_PROGRESS` as
 *   the player crosses each 10-line milestone. Tests that don't care about
 *   bus emission omit this and just verify the hook runs without throwing.
 */
export function buildMarathonRules(opts = {}) {
  const gravityScalar = opts.gravityScalar || (() => 1.0);
  const bus           = opts.bus           || null;

  // Closure-captured milestone tracker — the host (main.js) builds a fresh
  // rules pack on every Mode.start, so this resets cleanly across runs
  // without an explicit reset hook.
  let lastMilestoneFired = 0;

  return Object.freeze({
    key:               'marathon',
    lineScore:         (rowCount, level, clearType) => lineClearScore(rowCount, level, clearType),
    softDropPerCell:   SOFT_DROP_POINTS_PER_CELL,
    hardDropPerCell:   HARD_DROP_POINTS_PER_CELL,
    fallIntervalSec:   (level) => DEFAULT_FALL_INTERVAL(level, gravityScalar()),
    levelForLines:     levelForLines,
    resetsHighScoreSlot: true,

    // 150-line goal — the universal terminal. Topout is handled by the host
    // independently of this hook (it doesn't go through endCondition).
    endCondition: (state) => {
      if (state && state.linesCleared >= TARGET_LINES) {
        return { reason: 'goal' };
      }
      return null;
    },

    // Fire MODE_GOAL_PROGRESS the FIRST time linesCleared crosses each
    // 10-line boundary. A multi-line clear that crosses two boundaries at
    // once still emits one event (we report the highest crossed milestone),
    // matching the "progress signal, not stream" intent of the bus topic.
    onLinesCleared: (state /*, rowsCleared */) => {
      if (!state) return;
      // Floor to the nearest milestone, capped below TARGET so the
      // 150-line crossing belongs to MODE_END, not MODE_GOAL_PROGRESS.
      const linesAtCap = Math.min(state.linesCleared, TARGET_LINES - 1);
      const milestone = Math.floor(linesAtCap / MILESTONE_INTERVAL) * MILESTONE_INTERVAL;
      if (milestone <= lastMilestoneFired) return;
      if (milestone < MILESTONE_INTERVAL) return; // never fire for the 0-line milestone
      lastMilestoneFired = milestone;
      if (bus) {
        bus.emit(EVENTS.MODE_GOAL_PROGRESS, {
          kind:   'lines',
          value:  state.linesCleared,
          target: TARGET_LINES,
        });
      }
    },

    onTick: null,

    // initialModeView seeds the HUD. The Marathon badge reads `linesRemaining`
    // (computed from snapshot.linesCleared) and `multiplier`; `target` is
    // exposed so a future "X / 150" formatter can avoid hardcoding 150.
    initialModeView: Object.freeze({
      kind:           'marathon',
      linesRemaining: TARGET_LINES,
      target:         TARGET_LINES,
      multiplier:     GOAL_MULTIPLIER,
    }),

    // Marathon-specific surface — read by gameplay/end-of-run.js when the
    // run terminates with `reason: 'goal'`.
    goalMultiplier: GOAL_MULTIPLIER,
    goalTarget:     TARGET_LINES,
  });
}

export const MARATHON_TARGET_LINES   = TARGET_LINES;
export const MARATHON_MULTIPLIER     = GOAL_MULTIPLIER;
export const MARATHON_MILESTONE_STEP = MILESTONE_INTERVAL;
