// vfx/director — gameplay → cinematic translation.
//
// This is *the* place game-feel decisions live. Gameplay describes the world
// (LINE_CLEAR, HARD_DROP, LEVEL_UP, …); the director decides what the show
// looks like. Tuning the feel of a 4-line clear should mean editing one
// function in this file, not chasing edits across gameplay code.
//
// The director itself is pure logic — no THREE, no DOM, no audio APIs. It
// receives a small `api` object whose implementations live elsewhere (today:
// inline functions in app/main.js; tomorrow: vfx/emitters, materials, etc.).
// As subsystems extract, only the api wiring at the call site moves; the
// director's internals do not.
//
// Usage:
//   const stop = registerDirector(bus, {
//     impactRing, hardDropTrail, sfx, levelUpFx,
//     // Stage 8b — line-clear orchestration:
//     stageController, lineClearLayers,
//   });
//   // … later, to tear down (tests, hot-reload):
//   stop();

import { EVENTS } from '../gameplay/events.js';
import { tierForRows } from '../config/stages.js';

/**
 * @typedef {Object} LineClearLayers
 * Recipe-gated emitters fired by the orchestrator. Each is optional; missing
 * entries are skipped silently so subsystems can be wired incrementally.
 * @property {(rows: number[], colors: number[]) => void} [sparkle]   stage-palette burst (Layer 2)
 * @property {(rows: number[], colors: number[]) => void} [flash]     row-aligned flash slabs (Layer 5)
 * @property {(rows: number[], color: number, rowCount: number) => void} [shockwave] expanding ring (Layer 3)
 * @property {(rowCount: number) => void} [veil]                       camera-space tint (Layer 6)
 * @property {(rows: number[], accentHex: number, rowCount: number) => void} [envReaction] outside-case reaction (Layer 7)
 */

/**
 * @typedef {Object} StageControllerLike
 * Read-only interface the orchestrator needs from the stage controller.
 * @property {{ accentHex?: number, clearRecipe?: Record<string, {sparkle?:boolean,flash?:boolean,shockwave?:boolean,veil?:boolean,envReaction?:boolean}> }} spec
 */

/**
 * @typedef {Object} BeatGridLike
 * Read-only beat-grid surface used for beat-quantized scheduling. Optional
 * — when omitted, the orchestrator fires every layer immediately. When
 * present + analyzed + the next beat is within the lookahead window, the
 * "peripheral" layers (flash, shockwave, veil, envReaction) fire ON the
 * beat instead.
 * @property {boolean} isAnalyzed
 * @property {number}  secondsUntilNextBeat
 * @property {number}  nextBeatTimeSec
 * @property {(at: number, fn: () => void) => void} scheduleAt
 */

/**
 * @typedef {Object} DirectorApi
 * @property {(x: number, y: number, color: number) => void} impactRing
 * @property {(cells: Array<{col:number,row:number}>, dropRows: number, color: number) => void} hardDropTrail
 * @property {(name: string, arg?: any) => void} sfx
 * @property {(level: number) => void} levelUpFx
 * @property {StageControllerLike}  [stageController]   Stage 8b — present once stages are wired.
 * @property {LineClearLayers}      [lineClearLayers]   Stage 8b — recipe-gated emitter callbacks.
 * @property {BeatGridLike}         [beatGrid]          Optional — enables beat-quantized scheduling.
 */

/**
 * LineClearOrchestrator — Stage 8b + beat-quantized scheduling.
 *
 * Subscribes (via registerDirector) to LINE_CLEAR; reads
 * `stageController.spec.clearRecipe[tier]` for the active stage; fires only
 * the layer flags the recipe enables for that tier. The recipe is the
 * single knob that turns "every clear fires every layer faintly" into
 * "single is muted, triple is escalated, Tetris is cinematic" (plan §1.6.3).
 *
 * If `beatGrid` is provided AND analyzed AND the next beat is within
 * `BEAT_QUANTIZE_WINDOW_SEC`, the "peripheral" layers (flash, shockwave,
 * veil, envReaction) are scheduled to fire ON the next beat. The
 * "intra-case" layers (sparkle) always fire immediately — they're tied to
 * the cleared rows' visual cascade, not the music. Plan §1.6.4 / §9.5
 * binding: "the room responds *with* the beat."
 *
 * Pure logic — receives spawn callbacks, never touches THREE/DOM/audio.
 *
 * @param {{ stageController: StageControllerLike, lineClearLayers: LineClearLayers, beatGrid?: BeatGridLike }} deps
 */
// Maximum delay we'll tolerate to "wait for the beat." Past this, the
// scheduled flash/shockwave/veil would visibly trail the clear cascade,
// which reads as a stutter rather than a punctuation. 200 ms keeps the
// visual coupling tight while still allowing meaningful quantization.
const BEAT_QUANTIZE_WINDOW_SEC = 0.20;

