// Physics HUD badge — pure DOM module for the experimental physics
// mode (plan v2 §2.3 Phase E, archived plan_gameplay_1.md §8.9 #5).
//
// Visible only when the active mode is `physics`. Surfaces the
// physics-session's live numeric state:
//   - cube count (settled + falling bodies in the world)
//   - awake count (bodies still moving — drops as the stack settles)
//   - layers cleared (cumulative across the run)
//
// Pulses on each `PHYSICS_LAYER_CLEARED` event so the player gets a
// visual confirmation of the connected-component layer detector
// firing. Without the pulse, the cumulative counter would just tick
// up silently.
//
// Pure DOM. Reads via thunks (`getCubeCount`, `getAwakeCount`,
// `getLayersClearedTotal`) the host wires to the live PhysicsSession
// — no direct dependency on the session class itself, so this module
// stays trivially testable in isolation.

import { installPanelStyles } from './panel-shared.js';

let _stylesInstalled = false;

function installBadgeStyles() {
  if (_stylesInstalled) return;
  _stylesInstalled = true;
  const css = `
    .tp-physics-badge {
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
      gap: 4px;
      background: rgba(10, 14, 24, 0.58);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45),
                  inset 0 0 60px rgba(184, 76, 255, 0.025);
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
    .tp-physics-badge.is-visible { display: flex; }
    .tp-physics-badge__label {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      font-size: 9px;
      color: var(--muted, #8b93ad);
      opacity: 0.7;
    }
    .tp-physics-badge__row {
      display: grid;
      grid-template-columns: repeat(3, auto);
      gap: 16px;
      align-items: baseline;
    }
    .tp-physics-badge__metric {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1px;
    }
    .tp-physics-badge__metric-label {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 8.5px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--muted, #8b93ad);
      opacity: 0.7;
    }
    .tp-physics-badge__metric-value {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      font-size: 18px;
      letter-spacing: 0.04em;
      color: var(--ink, #f3f5fb);
    }
    .tp-physics-badge__metric--cleared .tp-physics-badge__metric-value {
      color: #d3a8ff; /* violet — physics' visual identity, matches the experimental tier */
      text-shadow: 0 0 14px rgba(184, 76, 255, 0.32);
    }
    .tp-physics-badge.is-pulsing {
      box-shadow: 0 0 0 6px rgba(184, 76, 255, 0.45),
                  0 10px 40px rgba(0, 0, 0, 0.45),
                  inset 0 0 60px rgba(184, 76, 255, 0.20);
    }
    .tp-physics-badge.is-pulsing .tp-physics-badge__metric--cleared .tp-physics-badge__metric-value {
      animation: tp-physics-badge-bump 320ms ease-out;
    }
    @keyframes tp-physics-badge-bump {
      0%   { transform: scale(1.0); }
      40%  { transform: scale(1.32); }
      100% { transform: scale(1.0); }
    }
  `;
  const style = document.createElement('style');
  style.id = 'tp-physics-badge-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * @typedef {Object} PhysicsBadgeOpts
 * @property {{on:(t:string,fn:Function,o?:any)=>Function}} bus
 * @property {{ MODE_START:string, MODE_END:string, PHYSICS_LAYER_CLEARED:string }} events
 * @property {() => string} getActiveModeKey
 * @property {() => number} getCubeCount
 * @property {() => number} getAwakeCount
 * @property {() => number} getLayersClearedTotal
 */

/**
 * @param {PhysicsBadgeOpts} opts
 * @returns {{ root: HTMLElement, refresh:()=>void, tick:()=>void, dispose:()=>void }}
 */
export function createPhysicsBadge(opts) {
  const {
    bus, events,
    getActiveModeKey,
    getCubeCount,
    getAwakeCount,
    getLayersClearedTotal,
  } = opts || {};
  if (!bus || !events
      || typeof getActiveModeKey       !== 'function'
      || typeof getCubeCount           !== 'function'
      || typeof getAwakeCount          !== 'function'
      || typeof getLayersClearedTotal  !== 'function') {
    throw new Error('createPhysicsBadge requires { bus, events, getActiveModeKey, getCubeCount, getAwakeCount, getLayersClearedTotal }');
  }

  installPanelStyles();
  installBadgeStyles();

  const root = document.createElement('div');
  root.id = 'physics-badge';
  root.className = 'tp-physics-badge';

  const labelEl = document.createElement('span');
  labelEl.className = 'tp-physics-badge__label';
  labelEl.textContent = 'Physics · experimental';
  root.appendChild(labelEl);

  function makeMetric(modifier, labelText) {
    const wrap = document.createElement('div');
    wrap.className = `tp-physics-badge__metric tp-physics-badge__metric--${modifier}`;
    const lbl = document.createElement('span');
    lbl.className = 'tp-physics-badge__metric-label';
    lbl.textContent = labelText;
    const val = document.createElement('span');
    val.className = 'tp-physics-badge__metric-value';
    val.textContent = '0';
    wrap.appendChild(lbl);
    wrap.appendChild(val);
    return { wrap, val };
  }
  const row    = document.createElement('div');
  row.className = 'tp-physics-badge__row';
  const cubes  = makeMetric('cubes',   'Cubes');
  const awake  = makeMetric('awake',   'Awake');
  const cleared = makeMetric('cleared', 'Layers');
  row.appendChild(cubes.wrap);
  row.appendChild(awake.wrap);
  row.appendChild(cleared.wrap);
  root.appendChild(row);

  document.body.appendChild(root);

  let _pulseTimer = null;
  function isVisible() { return getActiveModeKey() === 'physics'; }

  function pulse() {
    root.classList.add('is-pulsing');
    if (_pulseTimer != null) clearTimeout(_pulseTimer);
    _pulseTimer = setTimeout(() => {
      root.classList.remove('is-pulsing');
      _pulseTimer = null;
    }, 360);
  }

  function refresh() {
    if (!isVisible()) {
      root.classList.remove('is-visible');
      return;
    }
    root.classList.add('is-visible');
    tick();
  }

  /**
   * Per-frame update — pull the live numeric state from the host's
   * thunks. Cheap; only writes to DOM when the value actually changed.
   */
  function tick() {
    if (!isVisible()) {
      if (root.classList.contains('is-visible')) root.classList.remove('is-visible');
      return;
    }
    if (!root.classList.contains('is-visible')) root.classList.add('is-visible');
    const c = (getCubeCount()           | 0).toString();
    const a = (getAwakeCount()          | 0).toString();
    const L = (getLayersClearedTotal()  | 0).toString();
    if (cubes.val.textContent   !== c) cubes.val.textContent   = c;
    if (awake.val.textContent   !== a) awake.val.textContent   = a;
    if (cleared.val.textContent !== L) cleared.val.textContent = L;
  }

  const offs = [];
  offs.push(bus.on(events.MODE_START, () => {
    refresh();
  }));
  offs.push(bus.on(events.PHYSICS_LAYER_CLEARED, () => {
    if (!isVisible()) return;
    pulse();
    tick();
  }));
  offs.push(bus.on(events.MODE_END, () => refresh()));

  refresh();

  return {
    root,
    refresh,
    tick,
    dispose() {
      for (const off of offs) try { off(); } catch { /* ignore */ }
      if (_pulseTimer != null) clearTimeout(_pulseTimer);
      root.remove();
    },
  };
}
