import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Clock } from '../engine/time/clock.js';
import { bus } from '../engine/events/bus.js';
import { EVENTS } from '../gameplay/events.js';
import { registerDirector } from '../vfx/director.js';
import { createShake } from '../camera/shake.js';
import { createPunchZoom } from '../camera/punch-zoom.js';
import { createAudioPlayback } from '../audio/playback.js';
import { createBgmPlaylist, defaultVaporwaveTracks } from '../audio/bgm-playlist.js';
import { createPlaylistPanel } from '../ui/playlist-panel.js';
import { createMarathonBadge } from '../ui/marathon-badge.js';
import { createSprintBadge }   from '../ui/sprint-badge.js';
import { createUltraBadge }    from '../ui/ultra-badge.js';
import { createZenBadge }      from '../ui/zen-badge.js';
import { createVersusBadge }   from '../ui/versus-badge.js';
import { createStarfield } from '../world/starfield.js';
import { createNebulaSky } from '../world/nebula-sky.js';
import { createMoon } from '../world/moon.js';
import { hueForLevel, pickFlashHue } from '../config/nebula-progression.js';
import { paletteFromHue, STAGE_HUE_FOR_NAME } from '../config/palettes.js';
import { loadSettings, saveSettings, loadStats, saveStats, loadBpmCache, saveBpmCache, _resetForTests as _resetStorageForTests } from '../engine/storage.js';
import { Mode } from '../gameplay/mode.js';
import { createSettingsPanel } from '../ui/settings-panel.js';
import { makeToggleRow, makeHueSlider } from '../ui/panel-shared.js';
import { createBreathe } from '../camera/breathe.js';
import { createStageController, STAGE_EVENTS } from '../vfx/stage-controller.js';
import { STAGES } from '../config/stages.js';
import { createSelectiveBloom } from '../rendering/post/selective-bloom.js';
import { createAfterimagePass } from '../rendering/post/afterimage.js';
import { createChromaticPass } from '../rendering/post/chromatic.js';
import { createFeatureBus } from '../audio/reactive/feature-bus.js';
import { createFeatureDebugOverlay } from '../audio/reactive/debug-overlay.js';
import { createBeatGrid } from '../audio/reactive/beat-grid.js';
import { createBpmCache } from '../audio/reactive/bpm-cache.js';
import { createPlaybackProgress } from '../audio/playback-progress.js';
import { createBindings } from '../vfx/reactive/bindings.js';
import { createEffectsPanel } from '../ui/effects-panel.js';
import { bakeCurlNoise3D } from '../vfx/curl-noise.js';
import { createEnvReaction } from '../vfx/emitters/env-reaction.js';

// Shader sources are imported as raw strings via Vite's ?raw suffix.
// Files live under src/shaders/. This unlocks shader hot-reload during dev
// and keeps GLSL out of the JS string-template noise.
import GLASS_VERT from '../shaders/glass.vert.glsl?raw';
import GLASS_FRAG_PIECE from '../shaders/glass.frag.glsl?raw';
import GLASS_FRAG_CASE from '../shaders/glass-case.frag.glsl?raw';
import VIGNETTE_VERT from '../shaders/vignette.vert.glsl?raw';
import VIGNETTE_FRAG from '../shaders/vignette.frag.glsl?raw';
import AMBIENT_VERT from '../shaders/ambient.vert.glsl?raw';
import AMBIENT_FRAG from '../shaders/ambient.frag.glsl?raw';
import TRAIL_VERT from '../shaders/trail.vert.glsl?raw';
import TRAIL_FRAG from '../shaders/trail.frag.glsl?raw';
import SHARD_VERT from '../shaders/shard.vert.glsl?raw';
import SHARD_FRAG from '../shaders/shard.frag.glsl?raw';
import SPARKLE_VERT from '../shaders/sparkle.vert.glsl?raw';
import SPARKLE_FRAG from '../shaders/sparkle.frag.glsl?raw';
import { PIECES, PIECE_COLORS } from '../gameplay/pieces.js';
import { buildRules } from '../gameplay/rules.js';
import { recordEndOfRun } from '../gameplay/end-of-run.js';
import { pickHoleColumn } from '../gameplay/garbage.js';
import { Game } from '../gameplay/game.js';
import { BoardView } from '../world/board-view.js';
import { VersusSession } from './versus.js';

// =============================================================
// Tweaks — original three (gravity / mood / shatterPower) are written by
// the host editor app via the EDITMODE markers + postMessage; the rest
// are knobs surfaced through the settings panel (plan_UI_1.md §3.5).
// Their defaults sit alongside the editor-managed defaults; persistence
// happens through `engine/storage.js` (loaded right below).
// =============================================================
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "gravity": 1.9,
  "mood": "void",
  "shatterPower": 2.5
}/*EDITMODE-END*/;
// Settings-panel-managed defaults — added beside the editor-managed ones
// so a single TWEAKS object exposes everything to the consumer sites.
const TWEAK_PANEL_DEFAULTS = Object.freeze({
  shakeMul:        1.0,
  slowmoMul:       1.0,
  trailMul:        1.0,
  rimGlowMul:      1.0,
  particleQuality: 'mid',  // 'low' | 'mid' | 'high'
});
const TWEAKS = { ...TWEAK_DEFAULTS, ...TWEAK_PANEL_DEFAULTS };

// Hydrate from localStorage at boot. Order: TWEAK defaults → saved
// effects overlay → mood applied. The host-protocol path (postMessage
// from the editor app) still overwrites later if a host is attached;
// "last write wins" was the v1 contract.
const _persistedSettings = loadSettings();
{
  const e = _persistedSettings.effects || {};
  if (typeof e.shatterPower    === 'number') TWEAKS.shatterPower    = e.shatterPower;
  if (typeof e.shakeMul        === 'number') TWEAKS.shakeMul        = e.shakeMul;
  if (typeof e.slowmoMul       === 'number') TWEAKS.slowmoMul       = e.slowmoMul;
  if (typeof e.trailMul        === 'number') TWEAKS.trailMul        = e.trailMul;
  if (typeof e.rimGlowMul      === 'number') TWEAKS.rimGlowMul      = e.rimGlowMul;
  if (typeof e.mood            === 'string') TWEAKS.mood            = e.mood;
  if (typeof e.particleQuality === 'string') TWEAKS.particleQuality = e.particleQuality;
}
if (typeof _persistedSettings.mode === 'string') Mode.select(_persistedSettings.mode);

// Captured at boot so triggerGameOver can compute play-time. Reset on
// goRestart so each session contributes its own delta.
let sessionStart = (typeof performance !== 'undefined') ? performance.now() : 0;
let _piecesThisSession = 0;
let _linesThisSession = 0;

// §3.5 particleQuality — preset that scales every shard / sparkle count.
// Discrete (low/mid/high) on purpose: communicates "this affects perf"
// vs. a continuous slider that invites micro-tuning. Multiplier is
// looked up in one place so adding a new tier is a single-table edit.
const PARTICLE_QUALITY_MUL = Object.freeze({ low: 0.5, mid: 1.0, high: 1.5 });
function particleQualityMul() {
  return PARTICLE_QUALITY_MUL[TWEAKS.particleQuality] || 1.0;
}

// Mood presets — recolor rim/fill lights and case frame
const MOOD_PRESETS = {
  neon:  { rim: 0xff4a8a, fill: 0x6cf0ff, frame: 0xaee7ff },
  icy:   { rim: 0x6cb0ff, fill: 0xa0e6ff, frame: 0xd0ecff },
  ember: { rim: 0xff6a30, fill: 0xffb060, frame: 0xffd0a0 },
  void:  { rim: 0xa066ff, fill: 0x4a40c0, frame: 0x8866ff },
};
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';

// =============================================================
// Configuration
// =============================================================
const COLS = 10;
const ROWS = 20;
const DEPTH = 3;          // thicker than 2D — pieces fill all 3 depth slices
const CELL = 1.0;         // cube size in world units
const PLAY_W = COLS * CELL;
const PLAY_H = ROWS * CELL;
const PLAY_D = DEPTH * CELL;

// Tetromino colors — saturated poster hues so each piece reads as one
// unambiguous color even when stacked deep.
// PIECES, PIECE_COLORS, PIECE_KEYS are imported from ../gameplay/pieces.js.

// Per-color luminance normalization. The emissive output of a cube is
// `color * emissiveIntensity`, so without this a yellow O-piece naturally
// emits ~2× the perceived brightness of a blue J-piece at the same nominal
// intensity. We scale emissive/core/rim contributions inversely to each
// color's luma so every piece reads as equally bright.
const REF_LUMA = (() => {
  const lumas = Object.values(PIECE_COLORS).map(c => {
    const r = ((c >> 16) & 0xff) / 255;
    const g = ((c >> 8) & 0xff) / 255;
    const b = (c & 0xff) / 255;
    return 0.299 * r + 0.587 * g + 0.114 * b;
  });
  return lumas.reduce((a, b) => a + b, 0) / lumas.length;
})();
const _colorLumaScaleCache = new Map();
function colorLumaScale(hex) {
  if (_colorLumaScaleCache.has(hex)) return _colorLumaScaleCache.get(hex);
  const r = ((hex >> 16) & 0xff) / 255;
  const g = ((hex >> 8) & 0xff) / 255;
  const b = (hex & 0xff) / 255;
  const luma = Math.max(0.001, 0.299 * r + 0.587 * g + 0.114 * b);
  const scale = REF_LUMA / luma;
  _colorLumaScaleCache.set(hex, scale);
  return scale;
}

// =============================================================
// Renderer / Scene / Camera
// =============================================================
const app = document.getElementById('app');

// antialias:false — SMAA in the post-process composer handles AA on offscreen targets
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);
renderer.domElement.style.position = 'absolute';
renderer.domElement.style.inset = '0';
renderer.domElement.style.zIndex = '2';

// CSS3D renderer for crisp HUD panels in 3D space
const cssRenderer = new CSS3DRenderer();
cssRenderer.setSize(window.innerWidth, window.innerHeight);
cssRenderer.domElement.style.position = 'absolute';
cssRenderer.domElement.style.inset = '0';
cssRenderer.domElement.style.zIndex = '3';
cssRenderer.domElement.style.pointerEvents = 'none';
app.appendChild(cssRenderer.domElement);

const scene = new THREE.Scene();
const cssScene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 200);
const DEFAULT_CAM_POS = new THREE.Vector3(14, 4, 26);
const DEFAULT_CAM_TARGET = new THREE.Vector3(0, 0, 0);
camera.position.copy(DEFAULT_CAM_POS);
camera.lookAt(DEFAULT_CAM_TARGET);

// =============================================================
// Stage 1 (plan_particle_2.md) — basic spatial awareness
// =============================================================
// Sparse starfield + slow camera FOV breathing. Both are static-cost: no
// per-frame buffer uploads. Stage 5 will modulate breathe.intensity by the
// bass envelope; Stage 5 will also gate a starfield twinkle uniform.
const starfield = createStarfield({
  count: 600,
  radius: 90,
  pixelRatio: Math.min(window.devicePixelRatio, 2),
});
scene.add(starfield.group);

// Stage 10 — procedural nebula sky behind everything. Renders before stars
// (renderOrder -10 vs starfield -1). Initial palette is hue-based (matches
// the level-1 entry in LEVEL_HUE_BANDS); subsequent crossfades come from
// the player override, level-progression, or STAGE_CHANGE handlers.
//   __nebula.crossfadeToHue(280)   // violet
//   __nebula.crossfadeTo('ember')  // legacy named palette
const nebula = createNebulaSky({
  radius: 130,
  initialPalette: 'deep-cyan',
  intensity: 0.4,
});
scene.add(nebula.mesh);
// Seed the hue-based path so the level-1 visible color matches what
// `hueForLevel(1)` says it should be; without this the first level-up
// would fade from the named-palette texture to a hue-based one and the
// step would be visibly larger than intended.
nebula.crossfadeToHue(hueForLevel(1), 0.0);

// Stage 10 — procedural moon (per the violet-halo reference, screenshots/
// image.png). A high-segment SphereGeometry with a custom shader doing
// Lambertian + FBM surface detail, surrounded by a camera-facing halo
// billboard with additive bloom-eligible falloff. The disc is NOT bloom-
// eligible (moons are reflective, not luminous); the HALO is bloom-eligible
// (that's the dreamy violet aura in the reference).
//
// Position is above the case (high Y) and slightly off-center, NOT directly
// behind it — sitting the moon directly behind the playfield reads as
// oppressive (the case visually presses against it). Above-and-offset
// puts it clearly "in the sky."
const moon = createMoon({
  position: new THREE.Vector3(-15, 25, -28),
  radius: 12,
  segments: 96,
  // Mostly-frontal sun keeps the disc nearly full, like the reference.
  // The terminator is softened separately so the day/night boundary
  // doesn't read as a hard line.
  sunDir: new THREE.Vector3(0.25, 0.30, 0.95),
  terminatorSoftness: 0.55,
  haloColor: 0xb088ff,
  haloIntensity: 0.85,
});
scene.add(moon.group);

// Stage 8 — stage controller owns the active stage palette + recipe and
// emits STAGE_CHANGE when switched. Subscribers (nebula crossfade, future
// sparkle atlas / env-reaction systems) react without holding direct refs
// to the controller — pure event-driven decoupling per §1.5.
const stageController = createStageController({ bus, initial: 'cyan-void' });

// Stage 8 ↔ Stage 10 wiring: stage change drives the nebula crossfade,
// unless the player has explicitly pinned a hue via the effects-panel
// slider. Neither side knows about the other — they meet only through
// the bus and the `_userOverrideHue` flag.
//
// We translate the stage's named palette into a representative hue via
// STAGE_HUE_FOR_NAME, so the nebula crossfade goes through the same
// hue-based path as level-up and the player override. Keeps the resting-
// hue tracker accurate so the *next* level-up's wash starts from where
// the screen actually is.
bus.on(STAGE_EVENTS.STAGE_CHANGE, ({ spec }) => {
  if (_userOverrideHue != null) return;   // player choice wins
  const stageHue = STAGE_HUE_FOR_NAME[spec.nebulaPalette];
  if (stageHue == null) return;            // unknown palette — leave nebula alone
  nebula.crossfadeToHue(stageHue, 2.5);
  _currentRestingHue = stageHue;
});

const breathe = createBreathe({ amplitudeDeg: 0.4, periodSec: 9 });
breathe.bindBase(camera);

// =============================================================
// Post-processing pipeline — Stage 2: selective bloom
//   bloomLayer (masked render → UnrealBloom)  ┐
//                                              ├─►  combine (additive)  ─►  vignette  ─►  SMAA  ─►  output
//   regular RenderPass(scene, camera)         ┘
//
// Materials with `userData.enableBloom = true` contribute to the bloom layer.
// Everything else (case glass, locked cube bodies, frame, dim lighting)
// renders as normal but does NOT bloom — preventing the previous full-scene
// bloom from washing out the playfield. See rendering/post/selective-bloom.js.
// =============================================================
const _DPR = Math.min(window.devicePixelRatio, 2);
const selectiveBloom = createSelectiveBloom({
  renderer, scene, camera,
  width: window.innerWidth, height: window.innerHeight, pixelRatio: _DPR,
  strength: 0.95,
  radius: 0.45,
  threshold: 0.0,
  bloomScale: 1.0,
});
const bloomPass = selectiveBloom.bloomPass;   // alias for legacy strength tweens

const composer = new EffectComposer(renderer);
composer.setPixelRatio(_DPR);
composer.setSize(window.innerWidth, window.innerHeight);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(selectiveBloom.combinePass);

// Stage 6 — afterimage feeds on the bloom-composited HDR so high-bloom
// regions (sparkles, line-clear flash, hard-drop trails) leave visible tails.
// Damp 0.85 reads as a mild ghost; >0.92 starts smearing and reads as input
// lag — keep this conservative.
const afterimagePass = createAfterimagePass({ damp: 0.85 });
composer.addPass(afterimagePass);

// Stage 6 — chromatic aberration. Radial UV offset; uAmount bound to
// bands.air.norm in the bindings layer so high-end shimmer drives it.
const chromaticPass = createChromaticPass({ amount: 1.0 });
composer.addPass(chromaticPass);

const VignetteShader = {
  uniforms: {
    tDiffuse:   { value: null },
    uIntensity: { value: 0.65 },
    uRadius:    { value: 0.45 },
  },
  vertexShader: VIGNETTE_VERT,
  fragmentShader: VIGNETTE_FRAG,
};
const vignettePass = new ShaderPass(VignetteShader);
composer.addPass(vignettePass);

const smaaPass = new SMAAPass(
  window.innerWidth * Math.min(window.devicePixelRatio, 2),
  window.innerHeight * Math.min(window.devicePixelRatio, 2),
);
composer.addPass(smaaPass);

composer.addPass(new OutputPass());

// =============================================================
// Lighting — three-point with colored rim lights for the cubes
// =============================================================
const hemi = new THREE.HemisphereLight(0xb8d0ff, 0x0a0a14, 0.35);
scene.add(hemi);

const keyLight = new THREE.DirectionalLight(0xfff2e0, 1.6);
keyLight.position.set(10, 18, 14);
keyLight.castShadow = false;
scene.add(keyLight);

const rimLight = new THREE.PointLight(0xff4a8a, 2.4, 80, 1.6);
rimLight.position.set(-14, 8, -12);
scene.add(rimLight);

const fillLight = new THREE.PointLight(0x4ae0ff, 1.8, 80, 1.6);
fillLight.position.set(16, -2, -10);
scene.add(fillLight);

// Top accent — picks out the top edges of the case
const topAccent = new THREE.PointLight(0xffd080, 1.4, 40, 2.0);
topAccent.position.set(0, PLAY_H * 0.7, 8);
scene.add(topAccent);

// Sparkle texture (used by shatter sparkles)
let _sparkleTex = null;
function makeSparkleTexture() {
  if (_sparkleTex) return _sparkleTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32,32,0,32,32,32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0,0,64,64);
  _sparkleTex = new THREE.CanvasTexture(c);
  return _sparkleTex;
}

// =============================================================
// Ambient particle field — Stages 1 + 4 of plan_particle_2.md
//   500 CPU-driven, additively-billboarded sprites that drift around the
//   playfield. Single THREE.Points draw call. All per-particle state lives
//   in pre-allocated Float32Arrays — no per-frame allocations on the hot
//   path. Motion comes from a baked curl-noise field (vfx/curl-noise.js),
//   which is divergence-free so particles never converge into "rivers."
//   Stage 9 will move the integrator to a GPU ping-pong sim; the interface
//   below is designed so that swap is local to update().
// =============================================================
const AMBIENT_COUNT = 500;
const AMBIENT_VOL = { x: 32, y: 28, z: 18, zOffset: -6 };

// Curl-noise field shared by the ambient layer (and any future emitter that
// wants the same swirl shape). Bake once at boot — the cost (<100 ms for
// 64³) only hits the loading screen, which already tolerates a beat.
const ambientCurl = bakeCurlNoise3D({ size: 64, frequency: 1.6, seed: 1337 });

function makeAmbientTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  // Tight bright core for bloom + long soft falloff to avoid hard edges.
  g.addColorStop(0.00, 'rgba(255,255,255,1.0)');
  g.addColorStop(0.15, 'rgba(255,255,255,0.80)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.22)');
  g.addColorStop(1.00, 'rgba(255,255,255,0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const ambientField = (() => {
  const N = AMBIENT_COUNT;
  const positions = new Float32Array(N * 3);
  const velocities = new Float32Array(N * 3);
  const ages = new Float32Array(N);
  const lives = new Float32Array(N);
  const sizes = new Float32Array(N);
  const colors = new Float32Array(N * 3);
  const alphas = new Float32Array(N);

  function spawn(i, randomizeAge) {
    positions[i*3+0] = (Math.random()*2-1) * AMBIENT_VOL.x;
    positions[i*3+1] = (Math.random()*2-1) * AMBIENT_VOL.y;
    positions[i*3+2] = (Math.random()*2-1) * AMBIENT_VOL.z + AMBIENT_VOL.zOffset;
    velocities[i*3+0] = (Math.random()*2-1) * 0.25;
    velocities[i*3+1] = 0.15 + Math.random() * 0.5;
    velocities[i*3+2] = (Math.random()*2-1) * 0.18;
    lives[i] = 7.0 + Math.random() * 6.0;
    ages[i] = randomizeAge ? Math.random() * lives[i] : 0;
    sizes[i] = 0.35 + Math.random() * 1.1;
    // Disciplined palette: cyan-blue-violet arc (hue 0.50..0.72), avoiding the
    // saturated reds/greens that would clash with active piece highlights.
    const hue = 0.50 + Math.random() * 0.22;
    const sat = 0.55 + Math.random() * 0.25;
    const lum = 0.55 + Math.random() * 0.20;
    const tmp = new THREE.Color().setHSL(hue, sat, lum);
    colors[i*3+0] = tmp.r;
    colors[i*3+1] = tmp.g;
    colors[i*3+2] = tmp.b;
  }
  for (let i = 0; i < N; i++) spawn(i, true);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aColor',   new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aSize',    new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('aAlpha',   new THREE.BufferAttribute(alphas, 1));
  // Frustum culling is unhelpful here — particles cover a large volume around
  // the camera and the bounding sphere would always pass anyway. Skip the
  // matrix work.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTexture:    { value: makeAmbientTexture() },
      uPointScale: { value: window.innerHeight * 0.5 },
      uIntensity:  { value: 1.0 }, // exposed for later phases (audio reactivity)
    },
    vertexShader: AMBIENT_VERT,
    fragmentShader: AMBIENT_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
  });
  // Stash the curl texture on the material so a future GPU integrator
  // (Stage 9) can lift it into a uniform without re-baking.
  mat.userData.curlTexture = ambientCurl.texture;

  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);

  // Brief envelope: fade in over first 12% of life, fade out over last 35%.
  // Keeps spawns and deaths from popping; this is what later phases will
  // augment with anticipatory ramps tied to predicted beats.
  function envelope(k) {
    const fadeIn = 0.12;
    const fadeOut = 0.65; // start fading at 65% of life
    if (k < fadeIn)  return k / fadeIn;
    if (k > fadeOut) return Math.max(0, 1 - (k - fadeOut) / (1 - fadeOut));
    return 1.0;
  }

  // Stage 4 tunables. `flowSpeed` is world-units / sec along the curl
  // direction — the dominant drift. `curlScale` is sample rate per world
  // unit; smaller = larger swirls. The volume is roughly 64 wide so we
  // want ~2 swirl features visible across it (curlScale ≈ 0.04).
  // `inwardBias` blends a unit vector toward the playfield center into
  // the curl direction; it's the §1.4 attention-guidance lever — kept at
  // zero by default so the field reads as ambient atmosphere, not a
  // funnel. `upBias` preserves the gentle "rising past the camera" feel
  // from the original wobble.
  let flowSpeed   = 0.85;
  let curlScale   = 0.04;
  let inwardBias  = 0.0;
  const upBias    = 0.18;
  // Flow-target smoothing time-constant. Smaller = velocity tracks the
  // sampled curl more rigidly; larger = velocity glides through swirl
  // boundaries instead of snapping to them. 0.45 reads as "drifting".
  const TAU = 0.45;

  // Reused scratch vector — keep the hot loop allocation-free.
  const _curl = new Float32Array(3);

  function update(dt, time) {
    const posAttr   = geo.attributes.position;
    const alphaAttr = geo.attributes.aAlpha;
    // Low-pass coefficient. Per-frame `dt` varies (especially under
    // slow-mo / pause), so derive `k` from `dt` rather than baking a
    // fixed multiplier — keeps the response time-correct under any
    // frame budget.
    const k = 1 - Math.exp(-dt / TAU);
    // Slow temporal drift of the sampled point so even stationary
    // particles see the field "breathe" — keeps the volume from
    // looking frozen in still moments. Coefficient is small; the
    // CPU integration is the dominant motion source.
    const tShift = time * 0.01;

    for (let i = 0; i < N; i++) {
      ages[i] += dt;
      if (ages[i] >= lives[i]) { spawn(i, false); }

      let px = positions[i*3+0];
      let py = positions[i*3+1];
      let pz = positions[i*3+2];

      // Sample curl at the particle position in normalized field space.
      // The 3D texture wraps, so any input range is fine; we add a tiny
      // time shift so the field itself slowly evolves.
      ambientCurl.sample(
        _curl,
        px * curlScale + tShift,
        py * curlScale + tShift * 0.7,
        pz * curlScale + tShift * 1.3,
      );
      let cx = _curl[0];
      let cy = _curl[1];
      let cz = _curl[2];

      // Optional inward bias toward the playfield center. Blends a unit
      // vector into the curl direction; norm of result stays ~1 so
      // flowSpeed remains the dominant magnitude control.
      if (inwardBias > 0) {
        const dx = -px;
        const dy = -py;
        const dz = -(pz - AMBIENT_VOL.zOffset);
        const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (len > 1e-3) {
          const inv = inwardBias / len;
          cx += dx * inv;
          cy += dy * inv;
          cz += dz * inv;
        }
      }

      // Target velocity: curl direction scaled by flowSpeed, plus a
      // small upward bias so the field still feels like it's rising.
      const tvx = cx * flowSpeed;
      const tvy = cy * flowSpeed + upBias;
      const tvz = cz * flowSpeed;

      // First-order low-pass toward the target. Without this, velocity
      // would jump on every frame (curl is a position-only function),
      // and particles crossing swirl cell boundaries would visibly
      // snap. Smoothing also implicitly damps high-frequency noise.
      let vx = velocities[i*3+0];
      let vy = velocities[i*3+1];
      let vz = velocities[i*3+2];
      vx += (tvx - vx) * k;
      vy += (tvy - vy) * k;
      vz += (tvz - vz) * k;
      velocities[i*3+0] = vx;
      velocities[i*3+1] = vy;
      velocities[i*3+2] = vz;

      px += vx * dt;
      py += vy * dt;
      pz += vz * dt;

      // Toroidal wrap on Y so particles always feel like they're rising past
      // the camera. X/Z wrap softly to keep the volume populated.
      if (py >  AMBIENT_VOL.y) py -= AMBIENT_VOL.y * 2;
      if (py < -AMBIENT_VOL.y) py += AMBIENT_VOL.y * 2;
      if (px >  AMBIENT_VOL.x) px -= AMBIENT_VOL.x * 2;
      if (px < -AMBIENT_VOL.x) px += AMBIENT_VOL.x * 2;
      if (pz - AMBIENT_VOL.zOffset >  AMBIENT_VOL.z) pz -= AMBIENT_VOL.z * 2;
      if (pz - AMBIENT_VOL.zOffset < -AMBIENT_VOL.z) pz += AMBIENT_VOL.z * 2;

      positions[i*3+0] = px;
      positions[i*3+1] = py;
      positions[i*3+2] = pz;

      alphas[i] = envelope(ages[i] / lives[i]);
    }

    posAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
  }

  function setPointScaleFromHeight(h) {
    mat.uniforms.uPointScale.value = h * 0.5;
  }

  // Stage-5b binding handles. `setFlowSpeed` is the lowMid → field-speed
  // lever the plan calls out (§Stage 4·10). Clamp the lower bound so the
  // field never freezes — even in silence the room should feel alive.
  function setFlowSpeed(v) { flowSpeed = Math.max(0.1, v); }
  function setCurlScale(v) { curlScale = v; }
  function setInwardBias(v) { inwardBias = v; }

  return {
    update,
    setPointScaleFromHeight,
    setFlowSpeed,
    setCurlScale,
    setInwardBias,
    material: mat,
    points,
  };
})();

