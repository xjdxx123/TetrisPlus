# Particle / VFX Roadmap — Tetris-Effect-Adjacent in the Browser

**Document type:** Engineering execution plan
**Companion to:** [`plan_particle_1.md`](./plan_particle_1.md) (deeper technical analysis)
**Companion to:** [`plan_architecture.md`](./plan_architecture.md) (subsystem boundaries — `engine/`, `gameplay/`, `vfx/`, `audio/`, `rendering/`, `materials/`, `shaders/`)
**Status:** Replaces the staging in `plan_particle_1.md` §7. Keeps `plan_particle_1.md` as the technical reference (visual analysis §1.x, FeatureBus design §4, particle budgets §6.2).
**Author:** Senior graphics engineer, written for the team

---

## 0. Implementation Status (Updated)

This section was last updated **2026-05-08**. It supersedes the original "honest status" baseline — significant work has shipped since the plan was written. Each stage's status badge here is mirrored at the top of its section in §3. Detailed forward roadmap in §9.

### 0.1 Per-stage status

| Stage | Status | What's shipped | What's pending |
|---|---|---|---|
| 1 — Spatial awareness | ✅ Complete | starfield (600pts), body radial-gradient, camera FOV breathe | — |
| 2 — Bloom + emissive | ✅ Complete | selective-bloom (material-swap), edge-emissive on glass | hand-rolled Kawase (polish) |
| 3 — Particle layers | ❌ Not started | — | depth-layered ambient (close/mid/far) |
| 4 — Curl-noise particles | ❌ Not started | — | 3D noise bake + vertex sampling |
| 5 — Audio reactive | ⚠ 5a done | analyser, bands, envelope, normalizer, FeatureBus, bindings (2 active), debug overlay (F), playback progress bar | onset detection, beat grid (offline BPM), anticipatory ramps, more bindings |
| 6 — Advanced post | ⚠ Partial | chromatic aberration, after-image | depth fog, motion blur (deferred), DoF (deferred) |
| 7 — Glass material | ⚠ Partial | edge-emissive (shipped in Stage 2) | refraction, bass→edge-intensity binding, settle-edge ramp |
| 8 — Event-driven layered effects | ⚠ 8a done | stage controller, `STAGE_CHANGE` event, `_stagePalette()` reads from controller, dropdown UI, nebula crossfade wiring | LineClearOrchestrator, voxel-fragments / ribbon / env-reaction emitters, beat-quantized scheduling, hold/combo events, HARD_DROP/GAME_OVER director cleanup |
| 9 — GPU particles | ❌ Not started | — | FBO ping-pong, GPU sim for ambient + sparkle |
| 10 — Nebula atmosphere | ⚠ Mostly | nebula skybox (3-octave fbm + dual-LUT crossfade), palette LUT system, STAGE_CHANGE → crossfade wiring, console controls | distant cosmic structure, vertical fog gradient, optional audio-modulated intensity |

### 0.2 Bonus tooling delivered (not in original plan)

Worth listing because it materially helps iteration but doesn't appear in the staged plan:

| Tool | Hotkey / handle | Purpose |
|---|---|---|
| FeatureBus debug overlay | `F` / `__featureDebug` | per-band bars (norm + kick), live audio inspection |
| BGM scrubber | `__progress` | click/drag to seek; jump to drops on demand |
| Effects panel | `E` / `__effectsPanel` | toggle each effect on/off + master + stage dropdown |
| Stage controller console | `__stage.set('aurora')` | switch stages from console; emits STAGE_CHANGE |
| Bus history recorder | `__bus.history()` | last 256 events for debugging dispatch |
| Window-exposed handles | `__feature`, `__audio`, `__nebula`, etc. | direct introspection from DevTools |

### 0.3 Architectural property held throughout

The plumbing established in `plan_architecture.md` PRs 1–7 — bus + clock + director + module boundaries + ESLint isolation rules — has held cleanly across every shipped stage. No regressions, no architectural drift. New audio→visual code lands in `bindings.js`; new gameplay→VFX code lands in `director.js`; new stage logic lands in `config/stages.js`. Three files, three concerns, no leakage. This is the design property that's making subsequent stages cheap.

---

## 1. Architectural Principles (read before staging)

These are non-negotiable; they protect against the two failure modes — performance regressions and architectural drift.

1. **One-way data flow.** `gameplay/` emits events. `audio/reactive/` emits streams. `vfx/`, `camera/`, `rendering/post/` subscribe. Nothing flows the other way. If a particle system needs to know the score, it reads `Game.snapshot()` — not the score variable. Enforced by ESLint `no-restricted-imports` ([`eslint.config.js`](../project/eslint.config.js)).
2. **No `requestAnimationFrame` outside `engine/time/clock.js`.** Every particle update, audio sample, camera advance is a `Clock.onRenderTick` subscriber. This is what lets us add a `qualityScalar` LOD switch globally.
3. **No allocations in the hot path.** Particle pools are sized at boot; emitters allocate slot indices, never `Float32Array`s. Camera shake reuses a single `THREE.Vector3` for the offset.
4. **Three state buckets, one owner each.** *Gameplay state* (board, piece, score) lives in `gameplay/`. *Render state* (scene graph, materials, render targets) lives in `rendering/`+`world/`. *VFX state* (emitter pools, audio bands, camera impulses) lives in `vfx/`+`audio/`+`camera/`. Reads cross boundaries through *snapshots* and *events*; writes never do.
5. **Audio is a stream layer, not a side effect.** `audio/reactive/` produces `bands.bass.smoothed`, `onsets.kick`, `beat.nextAt`. `vfx/reactive/bindings.js` is the *only* place those streams meet `material.uniforms`. No subsystem reaches across.
6. **`audioContext.currentTime` is the master clock for music sync.** `performance.now()` drifts; the audio clock doesn't. `clock.totalSec` is fine for visual smoothing where ±5 ms doesn't matter, but choreography uses the audio clock. (Detail in `plan_particle_1.md` §3.1.)
7. **Hue discipline.** A given stage stays within a 30–60° hue arc. Bloom amplifies the dominant hue; wide palettes bloom into mud. (`plan_particle_1.md` §1.3.)
8. **Macro/micro split.** Restraint inside the case (≤8 shards/cell, ≤2k sparkle particles). Loudness around the case (flash, shockwave, environment reactions). (`plan_particle_1.md` §1.3, §1.6.)

---

## 2. Cross-Cutting Concerns (8-question answer set)

The user-supplied prompt asked these explicitly. Tight engineering answers:

### 2.1 Which stages are most prone to performance issues?

| Stage | Failure mode | Mitigation |
|---|---|---|
| **4** flow field | particle count × overdraw — 5k 100×100 px additive quads = 50M shaded fragments/frame at 1080p | radial alpha falloff + soft-particle depth fade + half-res buffer for ambient pass |
| **5** music sync | `getByteFrequencyData` called >once/frame; tiny FFT bins yanked into uniforms with no smoothing → strobing | sample once at frame top into a single `Float32Array`; envelope-followed bands feed uniforms; never bind raw bins |
| **6** advanced post | motion blur + DoF + CA stacked → multi-pass overdraw on every pixel | budget 2.5 ms total post at 1080p; CA is UV-offset (cheap), DoF is the expensive one — keep behind a quality flag |
| **9** GPU sim | FP precision drift past ~50k particles; `getError`-induced GPU sync stalls during dev | RGBA16F (not 32F), wrap-around modulo positions, never `getBufferSubData` on hot path |
| **10** nebula | full-screen raymarching at native res = death | half-res raymarch, 16–24 steps, depth-aware bilateral upsample |

### 2.2 Which stages are most prone to architectural loss-of-control?

| Stage | Failure mode | Mitigation |
|---|---|---|
| **5** music sync | direct `material.uniforms.x = analyser.bins[12]` writes scattered across files | `vfx/reactive/bindings.js` is the *single* place audio meets uniforms; everything else reads `bands.bass.smoothed()` |
| **8** events | every gameplay action emits a unique event; the bus becomes 40 topics; subscribers form a web | enforce the §1 director pattern — `gameplay/` emits ~10 stable topics; `vfx/director.js` decides what cinematic events fire from those |
| **9** GPU sim | one-off ping-pong setup per emitter, no shared abstraction | one `GPGPUSimulator` helper that owns the ping-pong + 3D noise + render-target pool; emitters compose, don't fork |
| **10** nebula | one giant 200-line nebula shader, untestable | shader chunks via `#include`; nebula composes octave noise, fresnel, palette LUT modules |

### 2.3 How to decouple gameplay from VFX

Already enforced in the codebase, but to spell it out:

```
gameplay/          → bus.emit('LINE_CLEAR', { rows, simultaneous, colors, scoreDelta, overallColor })
                       │
                       ▼
audio/reactive/   ─┐  vfx/director.js  (the gameplay→cinematic translator)
                   │   ├─ on LINE_CLEAR: tier-gated emission across multiple emitters
   bands ─────────┴─►  ├─ schedules flash/shockwave to next beat (audio clock)
   onsets ────────►    ├─ peripheral env reactions outside the case
                       └─ camera impulses
                       ▼
                     vfx/emitters/*  (pooled, instanced)
                     materials/      (uniform bindings)
                     camera/         (additive impulse layers)
                     rendering/post/ (composer chain)
```

`gameplay/` never imports `three`, `vfx/`, `materials/`, `audio/`, `camera/`, or `rendering/`. Tested by Vitest running gameplay in pure Node — if you broke isolation, the suite crashes at import time. (Plan §4 of `plan_architecture.md`.)

### 2.4 How to design the event bus

Already done in [`src/engine/events/bus.js`](../project/src/engine/events/bus.js). The decisions worth knowing:

- **Synchronous dispatch.** JS is single-threaded; queueing buys nothing. Handlers run inline during `bus.emit()`.
- **Frozen payloads.** `Object.freeze` on emit. Handlers must clone if they need to mutate. Catches a class of bugs where listener A mutates a payload that listener B then reads.
- **Replay buffer per topic.** Subscribers can pass `{ replay: true }` and immediately receive the last N payloads — useful for UI panels that boot mid-game.
- **Per-handler exception isolation.** A handler that throws doesn't break the dispatch loop. The error is logged, other handlers run.
- **Snapshot dispatch list before iteration.** Allows handlers to safely unsubscribe themselves mid-emit (common pattern).
- **Ring-buffer recorder.** `bus.history()` returns the last 256 events for debug overlays / bug repro / replay tooling. **Don't sleep on this**: when you're hunting "why did this Tetris not flash?", `__bus.history()` in the console is the first thing you reach for.

What's *not* in this bus, deliberately:
- No request/response. Need a value? Query the source's read API.
- No async/Promise. Visual code shouldn't pause for the bus.
- No type system. Topics are documented in `gameplay/events.js` as constants; payloads are commented inline. (When TypeScript lands, add a typed wrapper.)

### 2.5 How to avoid stuttering from React re-renders

This project is currently vanilla Three.js + a tiny vanilla-JS tweaks panel ([`src/app/main.js`](../project/src/app/main.js), [`src/ui/tweaks/TweaksPanel.jsx`](../project/src/ui/tweaks/TweaksPanel.jsx) is unused). When React lands for the HUD migration (Step 9 of `plan_architecture.md`):

1. **The Three.js scene mounts ONCE outside the React tree.** A `<canvas ref={...}>` is created in a top-level `App` component; the renderer is initialized in a `useEffect` with `[]` deps and never re-initialized. React must not own scene-graph identity.
2. **Game state lives outside React.** Use Zustand or a vanilla pub/sub — never a context provider that re-renders on every score change. UI components subscribe with selectors:
   ```jsx
   const score = useGameStore(s => s.score);  // re-renders only on score change
   ```
