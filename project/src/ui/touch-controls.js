// Touch controls overlay — on-screen buttons + minimal swipe gestures
// for phones / tablets / Pencil-style coarse pointers. Renders into a
// host element (#touch-controls) provided by tetris.html; visibility is
// driven by `body.is-touch` so desktop is unaffected.
//
// Buttons dispatch synthetic KeyboardEvents on `window`, hitting the
// existing keydown/keyup handler in main.js (the one that calls
// tryMove / tryRotate / hardDrop / holdActive) AND the InputRouter that
// online versus listens on. Going through the same surface as a physical
// keyboard means nothing else has to be touch-aware — DAS, 3D remap,
// online sync all keep working unchanged.
//
// Hold-to-repeat (left / right / soft-drop) is implemented by holding
// the synthetic key down until touchend; the in-engine DAS state
// machine then produces the repeats.

function dispatchKey(type, code) {
  // Some KeyboardEvent fields (key, keyCode) aren't read by main.js, but
  // we set `code` because that's what every handler keys off of.
  const ev = new KeyboardEvent(type, { code, bubbles: true, cancelable: true });
  window.dispatchEvent(ev);
}

function bindHoldKey(btn, code, { onTap } = {}) {
  // Single button serves both:
  //   - tap-fire (discrete: rotate / hold / hard drop)
  //   - press-and-hold (continuous: left / right / soft drop)
  // The pipeline doesn't care; main.js's keydown→keyup pairing already
  // distinguishes "tapped once" vs. "held for DAS" so we just mirror
  // pointer press/release as keydown/keyup pairs.
  let pressed = false;

  const press = () => {
    if (pressed) return;
    pressed = true;
    btn.classList.add('is-pressed');
    dispatchKey('keydown', code);
    if (onTap) onTap();
    // Don't preventDefault on pointerdown — iOS Safari needs the gesture
    // to flow so the synthetic events are honored. We do preventDefault
    // on touchstart at the container level to suppress scroll/zoom.
  };
  const release = () => {
    if (!pressed) return;
    pressed = false;
    btn.classList.remove('is-pressed');
    dispatchKey('keyup', code);
  };

  btn.addEventListener('pointerdown', (e) => {
    btn.setPointerCapture?.(e.pointerId);
    press();
  });
  btn.addEventListener('pointerup',     release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('pointerleave',  release);
  // Belt-and-suspenders: blur / window blur clears stuck keys.
  btn.addEventListener('blur', release);
}

/**
 * Build the touch-controls overlay. Idempotent — calling twice on the
 * same root replaces the previous contents.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.root  Host container (#touch-controls)
 * @param {HTMLElement} [opts.canvasEl] Canvas / orbit-target for swipe gestures
 */
export function createTouchControls({ root, canvasEl } = {}) {
  if (!root) return { setVisible() {}, dispose() {} };

  installStyles();

  root.innerHTML = '';
  root.classList.add('tp-touch');

  // ── D-pad cluster (bottom-left) ────────────────────────────────────
  const dpad = document.createElement('div');
  dpad.className = 'tp-touch__cluster tp-touch__cluster--left';
  dpad.innerHTML = `
    <button class="tp-touch__btn tp-touch__btn--up"    data-act="up"    aria-label="Up / depth"></button>
    <button class="tp-touch__btn tp-touch__btn--left"  data-act="left"  aria-label="Move left">‹</button>
    <button class="tp-touch__btn tp-touch__btn--down"  data-act="down"  aria-label="Soft drop">▾</button>
    <button class="tp-touch__btn tp-touch__btn--right" data-act="right" aria-label="Move right">›</button>
  `;
  root.appendChild(dpad);

  // ── Action cluster (bottom-right) ──────────────────────────────────
  const actions = document.createElement('div');
  actions.className = 'tp-touch__cluster tp-touch__cluster--right';
  actions.innerHTML = `
    <button class="tp-touch__btn tp-touch__btn--ccw"  data-act="ccw"  aria-label="Rotate CCW">↺</button>
    <button class="tp-touch__btn tp-touch__btn--cw"   data-act="cw"   aria-label="Rotate CW">↻</button>
    <button class="tp-touch__btn tp-touch__btn--hold" data-act="hold" aria-label="Hold">⇪</button>
    <button class="tp-touch__btn tp-touch__btn--drop" data-act="drop" aria-label="Hard drop">⤓</button>
  `;
  root.appendChild(actions);

  // Wire each button to a key code. ArrowUp in 3D mode reroutes to
  // depth +1 in main.js, so a single `ArrowUp` binding covers both —
  // tetris.html's body[data-mode] tag drives the label swap via CSS.
  const KEY_MAP = {
    left:  'ArrowLeft',
    right: 'ArrowRight',
    down:  'ArrowDown',
    up:    'ArrowUp',
    cw:    'KeyX',
    ccw:   'KeyZ',
    hold:  'KeyC',
    drop:  'Space',
  };
  for (const btn of root.querySelectorAll('[data-act]')) {
    const act = btn.getAttribute('data-act');
    bindHoldKey(btn, KEY_MAP[act]);
  }

  // Suppress browser gestures (scroll, pinch-zoom, double-tap-zoom) on
  // the cluster itself. The canvas swipe handler below opts in
  // explicitly to two specific gestures, so it doesn't need this.
  root.addEventListener('touchstart',  (e) => e.preventDefault(), { passive: false });
  root.addEventListener('touchmove',   (e) => e.preventDefault(), { passive: false });
  root.addEventListener('contextmenu', (e) => e.preventDefault());

  // ── Swipe gestures on canvas ───────────────────────────────────────
  // Two gestures, both two-finger to avoid stealing OrbitControls' single-
  // touch rotate:
  //   - double-tap (two quick taps on canvas) → hard drop
  //   - quick swipe-down with ONE finger from inside the playfield region
  //     → soft-drop pulse (300ms keydown)
  // The single-finger swipe is gated on speed + direction so a normal
  // orbit drag (slow, horizontal) doesn't trigger it.
  if (canvasEl) {
    let touchStart = null;
    let lastTapAt = 0;
    canvasEl.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { touchStart = null; return; }
      const t = e.touches[0];
      touchStart = { x: t.clientX, y: t.clientY, at: performance.now() };
    }, { passive: true });
    canvasEl.addEventListener('touchend', (e) => {
      if (!touchStart) return;
      const dt = performance.now() - touchStart.at;
      const tch = (e.changedTouches && e.changedTouches[0]) || null;
      if (!tch) { touchStart = null; return; }
      const dx = tch.clientX - touchStart.x;
      const dy = tch.clientY - touchStart.y;
      const distSq = dx * dx + dy * dy;

      // Double-tap (two short taps within 280ms) → hard drop.
      if (dt < 220 && distSq < 18 * 18) {
        const now = performance.now();
        if (now - lastTapAt < 280) {
          dispatchKey('keydown', 'Space');
          dispatchKey('keyup',   'Space');
          lastTapAt = 0;
        } else {
          lastTapAt = now;
        }
        touchStart = null;
        return;
      }

      // Fast downward swipe → soft drop burst (~280ms hold).
      if (dt < 300 && dy > 80 && Math.abs(dy) > Math.abs(dx) * 1.6) {
        dispatchKey('keydown', 'ArrowDown');
        setTimeout(() => dispatchKey('keyup', 'ArrowDown'), 280);
      }
      touchStart = null;
    }, { passive: true });
  }

  return {
    setVisible(v) {
      root.style.display = v ? '' : 'none';
    },
    dispose() {
      root.innerHTML = '';
    },
  };
}