// =============================================================
// Line-clear effect — §1.6 of plan_particle_1.md
// -------------------------------------------------------------
// Tetris Effect's clear isn't one big burst — it's 5–7 layered subsystems
// stacked under disciplined color rules (see §1.6.2). The existing game
// already covers:
//   Layer 1 — Cube fragments        : shatter()                 (block color)
//   Layer 3 — Shockwave ring        : triggerShockwave()        (block color)
//   Layer 5 — Flash / row slabs     : triggerFlash()            (white→block)
// The pieces this module adds, per the rev-3 plan:
//   Layer 2 — Stage-palette sparkle : emitLineClearBurst        (stage, lingering)
//   Layer 6 — Camera-space veil     : triggerLineClearVeil      (Tetris+ only)
//   §1.3   — Attention-budget dim  : ambient temporarily makes room
//
// Why a *stage-palette* sparkle when fragments + shockwave + flash already
// inherit the block color? Per §1.6.2 rule 2 (Hydelic interview + gameplay
// observation): Tetris Effect's sparkle layer reads as the *room* responding,
// not as the piece exploding. Without a layer that uses the room's hue,
// every clear feels like a generic confetti pop instead of the stage
// reacting to the player. This is the cheapest single change toward the
// target aesthetic.
// =============================================================

// Stage palette resolver — Stage 8 of plan_particle_2.md.
//
// Now sources from the stage controller (which owns the active stage's
// palette/accent/recipe). Returns the same { sparkleHex, accentHex } shape
// as before so call sites in emitLineClearBurst / triggerLineClearVeil /
// triggerFlash etc. don't need to change. The richer .palette[] array and
// .clearRecipe live on stageController.spec for the LineClearOrchestrator
// in Stage 8b.
function _stagePalette() {
  const spec = stageController.spec;
  return { sparkleHex: spec.sparkleHex, accentHex: spec.accentHex };
}

// -------------------------------------------------------------
// Layer 2 — Stage-palette sparkle pool
// -------------------------------------------------------------
// 2000-particle additive billboard pool, free-slot allocator with ring-cursor
// fallback. Tier-scaled spawn count: a Tetris is *visibly* a different event
// than a single (per §1.6.3 exit criterion), not just a louder one.
// Color rule: 75 % stage palette + 25 % block tint, HDR-boosted ×1.5 so
// bloom amplifies without pushing the sparkle past the bloom threshold's
// muddy-white ceiling.
const CLEAR_SPARKLE_COUNT = 2000;
const clearSparkle = (() => {
  const N = CLEAR_SPARKLE_COUNT;
  const positions  = new Float32Array(N * 3);
  const velocities = new Float32Array(N * 3);
  const ages       = new Float32Array(N);
  const lives      = new Float32Array(N);   // 0 = free slot
  const sizes      = new Float32Array(N);
  const colors     = new Float32Array(N * 3);
  const alphas     = new Float32Array(N);
  let allocCursor = 0;
  // Park free slots offscreen so a stale GPU draw never paints them.
  for (let i = 0; i < N; i++) positions[i*3+1] = 1e6;

  function alloc() {
    for (let probe = 0; probe < N; probe++) {
      const idx = (allocCursor + probe) % N;
      if (lives[idx] <= 0) { allocCursor = (idx + 1) % N; return idx; }
    }
    const idx = allocCursor;
    allocCursor = (allocCursor + 1) % N;
    return idx;
  }

  function spawn(spec) {
    const i = alloc();
    positions[i*3+0]  = spec.x;
    positions[i*3+1]  = spec.y;
    positions[i*3+2]  = spec.z;
    velocities[i*3+0] = spec.vx;
    velocities[i*3+1] = spec.vy;
    velocities[i*3+2] = spec.vz;
    lives[i] = spec.life;
    ages[i]  = 0;
    sizes[i] = spec.size;
    colors[i*3+0] = spec.r;
    colors[i*3+1] = spec.g;
    colors[i*3+2] = spec.b;
    alphas[i] = 0;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aColor',   new THREE.BufferAttribute(colors, 3));
  geo.setAttribute('aSize',    new THREE.BufferAttribute(sizes, 1));
  geo.setAttribute('aAlpha',   new THREE.BufferAttribute(alphas, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTexture:    { value: makeAmbientTexture() }, // soft radial — same look as ambient
      uPointScale: { value: window.innerHeight * 0.5 },
    },
    vertexShader: TRAIL_VERT,
    fragmentShader: TRAIL_FRAG,
    transparent: true, depthWrite: false, depthTest: true,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);

  function update(dt) {
    const posAttr   = geo.attributes.position;
    const colAttr   = geo.attributes.aColor;
    const sizeAttr  = geo.attributes.aSize;
    const alphaAttr = geo.attributes.aAlpha;

    for (let i = 0; i < N; i++) {
      if (lives[i] <= 0) continue;
      ages[i] += dt;
      if (ages[i] >= lives[i]) {
        lives[i] = 0; alphas[i] = 0;
        positions[i*3+1] = 1e6; // park offscreen
        continue;
      }
      // Buoyant: light drag, mild gravity. The "lingering" feel from §1.6
      // comes from low drag + lifetime extending past one beat.
      const dragK = Math.pow(0.97, dt * 60);
      velocities[i*3+0] *= dragK;
      velocities[i*3+1] = velocities[i*3+1] * dragK - 0.5 * dt; // gravity 0.5 (very light)
      velocities[i*3+2] *= dragK;
      positions[i*3+0] += velocities[i*3+0] * dt;
      positions[i*3+1] += velocities[i*3+1] * dt;
      positions[i*3+2] += velocities[i*3+2] * dt;
      // Triangular envelope: fast attack (0..15 % of life), long fade.
      const u = ages[i] / lives[i];
      alphas[i] = u < 0.15 ? (u / 0.15) : Math.pow(1 - (u - 0.15) / 0.85, 1.4);
    }
    posAttr.needsUpdate   = true;
    colAttr.needsUpdate   = true;
    sizeAttr.needsUpdate  = true;
    alphaAttr.needsUpdate = true;
  }
  function setPointScaleFromHeight(h) { mat.uniforms.uPointScale.value = h * 0.5; }
  return { spawn, update, setPointScaleFromHeight, material: mat, points };
})();

// emitLineClearBurst — the public entry. rowIndices is the array of cleared
// row indices (board space, 0 = bottom); rowColors[i] is the average hex
// color of rowIndices[i]'s cells before the row got nulled.
function emitLineClearBurst(rowIndices, rowColors) {
  const rowCount = rowIndices.length;
  if (rowCount === 0) return;
  // §1.6.3 tier scaling — linear in row count, with a Tetris bonus so 4
  // doesn't read as just "more 3". Order of magnitude follows the §1.2
  // "500–3k per event" target, with the per-row baseline tuned down once
  // we account for shatter() + spawnScorePopupBurst already firing.
  const PER_ROW_BASE = 120;
  const tetrisBonus  = rowCount === 4 ? 1.5 : 1.0;
  const PER_ROW = Math.round(PER_ROW_BASE * tetrisBonus);

  const pal = _stagePalette();
  const stageR = ((pal.sparkleHex >> 16) & 0xff) / 255;
  const stageG = ((pal.sparkleHex >> 8)  & 0xff) / 255;
  const stageB = ( pal.sparkleHex        & 0xff) / 255;
  // §1.6.2 rule 4 ("core skews block, periphery skews stage") at the cohort
  // level: 75 % stage palette, 25 % block tint. HDR ×1.5 keeps bloom hot.
  const STAGE_W = 0.75;
  const HDR = 1.5;

  for (let ri = 0; ri < rowCount; ri++) {
    const r = rowIndices[ri];
    const blockHex = rowColors && rowColors[ri] != null ? rowColors[ri] : 0xffffff;
    const blockR = ((blockHex >> 16) & 0xff) / 255;
    const blockG = ((blockHex >> 8)  & 0xff) / 255;
    const blockB = ( blockHex        & 0xff) / 255;
    const cr = (stageR * STAGE_W + blockR * (1 - STAGE_W)) * HDR;
    const cg = (stageG * STAGE_W + blockG * (1 - STAGE_W)) * HDR;
    const cb = (stageB * STAGE_W + blockB * (1 - STAGE_W)) * HDR;
    const yWorld = -PLAY_H / 2 + (r + 0.5) * CELL;

    for (let i = 0; i < PER_ROW; i++) {
      const xWorld = -PLAY_W / 2 + Math.random() * PLAY_W;
      const zWorld = -PLAY_D / 2 + Math.random() * PLAY_D;
      const yJitter = (Math.random() - 0.5) * CELL * 0.7;
      // Gentle radial + upward bias. Calm-stage motion model from §1.6
      // Layer 2 — the "energetic" radial spread is reserved for stages
      // that swap in a different recipe in Phase 7.
      const ang = Math.random() * Math.PI * 2;
      const radial = 1.5 + Math.random() * 3.5;
      clearSparkle.spawn({
        x: xWorld, y: yWorld + yJitter, z: zWorld,
        vx: Math.cos(ang) * radial,
        vy: 1.5 + Math.random() * 3.0,
        vz: Math.sin(ang) * radial * 0.5,
        life: 0.9 + Math.random() * 0.7,        // 0.9–1.6 s lingering
        size: 0.6 + Math.random() * 0.9,
        r: cr, g: cg, b: cb,
      });
    }
  }
  // Trigger the §1.3 attention-budget dim — ambient temporarily makes
  // room. Strength scales with row count.
  triggerAttentionDim(rowCount);
}

// -------------------------------------------------------------
// Layer 6 — Camera-space veil (Tetris+ only)
// -------------------------------------------------------------
// Brief full-screen tint in the dominant palette hue. Implemented as a
// fixed-position div with mix-blend-mode:screen so the tint adds to the
// scene rather than overlaying on top of it (preserves bloom). Opacity
// tweens fast-attack/slow-release. CSS overlay (rather than a fullscreen
// quad) keeps it independent of the scene's render target switching and
// gives us free SDR→sRGB handling.
const _veilEl = (() => {
  const el = document.createElement('div');
  el.style.cssText = `
    position: fixed; inset: 0; z-index: 4;
    pointer-events: none; opacity: 0;
    mix-blend-mode: screen;
    background: rgba(160, 100, 255, 1);
    will-change: opacity, background-color;
  `;
  document.body.appendChild(el);
  return el;
})();
const _veilFx = { active: false, t: 0, dur: 0.42, peak: 0.0 };
function triggerLineClearVeil(rowCount) {
  // Tetris+ gating used to live here as `if (rowCount < 4) return`; Stage 8b
  // moved that decision to the LineClearOrchestrator so a stage that wants
  // veil on triple just flips its recipe entry. rowCount is still passed
  // because future tuning may want to scale veil intensity by tier.
  const pal = _stagePalette();
  const r = (pal.accentHex >> 16) & 0xff;
  const g = (pal.accentHex >> 8)  & 0xff;
  const b = (pal.accentHex      ) & 0xff;
  _veilEl.style.backgroundColor = `rgb(${r}, ${g}, ${b})`;
  _veilFx.active = true;
  _veilFx.t = 0;
  _veilFx.dur  = 0.42;
  _veilFx.peak = 0.42;     // peak opacity — tuned to feel like a "pulse" not a flash
}
function updateLineClearVeil(dt) {
  if (!_veilFx.active) return;
  _veilFx.t += dt;
  const k = Math.min(1, _veilFx.t / _veilFx.dur);
  // Bell envelope: fast attack (0..0.18), long release (0.18..1.0)
  const env = k < 0.18
    ? (k / 0.18)
    : Math.pow(1 - (k - 0.18) / 0.82, 1.5);
  _veilEl.style.opacity = String(_veilFx.peak * env);
  if (k >= 1) {
    _veilFx.active = false;
    _veilEl.style.opacity = '0';
  }
}

// -------------------------------------------------------------
// Level-up "cool wash" — temporary nebula palette swap.
// -------------------------------------------------------------
// On LEVEL_UP, the whole sky crossfades to a random cool palette for a
// brief hold, then crossfades to the *new* resting palette (which may
// differ from the previous one if the level crossed a fixed milestone —
// see config/nebula-progression.js). The nebula covers most of the
// visible background, so this shift recolors the entire scene atmosphere
// — a much more visible punctuation than a screen-blend overlay. The
// asymmetry between phases (fast snap in, slower settle out) reads as a
// deliberate cool flash rather than a generic crossfade.
//
// State machine ticks from animate() — no setTimeout (would desync with
// pause / slow-mo / hot reload).
const _levelUpWash = {
  phase:    'idle',     // 'idle' | 'forward' | 'hold' | 'return'
  t:        0,
  forward:  0.32,       // fast snap to the random flash palette
  hold:     0.55,       // dwell at the flash palette
  release:  1.5,        // slower settle back to the resting palette
  returnTo: null,       // palette to crossfade back to (= new resting)
};

/**
 * @param {number} fromHue   Resting hue before the level-up.
 * @param {number} toHue     Resting hue AFTER the level-up. Equal to
 *   `fromHue` when the level didn't cross a band threshold; differs when
 *   it did (the wash settles into the new band's hue).
 */
function triggerLevelUpWash(fromHue, toHue) {
  // Re-trigger during a wash: snap to the previous return target so the
  // new wash starts from a clean state. Without this, rapid level-ups
  // (debug: mashing console `__bus.emit(EVENTS.LEVEL_UP, ...)`) would
  // strand the nebula mid-fade.
  if (_levelUpWash.phase !== 'idle' && _levelUpWash.returnTo != null) {
    nebula.crossfadeToHue(_levelUpWash.returnTo, 0.1);
  }
  // Random cool flash hue. Excludes both the from- and to-resting hues so
  // the flash always reads as a third, distinct color even when the level
  // crosses a band — "snap to surprise hue, settle into the new resting"
  // rather than "preview the new resting then commit."
  const exclude = (fromHue !== toHue) ? toHue : null;
  const flashHue = pickFlashHue(fromHue, exclude);
  nebula.crossfadeToHue(flashHue, _levelUpWash.forward);
  _levelUpWash.phase = 'forward';
  _levelUpWash.t = 0;
  _levelUpWash.returnTo = toHue;
}
function updateLevelUpWash(dt) {
  if (_levelUpWash.phase === 'idle') return;
  _levelUpWash.t += dt;
  if (_levelUpWash.phase === 'forward' && _levelUpWash.t >= _levelUpWash.forward) {
    _levelUpWash.phase = 'hold';
    _levelUpWash.t = 0;
  }
  if (_levelUpWash.phase === 'hold' && _levelUpWash.t >= _levelUpWash.hold) {
    nebula.crossfadeToHue(_levelUpWash.returnTo, _levelUpWash.release);
    _levelUpWash.phase = 'return';
    _levelUpWash.t = 0;
  }
  if (_levelUpWash.phase === 'return' && _levelUpWash.t >= _levelUpWash.release) {
    _levelUpWash.phase = 'idle';
    _levelUpWash.returnTo = null;
  }
}

// Tracks the resting nebula HUE across level-ups. Initialized to the
// level-1 band entry — must agree with the nebula's initial visible hue
// or the first level-up will fade from somewhere other than the current
// visual state. We seed the nebula to this hue right after instantiation
// (see the createNebulaSky call site).
let _currentRestingHue = hueForLevel(1);

// Player override — when non-null, the effects-panel hue slider has
// pinned a specific hue. Level-up still fires its random flash, but
// settles back to this hue instead of `hueForLevel(level)`. Stage
// changes also defer to this override (see STAGE_CHANGE handler).
// `null` means follow the level progression (the default).
let _userOverrideHue = null;

// Resolve the resting hue: player choice if set, otherwise level-driven.
function _resolveResting(forLevel) {
  return _userOverrideHue != null ? _userOverrideHue : hueForLevel(forLevel);
}

/**
 * Effects-panel hue slider handler. Pins the nebula to a specific hue
 * (0..360) and crossfades immediately. The resting tracker updates so
 * future level-up washes settle on the chosen hue instead of the level
 * progression.
 */
function setOverrideHue(hue) {
  _userOverrideHue = hue;
  nebula.crossfadeToHue(hue, 1.2);
  _currentRestingHue = hue;
}

/**
 * Effects-panel "Auto" toggle handler. When enabled, clears the player's
 * pin and crossfades back to `hueForLevel(currentLevel)` so subsequent
 * level-ups follow the band table.
 */
function setAutoHue(enabled) {
  if (!enabled) return;       // turning auto OFF is implicit when slider moves
  _userOverrideHue = null;
  const target = hueForLevel(level);
  nebula.crossfadeToHue(target, 1.5);
  _currentRestingHue = target;
}

// -------------------------------------------------------------
// §1.3 — Attention-budget dim
// -------------------------------------------------------------
// When a clear fires, the ambient layer's emission temporarily dims so the
// event has visual headroom. The plan calls this "the single biggest
// contributor to polish." Implementation: a 0..1 multiplier the ambient
// shader's uIntensity reads. Drops on clear, recovers over ~0.7 s.
let _clearAttentionMul = 1.0;
function triggerAttentionDim(rowCount) {
  // Tetris cuts intensity to ~50 %, single drops to ~85 %. Multiple in-
  // flight clears stack via min().
  const target = Math.max(0.5, 1.0 - 0.12 * Math.min(rowCount, 4));
  _clearAttentionMul = Math.min(_clearAttentionMul, target);
}
function tickAttentionRecovery(dt) {
  if (_clearAttentionMul < 1.0) {
    // Recovery time constant ~0.7 s — slower than the dim attack so the
    // dim reads as "made room" not "flickered."
    _clearAttentionMul = Math.min(1.0, _clearAttentionMul + dt / 0.7);
    ambientField.material.uniforms.uIntensity.value = _clearAttentionMul;
  }
}

// =============================================================
// Orbit Controls
// =============================================================
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.copy(DEFAULT_CAM_TARGET);
controls.minDistance = 12;
controls.maxDistance = 60;
controls.maxPolarAngle = Math.PI * 0.85;
controls.minPolarAngle = Math.PI * 0.1;
controls.mouseButtons = {
  LEFT: THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.PAN,
};
controls.touches = {
  ONE: THREE.TOUCH.ROTATE,
  TWO: THREE.TOUCH.DOLLY_PAN,
};

// =============================================================
// Glass cube — beveled geometry + real refraction + edge highlights
// =============================================================
// Build a rounded/beveled box manually so light catches the chamfered edges.
function makeRoundedBoxGeometry(width, height, depth, radius, segments) {
  // ExtrudeGeometry approach gives nice beveled corners
  const w = width / 2, h = height / 2, d = depth / 2;
  const r = Math.min(radius, w, h, d);
  const shape = new THREE.Shape();
  shape.moveTo(-w + r, -h);
  shape.lineTo(w - r, -h);
  shape.quadraticCurveTo(w, -h, w, -h + r);
  shape.lineTo(w, h - r);
  shape.quadraticCurveTo(w, h, w - r, h);
  shape.lineTo(-w + r, h);
  shape.quadraticCurveTo(-w, h, -w, h - r);
  shape.lineTo(-w, -h + r);
  shape.quadraticCurveTo(-w, -h, -w + r, -h);
  const extrudeSettings = {
    depth: depth - r * 2,
    bevelEnabled: true,
    bevelThickness: r,
    bevelSize: r,
    bevelOffset: 0,
    bevelSegments: segments,
    curveSegments: segments,
  };
  const geo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
  geo.translate(0, 0, -d + r);
  geo.computeVertexNormals();
  return geo;
}
const cubeSize = CELL * 0.92;
const cubeGeometry = makeRoundedBoxGeometry(cubeSize, cubeSize, cubeSize, 0.08, 4);
// Edge geometry for the highlight wires (use sharp edges threshold)
const edgeGeometry = new THREE.EdgesGeometry(cubeGeometry, 30);
// Smaller inner core geometry
const innerGeometry = makeRoundedBoxGeometry(cubeSize * 0.55, cubeSize * 0.55, cubeSize * 0.55, 0.05, 3);

const materialCache = new Map();
function getCubeMaterial(color, opts = {}) {
  const variant = opts.ghost ? 'g' : (opts.active ? 'a' : 'n');
  const key = color + ':' + variant;
  if (materialCache.has(key)) return materialCache.get(key);
  const c = new THREE.Color(color);
  // Locked cubes are opaque resin (poster colors, glossy clearcoat). Active
  // (currently-falling) cubes use the same look but with extra emissive lift
  // so the controlled piece reads brighter than locked stack. Ghost cubes
  // stay alpha-blended so they read as a preview.
  const mat = new THREE.MeshPhysicalMaterial({
    color: c,
    metalness: 0.0,
    roughness: opts.ghost ? 0.08 : 0.18,
    ior: 1.5,
    clearcoat: 1.0,
    clearcoatRoughness: 0.06,
    specularIntensity: 1.0,
    specularColor: 0xffffff,
    transparent: !!opts.ghost,
    opacity: opts.ghost ? 0.12 : 1.0,
    envMapIntensity: 1.0,
    emissive: c,
    emissiveIntensity: (opts.ghost ? 0.15 : (opts.active ? 0.95 : 0.65)) * colorLumaScale(color),
    side: THREE.FrontSide,
    depthWrite: true,
  });
  // Stage 2: cube body (resin) is structural — its emissive contribution is
  // intentional but should not be a bloom source. The cube CORE (separate
  // additive material) is what blooms. Without this opt-out, the locked
  // cubes' own glossy emissive bloomed back through and washed the case.
  mat.userData.enableBloom = false;
  materialCache.set(key, mat);
  return mat;
}

// Edge highlight material — bright thin wireframe along the chamfer.
// Locked cubes use opaque normal-blended edges so the seam between two
// adjacent same-color cubes reads as a discrete bright line, not a soft
// additive smear. Ghost cubes keep additive blending so they float.
function getEdgeMaterial(color, ghost) {
  const ec = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.75);
  return new THREE.LineBasicMaterial({
    color: ec,
    transparent: !!ghost,
    opacity: ghost ? 0.2 : 1.0,
    blending: ghost ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: !ghost,
  });
}

// Ghost body material — a faint additive fill so the landing preview reads
// as a *volume* instead of a hairline wireframe. Additive blending keeps it
// visually obvious that this is a hologram, not a real cube. Cached per
// color since the ghost is rebuilt on every move.
const _ghostBodyCache = new Map();
function getGhostBodyMaterial(color) {
  if (_ghostBodyCache.has(color)) return _ghostBodyCache.get(color);
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity: 0.12,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  _ghostBodyCache.set(color, mat);
  return mat;
}

// Inner glowing core material — additive hot spot (the "molten" core)
function getCoreMaterial(color) {
  return new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.55 * colorLumaScale(color),
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

// =============================================================
// Energized highlight — fresnel rim shell for the active piece
// (and for cubes still cooling down right after lock).
// =============================================================
// View-space fresnel: bright at grazing silhouette, fades on flat faces.
// Additive blending + depthWrite=false → composes cleanly over the glass
// transmission pass and is bloom-compatible without saturating.
const FRESNEL_VERT = GLASS_VERT;
const FRESNEL_FRAG = GLASS_FRAG_PIECE;
const _fresnelShellGeo = cubeGeometry; // share geometry; scale the mesh
const fresnelMaterialCache = new Map();
function getActiveFresnelMaterial(color) {
  if (fresnelMaterialCache.has(color)) return fresnelMaterialCache.get(color);
  const c = new THREE.Color(color);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: c.clone().lerp(new THREE.Color(0xffffff), 0.35) },
      uIntensity: { value: 1.0 },
      uPower: { value: 2.6 },
      uFloor: { value: 0.06 },
      uEdgeColor: { value: new THREE.Color(0xffffff) },
      uEdgeIntensity: { value: 0.55 },
    },
    vertexShader: FRESNEL_VERT,
    fragmentShader: FRESNEL_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  fresnelMaterialCache.set(color, mat);
  return mat;
}
function makeFresnelMaterialClone(color, intensity = 1.0) {
  const c = new THREE.Color(color);
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: c.clone().lerp(new THREE.Color(0xffffff), 0.35) },
      uIntensity: { value: intensity },
      uPower: { value: 2.6 },
      uFloor: { value: 0.06 },
      uEdgeColor: { value: new THREE.Color(0xffffff) },
      uEdgeIntensity: { value: 0.55 },
    },
    vertexShader: FRESNEL_VERT,
    fragmentShader: FRESNEL_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.FrontSide,
  });
}
function makeFresnelShell(material) {
  const shell = new THREE.Mesh(_fresnelShellGeo, material);
  shell.scale.setScalar(1.045);
  shell.renderOrder = 4;
  return shell;
}

// =============================================================
// Glass material — fresnel-driven alpha for the case walls / bottom.
// =============================================================
// Real glass is nearly invisible head-on and brightens at grazing edges
// where the surface curvature catches reflections. With no env map to
// sample, MeshPhysicalMaterial can't reproduce that — it either flashes
// at single reflection angles (metallic) or tints uniformly (rough), the
// latter reading as plastic. This shader bakes the fresnel directly:
// face-on alpha is tiny, rim alpha is high, with a smooth ramp between.
const GLASS_FRAG = GLASS_FRAG_CASE;
function makeGlassMaterial({ tint = 0xc8e6ff, rim = 0xffffff,
                             tintAlpha = 0.05, rimAlpha = 0.55,
                             power = 3.5 } = {}) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTint:      { value: new THREE.Color(tint) },
      uRimColor:  { value: new THREE.Color(rim) },
      uTintAlpha: { value: tintAlpha },
      uRimAlpha:  { value: rimAlpha },
      uPower:     { value: power },
    },
    vertexShader: FRESNEL_VERT, // shares the existing world-space N + V varyings
    fragmentShader: GLASS_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.FrontSide, // single visible face per wall — no double-tint stacking
  });
  // Stage 2: case glass should remain calm — bloom is for the contents, not
  // the container. The thin emissive trim (frame LineSegments) blooms; the
  // glass walls themselves do not.
  mat.userData.enableBloom = false;
  return mat;
}

