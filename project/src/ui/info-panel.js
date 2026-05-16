// Info panel — replaces the old static `#help` block with a tabbed
// reference: Controls / Audio / Roadmap / Credits. Static content only;
// nothing here reaches into the scene, audio bus, or feature flags at
// runtime. Update copy in place when behavior changes.
//
// Lifecycle:
//   const panel = createInfoPanel({ root, toggleBtn });
//   panel.toggle();         // open / close
//   panel.open(tabKey);     // open with a specific tab focused
//   panel.close();
//
// The host is responsible for binding the H hotkey + `?` toolbar
// button — this module only owns DOM, styling, and tab state.

const TABS = [
  { key: 'controls',  label: 'Controls' },
  { key: 'audio',     label: 'Audio'    },
  { key: 'roadmap',   label: 'Roadmap'  },
  { key: 'credits',   label: 'Credits'  },
];

/**
 * @param {Object} opts
 * @param {HTMLElement} opts.root         Host element (#help).
 * @param {HTMLElement} [opts.toggleBtn]  Optional element whose `is-open`
 *                                        class follows the panel state.
 * @param {string}      [opts.initialTab] Default tab key.
 * @param {boolean}     [opts.openByDefault]
 */
export function createInfoPanel({
  root,
  toggleBtn,
  initialTab = 'controls',
  openByDefault = false,
} = {}) {
  if (!root) {
    return {
      toggle() {}, open() {}, close() {},
      isOpen: () => false,
      setActiveTab() {},
    };
  }

  installStyles();
  root.classList.add('tp-info');
  root.innerHTML = '';

  // ── Header ─────────────────────────────────────────────────────────
  const header = document.createElement('div');
  header.className = 'tp-info__header';
  header.innerHTML = `
    <span class="tp-info__title">TETRIS+ · Info</span>
    <span class="tp-info__hint">H</span>
    <button class="tp-info__close" type="button" aria-label="Close">×</button>
  `;
  root.appendChild(header);
  header.querySelector('.tp-info__close').addEventListener('click', () => api.close());

  // ── Tab bar ────────────────────────────────────────────────────────
  const tabBar = document.createElement('div');
  tabBar.className = 'tp-info__tabs';
  root.appendChild(tabBar);

  // ── Content frame ──────────────────────────────────────────────────
  const content = document.createElement('div');
  content.className = 'tp-info__content';
  root.appendChild(content);

  const panes = {};
  for (const t of TABS) {
    const pane = document.createElement('section');
    pane.className = 'tp-info__pane';
    pane.dataset.tab = t.key;
    pane.innerHTML = PANE_HTML[t.key] || '';
    content.appendChild(pane);
    panes[t.key] = pane;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tp-info__tab';
    btn.dataset.tab = t.key;
    btn.textContent = t.label;
    btn.addEventListener('click', () => api.setActiveTab(t.key));
    tabBar.appendChild(btn);
  }

  let activeTab = initialTab;
  let open = !!openByDefault;

  function syncDom() {
    root.classList.toggle('is-open', open);
    if (toggleBtn) toggleBtn.classList.toggle('is-open', open);
    for (const t of TABS) {
      const pane = panes[t.key];
      const btn  = tabBar.querySelector(`[data-tab="${t.key}"]`);
      const on = t.key === activeTab;
      if (pane) pane.classList.toggle('is-active', on);
      if (btn)  btn.classList.toggle('is-active', on);
    }
  }
  syncDom();

  const api = {
    toggle() { open = !open; syncDom(); },
    open(tab) {
      if (tab && PANE_HTML[tab]) activeTab = tab;
      open = true; syncDom();
    },
    close() { open = false; syncDom(); },
    isOpen: () => open,
    setActiveTab(key) {
      if (!PANE_HTML[key]) return;
      activeTab = key; syncDom();
    },
  };
  return api;
}

