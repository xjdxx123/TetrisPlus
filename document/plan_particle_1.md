# Particle Engine Architecture — Tetris Effect Style on the Web

**Document type:** Technical analysis & implementation plan
**Target:** Browser-based 3D puzzle game (TetrisPlus)
**Scope:** Recreate the *feel* and *visual language* of Tetris Effect particle systems on the modern web, not a literal clone.
**Author:** Graphics architecture working document

---

## SECTION 1 — VISUAL ANALYSIS

### 1.1 What makes Tetris Effect's particle work feel "alive"

Tetris Effect's particle work is not impressive because of raw count. It is impressive because of **coherence**: every particle's birth, motion, and death is tied to either (a) the music's structure or (b) gameplay state changes that have already been visually anticipated by the environment. Nothing is random in the perceptual sense — even the noise is band-limited.

Three axes drive the feel:

1. **Motion language.** Almost no particle moves in a straight ballistic arc. The dominant motion is a **drifting curl-noise field** modulated by per-particle phase offsets. Particles inherit a direction from a shared vector field, then layer on a low-frequency oscillation that visually resembles "breathing." This is how 5,000 particles can read as one organism instead of 5,000 dots.
2. **Density layering.** There are typically 3–5 simultaneous particle layers running at very different scales: a near-camera dust haze (small, fast, motion-blurred), a mid-field flow ribbon (medium, additive, hue-shifting), a far-field sky/ambient field (huge, slow, often parallax-like), plus event-triggered explosions that cut across all layers.
3. **Timing discipline.** Spawn rates are quantized to musical subdivisions (typically 1/4, 1/8, 1/16 notes). Particle lifetimes are tuned so that the *visual envelope* of a burst (attack/sustain/release) lines up with the *audio envelope* of the sound it is paired with. This is what makes the effects feel choreographed rather than triggered.

### 1.2 Particle category taxonomy

Every effect in the game can be classified into one of these categories. Each category needs a different simulation, different shader, and different performance budget.

| Category | Density | Lifetime | Sim domain | Blend | Drives |
|----------|---------|----------|------------|-------|--------|
| **Ambient environmental** | 5k–50k | 5–30s | World-space | Additive | Scene mood |
| **Line-clear explosion** | 500–3k per event | 0.4–1.5s | World-space (board-local) | Additive + emissive | Gameplay reward |
| **Beat-synced pulse** | 100–500 per beat | 0.2–0.6s | Camera-space ring | Additive | Music feel |
| **Flowing ribbons** | 200–1000 segments | 2–8s | Vector-field-driven | Additive, soft | Continuity |
| **Voxel fragments** | 64–256 per piece | 1–3s | Rigid-body-lite | Opaque + emissive | Tactile feedback |
| **Dust / sparkle** | 1k–5k | 1–4s | Camera-space | Additive | Polish |
| **Shockwaves** | 1 per event | 0.3–0.8s | Single quad | Additive + distortion | Impact |
| **Volumetric energy fields** | Volumetric/fragment | Persistent | Screen-space raymarched | Additive | Atmosphere |
| **UI-reactive particles** | 50–500 | 0.2–1s | Screen-space (NDC) | Premultiplied | Feedback |
| **Camera-space veil** | 100–1000 | Persistent | Camera-locked | Additive | Lens feel |
| **Background atmospherics** | Procedural / sky | Persistent | Skybox / volumetric | Per-shader | World scale |

### 1.3 Why the result reads as immersive instead of chaotic

Five forces stop the screen from becoming visual noise:

- **Hue discipline.** Most layers stay within a 30–60° arc on the color wheel for any given level, with one accent hue used sparingly for events. Bloom amplifies whatever hue dominates, so wild palettes become muddy white quickly — the game avoids this by anchoring the palette per stage.
- **Vector field coherence.** Particles in the same scene share the same low-frequency curl/flow field. This *implicitly* groups them: the eye sees flow, not points.
- **Attention budgeting.** When a high-priority event fires (line clear, T-spin, level transition), the ambient layer's emission temporarily dims. The system *makes room* for the event particles. This is the single biggest contributor to "polish."
- **Soft edges everywhere.** Almost no particle in Tetris Effect has a hard edge. Soft-particle depth fade + radial alpha falloff + bloom absorbs aliasing and lets density rise without breaking up.
- **Temporal smoothing.** Camera and bloom both have noticeable temporal accumulation. Without it the bloom would strobe with the beat instead of glow.

### 1.4 How particles guide attention

Tetris Effect uses particle systems as a **gaze director**, not just decoration:

