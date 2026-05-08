// Live FeatureBus inspector — six horizontal bars, one per band, plus the
// raw/env/norm numeric values. Toggle with F.
//
// Stage 5 of plan_particle_2.md (was earmarked for Stage 5b but pulled
// forward as a verification tool — without this, bindings are tuned blind).
//
// Visual design follows `document/plan_UI_1.md` §4 — shared chrome from
// `panel-shared.js` (cyan accent, glass blur, monospace mark + sans-serif
// title). Pure DOM — no Three.js, no canvas.

import { installPanelStyles, makePanelHeader } from '../../ui/panel-shared.js';

export function createFeatureDebugOverlay({
  feature,
  audio = null,
  beatGrid = null,
  hotkey = 'KeyF',
  visibleByDefault = true,
} = {}) {
  installPanelStyles();
  const bandNames = feature.bandNames;

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

  // Header — close button needs pointer events; the rest of the panel
  // remains pass-through to the canvas (audio inspector should never block
  // gameplay clicks).
  const header = makePanelHeader({
    title: 'Audio bands',
    hotkey: hotkey.replace('Key', '').toUpperCase(),
    onClose: () => setVisibleInternal(false),
  });
  // Re-enable pointer events only on the close button.
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

  // === Band bars =========================================================
  const bandsLabel = document.createElement('div');
  bandsLabel.className = 'tp-panel__section-label';
  bandsLabel.textContent = 'Bands';
  body.appendChild(bandsLabel);

  const rows = {};
  for (const name of bandNames) {
    const row = document.createElement('div');
    row.className = 'tp-band-row';

    const nameEl = document.createElement('div');
    nameEl.className = 'tp-band-row__name';
    nameEl.textContent = name;
    row.appendChild(nameEl);

    const track = document.createElement('div');
    track.className = 'tp-band-row__track';
    const barNorm = document.createElement('div');
    barNorm.className = 'tp-band-row__bar-norm';
    const barKick = document.createElement('div');
    barKick.className = 'tp-band-row__bar-kick';
    track.appendChild(barNorm);
    track.appendChild(barKick);
    row.appendChild(track);

    const val = document.createElement('div');
    val.className = 'tp-band-row__val';
    val.textContent = '.00 · .00';
    row.appendChild(val);

    rows[name] = { barNorm, barKick, val };
    body.appendChild(row);
  }

  const legend = document.createElement('div');
  legend.className = 'tp-legend';
  legend.innerHTML = `
    <span><span class="tp-legend__swatch" style="background:rgba(108,240,255,0.42);"></span>norm (level)</span>
    <span><span class="tp-legend__swatch" style="background:linear-gradient(90deg,#ffd166,#ff5c8a);"></span>kick (transient)</span>
  `;
  body.appendChild(legend);

  // === Onset markers (Stage 5b) =========================================
  // Each channel gets a dot that flashes when an onset fires; fades over
  // ~250ms. Bars above show *continuous* signal; dots show *events*.
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

  // === Beat grid (Stage 5b) =============================================
  // BPM + phase bar + anticipation bar. The phase bar sweeps left-to-right
  // between beats; the anticipation bar fills only during the lookahead
  // window before each beat — visually a "wind-up" pulse pre-beat.
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

  return {
    update() {
      if (!visible) return;
      const ready = feature.isBound;
      const hasAnalyser = audio && !!audio.analyser;
      const ctxState = audio && audio.hasContext ? 'ready' : 'no-ctx';
      // Status uses the shared `tp-status--{ok,warn,err}` modifiers so the
      // colour communicates state without a parallel text channel.
      if (ready) {
        status.className = 'tp-status tp-status--ok';
        status.textContent = `bound · ${bandNames.length} bands · ctx ${ctxState}`;
      } else if (audio && audio.hasContext && !hasAnalyser) {
        status.className = 'tp-status tp-status--err';
        status.textContent = '⚠ analyser tap failed — see console (CORS?)';
      } else {
        status.className = 'tp-status';
        status.textContent = 'waiting for first user gesture…';
      }
      if (!ready) return;
      for (const name of bandNames) {
        const sig = feature.bands[name];
        const norm = Math.min(1, Math.max(0, sig.norm));
        const kick = Math.min(1, Math.max(0, sig.kick));
        const row = rows[name];
        row.barNorm.style.width = (norm * 100).toFixed(1) + '%';
        row.barKick.style.width = (kick * 100).toFixed(1) + '%';
        row.val.textContent = norm.toFixed(2) + ' · ' + kick.toFixed(2);
      }
      // Beat-grid status — BPM, phase, anticipation. Updated every frame; the
      // anticipation bar visibly fills during the 250ms before each beat.
      if (beatRow && beatGrid) {
        if (beatGrid.isAnalyzing) {
          beatRow.bpm.textContent = 'analyzing…';
          beatRow.bpm.style.color = '';
          beatRow.bpm.style.opacity = '0.55';
        } else if (beatGrid.isAnalyzed) {
          // Multi-track support: drift indicator surfaces when the running
          // track no longer matches the cached BPM (next analysis window
          // resets it). Color shifts so it's visible without text changes.
          const drifting = beatGrid.isDrifting;
          const driftMs = (beatGrid.driftMeanAbsSec * 1000) | 0;
          beatRow.bpm.textContent = drifting
            ? `${beatGrid.bpm.toFixed(1)} bpm · drift ${driftMs}ms ⚠`
            : `${beatGrid.bpm.toFixed(1)} bpm · offs ${beatGrid.offsetSec.toFixed(2)}s`;
          beatRow.bpm.style.opacity = '0.9';
          beatRow.bpm.style.color = drifting ? '#ff5c8a' : '';
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
      // Onset markers — fade over a fixed wall-clock window. Reads telemetry
      // from the FeatureBus so the overlay can be turned off mid-session
      // without leaking listeners. 250ms feels right: fast enough that two
      // back-to-back kicks read as separate flashes, slow enough that a
      // single fire is visible on a 60Hz display.
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