// ────────────────────────────────────────────────────────────────────
// Pane copy — kept in one place so updating the docs is one diff.
// Markup is plain HTML; styling is below.
// ────────────────────────────────────────────────────────────────────
const PANE_HTML = {
  controls: `
    <h4>Movement (2D modes)</h4>
    <table class="tp-info__keys">
      <tr><td>Move left / right</td><td><kbd>←</kbd> <kbd>→</kbd></td></tr>
      <tr><td>Soft drop</td><td><kbd>↓</kbd></td></tr>
      <tr><td>Hard drop</td><td><kbd>Space</kbd></td></tr>
      <tr><td>Rotate CW / CCW</td><td><kbd>↑</kbd> / <kbd>X</kbd> · <kbd>Z</kbd></td></tr>
      <tr><td>Hold piece</td><td><kbd>C</kbd> / <kbd>Shift</kbd></td></tr>
      <tr><td>Pause</td><td><kbd>P</kbd></td></tr>
    </table>

    <h4>3D mode (extras)</h4>
    <table class="tp-info__keys">
      <tr><td>Depth back / forward</td><td><kbd>↑</kbd> / <kbd>↓</kbd></td></tr>
      <tr><td>Pull toward viewer</td><td><kbd>Q</kbd></td></tr>
      <tr><td>Pitch (X axis)</td><td><kbd>W</kbd> / <kbd>S</kbd></td></tr>
      <tr><td>Yaw (Y axis)</td><td><kbd>A</kbd> / <kbd>D</kbd></td></tr>
      <tr><td>Spin (Z axis)</td><td><kbd>X</kbd> / <kbd>Z</kbd></td></tr>
    </table>

    <h4>Camera &amp; panels</h4>
    <table class="tp-info__keys">
      <tr><td>Orbit / pan / zoom</td><td>Drag · right-drag · scroll</td></tr>
      <tr><td>Reset camera</td><td><kbd>R</kbd></td></tr>
      <tr><td>Settings panel</td><td><kbd>O</kbd> · <span class="tp-info__chip">⚙</span></td></tr>
      <tr><td>This help</td><td><kbd>H</kbd> · <span class="tp-info__chip">?</span></td></tr>
      <tr><td>Mute audio</td><td><span class="tp-info__chip">🔊</span></td></tr>
      <tr><td>BGM playlist</td><td><kbd>M</kbd></td></tr>
      <tr><td>Effects panel (legacy)</td><td><kbd>E</kbd></td></tr>
    </table>

    <h4>Audio / debug</h4>
    <table class="tp-info__keys">
      <tr><td>Spiral visualizer on / off</td><td><kbd>V</kbd></td></tr>
      <tr><td>Spectrum + beat-lab overlay</td><td><kbd>F</kbd></td></tr>
      <tr><td>Audio-signal test panel</td><td><kbd>B</kbd></td></tr>
    </table>

    <h4>Touch (mobile)</h4>
    <p class="tp-info__note">
      On-screen buttons cover left / right / rotate / hold / hard drop.
      Two-finger orbit drags the camera; <em>double-tap</em> the canvas to
      hard-drop, or quick <em>swipe-down</em> on the canvas for a soft-drop
      burst.
    </p>
  `,

  audio: `
    <h4>The reactive stack — in one breath</h4>
    <p class="tp-info__note">
      Every sound the game makes (BGM, your captured browser tab, eventually
      a microphone) flows through one <strong>AnalyserNode</strong>. From
      there, the <strong>FeatureBus</strong> splits it into 6 perceptual
      bands (sub / bass / lowMid / mid / highMid / air) and stamps each
      band with energy, envelope, AGC-normalised level, transient flux, and
      kick-impulse signals. A live BPM tracker derives tempo and
      anticipation from the kick onsets. Visuals subscribe to those
      streams in <code>vfx/reactive/bindings.js</code> — the only place
      audio writes visual state.
    </p>

    <h4>Spiral visualizer (<kbd>V</kbd>)</h4>
    <ul class="tp-info__list">
      <li>Scene-embedded — automatically follows the orbit camera so it
          reads as a cosmic backdrop, not an overlay.</li>
      <li>Reacts to FeatureBus bass / air bands + the live kick tracker.</li>
      <li>Pulses on game events (LINE_CLEAR, T-spin, B2B, Level-up,
          Perfect Clear) with intensities tuned to the moment.</li>
      <li>Tween into the next geometric preset on big events; opacity
          jumps and decays via gsap.</li>
    </ul>

    <h4>External tab capture</h4>
    <p class="tp-info__note">
      In <strong>Settings → Spiral → Audio source</strong>, click
      <em>Capture browser tab</em>. The picker asks which tab to share —
      you <strong>must</strong> tick the <em>Share tab audio</em> checkbox
      (browser policy). The visualizer + 6-band pipeline switch over
      instantly. Closing the share banner falls back to TetrisPlus BGM.
    </p>
    <p class="tp-info__note">
      Limitation: macOS Chrome only supports <em>tab</em> mode with audio;
      full-window or screen captures arrive video-only. Authorisation must
      be re-granted every session.
    </p>

    <h4>Diagnostic overlays</h4>
    <ul class="tp-info__list">
      <li><kbd>F</kbd> — <strong>Audio spectrum</strong>. Log-spaced FFT
          bars, beat lab strip chart (cyan = anticipation ramp, white tick
          = predicted beat, red tick = measured kick), live BPM readout.
          Aligned white/red ticks = tracker is locked.</li>
      <li><kbd>B</kbd> — <strong>Signal test panel</strong>. Every
          FeatureBus channel side-by-side, plus mini canvases that
          demonstrate how each signal looks driving a primitive. For
          effect tuning.</li>
    </ul>

    <h4>Tips</h4>
    <ul class="tp-info__list">
      <li>The first key press / pointer tap unlocks the AudioContext —
          browsers won't let scripts start it cold.</li>
      <li>Loud and quiet tracks both reach near-full visual intensity:
          a 30-second AGC normalises every band.</li>
      <li>If the spiral looks dead: <code>__feature.isBound</code>
          should be true and <code>__feature.bands.bass.norm</code>
          should rise on hits. Both are exposed on <code>window</code>.</li>
    </ul>
  `,

  roadmap: `
    <h4>Shipped</h4>
    <ul class="tp-info__list">
      <li><strong>Core game</strong> — full Tetris ruleset (SRS rotation,
          B2B, combo, T-spin recognition), 6 modes (Marathon, Sprint,
          Ultra, Zen, Physics, 3D), persistent stats per mode.</li>
      <li><strong>3D Tetris</strong> — depth axis, rotational degrees on
          three axes, depth-aware ghost piece, voxel renderer.</li>
      <li><strong>Online Versus</strong> — rollback-netcoded 1v1 with
          garbage exchange + replay download (server ops still pending
          deploy).</li>
      <li><strong>Pure Physics</strong> — Rapier-driven shatter mode,
          per-cube physics, layer-clear scoring.</li>
      <li><strong>Audio reactivity</strong> — 6-band FeatureBus, AGC,
          onset / kick detection, live BPM tracker, spiral visualizer,
          external-tab capture, full Settings → Spiral / Audio panel.</li>
      <li><strong>VFX</strong> — selective bloom, chromatic aberration,
          nebula, ambient field, edge highlights, modern callouts,
          B2B / combo chips, Garbage flash, particle dust.</li>
    </ul>

    <h4>In flight (medium-term)</h4>
    <ul class="tp-info__list">
      <li><strong>M-1</strong> Swap live-beat-tracker to
          <code>realtime-bpm-analyzer</code> for ±1–2 BPM accuracy.</li>
      <li><strong>M-2</strong> Per-BGM visual presets (quiet / melodic
          / energetic / intense).</li>
      <li><strong>M-3</strong> Conditional reaction to long hard-drops
          (≥14 rows).</li>
      <li><strong>M-4</strong> Phase-locked spiral self-rotation.</li>
      <li><strong>M-5</strong> Pre-beat hue shift driven by anticipation.</li>
      <li><strong>M-6</strong> Onset-driven dust-burst emitter.</li>
      <li><strong>Pure Physics</strong> tuning playtest (gravity, friction,
          layer-clear threshold).</li>
      <li><strong>Online Versus</strong> ops — Cloudflare Workers / D1 /
          R2 deploy, telemetry, closed-alpha → public rollout.</li>
    </ul>

    <h4>Long-term</h4>
    <ul class="tp-info__list">
      <li><strong>L-1</strong> Harmonic-reactive colour via Meyda
          chroma / centroid / MFCC.</li>
      <li><strong>L-2</strong> Audio-source-aware Settings — separate
          tuning slots for BGM vs external capture.</li>
      <li><strong>L-3</strong> Multi-visualizer framework (alternates to
          the spiral).</li>
      <li><strong>L-4</strong> Per-track persisted parameters.</li>
      <li><strong>L-5</strong> ML beat-tracker exploration.</li>
      <li><strong>Per-collision dust</strong> for Physics mode.</li>
    </ul>

    <h4>Speculative / parking lot</h4>
    <ul class="tp-info__list">
      <li>Genre classifier auto-picks visual presets.</li>
      <li>Lyric-aware effects (LRC / YouTube captions).</li>
      <li>Real-time stem separation for clean kick detection.</li>
      <li>Procedural shader generation from audio analysis.</li>
    </ul>
  `,

  credits: `
    <h4>Open-source vendors</h4>
    <ul class="tp-info__list">
      <li><strong>Three.js</strong> — rendering core (MIT).</li>
      <li><strong>Rapier</strong> — physics for Pure Physics mode (Apache 2.0).</li>
      <li><strong>gsap</strong> — tween + opacity pulses (Standard “No Charge” License).</li>
      <li><strong>Muon Music Visualizer</strong> — vendored spiral
          geometry in <code>vfx/visualizers/muon-original/</code>
          (najafmohammed/muon-music-visualizer, MIT).</li>
      <li><strong>web-audio-beat-detector</strong> — offline BPM
          analysis (MIT).</li>
      <li><strong>realtime-bpm-analyzer</strong> — planned live BPM
          (Apache 2.0).</li>
      <li><strong>Meyda</strong> — chroma / MFCC / centroid (MIT).</li>
      <li><strong>lil-gui</strong> — dev-only spiral knobs (MIT).</li>
    </ul>

    <h4>References</h4>
    <ul class="tp-info__list">
      <li>Onset detection — Bello et al., <em>A Tutorial on Onset
          Detection in Music Signals</em>, IEEE TASLP 2005.</li>
      <li>Selective-bloom recipe — Three.js example #postprocessing
          (mr.doob et al.).</li>
      <li>Curl-noise dust — Bridson, <em>Curl-Noise for Procedural
          Fluid Flow</em>, SIGGRAPH 2007.</li>
    </ul>

    <h4>Project</h4>
    <p class="tp-info__note">
      Source &amp; design notes live in <code>document/</code> — see
      <code>plan_v3.md</code>, <code>plan_audio_interaction.md</code>,
      <code>audio_and_vfx.md</code>.
    </p>
  `,
};

