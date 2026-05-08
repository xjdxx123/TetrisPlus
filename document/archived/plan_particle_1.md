# Particle Engine Architecture — Tetris Effect Style on the Web

**Document type:** Technical analysis & implementation plan (revision 2)
**Target:** Browser-based 3D puzzle game (TetrisPlus)
**Scope:** Recreate the *feel* and *visual language* of Tetris Effect particle systems on the modern web, not a literal clone.
**Author:** Graphics architecture working document

---

## Status

| Phase | Status | Notes |
|-------|--------|-------|
| Phase 1 — Minimal prototype | **✅ Implemented** | `ambientField` (500 CPU sprites, additive billboard) wired into the existing Three.js + UnrealBloomPass scene. |
| Phase 2 — Simple particle systems | **✅ Implemented (starter quality)** | `dustField` (1000 capacity, energy-modulated active count), `burstPool` (3000-particle shared additive pool with free-slot allocator), `emitLineClearBurst` (200/row, HDR-boosted block color), `emitBeatPulse` (50–140 violet ring on onsets). The line-clear emitter is **single-layer**: fragments, sparkle, and flash are blended into one pool. §1.6 documents the layered structure Tetris Effect actually uses; Phase 7 unbundles this emitter into a `LineClearOrchestrator` driving distinct fragment / sparkle / shockwave / ribbon / flash / env-reaction systems. |
| Phase 3 — Audio analysis foundation | **✅ Implemented** | BGM routed through `MediaElementSource → bgmGain → AnalyserNode (fft 1024)`. `FeatureBus` with 6 log-spaced bands, asymmetric envelope followers (τ_a 5–12 ms / τ_r 60–220 ms), running-peak AGC normalizer, RMS + novelty. `BeatGrid` with live IOI-median tempo fitting (folded to 80–180 BPM) + downbeat anchor + `anticipationRamp(t, window)`. Adaptive-threshold spectral-flux onset detector classifies kick / snare / generic. Toggleable strip-chart debug overlay (F key). **Deferred to later phases**: offline `web-audio-beat-detector` pre-analysis (live IOI fitting carries us for a single-track BGM), Meyda integration (rolled-our-own DSP avoids the dep). |
| Phase 4 onward | Not started | See revised roadmap in §7. |

**The biggest revision in rev 2** was promoting audio analysis ahead of GPU simulation. **Rev 3** (this rev) is the line-clear effect anatomy in §1.6 — researching what Tetris Effect actually does on a clear changed our model from "one big additive burst" to "five-to-seven distinct layers stacked under disciplined color rules and a macro/micro placement principle." Phase 2's single-pool starter still works, but Phase 7 now owns the unbundling work.

---

## SECTION 1 — VISUAL ANALYSIS

### 1.1 What makes Tetris Effect's particle work feel "alive"

Tetris Effect's particle work is impressive because of **coherence**, not raw count. Every particle's birth, motion, and death is tied to either (a) the music's structure or (b) gameplay state changes that have already been visually anticipated by the environment. Nothing is random in the perceptual sense — even the noise is band-limited.

Three axes drive the feel:

1. **Motion language.** Almost no particle moves in a straight ballistic arc. The dominant motion is a **drifting curl-noise field** modulated by per-particle phase offsets. Particles inherit a direction from a shared vector field, then layer on a low-frequency oscillation that visually resembles "breathing." This is how 5,000 particles can read as one organism instead of 5,000 dots.
2. **Density layering.** There are typically 3–5 simultaneous particle layers running at very different scales: a near-camera dust haze (small, fast, motion-blurred), a mid-field flow ribbon (medium, additive, hue-shifting), a far-field sky/ambient field (huge, slow, often parallax-like), plus event-triggered explosions that cut across all layers.
3. **Timing discipline.** Spawn rates are quantized to musical subdivisions (typically 1/4, 1/8, 1/16 notes). Particle lifetimes are tuned so that the *visual envelope* of a burst (attack/sustain/release) lines up with the *audio envelope* of the sound it is paired with. The choreography is largely **scripted to the track**, not detected live — see §4 for why this matters for our architecture.

### 1.2 Particle category taxonomy

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

- **Hue discipline.** Most layers stay within a 30–60° arc on the color wheel for any given level, with one accent hue used sparingly for events. Bloom amplifies whatever hue dominates, so wild palettes turn muddy white quickly — Tetris Effect avoids this by anchoring the palette per stage.
- **Vector field coherence.** Particles in the same scene share the same low-frequency curl/flow field. The eye sees flow, not points.
- **Attention budgeting.** When a high-priority event fires (line clear, T-spin, level transition), the ambient layer's emission temporarily dims. The system *makes room* for the event. This is the single biggest contributor to "polish."
- **Soft edges everywhere.** Almost no particle has a hard edge. Soft-particle depth fade + radial alpha falloff + bloom absorbs aliasing.
- **Temporal smoothing.** Camera and bloom both have noticeable temporal accumulation. Without it the bloom would strobe with the beat instead of glow.
- **Macro/micro synesthesia.** Mizuguchi's design rule, articulated in interviews and analyses: keep the *interior* of the playfield restrained, push spectacle to the *periphery* (the case, the surrounding stage). Per-cell shatter stays modest (~4–8 shards/cell, not hundreds); the loud emissive work — flashes, shockwaves, environment reactions — happens around the case where it can't compete with reading the next piece. This is what lets density rise without breaking gameplay legibility.

### 1.4 How particles guide attention

- **Spawn-toward-board.** A slow inward flow field pulls ambient particles toward the playfield. Eye follows flow, board gets free attention.
- **Anti-attention zones.** Edges of the screen get *less* particle density, not more.
- **Event signaling.** The frame *before* a major beat, particle emission rates ramp anticipatorily — the audio arrives last; the visual particles arrive first by ~250–500 ms. This requires a pre-analyzed beat grid; you cannot get this from live onset detection alone. **Note (rev 3):** anticipation applies to the *ambient* layer; line-clear effects themselves are reactive, not predictive — the *peak* of the clear (flash + shockwave) appears to be quantized to the nearest beat, but the row-removal is immediate so gameplay isn't laggy.
- **Color signaling.** Hue shifts forecast level transitions.
- **Audio-first authoring.** Per the Hydelic interview, Tetris Effect's pipeline is music-first: tracks are written, then visuals are tuned to the music. Stage tempo is fixed (4/4 ~135 BPM "excited"; 6/4 100–120 BPM "calm"), and **block fall speed is artificially modulated to keep the piece on-beat** — gravity is a music-sync mechanism, not a physics constant. Implementation implication: our `gameTimeScale` / fall interval should accept beat-grid bias from the FeatureBus.

### 1.5 Likely rendering techniques (inferred)

- **GPU-resident simulation** (compute or fragment-shader writes to FP textures).
- **Compute-driven curl noise** at multiple octaves; commonly cached as a 3D texture for a single sample per particle per frame instead of recomputing — see Emil Dziewanowski's *Dissecting Curl Noise*.
- **Instanced quad rendering** with sorted-back-to-front transparency for the rare cases that need it; everything else is additive and order-independent.
- **Depth-aware soft particles** (alpha falloff against scene depth).
- **Bloom with multi-pass downsample/upsample** (Kawase or COD-style dual filter), threshold lowered far below 1.0.
- **Velocity-buffer motion blur**, at least camera-space.
- **Volumetric fog / god rays** raymarched at half-res, upsampled with a depth-aware bilateral filter.
- **Temporal accumulation** for bloom and reflections.
- **SDFs** for shockwave rings, energy fields, and some UI elements.
- **Vector fields baked or sampled live** — static for choreographed stages, live curl for responsive ones.

### 1.6 Line-clear effect anatomy *(new in rev 3)*

**Why this section.** Earlier revs treated a line clear as one big additive burst. Direct gameplay-video analysis plus interview sources (Hydelic Q&A, Variety interview, Unreal dev interview, Engadget, brothers-in-gaming) make it clear the effect is **layered** — at minimum five and as many as seven distinct particle/visual subsystems firing on every clear, each with its own lifetime, color rule, and placement domain. Treating it as one pool is what makes our current Phase 2 emitter look "okay-but-flat" instead of "cinematic." The unbundling work belongs in Phase 7.

#### 1.6.1 Layer breakdown