export function createLineClearOrchestrator({ stageController, lineClearLayers, beatGrid = null }) {
  if (!stageController) throw new Error('LineClearOrchestrator requires stageController');
  if (!lineClearLayers) throw new Error('LineClearOrchestrator requires lineClearLayers');

  // `beatGrid` may be either the resolved object OR a zero-arg thunk that
  // returns it. Thunk form lets call sites pass `() => beatGrid` when the
  // beat grid is declared after `registerDirector` runs — without it,
  // referencing a `const` before its declaration is a TDZ error and
  // crashes module load.
  function _resolveBeatGrid() {
    if (beatGrid == null) return null;
    return typeof beatGrid === 'function' ? beatGrid() : beatGrid;
  }

  // Decide whether to fire `fn` now or schedule it to the next beat.
  // Falls back to immediate firing whenever beatGrid isn't ready or the
  // next beat is outside the quantization window — graceful degradation
  // when the BPM analyzer hasn't returned yet, between songs, or on
  // tracks with bad confidence.
  function fireOrSchedule(fn) {
    const bg = _resolveBeatGrid();
    if (!bg || !bg.isAnalyzed) {
      fn();
      return;
    }
    const delay = bg.secondsUntilNextBeat;
    if (delay == null || delay <= 0 || delay > BEAT_QUANTIZE_WINDOW_SEC) {
      fn();
      return;
    }
    bg.scheduleAt(bg.nextBeatTimeSec, fn);
  }

  return {
    /**
     * @param {{ rows: number[], simultaneous: number, colors: number[], overallColor?: number }} payload
     */
    onClear({ rows, simultaneous, colors, overallColor }) {
      const spec = stageController.spec;
      const recipe = spec && spec.clearRecipe
        ? spec.clearRecipe[tierForRows(simultaneous)]
        : null;
      if (!recipe) return;

      // Layer 2 — stage-palette sparkle. Always present at every tier in the
      // current stages; tied to the cleared-row cascade visually, so it
      // fires immediately regardless of the beat grid.
      if (recipe.sparkle && lineClearLayers.sparkle) {
        lineClearLayers.sparkle(rows, colors);
      }
      // Layer 5 — flash slabs. Beat-quantized when possible (peaks on the
      // beat for cinematic punch).
      if (recipe.flash && lineClearLayers.flash) {
        fireOrSchedule(() => lineClearLayers.flash(rows, colors));
      }
      // Layer 3 — shockwave ring. Beat-quantized.
      if (recipe.shockwave && lineClearLayers.shockwave) {
        const color = overallColor != null ? overallColor : 0xffffff;
        fireOrSchedule(() => lineClearLayers.shockwave(rows, color, simultaneous));
      }
      // Layer 6 — full-screen accent veil. Beat-quantized.
      if (recipe.veil && lineClearLayers.veil) {
        fireOrSchedule(() => lineClearLayers.veil(simultaneous));
      }
      // Layer 7 — environment reaction (outside the case). Beat-quantized.
      // Stage accent (not block color) — §1.6.2 rule 2.
      if (recipe.envReaction && lineClearLayers.envReaction) {
        const accent = (spec && spec.accentHex != null) ? spec.accentHex : 0xffffff;
        fireOrSchedule(() => lineClearLayers.envReaction(rows, accent, simultaneous));
      }
    },
  };
}

/**
 * Wire gameplay events to cinematic effects.
 * Returns an unsubscribe function that detaches all handlers.
 *
 * @param {{ on: Function }} bus
 * @param {DirectorApi} api
 * @returns {() => void}
 */
export function registerDirector(bus, api) {
  const offs = [];

  // Hard drop: a settled-piece visual punch — ring at the impact row, vertical
  // light trail along the dropped path, and a punchy SFX. Trail length scales
  // with drop distance so a long drop reads visibly heavier than a short one.
  offs.push(
    bus.on(EVENTS.HARD_DROP, ({ ringX, ringY, color, cells, dropRows }) => {
      api.impactRing(ringX, ringY, color);
      api.hardDropTrail(cells, dropRows, color);
      api.sfx('drop');
    })
  );

  // Level up: deliberately small for now — just the existing UI callout.
  // When the cinematic palette grows (camera lift, exposure tween, etc.) this
  // is where they layer in.
  offs.push(
    bus.on(EVENTS.LEVEL_UP, ({ level }) => {
      api.levelUpFx(level);
    })
  );

  // Line clear: orchestrator gates the recipe layers. Wired only when the
  // call site supplies the stage controller + layer callbacks; older call
  // sites that don't pass them keep working with no LINE_CLEAR handling
  // (clearLines() owns the model-side updates regardless). `beatGrid` is
  // optional — when present, the orchestrator quantizes peripheral layers
  // to the next beat for cinematic punch.
  if (api.stageController && api.lineClearLayers) {
    const orchestrator = createLineClearOrchestrator({
      stageController: api.stageController,
      lineClearLayers: api.lineClearLayers,
      beatGrid:        api.beatGrid,
    });
    offs.push(
      bus.on(EVENTS.LINE_CLEAR, (payload) => orchestrator.onClear(payload))
    );
  }

  return () => {
    for (const off of offs) off();
    offs.length = 0;
  };
}
