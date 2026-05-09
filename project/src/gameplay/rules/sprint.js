// Sprint rules pack — race to 40 lines (plan_gameplay_1.md §3.3).
//
// Decisions kept from the plan, documented here so future tuning doesn't
// have to re-derive:
//
// - Score is **zero**. Sprint is a time-only metric; setting `lineScore` to
//   () => 0 makes the HUD score field honest (it shows 0 the entire run,
//   which the sprint-badge layout pushes off the visual hierarchy in favor
//   of the timer).
// - Gravity is **locked at level 1** (Option A in §3.3). The community Sprint
//   convention; players control pace via soft/hard drop. Implemented by
//   calling `fallIntervalSec(1)` regardless of the `level` arg the engine
//   passes in.
// - Timer accumulator lives in main.js (`_modeTimeMs`); this rules pack's
//   `onTick` is therefore a no-op for time-tracking. The plan's "onTick:
//   accumulate state.timeMs" was a recommended *if* state.timeMs were
//   rules-managed. Since the host owns it (single source of truth across
//   all modes), we don't double-accumulate here.
// - Milestones every 5 lines (5, 10, … 35 — 40 is reserved for MODE_END).
//
// Pure module. No THREE, no DOM, no AudioContext. Tested in pure Node.

import { SOFT_DROP_POINTS_PER_CELL, HARD_DROP_POINTS_PER_CELL, levelForLines } from '../scoring.js';
import { EVENTS } from '../events.js';

const TARGET_LINES       = 40;
const MILESTONE_INTERVAL = 5;

// Mirrors the classic curve — duplicated to keep this file dependency-free.
// Sprint never reads `level` because gravity is locked at 1, but the math
// is here for clarity and for any future "Sprint variants" that ramp.
const DEFAULT_FALL_INTERVAL = (level, gravityScalar = 1.0) =>
  Math.max(0.04, (0.85 * Math.pow(0.85, level - 1)) / gravityScalar);

/**
 * @param {Object} [opts]
 * @param {() => number} [opts.gravityScalar]
 * @param {{emit:(topic:string,payload:any)=>void}} [opts.bus]
 *   Optional. Fires `MODE_GOAL_PROGRESS` at every 5-line crossing.
 */
export function buildSprintRules(opts = {}) {
  const gravityScalar = opts.gravityScalar || (() => 1.0);
  const bus           = opts.bus           || null;

  let lastMilestoneFired = 0;

  return Object.freeze({
    key:               'sprint',
    // Sprint deliberately has no scoring — bestTimeMs is the leaderboard
    // metric. Returning 0 keeps the SCORE_DELTA pipeline running (the
    // bus event still fires) so the HUD can show "0" honestly.
    lineScore:         () => 0,
    softDropPerCell:   SOFT_DROP_POINTS_PER_CELL,
    hardDropPerCell:   HARD_DROP_POINTS_PER_CELL,
    // Gravity-locked: ignore the level argument and always return the
    // level-1 interval. The host's `_modeTimeMs` clock keeps moving; the
    // player's pace is the only variable.
    fallIntervalSec:   () => DEFAULT_FALL_INTERVAL(1, gravityScalar()),
    levelForLines:     levelForLines,
    resetsHighScoreSlot: false, // Sprint score is always 0; nothing to high-score
    goalMultiplier:    1.0,

    endCondition: (state) => {
      if (state && state.linesCleared >= TARGET_LINES) {
        return { reason: 'goal' };
      }
      return null;
    },

    onLinesCleared: (state /*, rowsCleared */) => {
      if (!state) return;
      const linesAtCap = Math.min(state.linesCleared, TARGET_LINES - 1);
      const milestone = Math.floor(linesAtCap / MILESTONE_INTERVAL) * MILESTONE_INTERVAL;
      if (milestone <= lastMilestoneFired) return;
      if (milestone < MILESTONE_INTERVAL) return;
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

    initialModeView: Object.freeze({
      kind:           'sprint',
      linesRemaining: TARGET_LINES,
      target:         TARGET_LINES,
      timeMs:         0,
    }),

    goalTarget: TARGET_LINES,
  });
}

export const SPRINT_TARGET_LINES   = TARGET_LINES;
export const SPRINT_MILESTONE_STEP = MILESTONE_INTERVAL;