| # | Layer | Density | Lifetime | Color source | Motion | Render domain |
|---|-------|---------|----------|--------------|--------|----------------|
| 1 | **Cube fragments** | ~4–8 shards × cleared cells | ~0.3–0.5 s (one beat) | **Block color** (per cell) | Radial-out + slight upward; per-stage gravity | World, in-board, opaque emissive |
| 2 | **Sparkle / dust** | High (the 500–3k figure lives here) | 0.8–1.5 s lingering | **Stage palette**, not block color | Buoyant in calm stages, radial in energetic ones | World, on-row, additive |
| 3 | **Shockwave ring** | 1 per multi-line event | ~0.3 s, single pulse | Stage accent, HDR-boosted | Radial expansion, world- or screen-aligned | World/screen, additive on top |
| 4 | **Trails / ribbons** | Stage-dependent (Dolphin, Aurora, Connected) | 1–2 s, arcing | Stage palette gradient | Streamers from row to case edges | World, additive depth-tested |
| 5 | **Flash / volumetric punch** | 1 frame high HDR + 2–3 frames decay | ~0.08 s | Stage accent, HDR > 1.0 | None (full-screen) | Post-bloom feed |
| 6 | **Camera-space veil** | Full-screen tint | 0.2–0.5 s on Tetris+ | Dominant palette hue | None | Tonemap-stage bias |
| 7 | **Environment reaction** | Stage-specific | Beat-aligned | Stage palette | Surrounding case lights up; creatures may emerge (dolphins, jellyfish on Sea stages); sand kicks; starfield flares | Outside the case |

The layers stack. A single-line clear in Deep Sea typically fires layers 1, 2, and 7 only (modest fragments, sparkle, water-ripple). A Tetris adds 3, 4, 5, and 6. A Perfect Clear/All Clear lights up the whole case (heavy 7) plus a wider 5+6.

#### 1.6.2 Color sourcing rules

The interviews + observation collapse to four rules:

1. **Fragments inherit the cleared block's color.** This is the only layer where per-piece hue dominates. Bloom-friendly but not above 1.0 — fragments are an identity layer, not a brightness layer.
2. **Sparkle/dust uses the *stage palette*, not the block color.** This is why a single-line clear in Deep Sea reads cyan regardless of which Tetrimino was placed. Trying to match the block color here is the most common mistake when copying the look.
3. **Flash, shockwave, and veil use the *stage accent* hue, HDR-boosted (>1.0).** They exist primarily to feed bloom — picking the dominant palette hue is what makes bloom amplify the stage identity instead of muddying it.
4. **Mixing rule for the line-clear footprint:** core skews block color, periphery skews stage hue. This is the §1.3 hue-discipline rule applied locally — the fragment cores read as "the piece" while the surrounding glow reads as "the room responding."

Our current `emitLineClearBurst` HDR-boosts the block color ×1.7 and uses *only* that color across all spawned particles. Per rule 2, that's wrong for the sparkle component — Phase 7 should split into block-tinted fragments + stage-tinted sparkle.

#### 1.6.3 Tier escalation

| Clear | Active layers | Notes |
|-------|---------------|-------|
| Single (1) | 1, 2, (7 light) | No shockwave, no camera move, no flash punch. |
| Double / Triple (2–3) | 1, 2, (7 medium) | More particles, slightly larger sparkle radius. Linear in row count. |
| Tetris (4) | 1, 2, 3, 4, 5, 6, 7 | Inflection point — shockwave + flash + veil all activate; environment reacts (creature emerge / stage flare). Camera nudges on some stages. |
| T-spin | Tetris-tier 1–7 | Audio stinger fires; color grade leans hotter. Not separately documented as visually distinct. |
| Perfect Clear (All Clear) | 1, 2, 3 (large), 5, 6 (heavy), 7 (case-wide) | Full case lights up. Distinct audio cue. Reuses the same layers turned up rather than introducing new ones. |
| Zone discharge | Single explosion at bottom | Lines accumulate during Zone instead of clearing immediately, then fire as one giant burst on Zone exit. Qualitatively different effect — one big release, not per-row events. |

The implementation lever is therefore **a single tier scalar** ("clear weight") that gates which layers activate and at what strength, plus an upper-bound override for Perfect Clear / Zone. Matches the in-game intensity sliders Tetris Effect ships (MIN/MID/MAX + a separate "light particle effects on clear" toggle, per the GameFAQs settings doc) — strong evidence that under the hood, all clear effects share a quality-gated emission multiplier.

#### 1.6.4 Stage variation

The 27 stages are *not* the same effect re-tinted. The **structural** layer recipe (1–7) is consistent, but each stage swaps the sprite content, palette arc, and motion model:

- **Sea stages** (Deep Sea, Dolphin Surf, Mermaid Cove, Jellyfish Chorus): bubble-sprite particles instead of generic sparkles, water-plane ripple as the env reaction, creature spawns on Tetris+.
- **Desert stages** (Deserted, Pharaoh's Code): sand-kick dust replaces sparkles; warmer palette; ribbons absent.
- **Cosmic stages** (Starfall, Orbit, Stratosphere): no gravity on fragments (long-lived float); starfield flare as env reaction.
- **Zen stages** (Yin & Yang, Zen Blossoms, Forest Dawn): petal/leaf sprites substitute for sparkles; ribbons prominent.

Implementation implication: the stage system isn't just a `palette` + `flowField` (current Phase 5 plan) — it also owns a `clearLayerRecipe` that picks sprite atlases, motion models, and env-reaction hooks per layer. Phase 5's stage system spec needs this.

#### 1.6.5 Music sync

Confirmed from the Hydelic interview:

- Stage tempo is fixed per stage (4/4 ~135 BPM excited; 6/4 100–120 BPM calm).
- Within a stage, visuals **switch at line-count thresholds**, and music tempo changes with them. So the visual envelope isn't synced just to the current beat — it's synced to a progression-driven beat that the *game itself* controls.
- Block fall speed is artificially modulated to keep the piece on-beat (Variety interview, brothers-in-gaming).

Inferred from gameplay video (medium confidence):

- The visual *peak* of a clear (flash, shockwave) lands on the nearest beat; the row-removal logic itself fires immediately so gameplay isn't laggy. Likely a two-stage trigger: gameplay event fires now, VFX peak schedules to next quantized tick.
- No documented *anticipatory* ramp before a clear emits. Anticipation is reserved for the ambient/dust layer responding to the predicted beat, not for the gameplay-event layer.

Implementation implication: `LineClearOrchestrator` (Phase 7) should accept a `quantizeTo: 'beat' | 'half-beat' | 'immediate'` parameter from the stage spec and use FeatureBus's beat lookahead to schedule the peak. Layers 5 and 6 (flash and veil) are the most beat-quantize-sensitive; layers 1 and 2 (fragments and sparkle) can fire immediately because their envelopes are long enough to mask a small offset.

#### 1.6.6 Notable design constraints

- **1:1:1 ratio (Ishihara, Variety):** "We strive to achieve a perfect ratio of [gameplay : visuals : sound]." No layer dominates — this is why no single VFX element overwhelms the others.
- **Macro/micro split (Mizuguchi):** keep the inside of the playfield clean, push spectacle to the periphery. Per-cell fragments stay restrained; loud emissive work lives in the case/environment. This is why our shatter doesn't need 256 shards/piece — Tetris Effect uses fewer.
- **Audio-first pipeline (Hydelic):** music demos came first, then visuals were tuned to them. The reverse direction is brittle.
- **In-game quality slider** (per GameFAQs settings doc): MIN/MID/MAX intensity plus a separate "light particle effects on clear" toggle. Strong confirmation that the implementation gates emission on a single quality multiplier — exactly the `qualityScalar` we already have in §3.7.

#### 1.6.7 Evidence gaps

- No source publishes exact particle counts. Our 500–3k range is order-of-magnitude only.
- Whether VFX peaks are actually beat-quantized vs immediate is inferred from video, not confirmed.
- Per-tier escalation curve is observed, not documented.
- The GDC talk *Making Tetris Effect* exists but wasn't accessible during research; it's the most likely source of stronger numbers.

#### 1.6.8 Sources

- [Splice — Hydelic Q&A on Tetris Effect's music](https://splice.com/blog/hydelic-q-and-a/) — only first-party source on music-visual sync mechanics.
- [Brothers in Gaming — Synesthesia in video games](https://www.brothers-in-gaming.com/post/synesthesia-in-video-games) — micro/macro synesthesia framework.
- [Variety — *Tetris Effect's Development Was Anything But Zen-Like*](https://variety.com/2019/gaming/features/tetris-effects-development-was-anything-but-zen-like-1203169014/) — 1:1:1 quote, dynamic block-fall speed.
- [Unreal Engine — How Tetris Effect Became a Modern Work of Art](https://www.unrealengine.com/en-US/developer-interviews/how-tetris-effect-became-a-modern-work-of-art) — UE4 particle stack ("particles as a base for most of the graphics").
- [VGC — *4 Years of Tetris Effect*](https://www.videogameschronicle.com/features/4-years-of-tetris-effect/) — Ishihara/MacDonald on visual restraint.
- [Shacknews — Ultimatris/Perfectris/Decahextris](https://www.shacknews.com/article/108550/what-are-ultimatris-perfectris-and-decahextris-in-tetris-effect) — full clear-tier hierarchy.
- [Engadget — *Tetris Effect on PSVR*](https://www.engadget.com/2018-11-21-tetris-effect-ps4-synesthesia-psvr.html) — concrete description of creature/environment reactions on combos.
- [GameFAQs — *Tetris Effect Connected* settings reference](https://gamefaqs.gamespot.com/pc/296457-tetris-effect-connected/faqs/78800/settings) — confirms in-game particle intensity sliders.
- [GDC Vault — *Making Tetris Effect* (paywalled)](https://www.gdcvault.com/play/1026528/Making-Tetris-Effect) — gap in this rev's research; revisit if access is obtained.

### 1.7 Mapping vocabulary worth studying

The MilkDrop preset community spent ~20 years figuring out which audio→visual mappings *feel* musical. **Read butterchurn presets** (the JS port of MilkDrop, [github.com/jberg/butterchurn](https://github.com/jberg/butterchurn)) — specifically the per-frame equations using `bass`, `bass_att`, `mid`, `mid_att`, `treb`, `treb_att`. The `_att` ("attenuated") variants are envelope-followed versions of the bands, and the way preset authors mix them with `time` and `frame` is exactly the vocabulary we're rebuilding. This is the single best reference for "what should react to what."

---

## SECTION 2 — FEASIBILITY ON THE WEB

### 2.1 Honest assessment

The full Tetris Effect look is **not 1:1 reproducible** in the browser today. Console targets fixed hardware; web targets a distribution that includes 5-year-old integrated GPUs and battery-throttled mobile silicon. We must redesign rather than port.

What *is* reproducible is the **perceptual identity** — flow, rhythm, glow, choreography. These are art-direction properties, not raw-throughput properties.

### 2.2 WebGL2 limitations

| Limitation | Impact |
|------------|--------|
| No compute shaders | GPU simulation must use transform feedback or ping-pong texture rendering — both work but waste fillrate and bandwidth. |
| Limited storage formats | RGBA16F/RGBA32F supported but bandwidth-heavy. |
| No indirect draw | Particle counts must be CPU-known per frame. |
| No bindless / no SSBO | Forces packing state into textures. |
| No timestamp queries (mostly) | Profiling on GPU is approximate. |

WebGL2 can deliver a beautiful Tetris Effect-adjacent look. It just requires conservative architecture.

### 2.3 WebGPU — current reality (May 2026)

WebGPU is shipping default in:
- **Chrome / Edge** on Windows, macOS, ChromeOS, Android 12+; Linux still rolling out.
- **Safari 26+** on macOS, iOS, iPadOS, visionOS.
- **Firefox 141+** on Windows, **145+** on Apple-Silicon Mac; Linux/Android in progress.

Global coverage sits at roughly **70–80%** ([caniuse.com/webgpu](https://caniuse.com/webgpu), [GPUWeb implementation status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)). Ship a WebGL2 fallback for at least another year, but **target WebGPU as the primary path**.

| Capability | Benefit |
|------------|---------|
| Compute shaders | Native GPU particle simulation, sort, cull. |
| Storage buffers | Variable-length particle arrays without texture-packing tricks. |
| Indirect draw + dispatch | GPU decides what to render. |
| Better pipeline state management | Lower per-draw CPU overhead. |
| Timestamp queries | Real GPU profiling. |

Critically for postprocessing: **Three.js's `EffectComposer` / `UnrealBloomPass` is WebGL-only**. The WebGPU-side replacement is the [`three/tsl` `bloom` node](https://threejs.org/examples/?q=bloom#webgpu_postprocessing_bloom) plus the `pass()` / `PostProcessing` pipeline. The migration pattern is renderer-conditional swap — not a rewrite — see [utsubo.com WebGPU/Three.js migration guide](https://www.utsubo.com/blog/webgpu-threejs-migration-guide) and Maxime Heckel's [*Field Guide to TSL and WebGPU*](https://blog.maximeheckel.com/posts/field-guide-to-tsl-and-webgpu/).

### 2.4 Bottlenecks specific to a browser puzzle game

- **Transparency overdraw** is the single biggest cost. 5k additive quads at 100×100 px on 1080p = 50M shaded fragments per frame for one layer.
- **Bloom bandwidth.** A naive bloom on 1440p HDR is ~90 MB/frame. Use half-res HDR + dual-filter bloom.
- **CPU-GPU sync stalls.** Never `getBufferSubData` on the hot path. Pre-allocate; never resize buffers per frame.
- **Mobile thermal throttling.** A device that hits 60 FPS in benchmark may drop to 30 after 4 minutes. Plan for *sustained* perf. Budget 25–50% of desktop targets on mobile.
- **Memory bandwidth on integrated GPUs.** Pack aggressively (RGBA16F, not 32F).
- **`getByteFrequencyData` more than once per frame** — surprisingly common cause of jank. Sample once at the top of the frame; cache.

### 2.5 What is practical / approximated / redesigned

| Effect | Verdict | Web approach |
|--------|---------|--------------|
| Curl-noise ambient drift | **Practical** | 3D-texture-cached noise; 10k–50k particles fine on desktop |
| Line-clear explosions | **Practical** | GPU-instanced burst pool, 2k particles per event |
| Beat-synced pulses | **Practical** | CPU triggers from beat grid, GPU draws |
| Ribbons / trails | **Practical** | Trail-strip geometry from history buffer |
| Voxel fragmentation | **Practical** | Up to ~256 instanced cubes per piece |
| Volumetric energy fields | **Approximate** | Half-res raymarched SDF, 16–32 steps max |
| Volumetric god rays | **Approximate** | Screen-space radial blur from light source |
| True per-particle motion blur | **Approximate** | Camera-velocity buffer only |
| Per-particle bokeh DOF | **Redesign** | Fake with size + alpha modulation by depth |
| Ground reflection probes | **Redesign** | Planar reflection on a single plane only |
| Screen-space GI | **Skip** | Bloom + emissive does enough work |

### 2.6 Stack comparison

| Stack | Verdict |
|-------|---------|
| **Three.js** + `EffectComposer` (WebGL) → **Three.js** + WebGPURenderer + `three/tsl` (WebGPU) | **Recommended.** Same API surface; renderer-conditional swap. |
| **React Three Fiber** | Use only if the rest of the app is React. Imperative `useFrame` for hot paths. |
| **Raw WebGL2** | Reject — months of plumbing for what Three.js gives free. |
| **Babylon.js** | Reasonable alternative; weaker for highly custom VFX. |

The project is already on Three.js r160. **Stay there**, plan a WebGPURenderer + TSL feature flag for the late-2026 migration window (§7 Phase 8).

---

## SECTION 3 — PARTICLE SYSTEM ARCHITECTURE

### 3.1 Render loop structure

```
frame():
  ├── audio.tick()              // sample AnalyserNode + Meyda once
  ├── featureBus.update(dt)     // smooth, normalize, peak-track
  ├── beatGrid.tick(audioCtx.currentTime)  // emits "next-beat" events 200ms ahead
  ├── input.tick()
  ├── game.update(dt)
  ├── eventBus.flush()          // gameplay → VFX
  ├── particleManager.update(dt, featureBus, beatGrid, events)
  │     ├── emitters.tick()     // CPU-side spawn decisions
  │     ├── gpuSim.dispatch()   // compute / FBO ping-pong
  │     └── lod.evaluate()
  ├── renderer.renderScene()
  ├── postFX.run()
  └── compositor.present()
```

Two principles:
- **Audio updates first.** Visuals derive from audio state, never vice versa.
- **`audioContext.currentTime` is the master clock**, not `performance.now()`. They drift; for choreography, only the audio clock is right.

### 3.2 Particle manager architecture

```
ParticleManager
├── Systems[]                      // each is a self-contained simulation+render
│   ├── AmbientCurlSystem
│   ├── DustSparkleSystem
│   ├── BeatPulseSystem
│   ├── RibbonSystem
│   ├── VoxelFragmentSystem
│   ├── ShockwaveSystem
│   ├── EnergyFieldSystem
│   ├── EnvReactionSystem          // stage-specific peripheral spectacle (water ripple, sand kick, starfield flare)
│   ├── UIParticleSystem
│   └── BackgroundFieldSystem
├── Orchestrators[]                // event → multi-layer fan-out
│   └── LineClearOrchestrator      // tier-gated; reads stage.clearLayerRecipe; quantizes peak to BeatGrid
├── SharedResources
│   ├── noise3DTexture            // curl noise sampled per-particle per frame
│   ├── particleAtlas             // per-stage sprite sheet (bubble / petal / sand / spark)
│   └── frameUniformBlock         // featureBus snapshot, packed
└── EventBus
```

Each system exposes the same interface (`init`, `capacity`, `liveCount`, `budgetPriority`, `onEvent`, `update`, `recordSimPass`, `recordRenderPass`).

**Orchestrators** are not systems — they are event handlers that fan out a single gameplay event into coordinated emissions across multiple systems. `LineClearOrchestrator` is the canonical example: a `linesCleared` event reads the stage's `clearLayerRecipe`, the rows' colors, and the FeatureBus's beat lookahead, then schedules tier-appropriate spawns into the fragment / sparkle / shockwave / ribbon / flash / veil / env-reaction systems with the right color rules from §1.6.2 and quantization from §1.6.5. The orchestrator owns the "macro/micro" placement rule from §1.3 — fragments stay inside the case, loud emissive layers go around it.

### 3.3 GPU simulation pipeline (WebGL2 path)

The canonical pattern in shipped audio-reactive demos is **FBO ping-pong GPGPU**:

1. Two floating-point render targets store particle state (position+age in RGBA1, velocity+lifetime in RGBA2). Encoded as fragments of a square texture.
2. Each frame, render a fullscreen quad into the "next" target reading from the "prev" target. The fragment shader is the integrator.
3. Render pass: the particle vertex shader reads the *current* state texture and emits a billboard quad per instance.

References: [Codrops — *Crafting a Dreamy Particle Effect with Three.js and GPGPU* (2024)](https://tympanus.net/codrops/2024/12/19/crafting-a-dreamy-particle-effect-with-three-js-and-gpgpu/), [juniorxsound/Particle-Curl-Noise](https://github.com/juniorxsound/Particle-Curl-Noise), Maxime Heckel's [*Magical World of Particles*](https://blog.maximeheckel.com/posts/the-magical-world-of-particles-with-react-three-fiber-and-shaders/).

### 3.4 GPU simulation pipeline (WebGPU path)

Compute shader writing to a single storage buffer of `Particle` structs. Indirect draw for the render pass so emission rates can scale dynamically. References: Wawa Sensei's [*GPGPU particles with TSL & WebGPU*](https://wawasensei.dev/courses/react-three-fiber/lessons/tsl-gpgpu).

### 3.5 Pre-built particle libraries — when to reach for them

| Library | When to use | When not to |
|---------|-------------|-------------|
| [**three.quarks**](https://github.com/Alchemist0823/three.quarks) | Unity-style VFX graph; designer-friendly; CPU+instanced. | Caps around 5–10k particles. Wrong tool for ambient drift density. |
| [**three-nebula**](https://github.com/creativelifeform/three-nebula) | JSON-loadable presets, designer hand-off. | Same density ceiling. CPU-bound. |
| [**Three-VFX**](https://github.com/mustache-dev/Three-VFX) | **GPU-accelerated via TSL/WebGPU compute, R3F-first.** | Still small (~117⭐ as of mid-2026). Worth piloting in Phase 8. |
| Hand-rolled GPGPU | Full control; the dominant pattern in shipped demos. | Most code. **What we will build.** |

**Decision:** hand-roll the GPGPU pipeline (Phase 4) for control, then evaluate Three-VFX during the WebGPU migration (Phase 8). Don't adopt three.quarks/three-nebula — wrong density class.

### 3.6 ECS vs scene graph

For 50k particles, **do not put them in the scene graph.** Each system is a single `Object3D` whose `onBeforeRender` swaps in custom buffers and issues an instanced draw. Scene graph is for the board, pieces, lights — not VFX.

A lightweight ECS-style record of *emitters* (not particles) is useful. Particles themselves stay GPU-only.

### 3.7 Memory management, batching, culling, LOD

- **Pre-allocate everything at init.** No per-frame allocations.
- **Fixed pools per system.** Empty slots have `lifetime <= 0` and are skipped.
- **Atlas textures, not per-system textures.**
- **Shared 3D noise texture** (~128³ at RGBA8 ≈ 8 MB) sampled by every flow-driven system.
- **Instancing always.** Use `gl_InstanceID` (WebGL2) or `instance_index` (WGSL).
- **Frustum cull in vertex shader** by setting `gl_Position.w = -1` for off-frustum particles.
- **LOD via global `qualityScalar`** (0.25–1.0) scaling per-system `liveCount`. Line-clears keep full count even on low quality; ambient sparkles shrink first.

### 3.8 Render order

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
10. UI-space particles
11. Postprocessing chain
12. HUD / 2D UI                           (sharp, no bloom contamination)
```

---

## SECTION 4 — AUDIO REACTIVE DESIGN *(major rewrite — architecture root)*

### 4.1 Why naive FFT mapping fails

Wiring an FFT bin (or even a smoothed band) directly to a particle parameter looks bad. Four reasons:

1. **Bin energy is noisy.** Adjacent frames vary 10–20% even on a sustained tone.
2. **Linear bins don't match perception.** Logarithmic scaling required.
3. **Beat ≠ energy.** A sustained pad has high energy and no beat.
4. **Modulating with onset events is wrong.** Discrete events should fire **impulses on a separate channel**, not yank the continuous envelope.

The solution is a **multi-stage signal pipeline** with a **FeatureBus** abstraction layer between the audio graph and visual code. Visual systems subscribe to named, smoothed, normalized signals — they never read FFT bins.

### 4.2 The FeatureBus pattern

```
AnalyserNode  ─┐
                │
Meyda          │
 (RMS, flux,   │
  centroid)    ├─►  RawFrame  ─►  BandExtractor  ─►  EnvelopeFollower  ─►  Normalizer  ─►  FeatureBus
                │                  (log bands)        (asym attack/         (running peak,
                                                       release)              AGC)
beatGrid       ─┘
 (offline BPM
  + downbeat)

FeatureBus signals (named, stable API):
  bands.{sub, bass, lowMid, mid, highMid, air}.{value, env, peak}
  onsets.{kick, snare, generic}            // event channel — refractory-windowed impulses
  beat.{phase01, nextAt, confidence}       // beat-grid driven, scheduled lookahead
  energy.{rms, perceived, novelty}         // RMS-derived
  transients.lastT[]                       // history for visual ripples
```

**Visual systems subscribe to FeatureBus signals; nothing reads AnalyserNode directly.** This makes the audio side testable: replay a recorded FeatureBus stream against the renderer with no audio context.

Reference: Kyle Ferguson's [*Audio Reactive Programming: Envelope Followers*](https://kferg.dev/posts/2020/audio-reactive-programming-envelope-followers/) for the asymmetric attack/release math.

### 4.3 Signal pipeline stages

```
AudioContext (sample rate via audioContext.sampleRate)
  │
  ├── BGM: AudioBuffer source (decoded once, reused) → bgmGain → AnalyserNode → destination
  │                                                                │
  │                                          (also into Meyda     │
  │                                           via createMeyda      │
  │                                           Analyzer source)     │
  │
  ├── Once at frame start:
  │     analyser.getByteFrequencyData(bins)        // single read per frame
  │     meyda.get(['rms', 'spectralFlux'])
  │
  ├── BandExtractor (log frequencies):
  │     sub:     20–60Hz
  │     bass:    60–200Hz
  │     lowMid:  200–500Hz
  │     mid:     500–2kHz
  │     highMid: 2k–6kHz
  │     air:     6k–16kHz
  │
  ├── EnvelopeFollower per band, asymmetric:
  │     attack:  τ_a ≈ 5–15ms     (fast rise on transients)
  │     release: τ_r ≈ 80–200ms   (slow decay = "glow")
  │     env = (raw > env) ? lerp(env, raw, 1-exp(-dt/τ_a))
  │                       : lerp(env, raw, 1-exp(-dt/τ_r))
  │
  ├── Normalizer per band:
  │     peak = max(raw, peak * 0.999)        // slow-decay running peak
  │     normalized = clamp01(raw / max(peak, 0.01))
  │
  ├── Onset detector (separate channel):
  │     flux = positivePart(fluxFromMeyda)
  │     adaptiveThreshold = mean(fluxHistory[-50]) + k * stddev
  │     if (flux > threshold && now - lastOnset > 60ms):
  │         emit onset event with strength
  │
  └── BeatGrid (separate, mostly offline):
        On track load: web-audio-beat-detector → BPM, downbeat phase
        Per frame: compute next beat time = phase + (60/bpm) * floor((now-phase)/(60/bpm) + 1)
        Emit "beat-in-Δ" events at lookaheadOffset (e.g., 250ms before)
```

### 4.4 Tooling — concrete library choices

| Library | Use | Bundle | Rationale |
|---------|-----|--------|-----------|
| **[Meyda](https://github.com/meyda/meyda)** (v5.6+, MIT) | `spectralFlux`, `rms`, `spectralCentroid`, `chroma` if needed | ~50 KB min+gz | The right "DSP toolbox" layer. Works as a tap on AnalyserNode or as an AudioWorklet. |
| **[web-audio-beat-detector](https://github.com/chrisguttandin/web-audio-beat-detector)** (MIT) | Offline BPM + downbeat on full AudioBuffer at track load | ~10 KB | Mature, narrow scope. Good on EDM/electronic; brittle on complex meters. |
| **Custom spectral-flux onset** | Live onsets (kick, snare, generic) | n/a | Wrap Meyda's `spectralFlux` with median filter + adaptive threshold + 60–100 ms refractory. Reference: [Keavon/Web-Onset](https://github.com/Keavon/Web-Onset). |
| `Tone.Transport` (Tone.js) | **Pattern only — don't import.** | n/a | Borrow the lookahead-scheduler pattern (`audioContext.currentTime` + `lookAhead`) without the rest of Tone.js. |
| Essentia.js, aubio.js, Pizzicato | — | — | **Skip.** Essentia is WASM-heavy (~5MB) and overkill; aubio is unmaintained; Pizzicato is for playback. |

### 4.5 Anticipatory animation — the Tetris Effect look

Live onset detection alone cannot give you the "the room responds to the beat *before* the beat lands" feeling. That requires a **scheduled beat grid**:

1. **On track load**, run `web-audio-beat-detector` once on the decoded `AudioBuffer`. Cache `{bpm, downbeatPhase, confidence}`.
2. Build a beat grid as `t_n = downbeatPhase + (60/bpm) * n` projected over the track length.
3. Each frame, the BeatGrid emits "beat-in-Δ" events `lookaheadOffset` ms (typically 200–300 ms) before the actual beat.
4. Visual systems subscribe to these *future* events: a curl-noise burst, color flash, or particle puff that *peaks* on the beat. This is the rhythm-game scheduler pattern.
5. **Use `audioContext.currentTime` as the master clock** for all scheduling. `performance.now()` drifts.

For unknown / streaming tracks (mic input, user uploads), fall back to live spectral-flux onset — but accept that the result will feel reactive, not anticipatory.

### 4.6 Mapping audio features to visual systems

| FeatureBus signal | Drives | Notes |
|-------------------|--------|-------|
| `bands.bass.env` | Bloom intensity, camera shake, energy field thickness | Slow-tier; τ_r ≈ 200ms |
| `bands.lowMid.env` | Ambient particle emission rate | Multiplicative on baseline |
| `bands.mid.env` | Ribbon flow speed, hue rotation rate | `pow(x, 0.7)` for nonlinear feel |
| `bands.highMid.env` | Sparkle spawn rate | Higher threshold; only fire over baseline |
| `bands.air.env` | Dust shimmer, chromatic aberration | Subtle, fast tier |
| `onsets.kick` | Beat pulse spawn, shockwave events | One-shot impulse, separate channel |
| `beat.nextAt` | **Anticipatory ramp on emission rates** | Lerp emission up over the 200ms before predicted beat |
| `energy.novelty` | Cinematic event particles, palette shift | Threshold + cooldown |
| `beat.phase01 % 16` | Skybox transitions, level animation | Phrase boundaries |

### 4.7 Smoothing tiers

- **Fast tier** (τ_a 5–15 ms, τ_r 50–80 ms): sparkle, chromatic aberration, anything that should "pop."
- **Slow tier** (τ_a 50 ms, τ_r 200–500 ms): bloom, hue rotation, FOV breathing, fog density. The "room responds" tier.

### 4.8 AudioWorklet vs AnalyserNode — when to upgrade

**AnalyserNode is fine for visualization at 60 FPS** ([Paul Adenot's perf notes](https://padenot.github.io/web-audio-perf/)). The audio graph runs in the audio thread regardless; AnalyserNode just samples it. Main-thread `getByteFrequencyData()` jitter is bounded by rAF (~16 ms), which is well below the human audio-visual binding window (~80 ms).

**Move analysis into an AudioWorklet only when:**
- Running >2–3 Meyda extractors per frame and seeing scripting time exceed 4 ms.
- Need sliding-DFT or window overlap >50% for low-latency onset.
- Need analysis to keep working through main-thread GC pauses.

**Cross-origin isolation (COOP/COEP)** is only required for `SharedArrayBuffer`. Plain AudioWorklet with `port.postMessage` works without it.

### 4.9 Browser & autoplay reality

- **AudioContext is suspended on load.** Always lazy-init on first user gesture. Check `navigator.getAutoplayPolicy()` and surface a "Click to start" if `"disallowed"`.
- **`document.hidden` (tab switch).** rAF stalls; audio keeps playing; FeatureBus desyncs. Either pause audio when hidden or drive analysis from `setInterval` / AudioWorklet.
- **Mobile Safari.** Lower sample rate possible (sometimes 22.05 kHz). Test on hardware. Drop `fftSize` to 512 on mobile; reduce bloom resolution.

### 4.10 Pseudocode skeleton

```ts
class FeatureBus {
  bands = makeBands();             // sub, bass, lowMid, mid, highMid, air
  onsets = new EventChannel();
  beat = { phase01: 0, nextAt: 0, confidence: 0 };
  energy = { rms: 0, perceived: 0, novelty: 0 };

  private analyser: AnalyserNode;
  private meyda: Meyda.MeydaAnalyzer;
  private beatGrid: BeatGrid;
  private bins = new Uint8Array(512);

  tick(dt: number, audioCtxTime: number) {
    this.analyser.getByteFrequencyData(this.bins);  // single read
    const features = this.meyda.get(['rms', 'spectralFlux']);

    for (const band of this.bands) {
      const raw = integrateLog(this.bins, band.lo, band.hi, this.sampleRate);
      band.value = raw;
      // Asymmetric envelope follower
      const tau = raw > band.env ? band.tauA : band.tauR;
      band.env += (raw - band.env) * (1 - Math.exp(-dt / tau));
      // Running peak with slow decay (AGC)
      band.peak = Math.max(raw, band.peak * 0.999);
      band.norm = band.peak > 0.01 ? Math.min(1, raw / band.peak) : 0;
    }

    // Onset detection (separate channel)
    if (this.onsetDetector.update(features.spectralFlux, audioCtxTime)) {
      this.onsets.emit({ t: audioCtxTime, kind: 'generic',
                         strength: this.onsetDetector.lastStrength });
    }

    // Beat grid (offline BPM, online phase)
    const beatInfo = this.beatGrid.tick(audioCtxTime);
    this.beat.phase01 = beatInfo.phase01;
    this.beat.nextAt = beatInfo.nextAt;
    this.beat.confidence = beatInfo.confidence;

    // Energy / novelty
    this.energy.rms = features.rms;
    this.energy.novelty = noveltyTrack(this.bands, dt);
  }
}

// Visual consumer:
class AmbientCurlSystem {
  update(dt: number, fb: FeatureBus) {
    const beatRamp = anticipationRamp(fb.beat.nextAt - audioCtx.currentTime, 250);
    this.material.uniforms.uIntensity.value =
      0.85 + 0.55 * fb.bands.bass.env + 0.30 * fb.bands.lowMid.env;
    this.emissionRate = this.baseRate * (0.5 + 1.5 * fb.bands.lowMid.env + 0.6 * beatRamp);
  }
}
```

---

## SECTION 5 — SHADER AND POST FX PLAN

### 5.1 Particle shader building blocks

- **`particle_billboard.vs`** — instancing + billboarding modes (camera-aligned, velocity-aligned, fixed) + size animation.
- **`particle_soft.fs`** — depth-aware soft falloff, radial alpha, additive output, optional atlas sampling.
- **`particle_distort.fs`** — outputs to a separate distortion target sampled in post (shockwaves).

### 5.2 Post-processing chain

```
HDR scene buffer (RGBA16F, half-res for ambient pass / full-res for main)
  │
  ├── 1. Distortion apply (sample distortion target, offset main UVs)
  ├── 2. Bloom
  │      ├── Threshold (soft knee, threshold ≈ 0.7)
  │      ├── Downsample chain (5–6 levels, dual filter)
  │      ├── Upsample chain with additive accumulate
  │      └── Composite onto main with intensity controlled by FeatureBus
  ├── 3. Camera motion blur (velocity buffer, 8–12 taps max)
  ├── 4. Chromatic aberration (radial offset, audio-modulated)
  ├── 5. Lens distortion (mild barrel, screen-edge only)
  ├── 6. Vignette
  ├── 7. Tonemap (AGX preferred for saturated palettes)
  ├── 8. Color grading LUT (per stage)
  └── 9. Dithering (1-bit triangular noise, prevents banding)
```

### 5.3 WebGL2 vs WebGPU postprocessing

- **WebGL2 (current):** `EffectComposer` + custom `ShaderPass`es. Replace `UnrealBloomPass` defaults with a hand-rolled dual-filter bloom in Phase 6.
- **WebGPU (Phase 8):** Drop into `three/tsl` `bloom` + `pass()` pipeline. The TSL `bloom` node measurably outperforms the WebGL `UnrealBloomPass` on draw-call-heavy scenes.
- **Renderer-conditional swap.** Same logical post chain, two implementations behind a feature flag — see [Migrate Three.js to WebGPU](https://www.utsubo.com/blog/webgpu-threejs-migration-guide).

### 5.4 What should be real vs faked

| Effect | Real or fake | Reasoning |
|--------|--------------|-----------|
| Bloom | **Real** (multi-pass) | Defines the look |
| Volumetric god rays | **Faked** (radial blur) | True volumetrics too costly |
| Volumetric fog | **Real but cheap** (depth-based exponential) | Trivial; huge mood impact |
| Refraction (glass blocks) | **Real** (background buffer offset) | One pass, reads great |
| Reflections | **Faked** (cubemap + planar plane) | SSR has too many failure cases |
| Motion blur | **Real** (camera velocity only) | Per-particle blur not worth cost |
| Chromatic aberration | **Faked** (UV offset per channel) | Real spectral CA isn't justified |
| Lens flare | **Faked** (sprite-based) | Standard; cheap |
| Soft particle edges | **Real** (depth fade) | Required for density |
| Ambient occlusion | **Skip or fake** (baked vertex AO) | SSAO cost not worth it given bloom dominance |

### 5.5 Overdraw minimization

- **Half-res ambient/background buffer**, depth-aware bilateral upsample.
- **Smaller quads.** Profile actual covered pixels per particle.
- **Discard early** when soft-particle alpha < 0.01.
- **Bloom threshold at 0.6–0.8.**

### 5.6 Pass ordering rules

- **Distortion before bloom.** Bloom sees the distorted image.
- **Tonemap before LUT.**
- **Dither last.**

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

- **<80 draw calls/frame total.**
- **GPU instancing always.**
- **Texture atlases.** All sprite particles share one atlas; ribbons share one tileable strip texture.
- **Sim frequency reduction.** Background field can simulate at 30 Hz while rendering at 60. Interpolate position in the vertex shader.
- **Half-resolution rendering** for ambient layers.
- **Dynamic resolution scaling.** Frame time > 17 ms for 1 s → drop to 0.85×; recover slowly.
- **`getByteFrequencyData` once per frame.**
- **Aggressive uniform packing.** Single audio + frame uniform block.

### 6.4 Profiling and debugging

- **Stats.js** for FPS / frame time.
- **`spector.js`** for per-call WebGL2 GPU inspection.
- **Chrome DevTools Performance panel** for CPU stalls.
- **WebGPU timestamp queries** for per-pass GPU timings.
- **In-engine HUD** — live particle counts per system, ms per pass, bloom buffer dims, dynamic res scale, FeatureBus signal traces.
- **System-id / overdraw / depth visualizer toggle.** Worth its weight in gold.

### 6.5 Graceful degradation

Quality is a single scalar 0..1 mapped to: per-system particle multipliers, bloom resolution, volumetric step count, motion blur on/off, CA on/off, DPR cap, post-FX LUT bypass on lowest. Auto-tune from rolling 60-frame median; debounce 1 s.

---

## SECTION 7 — IMPLEMENTATION ROADMAP *(restructured)*

### Phase 1 — Minimal prototype  ✅ **COMPLETE**

**Delivered.** Three.js scene + UnrealBloomPass + vignette + SMAA + AGX-adjacent ACES tonemap. `ambientField` (500 CPU sprites, additive billboard, soft radial sprite, disciplined cyan→violet hue arc). Single `THREE.Points` draw, pre-allocated `Float32Array`s, zero hot-path allocations. Triangular alpha envelope; toroidal wrap.

### Phase 2 — Simple particle systems  🟡 **PARTIALLY COMPLETE**

**Delivered.**
- BGM routed through Web Audio: `MediaElementSource → bgmGain → AnalyserNode (FFT 1024) → master`.
- 5-band integrator (bass, lowMid, mid, highMid, air) with single-tier EMA smoothing.
- Placeholder bass-ratio beat detector with 200 ms cooldown.
- `dustField` (1000 capacity, 200 baseline; active count modulated by `audio.smooth.energy`).
- `burstPool` (3000 capacity, free-slot allocator with ring-cursor fallback).
- `emitLineClearBurst` (200 particles per row, color from row average × 1.7 HDR boost).
- `emitBeatPulse` (50–110 particles per pulse, hot-violet ring).
- `_particleSystems` registry for resize coordination.
- `aSize` / `aColor` upload bug fixed (was: GPU-side size = 0 for spawned particles).

**Not done** (rolled into Phase 3): Meyda integration, offline BPM detection, FeatureBus abstraction layer, proper spectral-flux onset detection, asymmetric envelope followers, per-band normalization. The visuals work but the analyzer is primitive — every later choreographic feature will need the FeatureBus, so harden it before going further.

### Phase 3 — Audio analysis foundation *(new — promoted from old Phase 4)*

**Goal.** Replace the homegrown analyzer with a production audio pipeline. Build the FeatureBus abstraction. Pre-analyze BGM on track load. Properly detect onsets. This phase has no visual deliverables — it's plumbing — but every subsequent phase depends on it.

**Tasks.**
- Add Meyda (`meyda` ~50 KB). Tap from existing AnalyserNode; extract `spectralFlux`, `rms`, `spectralCentroid`.
- Add `web-audio-beat-detector`. On BGM load, decode the audio file once into an `AudioBuffer`, run BPM + downbeat detection, cache `{bpm, downbeatPhase, confidence}`.
- Build `FeatureBus` class: bands, asymmetric envelope followers (τ_a ≈ 5–15 ms, τ_r ≈ 80–200 ms), per-band normalizer with running peak, energy/novelty, onset event channel.
- Build `BeatGrid` class: project beat times from BPM + downbeat phase; emit "beat-in-Δ" events 250 ms ahead via `audioContext.currentTime` lookahead.
- Build spectral-flux onset detector with median filter + adaptive threshold + 60 ms refractory window. Reference: [Keavon/Web-Onset](https://github.com/Keavon/Web-Onset).
- **Refactor existing systems** (ambient, dust, burst, beat-pulse trigger) to read from FeatureBus instead of the raw `audioReactor.smooth.*`. The placeholder beat detector goes away; beat-pulse is now driven by `onsets.kick` from spectral-flux + the BeatGrid for anticipation.
- Add a debug overlay showing live FeatureBus signals as a strip-chart.

**Risks.** Tempo tracker is brittle on non-4/4 or live tracks — accept and document. BGM that's lossy-encoded mp3/m4a may have onset detection bias near the bitrate's high-frequency cutoff.

**Quality.** Effects feel choreographed instead of merely reactive. Beat pulses anticipate the kick by ~200 ms.

**Complexity.** Medium.

**Exit criteria.** Beat pulses land within ~30 ms of audio onset for 4/4 BGM; emission rates ramp anticipatorily; debug overlay shows clean band envelopes.

### Phase 4 — GPU simulation pipeline *(was Phase 3)*

**Goal.** Move ambient and dust from CPU to GPU using FBO ping-pong (WebGL2 path). Add 3D-texture-cached curl noise. Particle counts to 30k+ in the ambient field.

**Tasks.**
- Implement `GPGPUParticleSimulator` helper: two RGBA16F render targets (position+age, velocity+lifetime), ping-pong fragment-shader integrator, render pass that reads current state texture in vertex shader.
- Bake / sample 3D curl noise into a 128³ RGBA8 texture; share across systems.
- Port `ambientField` to GPGPU.
- Port `dustField` to GPGPU.
- Keep `burstPool` on CPU for now — bursts are short-lived enough that CPU is fine, and the spawn pattern is heterogeneous enough that GPU emission would be more complex than worth.
- References to study: [Codrops *Crafting a Dreamy Particle Effect* (2024)](https://tympanus.net/codrops/2024/12/19/crafting-a-dreamy-particle-effect-with-three-js-and-gpgpu/), [juniorxsound/Particle-Curl-Noise](https://github.com/juniorxsound/Particle-Curl-Noise), [Maxime Heckel's particles guide](https://blog.maximeheckel.com/posts/the-magical-world-of-particles-with-react-three-fiber-and-shaders/).

**Risks.** Ping-pong state machine bugs; FP precision issues at high counts; `getError`-induced sync stalls during dev.

**Quality.** Density jump. Ambient layer reads as a flow.

**Complexity.** High.

**Exit criteria.** 30k particles at 60 FPS on a mid-tier laptop; ambient flow visibly follows the noise field.

### Phase 5 — Anticipatory choreography & cinematic events *(new)*

**Goal.** Use the BeatGrid to drive scripted choreography that's impossible with live detection alone. Per-stage palette, phrase-aligned transitions, attention-budget arbiter.

**Tasks.**
- Stage system: each stage owns a `palette`, `flowField` parameters, `choreoScript` of beat-grid-aligned events.
- Phrase boundary detection: every 16 beats, fire a stage-transition event.
- Attention arbiter: when a high-priority event fires (line clear, T-spin, level transition), ambient emission temporarily dims to "make room."
- Camera FOV breathing tied to `bands.bass.env` (slow tier).
- Anticipatory ramps on emission rates 200–300 ms before predicted beats.
- Novelty/drop detection from `energy.novelty`; trigger palette shifts.

**Risks.** Choreography content scope creep — set a fixed budget of 3 stages.

**Quality.** Distinctive identity per stage; the room responds to phrase structure.

**Complexity.** Medium (mostly content + tuning).

**Exit criteria.** At least 3 distinct stage moods; transitions land on phrase boundaries; ambient visibly dims during line-clears.

### Phase 6 — Postprocessing chain replacement *(was Phase 5)*

**Goal.** Replace the default `EffectComposer` defaults with a hand-rolled chain (still WebGL2 — Phase 8 introduces the WebGPU/TSL alternative). Half-res ambient buffer with depth-aware bilateral upsample.

**Tasks.**
- Custom dual-filter (Kawase) bloom replacing `UnrealBloomPass`.
- Velocity buffer + camera motion blur.
- Chromatic aberration with FeatureBus modulation.
- Lens distortion (mild barrel, edge-only).
- AGX tonemap operator.
- Per-stage LUT support.
- 1-bit triangular dither.

**Risks.** Visual regressions vs. default Three.js bloom; LUT pipeline color issues; banding on cheap displays.

**Quality.** Major polish jump.

**Complexity.** Medium–high.

**Exit criteria.** No visible banding; bloom under 2.5 ms at 1080p; tonemap consistent across stages.

### Phase 7 — Advanced shader systems & line-clear unbundling *(was Phase 6; rev-3 expansion)*

**Goal.** Add the remaining particle categories from §1.2 *and* unbundle the Phase 2 single-pool line-clear emitter into the layered structure §1.6 documents. This is the phase where the line clear stops looking "okay-but-flat" and starts looking cinematic.

**Tasks — new systems.**
- **`VoxelFragmentSystem`** (§1.6 layer 1): instanced-mesh small cubes, 4–8 shards × cleared cells, block-color emissive, per-stage gravity. Up to ~256 instanced cubes total per piece (§6.2 budget). Lives inside the case.
- **`RibbonSystem`** (§1.6 layer 4): history-buffer trail strips. Stage-gated — Sea/Aurora/Connected stages emit ribbons from cleared rows to case edges; desert/zen stages don't.
- **`ShockwaveSystem`** (§1.6 layer 3): SDF ring quad with distortion-target output. Stage-accent color, HDR-boosted. World- or screen-aligned per stage spec.
- **`EnvReactionSystem`** (§1.6 layer 7): stage-specific peripheral spectacle. Water-plane ripple shader for Sea stages, sand-kick particle puff for desert, starfield flare for cosmic. The macro layer of macro/micro synesthesia (§1.3) — placed *outside* the case, never inside.
- **`EnergyFieldSystem`**: half-res raymarched SDF, 16–24 steps.

**Tasks — orchestration.**
- **`LineClearOrchestrator`**: replaces the current `emitLineClearBurst` single-pool emitter. On a `linesCleared` event:
  1. Compute tier weight (1 for single, ramping to ~3 for Tetris, ~5 for Perfect Clear) per §1.6.3.
  2. Read `stage.clearLayerRecipe` for which layers fire and with what sprite atlas / motion model.
  3. Schedule layer 1 + 2 immediately (their envelopes mask quantization error).
  4. Schedule layers 3, 5, 6 to peak on the **next beat** via `featureBus.beatGrid.nextAt` — quantized per §1.6.5.
  5. Apply color rules per §1.6.2: fragments inherit block color; sparkle uses *stage palette*; flash/shockwave/veil use *stage accent*, HDR-boosted.
  6. Trigger 7 (env reaction) via `EnvReactionSystem.onClear(tier)`.
- **Quality multiplier**: route through the existing `qualityScalar` (§3.7) so the shipped MIN/MID/MAX equivalent collapses naturally.
- **Refactor the current `burstPool`**: keep it for `emitBeatPulse` and as the sparkle-layer pool; voxel fragments graduate to their own instanced-mesh system.

**Tasks — supporting work.**
- Soft-particle depth fade everywhere (ports back into Phase 4 systems).
- Refraction on glass blocks (sample background buffer with offset).
- Stage spec format extended with `clearLayerRecipe` (per §1.6.4): which layers active, sprite atlases, gravity/motion, color rules.

**Risks.** SDF shader complexity; refraction read-back costs; ribbon vertex count; tier-tuning may overshoot — start conservative on the layer-3/5/6 intensity. The peripheral env-reaction is potentially scope-creepy (per-stage shaders) — ship a minimum viable env-reaction (one or two stages) and treat the rest as content work.

**Quality.** Approaches the target aesthetic. This is where "really good" becomes "rivals the source."

**Complexity.** High.

**Exit criteria.** All §1.6 line-clear layers present and tier-gated; a Tetris vs a single is *visibly* a different effect, not a same-effect-with-more-particles; per-stage clear flavor distinguishable on at least 3 stages; the sparkle layer reads as stage-palette while fragments read as block-color (§1.6.2 rule 2 verified by eye).

### Phase 8 — WebGPU / TSL migration & optimization

**Goal.** Add WebGPU as a feature-flagged alternate renderer. Hand-roll a TSL-based postprocessing chain. Optimization pass for mobile and laptop. Quality tiers, dynamic resolution, profiling HUD, soak testing.

**Tasks.**
- Renderer-conditional swap: `WebGLRenderer` (current) vs `WebGPURenderer`. Same scene API, different post chain.
- Port custom postprocessing to `three/tsl` (`bloom`, `pass`, `PostProcessing`).
- Evaluate Three-VFX as a possible particle replacement; if its TSL path proves stable, port one system as a pilot.
- Mobile shader audit (precision, derivatives, DPR cap).
- WebGL2 fallback verified end-to-end.
- Profiling HUD complete; soak tests at 10 minutes.

**Risks.** WebGPU stability on Linux; mobile Safari edge cases; Three-VFX maturity.

**Quality.** Stable across hardware; measurable WebGPU performance wins on draw-call-heavy scenes.

**Complexity.** Medium.

**Exit criteria.** §6.1 targets met on representative hardware in 10-minute soak tests; WebGPU path running on Chrome desktop without visual regressions.

**Total schedule:** ~14 weeks single-developer (was 12 in rev 1; Phase 3 added 2 weeks of audio plumbing).

---

## SECTION 8 — FINAL TECHNICAL RECOMMENDATION

### Stack

```
Rendering
  WebGL2 path (current):  Three.js r160 + EffectComposer + UnrealBloomPass → custom dual-filter bloom in Phase 6
  WebGPU path (Phase 8):  Three.js + WebGPURenderer + three/tsl bloom + PostProcessing
  Renderer-conditional swap behind a feature flag.

Audio
  AudioContext  →  BGM (decoded AudioBuffer, pre-analyzed for BPM)
                →  AnalyserNode (fftSize 1024, smoothing 0.0)  →  destination
                →  Meyda analyzer tap (spectralFlux, rms, spectralCentroid)
  Pre-load:  web-audio-beat-detector  →  {bpm, downbeatPhase, confidence}
              →  BeatGrid (precomputed event timeline)

FeatureBus runtime signals
  bands.{sub, bass, lowMid, mid, highMid, air}.{value, env, peak, norm}
  onsets.{kick, snare, generic}     // separate impulse channel
  beat.{phase01, nextAt, confidence}
  energy.{rms, perceived, novelty}

Visuals subscribe to FeatureBus; nothing reads AnalyserNode directly.

Particles
  Phase 4+:  Hand-rolled GPGPU FBO ping-pong on WebGL2; compute shader on WebGPU.
  3D-texture-cached curl noise, 128³ RGBA8 shared across systems.
  Three-VFX evaluated in Phase 8 as a possible drop-in for the WebGPU path.

Build
  Vite, shader hot-reload, HMR-friendly module boundaries on systems.
```

### Is WebGPU worth adopting?

**Yes — as a feature-flagged alternate path, not a rewrite.** Coverage is ~70–80% globally. Compute shaders and the TSL postprocessing pipeline both deliver measurable wins on draw-call-heavy scenes. Maintain the WebGL2 path through Phase 7; introduce WebGPU in Phase 8.

### Is AudioWorklet worth adopting?

**No — not yet.** Main-thread `AnalyserNode` + Meyda is fine for 60 FPS visualization. Move analysis into a worklet only when scripting time on the main thread exceeds ~4 ms or when sample-accurate sliding-DFT is required. The complexity tax is real.

### Priority order for first impressions

If only a subset of effects can ship, ship in this order — these buy the most "Tetris Effect feel" per hour of work:

1. **Bloom + HDR + AGX tonemap.** This single change dwarfs every other VFX in perceived quality.
2. **Curl-noise ambient drift, additive, hue-disciplined.** The signature flow.
3. **FeatureBus + offline BPM + anticipatory beat ramps.** *Without anticipation, the visuals will only ever feel "reactive," never "choreographed."*
4. **Layered line-clear (§1.6).** *The* "feel" moment. Even at low quality this means at minimum: block-color fragments + stage-palette sparkle + tier-gated flash. Skipping the color split (rule §1.6.2.2) is the single most common way to fail this effect.
5. **Beat-quantized peak on Tetris+ clears.** Schedule flash/shockwave to land on the next beat, not on the lock frame. Without this the clear feels triggered, not choreographed.
6. **Beat-synced subtle camera FOV + bloom modulation.** Music-room mood.
7. **Soft particles + depth fade.** Removes the cheap edge.
8. **Per-stage palette + skybox transitions on phrase boundaries.** Identity.
9. **Per-stage env reaction on Tetris+ (§1.6 layer 7).** Even one stage with a real environmental react (water ripple / starfield flare / sand kick) sells the macro/micro synesthesia.

Items 10+ (ribbons, energy fields, volumetric fog, refraction, full per-stage env-reaction library) take the project from "really good" to "rivals the source." Without items 1–9, none of those help.

### What can realistically rival Tetris Effect in a browser

Achievable:
- **Aesthetic identity** (palette, flow, glow, rhythm sync) — yes, fully.
- **Particle density** (10k–60k visible particles) — yes on desktop, scaled on mobile.
- **Choreography polish** (anticipation, attention budgeting, phrase-aligned transitions) — yes; this is craft + pre-analyzed beat grids, not horsepower.
- **Cinematic post-processing** — yes, indistinguishable at viewing distance.

Not achievable:
- True per-particle motion blur and DOF. *Faked acceptably.*
- High-fidelity volumetrics. *Faked acceptably.*
- PSVR-style stereoscopic immersion. *Out of scope.*
- Sustained 4K/120 on integrated GPUs. *Hardware-bound.*

The art-direction ceiling, not the rendering ceiling, will be the binding constraint. Build the systems above, then spend the back half of the schedule tuning rather than adding.

---

## APPENDIX — REFERENCES

### Audio analysis

- [Meyda (audio feature library)](https://github.com/meyda/meyda) — DSP toolbox; extractors via tap on AnalyserNode or AudioWorklet
- [web-audio-beat-detector](https://github.com/chrisguttandin/web-audio-beat-detector) — offline BPM + downbeat
- [Keavon/Web-Onset](https://github.com/Keavon/Web-Onset) — spectral-flux onset reference
- [Audio Reactive Programming: Envelope Followers — Kyle Ferguson](https://kferg.dev/posts/2020/audio-reactive-programming-envelope-followers/) — asymmetric attack/release math
- [Web Audio API Best Practices (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Best_practices)
- [Web Audio perf notes — Paul Adenot](https://padenot.github.io/web-audio-perf/)
- [Audio Worklets for Low-Latency Audio Processing](https://dev.to/omriluz1/audio-worklets-for-low-latency-audio-processing-3b9p)
- [Cross-Origin Isolation guide (web.dev)](https://web.dev/articles/cross-origin-isolation-guide)
- [Autoplay policy in Chrome](https://developer.chrome.com/blog/autoplay)
- [`navigator.getAutoplayPolicy()` — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/getAutoplayPolicy)

### Particle rendering & GPGPU

- [Codrops — *Crafting a Dreamy Particle Effect with Three.js and GPGPU* (2024)](https://tympanus.net/codrops/2024/12/19/crafting-a-dreamy-particle-effect-with-three-js-and-gpgpu/)
- [Codrops — *Audio-Reactive Visuals with Dynamic Particles* (2023)](https://tympanus.net/codrops/2023/12/19/creating-audio-reactive-visuals-with-dynamic-particles-in-three-js/)
- [Codrops — *Coding a 3D Audio Visualizer with Three.js, GSAP & Web Audio API* (2025)](https://tympanus.net/codrops/2025/06/18/coding-a-3d-audio-visualizer-with-three-js-gsap-web-audio-api/)
- [Maxime Heckel — *The Magical World of Particles with R3F and Shaders*](https://blog.maximeheckel.com/posts/the-magical-world-of-particles-with-react-three-fiber-and-shaders/)
- [Maxime Heckel — *Field Guide to TSL and WebGPU*](https://blog.maximeheckel.com/posts/field-guide-to-tsl-and-webgpu/)
- [Wawa Sensei — *GPGPU particles with TSL & WebGPU*](https://wawasensei.dev/courses/react-three-fiber/lessons/tsl-gpgpu)
- [Emil Dziewanowski — *Dissecting Curl Noise*](https://emildziewanowski.com/curl-noise/)
- [juniorxsound/Particle-Curl-Noise](https://github.com/juniorxsound/Particle-Curl-Noise)
- [three.quarks](https://github.com/Alchemist0823/three.quarks)
- [three-nebula](https://github.com/creativelifeform/three-nebula)
- [Three-VFX (TSL/WebGPU GPU particle library)](https://github.com/mustache-dev/Three-VFX)

### Audio-reactive reference projects

- [jberg/butterchurn](https://github.com/jberg/butterchurn) — JS port of MilkDrop; **read the preset language for the audio→visual mapping vocabulary**
- [projectM](https://github.com/projectM-visualizer/projectm) — native MilkDrop reimpl
- [dcyoung/r3f-audio-visualizer](https://github.com/dcyoung/r3f-audio-visualizer) — clean R3F + AnalyserNode
- [hvianna/audioMotion-analyzer](https://github.com/hvianna/audioMotion-analyzer) — battle-tested spectrum analyzer; good FFT-bin-to-log-band mapping reference
- [Visualizations with Web Audio API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API/Visualizations_with_Web_Audio_API)

### WebGPU / TSL migration

- [WebGPU support — caniuse](https://caniuse.com/webgpu)
- [GPUWeb implementation status](https://github.com/gpuweb/gpuweb/wiki/Implementation-Status)
- [WebGPU is now supported in major browsers — web.dev](https://web.dev/blog/webgpu-supported-major-browsers)
- [Migrate Three.js to WebGPU — utsubo](https://www.utsubo.com/blog/webgpu-threejs-migration-guide)

---

*End of document.*
