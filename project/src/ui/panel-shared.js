// Shared chrome for floating dev/inspection panels — effects panel and
// FeatureBus debug overlay.
//
// Implements the v1 design vocabulary documented in `document/plan_UI_1.md`
// (§4 visual / interaction details), scoped to the two surfaces that already
// exist. Toggle switches replace native checkboxes; cyan accent + glass
// chrome match the help/HUD/game-over panels in tetris.html.
//
// Pure DOM. The full 4-tab CSS3D settings panel from the plan is a larger
// piece of work; this module is the design-language seed both surfaces
// adopt now so when the bigger panel lands they all read as one family.

let _installed = false;

/**
 * Inject the shared panel stylesheet exactly once. Subsequent calls are
 * no-ops, so each panel module can call it eagerly without coordinating.
 */
export function installPanelStyles() {
  if (_installed) return;
  _installed = true;

  const css = `
    /* === TetrisPlus floating panel — shared chrome (panel-shared.js) === */

    .tp-panel {
      position: fixed;
      z-index: 50;
      min-width: 220px;
      padding: 12px 14px 10px;
      background: rgba(10, 14, 24, 0.58);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45),
                  inset 0 0 60px rgba(108, 240, 255, 0.025);
      color: var(--ink, #f3f5fb);
      font-family: ui-sans-serif, system-ui, -apple-system,
                   "SF Pro Display", "Helvetica Neue", Arial, sans-serif;
      font-size: 12px;
      line-height: 1.5;
      user-select: none;
      backdrop-filter: blur(10px) saturate(140%);
      -webkit-backdrop-filter: blur(10px) saturate(140%);
    }

    /* Header — mark + title + drag-handle hint + close button.
       The drag handle is a visual cue for the planned settings panel; here
       it's decorative — these two surfaces don't drag yet. */
    .tp-panel__header {
      display: flex;
      align-items: baseline;
      gap: 8px;
      margin-bottom: 10px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .tp-panel__mark {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      letter-spacing: 0.18em;
      font-size: 9.5px;
      color: var(--muted, #8b93ad);
      text-transform: uppercase;
    }
    .tp-panel__title {
      font-weight: 600;
      font-size: 11px;
      letter-spacing: 0.04em;
      color: var(--ink, #f3f5fb);
      flex: 1;
    }
    .tp-panel__hotkey {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 9.5px;
      letter-spacing: 0.12em;
      color: var(--muted, #8b93ad);
      opacity: 0.7;
      text-transform: uppercase;
    }
    .tp-panel__close {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: transparent;
      color: var(--muted, #8b93ad);
      font-size: 12px;
      line-height: 1;
      padding: 0;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s, border-color 0.15s, background 0.15s;
    }
    .tp-panel__close:hover {
      color: var(--ink, #f3f5fb);
      border-color: rgba(108, 240, 255, 0.45);
      background: rgba(108, 240, 255, 0.08);
    }

    .tp-panel__body { display: block; }
    .tp-panel__divider {
      height: 1px;
      margin: 8px 0;
      background: rgba(255, 255, 255, 0.06);
    }
    .tp-panel__section-label {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      font-size: 9.5px;
      color: var(--muted, #8b93ad);
      opacity: 0.85;
      margin: 4px 0 6px;
    }

    /* Row — flex container for "label + control" lines. */
    .tp-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 4px 4px;
      border-radius: 5px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .tp-row:hover { background: rgba(255, 255, 255, 0.03); }
    .tp-row__label {
      flex: 1;
      font-size: 12px;
      color: var(--ink, #f3f5fb);
    }
    .tp-row--master .tp-row__label { font-weight: 600; }
    .tp-row--master {
      margin-bottom: 4px;
      padding-bottom: 8px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }

    /* CSS toggle switch — replaces native checkbox per plan §4. */
    .tp-toggle__input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
      width: 0;
      height: 0;
    }
    .tp-toggle {
      position: relative;
      display: inline-block;
      width: 28px;
      height: 16px;
      flex: 0 0 auto;
      border-radius: 9px;
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.10);
      transition: background 0.18s, border-color 0.18s;
    }
    .tp-toggle__thumb {
      position: absolute;
      top: 1px;
      left: 1px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #cbd5ff;
      transition: left 0.18s ease, background 0.18s;
    }
    .tp-toggle__input:checked + .tp-toggle {
      background: rgba(108, 240, 255, 0.22);
      border-color: rgba(108, 240, 255, 0.50);
    }
    .tp-toggle__input:checked + .tp-toggle .tp-toggle__thumb {
      left: 13px;
      background: var(--accent, #6cf0ff);
      box-shadow: 0 0 8px rgba(108, 240, 255, 0.55);
    }
    .tp-toggle__input:focus-visible + .tp-toggle {
      outline: 2px solid rgba(108, 240, 255, 0.55);
      outline-offset: 2px;
    }

    /* Hue slider — RPG-style horizontal hue strip. The track shows the
       full HSL hue spectrum; the thumb sits at the chosen hue. Native
       <input type="range"> for free drag/touch/keyboard accessibility;
       custom thumb styling keeps the chrome consistent with the panel. */
    .tp-hue-slider {
      width: 100%;
      height: 22px;
      appearance: none;
      -webkit-appearance: none;
      background: linear-gradient(to right,
        hsl(0,   90%, 50%), hsl(30,  90%, 50%), hsl(60,  90%, 50%),
        hsl(90,  90%, 50%), hsl(120, 90%, 50%), hsl(150, 90%, 50%),
        hsl(180, 90%, 50%), hsl(210, 90%, 50%), hsl(240, 90%, 50%),
        hsl(270, 90%, 50%), hsl(300, 90%, 50%), hsl(330, 90%, 50%),
        hsl(360, 90%, 50%));
      border: 1px solid rgba(255, 255, 255, 0.10);
      border-radius: 5px;
      outline: none;
      cursor: pointer;
      padding: 0;
    }
    .tp-hue-slider::-webkit-slider-thumb {
      appearance: none;
      -webkit-appearance: none;
      width: 8px;
      height: 26px;
      background: var(--ink, #f3f5fb);
      border: 1px solid rgba(0, 0, 0, 0.7);
      border-radius: 2px;
      cursor: grab;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.55), 0 0 6px rgba(0, 0, 0, 0.5);
    }
    .tp-hue-slider::-moz-range-thumb {
      width: 6px;
      height: 24px;
      background: var(--ink, #f3f5fb);
      border: 1px solid rgba(0, 0, 0, 0.7);
      border-radius: 2px;
      cursor: grab;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.55), 0 0 6px rgba(0, 0, 0, 0.5);
    }
    .tp-hue-slider:disabled {
      opacity: 0.42;
      cursor: not-allowed;
    }
    /* Preview gradient — shows the actual generated palette for the
       chosen hue. Sits below the slider so the player sees the resting
       result, not just the saturated hue indicator. */
    .tp-hue-preview {
      width: 100%;
      height: 8px;
      margin-top: 4px;
      border-radius: 3px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: #000;
    }
    .tp-hue-readout {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 9.5px;
      color: var(--muted, #8b93ad);
      font-variant-numeric: tabular-nums;
      min-width: 30px;
      text-align: right;
    }

    /* Segmented control — used by stage selector (and future tabs). */
    .tp-select {
      flex: 1;
      background: rgba(255, 255, 255, 0.05);
      color: var(--ink, #f3f5fb);
      border: 1px solid rgba(255, 255, 255, 0.10);
      border-radius: 6px;
      padding: 4px 8px;
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
    }
    .tp-select:hover, .tp-select:focus {
      border-color: rgba(108, 240, 255, 0.45);
      background: rgba(108, 240, 255, 0.05);
      outline: none;
    }

    /* === FeatureBus overlay specifics === */
    .tp-band-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 5px 0;
    }
    .tp-band-row__name {
      width: 48px;
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 10px;
      letter-spacing: 0.05em;
      color: var(--muted, #8b93ad);
    }
    .tp-band-row__track {
      flex: 1;
      height: 8px;
      background: rgba(255, 255, 255, 0.05);
      border-radius: 4px;
      position: relative;
      overflow: hidden;
    }
    .tp-band-row__bar-norm {
      position: absolute;
      inset: 0;
      width: 0%;
      background: rgba(108, 240, 255, 0.42);
      border-right: 1px solid rgba(108, 240, 255, 0.65);
    }
    .tp-band-row__bar-kick {
      position: absolute;
      inset: 0;
      width: 0%;
      background: linear-gradient(90deg, #ffd166, #ff5c8a);
      box-shadow: 0 0 6px rgba(255, 92, 138, 0.45);
      mix-blend-mode: screen;
    }
    .tp-band-row__val {
      width: 56px;
      text-align: right;
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 10px;
      color: var(--ink, #f3f5fb);
      opacity: 0.85;
      font-variant-numeric: tabular-nums;
    }

    .tp-legend {
      display: flex;
      gap: 12px;
      margin-top: 8px;
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 9.5px;
      letter-spacing: 0.04em;
      color: var(--muted, #8b93ad);
    }
    .tp-legend__swatch {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 2px;
      vertical-align: middle;
      margin-right: 4px;
    }

    .tp-status {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 10px;
      color: var(--muted, #8b93ad);
      opacity: 0.65;
      margin: 2px 0 8px;
    }
    .tp-status--ok    { color: var(--muted, #8b93ad); }
    .tp-status--warn  { color: #ff9c4a; opacity: 0.9; }
    .tp-status--err   { color: #ff5c8a; opacity: 0.9; }

    /* === Settings panel — tabs, sliders, segmented, buttons (plan_UI_1.md) === */
    .tp-tab-bar {
      display: flex;
      gap: 0;
      margin: 0 -2px 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .tp-tab {
      flex: 1;
      padding: 7px 4px;
      border: none;
      background: transparent;
      color: var(--muted, #8b93ad);
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 10px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      transition: color 0.15s, border-color 0.15s;
    }
    .tp-tab:hover { color: var(--ink, #f3f5fb); }
    .tp-tab.is-active {
      color: var(--accent, #6cf0ff);
      border-bottom-color: var(--accent, #6cf0ff);
    }

    .tp-tab-pane { display: none; }
    .tp-tab-pane.is-active { display: block; }

    /* Slider row — label / track / readout in one flex line. */
    .tp-slider-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 5px 4px;
    }
    .tp-slider-row__label {
      flex: 0 0 130px;
      font-size: 11px;
      color: var(--ink, #f3f5fb);
    }
    .tp-slider-row__readout {
      flex: 0 0 38px;
      text-align: right;
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 10px;
      color: var(--muted, #8b93ad);
      font-variant-numeric: tabular-nums;
    }
    .tp-slider {
      flex: 1;
      appearance: none;
      -webkit-appearance: none;
      height: 4px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 2px;
      outline: none;
      cursor: pointer;
    }
    .tp-slider::-webkit-slider-thumb {
      appearance: none;
      -webkit-appearance: none;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--accent, #6cf0ff);
      box-shadow: 0 0 8px rgba(108, 240, 255, 0.6);
      cursor: grab;
    }
    .tp-slider::-moz-range-thumb {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--accent, #6cf0ff);
      box-shadow: 0 0 8px rgba(108, 240, 255, 0.6);
      cursor: grab;
      border: none;
    }
    .tp-slider-track-pulse {
      animation: tp-pulse 0.42s ease-out;
    }
    @keyframes tp-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(108, 240, 255, 0.6); }
      50%  { box-shadow: 0 0 0 6px rgba(108, 240, 255, 0.0); }
      100% { box-shadow: 0 0 0 0 rgba(108, 240, 255, 0.0); }
    }

    /* Segmented button group — preset choice (mood, particle quality). */
    .tp-segmented {
      display: flex;
      gap: 4px;
      flex: 1;
    }
    .tp-segmented__btn {
      flex: 1;
      padding: 5px 8px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.10);
      border-radius: 4px;
      color: var(--muted, #8b93ad);
      font-family: inherit;
      font-size: 10px;
      letter-spacing: 0.10em;
      text-transform: uppercase;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s, background 0.15s;
    }
    .tp-segmented__btn:hover {
      color: var(--ink, #f3f5fb);
      border-color: rgba(108, 240, 255, 0.35);
    }
    .tp-segmented__btn.is-active {
      color: var(--accent, #6cf0ff);
      background: rgba(108, 240, 255, 0.10);
      border-color: rgba(108, 240, 255, 0.55);
      box-shadow: 0 0 12px rgba(108, 240, 255, 0.20);
    }

    /* Generic button — used by Reset / Test / Start. */
    .tp-button {
      padding: 7px 12px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 5px;
      color: var(--ink, #f3f5fb);
      font-family: inherit;
      font-size: 11px;
      letter-spacing: 0.06em;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s, background 0.15s;
    }
    .tp-button:hover {
      border-color: rgba(108, 240, 255, 0.45);
      background: rgba(108, 240, 255, 0.06);
    }
    .tp-button--primary {
      color: var(--accent, #6cf0ff);
      border-color: rgba(108, 240, 255, 0.50);
      background: rgba(108, 240, 255, 0.08);
    }
    .tp-button--danger {
      color: #ff8aa0;
      border-color: rgba(255, 138, 160, 0.45);
    }
    .tp-button--danger.is-armed {
      color: #fff;
      background: rgba(255, 138, 160, 0.20);
      animation: tp-pulse-danger 0.42s ease-out;
    }
    @keyframes tp-pulse-danger {
      0%   { box-shadow: 0 0 0 0 rgba(255, 92, 138, 0.6); }
      50%  { box-shadow: 0 0 0 6px rgba(255, 92, 138, 0.0); }
      100% { box-shadow: 0 0 0 0 rgba(255, 92, 138, 0.0); }
    }
    .tp-button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    /* Stats display rows. */
    .tp-stat-row {
      display: flex;
      justify-content: space-between;
      padding: 4px 4px;
      font-size: 11px;
    }
    .tp-stat-row__label {
      color: var(--muted, #8b93ad);
    }
    .tp-stat-row__value {
      color: var(--ink, #f3f5fb);
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-variant-numeric: tabular-nums;
    }
    .tp-stat-row--hero .tp-stat-row__value {
      color: var(--accent, #6cf0ff);
      font-size: 18px;
      text-shadow: 0 0 16px rgba(108, 240, 255, 0.4);
    }
    .tp-mode-note {
      margin-top: 12px;
      padding: 8px 10px;
      border: 1px dashed rgba(255, 255, 255, 0.10);
      border-radius: 5px;
      color: var(--muted, #8b93ad);
      font-size: 10px;
      letter-spacing: 0.05em;
      line-height: 1.5;
    }
  `;

  const style = document.createElement('style');
  style.id = 'tp-panel-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

/**
 * Build a panel header element with the standard mark/title/hotkey/close
 * layout, matching the plan's `⊙ ✕` chrome (close only — reset orientation
 * is reserved for the 3D settings panel).
 *
 * @param {Object} opts
 * @param {string} opts.title    Sans-serif title shown beside the mark.
 * @param {string} [opts.mark]   Uppercase mono mark; defaults to 'TETRIS+'.
 * @param {string} [opts.hotkey] Display string for the hotkey hint, e.g. 'E'.
 * @param {() => void} [opts.onClose] Called when the close (✕) is clicked.
 * @returns {HTMLElement}
 */
export function makePanelHeader({ title, mark = 'TETRIS+', hotkey, onClose } = {}) {
  const header = document.createElement('div');
  header.className = 'tp-panel__header';

  const markEl = document.createElement('span');
  markEl.className = 'tp-panel__mark';
  markEl.textContent = mark;
  header.appendChild(markEl);

  const titleEl = document.createElement('span');
  titleEl.className = 'tp-panel__title';
  titleEl.textContent = title;
  header.appendChild(titleEl);

  if (hotkey) {
    const hotkeyEl = document.createElement('span');
    hotkeyEl.className = 'tp-panel__hotkey';
    hotkeyEl.textContent = hotkey;
    header.appendChild(hotkeyEl);
  }

  if (onClose) {
    const close = document.createElement('button');
    close.className = 'tp-panel__close';
    close.type = 'button';
    close.title = 'Close';
    close.textContent = '✕';
    close.addEventListener('click', () => onClose());
    header.appendChild(close);
  }

  return header;
}

/**
 * Build a hue slider with a small preview gradient and degree readout.
 * The slider commits its value via `change` (release), not `input` —
 * continuous drag-events would thrash the palette texture cache.
 *
 * @param {Object} opts
 * @param {number} [opts.initial=200]    Initial hue 0..359.
 * @param {(hue: number) => void} opts.onChange  Called on slider release.
 * @param {(hue: number) => string} [opts.previewBackground]  Returns a CSS
 *   `background` value showing the gradient that the chosen hue produces.
 *   If omitted, the preview shows a saturated band of the chosen hue.
 * @returns {{
 *   wrap:    HTMLElement,
 *   slider:  HTMLInputElement,
 *   preview: HTMLElement,
 *   readout: HTMLElement,
 *   setValue: (hue: number) => void,
 *   setEnabled: (on: boolean) => void,
 * }}
 */
export function makeHueSlider({ initial = 200, onChange, previewBackground } = {}) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:0;flex:1;';

  const sliderRow = document.createElement('div');
  sliderRow.style.cssText = 'display:flex;align-items:center;gap:8px;';

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '359';
  slider.step = '1';
  slider.value = String(Math.round(initial));
  slider.className = 'tp-hue-slider';

  const readout = document.createElement('span');
  readout.className = 'tp-hue-readout';
  readout.textContent = `${Math.round(initial)}°`;

  sliderRow.appendChild(slider);
  sliderRow.appendChild(readout);
  wrap.appendChild(sliderRow);

  const preview = document.createElement('div');
  preview.className = 'tp-hue-preview';
  wrap.appendChild(preview);

  function updatePreview(hue) {
    if (previewBackground) {
      preview.style.background = previewBackground(hue);
    } else {
      preview.style.background = `hsl(${hue}, 90%, 50%)`;
    }
  }
  updatePreview(initial);

  // Live readout + preview during drag (cheap, no allocation), commit
  // the texture-thrashing onChange call only on release.
  slider.addEventListener('input', () => {
    const hue = parseInt(slider.value, 10);
    readout.textContent = `${hue}°`;
    updatePreview(hue);
  });
  slider.addEventListener('change', () => {
    const hue = parseInt(slider.value, 10);
    if (onChange) onChange(hue);
  });

  return {
    wrap,
    slider,
    preview,
    readout,
    setValue(hue) {
      const h = Math.round(((hue % 360) + 360) % 360);
      slider.value = String(h);
      readout.textContent = `${h}°`;
      updatePreview(h);
    },
    setEnabled(on) {
      slider.disabled = !on;
    },
  };
}