- **Spawn-toward-board.** During gameplay, a slow inward flow field pulls ambient particles toward the playfield. The eye follows flow, so the playfield gets free attention.
- **Anti-attention zones.** Edges of the screen get *less* particle density, not more, to keep the player's gaze centered.
- **Event signaling.** The frame *before* a major beat, particle emission rates ramp anticipatorily. This is a learned animation principle (anticipation → action → follow-through) applied to VFX.
- **Color signaling.** Hue shifts forecast level transitions. The audio arrives last; the visual particles arrive first by ~250–500 ms.

### 1.5 Likely rendering techniques (inferred)

This is informed inference based on what is achievable on PS4/PS5/PC at 60–120 FPS with this density and what the visual artifacts suggest:

- **GPU-resident simulation.** Position/velocity/age stored in floating-point textures or storage buffers. CPU never touches per-particle state on the hot path.
- **Compute-driven curl noise.** Simplex/Perlin gradient noise sampled at multiple octaves to drive a divergence-free flow field. This is the signature look of the ambient layer.
- **Instanced quad rendering** with sorted-back-to-front transparency for the rare cases that need it; everything else is additive and order-independent.
- **Depth-aware soft particles.** Alpha falloff against scene depth to prevent hard intersections with geometry.
- **Bloom with multiple downsample-upsample passes** (Kawase or COD-style dual filter), threshold lowered far below 1.0 — most "glow" is sub-1.0 emission, not blown highlights.
- **Velocity-buffer motion blur**, at least camera-space, possibly per-particle.
- **Volumetric fog / god rays** for energy fields — likely raymarched at half-res into a quarter-res buffer and upsampled with a depth-aware bilateral filter.
- **Temporal accumulation** for bloom and reflections to stabilize frame-to-frame variance.
- **SDFs for shape control.** Shockwave rings, energy fields, and some UI elements look SDF-driven — antialiasing is too clean for plain textures.
- **Vector fields baked or sampled live.** Static field textures for stages where flow is choreographed; live curl noise for stages that need responsiveness.
- **Probably no full PBR** for particles — emissive-only with cheap rim/Fresnel approximations is cheaper and reads better at this density.

---

## SECTION 2 — FEASIBILITY ON THE WEB

### 2.1 Honest assessment

The full Tetris Effect look is **not 1:1 reproducible** in the browser today. The console version targets fixed hardware with predictable bandwidth. Web targets a distribution including 5-year-old integrated GPUs and battery-throttled mobile silicon. We must redesign rather than port.

What *is* reproducible is the **perceptual identity** — flow, rhythm, glow, choreography. These are art-direction properties, not raw-throughput properties.

### 2.2 WebGL2 limitations

| Limitation | Impact |
|------------|--------|
| No compute shaders | GPU simulation must use transform feedback or ping-pong texture rendering — both work but waste fillrate and bandwidth. |
| Limited storage formats | RGBA16F/RGBA32F supported but bandwidth-heavy; integer atomics absent. |
| No indirect draw | Particle counts must be CPU-known per frame; can't have GPU decide draw count. |
| No bindless / no SSBO | Forces packing state into textures; awkward for variable-size data. |
| Single render thread | Main thread compositing pressure on Chrome/Safari. |
| No timestamp queries (mostly) | Profiling on GPU is approximate. |

WebGL2 can absolutely deliver a beautiful Tetris Effect-adjacent look. It just requires conservative architecture.

### 2.3 WebGPU advantages

| Capability | Benefit |
|------------|---------|
| Compute shaders | Native GPU particle simulation, sort, cull. Cleaner code, lower overhead. |
| Storage buffers | Variable-length particle arrays without texture-packing tricks. |
| Indirect draw + indirect dispatch | GPU decides what to render; lets emission rates scale dynamically. |
| Better pipeline state management | Lower per-draw CPU overhead, important for many small effects. |
| Timestamp queries | Real GPU profiling. |
| Better mobile story (Vulkan/Metal under the hood) | Long-term performance ceiling is higher. |

WebGPU is the right target for this project's lifecycle. Browser support as of 2026 is good on Chrome/Edge/Arc/Brave; Safari shipped, Firefox shipping. A WebGL2 fallback is still wise for ~10–15% of users.

### 2.4 Bottlenecks specific to a browser puzzle game

- **Transparency overdraw** is the single biggest cost. 5k additive quads, each covering 100×100 pixels, at 1080p, is 50M shaded fragments per frame just for one layer. Mitigation: tighter quad sizes, lower-resolution offscreen buffers for ambient layers, and aggressive depth-rejection where possible.
- **Bloom bandwidth.** A naive bloom on a 1440p HDR buffer is ~90 MB/frame of bandwidth. Use half-res HDR, dual-filter bloom (5–6 levels), and avoid full-res threshold passes.
- **CPU-GPU sync stalls** if you use `getBufferSubData` or readback. Never do it on the hot path. Pre-allocate, never resize buffers per-frame.
- **Mobile thermal throttling.** A device that hits 60 FPS in benchmark may drop to 30 after 4 minutes. Plan for *sustained* perf, not peak.
- **Memory bandwidth on integrated GPUs.** Intel Iris / Apple M1 base have ~50–80 GB/s shared with the CPU. Floating-point textures eat bandwidth. Pack aggressively (RGBA16F, not 32F, for particle state when precision allows).

