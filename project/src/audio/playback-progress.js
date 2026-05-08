// BGM progress bar — dev/scrubbing tool.
//
// A thin bar at the bottom of the viewport showing current BGM position.
// Click anywhere on the bar to seek. Drag to scrub. Useful during VFX
// tuning so you can jump to drops / verses / breakdowns on demand instead
// of waiting for the song to come around.
//
// Reads/writes the HTMLAudioElement directly — independent of the Web
// Audio graph. Seeking still works while muted.

export function createPlaybackProgress({ bgmEl, position = 'bottom' } = {}) {
  if (!bgmEl) {
    return { update() {}, setVisible() {}, dispose() {} };
  }

  const root = document.createElement('div');
  root.id = 'bgm-progress';
  Object.assign(root.style, {
    position: 'fixed',
    [position]: '0',
    left: '0',
    right: '0',
    height: '34px',
    background: 'rgba(8, 12, 24, 0.78)',
    borderTop: position === 'bottom' ? '1px solid rgba(108, 240, 255, 0.18)' : 'none',
    borderBottom: position === 'top' ? '1px solid rgba(108, 240, 255, 0.18)' : 'none',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '0 14px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '11px',
    color: '#cbd5ff',
    zIndex: '60',
    userSelect: 'none',
    backdropFilter: 'blur(4px)',
  });

  const timeNow = document.createElement('div');
  timeNow.style.cssText = 'width:46px;font-variant-numeric:tabular-nums;opacity:0.85;';
  timeNow.textContent = '0:00';

  // The bar is the click/drag target. Fill + handle are decorative children
  // with pointerEvents: none so events pass through to the bar.
  const bar = document.createElement('div');
  bar.style.cssText = `
    flex: 1;
    height: 8px;
    background: rgba(255,255,255,0.07);
    border-radius: 4px;
    position: relative;
    cursor: pointer;
    touch-action: none;
  `;

  const fill = document.createElement('div');
  fill.style.cssText = `
    position: absolute;
    left: 0; top: 0; bottom: 0;
    background: linear-gradient(90deg, #6cf0ff, #ff9ed0);
    border-radius: 4px;
    width: 0%;
    pointer-events: none;
  `;
  bar.appendChild(fill);

  const handle = document.createElement('div');
  handle.style.cssText = `
    position: absolute;
    top: 50%;
    left: 0%;
    transform: translate(-50%, -50%);
    width: 12px; height: 12px;
    background: #ffffff;
    border-radius: 50%;
    pointer-events: none;
    box-shadow: 0 0 8px rgba(108,240,255,0.7);
    transition: transform 80ms ease-out;
  `;
  bar.appendChild(handle);

  const timeTotal = document.createElement('div');
  timeTotal.style.cssText = 'width:46px;font-variant-numeric:tabular-nums;text-align:right;opacity:0.7;';
  timeTotal.textContent = '--:--';

  root.appendChild(timeNow);
  root.appendChild(bar);
  root.appendChild(timeTotal);
  document.body.appendChild(root);

  function fmt(t) {
    if (!isFinite(t) || t < 0) return '--:--';
    const m = Math.floor(t / 60);
    const s = Math.floor(t % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function seek(clientX) {
    if (!isFinite(bgmEl.duration) || bgmEl.duration <= 0) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    bgmEl.currentTime = ratio * bgmEl.duration;
  }

  let dragging = false;
  bar.addEventListener('pointerdown', (e) => {
    dragging = true;
    bar.setPointerCapture(e.pointerId);
    seek(e.clientX);
    e.preventDefault();
  });
  bar.addEventListener('pointermove', (e) => {
    if (dragging) seek(e.clientX);
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    try { bar.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);

  // Light hover accent — confirms the bar is interactive.
  bar.addEventListener('pointerenter', () => { handle.style.transform = 'translate(-50%, -50%) scale(1.3)'; });
  bar.addEventListener('pointerleave', () => { handle.style.transform = 'translate(-50%, -50%) scale(1)'; });

  return {
    update() {
      const cur = bgmEl.currentTime || 0;
      const dur = bgmEl.duration || 0;
      timeNow.textContent = fmt(cur);
      timeTotal.textContent = fmt(dur);
      if (dur > 0 && !dragging) {
        const pct = (cur / dur) * 100;
        fill.style.width = pct.toFixed(2) + '%';
        handle.style.left = pct.toFixed(2) + '%';
      }
    },
    setVisible(v) { root.style.display = v ? 'flex' : 'none'; },
    dispose() { root.remove(); },
  };
}
