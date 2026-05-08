// Game-mode namespace (plan_UI_1.md §3.7).
//
// Today every mode resolves to classic rules; the mode buttons exist as
// UI surface + persistence so the player's choice survives a reload.
// When real per-mode logic lands (Sprint timer, Ultra countdown, Zen
// no-top-out, Versus AI), `triggerGameOver` consults `Mode.current` for
// the end condition and `clearLines` consults it for scoring multipliers
// — the panel UI doesn't change.
//
// Pure module. No THREE, no DOM. Settings persistence is delegated to
// the caller (effects panel) — Mode.select just exposes a setter and
// fires the listeners.

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
const DISABLED = Object.freeze({ versus: true });

let _current = 'classic';
const _listeners = new Set();

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

  /** For tests — reset to default + clear listeners. */
  _resetForTests() {
    _current = 'classic';
    _listeners.clear();
  },
});
