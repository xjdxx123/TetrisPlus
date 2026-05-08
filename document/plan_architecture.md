# TetrisPlus — Architecture Refactor Proposal

**Author:** Engine architecture review
**Status:** Proposal — pre-implementation
**Target:** [`project/tetris.html`](../project/tetris.html), [`project/game.js`](../project/game.js), [`project/tweaks-panel.jsx`](../project/tweaks-panel.jsx)

---

## 0. Current State (Grounding)

Before prescribing structure, the actual baseline:

- **[`project/tetris.html`](../project/tetris.html)** is a 4,213-line single-page app. All gameplay, rendering, particles, shaders, audio, UI, and the tweaks panel live in one `<script>` block. State is module-scope mutable (`board[]`, `activePiece`, `score`, `level`, `gameOver`, etc. around [tetris.html:1472-1759](../project/tetris.html#L1472-L1759)). The frame loop at [tetris.html:3090-3336](../project/tetris.html#L3090-L3336) advances physics, particles, UI animation, audio-reactive params, camera shake, and renders, all interleaved.
- **[`project/game.js`](../project/game.js)** is 1,365 lines of dead/parallel implementation (its own `THREE.WebGLRenderer`, its own board, never imported). It is a fork-in-place that diverged.
- **[`project/tweaks-panel.jsx`](../project/tweaks-panel.jsx)** is a 552-line React component library not currently mounted; the HTML re-implements the same panel in vanilla JS at [tetris.html:3727-4213](../project/tetris.html#L3727-L4213) using a `postMessage` protocol (`__activate_edit_mode`, `__edit_mode_set_keys`).
- **Subsystems already present, just unseparated:** ambient CPU billboard particles (500, [tetris.html:621-810](../project/tetris.html#L621-L810)), instanced GPU sparkle pool (2000, [tetris.html:811-1104](../project/tetris.html#L811-L1104)), instanced shard pool ([tetris.html:1919-2166](../project/tetris.html#L1919-L2166)), inline glass fresnel shaders ([tetris.html:1248-1274](../project/tetris.html#L1248-L1274)), vignette/bloom/SMAA composer, OrbitControls camera, Web Audio + HTMLAudioElement audio, CSS3DRenderer for HUD overlay, mood/tweak system.

**Implication for this proposal.** The work is not deleting — it's *parting*. We carve already-existing subsystems out of the monolith while preserving the running build. `game.js` should be deleted on day one (dead code, parallel state model is a future merge hazard). `tweaks-panel.jsx` should either become *the* panel or be deleted; running two panel implementations against the same protocol is a footgun.

---

## 1. System Decomposition

The monolith already contains ~14 implicit subsystems. They need explicit ownership boundaries before any of them grows further. Listed with **owns / does not own / public surface / dependencies**.

### 1.1 Gameplay Core (`gameplay/`)
- **Owns:** board grid (`Cell[H][W]`), active piece, hold piece, next queue, score, level, lines cleared, gravity timer, tetromino spawning, rotation/kick tables, line-clear detection, game-over state.
- **Does not own:** any `THREE.*` object, any DOM element, any audio playback, any particle. Has no knowledge that the renderer exists.
- **Public surface:** `Game.tick(dtMs, input)`, `Game.snapshot(): BoardSnapshot`, `Game.events: EventStream<GameplayEvent>`. Single function input, single function output, single event stream.
- **Depends on:** `shared/math`, `shared/random` (seeded RNG so gameplay can be deterministic). Nothing else.

### 1.2 Input System (`input/`)
- **Owns:** raw keyboard/gamepad/touch capture, keybind config, DAS/ARR repeat shaping, "intent" mapping (`MOVE_LEFT`, `ROTATE_CW`, `HARD_DROP`, `HOLD`, `PAUSE`).
- **Does not own:** game rules. It does not know what `HARD_DROP` does — it just fires the intent.
- **Public surface:** `Input.poll(): InputFrame` consumed by `Game.tick`. `Input.bind(action, key)`.
- **Depends on:** browser DOM events only.

### 1.3 Camera System (`camera/`)
- **Owns:** the `PerspectiveCamera`, OrbitControls, framing logic, additive shake/punch/zoom layers, target-following.
- **Does not own:** the scene, lights, render passes, or what triggers shakes.
- **Public surface:** `Camera.update(dt)`, `Camera.applyImpulse(ImpulseDescriptor)`, `Camera.three: PerspectiveCamera` (read-only handle for the renderer).
- **Subscribes to:** `CAMERA_IMPACT`, `BASS_PEAK` (optional), `LINE_CLEAR` (optional punch-zoom).
- **Depends on:** `three`, `event bus`.

### 1.4 Rendering Pipeline (`rendering/`)
- **Owns:** `WebGLRenderer`, `CSS3DRenderer`, `EffectComposer`, render targets, render-pass ordering, frame graph, lights, environment. Owns the *act of drawing*.
- **Does not own:** what to draw. Scene contents are submitted by other systems via render contexts.
- **Public surface:** `Renderer.registerLayer(layer)`, `Renderer.renderFrame(camera)`, `Renderer.resize(w,h)`.
- **Depends on:** `three`, `three/addons/postprocessing`.

### 1.5 Scene Graph / World (`world/`)
- **Owns:** the visual representation of the board (cube meshes per cell, ghost piece, active piece visualization, glass case walls/frame, inner floor, back grid). Lives behind a thin `BoardView` that consumes `BoardSnapshot` from Gameplay and reconciles meshes.
- **Does not own:** gameplay state. Strictly a *reactive view* — given a snapshot, produce/update meshes.
- **Public surface:** `BoardView.sync(snapshot)`, `BoardView.group: Object3D`.
- **Depends on:** `three`, `materials`.

### 1.6 Materials & Shaders (`materials/`, `shaders/`)
- **Owns:** glass fresnel material, cube core/emissive material, ambient field shader, sparkle shader, shard shader, vignette ShaderPass. All shader source as `.glsl` files via `?raw` import.
- **Does not own:** geometry, mesh instancing, draw orchestration.
- **Public surface:** factory functions returning configured `ShaderMaterial` instances; uniform getters/setters typed.
- **Depends on:** `three` only.

### 1.7 VFX Framework (`vfx/`)
- **Owns:** pooled emitter API, emitter lifetimes, particle update + GPU writeback. Encapsulates today's three particle systems (ambient field, clear sparkle, shatter shards) and the line-clear veil.
- **Does not own:** *when* effects fire (events drive that), camera, shaders.
- **Public surface:** `VFX.spawn(presetName, params)`, `VFX.update(dt)`. Presets registered at boot.
- **Depends on:** `three`, `materials`.

### 1.8 Audio System (`audio/playback`)
- **Owns:** `AudioContext`, decoded `AudioBuffer` cache, BGM `HTMLAudioElement`, voice-bus volumes (master, music, sfx, voice), gesture-gated init, ducking.
- **Does not own:** what to play *when* — that is event-driven.
- **Public surface:** `Audio.play(clipId, opts)`, `Audio.setBus(name, level)`, `Audio.bgm.fade(...)`.

### 1.9 Audio Analysis (`audio/reactive`)
- **Owns:** FFT analyser node tap, frequency-band aggregation (sub/bass/mid/high), beat detector, smoothed parameter streams.
- **Does not own:** any visual material.
- **Public surface:** events (`MUSIC_BEAT`, `BASS_PEAK`) + a streams object: `Reactive.bands.bass.value`, `Reactive.bands.bass.smoothed`.

### 1.10 Music-Reactive Controllers (`vfx/reactive`)
- **Owns:** the *mapping* from audio signals to visual parameters (e.g., bass peak → bloom intensity, beat → ambient particle pulse). Pure plumbing layer.
- **Does not own:** signal extraction or shader code itself.
- **Public surface:** declarative bindings: `bind(Reactive.bands.bass.smoothed, MaterialUniform('glassEmissive', 0..1.5))`.

### 1.11 UI Framework (`ui/`)
- **Owns:** HUD elements (mini-piece previews, score panel, level callout, game-over screen, audio toggle, brand header, help panel). Tweaks panel as a single React mount.
- **Does not own:** game state; it consumes snapshots and events.
- **Public surface:** React components + `UI.mount(root, store)`. The CSS3D 3D HUD elements are a separate `ui/3d` submodule with the same contract.

### 1.12 Post-Processing (`rendering/post`)
- **Owns:** the composer pass chain, vignette/bloom/SMAA configuration, luma/exposure tweens, "punch" and "slow-mo" frame effects.
- **Does not own:** *when* a punch fires.

### 1.13 VFX Event Bus / Message Hub (`shared/events`)
- **Owns:** topic registry, typed publish/subscribe, replay buffer for late subscribers, debug recorder.
- **Does not own:** any domain logic. Strictly a transport.

### 1.14 Resource Manager (`shared/assets`)
- **Owns:** texture/audio/shader loading, decode, caching, hot-reload. Single async load graph at boot.
- **Public surface:** `await Assets.load(manifest)`, `Assets.tex('sparkle')`, `Assets.audio('ultrakill')`.

### 1.15 Timing / Scheduler (`shared/time`)
- **Owns:** the *single* `requestAnimationFrame` driver, fixed-timestep gameplay tick (e.g., 60 Hz), variable-timestep render tick, slow-mo / pause time scaling, frame-budget instrumentation.
- **Public surface:** `Clock.onFixedTick(fn)`, `Clock.onRenderTick(fn)`. Replaces today's single tangled `animate()` ([tetris.html:3090-3336](../project/tetris.html#L3090-L3336)).

### 1.16 State Machine (`gameplay/fsm` and `app/fsm`)
- Two distinct FSMs: **app-level** (`Boot → MainMenu → Playing → Paused → GameOver`) and **gameplay-level** (`Spawn → Falling → Locking → ClearAnim → Spawn`). Today both are implicit in scattered booleans.

### 1.17 Tweaks / Config (`config/`)
- **Owns:** the live-editable parameter graph and persistence. The current `postMessage` protocol becomes one of N possible transports (also: query string, localStorage).
- **Public surface:** `Config.get(key)`, `Config.subscribe(key, fn)`. Anyone reading config goes through this — no more reading globals at module scope.

---

## 2. Architectural Boundaries

The single rule: **gameplay code never references rendering, audio, or VFX directly**. Today, [`hardDrop`](../project/tetris.html#L1989-L1990) calls `triggerImpactRing(...)` directly. That is the canonical violation. It needs to become:

```
// gameplay/movement.ts
events.emit('HARD_DROP', { column, row, color });
```

…and the impact ring lives in a VFX listener that has no idea what `hardDrop` is.

### 2.1 Event Taxonomy

Three layers of events. Layer is identified by prefix.

**Gameplay events** — emitted by `gameplay/`, consumed by everyone else.
| Event | Payload | Emitted from |
|-------|---------|--------------|
| `PIECE_SPAWN` | `{ type, rotation, origin }` | spawner |
| `PIECE_MOVE` | `{ dx, dy }` | movement |
| `PIECE_ROTATE` | `{ rotation, kicked: boolean }` | rotation |
| `PIECE_LOCK` | `{ cells: Cell[] }` | lock |
| `HARD_DROP` | `{ column, dropDistance, color }` | hard drop |
| `LINE_CLEAR` | `{ rows: number[], colors: hex[], simultaneous: 1..4 }` | clear detection |
| `COMBO_START` / `COMBO_END` | `{ count }` | clear pipeline |
| `LEVEL_UP` | `{ level }` | scoring |
| `GAME_OVER` | `{ score, lines, level }` | rules |
| `SCORE_DELTA` | `{ delta, source }` | scoring |

**Music / reactive events** — emitted by `audio/reactive`.
| Event | Payload |
|-------|---------|
| `MUSIC_BEAT` | `{ bpm, confidence, t }` |
| `BASS_PEAK` | `{ amplitude }` |
| `BAND_FRAME` | `{ sub, bass, mid, high }` (every frame, may be skipped if no listeners) |

**Cinematic / render events** — emitted by gameplay listeners (the *translation* layer), consumed by camera and post-processing.
| Event | Payload |
|-------|---------|
| `CAMERA_IMPACT` | `{ magnitude, axis, decayMs }` |
| `PUNCH_ZOOM` | `{ amount, durationMs }` |
| `SLOW_MO` | `{ scale, durationMs }` |
| `FLASH` | `{ color, intensity, decayMs }` |
| `ATTENTION_DIM` | `{ amount, durationMs }` |

### 2.2 Translation Layer

Gameplay never emits `CAMERA_IMPACT` directly — that is a presentational decision. A small **director** module (`vfx/director.ts`) subscribes to gameplay events and decides what cinematic events to fire:

```
on('LINE_CLEAR', (e) => {
  if (e.rows.length === 4) {
    emit('CAMERA_IMPACT', { magnitude: 1.4, axis: 'y', decayMs: 600 });
    emit('SLOW_MO',       { scale: 0.35, durationMs: 220 });
    emit('FLASH',         { color: 0xffffff, intensity: 0.6, decayMs: 400 });
  }
});
```

This is the central insight: **gameplay describes the world, the director describes the show**. Tuning combat-feel becomes editing one file. Today this logic is sprinkled across [tetris.html:3019-3089](../project/tetris.html#L3019-L3089).

### 2.3 Decoupling Mechanics

- **Bus** is synchronous, single-threaded, in-process. No reason for queues — JS is single-threaded.
- **Late subscribers** receive a small replay (last N events per topic) so the UI can boot mid-game.
- **No request-response over the bus.** It is fire-and-forget; if you need a value, query the source system's read API.
- **No payload mutation** after publish; payloads are frozen objects.
- **Debug recorder** snapshots the last 30 s of events for replay during bug repro.

---

## 3. Rendering Architecture

### 3.1 Layered Frame Graph

```
┌──────────────────────────────────────────────────────────────┐
│ Frame                                                        │
│                                                              │
│   1. Geometry pass     (opaque world: glass case, board)     │
│   2. Effects pass      (additive: sparkles, shards, ambient) │
│   3. Transparent pass  (sorted: glass cubes, veil overlay)   │
│   4. Post-processing   (bloom → vignette → SMAA → output)    │
│   5. CSS3D pass        (HUD anchored in 3D)                  │
│   6. UI overlay        (DOM HUD: score, callouts)            │
│   7. Debug pass        (gizmos, on-toggle only)              │
└──────────────────────────────────────────────────────────────┘
```

Today all of this is implicit in the order things were added to one scene. Make the order explicit via named layers, each with its own scene root and submission API:

```
const layers = {
  world:       new RenderLayer({ scene: worldScene,    sortMode: 'opaque' }),
  fx:          new RenderLayer({ scene: fxScene,       sortMode: 'additive' }),
  transparent: new RenderLayer({ scene: glassScene,    sortMode: 'back-to-front' }),
  hud3d:       new RenderLayer({ renderer: cssRenderer }),
};
```

Each subsystem registers meshes only into its own layer. The renderer composes layers in a fixed order; reordering becomes a config change.

### 3.2 Render Contexts

A `RenderContext` is the read-only bundle handed to a layer's render call: `{ camera, viewport, time, renderer, frame }`. Layers must not reach for globals; everything they need is in the context. This is the boundary that lets us later add a second view (e.g. minimap, replay viewer) without rewriting layers.

### 3.3 Separation of Concerns

| Concept | Layer | Owner |
|---|---|---|
| World rendering | geometry + transparent | `world/` |
| Effect rendering | fx | `vfx/` |
| Gameplay visualization | world (board view) | `world/board-view` |
| Atmospheric rendering | fx (ambient field) + post (vignette/bloom) | `vfx/ambient`, `rendering/post` |

The **world layer never knows about effects**. The **fx layer never reads gameplay state directly** — only events.

### 3.4 Frame Graph Notes

For now, a fixed pipeline is fine. We do *not* need a Vulkan-style data-driven frame graph; the win is just that the pass order is named and configured in one place ([rendering/pipeline.ts]) instead of implied by mesh creation order in a 4,000-line file. If we later add deferred shading or screen-space reflections, the abstraction is ready.

---

## 4. Gameplay Core Isolation

The litmus test: **`gameplay/` must run under Node with no DOM, no `THREE`, no `AudioContext`**. If the test suite can't `import { Game } from '../gameplay'` and step the simulation, isolation has failed.

### 4.1 Public Surface (final)

```ts
class Game {
  constructor(opts: { seed: number; rules?: RulesetConfig });
  tick(dtMs: number, input: InputFrame): void;
  snapshot(): Readonly<BoardSnapshot>;   // for views
  events: EventStream<GameplayEvent>;     // for everyone else
  serialize(): GameSaveBlob;              // for replays/saves
  restore(blob: GameSaveBlob): void;
}
```

That's it. No setters, no callbacks, no globals, no `THREE` types crossing the boundary. Colors travel as hex `0xRRGGBB`, not `THREE.Color`.

### 4.2 Determinism

- Seeded RNG (`shared/random`) for the bag.
- All time-dependent behavior driven by `dtMs` parameter, never `performance.now()` inside the core.
- No `Math.random()` allowed — lint rule.

Determinism means: replay support, easy bug repro, deterministic tests, and a future "ghost piece preview" / lookahead AI feature.

### 4.3 Migration of Globals

The globals at [tetris.html:1472-1759](../project/tetris.html#L1472-L1759) (`board`, `activePiece`, `score`, `lines`, `level`, `gameOver`, `paused`, `nextQueue`, `holdPiece`) become private fields on `Game`. The mesh maps (`cellMeshes[]`, `stackGroup`, `pieceGroup`, `ghostGroup`) move to `world/board-view` because they are *not* gameplay state — they are visualization caches.

---

## 5. Effects Architecture

### 5.1 Effect Categories

| Category | Trigger | Examples (today) | Lifetime |
|----------|---------|------------------|----------|
| Gameplay VFX | gameplay event | shatter shards, line-clear sparkle ring, hard-drop dust ring | sub-second |
| Ambient VFX | always-on | 500-particle drift field | infinite |
| Cinematic VFX | director event | flash, shockwave, attention dim, slow-mo | sub-second |
| Music-reactive VFX | reactive stream | bass-driven bloom pulse, beat-driven cube glow | continuous |
| UI VFX | UI event | score popups, panel jitter, level-up callout | sub-second |

Each category is a separate file under `vfx/`. They share the same emitter primitives but are triggered by disjoint event sources.

### 5.2 Pooled Emitter API

```ts
type Emitter = {
  spawn(params: SpawnParams): void;
  update(dt: number): void;
  group: Object3D;
  capacity: number;       // pool size
  active: number;         // live count
};

const emitters = registerEmitters({
  shatter:    instancedShardEmitter({ capacity: 2000, material: shardMaterial }),
  sparkle:    instancedSparkleEmitter({ capacity: 2000, material: sparkleMaterial }),
  ambient:    cpuBillboardEmitter({ capacity: 500, material: ambientMaterial }),
  veil:       overlayPlaneEmitter(),
  shockwave:  ringEmitter(),
});
```

Each emitter:
- **Allocates buffers up-front** (no per-frame allocation).
- **Tracks free slots** (the existing free-slot allocator at [tetris.html:811-1104](../project/tetris.html#L811-L1104) generalizes here).
- **Writes only the dirty range** of `InstancedBufferAttribute`s each frame.
- **Auto-frees** on lifetime expiry without touching the GC.

### 5.3 Effect Presets

Authoring an effect should be data, not code. A preset is JSON-ish:

```ts
const HARD_DROP_DUST: Preset = {
  emitter: 'sparkle',
  count: 24,
  lifetimeMs: 320,
  velocity:    { mode: 'cone', axis: [0,1,0], halfAngleDeg: 70, speed: [3, 6] },
  size:        { start: 0.1, end: 0.0 },
  alpha:       { start: 0.9, end: 0.0, curve: 'easeOutQuad' },
  colorFrom:   'paramColor',  // resolved at spawn from event payload
};
```

Then the gameplay listener is one line:

```
on('HARD_DROP', e => VFX.spawn(HARD_DROP_DUST, { paramColor: e.color, position: e.impactXY }));
```

### 5.4 Layered Composition

A high-impact event ("tetris" line clear) composes multiple presets in a director:

```
director.scene('TETRIS_CLEAR', {
  presets: [SHATTER_BURST, CLEAR_RING, HORIZON_FLASH, BLOOM_PUNCH],
  staggerMs: [0, 60, 0, 100],
});
```

### 5.5 Update / Cull / Render

- **Update**: `Clock.onRenderTick` advances all active emitters with the same `dt`. CPU-driven emitters compute new attribute ranges; GPU-driven emitters write uniforms (time, emitTime arrays).
- **Cull**: each emitter exposes a bounding sphere; renderer skips passes for empty pools. (Camera is always close to the play volume here, so frustum culling for emitters is low-priority right now — flagged in §8 as deferred.)
- **Render**: emitters' meshes live in the `fx` layer scene, drawn in pass 2. They never enter the world or transparent layers.

---

## 6. Audio-Reactive System

### 6.1 Layer Cake

```
[ HTMLAudio source ]
       │
       ▼
[ AudioContext + AnalyserNode ]      ← audio/playback
       │     (raw FFT bins, time-domain)
       ▼
[ Frequency band aggregator ]        ← audio/reactive
       │     (sub, bass, mid, high; smoothed + raw)
       ▼
[ Beat detector ]                    ← audio/reactive
       │     (BPM estimate, peak detector with refractory)
       ▼
[ Reactive event bus + streams ]     ← audio/reactive (public)
       │
       ▼
[ Reactive controllers ]             ← vfx/reactive
       │     (declarative bindings: stream → uniform)
       ▼
[ Materials / camera / post ]
```

### 6.2 No Direct Shader Manipulation

The forbidden pattern:

```
// in audio analyser
glassMaterial.uniforms.uBassPulse.value = bandEnergy.bass;   // ✗
```

The required pattern:

```
// audio side: just publishes
reactive.bands.bass.write(energy);

// vfx/reactive side: declares the binding once at boot
bind(reactive.bands.bass.smoothed(150 /*ms attack*/, 400 /*ms decay*/),
     MaterialUniform(glassMaterial, 'uBassPulse', { range: [0, 1.5] }));
```

The audio system has no `THREE` import. The binding layer is the only place that knows both ends exist.

### 6.3 Smoothed Streams

Each band exposes:
- `value` — current frame's raw value
- `smoothed(attackMs, decayMs)` — asymmetric one-pole filter, returns a derived stream
- `peaks(threshold, refractoryMs)` — emits discrete peak events

These are stream primitives. Reactive controllers compose them; audio analysis doesn't bake in a particular smoothing curve.

### 6.4 Beat Events

`MUSIC_BEAT` carries `{ bpm, confidence, t, phase }`. Subscribers can choose to act only on `confidence > 0.7` beats. Today there is no beat detection — it is a green-field add and should not be allowed to creep into gameplay (a beat is a presentational signal, not a rule).

---

## 7. Project Structure

Move to a real bundler (Vite). Convert the inline `<script>` into ES modules. Shaders as `*.glsl` imported with `?raw`. TypeScript optional but recommended for the `gameplay/` core (it's the most logic-dense module).

```
TetrisPlus/
├─ project/
│  ├─ index.html                  ← thin shell, mounts <App/>
│  └─ src/
│     ├─ app/
│     │  ├─ main.ts               ← composition root
│     │  ├─ fsm.ts                ← Boot/Menu/Playing/Paused/Over
│     │  └─ wiring.ts             ← bus wiring; gameplay→director→VFX
│     │
│     ├─ engine/                  ← framework code, game-agnostic
│     │  ├─ time/
│     │  │  ├─ clock.ts           ← single rAF; fixed + render ticks
│     │  │  └─ slowmo.ts
│     │  ├─ events/
│     │  │  ├─ bus.ts
│     │  │  └─ recorder.ts
│     │  ├─ assets/
│     │  │  ├─ loader.ts
│     │  │  └─ manifest.ts
│     │  └─ random/
│     │     └─ seeded.ts
│     │
│     ├─ gameplay/                ← pure simulation (no THREE, no DOM)
│     │  ├─ game.ts               ← public Game class
│     │  ├─ board.ts
│     │  ├─ piece.ts
│     │  ├─ rotation.ts           ← kick tables
│     │  ├─ scoring.ts
│     │  ├─ rules.ts              ← config: gravity curve, lock delay
│     │  └─ events.ts             ← gameplay event types
│     │
│     ├─ rendering/
│     │  ├─ pipeline.ts           ← frame graph, layer composer
│     │  ├─ layers/
│     │  │  ├─ world-layer.ts
│     │  │  ├─ fx-layer.ts
│     │  │  ├─ transparent-layer.ts
│     │  │  └─ hud3d-layer.ts
│     │  ├─ post/
│     │  │  ├─ composer.ts
│     │  │  ├─ bloom.ts
│     │  │  ├─ vignette.ts
│     │  │  └─ smaa.ts
│     │  ├─ context.ts            ← RenderContext type
│     │  └─ debug-pass.ts
│     │
│     ├─ world/
│     │  ├─ board-view.ts         ← reconciles BoardSnapshot → meshes
│     │  ├─ piece-view.ts
│     │  ├─ ghost-view.ts
│     │  ├─ glass-case.ts         ← walls, frame, back grid, floor
│     │  └─ environment.ts
│     │
│     ├─ camera/
│     │  ├─ camera-rig.ts
│     │  ├─ orbit.ts
│     │  └─ shake.ts
│     │
│     ├─ materials/
│     │  ├─ glass.ts
│     │  ├─ cube-core.ts
│     │  ├─ shard.ts
│     │  ├─ sparkle.ts
│     │  └─ ambient.ts
│     │
│     ├─ shaders/                 ← raw GLSL only
│     │  ├─ glass.vert.glsl
│     │  ├─ glass.frag.glsl
│     │  ├─ vignette.frag.glsl
│     │  ├─ sparkle.vert.glsl
│     │  ├─ sparkle.frag.glsl
│     │  ├─ shard.vert.glsl
│     │  ├─ shard.frag.glsl
│     │  └─ ambient.frag.glsl
│     │
│     ├─ vfx/
│     │  ├─ director.ts           ← gameplay → cinematic translation
│     │  ├─ presets/
│     │  │  ├─ hard-drop.ts
│     │  │  ├─ line-clear.ts
│     │  │  ├─ tetris-clear.ts
│     │  │  └─ ambient.ts
│     │  ├─ emitters/
│     │  │  ├─ instanced-shards.ts
│     │  │  ├─ instanced-sparkle.ts
│     │  │  ├─ cpu-billboards.ts
│     │  │  ├─ ring.ts
│     │  │  └─ veil.ts
│     │  ├─ pool.ts
│     │  └─ reactive/
│     │     └─ bindings.ts        ← stream → uniform plumbing
│     │
│     ├─ audio/
│     │  ├─ playback.ts           ← AudioContext, buffers, BGM
│     │  ├─ buses.ts              ← master/music/sfx/voice
│     │  └─ reactive/
│     │     ├─ analyser.ts
│     │     ├─ bands.ts
│     │     ├─ beat.ts
│     │     └─ streams.ts
│     │
│     ├─ ui/
│     │  ├─ App.tsx               ← React root
│     │  ├─ HUD/
│     │  │  ├─ ScorePanel.tsx
│     │  │  ├─ NextQueue.tsx
│     │  │  ├─ HoldPanel.tsx
│     │  │  ├─ Callouts.tsx       ← level-up, line-clear text
│     │  │  └─ AudioToggle.tsx
│     │  ├─ tweaks/
│     │  │  └─ TweaksPanel.tsx    ← real home of tweaks-panel.jsx
│     │  ├─ menu/
│     │  │  ├─ MainMenu.tsx
│     │  │  └─ GameOver.tsx
│     │  └─ store.ts              ← read-only view of Game.snapshot
│     │
│     ├─ input/
│     │  ├─ keyboard.ts
│     │  ├─ gamepad.ts
│     │  ├─ das-arr.ts
│     │  └─ intents.ts            ← InputFrame for Game.tick
│     │
│     ├─ config/
│     │  ├─ tweaks.ts             ← live config registry
│     │  ├─ persistence.ts        ← localStorage / postMessage transport
│     │  └─ moods.ts              ← preset bundles (today's mood presets)
│     │
│     └─ shared/
│        ├─ math.ts
│        ├─ color.ts
│        ├─ types.ts
│        └─ debug.ts
│
├─ assets/
│  ├─ sounds/                     ← already exists at project/asset/sounds
│  │  ├─ bgm_vaporwave.m4a
│  │  ├─ ultrakill.wav … (announcer pack)
│  │  └─ …
│  └─ textures/
│
├─ document/                      ← existing planning docs, this file
└─ tools/
   └─ shader-watch.ts             ← reload .glsl in dev
```

### 7.1 Dependency Direction (one-way arrows only)

```
                ┌──────────┐
                │  app     │
                └────┬─────┘
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   ┌────────┐  ┌──────────┐  ┌─────────┐
   │ ui     │  │ gameplay │  │ engine  │ ← time, events, assets, rng
   └────┬───┘  └────┬─────┘  └────┬────┘
        │           │              │
        ▼           │              │
    (events) ◄──────┘              │
        ▲                          │
        │                          │
   ┌────┴─────┐  ┌──────────┐  ┌──────────┐
   │ vfx      │  │ camera   │  │ audio    │
   └────┬─────┘  └────┬─────┘  └─────┬────┘
        │              │             │
        ▼              ▼             │
   ┌──────────────────────────┐      │
   │ rendering / world / ...  │◄─────┘
   └──────────────────────────┘
```

### 7.2 Import Restrictions (enforce with eslint `no-restricted-imports` or a custom rule)

- `gameplay/**` may import from: `engine/**`, `shared/**`. Nothing else. **No `three`, no DOM, no React.**
- `audio/**` may import from: `engine/**`, `shared/**`. **No `three`, no React.**
- `world/**`, `camera/**`, `materials/**`, `vfx/**` may import `three`.
- `ui/**` may import React, may *read* `gameplay` snapshots through `ui/store`, may *not* import `gameplay` mutators.
- `rendering/**` may not import `gameplay`.
- `shaders/**` is leaf — imports nothing.

### 7.3 Ownership Rules

- One module owns each piece of state. `score` is owned by `gameplay/scoring.ts`. `score` is *read* by `ui/store.ts` and `vfx/director.ts` via snapshots/events.
- A module's `index.ts` is its public face. If a file isn't re-exported, it isn't part of the API.

---

## 8. Technical Debt Reduction

### 8.1 Bloat Patterns Already Present (or about to be)

| Pattern | Where | Untangle by |
|---|---|---|
| **God file** | [tetris.html](../project/tetris.html) does everything | extract subsystems incrementally — see §9 |
| **Parallel dead implementation** | [game.js](../project/game.js) | delete in PR #1 |
| **Duplicate UI implementations** | [tweaks-panel.jsx](../project/tweaks-panel.jsx) (React) and [tetris.html:3727-4213](../project/tetris.html#L3727-L4213) (vanilla JS) | adopt one; delete the other |
| **Hidden mutable state** | module-scope `board`, `score`, `level`, `activePiece`, `paused`, `gameOver` | encapsulate in `Game` class |
| **Cross-system reach** | `hardDrop()` calls `triggerImpactRing` directly ([tetris.html:1989-1990](../project/tetris.html#L1989-L1990)); audio plays from inside line-clear handler | event bus + director |
| **Inline shader strings** | [tetris.html:1248-1274](../project/tetris.html#L1248-L1274) glass shaders, vignette, sparkle, shard | move to `shaders/*.glsl` with `?raw` |
| **Update-loop chaos** | one `animate()` ([tetris.html:3090-3336](../project/tetris.html#L3090-L3336)) does physics, particles, UI, audio reactivity, camera, render | split into `Clock.onFixedTick` / `onRenderTick`; each subsystem registers its own update |
| **Shader sprawl risk** | as more music-reactive shaders are added, copy-paste of fresnel boilerplate is likely | shader chunks via `THREE.ShaderChunk` registry, or a single `glassBase.glsl` import |
| **Effect logic duplicated** | sparkle and shard pools each implement free-slot allocation independently | unify under `vfx/pool.ts` |
| **Tweaks coupling** | tweaks read directly from globals via vanilla panel | route through `Config.subscribe` only |

### 8.2 Untangling Principles

1. **No big-bang rewrite.** Tetris.html keeps running through every PR. (See §9.)
2. **One subsystem per PR.** Each PR introduces a new module and *replaces* its inline equivalent in `tetris.html` with an import. `tetris.html` shrinks monotonically.
3. **No new code in `tetris.html` after step 1.** Even before subsystems are extracted, new features go into modules.
4. **Lints enforce boundaries from day one.** Add `no-restricted-imports` rules as each module is created. The wall goes up as the building goes up.
5. **Shaders out before rendering split.** Shader extraction is the lowest-risk first move (text → text) and unlocks hot-reload, which makes the remaining work faster.
6. **Performance work is forbidden during the refactor.** Tempting and dangerous; conflates two changes. After the architecture is in, then optimize.

---

## 9. Implementation Strategy (Step-by-Step)

Each step ends with a green build and a playable game. No step requires more than ~1 day of focused work.

### Step 0 — Hygiene (½ day)
- Delete [`project/game.js`](../project/game.js). (Confirm with user; it has zero imports.)
- Decide: adopt `tweaks-panel.jsx` *or* delete it. Recommend keeping the React version, because step 9 ports the panel to React anyway.
- Add Vite. Convert `tetris.html` from inline `<script>` to `<script type="module" src="./src/main.ts"></script>`. Cut/paste the entire current script into `src/main.ts`. **No logic change.** Build runs, game plays.
- Add ESLint with `no-restricted-imports` set up but rules empty.
- Add Vitest.

### Step 1 — Engine primitives (1 day)
- Create `engine/events/bus.ts`, `engine/time/clock.ts`, `engine/random/seeded.ts`.
- `Clock` now drives the existing `animate()` — move the `requestAnimationFrame` call into `Clock`. `animate()` becomes `Clock.onRenderTick(animate)`.
- No bus subscribers yet; system is staged.

### Step 2 — Extract Gameplay Core (2 days)
- New `gameplay/` directory. Pull the board/piece/rotation/scoring/lock logic out of `main.ts` into `gameplay/game.ts`.
- Replace each direct call to a side-effect (`triggerImpactRing`, `playSound`, `triggerFlash`) with `events.emit(...)`.
- Add temporary listeners in `main.ts` that translate events back into the existing inline functions, so behavior is identical.
- Write Vitest cases: spawn → fall → lock → clear → score deltas. **This is where determinism pays off immediately.**
- Lint rule: `gameplay/**` may not import `three`.

### Step 3 — VFX Director + Pool (1 day)
- Create `vfx/director.ts`, subscribe to gameplay events. Move the translation logic from the temporary listeners.
- Create `vfx/pool.ts` and refactor the existing sparkle/shard allocators ([tetris.html:811-1104](../project/tetris.html#L811-L1104), [tetris.html:1919-2166](../project/tetris.html#L1919-L2166)) onto the unified pool. *No visual change*, just shared allocator.
- Convert today's effects to presets in `vfx/presets/`.

### Step 4 — Rendering Pipeline (1.5 days)
- Extract renderer construction, composer setup, lights into `rendering/pipeline.ts`.
- Introduce layers (world / fx / transparent / hud3d). Move existing meshes into the right layer scene.
- Composer pass chain into `rendering/post/`.
- Shaders out to `shaders/*.glsl` with `?raw` import. Hot-reload via Vite.

### Step 5 — World Views (1 day)
- `world/board-view.ts` consumes `Game.snapshot()` and reconciles meshes. Replace today's `cellMeshes[]` direct mutation.
- `world/glass-case.ts`, `world/piece-view.ts`, `world/ghost-view.ts`.

### Step 6 — Audio Split (1 day)
- `audio/playback.ts` (AudioContext + buffers) — straightforward extraction.
- `audio/reactive/{analyser,bands,beat,streams}.ts` — analyser node tap, frequency bands, beat detector.
- `vfx/reactive/bindings.ts` — declarative stream-to-uniform bindings.
- Remove all direct audio→shader writes.

### Step 7 — Camera & Cinematics (½ day)
- `camera/` extraction. Camera shake becomes a subscriber to `CAMERA_IMPACT`.
- Punch-zoom, slow-mo, flash become director-published events with composable handlers.

### Step 8 — Update Loop Sanity (½ day)
- Audit every system: it must register its update via `Clock.onFixedTick` or `Clock.onRenderTick`. The single inline `animate()` ([tetris.html:3090-3336](../project/tetris.html#L3090-L3336)) is now empty and gone.
- Add per-system frame-time instrumentation, exposed via debug overlay.

### Step 9 — UI Migration (1 day)
- React mount. Port `tetris.html`'s HUD CSS + DOM into `ui/HUD/*`.
- Mount `TweaksPanel.tsx` (the existing JSX), but replace the `postMessage` plumbing with direct `Config.subscribe`. Keep `postMessage` as one transport for the host editor compatibility.

### Step 10 — Tooling (½ day)
- Debug overlay: subsystem frame times, event log tail, emitter pool occupancy.
- Replay recorder: dump 30 s of inputs + seed; replay deterministically.
- Shader hot-reload toast.

**Total estimated effort:** ~10 working days, fully incremental, every checkpoint shippable. No "rewrite weekend" — that's the trap.

### 9.1 Migration Safety Net

- A snapshot test renders one game frame to a `data:` URL after a fixed input sequence and pixel-diffs against a baseline. Catches accidental visual regressions during extraction.
- A "before each step, the game still plays" smoke test recorded with the replay recorder from step 10 (added later, but runnable retroactively).

---

## 10. Final Architectural Principles

These are the rules to staple to the wall. When in doubt, default to them.

### 10.1 Architectural Rules
1. **Gameplay has no graphics.** `gameplay/` imports neither `three` nor the DOM. Period.
2. **Events flow up, snapshots flow down.** Gameplay emits events and exposes a read-only snapshot. Visual layers subscribe and reconcile. Never the reverse.
3. **One owner per piece of state.** If two modules can write to it, one is wrong.
4. **Update is centralized, work is distributed.** One clock, many subscribers. No subsystem starts its own `requestAnimationFrame`.
5. **Shaders are assets, not strings.** GLSL files, hot-reloadable, testable in isolation.
6. **Pools, not allocations.** Particle counts are budgeted at boot; no `new Vector3()` in a hot path.
7. **Presets, not procedures.** A new effect is a JSON-shaped data file plus, if needed, a one-line listener — never a new copy of the emitter loop.
8. **The director is one file.** All "which gameplay event triggers which presentational thing" lives in `vfx/director.ts`. Game-feel tuning happens there.

### 10.2 Dependency Philosophy
- **Layered, not webbed.** Higher layers may know about lower layers; lower layers may not look up. The bus is the only sanctioned way to talk *across* siblings.
- **Imports are public API.** A module's `index.ts` is its contract. Anything not exported from there is private. Lint enforces.
- **No module imports more than ~5 other modules.** When it does, it's a god object. Split it.

### 10.3 Communication Patterns
- **Events for "something happened."** One-shot, fire-and-forget, async-feel. Examples: `LINE_CLEAR`, `MUSIC_BEAT`.
- **Streams for continuous signals.** Sampled per-frame, smoothable, composable. Examples: `bands.bass.smoothed`.
- **Snapshots for "what is the current state?"** Pulled on demand, never mutated by the consumer. Examples: `Game.snapshot()`, `Config.get()`.
- **Direct calls for synchronous control.** When module A *owns* B, A calls B's functions. When A doesn't own B, use events.

### 10.4 Scalability Principles
- **New gameplay rules touch only `gameplay/`.** If a rule change forces a render change, the rule was modeling a presentational concern.
- **New visual flourishes touch only `vfx/` and possibly `materials/`.** A new sparkle shape requires zero gameplay edits.
- **New camera moods touch only `camera/`.** Punch-zoom, parallax, dolly — all live as composable `CameraImpulse` subscribers.
- **New input devices touch only `input/`.** Gamepad, touch, MIDI — same `InputFrame` output.
- **Each system should be replaceable.** Swap WebGL for WebGPU, Three.js for a custom renderer, React for Solid — each touches its own folder.

### 10.5 Keeping Experimental Visuals Manageable
This is the honest hardest one for a graphics-heavy passion project — features like a single-shader audio-reactive haze look "small" when prototyped and *will* tempt you to add them inline.
- **Every new visual experiment lands as a preset, not a patch.** A preset is a file in `vfx/presets/` (or a new shader pair in `shaders/`) plus one wiring line in `vfx/director.ts` or `vfx/reactive/bindings.ts`. If the experiment doesn't fit that shape, it's not ready to land.
- **Quarantine the speculative.** New experimental modules go under `vfx/experimental/` with a known retention policy: promote within 30 days or delete. The current `game.js` is what happens without this rule.
- **Mood / Tweak presets are first-class.** Shipping a "vaporwave dusk" mood is a JSON-ish preset bundle, not a fork of the renderer. Today's mood presets ([tetris.html:365-485](../project/tetris.html#L365-L485)) already proved this works — the structure just needs to graduate from "object literal in main file" to "registry under `config/moods.ts`".
- **Prefer composition over forks.** When a new effect feels like it needs its own everything, ask why the existing emitter primitive isn't enough. Usually it is.
- **Performance budget is per-subsystem, visible always.** A 16ms frame budget split across world / fx / post / UI prevents one system silently eating the headroom for the next experiment.

---

## Appendix A — Concrete First PRs

If the team wants to ship the first three PRs this week:

1. **PR-1: Hygiene.** Delete `game.js`, decide tweaks-panel ownership, add Vite + ESLint + Vitest, convert inline script to `src/main.ts`. Zero behavior change. ~½ day.
2. **PR-2: Event bus + clock.** Land `engine/events/bus.ts` and `engine/time/clock.ts`. Wrap the existing `animate()` in `Clock.onRenderTick`. Still zero behavior change. ~1 day.
3. **PR-3: Extract gameplay core.** `gameplay/game.ts` with the board/piece/rotation/scoring logic, replacing inline calls to side-effects with events emitted on the bus. Temporary translation listeners in `main.ts` keep visuals identical. Vitest covers the rules engine. **This is the inflection-point PR** — after it, every subsequent change is local. ~2 days.

After PR-3, the rest of §9 is unblocked and can run in parallel across contributors.
