// Game-mode namespace (plan_UI_1.md §3.7, plan_gameplay_1.md §4).
//
// Layer 1 — the `select` / `onChange` / `current` registry persisted with
// settings. The settings panel's mode buttons drive this.
//
// Layer 2 — the `start` / `stop` / `config` lifecycle hooks the rules
// engine surfaces. `start()` is the single entry point that triggers a
// fresh run with the active mode's rules; `stop()` forces an early
// terminal (Zen "Stop session", future Versus "Forfeit"). The actual game
// reset is delegated to a caller-supplied callback so this module stays
// pure (no DOM, no THREE, testable in Node).
//
// Today every rules pack resolves to Classic (gameplay/rules.js); when
// future mode-specific packs land, this file does NOT change — buildRules
// is the seam.

const AVAILABLE = Object.freeze([
  'classic',
  'marathon',
  'sprint',
  'ultra',
  'zen',
  'versus',
]);

const LABELS = Object.freeze({
  classic:  'Classic',
  marathon: 'Marathon',
  sprint:   'Sprint',
  ultra:    'Ultra',
  zen:      'Zen',
  versus:   'Versus',
});

// Future-behavior contract — informational; useful when modes ship to
// avoid having to re-derive the design intent from §2.3 of the plan.
const DESCRIPTIONS = Object.freeze({
  classic:  'Endless. Default rules.',
  marathon: 'Ends at 150 lines, score multiplier.',
  sprint:   'Race to 40 lines, time displayed.',
  ultra:    '2-minute timer, max score.',
  zen:      'No game-over (top-out shifts the stack down).',
  versus:   'Reserved — needs network or AI. Disabled until then.',
});

// Modes the v1 plan ships with disabled-looking. The UI greys these out
// but the underlying state machine still allows selection (so a future
// release that wires the logic doesn't have to also add a UI affordance).
// Versus is enabled in Phase 6 — local 1v1 vs an AI bot opponent.
const DISABLED = Object.freeze({});

// Per-mode metadata consumed by Mode.config() — used by the settings
// panel's "Goal: …" text + Stats tab formatters.
const CONFIG = Object.freeze({
  classic:  Object.freeze({ goalLabel: 'Endless',                 hudKind: 'classic',  estimatedDurationMin: null, isOnline: false, isExperimental: false }),
  marathon: Object.freeze({ goalLabel: '150 lines (1.5× bonus)',  hudKind: 'marathon', estimatedDurationMin: 8,    isOnline: false, isExperimental: false }),
  sprint:   Object.freeze({ goalLabel: '40 lines (race the clock)', hudKind: 'sprint', estimatedDurationMin: 1,    isOnline: false, isExperimental: false }),
  ultra:    Object.freeze({ goalLabel: '2 minutes (max score)',   hudKind: 'ultra',    estimatedDurationMin: 2,    isOnline: false, isExperimental: false }),
  zen:      Object.freeze({ goalLabel: 'No topout',               hudKind: 'zen',      estimatedDurationMin: null, isOnline: false, isExperimental: false }),
  versus:   Object.freeze({ goalLabel: 'Versus (1v1)',            hudKind: 'versus',   estimatedDurationMin: 5,    isOnline: false, isExperimental: false }),
});

let _current = 'classic';
const _listeners = new Set();
// Mode lifecycle — the host wires `_startHandler`/`_stopHandler` once at
// boot via `Mode._wireLifecycle({ onStart, onStop })`. Mode.start/stop
// then delegate the actual reset/terminal to the host. We keep these as
// internal slots (rather than constructor params) because Mode is a
// frozen singleton and the wiring needs to happen after main.js has
// constructed both the game state and the storage hooks.
let _startHandler = null;
let _stopHandler  = null;

export const Mode = Object.freeze({
  available:   AVAILABLE,
  labels:      LABELS,
  descriptions: DESCRIPTIONS,
  disabled:    DISABLED,

  get current() { return _current; },

  /**
   * Set the active mode. No-ops if `name` isn't in AVAILABLE. Fires
   * subscribers so the settings panel + any future per-mode systems
   * pick up the change.
   *
   * @returns {boolean} true if the mode actually changed
   */
  select(name) {
    if (!AVAILABLE.includes(name)) return false;
    if (name === _current) return false;
    _current = name;
    for (const fn of _listeners) {
      try { fn(_current); }
      catch (err) { console.error('[mode] listener threw:', err); }
    }
    return true;
  },

  /**
   * Subscribe to mode changes. Returns an unsubscribe function.
   * Useful for the settings panel's "currently playing" badge sync.
   */
  onChange(fn) {
    if (typeof fn !== 'function') throw new Error('Mode.onChange requires a function');
    _listeners.add(fn);
    return () => _listeners.delete(fn);
  },

  /**
   * Static metadata for a mode key (plan_gameplay_1.md §4.3).
   * Used by the settings panel to render goal/duration text without
   * hardcoding strings in the UI module.
   *
   * @param {string} key
   * @returns {{ goalLabel:string, hudKind:string, estimatedDurationMin:number|null, isOnline:boolean, isExperimental:boolean }}
   */
  config(key) {
    return CONFIG[key] || CONFIG.classic;
  },

  /**
   * Wire the lifecycle handlers. Called once from main.js after the game
   * state and storage hooks are in place. Replaces previous handlers if
   * called twice (HMR safety).
   *
   * @param {Object} hooks
   * @param {(opts: { key:string, seed?:number, restart?:boolean }) => void} hooks.onStart
   * @param {(reason: 'topout'|'goal'|'time'|'forfeit') => void} hooks.onStop
   */
  _wireLifecycle({ onStart, onStop } = {}) {
    _startHandler = (typeof onStart === 'function') ? onStart : null;
    _stopHandler  = (typeof onStop  === 'function') ? onStop  : null;
  },

  /**
   * Begin a fresh run with the given mode's rules. The host's `onStart`
   * hook is responsible for: (a) building the rules pack, (b) resetting
   * gameplay state, (c) emitting MODE_START on the bus.
   *
   * @param {Object} [opts]
   * @param {string}  [opts.key]      defaults to Mode.current
   * @param {number}  [opts.seed]     RNG seed (future — not consumed today)
   * @param {boolean} [opts.restart]  default true; if false, only swaps the
   *                                   active rules pack without resetting
   *                                   the board (used by future "switch mode
   *                                   mid-run" UX, not currently exposed).
   */
  start(opts = {}) {
    const key = opts.key || _current;
    if (!AVAILABLE.includes(key)) return false;
    if (key !== _current) {
      // Honor an explicit `key` arg by selecting it first so listeners +
      // settings-panel chrome stay in sync.
      this.select(key);
    }
    if (!_startHandler) {
      // No host wired yet (test environment, or pre-boot). Surface as a
      // no-op rather than throwing so module-level smoke tests don't need
      // a stub.
      return false;
    }
    _startHandler({ key, seed: opts.seed, restart: opts.restart !== false });
    return true;
  },

  /**
   * Force-end the active run. Used by Zen's "Stop session" and future
   * Versus "Forfeit". For modes whose endCondition has already returned a
   * result, the engine has already ended — this is a no-op.
   *
   * @param {'topout'|'goal'|'time'|'forfeit'} [reason='forfeit']
   */
  stop(reason = 'forfeit') {
    if (!_stopHandler) return false;
    _stopHandler(reason);
    return true;
  },

  /** For tests — reset to default + clear listeners + drop lifecycle hooks. */
  _resetForTests() {
    _current = 'classic';
    _listeners.clear();
    _startHandler = null;
    _stopHandler  = null;
  },
});
