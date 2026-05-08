// Live FeatureBus inspector — six horizontal bars, one per band, plus the
// raw/env/norm numeric values. Toggle with F.
//
// Stage 5 of plan_particle_2.md (was earmarked for Stage 5b but pulled
// forward as a verification tool — without this, bindings are tuned blind).
//
// Pure DOM — no Three.js, no canvas. The cost is one update per frame
// writing ~24 string properties; trivial.

export function createFeatureDebugOverlay({ feature, audio = null, hotkey = 'KeyF', visibleByDefault = true } = {}) {
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
    },
    setVisible(v) {
      visible = !!v;
      root.style.display = visible ? 'block' : 'none';
    },
  };
}
