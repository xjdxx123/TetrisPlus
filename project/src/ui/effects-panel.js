// Effects toggle panel — dev/inspection tool.
//
// A floating list of checkboxes, one per visual effect. Each entry is
// `{ name, initiallyOn, onChange(boolean) }`. The panel owns the checkbox
// DOM and binds change events to onChange.
//
// Toggle the whole panel with the configured hotkey (default: 'E').
// Console handle: `__effectsPanel.setVisible(false)`.
//
// Pure DOM, no Three.js. Can sit alongside the F-key feature debug overlay.

export function createEffectsPanel({
  effects,
  hotkey = 'KeyE',
  visibleByDefault = true,
  // Optional stage selector at top — pass the stage controller from
  // src/vfx/stage-controller.js and a `stages` map (label → name).
  stage = null,
  stages = null,    // { 'cyan-void': 'Cyan Void', 'ember-rise': 'Ember Rise', ... }
} = {}) {
  if (!Array.isArray(effects) || effects.length === 0) {
    return { setVisible() {}, dispose() {} };
  }

  const root = document.createElement('div');
  root.id = 'effects-panel';
  Object.assign(root.style, {
    position: 'fixed',
    top: '64px',
    left: '16px',
    width: '210px',
    padding: '10px 12px',
    background: 'rgba(8, 12, 24, 0.82)',
    border: '1px solid rgba(108, 240, 255, 0.22)',
    borderRadius: '8px',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
    fontSize: '12px',
    lineHeight: '1.6',
    color: '#cbd5ff',
    zIndex: '50',
    userSelect: 'none',
    backdropFilter: 'blur(4px)',
  });

  const header = document.createElement('div');
  header.style.cssText = 'opacity:0.55;margin-bottom:6px;letter-spacing:0.4px;text-transform:uppercase;font-size:10px;font-family:ui-monospace,monospace;';
  header.textContent = `effects · ${hotkey.replace('Key', '').toUpperCase()} to toggle`;
  root.appendChild(header);

  // Optional stage selector (Stage 8). Sits above the checkboxes; uses a
  // <select> for direct picking. Calling stage.set() emits STAGE_CHANGE
  // on the bus, which the nebula crossfade subscribes to.
  let stageSelect = null;
  if (stage && stages) {
    const stageRow = document.createElement('div');
    stageRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin:4px 0 8px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.08);';
    const stageLabel = document.createElement('span');
    stageLabel.textContent = 'Stage';
    stageLabel.style.cssText = 'opacity:0.7;font-size:11px;width:50px;';
    stageRow.appendChild(stageLabel);
    stageSelect = document.createElement('select');
    stageSelect.style.cssText = 'flex:1;background:rgba(255,255,255,0.06);color:#cbd5ff;border:1px solid rgba(108,240,255,0.18);border-radius:4px;padding:3px 6px;font-size:11px;cursor:pointer;font-family:inherit;';
    for (const name of stage.available) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = stages[name] || name;
      if (name === stage.current) opt.selected = true;
      stageSelect.appendChild(opt);
    }
    stageSelect.addEventListener('change', () => { stage.set(stageSelect.value); });
    stageRow.appendChild(stageSelect);
    root.appendChild(stageRow);
  }

  // Master toggle row at the top — flips every effect at once.
  const master = document.createElement('label');
  master.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.08);margin-bottom:4px;';
  const masterCb = document.createElement('input');
  masterCb.type = 'checkbox';
  masterCb.checked = true;
  masterCb.style.cssText = 'cursor:pointer;accent-color:#6cf0ff;';
  master.appendChild(masterCb);
  const masterLabel = document.createElement('span');
  masterLabel.textContent = 'All effects';
  masterLabel.style.cssText = 'font-weight:600;letter-spacing:0.3px;';
  master.appendChild(masterLabel);
  root.appendChild(master);

  const rowState = []; // { effect, checkbox }

  for (const effect of effects) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;padding:2px 0;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = effect.initiallyOn !== false;
    cb.style.cssText = 'cursor:pointer;accent-color:#6cf0ff;';
    row.appendChild(cb);
    const label = document.createElement('span');
    label.textContent = effect.name;
    row.appendChild(label);
    root.appendChild(row);

    cb.addEventListener('change', () => {
      try { effect.onChange(cb.checked); }
      catch (err) { console.error(`[effects-panel] ${effect.name}.onChange threw:`, err); }
      // Keep the master in a sane state — checked iff every individual is on.
      masterCb.checked = rowState.every(r => r.checkbox.checked);
    });

    // Apply the initial state immediately so the world matches the panel.
    try { effect.onChange(cb.checked); }
    catch (err) { console.error(`[effects-panel] ${effect.name}.onChange (initial) threw:`, err); }

    rowState.push({ effect, checkbox: cb });
  }

  masterCb.addEventListener('change', () => {
    const v = masterCb.checked;
    for (const { effect, checkbox } of rowState) {
      checkbox.checked = v;
      try { effect.onChange(v); }
      catch (err) { console.error(`[effects-panel] ${effect.name}.onChange (master) threw:`, err); }
    }
  });

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
    setVisible(v) { visible = !!v; root.style.display = visible ? 'block' : 'none'; },
    dispose() { root.remove(); },
    // For console: __effectsPanel.set('Nebula', false)
    set(name, on) {
      const r = rowState.find(({ effect }) => effect.name === name);
      if (!r) return;
      r.checkbox.checked = !!on;
      r.checkbox.dispatchEvent(new Event('change'));
    },
    // Sync dropdown if stage changed via console / event.
    syncStage(name) {
      if (stageSelect && name && stageSelect.value !== name) stageSelect.value = name;
    },
  };
}
