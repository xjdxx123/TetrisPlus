// Versus HUD badge — opponent state + per-side garbage queues
// (plan_gameplay_1.md §3.6 #4 + §3.7 dual-board + §13 polish).
//
// Visible only when the active mode is Versus. Surfaces:
//  - opponent score (the bot's cosmetic counter in v1; remote score in v2)
//  - **TO YOU** queue — pink pips for inbound garbage about to land on
//    the player. Each pip's opacity reflects M5 spawn-delay readiness:
//    dim while pending (readyAt > modeTime), bright when ready, pulsing
//    when imminent (≤200ms to ready).
//  - **TO BOT** queue — cyan pips for outbound garbage queued on the
//    opponent's well (what the player has SENT and is waiting for the
//    bot to absorb). Same readiness scheme, mirrored layout.
//  - "BLOCKED" indicator when either queue has hit the cap.
//  - latency placeholder (always 0 in local; reserved for online v2).
//
// The two columns sit directly under their respective score, so each
// player can read "what's about to hit me" and "what's pressuring my
// opponent" at a glance — symmetric, color-coded, side-labeled.
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
      align-items: start;
    }
    .tp-versus-badge__side {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
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
      align-self: center;
    }

    /* ─── Per-side garbage queue (split-column layout) ─── */
    .tp-versus-badge__queue {
      position: relative;
      display: grid;
      grid-template-columns: repeat(8, 14px);
      gap: 3px;
      justify-content: center;
      padding: 4px 6px;
      border-radius: 4px;
      width: 136px;
      min-height: 18px;
      transition: background 0.2s ease-out, border-color 0.2s ease-out;
      border: 1px solid rgba(255, 255, 255, 0.06);
      background: rgba(255, 255, 255, 0.02);
    }
    .tp-versus-badge__queue-caption {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      font-size: 8.5px;
      color: var(--muted, #8b93ad);
      opacity: 0.7;
    }
    .tp-versus-badge__queue-total {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
      font-size: 9px;
      letter-spacing: 0.10em;
      color: var(--muted, #8b93ad);
      opacity: 0.75;
      min-height: 12px;
    }

    /* Track slot — always rendered (8 of them per side) so the queue
       area has a permanent visible structure. Fills with a real pip
       on top when garbage queues. */
    .tp-versus-badge__slot {
      width: 14px;
      height: 6px;
      border-radius: 2px;
      border: 1px solid rgba(255, 255, 255, 0.10);
      background: rgba(255, 255, 255, 0.02);
      box-sizing: border-box;
    }
    /* Pip — base shape; per-side color overridden below. Sits inside
       the corresponding slot via grid placement. */
    .tp-versus-badge__pip {
      width: 14px;
      height: 6px;
      border-radius: 2px;
      transition: opacity 0.18s ease-out, transform 0.2s ease-out;
    }
    /* Inbound (TO YOU) → red/pink, the threat color. */
    .tp-versus-badge__pip--inbound {
      background: rgba(255, 92, 138, 0.85);
      box-shadow: 0 0 6px rgba(255, 92, 138, 0.55);
    }
    /* Outbound (TO BOT) → cyan, the same accent the §3.7 versus polish
       uses for opponent shockwaves so the player learns the visual
       language: cyan = "I sent that". */
    .tp-versus-badge__pip--outbound {
      background: rgba(108, 240, 255, 0.85);
      box-shadow: 0 0 6px rgba(108, 240, 255, 0.50);
    }
    /* Readiness modifier states (M5 spawn-delay window):
       - pending  : readyAt > modeTime + 200ms — dim, waiting in queue.
       - imminent : within 200ms of ready — pulse so the player knows
                    "lock soon to cancel, or eat it next piece".
       - ready    : default (no class) — full opacity, will apply on
                    the next no-clear lock. */
    .tp-versus-badge__pip--pending {
      opacity: 0.32;
    }
    .tp-versus-badge__pip--imminent {
      animation: tp-versus-badge-pip-pulse 480ms ease-in-out infinite alternate;
    }
    @keyframes tp-versus-badge-pip-pulse {
      from { opacity: 0.55; transform: scaleY(1.0); }
      to   { opacity: 1.00; transform: scaleY(1.4); }
    }

    /* Drain flash (plan_gameplay_2.md §1.3). Plays once whenever a
       queue applies (GARBAGE_APPLIED) or is eaten by an outgoing
       clear (GARBAGE_CANCELLED) — communicates "the queue just
       drained" since the M5 spawn-delay window means real pips
       appear and disappear quickly during normal play. The pip-by-
       pip exit animation would need DOM identity tracking; this
       container-level flash gives the same UX read with a fraction
       of the complexity. */
    .tp-versus-badge__queue.is-draining-applied {
      animation: tp-versus-badge-queue-applied 320ms ease-out;
    }
    .tp-versus-badge__queue.is-draining-cancelled {
      animation: tp-versus-badge-queue-cancelled 320ms ease-out;
    }
    @keyframes tp-versus-badge-queue-applied {
      0%   { background: rgba(255, 92, 138, 0.30);
             box-shadow: 0 0 14px rgba(255, 92, 138, 0.55);
             border-color: rgba(255, 92, 138, 0.65); }
      100% { background: rgba(255, 255, 255, 0.02);
             box-shadow: none;
             border-color: rgba(255, 255, 255, 0.06); }
    }
    @keyframes tp-versus-badge-queue-cancelled {
      0%   { background: rgba(108, 240, 255, 0.30);
             box-shadow: 0 0 14px rgba(108, 240, 255, 0.55);
             border-color: rgba(108, 240, 255, 0.65); }
      100% { background: rgba(255, 255, 255, 0.02);
             box-shadow: none;
             border-color: rgba(255, 255, 255, 0.06); }
    }

    /* Pulse on garbage events. */
    .tp-versus-badge.is-pulsing {
      box-shadow: 0 0 0 6px rgba(255, 92, 138, 0.45),
                  0 10px 40px rgba(0, 0, 0, 0.45),
                  inset 0 0 60px rgba(255, 92, 138, 0.20);
    }
    /* When EITHER queue is at the cap, the badge marks the blocked state.
       The blocked column itself draws a dashed red border. */
    .tp-versus-badge__queue.is-blocked {
      background: rgba(255, 92, 138, 0.10);
      border: 1px dashed rgba(255, 92, 138, 0.55);
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

const QUEUE_PIP_CAP = 12;        // keep each column from wrapping past 2 lines
// Spawn-delay readiness threshold (matches Game._garbageDelayMs default
// of 800ms — this is the "imminent" window in the last fifth or so).
const IMMINENT_MS = 200;

/**
 * @typedef {Object} GarbageQueueState
 * @property {number} rows       Total queued rows (sum of entries.rows).
 * @property {boolean} blocked   True when the queue has hit its cap.
 * @property {Array<{rows:number, readyAt:number}>} [entries]
 *   Per-entry queue contents in FIFO order (front = oldest = next to
 *   apply). Optional — when missing, the badge renders all pips as
 *   "ready" (matches the pre-§13 behaviour).
 * @property {number} [modeTimeMs]
 *   The Game's pause-aware time at the moment of read. Used together
 *   with `entries[*].readyAt` to compute readiness state. Optional;
 *   defaults to "everything ready" when omitted.
 */

/**
 * @typedef {Object} VersusBadgeOpts
 * @property {{on:(t:string,fn:Function,o?:any)=>Function}} bus
 * @property {{ MODE_START:string, MODE_END:string, GARBAGE_SENT:string,
 *              GARBAGE_OUTGOING:string, GARBAGE_RECEIVED:string,
 *              GARBAGE_CANCELLED:string, PIECE_LOCK:string }} events
 * @property {() => string} getActiveModeKey
 * @property {() => { score:number, stackHeight:number, deathThreshold:number, alive:boolean }} getOpponentSnapshot
 * @property {() => GarbageQueueState} getInboundGarbage
 *   The PLAYER's inbound queue (about to land on YOU).
 * @property {() => GarbageQueueState} [getOutboundGarbage]
 *   The OPPONENT's inbound queue (what the player has sent and is
 *   waiting for the opponent to absorb). When omitted (Phase-6 single-
 *   sim with abstract bot), the bot column renders empty.
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
    getOutboundGarbage = () => ({ rows: 0, blocked: false }),
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
  /**
   * Build a "side" column: SIDE LABEL → SCORE → caption ("TO YOU" /
   * "TO BOT") → queue pip strip → row total. Each column is a single
   * vertical stack so the player can read each side independently.
   */
  function makeSide(labelText, captionText, pipKindClass) {
    const wrap = document.createElement('div');
    wrap.className = 'tp-versus-badge__side';
    const lbl = document.createElement('span');
    lbl.className = 'tp-versus-badge__side-label';
    lbl.textContent = labelText;
    const num = document.createElement('span');
    num.className = 'tp-versus-badge__score';
    num.textContent = '0';
    const caption = document.createElement('span');
    caption.className = 'tp-versus-badge__queue-caption';
    caption.textContent = captionText;
    const queue = document.createElement('div');
    queue.className = 'tp-versus-badge__queue';
    const total = document.createElement('span');
    total.className = 'tp-versus-badge__queue-total';
    total.textContent = '';
    wrap.appendChild(lbl);
    wrap.appendChild(num);
    wrap.appendChild(caption);
    wrap.appendChild(queue);
    wrap.appendChild(total);
    return { wrap, num, queue, total, pipKindClass };
  }
  const youSide = makeSide('YOU', 'INCOMING TO YOU',  'tp-versus-badge__pip--inbound');
  const vs      = document.createElement('span');
  vs.className = 'tp-versus-badge__vs';
  vs.textContent = 'vs';
  const oppSide = makeSide('BOT', 'INCOMING TO BOT',  'tp-versus-badge__pip--outbound');
  bodyEl.appendChild(youSide.wrap);
  bodyEl.appendChild(vs);
  bodyEl.appendChild(oppSide.wrap);
  root.appendChild(bodyEl);

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

  // Number of permanent slot outlines per side. Anything beyond this
  // count gets summarized in the "+N more" footer rather than wrapping
  // to a third row, so the badge stays a fixed height.
  const SLOT_COUNT = QUEUE_PIP_CAP;

  /**
   * Render one side's queue column. Always paints `SLOT_COUNT` faded
   * slot outlines so the queue area has visible structure even when
   * empty; overlays a real pip on each slot that has queued garbage.
   * Each pip carries its own readiness state (M5 spawn-delay window).
   *
   * @param {ReturnType<makeSide>} side
   * @param {GarbageQueueState} state
   */
  function renderSideQueue(side, state) {
    const { queue, total, pipKindClass } = side;
    const totalRows = Math.max(0, state.rows | 0);
    const blocked   = !!state.blocked;
    queue.innerHTML = '';
    queue.classList.toggle('is-blocked', blocked);

    // Step 1 — always render the slot track so the queue area is
    // permanently visible (vs. the prior "— clear —" empty state which
    // hid the structure entirely and made the badge feel half-dead).
    const slotEls = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const slot = document.createElement('span');
      slot.className = 'tp-versus-badge__slot';
      queue.appendChild(slot);
      slotEls.push(slot);
    }

    // Step 2 — overlay real pips. Iterate per-entry so each pip can
    // carry its own readiness state. Falls back to a single synthetic
    // entry when the host doesn't surface per-entry data.
    const entries = Array.isArray(state.entries) && state.entries.length
      ? state.entries
      : [{ rows: totalRows, readyAt: 0 }];
    const now = state.modeTimeMs | 0;

    let pipCount = 0;
    for (const entry of entries) {
      if (pipCount >= SLOT_COUNT) break;
      const remaining = (entry.readyAt | 0) - now;
      const ready    = remaining <= 0;
      const imminent = !ready && remaining <= IMMINENT_MS;
      const rows     = entry.rows | 0;
      for (let i = 0; i < rows && pipCount < SLOT_COUNT; i++, pipCount++) {
        const slot = slotEls[pipCount];
        const pip = document.createElement('span');
        pip.className = `tp-versus-badge__pip ${pipKindClass}`;
        if (!ready)   pip.classList.add('tp-versus-badge__pip--pending');
        if (imminent) pip.classList.add('tp-versus-badge__pip--imminent');
        // Replace the slot outline with the pip — same grid cell,
        // so the layout doesn't shift.
        slot.replaceWith(pip);
      }
    }

    // Step 3 — row-count footer. ALWAYS rendered now (even at 0) so
    // the row count is a stable always-on readout, not appearing /
    // disappearing as the queue empties.
    const overflow = Math.max(0, totalRows - SLOT_COUNT);
    let label;
    if (blocked) {
      label = `${totalRows} ROWS · BLOCKED`;
      total.style.color = '#ff8aa0';
    } else if (totalRows === 0) {
      label = 'CLEAR';
      total.style.color = '';
    } else if (overflow > 0) {
      label = `${totalRows} ROWS · +${overflow} OFFSCREEN`;
      total.style.color = '';
    } else {
      label = `${totalRows} ROW${totalRows === 1 ? '' : 'S'}`;
      total.style.color = '';
    }
    total.textContent = label;
  }

  /**
   * Render both queues + the badge-level "is-blocked" composite flag.
   * Driven by `tick()` (every render frame) and by garbage-event
   * subscribers below for snappier reactions.
   */
  function renderQueue() {
    const inb = getInboundGarbage()  || { rows: 0, blocked: false };
    const out = getOutboundGarbage() || { rows: 0, blocked: false };
    renderSideQueue(youSide, inb);
    renderSideQueue(oppSide, out);
    root.classList.toggle('is-blocked', !!inb.blocked || !!out.blocked);
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

  /**
   * Drain flash helper (plan_gameplay_2.md §1.3) — kicks off a one-shot
   * CSS animation on a queue column. The class swap forces the
   * animation to restart on rapid back-to-back events (without the
   * `void offsetWidth` reflow trick, the second flash wouldn't play).
   *
   * @param {HTMLElement} queueEl  The `.tp-versus-badge__queue` element.
   * @param {'applied'|'cancelled'} kind
   */
  function flashDrain(queueEl, kind) {
    if (!queueEl) return;
    const cls = kind === 'cancelled'
      ? 'is-draining-cancelled'
      : 'is-draining-applied';
    // Remove any in-flight animation so a rapid follow-up event
    // restarts cleanly.
    queueEl.classList.remove('is-draining-applied', 'is-draining-cancelled');
    void queueEl.offsetWidth; // force reflow so animation restarts
    queueEl.classList.add(cls);
    // Animation is 320ms; clean up the class after a small buffer.
    setTimeout(() => queueEl.classList.remove(cls), 360);
  }

  // Pulse + re-render on every garbage event — both directions — so the
  // chrome "thumps" with pressure. Cheap.
  offs.push(bus.on(events.GARBAGE_SENT, () => {
    if (!isVisible()) return;
    pulse();
    renderQueue(); // bot's queue grew
  }));
  offs.push(bus.on(events.GARBAGE_RECEIVED, () => {
    if (!isVisible()) return;
    pulse();
    renderQueue(); // your queue grew
  }));
  // §12 M5: outgoing emitted by versus.onLinesCleared (raw, pre-cancel).
  // Re-render so the bot column updates the moment a clear lands, not
  // waiting for the next tick.
  if (events.GARBAGE_OUTGOING) {
    offs.push(bus.on(events.GARBAGE_OUTGOING, () => {
      if (!isVisible()) return;
      renderQueue();
    }));
  }
  // §12 M5: cancellation eats from the queue front-first. Re-render
  // immediately + flash the column cyan so the player sees a clear
  // "I just ate that garbage" cue (plan_gameplay_2.md §1.3).
  if (events.GARBAGE_CANCELLED) {
    offs.push(bus.on(events.GARBAGE_CANCELLED, () => {
      if (!isVisible()) return;
      // Cancellation always reduces the PLAYER's inbound queue
      // (versus.onLinesCleared composes outgoing → Game cancels
      // against the player's own inbound). Flash YOU's column.
      flashDrain(youSide.queue, 'cancelled');
      renderQueue();
    }));
  }

  // §12 M5: GARBAGE_APPLIED fires when a queued entry has actually
  // landed on the board. Re-render so the column updates AND flash
  // pink so the player sees "the queue just hit me" cleanly. Without
  // this flash, the spawn-delay window's 800ms means pips often
  // appear and disappear faster than the eye registers.
  if (events.GARBAGE_APPLIED) {
    offs.push(bus.on(events.GARBAGE_APPLIED, () => {
      if (!isVisible()) return;
      flashDrain(youSide.queue, 'applied');
      renderQueue();
    }));
  }

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
