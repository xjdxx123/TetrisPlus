// Effects toggle panel — dev/inspection tool.
//
// A floating list of toggles, one per visual effect. Each entry is
// `{ name, initiallyOn, onChange(boolean) }`. The panel owns the toggle
// DOM and binds change events to onChange.
//
// Toggle the whole panel with the configured hotkey (default: 'E').
// Console handle: `__effectsPanel.setVisible(false)`.
//
// Visual design follows `document/plan_UI_1.md` §4 — shared chrome from
// `panel-shared.js` (cyan accent, glass blur, monospace mark + sans-serif
// title, CSS toggle switches in place of native checkboxes).

import { installPanelStyles, makePanelHeader, makeToggleRow, makeHueSlider } from './panel-shared.js';

export function createEffectsPanel({
  effects,
  hotkey = 'KeyE',
  visibleByDefault = true,
  // Optional stage selector — pass the stage controller from
  // src/vfx/stage-controller.js and a `stages` map (name → label).
  stage = null,
  stages = null,
  // Optional hue picker — RPG-style horizontal hue strip. The player picks
  // a single hue value; the palette is generated procedurally from it.
  // Pass `hue: { initial, onChange, onAutoToggle, previewBackground }` to
  // enable. `previewBackground(hue)` returns a CSS gradient string that
  // shows the actual generated palette for the chosen hue.
  hue = null,
} = {}) {
  if (!Array.isArray(effects) || effects.length === 0) {
    return { setVisible() {}, dispose() {} };
  }

  installPanelStyles();

  const root = document.createElement('div');
  root.id = 'effects-panel';
  root.className = 'tp-panel';
  // Position is panel-specific; chrome lives in shared CSS.
  root.style.top = '64px';
  root.style.left = '16px';
  root.style.width = '230px';

  let visible = visibleByDefault;
  const setVisibleInternal = (v) => {
    visible = !!v;
    root.style.display = visible ? 'block' : 'none';
  };

  const hotkeyDisplay = hotkey.replace('Key', '').toUpperCase();
  root.appendChild(makePanelHeader({
    title: 'Effects',
    hotkey: hotkeyDisplay,
    onClose: () => setVisibleInternal(false),
  }));

  const body = document.createElement('div');
  body.className = 'tp-panel__body';
  root.appendChild(body);

  // Optional stage selector — sits above the toggles. Calling stage.set()
  // emits STAGE_CHANGE on the bus (which the nebula crossfade subscribes to).
  let stageSelect = null;
  if (stage && stages) {
    const sectionLabel = document.createElement('div');
    sectionLabel.className = 'tp-panel__section-label';
    sectionLabel.textContent = 'Stage';
    body.appendChild(sectionLabel);

    const stageRow = document.createElement('div');
    stageRow.className = 'tp-row';
    // Selector takes the full row width — no caption needed (the section
    // label above already names it).
    stageSelect = document.createElement('select');
    stageSelect.className = 'tp-select';
    for (const name of stage.available) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = stages[name] || name;
      if (name === stage.current) opt.selected = true;
      stageSelect.appendChild(opt);
    }
    stageSelect.addEventListener('change', () => { stage.set(stageSelect.value); });
    stageRow.appendChild(stageSelect);
    body.appendChild(stageRow);

    const divider = document.createElement('div');
    divider.className = 'tp-panel__divider';
    body.appendChild(divider);
  }

  // Optional hue picker — replaces the old palette dropdown. The slider is
  // a continuous hue strip (RPG-style); an "Auto" toggle above it clears
  // the player's pin so level-progression resumes. When Auto is on the
  // slider is disabled (greyed out) — players can still see what hue the
  // game is settled on, just can't drag it without flipping Auto off.
  let hueSlider = null;
  let autoToggleInput = null;
  if (hue && hue.onChange) {
    const sectionLabel = document.createElement('div');
    sectionLabel.className = 'tp-panel__section-label';
    sectionLabel.textContent = 'Palette hue';
    body.appendChild(sectionLabel);

    // Auto toggle row — same chrome as the effect toggles below.
    const auto = makeToggleRow({
      label: 'Auto (level-driven)',
      checked: hue.initialAuto !== false,
    });
    body.appendChild(auto.row);
    autoToggleInput = auto.input;

    // Hue slider row.
    const sliderWrap = document.createElement('div');
    sliderWrap.style.cssText = 'padding:4px 4px;';
    hueSlider = makeHueSlider({
      initial: hue.initial != null ? hue.initial : 200,
      previewBackground: hue.previewBackground,
      onChange: (h) => {
        // Manually picking a hue commits an override — flip Auto off so
        // the UI state is honest about what's driving the nebula.
        if (auto.input.checked) {
          auto.input.checked = false;
          hueSlider.setEnabled(true);
        }
        hue.onChange(h);
      },
    });
    hueSlider.setEnabled(!auto.input.checked);
    sliderWrap.appendChild(hueSlider.wrap);
    body.appendChild(sliderWrap);

    auto.input.addEventListener('change', () => {
      hueSlider.setEnabled(!auto.input.checked);
      if (hue.onAutoToggle) hue.onAutoToggle(auto.input.checked);
    });

    const divider = document.createElement('div');
    divider.className = 'tp-panel__divider';
    body.appendChild(divider);
  }

  // Master toggle row — flips every effect at once.
  const sectionLabel = document.createElement('div');
  sectionLabel.className = 'tp-panel__section-label';
  sectionLabel.textContent = 'Toggles';
  body.appendChild(sectionLabel);

  const master = makeToggleRow({ label: 'All effects', checked: true, master: true });
  body.appendChild(master.row);

  const rowState = []; // { effect, input }

  for (const effect of effects) {
    const t = makeToggleRow({
      label: effect.name,
      checked: effect.initiallyOn !== false,
    });
    body.appendChild(t.row);

    t.input.addEventListener('change', () => {
      try { effect.onChange(t.input.checked); }
      catch (err) { console.error(`[effects-panel] ${effect.name}.onChange threw:`, err); }
      // Keep the master in a sane state — checked iff every individual is on.
      master.input.checked = rowState.every(r => r.input.checked);
    });

    // Apply the initial state immediately so the world matches the panel.
    try { effect.onChange(t.input.checked); }
    catch (err) { console.error(`[effects-panel] ${effect.name}.onChange (initial) threw:`, err); }

    rowState.push({ effect, input: t.input });
  }

  master.input.addEventListener('change', () => {
    const v = master.input.checked;
    for (const { effect, input } of rowState) {
      input.checked = v;
      try { effect.onChange(v); }
      catch (err) { console.error(`[effects-panel] ${effect.name}.onChange (master) threw:`, err); }
    }
  });

  document.body.appendChild(root);

  if (!visible) root.style.display = 'none';

  window.addEventListener('keydown', (e) => {
    if (e.code !== hotkey) return;
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
    setVisibleInternal(!visible);
  });

  return {
    setVisible: setVisibleInternal,
    dispose() { root.remove(); },
    // For console: __effectsPanel.set('Nebula', false)
    set(name, on) {
      const r = rowState.find(({ effect }) => effect.name === name);
      if (!r) return;
      r.input.checked = !!on;
      r.input.dispatchEvent(new Event('change'));
    },
    // Sync dropdown if stage changed via console / event.
    syncStage(name) {
      if (stageSelect && name && stageSelect.value !== name) stageSelect.value = name;
    },
    // Sync hue slider + auto toggle if the override changed elsewhere
    // (e.g. `__hue(280)` from console). Pass null/undefined hue to mean
    // "auto mode active"; pass a number to display + force auto off.
    syncHue(value) {
      if (!hueSlider) return;
      if (value == null) {
        if (autoToggleInput && !autoToggleInput.checked) {
          autoToggleInput.checked = true;
          hueSlider.setEnabled(false);
        }
        return;
      }
      hueSlider.setValue(value);
      if (autoToggleInput && autoToggleInput.checked) {
        autoToggleInput.checked = false;
        hueSlider.setEnabled(true);
      }
    },
  };
}