3. **Hot paths read via refs.** A particle system's per-frame update never touches a useState setter. If it absolutely must, `useRef().current` mutation is free.
4. **For R3F if adopted (not currently planned):** `useFrame` callbacks run outside React; mutating object3D refs in `useFrame` is the pattern — never `setState`. (`plan_particle_1.md` §3.6 also notes: don't put 50k particles in the scene graph regardless of React.)
5. **Concurrent React features (transitions, useDeferredValue) are anti-patterns here.** Game-state-driven UI should update on the next frame, not when scheduler decides.

The pragmatic test: open Chrome Performance, record 5 seconds of gameplay, look for any "Render component" stack frames running >1 ms. Score updates and particle emissions should never trigger React re-renders of anything in the render path.

### 2.6 What goes in a shader

| Belongs in shader | Why |
|---|---|
| Per-particle position from age + spawn velocity + gravity | 5k particles × 60 fps = 300k integrations/sec; CPU integration costs 4–6 ms |
| Soft-particle depth fade | Per-pixel; can't be done CPU-side at all |
| Fresnel / view-dependent rim | Per-pixel; varies per fragment |
| Curl-noise sampling (3D texture lookup) | Hardware-accelerated trilinear |
| Per-particle color tween (alpha envelope, hue shift) | Trivial in vertex; expensive on CPU |
| Screen-space post effects (CA, vignette, dither, bloom blur) | Per-pixel by definition |
| Frustum cull (set `gl_Position.w = -1`) | Avoids fragment shader cost on culled instances; cheaper than CPU cull bookkeeping |

### 2.7 What stays CPU-side

| Belongs on CPU | Why |
|---|---|
| Spawn decisions (when to emit, how many) | Decisions are rare (events) and need game-state context |
| Pool-slot allocation, free-list maintenance | Bookkeeping, not arithmetic |
| Audio analysis (FFT band integration, envelope followers, onset detection) | Operates on ~512 bins/frame; not enough work to GPU-amortize the upload |
| Beat grid lookup, scheduling | Single-element decisions |
| Color picking from stage palette | One color per emit event |
| Gameplay logic (board, piece, score) | Latency-sensitive, deterministic, testable |
| Event dispatch | Gameplay events fire 1–20 times/sec; not arithmetic |
| LOD evaluation (`qualityScalar` from rolling frame time) | Once per second |

Rule of thumb: if it runs at *particle count* per second, GPU. If it runs at *event count* per second, CPU.

### 2.8 Three state buckets, three owners

| Bucket | Examples | Owner module | Read by | Written by |
|---|---|---|---|---|
| **Gameplay state** | board grid, active piece, score, level, gameOver, paused, nextQueue, holdPiece | `gameplay/` | everyone (via `Game.snapshot()`) | only `gameplay/` |
| **Render state** | scene graph, materials, render targets, composer passes, light positions | `rendering/`, `world/`, `materials/` | `gameplay/` never; `vfx/` reads via `RenderContext` | only its owner |
| **VFX state** | emitter pools, particle attribute buffers, audio band envelopes, camera impulse magnitudes, time uniforms | `vfx/`, `audio/`, `camera/` | each owns its own; bindings layer reads | only the owning subsystem |

If a particle pool ends up reading `score` directly, you've broken bucket 1↔3. The fix is always: gameplay emits an event (`SCORE_DELTA`); the VFX subscribes; the score variable stays untouched outside `gameplay/`.

---

## 3. The Ten Stages

Each stage answers the 10-item template the prompt requires. Stages are *layered* — each ships independently green and the game keeps running. Time estimates are single-developer, focused work, after the architectural refactor in `plan_architecture.md` PRs 1–4 lands (which it has, through PR-7).

### Stage 1 — Basic Spatial Awareness · ✅ Complete

#### 1. Goal
Make the playfield feel embedded in space, not floating on a black canvas. Buy "atmosphere" with the cheapest possible visual moves.

#### 2. Visual Result
- Dark cosmic background — not pure black, a deep desaturated indigo/violet (#0a0a18-ish).
- A sparse static starfield (300–800 points) at world-far distance.
- The 500-particle ambient field stays as is for now (Stage 4 upgrades it).
- Camera FOV oscillates slowly — a 0.5° amplitude, 8–12 sec period sine wave on top of the configured FOV. Reads as "breathing."
- Optional: very subtle radial gradient behind the case (CSS or a quad with vertical fade).

#### 3. Technical Plan
- A `world/starfield.js` module owns a single `THREE.Points` instance with pre-allocated positions on a sphere shell. Static — no per-frame update beyond a slow rotation tied to `clock.totalSec`.
- A `camera/breathe.js` module subscribes to `Clock.onRenderTick` and applies an FOV delta around a base. Cheap to disable for low-quality mode.
- The `<body>` background or a screen-space radial-gradient quad (no shader, just a vertex-color two-triangle plane) for the "deep space" tint.

#### 4. Reasoning
This is the cheapest legibility upgrade we can ship. Stars give the eye reference for camera motion; FOV breathing tells the player there's an actual *world* (static FOV always reads as a CG render). No new pipelines, no new buffers, no shader work — just art-directed additions sitting on the existing renderer.

#### 5. Performance Impact
Negligible. Starfield = one static draw call, ~800 points, no overdraw past a few pixels each. Camera breathing = 2 sin() per frame on the CPU. Combined < 0.1 ms.

#### 6. File Structure Changes
```
src/
├── world/
│   ├── starfield.js        (+, ~80 lines)
│   └── space-tint.js       (+, ~30 lines)
└── camera/
    └── breathe.js          (+, ~40 lines)
```

#### 7. Dependencies
None new. Uses existing `three`, `clock`, `bus` (no audio yet).

#### 8. Step-by-Step Implementation
1. Add `src/world/starfield.js` — exports `createStarfield({ count, radius })` returning a `THREE.Points` mesh.
2. Pre-allocate `Float32Array(count * 3)` of positions on a unit sphere (rejection sampling or `(u,v) → spherical`), scale by `radius`.
3. Use a tiny shader: vertex passes through, fragment outputs constant color modulated by `aSize` attribute (twinkle disabled in this stage; arrives in Stage 5).
4. Add `src/camera/breathe.js` — exports `createBreathe({ amplitudeDeg, periodSec })` with `update(camera, totalSec)`.
5. In `src/app/main.js`: instantiate, add to scene, register `clock.onRenderTick(t => breathe.update(camera, t))`. ~5 lines of wiring.
6. Tune amplitude visually: start 0.3°, push up to 0.8° if too subtle.

#### 9. Key Code Examples

```js
// world/starfield.js
import * as THREE from 'three';

export function createStarfield({ count = 600, radius = 80, baseColor = 0xb0c0ff } = {}) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // Even sphere distribution via inverse-CDF.
    const u = Math.random(), v = Math.random();
    const theta = 2 * Math.PI * u, phi = Math.acos(2 * v - 1);
    positions[i * 3]     = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = radius * Math.cos(phi);
    sizes[i] = 1.0 + Math.random() * 1.6;  // mix of small + bright
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(baseColor) }, uPx: { value: 1.0 } },
    vertexShader: `
      attribute float aSize;
      uniform float uPx;
      varying float vSize;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uPx;
        vSize = aSize;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vSize;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float a = smoothstep(0.5, 0.0, length(d));
        if (a < 0.02) discard;
        gl_FragColor = vec4(uColor, a * (0.4 + 0.4 * vSize / 2.5));
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  return new THREE.Points(geo, mat);
}
```

```js
// camera/breathe.js
export function createBreathe({ amplitudeDeg = 0.4, periodSec = 10 } = {}) {
  return {
    update(camera, totalSec) {
      const phase = (totalSec / periodSec) * Math.PI * 2;
      camera.fov = camera.userData.baseFov + Math.sin(phase) * amplitudeDeg;
      camera.updateProjectionMatrix();
    },
    bindBase(camera) { camera.userData.baseFov = camera.fov; },
  };
}
```

#### 10. Next Stage Expansion Plan
Stage 2 turns up the lighting work — bloom tuning + selective bloom + cube edge emissive. The starfield gets free glow from bloom; the FOV breathing syncs to bass envelope in Stage 5.

---

### Stage 2 — Bloom and Emissive Systems · ✅ Complete

#### 1. Goal
Make the existing geometry *glow*, not just *render*. The single biggest perceived-quality lever in the entire project.

#### 2. Visual Result
- Bloom is unmistakable but not blurry — fine details (HUD text, piece edges) stay sharp.
- Active piece, ghost piece outline, and stage-accent UI elements are bloom-bright.
- The board cell *core* glows softly; the case frame edges have a thin emissive trim.
- Background particles + starfield catch light from bloom; nothing critical (HUD text) does.

#### 3. Technical Plan
- Tune `UnrealBloomPass` parameters: lower threshold (~0.7 → 0.5), tighter radius. Verify with a test piece.
- **Selective bloom via emissive mask.** The cleanest WebGL2 approach for now: render the scene twice — once normally to the main color buffer, once with all "bloom-eligible" materials replaced with their emissive contribution and everything else replaced with black, into a separate target. Bloom that target. Composite over main. Only a few materials need a second copy; cache the swap.
- Edge emissive on the cube cores is already in `glass.frag.glsl` via `uColor * uIntensity`. Add a second component for edge-detection style highlight tied to `uPower` near the rim.
- HUD bloom contamination: keep the HUD on the CSS3D layer (already separate), so bloom can't reach it.

#### 4. Reasoning
- **Why bloom is core.** Tetris Effect's signature look is HDR + bloom. Bloom is what turns "neon colored squares" into "lights in space."
- **Why threshold-only bloom underdelivers.** A flat threshold-based bloom either lets dim glows through (washes the image) or clips them out (no halo at all). Selective bloom via mask gives art direction: piece cores glow, dust glows, starfield glows; cube *bodies* don't glow (they have a glass wall, not an emitter).
- **Why this is the second stage.** Stages 3+ add things that *want* to be bloom-eligible (particles, sparkles, line-clear flash). Get the bloom math right first; everything downstream tunes against it.

#### 5. Performance Impact
- Existing `UnrealBloomPass` cost ~1.5–2.0 ms at 1080p. Selective bloom adds the second-pass scene render — but only of materials in the bloom mask layer (active piece + glow elements), so well under 1 ms extra.
- Total post chain budget remains ~3 ms; bloom is dominant.

#### 6. File Structure Changes
```
src/
├── rendering/post/
│   └── selective-bloom.js  (+, ~120 lines)
├── materials/
│   ├── cube-emissive.js    (+, ~50 lines, factory for the edge-emissive variant)
│   └── glass.js            (modify — extract factory cleanly from main.js)
└── shaders/
    └── glass.frag.glsl     (modify — add edge-highlight component)
```

#### 7. Dependencies
None new (still `three/addons/postprocessing/UnrealBloomPass`). Long-term Stage 6 may swap to a hand-rolled dual-filter (Kawase) bloom (`plan_particle_1.md` §5.2), but that's a polish-tier change, not blocking.

#### 8. Step-by-Step Implementation
1. Make `enableBloom` a `userData` flag on materials/meshes that should bloom.
2. In `selective-bloom.js`: at render time, swap non-bloom materials with `THREE.MeshBasicMaterial({ color: 0x000000 })` for the bloom render pass; restore after.
3. Pipe through `EffectComposer` with two `RenderPass` stages combined via additive `ShaderPass`.
4. Tag active-piece material, ghost material, sparkle, shard, ambient, starfield, line-clear flash with `enableBloom = true`. Tag case glass and HUD with `enableBloom = false`.
5. Tune threshold/radius/strength on a worst-case scene (full board + active Tetris piece). Final values typically: threshold 0.55, radius 0.45, strength 0.85.

#### 9. Key Code Examples

```js
// rendering/post/selective-bloom.js — material-swap selective bloom
const BLACK = new THREE.MeshBasicMaterial({ color: 0x000000 });
const _swap = new Map();

function darkenNonBloom(scene) {
  scene.traverse(o => {
    if (o.isMesh && !o.material.userData.enableBloom) {
      _swap.set(o, o.material);
      o.material = BLACK;
    }
  });
}
function restoreMaterials() {
  _swap.forEach((m, o) => { o.material = m; });
  _swap.clear();
}

export function createSelectiveBloom(renderer, scene, camera, { threshold = 0.55, radius = 0.45, strength = 0.85 } = {}) {
  const bloomComposer = new EffectComposer(renderer, /* HDR target */);
  bloomComposer.renderToScreen = false;
  bloomComposer.addPass(new RenderPass(scene, camera));
  bloomComposer.addPass(new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), strength, radius, threshold));
  // Final composer (caller adds RenderPass for full scene + this combine pass)
  return {
    renderBloom() { darkenNonBloom(scene); bloomComposer.render(); restoreMaterials(); },
    bloomTarget: bloomComposer.readBuffer.texture,
  };
}
```

```glsl
// shaders/glass.frag.glsl — edge highlight component (additive on existing fresnel)
// Stronger response near the geometric edge of the cube — vNormalW will swing
// rapidly across the bevel, making fwidth() a cheap edge proxy.
float edge = clamp(length(fwidth(vNormalW)) * 6.0, 0.0, 1.0);
vec3 edgeAccent = uEdgeColor * edge * uEdgeIntensity;
gl_FragColor.rgb += edgeAccent;
```

#### 10. Next Stage Expansion Plan
Stage 3 introduces depth-layered particles that live in the bloom mask. Stage 5 modulates `uEdgeIntensity` (and bloom strength) by `bands.bass.smoothed` so the case "breathes" with the music. Stage 6 swaps `UnrealBloomPass` for a tighter dual-filter Kawase implementation if `EffectComposer` cost becomes the dominant frame budget.

---

### Stage 3 — Basic Particle Systems · ❌ Not started

#### 1. Goal
Layered ambient particles — three depth strata (close dust, mid drift, far field) instead of the single 500-particle band that exists today. Pre-instanced. Still CPU-driven.

#### 2. Visual Result
- A near-camera dust haze (small, fast-fading), ~300 active.
- The mid-field drift (the existing 500 ambient field, unchanged for now).
- A far-field "starfield drift" — slower, larger, fewer particles (~200), with parallax-like horizontal motion as the camera breathes.
- Each layer reads as its own depth — soft particles + size variation handle this without true parallax.

#### 3. Technical Plan
- Generalize the existing single ambient field into a `ParticleLayer` factory:
  - Each layer has its own pre-allocated buffers (positions, velocities, lifetimes, sizes, colors).
  - All layers share the same vertex shader (`ambient.vert.glsl`) but with per-layer uniforms (size scalar, alpha scalar, motion-noise scalar, hue arc).
  - Layers register with a `vfx/layer-registry.js` so the renderer iterates them in a defined order (far → mid → near, all additive).
- This stage stays on `THREE.Points` (one draw call per layer is fine for ≤2k particles). Stage 9 promotes layers to GPU sim.
- **Why not DOM particles:** DOM transforms can't sit in 3D depth correctly, can't blend additively, can't be bloom-eligible, and bottleneck on layout for >100 nodes. CSS particles are dead weight here.

#### 4. Reasoning
Density layering is one of the three pillars of `plan_particle_1.md` §1.1 ("motion language, density layering, timing discipline"). A single particle band always reads flat. Three bands at different scales and speeds give the eye something to parse as space.

GPU instancing isn't strictly required at <2k count, but the abstraction (`ParticleLayer`) being instancing-ready is what lets Stage 9 swap implementations without changing emitters. Build the boundary correctly now, optimize later.

#### 5. Performance Impact
3 layers × ~1k average particles = ~3k visible. Three additional draw calls. CPU cost per layer ~0.3 ms (loop integration). Total +1 ms vs current. Bloom contribution adds ~0.2 ms (more bloom-eligible pixels). Comfortably under budget.

#### 6. File Structure Changes
```
src/vfx/
├── emitters/
│   ├── particle-layer.js   (+, ~180 lines — generalized version of current ambient field)
│   ├── dust-near.js        (+, ~30 lines, configures particle-layer for the close band)
│   ├── drift-mid.js        (+, ~30 lines)
│   └── drift-far.js        (+, ~30 lines)
└── layer-registry.js       (+, ~40 lines, ordered iteration)
```

The current inline 500-particle ambient field in `main.js` migrates into `drift-mid.js` (no behavior change for that layer).

#### 7. Dependencies
None new.

#### 8. Step-by-Step Implementation
1. Extract the existing 500-particle ambient logic from `src/app/main.js` into `vfx/emitters/particle-layer.js` as a parameterized factory: `createParticleLayer({ count, sizeRange, hueArc, driftSpeed, lifetime, blendMode })`.
2. Verify the migration is identity — the existing band still looks exactly the same. No new behavior yet.
3. Add `dust-near.js` (200 count, fast lifetime ~3s, small size 0.5–1.0, low alpha, hue centered on stage primary).
4. Add `drift-far.js` (300 count, very slow drift, large size 2.0–4.0, low alpha, hue centered on stage secondary).
5. Add `layer-registry.js`. Register all three. Set render order: far (0), mid (1), near (2) — back-to-front for proper additive accumulation.
6. Visually tune until the eye separates the three depths.

#### 9. Key Code Examples

```js
// vfx/emitters/particle-layer.js
export function createParticleLayer({
  count, sizeRange, hueArc, driftSpeed, lifetime, baseAlpha,
}) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  const sz  = new Float32Array(count);
  const al  = new Float32Array(count);
  const vel = new Float32Array(count * 3);
  const age = new Float32Array(count);
  const life = new Float32Array(count);
  // (init each particle; helper omitted)
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor',   new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSize',    new THREE.BufferAttribute(sz, 1));
  geo.setAttribute('aAlpha',   new THREE.BufferAttribute(al, 1));
  // ... ShaderMaterial referencing imported ambient.{vert,frag}.glsl ...
  function update(dt, totalSec) {
    for (let i = 0; i < count; i++) {
      age[i] += dt;
      if (age[i] > life[i]) respawn(i);
      pos[i*3+0] += vel[i*3+0] * dt;
      pos[i*3+1] += vel[i*3+1] * dt;
      pos[i*3+2] += vel[i*3+2] * dt;
      al[i] = baseAlpha * triangularEnvelope(age[i] / life[i]);
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aAlpha.needsUpdate = true;
  }
  return { mesh: new THREE.Points(geo, mat), update, count };
}
```

#### 10. Next Stage Expansion Plan
Stage 4 replaces the per-layer `vel` integration with sampling from a shared 3D curl-noise texture — same `update()` signature, different motion model. Stage 9 promotes the same layer to GPU sim with FBO ping-pong, again preserving the boundary.

---

### Stage 4 — Flow Field Particles (start of "advanced") · ❌ Not started

#### 1. Goal
Particles sample a shared **curl-noise** vector field instead of integrating fixed per-particle velocities. The motion immediately stops looking sinusoidal and starts looking like *fluid*.

#### 2. Visual Result
- Particles drift along smooth, swirling streams. You can visually trace the flow lines.
- Multiple particles in the same neighborhood share the same direction → reads as *coherent flow* rather than *random walk*.
- Optional inward bias makes the field feel like it's "flowing toward" the playfield (attention guidance, `plan_particle_1.md` §1.4).

#### 3. Technical Plan
- **Curl noise primer.** Take a 3D simplex/Perlin scalar field, take the curl of its gradient → divergence-free 3D vector field. Particles advected along curl noise can't *all* converge to a point, so the field stays visually full forever. Reference: Emil Dziewanowski's *Dissecting Curl Noise*.
- **Bake to a 3D texture once.** A 128³ RGBA8 3D texture (~8 MB) sampled with hardware trilinear is far cheaper than computing curl noise per-particle every frame. Generate at boot from a worker (or even just on the main thread — 0.5 sec one-time cost).
- Sample the field in the **vertex shader** — one `texture(uCurl, p / fieldScale)` per particle per frame, returns a velocity vector to advect by `dt`.
- Layered scales: each particle layer (Stage 3) samples at a different `fieldScale` so they look independent.

#### 4. Reasoning
Curl noise is the single most important particle-motion technique for this aesthetic. Linear noise (Perlin alone) makes particles converge into "rivers" that look fake. Curl is divergence-free by construction — no convergence, no rivers, just smooth swirls. Tetris Effect's particle motion is curl-noise-driven; this is non-negotiable for the look.

#### 5. Performance Impact
- 3D texture sample per particle per frame: roughly 1 cycle on modern integrated GPUs, free on discrete. Even at 30k particles, ~0.1 ms.
- 8 MB VRAM for the noise texture. Acceptable.
- Bake time at boot: ~500 ms on the main thread; consider a worker if it visibly stalls the loading screen.

#### 6. File Structure Changes
```
src/vfx/
├── curl-noise.js           (+, ~150 lines — bakes 3D noise texture, exposes uniform)
└── emitters/particle-layer.js  (modify — sample curl from vertex shader)

