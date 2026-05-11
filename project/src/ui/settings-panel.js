// Settings panel — plan_UI_1.md §3.3.
//
// One CSS3D panel with four tabs (Effects, Audio, Mode, Stats). Lives in
// the same `cssScene` as the existing HUD panels (Score / Lines / Next /
// Hold). Drag + rotate via `makeDraggableRotatable`; show/hide via the
// gear button + `O` key.
//
// The module is pure DOM construction — it never reaches into the scene
// or audio bus directly. Callers wire the actual game state through a
// flat config of `{ value, onChange }` slots per control. This keeps the
// settings UI testable and lets future tabs land without touching main.js.
//
// Caller responsibilities:
//   - mount the returned `obj` (a CSS3DObject) into a scene
//   - drive the show/hide animation by calling `update(dt)` per frame
//   - persist returned `pose` snapshots via the storage module

import { CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import {
  installPanelStyles,
  makePanelHeader,
  makeToggleRow,
  makeSliderRow,
  makeSegmentedRow,
} from './panel-shared.js';
import { makeDraggableRotatable } from './draggable-rotatable.js';
import {
  formatModeBestPrimary,
  formatModeBestSecondary,
  formatModeBestModern,
  formatModeBestSummary,
  formatModeGoalAndDuration,
  formatTimeFriendly,
} from './format/mode-stats.js';

const PANEL_WIDTH_PX  = 360;
const PANEL_HEIGHT_PX = 480;
const WORLD_SCALE     = 0.025;

/**
 * @typedef {Object} SliderSpec
 * @property {string}   label
 * @property {number}   min
 * @property {number}   max
 * @property {number}   [step]
 * @property {number}   value
 * @property {(v: number) => void} onChange
 * @property {(v: number) => string} [format]
 */

/**
 * @typedef {Object} SettingsPanelConfig
 * @property {THREE.Camera}      camera
 * @property {{enabled: boolean}} [controls]   OrbitControls
 * @property {{x:number,y:number,z:number,yaw?:number,pitch?:number,hidden?:boolean}} [initialPose]
 * @property {(pose: {x:number,y:number,z:number,yaw:number,pitch:number}) => void} [onPoseChange]
 *
 * @property {{
 *   shatterPower: SliderSpec,
 *   bloom:        SliderSpec,
 *   shakeMul:     SliderSpec,
 *   slowmoMul:    SliderSpec,
 *   trailMul:     SliderSpec,
 *   rimGlowMul:   SliderSpec,
 *   mood: { value: string, choices: Array<{value:string,label:string}>, onChange: (v:string)=>void },
 *   particleQuality: { value: string, choices: Array<{value:string,label:string}>, onChange: (v:string)=>void },
 *   vignette: { value: boolean, onChange: (v:boolean)=>void },
 *   onResetEffects?: () => void,
 * }} effects
 *
 * @property {{
 *   muted: { value: boolean, onChange: (v:boolean)=>void },
 *   bgm:   SliderSpec,
 *   voice: SliderSpec,
 *   sfx:   SliderSpec,
 *   onTestAnnouncer?: () => void,
 *   onTestSfx?: () => void,
 * }} audio
 *
 * @property {{
 *   current: string,
 *   available: ReadonlyArray<string>,
 *   labels: Record<string, string>,
 *   descriptions?: Record<string, string>,
 *   disabled?: Record<string, boolean>,
 *   onSelect: (m: string) => void,
 *   onStart?: () => void,
 *   onChange?: (handler: (m:string)=>void) => () => void,
 * }} mode
 *
 * @property {{
 *   load: () => any,
 *   reset: () => void,
 *   formatTime?: (ms:number) => string,
 * }} stats
 */

/**
 * @param {SettingsPanelConfig} cfg
 */
export function createSettingsPanel(cfg) {
  installPanelStyles();

  const root = document.createElement('div');
  root.id = 'settings-panel';
  root.className = 'tp-panel';
  root.style.width  = `${PANEL_WIDTH_PX}px`;
  // CSS3D positioning is via the CSS3DObject; fixed-positioning rules from
  // .tp-panel don't apply here. Override.
  root.style.position = 'static';
  root.style.maxHeight = `${PANEL_HEIGHT_PX}px`;
  root.style.boxSizing = 'border-box';
  root.style.pointerEvents = 'auto';
  root.style.cursor = 'grab';
  root.style.transformOrigin = 'center center';

  // === Header — drag handle + close ====================================
  const header = makePanelHeader({
    title: 'Settings',
    hotkey: 'O',
    onClose: () => api.close(),
  });
  // Tag the header for double-click reset + visual cursor cue.
  header.dataset.grab = 'header';
  header.style.cursor = 'grab';
  root.appendChild(header);

  // === Tab bar =========================================================
  const tabBar = document.createElement('div');
  tabBar.className = 'tp-tab-bar';
  root.appendChild(tabBar);

  const TAB_DEFS = [
    { key: 'effects',    label: 'Effects' },
    { key: 'audio',      label: 'Audio' },
    { key: 'visualizer', label: 'Spiral' },
    { key: 'mode',       label: 'Mode' },
    { key: 'stats',      label: 'Stats' },
  ];

  // Tab content area — body for each pane sits inside this scrolling box.
  const content = document.createElement('div');
  content.style.cssText = 'overflow:auto; max-height: 400px; padding: 2px 2px 6px; pointer-events:auto;';
  root.appendChild(content);

  const panes = {};

  // Tab buttons emit the active-state via `data-active-tab` on root, then
  // we toggle the `.is-active` class on each pane to show/hide.
  let activeTab = 'effects';
  function setActiveTab(key) {
    activeTab = key;
    for (const t of TAB_DEFS) {
      const tabBtn = tabBar.querySelector(`[data-tab="${t.key}"]`);
      if (tabBtn) tabBtn.classList.toggle('is-active', t.key === key);
      if (panes[t.key]) panes[t.key].classList.toggle('is-active', t.key === key);
    }
    if (key === 'stats') refreshStats();
  }

  for (const t of TAB_DEFS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tp-tab' + (t.key === activeTab ? ' is-active' : '');
    btn.dataset.tab = t.key;
    btn.textContent = t.label;
    btn.addEventListener('click', () => setActiveTab(t.key));
    tabBar.appendChild(btn);
  }

  // === Effects tab =====================================================
  const effectsPane = document.createElement('div');
  effectsPane.className = 'tp-tab-pane is-active';
  panes.effects = effectsPane;
  content.appendChild(effectsPane);

  const effectsControls = {};
  function appendEffectSlider(key, spec) {
    const r = makeSliderRow({
      label:    spec.label,
      min:      spec.min,
      max:      spec.max,
      step:     spec.step != null ? spec.step : 0.01,
      value:    spec.value,
      onChange: spec.onChange,
      onInput:  spec.onInput,
      format:   spec.format,
    });
    effectsControls[key] = r;
    effectsPane.appendChild(r.row);
  }
  appendEffectSlider('shatterPower', cfg.effects.shatterPower);
  appendEffectSlider('bloom',        cfg.effects.bloom);
  appendEffectSlider('shakeMul',     cfg.effects.shakeMul);
  appendEffectSlider('slowmoMul',    cfg.effects.slowmoMul);
  appendEffectSlider('trailMul',     cfg.effects.trailMul);
  appendEffectSlider('rimGlowMul',   cfg.effects.rimGlowMul);

  // Mood preset (segmented).
  const moodCtl = makeSegmentedRow({
    label: 'Glass mood',
    choices: cfg.effects.mood.choices,
    value:   cfg.effects.mood.value,
    onChange: cfg.effects.mood.onChange,
  });
  effectsControls.mood = moodCtl;
  effectsPane.appendChild(moodCtl.row);

  // Particle quality (segmented).
  const pqCtl = makeSegmentedRow({
    label: 'Particles',
    choices: cfg.effects.particleQuality.choices,
    value:   cfg.effects.particleQuality.value,
    onChange: cfg.effects.particleQuality.onChange,
  });
  effectsControls.particleQuality = pqCtl;
  effectsPane.appendChild(pqCtl.row);

  // Vignette toggle (CSS switch, label on left).
  const vigToggle = makeToggleRow({
    label: 'Vignette',
    checked: cfg.effects.vignette.value,
  });
  effectsControls.vignette = vigToggle;
  vigToggle.input.addEventListener('change', () => cfg.effects.vignette.onChange(vigToggle.input.checked));
  effectsPane.appendChild(vigToggle.row);

  // Reset Effects button.
  const resetEffectsRow = document.createElement('div');
  resetEffectsRow.style.cssText = 'display:flex; justify-content:flex-end; padding:8px 4px 0;';
  const resetEffectsBtn = document.createElement('button');
  resetEffectsBtn.type = 'button';
  resetEffectsBtn.className = 'tp-button';
  resetEffectsBtn.textContent = 'Reset effects';
  resetEffectsBtn.addEventListener('click', () => {
    if (cfg.effects.onResetEffects) cfg.effects.onResetEffects();
  });
  resetEffectsRow.appendChild(resetEffectsBtn);
  effectsPane.appendChild(resetEffectsRow);

  // === Audio tab =======================================================
  const audioPane = document.createElement('div');
  audioPane.className = 'tp-tab-pane';
  panes.audio = audioPane;
  content.appendChild(audioPane);

  const muteToggle = makeToggleRow({
    label: 'Master mute',
    checked: cfg.audio.muted.value,
  });
  muteToggle.input.addEventListener('change', () => cfg.audio.muted.onChange(muteToggle.input.checked));
  audioPane.appendChild(muteToggle.row);

  const audioControls = { muted: muteToggle };
  function appendAudioSlider(key, spec) {
    const r = makeSliderRow({
      label: spec.label, min: spec.min, max: spec.max,
      step: spec.step != null ? spec.step : 0.01,
      value: spec.value, onChange: spec.onChange, onInput: spec.onInput,
      format: spec.format,
    });
    audioControls[key] = r;
    audioPane.appendChild(r.row);
  }
  appendAudioSlider('bgm',   cfg.audio.bgm);
  appendAudioSlider('voice', cfg.audio.voice);
  appendAudioSlider('sfx',   cfg.audio.sfx);

  // Test buttons.
  const testRow = document.createElement('div');
  testRow.style.cssText = 'display:flex; gap:8px; padding:8px 4px 0;';
  const testAnnounce = document.createElement('button');
  testAnnounce.type = 'button';
  testAnnounce.className = 'tp-button';
  testAnnounce.textContent = 'Test announcer';
  testAnnounce.addEventListener('click', () => cfg.audio.onTestAnnouncer && cfg.audio.onTestAnnouncer());
  const testSfx = document.createElement('button');
  testSfx.type = 'button';
  testSfx.className = 'tp-button';
  testSfx.textContent = 'Test SFX';
  testSfx.addEventListener('click', () => cfg.audio.onTestSfx && cfg.audio.onTestSfx());
  testRow.appendChild(testAnnounce);
  testRow.appendChild(testSfx);
  audioPane.appendChild(testRow);

  // === Visualizer (Spiral) tab =========================================
  // Live tuning of the muon-original visualizer's most player-facing
  // parameters. Underlying `params` object is mutated in place; muon's
  // CoreControls.redrawGeometry picks up geometry changes (maxPoints /
  // colorSpectrum / aperture / spacing) on the next tick automatically.
  const visualizerPane = document.createElement('div');
  visualizerPane.className = 'tp-tab-pane';
  panes.visualizer = visualizerPane;
  content.appendChild(visualizerPane);

  if (cfg.visualizer) {
    const v = cfg.visualizer;
    const sectionLabel = (text) => {
      const el = document.createElement('div');
      el.className = 'tp-panel__section-label';
      el.textContent = text;
      el.style.cssText += 'margin-top:8px;';
      return el;
    };
    const addSlider = (spec) => {
      const r = makeSliderRow(spec);
      visualizerPane.appendChild(r.row);
      return r;
    };
    const addToggle = (spec) => {
      const t = makeToggleRow({ label: spec.label, checked: spec.value });
      t.input.addEventListener('change', () => spec.onChange(t.input.checked));
      visualizerPane.appendChild(t.row);
      return t;
    };

    // --- Mode ------------------------------------------------------------
    visualizerPane.appendChild(sectionLabel('Mode'));
    if (v.mode) {
      const modeCtl = makeSegmentedRow({
        label: 'Display',
        choices: v.mode.choices,
        value: v.mode.value,
        onChange: v.mode.onChange,
      });
      visualizerPane.appendChild(modeCtl.row);
    }

    // --- Audio source ----------------------------------------------------
    visualizerPane.appendChild(sectionLabel('Audio source'));
    addToggle({
      label: 'Use FeatureBus (vs Muon native)',
      value: v.useFeatureBus.value,
      onChange: v.useFeatureBus.onChange,
    });

    // --- Geometry --------------------------------------------------------
    visualizerPane.appendChild(sectionLabel('Geometry'));
    addSlider({
      label: 'Particle count', min: 360, max: 12240, step: 360,
      value: v.maxPoints.value, onChange: v.maxPoints.onChange,
      format: (n) => n.toFixed(0),
    });
    addSlider({
      label: 'Color spectrum', min: 3, max: 30, step: 1,
      value: v.colorSpectrum.value, onChange: v.colorSpectrum.onChange,
      format: (n) => n.toFixed(0),
    });
    addSlider({
      label: 'Aperture', min: 0, max: Math.PI, step: 0.01,
      value: v.aperture.value, onChange: v.aperture.onChange,
    });
    addSlider({
      label: 'Spacing', min: 0, max: 1, step: 0.01,
      value: v.spacing.value, onChange: v.spacing.onChange,
    });
    addToggle({
      label: 'Mirror spiral',
      value: v.particleMirror.value, onChange: v.particleMirror.onChange,
    });
    addToggle({
      label: 'Auto-morph on bass',
      value: v.visualizationPreset.value, onChange: v.visualizationPreset.onChange,
    });

    // --- Dust emitter ----------------------------------------------------
    visualizerPane.appendChild(sectionLabel('Dust emitter'));
    addSlider({
      label: 'Divisions', min: 1, max: 150, step: 1,
      value: v.divisions.value, onChange: v.divisions.onChange,
      format: (n) => n.toFixed(0),
    });
    addSlider({
      label: 'Lifespan', min: 10, max: 250, step: 1,
      value: v.lifespan.value, onChange: v.lifespan.onChange,
      format: (n) => n.toFixed(0),
    });
    addSlider({
      label: 'Noise scale', min: 0, max: 2, step: 0.01,
      value: v.noiseScale.value, onChange: v.noiseScale.onChange,
    });

    // --- Color -----------------------------------------------------------
    visualizerPane.appendChild(sectionLabel('Color'));
    addToggle({
      label: 'Sync dust to spiral hue',
      value: v.syncColors.value, onChange: v.syncColors.onChange,
    });
    addToggle({
      label: 'Mono color (override hue cycle)',
      value: v.enableMonoColor.value, onChange: v.enableMonoColor.onChange,
    });
    addSlider({
      label: 'Mono hue', min: 0, max: 360, step: 1,
      value: v.monoColor.h.value, onChange: v.monoColor.h.onChange,
      format: (n) => `${n.toFixed(0)}°`,
    });
  } else {
    const note = document.createElement('div');
    note.className = 'tp-status';
    note.textContent = 'Visualizer not initialised.';
    visualizerPane.appendChild(note);
  }

  // === Mode tab ========================================================
  const modePane = document.createElement('div');
  modePane.className = 'tp-tab-pane';
  panes.mode = modePane;
  content.appendChild(modePane);

  // Phase 7 — per-mode info panel above the button grid: goal text +
  // estimated duration + a one-line "Personal best" summary that updates
  // when the player switches modes. Static "Modes coming soon" note is
  // gone — every mode now plays its own rules.
  const modeInfo = document.createElement('div');
  modeInfo.className = 'tp-mode-info';
  modeInfo.style.cssText = 'padding:6px 6px 8px; margin-bottom:8px; ' +
    'border-bottom:1px solid rgba(255,255,255,0.06);';

  const modeInfoTitle = document.createElement('div');
  modeInfoTitle.style.cssText = 'font-size:13px; color:var(--accent, #6cf0ff); ' +
    'font-weight:500; letter-spacing:0.04em; margin-bottom:2px;';
  const modeInfoGoal = document.createElement('div');
  modeInfoGoal.style.cssText = 'font-size:11px; color:var(--ink, #f3f5fb); ' +
    'opacity:0.85; letter-spacing:0.03em;';
  const modeInfoDuration = document.createElement('div');
  modeInfoDuration.style.cssText = 'font-size:10px; color:var(--muted, #8b93ad); ' +
    'opacity:0.65; letter-spacing:0.06em; margin-top:1px;';
  const modeInfoBest = document.createElement('div');
  modeInfoBest.style.cssText = 'font-size:10.5px; color:var(--muted, #8b93ad); ' +
    'margin-top:6px; font-family:"SF Mono", ui-monospace, Menlo, Consolas, monospace; ' +
    'letter-spacing:0.04em; font-variant-numeric:tabular-nums;';
  modeInfo.appendChild(modeInfoTitle);
  modeInfo.appendChild(modeInfoGoal);
  modeInfo.appendChild(modeInfoDuration);
  modeInfo.appendChild(modeInfoBest);
  modePane.appendChild(modeInfo);

  function _refreshModeInfo(mKey) {
    const label = cfg.mode.labels[mKey] || mKey;
    modeInfoTitle.textContent = `Mode · ${label}`;
    if (cfg.mode.config) {
      const cfgEntry = cfg.mode.config(mKey) || {};
      const goalDur = formatModeGoalAndDuration(mKey, cfgEntry);
      modeInfoGoal.textContent = `Goal: ${goalDur.goal}`;
      modeInfoDuration.textContent = goalDur.duration ? `Estimated duration: ${goalDur.duration}` : 'Endless — runs until topout or forfeit';
    } else {
      modeInfoGoal.textContent = '';
      modeInfoDuration.textContent = '';
    }
    if (cfg.stats && typeof cfg.stats.load === 'function') {
      const stats = cfg.stats.load();
      const best = (stats.modeBests && stats.modeBests[mKey]) || {};
      modeInfoBest.textContent = `Personal best: ${formatModeBestSummary(mKey, best)}`;
    } else {
      modeInfoBest.textContent = '';
    }
  }

  // Render the 6 modes in a 3x2 grid for readable, balanced layout.
  const modeGrid = document.createElement('div');
  modeGrid.style.cssText = 'display:grid; grid-template-columns: 1fr 1fr 1fr; gap:6px; padding:4px;';
  const modeButtons = new Map();
  for (const m of cfg.mode.available) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tp-segmented__btn';
    btn.textContent = cfg.mode.labels[m] || m;
    if (cfg.mode.disabled && cfg.mode.disabled[m]) btn.disabled = true;
    if (m === cfg.mode.current) btn.classList.add('is-active');
    btn.addEventListener('click', () => {
      if (cfg.mode.disabled && cfg.mode.disabled[m]) return;
      _setModeActive(m);
      cfg.mode.onSelect(m);
    });
    modeButtons.set(m, btn);
    modeGrid.appendChild(btn);
  }
  // Start button — declared above _setModeActive so the active-mode
  // dispatcher can update its label in one place.
  const startRow = document.createElement('div');
  startRow.style.cssText = 'display:flex; justify-content:center; padding:14px 4px 4px;';
  const startBtn = document.createElement('button');
  startBtn.type = 'button';
  startBtn.className = 'tp-button tp-button--primary';

  // Versus-only options block — visible only when mode === 'versus'.
  // Currently hosts the bot-strength dropdown (§3.7 sub-phase 7e
  // polish); future per-mode options (Sprint variants, Versus time-out
  // toggle) can pile in here following the same show/hide pattern.
  const versusOptions = document.createElement('div');
  versusOptions.style.cssText = 'display:none; flex-direction:column; gap:6px; ' +
    'padding: 8px 10px; margin: 6px 4px 0; border-left: 2px solid var(--accent, #6cf0ff); ' +
    'background: rgba(108, 240, 255, 0.04); border-radius: 0 4px 4px 0;';
  const versusOptionsLabel = document.createElement('div');
  versusOptionsLabel.style.cssText = 'font-size:11px; color:var(--accent, #6cf0ff); ' +
    'letter-spacing:0.12em; text-transform:uppercase; opacity:0.85;';
  versusOptionsLabel.textContent = 'Versus';
  versusOptions.appendChild(versusOptionsLabel);

  const botRow = document.createElement('label');
  botRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; ' +
    'gap:10px; font-size:11px; color:var(--ink, #f3f5fb);';
  const botRowText = document.createElement('span');
  botRowText.textContent = 'Bot strength';
  botRowText.style.cssText = 'opacity:0.85;';
  const botRowSelect = document.createElement('select');
  botRowSelect.style.cssText = 'background:var(--bg2, rgba(0,0,0,0.4)); color:var(--ink, #f3f5fb); ' +
    'border:1px solid var(--rule, rgba(108,240,255,0.25)); border-radius:4px; ' +
    'padding:3px 6px; font-size:11px; cursor:pointer; outline:none;';
  const BOT_CHOICES = [
    { value: 'casual', label: 'Casual (heuristic)' },
    { value: 'random', label: 'Random (tutorial)' },
    { value: 'mirror', label: 'Mirror (sparring)' },
  ];
  const initialStrength = (cfg.versus && cfg.versus.botStrength) || 'casual';
  for (const c of BOT_CHOICES) {
    const opt = document.createElement('option');
    opt.value = c.value;
    opt.textContent = c.label;
    if (c.value === initialStrength) opt.selected = true;
    botRowSelect.appendChild(opt);
  }
  botRowSelect.addEventListener('change', () => {
    if (cfg.versus && typeof cfg.versus.onBotStrengthChange === 'function') {
      cfg.versus.onBotStrengthChange(botRowSelect.value);
    }
  });
  botRow.appendChild(botRowText);
  botRow.appendChild(botRowSelect);
  versusOptions.appendChild(botRow);

  function _setModeActive(m) {
    for (const [k, btn] of modeButtons) btn.classList.toggle('is-active', k === m);
    _refreshModeInfo(m);
    // Start-button label tracks the active mode so the action reads
    // honestly ("Start Marathon" vs "Start with selected mode" vague-speak).
    const label = cfg.mode.labels[m] || m;
    startBtn.textContent = `▶ Start ${label}`;
    // Versus-only options surface only when versus is the active mode.
    versusOptions.style.display = (m === 'versus') ? 'flex' : 'none';
  }
  _setModeActive(cfg.mode.current);
  modePane.appendChild(modeGrid);
  modePane.appendChild(versusOptions);

  // External mode-change subscription so console-side `__mode.select(...)`
  // syncs the dropdown.
  let modeUnsubscribe = null;
  if (cfg.mode.onChange) {
    modeUnsubscribe = cfg.mode.onChange((m) => _setModeActive(m));
  }

  startBtn.addEventListener('click', () => cfg.mode.onStart && cfg.mode.onStart());
  startRow.appendChild(startBtn);
  modePane.appendChild(startRow);

  // === Stats tab =======================================================
  const statsPane = document.createElement('div');
  statsPane.className = 'tp-tab-pane';
  panes.stats = statsPane;
  content.appendChild(statsPane);

  const statsBody = document.createElement('div');
  statsPane.appendChild(statsBody);

  // Phase 8 — friendly-time formatter delegated to the shared formatter
  // module; cfg.stats.formatTime is honored for legacy callers, but the
  // default now matches the rest of the project's time formatting.
  const formatTime = cfg.stats.formatTime || formatTimeFriendly;

  function fmtNumber(n) {
    return (n || 0).toLocaleString();
  }

  function refreshStats() {
    const s = cfg.stats.load();
    // Phase 7 — keep the Mode tab's "Personal best" line in sync. Cheap;
    // refreshStats() is called from main.js's endRun() and after the
    // confirm-reset button fires. The current mode key is whatever has
    // is-active in the button grid.
    let activeKey = cfg.mode.current;
    for (const [k, btn] of modeButtons) {
      if (btn.classList.contains('is-active')) { activeKey = k; break; }
    }
    _refreshModeInfo(activeKey);
    statsBody.innerHTML = '';
    // Hero row — high score.
    const hero = document.createElement('div');
    hero.className = 'tp-stat-row tp-stat-row--hero';
    hero.innerHTML = `
      <span class="tp-stat-row__label">High score</span>
      <span class="tp-stat-row__value">${fmtNumber(s.highScore)}</span>
    `;
    statsBody.appendChild(hero);

    // Per-mode bests — Phase 8: each row is `<label>  <primary>` plus a
    // muted secondary line below for context (attempts, time, etc.).
    // Sprint shows a time, Zen shows a duration, Versus shows W-L; the
    // shared formatter dispatches on mode key.
    const sectionA = document.createElement('div');
    sectionA.className = 'tp-panel__section-label';
    sectionA.style.marginTop = '12px';
    sectionA.textContent = 'Best by mode';
    statsBody.appendChild(sectionA);
    for (const m of cfg.mode.available) {
      const best = (s.modeBests && s.modeBests[m]) || {};
      const primary   = formatModeBestPrimary(m, best);
      const secondary = formatModeBestSecondary(m, best);
      // Plan v2 §1.1 — modern-rules tertiary line (Best B2B / combo /
      // perfect clears / T-spin clears / cancelled best). Only renders
      // when at least one modern field has a non-zero value, so a
      // fresh-install slot stays at the existing two-line layout.
      const modern    = formatModeBestModern(m, best);

      const row = document.createElement('div');
      row.className = 'tp-stat-row';
      row.innerHTML = `
        <span class="tp-stat-row__label">${cfg.mode.labels[m] || m}</span>
        <span class="tp-stat-row__value">${primary}</span>
      `;
      statsBody.appendChild(row);

      // Sub-row(s) — `secondary` and `modern` are independent. Render
      // each at the same indent + dim treatment as the existing
      // Phase-7 sub-row so the visual hierarchy reads "headline,
      // attempts/lines context, modern-rules milestones".
      const subStyle = 'padding-top:0; padding-bottom:6px; opacity:0.65; font-size:9.5px;';
      if (secondary) {
        const sub = document.createElement('div');
        sub.className = 'tp-stat-row';
        sub.style.cssText = subStyle;
        sub.innerHTML = `
          <span class="tp-stat-row__label" style="font-size:9.5px;"></span>
          <span class="tp-stat-row__value" style="font-size:9.5px;">${secondary}</span>
        `;
        statsBody.appendChild(sub);
      }
      if (modern) {
        const subM = document.createElement('div');
        subM.className = 'tp-stat-row';
        subM.style.cssText = subStyle;
        subM.innerHTML = `
          <span class="tp-stat-row__label" style="font-size:9.5px;"></span>
          <span class="tp-stat-row__value" style="font-size:9.5px;">${modern}</span>
        `;
        statsBody.appendChild(subM);
      }
    }

    // Totals.
    const sectionB = document.createElement('div');
    sectionB.className = 'tp-panel__section-label';
    sectionB.style.marginTop = '12px';
    sectionB.textContent = 'Totals';
    statsBody.appendChild(sectionB);
    const totals = s.totals || {};
    const totalRows = [
      { label: 'Lines cleared',  value: fmtNumber(totals.linesCleared) },
      { label: 'Pieces placed',  value: fmtNumber(totals.piecesPlaced) },
      { label: 'Time played',    value: formatTime(totals.playTimeMs || 0) },
    ];
    for (const r of totalRows) {
      const row = document.createElement('div');
      row.className = 'tp-stat-row';
      row.innerHTML = `
        <span class="tp-stat-row__label">${r.label}</span>
        <span class="tp-stat-row__value">${r.value}</span>
      `;
      statsBody.appendChild(row);
    }

    // Reset (confirm-twice).
    const resetRow = document.createElement('div');
    resetRow.style.cssText = 'display:flex; justify-content:flex-end; padding:14px 4px 0;';
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'tp-button tp-button--danger';
    resetBtn.textContent = 'Reset stats';
    let armed = false;
    let armTimer = null;
    resetBtn.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        resetBtn.textContent = 'Click again to confirm';
        resetBtn.classList.add('is-armed');
        if (armTimer) clearTimeout(armTimer);
        armTimer = setTimeout(() => {
          armed = false;
          resetBtn.textContent = 'Reset stats';
          resetBtn.classList.remove('is-armed');
        }, 2000);
        return;
      }
      // Confirmed — fire reset, then re-render.
      if (cfg.stats.reset) cfg.stats.reset();
      armed = false;
      if (armTimer) { clearTimeout(armTimer); armTimer = null; }
      refreshStats();
    });
    resetRow.appendChild(resetBtn);
    statsBody.appendChild(resetRow);
  }
  refreshStats();

  // === CSS3D + draggable wiring =======================================
  const obj = new CSS3DObject(root);
  // Default pose lives in the configured initialPose; persist through
  // cfg.onPoseChange whenever the player drags or rotates.
  const ip = cfg.initialPose || {};
  const defaultPose = {
    x:     ip.x     != null ? ip.x     : 0,
    y:     ip.y     != null ? ip.y     : 0,
    z:     ip.z     != null ? ip.z     : 6,
    yaw:   ip.yaw   != null ? ip.yaw   : 0,
    pitch: ip.pitch != null ? ip.pitch : 0,
  };
  obj.position.set(defaultPose.x, defaultPose.y, defaultPose.z);
  obj.rotation.set(defaultPose.pitch, defaultPose.yaw, 0);
  obj.scale.setScalar(WORLD_SCALE);
  obj.visible = false;            // start hidden — show only when toggled

  const dragger = makeDraggableRotatable(root, obj, {
    camera:   cfg.camera,
    controls: cfg.controls,
    defaultPose,
    onChange: cfg.onPoseChange,
  });

  // === Show/hide animation (Tier 3) ====================================
  // The animate loop ticks `update(dt)` which advances the entry/exit
  // tween. `visible = false` clamps after the exit to stop eating
  // pointer events.
  let tween = null; // { kind: 'in' | 'out', t: 0, dur: 0.2 }
  let visible = !(ip.hidden ?? true);
  obj.visible = visible;
  // Start at target scale if visible from boot.
  if (visible) root.style.opacity = '1';
  else { root.style.opacity = '0'; obj.scale.setScalar(WORLD_SCALE * 0.6); }

  function update(dt) {
    // Drive the dragger's reset-pose tween (300ms ease, plan §3.2). The
    // dragger has no internal clock — it depends on the panel's tick.
    dragger.update(dt);
    if (!tween) return;
    tween.t += dt;
    const k = Math.min(1, tween.t / tween.dur);
    const eased = 1 - Math.pow(1 - k, 3); // easeOutCubic
    if (tween.kind === 'in') {
      const s = WORLD_SCALE * (0.6 + 0.4 * eased);
      obj.scale.setScalar(s);
      root.style.opacity = String(eased);
    } else {
      const s = WORLD_SCALE * (1.0 - 0.4 * eased);
      obj.scale.setScalar(s);
      root.style.opacity = String(1 - eased);
    }
    if (k >= 1) {
      const finalKind = tween.kind;
      tween = null;
      if (finalKind === 'out') {
        obj.visible = false;
        visible = false;
      }
    }
  }

  function _emitVisibility() {
    if (cfg.onVisibilityChange) {
      try { cfg.onVisibilityChange(visible); }
      catch (err) { console.error('[settings] onVisibilityChange threw:', err); }
    }
  }
  function open() {
    if (visible && !tween) return;
    obj.visible = true;
    visible = true;
    tween = { kind: 'in', t: 0, dur: 0.2 };
    _emitVisibility();
  }
  function close() {
    if (!visible && !tween) return;
    tween = { kind: 'out', t: 0, dur: 0.2 };
    visible = false;
    _emitVisibility();
  }
  function toggle() { (visible ? close : open)(); }

  // === Public API ======================================================
  const api = {
    el: root,
    obj,
    /** Tab content panes — exposed so callers (main.js) can append
     *  custom controls (e.g. layer toggles, stage selector, hue slider)
     *  beyond what the structured config covers. */
    panes,
    open, close, toggle,
    update,
    refreshStats,
    setActiveTab,
    /** Snap every Effects-tab control to a fresh values object, with a
     *  brief CSS pulse so the player sees the change. Called by the
     *  "Reset effects" button after it rewinds TWEAKS — the caller
     *  passes the current TWEAKS / pass values explicitly because the
     *  cfg snapshot is frozen at construction time. */
    refreshEffects(values) {
      const v = values || {};
      if (v.shatterPower    != null) effectsControls.shatterPower.setValue(v.shatterPower,    { silent: true, pulse: true });
      if (v.bloom           != null) effectsControls.bloom.setValue(v.bloom,                  { silent: true, pulse: true });
      if (v.shakeMul        != null) effectsControls.shakeMul.setValue(v.shakeMul,            { silent: true, pulse: true });
      if (v.slowmoMul       != null) effectsControls.slowmoMul.setValue(v.slowmoMul,          { silent: true, pulse: true });
      if (v.trailMul        != null) effectsControls.trailMul.setValue(v.trailMul,            { silent: true, pulse: true });
      if (v.rimGlowMul      != null) effectsControls.rimGlowMul.setValue(v.rimGlowMul,        { silent: true, pulse: true });
      if (v.mood            != null) effectsControls.mood.setValue(v.mood,                    { silent: true });
      if (v.particleQuality != null) effectsControls.particleQuality.setValue(v.particleQuality, { silent: true });
      if (v.vignette        != null) effectsControls.vignette.input.checked = !!v.vignette;
    },
    /** Sync mute toggle when external code (the 🔊 button) flips it. */
    syncMute(muted) {
      if (muteToggle.input.checked !== muted) muteToggle.input.checked = muted;
    },
    /** Sync mode buttons when console / event-driven changes happen. */
    syncMode(m) { _setModeActive(m); },
    get isOpen() { return visible; },
    dispose() {
      if (modeUnsubscribe) modeUnsubscribe();
      dragger.dispose();
      root.remove();
    },
  };
  return api;
}
