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
 * @property {(force: number) => void} [shake]
 *   Optional — camera shake impulse (typically 0..2 range). When provided,
 *   the §12 director recipes use it for B2B chain amplification and
 *   Perfect Clear punch. When omitted, the recipes silently skip the
 *   shake portion and emit SFX only.
 */

// §12 modern-rules visual constants (plan_gameplay_2.md §1.2).
//
// Color overrides applied to LINE_CLEAR's overallColor / shockwave when
// the underlying clear carries a special clearType or isPerfectClear /
// isB2B flag. The orchestrator picks the highest-priority override:
//   PC > T-spin > B2B > normal.
const TSPIN_VIOLET    = 0xb84cff; // matches PIECE_COLORS.T
const TSPIN_MINI_DIM  = 0x7e3ab3; // softer violet — Mini reads as smaller punch
const PERFECT_CLEAR_GOLD = 0xffd400;
const B2B_CYAN        = 0x6cf0ff;

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

  /**
   * Modern-rules color override for the shockwave/envReaction layers.
   * Picks the highest-priority special on a clear: Perfect Clear → gold,
   * T-spin → violet, T-spin Mini → softer violet, B2B (without other
   * special) → cyan tint. Returns `null` to leave the default
   * `overallColor` (or stage accent) intact.
   *
   * @param {{clearType?: string, isB2B?: boolean, isPerfectClear?: boolean}} flags
   * @returns {number|null}
   */
  function modernAccentOverride(flags) {
    if (flags && flags.isPerfectClear) return PERFECT_CLEAR_GOLD;
    if (flags && flags.clearType === 'tspin') return TSPIN_VIOLET;
    if (flags && flags.clearType === 'mini')  return TSPIN_MINI_DIM;
    if (flags && flags.isB2B)                  return B2B_CYAN;
    return null;
  }

  return {
    /**
     * @param {{
     *   rows: number[], simultaneous: number,
     *   colors: number[], overallColor?: number,
     *   clearType?: string, isB2B?: boolean, isPerfectClear?: boolean,
     * }} payload
     */
    onClear({ rows, simultaneous, colors, overallColor, clearType, isB2B, isPerfectClear }) {
      const spec = stageController.spec;
      const recipe = spec && spec.clearRecipe
        ? spec.clearRecipe[tierForRows(simultaneous)]
        : null;
      if (!recipe) return;

      // Plan v2 §1.2 — modern-rules color/intensity override. Promotes
      // the clear's tier-derived recipe with a §12-flavored accent for
      // shockwave / envReaction so a T-spin Double doesn't feel
      // visually identical to a plain Double. The intensity argument
      // (last shockwave / envReaction param) gets a +1 bump on B2B
      // continuations so the chain reads as escalating.
      const modernAccent = modernAccentOverride({ clearType, isB2B, isPerfectClear });
      const intensityBoost = isB2B ? 1 : 0;

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
      // Layer 3 — shockwave ring. Beat-quantized. Modern-rules accent
      // overrides the row-mean color when present.
      if (recipe.shockwave && lineClearLayers.shockwave) {
        const fallback = overallColor != null ? overallColor : 0xffffff;
        const color = modernAccent != null ? modernAccent : fallback;
        fireOrSchedule(() => lineClearLayers.shockwave(rows, color, simultaneous + intensityBoost));
      }
      // Layer 6 — full-screen accent veil. Beat-quantized.
      if (recipe.veil && lineClearLayers.veil) {
        fireOrSchedule(() => lineClearLayers.veil(simultaneous + intensityBoost));
      }
      // Layer 7 — environment reaction (outside the case). Beat-quantized.
      // Stage accent (not block color) — §1.6.2 rule 2 — but the
      // §12 modern-rules override takes precedence so a Perfect Clear
      // makes the room react gold even on a non-gold stage.
      if (recipe.envReaction && lineClearLayers.envReaction) {
        const stageAccent = (spec && spec.accentHex != null) ? spec.accentHex : 0xffffff;
        const accent = modernAccent != null ? modernAccent : stageAccent;
        fireOrSchedule(() => lineClearLayers.envReaction(rows, accent, simultaneous + intensityBoost));
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

  // ─── §12 modern-rules cinematic recipes (plan_gameplay_2.md §1.2) ─────
  //
  // The LINE_CLEAR orchestrator above already recolors the shockwave /
  // envReaction layers when the underlying clear is a T-spin / B2B /
  // Perfect Clear. The recipes below add the AUDIO+HAPTIC cues that
  // can't be inferred from a row-clear payload alone — SFX names that
  // main.js maps to its sample bank, and camera-shake impulses for the
  // "this clear hit harder than a regular Tetris" feel.
  //
  // No new layer apis required. Recipes silently skip when the host
  // didn't wire `sfx` or `shake` (older call sites stay functional).

  // T-spin: every detected spin gets an SFX cue, including the
  // 0-clear case (which the LINE_CLEAR orchestrator misses entirely
  // since no row cleared). Mini and regular use distinct sample names
  // so the host can route to different sounds.
  offs.push(
    bus.on(EVENTS.T_SPIN, ({ kind, cleared }) => {
      if (typeof api.sfx !== 'function') return;
      if (kind === 'mini') api.sfx('tspin-mini', { cleared });
      else                  api.sfx('tspin',      { cleared });
    })
  );

  // B2B chain: only celebrate continuations (count >= 2) — the first
  // difficult clear of a chain is announced by the underlying Tetris
  // / T-spin already. Camera shake amplifies with chain length:
  //   chain 2  → 0.4 force
  //   chain 3  → 0.6 force
  //   chain 4+ → capped at 0.8
  // Force values calibrated against the existing hard-drop impulse
  // (~0.15) and rows-cleared force (~0.25 + 0.22*N) so a B2B Tetris
  // reads as "the room punched on top of the regular clear" without
  // overpowering the existing camera math.
  offs.push(
    bus.on(EVENTS.B2B_CHAIN, ({ count }) => {
      if (count < 2) return;
      if (typeof api.sfx === 'function') api.sfx('b2b', { count });
      if (typeof api.shake === 'function') {
        const force = Math.min(0.8, 0.4 + (count - 2) * 0.2);
        api.shake(force);
      }
    })
  );

  // Perfect Clear: the rare hero moment. Single fanfare SFX + medium
  // camera punch. The LINE_CLEAR orchestrator gilds the shockwave +
  // envReaction layers; PC adds audio+haptic on top.
  offs.push(
    bus.on(EVENTS.PERFECT_CLEAR, ({ cleared }) => {
      if (typeof api.sfx === 'function') api.sfx('perfect-clear', { cleared });
      if (typeof api.shake === 'function') api.shake(0.7);
    })
  );

  // ─── Pure Physics — layer-cleared recipe (plan v2 §2.3 Phase F) ────
  //
  // Physics mode never fires LINE_CLEAR (the grid path is bypassed by
  // PhysicsSession). PHYSICS_LAYER_CLEARED is the equivalent. We
  // route it to the same shockwave + sfx + shake surfaces but with
  // physics-specific accents:
  //   - Color: violet (the experimental tier's identity).
  //   - Origin: each layer's `centerY` from the payload, so a
  //     bottom-row clear feels like it's at the bottom and a stack
  //     near the top reads as a high-up event. Uses the existing
  //     shockwave api with synthetic `rows` of the right length.
  //   - SFX: 'physics-layer' (host's audio bank can map this; falls
  //     back to a no-op if unwired).
  //   - Shake: scales with simultaneous layer count (single layer
  //     0.3 force, double 0.5, three+ 0.7 cap).
  if (api.lineClearLayers && api.lineClearLayers.shockwave) {
    offs.push(
      bus.on(EVENTS.PHYSICS_LAYER_CLEARED, ({ layers, simultaneous, cubeCount }) => {
        if (!Array.isArray(layers) || layers.length === 0) return;
        const PHYSICS_VIOLET = 0xd3a8ff; // matches physics-badge accent + T-piece tone
        for (const layer of layers) {
          // The shockwave emitter signature is (rows, color, rowCount)
          // — `rows` indexes are normally board-row integers used to
          // compute world-Y. For physics, we pass a single-element
          // synthetic array `[Math.round(centerY)]` so the existing
          // emitter's bottomRow lookup yields a sensible Y. rowCount
          // controls intensity; pass the layer size (≥ 10).
          api.lineClearLayers.shockwave(
            [Math.round(layer.centerY)],
            PHYSICS_VIOLET,
            Math.max(1, layer.size | 0),
          );
        }
        if (typeof api.sfx === 'function') api.sfx('physics-layer', { simultaneous, cubeCount });
        if (typeof api.shake === 'function') {
          // 0.3 / 0.5 / 0.7 for 1 / 2 / 3+ simultaneous layers.
          const force = Math.min(0.7, 0.3 + (Math.max(0, simultaneous - 1)) * 0.2);
          api.shake(force);
        }
      })
    );
  }

  return () => {
    for (const off of offs) off();
    offs.length = 0;
  };
}
