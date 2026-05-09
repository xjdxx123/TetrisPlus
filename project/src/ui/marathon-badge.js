// Marathon HUD badge — `Lines remaining: 87 / 150` + `Multiplier: 1.5×`.
//
// Visible only when the active mode is Marathon. Subscribes to the gameplay
// bus topics that move it: MODE_START seeds the lines target, LINE_CLEAR
// updates the remaining count, MODE_END swaps to a "Cleared!" finale,
// MODE_GOAL_PROGRESS pulses the chrome (cyan flash, ~400ms).
//
// Pure DOM. Zero dependencies on the renderer. Uses the shared `tp-panel`
// chrome from `panel-shared.js` so it reads as one family with the
// playlist + effects panels.

import { installPanelStyles } from './panel-shared.js';

let _stylesInstalled = false;

function installBadgeStyles() {
  if (_stylesInstalled) return;
  _stylesInstalled = true;
  const css = `
    .tp-marathon-badge {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 50;
      min-width: 240px;
      padding: 10px 16px 8px;
      display: none; /* hidden until MODE_START fires for Marathon */
      flex-direction: column;
      align-items: center;
      gap: 4px;
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
      pointer-events: none;
    }
    .tp-marathon-badge.is-visible { display: flex; }
    .tp-marathon-badge__label {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      font-size: 9px;
      color: var(--muted, #8b93ad);
      opacity: 0.7;
    }
    .tp-marathon-badge__count {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      font-size: 22px;
      color: var(--ink, #f3f5fb);
      letter-spacing: 0.04em;
    }
    .tp-marathon-badge__count strong {
      color: var(--accent, #6cf0ff);
      text-shadow: 0 0 14px rgba(108, 240, 255, 0.32);
    }
    .tp-marathon-badge__mult {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 10px;
      color: var(--muted, #8b93ad);
      opacity: 0.6;
      letter-spacing: 0.06em;
    }
    /* Pulse fired on every milestone crossing (every 10 lines). */
    .tp-marathon-badge.is-pulsing {
      box-shadow: 0 0 0 6px rgba(108, 240, 255, 0.45),
                  0 10px 40px rgba(0, 0, 0, 0.45),
                  inset 0 0 60px rgba(108, 240, 255, 0.20);
    }
    /* Goal-completion finale — multiplier becomes the headline. */
    .tp-marathon-badge.is-completed .tp-marathon-badge__count strong {
      color: #ffd400;
      text-shadow: 0 0 14px rgba(255, 212, 0, 0.40);
    }
    .tp-marathon-badge.is-completed .tp-marathon-badge__mult {
      color: #ffd400;
      opacity: 1.0;
    }
  `;
  const style = document.createElement('style');
  style.id = 'tp-marathon-badge-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * @typedef {Object} MarathonBadgeOpts
 * @property {{ on:(topic:string,fn:Function,opts?:any)=>Function }} bus
 * @property {{ MODE_START:string, MODE_END:string, MODE_GOAL_PROGRESS:string, LINE_CLEAR:string }} events
 * @property {() => string} getActiveModeKey  Returns the host's notion of the
 *   active mode key (typically `Mode.current`). The badge subscribes
 *   permanently to the bus and gates display on this thunk so a future
 *   "switch mode mid-run" flow doesn't require teardown.
 * @property {() => number} [getLinesCleared]  Optional — used at MODE_START
 *   to render the initial state from a non-zero counter (e.g., HMR mid-run
 *   restart). Defaults to () => 0.
 */

/**
 * @param {MarathonBadgeOpts} opts
 * @returns {{ root: HTMLElement, refresh:()=>void, dispose:()=>void }}
 */
export function createMarathonBadge(opts) {
  const {
    bus,
    events,
    getActiveModeKey,
    getLinesCleared = () => 0,
  } = opts || {};
  if (!bus || !events || typeof getActiveModeKey !== 'function') {
    throw new Error('createMarathonBadge requires { bus, events, getActiveModeKey }');
  }

  installPanelStyles();
  installBadgeStyles();

  const root = document.createElement('div');
  root.id = 'marathon-badge';
  root.className = 'tp-marathon-badge';

  const labelEl = document.createElement('span');
  labelEl.className = 'tp-marathon-badge__label';
  labelEl.textContent = 'Marathon · 150 lines';
  root.appendChild(labelEl);

  const countEl = document.createElement('span');
  countEl.className = 'tp-marathon-badge__count';
  root.appendChild(countEl);

  const multEl = document.createElement('span');
  multEl.className = 'tp-marathon-badge__mult';
  multEl.textContent = '× 1.5 on completion';
  root.appendChild(multEl);

  document.body.appendChild(root);

  // Currently-rendered values — guarded so only changes trigger DOM writes.
  let _target  = 150;
  let _mult    = 1.5;
  let _linesCleared = 0;
  let _completed = false;
  let _pulseTimer = null;

  function isVisible() {
    return getActiveModeKey() === 'marathon';
  }

  function render() {
    if (!isVisible()) {
      root.classList.remove('is-visible');
      return;
    }
    root.classList.add('is-visible');
    const remaining = Math.max(0, _target - _linesCleared);
    countEl.innerHTML = `<strong>${remaining}</strong> / ${_target}`;
    multEl.textContent = _completed
      ? `+${Math.round((_mult - 1) * 100)}% Marathon Bonus`
      : `× ${_mult.toFixed(1)} on completion`;
    root.classList.toggle('is-completed', _completed);
  }

  function pulse() {
    root.classList.add('is-pulsing');
    if (_pulseTimer != null) clearTimeout(_pulseTimer);
    _pulseTimer = setTimeout(() => {
      root.classList.remove('is-pulsing');
      _pulseTimer = null;
    }, 420);
  }

  // ---------------------------------------------------------------------
  // Subscriptions. Each handler is registered once at construction; the
  // returned unsubscribers run on dispose().
  // ---------------------------------------------------------------------
  const offs = [];

  offs.push(bus.on(events.MODE_START, (e) => {
    _completed = false;
    if (e && e.initialModeView && e.initialModeView.kind === 'marathon') {
      _target = e.initialModeView.target || e.initialModeView.linesRemaining || 150;
      _mult   = e.initialModeView.multiplier || 1.5;
    }
    _linesCleared = getLinesCleared() || 0;
    render();
  }));

  // Track raw line clears so the count moves on every clear without a
  // mode-specific helper. `simultaneous` would also work; using the rows
  // array's length keeps us aligned with the simulation.
  offs.push(bus.on(events.LINE_CLEAR, (e) => {
    if (!isVisible()) return;
    _linesCleared += (e && Array.isArray(e.rows) ? e.rows.length : (e?.simultaneous || 0));
    render();
  }));

  // Pulse the chrome on each milestone — Marathon emits these at every
  // 10-line crossing. We deliberately re-render *after* the pulse so the
  // numeric update isn't visually masked by the box-shadow flash.
  offs.push(bus.on(events.MODE_GOAL_PROGRESS, (e) => {
    if (!isVisible()) return;
    if (!e || e.kind !== 'lines') return;
    pulse();
  }));

  offs.push(bus.on(events.MODE_END, (e) => {
    if (!isVisible()) return;
    if (e && e.reason === 'goal') {
      _completed = true;
      _linesCleared = _target; // pin the headline at "0 / 150"
      pulse();
    }
    render();
  }));

  // First-frame render — covers the boot path where MODE_START fires
  // before main.js has assigned `marathonBadge`. When the host calls
  // refresh() right after construction, the badge picks up the cached
  // initial state without waiting for a re-emit.
  render();

  return {
    root,
    refresh: render,
    dispose() {
      for (const off of offs) {
        try { off(); } catch { /* ignore */ }
      }
      if (_pulseTimer != null) clearTimeout(_pulseTimer);
      root.remove();
    },
  };
}
