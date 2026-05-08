// Live FeatureBus inspector — six horizontal bars, one per band, plus the
// raw/env/norm numeric values. Toggle with F.
//
// Stage 5 of plan_particle_2.md (was earmarked for Stage 5b but pulled
// forward as a verification tool — without this, bindings are tuned blind).
//
// Pure DOM — no Three.js, no canvas. The cost is one update per frame
// writing ~24 string properties; trivial.

export function createFeatureDebugOverlay({ feature, audio = null, beatGrid = null, hotkey = 'KeyF', visibleByDefault = true } = {}) {
  const bandNames = feature.bandNames;

  const root = document.createElement('div');
  root.id = 'feature-debug';
  Object.assign(root.style, {
    position: 'fixed',
    top: '64px',
    right: '16px',
    width: '240px',
    padding: '10px 12px',
    background: 'rgba(8, 12, 24, 0.82)',
    border: '1px solid rgba(108, 240, 255, 0.22)',
    borderRadius: '8px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: '11px',
    lineHeight: '1.4',
    color: '#cbd5ff',
    zIndex: '50',
    pointerEvents: 'none',
    userSelect: 'none',
    backdropFilter: 'blur(4px)',
  });

  const header = document.createElement('div');
  header.style.cssText = 'opacity:0.55;margin-bottom:8px;letter-spacing:0.4px;text-transform:uppercase;font-size:10px;';
  header.textContent = 'audio bands · F to toggle';
  root.appendChild(header);

  const status = document.createElement('div');
  status.style.cssText = 'opacity:0.5;margin-bottom:6px;font-size:10px;';
  status.textContent = 'waiting for analyser…';
  root.appendChild(status);

  const rows = {};
  for (const name of bandNames) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:6px;margin:4px 0;';
    row.innerHTML = `
      <div style="width:52px;opacity:0.7">${name}</div>
      <div style="flex:1;height:9px;background:rgba(255,255,255,0.06);position:relative;border-radius:4px;overflow:hidden;">
        <div class="bar-norm"
             style="position:absolute;left:0;top:0;bottom:0;width:0%;
                    background:rgba(108,240,255,0.4);"></div>
        <div class="bar-kick"
             style="position:absolute;left:0;top:0;bottom:0;width:0%;
                    background:linear-gradient(90deg,#ffd166,#ff5c8a);
                    box-shadow:0 0 6px rgba(255,92,138,0.5);"></div>
      </div>
      <div class="val" style="width:46px;text-align:right;opacity:0.85;font-variant-numeric:tabular-nums;font-size:10px;">.00·.00</div>
    `;
    rows[name] = {
      barNorm: row.querySelector('.bar-norm'),
      barKick: row.querySelector('.bar-kick'),
      val:     row.querySelector('.val'),
    };
    root.appendChild(row);
  }

  const legend = document.createElement('div');
  legend.style.cssText = 'opacity:0.5;margin-top:8px;font-size:10px;display:flex;gap:10px;';
  legend.innerHTML = `
    <span><span style="display:inline-block;width:8px;height:8px;background:rgba(108,240,255,0.4);vertical-align:middle;margin-right:3px;"></span>norm (level)</span>
    <span><span style="display:inline-block;width:8px;height:8px;background:linear-gradient(90deg,#ffd166,#ff5c8a);vertical-align:middle;margin-right:3px;"></span>kick (transient)</span>
  `;
  root.appendChild(legend);

  // Stage 5b — discrete onset markers. Each channel gets a small dot that
  // flashes (and a short trailing label flashing strength) whenever an onset
  // fires; the dot fades over ~250ms. The bar visualisations above show
  // *continuous* signal; onset dots show *events*.
  let onsetRows = null;
  if (feature.onsets) {
    const onsetSection = document.createElement('div');
    onsetSection.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08);display:flex;gap:14px;';
    const channels = feature.onsets.names;
    onsetRows = {};
    for (const name of channels) {
      const cell = document.createElement('div');
      cell.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:3px;flex:1;';
      cell.innerHTML = `
        <div style="opacity:0.6;font-size:10px;letter-spacing:0.3px;">${name}</div>
        <div class="onset-dot" style="
          width:14px;height:14px;border-radius:50%;
          background:rgba(255,255,255,0.06);
          box-shadow:0 0 0 1px rgba(255,255,255,0.10);
          transition:none;"></div>
        <div class="onset-strength" style="
          font-variant-numeric:tabular-nums;font-size:10px;opacity:0.5;">.00</div>
      `;
      onsetRows[name] = {
        dot:      cell.querySelector('.onset-dot'),
        strength: cell.querySelector('.onset-strength'),
      };
      onsetSection.appendChild(cell);
    }
    root.appendChild(onsetSection);
  }

  // Stage 5b — beat-grid status row. Shows BPM + a phase bar + an
  // anticipation bar. The phase bar sweeps left-to-right between beats; the
  // anticipation bar fills only during the lookahead window before each
  // beat, so visually you see a "wind-up" pulse just before every beat.
  let beatRow = null;
  if (beatGrid) {
    const row = document.createElement('div');
    row.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08);';
    row.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px;">
        <span style="opacity:0.7;font-size:10px;letter-spacing:0.3px;">beat-grid</span>
        <span class="bg-bpm" style="font-variant-numeric:tabular-nums;font-size:10px;opacity:0.9;">analyzing…</span>
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin:3px 0;">
        <div style="width:52px;opacity:0.6;font-size:10px;">phase</div>
        <div style="flex:1;height:6px;background:rgba(255,255,255,0.06);border-radius:3px;position:relative;overflow:hidden;">
          <div class="bg-phase" style="position:absolute;inset:0;width:0%;background:rgba(108,240,255,0.5);"></div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;margin:3px 0;">
        <div style="width:52px;opacity:0.6;font-size:10px;">anticip</div>
        <div style="flex:1;height:6px;background:rgba(255,255,255,0.06);border-radius:3px;position:relative;overflow:hidden;">
          <div class="bg-antic" style="position:absolute;inset:0;width:0%;background:linear-gradient(90deg,#a0e6ff,#ff5c8a);box-shadow:0 0 8px rgba(255,92,138,0.5);"></div>
        </div>
      </div>
    `;
    beatRow = {
      bpm:    row.querySelector('.bg-bpm'),
      phase:  row.querySelector('.bg-phase'),
      antic:  row.querySelector('.bg-antic'),
    };
    root.appendChild(row);
  }

  document.body.appendChild(root);

  let visible = visibleByDefault;
  if (!visible) root.style.display = 'none';

  window.addEventListener('keydown', (e) => {
    if (e.code !== hotkey) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    visible = !visible;
    root.style.display = visible ? 'block' : 'none';
  });

  return {
    update() {
      if (!visible) return;
      const ready = feature.isBound;
      const hasAnalyser = audio && !!audio.analyser;
      const ctxState = audio && audio.hasContext ? 'ready' : 'no-ctx';
      if (ready) {
        status.textContent = `bound · ${bandNames.length} bands · ctx ${ctxState}`;
      } else if (audio && audio.hasContext && !hasAnalyser) {
        status.textContent = '⚠ analyser tap failed — see console (CORS?)';
      } else {
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
        row.val.textContent = norm.toFixed(2) + '·' + kick.toFixed(2);
      }
      // Beat-grid status — BPM, phase, anticipation. Updated every frame; the
      // anticipation bar will visibly fill during the 250ms before each beat.
      if (beatRow && beatGrid) {
        if (beatGrid.isAnalyzing) {
          beatRow.bpm.textContent = 'analyzing…';
          beatRow.bpm.style.opacity = '0.55';
          beatRow.bpm.style.color = '#cbd5ff';
        } else if (beatGrid.isAnalyzed) {
          // Stage 5b multi-track support: the drift indicator surfaces when
          // the running track no longer matches the cached BPM (next analysis
          // window will reset it). Color shifts so it's visible without text
          // changes.
          const drifting = beatGrid.isDrifting;
          const driftMs = (beatGrid.driftMeanAbsSec * 1000) | 0;
          beatRow.bpm.textContent = drifting
            ? `${beatGrid.bpm.toFixed(1)} bpm · drift ${driftMs}ms ⚠`
            : `${beatGrid.bpm.toFixed(1)} bpm · offs ${beatGrid.offsetSec.toFixed(2)}s`;
          beatRow.bpm.style.opacity = '0.9';
          beatRow.bpm.style.color = drifting ? '#ff5c8a' : '#cbd5ff';
        } else if (beatGrid.analyzeError) {
          beatRow.bpm.textContent = '⚠ analysis failed';
          beatRow.bpm.style.opacity = '0.6';
          beatRow.bpm.style.color = '#ff5c8a';
        } else {
          beatRow.bpm.textContent = 'awaiting BGM';
          beatRow.bpm.style.opacity = '0.45';
          beatRow.bpm.style.color = '#cbd5ff';
        }
        beatRow.phase.style.width = (beatGrid.phase * 100).toFixed(1) + '%';
        beatRow.antic.style.width = (beatGrid.anticipation * 100).toFixed(1) + '%';
      }
      // Onset markers — fade over a fixed wall-clock window. Reads telemetry
      // from the FeatureBus so the overlay can be turned off mid-session
      // without leaking listeners. 250ms feels right: fast enough that two
      // back-to-back kicks read as separate flashes, slow enough that you
      // can actually see a single fire on a 60Hz display.
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
            label.style.opacity = '0.35';
          }
        }
      }
    },
    setVisible(v) {
      visible = !!v;
      root.style.display = visible ? 'block' : 'none';
    },
  };
}