// Active-piece tunables — shared base values that the per-frame pulse rides on.
const ACTIVE_EMISSIVE_BASE = 0.95;   // matches getCubeMaterial's active value
const LOCKED_EMISSIVE_BASE = 0.65;   // matches getCubeMaterial's locked value
const ACTIVE_EDGE_OPACITY  = 1.0;
const ACTIVE_CORE_OPACITY  = 0.85;   // hotter than the locked 0.55
const LOCKED_CORE_OPACITY  = 0.55;
const SETTLE_DURATION      = 0.95;   // seconds, in the requested 0.5–1.5 band

// Cubes that are mid-fade after locking. Each entry owns *cloned* materials
// so its emissive/opacity can be tweened independently of the shared cache.
const settlingCubes = [];

function makeCube(color, opts = {}) {
  const group = new THREE.Group();

  // Ghost piece: a hologram of where the active piece will land. A faint
  // additive body fill plus a bright outer wireframe and a 88%-inset
  // secondary wire — combination reads as "translucent preview" without
  // becoming invisible (pure-wireframe ghosts dropped below the visibility
  // floor against the case + bloom background, plan_fix_3 G16 revised).
  if (opts.ghost) {
    const body = new THREE.Mesh(cubeGeometry, getGhostBodyMaterial(color));
    body.renderOrder = 1;
    group.add(body);
    const edgeMat = getEdgeMaterial(color, true);
    edgeMat.opacity = 0.7; // boost from default 0.2 — line width is locked at
                           // 1px in WebGL so opacity is the only way to push
                           // visibility.
    const outerEdges = new THREE.LineSegments(edgeGeometry, edgeMat);
    outerEdges.renderOrder = 3;
    group.add(outerEdges);
    const innerMat = edgeMat.clone();
    innerMat.opacity = 0.35;
    const innerEdges = new THREE.LineSegments(edgeGeometry, innerMat);
    innerEdges.scale.setScalar(0.88);
    innerEdges.renderOrder = 3;
    group.add(innerEdges);
    group.userData.color = color;
    return group;
  }

  // For settling cubes we clone the locked material so emissiveIntensity can
  // be animated without affecting other locked cubes that share the cache.
  let mainMat;
  if (opts.settling) {
    mainMat = getCubeMaterial(color, {}).clone();
    mainMat.emissive = new THREE.Color(color); // ensure unique Color instance
    mainMat.emissiveIntensity = ACTIVE_EMISSIVE_BASE * colorLumaScale(color);
  } else {
    mainMat = getCubeMaterial(color, opts);
  }
  const mesh = new THREE.Mesh(cubeGeometry, mainMat);
  // Cubes render BEFORE the case walls so transparent-pass sort places
  // them behind the walls correctly regardless of camera angle.
  mesh.renderOrder = 2;
  group.add(mesh);

  // Edge highlight — picks out the bevel
  const edgeMat = getEdgeMaterial(color, false);
  if (opts.settling || opts.active) {
    // Make edges transparent so opacity tween reads; locked cubes keep
    // opaque normal-blended edges by going through the standard path.
    edgeMat.transparent = true;
    edgeMat.opacity = ACTIVE_EDGE_OPACITY;
  }
  const edges = new THREE.LineSegments(edgeGeometry, edgeMat);
  edges.renderOrder = 3;
  group.add(edges);

  // Inner glow core — for emissive volumetric look
  let coreMat = null;
  if (!opts.ghost) {
    coreMat = getCoreMaterial(color);
    if (opts.settling || opts.active) coreMat.opacity = ACTIVE_CORE_OPACITY * colorLumaScale(color);
    const core = new THREE.Mesh(innerGeometry, coreMat);
    core.renderOrder = 3;
    group.add(core);
  }

  // Fresnel rim shell — adds the energized halo.
  let fresnelMat = null;
  if (opts.active) {
    fresnelMat = getActiveFresnelMaterial(color); // shared, animated globally
    group.add(makeFresnelShell(fresnelMat));
  } else if (opts.settling) {
    fresnelMat = makeFresnelMaterialClone(color, 1.0); // per-cube fade
    group.add(makeFresnelShell(fresnelMat));
  }

  group.userData.color = color;

  if (opts.settling) {
    settlingCubes.push({
      group,
      mainMat,
      edgeMat,
      coreMat,
      fresnelMat,
      color,
      energy: 1.0,
      duration: SETTLE_DURATION,
    });
  }

  return group;
}

// =============================================================
// Glass case (playfield container)
// =============================================================
const caseGroup = new THREE.Group();
scene.add(caseGroup);

// Glass shell — built as 4 individual side walls + bottom (no top, like reference).
// Uses the custom fresnel-driven glass shader (above): nearly invisible at
// face-on view, bright glassy rim at grazing angles. This is what gives the
// wall a true-glass read instead of a uniformly-tinted plastic slab.
const wallThickness = 0.06;
const wallMat = makeGlassMaterial({
  tint: 0xc8e6ff,     // very faint cyan body tint
  rim:  0xffffff,     // clean white edge catch
  tintAlpha: 0.04,    // body is almost fully transparent
  rimAlpha:  0.55,    // edges read clearly so the case shape stays defined
  power:     3.5,
});
function addWall(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Mesh(g, wallMat);
  m.position.set(x, y, z);
  // Render walls FIRST in the transparent pass (before additive cube cores,
  // fresnel rim shells, and particle effects) so those overlays composite on
  // top of the wall instead of being dimmed by its alpha blend. Otherwise,
  // looking through the front wall washes out the energized-piece glow that
  // is clearly visible from above (where no wall is in the line of sight).
  m.renderOrder = -1;
  caseGroup.add(m);
  return m;
}
// Front, back, left, right
addWall(PLAY_W + wallThickness*2, PLAY_H, wallThickness, 0, 0,  PLAY_D/2 + wallThickness/2);
addWall(PLAY_W + wallThickness*2, PLAY_H, wallThickness, 0, 0, -PLAY_D/2 - wallThickness/2);
addWall(wallThickness, PLAY_H, PLAY_D, -PLAY_W/2 - wallThickness/2, 0, 0);
addWall(wallThickness, PLAY_H, PLAY_D,  PLAY_W/2 + wallThickness/2, 0, 0);
// Bottom — same fresnel glass treatment, with a slightly heavier body so the
// stack still reads as resting on something solid.
const bottomMat = makeGlassMaterial({
  tint: 0xc8e6ff,
  rim:  0xffffff,
  tintAlpha: 0.10,
  rimAlpha:  0.55,
  power:     3.0,
});
const bottomGeo = new THREE.BoxGeometry(PLAY_W + wallThickness*2, 0.12, PLAY_D + wallThickness*2);
const bottom = new THREE.Mesh(bottomGeo, bottomMat);
bottom.position.y = -PLAY_H/2 - 0.06;
// Same rationale as walls: render before transparent overlays.
bottom.renderOrder = -1;
caseGroup.add(bottom);

// Edge frame — bright glowing wires around the entire case (top rim, vertical edges, bottom rim)
const frameOuterGeo = new THREE.BoxGeometry(
  PLAY_W + wallThickness*2,
  PLAY_H,
  PLAY_D + wallThickness*2,
);
const frameEdges = new THREE.EdgesGeometry(frameOuterGeo);
const frameMat = new THREE.LineBasicMaterial({
  color: 0xc4ecff,
  transparent: true,
  opacity: 0.65,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const frame = new THREE.LineSegments(frameEdges, frameMat);
caseGroup.add(frame);

// Inner edge frame — traces the interior of the play volume so the case
// reads as a contained box even when the outer frame is camera-occluded.
const innerFrameGeo = new THREE.BoxGeometry(PLAY_W, PLAY_H, PLAY_D);
const innerFrameEdges = new THREE.EdgesGeometry(innerFrameGeo);
const innerFrameMat = new THREE.LineBasicMaterial({
  color: 0x6cf0ff,
  transparent: true,
  opacity: 0.22,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const innerFrame = new THREE.LineSegments(innerFrameEdges, innerFrameMat);
caseGroup.add(innerFrame);

// Bright top rim — extra-prominent (like the reference's lit top edge)
const topRimGeo = new THREE.BoxGeometry(
  PLAY_W + wallThickness*2 + 0.04,
  0.02,
  PLAY_D + wallThickness*2 + 0.04,
);
const topRimEdges = new THREE.EdgesGeometry(topRimGeo);
const topRim = new THREE.LineSegments(topRimEdges, new THREE.LineBasicMaterial({
  color: 0xffffff,
  transparent: true,
  opacity: 0.95,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
}));
topRim.position.y = PLAY_H / 2;
caseGroup.add(topRim);

// Inner light strip running around the top rim (additive)
const rimLightStrip = new THREE.PointLight(0xaee7ff, 1.2, 14, 1.6);
rimLightStrip.position.set(0, PLAY_H/2 + 0.4, 0);
caseGroup.add(rimLightStrip);

// Inner grid lines on back wall (subtle gameplay aid)
const backGridMat = new THREE.LineBasicMaterial({
  color: 0x4a8acc, transparent: true, opacity: 0.12,
});
// Stage 2: dim reference grid — must NOT bloom or it competes with the
// playfield contents.
backGridMat.userData.enableBloom = false;
const backGridGeo = new THREE.BufferGeometry();
const backVerts = [];
const backZ = -PLAY_D / 2 - 0.01;
for (let i = 0; i <= COLS; i++) {
  const x = -PLAY_W / 2 + i * CELL;
  backVerts.push(x, -PLAY_H / 2, backZ, x, PLAY_H / 2, backZ);
}
for (let j = 0; j <= ROWS; j++) {
  const y = -PLAY_H / 2 + j * CELL;
  backVerts.push(-PLAY_W / 2, y, backZ, PLAY_W / 2, y, backZ);
}
backGridGeo.setAttribute('position', new THREE.Float32BufferAttribute(backVerts, 3));
const backGrid = new THREE.LineSegments(backGridGeo, backGridMat);
caseGroup.add(backGrid);

// Floor inside case — polished reflective surface so cubes get a faint reflection
const innerFloorGeo = new THREE.PlaneGeometry(PLAY_W, PLAY_D);
const innerFloorMat = new THREE.MeshPhysicalMaterial({
  color: 0x0a1020,
  roughness: 0.15,
  metalness: 0.9,
  envMapIntensity: 1.2,
  clearcoat: 0.8,
  clearcoatRoughness: 0.1,
});
// Stage 2: structural reflective floor — should not bloom.
innerFloorMat.userData.enableBloom = false;
const innerFloor = new THREE.Mesh(innerFloorGeo, innerFloorMat);
innerFloor.rotation.x = -Math.PI / 2;
innerFloor.position.y = -PLAY_H / 2 + 0.015;
caseGroup.add(innerFloor);

// Static flash-light pool — pre-allocated PointLights for line-clear flashes.
// Adding/removing PointLights at runtime forces Three.js to recompile every
// material that responds to lights, causing the multi-line-clear stutter.
// Keep them parented permanently with intensity:0 and animate intensity only.
const FLASH_LIGHT_POOL_SIZE = 5; // 4 for a Tetris + 1 for hard-drop impact
const flashLightPool = [];
for (let i = 0; i < FLASH_LIGHT_POOL_SIZE; i++) {
  const fl = new THREE.PointLight(0xffffff, 0, 30);
  fl.position.set(0, 0, 0);
  caseGroup.add(fl);
  flashLightPool.push({ light: fl, busy: false });
}
function acquireFlashLight() {
  for (const slot of flashLightPool) {
    if (!slot.busy) { slot.busy = true; return slot; }
  }
  return null; // all in use; skip this flash light (visual: still has plane flash)
}

// Static flash-slab pool — 4 horizontal + 4 vertical PlaneGeometry meshes
// pre-allocated. Tetris clear = 4 rows × (1 H + 1 V) = 8 slabs needed.
// Each slab fades white-hot → row-color over its lifetime so the clear
// keeps the visual identity of the cleared piece colors.
const FLASH_SLAB_POOL_SIZE = 400;
const _flashSlabGeo = new THREE.PlaneGeometry(PLAY_W * 1.6, CELL * 1.4);
const flashSlabPoolH = [];
const flashSlabPoolV = [];
for (let i = 0; i < FLASH_SLAB_POOL_SIZE; i++) {
  for (const isVertical of [false, true]) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(_flashSlabGeo, mat);
    if (isVertical) mesh.rotation.y = Math.PI / 2;
    mesh.visible = false;
    caseGroup.add(mesh);
    (isVertical ? flashSlabPoolV : flashSlabPoolH).push({ mesh, busy: false });
  }
}
function acquireFlashSlab(vertical) {
  const pool = vertical ? flashSlabPoolV : flashSlabPoolH;
  for (const slot of pool) if (!slot.busy) { slot.busy = true; return slot; }
  return null;
}

// Impact effect — multi-component burst when a hard drop locks. Three
// concentric rings expand at different rates + a vertical light pillar
// shoots up from the impact point + ground sparks + a tinted flash light.
// All meshes pre-allocated; only matrices/opacity animate.
function _makeImpactRing(innerR, outerR) {
  const geo = new THREE.RingGeometry(innerR, outerR, 56);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.visible = false;
  caseGroup.add(mesh);
  return { mesh, mat };
}
const _impactRing1 = _makeImpactRing(1.40, 1.52); // thin sharp leader
const _impactRing2 = _makeImpactRing(1.32, 1.48); // medium follow-up
const _impactRing3 = _makeImpactRing(1.18, 1.46); // thick slow disc

// Hard-drop trail — semi-transparent cube boxes stretched along each piece
// cell's drop path. Pool-allocated so repeated drops don't churn GC. Boxes
// share one unit-height geometry; per-spawn we scale Y to the drop distance
// and place the mesh at the midpoint of the path.
const TRAIL_POOL_SIZE = 24;
const _trailGeo = new THREE.BoxGeometry(CELL * 0.85, 1, CELL * 0.85);
const trailPool = [];
for (let i = 0; i < TRAIL_POOL_SIZE; i++) {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(_trailGeo, mat);
  mesh.visible = false;
  caseGroup.add(mesh);
  trailPool.push({ mesh, busy: false });
}
const trailFx = []; // {slot, life, maxLife, startOpacity}

const impactFx = { active: false, t: 0, dur: 0.6 };
const _impactPos = new THREE.Vector3();
function triggerImpactRing(x, y, color) {
  // Ground rings at the lock row's floor, centered under the piece
  for (const r of [_impactRing1, _impactRing2, _impactRing3]) {
    r.mesh.position.set(x, y + 0.02, 0);
    r.mat.color.setHex(color);
    r.mesh.scale.setScalar(0.4);
    r.mat.opacity = 0;
    r.mesh.visible = true;
  }

  impactFx.t = 0;
  impactFx.active = true;

  // Ground sparks — reuse the existing GPU sparkle pool
  _impactPos.set(x, y + 0.1, 0);
  spawnSparkles(_impactPos, color, 32);

  // Tinted flash light at the impact point — pulled from the same pool the
  // line-clear flash uses, so a hard-drop-into-clear flow shares slots.
  const ls = acquireFlashLight();
  if (ls) {
    ls.light.position.set(x, y + 0.6, 0);
    ls.light.color.setHex(color);
    ls.light.intensity = 14;
    flashes.push({ slot: ls, life: 0, maxLife: 0.35, kind: 'light' });
  }
}

// Spawn a semi-transparent cube trail along each piece cell's drop path.
// `cells` are the lock-position cells; `dropRows` is how far the piece fell.
// Trail span per cell = (dropRows + 1) * CELL — covers from the start cell
// down through the end cell so the streak reads as the path the piece swept.
function spawnHardDropTrail(cells, dropRows, color) {
  if (dropRows <= 0) return;
  const trailHeight = (dropRows + 1) * CELL;
  for (const { col, row } of cells) {
    let slot = null;
    for (const s of trailPool) if (!s.busy) { slot = s; break; }
    if (!slot) break;
    slot.busy = true;
    const x = -PLAY_W / 2 + (col + 0.5) * CELL;
    const yEndCenter = -PLAY_H / 2 + (row + 0.5) * CELL;
    const yMid = yEndCenter + (dropRows * CELL) / 2;
    slot.mesh.position.set(x, yMid, 0);
    slot.mesh.scale.set(1, trailHeight, 1);
    slot.mesh.material.color.setHex(color);
    // §3.5 trailMul: 0..1 scales the spawn opacity. At 0 the trail is
    // visually disabled even though the slot still reserves bookkeeping.
    const startOpacity = 0.5 * TWEAKS.trailMul;
    slot.mesh.material.opacity = startOpacity;
    slot.mesh.visible = startOpacity > 0;
    trailFx.push({ slot, life: 0, maxLife: 0.45, startOpacity });
  }
}

// =============================================================
// Coordinate helpers — board cell -> world position
// Board origin: column 0 = left, row 0 = bottom, depth slice 0 = back
// =============================================================
function cellToWorld(c, r, d) {
  return new THREE.Vector3(
    -PLAY_W / 2 + (c + 0.5) * CELL,
    -PLAY_H / 2 + (r + 0.5) * CELL,
    -PLAY_D / 2 + (d + 0.5) * CELL,
  );
}

// =============================================================
// Game State
// =============================================================
// Board is COLS × ROWS (no depth dim — pieces always fill all depth slices).
// Cell stores piece color or null. After §3.7's Game extraction the
// canonical board lives in `game._board` — `board` here is a live
// reference into that array (rebound on each game construction by
// `syncFromGame()`), so existing `board[r][c]` reads in main.js continue
// to work without churning every site.
let board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));

// Per-instance gameplay simulation + render mirror. Both are constructed
// in `Mode._wireLifecycle.onStart`; reused across mode swaps via
// dispose+reconstruct. Render-side mesh state (cellMeshes, stack/piece/
// ghost groups, all the lock + line-clear + garbage subscribers) lives
// in BoardView (§3.7 sub-phase 7b). Visual-inertia state (the spring on
// the active piece) stays in main.js — it animates BoardView's
// pieceGroup but isn't part of the simulation.
//
// In versus mode `versusSession` owns a real second simulation (the
// AI opponent — §3.7 sub-phase 7e). When non-null, `game` and
// `boardView` are aliased to the player side (`gameP1` / `viewP1`)
// so the existing legacy gameplay wrappers keep working untouched.
let game           = null;
let boardView      = null;
let versusSession  = null;

// Dual-board layout constants for versus mode. The existing case mesh
// sits at caseGroup origin; the player's well stays there (so the
// chrome wraps it as before). The opponent's well is mounted at
// +OPPONENT_OFFSET_X with no chrome — duplicating the case mesh per
// side is a polish item, not the §3.7 7e deliverable.
const OPPONENT_OFFSET_X    = 14;
const VERSUS_CAM_POS       = new THREE.Vector3(21, 4, 34);
const VERSUS_CAM_TARGET    = new THREE.Vector3(7, 0, 0);

let activePiece = null;
let nextQueue = [];
let holdPiece = null;
let canHold = true;
let score = 0;
let lines = 0;
let level = 1;
let gameOver = false;
let paused = false;

// Inertia / smooth visual offset on the active piece group
const pieceVisualOffset = new THREE.Vector3(0, 0, 0); // current offset
const pieceTargetOffset = new THREE.Vector3(0, 0, 0); // target (always 0 — settles back)
const pieceVel = new THREE.Vector3(0, 0, 0);
let pieceRotVisual = 0;
let pieceRotTarget = 0;
let pieceRotVel = 0;

// Falling timing — gravity curve sourced from the active rules pack so
// per-mode overrides (Sprint locks gravity, future packs can ramp
// differently) Just Work without per-call branching here. The rules pack
// builder receives a thunk for `gravityScalar` so the live TWEAKS.gravity
// slider is reflected on every read.
let fallTimer = 0;
// Active rules pack — initialized to the player's last-selected mode so
// shadow reads (e.g. `activeRules.lineScore` from a stat refresh before
// Mode.start fires) have something to consume. `Mode._wireLifecycle.
// onStart` rebuilds this on every run.
let activeRules = buildRules(Mode.current, { gravityScalar: () => TWEAKS.gravity, bus });

// Pause-aware gameplay-time accumulator — synced from `game._modeTimeMs`
// via `syncFromGame()` after each game call.
let _modeTimeMs = 0;

/**
 * Pull the latest state out of the Game instance into the shadow vars
 * that legacy main.js code still reads. Cheap (object refs + a few
 * primitive copies); call after any `game.X()` mutation.
 *
 * The shadow-var pattern is a §3.7 sub-phase 7a transition: the
 * canonical state lives in Game, but ~250 reads in this file would each
 * need editing to read `game.X` directly. Shadowing collapses that into
 * a single sync call. A future sub-phase (7b: BoardView) is the natural
 * point to remove the shadows entirely.
 */
function syncFromGame() {
  if (!game) return;
  board       = game.board;       // same array reference; in-place mutations stay live
  activePiece = game.activePiece;
  nextQueue   = game.nextQueue;
  holdPiece   = game.holdPiece;
  canHold     = game.canHold;
  score       = game.score;
  lines       = game.lines;
  level       = game.level;
  gameOver    = game.gameOver;
  paused      = game.paused;
  fallTimer   = game.fallTimer;
  activeRules = game.rules;
  _modeTimeMs = game.modeTimeMs;
  _piecesThisSession = game.piecesThisSession;
  _linesThisSession  = game.linesThisSession;
  sessionStart       = game.sessionStart;
}

// =============================================================
// Versus garbage queue (plan_gameplay_1.md §3.6 + §3.7)
// =============================================================
// Game owns the queue + drain logic; main.js exposes a tiny shim so the
// versus-badge's existing `getInboundGarbage()` shape doesn't need to
// change. The mesh-side mutation (cube swap when a queued row applies)
// is wired below as a GARBAGE_APPLIED subscriber.
const GARBAGE_COLOR = 0x808080; // neutral gray; reads as "not mine"

function _queuedGarbageRowCount() {
  return game ? game.queuedGarbageRows : 0;
}

/**
 * Highest non-empty row in a board, 1-indexed (0 = empty board, ROWS =
 * stack reaches the top). Used by versus-badge to render the
 * opponent's stack-height meter.
 */
function _highestFilledRow(board) {
  if (!Array.isArray(board)) return 0;
  for (let r = board.length - 1; r >= 0; r--) {
    const row = board[r];
    if (row && row.some(c => c != null)) return r + 1;
  }
  return 0;
}

// =============================================================
// Input adapters — each is a thin delegate over `game.X()` plus a
// trailing `syncFromGame()` so the legacy shadow vars (`activePiece`,
// `score`, etc.) keep the same values the legacy reads expected.
// All render side-effects (mesh rebuild, sfx, shatter, ring) are wired
// as bus subscribers further down — Game emits, the host reacts.
// =============================================================
function tryMove(dCol, dRow) {
  if (!game) return false;
  const moved = game.tryMove(dCol, dRow);
  syncFromGame();
  return moved;
}

function tryRotate(dir) {
  if (!game) return;
  game.tryRotate(dir);
  syncFromGame();
}

function softDrop() {
  if (!game) return;
  game.softDrop();
  syncFromGame();
}

function hardDrop() {
  if (!game) return;
  const result = game.hardDrop();
  if (!result) { syncFromGame(); return; }
  // Compute world-space ring coords + emit HARD_DROP *before* the
  // lock cascade — preserves the legacy ordering that vfx/director.js
  // subscribers rely on (impact ring shows BEFORE the shatter).
  pieceVel.y -= 8 + result.dropRows * 0.4;
  shake.impulse(0.15 + result.dropRows * 0.02);
  let xSum = 0, xCount = 0;
  for (const cell of result.cells) {
    if (cell.row === result.minRow) {
      xSum += -PLAY_W / 2 + (cell.col + 0.5) * CELL;
      xCount++;
    }
  }
  const ringX = xSum / xCount;
  const ringY = -PLAY_H / 2 + result.minRow * CELL;
  bus.emit(EVENTS.HARD_DROP, {
    dropRows: result.dropRows,
    color:    result.color,
    ringX, ringY,
    minRow:   result.minRow,
    cells:    result.cells,
  });
  game.lockPiece();
  syncFromGame();
}

function lockPiece() {
  if (!game) return;
  game.lockPiece();
  syncFromGame();
}

function holdActive() {
  if (!game) return;
  game.holdActive();
  syncFromGame();
  updateHUD();
}

function spawnPiece(key) {
  if (!game) return;
  game.spawnPiece(key);
  syncFromGame();
}

const cubeAnims = [];
function animateCubeTo(cube, target) {
  cubeAnims.push({
    cube,
    from: cube.position.clone(),
    to: target.clone(),
    t: 0,
    dur: 0.35,
  });
}

// Squash & stretch on lock — cubes are stretched/compressed at lock time
// then spring back to (1,1,1) with overshoot.
const lockAnims = [];
function startLockAnim(cube) {
  cube.scale.set(1.18, 0.82, 1.18);
  lockAnims.push({ cube, t: 0, dur: 0.22 });
}
function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// =============================================================
// Shatter / Particles — GPU-instanced shards (one draw call total)
// =============================================================
// All shards share one InstancedBufferGeometry + ShaderMaterial. Per-instance
// attributes drive position/rotation/color/lifetime in the vertex shader, so
// CPU work is just "write attribute slots and bump needsUpdate." A 4-line
// Tetris with shatterPower=2.5 used to allocate 2,400 Mesh objects + spike GC.
// Now: zero allocations, one draw call regardless of shard count.
// Bumped 2048 → 4096 (plan_fix_3 G20): a top-out cascade can shatter up to
// 600 cubes in ~250ms; even at the 1× shatterPower default that's 4800
// shards. The ring buffer recycles old slots so we don't *need* the full
// count on screen at once, but extra headroom keeps the leading rows of the
// cascade alive long enough to read as a wave instead of a snap. Float32
// allocation cost: ~80KB per attribute, fine.
const SHARD_CAPACITY = 4096;
const _baseShardGeo = new THREE.TetrahedronGeometry(0.22, 0);
const shardGeo = new THREE.InstancedBufferGeometry();
shardGeo.index = _baseShardGeo.index;
shardGeo.setAttribute('position', _baseShardGeo.attributes.position);
shardGeo.setAttribute('normal', _baseShardGeo.attributes.normal);
shardGeo.instanceCount = SHARD_CAPACITY;

const _shardOrigin    = new Float32Array(SHARD_CAPACITY * 3);
const _shardVelocity  = new Float32Array(SHARD_CAPACITY * 3);
const _shardAngVel    = new Float32Array(SHARD_CAPACITY * 3);
const _shardColor     = new Float32Array(SHARD_CAPACITY * 3);
const _shardSpawnTime = new Float32Array(SHARD_CAPACITY);
const _shardMaxLife   = new Float32Array(SHARD_CAPACITY);
const _shardScale     = new Float32Array(SHARD_CAPACITY);
// Initialize all maxLife=0 so every slot starts "expired" (invisible)
for (let i = 0; i < SHARD_CAPACITY; i++) _shardSpawnTime[i] = -1000.0;

const _aOriginAttr    = new THREE.InstancedBufferAttribute(_shardOrigin, 3);
const _aVelocityAttr  = new THREE.InstancedBufferAttribute(_shardVelocity, 3);
const _aAngVelAttr    = new THREE.InstancedBufferAttribute(_shardAngVel, 3);
const _aColorAttr     = new THREE.InstancedBufferAttribute(_shardColor, 3);
const _aSpawnAttr     = new THREE.InstancedBufferAttribute(_shardSpawnTime, 1);
const _aMaxLifeAttr   = new THREE.InstancedBufferAttribute(_shardMaxLife, 1);
const _aScaleAttr     = new THREE.InstancedBufferAttribute(_shardScale, 1);
_aOriginAttr.setUsage(THREE.DynamicDrawUsage);
_aVelocityAttr.setUsage(THREE.DynamicDrawUsage);
_aAngVelAttr.setUsage(THREE.DynamicDrawUsage);
_aColorAttr.setUsage(THREE.DynamicDrawUsage);
_aSpawnAttr.setUsage(THREE.DynamicDrawUsage);
_aMaxLifeAttr.setUsage(THREE.DynamicDrawUsage);
_aScaleAttr.setUsage(THREE.DynamicDrawUsage);
shardGeo.setAttribute('aOrigin',    _aOriginAttr);
shardGeo.setAttribute('aVelocity',  _aVelocityAttr);
shardGeo.setAttribute('aAngVel',    _aAngVelAttr);
shardGeo.setAttribute('aColor',     _aColorAttr);
shardGeo.setAttribute('aSpawnTime', _aSpawnAttr);
shardGeo.setAttribute('aMaxLife',   _aMaxLifeAttr);
shardGeo.setAttribute('aScale',     _aScaleAttr);

const shardMat = new THREE.ShaderMaterial({
  uniforms: {
    uTime:    { value: 0.0 },
    uGravity: { value: new THREE.Vector3(0.0, -16.0, 0.0) },
    uFloorY:  { value: -PLAY_H / 2 - 0.45 },
  },
  vertexShader: SHARD_VERT,
  fragmentShader: SHARD_FRAG,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  fog: false,
});

const shardMesh = new THREE.Mesh(shardGeo, shardMat);
shardMesh.frustumCulled = false; // bounding box would be wrong for shader-driven motion
scene.add(shardMesh);

let _shardCursor = 0;
let _shardClock = 0.0;

// =============================================================
// Sparkle pool — one Points + ShaderMaterial, ring buffer of 4096 slots.
// Each cube cleared used to allocate a fresh BufferGeometry + PointsMaterial
// (~40 allocations per Tetris). Now: zero per-frame allocations.
// =============================================================
const SPARKLE_CAPACITY = 4096;
const sparkleGeo = new THREE.BufferGeometry();
const _sparkleOrigin   = new Float32Array(SPARKLE_CAPACITY * 3);
const _sparkleVelocity = new Float32Array(SPARKLE_CAPACITY * 3);
const _sparkleColor    = new Float32Array(SPARKLE_CAPACITY * 3);
const _sparkleSpawn    = new Float32Array(SPARKLE_CAPACITY);
const _sparkleLife     = new Float32Array(SPARKLE_CAPACITY);
for (let i = 0; i < SPARKLE_CAPACITY; i++) _sparkleSpawn[i] = -1000.0;

const _spOriginAttr   = new THREE.BufferAttribute(_sparkleOrigin, 3);
const _spVelocityAttr = new THREE.BufferAttribute(_sparkleVelocity, 3);
const _spColorAttr    = new THREE.BufferAttribute(_sparkleColor, 3);
const _spSpawnAttr    = new THREE.BufferAttribute(_sparkleSpawn, 1);
const _spLifeAttr     = new THREE.BufferAttribute(_sparkleLife, 1);
_spOriginAttr.setUsage(THREE.DynamicDrawUsage);
_spVelocityAttr.setUsage(THREE.DynamicDrawUsage);
_spColorAttr.setUsage(THREE.DynamicDrawUsage);
_spSpawnAttr.setUsage(THREE.DynamicDrawUsage);
_spLifeAttr.setUsage(THREE.DynamicDrawUsage);
sparkleGeo.setAttribute('position',   _spOriginAttr);
sparkleGeo.setAttribute('aVelocity',  _spVelocityAttr);
sparkleGeo.setAttribute('aColor',     _spColorAttr);
sparkleGeo.setAttribute('aSpawnTime', _spSpawnAttr);
sparkleGeo.setAttribute('aLife',      _spLifeAttr);

const sparkleMat = new THREE.ShaderMaterial({
  uniforms: {
    uTime:    { value: 0.0 },
    uGravity: { value: -16.0 * 0.4 },
    uMap:     { value: makeSparkleTexture() },
    // uSize is in "pixels-at-unit-distance"; gl_PointSize = uSize / -mvPos.z
    uSize:    { value: 220.0 },
  },
  vertexShader: SPARKLE_VERT,
  fragmentShader: SPARKLE_FRAG,
  transparent: true,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  fog: false,
});

const sparkleMesh = new THREE.Points(sparkleGeo, sparkleMat);
sparkleMesh.frustumCulled = false;
scene.add(sparkleMesh);

let _sparkleCursor = 0;

const _shardWorld = new THREE.Vector3();
const _shardColorObj = new THREE.Color();
function shatter(cube) {
  const color = cube.userData.color;
  cube.getWorldPosition(_shardWorld);
  _shardColorObj.set(color);

  // Shard count scales with SHATTER_POWER (1x = 8/cube, cinematic = 16/cube)
  // and the particleQuality preset (§3.5) — low halves count, high adds 50%.
  // All shards write into the shared InstancedBufferGeometry — zero allocations,
  // one draw call regardless of total active shard count.
  const count = Math.round(8 * TWEAKS.shatterPower * particleQualityMul());
  for (let i = 0; i < count; i++) {
    const idx = _shardCursor;
    _shardCursor = (_shardCursor + 1) % SHARD_CAPACITY;
    const i3 = idx * 3;

    _shardOrigin[i3 + 0] = _shardWorld.x + (Math.random() - 0.5) * 0.3;
    _shardOrigin[i3 + 1] = _shardWorld.y + (Math.random() - 0.5) * 0.3;
    _shardOrigin[i3 + 2] = _shardWorld.z + (Math.random() - 0.5) * 0.3;

    // Row-axis biased burst (plan_fix_3 G2): the row "explodes outward"
    // along its long axis (X), arcs upward (Y), and biases positive Z so
    // shards arc into the camera's space rather than disappearing behind
    // the case. Outward magnitude in X scales with column distance from
    // the row's center so a cell at the far edge throws shards harder
    // than one at center — gives each row a coherent "blooming" silhouette
    // instead of every cell exploding identically.
    const xCenterOffset = _shardWorld.x; // case is centered at x=0
    const xDir = xCenterOffset >= 0 ? 1 : -1;
    const xOutwardBase = Math.abs(xCenterOffset) * 0.9;
    const speedScale = TWEAKS.shatterPower;
    const vx = (xDir * (xOutwardBase + 2 + Math.random() * 4)
                + (Math.random() - 0.5) * 1.5) * speedScale;
    const vy = (3 + Math.random() * 4) * speedScale;
    const vz = (1.5 + Math.random() * 3.5) * speedScale; // bias toward camera (+Z)
    _shardVelocity[i3 + 0] = vx;
    _shardVelocity[i3 + 1] = vy;
    _shardVelocity[i3 + 2] = vz;

    // Angular velocity aligned with linear motion — shards tumble end-over-end
    // along the burst axis instead of spinning randomly in place. The tumble
    // axis is roughly perpendicular to (v, world-up); we approximate with
    // (-vz, 0, vx) so each shard rolls around its own travel direction.
    const speed = Math.hypot(vx, vy, vz);
    const tumble = (8 + Math.random() * 8) * (speed > 0.001 ? 1 / speed : 0);
    _shardAngVel[i3 + 0] = -vz * tumble + (Math.random() - 0.5) * 3;
    _shardAngVel[i3 + 1] = (Math.random() - 0.5) * 6;
    _shardAngVel[i3 + 2] =  vx * tumble + (Math.random() - 0.5) * 3;

    _shardColor[i3 + 0] = _shardColorObj.r;
    _shardColor[i3 + 1] = _shardColorObj.g;
    _shardColor[i3 + 2] = _shardColorObj.b;

    _shardSpawnTime[idx] = _shardClock;
    _shardMaxLife[idx]   = 1.4 + Math.random() * 0.5;
    _shardScale[idx]     = 0.7 + Math.random() * 0.7;
  }
  _aOriginAttr.needsUpdate    = true;
  _aVelocityAttr.needsUpdate  = true;
  _aAngVelAttr.needsUpdate    = true;
  _aColorAttr.needsUpdate     = true;
  _aSpawnAttr.needsUpdate     = true;
  _aMaxLifeAttr.needsUpdate   = true;
  _aScaleAttr.needsUpdate     = true;

  // Sparkle count also scales with power
  spawnSparkles(_shardWorld, color, Math.round(6 * TWEAKS.shatterPower));
}

const _sparkleColorObj = new THREE.Color();
function spawnSparkles(pos, color, count) {
  _sparkleColorObj.set(color);
  for (let i = 0; i < count; i++) {
    const idx = _sparkleCursor;
    _sparkleCursor = (_sparkleCursor + 1) % SPARKLE_CAPACITY;
    const i3 = idx * 3;
    _sparkleOrigin[i3 + 0]   = pos.x;
    _sparkleOrigin[i3 + 1]   = pos.y;
    _sparkleOrigin[i3 + 2]   = pos.z;
    _sparkleVelocity[i3 + 0] = (Math.random() - 0.5) * 8;
    _sparkleVelocity[i3 + 1] = (Math.random() - 0.2) * 5;
    _sparkleVelocity[i3 + 2] = (Math.random() - 0.5) * 8;
    _sparkleColor[i3 + 0]    = _sparkleColorObj.r;
    _sparkleColor[i3 + 1]    = _sparkleColorObj.g;
    _sparkleColor[i3 + 2]    = _sparkleColorObj.b;
    _sparkleSpawn[idx]       = _shardClock; // share the same clock as shards
    _sparkleLife[idx]        = 1.2;
  }
  _spOriginAttr.needsUpdate   = true;
  _spVelocityAttr.needsUpdate = true;
  _spColorAttr.needsUpdate    = true;
  _spSpawnAttr.needsUpdate    = true;
  _spLifeAttr.needsUpdate     = true;
}

// (makeSparkleTexture is defined earlier near scene setup)

// Flash on cleared rows — fully pooled. Each row triggers an H slab + V slab
// + a pooled point light. Slab color tweens from white-hot → row color so
// the clear keeps the cleared piece's color identity instead of a generic
// white blast. Zero allocations per call.
const flashes = []; // pool slots in flight: {slot, life, maxLife, kind, targetColor}
const _flashTargetA = new THREE.Color();
const _flashTargetB = new THREE.Color();
function triggerFlash(rows, rowColors) {
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const y = -PLAY_H / 2 + (r + 0.5) * CELL;
    const rowColor = (rowColors && rowColors[i] != null) ? rowColors[i] : 0xffffff;

    const slotH = acquireFlashSlab(false);
    if (slotH) {
      slotH.mesh.position.set(0, y, 0);
      slotH.mesh.scale.set(1, 1, 1);
      slotH.mesh.material.color.setHex(0xffffff);
      slotH.mesh.material.opacity = 1.0;
      slotH.mesh.visible = true;
      flashes.push({ slot: slotH, life: 0, maxLife: 0.55, kind: 'slab', targetColor: rowColor });
    }

    const slotV = acquireFlashSlab(true);
    if (slotV) {
      slotV.mesh.position.set(0, y, 0);
      slotV.mesh.scale.set(1, 1, 1);
      slotV.mesh.material.color.setHex(0xffffff);
      slotV.mesh.material.opacity = 0.85;
      slotV.mesh.visible = true;
      flashes.push({ slot: slotV, life: 0, maxLife: 0.45, kind: 'slab', targetColor: rowColor });
    }

    const lightSlot = acquireFlashLight();
    if (lightSlot) {
      lightSlot.light.position.set(0, y, 0);
      // Light is white-tinted toward row color so it doesn't lose punch.
      _flashTargetA.setHex(rowColor).lerp(_flashTargetB.setHex(0xffffff), 0.5);
      lightSlot.light.color.copy(_flashTargetA);
      lightSlot.light.intensity = 12;
      flashes.push({ slot: lightSlot, life: 0, maxLife: 0.5, kind: 'light' });
    }
  }
}

