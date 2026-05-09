// Modern-rules callouts — transient text overlays for §12 events
// (plan §13 next-moves item 1).
//
// Subscribes to T_SPIN / B2B_CHAIN / PERFECT_CLEAR / GARBAGE_CANCELLED and
// renders a stack of fading text strips at the top-center of the screen.
// COMBO_START / COMBO_END are intentionally suppressed — combos fire on
// every line clear, so a callout would spam; the existing badge HUDs
// already display the combo count.
//
// Each callout pops in (transform + opacity), holds ~900ms, fades out
// over ~500ms — total ~1.4s lifetime. Multiple concurrent callouts stack
// vertically, oldest at the bottom (highest), newest at the top (closest
// to the playfield).
//
// Pure DOM. Zero THREE / audio dependencies. The text-formatter is
// extracted as a pure function (`formatCallout`) for testability —
// rendering is left untested as a deliberate match with the existing
// `marathon-badge.js` / `versus-badge.js` precedent.

import { installPanelStyles } from './panel-shared.js';

let _stylesInstalled = false;

function installCalloutStyles() {
  if (_stylesInstalled) return;
  _stylesInstalled = true;
  const css = `
    .tp-modern-callouts {
      position: fixed;
      top: 96px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 60;
      display: flex;
      flex-direction: column-reverse;
      align-items: center;
      gap: 6px;
      pointer-events: none;
      user-select: none;
    }
    .tp-modern-callouts__item {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-weight: 700;
      font-size: 22px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      padding: 8px 18px;
      border-radius: 8px;
      background: rgba(10, 14, 24, 0.72);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: var(--ink, #f3f5fb);
      backdrop-filter: blur(10px) saturate(140%);
      -webkit-backdrop-filter: blur(10px) saturate(140%);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
      opacity: 0;
      transform: translateY(-8px) scale(0.96);
      transition: opacity 220ms ease-out, transform 220ms ease-out;
      white-space: nowrap;
    }
    .tp-modern-callouts__item.is-visible {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
    .tp-modern-callouts__item.is-fading {
      opacity: 0;
      transform: translateY(-4px) scale(0.98);
      transition: opacity 460ms ease-in, transform 460ms ease-in;
    }
    /* Per-kind accent colors — match the in-game piece palette where
       it makes sense (T = violet for T-spins) and use distinct hues
       for the rest (cyan = chain energy, gold = rarity, silver = defense). */
    .tp-modern-callouts__item--tspin {
      color: #d3a8ff;
      border-color: rgba(184, 76, 255, 0.55);
      box-shadow: 0 0 24px rgba(184, 76, 255, 0.35),
                  0 6px 24px rgba(0, 0, 0, 0.45);
    }
    .tp-modern-callouts__item--mini {
      color: #b395d8;
      border-color: rgba(184, 76, 255, 0.30);
      font-size: 18px;
    }
    .tp-modern-callouts__item--b2b {
      color: #6cf0ff;
      border-color: rgba(108, 240, 255, 0.55);
      box-shadow: 0 0 24px rgba(108, 240, 255, 0.32),
                  0 6px 24px rgba(0, 0, 0, 0.45);
    }
    .tp-modern-callouts__item--pc {
      color: #ffd400;
      border-color: rgba(255, 212, 0, 0.65);
      font-size: 28px;
      letter-spacing: 0.20em;
      box-shadow: 0 0 36px rgba(255, 212, 0, 0.45),
                  0 6px 24px rgba(0, 0, 0, 0.45);
    }
    .tp-modern-callouts__item--cancelled {
      color: #b9c4d6;
      border-color: rgba(185, 196, 214, 0.45);
      font-size: 16px;
    }
  `;
  const style = document.createElement('style');
  style.id = 'tp-modern-callouts-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

// ─── Pure formatter ────────────────────────────────────────────────────

/**
 * Translate a §12 event payload into a callout description, or null
 * to suppress. Pure function — rendering is the caller's job.
 *
 * @param {string} topic   The event topic ('T_SPIN' / 'B2B_CHAIN' / etc.).
 * @param {Object} payload The event payload.
 * @returns {null | { text: string, kind: string }}
 */
export function formatCallout(topic, payload) {
  if (!payload || typeof payload !== 'object') return null;

  if (topic === 'T_SPIN') {
    const isMini = payload.kind === 'mini';
    const cleared = payload.cleared | 0;
    const prefix = isMini ? 'T-SPIN MINI' : 'T-SPIN';
    const suffix = ['', ' SINGLE', ' DOUBLE', ' TRIPLE'][cleared] || '';
    return { text: prefix + suffix, kind: isMini ? 'mini' : 'tspin' };
  }

  if (topic === 'B2B_CHAIN') {
    const count = payload.count | 0;
    // Only celebrate continuations (count >= 2). The first difficult
    // clear of a chain (count === 1) gets no callout — it's not a chain
    // yet, just a Tetris or T-spin which is already announced.
    if (count < 2) return null;
    return { text: `BACK-TO-BACK ×${count}`, kind: 'b2b' };
  }

  if (topic === 'PERFECT_CLEAR') {
    const cleared = payload.cleared | 0;
    const suffix  = ['', ' · SINGLE', ' · DOUBLE', ' · TRIPLE', ' · TETRIS'][cleared] || '';
    return { text: `PERFECT CLEAR${suffix}`, kind: 'pc' };
  }

  if (topic === 'GARBAGE_CANCELLED') {
    const rows = payload.rows | 0;
    if (rows <= 0) return null;
    return { text: `CANCELLED ×${rows}`, kind: 'cancelled' };
  }

  return null;
}

// Suppression list — events we DON'T translate into callouts. Exposed
// so tests can verify the suppression intent (rather than just "no
// match returns null").
export const _SUPPRESSED_TOPICS = Object.freeze(['COMBO_START', 'COMBO_END', 'B2B_BREAK']);

// ─── DOM subscriber ─────────────────────────────────────────────────────

/**
 * @typedef {Object} ModernCalloutsOpts
 * @property {{ on:(topic:string,fn:Function,opts?:any)=>Function }} bus
 *   Engine event bus.
 * @property {{ T_SPIN:string, B2B_CHAIN:string, PERFECT_CLEAR:string,
 *              GARBAGE_CANCELLED:string }} events
 *   Topic constants — pulled from `gameplay/events.js#EVENTS`.
 * @property {HTMLElement} [container]
 *   Optional mount point. Defaults to `document.body`.
 * @property {number} [holdMs]   Default 900. Time the callout sits at full
 *   opacity before fading.
 * @property {number} [fadeMs]   Default 460. Fade-out duration.
 * @property {string} [side]     Optional — when provided, only events with
 *   matching `payload.side` produce callouts. Used by dual-board layouts
 *   to route the player's callouts to the player's side and the
 *   opponent's elsewhere (or nowhere).
 */

/**
 * Mount the modern-rules callouts on `container` (default body), wire
 * up subscriptions, and return a controller with `dispose()`.
 *
 * @param {ModernCalloutsOpts} opts
 * @returns {{ root: HTMLElement, dispose: () => void }}
 */
export function createModernCallouts(opts) {
  const {
    bus,
    events,
    container = (typeof document !== 'undefined' ? document.body : null),
    holdMs = 900,
    fadeMs = 460,
    side = null,
  } = opts || {};
  if (!bus || !events) {
    throw new Error('createModernCallouts requires { bus, events }');
  }
  if (!container || typeof document === 'undefined') {
    throw new Error('createModernCallouts requires a DOM environment');
  }

  installPanelStyles();
  installCalloutStyles();

  const root = document.createElement('div');
  root.className = 'tp-modern-callouts';
  container.appendChild(root);

  const offs = [];
  const liveTimers = new Set();

  function emitCallout(topic, payload) {
    if (side != null && payload && payload.side != null && payload.side !== side) return;
    const desc = formatCallout(topic, payload);
    if (!desc) return;

    const el = document.createElement('div');
    el.className = `tp-modern-callouts__item tp-modern-callouts__item--${desc.kind}`;
    el.textContent = desc.text;
    root.appendChild(el);

    // Trigger the entry transition on next frame (CSS needs the
    // element committed before the class change can animate).
    const showTimer = setTimeout(() => {
      el.classList.add('is-visible');
      liveTimers.delete(showTimer);
    }, 0);
    liveTimers.add(showTimer);

    // After holdMs at full opacity, start the fade.
    const fadeTimer = setTimeout(() => {
      el.classList.add('is-fading');
      liveTimers.delete(fadeTimer);
      // After the fade completes, remove the element. Add a small
      // safety buffer above `fadeMs` so we don't blink at end-of-animation.
      const removeTimer = setTimeout(() => {
        if (el.parentNode === root) root.removeChild(el);
        liveTimers.delete(removeTimer);
      }, fadeMs + 50);
      liveTimers.add(removeTimer);
    }, holdMs);
    liveTimers.add(fadeTimer);
  }

  // Subscriptions. Topics are looked up by string so the `events` arg
  // can be a subset of the full taxonomy (e.g. tests inject only the
  // four topics they care about).
  for (const topic of ['T_SPIN', 'B2B_CHAIN', 'PERFECT_CLEAR', 'GARBAGE_CANCELLED']) {
    const eventName = events[topic];
    if (!eventName) continue;
    offs.push(bus.on(eventName, (payload) => emitCallout(topic, payload)));
  }

  function dispose() {
    for (const off of offs) {
      try { off(); } catch { /* ignore */ }
    }
    offs.length = 0;
    for (const t of liveTimers) clearTimeout(t);
    liveTimers.clear();
    if (root.parentNode === container) container.removeChild(root);
  }

  return { root, dispose };
}
