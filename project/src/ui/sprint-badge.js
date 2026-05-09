// Sprint HUD badge — `0:23.412` timer + `Lines remaining: 31 / 40`.
//
// Visible only when the active mode is Sprint. The timer is the headline:
// monospace, large, mm:ss.ms format. `MODE_END { reason: 'goal' }` swaps
// the layout to `Cleared in 0:53.412` and freezes the clock.
//
// Per the plan §3.3, the timer must run at gameplay tick rate (not render
// rate) — the host pumps `tick()` from the gameplay block, so the timer
// stops cleanly during pause / game-over.
//
// Pure DOM. Uses the shared `tp-panel` chrome from `panel-shared.js`.

import { installPanelStyles } from './panel-shared.js';

let _stylesInstalled = false;

function installBadgeStyles() {
  if (_stylesInstalled) return;
  _stylesInstalled = true;
  const css = `
    .tp-sprint-badge {
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
      transition: box-shadow 0.4s ease-out;
      pointer-events: none;
    }
    .tp-sprint-badge.is-visible { display: flex; }
    .tp-sprint-badge__label {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      font-size: 9px;
      color: var(--muted, #8b93ad);
      opacity: 0.7;
    }
    .tp-sprint-badge__time {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      font-size: 26px;
      letter-spacing: 0.04em;
      color: var(--accent, #6cf0ff);
      text-shadow: 0 0 14px rgba(108, 240, 255, 0.30);
      line-height: 1.1;
    }
    .tp-sprint-badge__lines {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 11px;
      letter-spacing: 0.06em;
      color: var(--muted, #8b93ad);
      font-variant-numeric: tabular-nums;
    }
    .tp-sprint-badge__lines strong {
      color: var(--ink, #f3f5fb);
      font-weight: 600;
    }
    .tp-sprint-badge.is-pulsing {
      box-shadow: 0 0 0 6px rgba(108, 240, 255, 0.45),
                  0 10px 40px rgba(0, 0, 0, 0.45),
                  inset 0 0 60px rgba(108, 240, 255, 0.20);
    }
    .tp-sprint-badge.is-completed .tp-sprint-badge__time {
      color: #ffd400;
      text-shadow: 0 0 16px rgba(255, 212, 0, 0.40);
    }
    .tp-sprint-badge.is-completed .tp-sprint-badge__lines {
      color: #ffd400;
      opacity: 1.0;
    }
  `;
  const style = document.createElement('style');
  style.id = 'tp-sprint-badge-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * Format milliseconds as `m:ss.mmm` (mm:ss.mmm if minutes > 9).
 * Sprint runs are usually under 10 minutes; the format adapts gracefully.
 */
export function formatSprintTime(ms) {
  if (!isFinite(ms) || ms < 0) return '0:00.000';
  const total = Math.floor(ms);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const millis  = total % 1000;
  return `${minutes}:${seconds.toString().padStart(2, '0')}.${millis.toString().padStart(3, '0')}`;
}

/**
 * @typedef {Object} SprintBadgeOpts
 * @property {{on:(t:string,fn:Function,o?:any)=>Function}} bus
 * @property {{ MODE_START:string, MODE_END:string, MODE_GOAL_PROGRESS:string, LINE_CLEAR:string }} events
 * @property {() => string} getActiveModeKey
 * @property {() => number} getModeTimeMs        Returns the host's `_modeTimeMs` accumulator.
 * @property {() => number} [getLinesCleared]    Default: () => 0.
 */

/**
 * @param {SprintBadgeOpts} opts
 * @returns {{ root:HTMLElement, tick:()=>void, refresh:()=>void, dispose:()=>void }}
 */
export function createSprintBadge(opts) {
  const {
    bus, events,
    getActiveModeKey,
    getModeTimeMs,
    getLinesCleared = () => 0,
  } = opts || {};
  if (!bus || !events || typeof getActiveModeKey !== 'function' || typeof getModeTimeMs !== 'function') {
    throw new Error('createSprintBadge requires { bus, events, getActiveModeKey, getModeTimeMs }');
  }

  installPanelStyles();
  installBadgeStyles();

  const root = document.createElement('div');
  root.id = 'sprint-badge';
  root.className = 'tp-sprint-badge';

  const labelEl = document.createElement('span');
  labelEl.className = 'tp-sprint-badge__label';
  labelEl.textContent = 'Sprint · 40 lines';
  root.appendChild(labelEl);

  const timeEl = document.createElement('span');
  timeEl.className = 'tp-sprint-badge__time';
  timeEl.textContent = '0:00.000';
  root.appendChild(timeEl);

  const linesEl = document.createElement('span');
  linesEl.className = 'tp-sprint-badge__lines';
  root.appendChild(linesEl);

  document.body.appendChild(root);

  let _target        = 40;
  let _linesCleared  = 0;
  let _completed     = false;
  let _frozenTimeMs  = null;   // when set, render this instead of getModeTimeMs()
  let _pulseTimer    = null;
  let _lastRenderedTimeStr = '';
  let _lastRenderedLinesHTML = '';

  function isVisible() { return getActiveModeKey() === 'sprint'; }

  function renderLines() {
    const remaining = Math.max(0, _target - _linesCleared);
    const html = `<strong>${remaining}</strong> / ${_target} lines remaining`;
    if (html !== _lastRenderedLinesHTML) {
      linesEl.innerHTML = html;
      _lastRenderedLinesHTML = html;
    }
  }
  function renderTime(ms) {
    const str = formatSprintTime(ms);
    if (str !== _lastRenderedTimeStr) {
      timeEl.textContent = str;
      _lastRenderedTimeStr = str;
    }
  }

  function refresh() {
    if (!isVisible()) {
      root.classList.remove('is-visible');
      return;
    }
    root.classList.add('is-visible');
    root.classList.toggle('is-completed', _completed);
    renderLines();
    renderTime(_frozenTimeMs != null ? _frozenTimeMs : getModeTimeMs());
  }

  /**
   * Called per gameplay tick. Cheap when the badge isn't visible (one
   * thunk + a class check). When visible, conditionally rewrites the
   * time + lines spans only when the formatted strings change.
   */
  function tick() {
    if (!isVisible()) {
      if (root.classList.contains('is-visible')) root.classList.remove('is-visible');
      return;
    }
    if (!root.classList.contains('is-visible')) {
      root.classList.add('is-visible');
    }
    if (_frozenTimeMs == null) {
      renderTime(getModeTimeMs());
    }
  }

  function pulse() {
    root.classList.add('is-pulsing');
    if (_pulseTimer != null) clearTimeout(_pulseTimer);
    _pulseTimer = setTimeout(() => {
      root.classList.remove('is-pulsing');
      _pulseTimer = null;
    }, 420);
  }

  // Subscriptions.
  const offs = [];

  offs.push(bus.on(events.MODE_START, (e) => {
    _completed     = false;
    _frozenTimeMs  = null;
    _linesCleared  = getLinesCleared() || 0;
    if (e && e.initialModeView && e.initialModeView.kind === 'sprint') {
      _target = e.initialModeView.target || e.initialModeView.linesRemaining || 40;
    }
    refresh();
  }));

  offs.push(bus.on(events.LINE_CLEAR, (e) => {
    if (!isVisible()) return;
    _linesCleared += (e && Array.isArray(e.rows) ? e.rows.length : (e?.simultaneous || 0));
    renderLines();
  }));

  offs.push(bus.on(events.MODE_GOAL_PROGRESS, (e) => {
    if (!isVisible()) return;
    if (!e || e.kind !== 'lines') return;
    pulse();
  }));

  offs.push(bus.on(events.MODE_END, (e) => {
    if (!isVisible()) return;
    // Lock the displayed time on the value reported by the run — that's
    // the spec-correct "time at the lock that triggered line 40", not
    // "time at end of clear-anim". The `e.timeMs` field comes from the
    // host's _modeTimeMs which was accumulated by the gameplay tick.
    if (e) {
      _frozenTimeMs = (typeof e.timeMs === 'number') ? e.timeMs : getModeTimeMs();
      if (e.reason === 'goal') {
        _completed = true;
        labelEl.textContent = 'Sprint · cleared!';
        _linesCleared = _target;
        pulse();
      } else {
        labelEl.textContent = 'Sprint · ' + (e.reason || 'ended');
      }
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