### 2.5 What is practical / approximated / redesigned

| Effect | Verdict | Web approach |
|--------|---------|--------------|
| Curl-noise ambient drift | **Practical** | Compute or fragment shader, 10k–50k particles fine |
| Line-clear explosions | **Practical** | GPU-instanced burst pool, 2k particles per event |
| Beat-synced pulses | **Practical** | Trivial; CPU triggers, GPU draws |
| Ribbon / trail systems | **Practical** | Trail-strip geometry from history buffer |
| Voxel fragmentation | **Practical** | Up to ~256 instanced cubes per piece |
| Volumetric energy fields | **Approximate** | Half-res raymarched SDF, 16–32 steps max |
| Volumetric god rays | **Approximate** | Screen-space radial blur from light source instead of true volumetrics |
| True per-particle motion blur | **Approximate** | Camera-velocity buffer only, not per-particle |
| Per-particle depth-of-field bokeh | **Redesign** | Fake with size + alpha modulation by depth |
| Ground reflection probes | **Redesign** | Planar reflection on a single plane only |
| Screen-space global illumination | **Skip** | Bloom + emissive does enough work |

### 2.6 Stack comparison

| Stack | Strengths | Weaknesses | Verdict for this project |
|-------|-----------|------------|--------------------------|
| **Three.js** | Mature, huge ecosystem, postprocessing.js, instancing, full materials, good docs | Large bundle, scene-graph overhead, custom shaders require digging | **Recommended** for v1. Best velocity-to-quality ratio. |
| **React Three Fiber** | Declarative, great DX, easy state-driven scenes | React reconciliation overhead in tight loops; not ideal for 50k particles unless you escape to imperative | Use only if the rest of the app is React. Imperative `useFrame` for hot paths. |
| **Raw WebGL2** | Maximum control, smallest bundle | Months of plumbing for what Three.js gives free | Reject — not worth the time cost for one developer. |
| **Babylon.js** | Strong PBR, built-in particle systems, good editor | Particle system not as flexible as custom; community smaller for shader work | Reasonable alternative; slightly worse for highly custom VFX. |
| **WebGPU-first frameworks (TSL via Three.js r160+, three-gpu-pathtracer, hwoa-rang-gpu)** | Future-proof, compute-native | Less mature, fewer examples, faster API churn | Adopt the WebGPU path *inside* Three.js (TSL / WebGPURenderer) rather than a separate framework. |

**Recommendation.** Three.js with WebGPURenderer (TSL nodes for shaders), with a hand-written postprocessing chain rather than `EffectComposer` defaults, and an imperative particle manager outside the scene graph.

---

## SECTION 3 — PARTICLE SYSTEM ARCHITECTURE

### 3.1 Render loop structure

```
frame():
  ├── audio.tick()              // FFT, beat detection, smoothed bands
  ├── input.tick()
  ├── game.update(dt)           // gameplay state → events
  ├── eventBus.flush()          // gameplay → VFX events
  ├── particleManager.update(dt, audio, events)
  │     ├── emitters.tick()     // CPU-side spawn decisions
  │     ├── gpuSim.dispatch()   // compute pass, all systems
  │     └── lod.evaluate()      // adjust active counts
  ├── renderer.renderScene()    // main color + depth (HDR, half-res optional)
  ├── postFX.run()              // bloom, motion blur, CA, tonemap
  └── compositor.present()
```

Two principles:

- **Audio updates first.** Visuals derive from audio state, never vice versa. This keeps frames audio-aligned even under CPU jitter.
- **Particle simulation is GPU work, not main-thread work.** The CPU's only job is emission decisions and parameter updates.

### 3.2 Particle manager architecture

```
ParticleManager
├── Systems[]                      // each is a self-contained simulation+render
│   ├── AmbientCurlSystem
│   ├── LineClearBurstSystem
│   ├── BeatPulseSystem
│   ├── RibbonSystem
│   ├── VoxelFragmentSystem
│   ├── DustSparkleSystem
│   ├── ShockwaveSystem
│   ├── EnergyFieldSystem
│   ├── UIParticleSystem
│   └── BackgroundFieldSystem
├── SharedResources
│   ├── noiseTextures (3D curl, 2D vector field)
│   ├── particleAtlas (sprites)
│   ├── audioUniformBlock
│   └── frameUniformBlock
└── EventBus                        // gameplay → systems
```

Each `System` exposes:

