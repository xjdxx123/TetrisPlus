// Input intents — translates keyboard events into per-frame InputFrame
// objects (plan_gameplay_1.md §3.7 sub-phase 7c).
//
// One InputRouter binds to a window/element with a configurable
// keymap. Each frame the host calls `router.frame()`, which returns
// the current `InputFrame` and resets the discrete-action latches.
//
// Why two flavors of inputs:
// - Continuous (left, right, softDrop) — true while the key is held.
//   The host applies its own DAS/ARR cadence over them.
// - Discrete (rotateCW, rotateCCW, hardDrop, hold, pause) — fire ONCE
//   on keydown then stay false until the next keydown. Holding the
//   key shouldn't auto-repeat the action (rotating one piece per
//   keydown, not 30 rotations from a held key).
//
// The dual-board host (§3.7 sub-phase 7e) constructs two routers, one
// per side, with non-overlapping keymaps. Single-sim main.js still has
// its inline keyboard switch — this module is the foundation, not yet
// the only consumer.
//
// Pure module beyond the listener registration. No THREE, no DOM beyond
// `addEventListener`. Tested in pure Node with a fake target.

/**
 * @typedef {Object} InputFrame
 * @property {boolean} left       Held: piece moves left this frame (DAS-managed by host).
 * @property {boolean} right      Held: piece moves right this frame.
 * @property {boolean} softDrop   Held: gravity 12× faster.
 * @property {boolean} hardDrop   Discrete: latched by router; fires once per keydown.
 * @property {boolean} rotateCW   Discrete.
 * @property {boolean} rotateCCW  Discrete.
 * @property {boolean} hold       Discrete.
 * @property {boolean} pause      Discrete.
 */

/** Empty (all-false) frame — useful as a default for tests / no-op ticks. */
export const EMPTY_FRAME = Object.freeze({
  left: false, right: false, softDrop: false, hardDrop: false,
  rotateCW: false, rotateCCW: false, hold: false, pause: false,
});

/**
 * The canonical action set. Used as the keys of any keymap. Adding an
 * intent here requires adding it to `EMPTY_FRAME` too.
 */
export const INTENT_ACTIONS = Object.freeze([
  'left', 'right', 'softDrop', 'hardDrop',
  'rotateCW', 'rotateCCW', 'hold', 'pause',
]);

/** Discrete actions (latched on keydown, cleared by frame()). */
const DISCRETE_ACTIONS = new Set(['hardDrop', 'rotateCW', 'rotateCCW', 'hold', 'pause']);

/**
 * Default keymap presets per side. P1 owns the standard arrow + Space
 * layout; P2 takes WASD + RShift so both can play on one keyboard
 * without overlap. Each value is an array of `KeyboardEvent.code`
 * strings — multiple aliases per action are allowed (e.g. ShiftLeft +
 * ShiftRight both trigger hold for P1).
 */
export const KEYMAP_PRESETS = Object.freeze({
  player: Object.freeze({
    left:       ['ArrowLeft'],
    right:      ['ArrowRight'],
    softDrop:   ['ArrowDown'],
    hardDrop:   ['Space'],
    rotateCW:   ['ArrowUp', 'KeyX'],
    rotateCCW:  ['KeyZ'],
    hold:       ['KeyC', 'ShiftLeft'],
    pause:      ['KeyP'],
  }),
  opponent: Object.freeze({
    left:       ['KeyA'],
    right:      ['KeyD'],
    softDrop:   ['KeyS'],
    hardDrop:   ['KeyQ'],
    rotateCW:   ['KeyW'],
    rotateCCW:  ['KeyE'],
    hold:       ['ShiftRight'],
    pause:      [],
  }),
});

/**
 * Build a flat lookup `code → action` from a keymap. Used internally by
 * InputRouter; exported so tests can assert mappings without
 * instantiating the router.
 */
export function buildCodeIndex(keymap) {
  const idx = new Map();
  for (const action of INTENT_ACTIONS) {
    const codes = (keymap && keymap[action]) || [];
    for (const code of codes) {
      idx.set(code, action);
    }
  }
  return idx;
}

/**
 * Detect collisions where two routers' keymaps share the same code —
 * one keypress would fire both sides' intent. The host can warn or
 * reassign before constructing.
 *
 * @param {Object} a
 * @param {Object} b
 * @returns {string[]}  Conflicting codes (empty if none).
 */
