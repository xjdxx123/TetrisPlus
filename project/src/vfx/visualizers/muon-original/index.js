// Vendored Muon Music Visualizer (najafmohammed/muon-music-visualizer, MIT)
// — SCENE-EMBEDDED ENTRY POINT.
//
// We embed Muon's spiral particles + curl-noise dust directly into the
// host game's scene (instead of rendering to a standalone canvas with its
// own renderer/composer). This gives the spiral several properties for
// free that the standalone approach can't:
//
//   - Automatically rotates / pans with the game camera. No camera-link
//     glue needed — they share the camera.
//   - Naturally picks up the host's post chain (selectiveBloom, vignette,
//     chromatic). No double-pipeline GPU pressure.
//   - No alpha-preservation issues at canvas composite time — particles
//     just render after the game's opaque pieces.
//
// The spiral lives inside a single Object3D group positioned far behind
// the playfield (default `bgZ: -800`, `bgScale: 10`) so it reads as a
// "background sky", not a 3D object the player can collide with.
//
// Audio source: same options as before. Set `params.useFeatureBus = true`
// (via Settings → Spiral panel) to switch from Muon's piecewise
// audioProcessing to the project's FeatureBus signals (bass/air norm +
// onset events).
//
// `globalParams` is re-exported because CoreControls/wave.js does
// `import { globalParams } from ".."` — must be importable on this file.

