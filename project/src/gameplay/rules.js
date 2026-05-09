// Rules engine — per-mode rule packs (plan_gameplay_1.md §2.1).
//
// A `Rules` object bundles every behavior a mode might want to override:
// scoring, gravity curve, end conditions, hooks fired during the gameplay
// loop. The simulation reads from `rules` instead of branching on
// `Mode.current`; modes that ship later (Sprint, Ultra, Zen, Versus) each
// provide a small file under `gameplay/rules/<key>.js` that builds and
// returns a customized Rules.
//
// Pure module. No THREE, no DOM, no AudioContext. Tested in pure Node.
//
// Default values mirror today's inline behaviour exactly — Classic must
// play identically before and after the refactor (see §11 risk table).

import { lineClearScore, levelForLines, SOFT_DROP_POINTS_PER_CELL, HARD_DROP_POINTS_PER_CELL } from './scoring.js';
import { buildMarathonRules } from './rules/marathon.js';
import { buildSprintRules }   from './rules/sprint.js';
import { buildUltraRules }    from './rules/ultra.js';
import { buildZenRules }      from './rules/zen.js';
import { buildVersusRules }   from './rules/versus.js';

/**
 * @typedef {Object} EndResult
 * @property {'topout'|'goal'|'time'|'forfeit'} reason
 * @property {number} [score]
 * @property {number} [lines]
 * @property {number} [level]
 * @property {number} [timeMs]
 */

/**
 * @typedef {Object} ModeView
 * @description HUD snapshot — switched on `kind`. The classic mode produces
 * `{ kind: 'classic' }`; future packs add `{ kind: 'sprint', linesRemaining,
 *  timeMs }` etc. The HUD dispatches on `kind` (plan §2.5).
 * @property {string} kind
 */

/**
 * @typedef {Object} GameplayState
 * @description Read-only snapshot the rules engine observes. Field set is
 * intentionally minimal — adding fields is a contract change.
 * @property {number} score
 * @property {number} lines
 * @property {number} level
 * @property {number} linesCleared    (often === lines — exposed separately
 *                                     so future modes that don't use the
 *                                     standard line counter can deviate)
 * @property {number} timeMs          Elapsed gameplay time (ms; pause-aware).
 *                                    Always provided; default-zeroed.
 */

/**
 * @typedef {Object} Rules
 * @property {string}   key
 *
 * @property {(rowCount: number, level: number, clearType?: 'normal'|'tspin'|'mini') => number} lineScore
 *   Score awarded on a line clear of `rowCount` rows at the given level.
 *   Optional `clearType` selects between standard and T-spin tables
 *   (plan §12 M2). Default: standard `lineClearScore`.
 *
 * @property {number}   softDropPerCell    Default 1 (one point per soft-drop tick).
 * @property {number}   hardDropPerCell    Default 2 (two points per hard-drop cell).
 *
 * @property {(level: number) => number} fallIntervalSec
 *   Seconds between gravity ticks at the given level. Default mirrors the
 *   inline `0.85 * 0.85^(lvl-1) / TWEAKS.gravity` curve. Modes can override
 *   to lock gravity (Sprint) or ramp differently.
 *
 * @property {(state: GameplayState) => EndResult|null} endCondition
 *   Called once per locked piece (and once per second for time-based modes).
 *   Returns `null` to continue, or `{ reason: ... }` to terminate. Topout is
 *   handled outside the rules engine — this hook is for goal/time/forfeit.
 *
 * @property {((state: GameplayState, rowsCleared: number) => void) | null} onLinesCleared
 *   Optional — Marathon emits MODE_GOAL_PROGRESS at 10-line milestones, etc.
 *
 * @property {((state: GameplayState, dtMs: number) => void) | null} onTick
 *   Optional — Sprint accumulates state.timeMs, Ultra fires late-second
 *   pulses. dtMs is the gameplay tick delta in milliseconds.
 *
 * @property {boolean}  resetsHighScoreSlot
 *   When false (Zen), the mode's score never enters the global high-score
 *   slot — only the per-mode best.
 *
 * @property {ModeView} initialModeView
 *   Seed value for the HUD. Each mode's HUD reads `state.modeView` (managed
 *   externally — main.js); the rules pack just provides the shape.
 *
 * @property {(level: number) => number} levelForLines
 *   Total cleared lines → current level. Default: every 10 lines.
 */

const DEFAULT_FALL_INTERVAL = (level, gravityScalar = 1.0) =>
  Math.max(0.04, (0.85 * Math.pow(0.85, level - 1)) / gravityScalar);

/**
 * The Classic rules pack — every override is a no-op (returns the default).
 * This is also the baseline for new packs: build off of `classic` and
 * override only the fields you need.
 *
 * @param {Object} [opts]
 * @param {() => number} [opts.gravityScalar]   Live read of TWEAKS.gravity
 *   so the live tweak slider keeps working. Always wrapped in a thunk so a
 *   slider drag mid-game is reflected immediately. Defaults to () => 1.0.
 * @param {{emit:(topic:string,payload:any)=>void}} [opts.bus]
 *   Optional event bus — passed through to packs that emit
 *   `MODE_GOAL_PROGRESS` from inside their hooks. Classic doesn't use it;
 *   the parameter is here for API symmetry across packs.
 * @returns {Rules}
 */
function buildClassicRules(opts = {}) {
  const gravityScalar = opts.gravityScalar || (() => 1.0);
  return Object.freeze({
    key:               'classic',
    lineScore:         (rowCount, level, clearType) => lineClearScore(rowCount, level, clearType),
    softDropPerCell:   SOFT_DROP_POINTS_PER_CELL,
    hardDropPerCell:   HARD_DROP_POINTS_PER_CELL,
    fallIntervalSec:   (level) => DEFAULT_FALL_INTERVAL(level, gravityScalar()),
    endCondition:      () => null,
    onLinesCleared:    null,
    onTick:            null,
    resetsHighScoreSlot: true,
    initialModeView:   Object.freeze({ kind: 'classic' }),
    levelForLines:     levelForLines,
    goalMultiplier:    1.0, // applied at endRun(reason:'goal') — classic never reaches it
  });
}

// Registry of mode-key → builder. Future modes (Sprint, Ultra, Zen, Versus)
// register their builders here as their files land. Unknown keys fall back
// to classic so a stale persisted mode-key doesn't crash the boot path.
const BUILDERS = Object.freeze({
  classic:  buildClassicRules,
  marathon: buildMarathonRules,
  sprint:   buildSprintRules,
  ultra:    buildUltraRules,
  zen:      buildZenRules,
  versus:   buildVersusRules,
});

/**
 * Build a Rules object for the given mode key.
 *
 * @param {string} modeKey
 * @param {Object} [opts]
 * @returns {Rules}
 */
export function buildRules(modeKey, opts = {}) {
  const builder = BUILDERS[modeKey] || BUILDERS.classic;
  return builder(opts);
}

/** For tests / introspection. */
export const _BUILDERS = BUILDERS;
export const _DEFAULT_FALL_INTERVAL = DEFAULT_FALL_INTERVAL;