```ts
interface ParticleSystem {
  init(device, sharedResources): void;
  capacity: number;                  // max live particles
  liveCount: number;                 // current
  budgetPriority: number;            // for LOD downscaling
  onEvent(event): void;              // line clear, beat, etc.
  update(dt, audio): void;           // CPU-side; queues GPU work
  recordSimPass(pass): void;
  recordRenderPass(pass, camera): void;
}
```

### 3.3 GPU simulation pipeline

Use **double-buffered storage buffers** (or ping-pong textures on WebGL2) holding particle state:

```
struct Particle {
  vec3 position;
  float age;
  vec3 velocity;
  float lifetime;
  vec4 color;       // packed rgba
  vec2 size;        // x current, y birth
  uint flags;       // emitter id, layer, sub-effect
  uint seed;
}
```

Per-frame:

1. **Emission compute pass.** Reads CPU-staged spawn requests; writes new particles into free slots. Slot allocation via an atomic free-list head, or simpler: fixed ring buffer per system, oldest gets overwritten.
2. **Simulation compute pass.** Per-particle: integrate velocity, sample curl noise, apply forces, age, kill.
3. **(Optional) Sort pass.** Only for the few systems that need back-to-front transparency (rare — additive doesn't need it).
4. **Render pass.** Indirect-drawn instanced quads, billboarded in vertex shader.

On WebGL2 fallback: replace 1–3 with transform feedback or fragment-shader writes into floating-point render targets, ping-ponged.

### 3.4 Effect layering and render order

Render order matters as much as the simulation:

```
1. Skybox / background atmospheric        (opaque, depth-write)
2. Background field particles             (additive, depth-test, no depth-write)
3. Opaque scene geometry                  (board, pieces)
4. Voxel fragments (opaque emissive)
5. Ambient particles                      (additive, soft-particle)
6. Ribbons                                (additive, depth-test)
7. Line-clear bursts                      (additive, brightest)
8. Shockwaves                             (additive + distortion uniforms)
9. Camera-space veil                      (additive, no depth-test)
10. UI-space particles                    (after main 3D, before HUD)
11. Postprocessing chain
12. HUD / 2D UI                           (sharp, no bloom contamination)
```

Two non-obvious rules:
- **HUD is composited after postprocessing.** Otherwise UI text gets bloomed into mush.
- **Camera-space veil is between world particles and post.** It needs to be in the HDR buffer to bloom correctly, but should ignore world depth.

### 3.5 ECS vs scene graph

Three.js is scene-graph by default. For 50k particles, **do not put them in the scene graph**. Each system should be a single `Object3D` whose `onBeforeRender` swaps in custom buffers and issues an instanced draw. The scene graph is for the board, pieces, and lights — not VFX.

A lightweight ECS-style record of *emitters* (not particles) is useful: emitter id, layer, parameters, lifetime. A few hundred emitter records is fine on the CPU. Particles themselves stay GPU-only.

### 3.6 Memory management

- **Pre-allocate everything at init.** No per-frame allocations in the manager. No `new Float32Array(...)` inside `update()`.
- **Fixed pools per system.** A line-clear system with capacity 8,000 always owns 8,000 particle slots. Empty slots have `lifetime <= 0` and are skipped by sim and render.
- **Atlas textures, not per-system textures.** One sprite atlas (1024² or 2048²) for all simple sprite particles; samples with derived UVs.
- **Shared noise textures.** One 128³ curl noise volume at RGBA8 (~8 MB) is enough; sampled with smooth interpolation.

### 3.7 Batching, instancing, culling, LOD

- **Batching.** All systems with the same shader/material can be drawn in one instanced draw call. Most ambient layers can collapse into 2–3 draw calls total.
- **Instancing.** Always use `gl_InstanceID` (WebGL2) or `instance_index` (WGSL) to fetch state — never use vertex attributes per particle.
- **Frustum culling.** Cheap on the GPU: kill in vertex shader if outside clip space (set `gl_Position.w = -1`). Don't try CPU-side AABB culling for particles — costs more than it saves.
- **LOD.** Each system has a `budgetPriority`. The manager scales `liveCount` per system based on a global `qualityScalar` (0.25 → 1.0). High-priority systems (line-clear) keep full count even on low quality. Low-priority systems (ambient sparkles) are first to shrink.

---

## SECTION 4 — AUDIO REACTIVE DESIGN

### 4.1 Why naive FFT mapping fails

Wiring an FFT bin directly to a particle parameter looks bad. Reasons:

1. **Bin energy is noisy.** Adjacent frames vary 10–20% even on a sustained tone.
2. **Logarithmic perception.** Linear bin energy doesn't match what we hear.
3. **Beat and energy are not the same.** A sustained pad has high energy but no beat.
4. **No emotional alignment.** A drop should feel like a drop, not a graph.

The system needs a **layered signal chain**, not raw FFT.

### 4.2 Signal flow

```
PCM (AudioContext)
  │
  ├── AnalyserNode (FFT, 2048 bins)
  │     │
  │     ├── Band integrator → bass, lowMid, mid, highMid, high (5 bands)
  │     │     └── A-weighted, log-scaled, per-band exponential smoothing
  │     │
  │     ├── Onset detector (spectral flux) → transient pulses
  │     │     └── median filter → adaptive threshold → onset events
  │     │
  │     └── Loudness (RMS over 50ms window) → overall energy
  │
  ├── Tempo tracker (onset autocorrelation) → BPM, phase
  │     └── PLL / Kalman → predicted next-beat time
  │
  └── State features
        ├── energyLong (5s EMA)
        ├── energyShort (300ms EMA)
        ├── novelty = energyShort − energyLong  // for build/drop detection
        └── musicalPhase = beats elapsed % 16   // for cinematic timing
```

### 4.3 Mapping audio features to visual systems

| Audio feature | Drives | Mapping notes |
|---------------|--------|---------------|
| **Bass** (smoothed, 0–200Hz) | Bloom intensity, camera shake, energy field thickness | Hard-clip, then EMA τ=120ms |
| **Low-mids** | Ambient particle emission rate | Multiplicative on baseline |
| **Mids** | Ribbon flow speed, hue rotation rate | Map nonlinearly (`pow(x, 0.7)`) |
| **High-mids** | Sparkle spawn rate | Higher threshold; only fire over baseline |
| **Highs** | Dust shimmer, chromatic aberration | Subtle, EMA τ=80ms |
| **Onsets** | Beat pulse spawn, shockwave events | One-shot triggers |
| **Predicted beat** | Anticipatory ramp on emission rates | Lerp emission up over the 200ms before predicted beat |
| **Novelty (drop detection)** | Cinematic event particles, palette shift | Threshold + cooldown |
| **Musical phase (mod 16)** | Skybox transitions, level animation | Lined up with phrase boundaries |

### 4.4 Smoothing and emotional timing

Two smoothing tiers:

- **Fast tier (8–80ms):** for sparkle, chromatic aberration, anything that should "pop" with the music. Use exponential moving average.
- **Slow tier (300ms–2s):** for bloom intensity, hue rotation, camera FOV breathing, fog density. These should feel like the room responding, not the snare.

Crucially: **anticipation.** Use the predicted beat time to start ramping particle emission ~150–250ms before the beat lands. This is what separates "reactive" from "synced."

### 4.5 Pseudocode

```ts
class AudioReactor {
  bands = { bass: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 };
  bandsSlow = { ...this.bands };
  onsets: Onset[] = [];
  beat = { bpm: 120, phase: 0, nextBeatTime: 0, confidence: 0 };
  novelty = 0;

  tick(now: number) {
    const spectrum = this.analyser.getFrequencyData(); // Uint8 -> Float
    const log = toLogScale(spectrum);

    // 1. Bands
    for (const b of BANDS) {
      const raw = integrate(log, b.lo, b.hi);
      this.bands[b.name] = ema(this.bands[b.name], raw, b.tauFast);
      this.bandsSlow[b.name] = ema(this.bandsSlow[b.name], raw, b.tauSlow);
    }

    // 2. Onsets via spectral flux
    const flux = positiveFlux(log, this.prevLog);
    this.fluxHistory.push(flux);
    const threshold = median(this.fluxHistory) * 1.5;
    if (flux > threshold && now - this.lastOnset > 80) {
      this.onsets.push({ t: now, strength: flux / threshold });
      this.lastOnset = now;
    }

    // 3. Tempo tracker
    this.beat = this.tempoTracker.update(this.onsets, now);

    // 4. Novelty
    const eShort = ema(this.eShort, this.bands.bass + this.bands.mid, 0.3);
    const eLong = ema(this.eLong, eShort, 5.0);
    this.novelty = Math.max(0, eShort - eLong);

    this.prevLog = log;
  }

  // For VFX consumers
  emissionMultiplier(layer: Layer): number {
    const beatAnticipation = anticipationRamp(this.beat.nextBeatTime - now, 200);
    switch (layer) {
      case 'ambient': return 0.6 + 0.8 * this.bandsSlow.lowMid;
      case 'sparkle': return 0.3 + 1.4 * this.bands.highMid + beatAnticipation;
      case 'pulse':   return this.onsets.length > 0 ? this.onsets[0].strength : 0;
      // ...
    }
  }
}
```

### 4.6 Architecture recommendations

- Run audio analysis in an `AudioWorklet` if you need <5ms latency; otherwise the main thread `AnalyserNode` is fine for a puzzle game.
- The audio reactor publishes a **single uniform block** updated once per frame. All shaders read the same uniform block. Don't pass audio data through 8 different uniforms.
- Decouple: the audio reactor doesn't know what visuals exist. Visual systems pull the features they want.

---

## SECTION 5 — SHADER AND POST FX PLAN

### 5.1 Particle shader architecture

A single über-shader is wrong for this project; per-category specialization wins. But there are three reusable building blocks:

- **`particle_billboard.vs`** — vertex shader that handles instancing, billboarding modes (camera-aligned, velocity-aligned, fixed), and size animation curves.
- **`particle_soft.fs`** — fragment shader with depth-aware soft falloff, radial alpha, additive output, optional atlas sampling.
- **`particle_distort.fs`** — for shockwaves; outputs to a separate distortion target sampled in post.

Each system composes from these or specializes (ribbons need a strip vertex shader, voxels need full mesh shaders).

### 5.2 Post-processing chain

```
HDR scene buffer (RGBA16F, half-res for ambient pass / full-res for main)
  │
  ├── 1. Distortion apply (sample distortion target, offset main UVs)
  ├── 2. Bloom
  │      ├── Threshold (soft knee, threshold ≈ 0.7)
  │      ├── Downsample chain (5–6 levels, dual-filter blur)
  │      ├── Upsample chain with additive accumulate
  │      └── Composite onto main with intensity controlled by audio
  ├── 3. Camera motion blur (velocity buffer, 8–12 taps max)
  ├── 4. Chromatic aberration (radial offset, audio-modulated)
  ├── 5. Lens distortion (mild barrel, screen-edge only)
  ├── 6. Vignette
  ├── 7. Tonemap (ACES or AGX; AGX preferred for saturated palettes)
  ├── 8. Color grading LUT (per stage)
  └── 9. Dithering (1-bit triangular noise, prevents banding)
```

### 5.3 What should be real vs faked

| Effect | Real or fake | Reasoning |
|--------|--------------|-----------|
| Bloom | **Real** (multi-pass) | Defines the look; cannot be faked |
| Volumetric god rays | **Faked** (radial blur from light center) | True volumetrics too costly |
| Volumetric fog | **Real but cheap** (depth-based exponential) | Trivial to compute, huge mood impact |
| Refraction (glass blocks) | **Real** (sample background buffer with offset) | One pass, reads great |
| Reflections | **Faked** (cubemap probe + planar plane) | SSR has too many failure cases |
| Motion blur | **Real** (camera velocity only) | Per-particle blur not worth cost |
| Chromatic aberration | **Faked** (UV offset per channel) | Real spectral CA isn't justified |
| Lens flare | **Faked** (sprite-based, screen-space) | Standard; cheap |
| Soft particle edges | **Real** (depth fade) | Required for density |
| Subsurface on voxels | **Faked** (cheap Fresnel-modulated emissive) | True SSS isn't readable at this scale |
| Ambient occlusion | **Skip or fake** (baked vertex AO) | SSAO cost not worth it given bloom dominance |

### 5.4 Overdraw minimization

- **Half-resolution buffer for ambient/background particles**, upsampled with a depth-aware filter into the full-res buffer. 4× fillrate savings.
- **Smaller quads.** Profile actual covered pixels per particle; oversize quads are the most common cause of fillrate disasters.
- **Discard early.** Soft-particle alpha < 0.01 → discard (or set color to 0 and let blend eat it; on tile-based GPUs, real `discard` can be slower — measure).
- **Sort large transparents front-to-back** when they're alpha-blended (rare here; additive doesn't care).
- **Bloom threshold at 0.6–0.8.** Lower threshold means the bloom upsample still finds energy without an HDR explosion.

