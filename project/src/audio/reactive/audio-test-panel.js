// Audio test panel — toggle with B. A comprehensive read-out of every
// audio-analysis signal in the engine, plus a minimal visualization
// demo that shows what each signal "looks like" when driving simple
// primitives. Built for development / effect tuning, not for players.
//
// Surfaces shown:
//   - FeatureBus: 6 bands × 5 per-band signals (value, env, norm, flux,
//     kick) as a mini-bar matrix. Onsets (kick / snare / generic) as
//     flash indicators with last-fire age.
//   - Live beat tracker: BPM, source (worklet / bootstrap / none),
//     anticipation + phase bars, history count, lock state.
//   - Meyda: chroma 12-vector, dominant pitch-class letter, hue/
//     confidence, spectral centroid, RMS, perceptual sharpness.
//   - Viz demo (small canvas): primitives driven by the above signals —
//     a circle pulsed by bass.kick, a hue-tinted square (chroma + RMS),
//     anticipation fill bar, 12 chroma lights, onset spawn flashes.
//
// Layout: docked top-left (the F-key spectrum overlay holds top-right),
// vertically scrollable, ~340 px wide. Uses the shared panel chrome so
// it reads as part of the dev panel family even though it's bigger
// than the other surfaces.

import { installPanelStyles, makePanelHeader } from '../../ui/panel-shared.js';

const BAND_NAMES   = ['sub', 'bass', 'lowMid', 'mid', 'highMid', 'air'];
const SIGNAL_NAMES = ['value', 'env', 'norm', 'flux', 'kick'];

// Each per-band signal gets a tint so the columns are distinguishable
// at a glance. `kick` (transient impulse) is hot pink to match the
// onset / kick visual language used elsewhere; `norm` (loudness) is
// white-ish; flux is orange (rising edge feel).
const SIGNAL_COLORS = {
  value: 'rgba(108,240,255,0.85)',  // cyan
  env:   'rgba(140,180,255,0.85)',  // soft blue
  norm:  'rgba(255,255,255,0.90)',  // white
  flux:  'rgba(255,170,90,0.90)',   // orange
  kick:  'rgba(255,92,138,0.95)',   // pink
};

const ONSET_NAMES = ['kick', 'snare', 'generic'];
const ONSET_COLORS = {
  kick:    { r: 255, g:  92, b: 138 },
  snare:   { r: 255, g: 209, b: 102 },
  generic: { r: 108, g: 240, b: 255 },
};
const ONSET_FLASH_SEC = 0.25;

const PITCH_LETTERS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const VIZ_W = 312;
const VIZ_H = 110;

