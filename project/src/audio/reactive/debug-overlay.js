// Live audio inspector — FFT spectrum + onset markers + beat-grid info.
// Toggle with F.
//
// Replaces the old 6-band horizontal-bar layout with a log-spaced FFT
// spectrum canvas that's simultaneously more informative and source-agnostic
// (works for BGM analyser AND external tab capture). The 6-band FeatureBus
// signals still drive everything downstream (selective bloom, dust, etc) —
// this panel just shows the raw frequency content instead of the 6
// summary numbers.
//
// Visual design follows `document/plan_UI_1.md` §4 — shared chrome from
// `panel-shared.js` (cyan accent, glass blur, monospace mark + sans-serif
// title). Canvas for the spectrum, DOM for onsets + beat-grid.

import { installPanelStyles, makePanelHeader } from '../../ui/panel-shared.js';

const SPECTRUM_BARS = 96;     // log-spaced bins to draw
const SPECTRUM_W    = 232;    // panel-body inner width
const SPECTRUM_H    = 64;
const SMOOTHING     = 0.55;   // per-bar exponential smoothing (0 = no, 1 = freeze)

export function createFeatureDebugOverlay({
  feature,
  audio = null,
  beatGrid = null,
  hotkey = 'KeyF',
  visibleByDefault = true,
  // Caller provides the "currently active" analyser. Falls back to
  // audio.analyser when undefined / returning nullish. Lets the panel
  // follow external tab capture without depending on its specifics.
  getAnalyser = null,
} = {}) {
  installPanelStyles();

  const root = document.createElement('div');
  root.id = 'feature-debug';
  root.className = 'tp-panel';
  root.style.top = '64px';
  root.style.right = '16px';
  root.style.width = '260px';
  root.style.pointerEvents = 'none';

  let visible = visibleByDefault;
  const setVisibleInternal = (v) => {
    visible = !!v;
    root.style.display = visible ? 'block' : 'none';
  };

  const header = makePanelHeader({
    title: 'Audio spectrum',
    hotkey: hotkey.replace('Key', '').toUpperCase(),
    onClose: () => setVisibleInternal(false),
  });
  const closeBtn = header.querySelector('.tp-panel__close');
  if (closeBtn) closeBtn.style.pointerEvents = 'auto';
  root.appendChild(header);

  const body = document.createElement('div');
  body.className = 'tp-panel__body';
  root.appendChild(body);

  const status = document.createElement('div');
  status.className = 'tp-status';
  status.textContent = 'waiting for analyser…';
  body.appendChild(status);

  // === Spectrum canvas =================================================
  const specLabel = document.createElement('div');
  specLabel.className = 'tp-panel__section-label';
  specLabel.textContent = 'Spectrum';
  body.appendChild(specLabel);

  const canvas = document.createElement('canvas');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width  = SPECTRUM_W * dpr;
  canvas.height = SPECTRUM_H * dpr;
  canvas.style.width  = `${SPECTRUM_W}px`;
  canvas.style.height = `${SPECTRUM_H}px`;
  canvas.style.display = 'block';
  canvas.style.borderRadius = '4px';
  canvas.style.background = 'rgba(255,255,255,0.03)';
  canvas.style.marginBottom = '6px';
  body.appendChild(canvas);
  const ctx2d = canvas.getContext('2d');
  ctx2d.scale(dpr, dpr);

  const sourceLine = document.createElement('div');
  sourceLine.style.cssText = 'font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;font-size:9.5px;letter-spacing:0.05em;color:var(--muted,#8b93ad);margin-bottom:6px;';
  sourceLine.textContent = 'source: —';
  body.appendChild(sourceLine);

  // Per-bin state — recomputed when analyser bin-count changes.
  let dataArray = null;
  let barRanges = null;
  let smoothed  = null;
  let lastBinCount = 0;

  const recomputeBars = (binCount) => {
    dataArray = new Uint8Array(binCount);
    smoothed  = new Float32Array(SPECTRUM_BARS);
    // Log-spaced bin assignment so low-end isn't crammed into one bar.
    const logMin = Math.log(1);
    const logMax = Math.log(binCount - 1);
    barRanges = new Array(SPECTRUM_BARS);
    for (let i = 0; i < SPECTRUM_BARS; i++) {
      const t0 = i / SPECTRUM_BARS;
      const t1 = (i + 1) / SPECTRUM_BARS;
      const s = Math.round(Math.exp(logMin + (logMax - logMin) * t0));
      const e = Math.max(s + 1, Math.round(Math.exp(logMin + (logMax - logMin) * t1)));
      barRanges[i] = [s, Math.min(e, binCount - 1)];
    }
    lastBinCount = binCount;
  };

  // === Onset markers ===================================================
  let onsetRows = null;
  if (feature.onsets) {
    const divider = document.createElement('div');
    divider.className = 'tp-panel__divider';
    body.appendChild(divider);

    const onsetLabel = document.createElement('div');
    onsetLabel.className = 'tp-panel__section-label';
    onsetLabel.textContent = 'Onsets';
    body.appendChild(onsetLabel);

    const onsetSection = document.createElement('div');
    onsetSection.style.cssText = 'display:flex;gap:14px;margin:4px 0 2px;';
    const channels = feature.onsets.names;
    onsetRows = {};
    for (const name of channels) {
      const cell = document.createElement('div');
      cell.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:4px;flex:1;';

      const cellLabel = document.createElement('div');
      cellLabel.style.cssText = 'font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;font-size:9.5px;letter-spacing:0.05em;color:var(--muted,#8b93ad);';
      cellLabel.textContent = name;
      cell.appendChild(cellLabel);

      const dot = document.createElement('div');
      dot.style.cssText = 'width:14px;height:14px;border-radius:50%;background:rgba(255,255,255,0.06);box-shadow:0 0 0 1px rgba(255,255,255,0.10);';
      cell.appendChild(dot);

      const strength = document.createElement('div');
      strength.style.cssText = 'font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;font-size:10px;color:var(--ink,#f3f5fb);opacity:0.45;';
      strength.textContent = '.00';
      cell.appendChild(strength);

      onsetRows[name] = { dot, strength };
      onsetSection.appendChild(cell);
    }
    body.appendChild(onsetSection);
  }

  // === Beat-grid =======================================================
  let beatRow = null;
  if (beatGrid) {
    const divider = document.createElement('div');
    divider.className = 'tp-panel__divider';
    body.appendChild(divider);

    const sectionLabel = document.createElement('div');
    sectionLabel.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;';
    const left = document.createElement('span');
    left.className = 'tp-panel__section-label';
    left.style.margin = '0';
    left.textContent = 'Beat-grid';
    const bpm = document.createElement('span');
    bpm.style.cssText = 'font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;font-size:10px;color:var(--muted,#8b93ad);font-variant-numeric:tabular-nums;';
    bpm.textContent = 'analyzing…';
    sectionLabel.appendChild(left);
    sectionLabel.appendChild(bpm);
    body.appendChild(sectionLabel);

    const mkLine = (label) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin:3px 0;';
      const lbl = document.createElement('div');
      lbl.style.cssText = 'width:48px;font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;font-size:10px;letter-spacing:0.05em;color:var(--muted,#8b93ad);';
      lbl.textContent = label;
      const track = document.createElement('div');
      track.style.cssText = 'flex:1;height:6px;background:rgba(255,255,255,0.05);border-radius:3px;position:relative;overflow:hidden;';
      const fill = document.createElement('div');
      fill.style.cssText = 'position:absolute;inset:0;width:0%;';
      track.appendChild(fill);
      row.appendChild(lbl);
      row.appendChild(track);
      body.appendChild(row);
      return fill;
    };
    const phaseBar = mkLine('phase');
    phaseBar.style.background = 'rgba(108,240,255,0.5)';
    const anticBar = mkLine('antic');
    anticBar.style.background = 'linear-gradient(90deg,#a0e6ff,#ff5c8a)';
    anticBar.style.boxShadow = '0 0 8px rgba(255,92,138,0.5)';

    beatRow = { bpm, phase: phaseBar, antic: anticBar };
  }

  document.body.appendChild(root);
  if (!visible) root.style.display = 'none';

  window.addEventListener('keydown', (e) => {
    if (e.code !== hotkey) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
    setVisibleInternal(!visible);
  });

  // Helpers --------------------------------------------------------------

  function currentAnalyser() {
    if (typeof getAnalyser === 'function') {
      const a = getAnalyser();
      if (a) return a;
    }
    return audio && audio.analyser ? audio.analyser : null;
  }

  function renderSpectrum(analyser) {
    if (!analyser) return;
    const bins = analyser.frequencyBinCount;
    if (bins !== lastBinCount) recomputeBars(bins);
    analyser.getByteFrequencyData(dataArray);

    ctx2d.clearRect(0, 0, SPECTRUM_W, SPECTRUM_H);

    const barW = SPECTRUM_W / SPECTRUM_BARS;
    for (let i = 0; i < SPECTRUM_BARS; i++) {
      const [s, e] = barRanges[i];
      let sum = 0;
      const n = e - s;
      for (let j = s; j < e; j++) sum += dataArray[j];
      const avg = (n > 0 ? sum / n : 0) / 255;
      // Exponential smoothing for less visual jitter; rises faster than
      // it falls so transients still pop.
      const prev = smoothed[i];
      const target = avg;
      const tau = target > prev ? 0.2 : SMOOTHING;
      smoothed[i] = prev + (target - prev) * (1 - tau);

      const v = smoothed[i];
      const h = v * SPECTRUM_H;
      // Cyan→pink gradient on intensity reads as "loudness" not "frequency".
      const intensity = Math.min(1, v * 1.3);
      const r = Math.round(108 + (255 - 108) * intensity);
      const g = Math.round(240 + ( 92 - 240) * intensity);
      const b = Math.round(255 + (138 - 255) * intensity);
      ctx2d.fillStyle = `rgb(${r},${g},${b})`;
      ctx2d.fillRect(i * barW, SPECTRUM_H - h, Math.max(1, barW - 1), h);
    }
  }

  return {
    update() {
      if (!visible) return;
      const ready = feature.isBound;
      const hasAnalyser = audio && !!audio.analyser;
      const ctxState = audio && audio.hasContext ? 'ready' : 'no-ctx';
      if (ready) {
        status.className = 'tp-status tp-status--ok';
        status.textContent = `bound · ctx ${ctxState}`;
      } else if (audio && audio.hasContext && !hasAnalyser) {
        status.className = 'tp-status tp-status--err';
        status.textContent = '⚠ analyser tap failed — see console (CORS?)';
      } else {
        status.className = 'tp-status';
        status.textContent = 'waiting for first user gesture…';
      }

      // Spectrum — sourced from the active analyser (external tab if a
      // capture is running, BGM otherwise).
      const analyser = currentAnalyser();
      // Detect whether we're on BGM or external — naive but cheap.
      // If getAnalyser returned a value AND it isn't the same node as
      // audio.analyser, we're on external.
      let sourceLabel = 'none';
      if (analyser) {
        const isBgm = audio && audio.analyser === analyser;
        sourceLabel = isBgm ? 'BGM' : 'external tab';
        renderSpectrum(analyser);
      } else {
        ctx2d.clearRect(0, 0, SPECTRUM_W, SPECTRUM_H);
      }
      sourceLine.textContent = `source: ${sourceLabel}`;

      if (!ready) return;
      // Beat-grid status.
      if (beatRow && beatGrid) {
        if (beatGrid.isAnalyzed) {
          beatRow.bpm.textContent = `${beatGrid.bpm.toFixed(1)} bpm · offs ${beatGrid.offsetSec.toFixed(2)}s`;
          beatRow.bpm.style.opacity = '0.9';
          beatRow.bpm.style.color = '';
        } else if (beatGrid.isAnalyzing) {
          beatRow.bpm.textContent = 'analyzing…';
          beatRow.bpm.style.color = '';
          beatRow.bpm.style.opacity = '0.55';
        } else if (beatGrid.analyzeError) {
          beatRow.bpm.textContent = '⚠ analysis failed';
          beatRow.bpm.style.opacity = '0.6';
          beatRow.bpm.style.color = '#ff5c8a';
        } else {
          beatRow.bpm.textContent = 'awaiting BGM';
          beatRow.bpm.style.opacity = '0.45';
          beatRow.bpm.style.color = '';
        }
        beatRow.phase.style.width = (beatGrid.phase * 100).toFixed(1) + '%';
        beatRow.antic.style.width = (beatGrid.anticipation * 100).toFixed(1) + '%';
      }
      // Onset markers.
      if (onsetRows && feature.onsets) {
        const FADE_SEC = 0.25;
        const now = feature.totalSec || 0;
        for (const name of feature.onsets.names) {
          const tele = feature.onsets.telemetry(name);
          const elapsed = now - tele.lastFireAtSec;
          const k = Math.max(0, Math.min(1, 1 - elapsed / FADE_SEC));
          const dot = onsetRows[name].dot;
          const label = onsetRows[name].strength;
          if (k > 0) {
            const alpha = 0.25 + 0.75 * k;
            dot.style.background = `rgba(255, 92, 138, ${alpha.toFixed(2)})`;
            dot.style.boxShadow = `0 0 ${(8 + 12 * k).toFixed(0)}px rgba(255, 92, 138, ${(0.6 * k).toFixed(2)}), 0 0 0 1px rgba(255, 92, 138, 0.6)`;
            label.textContent = tele.lastStrength.toFixed(2);
            label.style.opacity = (0.4 + 0.6 * k).toFixed(2);
          } else {
            dot.style.background = 'rgba(255,255,255,0.06)';
            dot.style.boxShadow = '0 0 0 1px rgba(255,255,255,0.10)';
            label.style.opacity = '0.45';
          }
        }
      }
    },
    setVisible: setVisibleInternal,
  };
}