src/shaders/
├── curl-bake.frag.glsl     (+, ~50 lines — used during boot to compute curl field)
└── ambient.vert.glsl       (modify — add curl sampling)
```

#### 7. Dependencies
None new. Existing `three` provides `Data3DTexture` and shader extensions for 3D sampling.

#### 8. Step-by-Step Implementation
1. Implement `bakeCurlNoise3D(size, frequency, seed)` in `vfx/curl-noise.js`. Compute scalar Perlin/simplex at three offsets per voxel, take partial differences to approximate curl, write to RGBA8.
2. Wrap in a `Data3DTexture`; expose as a uniform `uCurl`, `uCurlScale`.
3. Modify `ambient.vert.glsl` to sample `texture(uCurl, fract(position * uCurlScale * 0.05))` and add the result × `uFlowSpeed * dt` to position. (Vertex shader can't write back to the buffer, so this stage keeps CPU integration but reads the *direction* from curl. Stage 9's GPU sim makes the integration GPU-resident.)
4. Tune field scale per layer — close dust uses high frequency (busy local swirls), far drift uses low frequency (slow lazy curves).
5. Add an optional inward bias: a fixed gradient toward `(0,0,0)` blended with the curl vector by `bias` parameter. This is the attention-guidance lever from `plan_particle_1.md` §1.4.

#### 9. Key Code Examples

```js
// vfx/curl-noise.js — boot-time bake (simplified; real version would use a known noise lib)
export function bakeCurlNoise3D(size = 128, scale = 0.04, seed = 1337) {
  const data = new Uint8Array(size * size * size * 4);
  const eps = 1e-3;
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Three independent scalar fields → vector.
        const fx = noise3D(x*scale,        y*scale,        z*scale,        seed);
        const fy = noise3D(x*scale + 100,  y*scale + 100,  z*scale + 100,  seed);
        const fz = noise3D(x*scale + 200,  y*scale + 200,  z*scale + 200,  seed);
        // Curl approximated via finite differences along each axis (omitted).
        const [cx, cy, cz] = curl(fx, fy, fz, x, y, z, scale);
        const i = (z*size*size + y*size + x) * 4;
        data[i + 0] = Math.round(cx * 127 + 128);
        data[i + 1] = Math.round(cy * 127 + 128);
        data[i + 2] = Math.round(cz * 127 + 128);
        data[i + 3] = 255;
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RGBAFormat;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.unpackAlignment = 1;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}
```

```glsl
// shaders/ambient.vert.glsl — add at top of main()
uniform sampler3D uCurl;
uniform float     uCurlScale;
uniform float     uFlowSpeed;
uniform float     uTime;
// inside main():
vec3 sampUV  = fract(position * uCurlScale * 0.05 + uTime * 0.005);
vec3 flow    = texture(uCurl, sampUV).rgb * 2.0 - 1.0;   // unpack RGBA8 → [-1,1]
vec3 driven  = position + flow * uFlowSpeed;             // advect
// gl_Position uses `driven` instead of `position`
```

#### 10. Next Stage Expansion Plan
Stage 5's `bands.lowMid.smoothed` modulates `uFlowSpeed` (the "music breathes the field" line). Stage 9's GPU sim integrates positions in fragment shader, persisting state across frames — the per-particle CPU integration goes away and counts can hit 50k+.

---

### Stage 5 — Music-Synchronized Visual System · ⚠ 5a Complete, 5b Pending

> **5a (shipped):** AnalyserNode tap, log-spaced 6 bands, asymmetric envelope follower, running-peak AGC normalizer, half-wave-rectified flux + kick impulse signals, FeatureBus public API, declarative bindings.js layer (2 active bindings: highMid → bloom, air → CA). F-key debug strip-chart overlay. Bonus: BGM scrubber for VFX tuning.
>
> **5b (pending):** discrete onset event channel via spectral-flux + adaptive threshold + refractory; offline beat grid via `web-audio-beat-detector`; anticipatory ramps on emission rates 200–300 ms ahead of predicted beats; expanded bindings (FOV breathing intensity, glass edge intensity, sparkle/dust spawn rates). See §9.2.

#### 1. Goal
Audio drives visuals through a clean signal layer. **Different frequency bands drive different visual concerns** — bass moves slow things, treble moves fast things, beats fire impulses. Don't just "dance to the rhythm"; play different bands against different layers.

#### 2. Visual Result
- The case frame's edge intensity pulses softly with the bass envelope.
- Camera FOV breathing (Stage 1) gains a multiplicative bass component — gentle expand-on-the-drop.
- Sparkle / dust spawn rate ramps with mid-band envelope.
- Particle field flow speed (Stage 4) ramps with low-mid band.
- Onset events ("kick" detection) fire a beat-pulse impulse — small ring of particles at the case base, ~150 ms decay.
- High-band shimmer modulates a tiny chromatic-aberration amount (introduced in Stage 6) so the very-high-end "pings" feel sharp.

#### 3. Technical Plan
This is the biggest plumbing stage in the plan. Implementation follows `plan_particle_1.md` §4 directly — that section is the definitive reference and **should be considered binding**, not retreaded here. The summary:

```
HTMLAudioElement(BGM)  ─►  MediaElementSource  ─►  bgmGain  ─►  AnalyserNode (fftSize 1024)  ─►  destination
                                                                       │
                                                                       └─►  audio/reactive/analyser.js  (sample once/frame)
                                                                              │
                                                                              ▼
                                                                       audio/reactive/bands.js
                                                                       (sub, bass, lowMid, mid, highMid, air; log-spaced)
                                                                              │
                                                                              ▼
                                                                       audio/reactive/envelope.js
                                                                       (asymmetric attack 5–15 ms / release 80–200 ms)
                                                                              │
                                                                              ▼
                                                                       audio/reactive/normalizer.js
                                                                       (running peak AGC; norm in [0,1])
                                                                              │
                                                                              ▼
                                                                       FeatureBus signals (named, stable):
                                                                         bands.{x}.{value, env, norm}
                                                                         onsets.{kick, snare, generic}
                                                                         beat.{phase01, nextAt, confidence}