### 5.5 Shader ordering rules

- **Distortion before bloom.** Bloom sees the distorted image, so distortion looks energetic, not pasted on.
- **Tonemap before LUT.** LUT is built for tonemapped color space.
- **Dither last.** After everything else, including LUT.

---

## SECTION 6 — PERFORMANCE ENGINEERING

### 6.1 Targets

| Target | Resolution | FPS | GPU class |
|--------|------------|-----|-----------|
| Desktop high | 1440p | 60 stable, 120 if available | RTX 3060+ / RX 6600+ / M2 Pro+ |
| Desktop mid | 1080p | 60 stable | GTX 1060 / RX 580 / M1 |
| Laptop low | 900p | 60 with degradation | Intel Iris Xe |
| Mobile high | 1080p (DPR 2 panel, render at 1.0×) | 60 | A15+, SD 8 Gen 1+ |
| Mobile mid | 720p render, upscale | 30–60 | A12, SD 855 |

### 6.2 Particle budgets per quality tier

| System | Low | Mid | High | Ultra |
|--------|-----|-----|------|-------|
| Ambient curl field | 4k | 12k | 30k | 60k |
| Line clear burst | 400 | 1k | 2k | 3k |
| Beat pulse | 64 | 200 | 400 | 600 |
| Ribbons | 50 | 200 | 500 | 1k |
| Voxel fragments | 64 | 128 | 256 | 384 |
| Dust / sparkle | 500 | 2k | 5k | 10k |
| Shockwaves | 1 | 1 | 2 | 4 (concurrent) |
| Energy fields | off | half-res, 8 steps | half-res, 16 steps | half-res, 24 steps |
| UI particles | 50 | 200 | 400 | 600 |

