// Modern-rules in-run chips — persistent live readouts of the current
// Back-to-Back chain length and combo step (plan_gameplay_2.md §1.4).
//
// Complements `ui/modern-callouts.js`: callouts announce each event
// (T-SPIN!, BACK-TO-BACK ×3) for ~1.4s and fade; chips are persistent
// — once a chain is active, the chip shows "B2B ×3" and stays until the
// chain breaks. Same for combo.
//
// Why a single global module instead of per-badge widgets: every mode
// uses modern rules (Marathon / Sprint / Ultra / Zen / Versus all
// support T-spin / B2B / combo via the rules engine), so the chips are
// mode-agnostic. One mount point + one subscriber pair is easier to
// reason about than five copies. The chips position themselves to the
// left of the per-mode badges so they don't fight for screen space.
//
// Pure DOM. No THREE / audio dependencies.

import { installPanelStyles } from './panel-shared.js';

let _stylesInstalled = false;

function installChipStyles() {
  if (_stylesInstalled) return;
  _stylesInstalled = true;
  const css = `
    .tp-modern-chips {
      position: fixed;
      top: 16px;
      left: 16px;
      z-index: 55;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 4px;
      pointer-events: none;
      user-select: none;
    }
    .tp-modern-chip {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-radius: 6px;
      background: rgba(10, 14, 24, 0.60);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: var(--ink, #f3f5fb);
      backdrop-filter: blur(8px) saturate(140%);
      -webkit-backdrop-filter: blur(8px) saturate(140%);
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.10em;
      font-size: 11px;
      opacity: 0;
      transform: translateX(-12px) scale(0.94);
      transition: opacity 220ms ease-out, transform 220ms ease-out;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
    }
    .tp-modern-chip.is-visible {
      opacity: 1;
      transform: translateX(0) scale(1);
    }
    .tp-modern-chip__label {
      font-size: 8.5px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--muted, #8b93ad);
      opacity: 0.85;
    }
    .tp-modern-chip__count {
      font-size: 14px;
      font-weight: 700;
    }
    /* B2B = cyan accent (matches the chain color used elsewhere). */
    .tp-modern-chip--b2b {
      border-color: rgba(108, 240, 255, 0.40);
      box-shadow: 0 0 14px rgba(108, 240, 255, 0.18),
                  0 4px 12px rgba(0, 0, 0, 0.45);
    }
    .tp-modern-chip--b2b .tp-modern-chip__count {
      color: #6cf0ff;
      text-shadow: 0 0 10px rgba(108, 240, 255, 0.35);
    }
    /* Combo = warm orange — different visual axis from B2B so the
       player can tell them apart without reading. */
    .tp-modern-chip--combo {
      border-color: rgba(255, 138, 28, 0.40);
      box-shadow: 0 0 14px rgba(255, 138, 28, 0.18),
                  0 4px 12px rgba(0, 0, 0, 0.45);
    }
    .tp-modern-chip--combo .tp-modern-chip__count {
      color: #ff8a1c;
      text-shadow: 0 0 10px rgba(255, 138, 28, 0.35);
    }
    /* One-shot pulse animation when the count increments — the count
       text scales briefly so the player feels the increase. */
    .tp-modern-chip.is-bumping .tp-modern-chip__count {
      animation: tp-modern-chip-bump 280ms ease-out;
    }
    @keyframes tp-modern-chip-bump {
      0%   { transform: scale(1.0); }
      40%  { transform: scale(1.32); }
      100% { transform: scale(1.0); }
    }
  `;
  const style = document.createElement('style');
  style.id = 'tp-modern-chips-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * @typedef {Object} ModernChipsOpts
 * @property {{ on:(t:string,fn:Function,o?:any)=>Function }} bus
 * @property {{ B2B_CHAIN:string, B2B_BREAK:string,
 *              COMBO_START:string, COMBO_END:string,
 *              MODE_START:string, MODE_END:string }} events
 * @property {HTMLElement} [container]    Default `document.body`.
 * @property {() => string} [getActiveModeKey]
 *   Optional gate. When supplied, chips only render while the active
 *   mode is one of `modes`. When omitted, chips show in any mode the
 *   §12 events fire in (which is currently all six modes).
 * @property {string[]} [modes]
 *   Default ['classic','marathon','sprint','ultra','zen','versus'] —
 *   every mode that uses the rules engine. Sprint shows the combo
 *   chip but B2B is rare there (T-spins score 0 by Sprint's lineScore
 *   override, but still emit T_SPIN events; B2B chains can still
 *   form via Tetris on Tetris).
 */

/**
 * @param {ModernChipsOpts} opts
 * @returns {{ root: HTMLElement, dispose: () => void }}
 */
export function createModernChips(opts) {
  const {
    bus, events,
    container = (typeof document !== 'undefined' ? document.body : null),
    getActiveModeKey = null,
    modes = ['classic', 'marathon', 'sprint', 'ultra', 'zen', 'versus'],
  } = opts || {};
  if (!bus || !events) {
    throw new Error('createModernChips requires { bus, events }');
  }
  if (!container || typeof document === 'undefined') {
    throw new Error('createModernChips requires a DOM environment');
  }

  installPanelStyles();
  installChipStyles();

  const root = document.createElement('div');
  root.className = 'tp-modern-chips';

  function makeChip(kindClass, labelText) {
    const chip = document.createElement('div');
    chip.className = `tp-modern-chip ${kindClass}`;
    const lbl = document.createElement('span');
    lbl.className = 'tp-modern-chip__label';
    lbl.textContent = labelText;
    const count = document.createElement('span');
    count.className = 'tp-modern-chip__count';
    count.textContent = '×0';
    chip.appendChild(lbl);
    chip.appendChild(count);
    return { chip, count };
  }

  const b2b   = makeChip('tp-modern-chip--b2b',   'B2B');
  const combo = makeChip('tp-modern-chip--combo', 'Combo');
  root.appendChild(b2b.chip);
  root.appendChild(combo.chip);
  container.appendChild(root);

  const modeSet = new Set(modes);
  function isModeAllowed() {
    if (typeof getActiveModeKey !== 'function') return true;
    return modeSet.has(getActiveModeKey());
  }

  // Bump animation helper. Re-entry-safe via class swap + reflow.
  function bump(el) {
    el.classList.remove('is-bumping');
    void el.offsetWidth; // restart animation
    el.classList.add('is-bumping');
    setTimeout(() => el.classList.remove('is-bumping'), 320);
  }

  function showChip(side, count) {
    if (!isModeAllowed() || count < 1) {
      hideChip(side);
      return;
    }
    side.count.textContent = `×${count}`;
    side.chip.classList.add('is-visible');
    bump(side.chip);
  }
  function hideChip(side) {
    side.chip.classList.remove('is-visible');
  }

  const offs = [];

  // B2B chain — visible at count >= 1 (the very first difficult clear
  // is shown so the player knows "I'm in B2B territory now"). The
  // existing callout module suppresses count=1 to avoid spam, but the
  // persistent chip benefits from the early signal.
  offs.push(bus.on(events.B2B_CHAIN, (e) => {
    if (!e || typeof e.count !== 'number') return;
    showChip(b2b, e.count | 0);
  }));
  offs.push(bus.on(events.B2B_BREAK, () => hideChip(b2b)));

  // Combo — visible only at count >= 2 (combo=1 is "first clear of
  // streak", not a real streak yet). Game's `_combo` is incremented
  // exactly once per call to clearLines, and clearLines is the ONLY
  // path that emits LINE_CLEAR. So LINE_CLEAR is a 1:1 proxy for the
  // combo increment — we count locally without needing to read
  // game.combo via a thunk.
  //
  // Lifecycle:
  //   - LINE_CLEAR  → _localCombo += 1; show chip when ≥ 2
  //   - COMBO_END   → _localCombo = 0; hide chip
  //   - MODE_START  → reset (handled below in the shared MODE_START handler)
  let _localCombo = 0;
  if (events.LINE_CLEAR) {
    offs.push(bus.on(events.LINE_CLEAR, () => {
      _localCombo += 1;
      if (_localCombo >= 2) showChip(combo, _localCombo);
    }));
  }
  offs.push(bus.on(events.COMBO_END, () => {
    _localCombo = 0;
    hideChip(combo);
  }));

  // MODE_START / MODE_END — reset visibility so a new run starts
  // with no stale chips visible from the prior run.
  offs.push(bus.on(events.MODE_START, () => {
    _localCombo = 0;
    hideChip(b2b);
    hideChip(combo);
  }));
  offs.push(bus.on(events.MODE_END, () => {
    hideChip(b2b);
    hideChip(combo);
  }));

  function dispose() {
    for (const off of offs) {
      try { off(); } catch { /* ignore */ }
    }
    offs.length = 0;
    if (root.parentNode === container) container.removeChild(root);
  }

  return { root, dispose };
}
