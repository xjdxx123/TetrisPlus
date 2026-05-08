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
 */

/**
 * @typedef {Object} StageControllerLike
 * Read-only interface the orchestrator needs from the stage controller.
 * @property {{ clearRecipe?: Record<string, {sparkle?:boolean,flash?:boolean,shockwave?:boolean,veil?:boolean}> }} spec
 */

/**
 * @typedef {Object} DirectorApi
 * @property {(x: number, y: number, color: number) => void} impactRing
 * @property {(cells: Array<{col:number,row:number}>, dropRows: number, color: number) => void} hardDropTrail
 * @property {(name: string, arg?: any) => void} sfx
 * @property {(level: number) => void} levelUpFx
 * @property {StageControllerLike}  [stageController]   Stage 8b — present once stages are wired.
 * @property {LineClearLayers}      [lineClearLayers]   Stage 8b — recipe-gated emitter callbacks.
 */

/**
 * LineClearOrchestrator — Stage 8b of plan_particle_2.md.
 *
 * Subscribes (via registerDirector) to LINE_CLEAR; reads
 * `stageController.spec.clearRecipe[tier]` for the active stage; fires only
 * the layer flags the recipe enables for that tier. The recipe is the
 * single knob that turns "every clear fires every layer faintly" into
 * "single is muted, triple is escalated, Tetris is cinematic" (plan §1.6.3).
 *
 * Pure logic — receives spawn callbacks, never touches THREE/DOM/audio.
 *
 * @param {{ stageController: StageControllerLike, lineClearLayers: LineClearLayers }} deps
 */
export function createLineClearOrchestrator({ stageController, lineClearLayers }) {
  if (!stageController) throw new Error('LineClearOrchestrator requires stageController');
  if (!lineClearLayers) throw new Error('LineClearOrchestrator requires lineClearLayers');

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
      // current stages; included in the recipe so a future "no-sparkle" stage
      // can opt out without code changes.
      if (recipe.sparkle && lineClearLayers.sparkle) {
        lineClearLayers.sparkle(rows, colors);
      }
      // Layer 5 — flash slabs (row-aligned, color-tinted). Tetris-tier in
      // the seed stages.
      if (recipe.flash && lineClearLayers.flash) {
        lineClearLayers.flash(rows, colors);
      }
      // Layer 3 — shockwave ring. Triple+ in the seed stages. The fallback
      // color is white if the gameplay event omits overallColor.
      if (recipe.shockwave && lineClearLayers.shockwave) {
        lineClearLayers.shockwave(rows, overallColor != null ? overallColor : 0xffffff, simultaneous);
      }
      // Layer 6 — full-screen accent veil (camera-space tonemap bias).
      // Tetris+ in the seed stages.
      if (recipe.veil && lineClearLayers.veil) {
        lineClearLayers.veil(simultaneous);
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
  // (clearLines() owns the model-side updates regardless).
  if (api.stageController && api.lineClearLayers) {
    const orchestrator = createLineClearOrchestrator({
      stageController: api.stageController,
      lineClearLayers: api.lineClearLayers,
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