### 6.3 Strategies

- **Draw call reduction.** Target: under 80 draw calls/frame total. Each particle system: 1–3 calls.
- **GPU instancing always.** Never per-particle vertex buffers.
- **Texture atlases.** All sprite particles share one atlas. Ribbons share one tileable strip texture.
- **Sim frequency reduction.** Background field can simulate at 30 Hz even when rendering at 60. Interpolate position in the vertex shader.
- **Half-resolution rendering** for ambient layers; depth-aware bilateral upsample.
- **Dynamic resolution scaling.** Start at 1.0×; if frame time crosses 17ms for 1s, drop to 0.85×; recover slowly.
- **Aggressive uniform packing.** All audio + frame uniforms in one block, updated once.
- **Avoid Three.js material recompiles.** Defines + onBeforeCompile is a trap; prefer raw `ShaderMaterial`/`RawShaderMaterial` with stable defines.

### 6.4 Profiling and debugging

- **Stats.js** for FPS / frame time at minimum.
- **`spector.js`** browser extension for per-call GPU inspection in WebGL2. Indispensable for debugging draw order.
- **Chrome DevTools Performance panel** — flame graph for CPU-side stalls.
- **WebGPU timestamp queries** for per-pass GPU timings (Chrome flag).
- **In-engine HUD** showing: live particle counts per system, ms per pass (CPU), ms per pass (GPU when available), bloom buffer dims, dynamic res scale.
- **GPU debugging recommendation.** Build a "wireframe / overdraw / depth / system-id" visualizer toggle. Worth its weight in gold for tuning quad sizes and finding fillrate hotspots.