vfx/reactive/bindings.js   ◄── the ONLY consumer; declarative bindings
   bind(bands.bass.norm, target: glassMaterial.uniforms.uEdgeIntensity, range: [0.4, 1.6])
   bind(bands.lowMid.norm, target: ambientLayer.flowSpeed, range: [0.6, 1.4])
   bind(bands.mid.norm, target: dustEmitter.spawnRateMul, range: [1.0, 2.5])
   bind(onsets.kick, fire: (strength) => beatPulseEmitter.spawn(strength))
   bind(bands.bass.env, target: bloomPass.strength, range: [0.7, 1.0], slowTier: true)
```

The non-negotiable architectural rule: **`audio/reactive/` never imports `three`. `vfx/reactive/bindings.js` is the only place audio meets uniforms.** Everything else reads `bands.bass.norm()` as a number.

#### 4. Reasoning
- **Why naive FFT mapping fails.** `plan_particle_1.md` §4.1: bin energy is noisy (10–20% frame-to-frame), linear bins don't match perception, beat ≠ energy, onset events ≠ continuous envelope.
- **Why the FeatureBus pattern.** A stable "audio API" between the audio graph and the visuals. Audio internals can change (move from main-thread `AnalyserNode` to AudioWorklet, swap BPM detector) without touching consumers.
- **Why different bands drive different concerns.** Bass = slow tier (bloom, FOV, frame intensity, fog density). Treble = fast tier (sparkle, CA, particle flicker). Beats = impulse channel (one-shot bursts). Mixing tiers (binding bass to a fast effect) reads as "lag." Mixing impulses with continuous (binding onset events to bloom strength) reads as "flicker."
- **Why anticipation (Stage 5b).** The most distinctive "Tetris Effect" feel — the room responding *before* the beat — requires offline BPM detection + a beat-grid scheduler, not live onset. Run `web-audio-beat-detector` once on the BGM at boot, cache `{bpm, downbeatPhase}`, build a beat grid; subscribe systems to `beat.nextAt` events 200–300 ms ahead. Reference: `plan_particle_1.md` §4.5.

#### 5. Performance Impact
- `getByteFrequencyData(Uint8Array)` once per frame: < 0.05 ms.
- Band integration over 6 bands × ~512 bins: ~0.05 ms.
- Envelope follower per band: trivial.
- Onset detection (median-filtered spectral flux): ~0.1 ms.
- Bindings layer (10 uniform writes/frame): ~0.02 ms.
- **Total CPU: ~0.3 ms.** No new GPU work in this stage.

#### 6. File Structure Changes
```
src/audio/reactive/
├── analyser.js          (+, AnalyserNode tap, single sample/frame)
├── bands.js             (+, log-spaced band integration)
├── envelope.js           (+, asymmetric one-pole follower)
├── normalizer.js         (+, running-peak AGC)
├── onset.js              (+, spectral-flux + adaptive threshold + refractory)
└── beat-grid.js          (+, offline BPM + scheduled beat events)

src/vfx/reactive/
└── bindings.js           (+, declarative stream→uniform bindings)
```

#### 7. Dependencies
- `meyda` (~50 KB min+gz) — DSP feature extractor for spectralFlux/RMS. Optional; can hand-roll spectral flux. (`plan_particle_1.md` §4.4)
- `web-audio-beat-detector` (~10 KB) — offline BPM/downbeat. Required for anticipatory animation; without it, only reactive onsets are possible.
- *Skip:* Tone.js (overkill), essentia.js (5 MB WASM), Pizzicato (wrong layer).

#### 8. Step-by-Step Implementation
1. Wire `MediaElementSource` from the existing BGM `HTMLAudioElement` through a gain node into an `AnalyserNode (fftSize=1024, smoothingTimeConstant=0)` and back to destination. Modify `audio/playback.js` carefully — preserve the current procedural-SFX path.
2. Implement `audio/reactive/analyser.js` exposing `sample()` returning a `Float32Array` of the latest bin energies.
3. Implement `audio/reactive/bands.js` — log-spaced ranges [20–60, 60–200, 200–500, 500–2000, 2000–6000, 6000–16000] Hz, return per-band raw values.
4. Implement `audio/reactive/envelope.js` — asymmetric one-pole follower (`τ_a` for rise, `τ_r` for fall).
5. Implement `audio/reactive/normalizer.js` — running peak with slow decay (`peak = max(raw, peak * 0.999)`), `norm = clamp(raw / max(peak, 0.01), 0, 1)`.
6. Implement `audio/reactive/onset.js` — spectral-flux from `meyda` (or hand-rolled), median-filter window, adaptive threshold, 60 ms refractory.
7. Implement `audio/reactive/beat-grid.js` — on BGM track load, decode the file into `AudioBuffer`, run `web-audio-beat-detector`, cache `{bpm, downbeatPhase, confidence}`, project beat times, emit `beat.nextAt` events 250 ms ahead.
8. All of the above publish into a `FeatureBus` singleton (just an event emitter wrapping the engine bus, with named-stream getters).
9. Implement `vfx/reactive/bindings.js`. Define the bindings table (see code example below); register them at boot. `Clock.onRenderTick` calls `bindings.tick(audio)` once per frame; bindings.tick writes uniforms.
10. Add the `F` key debug overlay: a strip-chart of bands.{bass,mid,air}.{value,env,norm} + onset markers + beat-grid markers. Without this overlay, you cannot tune the system.

#### 9. Key Code Examples

```js
// audio/reactive/envelope.js — asymmetric one-pole envelope follower
export function envelope(tauAttackMs, tauReleaseMs) {
  let env = 0;
  return {
    update(raw, dtMs) {
      const tau = raw > env ? tauAttackMs : tauReleaseMs;
      env += (raw - env) * (1 - Math.exp(-dtMs / tau));
      return env;
    },
    get value() { return env; },
  };
}
```

```js
// vfx/reactive/bindings.js — declarative; the ONE place uniforms meet audio
export function createBindings({ feature, glassMaterial, ambient, bloom, beatPulse, dust }) {
  const bindings = [
    {
      get: () => feature.bands.bass.norm,
      apply: v => { glassMaterial.uniforms.uEdgeIntensity.value = lerp(0.4, 1.6, v); },
    },
    {
      get: () => feature.bands.lowMid.norm,
      apply: v => { ambient.uniforms.uFlowSpeed.value = lerp(0.6, 1.4, v); },
    },
    {
      get: () => feature.bands.mid.norm,
      apply: v => { dust.spawnRateMul = lerp(1.0, 2.5, v); },
    },
    {
      get: () => feature.bands.bass.env,
      apply: v => { bloom.strength = lerp(0.7, 1.0, v); },  // slow tier
    },
  ];
  feature.onsets.on('kick', strength => beatPulse.spawn(strength));
  return {
    tick() { for (const b of bindings) b.apply(b.get()); },
  };
}
```

#### 10. Next Stage Expansion Plan
Stage 6's chromatic aberration and after-image both subscribe to `bands.air.norm` (high-band shimmer). Stage 8's line-clear orchestrator schedules its flash peak to `beat.nextAt` for the beat-quantized punch. Stage 9's GPU particle sim takes `bands.bass.env` as a uniform driving emission rate.

---

### Stage 6 — Advanced Post-Processing System · ⚠ Partial

> **Shipped:** chromatic aberration (radial UV-offset; uAmount bound to `bands.air.norm`), after-image (Three's `AfterimagePass`, damp 0.85).
>
> **Pending:** depth-based exponential fog (every shader needs to opt in — bigger lift than it looks); motion blur (camera-velocity only, behind quality flag); DoF (behind quality flag).

#### 1. Goal
Round out the post chain: chromatic aberration, after-image (motion accumulation), depth-based fog. Defer motion-blur and DoF — both are easy to overdo and the marginal gain is small.

#### 2. Visual Result
- A subtle (≤2 px) radial chromatic aberration. Visible only at the screen edge.
- After-image — high-bloom regions leave a 2–4 frame tail. Sells "energy" without visible smearing.
- Volumetric-feeling fog — depth-based exponential. Reads as "deep space haze," not as "fog."
- (Deferred) Motion blur — only camera-velocity-driven, never per-particle. Behind a quality flag.
- (Deferred) DoF — easy to make the case look like a phone-camera Bokeh meme. Behind a quality flag.

#### 3. Technical Plan
- Implement each effect as a separate `ShaderPass` in `EffectComposer`. Pass order matters (`plan_particle_1.md` §5.6): distortion before bloom; tonemap before LUT; dither last.
- Chromatic aberration: simple UV offset per-channel; offset magnitude radial from center.
- After-image: a `ShaderPass` that maintains a previous-frame texture and blends it with the current at `0.85` decay. Cheap, dramatic.
- Fog: depth-based exponential fade in tonemap pass; reads `gl_FragCoord.z` and applies `exp(-z * density)`.

#### 4. Reasoning
The post chain is where "looks like a 3D demo" becomes "looks like a film." The risk is the effects that turn cheap fast: motion blur (looks like a smear if too strong) and DoF (looks like Instagram if too sloppy). Skip both for now — bloom + CA + after-image + fog already cover 80% of the perceived-quality lift.

#### 5. Performance Impact
- CA: ~0.2 ms at 1080p (3 texture samples per fragment).
- After-image: ~0.4 ms (one sample + blend; needs an extra render target).
- Fog: ~0.05 ms (combined with tonemap).
- **Total post chain: ~3.5 ms.** Tight but acceptable; mobile drops some effects via `qualityScalar`.

#### 6. File Structure Changes
```
src/rendering/post/
├── chromatic.js          (+, ~80 lines, ShaderPass)
├── afterimage.js         (+, ~100 lines)
├── fog.js                (+, ~60 lines, integrates with tonemap pass)
└── pipeline.js           (modify — explicit pass ordering)

