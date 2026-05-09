// Ultra rules pack — 2 minutes, max score (plan_gameplay_1.md §3.4).
//
// Design choices kept from the plan:
//
// - Duration is 120,000 ms. Time-attack inverse of Sprint.
// - Scoring is **stock** — line clears + soft/hard drop points use the
//   classic table at the level the player has reached. The time pressure
//   is the multiplier, not a `goalMultiplier`.
// - Gravity uses the **classic curve** — level still ramps inside the
//   2 minutes. Hard drops cheese-the-floor early levels; the curve catches
//   up to the player by the end of the run.
// - Late-second milestones at 30/60/90/110/115/118/119 seconds. The early
//   trio (30/60/90) is a calm 3-stop pacing; the late dense ramp
//   (110/115/118/119) is the "final-seconds tension" hook the plan
//   identifies as Ultra's signature feel.
// - Topout still records the score-at-topout in `modeBests.ultra.bestScore`
//   if it beats the prior best. A topout 1s before time-out shouldn't void
//   a great run. (This is plain end-of-run.js behaviour — no per-mode
//   override needed.)
//
// Time source: this pack reads `state.timeMs` from the snapshot the host
// passes in. The host accumulates `_modeTimeMs` during the gameplay block
// (paused / topout safe), which matches Sprint's timer. The plan's text
// in §3.4 #8 calls Ultra "wall-clock"; in practice, when the tab is
// visible (the default for a 2-minute focused run), gameplay-time and
// wall-clock are indistinguishable. If a future engine update decouples
// the sim tick from rAF, this pack picks up wall-clock semantics for free.

import { lineClearScore, levelForLines, SOFT_DROP_POINTS_PER_CELL, HARD_DROP_POINTS_PER_CELL } from '../scoring.js';
import { EVENTS } from '../events.js';

const DURATION_MS = 120_000;

// Milestones (seconds → ms). Fired from `onTick` the first time `state.timeMs`
// crosses each threshold. Order matters — later milestones must come after
// earlier ones so the "first crossed" lookup terminates correctly.
const MILESTONES_MS = Object.freeze([
  30_000, 60_000, 90_000, 110_000, 115_000, 118_000, 119_000,
]);

const DEFAULT_FALL_INTERVAL = (level, gravityScalar = 1.0) =>
  Math.max(0.04, (0.85 * Math.pow(0.85, level - 1)) / gravityScalar);

/**
 * @param {Object} [opts]
 * @param {() => number} [opts.gravityScalar]
 * @param {{emit:(topic:string,payload:any)=>void}} [opts.bus]
 *   Optional. Fires `MODE_GOAL_PROGRESS` at each milestone crossing.
 */
export function buildUltraRules(opts = {}) {
  const gravityScalar = opts.gravityScalar || (() => 1.0);
  const bus           = opts.bus           || null;

  // Track which milestones have already fired this run. Closure-captured;
  // a fresh rules pack on every Mode.start clears this naturally.
  let nextMilestoneIdx = 0;

  return Object.freeze({
    key:               'ultra',
    lineScore:         (rowCount, level, clearType) => lineClearScore(rowCount, level, clearType),
    softDropPerCell:   SOFT_DROP_POINTS_PER_CELL,
    hardDropPerCell:   HARD_DROP_POINTS_PER_CELL,
    fallIntervalSec:   (level) => DEFAULT_FALL_INTERVAL(level, gravityScalar()),
    levelForLines:     levelForLines,
    resetsHighScoreSlot: true,
    goalMultiplier:    1.0,

    endCondition: (state) => {
      if (state && state.timeMs >= DURATION_MS) {
        return { reason: 'time' };
      }
      return null;
    },

    // No per-line milestones (Ultra is timed, not lines-targeted). Score
    // still increments through the standard pipeline; the badge listens
    // to SCORE_DELTA elsewhere.
    onLinesCleared: null,

    // Time-based milestones — fire each one as the gameplay clock crosses
    // its threshold. We walk forward through the sorted MILESTONES_MS
    // array, never backwards, so a single tick that crosses two
    // milestones (vanishingly unlikely with 16ms frames, but possible
    // after a long pause+resume) emits both.
    onTick: (state /*, dtMs */) => {
      if (!state || !bus) return;
      const t = state.timeMs;
      while (nextMilestoneIdx < MILESTONES_MS.length && t >= MILESTONES_MS[nextMilestoneIdx]) {
        const milestoneMs = MILESTONES_MS[nextMilestoneIdx];
        bus.emit(EVENTS.MODE_GOAL_PROGRESS, {
          kind:   'time',
          value:  milestoneMs,
          target: DURATION_MS,
        });
        nextMilestoneIdx++;
      }
    },

    initialModeView: Object.freeze({
      kind:            'ultra',
      timeRemainingMs: DURATION_MS,
      target:          DURATION_MS,
      score:           0,
    }),

    // Exposed for the HUD + tests.
    duration:    DURATION_MS,
    milestones:  MILESTONES_MS,
  });
}

export const ULTRA_DURATION_MS = DURATION_MS;
export const ULTRA_MILESTONES_MS = MILESTONES_MS;