export function createAudioTestPanel({
  feature,
  liveBeat = null,
  meydaFeatures = null,
  hotkey = 'KeyB',
  visibleByDefault = false,
} = {}) {
  installPanelStyles();

  const root = document.createElement('div');
  root.id = 'audio-test-panel';
  root.className = 'tp-panel';
  root.style.top    = '64px';
  root.style.left   = '16px';
  root.style.width  = '340px';
  root.style.maxHeight = 'calc(100vh - 80px)';
  root.style.overflowY = 'auto';
  // Dev panel — scroll/click on it should work, so pointer-events
  // stays default (auto). This does block clicks on the playfield
  // behind it, but B-toggle hides it when not needed.
  root.style.zIndex = '55';

  let visible = visibleByDefault;
  const setVisibleInternal = (v) => {
    visible = !!v;
    root.style.display = visible ? 'block' : 'none';
  };

  const header = makePanelHeader({
    title: 'Audio test panel',
    hotkey: hotkey.replace('Key', '').toUpperCase(),
    onClose: () => setVisibleInternal(false),
  });
  root.appendChild(header);

  const body = document.createElement('div');
  body.className = 'tp-panel__body';
  root.appendChild(body);

  // ===== Helpers ========================================================
  const sectionLabel = (text) => {
    const el = document.createElement('div');
    el.className = 'tp-panel__section-label';
    el.textContent = text;
    el.style.cssText += 'margin-top:8px;';
    return el;
  };
  // Make a `label · value [optional sibling: bar / swatch]` row. The text
  // node is its own span so subsequent textContent assignments don't
  // wipe out adjacent decoration like the hue swatch.
  const valueLine = (label) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;'
      + 'font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;font-size:10px;'
      + 'letter-spacing:0.04em;line-height:1.45;color:var(--muted,#8b93ad);';
    const l = document.createElement('span');
    l.textContent = label;
    l.style.cssText = 'min-width:64px;';
    const v = document.createElement('span');
    v.style.cssText = 'color:var(--ink,#f3f5fb);display:inline-flex;align-items:center;gap:6px;'
      + 'min-width:46px;';
    const text = document.createElement('span');
    text.textContent = '—';
    v.appendChild(text);
    row.appendChild(l); row.appendChild(v);
    return { row, value: v, text };
  };
  const mkBar = (color) => {
    const track = document.createElement('div');
    track.style.cssText = 'position:relative;height:6px;border-radius:3px;'
      + 'background:rgba(255,255,255,0.06);overflow:hidden;';
    const fill = document.createElement('div');
    fill.style.cssText = 'position:absolute;left:0;top:0;bottom:0;width:0%;'
      + `background:${color || 'rgba(108,240,255,0.7)'};border-radius:3px;`
      + 'transition:width 50ms linear;';
    track.appendChild(fill);
    return { track, fill };
  };

  // ===== Section 1 — FeatureBus matrix ==================================
  body.appendChild(sectionLabel('FeatureBus bands'));

  // Header row showing the 5 signal columns.
  const matrixHeader = document.createElement('div');
  matrixHeader.style.cssText = 'display:grid;grid-template-columns:48px repeat(5, 1fr);'
    + 'gap:4px;font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;'
    + 'font-size:9px;letter-spacing:0.1em;color:var(--muted,#8b93ad);'
    + 'text-transform:uppercase;margin-bottom:4px;';
  const cornerEl = document.createElement('span');
  matrixHeader.appendChild(cornerEl);
  for (const sig of SIGNAL_NAMES) {
    const cell = document.createElement('span');
    cell.textContent = sig;
    cell.style.color = SIGNAL_COLORS[sig];
    cell.style.textAlign = 'center';
    matrixHeader.appendChild(cell);
  }
  body.appendChild(matrixHeader);

  // The matrix itself — one row per band, 5 mini-bars across.
  const bandFills = {};
  for (const band of BAND_NAMES) {
    const row = document.createElement('div');
    row.style.cssText = 'display:grid;grid-template-columns:48px repeat(5, 1fr);'
      + 'gap:4px;align-items:center;margin-bottom:2px;';
    const name = document.createElement('span');
    name.textContent = band;
    name.style.cssText = 'font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;'
      + 'font-size:9.5px;color:var(--ink,#f3f5fb);';
    row.appendChild(name);
    bandFills[band] = {};
    for (const sig of SIGNAL_NAMES) {
      const bar = mkBar(SIGNAL_COLORS[sig]);
      bandFills[band][sig] = bar.fill;
      row.appendChild(bar.track);
    }
    body.appendChild(row);
  }

  // ===== Section 2 — Onsets =============================================
  body.appendChild(sectionLabel('Onsets'));
  const onsetRows = {};
  for (const name of ONSET_NAMES) {
    const col = ONSET_COLORS[name];
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;'
      + 'font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;'
      + 'font-size:10px;color:var(--muted,#8b93ad);margin-bottom:3px;';
    const dot = document.createElement('span');
    dot.style.cssText = `width:10px;height:10px;border-radius:5px;`
      + `background:rgba(${col.r},${col.g},${col.b},0.18);`
      + `box-shadow:0 0 0 1px rgba(${col.r},${col.g},${col.b},0.45);`
      + 'flex:none;transition:background 80ms ease, box-shadow 80ms ease;';
    const label = document.createElement('span');
    label.textContent = name;
    label.style.flex = '1';
    label.style.color = `rgb(${col.r},${col.g},${col.b})`;
    const age = document.createElement('span');
    age.textContent = '— ms';
    age.style.color = 'var(--muted,#8b93ad)';
    const strength = document.createElement('span');
    strength.textContent = 's=—';
    strength.style.cssText = 'opacity:0.55;min-width:34px;text-align:right;';
    row.appendChild(dot); row.appendChild(label);
    row.appendChild(strength); row.appendChild(age);
    body.appendChild(row);
    onsetRows[name] = { dot, age, strength };
  }

  // ===== Section 3 — Live beat tracker ==================================
  body.appendChild(sectionLabel('Live beat tracker'));

  const bpmBig = document.createElement('div');
  bpmBig.style.cssText = 'font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;'
    + 'font-size:22px;font-weight:600;letter-spacing:0.02em;color:var(--ink,#f3f5fb);'
    + 'line-height:1.1;display:flex;align-items:baseline;gap:8px;margin-bottom:4px;';
  const bpmNumber = document.createElement('span');
  bpmNumber.textContent = '—';
  const bpmUnit = document.createElement('span');
  bpmUnit.textContent = 'BPM';
  bpmUnit.style.cssText = 'font-size:10px;color:var(--muted,#8b93ad);letter-spacing:0.12em;';
  const bpmSourceTag = document.createElement('span');
  bpmSourceTag.style.cssText = 'margin-left:auto;font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;'
    + 'font-size:9px;letter-spacing:0.1em;padding:2px 6px;border-radius:3px;'
    + 'background:rgba(255,255,255,0.06);color:var(--muted,#8b93ad);text-transform:uppercase;';
  bpmSourceTag.textContent = 'none';
  bpmBig.appendChild(bpmNumber); bpmBig.appendChild(bpmUnit); bpmBig.appendChild(bpmSourceTag);
  body.appendChild(bpmBig);

  const statusBadges = document.createElement('div');
  statusBadges.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;';
  const mkBadge = (txt) => {
    const b = document.createElement('span');
    b.textContent = txt;
    b.style.cssText = 'font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;'
      + 'font-size:9px;letter-spacing:0.08em;padding:2px 6px;border-radius:3px;'
      + 'background:rgba(255,255,255,0.04);color:var(--muted,#8b93ad);'
      + 'border:1px solid rgba(255,255,255,0.06);';
    return b;
  };
  const lbBadges = {
    analyzed: mkBadge('analyzed'),
    analyzing: mkBadge('analyzing'),
    stable: mkBadge('stable'),
    pending: mkBadge('worklet setup'),
    error: mkBadge('error'),
  };
  for (const b of Object.values(lbBadges)) statusBadges.appendChild(b);
  body.appendChild(statusBadges);

  const anticLine = valueLine('antic');
  const anticBar = mkBar('linear-gradient(90deg,#a0e6ff,#ff5c8a)');
  anticLine.row.appendChild(anticBar.track);
  anticBar.track.style.flex = '1';
  body.appendChild(anticLine.row);

  const phaseLine = valueLine('phase');
  const phaseBar = mkBar('rgba(108,240,255,0.55)');
  phaseLine.row.appendChild(phaseBar.track);
  phaseBar.track.style.flex = '1';
  body.appendChild(phaseLine.row);

  const historyLine = valueLine('history');
  // Let the value text expand — history shows "N kicks · last @ X.XXs"
  historyLine.value.style.minWidth = '0';
  historyLine.value.style.flex = '1';
  historyLine.value.style.justifyContent = 'flex-end';
  body.appendChild(historyLine.row);

  // ===== Section 4 — Meyda =============================================
  body.appendChild(sectionLabel('Meyda'));

  // Chroma 12-bar histogram. Each pitch class gets its own thin
  // vertical bar; the dominant class is also called out as a letter
  // tag below.
  const chromaCanvas = document.createElement('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const CHROMA_W = 312, CHROMA_H = 36;
  chromaCanvas.width  = CHROMA_W * dpr;
  chromaCanvas.height = CHROMA_H * dpr;
  chromaCanvas.style.width  = `${CHROMA_W}px`;
  chromaCanvas.style.height = `${CHROMA_H}px`;
  chromaCanvas.style.display = 'block';
  chromaCanvas.style.borderRadius = '4px';
  chromaCanvas.style.background = 'rgba(255,255,255,0.03)';
  chromaCanvas.style.marginBottom = '4px';
  body.appendChild(chromaCanvas);
  const chromaCtx = chromaCanvas.getContext('2d');
  chromaCtx.scale(dpr, dpr);

  // Pitch-class letter row — twelve labels, the dominant one is
  // highlighted in the chroma's hue colour.
  const pitchRow = document.createElement('div');
  pitchRow.style.cssText = 'display:grid;grid-template-columns:repeat(12,1fr);gap:2px;'
    + 'font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;font-size:9px;'
    + 'text-align:center;color:var(--muted,#8b93ad);margin-bottom:6px;';
  const pitchEls = [];
  for (let i = 0; i < 12; i++) {
    const span = document.createElement('span');
    span.textContent = PITCH_LETTERS[i];
    span.style.padding = '1px 0';
    span.style.borderRadius = '2px';
    pitchRow.appendChild(span);
    pitchEls.push(span);
  }
  body.appendChild(pitchRow);

  const hueLine = valueLine('hue°');
  const hueSwatch = document.createElement('span');
  hueSwatch.style.cssText = 'display:inline-block;width:14px;height:14px;border-radius:3px;'
    + 'background:hsl(0,70%,50%);border:1px solid rgba(255,255,255,0.15);flex:none;';
  hueLine.value.appendChild(hueSwatch);
  body.appendChild(hueLine.row);

  const confLine = valueLine('chroma conf');
  const confBar = mkBar('rgba(255,255,255,0.7)');
  confLine.row.appendChild(confBar.track);
  confBar.track.style.flex = '1';
  body.appendChild(confLine.row);

  const centroidLine = valueLine('centroid');
  centroidLine.value.style.minWidth = '0';
  centroidLine.value.style.flex = '1';
  centroidLine.value.style.justifyContent = 'flex-end';
  body.appendChild(centroidLine.row);

  const rmsLine = valueLine('RMS');
  const rmsBar = mkBar('rgba(255,170,90,0.8)');
  rmsLine.row.appendChild(rmsBar.track);
  rmsBar.track.style.flex = '1';
  body.appendChild(rmsLine.row);

  const sharpLine = valueLine('sharpness');
  const sharpBar = mkBar('rgba(255,209,102,0.8)');
  sharpLine.row.appendChild(sharpBar.track);
  sharpBar.track.style.flex = '1';
  body.appendChild(sharpLine.row);

  const meydaStateLine = valueLine('meyda state');
  meydaStateLine.value.style.minWidth = '0';
  meydaStateLine.value.style.flex = '1';
  meydaStateLine.value.style.justifyContent = 'flex-end';
  body.appendChild(meydaStateLine.row);

  // ===== Section 5 — Viz demo (canvas) =================================
  body.appendChild(sectionLabel('Viz demo'));

  const vizLegend = document.createElement('div');
  vizLegend.style.cssText = 'font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;'
    + 'font-size:9px;letter-spacing:0.04em;color:var(--muted,#8b93ad);line-height:1.4;'
    + 'margin-bottom:4px;';
  vizLegend.innerHTML = ''
    + 'circle ← bass.kick · box ← chroma+RMS · bar ← antic · lights ← chroma[] · dots ← onsets';
  body.appendChild(vizLegend);

  const vizCanvas = document.createElement('canvas');
  vizCanvas.width  = VIZ_W * dpr;
  vizCanvas.height = VIZ_H * dpr;
  vizCanvas.style.width  = `${VIZ_W}px`;
  vizCanvas.style.height = `${VIZ_H}px`;
  vizCanvas.style.display = 'block';
  vizCanvas.style.borderRadius = '4px';
  vizCanvas.style.background = 'rgba(0,0,0,0.35)';
  body.appendChild(vizCanvas);
  const vizCtx = vizCanvas.getContext('2d');
  vizCtx.scale(dpr, dpr);

  // Per-channel "spawn flash" decay state for the viz canvas onset dots.
  // Independent of the top section's flash state so the demo reads cleanly
  // even if the user is also looking at the indicators.
  const onsetFlashState = { kick: 0, snare: 0, generic: 0 };
  let lastOnsetSeenAt = { kick: -1, snare: -1, generic: -1 };

  // ===== Mount + hotkey ================================================
  document.body.appendChild(root);
  if (!visible) root.style.display = 'none';

  window.addEventListener('keydown', (e) => {
    if (e.code !== hotkey) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
    setVisibleInternal(!visible);
  });

  // ===== Per-frame update ==============================================
  function setFillPct(fill, pct) {
    const p = pct < 0 ? 0 : (pct > 1 ? 1 : pct);
    fill.style.width = (p * 100).toFixed(1) + '%';
  }
  function setBadgeState(el, active, activeBg, activeColor) {
    if (active) {
      el.style.background = activeBg || 'rgba(108,240,255,0.18)';
      el.style.color = activeColor || '#a0e6ff';
      el.style.borderColor = activeBg || 'rgba(108,240,255,0.35)';
      el.style.opacity = '1';
    } else {
      el.style.background = 'rgba(255,255,255,0.04)';
      el.style.color = 'var(--muted,#8b93ad)';
      el.style.borderColor = 'rgba(255,255,255,0.06)';
      el.style.opacity = '0.55';
    }
  }

  function drawChromaHistogram(chroma) {
    chromaCtx.clearRect(0, 0, CHROMA_W, CHROMA_H);
    if (!chroma || chroma.length < 12) return;
    const colW = CHROMA_W / 12;
    let maxV = 0;
    for (let i = 0; i < 12; i++) if (chroma[i] > maxV) maxV = chroma[i];
    const denom = maxV > 0 ? maxV : 1;
    for (let i = 0; i < 12; i++) {
      const v = chroma[i] / denom;
      const x = i * colW;
      const h = Math.max(2, v * (CHROMA_H - 4));
      // Hue per bin so the histogram reads as the chroma → hue mapping
      // we use for the spiral tint. C = red, ascending by 30°.
      const hueDeg = (i / 12) * 360;
      chromaCtx.fillStyle = `hsla(${hueDeg.toFixed(0)}, 70%, 55%, ${0.35 + 0.55 * v})`;
      chromaCtx.fillRect(x + 1, CHROMA_H - 2 - h, colW - 2, h);
    }
  }

  function drawViz(state) {
    const ctx = vizCtx;
    ctx.clearRect(0, 0, VIZ_W, VIZ_H);

    // Left: pulsing circle driven by bass.kick (the same signal the
    // selective-bloom max-merge binding watches).
    const cx = 36, cy = VIZ_H / 2;
    const baseR = 12;
    const kick = state.bassKick;
    const r = baseR + kick * 16;
    ctx.beginPath();
    ctx.fillStyle = `rgba(255,92,138,${0.18 + 0.55 * kick})`;
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,92,138,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
    ctx.stroke();

    // Middle: hue-tinted square (chroma circular-mean hue, size from
    // RMS). The "songs in different keys look different" prototype.
    const boxCx = 96;
    const boxBaseSize = 22;
    const boxSize = boxBaseSize + state.rms * 60;
    const hue = state.chromaHueDeg | 0;
    ctx.fillStyle = `hsla(${hue}, 75%, 55%, ${0.55 + 0.4 * state.chromaConfidence})`;
    ctx.fillRect(boxCx - boxSize / 2, cy - boxSize / 2, boxSize, boxSize);
    ctx.strokeStyle = `hsla(${hue}, 75%, 75%, 0.7)`;
    ctx.strokeRect(boxCx - boxSize / 2, cy - boxSize / 2, boxSize, boxSize);

    // Right: 12-light row mirroring the chroma vector — same data as
    // the histogram above but at viz scale + colored consistently.
    const lightsX = 142;
    const lightsW = 76;
    const lightW = lightsW / 12;
    if (state.chroma && state.chroma.length >= 12) {
      let maxV = 0;
      for (let i = 0; i < 12; i++) if (state.chroma[i] > maxV) maxV = state.chroma[i];
      const denom = maxV > 0 ? maxV : 1;
      for (let i = 0; i < 12; i++) {
        const a = state.chroma[i] / denom;
        const hueDeg = (i / 12) * 360;
        ctx.fillStyle = `hsla(${hueDeg}, 70%, 55%, ${0.12 + 0.75 * a})`;
        ctx.fillRect(lightsX + i * lightW + 0.5, cy - 4, lightW - 1, 8);
      }
    }

    // Far right: onset spawn flashes. Each fired onset blooms a circle
    // that fades over ONSET_FLASH_SEC, demonstrating the "kick fires →
    // spawn a particle burst" pattern (M-6 in the plan).
    const flashX = 248;
    let flashY = cy - 22;
    for (const name of ONSET_NAMES) {
      const col = ONSET_COLORS[name];
      const phase = onsetFlashState[name];
      const r2 = 5 + phase * 12;
      ctx.fillStyle = `rgba(${col.r},${col.g},${col.b},${0.15 + phase * 0.75})`;
      ctx.beginPath();
      ctx.arc(flashX, flashY, r2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(${col.r},${col.g},${col.b},${0.5 + phase * 0.4})`;
      ctx.font = '8px "SF Mono", ui-monospace, monospace';
      ctx.textBaseline = 'middle';
      ctx.fillText(name[0].toUpperCase(), flashX + 12, flashY);
      flashY += 22;
    }

    // Bottom: anticipation fill bar across the canvas width — the
    // pre-beat lean-in that the spiral / bloom bindings ride.
    const ax = 6, ay = VIZ_H - 8, aw = VIZ_W - 12, ah = 4;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(ax, ay, aw, ah);
    const ag = ctx.createLinearGradient(ax, 0, ax + aw, 0);
    ag.addColorStop(0, 'rgba(160,230,255,0.85)');
    ag.addColorStop(1, 'rgba(255,92,138,0.95)');
    ctx.fillStyle = ag;
    ctx.fillRect(ax, ay, aw * state.anticipation, ah);
  }

  function update() {
    if (!visible) return;
    const now = (feature && typeof feature.totalSec === 'number') ? feature.totalSec : 0;
    const snap = feature.snapshot ? feature.snapshot() : null;

    // --- FeatureBus matrix -----------------------------------------
    if (snap) {
      for (const band of BAND_NAMES) {
        const cells = bandFills[band];
        const data = snap[band];
        if (!data) continue;
        for (const sig of SIGNAL_NAMES) {
          setFillPct(cells[sig], data[sig] || 0);
        }
      }
    }

    // --- Onsets -----------------------------------------------------
    for (const name of ONSET_NAMES) {
      const row = onsetRows[name];
      const col = ONSET_COLORS[name];
      const tele = (feature.onsets && feature.onsets.telemetry)
        ? feature.onsets.telemetry(name)
        : null;
      const last = tele ? tele.lastFireAtSec : -Infinity;
      const elapsed = Number.isFinite(last) ? Math.max(0, now - last) : Infinity;
      // Top-section flash logic.
      const flash = Math.max(0, 1 - elapsed / ONSET_FLASH_SEC);
      row.dot.style.background = `rgba(${col.r},${col.g},${col.b},${0.18 + 0.75 * flash})`;
      row.dot.style.boxShadow = flash > 0.05
        ? `0 0 8px rgba(${col.r},${col.g},${col.b},${0.6 * flash}), 0 0 0 1px rgba(${col.r},${col.g},${col.b},0.9)`
        : `0 0 0 1px rgba(${col.r},${col.g},${col.b},0.45)`;
      if (Number.isFinite(elapsed) && elapsed < 10) {
        row.age.textContent = (elapsed * 1000).toFixed(0).padStart(4, ' ') + ' ms';
      } else {
        row.age.textContent = '   — ms';
      }
      row.strength.textContent = tele ? `s=${(tele.lastStrength || 0).toFixed(2)}` : 's=—';
      // Viz canvas flash state — detect each new fire by comparing the
      // last-fire-time we've seen against the telemetry's current one.
      if (tele && Number.isFinite(last) && last > lastOnsetSeenAt[name]) {
        onsetFlashState[name] = 1;
        lastOnsetSeenAt[name] = last;
      } else {
        // Linear decay; ONSET_FLASH_SEC sec to fully fade.
        onsetFlashState[name] = Math.max(0, 1 - elapsed / ONSET_FLASH_SEC);
      }
    }

    // --- Live beat tracker -----------------------------------------
    let antic = 0, phase = 0;
    if (liveBeat) {
      const bpm = liveBeat.bpm || 0;
      bpmNumber.textContent = bpm > 0 ? bpm.toFixed(1) : '—';
      const src = liveBeat.bpmSource || 'none';
      bpmSourceTag.textContent = src;
      // Tint the source badge: worklet=cyan (high confidence), bootstrap=amber,
      // none=muted. Reads at a glance "which path is currently driving".
      if (src === 'worklet') {
        bpmSourceTag.style.background = 'rgba(108,240,255,0.18)';
        bpmSourceTag.style.color = '#a0e6ff';
      } else if (src === 'bootstrap') {
        bpmSourceTag.style.background = 'rgba(255,170,90,0.18)';
        bpmSourceTag.style.color = '#ffd166';
      } else {
        bpmSourceTag.style.background = 'rgba(255,255,255,0.06)';
        bpmSourceTag.style.color = 'var(--muted,#8b93ad)';
      }

      setBadgeState(lbBadges.analyzed,  !!liveBeat.isAnalyzed);
      setBadgeState(lbBadges.analyzing, !!liveBeat.isAnalyzing, 'rgba(255,170,90,0.18)', '#ffd166');
      setBadgeState(lbBadges.stable,    !!liveBeat.isStable);
      setBadgeState(lbBadges.pending,   !!liveBeat.isPendingSetup);
      setBadgeState(lbBadges.error,     !!liveBeat.analyzeError, 'rgba(255,92,138,0.18)', '#ff5c8a');

      antic = liveBeat.anticipation || 0;
      phase = liveBeat.phase || 0;
      anticLine.text.textContent = antic.toFixed(2);
      phaseLine.text.textContent = phase.toFixed(2);
      setFillPct(anticBar.fill, antic);
      setFillPct(phaseBar.fill, phase);
      historyLine.text.textContent = `${liveBeat.historyCount || 0} kicks · last @ ${(liveBeat.offsetSec || 0).toFixed(2)}s`;
    }

    // --- Meyda ------------------------------------------------------
    let bassKick = (snap && snap.bass) ? (snap.bass.kick || 0) : 0;
    let chromaVec = null, chromaHueDeg = 0, chromaConf = 0, rmsVal = 0;
    if (meydaFeatures) {
      chromaVec = meydaFeatures.chroma;
      chromaHueDeg = meydaFeatures.chromaHueDeg || 0;
      chromaConf = meydaFeatures.chromaConfidence || 0;
      rmsVal = meydaFeatures.rms || 0;
      drawChromaHistogram(chromaVec);
      const dom = meydaFeatures.dominantPitchClass | 0;
      for (let i = 0; i < 12; i++) {
        if (i === dom && chromaConf > 0.05) {
          pitchEls[i].style.color = `hsl(${(i / 12) * 360}, 70%, 70%)`;
          pitchEls[i].style.background = `hsla(${(i / 12) * 360}, 70%, 50%, 0.18)`;
        } else {
          pitchEls[i].style.color = 'var(--muted,#8b93ad)';
          pitchEls[i].style.background = 'transparent';
        }
      }
      hueLine.text.textContent = chromaHueDeg.toFixed(0) + '°';
      hueSwatch.style.background = `hsl(${chromaHueDeg.toFixed(0)},70%,55%)`;
      confLine.text.textContent = chromaConf.toFixed(2);
      setFillPct(confBar.fill, chromaConf);
      centroidLine.text.textContent = `${(meydaFeatures.spectralCentroid || 0).toFixed(0)} Hz (${(meydaFeatures.spectralCentroidNorm * 100).toFixed(0)}%)`;
      rmsLine.text.textContent = rmsVal.toFixed(3);
      // RMS is usually <0.25 in practice — amplify the bar so the dynamic
      // range reads visibly. The number above stays raw.
      setFillPct(rmsBar.fill, Math.min(1, rmsVal * 4));
      sharpLine.text.textContent = (meydaFeatures.perceptualSharpness || 0).toFixed(2);
      setFillPct(sharpBar.fill, Math.min(1, (meydaFeatures.perceptualSharpness || 0)));
      meydaStateLine.text.textContent = meydaFeatures.isReady
        ? `ready · ${meydaFeatures.frameCount} frames`
        : (meydaFeatures.isPendingSetup ? 'pending setup…' : 'idle');
    }

    // --- Viz demo ---------------------------------------------------
    drawViz({
      bassKick,
      rms: rmsVal,
      chroma: chromaVec,
      chromaHueDeg,
      chromaConfidence: chromaConf,
      anticipation: antic,
    });
  }

  return {
    update,
    setVisible: setVisibleInternal,
    get isVisible() { return visible; },
  };
}
