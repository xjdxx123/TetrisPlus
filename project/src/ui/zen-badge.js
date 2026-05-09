// Zen HUD badge — `Lines: 87 · Pieces: 234 · Shifts: 2` + "Stop session"
// button (plan_gameplay_1.md §3.5 #4).
//
// Visible only when the active mode is Zen. Subscribes to:
//   LINE_CLEAR    → bumps lines counter
//   PIECE_SPAWN   → bumps pieces counter
//   ZEN_RESCUE    → bumps shifts counter + brief restorative pulse
//   MODE_START    → resets all three counters
//   MODE_END      → freezes the chrome ("Forfeited" finale)
//
// Stop button calls the host's `onStop` thunk (which routes through
// Mode.stop('forfeit') in main.js). The button is the *only* exit from
// Zen — there's no natural endCondition.
//
// Pure DOM. Uses the shared `tp-panel` chrome.

import { installPanelStyles } from './panel-shared.js';

let _stylesInstalled = false;

function installBadgeStyles() {
  if (_stylesInstalled) return;
  _stylesInstalled = true;
  const css = `
    .tp-zen-badge {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 50;
      min-width: 280px;
      padding: 10px 16px 8px;
      display: none;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      background: rgba(10, 14, 24, 0.58);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45),
                  inset 0 0 60px rgba(108, 240, 255, 0.025);
      color: var(--ink, #f3f5fb);
      font-family: ui-sans-serif, system-ui, -apple-system,
                   "SF Pro Display", "Helvetica Neue", Arial, sans-serif;
      font-size: 12px;
      line-height: 1.4;
      user-select: none;
      backdrop-filter: blur(10px) saturate(140%);
      -webkit-backdrop-filter: blur(10px) saturate(140%);
      transition: box-shadow 0.4s ease-out;
    }
    .tp-zen-badge.is-visible { display: flex; }
    .tp-zen-badge__label {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      font-size: 9px;
      color: var(--muted, #8b93ad);
      opacity: 0.7;
    }
    .tp-zen-badge__counts {
      display: flex;
      gap: 18px;
      align-items: baseline;
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      font-size: 13px;
      color: var(--ink, #f3f5fb);
    }
    .tp-zen-badge__count strong {
      color: var(--accent, #6cf0ff);
      text-shadow: 0 0 10px rgba(108, 240, 255, 0.30);
      font-size: 16px;
      letter-spacing: 0.04em;
    }
    .tp-zen-badge__count em {
      font-style: normal;
      font-size: 9px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted, #8b93ad);
      margin-left: 4px;
    }
    .tp-zen-badge__stop {
      pointer-events: auto;
      margin-top: 4px;
      padding: 5px 14px;
      background: transparent;
      border: 1px solid rgba(255, 138, 160, 0.45);
      border-radius: 5px;
      color: #ff8aa0;
      font-family: inherit;
      font-size: 10px;
      letter-spacing: 0.10em;
      text-transform: uppercase;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s, background 0.15s;
    }
    .tp-zen-badge__stop:hover {
      color: #fff;
      border-color: rgba(255, 138, 160, 0.85);
      background: rgba(255, 138, 160, 0.18);
    }
    /* Brief restorative cyan flash when a shift completes. */
    .tp-zen-badge.is-pulsing {
      box-shadow: 0 0 0 6px rgba(108, 240, 255, 0.45),
                  0 10px 40px rgba(0, 0, 0, 0.45),
                  inset 0 0 60px rgba(108, 240, 255, 0.20);
    }
    /* MODE_END — show the final session as a calm summary, hide stop. */
    .tp-zen-badge.is-completed .tp-zen-badge__stop { display: none; }
    .tp-zen-badge.is-completed .tp-zen-badge__count strong {
      color: #a8b3d4;
      text-shadow: none;
    }
  `;
  const style = document.createElement('style');
  style.id = 'tp-zen-badge-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * @typedef {Object} ZenBadgeOpts
 * @property {{on:(t:string,fn:Function,o?:any)=>Function}} bus
 * @property {{ MODE_START:string, MODE_END:string, LINE_CLEAR:string, PIECE_SPAWN:string, ZEN_RESCUE:string }} events
 * @property {() => string} getActiveModeKey
 * @property {() => void}   onStop      Called when the player clicks Stop session.
 *                                       Typical impl: `() => Mode.stop('forfeit')`.
 * @property {() => number} [getLinesCleared]   Default () => 0 — used to seed at MODE_START.
 * @property {() => number} [getPiecesPlaced]   Default () => 0.
 */

/**
 * @param {ZenBadgeOpts} opts
 */
export function createZenBadge(opts) {
  const {
    bus, events,
    getActiveModeKey,
    onStop,
    getLinesCleared = () => 0,
    getPiecesPlaced = () => 0,
  } = opts || {};
  if (!bus || !events || typeof getActiveModeKey !== 'function' || typeof onStop !== 'function') {
    throw new Error('createZenBadge requires { bus, events, getActiveModeKey, onStop }');
  }

  installPanelStyles();
  installBadgeStyles();

  const root = document.createElement('div');
  root.id = 'zen-badge';
  root.className = 'tp-zen-badge';

  const labelEl = document.createElement('span');
  labelEl.className = 'tp-zen-badge__label';
  labelEl.textContent = 'Zen · no topout';
  root.appendChild(labelEl);

  const countsEl = document.createElement('div');
  countsEl.className = 'tp-zen-badge__counts';
  root.appendChild(countsEl);

  function makeCount(labelText) {
    const wrap = document.createElement('span');
    wrap.className = 'tp-zen-badge__count';
    const num = document.createElement('strong');
    num.textContent = '0';
    const lbl = document.createElement('em');
    lbl.textContent = labelText;
    wrap.appendChild(num);
    wrap.appendChild(lbl);
    return { wrap, num };
  }
  const linesCount  = makeCount('lines');
  const piecesCount = makeCount('pieces');
  const shiftsCount = makeCount('shifts');
  countsEl.appendChild(linesCount.wrap);
  countsEl.appendChild(piecesCount.wrap);
  countsEl.appendChild(shiftsCount.wrap);

  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'tp-zen-badge__stop';
  stopBtn.textContent = 'Stop session';
  stopBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.currentTarget.blur();
    try { onStop(); }
    catch (err) { console.error('[zen-badge] onStop threw:', err); }
  });
  root.appendChild(stopBtn);

  document.body.appendChild(root);

  let _lines     = 0;
  let _pieces    = 0;
  let _shifts    = 0;
  let _completed = false;
  let _pulseTimer = null;

  function isVisible() { return getActiveModeKey() === 'zen'; }

  function setNum(slot, value) {
    const str = (value | 0).toLocaleString();
    if (slot.num.textContent !== str) slot.num.textContent = str;
  }
  function refresh() {
    if (!isVisible()) {
      root.classList.remove('is-visible');
      return;
    }
    root.classList.add('is-visible');
    root.classList.toggle('is-completed', _completed);
    setNum(linesCount,  _lines);
    setNum(piecesCount, _pieces);
    setNum(shiftsCount, _shifts);
  }

  function pulse() {
    root.classList.add('is-pulsing');
    if (_pulseTimer != null) clearTimeout(_pulseTimer);
    _pulseTimer = setTimeout(() => {
      root.classList.remove('is-pulsing');
      _pulseTimer = null;
    }, 450);
  }

  // Subscriptions.
  const offs = [];

  offs.push(bus.on(events.MODE_START, () => {
    _completed = false;
    _lines  = getLinesCleared() || 0;
    _pieces = getPiecesPlaced() || 0;
    _shifts = 0;
    labelEl.textContent = 'Zen · no topout';
    refresh();
  }));

  offs.push(bus.on(events.LINE_CLEAR, (e) => {
    if (!isVisible()) return;
    _lines += (e && Array.isArray(e.rows) ? e.rows.length : (e?.simultaneous || 0));
    setNum(linesCount, _lines);
  }));

  offs.push(bus.on(events.PIECE_SPAWN, () => {
    if (!isVisible()) return;
    _pieces++;
    setNum(piecesCount, _pieces);
  }));

  offs.push(bus.on(events.ZEN_RESCUE, (e) => {
    if (!isVisible()) return;
    _shifts++;
    setNum(shiftsCount, _shifts);
    pulse();
    // Cosmetic — the count is the receipt; the pulse is the feedback.
    void e; // payload reserved for future use
  }));

  offs.push(bus.on(events.MODE_END, (e) => {
    if (!isVisible()) return;
    _completed = true;
    if (e && e.reason) {
      labelEl.textContent = `Zen · ${e.reason === 'forfeit' ? 'session ended' : e.reason}`;
    }
    refresh();
  }));

  refresh();

  return {
    root,
    refresh,
    dispose() {
      for (const off of offs) try { off(); } catch { /* ignore */ }
      if (_pulseTimer != null) clearTimeout(_pulseTimer);
      root.remove();
    },
  };
}