// =============================================================
// HUD Panels — CSS3D so they look crisp, draggable in 3D
// =============================================================
function makePanelEl(html, opts={}) {
  const el = document.createElement('div');
  el.innerHTML = html;
  el.className = 'hud-panel ' + (opts.cls || '');
  el.style.cssText = `
    pointer-events: auto;
    background: linear-gradient(180deg, rgba(18,22,38,0.85), rgba(8,10,18,0.85));
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 14px;
    padding: 14px 18px;
    color: #f3f5fb;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    box-shadow:
      0 12px 48px rgba(0,0,0,0.6),
      inset 0 1px 0 rgba(255,255,255,0.06),
      0 0 0 1px rgba(108,240,255,0.05),
      0 0 36px rgba(108,240,255,0.08);
    backdrop-filter: blur(12px) saturate(140%);
    -webkit-backdrop-filter: blur(12px) saturate(140%);
    cursor: grab;
    user-select: none;
    min-width: 130px;
  `;
  return el;
}

function panelHTML(label, value, sub, valueClass = '') {
  const cls = valueClass ? ` class="${valueClass}"` : '';
  return `<div class="panel-inner">
    <div style="font-size:10px; letter-spacing:0.22em; color:#8b93ad; text-transform:uppercase; font-weight:600;">${label}</div>
    <div${cls} style="font-size:28px; font-weight:700; letter-spacing:0.02em; margin-top:4px; color:#fff; text-shadow: 0 0 18px rgba(108,240,255,0.3);">${value}</div>
    ${sub ? `<div style="font-size:11px; letter-spacing:0.16em; color:#8b93ad; text-transform:uppercase; margin-top:6px;">${sub}</div>` : ''}
  </div>`;
}

const scoreEl = makePanelEl(panelHTML('Score', '0', 'Level 1'));
scoreEl.id = 'panel-score';
const scoreObj = new CSS3DObject(scoreEl);
scoreObj.position.set(-13, 4, 4);
scoreObj.scale.setScalar(0.025);
cssScene.add(scoreObj);

const linesEl = makePanelEl(panelHTML('Lines', '0', 'Faces cleared'));
linesEl.id = 'panel-lines';
const linesObj = new CSS3DObject(linesEl);
linesObj.position.set(13, -5, 4);
linesObj.scale.setScalar(0.025);
cssScene.add(linesObj);

// Next panel — shows mini cube preview in CSS
const nextEl = makePanelEl(`<div class="panel-inner">
  <div style="font-size:10px; letter-spacing:0.22em; color:#8b93ad; text-transform:uppercase; font-weight:600;">Next</div>
  <div id="next-preview" style="margin-top:8px; height:120px; width:140px; display:flex; align-items:center; justify-content:center; position:relative;"></div>
</div>`);
nextEl.id = 'panel-next';
const nextObj = new CSS3DObject(nextEl);
nextObj.position.set(13, 5, 4);
nextObj.scale.setScalar(0.025);
cssScene.add(nextObj);

// Hold panel
const holdEl = makePanelEl(`<div class="panel-inner">
  <div style="font-size:10px; letter-spacing:0.22em; color:#8b93ad; text-transform:uppercase; font-weight:600;">Hold</div>
  <div id="hold-preview" style="margin-top:8px; height:120px; width:140px; display:flex; align-items:center; justify-content:center; position:relative;"></div>
</div>`);
holdEl.id = 'panel-hold';
const holdObj = new CSS3DObject(holdEl);
holdObj.position.set(-13, -5, 4);
holdObj.scale.setScalar(0.025);
cssScene.add(holdObj);

// Make panels draggable in 3D space (project mouse onto a plane parallel to camera)
function makeDraggable(el, obj) {
  let dragging = false;
  let dragOffset = new THREE.Vector3();
  let dragPlane = new THREE.Plane();
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    dragging = true;
    el.style.cursor = 'grabbing';
    el.setPointerCapture(e.pointerId);

    // Plane perpendicular to camera, through panel position
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    dragPlane.setFromNormalAndCoplanarPoint(camDir, obj.position);

    // Compute initial intersection
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const intersect = new THREE.Vector3();
    raycaster.ray.intersectPlane(dragPlane, intersect);
    dragOffset.copy(obj.position).sub(intersect);

    // Disable orbit while dragging panel
    controls.enabled = false;
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const intersect = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(dragPlane, intersect)) {
      obj.position.copy(intersect).add(dragOffset);
    }
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    el.style.cursor = 'grab';
    try { el.releasePointerCapture(e.pointerId); } catch {}
    controls.enabled = true;
  }
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
  el.addEventListener('lostpointercapture', endDrag);
}
makeDraggable(scoreEl, scoreObj);
makeDraggable(linesEl, linesObj);
makeDraggable(nextEl, nextObj);
makeDraggable(holdEl, holdObj);

// Render mini piece preview into a panel
function renderMiniPiece(container, key) {
  container.innerHTML = '';
  if (!key) return;
  const shape = PIECES[key][0];
  const color = PIECE_COLORS[key];
  const cellSize = 28;
  // Find bounds
  let minR=4, maxR=-1, minC=4, maxC=-1;
  for (let r=0;r<4;r++) for (let c=0;c<4;c++) {
    if (shape[r][c]) {
      if (r<minR) minR=r;
      if (r>maxR) maxR=r;
      if (c<minC) minC=c;
      if (c>maxC) maxC=c;
    }
  }
  const w = (maxC-minC+1)*cellSize;
  const h = (maxR-minR+1)*cellSize;
  const grid = document.createElement('div');
  grid.style.cssText = `
    position: relative;
    width: ${w}px;
    height: ${h}px;
    transform: rotateX(20deg) rotateY(-25deg);
    transform-style: preserve-3d;
  `;
  for (let r=minR;r<=maxR;r++) {
    for (let c=minC;c<=maxC;c++) {
      if (shape[r][c]) {
        const cell = document.createElement('div');
        const hex = '#' + color.toString(16).padStart(6,'0');
        cell.style.cssText = `
          position: absolute;
          left: ${(c-minC)*cellSize}px;
          top: ${(r-minR)*cellSize}px;
          width: ${cellSize-1}px;
          height: ${cellSize-1}px;
          background: linear-gradient(135deg, ${hex}cc, ${hex}66);
          border: 1px solid ${hex};
          border-radius: 2px;
          box-shadow:
            inset 0 0 6px rgba(255,255,255,0.4),
            inset 0 -3px 4px rgba(0,0,0,0.3),
            0 0 8px ${hex}88;
        `;
        grid.appendChild(cell);
      }
    }
  }
  container.appendChild(grid);
}

let _prevScore = 0;
// Score-tick tween (G19): the panel shows _displayedScore which lerps toward
// the real score on big deltas. Tick lives in the animate loop.
let _displayedScore = 0;
const scoreTween = { active: false, from: 0, to: 0, t: 0, dur: 0.4 };
let _prevLines = 0;
function pulsePanel(el, intensity) {
  // Animate the .panel-inner wrapper, NOT the outer element — CSS3DRenderer
  // owns the outer's transform. Intensity is a 0..1 multiplier baked into the
  // keyframes via the --p custom property.
  const inner = el.querySelector('.panel-inner');
  if (!inner) return;
  inner.style.setProperty('--p', intensity.toFixed(3));
  inner.classList.remove('panel-pulse');
  // Force reflow so the next add restarts the animation.
  void inner.offsetWidth;
  inner.classList.add('panel-pulse');
}
function updateHUD() {
  const dScore = score - _prevScore;
  const dLines = lines - _prevLines;
  // Big score deltas (line clears) tween from displayed → target over 0.4s
  // so the HUD reads as a scoreboard ticking up rather than swapping text
  // instantly. Soft-drop +1s skip the tween — they'd never finish before the
  // next +1 anyway, and the constant tween reset would just look like jitter.
  if (dScore >= 100) {
    scoreTween.from = _displayedScore;
    scoreTween.to = score;
    scoreTween.t = 0;
    scoreTween.active = true;
  } else {
    scoreTween.active = false;
    _displayedScore = score;
  }
  scoreEl.innerHTML = panelHTML('Score', _displayedScore.toLocaleString(),
                                `Level ${level}`, 'score-value');
  linesEl.innerHTML = panelHTML('Lines', lines, `Faces cleared`);
  // Re-bind drag (innerHTML wipes children but element reference is preserved)
  // Need to also re-render previews
  nextEl.innerHTML = `<div class="panel-inner">
    <div style="font-size:10px; letter-spacing:0.22em; color:#8b93ad; text-transform:uppercase; font-weight:600;">Next</div>
    <div id="next-preview" style="margin-top:8px; height:120px; width:140px; display:flex; align-items:center; justify-content:center; position:relative;"></div>
  </div>`;
  holdEl.innerHTML = `<div class="panel-inner">
    <div style="font-size:10px; letter-spacing:0.22em; color:#8b93ad; text-transform:uppercase; font-weight:600;">Hold</div>
    <div id="hold-preview" style="margin-top:8px; height:120px; width:140px; display:flex; align-items:center; justify-content:center; position:relative;"></div>
  </div>`;
  const np = nextEl.querySelector('#next-preview');
  const hp = holdEl.querySelector('#hold-preview');
  if (np && nextQueue.length > 0) renderMiniPiece(np, nextQueue[0]);
  if (hp) {
    if (holdPiece) renderMiniPiece(hp, holdPiece);
    else hp.innerHTML = `<div style="
      width:72px; height:72px;
      border:1.5px dashed rgba(108,240,255,0.25);
      border-radius:6px;"></div>`;
  }
  // Pulse panels by score / lines delta. Score uses log10 so soft-drop
  // +1s barely register while a Tetris bonus shakes it hard.
  if (dScore > 0) pulsePanel(scoreEl, Math.min(1, Math.log10(1 + dScore) / 3));
  if (dLines > 0) pulsePanel(linesEl, Math.min(1, dLines / 4));
  _prevScore = score;
  _prevLines = lines;
}

// =============================================================
// Hold
// =============================================================
// =============================================================
// Game Over
// =============================================================
// Topout / goal / time / forfeit all funnel through endRun. After §3.7
// the simulation lives in Game; topouts flow as
// `Game._signalEndRun → onEndRun callback → endRun({reason:'topout'})`.
// The `triggerGameOver()` helper that legacy code called is gone — the
// callback is the single entry point.

// Universal terminal. Emits GAME_OVER (for the existing cascade visuals
// that listen to it) only on topout; emits MODE_END unconditionally so
// HUD/director listeners get a single terminal regardless of reason.
//
// Goal-multiplier: when the rules pack defines a `goalMultiplier` and the
// run ends with `reason: 'goal'`, the live `score` is multiplied in-place
// before any consumer reads it. This is the surface Marathon's "+50%"
// shows up in: the recorded best, the MODE_END payload, and the
// game-over overlay all see the multiplied number consistently.
//
// Versus winner: when `reason: 'topout'` is paired with a `winner` field
// ('player' for bot KO, 'opponent' for player KO, null for double-KO
// draw), the value flows through to MODE_END + the per-mode wins/losses
// updater. Non-versus modes always pass winner=null/undefined.
// Single-shot guard. After §3.7, Game's _signalEndRun has already set
// game.gameOver=true before calling our onEndRun callback — so the
// legacy `if (gameOver) return` guard would always early-out. We use a
// host-local invocation flag instead, reset by resetRunState.
let _endRunInvoked = false;