src/shaders/
├── chromatic.frag.glsl   (+)
├── afterimage.frag.glsl  (+)
└── fog.frag.glsl         (+)
```

#### 7. Dependencies
None new.

#### 8. Step-by-Step Implementation
1. CA first (smallest visual change, biggest discipline test). Bind amount to `bands.air.norm` per Stage 5; clamp at 2 px max.
2. After-image. Tune decay factor — `0.88` reads as "ghost", `0.95` reads as "smear" (avoid).
3. Fog as a tonemap-pass tweak. Density `0.0035` is a good starting value at our scene scale.
4. (Optional) Motion blur behind a quality flag. Velocity-buffer-only — reproject previous-frame `viewProjection`, sample 8–12 taps along the velocity vector. Skip per-particle motion blur entirely (`plan_particle_1.md` §5.4).
5. (Optional) DoF behind a flag. Two-tap separable Gaussian based on linear depth. Strict `coc` clamp.

#### 9. Key Code Examples

```glsl
// shaders/chromatic.frag.glsl — radial CA, audio-modulated
uniform sampler2D tDiffuse;
uniform float uAmount;       // bound to bands.air.norm in vfx/reactive/bindings
varying vec2 vUv;
void main() {
  vec2 c = vec2(0.5);
  vec2 d = vUv - c;
  float r = length(d);
  vec2 dir = d / max(r, 1e-4);
  float amt = uAmount * r * 0.012;     // radial; stronger toward edges
  float r_ = texture2D(tDiffuse, vUv - dir * amt).r;
  float g_ = texture2D(tDiffuse, vUv).g;
  float b_ = texture2D(tDiffuse, vUv + dir * amt).b;
  gl_FragColor = vec4(r_, g_, b_, 1.0);
}
```

```js
// rendering/post/afterimage.js — feedback accumulator
export function createAfterimagePass({ damp = 0.88 } = {}) {
  const shader = {
    uniforms: { tDiffuse: { value: null }, tPrev: { value: null }, uDamp: { value: damp } },
    vertexShader: VIGNETTE_VERT,  // reuse passthrough
    fragmentShader: `
      uniform sampler2D tDiffuse, tPrev;
      uniform float uDamp;
      varying vec2 vUv;
      void main() {
        vec3 cur  = texture2D(tDiffuse, vUv).rgb;
        vec3 prev = texture2D(tPrev,    vUv).rgb;
        // max() is the bloom-friendly choice; lerp() smears on movement.
        gl_FragColor = vec4(max(cur, prev * uDamp), 1.0);
      }`,
  };
  // ... wraps a ShaderPass + maintains a previous-frame target via render-to-texture
}
```

#### 10. Next Stage Expansion Plan
Stage 7's glass material refraction can sample the post-bloom buffer for "glow refracts through cube edges." Stage 8 line-clear flash benefits from after-image (clear flashes leave a visible tail). Stage 10 nebula is rendered as part of the geometry pass; fog parameters tune to keep the nebula readable at distance.

---

### Stage 7 — Advanced Block Materials · ⚠ Partial

> **Shipped:** `fwidth(vNormalW)`-based edge-emissive component on the active piece glow shell (delivered as part of Stage 2); `uEdgeColor` + `uEdgeIntensity` uniforms in [`glass.frag.glsl`](../project/src/shaders/glass.frag.glsl).
>
> **Pending:** depth-aware refraction (sample background buffer with `cross(viewDir,normal)`-driven UV offset); `bands.bass.norm → uEdgeIntensity` binding (a 1-line addition in [`bindings.js`](../project/src/vfx/reactive/bindings.js) once we agree on the range); piece-settling animation tied to edge-intensity ramp.

#### 1. Goal
Make blocks look like *electronic glass* — refractive, edge-emissive, alive in motion. Not just "transparent material with a fresnel."

#### 2. Visual Result
- Locked cubes: faintly transparent, edges catching light. Refraction subtly distorts the field behind them.
- Active piece: stronger emissive core, brighter edges, slight pulse.
- Ghost piece: outline only, low alpha, no fill.
- Edge highlights respond to camera angle (true fresnel) and to a subtle audio modulation (bass envelope).
- Right after a piece locks (the "settling" animation that already exists): a brief edge-emissive ramp-up, then settle.

#### 3. Technical Plan
- Glass shader (`shaders/glass.frag.glsl`) gets two new components: depth-aware refraction sampling the previous-pass scene buffer, and a `fwidth(normal)`-driven edge-detect highlight (already prototyped in Stage 2).
- Refraction is a single texture sample with UV offset proportional to `cross(viewDir, normal)`. Cheap and convincing.
- Active vs locked piece materials share the same shader, different uniforms. Ghost is a separate "outline-only" variant.
- The "settling" animation interpolates `uEdgeIntensity` from 1.6 → 0.6 over 1.5s after lock. This is the existing `startLockAnim` codepath, just pointing at the shader uniform instead of opacity.

#### 4. Reasoning
- **Why simple transparent isn't enough.** Any `MeshPhysicalMaterial({ transparent, transmission })` reads as plastic without an environment map. The fresnel-only approach baked into our existing `glass.frag.glsl` already beats `MeshPhysicalMaterial` for our scene. Stage 7 finishes that direction.
- **Why "electronic glass" not "real glass."** Real glass is *quiet* — nearly invisible head-on, only rim glints visible. Electronic glass *holds light* — rim, body, edges all carry color. Tetris Effect's cubes are electronic glass: they look like data made physical.
- **Refraction matters even slightly.** A 1–2 px UV offset in the cube body is enough to read as "transparent material" instead of "decal." Skipping refraction entirely makes the cubes feel painted on.

#### 5. Performance Impact
- One additional render-target sample per cube fragment (refraction). At ~20 visible cubes × ~10k fragments = 200k samples/frame. ~0.1 ms.
- Edge highlight via `fwidth()` — derivatives are free in WebGL2.
- After-piece-lock ramp uses existing animation system. No new cost.

#### 6. File Structure Changes
```
src/materials/
├── glass.js                (modify — factor out, add refraction+edge uniforms)
└── cube-emissive.js        (was created in Stage 2; extends to active/ghost variants)

