// Versus HUD badge — opponent state + incoming garbage queue
// (plan_gameplay_1.md §3.6 #4).
//
// Visible only when the active mode is Versus. Surfaces:
//  - opponent score (the bot's cosmetic counter in v1; remote score in v2)
//  - opponent's accumulated player→bot garbage (visualizes the player's
//    pressure on the bot)
//  - inbound garbage queue (what's about to land on the player)
//  - "BLOCKED" indicator when the queue has hit the cap
//  - latency placeholder (always 0 in local; reserved for online v2)
//
// On MODE_END, swaps to a "WIN" / "LOSS" / "DRAW" finale based on the
// winner field.
//
// Pure DOM. Uses the shared `tp-panel` chrome.

import { installPanelStyles } from './panel-shared.js';

let _stylesInstalled = false;

function installBadgeStyles() {
  if (_stylesInstalled) return;
  _stylesInstalled = true;
  const css = `
    .tp-versus-badge {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 50;
      min-width: 320px;
      padding: 10px 16px 8px;
      display: none;
      flex-direction: column;
      align-items: stretch;
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
      transition: box-shadow 0.4s ease-out, border-color 0.4s ease-out;
      pointer-events: none;
    }
    .tp-versus-badge.is-visible { display: flex; }
    .tp-versus-badge__head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 12px;
    }
    .tp-versus-badge__label {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      font-size: 9px;
      color: var(--muted, #8b93ad);
      opacity: 0.7;
    }
    .tp-versus-badge__latency {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 9px;
      letter-spacing: 0.10em;
      color: var(--muted, #8b93ad);
      opacity: 0.55;
    }
    .tp-versus-badge__body {
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      gap: 10px;
      align-items: center;
    }
    .tp-versus-badge__side {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
    }
    .tp-versus-badge__side-label {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      font-size: 8.5px;
      color: var(--muted, #8b93ad);
    }
    .tp-versus-badge__score {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      font-size: 18px;
      letter-spacing: 0.04em;
      color: var(--ink, #f3f5fb);
    }
    .tp-versus-badge__vs {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      letter-spacing: 0.18em;
      font-size: 11px;
      color: var(--muted, #8b93ad);
      opacity: 0.6;
    }
    .tp-versus-badge__queue {
      display: flex;
      gap: 3px;
      justify-content: center;
      flex-wrap: wrap;
      padding: 4px 0 0;
      min-height: 18px;
    }
    .tp-versus-badge__pip {
      display: inline-block;
      width: 14px;
      height: 6px;
      border-radius: 2px;
      background: rgba(255, 92, 138, 0.55);
      box-shadow: 0 0 6px rgba(255, 92, 138, 0.40);
    }
    .tp-versus-badge__pip--bot {
      background: rgba(108, 240, 255, 0.45);
      box-shadow: 0 0 6px rgba(108, 240, 255, 0.30);
    }
    .tp-versus-badge__queue-empty {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 9px;
      letter-spacing: 0.14em;
      color: var(--muted, #8b93ad);
      opacity: 0.4;
    }
    .tp-versus-badge.is-pulsing {
      box-shadow: 0 0 0 6px rgba(255, 92, 138, 0.45),
                  0 10px 40px rgba(0, 0, 0, 0.45),
                  inset 0 0 60px rgba(255, 92, 138, 0.20);
    }
    .tp-versus-badge.is-blocked .tp-versus-badge__queue {
      background: rgba(255, 92, 138, 0.10);
      border: 1px dashed rgba(255, 92, 138, 0.55);
      border-radius: 4px;
    }
    /* Finale states. */
    .tp-versus-badge.is-finale {
      border-color: rgba(255, 212, 0, 0.55);
    }
    .tp-versus-badge.is-finale.is-loss {
      border-color: rgba(255, 92, 138, 0.55);
    }
    .tp-versus-badge.is-finale .tp-versus-badge__label {
      color: var(--ink, #f3f5fb);
      font-size: 18px;
      letter-spacing: 0.30em;
      opacity: 1.0;
    }
    .tp-versus-badge.is-finale.is-win .tp-versus-badge__label {
      color: #ffd400;
      text-shadow: 0 0 14px rgba(255, 212, 0, 0.45);
    }
    .tp-versus-badge.is-finale.is-loss .tp-versus-badge__label {
      color: #ff8aa0;
    }
  `;
  const style = document.createElement('style');
  style.id = 'tp-versus-badge-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

const QUEUE_PIP_CAP = 12;        // keep the row from wrapping to a third line

/**
 * @typedef {Object} VersusBadgeOpts
 * @property {{on:(t:string,fn:Function,o?:any)=>Function}} bus
 * @property {{ MODE_START:string, MODE_END:string, GARBAGE_SENT:string, GARBAGE_RECEIVED:string, PIECE_LOCK:string }} events
 * @property {() => string} getActiveModeKey
 * @property {() => { score:number, stackHeight:number, deathThreshold:number, alive:boolean }} getOpponentSnapshot
 * @property {() => { rows:number, blocked:boolean }} getInboundGarbage
 * @property {number} [latencyMs]      Always 0 in local; reserved for online.
 */

/**
 * @param {VersusBadgeOpts} opts
 */
export function createVersusBadge(opts) {
  const {
    bus, events,
    getActiveModeKey,
    getOpponentSnapshot,
    getInboundGarbage,
    latencyMs = 0,
  } = opts || {};
  if (!bus || !events
      || typeof getActiveModeKey !== 'function'
      || typeof getOpponentSnapshot !== 'function'
      || typeof getInboundGarbage   !== 'function') {
    throw new Error('createVersusBadge requires { bus, events, getActiveModeKey, getOpponentSnapshot, getInboundGarbage }');
  }

  installPanelStyles();
  installBadgeStyles();

  const root = document.createElement('div');
  root.id = 'versus-badge';
  root.className = 'tp-versus-badge';

  const head = document.createElement('div');
  head.className = 'tp-versus-badge__head';
  const labelEl = document.createElement('span');
  labelEl.className = 'tp-versus-badge__label';
  labelEl.textContent = 'Versus · vs Bot';
  const latencyEl = document.createElement('span');
  latencyEl.className = 'tp-versus-badge__latency';
  latencyEl.textContent = latencyMs > 0 ? `${latencyMs}ms` : 'local';
  head.appendChild(labelEl);
  head.appendChild(latencyEl);
  root.appendChild(head);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'tp-versus-badge__body';
  function makeSide(labelText) {
    const wrap = document.createElement('div');
    wrap.className = 'tp-versus-badge__side';
    const lbl = document.createElement('span');
    lbl.className = 'tp-versus-badge__side-label';
    lbl.textContent = labelText;
    const num = document.createElement('span');
    num.className = 'tp-versus-badge__score';
    num.textContent = '0';
    wrap.appendChild(lbl);
    wrap.appendChild(num);
    return { wrap, num };
  }
  const youSide = makeSide('YOU');
  const vs = document.createElement('span');
  vs.className = 'tp-versus-badge__vs';
  vs.textContent = 'vs';
  const oppSide = makeSide('BOT');
  bodyEl.appendChild(youSide.wrap);
  bodyEl.appendChild(vs);
  bodyEl.appendChild(oppSide.wrap);
  root.appendChild(bodyEl);

  const queueEl = document.createElement('div');
  queueEl.className = 'tp-versus-badge__queue';
  root.appendChild(queueEl);

  document.body.appendChild(root);

  let _completed = false;
  let _pulseTimer = null;

  function isVisible() { return getActiveModeKey() === 'versus'; }
  function pulse() {
    root.classList.add('is-pulsing');
    if (_pulseTimer != null) clearTimeout(_pulseTimer);
    _pulseTimer = setTimeout(() => {
      root.classList.remove('is-pulsing');
      _pulseTimer = null;
    }, 380);
  }

  // Render the queue strip — pink pips for inbound garbage that's about to
  // land on the player; dim cyan pips for the bot's accumulated stack
  // (visual proxy for "how close are we to KO'ing the bot"). Hidden when
  // both are zero to avoid empty-row noise.
  function renderQueue() {
    const inb = getInboundGarbage() || { rows: 0, blocked: false };
    const opp = getOpponentSnapshot() || {};
    queueEl.innerHTML = '';
    const inboundCount = Math.min(QUEUE_PIP_CAP, inb.rows | 0);
    const oppCount     = Math.min(QUEUE_PIP_CAP, opp.stackHeight | 0);

    if (inboundCount === 0 && oppCount === 0 && !inb.blocked) {
      const empty = document.createElement('span');
      empty.className = 'tp-versus-badge__queue-empty';
      empty.textContent = '— no garbage in flight —';
      queueEl.appendChild(empty);
    } else {
      for (let i = 0; i < inboundCount; i++) {
        const pip = document.createElement('span');
        pip.className = 'tp-versus-badge__pip';
        queueEl.appendChild(pip);
      }
      // Spacer between the two stacks if both have pips.
      if (inboundCount > 0 && oppCount > 0) {
        const sep = document.createElement('span');
        sep.style.cssText = 'width:8px;display:inline-block;';
        queueEl.appendChild(sep);
      }
      for (let i = 0; i < oppCount; i++) {
        const pip = document.createElement('span');
        pip.className = 'tp-versus-badge__pip tp-versus-badge__pip--bot';
        queueEl.appendChild(pip);
      }
      if (inb.blocked) {
        const block = document.createElement('span');
        block.className = 'tp-versus-badge__queue-empty';
        block.style.color = '#ff8aa0';
        block.style.opacity = '0.95';
        block.textContent = ' · BLOCKED';
        queueEl.appendChild(block);
      }
    }

    root.classList.toggle('is-blocked', !!inb.blocked);
  }

  function refresh() {
    if (!isVisible()) {
      root.classList.remove('is-visible');
      return;
    }
    root.classList.add('is-visible');
    if (!_completed) {
      labelEl.textContent = 'Versus · vs Bot';
    }
    renderQueue();
  }

  /** Per-render tick — keeps the score readouts + queue current. Cheap
   *  when not visible (early return). */
  function tick(youScore) {
    if (!isVisible()) {
      if (root.classList.contains('is-visible')) root.classList.remove('is-visible');
      return;
    }
    if (!root.classList.contains('is-visible')) root.classList.add('is-visible');
    const opp = getOpponentSnapshot() || { score: 0 };
    const youStr = ((youScore | 0)).toLocaleString();
    const oppStr = ((opp.score | 0)).toLocaleString();
    if (youSide.num.textContent !== youStr) youSide.num.textContent = youStr;
    if (oppSide.num.textContent !== oppStr) oppSide.num.textContent = oppStr;
    renderQueue();
  }

  // Subscriptions.
  const offs = [];

  offs.push(bus.on(events.MODE_START, () => {
    _completed = false;
    root.classList.remove('is-finale', 'is-win', 'is-loss', 'is-blocked', 'is-pulsing');
    labelEl.textContent = 'Versus · vs Bot';
    youSide.num.textContent = '0';
    oppSide.num.textContent = '0';
    refresh();
  }));

  // Pulse on every garbage event — both directions — so the chrome
  // "thumps" with pressure. Cheap.
  offs.push(bus.on(events.GARBAGE_SENT, () => {
    if (!isVisible()) return;
    pulse();
  }));
  offs.push(bus.on(events.GARBAGE_RECEIVED, () => {
    if (!isVisible()) return;
    pulse();
    renderQueue();
  }));

  // PIECE_LOCK fires *before* drainInboundGarbage in main.js, so our
  // post-lock render still shows the queue contents. Subscribing here
  // gives the queue a refresh on every lock without needing a tick.
  offs.push(bus.on(events.PIECE_LOCK, () => {
    if (!isVisible()) return;
    renderQueue();
  }));

  offs.push(bus.on(events.MODE_END, (e) => {
    if (!isVisible()) return;
    _completed = true;
    const winner = e && e.winner;
    root.classList.add('is-finale');
    if (winner === 'player')        { root.classList.add('is-win');  labelEl.textContent = 'WIN'; }
    else if (winner === 'opponent') { root.classList.add('is-loss'); labelEl.textContent = 'LOSS'; }
    else                            { labelEl.textContent = (e?.reason === 'forfeit') ? 'FORFEIT' : 'DRAW'; }
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
