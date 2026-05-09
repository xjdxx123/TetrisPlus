// Ultra HUD badge — countdown timer (large) + score (secondary).
//
// Visible only when the active mode is Ultra. The countdown is the
// headline; at ≤10s the chrome shifts to a red "warning" palette and
// pulses on each second. On `MODE_END` the score becomes the headline
// (same number, swapped emphasis).
//
// Pure DOM. Uses the shared `tp-panel` chrome.

import { installPanelStyles } from './panel-shared.js';

let _stylesInstalled = false;

function installBadgeStyles() {
  if (_stylesInstalled) return;
  _stylesInstalled = true;
  const css = `
    .tp-ultra-badge {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 50;
      min-width: 240px;
      padding: 10px 18px 10px;
      display: none;
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
      transition: box-shadow 0.4s ease-out, border-color 0.4s ease-out;
      pointer-events: none;
    }
    .tp-ultra-badge.is-visible { display: flex; }
    .tp-ultra-badge__label {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      font-size: 9px;
      color: var(--muted, #8b93ad);
      opacity: 0.7;
    }
    .tp-ultra-badge__time {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      font-size: 28px;
      letter-spacing: 0.04em;
      color: var(--accent, #6cf0ff);
      text-shadow: 0 0 14px rgba(108, 240, 255, 0.30);
      line-height: 1.05;
      transition: color 0.25s, transform 0.18s ease-out;
    }
    .tp-ultra-badge__score {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 11px;
      letter-spacing: 0.06em;
      color: var(--muted, #8b93ad);
      font-variant-numeric: tabular-nums;
    }
    .tp-ultra-badge__score strong {
      color: var(--ink, #f3f5fb);
      font-weight: 600;
    }
    /* ≤10s: shift the timer to red and bias the chrome to match. */
    .tp-ultra-badge.is-warning {
      border-color: rgba(255, 92, 138, 0.50);
    }
    .tp-ultra-badge.is-warning .tp-ultra-badge__time {
      color: #ff5c8a;
      text-shadow: 0 0 16px rgba(255, 92, 138, 0.45);
    }
    /* Per-second pulse during the warning window. Brief scale + halo. */
    .tp-ultra-badge.is-pulsing .tp-ultra-badge__time {
      transform: scale(1.10);
    }
    .tp-ultra-badge.is-pulsing {
      box-shadow: 0 0 0 6px rgba(255, 92, 138, 0.45),
                  0 10px 40px rgba(0, 0, 0, 0.45),
                  inset 0 0 60px rgba(255, 92, 138, 0.20);
    }
    /* MODE_END finale: emphasis swaps from time → score. */
    .tp-ultra-badge.is-completed .tp-ultra-badge__time {
      font-size: 14px;
      opacity: 0.7;
    }
    .tp-ultra-badge.is-completed .tp-ultra-badge__score {
      font-size: 22px;
      color: #ffd400;
      text-shadow: 0 0 16px rgba(255, 212, 0, 0.40);
      order: -1;
    }
  `;
  const style = document.createElement('style');
  style.id = 'tp-ultra-badge-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

const WARNING_THRESHOLD_MS = 10_000;
const PULSE_DURATION_MS    = 220;

/**
 * Format milliseconds as `m:ss` (mm:ss if minutes > 9). Ultra's main
 * countdown shows whole seconds — the warning window's pulse covers the
 * "feel" of the sub-second decay, and full-second precision keeps the
 * digit count from jittering pixel-by-pixel.
 */
export function formatUltraTime(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * @typedef {Object} UltraBadgeOpts
 * @property {{on:(t:string,fn:Function,o?:any)=>Function}} bus
 * @property {{ MODE_START:string, MODE_END:string, SCORE_DELTA:string }} events
 * @property {() => string} getActiveModeKey
 * @property {() => number} getModeTimeMs        Host's `_modeTimeMs` accumulator.
 * @property {() => number} [getScore]           Default: () => 0.
 * @property {number}       [duration]           Total run time (ms). Default 120000.
 */

/**
 * @param {UltraBadgeOpts} opts
 */
export function createUltraBadge(opts) {
  const {
    bus, events,
    getActiveModeKey,
    getModeTimeMs,
    getScore  = () => 0,
    duration  = 120_000,
  } = opts || {};
  if (!bus || !events || typeof getActiveModeKey !== 'function' || typeof getModeTimeMs !== 'function') {
    throw new Error('createUltraBadge requires { bus, events, getActiveModeKey, getModeTimeMs }');
  }

  installPanelStyles();
  installBadgeStyles();

  const root = document.createElement('div');
  root.id = 'ultra-badge';
  root.className = 'tp-ultra-badge';

  const labelEl = document.createElement('span');
  labelEl.className = 'tp-ultra-badge__label';
  labelEl.textContent = 'Ultra · 2 minutes';
  root.appendChild(labelEl);

  const timeEl = document.createElement('span');
  timeEl.className = 'tp-ultra-badge__time';
  root.appendChild(timeEl);

  const scoreEl = document.createElement('span');
  scoreEl.className = 'tp-ultra-badge__score';
  root.appendChild(scoreEl);

  document.body.appendChild(root);

  let _completed     = false;
  let _frozenTimeMs  = null;       // when set, render this instead of getModeTimeMs()
  let _lastSecondShown = -1;       // last whole-second value rendered
  let _lastScoreShown  = -1;
  let _wasInWarning  = false;
  let _pulseTimer    = null;

  function isVisible() { return getActiveModeKey() === 'ultra'; }

  function pulse() {
    root.classList.add('is-pulsing');
    if (_pulseTimer != null) clearTimeout(_pulseTimer);
    _pulseTimer = setTimeout(() => {
      root.classList.remove('is-pulsing');
      _pulseTimer = null;
    }, PULSE_DURATION_MS);
  }

  function renderScore(score) {
    if (score === _lastScoreShown) return;
    _lastScoreShown = score;
    scoreEl.innerHTML = `<strong>${(score | 0).toLocaleString()}</strong> pts`;
  }

  function refresh() {
    if (!isVisible()) {
      root.classList.remove('is-visible');
      return;
    }
    root.classList.add('is-visible');
    root.classList.toggle('is-completed', _completed);
    // Force a full re-render path — invalidates the per-second cache.
    _lastSecondShown = -1;
    _lastScoreShown  = -1;
    tick();
    renderScore(getScore() | 0);
  }

  /**
   * Per-render tick. Cheap when invisible; otherwise updates the timer
   * digits when whole seconds tick over and pulses on each second
   * boundary inside the warning window.
   */
  function tick() {
    if (!isVisible()) {
      if (root.classList.contains('is-visible')) root.classList.remove('is-visible');
      return;
    }
    if (!root.classList.contains('is-visible')) root.classList.add('is-visible');

    const elapsed = (_frozenTimeMs != null) ? _frozenTimeMs : getModeTimeMs();
    const remaining = Math.max(0, duration - elapsed);

    // Update digits only when the displayed second changes.
    const secondsRemaining = Math.ceil(remaining / 1000);
    if (secondsRemaining !== _lastSecondShown) {
      timeEl.textContent = formatUltraTime(remaining);
      _lastSecondShown = secondsRemaining;

      // Warning band — colour shift and pulse on every second tick inside
      // the last 10s. The pulse fires once per second crossing rather
      // than every frame, so it reads as a clear ticking metronome.
      const inWarning = remaining > 0 && remaining <= WARNING_THRESHOLD_MS && !_completed;
      if (inWarning) {
        if (!_wasInWarning) root.classList.add('is-warning');
        pulse();
      } else if (_wasInWarning) {
        root.classList.remove('is-warning');
      }
      _wasInWarning = inWarning;
    }

    // Score updates aren't second-gated — they update as the bus fires
    // SCORE_DELTA. We still poll here as a fallback in case a SCORE_DELTA
    // listener hasn't been wired (cheap thunk + cached compare).
    renderScore(getScore() | 0);
  }

  // Subscriptions.
  const offs = [];

  offs.push(bus.on(events.MODE_START, () => {
    _completed     = false;
    _frozenTimeMs  = null;
    _wasInWarning  = false;
    root.classList.remove('is-completed', 'is-warning', 'is-pulsing');
    refresh();
  }));

  // Listen to SCORE_DELTA so the score updates in lockstep with the
  // simulation (via the bus, not via a poll). Falls through to the
  // tick()'s renderScore poll if the host doesn't emit.
  offs.push(bus.on(events.SCORE_DELTA, (e) => {
    if (!isVisible() || _completed) return;
    if (!e || typeof e.total !== 'number') return;
    renderScore(e.total | 0);
  }));

  offs.push(bus.on(events.MODE_END, (e) => {
    if (!isVisible()) return;
    if (e) {
      _frozenTimeMs = (typeof e.timeMs === 'number') ? e.timeMs : getModeTimeMs();
      _completed    = true;
      // The "topped out 0.5s before time" flavour the plan mentions —
      // keep the label honest. Goal/time end uses "time".
      if (e.reason === 'time')       labelEl.textContent = 'Ultra · time!';
      else if (e.reason === 'topout') labelEl.textContent = 'Ultra · topped out';
      else                            labelEl.textContent = 'Ultra · ' + (e.reason || 'ended');
    }
    refresh();
  }));

  refresh();

  return {
    root,
    tick,
    refresh,
    dispose() {
      for (const off of offs) try { off(); } catch { /* ignore */ }
      if (_pulseTimer != null) clearTimeout(_pulseTimer);
      root.remove();
    },
  };
}