src/shaders/
└── glass.frag.glsl         (modify — add refraction sample + edge accent)
```

#### 7. Dependencies
None new.

#### 8. Step-by-Step Implementation
1. Add a `tBackground` sampler uniform on the glass shader. Bind it to a `THREE.WebGLRenderTarget` storing the post-opaque pre-transparent render of the scene.
2. In the fragment shader: sample `tBackground` at UV offset by `cross(viewDir, normal).xy * uRefractionAmount`. Mix into `gl_FragColor` weighted by `1 - fres`.
3. Add `uRefractionAmount` (~0.03 typical), `uEdgeColor`, `uEdgeIntensity` uniforms.
4. Add the `fwidth(vNormalW)` edge component (Stage 2 prototyped this — finalize the formula).
5. Wire `uEdgeIntensity` to bind from `bands.bass.norm` (Stage 5 layer) at a small range [0.7, 1.1] for active piece; locked cubes don't bind (always 1.0).
6. Verify the settling animation still smoothly transitions edge intensity over 1.5s post-lock.

#### 9. Key Code Examples

```glsl
// shaders/glass.frag.glsl — final form
uniform vec3 uColor;
uniform float uIntensity;
uniform float uPower;
uniform float uFloor;
uniform vec3 uEdgeColor;
uniform float uEdgeIntensity;
uniform sampler2D tBackground;
uniform float uRefractionAmount;
varying vec3 vNormalW;
varying vec3 vViewDirW;
varying vec4 vScreenPos;
void main() {
  float ndv = clamp(dot(normalize(vNormalW), normalize(vViewDirW)), 0.0, 1.0);
  float fres = pow(1.0 - ndv, uPower);
  float a = (uFloor + (1.0 - uFloor) * fres) * uIntensity;
  vec3 base = uColor * a;

  // Refraction — sample the post-opaque scene at offset UVs.
  vec2 screenUv = (vScreenPos.xy / vScreenPos.w) * 0.5 + 0.5;
  vec2 refrUv  = screenUv + cross(vViewDirW, vNormalW).xy * uRefractionAmount;
  vec3 refr    = texture2D(tBackground, refrUv).rgb;
  base = mix(base, base * 0.6 + refr * 0.6, 1.0 - fres);

  // Edge highlight — fwidth() reads geometric edge width per pixel.
  float edge = clamp(length(fwidth(vNormalW)) * 6.0, 0.0, 1.0);
  base += uEdgeColor * edge * uEdgeIntensity;

  gl_FragColor = vec4(base, a);
}
```

#### 10. Next Stage Expansion Plan
Stage 8's line-clear shatter graduates to the `cube-emissive` material — fragments inherit the parent block's `uColor` and `uEdgeIntensity` so the shatter reads continuous with the lock. Stage 5's bass binding already affects the edge intensity.

---

### Stage 8 — Event-Driven Effects System · ⚠ 8a Complete, 8b/c Pending

> **8a (shipped):** stage spec system in [`config/stages.js`](../project/src/config/stages.js) (3 stages: `cyan-void`, `ember-rise`, `aurora`; each with `palette[]` + `accentHex` + `clearRecipe` per tier + `nebulaPalette` cross-ref). [`vfx/stage-controller.js`](../project/src/vfx/stage-controller.js) owns the active stage and emits `STAGE_CHANGE`. `_stagePalette()` in main.js now reads from the controller. `STAGE_CHANGE → nebula.crossfadeTo` wired through the bus. Stage selector dropdown in the effects panel + `__stage` console handle.
>
> **8b (pending — the inflection point):** `LineClearOrchestrator` in [`vfx/director.js`](../project/src/vfx/director.js) that subscribes to `LINE_CLEAR` and reads `stage.clearRecipe` to gate which layers fire per tier (single/double/triple/tetris). Currently the recipe is *defined* but not *consumed* — `clearLines()` still fires every layer inline.
>
> **8c (pending — content):** new emitter modules (`voxel-fragments`, `ribbon`, `env-reaction` per §1.6 layers 1/4/7); `HOLD_PIECE`, `COMBO_INCREMENT`, `COMBO_RESET` event additions; HARD_DROP/GAME_OVER director cleanup; beat-quantized scheduling for layers 3/5/6 (depends on 5b beat grid).

#### 1. Goal
The full layered event-driven cinematic, per `plan_particle_1.md` §1.6. This is the stage where line clears stop being "okay" and start being "the thing players remember."

#### 2. Visual Result
On a Tetris (4-row clear):
1. **Cube fragments** (~6 shards/cell): block-color, world-space, ballistic-with-gravity. Inside the case.
2. **Sparkle layer** (~600 particles): **stage-palette**, not block color — buoyant, longer-lived.
3. **Shockwave ring**: stage-accent, HDR-boosted, expanding from the cleared rows.
4. **Trails**: short streamers from rows to case edges (stage-gated; ribbons not in every stage).
5. **Flash**: 1-frame full-screen accent flash + 2–3 frames of after-image decay.
6. **Camera-space veil**: brief tonemap bias toward stage hue.
7. **Environment reaction**: depending on stage — water ripple plane / starfield flare / sand kick. *Outside* the case.

On smaller clears (1, 2, 3 rows), only layers 1+2 fire (modest fragments + sparkle). On Perfect Clear, layer 7 lights up the entire case. Tier-gated by a single "clear weight" scalar.

Other events also wired:
- Hard drop: impact ring (already exists), trail (already exists), camera shake (already exists), drop SFX. Migrate the inline body of HARD_DROP listener entirely into director.
- Hold: tiny puff of stage-palette particles around the hold panel + UI flash.
- Combo: each consecutive clear without a no-clear-lock incrementally raises the "clear weight" scalar. Visual escalation comes free from the tier gate.

#### 3. Technical Plan
The architecture is already in place ([`src/vfx/director.js`](../project/src/vfx/director.js)) and HARD_DROP + LEVEL_UP are wired through it. This stage:

1. **Add new emitters** — `vfx/emitters/{voxel-fragments, sparkle, shockwave, ribbon, flash, env-reaction}.js`. Each pre-allocates its pool, exposes `spawn(params)` and `update(dt, totalSec)`.
2. **Add stage system** — `config/stages.js` with per-stage `palette`, `accentHue`, `clearLayerRecipe` (which layers fire on a clear, with what sprite atlas / motion model). The existing `MOOD_PRESETS` is the seed for this.
3. **Add `LineClearOrchestrator`** in `vfx/director.js` — the §1.6 logic:
   - Compute tier weight from `simultaneous` (1 → 1.0; 2 → 1.5; 3 → 2.2; 4 → 3.0; perfect → 5.0).
   - Read `stage.clearLayerRecipe`.
   - Schedule layers 1+2 immediately; schedule layers 3+5+6 to peak on `beat.nextAt`.
   - Apply color rules: fragments inherit `colors[i]` (block); sparkle uses `stage.palette[i % n]`; flash/shockwave/veil use `stage.accentHue`.
   - Trigger layer 7 (env reaction) via `EnvReactionSystem.onClear(tier)`.
4. **Migrate HARD_DROP cleanly** — the current director wiring is the right pattern; just verify the call signatures stay stable as emitters move.
5. **Add hold/combo events** — `gameplay/` emits `HOLD_PIECE` and `COMBO_INCREMENT`; director subscribes.

#### 4. Reasoning
This is *the* feel moment of the entire visual system. The most-cited "Tetris Effect feel" reference (`plan_particle_1.md` §1.6.2 rule 2) is that the sparkle layer uses the *stage palette*, not the block color — this is the single change most likely to be skipped, and most likely to cause "looks great but feels generic." Color-source rules are the bug-prone part of this stage.

The event taxonomy is already documented in [`src/gameplay/events.js`](../project/src/gameplay/events.js); we extend it with `HOLD_PIECE` and `COMBO_INCREMENT`.

The tier-gated emission is what makes a Single visibly different from a Tetris (not just "more particles"). Players read the differentiation; balance team plays with the curve.

#### 5. Performance Impact
- 6 new emitter pools. Pre-allocated, idle = no cost. Active during a Tetris = ~3–4 simultaneously emitting.
- Worst case (Perfect Clear): all 7 layers firing + camera shake + flash. CPU budget for emit-decisions: ~0.3 ms. GPU: ~1.5 ms extra in the burst frame. Settles in 600 ms.
- Bus dispatch is sub-microsecond per emit; never the bottleneck.

#### 6. File Structure Changes
```
src/vfx/
├── director.js              (modify — add LineClearOrchestrator, HOLD_PIECE, COMBO_INCREMENT)
├── emitters/
│   ├── voxel-fragments.js   (+, instanced cubes; replaces inline shatter pool)
│   ├── sparkle.js           (+, instanced points; current sparkle pool refactored)
│   ├── shockwave.js         (+, SDF ring quad)
│   ├── ribbon.js            (+, history-buffer trail strip)
│   ├── flash.js             (+, full-screen overlay quad)
│   └── env-reaction.js      (+, stage-dispatched: water-ripple/starfield-flare/sand-kick)
└── stages/
    ├── stage-spec.js        (+, types + helpers)
    ├── deep-cyan.js         (+, default starter stage; uses today's mood-preset content)
    └── desert-amber.js      (+, second stage; alternate clearLayerRecipe + palette)

src/gameplay/
└── events.js                (modify — add HOLD_PIECE, COMBO_INCREMENT, COMBO_RESET)

src/config/
└── stages.js                (+, registry)
```

#### 7. Dependencies
None new.

#### 8. Step-by-Step Implementation
1. Migrate the inline shatter pool into `vfx/emitters/voxel-fragments.js`. Verify visuals identical.
2. Migrate the inline line-clear sparkle pool into `vfx/emitters/sparkle.js`. Verify identical.
3. Add `vfx/emitters/shockwave.js` and `flash.js`. Wire each to its own bus event for now (so they can be unit-tested).
4. Add `config/stages.js` and one starter `stage-spec` (cyan/violet, current MOOD_PRESETS.void content).
5. Replace the existing `clearLines` view body with `bus.emit(EVENTS.LINE_CLEAR, ...)` ONLY (the model side of it — score, level update — stays in `gameplay/`). The view body becomes a director listener that calls `LineClearOrchestrator.onClear(payload, stage)`.
6. Implement the orchestrator. Start simple: tier weight + which layers fire + immediate vs beat-quantized scheduling.
7. Apply color rules. **This is the verification step**: visually confirm sparkle is stage-cyan regardless of the cleared piece color, and fragments are piece-color.
8. Add the second stage (desert amber, different palette + different `clearLayerRecipe`) to verify the system actually scales.
9. Add hold + combo events; trivial puff emitters subscribed.

#### 9. Key Code Examples

```js
// vfx/director.js — LineClearOrchestrator
export function createLineClearOrchestrator({ stages, currentStageId, emitters, beatGrid }) {
  return {
    onClear({ rows, simultaneous, colors, scoreDelta, overallColor }) {
      const stage = stages[currentStageId];
      const tier = tierFromSimultaneous(simultaneous);  // 1, 1.5, 2.2, 3.0
      const recipe = stage.clearLayerRecipe;

      // Layer 1: fragments (block color, immediate, inside-case)
      if (recipe.fragments) {
        for (let i = 0; i < rows.length; i++) {
          emitters.voxelFragments.spawnRow(rows[i], colors[i], tier);
        }
      }

      // Layer 2: sparkle (STAGE PALETTE, not block color)
      if (recipe.sparkle) {
        for (let i = 0; i < rows.length; i++) {
          emitters.sparkle.spawnRow(rows[i], stage.palette[i % stage.palette.length], tier);
        }
      }

      // Layers 3, 5, 6: peak on next beat (audio-clock quantization)
      if (recipe.shockwave && tier >= 2) {
        beatGrid.scheduleAt(beatGrid.nextBeatTime(), () => {
          emitters.shockwave.spawn({ rows, color: stage.accentHue, tier });
        });
      }
      if (recipe.flash && tier >= 2) {
        beatGrid.scheduleAt(beatGrid.nextBeatTime(), () => {
          emitters.flash.fire({ color: stage.accentHue, tier });
        });
      }

      // Layer 7: environment reaction (outside case)
      if (recipe.envReaction) {
        emitters.envReaction.onClear({ tier, stage });
      }
    },
  };
}
```

```js
// gameplay/events.js — additions
export const EVENTS = Object.freeze({
  // ... existing ...
  HOLD_PIECE:        'HOLD_PIECE',         // { color, key }
  COMBO_INCREMENT:   'COMBO_INCREMENT',    // { count }
  COMBO_RESET:       'COMBO_RESET',        // (no payload)
  STAGE_CHANGE:      'STAGE_CHANGE',       // { from, to, reason: 'phrase' | 'manual' | 'level' }
});
```

#### 10. Next Stage Expansion Plan
Stage 9 promotes the highest-density emitters (sparkle, fragments) to GPU-resident sim — orchestrator stays unchanged. Stage 10's nebula skybox responds to `STAGE_CHANGE` events for cross-fade transitions.

---

### Stage 9 — GPU Particle Architecture Upgrade · ❌ Not started

#### 1. Goal
Move the highest-count particle layers (ambient drift, sparkle pool) from CPU integration to GPU-resident simulation. Unlock 30k–50k+ ambient particles. Free up several ms of CPU/frame.

#### 2. Visual Result
- Ambient particle count goes from ~500–2k (current Stage 3) to 20k–40k. The flow becomes *thick* — the field reads as continuous.
- Sparkle pool size doubles or triples without CPU cost.
- No visual regression (the boundary is the `ParticleLayer` interface from Stage 3).
- Mobile drops to a smaller particle count via `qualityScalar`.

#### 3. Technical Plan
- **WebGL2 path: FBO ping-pong GPGPU.** Two `RGBA16F` render targets store position+age and velocity+lifetime. Fragment shader integrator reads the previous frame's textures, advances state, writes the next frame. The render pass's vertex shader reads the *current* state texture by `gl_InstanceID` and emits a billboard quad. References: `plan_particle_1.md` §3.3.
- **WebGPU path (deferred to Stage 9b):** compute shader writing a single storage buffer of `Particle` structs.
- **Shared resources:** the 3D curl-noise texture from Stage 4 is sampled by every flow-driven system.
- **Don't promote everything.** Bursts (line-clear sparkle, fragments) stay CPU-allocated — short-lived, heterogeneous, would cost more to GPU-orchestrate. Promote ambient + dust + sparkle background layers; keep bursts CPU.

#### 4. Reasoning
- **Why CPU particles cap out.** Per-particle integration on CPU is ~30–60 ns each on a modern laptop. At 60 FPS, that's a budget of ~270k particle-updates. Subtract bookkeeping and you're at ~80k. Plus you pay the full upload cost — `BufferAttribute.needsUpdate = true` re-uploads the whole buffer.
- **Why GPU particles scale.** Integration runs at fragment-shader rates (millions/frame). Position state stays in VRAM; no upload. The CPU does only spawn/free decisions — bound by event count, not particle count.
- **Why FBO ping-pong vs transform feedback.** Both work in WebGL2. FBO ping-pong is more flexible (write any state layout you want into the textures); transform feedback is simpler but one-buffer-per-shader-output. For a multi-system architecture, FBO wins. References: Codrops *Crafting a Dreamy Particle Effect*, Maxime Heckel's particles guide.
- **Why now, not earlier.** Doing GPU sim before the abstractions stabilize means rewriting everything when the boundaries change. Stages 3–8 establish the `ParticleLayer` interface; Stage 9 swaps the implementation.

#### 5. Performance Impact
- Ambient field: CPU 4 ms → GPU 0.2 ms. **Net win 3.8 ms/frame.**
- Particle count for the same budget: 5–10×.
- VRAM cost: two RGBA16F render targets at sqrt(N)×sqrt(N) — 50k particles ≈ 224×224 ≈ 0.4 MB per target × 2 = 0.8 MB. Negligible.
- Boot cost: noise texture bake (Stage 4 work) + render-target setup, ~1.5 sec total. Worth a loading-screen splash.

#### 6. File Structure Changes
```
src/vfx/
├── gpu-sim.js               (+, ~250 lines — GPGPUParticleSimulator helper class)
├── emitters/
│   ├── particle-layer.js   (modify — add `gpu: true` mode that uses gpu-sim)
│   └── ...
└── ...

src/shaders/
├── gpgpu-position.frag.glsl   (+, integrator for position+age)
├── gpgpu-velocity.frag.glsl   (+, integrator for velocity+lifetime — reads curl noise)
└── gpgpu-render.vert.glsl     (+, reads state textures by instance id)
```

#### 7. Dependencies
None new (Three.js already includes `GPUComputationRenderer`; we may use it directly or hand-roll FBO ping-pong for tighter control — both work).

#### 8. Step-by-Step Implementation
1. Build `vfx/gpu-sim.js` — a `GPGPUParticleSimulator` class wrapping ping-pong + shader-pass logic.
2. Port the Stage 3 ambient layer to GPU mode behind a flag (`gpu: true`). Keep the CPU path; flip back if anything regresses.
3. Verify visual identity at the same particle count (5k). Then ramp count up to 30k. Profile.
4. Port the sparkle pool. Verify line-clear visuals identical.
5. Add `qualityScalar` LOD: low/mid/high tiers correspond to particle counts (5k/15k/40k for ambient, 1k/2k/4k for sparkle).
6. Add a particle-count debug overlay so tuning is observable.

#### 9. Key Code Examples

```js
// vfx/gpu-sim.js — minimal ping-pong skeleton
export class GPGPUParticleSimulator {
  constructor(renderer, { count, integrators }) {
    const w = Math.ceil(Math.sqrt(count));
    this.size = w;
    // Two FBOs per state texture (positionA/B, velocityA/B)
    this.targets = {
      position: [makeFBO(w, w), makeFBO(w, w)],
      velocity: [makeFBO(w, w), makeFBO(w, w)],
    };
    this.read = 0; this.write = 1;
    this.integrators = integrators;  // { position: ShaderMaterial, velocity: ShaderMaterial }
    this.renderer = renderer;
  }
  step(dt, uniforms) {
    // Bind read targets as uniforms in integrator
    this.integrators.position.uniforms.tPosition.value = this.targets.position[this.read].texture;
    this.integrators.position.uniforms.tVelocity.value = this.targets.velocity[this.read].texture;
    // ... set dt, time, etc ...
    // Render integrator into write target
    this.renderer.setRenderTarget(this.targets.position[this.write]);
    renderFullScreenQuad(this.integrators.position);
    // Same for velocity
    [this.read, this.write] = [this.write, this.read];
  }
  get positionTexture() { return this.targets.position[this.read].texture; }
}
```

```glsl
// shaders/gpgpu-velocity.frag.glsl — integrator
uniform sampler2D tPosition;
uniform sampler2D tVelocity;
uniform sampler3D uCurl;
uniform float uDt;
uniform float uCurlStrength;
varying vec2 vUv;
void main() {
  vec4 pAge = texture2D(tPosition, vUv);     // xyz=pos, w=age
  vec4 vLife = texture2D(tVelocity, vUv);    // xyz=vel, w=lifetime

  // Sample curl noise at current position
  vec3 curl = texture(uCurl, fract(pAge.xyz * 0.05)).rgb * 2.0 - 1.0;
  vec3 newVel = mix(vLife.xyz, curl * uCurlStrength, 0.05);   // smooth target chase

  gl_FragColor = vec4(newVel, vLife.w);
}
```

#### 10. Next Stage Expansion Plan
Stage 10 nebula uses a similar half-res GPU pass for the volumetric layer; the `gpu-sim.js` infrastructure generalizes. WebGPU port (Stage 9b in a future doc) replaces ping-pong with compute storage buffers + indirect draw — same logical pipeline.

---

### Stage 10 — Final Atmosphere Layer · ⚠ Mostly Complete

> **Shipped:** procedural nebula skybox in [`world/nebula-sky.js`](../project/src/world/nebula-sky.js) — 3-octave fbm of 3D simplex noise sampled along view direction, two-LUT crossfade via [`shaders/nebula.frag.glsl`](../project/src/shaders/nebula.frag.glsl). Palette LUT system in [`config/palettes.js`](../project/src/config/palettes.js) (4 starter palettes). `STAGE_CHANGE → nebula.crossfadeTo` wired through bus. `__nebula` console handle.
>
> **Pending:** distant cosmic structure (low-poly silhouette meshes at radius 60–80); vertical fog gradient (depends on Stage 6 fog); optional `bands.bass.env → nebula.setIntensity` binding (1-line addition).

#### 1. Goal
The world feels *inhabited* — there's a giant cosmic structure beyond the playfield. Distant galaxies, slow nebulae, sense of immense scale.

#### 2. Visual Result
- A procedural nebula skybox — slow-rotating, color-shifting in 30–90 sec cycles. Stage-palette-tinted.
- Distant cosmic structure — a few large low-poly meshes (asteroid silhouettes / structure / planets) at world-far distance, with their own slow rotation.
- A volumetric-feeling fog density gradient — denser toward the back, thinner toward the camera. Reads as atmosphere depth.
- Color of the nebula crossfades on stage change (Stage 8's `STAGE_CHANGE` event).
- Combined effect: the playfield reads as *a window into space*, not *a 3D HUD*.

#### 3. Technical Plan
- **Nebula skybox.** A unit sphere with a procedural fragment shader: 3–4 octaves of simplex noise, layered with a palette LUT (1D texture of stage colors). Sample direction in world space; output emissive RGB, no lighting.
- **Distant structure.** 3–6 low-poly meshes (one or two thousand tris total) positioned at radius 60–80, parented to a slowly rotating group. Emissive material with subtle audio modulation (slow tier).
- **Atmospheric fog gradient.** Already implemented in Stage 6's fog pass — extend with a *vertical* term so the gradient feels like upwards-thinning haze.
- **Cross-fade on stage change.** Two LUT textures, blended by a `uStageBlend` uniform that lerps over 2–3 sec.

#### 4. Reasoning
This is the final art-direction layer. Without it, the playfield always reads as a CG demo. With it, the playfield reads as a place. The cost is small (skybox + 6 meshes), and the perceived-quality lift is large because the eye constantly samples the periphery for context — even if the player consciously focuses on the board.

The nebula is *not* a literal scientific simulation. It's a stylized procedural background. Spending shader budget here on accurate volumetrics is wrong; spend it on palette discipline and motion coherence.

#### 5. Performance Impact
- Skybox: 1 draw call, fullscreen, ~0.6 ms at 1080p (4 octaves of simplex). Half-res it on mobile.
- Distant meshes: 1 draw call total via instancing, ~0.05 ms.
- LUT cross-fade: trivial uniform interpolation.
- **Total Stage 10 add: ~0.7 ms.**

#### 6. File Structure Changes
```
src/world/
├── nebula-sky.js              (+, ~120 lines — skybox setup, palette LUT)
├── distant-structure.js       (+, ~80 lines — instanced low-poly meshes)
└── ...

src/shaders/
├── nebula.frag.glsl           (+, octave simplex + palette LUT sampling)
└── nebula.vert.glsl           (+, passthrough or world-direction mode)

src/config/
└── palettes.js                (+, per-stage LUT definitions)
```

#### 7. Dependencies
None new. The simplex noise can be hand-ported from any reference; we already use noise in Stage 4's curl bake.

#### 8. Step-by-Step Implementation
1. Add `world/nebula-sky.js` — a `THREE.Mesh` with `BackSide`-rendered icosahedron at `radius = 100` and a custom shader.
2. Bake/port a stage palette LUT — 256×1 RGBA texture per stage; sample by noise value to color.
3. Implement `nebula.frag.glsl`: 4 octaves of 3D simplex sampled along the view direction (world-space), use the noise to pick from the palette LUT.
4. Add `distant-structure.js` — `InstancedMesh` of 4–6 low-poly assets at far distance, parented to a slowly rotating group.
5. Wire `STAGE_CHANGE` event: cross-fade LUT over 2.5 sec.
6. Final tuning pass — nebula brightness must stay below the playfield's bloom threshold so it doesn't compete for attention.

#### 9. Key Code Examples

```glsl
// shaders/nebula.frag.glsl — sketch
uniform sampler2D uPaletteA;
uniform sampler2D uPaletteB;
uniform float uStageBlend;     // 0..1
uniform float uTime;
varying vec3 vWorldDir;
float simplex(vec3 p);          // standard impl

float fbm(vec3 p) {
  float a = 0.0, w = 0.5;
  for (int i = 0; i < 4; i++) {
    a += w * simplex(p);
    p *= 2.0; w *= 0.5;
  }
  return a;
}

void main() {
  vec3 dir = normalize(vWorldDir);
  float n = fbm(dir * 1.7 + vec3(uTime * 0.005));
  float pal = clamp(n * 0.5 + 0.5, 0.0, 1.0);
  vec3 a = texture2D(uPaletteA, vec2(pal, 0.5)).rgb;
  vec3 b = texture2D(uPaletteB, vec2(pal, 0.5)).rgb;
  vec3 col = mix(a, b, uStageBlend);
  gl_FragColor = vec4(col * 0.45, 1.0);   // dim — must not compete with playfield
}
```

#### 10. Next Stage Expansion Plan
Beyond Stage 10: per-track choreographed scenes (Tetris Effect's stage-mode), VR-mode rendering target, mobile-specific quality cliffs, content authoring tooling, multiplayer sync, Zone-mode (the giant-burst variant from `plan_particle_1.md` §1.6.3 row 6). All "content" rather than "engine" work.

---

## 4. Performance Budget Table (1080p, 60 FPS desktop mid)

| Subsystem | Budget | Notes |
|---|---|---|
| Game logic (gameplay tick) | 0.5 ms | Trivial; bottleneck is rare |
| Audio analyser + bands + onsets | 0.3 ms | Single FFT read; envelope follower |
| Bindings layer | 0.05 ms | <20 uniform writes |
| Particle CPU work (Stage 3 layers) | 1.5 ms | Pre-Stage-9 |
| Particle GPU sim (Stage 9 layers) | 0.5 ms | Post-Stage-9 |
| Geometry pass (board + cubes + case) | 1.0 ms | ~30 draw calls |
| Effect pass (sparkles, shards, ambient) | 1.5 ms | Mostly fragment-bound |
| Selective bloom render (Stage 2) | 1.0 ms | Mask render + downsample/upsample |
| Post chain (CA + after-image + fog + tonemap) | 1.5 ms | Stage 6 budget |
| CSS3DRenderer HUD | 0.3 ms | Existing |
| **Frame total** | **~9 ms / 16.7** | ~7.7 ms headroom for VFX bursts |

Tight — but not breaking. Mobile cuts particle counts and post-chain depth via `qualityScalar`.

## 5. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Stage 5 audio analyser noisy → strobing visuals | High | High | envelope followers (asymmetric attack/release), per-band normalizer, **F-key debug overlay from day 1** |
| Stage 8 line-clear color rules skipped → "looks like our current emitter" | High | Medium | code-review checklist: sparkle uses *stage palette*, never block color |
| Stage 9 GPU sim FP precision drift | Medium | Medium | RGBA16F not 32F, modulo wrapping on positions, weekly soak-tests |
| Stage 10 nebula brightness competes with playfield | Medium | Low | bake max-brightness clamp into shader; manual review |
| Cumulative shader hot-reload churn slows iteration | Medium | Low | `import xx from 'x.glsl?raw'` is already set up; verify at start of each stage |
| Sub-stage cycles drift architecture out of `plan_architecture.md` rules | Medium | High | enforce ESLint `no-restricted-imports`; new modules go through `vfx/director.js` not directly |
| WebGPU swap timing forces premature post-chain rewrite | Low | Medium | feature-flag the `WebGPURenderer` path; keep WebGL2 the canonical path through Stage 10 |

## 6. Mapping to Existing Modules

The architectural skeleton is already in place from `plan_architecture.md` PRs 1–7. Each stage of *this* plan slots directly into existing folders:

| Stage | Primary modules touched |
|---|---|
| 1 | `world/`, `camera/breathe.js` |
| 2 | `rendering/post/`, `materials/`, `shaders/` |
| 3 | `vfx/emitters/`, `vfx/layer-registry.js` |
| 4 | `vfx/curl-noise.js`, `shaders/` |
| 5 | `audio/reactive/`, `vfx/reactive/`, `engine/events/bus.js` (existing) |
| 6 | `rendering/post/`, `shaders/` |
| 7 | `materials/glass.js`, `shaders/glass.frag.glsl` |
| 8 | `vfx/director.js` (existing — extended), `vfx/emitters/`, `config/stages.js`, `gameplay/events.js` (existing — extended) |
| 9 | `vfx/gpu-sim.js`, `shaders/gpgpu-*.glsl` |
| 10 | `world/nebula-sky.js`, `world/distant-structure.js`, `shaders/nebula.*.glsl` |

The bus, clock, director, gameplay isolation, and shader-as-files plumbing are already done. This roadmap is mostly *content + tuning*, not *plumbing*.

## 7. Relationship to `plan_particle_1.md`

`plan_particle_1.md` is **kept as the deeper technical reference**, not deprecated. Specifically these sections remain authoritative:

- §1.1–1.7 visual analysis (motion language, density layering, line-clear anatomy, color rules)
- §3 particle manager architecture
- §4 audio reactive design — the FeatureBus pattern, asymmetric envelope math, beat-grid scheduling
- §5.4 real-vs-fake post-effect inventory
- §6.2 particle budgets per quality tier

What `plan_particle_2.md` (this doc) replaces:

- §7 phase ordering — the user's 10-stage progression supersedes the previous 8-phase plan.
- The implementation status table at the top of `plan_particle_1.md` — that document overstated what was implemented; this document grounds in actual code.

When implementing a stage, read both:
- *This* doc for the goal, scope, and step-by-step plan.
- `plan_particle_1.md` for the supporting analysis (especially §1.6 for Stage 8, §4 for Stage 5).

## 8. Schedule — Planned vs Actual

| Stage | Original budget | Done | Remaining | Notes |
|---|---|---|---|---|
| 1 — Spatial awareness | 0.5 day | 0.5 ✅ | — | shipped |
| 2 — Bloom + emissive + selective | 1.5 days | 1.5 ✅ | — | shipped |
| 3 — Particle layers | 1 day | 0 ❌ | 1 day | not started; deferred (existing 500-particle field is adequate) |
| 4 — Curl-noise field | 1.5 days | 0 ❌ | 1.5 days | not started |
| 5 — Audio reactive | 3 days | 1.5 ⚠ | 1.5 days | 5a complete (analyser/bands/envelope/normalizer/bindings); 5b pending (onsets/beat-grid/anticipation/+bindings) |
| 6 — Advanced post | 1.5 days | 1.0 ⚠ | 0.5 day | CA + after-image done; fog pending; motion blur + DoF deferred |
| 7 — Glass material | 1 day | 0.3 ⚠ | 0.7 day | edge-emissive done; refraction + bass-binding pending |
| 8 — Event-driven layered | 2.5 days | 1.0 ⚠ | 1.5 days | 8a (stage system + STAGE_CHANGE) done; 8b (LineClearOrchestrator) + 8c (new emitters) pending |
| 9 — GPU particle sim | 2 days | 0 ❌ | 2 days | not started |
| 10 — Nebula + atmosphere | 1.5 days | 1.0 ⚠ | 0.5 day | nebula + crossfade done; distant structure + vertical fog pending |
| **Total** | **~16 days** | **~7 days** | **~9 days** | — |

Stages 5 and 8 still dominate the remaining work. **Stage 8b (LineClearOrchestrator)** is the highest-leverage remaining item — see §9.

## 9. Roadmap from Here

Concrete next sessions, ordered by **felt-quality lift per day** rather than plan-section number. Each is independently green and ships under one focused session.

### 9.1 — Stage 8b: LineClearOrchestrator (~1.5 days · the inflection point)

The single most "Tetris Effect feel" change still on the board. Stage 8a already wired up the stage controller, palette discipline, and `STAGE_CHANGE` plumbing — the missing piece is the orchestrator that consumes `stage.clearRecipe`.

**Scope**
- Build `LineClearOrchestrator` in [`src/vfx/director.js`](../project/src/vfx/director.js):
  1. Subscribe to `EVENTS.LINE_CLEAR`
  2. Compute tier from `simultaneous` via `tierForRows()` (already in [`config/stages.js`](../project/src/config/stages.js))
  3. Read `stageController.spec.clearRecipe[tier]`
  4. For each layer flag: gate the existing inline emitter call (sparkle / flash / shockwave / veil)
- Refactor [`clearLines()`](../project/src/app/main.js) so it ONLY emits the bus event (model side); the view-side firing moves into the orchestrator
- Verify tier escalation reads correctly: a single-line clear should now look visibly different from a triple, and a triple visibly different from a tetris

**Why this is high leverage**
- The recipe is already defined; this PR makes it *active*. Single-line clears stop firing the dramatic flash + shockwave + veil layers (they were always firing before, just faintly because `triggerFlash` and `triggerLineClearVeil` had `rowCount < 4` guards). Result: clears feel **graded** instead of **uniform**.
- Sets up Stage 8c — once layers are gated by recipe, adding the env-reaction layer to specific stages is one entry per stage.

**Risks**
- Refactoring `clearLines` view body without losing existing visual behavior. Keep the existing emitter calls; just MOVE them to the orchestrator and gate them by recipe — don't replace with new emitters yet.

### 9.2 — Stage 5b: Onset events + offline beat grid (~1.5 days)

The single most distinctive Tetris Effect feel still missing: anticipation. Live-only audio analysis can never deliver "the room responds *before* the beat" — it requires pre-analyzed BPM.

**Scope**
- `src/audio/reactive/onset.js`: spectral-flux per band, median-filter window, adaptive threshold, 60ms refractory. Emit discrete `onsets.kick`, `onsets.snare`, `onsets.generic` events on the FeatureBus event channel.
- Install `web-audio-beat-detector`. On BGM load, decode once into `AudioBuffer`, run BPM + downbeat detection, cache `{bpm, downbeatPhase, confidence}`.
- `src/audio/reactive/beat-grid.js`: project beat times, emit `beat-in-Δ` events 250ms ahead via `audioContext.currentTime` lookahead.
- 2–3 anticipatory bindings in [`bindings.js`](../project/src/vfx/reactive/bindings.js): ramp ambient particle emission rate up over the 200ms before predicted beats; gentle bloom-strength climb; sparkle pre-warm.
- Show beat markers + onset firings on the F-key debug overlay.

**Why this matters**
- Currently, audio reactivity is *reactive* — bloom pops AFTER the kick lands, not before. The Tetris Effect signature is the *opposite* (visuals lead the audio by ~250ms). This requires the offline beat grid; no shortcut.

### 9.3 — Stage 4: Curl-noise particles (~1.5 days)

Particles still drift sinusoidally per the existing `ambient.vert.glsl`. Curl noise is the canonical "Tetris Effect particle motion" technique.

**Scope**
- `src/vfx/curl-noise.js`: bake a 128³ RGBA8 3D texture of curl noise at boot (~500ms one-time cost). Rejection-sample 3 scalar Perlin/simplex offsets per voxel, take partial differences for curl.
- Modify `ambient.vert.glsl` to sample `texture(uCurl, position * uCurlScale)` and add the result × `uFlowSpeed * dt` to position.
- Add `bindings.js` entry: `bands.lowMid.norm → uFlowSpeed` (range 0.6 → 1.4) — particles flow faster on instrumental energy.
- Will be reused by Stage 9's GPU sim (same noise texture, same sampling pattern).

**Why this matters**
- Sinusoidal motion looks scripted; curl-noise reads as fluid. Per `plan_particle_1.md` §1.1: "curl noise is the canonical pattern; the eye sees flow, not points."

### 9.4 — Stage 7: Refraction + bass-driven edges (~1 day)

Cubes currently look like resin (matte under emissive lift). Refraction makes them read as glass.

**Scope**
- Add `tBackground` sampler uniform on the glass shader. Bind it to a render target storing the post-opaque pre-transparent scene.
- In `glass.frag.glsl`: sample `tBackground` at UV offset by `cross(viewDir, normal).xy * uRefractionAmount`. Mix with base color weighted by `1 - fres`.
- Add `bands.bass.norm → uEdgeIntensity` binding (range 0.7 → 1.1) for active piece — already commented out in [`bindings.js`](../project/src/vfx/reactive/bindings.js); just uncomment with a target.

**Risks**
- Refraction needs a background-buffer render pass before the transparent pass. Requires a small refactor of the render loop (extract a "render opaque scene to background buffer" step). Doable but care needed.

### 9.5 — Stage 8c: env-reaction (one stage, then content) (~1 day)

After 8b, add the §1.6 layer 7 — environment reactions outside the case.

**Scope**
- Pick **one** stage to demonstrate. Recommend `aurora` → vertical green light streaks shoot up from the cleared rows past the case top on Tetris+. Cheapest and most visible.
- `src/vfx/emitters/env-reaction.js`: instanced thin quads, additive, lifetime ~1s, animated upward velocity, stage-accent color.
- Recipe gate: only fire when `stage.clearRecipe[tier].envReaction === true` (extend the recipe shape).
- Future: per-stage env reactions (water ripple for sea, sand kick for desert) — content work.

### 9.6 — Stage 6 fog + Stage 10 distant structure (~1 day, both)

Polish layer. Both small.
- Add `scene.fog = new THREE.FogExp2(...)` and modify glass + particle shaders to multiply outgoing color by `exp(-z * density)` factor in fragment. Vertical bias optional.
- Stage 10 distant structure: 4–6 low-poly silhouette meshes (asteroids, planets) at radius 60–80, parented to a slowly rotating group. Emissive material with a slight bass-modulated brightness.

### 9.7 — Stage 3: Particle layers (~1 day, low priority)

Marginal vs the items above until Stage 9 makes density affordable. Defer until after 8b/5b/4 land.

### 9.8 — Stage 9: GPU particle sim (~2 days, architectural)

Move ambient + sparkle pools from CPU integration to GPU-resident FBO ping-pong. Unlocks 30k+ particle counts; saves ~3ms CPU/frame at current counts. Only worth doing once the visible content stages above are done — without 4+8b, you'd have 30k particles of *nothing in particular*.

### 9.9 — Recommended landing order

If shipping all of 9.1–9.8 sequentially:

1. **Stage 8b** (1.5 days) — biggest perceived lift, lowest architectural risk
2. **Stage 5b** (1.5 days) — unlocks the anticipation property; required for 8b's beat-quantized scheduling to be more than "fire on lock"
3. **Stage 4** (1.5 days) — visible motion-language change
4. **Stage 7** (1 day) — glass becomes glass
5. **Stage 8c env-reaction** (1 day) — first peripheral spectacle
6. **Stage 6 fog + Stage 10 distant** (1 day combined) — polish
7. **Stage 3** (1 day) — depth layers
8. **Stage 9** (2 days) — GPU sim if particle counts ever justify it

**Total remaining: ~10.5 days** (matches the §8 figure within rounding).

### 9.10 — Two architectural items to track separately

These aren't stages but should land alongside future work:

- **`qualityScalar` LOD knob.** Single 0..1 multiplier scaling per-system particle counts, post-chain depth, mobile DPR. Add when Stage 9 lands; useful enough that an MVP version (`bindings.js`-style table mapping `qualityScalar → various uniforms`) could land sooner.
- **Per-system frame-time budget HUD.** Profile-during-development tool. Build into the F-key overlay or a new G-key one. Without this, mobile soak testing is guesswork.

---

## 10. Final Word

Half the difficulty of "make it feel like Tetris Effect" is *restraint*: not putting motion blur and DoF on, not bumping bloom strength to 1.5, not cranking sparkle counts to 10k, not letting CA stack with after-image without tuning. The bones in this plan are conservative for that reason.

The other half is *coherence*: bands drive different layers at different speeds, hue stays disciplined, fragments-vs-sparkle obey color rules, anticipation runs ahead of beats. Coherence is craft — not throughput. A 5k-particle scene that follows the rules looks better than a 50k-particle scene that doesn't.

Build the systems straight. Tune them ruthlessly. Don't add anything not in this plan until the existing layers ship green.

---

*End of document.*