let _stylesInstalled = false;
function installStyles() {
  if (_stylesInstalled) return;
  _stylesInstalled = true;
  const css = `
    /* Info panel — replaces the old static .help block. Closed by
       default; opening drops in a tabbed reference. On mobile the
       panel takes the full screen so content is readable; on desktop
       it docks bottom-left like the old help. */
    .tp-info {
      position: fixed;
      bottom: 18px;
      left: 22px;
      z-index: 30;
      width: 360px;
      max-width: calc(100vw - 44px);
      max-height: 70vh;
      background: rgba(10, 14, 24, 0.78);
      backdrop-filter: blur(12px) saturate(150%);
      -webkit-backdrop-filter: blur(12px) saturate(150%);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      box-shadow: 0 12px 48px rgba(0, 0, 0, 0.6),
                  0 0 32px rgba(108, 240, 255, 0.06);
      color: var(--ink, #f3f5fb);
      font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
      font-size: 12px;
      line-height: 1.55;
      display: flex;
      flex-direction: column;
      opacity: 0;
      pointer-events: none;
      transform: translateY(8px);
      transition: opacity 180ms ease, transform 180ms ease;
    }
    .tp-info.is-open {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0);
    }

    .tp-info__header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .tp-info__title {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 11px;
      letter-spacing: 0.22em;
      color: var(--accent, #6cf0ff);
      text-transform: uppercase;
      flex: 1;
    }
    .tp-info__hint {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 10px;
      letter-spacing: 0.16em;
      color: var(--muted, #8b93ad);
      opacity: 0.7;
    }
    .tp-info__close {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: transparent;
      color: var(--muted, #8b93ad);
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
    }
    .tp-info__close:hover {
      color: var(--ink, #f3f5fb);
      border-color: rgba(108, 240, 255, 0.45);
    }

    .tp-info__tabs {
      display: flex;
      gap: 4px;
      padding: 8px 10px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }
    .tp-info__tab {
      background: transparent;
      border: 1px solid transparent;
      border-bottom: none;
      color: var(--muted, #8b93ad);
      padding: 6px 10px;
      font-size: 11px;
      letter-spacing: 0.06em;
      cursor: pointer;
      border-radius: 8px 8px 0 0;
      transition: color 120ms, background 120ms, border-color 120ms;
    }
    .tp-info__tab:hover { color: var(--ink, #f3f5fb); }
    .tp-info__tab.is-active {
      color: var(--accent, #6cf0ff);
      background: rgba(108, 240, 255, 0.08);
      border-color: rgba(108, 240, 255, 0.25);
    }

    .tp-info__content {
      overflow: auto;
      padding: 12px 14px 14px;
      flex: 1;
    }
    .tp-info__pane { display: none; }
    .tp-info__pane.is-active { display: block; }
    .tp-info__pane h4 {
      margin: 12px 0 6px;
      font-size: 10px;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: var(--ink, #f3f5fb);
      font-weight: 600;
    }
    .tp-info__pane h4:first-child { margin-top: 0; }
    .tp-info__pane p,
    .tp-info__pane ul {
      margin: 0 0 8px;
      color: rgba(243, 245, 251, 0.86);
    }
    .tp-info__pane ul { padding-left: 16px; }
    .tp-info__pane li { margin: 2px 0; }
    .tp-info__pane code {
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 11px;
      background: rgba(255, 255, 255, 0.05);
      padding: 1px 5px;
      border-radius: 3px;
      color: var(--accent, #6cf0ff);
    }
    .tp-info__note {
      color: rgba(243, 245, 251, 0.78);
    }
    .tp-info__keys {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 10px;
    }
    .tp-info__keys td {
      padding: 3px 0;
      vertical-align: top;
    }
    .tp-info__keys td:first-child {
      color: rgba(243, 245, 251, 0.78);
    }
    .tp-info__keys td:last-child {
      text-align: right;
      white-space: nowrap;
    }
    .tp-info kbd {
      display: inline-block;
      min-width: 18px;
      padding: 1px 6px;
      font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 10px;
      color: var(--ink, #f3f5fb);
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-bottom-color: rgba(255, 255, 255, 0.04);
      border-radius: 4px;
      text-align: center;
    }
    .tp-info__chip {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 999px;
      background: rgba(108, 240, 255, 0.12);
      color: var(--accent, #6cf0ff);
      font-size: 11px;
    }
    .tp-info__list { padding-left: 16px; }

    /* Mobile: fullscreen-ish sheet. Tab bar stays at top, content scrolls. */
    @media (max-width: 600px), (pointer: coarse) {
      .tp-info {
        left: 8px;
        right: 8px;
        bottom: 8px;
        top: 8px;
        width: auto;
        max-width: none;
        max-height: none;
        font-size: 13px;
      }
      .tp-info__tabs {
        overflow-x: auto;
        flex-wrap: nowrap;
      }
      .tp-info__tab { flex: 1 0 auto; }
    }
  `;
  const style = document.createElement('style');
  style.id = 'tp-info-style';
  style.textContent = css;
  document.head.appendChild(style);
}