import * as THREE from "three";
import GUI from "lil-gui";
import { Operations } from "./Utils/operations";
import { CoreControls } from "./CoreControls";
import { generateParticlesSpiral } from "./Resources/geometries";
import materials from "./Resources/materials";
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
  scene,                  // REQUIRED — game scene the spiral group attaches to
  feature = null,
  beatGrid = null,        // eslint-disable-line no-unused-vars
  hotkey = "KeyV",
  visibleByDefault = false,
} = {}) {
  if (!scene) {
    throw new Error("[muon-original] `scene` is required for scene-embedded mode");
  }

  // === Muon's params (verbatim from original src/index.js) + our extras
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
    useFeatureBus: false,
    // Scene-embedded geometry: how far back + how big. Tune via Settings →
    // Spiral or via console (__spiralWave.params.bgZ = -1200).
    bgZ: -800,
    bgScale: 10,
    // 'off' = group detached from scene; 'background' = attached.
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

  // FeatureBus onset bridge.
  let _fbOnsetFired = false;
  if (feature && feature.onsets && typeof feature.onsets.on === "function") {
    feature.onsets.on("kick", () => { _fbOnsetFired = true; });
  }

  // === Scene assembly =================================================
  // No standalone scene/camera/renderer/composer — those all belong to
  // the host. We build the spiral Points + dust ourselves (used to come
  // from Objects.initParticles, but that ties to materials we already
  // have) and parent them under a single group that hosts the bgZ/bgScale
  // transform. Setting depthTest:false keeps additive blending dense; the
  // tradeoff is spiral particles "show through" opaque game pieces a bit,
  // which actually reads as glow rather than wrong.
  const particles  = new THREE.Points(generateParticlesSpiral(params.maxPoints), materials.particleMaterial);
  const particles2 = new THREE.Points(generateParticlesSpiral(params.maxPoints), materials.particleMaterial);
  particles2.rotation.z = -Math.PI / 2;

  const spiralGroup = new THREE.Group();
  spiralGroup.name = "muon-spiral-bg";
  spiralGroup.position.z = params.bgZ;
  spiralGroup.scale.setScalar(params.bgScale);
  spiralGroup.add(particles);
  // particles2 + emittedParticleSystem are toggled in tick based on params.
  spiralGroup.add(particles2);
  spiralGroup.add(emittedParticleSystem);

  const clock = new THREE.Clock();

  // === Wavesurfer mock (analyser bridge) ============================
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
  const STORAGE_KEY = "muon-original.useFeatureBus";
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
    });
  if (!feature) {
    audioFolder.add({ note: "no feature passed in" }, "note").disable();
  }

  const placementFolder = gui.addFolder("Placement");
  placementFolder.add(params, "bgZ",     -3000, 0,   10)
    .onChange((v) => { spiralGroup.position.z = v; });
  placementFolder.add(params, "bgScale", 0.5,   30,  0.1)
    .onChange((v) => { spiralGroup.scale.setScalar(v); });

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
  // Two modes now: 'off' detaches the group; 'background' attaches it.
  // The host's render loop handles painting — nothing to draw here.
  const MODES = ["off", "background"];

  const setMode = (mode) => {
    if (!MODES.includes(mode)) return;
    params.mode = mode;
    if (mode === "off" && spiralGroup.parent) {
      scene.remove(spiralGroup);
    } else if (mode === "background" && !spiralGroup.parent) {
      scene.add(spiralGroup);
    }
  };
  setMode(visibleByDefault ? "background" : params.mode);

  // Backward-compat shim — older call sites use setVisible/isVisible.
  const setVisible = (v) => setMode(v ? "background" : "off");

  // V toggles between off and background.
  const onKey = (e) => {
    if (e.code !== hotkey) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    setMode(params.mode === "off" ? "background" : "off");
  };
  window.addEventListener("keydown", onKey);

  // === Per-frame audio + uniform update =============================
  // Same body as Muon's render() minus the composer.render() — host
  // handles drawing. We still update geometry + uniforms every frame so
  // the host's renderer picks up our changes when it traverses the scene.
  const tick = () => {
    if (params.mode === "off") return;

    const analyser = initFftBuffer();
    if (!analyser || dataArray.length === 0) return;
    analyser.getByteFrequencyData(dataArray);

    const timeDelta = clock.getDelta();
    const time = clock.getElapsedTime();

    let _delta = exponentialBassScaler - prevExponentialBassScalar;
    prevExponentialBassScalar = exponentialBassScaler;

    const useFB = params.useFeatureBus && feature && feature.bands;
    const audioFeats = useFB
      ? deriveAudioFeatsFromFeatureBus(feature)
      : CoreControls.audioProcessing(dataArray);

    if (useFB) {
      _delta = _fbOnsetFired ? 0.01 : 0;
      _fbOnsetFired = false;
    }

    const coreScaler = audioFeats.coreScaler;
    exponentialBassScaler = audioFeats.exponentialBassScaler;
    exponentialTrebleScaler = useFB
      ? audioFeats.exponentialTrebleScaler
      : audioFeats.exponentialBassScaler;

    if (coreScaler > 1) {
      sineCounter += coreScaler * 0.5 * timeDelta;
    } else {
      sineCounter += params.idleMultiplier * timeDelta * 7;
    }

    // Spacing override matches Muon's behaviour: 0.6 during playback,
    // 1.0 when idle. Slightly disagrees with the Settings → Spiral slider
    // (it gets overwritten each frame); we accept that for parity.
    if (!wavesurfer.isPlaying()) {
      params.radiusMultiplier =
        (params.radiusMultiplier + 0.00012 * timeDelta) % 1;
      params.spacing = 1;
    } else {
      params.spacing = 0.6;
    }

    // Mirror + dust visibility toggles. Adding/removing children is cheap.
    if (params.particleMirror && !particles2.parent) spiralGroup.add(particles2);
    if (!params.particleMirror && particles2.parent) spiralGroup.remove(particles2);

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
    if (spiralGroup.parent) scene.remove(spiralGroup);
    particles.geometry.dispose();
    particles2.geometry.dispose();
  };

  return {
    tick,
    dispose,
    setVisible,
    setMode,
    getMode: () => params.mode,
    isVisible:  () => params.mode !== "off",
    isInFront:  () => false,           // never — host always renders
    spiralGroup,                       // expose for ad-hoc tuning
    params,
    gui,
  };
}

// Silence eslint for an unused symbol re-exported only to confirm the file
// also serves as the parent module that wave.js imports `globalParams` from.
void Operations;