function endRun({ reason = 'topout', winner } = {}) {
  if (_endRunInvoked) return;
  _endRunInvoked = true;
  // Sync from game so the local shadow vars (score / lines / level /
  // modeTimeMs / sessionStart / _piecesThisSession / _linesThisSession)
  // reflect the final simulation state before the stats write.
  syncFromGame();
  // Versus topout disambiguation — when the player tops out via
  // Game's collide check (no explicit winner), default to "opponent
  // wins" for versus mode.
  if (Mode.current === 'versus' && reason === 'topout' && winner === undefined) {
    winner = 'opponent';
  }
  if (reason === 'topout') {
    bus.emit(EVENTS.GAME_OVER, { score, lines, level });
  }
  // High-score / per-mode best / cumulative totals — extracted helper.
  // Run BEFORE the player can hit "Play Again" so a mid-cascade tab close
  // still records the run. recordEndOfRun returns the multiplied score
  // (when applicable) so we sync the multiplied value back to game so
  // downstream MODE_END consumers (badges, settings panel) see it too.
  try {
    let updateBest = activeRules.updateBest;
    if (Mode.current === 'versus') {
      updateBest = (best, summary) => {
        const w = summary && summary.winner;
        if (w === 'player')        best.wins   = (best.wins   || 0) + 1;
        else if (w === 'opponent') best.losses = (best.losses || 0) + 1;
        else if (reason === 'topout' && w === null) best.draws = (best.draws || 0) + 1;
      };
    }
    const result = recordEndOfRun({
      score, lines, level,
      modeKey: Mode.current,
      reason,
      sessionStartMs: sessionStart,
      piecesPlacedThisRun: _piecesThisSession,
      linesClearedThisRun: _linesThisSession,
      resetsHighScoreSlot: activeRules.resetsHighScoreSlot,
      goalMultiplier:      activeRules.goalMultiplier,
      runTimeMs:           _modeTimeMs,
      winner,
      updateBest,
    }, { loadStats, saveStats });
    if (result && result.multiplied) {
      if (game) game.setScore(result.score);
      score = result.score;
    }
    if (settingsPanel) settingsPanel.refreshStats();
  } catch (err) {
    console.warn('[stats] failed to persist end-of-run stats:', err);
  }
  bus.emit(EVENTS.MODE_END, {
    reason,
    score, lines, level,
    timeMs: _modeTimeMs,
    winner,                  // versus only — undefined for solo modes
  });
}
// Reset everything — board state, render queues, audio cascade, score —
// to the moment-before-first-piece initial conditions. Wrapped in a named
// function so Mode.start({restart:true}) can call it directly without
// going through the DOM button.
//
// After §3.7's Game extraction the canonical board+scoring lives in
// `game`; this function clears the *render-side* spillage (mesh slices,
// particle pools, in-flight animations, FX state) and then asks Game to
// reset its simulation. `game.reset()` calls `spawnPiece()` internally,
// which fires PIECE_SPAWN — the subscriber rebuilds the piece + ghost
// mesh from the post-reset state.
function resetRunState() {
  // Render-side cleanup. BoardView owns cellMeshes + stackGroup +
  // pieceGroup + ghostGroup post-§3.7 sub-phase 7b — it disposes its
  // own cube registry. Anything else (line-clear shards, sparkles,
  // flash slabs, trails, in-flight cube animations, score bursts,
  // overlay state) lives in main.js and is reset here.
  if (boardView) boardView.clear();
  flashes.length = 0;
  cubeAnims.length = 0;
  lockAnims.length = 0;
  // Dispose any in-flight settling cubes' cloned materials (their cubes were
  // already removed above when stackGroup was cleared).
  for (const s of settlingCubes) {
    s.mainMat.dispose();
    s.fresnelMat.dispose();
  }
  settlingCubes.length = 0;
  // Expire all live shards & sparkles by zeroing their spawn times
  for (let i = 0; i < SHARD_CAPACITY; i++)   _shardSpawnTime[i] = -1000.0;
  for (let i = 0; i < SPARKLE_CAPACITY; i++) _sparkleSpawn[i]   = -1000.0;
  _aSpawnAttr.needsUpdate = true;
  _spSpawnAttr.needsUpdate = true;
  // Return any in-flight flash lights and slabs to their pools
  for (const slot of flashLightPool) {
    slot.light.intensity = 0;
    slot.busy = false;
  }
  for (const slot of flashSlabPoolH) { slot.mesh.visible = false; slot.busy = false; }
  for (const slot of flashSlabPoolV) { slot.mesh.visible = false; slot.busy = false; }
  // Reset gameplay-effect state so a fresh game starts clean
  _impactRing1.mesh.visible = false;
  _impactRing2.mesh.visible = false;
  _impactRing3.mesh.visible = false;
  for (const slot of trailPool) { slot.mesh.visible = false; slot.busy = false; }
  trailFx.length = 0;
  impactFx.active = false;
  slowmo.active = false;
  gameTimeScale = 1.0;
  levelUp.active = false;
  levelUpEl.classList.remove('show');
  clearCalloutEl.classList.remove('show');
  // Cancel any in-flight score bursts so a quick restart doesn't leave
  // animations playing over the new game.
  resetScoreBursts();
  _prevScore = 0;
  _prevLines = 0;
  _displayedScore = 0;
  scoreTween.active = false;
  resetAnnouncerForNewGame();
  document.getElementById('gameOver').classList.remove('show');
  // Single-shot end-run guard — flipped to true by endRun, reset here so
  // the next run can fire its terminal exactly once.
  _endRunInvoked = false;
  // Reset simulation. game.reset() → spawnPiece() → emits PIECE_SPAWN,
  // which the subscriber consumes to rebuild the piece + ghost mesh. We
  // sync at the end so legacy reads of `score` / `activePiece` etc. are
  // current.
  if (game) game.reset();
  syncFromGame();
}

// Wire the DOM "Play Again" button + Mode.start lifecycle hook to the
// shared reset path. Both end up calling resetRunState then emitting
// MODE_START so HUD/director listeners get a single canonical signal.
document.getElementById('goRestart').addEventListener('click', () => {
  Mode.start({ restart: true });
});

Mode._wireLifecycle({
  onStart: ({ key, seed, restart }) => {
    // Build the rules pack first; Game owns it from here on. The
    // gravityScalar thunk keeps the live TWEAKS slider working across
    // mode swaps without having to plumb it through Game.
    const rules = buildRules(key, { gravityScalar: () => TWEAKS.gravity, bus });
    // Tear down any prior simulation. dispose() chains down through
    // VersusSession → both games + both boardViews. Solo state is
    // disposed redundantly (game/boardView may alias session.gameP1/
    // viewP1 from a prior versus run); BoardView/Game.dispose are
    // idempotent so the double-call is safe.
    if (versusSession) versusSession.dispose();
    if (boardView)     boardView.dispose();
    if (game)          game.dispose();
    versusSession = null;
    _endRunInvoked = false; // reset host-side end-run guard

    if (key === 'versus') {
      // Real dual-sim — VersusSession owns both Games + BoardViews +
      // the cross-bus garbage bridge. main.js drives the player side
      // via its existing keyboard handlers (`playerInputMode: 'host'`);
      // VersusSession's tickOpponent() drives the bot. Player events
      // ride the global bus so HUD / cinematic FX / audio fire as
      // usual; opponent events stay on a private bus (no leak).
      versusSession = new VersusSession({
        parent: caseGroup,
        rendererDeps: { cellToWorld, makeCube, shatter, animateCubeTo, startLockAnim, playSfx },
        opponentMode: 'bot',
        opponentStrength: 'casual',
        playerInputMode: 'host',
        inputTarget: window,
        busP1: bus,
        onSideEnd: (reason, side) => {
          // Player KO or session-forced opponent_topout → host's endRun
          // does stats persistence + MODE_END. The `_endRunInvoked`
          // guard covers the case where both sides signal in one tick
          // (single-shot per run).
          if (side === 'player') {
            const winner = reason === 'topout' ? 'opponent' : undefined;
            endRun({ reason, winner });
          } else if (side === 'opponent') {
            // Bot KO — player wins.
            endRun({ reason: 'topout', winner: 'player' });
          }
        },
      });
      // Layout: player's well at the case origin (existing chrome
      // wraps it); opponent's well off to the right (no chrome — see
      // OPPONENT_OFFSET_X comment above for the rationale).
      versusSession.dualBoard.leftAnchor.position.x  = 0;
      versusSession.dualBoard.rightAnchor.position.x = OPPONENT_OFFSET_X;
      // Alias the player side into the legacy refs so the gameplay
      // function wrappers (tryMove, hardDrop, etc.) keep driving
      // gameP1 unchanged.
      game      = versusSession.gameP1;
      boardView = versusSession.viewP1;
      // Disable the Phase-6 abstract bot — VersusSession's BotController
      // owns the opponent now. Without this, both bots emit garbage.
      if (typeof versusBot !== 'undefined') {
        versusBot.reset();
        versusBot.setEnabled(false);
      }
      enterVersusCamera();
      versusSession.start();
      if (restart) resetRunState();
      else         syncFromGame();
    } else {
      // Solo modes — single Game + single BoardView, mounted directly
      // under caseGroup at origin (the legacy layout).
      game = new Game({
        rules,
        bus,
        side: 'player',
        onEndRun: ({ reason, winner }) => endRun({ reason, winner }),
      });
      boardView = new BoardView({
        game, bus,
        parent: caseGroup,
        side: 'player',
        cols: COLS, rows: ROWS, depth: DEPTH,
        cellToWorld, makeCube, shatter, animateCubeTo, startLockAnim,
        playSfx,
      });
      if (typeof versusBot !== 'undefined') versusBot.reset();
      exitVersusCamera();
      if (restart) {
        resetRunState();
      } else {
        game.spawnPiece();
        syncFromGame();
      }
    }
    bus.emit(EVENTS.MODE_START, {
      key,
      seed: typeof seed === 'number' ? seed : null,
      initialModeView: rules.initialModeView,
    });
  },
  onStop: (reason) => {
    endRun({ reason });
  },
});

// Game owns the inbound-garbage queue post-§3.7. The bot's emission
// flows through the bus → Game's internal subscription → Game's queue.
// Main.js no longer maintains its own queue; the versus-badge reads via
// `_queuedGarbageRowCount()` (which delegates to game.queuedGarbageRows).

// =============================================================
// Host-side bus subscribers (visual inertia + cinematic FX + HUD)
// =============================================================
// BoardView (world/board-view.js) handles all *mesh* state mutation
// off the same bus events. The handlers here cover the rest: the
// active piece's spring/wobble (visual inertia), the cinematic FX
// layer (callout / popup / slowmo / shake / punch), and HUD refresh.
// They live in main.js because the rotation spring + score popup +
// announcer state are host-scoped — dual-board (§7e) doesn't double
// them; both BoardViews share the same cinematic + HUD.

// PIECE_ROTATE — kick the rotation spring with velocity so the wobble
// swings through zero and decays. Reads as a rotational impulse.
bus.on(EVENTS.PIECE_ROTATE, ({ dir }) => {
  pieceRotVel = dir > 0 ? -8 : 8;
});

// PIECE_SPAWN — reset the visual-inertia state so the new piece reads
// as crisp, and refresh the HUD's hold/next/score readout.
bus.on(EVENTS.PIECE_SPAWN, () => {
  pieceVisualOffset.set(0, 0, 0);
  pieceVel.set(0, 0, 0);
  pieceRotVisual = 0;
  pieceRotTarget = 0;
  pieceRotVel = 0;
  updateHUD();
});

// PIECE_LOCK — bounce the piece's downward velocity and route the
// announcer based on whether the lock cleared anything.
bus.on(EVENTS.PIECE_LOCK, ({ cleared }) => {
  pieceVel.y = -1.0;
  if (cleared > 0) announceLineClear(cleared);
  else             noteNoClearLock();
});

// LINE_CLEAR — cinematic layer (callout / popup / slowmo / shake /
// punch) + HUD refresh. The mesh shatter + stack-down animation is in
// BoardView; this subscriber doesn't touch cellMeshes.
bus.on(EVENTS.LINE_CLEAR, ({ rows, scoreDelta, overallColor }) => {
  if (rows.length >= 2) triggerCallout(rows.length, overallColor);
  triggerScorePopup(scoreDelta, rows[rows.length - 1], overallColor);
  triggerSlowmo(rows.length);
  shake.setForce((0.25 + rows.length * 0.22) * TWEAKS.shatterPower * TWEAKS.shakeMul);
  if (rows.length >= 2) triggerPunchZoom(rows.length);
  updateHUD();
});

// GARBAGE_APPLIED / ZEN_RESCUE — BoardView mirrored the data shift on
// the mesh side; the host just refreshes the HUD so the badge updates.
bus.on(EVENTS.GARBAGE_APPLIED, () => updateHUD());
bus.on(EVENTS.ZEN_RESCUE,      () => updateHUD());

// =============================================================
// Versus AI bot (plan §3.6 v1 — single-process opponent stand-in).
// =============================================================
// The bot is a simple state machine. It exists only when Mode.current ===
// 'versus'; otherwise its tick is a no-op. The player's onLinesCleared
// emits GARBAGE_SENT — the bot subscribes and absorbs into its own
// "stack height" counter. When that counter crosses BOT_DEATH_THRESHOLD,
// the bot tops out and the player wins. The bot also emits its own
// outbound garbage at random 8-12s intervals — slow enough that a
// reasonable player can keep up with clears, fast enough that ignoring
// the queue is fatal.
//
// The bot's `score` is purely cosmetic — it climbs at ~60pts/sec to give
// the HUD's opponent-score readout something to do. Real Versus scoring
// uses wins/losses; the score is flavor.
const BOT_SCORE_PER_MS        = 0.06;      // ~60 pts/sec passive growth
const BOT_GARBAGE_MIN_INTERVAL_MS = 8000;
const BOT_GARBAGE_MAX_INTERVAL_MS = 12000;
const BOT_DEATH_THRESHOLD_ROWS = 12;       // accumulated player→bot garbage to KO
const versusBot = (() => {
  let alive  = false;
  let score  = 0;
  let stackHeight = 0;       // rows of garbage absorbed from the player
  let nextSendInMs = 0;
  let active = false;        // mirrors Mode.current === 'versus'

  function rollNextInterval() {
    return BOT_GARBAGE_MIN_INTERVAL_MS +
      Math.random() * (BOT_GARBAGE_MAX_INTERVAL_MS - BOT_GARBAGE_MIN_INTERVAL_MS);
  }

  function reset() {
    alive  = (Mode.current === 'versus');
    active = (Mode.current === 'versus');
    score  = 0;
    stackHeight = 0;
    nextSendInMs = rollNextInterval();
  }

  function absorbPlayerGarbage(rows) {
    if (!alive || !active) return;
    stackHeight += rows;
    if (stackHeight >= BOT_DEATH_THRESHOLD_ROWS) {
      alive = false;
      // Bot KO → player wins. Routed through endRun so the wins/losses
      // accounting fires and MODE_END reaches every subscriber uniformly.
      endRun({ reason: 'topout', winner: 'player' });
    }
  }

  function tick(dtMs) {
    if (!active || !alive) return;
    if (gameOver || paused) return;
    score += dtMs * BOT_SCORE_PER_MS;
    nextSendInMs -= dtMs;
    if (nextSendInMs <= 0) {
      bus.emit(EVENTS.GARBAGE_RECEIVED, {
        rows:       1,
        holeColumn: pickHoleColumn(COLS, Math.random),
        source:     'opponent',
      });
      nextSendInMs = rollNextInterval();
    }
  }

  // The bot watches the player's outbound stream. Unlike the player's
  // GARBAGE_RECEIVED handler (which feeds the visual queue), the bot
  // applies sent garbage *immediately* to its abstract stack — there's no
  // visual board for the bot in v1.
  bus.on(EVENTS.GARBAGE_SENT, (e) => {
    if (!active || !alive) return;
    if (!e || typeof e.rows !== 'number' || e.rows <= 0) return;
    absorbPlayerGarbage(e.rows);
  });

  return {
    reset,
    tick,
    /**
     * Force-disable the abstract bot. Called by `Mode._wireLifecycle.
     * onStart` when versusSession owns the opponent — the abstract bot
     * shouldn't ALSO emit garbage or absorb the player's clears.
     * Setting active+alive to false makes both `tick()` and the
     * GARBAGE_SENT subscriber early-return.
     */
    setEnabled(b) {
      alive  = b && (Mode.current === 'versus');
      active = b && (Mode.current === 'versus');
    },
    get alive()       { return alive; },
    get active()      { return active; },
    get score()       { return Math.round(score); },
    get stackHeight() { return stackHeight; },
    get deathThreshold() { return BOT_DEATH_THRESHOLD_ROWS; },
  };
})();

// =============================================================
// Input
// =============================================================
const keyState = { left: false, right: false, down: false };
const dasState = { left: 0, right: 0 };
const DAS = 0.16; // delay-auto-shift
const ARR = 0.045; // auto-repeat rate

window.addEventListener('keydown', (e) => {
  if (gameOver) return;
  switch (e.code) {
    case 'ArrowLeft':
      if (!keyState.left) {
        if (tryMove(-1, 0)) {
          pieceVel.x -= 4;
        } else {
          // Wall / stack collision — bonk the visual offset so the piece
          // visibly bumps off and springs back.
          pieceVisualOffset.x -= 0.18;
          pieceVel.x = 0;
        }
        keyState.left = true;
        dasState.left = 0;
      }
      e.preventDefault();
      break;
    case 'ArrowRight':
      if (!keyState.right) {
        if (tryMove(1, 0)) {
          pieceVel.x += 4;
        } else {
          pieceVisualOffset.x += 0.18;
          pieceVel.x = 0;
        }
        keyState.right = true;
        dasState.right = 0;
      }
      e.preventDefault();
      break;
    case 'ArrowDown':
      keyState.down = true;
      e.preventDefault();
      break;
    case 'ArrowUp':
    case 'KeyX':
      tryRotate(1);
      e.preventDefault();
      break;
    case 'KeyZ':
      tryRotate(-1);
      e.preventDefault();
      break;
    case 'Space':
      hardDrop();
      e.preventDefault();
      break;
    case 'KeyC':
    case 'ShiftLeft':
    case 'ShiftRight':
      holdActive();
      e.preventDefault();
      break;
    case 'KeyP':
      if (game) {
        game.setPaused(!game.paused);
        syncFromGame();
      }
      break;
    case 'KeyR':
      resetCamera();
      break;
    case 'KeyO':
      // plan_UI_1.md §3.4 — Settings panel toggle. Don't fire if focus
      // is on a slider / select / text input (e.g. typing in the URL bar
      // overlay), matching the existing E/F panel-toggle gates.
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) break;
      if (settingsPanel) {
        settingsPanel.toggle();
        syncSettingsToggleChrome();
        _persistSettingsSnapshot();
      }
      e.preventDefault();
      break;
  }
});
window.addEventListener('keyup', (e) => {
  switch (e.code) {
    case 'ArrowLeft': keyState.left = false; break;
    case 'ArrowRight': keyState.right = false; break;
    case 'ArrowDown': keyState.down = false; break;
  }
});

function resetCamera() {
  // Tween camera back to default
  camTween.from = camera.position.clone();
  camTween.to = DEFAULT_CAM_POS.clone();
  camTween.fromTarget = controls.target.clone();
  camTween.toTarget = DEFAULT_CAM_TARGET.clone();
  camTween.t = 0;
  camTween.dur = 0.7;
  camTween.active = true;
}

const camTween = { active: false, t: 0, dur: 0.7, from:null, to:null, fromTarget:null, toTarget:null };

/**
 * Slide the camera to the dual-board midpoint so both wells fit in
 * the frame. Called on entering versus mode; `exitVersusCamera`
 * restores the default for solo modes.
 */
function enterVersusCamera() {
  camTween.from = camera.position.clone();
  camTween.to   = VERSUS_CAM_POS.clone();
  camTween.fromTarget = controls.target.clone();
  camTween.toTarget   = VERSUS_CAM_TARGET.clone();
  camTween.t = 0;
  camTween.dur = 0.9;
  camTween.active = true;
}

function exitVersusCamera() {
  // Only tween if we're not already at default — avoids a 0.9s
  // no-op on every solo Mode.start.
  if (camera.position.distanceToSquared(DEFAULT_CAM_POS) < 1e-3 &&
      controls.target.distanceToSquared(DEFAULT_CAM_TARGET) < 1e-3) return;
  camTween.from = camera.position.clone();
  camTween.to   = DEFAULT_CAM_POS.clone();
  camTween.fromTarget = controls.target.clone();
  camTween.toTarget   = DEFAULT_CAM_TARGET.clone();
  camTween.t = 0;
  camTween.dur = 0.9;
  camTween.active = true;
}

// =============================================================
// Punch-zoom for multi-line clears
// Quick dolly toward target then ease back; sized by combo length.
// =============================================================
const punchZoom = createPunchZoom();
function triggerPunchZoom(rowCount) {
  // Combo size: 2=double, 3=triple, 4=tetris-face. Bigger combos punch harder.
  punchZoom.trigger(rowCount, TWEAKS.shatterPower);
}

// =============================================================
// Slow-mo on multi-line clears — global game-time scale (rendering and
// input stay real-time; only game logic + effect lifetimes get scaled).
// =============================================================
let gameTimeScale = 1.0;
const slowmo = { active: false, t: 0, holdScale: 1.0, holdDur: 0, releaseDur: 0 };
function triggerSlowmo(rowCount) {
  // §3.5 slowmoMul scales the holdScale away from 1.0 (real-time). At
  // mul=1 we get the authored holdScale; at mul=0 the scale is 1.0 (no
  // slow-mo); at mul=0.5 we land halfway between authored and real-time.
  function blendedHold(authored) {
    return 1.0 - (1.0 - authored) * TWEAKS.slowmoMul;
  }
  if (rowCount === 4) {
    slowmo.holdScale = blendedHold(0.35); slowmo.holdDur = 0.75; slowmo.releaseDur = 0.55;
  } else if (rowCount === 3) {
    slowmo.holdScale = blendedHold(0.55); slowmo.holdDur = 0.50; slowmo.releaseDur = 0.45;
  } else {
    return; // 1- or 2-line clears stay real-time
  }
  // If the player has slowmoMul = 0, holdScale becomes 1.0 — skip slow-mo
  // entirely so we don't pay the tween cost for a no-op.
  if (TWEAKS.slowmoMul <= 0) return;
  slowmo.t = 0;
  slowmo.active = true;
}

// =============================================================
// Level-up flash — frame color pulse + brief bloom bump + HTML callout
// =============================================================
const levelUpEl = document.getElementById('levelup');
const _frameBaseColor = new THREE.Color();
const _white = new THREE.Color(0xffffff);
let _bloomBaseStrength = 0;
const levelUp = { active: false, t: 0, dur: 0.4 };
function triggerLevelUp(newLevel) {
  // Capture baseline at trigger time — applyMood() may have changed the
  // frame color since boot, and we restore to the *current* mood color.
  _frameBaseColor.copy(frameMat.color);
  _bloomBaseStrength = bloomPass.strength;
  levelUp.active = true;
  levelUp.t = 0;
  // Restart the CSS animation by removing+adding the class across a reflow.
  levelUpEl.textContent = `Level ${newLevel}`;
  levelUpEl.classList.remove('show');
  void levelUpEl.offsetWidth;
  levelUpEl.classList.add('show');
  // Cool background wash. On every level-up: random cool flash → settle
  // into the new resting hue. Resting comes from the player override
  // (effects-panel hue slider) if set, else from the level band table —
  // so milestone levels (5, 10, 15…) commit to a new atmosphere by
  // default, but a player who's pinned a hue stays on it.
  const oldHue = _currentRestingHue;
  const newHue = _resolveResting(newLevel);
  _currentRestingHue = newHue;
  triggerLevelUpWash(oldHue, newHue);
}

// Multi-line callout (DOUBLE / TRIPLE / TETRIS)
const clearCalloutEl = document.getElementById('clearCallout');
const CLEAR_WORDS = { 2: 'Double', 3: 'Triple', 4: 'Tetris' };
const CLEAR_FONT_SIZE = { 2: 56, 3: 72, 4: 96 };
function triggerCallout(rowCount, color) {
  const word = CLEAR_WORDS[rowCount];
  if (!word) return;
  clearCalloutEl.textContent = word + (rowCount === 4 ? '!' : '');
  const hex = '#' + color.toString(16).padStart(6, '0');
  clearCalloutEl.style.fontSize = CLEAR_FONT_SIZE[rowCount] + 'px';
  clearCalloutEl.style.color = hex;
  clearCalloutEl.style.textShadow = `0 0 28px ${hex}, 0 0 80px ${hex}`;
  clearCalloutEl.classList.remove('show');
  void clearCalloutEl.offsetWidth;
  clearCalloutEl.classList.add('show');
}

// =============================================================
// Score burst — explosive 3D-anchored popup + particle dissolve.
// =============================================================
// Three composed effects fire on each line clear:
//
//   1. CSS3D text popup (.score-burst-outer / .score-burst-inner) anchored
//      at the row's world center. The keyframe animation overshoots, jitters,
//      then dissolves; the inner-element animation doesn't fight the
//      CSS3DRenderer transform on the outer.
//
//   2. Particle burst into the existing shard + sparkle GPU pools — voxel
//      fragments + neon dust radiating outward, color-tinted to the row
//      average. Tangential bias on the velocity gives curved trajectories;
//      bloom-on-bright-additive does the motion-blur work without a
//      stretched-billboard shader.
//
//   3. Shockwave ring (3+ row clears only) — a thin additive torus that
//      scales from 0.4 → ~6 with opacity 0.9 → 0 over 0.55s. Pooled, two
//      slots so back-to-back triples don't cut each other off.
//
// Counts and energies scale with rowCount. A Tetris is roughly 4× the dust
// of a single — exponential, not linear, so the read jumps in tier.

// ---- CSS3D popup pool ------------------------------------------------------
const POPUP_POOL_SIZE = 4;
const popupPool = [];
for (let i = 0; i < POPUP_POOL_SIZE; i++) {
  const outer = document.createElement('div');
  outer.className = 'score-burst-outer';
  const inner = document.createElement('div');
  inner.className = 'score-burst-inner';
  inner.textContent = '';
  outer.appendChild(inner);
  const obj = new CSS3DObject(outer);
  obj.scale.setScalar(0.025);     // matches HUD panel world scale
  obj.visible = false;
  cssScene.add(obj);
  popupPool.push({ obj, outer, inner, busy: false, endsAt: 0 });
}
function acquireScorePopup() {
  for (const slot of popupPool) if (!slot.busy) return slot;
  // Pool exhausted (rare — 4 simultaneous clears within 1s) — recycle the
  // oldest by end-time so we never silently drop a popup.
  let oldest = popupPool[0];
  for (const slot of popupPool) if (slot.endsAt < oldest.endsAt) oldest = slot;
  return oldest;
}
function resetScoreBursts() {
  for (const slot of popupPool) {
    slot.inner.classList.remove('show');
    slot.obj.visible = false;
    slot.busy = false;
    slot.endsAt = 0;
  }
}

// ---- Shockwave ring pool (3+ rows) -----------------------------------------
const _shockwaveGeo = new THREE.RingGeometry(0.92, 1.0, 64, 1);
const SHOCKWAVE_POOL_SIZE = 2;
const shockwavePool = [];
for (let i = 0; i < SHOCKWAVE_POOL_SIZE; i++) {
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(_shockwaveGeo, mat);
  mesh.visible = false;
  // Face the camera at trigger time; render after walls so it isn't dimmed
  mesh.renderOrder = 5;
  scene.add(mesh);
  shockwavePool.push({ mesh, mat, busy: false });
}
const shockwaveFx = []; // {slot, t, dur, startScale, peakScale, color}
const _shockNormal = new THREE.Vector3();
function triggerShockwave(worldPos, color, intensity) {
  let slot = null;
  for (const s of shockwavePool) if (!s.busy) { slot = s; break; }
  if (!slot) slot = shockwavePool[0]; // recycle oldest if both busy
  slot.busy = true;
  slot.mesh.position.copy(worldPos);
  // Orient ring so its plane faces the camera (look-at the camera position)
  slot.mesh.lookAt(camera.position);
  slot.mat.color.setHex(color);
  slot.mat.opacity = 0.9;
  slot.mesh.scale.setScalar(0.4);
  slot.mesh.visible = true;
  shockwaveFx.push({
    slot,
    t: 0,
    dur: 0.55,
    peakScale: 4 + intensity * 1.4, // tetris pushes ~9.5× radius
  });
}