let _stylesInstalled = false;
function installStyles() {
  if (_stylesInstalled) return;
  _stylesInstalled = true;
  const css = `
    /* Touch controls — hidden by default; surfaced by body.is-touch. */
    .tp-touch {
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 8;
      display: none;
      /* iOS notch / home-bar inset support. */
      padding: env(safe-area-inset-top) env(safe-area-inset-right)
               env(safe-area-inset-bottom) env(safe-area-inset-left);
    }
    body.is-touch .tp-touch { display: block; }

    .tp-touch__cluster {
      position: absolute;
      bottom: calc(18px + env(safe-area-inset-bottom));
      display: grid;
      gap: 8px;
      pointer-events: auto;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;
    }
    .tp-touch__cluster--left {
      left: 14px;
      grid-template-columns: 56px 56px 56px;
      grid-template-rows: 56px 56px;
      grid-template-areas:
        " .    up   . "
        "left down right";
    }
    .tp-touch__cluster--right {
      right: 14px;
      grid-template-columns: 56px 56px;
      grid-template-rows: 56px 56px;
      grid-template-areas:
        "ccw   cw  "
        "hold  drop";
    }

    .tp-touch__btn {
      width: 100%;
      height: 100%;
      border-radius: 14px;
      background: rgba(10, 14, 24, 0.62);
      border: 1px solid rgba(255, 255, 255, 0.14);
      color: var(--ink, #f3f5fb);
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      font-size: 20px;
      line-height: 1;
      padding: 0;
      backdrop-filter: blur(10px) saturate(140%);
      -webkit-backdrop-filter: blur(10px) saturate(140%);
      transition: background 80ms, border-color 80ms, transform 80ms;
      /* Disable iOS tap highlight / callout. */
      -webkit-tap-highlight-color: transparent;
      -webkit-touch-callout: none;
    }
    .tp-touch__btn.is-pressed {
      background: rgba(108, 240, 255, 0.22);
      border-color: rgba(108, 240, 255, 0.7);
      transform: scale(0.94);
    }
    .tp-touch__btn--left  { grid-area: left; }
    .tp-touch__btn--right { grid-area: right; }
    .tp-touch__btn--down  { grid-area: down; }
    .tp-touch__btn--up    { grid-area: up; }
    .tp-touch__btn--ccw   { grid-area: ccw; }
    .tp-touch__btn--cw    { grid-area: cw;  }
    .tp-touch__btn--hold  { grid-area: hold; font-size: 16px; }
    .tp-touch__btn--drop  { grid-area: drop; font-size: 22px;
      background: rgba(108, 240, 255, 0.16);
      border-color: rgba(108, 240, 255, 0.5);
    }

    /* Up button: hidden by default (2D mode); shown in 3D mode where
       ArrowUp is the depth-back binding. ArrowDown is also reused for
       depth in 3D — the down button stays useful in both modes. */
    .tp-touch__btn--up { display: none; }
    body[data-mode="3d"] .tp-touch__btn--up { display: block; }

    /* Hide hold button in 3D mode (no piece-hold in 3D variants). */
    body[data-mode="3d"] .tp-touch__btn--hold { visibility: hidden; }

    /* Smaller buttons on narrow phones. */
    @media (max-width: 380px) {
      .tp-touch__cluster--left {
        grid-template-columns: 48px 48px 48px;
        grid-template-rows: 48px 48px;
      }
      .tp-touch__cluster--right {
        grid-template-columns: 48px 48px;
        grid-template-rows: 48px 48px;
      }
      .tp-touch__btn { font-size: 18px; border-radius: 12px; }
    }
  `;
  const style = document.createElement('style');
  style.id = 'tp-touch-style';
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * Detect coarse-pointer / touch-only device. Returns true on phones +
 * tablets, false on desktops + laptops (even touchscreen laptops where a
 * mouse is also attached, because they expose a fine pointer too).
 */
export function isTouchDevice() {
  if (typeof window === 'undefined') return false;
  const mq = window.matchMedia && window.matchMedia('(pointer: coarse)');
  if (mq && mq.matches) return true;
  // Fallback for older Android browsers that report (pointer: none).
  return (
    'ontouchstart' in window &&
    (navigator.maxTouchPoints || 0) > 0 &&
    !window.matchMedia('(pointer: fine)').matches
  );
}