export function findKeymapConflicts(a, b) {
  const ai = buildCodeIndex(a);
  const conflicts = [];
  for (const [code] of buildCodeIndex(b)) {
    if (ai.has(code)) conflicts.push(code);
  }
  return conflicts;
}

/**
 * Per-side keyboard input router.
 *
 * Lifecycle:
 *   const router = new InputRouter({ side, target });
 *   // each tick:
 *   const frame = router.frame();
 *   game.tick(dtMs, frame);
 *   if (frame.rotateCW) game.tryRotate(1);
 *   ...
 *   router.dispose();
 */
export class InputRouter {
  /**
   * @param {Object} opts
   * @param {string} [opts.side]              'player' / 'opponent' (tag only).
   * @param {Object} [opts.keymap]            Defaults to KEYMAP_PRESETS[side] || .player.
   * @param {EventTarget} [opts.target]       Defaults to globalThis (window in browser).
   * @param {boolean} [opts.preventDefault]   Call e.preventDefault() on matched keys. Default true.
   * @param {(code:string, action:string) => void} [opts.onConflict]
   *   Called once per matched code when another listener has already
   *   handled it (e.g. browser shortcut). Surface for the per-key
   *   warning the plan spec calls for.
   */
  constructor(opts = {}) {
    this._side = opts.side || 'player';
    this._keymap = opts.keymap || KEYMAP_PRESETS[this._side] || KEYMAP_PRESETS.player;
    this._target = opts.target || globalThis;
    this._preventDefault = opts.preventDefault !== false;
    this._onConflict = typeof opts.onConflict === 'function' ? opts.onConflict : null;
    this._codeIndex = buildCodeIndex(this._keymap);

    // Held-key set + discrete-action latch set.
    this._heldActions = new Set();
    this._fired = new Set();

    // Bound handlers — stable refs for add/removeEventListener pairing.
    this._onKeyDown = (e) => this._handleKeyDown(e);
    this._onKeyUp   = (e) => this._handleKeyUp(e);
    this._target.addEventListener('keydown', this._onKeyDown);
    this._target.addEventListener('keyup',   this._onKeyUp);
  }

  /**
   * Snapshot the current frame's intents. Called once per tick. Returns
   * a fresh object (not frozen — host is free to forward it). Discrete
   * actions are cleared after this call so the next frame starts clean.
   *
   * @returns {InputFrame}
   */
  frame() {
    const out = {
      left:       this._heldActions.has('left'),
      right:      this._heldActions.has('right'),
      softDrop:   this._heldActions.has('softDrop'),
      hardDrop:   this._fired.has('hardDrop'),
      rotateCW:   this._fired.has('rotateCW'),
      rotateCCW:  this._fired.has('rotateCCW'),
      hold:       this._fired.has('hold'),
      pause:      this._fired.has('pause'),
    };
    this._fired.clear();
    return out;
  }

  /**
   * Force-clear all input state. Useful when the user blurs the window
   * or pauses — held keys could otherwise stay "stuck" if the keyup
   * fired off-target.
   */
  clear() {
    this._heldActions.clear();
    this._fired.clear();
  }

  /**
   * Hot-swap the keymap. Existing held keys are cleared (a stale
   * "ArrowLeft held" shouldn't survive a remap to a different mode).
   */
  setKeymap(keymap) {
    this._keymap = keymap;
    this._codeIndex = buildCodeIndex(keymap);
    this.clear();
  }

  /** Tear down — removes the keydown/keyup listeners. */
  dispose() {
    this._target.removeEventListener('keydown', this._onKeyDown);
    this._target.removeEventListener('keyup',   this._onKeyUp);
    this.clear();
  }

  // ─── Internal ────────────────────────────────────────────────────────

  _handleKeyDown(e) {
    const action = this._codeIndex.get(e.code);
    if (!action) return;
    if (this._preventDefault && typeof e.preventDefault === 'function') {
      e.preventDefault();
    }
    if (e.defaultPrevented === false && this._onConflict) {
      // Caller wants to know — not strictly a conflict, but a hook to
      // log unexpected propagation.
      this._onConflict(e.code, action);
    }
    if (DISCRETE_ACTIONS.has(action)) {
      // Edge-trigger only on first keydown. Browsers fire keydown
      // repeatedly while held — we don't want hardDrop firing 30×/sec.
      if (!this._heldActions.has(action)) this._fired.add(action);
    }
    this._heldActions.add(action);
  }

  _handleKeyUp(e) {
    const action = this._codeIndex.get(e.code);
    if (!action) return;
    this._heldActions.delete(action);
  }
}