// ---- Particle burst from popup origin --------------------------------------
const _burstColor = new THREE.Color();
function spawnScorePopupBurst(worldPos, color, intensity) {
  // intensity = rowCount (1..4). Tier the densities so a Tetris reads as a
  // distinctly bigger event than a single, not just a louder one.
  const _qm = particleQualityMul();
  const SHARD_COUNT   = Math.round((20 + intensity * 22) * TWEAKS.shatterPower * _qm);
  const SPARKLE_COUNT = Math.round((50 + intensity * 70) * TWEAKS.shatterPower * _qm);
  const SPEED_BASE    = 5 + intensity * 1.3;  // m/s
  _burstColor.set(color);

  // ---- voxel/glass shards ----
  for (let i = 0; i < SHARD_COUNT; i++) {
    const idx = _shardCursor;
    _shardCursor = (_shardCursor + 1) % SHARD_CAPACITY;
    const i3 = idx * 3;
    // Uniform-random direction on a sphere
    const theta = Math.random() * Math.PI * 2;
    const u = 2 * Math.random() - 1;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    const dx = s * Math.cos(theta);
    const dy = u;
    const dz = s * Math.sin(theta);
    const speed = SPEED_BASE * (0.6 + Math.random() * 0.8);
    // Tangential component for curved trajectories — perpendicular to the
    // outward direction, varying sign per particle so the burst has a
    // swirl rather than a uniform helical bias.
    const tangX = -dz, tangZ = dx;
    const curve = (Math.random() - 0.5) * speed * 0.6;
    _shardOrigin[i3 + 0] = worldPos.x + (Math.random() - 0.5) * 0.3;
    _shardOrigin[i3 + 1] = worldPos.y + (Math.random() - 0.5) * 0.3;
    _shardOrigin[i3 + 2] = worldPos.z + (Math.random() - 0.5) * 0.3;
    _shardVelocity[i3 + 0] = dx * speed + tangX * curve;
    _shardVelocity[i3 + 1] = dy * speed + 1.2;          // slight upward bias
    _shardVelocity[i3 + 2] = dz * speed + tangZ * curve + 1.5; // toward camera
    _shardAngVel[i3 + 0] = (Math.random() - 0.5) * 18;
    _shardAngVel[i3 + 1] = (Math.random() - 0.5) * 18;
    _shardAngVel[i3 + 2] = (Math.random() - 0.5) * 18;
    _shardColor[i3 + 0] = _burstColor.r;
    _shardColor[i3 + 1] = _burstColor.g;
    _shardColor[i3 + 2] = _burstColor.b;
    _shardSpawnTime[idx] = _shardClock;
    _shardMaxLife[idx]   = 0.7 + Math.random() * 0.5;
    _shardScale[idx]     = 0.45 + Math.random() * 0.55;
  }
  _aOriginAttr.needsUpdate    = true;
  _aVelocityAttr.needsUpdate  = true;
  _aAngVelAttr.needsUpdate    = true;
  _aColorAttr.needsUpdate     = true;
  _aSpawnAttr.needsUpdate     = true;
  _aMaxLifeAttr.needsUpdate   = true;
  _aScaleAttr.needsUpdate     = true;

  // ---- neon dust (sparkles) — denser, faster, shorter-lived than shards.
  // High speed + short life + bloom = streak/motion-blur read at no shader
  // cost. Each sparkle is a billboarded Point with the existing additive
  // material.
  for (let i = 0; i < SPARKLE_COUNT; i++) {
    const idx = _sparkleCursor;
    _sparkleCursor = (_sparkleCursor + 1) % SPARKLE_CAPACITY;
    const i3 = idx * 3;
    const theta = Math.random() * Math.PI * 2;
    const u = 2 * Math.random() - 1;
    const s = Math.sqrt(Math.max(0, 1 - u * u));
    const dx = s * Math.cos(theta);
    const dy = u;
    const dz = s * Math.sin(theta);
    const speed = SPEED_BASE * (0.9 + Math.random() * 1.1);
    _sparkleOrigin[i3 + 0]   = worldPos.x + (Math.random() - 0.5) * 0.2;
    _sparkleOrigin[i3 + 1]   = worldPos.y + (Math.random() - 0.5) * 0.2;
    _sparkleOrigin[i3 + 2]   = worldPos.z + (Math.random() - 0.5) * 0.2;
    _sparkleVelocity[i3 + 0] = dx * speed;
    _sparkleVelocity[i3 + 1] = dy * speed + 2.0;
    _sparkleVelocity[i3 + 2] = dz * speed + 1.8;
    _sparkleColor[i3 + 0]    = _burstColor.r;
    _sparkleColor[i3 + 1]    = _burstColor.g;
    _sparkleColor[i3 + 2]    = _burstColor.b;
    _sparkleSpawn[idx]       = _shardClock;
    _sparkleLife[idx]        = 0.5 + Math.random() * 0.5;
  }
  _spOriginAttr.needsUpdate   = true;
  _spVelocityAttr.needsUpdate = true;
  _spColorAttr.needsUpdate    = true;
  _spSpawnAttr.needsUpdate    = true;
  _spLifeAttr.needsUpdate     = true;
}

// ---- Public entry: replaces the legacy 2D popup ----------------------------
const _popupWorldPos = new THREE.Vector3();
function triggerScorePopup(amount, rowIndex, color) {
  // Anchor the burst at the cleared row's world center, slightly toward
  // camera so it pops in front of cubes.
  const worldY = -PLAY_H / 2 + (rowIndex + 0.5) * CELL;
  _popupWorldPos.set(0, worldY, 1.5);

  // (1) Text popup
  const slot = acquireScorePopup();
  slot.busy = true;
  slot.endsAt = performance.now() + 1000;
  slot.obj.position.copy(_popupWorldPos);
  // Always face the camera — billboarded text reads at any orbit angle.
  slot.obj.lookAt(camera.position);
  const intensity = Math.max(1, Math.min(4, amount >= 800 ? 4 : amount >= 500 ? 3 : amount >= 300 ? 2 : 1));
  slot.inner.className = 'score-burst-inner tier-' + intensity;
  slot.inner.textContent = `+${amount.toLocaleString()}`;
  const hex = '#' + color.toString(16).padStart(6, '0');
  slot.inner.style.color = hex;
  // Hot rim glow that bloom can lift further on top of additive particles.
  slot.inner.style.textShadow =
    `0 0 8px ${hex}, 0 0 22px ${hex}, 0 0 60px ${hex}, 0 0 96px rgba(255,255,255,0.55)`;
  slot.obj.visible = true;
  // Restart the animation: remove + force reflow + add.
  slot.inner.classList.remove('show');
  void slot.inner.offsetWidth;
  slot.inner.classList.add('show');
  // Free the slot after the keyframe duration. Use real wall-clock so the
  // free doesn't get stretched by slow-mo (the CSS animation is wall-clock
  // too, so they stay in sync).
  setTimeout(() => {
    slot.busy = false;
    slot.obj.visible = false;
  }, 1000);

  // (2) Particle burst — fires immediately; the text sits on top in screen
  // space and dissolves into the (already-spreading) particles.
  spawnScorePopupBurst(_popupWorldPos, color, intensity);

  // The shockwave ring used to fire here on triple+; Stage 8b moved it to
  // the LineClearOrchestrator so the stage's `clearRecipe` decides whether
  // the layer participates. See triggerLineClearShockwave below.
}

// Stage 8b — shockwave entry called by the LineClearOrchestrator (recipe-
// gated). Anchors at the bottom-most cleared row so the ring expands from
// where the popup text lands. Same pool, same scaling curve as before — we
// just lift the gate decision out to the orchestrator.
const _orchShockwavePos = new THREE.Vector3();
function triggerLineClearShockwave(rows, color, rowCount) {
  // `rows` is sorted top-down by clearLines (largest row index first), so
  // the last entry is the bottom-most cleared row.
  const bottomRow = rows[rows.length - 1];
  const worldY = -PLAY_H / 2 + (bottomRow + 0.5) * CELL;
  _orchShockwavePos.set(0, worldY, 1.5);
  // intensity drives ring radius (peakScale = 4 + intensity * 1.4); using
  // rowCount keeps the previous curve (triple→8.2, tetris→9.6).
  triggerShockwave(_orchShockwavePos, color, rowCount);
}

// =============================================================
// Camera shake — coherent (multi-frequency sine sum) so the shake reads as
// kinetic motion instead of per-frame static.
// =============================================================
const shake = createShake();

// =============================================================
// Animation Loop
// =============================================================
// Render tick. Driven by the engine Clock (single rAF for the whole app);
// Clock provides clamped dt and monotonic totalSec — no local timekeeping
// state needed here anymore.
function animate(dt, envTime) {

  // Stage 5 — sample audio FIRST, before any visual code reads streams.
  // featureBus.tick is a safe no-op until the user gesture wakes the
  // AudioContext (audio.analyser is null up to that point).
  featureBus.tick(dt);
  // Stage 5b — beat-grid scheduler. Cheap when not analyzed (early-return).
  // Once BPM is cached, projects upcoming beat times from bgmEl.currentTime
  // and dispatches beat / preBeat events — bindings consume `anticipation`.
  beatGrid.tick();
  // Mode HUD per-frame ticks. Each is cheap when the badge isn't visible
  // (one thunk call + an early return). Per the plan, Sprint's timer must
  // update at gameplay rate, not render rate — `_modeTimeMs` is only
  // advanced inside the gameplay block, so reading it here gives the
  // pause-aware value without extra plumbing.
  sprintBadge.tick();
  ultraBadge.tick();
  versusBadge.tick(score);
  bindings.tick();
  featureDebug.update();
  playbackProgress.update();
  // Settings panel — drive the open/close animation tween and keep the
  // gear-button chrome in sync with the panel's visibility (the panel's
  // ✕ close button changes state without going through the gear button).
  if (settingsPanel) {
    settingsPanel.update(dt);
    syncSettingsToggleChrome();
  }

  // Stage 1 — starfield rotation + camera FOV breathing. Both wall-clock
  // driven so they keep "breathing" during pause / slow-mo, matching the
  // ambient field below.
  starfield.update(dt);
  // Stage 10 — nebula time/crossfade advance.
  nebula.update(dt, envTime);
  // Stage 10 — moon self-rotation. Real-time `dt` so it keeps spinning
  // during pause / slow-mo (it's environment, not gameplay).
  moon.update(dt);
  breathe.update(camera, envTime);

  // Ambient particle field (Phase 1: CPU-driven drift). Uses real-time dt so
  // the field keeps breathing during pause / slow-mo — that's the intended
  // feel; it's environment, not gameplay.
  ambientField.update(dt, envTime);

  // §1.6 line-clear layers — sparkle pool sim, veil opacity tween,
  // attention-budget recovery. All real-time so they survive slow-mo
  // (the slow-mo on Tetris is meant to *let you see* the effect, not
  // slow the effect itself).
  clearSparkle.update(dt);
  if (_veilFx.active) updateLineClearVeil(dt);
  if (_levelUpWash.phase !== 'idle') updateLevelUpWash(dt);
  tickAttentionRecovery(dt);
  // Stage 8c env-reaction — Layer 7 streaks. Real-time tick (slow-mo on
  // Tetris is meant to *let you see* the effect, not slow it).
  envReaction.update(dt);

  // Slow-mo tick — drives gameTimeScale. dtGame is what game logic and
  // effect lifetimes consume; rendering and input use real-time dt.
  if (slowmo.active) {
    slowmo.t += dt;
    if (slowmo.t < slowmo.holdDur) {
      gameTimeScale = slowmo.holdScale;
    } else {
      const k = Math.min(1, (slowmo.t - slowmo.holdDur) / slowmo.releaseDur);
      gameTimeScale = slowmo.holdScale + (1 - slowmo.holdScale) * k;
      if (k >= 1) { gameTimeScale = 1.0; slowmo.active = false; }
    }
  } else {
    gameTimeScale = 1.0;
  }
  const dtGame = dt * gameTimeScale;

  // ---- DAS / ARR for held arrows ----
  if (!gameOver && !paused && activePiece) {
    if (keyState.left) {
      dasState.left += dt;
      if (dasState.left > DAS) {
        while (dasState.left > DAS) {
          if (tryMove(-1, 0)) {
            pieceVel.x -= 1.2;
          }
          dasState.left -= ARR;
        }
      }
    }
    if (keyState.right) {
      dasState.right += dt;
      if (dasState.right > DAS) {
        while (dasState.right > DAS) {
          if (tryMove(1, 0)) {
            pieceVel.x += 1.2;
          }
          dasState.right -= ARR;
        }
      }
    }

    // Mode tick — Game owns gravity, modeTimeMs accumulation, the
    // rules pack's onTick + endCondition polling. Soft-drop input is
    // signalled via the InputFrame so Game accelerates fallTimer 12×
    // (matches the legacy down-arrow-held behavior).
    //
    // In versus mode, VersusSession.tickOpponent advances gameP2 (bot
    // intents → tryMove/Rotate/hardDrop on gameP2 + gameP2.tick).
    // The abstract Phase-6 versusBot is disabled in versusSession
    // mode (alive=false from setEnabled(false)), so its tick is a
    // safe no-op even though we still call it.
    const dtMs = dtGame * 1000;
    versusBot.tick(dtMs);
    if (versusSession) versusSession.tickOpponent(dtMs);
    const tickResult = game ? game.tick(dtMs, { softDrop: !!keyState.down }) : null;
    syncFromGame();
    if (tickResult && tickResult.reason) {
      endRun({ reason: tickResult.reason });
    }
  }

  // ---- Piece visual inertia ----
  // Spring toward 0 offset; velocity decays. Gravity tweak shifts feel:
  // low-G (0.5) = floaty/loose, heavy (1.6) = snappy/tight.
  const stiffness = 60 * TWEAKS.gravity;
  const damping = 9 * Math.sqrt(TWEAKS.gravity);
  const accel = new THREE.Vector3()
    .copy(pieceVisualOffset).multiplyScalar(-stiffness)
    .add(pieceVel.clone().multiplyScalar(-damping));
  pieceVel.addScaledVector(accel, dtGame);
  pieceVisualOffset.addScaledVector(pieceVel, dtGame);

  // Rotation wobble
  pieceRotVel += (-pieceRotVisual * 80 - pieceRotVel * 9) * dtGame;
  pieceRotVisual += pieceRotVel * dtGame;

  // Scale offset down to keep within visible bounds
  const maxOff = 0.45;
  pieceVisualOffset.clampLength(-maxOff, maxOff);

  if (boardView) {
    boardView.pieceGroup.position.copy(pieceVisualOffset);
    boardView.pieceGroup.rotation.z = pieceRotVisual * 0.15;
  }

  // ---- Active-piece energized highlight ----
  // Slow breathing pulse + brief boost when the piece is moving fast.
  // Shared materials are updated once per color, regardless of how many
  // cubes the active piece occupies — bounded ≤ 7 writes per frame.
  {
    const pulse = 0.9 +  0.4 *Math.sin(envTime * 7);
    const moveSpeed = Math.sqrt(
      pieceVel.x * pieceVel.x +
      pieceVel.y * pieceVel.y +
      pieceVel.z * pieceVel.z,
    );
    const rotSpeed = Math.abs(pieceRotVel);
    // Map movement to a 0..1 boost; clamp so it can't run away on hard drops.
    const moveBoost = Math.min(1.0, moveSpeed * 0.18 + rotSpeed * 0.06);
    const emissiveMul = pulse * (1.0 + 0.45 * moveBoost);
    const fresnelMul  = pulse * (1.0 + 0.85 * moveBoost);
    for (const color of Object.values(PIECE_COLORS)) {
      const lumaScale = colorLumaScale(color);
      const aMat = materialCache.get(color + ':a');
      if (aMat) aMat.emissiveIntensity = ACTIVE_EMISSIVE_BASE * emissiveMul * lumaScale;
      const fMat = fresnelMaterialCache.get(color);
      // §3.5 rimGlowMul scales the active-piece fresnel rim ONLY (not
      // settling cubes — those use cloned materials and own their own
      // fade timeline). At 0 the rim disappears; at 1.5 it pops harder.
      if (fMat) fMat.uniforms.uIntensity.value = fresnelMul * lumaScale * TWEAKS.rimGlowMul;
    }
  }

  // ---- Settling cubes — energized → cooled glass over ~SETTLE_DURATION ----
  // Each cube owns cloned materials so its fade is independent. When done,
  // release the clones and swap the main mesh back onto the cached locked
  // material so identical settled cubes share state again.
  for (let i = settlingCubes.length - 1; i >= 0; i--) {
    const s = settlingCubes[i];
    // If the cube was removed from the scene (e.g. line-cleared mid-fade),
    // drop the entry and free its cloned materials.
    if (!s.group.parent) {
      s.mainMat.dispose();
      s.fresnelMat.dispose();
      settlingCubes.splice(i, 1);
      continue;
    }
    s.energy -= dtGame / s.duration;
    if (s.energy <= 0) {
      // Finalize: hand the main mesh back to the shared locked material so
      // we don't keep paying for a unique MeshPhysicalMaterial per stack
      // cube. Edges/cores were already created per-cube by the existing
      // code so they keep their (now low-emissive) clones in place.
      const settledMat = getCubeMaterial(s.color, {});
      const mainMesh = s.group.children[0];
      mainMesh.material = settledMat;
      s.mainMat.dispose();
      // Remove and dispose the fresnel rim shell (last child added).
      let shellIdx = -1;
      for (let j = s.group.children.length - 1; j >= 0; j--) {
        if (s.group.children[j].material === s.fresnelMat) { shellIdx = j; break; }
      }
      if (shellIdx >= 0) {
        const shell = s.group.children[shellIdx];
        s.group.remove(shell);
      }
      s.fresnelMat.dispose();
      // Snap edges/core to locked look.
      if (s.edgeMat) {
        s.edgeMat.opacity = 1.0;
        s.edgeMat.transparent = false;
      }
      if (s.coreMat) s.coreMat.opacity = LOCKED_CORE_OPACITY * colorLumaScale(s.color);
      settlingCubes.splice(i, 1);
      continue;
    }
    // easeOutCubic on energy → smooth, cinematic decay
    const e = 1 - Math.pow(1 - s.energy, 3);
    const lumaScale = colorLumaScale(s.color);
    s.mainMat.emissiveIntensity =
      (LOCKED_EMISSIVE_BASE + (ACTIVE_EMISSIVE_BASE - LOCKED_EMISSIVE_BASE) * e) * lumaScale;
    if (s.coreMat) {
      s.coreMat.opacity =
        (LOCKED_CORE_OPACITY + (ACTIVE_CORE_OPACITY - LOCKED_CORE_OPACITY) * e) * lumaScale;
    }
    if (s.edgeMat) {
      // Fade edge transparency from full → opaque locked look.
      s.edgeMat.opacity = 1.0; // edges keep brightness; the rim shell carries the cooldown
    }
    s.fresnelMat.uniforms.uIntensity.value = e * lumaScale;
  }

  // ---- Cube settle anims ----
  for (let i = cubeAnims.length - 1; i >= 0; i--) {
    const a = cubeAnims[i];
    a.t += dtGame;
    const k = Math.min(1, a.t / a.dur);
    const ease = 1 - Math.pow(1 - k, 3);
    a.cube.position.lerpVectors(a.from, a.to, ease);
    if (k >= 1) cubeAnims.splice(i, 1);
  }

  // ---- Lock squash-and-stretch ----
  for (let i = lockAnims.length - 1; i >= 0; i--) {
    const a = lockAnims[i];
    a.t += dtGame;
    const k = Math.min(1, a.t / a.dur);
    const ease = easeOutBack(k);
    // Lerp from initial-stretch (1.18, 0.82, 1.18) to (1, 1, 1) with overshoot.
    a.cube.scale.x = 1.18 + (1 - 1.18) * ease;
    a.cube.scale.y = 0.82 + (1 - 0.82) * ease;
    a.cube.scale.z = 1.18 + (1 - 1.18) * ease;
    if (k >= 1) {
      a.cube.scale.set(1, 1, 1);
      lockAnims.splice(i, 1);
    }
  }

  // ---- Impact effect (hard-drop) ----
  if (impactFx.active) {
    impactFx.t += dtGame;
    const k = Math.min(1, impactFx.t / impactFx.dur);

    // Ring 1 — sharp leader: fastest, biggest, fades early
    const k1 = Math.min(1, k * 1.7);
    const e1 = 1 - Math.pow(1 - k1, 3);
    _impactRing1.mesh.scale.setScalar(0.4 + e1 * 2.6);
    _impactRing1.mat.opacity = Math.pow(1 - k1, 1.3) * 1.0;

    // Ring 2 — medium follow-up, slight delay, mid expansion
    const k2 = Math.max(0, Math.min(1, (k - 0.06) * 1.4));
    const e2 = 1 - Math.pow(1 - k2, 2.5);
    _impactRing2.mesh.scale.setScalar(0.4 + e2 * 1.8);
    _impactRing2.mat.opacity = Math.pow(1 - k2, 1.6) * 0.85;

    // Ring 3 — thick disc, slow, hangs the longest
    const k3 = k;
    const e3 = 1 - Math.pow(1 - k3, 2);
    _impactRing3.mesh.scale.setScalar(0.4 + e3 * 1.0);
    _impactRing3.mat.opacity = Math.pow(1 - k3, 2) * 0.7;

    if (k >= 1) {
      _impactRing1.mesh.visible = false;
      _impactRing2.mesh.visible = false;
      _impactRing3.mesh.visible = false;
      impactFx.active = false;
    }
  }

  // ---- Score-burst shockwave rings (3+ row clears) ----
  for (let i = shockwaveFx.length - 1; i >= 0; i--) {
    const fx = shockwaveFx[i];
    fx.t += dtGame;
    const k = Math.min(1, fx.t / fx.dur);
    // easeOutQuart on scale — fast initial expansion, gentle settle.
    const eS = 1 - Math.pow(1 - k, 4);
    fx.slot.mesh.scale.setScalar(0.4 + eS * fx.peakScale);
    // Opacity fades on a steeper curve so the ring vanishes before its outline
    // gets pixelated by tone mapping.
    fx.slot.mat.opacity = Math.pow(1 - k, 1.4) * 0.9;
    if (k >= 1) {
      fx.slot.mesh.visible = false;
      fx.slot.busy = false;
      shockwaveFx.splice(i, 1);
    }
  }

  // ---- Hard-drop cube trail — fade semi-transparent boxes & return slots ----
  for (let i = trailFx.length - 1; i >= 0; i--) {
    const t = trailFx[i];
    t.life += dtGame;
    const k = Math.min(1, t.life / t.maxLife);
    t.slot.mesh.material.opacity = t.startOpacity * Math.pow(1 - k, 1.6);
    if (k >= 1) {
      t.slot.mesh.visible = false;
      t.slot.busy = false;
      trailFx.splice(i, 1);
    }
  }

  // ---- Shards & Sparkles (both GPU-driven, share _shardClock) ----
  // Physics, rotation, and lifetime fade all happen in the shaders using
  // per-instance attributes; CPU just advances the clock uniform.
  _shardClock += dtGame;
  shardMat.uniforms.uTime.value = _shardClock;
  sparkleMat.uniforms.uTime.value = _shardClock;

  // ---- Flashes ----
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i];
    f.life += dtGame;
    const k = f.life / f.maxLife;
    if (f.kind === 'light') {
      f.slot.light.intensity = 12 * (1 - k);
      if (k >= 1) {
        f.slot.light.intensity = 0;
        f.slot.busy = false;
        flashes.splice(i, 1);
      }
    } else { // 'slab'
      const m = f.slot.mesh.material;
      // White-hot at start, lerp to row color over first half of life.
      _flashTargetA.setHex(0xffffff);
      _flashTargetB.setHex(f.targetColor);
      m.color.copy(_flashTargetA).lerp(_flashTargetB, Math.min(1, k * 2));
      m.opacity = Math.max(0, 1 - k);
      f.slot.mesh.scale.x = 1 + k * 0.5;
      f.slot.mesh.scale.y = 1 + k * 3;
      if (k >= 1) {
        f.slot.mesh.visible = false;
        f.slot.busy = false;
        flashes.splice(i, 1);
      }
    }
  }

  // ---- Camera shake ----
  shake.update(dt, dtGame);

  // ---- Camera tween ----
  if (camTween.active) {
    camTween.t += dt;
    const k = Math.min(1, camTween.t / camTween.dur);
    const ease = 1 - Math.pow(1 - k, 3);
    camera.position.lerpVectors(camTween.from, camTween.to, ease);
    controls.target.lerpVectors(camTween.fromTarget, camTween.toTarget, ease);
    if (k >= 1) camTween.active = false;
  }

  // ---- Score-tick tween (G19) ----
  // Real-time (dt, not dtGame) so the count-up still finishes during slow-mo
  // — slow-motion is a visual flourish on the *world*, the HUD should keep
  // tracking real wall-clock so the player isn't waiting for it.
  if (scoreTween.active) {
    scoreTween.t += dt;
    const k = Math.min(1, scoreTween.t / scoreTween.dur);
    const ease = 1 - Math.pow(1 - k, 3); // easeOutCubic
    _displayedScore = Math.round(scoreTween.from + (scoreTween.to - scoreTween.from) * ease);
    const valEl = scoreEl.querySelector('.score-value');
    if (valEl) valEl.textContent = _displayedScore.toLocaleString();
    if (k >= 1) {
      scoreTween.active = false;
      _displayedScore = scoreTween.to;
    }
  }

  // ---- Level-up flash (frame color + bloom bump) ----
  if (levelUp.active) {
    levelUp.t += dtGame;
    const k = Math.min(1, levelUp.t / levelUp.dur);
    // Bell envelope: 0 → 1 → 0
    const env = k < 0.35 ? (k / 0.35) : Math.pow(1 - (k - 0.35) / 0.65, 2);
    frameMat.color.copy(_frameBaseColor).lerp(_white, env * 0.85);
    bloomPass.strength = _bloomBaseStrength + 0.4 * env;
    if (k >= 1) {
      frameMat.color.copy(_frameBaseColor);
      bloomPass.strength = _bloomBaseStrength;
      levelUp.active = false;
    }
  }

  punchZoom.update(dtGame, camera.position, controls.target);

  controls.update();

  // Apply additive impulse layers around the render call so they don't
  // accumulate into camera.position between frames.
  camera.position.add(shake.offset).add(punchZoom.offset);
  // Stage 2 — render the bloom layer first (masked render → blur). The
  // result is sampled by the combine pass inside the main composer below.
  selectiveBloom.renderBloomLayer();
  composer.render();
  cssRenderer.render(cssScene, camera);
  camera.position.sub(shake.offset).sub(punchZoom.offset);
}

