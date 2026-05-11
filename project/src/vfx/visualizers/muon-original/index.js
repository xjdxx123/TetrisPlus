// Vendored Muon Music Visualizer (najafmohammed/muon-music-visualizer, MIT)
// — MINIMAL ENTRY POINT.
//
// This file replaces Muon's original src/index.js. We strip everything
// non-visual (DOM controls, video player, search modal, equalizer, stats
// HUD, file picker, dat.gui) and bridge the audio source: instead of
// `wavesurfer.backend.analyser`, we feed the project's existing
// `audio.analyser` (AnalyserNode) directly into Muon's render pipeline.
//
// Purpose: A/B comparison vs our own ported spiral. Toggle with the `B`
// hotkey. Mounts a separate <canvas>; the game render loop is suppressed
// while this overlay is visible (gated in main.js via spiralWave/muon
// isVisible checks).
//
// `globalParams` is re-exported here because CoreControls/wave.js does
// `import { globalParams } from ".."` — i.e. expects to find it on this
// file. Same shape Muon used in their original index.js.

import * as THREE from "three";
import GUI from "lil-gui";
import { Operations } from "./Utils/operations";
import { CoreControls } from "./CoreControls";
import { Objects } from "./Resources/objects";
import { gsapControls } from "./GSAP";
import {
  emittedParticleSystem,
  emitParticle,
  updateParticleAttributes,
} from "./Utils/ParticleEmitter";

// Required export — wave.js imports it from `..`.
export const globalParams = {
  updateStatsLock: false,
  updateLock: false,
  visualserPresetCounter: 0,
};

const maxExponentialScaler = 0.1;

// Map FeatureBus signals into the same scalar shape Muon's audioProcessing
// returns. Magnitudes chosen to land near Muon's typical range so downstream
// formulas (sineCounter advance, dust beatScalerFactor, preset morph) read
// the same physical "intensity" regardless of source.
//
//   exponentialBassScaler:   Muon caps at 0.1 → bass.norm (∈ [0,1]) × 0.1
//   exponentialTrebleScaler: same cap → air.norm × 0.1
//   coreScaler:              Muon's typical range 1..6 → 1 + bass.kick × 5
//   _delta synth:            FB's onsets are discrete events, not a derivative;
//                            we synthesise a one-frame _delta when a kick fires
//                            so wavePresetController's threshold check trips.
function deriveAudioFeatsFromFeatureBus(feature) {
  const bass = feature.bands.bass;
  const air  = feature.bands.air;
  return {
    baseFr: bass.norm * 0.08,            // unused downstream but kept for shape
    trebleFr: air.norm * 0.02,
    coreScaler: 1 + bass.kick * 5,
    exponentialBassScaler:   bass.norm * 0.1,
    exponentialTrebleScaler: air.norm  * 0.1,
  };
}