/**
 * Slider row — `[label] [range slider] [readout]`. Shared by every Effects/
 * Audio tab knob in the settings panel. Live readout updates on `input`,
 * commit (and `onChange`) fires on `change` (release) so heavy consumers
 * (re-baking textures, etc.) don't thrash on continuous drag.
 *
 * @param {Object} opts
 * @param {string}   opts.label
 * @param {number}   opts.min
 * @param {number}   opts.max
 * @param {number}   [opts.step=0.01]
 * @param {number}   opts.value
 * @param {(v: number) => void} opts.onChange  Commit on release.
 * @param {(v: number) => void} [opts.onInput] Live during drag (optional).
 * @param {(v: number) => string} [opts.format] Override default toFixed(2).
 * @returns {{ row: HTMLElement, slider: HTMLInputElement, readout: HTMLElement,
 *            setValue: (v: number, opts?: { silent?: boolean, pulse?: boolean }) => void }}
 */
export function makeSliderRow({
  label, min, max, step = 0.01, value,
  onChange, onInput,
  format = (v) => v.toFixed(2),
} = {}) {
  const row = document.createElement('div');
  row.className = 'tp-slider-row';

  const labelEl = document.createElement('span');
  labelEl.className = 'tp-slider-row__label';
  labelEl.textContent = label;
  row.appendChild(labelEl);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'tp-slider';
  slider.min = String(min);
  slider.max = String(max);
  slider.step = String(step);
  slider.value = String(value);

  const readout = document.createElement('span');
  readout.className = 'tp-slider-row__readout';
  readout.textContent = format(value);

  row.appendChild(slider);
  row.appendChild(readout);

  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    readout.textContent = format(v);
    if (onInput) onInput(v);
  });
  slider.addEventListener('change', () => {
    const v = parseFloat(slider.value);
    if (onChange) onChange(v);
  });

  return {
    row, slider, readout,
    setValue(v, { silent = false, pulse = false } = {}) {
      slider.value = String(v);
      readout.textContent = format(v);
      if (pulse) {
        slider.classList.remove('tp-slider-track-pulse');
        // Force reflow so removing + re-adding the class restarts the
        // animation. Without this, two pulses in quick succession see
        // only the first one.
        void slider.offsetWidth;
        slider.classList.add('tp-slider-track-pulse');
      }
      if (!silent && onChange) onChange(v);
    },
  };
}