// =============================================================
// Event wiring
// =============================================================
//
// HARD_DROP and LEVEL_UP are owned by vfx/director.js — the single place
// game-feel decisions live. The director takes a small api of legacy
// implementations as DI; as those legacy functions migrate to their proper
// homes (vfx/emitters/, materials/, etc.) only the wiring below moves.
//
// GAME_OVER stays inline for now — its body reaches into board state,
// cellMeshes, stackGroup, bloomPass, and other module-scope refs. It
// migrates once those subsystems are themselves modularized.
// playSfx is a `const` declared lower in this file (in the audio adapter
// block); referencing it directly here would hit the TDZ at module init.
// Wrapping it in an arrow defers the lookup until the listener actually
// fires, after the const has been initialized.
// Stage 8c env-reaction emitter — vertical light streaks above the case on
// recipe-gated tiers. Today only `aurora.tetris` opts in; the orchestrator
// reads the stage's `accentHex` and feeds it into spawnRow so the streaks
// read as a stage-palette periphery event, not an extension of the inside-
// the-case block-color burst.
const envReaction = createEnvReaction({ scene });

function triggerEnvReaction(rows, accentHex, rowCount) {
  // Origin Y: bottom-most cleared row (matches the shockwave's anchor so
  // both peripheral layers visually emerge from the same spot).
  const bottomRow = rows[rows.length - 1];
  const worldY = -PLAY_H / 2 + (bottomRow + 0.5) * CELL;
  envReaction.spawnRow(worldY, accentHex, rowCount);
}

registerDirector(bus, {
  impactRing:    triggerImpactRing,
  hardDropTrail: spawnHardDropTrail,
  sfx:           (name, arg) => playSfx(name, arg),
  levelUpFx:     triggerLevelUp,
  // Stage 8b — LineClearOrchestrator. The stageController owns which stage
  // is active (and thus which `clearRecipe` is read); each lineClearLayers
  // entry is the existing inline emitter, gated now by recipe instead of
  // always-firing. Single-line clears in the seed stages drop flash +
  // shockwave + veil; Tetris+ keeps all four. Stage 8c adds envReaction
  // (Layer 7) — currently only fires for `aurora.tetris`.
  //
  // `beatGrid` is the Stage-5b beat detector. When passed, the orchestrator
  // quantizes the peripheral layers (flash, shockwave, veil, envReaction)
  // to the next beat if it lands within ~200 ms — gives clears the
  // distinctive "the room punches *with* the kick" feel. Falls back to
  // immediate firing on tracks where BPM hasn't been detected yet.
  //
  // Passed as a thunk because `beatGrid` (the const) is declared further
  // down in this file (it depends on the audio bgmEl). Direct reference
  // would TDZ-throw at module load. The orchestrator resolves the thunk
  // lazily on each line-clear; by then the binding is initialized.
  stageController,
  beatGrid: () => beatGrid,
  lineClearLayers: {
    sparkle:     (rows, rowColors)        => emitLineClearBurst(rows, rowColors),
    flash:       (rows, rowColors)        => triggerFlash(rows, rowColors),
    shockwave:   (rows, color, rowCount)  => triggerLineClearShockwave(rows, color, rowCount),
    veil:        (rowCount)               => triggerLineClearVeil(rowCount),
    envReaction: (rows, accent, rowCount) => triggerEnvReaction(rows, accent, rowCount),
  },
});

bus.on(EVENTS.GAME_OVER, ({ score, lines, level }) => {
  document.getElementById('goScore').textContent = score.toLocaleString();
  document.getElementById('goLines').textContent = lines;
  document.getElementById('goLevel').textContent = level;
  playVoice('manbaout');

  // G20: shatter the entire stack as a top-down cascade so the case visibly
  // breaks before the overlay covers it. 12ms per row → a 20-row stack peaks
  // in ~240ms, comfortably within the SHARD_CAPACITY budget. The shatter()
  // call itself reuses the existing GPU pool, so no allocation per cube.
  const ROW_STAGGER_MS = 12;
  let scheduledRows = 0;
  // Snapshot the BoardView reference at schedule time — a Play-Again
  // could swap it out from under the staggered setTimeouts otherwise.
  const cascadeView = boardView;
  if (cascadeView) {
    for (let r = ROWS - 1; r >= 0; r--) {
      let rowHasCubes = false;
      for (let c = 0; c < COLS; c++) {
        if (cascadeView.cellMeshes[r][c]) { rowHasCubes = true; break; }
      }
      if (!rowHasCubes) continue;
      const delay = scheduledRows * ROW_STAGGER_MS;
      scheduledRows++;
      setTimeout(() => {
        for (let c = 0; c < COLS; c++) {
          const slices = cascadeView.cellMeshes[r][c];
          if (!slices) continue;
          for (const cube of slices) {
            shatter(cube);
            cascadeView.stackGroup.remove(cube);
          }
          cascadeView.cellMeshes[r][c] = null;
          board[r][c] = null;
        }
      }, delay);
    }
  }
  // Catastrophic camera reaction — Tetris-strength shake + a transient bloom
  // bump, both on the real (unscaled) renderer because the game over moment
  // is dramatic by itself; we don't want to be in slow-mo while it plays.
  shake.setForce(1.6 * TWEAKS.shatterPower);
  _bloomBaseStrength = bloomPass.strength;
  bloomPass.strength = _bloomBaseStrength + 0.6;
  setTimeout(() => { bloomPass.strength = _bloomBaseStrength; }, 700);

  const overlayDelay = Math.max(400, scheduledRows * ROW_STAGGER_MS + 250);
  setTimeout(() => {
    document.getElementById('gameOver').classList.add('show');
  }, overlayDelay);
});

// Dev affordance: expose the bus on window so the browser console can
// inspect bus.history() during the migration. Strip in production later.
if (typeof window !== 'undefined') window.__bus = bus;

// Boot the single rAF driver. Future subsystems register their own ticks via
// clock.onRenderTick / onFixedTick — no other rAF call exists in this app.
const clock = new Clock({ maxDtSec: 0.05 });
clock.onRenderTick(animate);
clock.start();

// =============================================================
// Resize
// =============================================================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  cssRenderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  selectiveBloom.setSize(window.innerWidth, window.innerHeight);
  smaaPass.setSize(
    window.innerWidth * Math.min(window.devicePixelRatio, 2),
    window.innerHeight * Math.min(window.devicePixelRatio, 2),
  );
  ambientField.setPointScaleFromHeight(window.innerHeight);
  clearSparkle.setPointScaleFromHeight(window.innerHeight);
});

// =============================================================
// Audio — UT-style announcer voices + looping vaporwave BGM
// =============================================================
// Implementation lives in src/audio/playback.js. We adapt the legacy
// playSfx / playVoice / setMuted / initAudio function names by binding to
// the module's methods, so the 18 call sites scattered through this file
// don't need to change. Future PR: replace those call sites with bus events
// (e.g. events.emit('AUDIO_PLAY_SFX', { name })) and remove this adapter.
// Pull persisted audio settings into the createAudioPlayback opts so the
// stored mute / volumes take effect on the very first frame, before any
// user gesture wakes the AudioContext.
const _persistedAudio = (_persistedSettings && _persistedSettings.audio) || {};
const audio = createAudioPlayback({
  voices: {
    freshmeat:    'asset/sounds/effects/freshmeat.wav',
    rempage:      'asset/sounds/effects/rempage.wav',
    dominating:   'asset/sounds/effects/dominating.wav',
    unstoppable:  'asset/sounds/effects/unstoppable.wav',
    godlike:      'asset/sounds/effects/godlike.wav',
    wreckingsick: 'asset/sounds/effects/wreckingsick.wav',
    megakill:     'asset/sounds/effects/megakill.wav',
    ultrakill:    'asset/sounds/effects/ultrakill.wav',
    monsterkill:  'asset/sounds/effects/monsterkill.wav',
    holyshit:     'asset/sounds/effects/holyshit.wav',
    manbaout:     'asset/sounds/effects/manbaout.mp3',
    man:          'asset/sounds/effects/man.mp3',
  },
  bgmEl: document.getElementById('bgmAudio'),
  volumes: {
    bgm:   typeof _persistedAudio.bgm   === 'number' ? _persistedAudio.bgm   : 0.32,
    voice: typeof _persistedAudio.voice === 'number' ? _persistedAudio.voice : 0.95,
    sfx:   typeof _persistedAudio.sfx   === 'number' ? _persistedAudio.sfx   : 0.55,
  },
});
if (_persistedAudio.muted) audio.setMuted(true);
const initAudio = () => audio.init();
const playSfx   = (name, arg) => audio.playSfx(name, arg);
const playVoice = (name)      => audio.playVoice(name);

// =============================================================
// BGM playlist — rotation through asset/sounds/bgm/.
// =============================================================
// The playlist drives the same <audio id="bgmAudio"> element the audio
// module's analyser tap is wired to (the MediaElementSource is one-shot
// per element, so we cannot create a second <audio> for crossfades — we
// fade via audio.fadeBgmEnvelope on the bgmGain stage instead).
//
// Persistence: settings.audio.bgmTrackIndex remembers the last track. The
// playlist seeds initialIndex from it; onTrackChange writes it back.
const _bgmTracks = defaultVaporwaveTracks();
const _initialBgmTrack = (() => {
  const stored = _persistedAudio.bgmTrackIndex;
  if (typeof stored !== 'number') return 0;
  if (stored < 0 || stored >= _bgmTracks.length) return 0;
  return stored | 0;
})();

// Pub/sub for the playlist UI — the manager calls these on track + playing
// changes. Multiple subscribers (UI panel, console handle, future overlays)
// each register their own listener.
const _playlistTrackListeners   = new Set();
const _playlistPlayingListeners = new Set();
function _firePlaylistTrack(idx, track) {
  for (const fn of _playlistTrackListeners) {
    try { fn(idx, track); }
    catch (err) { console.error('[bgm-playlist] track listener threw:', err); }
  }
}
function _firePlaylistPlaying(playing) {
  for (const fn of _playlistPlayingListeners) {
    try { fn(playing); }
    catch (err) { console.error('[bgm-playlist] playing listener threw:', err); }
  }
}

const bgmPlaylist = createBgmPlaylist({
  bgmEl: document.getElementById('bgmAudio'),
  tracks: _bgmTracks,
  initialIndex: _initialBgmTrack,
  fadeMs: 280,
  fadeEnvelope: (target, durationSec) => audio.fadeBgmEnvelope(target, durationSec),
  onTrackChange: (idx, track) => {
    _persistedAudio.bgmTrackIndex = idx;
    _persistSettingsSnapshot();
    // Apply the new track's cached {bpm, offset} (if any). This also resets
    // the scheduler — pending schedules from the old track were anchored to
    // its playhead and would fire on the new track's timeline otherwise.
    // If the new track hasn't been analyzed yet, clearBpm() keeps anticipation
    // idle until the cache resolves; the onAnalyzed listener above wires it
    // back in mid-song the moment the analyzer lands.
    try { applyActiveTrackBpm(); }
    catch (err) { console.warn('[bgm-playlist] applyActiveTrackBpm threw:', err?.message || err); }
    _firePlaylistTrack(idx, track);
  },
  onPlayingChange: (playing) => {
    _firePlaylistPlaying(playing);
  },
});

// Stage 5 — audio reactive feature bus + bindings layer.
// FeatureBus reads the analyser tap exposed by audio/playback.js. Until the
// user gesture wakes AudioContext, audio.analyser is null and feature.tick()
// is a safe no-op (sampler returns null on the first frames).
// Bindings is the SOLE place an audio stream meets a visual property —
// no other module may straddle the boundary (plan_particle_2.md §1.5).
const featureBus = createFeatureBus({ audio });

// Stage 5b — beat grid (anticipatory beat scheduler).
// The grid uses the BGM element's currentTime as its source of truth (NOT
// audioContext.currentTime — that's monotonic since context creation, while
// bgmEl.currentTime resets on loop and reflects scrubs). It receives BPM
// values from the per-track bpmCache (below) on every playlist track change;
// until the first cache hit lands, grid.tick() is a safe no-op.
const _bgmEl = document.getElementById('bgmAudio');
const beatGrid = createBeatGrid({
  getSongTimeSec: () => (_bgmEl ? _bgmEl.currentTime : 0),
  lookaheadSec:   0.25,
});

// BPM cache — fetches each BGM file end-to-end, decodes, runs
// web-audio-beat-detector once, and caches the {bpm, offset} keyed by URL.
// Replaces the live-capture pipeline (audio-recorder + windowed analyzeWindow
// + drift detector) that the old single-file vaporwave layout required.
// Persists across reloads via engine/storage.js so subsequent boots skip
// re-analysis entirely.
const bpmCache = createBpmCache({
  decode:   (arrayBuffer) => audio.decode(arrayBuffer),
  analyzer: async () => {
    // Lazy import — keeps the ~120KB web-audio-beat-detector worker out of
    // the synchronous boot path. Triggered on the first track that needs
    // analysis; subsequent calls reuse the cached factory in bpm-cache.js.
    const { guess } = await import('web-audio-beat-detector');
    return guess;
  },
  load: () => loadBpmCache(),
  save: (blob) => saveBpmCache(blob),
});

// Stage 5b — façade exposing the active piece's edge-intensity uniform to
// the bindings layer. The active piece uses cached fresnel materials keyed
// by tetromino color (`fresnelMaterialCache`); writing once per material on
// every binding tick is bounded at ≤7 writes/frame and means the binding
// works regardless of which piece happens to be active.
const activePieceEdges = {
  setEdgeIntensity(v) {
    for (const m of fresnelMaterialCache.values()) {
      m.uniforms.uEdgeIntensity.value = v;
    }
  },
};

const bindings = createBindings({
  feature: featureBus,
  beatGrid,
  targets: {
    selectiveBloom,
    breathe,
    chromatic: chromaticPass,
    ambientField,
    activePieceEdges,
    nebula,
  },
});
// Live FeatureBus inspector — F key toggles. Visible by default during the
// Stage 5 verification window; comment out `visibleByDefault: true` once the
// audio→visual loop has been confirmed working.
const featureDebug = createFeatureDebugOverlay({ feature: featureBus, audio, beatGrid, hotkey: 'KeyF', visibleByDefault: true });

// Effects toggle panel — E key toggles. Each entry's `onChange` runs once
// at boot to apply the initial state. The body tint cache lets us cleanly
// restore the radial gradient when re-enabled.
const _bodyTintOriginal = document.body.style.background || getComputedStyle(document.body).background;
// Effects-panel hue preview — given a hue, return a CSS gradient string
// showing the actual generated palette. Lets the player see the final
// look before committing the slider release.
function _hueGradientCss(hue) {
  const stops = paletteFromHue(hue);
  const css = stops.map((s) => {
    const r = Math.round(s.color[0] * 255);
    const g = Math.round(s.color[1] * 255);
    const b = Math.round(s.color[2] * 255);
    return `rgb(${r},${g},${b}) ${(s.t * 100).toFixed(0)}%`;
  });
  return `linear-gradient(to right, ${css.join(', ')})`;
}

// E-key effects panel — power-user backup view. The same controls now
// live in the Settings panel (Effects tab + Layers/Atmosphere sections);
// this floating panel stays hidden by default and can still be brought
// up with the E key for quick toggle inspection.
const effectsPanel = createEffectsPanel({
  hotkey: 'KeyE',
  visibleByDefault: false,
  stage: stageController,
  stages: Object.fromEntries(Object.entries(STAGES).map(([k, v]) => [k, v.label])),
  // Hue slider — RPG-style continuous picker. Auto toggle defaults ON
  // (matches `_userOverrideHue = null` initial state). Dragging the
  // slider commits a pin on release; flipping Auto on releases the pin.
  hue: {
    initial: hueForLevel(1),
    initialAuto: true,
    previewBackground: _hueGradientCss,
    onChange: (h) => setOverrideHue(h),
    onAutoToggle: (on) => setAutoHue(on),
  },
  effects: [
    {
      name: 'Nebula sky',
      initiallyOn: true,
      onChange: (on) => { nebula.mesh.visible = on; },
    },
    {
      name: 'Starfield',
      initiallyOn: true,
      onChange: (on) => { starfield.group.visible = on; },
    },
    {
      name: 'Bloom',
      initiallyOn: true,
      onChange: (on) => { selectiveBloom.combinePass.enabled = on; },
    },
    {
      name: 'Chromatic aberration',
      initiallyOn: true,
      onChange: (on) => { chromaticPass.enabled = on; },
    },
    {
      name: 'After-image',
      initiallyOn: true,
      onChange: (on) => { afterimagePass.enabled = on; },
    },
    {
      name: 'Camera breathe',
      initiallyOn: true,
      onChange: (on) => { breathe.setEnabled(on); },
    },
    {
      name: 'Audio → visuals',
      initiallyOn: true,
      onChange: (on) => { bindings.setEnabled(on); },
    },
    {
      name: 'Background tint',
      initiallyOn: true,
      onChange: (on) => {
        document.body.style.background = on ? _bodyTintOriginal : '#000';
      },
    },
    {
      name: 'Vignette',
      initiallyOn: true,
      onChange: (on) => { vignettePass.enabled = on; },
    },
    {
      // Stage 8c — Layer 7 streaks above the case on aurora-tetris.
      // Toggling off hides the mesh entirely (no per-frame cost beyond
      // the empty `update` tick).
      name: 'Env reaction',
      initiallyOn: true,
      onChange: (on) => { envReaction.mesh.visible = on; },
    },
    {
      // Stage 10 — procedural moon hero body in the background.
      name: 'Moon',
      initiallyOn: true,
      onChange: (on) => { moon.setVisible(on); },
    },
  ],
});
// =============================================================
// Settings panel (plan_UI_1.md) — single CSS3D panel with 4 tabs.
// =============================================================
// Authored defaults for the "Reset effects" button — values that match
// what a fresh install gets from storage. Mirrors SETTINGS_DEFAULTS in
// engine/storage.js; not imported because the panel itself doesn't need
// to know about persistence — the reset path just rewinds TWEAKS + the
// sliders, and the slider's onChange persists each one.
const _EFFECTS_RESET_VALUES = Object.freeze({
  shatterPower:    2.5,
  bloom:           0.7,
  shakeMul:        1.0,
  slowmoMul:       1.0,
  trailMul:        1.0,
  rimGlowMul:      1.0,
  mood:            'void',
  particleQuality: 'mid',
  vignette:        true,
});

// Persistence helper: snapshot the current TWEAKS + audio + mode + panel
// pose into the settings blob. Called whenever a slider commits or the
// panel pose changes; saveSettings debounces the write.
function _persistSettingsSnapshot() {
  const audioVols = audio && audio.volumes ? audio.volumes() : { bgm: 0.32, voice: 0.95, sfx: 0.55 };
  saveSettings({
    effects: {
      shatterPower:    TWEAKS.shatterPower,
      bloom:           bloomPass.strength,
      shakeMul:        TWEAKS.shakeMul,
      slowmoMul:       TWEAKS.slowmoMul,
      trailMul:        TWEAKS.trailMul,
      rimGlowMul:      TWEAKS.rimGlowMul,
      mood:            TWEAKS.mood,
      particleQuality: TWEAKS.particleQuality,
      vignette:        vignettePass.enabled,
    },
    audio: {
      muted: !!(audio && audio.muted),
      ...audioVols,
      // Resume on the same track next launch — bgmPlaylist is always
      // initialized before this helper can be called (settings panel boot
      // is later in the file).
      bgmTrackIndex: bgmPlaylist.index,
    },
    mode: Mode.current,
    // Snapshot the panel's pose AND its current visibility so a player
    // who hides the panel keeps it hidden on next launch.
    panel: {
      ...(_persistedSettings.panel || { x: 0, y: 0, z: 6, yaw: 0, pitch: 0 }),
      hidden: settingsPanel ? !settingsPanel.isOpen : false,
    },
  });
}

const settingsPanel = createSettingsPanel({
  camera,
  controls,
  initialPose: _persistedSettings.panel,
  onPoseChange: (pose) => {
    // Mutate the persisted-settings cache so _persistSettingsSnapshot
    // captures the latest pose; saveSettings debounces the write.
    _persistedSettings.panel = { ..._persistedSettings.panel, ...pose };
    _persistSettingsSnapshot();
  },
  onVisibilityChange: () => {
    // Panel's own ✕ button or external open/close: persist + sync the
    // gear button chrome.
    if (typeof syncSettingsToggleChrome === 'function') syncSettingsToggleChrome();
    _persistSettingsSnapshot();
  },

  effects: {
    shatterPower: {
      label: 'Shatter power', min: 0.4, max: 2.5, step: 0.05, value: TWEAKS.shatterPower,
      onChange: (v) => { TWEAKS.shatterPower = v; _persistSettingsSnapshot(); },
    },
    bloom: {
      label: 'Bloom intensity', min: 0.0, max: 1.5, step: 0.01, value: bloomPass.strength,
      onChange: (v) => {
        bloomPass.strength = v;
        // Re-baseline so any in-flight level-up flash returns to the
        // *new* user-set value, not the old one.
        _bloomBaseStrength = v;
        _persistSettingsSnapshot();
      },
    },
    shakeMul: {
      label: 'Camera shake', min: 0.0, max: 1.5, step: 0.05, value: TWEAKS.shakeMul,
      onChange: (v) => { TWEAKS.shakeMul = v; _persistSettingsSnapshot(); },
    },
    slowmoMul: {
      label: 'Slow-mo strength', min: 0.0, max: 1.0, step: 0.05, value: TWEAKS.slowmoMul,
      onChange: (v) => { TWEAKS.slowmoMul = v; _persistSettingsSnapshot(); },
    },
    trailMul: {
      label: 'Drop trail', min: 0.0, max: 1.0, step: 0.05, value: TWEAKS.trailMul,
      onChange: (v) => { TWEAKS.trailMul = v; _persistSettingsSnapshot(); },
    },
    rimGlowMul: {
      label: 'Rim glow', min: 0.0, max: 1.5, step: 0.05, value: TWEAKS.rimGlowMul,
      onChange: (v) => { TWEAKS.rimGlowMul = v; _persistSettingsSnapshot(); },
    },
    mood: {
      value: TWEAKS.mood,
      choices: [
        { value: 'neon',  label: 'Neon'  },
        { value: 'icy',   label: 'Icy'   },
        { value: 'ember', label: 'Ember' },
        { value: 'void',  label: 'Void'  },
      ],
      onChange: (v) => { TWEAKS.mood = v; applyMood(); _persistSettingsSnapshot(); },
    },
    particleQuality: {
      value: TWEAKS.particleQuality,
      choices: [
        { value: 'low',  label: 'Low'  },
        { value: 'mid',  label: 'Mid'  },
        { value: 'high', label: 'High' },
      ],
      onChange: (v) => { TWEAKS.particleQuality = v; _persistSettingsSnapshot(); },
    },
    vignette: {
      value: vignettePass.enabled,
      onChange: (v) => { vignettePass.enabled = v; _persistSettingsSnapshot(); },
    },
    onResetEffects: () => {
      // Reset every effects-tab knob to authored defaults + force the
      // panel sliders to display them. Uses setValue with pulse:true so
      // the player gets visible confirmation.
      TWEAKS.shatterPower    = _EFFECTS_RESET_VALUES.shatterPower;
      bloomPass.strength     = _EFFECTS_RESET_VALUES.bloom;
      _bloomBaseStrength     = _EFFECTS_RESET_VALUES.bloom;
      TWEAKS.shakeMul        = _EFFECTS_RESET_VALUES.shakeMul;
      TWEAKS.slowmoMul       = _EFFECTS_RESET_VALUES.slowmoMul;
      TWEAKS.trailMul        = _EFFECTS_RESET_VALUES.trailMul;
      TWEAKS.rimGlowMul      = _EFFECTS_RESET_VALUES.rimGlowMul;
      TWEAKS.mood            = _EFFECTS_RESET_VALUES.mood;
      TWEAKS.particleQuality = _EFFECTS_RESET_VALUES.particleQuality;
      vignettePass.enabled   = _EFFECTS_RESET_VALUES.vignette;
      applyMood();
      _persistSettingsSnapshot();
      // Re-render the Effects tab so the sliders snap visually. Pass
      // explicit values rather than relying on the construction-time
      // cfg snapshot.
      settingsPanel.refreshEffects({
        shatterPower:    TWEAKS.shatterPower,
        bloom:           bloomPass.strength,
        shakeMul:        TWEAKS.shakeMul,
        slowmoMul:       TWEAKS.slowmoMul,
        trailMul:        TWEAKS.trailMul,
        rimGlowMul:      TWEAKS.rimGlowMul,
        mood:            TWEAKS.mood,
        particleQuality: TWEAKS.particleQuality,
        vignette:        vignettePass.enabled,
      });
    },
  },

  audio: {
    muted: {
      value: !!(audio && audio.muted),
      onChange: (v) => { audio.setMuted(v); _persistSettingsSnapshot(); },
    },
    bgm: {
      label: 'BGM',   min: 0, max: 1, step: 0.01, value: (audio.volumes && audio.volumes().bgm)   || 0.32,
      onChange: (v) => { audio.setBgmVolume(v); _persistSettingsSnapshot(); },
    },
    voice: {
      label: 'Voice', min: 0, max: 1, step: 0.01, value: (audio.volumes && audio.volumes().voice) || 0.95,
      onChange: (v) => { audio.setVoiceVolume(v); _persistSettingsSnapshot(); },
    },
    sfx: {
      label: 'SFX',   min: 0, max: 1, step: 0.01, value: (audio.volumes && audio.volumes().sfx)   || 0.55,
      onChange: (v) => { audio.setSfxVolume(v); _persistSettingsSnapshot(); },
    },
    onTestAnnouncer: () => playVoice('rempage'),
    onTestSfx:       () => playSfx('clear', 4),
  },

  mode: {
    current:      Mode.current,
    available:    Mode.available,
    labels:       Mode.labels,
    descriptions: Mode.descriptions,
    disabled:     Mode.disabled,
    // Phase 7 — surface Mode.config(key) for the per-mode goal/duration
    // text that renders above the mode-button grid. Wrapped as a thunk so
    // the panel always reads the live config (cheap; no caching surprises
    // if metadata is ever made dynamic).
    config:       (key) => Mode.config(key),
    onSelect: (m) => { Mode.select(m); _persistSettingsSnapshot(); },
    onStart:  () => {
      // Goes through Mode.start so the lifecycle hook (rules-pack rebuild
      // + MODE_START emit + resetRunState) runs regardless of how the
      // start was initiated (settings button, hotkey, "Play Again").
      Mode.start({ restart: true });
    },
    onChange: (handler) => Mode.onChange(handler),
  },

  stats: {
    load: () => loadStats(),
    reset: () => {
      // Wipe the stats blob entirely (storage module's _resetForTests
      // also clears the in-memory shadow — which is what we want here).
      _resetStorageForTests();
      // Re-persist current settings so the wipe doesn't take settings
      // with it.
      _persistSettingsSnapshot();
    },
  },
});
cssScene.add(settingsPanel.obj);