export function createMuonOriginal({
  audio,
  feature = null,
  beatGrid = null,
  hotkey = "KeyB",
  visibleByDefault = false,
} = {}) {
  // === Canvas + DOM mount ============================================
  const canvas = document.createElement("canvas");
  canvas.id = "muon-original-canvas";
  canvas.className = "webgl";   // matches Muon's HTML class
  Object.assign(canvas.style, {
    position: "fixed",
    inset: "0",
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    zIndex: "41",      // above spiral (40), below tp-panel chrome (50+)
    display: "none",
    background: "#000000",
  });
  document.body.appendChild(canvas);

  // === Muon's params (verbatim from original src/index.js) ===========
  const params = {
    maxPoints: 0,
    colorSpectrum: 3,
    aperture: 3,
    sineCounterMultiplier: 1,
    idleMultiplier: 0.27,
    particleMirror: true,
    radiusMultiplier: 0.66,
    dynamicRadius: true,
    updateLockInterval: 0.17,
    deltaResponseLimit: 0.005,
    visualizationPreset: true,
    spacing: 1,
    syncColors: true,
    divisions: 21,
    lifespan: 200,
    noiseScale: 0.3,
    noiseForce: 1,
    timeMult: 0.01,
    enableMonoColor: false,
    monoColor: { h: 350, s: 0.9, v: 0.3 },
    // A/B audio source toggle. false = Muon's vendored audioProcessing on
    // raw FFT bytes (matches the reference demo). true = TetrisPlus
    // FeatureBus (6-band + AGC + onset detection). FB only takes effect if
    // a `feature` argument was passed to createMuonOriginal.
    useFeatureBus: false,
    // Display mode — set via setMode(). 'off' hides the canvas entirely;
    // 'background' renders behind the game (z-index below game canvas);
    // 'theater' renders in front and suppresses the game render so the
    // GPU isn't doing two heavy 3D pipelines at once.
    mode: "off",
  };

  let sineCounter = 0;
  const prevParams = {
    maxPoints: 0,
    colorSpectrum: 3,
    aperture: 0,
    radiusMultiplier: 0,
    spacing: 1,
  };

  let exponentialBassScaler = 0;
  let exponentialTrebleScaler = 0;
  let prevExponentialBassScalar = 0;
  let dataArray = new Uint8Array(0);

  // FeatureBus onset bridge. Muon's wavePresetController triggers a preset
  // morph when |_delta| exceeds deltaResponseLimit (default 0.005). FB
  // exposes onsets as discrete events instead of as a derivative, so we
  // latch a flag on each kick and synthesise a one-frame _delta in tick.
  let _fbOnsetFired = false;
  if (feature && feature.onsets && typeof feature.onsets.on === 'function') {
    feature.onsets.on('kick', () => { _fbOnsetFired = true; });
  }

  // === Three.js scene assembly (uses Muon's Objects helpers) =========
  const scene = new THREE.Scene();
  let particles = Objects.initParticles(params.maxPoints);
  scene.add(particles);
  let particles2 = Objects.initParticles(params.maxPoints);

  const camera = Objects.initCamera();
  const controls = Objects.initOrbitControls(camera, canvas);

  const renderer = Objects.initRenderer(canvas);
  const composer = Objects.initComposer(renderer, scene, camera);

  Objects.initResize(camera, renderer, composer);

  // GSAP intro animation — same one Muon plays on first load. Tweens
  // maxPoints 0 → 1080 → 7920 → 5400, camera scale 0 → 1, etc. This is
  // the "explosive reveal" that makes Muon's first 3 seconds feel alive.
  // We re-trigger it every time the overlay is shown so the user gets
  // the same effect on every B-press.

  // Emission particles.
  scene.add(emittedParticleSystem);

  const clock = new THREE.Clock();

  // === Wavesurfer mock — bridges our analyser to Muon's expected API.
  // Muon checks `wavesurfer.isPlaying()` (boolean, NOT a property) and
  // reads FFT bytes from `wavesurfer.backend.analyser`. Mirror that shape
  // exactly and forward to our shared AudioContext analyser.
  const wavesurfer = {
    isPlaying: () => !!audio?.analyser,
    backend: {
      get analyser() { return audio?.analyser ?? null; },
    },
  };

  const initFftBuffer = () => {
    const a = wavesurfer.backend.analyser;
    if (!a) return null;
    if (dataArray.length !== a.frequencyBinCount) {
      dataArray = new Uint8Array(a.frequencyBinCount);
    }
    return a;
  };

  // === lil-gui dev panel ============================================
  // Ranges mirror Muon's own GUI/index.js where applicable. Geometry params
  // (maxPoints/colorSpectrum/aperture/spacing) are picked up by
  // CoreControls.redrawGeometry every tick — no manual rebuild needed.
  const STORAGE_KEY = "muon-original.useFeatureBus";
  // Hydrate persisted toggle BEFORE building the panel so the UI reflects it.
  if (localStorage.getItem(STORAGE_KEY) === "true") params.useFeatureBus = true;

  const gui = new GUI({ title: "Muon Visualizer", width: 280 });
  gui.domElement.style.zIndex = "60";
  gui.hide();

  const audioFolder = gui.addFolder("Audio source");
  audioFolder
    .add(params, "useFeatureBus")
    .name("Use FeatureBus (vs Muon)")
    .onChange((v) => {
      localStorage.setItem(STORAGE_KEY, String(v));
      console.log(`[muon-original] audio source = ${v ? "FeatureBus" : "Muon vendored"}`);
    });
  if (!feature) {
    audioFolder.add({ note: "no feature passed in" }, "note").disable();
  }

  const geomFolder = gui.addFolder("Geometry");
  geomFolder.add(params, "maxPoints",        360, 12240, 360);
  geomFolder.add(params, "colorSpectrum",    3,    30, 1);
  geomFolder.add(params, "aperture",         0,    Math.PI, 0.01);
  geomFolder.add(params, "spacing",          0,    1, 0.01);

  const morphFolder = gui.addFolder("Morph");
  morphFolder.add(params, "radiusMultiplier",   0.01, 1,    0.0001).listen();
  morphFolder.add(params, "updateLockInterval", 0.05, 1.0,  0.01);
  morphFolder.add(params, "deltaResponseLimit", 0.001, 0.01, 0.001);
  morphFolder.add(params, "visualizationPreset");
  morphFolder.add(params, "particleMirror");
  morphFolder.add(params, "dynamicRadius");
  morphFolder.add(params, "idleMultiplier",  0,    2,    0.01);

  const dustFolder = gui.addFolder("Curl-noise dust");
  dustFolder.add(params, "divisions",  1,   150, 1);
  dustFolder.add(params, "lifespan",   10,  250, 1);
  dustFolder.add(params, "noiseScale", 0,   2,    0.01);
  dustFolder.add(params, "timeMult",   0,   0.1,  0.001);

  const colorFolder = gui.addFolder("Color");
  colorFolder.add(params, "syncColors");
  colorFolder.add(params, "enableMonoColor");
  colorFolder.add(params.monoColor, "h", 0, 360, 1).name("mono.h");
  colorFolder.add(params.monoColor, "s", 0, 1,  0.01).name("mono.s");
  colorFolder.add(params.monoColor, "v", 0, 1,  0.01).name("mono.v");

  // === Mode / visibility / hotkey ===================================
  // lil-gui stays hidden by default — the Settings panel ("Spiral" tab)
  // is the user-facing surface now. Dev shortcut for the full param
  // surface: `__spiralWave.gui.show()` from the console.
  //
  // cameraIntro is the cinematic explosion — camera scales from 0, params
  // tween through 0→1080→7920→5400 over 4s. We only run it ONCE per page
  // load: subsequent mode flips just re-style the canvas without restarting
  // the tween, otherwise it would clobber any user-set Particle count /
  // Color spectrum / Spacing.
  //
  // Three modes:
  //   off        — canvas hidden, game renders normally
  //   background — spiral canvas behind game (z-index 1, game canvas is at
  //                z-index 2 with alpha:true so transparent areas reveal
  //                the spiral); pointer events pass through to the game so
  //                play continues uninterrupted
  //   theater    — spiral canvas in front (z-index 41), captures pointer
  //                events for OrbitControls; game render is suppressed by
  //                main.js so we don't double-pipeline the GPU
  let _introPlayed = false;
  const MODES = ["off", "background", "theater"];

  const setMode = (mode) => {
    if (!MODES.includes(mode)) return;
    params.mode = mode;
    if (mode === "off") {
      canvas.style.display = "none";
      canvas.style.pointerEvents = "none";
      canvas.style.zIndex = "41";
      controls.enabled = false;
    } else if (mode === "background") {
      canvas.style.display = "block";
      canvas.style.pointerEvents = "none";
      canvas.style.zIndex = "1";
      controls.enabled = false;
    } else if (mode === "theater") {
      canvas.style.display = "block";
      canvas.style.pointerEvents = "auto";
      canvas.style.zIndex = "41";
      controls.enabled = true;
    }
    if (mode !== "off" && !_introPlayed) {
      _introPlayed = true;
      gsapControls.cameraIntro(camera, params);
    }
  };
  setMode(params.mode);

  // Backward-compat shim — older call sites use setVisible/isVisible.
  // setVisible(true) maps to "theater" (the original full-screen behaviour).
  const setVisible = (v) => setMode(v ? "theater" : "off");
  if (visibleByDefault) setMode("theater");

  // V cycles modes: off → background → theater → off. The first non-off
  // press triggers the cinematic intro.
  const onKey = (e) => {
    if (e.code !== hotkey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    const i = MODES.indexOf(params.mode);
    setMode(MODES[(i + 1) % MODES.length]);
  };
  window.addEventListener("keydown", onKey);

  // === Per-frame render — direct port of Muon's render() body =======
  // Skips: stats.update, DOM updateStats, video sync, currentTime DOM,
  // file/pause button event setup. Keeps every visual call.
  const tick = () => {
    if (canvas.style.display === "none") return;

    // Resize/fill the FFT buffer FIRST — Muon's original src/index.js sets
    // it up via audioAnalyzer() before the render loop starts, so the first
    // call to audioProcessing always sees a populated array. We don't have
    // that lifecycle, so do it inline. Bail until the analyser is online to
    // avoid Operations.avg's `reduce` crashing on an empty Uint8Array.
    const analyser = initFftBuffer();
    if (!analyser || dataArray.length === 0) return;
    analyser.getByteFrequencyData(dataArray);

    const timeDelta = clock.getDelta();
    const time = clock.getElapsedTime();

    let _delta = exponentialBassScaler - prevExponentialBassScalar;
    prevExponentialBassScalar = exponentialBassScaler;

    // Audio source A/B switch. FB path falls back to Muon's own pipeline
    // when feature wasn't supplied (or hasn't ticked yet).
    const useFB = params.useFeatureBus && feature && feature.bands;
    const audioFeats = useFB
      ? deriveAudioFeatsFromFeatureBus(feature)
      : CoreControls.audioProcessing(dataArray);

    // FB has no derivative-style _delta, so synthesise one when an onset
    // just fired. Magnitude (0.01) chosen above deltaResponseLimit (0.005)
    // so wavePresetController's threshold trips reliably.
    if (useFB) {
      _delta = _fbOnsetFired ? 0.01 : 0;
      _fbOnsetFired = false;
    }

    const coreScaler = audioFeats.coreScaler;
    exponentialBassScaler = audioFeats.exponentialBassScaler;
    // NB: Muon's original assigns bass to treble as well — preserved for
    // the Muon path; FB path uses the real treble band.
    exponentialTrebleScaler = useFB
      ? audioFeats.exponentialTrebleScaler
      : audioFeats.exponentialBassScaler;

    if (coreScaler > 1) {
      sineCounter += coreScaler * 0.5 * timeDelta;
    } else {
      sineCounter += params.idleMultiplier * timeDelta * 7;
    }

    composer.render();

    if (!wavesurfer.isPlaying()) {
      params.radiusMultiplier =
        (params.radiusMultiplier + 0.00012 * timeDelta) % 1;
      params.spacing = 1;
    } else {
      params.spacing = 0.6;
    }

    if (params.particleMirror) {
      scene.add(particles2);
    } else {
      scene.remove(particles2);
    }

    CoreControls.redrawGeometry(
      wavesurfer.isPlaying(),
      prevParams,
      params,
      particles,
      particles2,
    );

    CoreControls.sineWavePropagation(
      wavesurfer,
      particles,
      particles2,
      sineCounter,
      dataArray,
      params,
      exponentialBassScaler,
      exponentialTrebleScaler,
      prevParams,
    );

    sineCounter += Math.abs(_delta * 250) * timeDelta;

    CoreControls.wavePresetController(params, _delta, particles2);

    // (FFT fetch already done at the top of tick so audioProcessing has data.)

    if (exponentialBassScaler > maxExponentialScaler)
      exponentialBassScaler = maxExponentialScaler;

    const hue = CoreControls.hueControl((_delta * timeDelta) / 2);
    particles.material.uniforms.color.value.setHSL(hue, 0.7, 0.5);
    particles2.material.uniforms.color.value.setHSL(hue, 0.7, 0.5);
    if (params.syncColors) {
      emittedParticleSystem.material.uniforms.color.value.setHSL(
        hue, 0.7, 0.5,
      );
    }

    emitParticle(
      exponentialBassScaler, exponentialTrebleScaler,
      time, dataArray, wavesurfer.isPlaying(), params,
    );
    updateParticleAttributes(
      exponentialBassScaler, exponentialTrebleScaler,
      time, dataArray, wavesurfer.isPlaying(), params,
    );
  };

  const dispose = () => {
    window.removeEventListener("keydown", onKey);
    gui.destroy();
    renderer.dispose();
    canvas.remove();
  };

  return {
    tick,
    dispose,
    setVisible,
    setMode,
    getMode: () => params.mode,
    isVisible:    () => params.mode !== "off",
    isInFront:    () => params.mode === "theater", // gates main game render
    canvas,
    params,
    gui,            // exposed for dev: __spiralWave.gui.show()
  };
}

// Silence eslint for an unused symbol re-exported only to confirm the file
// also serves as the parent module that wave.js imports `globalParams` from.
void Operations;
