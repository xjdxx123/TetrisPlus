// Stage controller — Stage 8 of plan_particle_2.md.
//
// Owns the active stage. Mutating the stage emits a `STAGE_CHANGE` event
// on the engine bus so subscribers (nebula crossfade, palette atlas swap,
// env-reaction swap) can react without holding a direct reference back.
//
// One way data flow:
//   stageController.set('ember-rise')
//        → bus.emit(STAGE_CHANGE, { from, to, spec })
//             → nebula listener calls nebula.crossfadeTo(spec.nebulaPalette)
//             → (future) sparkle listener swaps sprite atlas
//             → (future) env-reaction system swaps active emitters
//
// Read-only access (e.g., the `_stagePalette()` helper in main.js) calls
// `stage.spec` to get the current palette/accent/recipe — no event needed.

import { STAGES, STAGE_NAMES, DEFAULT_STAGE } from '../config/stages.js';

export const STAGE_EVENTS = Object.freeze({
  STAGE_CHANGE: 'STAGE_CHANGE',  // payload: { from: string, to: string, spec: StageSpec }
});

export function createStageController({ bus, initial = DEFAULT_STAGE } = {}) {
  if (!bus) throw new Error('stage-controller requires a bus');
  let current = initial in STAGES ? initial : DEFAULT_STAGE;

  return {
    get current() { return current; },
    get spec()    { return STAGES[current]; },
    get available() { return STAGE_NAMES; },

    set(name) {
      if (!(name in STAGES)) {
        console.warn(`[stage] unknown stage '${name}'. Available:`, STAGE_NAMES);
        return;
      }
      if (name === current) return;
      const from = current;
      current = name;
      bus.emit(STAGE_EVENTS.STAGE_CHANGE, {
        from,
        to: current,
        spec: STAGES[current],
      });
    },

    cycle() {
      const i = STAGE_NAMES.indexOf(current);
      const next = STAGE_NAMES[(i + 1) % STAGE_NAMES.length];
      this.set(next);
    },
  };
}