/**
 * Segmented button row — exclusive selection across N labelled buttons.
 * Used by Mood preset, Particle quality, and the Mode tab's mode picker.
 *
 * @param {Object} opts
 * @param {Array<{ value: string, label: string, disabled?: boolean }>} opts.choices
 * @param {string} opts.value     Currently active choice.
 * @param {(value: string) => void} opts.onChange
 * @param {string} [opts.label]   If set, renders a `[label] [segmented]` row.
 * @returns {{ row: HTMLElement, buttons: Map<string, HTMLButtonElement>,
 *            setValue: (v: string, opts?: { silent?: boolean }) => void }}
 */
export function makeSegmentedRow({ choices, value, onChange, label } = {}) {
  const row = document.createElement('div');
  row.className = 'tp-slider-row';

  if (label) {
    const labelEl = document.createElement('span');
    labelEl.className = 'tp-slider-row__label';
    labelEl.textContent = label;
    row.appendChild(labelEl);
  }

  const seg = document.createElement('div');
  seg.className = 'tp-segmented';
  const buttons = new Map();
  for (const c of choices) {
    const btn = document.createElement('button');
    btn.className = 'tp-segmented__btn';
    btn.type = 'button';
    btn.textContent = c.label;
    if (c.disabled) btn.disabled = true;
    if (c.value === value) btn.classList.add('is-active');
    btn.addEventListener('click', () => {
      if (c.disabled) return;
      _setActive(c.value);
      if (onChange) onChange(c.value);
    });
    buttons.set(c.value, btn);
    seg.appendChild(btn);
  }
  row.appendChild(seg);

  function _setActive(v) {
    for (const [k, btn] of buttons) btn.classList.toggle('is-active', k === v);
  }

  return {
    row, buttons,
    setValue(v, { silent = false } = {}) {
      _setActive(v);
      if (!silent && onChange) onChange(v);
    },
  };
}

/**
 * Build a `<label>` containing the CSS toggle switch + caption text. Returns
 * { row, input } so callers can wire change handlers and read state.
 *
 * @param {Object} opts
 * @param {string} opts.label     Caption text.
 * @param {boolean} [opts.checked]
 * @param {boolean} [opts.master] Visually emphasizes the row (top-of-list).
 * @returns {{ row: HTMLLabelElement, input: HTMLInputElement }}
 */
export function makeToggleRow({ label, checked = false, master = false } = {}) {
  const row = document.createElement('label');
  row.className = master ? 'tp-row tp-row--master' : 'tp-row';

  const labelEl = document.createElement('span');
  labelEl.className = 'tp-row__label';
  labelEl.textContent = label;
  row.appendChild(labelEl);

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'tp-toggle__input';
  input.checked = !!checked;

  const track = document.createElement('span');
  track.className = 'tp-toggle';
  const thumb = document.createElement('span');
  thumb.className = 'tp-toggle__thumb';
  track.appendChild(thumb);

  row.appendChild(input);
  row.appendChild(track);

  return { row, input };
}