### 6.5 Graceful degradation

Quality is a single scalar 0..1 mapped to:
- particle counts (per-system multipliers)
- bloom resolution (full / half / quarter)
- volumetric step count
- motion blur on/off
- chromatic aberration on/off
- DPR cap
- post-FX LUT bypass on lowest

Auto-tune based on rolling 60-frame median frame time. Avoid panicked resolution changes — debounce 1s.

---

## SECTION 7 — IMPLEMENTATION ROADMAP

### Phase 1 — Minimal prototype (1 week)
**Goal.** Three.js scene with the existing Tetris board, a single black background, and one CPU-driven particle system (~500 sprites, additive billboard, basic bloom).
**Risks.** Underestimating Three.js postprocessing quirks.
**Quality.** Visible glow, no choreography.
**Complexity.** Low.
**Exit criteria.** 60 FPS at 1080p with 500 particles.

### Phase 2 — Simple particle systems (1 week)
**Goal.** Four systems: ambient drift (CPU), line-clear burst (CPU), beat pulse (CPU), dust. Integrate a basic FFT analyzer and band smoothing. Wire emission rate to bands.
**Risks.** CPU-side particle update becoming the bottleneck.
**Quality.** Reactive but limited density (~3k–5k total).
**Complexity.** Low–medium.
**Exit criteria.** Audio visibly drives particle density; gameplay events trigger bursts.

### Phase 3 — GPU instancing & GPU simulation (2 weeks)
**Goal.** Move ambient and burst systems to GPU simulation (transform feedback on WebGL2 path; compute on WebGPU path). Curl noise field added. Particle counts to 30k+.
**Risks.** Ping-pong texture state machine bugs; floating-point precision issues at high particle counts; double-buffering mistakes.
**Quality.** Big density jump; ambient layer reads as a flow.
**Complexity.** Medium–high.
**Exit criteria.** 30k particles at 60 FPS on a mid laptop.

### Phase 4 — Audio reactivity v2 (1 week)
**Goal.** Onset detection, tempo tracking, anticipation ramps, novelty/drop detection. Single audio uniform block. Per-stage palette tied to musical phase.
**Risks.** Tempo tracker instability on tracks with non-4/4 time.
**Quality.** Effects feel choreographed.
**Complexity.** Medium.
**Exit criteria.** Beat pulses land within ~30ms of audio onset; emission ramps anticipate beats.

### Phase 5 — Postprocessing chain (1.5 weeks)
**Goal.** Replace default postprocessing. Custom dual-filter bloom, motion blur, CA, lens distortion, vignette, AGX tonemap, LUT. Half-res ambient buffer + bilateral upsample.
**Risks.** Visual regressions vs. default Three.js bloom; LUT pipeline color issues.
**Quality.** Major polish jump.
**Complexity.** Medium–high.
**Exit criteria.** No banding; bloom under 2.5ms at 1080p; tonemap consistent across stages.