// =============================================================
// Settings panel — Effects tab extensions: layer toggles + atmosphere.
// =============================================================
// The original "Effects" tab covers intensity sliders. The toggles here
// were previously the contents of the E-key effects-panel; folding them
// into the settings panel gives players one place to find every visual
// knob (per the user feedback that the two panels' options weren't
// integrated). The E-panel still exists as a power-user inspection tool
// but starts hidden by default.
{
  const effectsPane = settingsPanel.panes.effects;

  const divider1 = document.createElement('div');
  divider1.className = 'tp-panel__divider';
  effectsPane.appendChild(divider1);

  const layersHeader = document.createElement('div');
  layersHeader.className = 'tp-panel__section-label';
  layersHeader.textContent = 'Layers';
  effectsPane.appendChild(layersHeader);

  // Toggle definitions — same wiring the E-panel used. `initiallyOn`
  // mirrors the previous defaults; `apply` is fired immediately so the
  // world matches the toggle state at boot.
  const LAYER_TOGGLES = [
    { name: 'Nebula sky',           on: true,  apply: (v) => { nebula.mesh.visible = v; } },
    { name: 'Starfield',             on: true,  apply: (v) => { starfield.group.visible = v; } },
    { name: 'Bloom',                 on: true,  apply: (v) => { selectiveBloom.combinePass.enabled = v; } },
    { name: 'Chromatic aberration',  on: true,  apply: (v) => { chromaticPass.enabled = v; } },
    { name: 'After-image',           on: true,  apply: (v) => { afterimagePass.enabled = v; } },
    { name: 'Camera breathe',        on: true,  apply: (v) => { breathe.setEnabled(v); } },
    { name: 'Audio → visuals',       on: true,  apply: (v) => { bindings.setEnabled(v); } },
    { name: 'Env reaction',          on: true,  apply: (v) => { envReaction.mesh.visible = v; } },
    { name: 'Moon',                  on: true,  apply: (v) => { moon.setVisible(v); } },
  ];
  for (const t of LAYER_TOGGLES) {
    const row = makeToggleRow({ label: t.name, checked: t.on });
    row.input.addEventListener('change', () => {
      try { t.apply(row.input.checked); }
      catch (err) { console.error(`[settings] ${t.name} toggle threw:`, err); }
    });
    // Apply initial state — ensures the world matches the toggle on boot
    // even if a previous panel had already applied something else.
    try { t.apply(t.on); } catch { /* ignore */ }
    effectsPane.appendChild(row.row);
  }

  const divider2 = document.createElement('div');
  divider2.className = 'tp-panel__divider';
  effectsPane.appendChild(divider2);

  const atmosHeader = document.createElement('div');
  atmosHeader.className = 'tp-panel__section-label';
  atmosHeader.textContent = 'Atmosphere';
  effectsPane.appendChild(atmosHeader);

  // Stage dropdown — replicates the E-panel's stage selector.
  const stageRow = document.createElement('div');
  stageRow.className = 'tp-row';
  const stageSelect = document.createElement('select');
  stageSelect.className = 'tp-select';
  stageSelect.title = 'Stage';
  for (const name of stageController.available) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = (STAGES[name] && STAGES[name].label) || name;
    if (name === stageController.current) opt.selected = true;
    stageSelect.appendChild(opt);
  }
  stageSelect.addEventListener('change', () => stageController.set(stageSelect.value));
  stageRow.appendChild(stageSelect);
  effectsPane.appendChild(stageRow);
  // Sync the dropdown when the stage is changed via the bus / console.
  bus.on(STAGE_EVENTS.STAGE_CHANGE, ({ to }) => {
    if (stageSelect.value !== to) stageSelect.value = to;
  });

  // Palette hue — auto toggle + slider. Mirrors the E-panel's hue picker
  // and shares the setOverrideHue / setAutoHue handlers, so dragging
  // either panel's slider has the same effect.
  const hueAutoLabel = document.createElement('div');
  hueAutoLabel.className = 'tp-panel__section-label';
  hueAutoLabel.style.opacity = '0.7';
  hueAutoLabel.style.marginTop = '6px';
  hueAutoLabel.textContent = 'Palette hue';
  effectsPane.appendChild(hueAutoLabel);

  const hueAuto = makeToggleRow({ label: 'Auto (level-driven)', checked: true });
  effectsPane.appendChild(hueAuto.row);

  const hueWrap = document.createElement('div');
  hueWrap.style.cssText = 'padding:4px 4px 8px;';
  const hueSlider = makeHueSlider({
    initial: hueForLevel(1),
    previewBackground: _hueGradientCss,
    onChange: (h) => {
      if (hueAuto.input.checked) {
        hueAuto.input.checked = false;
        hueSlider.setEnabled(true);
      }
      setOverrideHue(h);
    },
  });
  hueSlider.setEnabled(!hueAuto.input.checked);
  hueWrap.appendChild(hueSlider.wrap);
  effectsPane.appendChild(hueWrap);
  hueAuto.input.addEventListener('change', () => {
    hueSlider.setEnabled(!hueAuto.input.checked);
    setAutoHue(hueAuto.input.checked);
  });
}

// BGM progress + scrubber — click anywhere on the bar to seek. Useful for
// VFX tuning so you can jump to drops/breakdowns on demand.
const playbackProgress = createPlaybackProgress({ bgmEl: document.getElementById('bgmAudio') });

// =============================================================
// Mode HUD badges — gated by Mode.current. Each badge subscribes
// permanently to MODE_* events and gates its own visibility on the
// active mode key (per-mode badges read trivially as no-ops in other
// modes). Future Sprint/Ultra/Zen badges plug into the same pattern.
// =============================================================
const marathonBadge = createMarathonBadge({
  bus,
  events: EVENTS,
  getActiveModeKey: () => Mode.current,
  // The badge re-renders on MODE_START; passing the current line count
  // covers HMR mid-run reloads where lines !== 0 at boot.
  getLinesCleared: () => _linesThisSession,
});
const sprintBadge = createSprintBadge({
  bus,
  events: EVENTS,
  getActiveModeKey: () => Mode.current,
  // Sprint's headline timer reads from the host's pause-aware accumulator.
  // _modeTimeMs only advances inside the gameplay block, so pause / topout
  // freeze the clock automatically without per-mode plumbing.
  getModeTimeMs:    () => _modeTimeMs,
  getLinesCleared:  () => _linesThisSession,
});
const ultraBadge = createUltraBadge({
  bus,
  events: EVENTS,
  getActiveModeKey: () => Mode.current,
  getModeTimeMs:    () => _modeTimeMs,
  getScore:         () => score,
  duration:         120_000,
});
const zenBadge = createZenBadge({
  bus,
  events: EVENTS,
  getActiveModeKey: () => Mode.current,
  // Stop session — the only way out of Zen. Routes through Mode.stop so
  // the lifecycle hook (endRun + MODE_END emit) fires the same way as
  // every other terminal.
  onStop:           () => Mode.stop('forfeit'),
  getLinesCleared:  () => _linesThisSession,
  getPiecesPlaced:  () => _piecesThisSession,
});
const versusBadge = createVersusBadge({
  bus,
  events: EVENTS,
  getActiveModeKey: () => Mode.current,
  // Opponent snapshot routes to whichever bot is active: the §3.7 7e
  // VersusSession (real second sim with a visible board) when present,
  // or the Phase-6 abstract bot (no visible board) as fallback.
  getOpponentSnapshot: () => {
    if (versusSession) {
      const op = versusSession.gameP2;
      return {
        score:          op.score,
        stackHeight:    _highestFilledRow(op.board),
        deathThreshold: ROWS - 1,
        alive:          !op.gameOver,
      };
    }
    return {
      score:          versusBot.score,
      stackHeight:    versusBot.stackHeight,
      deathThreshold: versusBot.deathThreshold,
      alive:          versusBot.alive,
    };
  },
  getInboundGarbage: () => ({
    rows:    _queuedGarbageRowCount(),
    blocked: game ? game.garbageBlocked : false,
  }),
});
// Re-render whenever the player swaps modes via the settings panel — the
// badges' refresh() reads `Mode.current` (via getActiveModeKey) and toggles
// their own visibility, so a mode change without a restart still settles
// the chrome correctly.
Mode.onChange(() => {
  marathonBadge.refresh();
  sprintBadge.refresh();
  ultraBadge.refresh();
  zenBadge.refresh();
  versusBadge.refresh();
});

// =============================================================
// Playlist panel (M) — transport + scrollable track list.
// =============================================================
// Hidden by default to keep the boot view uncluttered; the M hotkey or the
// (future) bottom-right cluster button surfaces it. The panel reads through
// the `bgmPlaylist` controller and the audio module's BGM volume; nothing
// in the panel reaches into the scene or audio bus directly.
const playlistPanel = createPlaylistPanel({
  playlist: bgmPlaylist,
  hotkey: 'KeyM',
  visibleByDefault: false,
  volume: {
    value: (audio.volumes && audio.volumes().bgm) || 0.32,
    onChange: (v) => { audio.setBgmVolume(v); _persistSettingsSnapshot(); },
  },
  // Subscribe-and-return-unsubscribe pattern so the panel can react to
  // playlist changes that happen outside of its own click handlers (e.g.
  // a track ending naturally and the playlist auto-advancing).
  subscribeTrack: (fn) => {
    _playlistTrackListeners.add(fn);
    return () => _playlistTrackListeners.delete(fn);
  },
  subscribePlaying: (fn) => {
    _playlistPlayingListeners.add(fn);
    return () => _playlistPlayingListeners.delete(fn);
  },
});

// Keep the effects-panel stage dropdown in sync if the stage is changed
// from the console (`__stage.set('aurora')`) instead of via the dropdown.
// Registered HERE rather than next to the nebula sub so it doesn't TDZ-hit
// `effectsPanel` (which is declared above this line but conceptually a
// later-bound dep — keep the seam tight).
bus.on(STAGE_EVENTS.STAGE_CHANGE, ({ to }) => effectsPanel.syncStage(to));

// Console handle for ad-hoc inspection: __feature.snapshot() / __bindings.bindingCount
if (typeof window !== 'undefined') {
  window.__feature = featureBus;
  window.__bindings = bindings;
  window.__featureDebug = featureDebug;
  window.__audio = audio;
  window.__bgm = bgmPlaylist;
  window.__playlistPanel = playlistPanel;
  window.__progress = playbackProgress;
  window.__nebula = nebula;
  window.__effectsPanel = effectsPanel;
  window.__stage = stageController;
  window.__beat = beatGrid;
  // Console handle: __hue(280) pins the nebula hue; __hue() clears the
  // pin and resumes level-progression. The effects-panel slider is the
  // same surface; this is for ad-hoc tuning + scripted demos.
  window.__hue = (h) => {
    if (h == null) {
      setAutoHue(true);
      effectsPanel.syncHue(null);   // null = auto mode
    } else {
      setOverrideHue(h);
      effectsPanel.syncHue(h);
    }
  };
}
function setMuted(b) {
  audio.setMuted(b);
  audioToggleBtn.classList.toggle('muted', audio.muted);
  audioToggleBtn.textContent = audio.muted ? '🔇' : '🔊';
  // Two views of the same `audio.muted` state — keep the panel toggle
  // and the bottom-right 🔊 button in sync regardless of which fired
  // the change.
  if (settingsPanel) settingsPanel.syncMute(audio.muted);
  // Persist on every flip so the mute survives reload.
  _persistSettingsSnapshot();
}
const audioToggleBtn = document.getElementById('audioToggle');
audioToggleBtn.addEventListener('click', (e) => {
  // Click also serves as the unlock gesture if audio hasn't started yet.
  if (!audio.hasContext) initAudio();
  setMuted(!audio.muted);
  e.currentTarget.blur();
});
// Reflect the boot-time mute (loaded from storage) in the button chrome.
if (audio.muted) {
  audioToggleBtn.classList.add('muted');
  audioToggleBtn.textContent = '🔇';
}

// ⚙ Settings panel toggle (plan_UI_1.md §3.4). Clicking the button or
// pressing 'O' opens/closes the CSS3D panel. The button's `is-open`
// class follows the panel state so the chrome highlights cyan when
// open.
const settingsToggleBtn = document.getElementById('settingsToggle');
function syncSettingsToggleChrome() {
  settingsToggleBtn.classList.toggle('is-open', settingsPanel.isOpen);
}
settingsToggleBtn.addEventListener('click', (e) => {
  settingsPanel.toggle();
  syncSettingsToggleChrome();
  _persistSettingsSnapshot();   // remember hide/show across reloads
  e.currentTarget.blur();
});
// First user gesture (key or pointer) unlocks audio. Browsers gate
// AudioContext + media playback until this happens. The BPM analysis
// queue depends on audio.decode() (which needs the AudioContext), so we
// await the init before starting the queue — otherwise the first 14
// decode calls race the async context creation and reject.
const _audioBoot = async () => {
  // Detach the listeners synchronously so a rapid second key press doesn't
  // re-enter the handler before initAudio() resolves.
  window.removeEventListener('keydown', _audioBoot);
  window.removeEventListener('pointerdown', _audioBoot);
  try { await initAudio(); }
  catch (err) { console.warn('[audio] init failed:', err?.message || err); }
  // Kick off whole-track BPM analysis for every track in the playlist.
  // bpmCache serializes the work and persists results — repeat boots skip
  // any track whose URL is already cached.
  startBpmAnalysisForPlaylist();
};
window.addEventListener('keydown', _audioBoot);
window.addEventListener('pointerdown', _audioBoot);

// =============================================================
// Whole-track BPM pipeline
// =============================================================
// New layout: each BGM file is a single track with one tempo, so the cleanest
// answer is to fetch + decode + analyze each file end-to-end exactly once,
// cache the {bpm, offset} by URL, and feed it into beatGrid on every playlist
// track switch. The cache module owns the queue + persistence; main.js wires
// the seams.
//
// Failure modes:
// - Track 404 / decode fails → that track's anticipation stays idle, the rest
//   continue working.
// - web-audio-beat-detector worker fails to load → all anticipation is idle,
//   live audio reactivity (bands.bass, kick onsets, etc.) keeps working.

// Apply the cached entry for the active track, if any. Called at boot AND on
// every track change. If the entry isn't yet cached, we clear the grid so
// stale projections from the previous track aren't used.
function applyActiveTrackBpm() {
  const cur = bgmPlaylist.current().track;
  if (!cur) { beatGrid.clearBpm(); return; }
  const entry = bpmCache.get(cur.url);
  if (entry) {
    beatGrid.setBpm(entry.bpm, entry.offset);
  } else {
    beatGrid.clearBpm();
  }
}

// When any track's analysis lands, if it's the *active* track, apply it
// immediately. This is the "first-launch" path: the player presses a key,
// the active track starts playing, and a few seconds later its BPM lands —
// anticipation engages mid-song without needing a track switch.
bpmCache.onAnalyzed((url) => {
  const cur = bgmPlaylist.current().track;
  if (cur && cur.url === url) applyActiveTrackBpm();
});

// Start: queue all tracks. The active track goes first so its BPM lands as
// soon as possible; the rest run in playlist order behind it.
function startBpmAnalysisForPlaylist() {
  // Boot-time cache hit — apply immediately so the very first frame after
  // the user gesture already has anticipation.
  applyActiveTrackBpm();

  const all = bgmPlaylist.tracks();
  const cur = bgmPlaylist.current().track;
  const ordered = cur
    ? [cur, ...all.filter(t => t.url !== cur.url)]
    : all;
  // Fire-and-forget; bpmCache serializes internally so we don't spawn 14
  // concurrent decodes.
  bpmCache.analyzeAll(ordered.map(t => t.url));
}

// Console handle for ad-hoc inspection / forced re-analysis.
if (typeof window !== 'undefined') {
  window.__beatCache    = bpmCache;
  window.__beatReanalyze = () => {
    const cur = bgmPlaylist.current().track;
    if (cur) bpmCache.invalidate(cur.url);
  };
}

// ---- Announcer state machine ------------------------------------------------
// Streak = total LINES cleared across consecutive clearing locks (not just
// 1-line clears). Resets only on a piece locking without clearing. Tiers
// fire when the cumulative line count crosses each threshold for the first
// time in this streak — so a Tetris contributes 4, a double contributes 2,
// etc. This makes the ladder reachable in normal play.
//
// Priority on each clear (highest wins):
//   1. Back-to-back Tetris → holyshit (fires once per streak)
//   2. Crossed a new streak tier → that ladder voice
//   3. Cluster size voice (monsterkill / ultrakill / megakill)
//   4. Single-line, no tier crossing → silent
const STREAK_TIERS = [
  { at: 3,  voice: 'rempage' },      // first milestone — a single Tetris hits this
  { at: 5,  voice: 'dominating' },
  { at: 8,  voice: 'unstoppable' },
  { at: 12, voice: 'godlike' },
  { at: 18, voice: 'wreckingsick' },
];
const STREAK_GRACE = 8; // non-clearing locks tolerated before the streak breaks
let streakLines = 0;
let lastTier = -1;          // highest tier index voiced so far this streak
let prevWasTetris = false;
let holyshitUsed = false;   // back-to-back-tetris voice fires once per streak
let firstClearSeen = false;
let missedLocks = 0;        // non-clearing locks since the last clear

function announceLineClear(rowCount) {
  // Any clear forgives a filler piece — don't break the chain on near-misses.
  missedLocks = 0;
  // First-ever clear in this game gets the welcome regardless of size.
  if (!firstClearSeen) {
    firstClearSeen = true;
    playVoice('freshmeat');
    streakLines = rowCount;
    prevWasTetris = (rowCount === 4);
    return;
  }
  const oldStreak = streakLines;
  streakLines = oldStreak + rowCount;
  // Find the highest tier crossed by this clear that hasn't fired yet.
  let crossed = -1;
  for (let i = lastTier + 1; i < STREAK_TIERS.length; i++) {
    if (oldStreak < STREAK_TIERS[i].at && streakLines >= STREAK_TIERS[i].at) {
      crossed = i;
    }
  }
  const isBackToBackTetris = (rowCount === 4 && prevWasTetris);
  prevWasTetris = (rowCount === 4);
  // Back-to-back Tetris — fire once per streak so chains of 3+ tetrises don't
  // just say "holyshit" forever; subsequent ones fall through to the ladder.
  if (isBackToBackTetris && !holyshitUsed) {
    playVoice('holyshit');
    holyshitUsed = true;
    if (crossed >= 0) lastTier = crossed; // still record the tier as consumed
    return;
  }
  if (crossed >= 0) {
    playVoice(STREAK_TIERS[crossed].voice);
    lastTier = crossed;
    return;
  }
  if (rowCount === 4) playVoice('monsterkill');
  else if (rowCount === 3) playVoice('ultrakill');
  else if (rowCount === 2) playVoice('megakill');
  // Single-line with no tier crossing = silent (avoids constant chatter).
}
// Called on every non-clearing lock. The streak tolerates STREAK_GRACE filler
// pieces in a row before it actually breaks — a beginner usually needs one or
// two non-clearing pieces to set up the next clear.
function noteNoClearLock() {
  missedLocks += 1;
  if (missedLocks > STREAK_GRACE) resetAnnouncerStreak();
}
function resetAnnouncerStreak() {
  streakLines = 0;
  lastTier = -1;
  prevWasTetris = false;
  holyshitUsed = false;
  missedLocks = 0;
}
function resetAnnouncerForNewGame() {
  resetAnnouncerStreak();
  firstClearSeen = false;
}

// =============================================================
// Help toggle
// =============================================================
const helpEl = document.getElementById('help');
const helpToggle = document.getElementById('helpToggle');
helpToggle.addEventListener('click', () => {
  helpEl.classList.toggle('hidden');
});

// =============================================================
// Mood — recolor rim/fill lights and case frame based on TWEAKS.mood
// =============================================================
function applyMood() {
  const m = MOOD_PRESETS[TWEAKS.mood] || MOOD_PRESETS.neon;
  rimLight.color.setHex(m.rim);
  fillLight.color.setHex(m.fill);
  frameMat.color.setHex(m.frame);
}

// =============================================================
// Boot
// =============================================================
applyMood();
// Boot the simulation through the same lifecycle as a mode swap or
// Play-Again — Mode.start fires onStart, which constructs the Game and
// emits MODE_START. `restart: false` skips the resetRunState() pass
// since this is the very first run; the freshly-constructed Game seeds
// the first piece via spawnPiece() in onStart.
Mode.start({ key: Mode.current, restart: false });
updateHUD();

// =============================================================
// Vanilla tweaks panel (no React) — host protocol compliant
// =============================================================
(function setupTweaks() {
  const panel = document.createElement('div');
  panel.id = 'tweaks-panel';
  panel.style.cssText = `
    position: fixed; right: 16px; top: 16px; z-index: 50;
    width: 250px; background: rgba(10,14,24,0.78);
    border: 1px solid rgba(108,240,255,0.25); border-radius: 12px;
    padding: 14px 16px 16px;
    backdrop-filter: blur(14px) saturate(140%);
    -webkit-backdrop-filter: blur(14px) saturate(140%);
    color: #f3f5fb; font: 11px ui-sans-serif, system-ui, sans-serif;
    box-shadow: 0 12px 48px rgba(0,0,0,0.6), 0 0 32px rgba(108,240,255,0.08);
    display: none; user-select: none;
  `;
  panel.innerHTML = `
    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px;">
      <div style="font-size:11px; letter-spacing:0.22em; color:#6cf0ff; text-transform:uppercase; font-weight:700;">Tweaks</div>
      <button id="tw-close" style="background:none; border:none; color:#8b93ad; cursor:pointer; font-size:16px; line-height:1; padding:0;">×</button>
    </div>
    <div class="tw-row">
      <label>Gravity feel</label>
      <div style="display:flex; align-items:center; gap:8px;">
        <input id="tw-gravity" type="range" min="0.5" max="2.0" step="0.05" />
        <span id="tw-gravity-v" style="color:#6cf0ff; font-variant-numeric: tabular-nums; min-width:32px; text-align:right;"></span>
      </div>
      <div class="tw-hint">Floaty ↔ snappy. Affects fall speed and inertia stiffness.</div>
    </div>
    <div class="tw-row">
      <label>Glass mood</label>
      <div id="tw-mood" class="tw-segmented"></div>
      <div class="tw-hint">Recolors lighting, frame, grid, and atmospheric fog.</div>
    </div>
    <div class="tw-row">
      <label>Shatter power</label>
      <div style="display:flex; align-items:center; gap:8px;">
        <input id="tw-shatter" type="range" min="0.4" max="2.5" step="0.05" />
        <span id="tw-shatter-v" style="color:#6cf0ff; font-variant-numeric: tabular-nums; min-width:32px; text-align:right;"></span>
      </div>
      <div class="tw-hint">Calm → cinematic. Scales shards, sparkles, shake, punch-zoom.</div>
    </div>
  `;
  const style = document.createElement('style');
  style.textContent = `
    #tweaks-panel .tw-row { margin-bottom: 12px; }
    #tweaks-panel .tw-row:last-child { margin-bottom: 0; }
    #tweaks-panel label {
      display:block; font-size:10px; letter-spacing:0.18em;
      color:#8b93ad; text-transform:uppercase; font-weight:600;
      margin-bottom: 6px;
    }
    #tweaks-panel .tw-hint {
      font-size:10px; color:#6b7388; margin-top: 5px; line-height: 1.4;
    }
    #tweaks-panel input[type=range] {
      flex: 1; accent-color: #6cf0ff; height: 18px;
    }
    #tweaks-panel .tw-segmented {
      display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px;
    }
    #tweaks-panel .tw-segmented button {
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      color: #b0b8cc; padding: 7px 4px; border-radius: 6px;
      font-size: 10px; letter-spacing: 0.12em; text-transform: uppercase;
      font-weight: 600; cursor: pointer; transition: all 0.15s;
    }
    #tweaks-panel .tw-segmented button:hover { color: #f3f5fb; }
    #tweaks-panel .tw-segmented button.active {
      background: rgba(108,240,255,0.15);
      border-color: rgba(108,240,255,0.6);
      color: #6cf0ff;
      box-shadow: 0 0 12px rgba(108,240,255,0.2);
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(panel);

  // Wire gravity
  const gv = panel.querySelector('#tw-gravity');
  const gvLabel = panel.querySelector('#tw-gravity-v');
  gv.value = TWEAKS.gravity;
  gvLabel.textContent = (+TWEAKS.gravity).toFixed(2);
  gv.addEventListener('input', () => {
    TWEAKS.gravity = parseFloat(gv.value);
    gvLabel.textContent = TWEAKS.gravity.toFixed(2);
    persist({ gravity: TWEAKS.gravity });
  });

  // Wire shatter
  const sh = panel.querySelector('#tw-shatter');
  const shLabel = panel.querySelector('#tw-shatter-v');
  sh.value = TWEAKS.shatterPower;
  shLabel.textContent = (+TWEAKS.shatterPower).toFixed(2);
  sh.addEventListener('input', () => {
    TWEAKS.shatterPower = parseFloat(sh.value);
    shLabel.textContent = TWEAKS.shatterPower.toFixed(2);
    persist({ shatterPower: TWEAKS.shatterPower });
  });

  // Wire mood segmented
  const moodEl = panel.querySelector('#tw-mood');
  const moods = ['neon', 'icy', 'ember', 'void'];
  moods.forEach(m => {
    const b = document.createElement('button');
    b.textContent = m;
    b.dataset.mood = m;
    if (TWEAKS.mood === m) b.classList.add('active');
    b.addEventListener('click', () => {
      TWEAKS.mood = m;
      moodEl.querySelectorAll('button').forEach(x => x.classList.toggle('active', x.dataset.mood === m));
      applyMood();
      persist({ mood: m });
    });
    moodEl.appendChild(b);
  });

  // Persistence via host protocol
  function persist(edits) {
    try { window.parent.postMessage({ type: '__edit_mode_set_keys', edits }, '*'); } catch {}
  }

  // Host protocol — listen FIRST, then announce
  window.addEventListener('message', (e) => {
    if (!e.data || !e.data.type) return;
    if (e.data.type === '__activate_edit_mode') panel.style.display = 'block';
    else if (e.data.type === '__deactivate_edit_mode') panel.style.display = 'none';
  });
  panel.querySelector('#tw-close').addEventListener('click', () => {
    panel.style.display = 'none';
    try { window.parent.postMessage({ type: '__edit_mode_dismissed' }, '*'); } catch {}
  });
  try { window.parent.postMessage({ type: '__edit_mode_available' }, '*'); } catch {}
})();