### Phase 6 — Advanced shaders (2 weeks)
**Goal.** Ribbons via history-buffer strips, shockwave SDF rings with distortion, soft-particle depth fade, voxel fragment system, energy fields (raymarched half-res), refraction on glass blocks.
**Risks.** SDF shader complexity, refraction read-back costs, ribbon vertex count.
**Quality.** Approaches the target aesthetic.
**Complexity.** High.
**Exit criteria.** All defined particle categories present; line clears feel impactful.

### Phase 7 — Cinematic systems & per-stage choreography (1.5 weeks)
**Goal.** Stage transitions, palette swaps tied to musical phrase boundaries, attention-budget arbiter (ambient dims when events fire), camera FOV breathing, anticipatory pre-beat ramps.
**Risks.** Choreography content scope creep.
**Quality.** Distinctive identity per stage.
**Complexity.** Medium (mostly content + tuning).
**Exit criteria.** At least 3 distinct stage moods; smooth transitions.

### Phase 8 — Optimization & QA (2 weeks)
**Goal.** Quality tiers, dynamic resolution, mobile pass, WebGL2 fallback verified, profiling HUD, soak testing for thermal throttling.
**Risks.** Mobile-specific shader bugs (precision, derivatives).
**Quality.** Stable across hardware.
**Complexity.** Medium.
**Exit criteria.** Targets in §6.1 met on representative hardware in 10-minute soak tests.

**Total:** ~12 weeks single-developer, with overlap.

---

## SECTION 8 — FINAL TECHNICAL RECOMMENDATION

### Stack
- **Renderer:** Three.js (latest), `WebGPURenderer` primary path, `WebGLRenderer` fallback. Shaders authored in TSL where reasonable, hand-written WGSL/GLSL for hot paths.
- **Particle simulation:** GPU compute (WGSL) on WebGPU; transform-feedback ping-pong on WebGL2 fallback.
- **Audio:** `AnalyserNode` for FFT; custom JS-side band integrator, onset detector, tempo tracker. `AudioWorklet` reserved for if perceptible latency emerges.
- **Postprocessing:** Custom passes; do not rely on `EffectComposer` defaults beyond Phase 1.
- **State:** Imperative `ParticleManager` outside the React/scene-graph layer; only the gameplay UI lives in React if React is used.
- **Build:** Vite, with shader hot-reload.

### Rendering approach
- HDR linear pipeline end-to-end (`RGBA16F`).
- Half-resolution ambient/background pass, depth-aware upsample.
- Full-res scene pass for board, pieces, line-clear bursts.
- Custom postprocessing in the order in §5.2.
- HUD composited *after* postprocessing.

### Is WebGPU worth adopting?
**Yes.** For a project shipping in 2026 with a multi-month build window, WebGPU is the right primary path. Compute shaders reduce simulation code size and CPU overhead meaningfully, and the performance ceiling on mobile is materially higher. Maintain a WebGL2 fallback for ~10–15% of users, but design the architecture WebGPU-first.

### Priority order for first impressions
If only a subset of effects can ship, ship in this order — these are the ones that buy the most "Tetris Effect feel" per hour of work:

1. **Bloom + HDR + AGX tonemap.** This single change dwarfs every other VFX in perceived quality.
2. **Curl-noise ambient drift, additive, hue-disciplined.** The signature flow.
3. **Line-clear bursts that anticipate the audio onset.** The "feel" moment.
4. **Beat-synced subtle camera FOV + bloom modulation.** Music-room mood.
5. **Soft particles + depth fade.** Removes the cheap edge.
6. **Per-stage palette + skybox transitions on phrase boundaries.** Identity.

The next tier (ribbons, energy fields, volumetric fog, voxel shatter, refraction) is where the project goes from "really good" to "rivals the source." Without items 1–6, none of those help.

### What can realistically rival Tetris Effect in a browser
With the stack and roadmap above, we can match Tetris Effect on:
- **Aesthetic identity** (palette, flow, glow, rhythm sync) — yes, fully.
- **Particle density** (10k–60k visible particles) — yes on desktop, scaled on mobile.
- **Choreography polish** (anticipation, attention budgeting, phrase-aligned transitions) — yes; this is craft, not horsepower.
- **Cinematic post-processing** (bloom, CA, motion blur, tonemapping, dithering) — yes, indistinguishable at viewing distance.

We will not match Tetris Effect on:
- **True per-particle motion blur and DOF.** Faked acceptably.
- **High-fidelity volumetrics.** Faked acceptably.
- **PSVR-style stereoscopic immersion.** Out of scope.
- **Sustained 4K/120 on integrated GPUs.** Hardware-bound.

The art-direction ceiling, not the rendering ceiling, will be the binding constraint. Build the systems above, then spend the back half of the schedule tuning rather than adding.

---

*End of document.*
