# Tetris+ Gameplay Plan v2 — Post-§12 Forward Roadmap

**Date:** 2026-05-09 · **Test surface:** 924 tests across 52 files (all green) ·
**Predecessor:** `document/archived/plan_gameplay_1.md` (preserved for the
full design rationale, mode-by-mode specs, and shipped-implementation
notes). v2 picks up where v1 left off.

**Status:** all four §1 polish items (1.1 Stats UI surfacing, 1.2 VFX
celebration recipes, 1.3 Garbage drain flash, 1.4 In-run B2B/combo
chips) ✅ shipped on main; the §2.3 Pure Physics chapter — including
the Force-Physics rework (Phases G/H/J/I plus the K fold-in) — also ✅
shipped, with playtest tuning (Phase L) as the only remaining
follow-up. v2 now spans only the speculative chapters (§2.1 3D
Tetris, §2.2 Online Versus), gated behind the 30-day
promote-or-delete culture.

---

## 0. Where we are

### 0.1 Shipped (the architectural floor)

Everything below is live on `main`. Features cite the v1 section that
specified them; v2 won't redesign these, only build on top.

| Capability | v1 ref | Notes |
|---|---|---|
| Six standard modes — Classic / Marathon / Sprint / Ultra / Zen / Versus | §3.1–§3.6 | Each plays its own rules pack via the rules engine. |
| Rules engine (`gameplay/rules.js` + per-mode packs) | §2.1 | Pure pluggable behaviors; `lineScore` / `endCondition` / `onLinesCleared` / `onTick` hooks. |
| Mode lifecycle events (`MODE_START` / `MODE_END` / `MODE_GOAL_PROGRESS`) | §2.2 | Universal terminal contract; hosts wire ad-hoc lifecycle through here. |
| Mode tab UX + Stats schema renderer | Phases 7–8 | `ui/format/mode-stats.js` per-mode formatters. |
| **§3.7 Game container** — `Game` class, `BoardView`, `InputRouter`, `BotController`, `DualBoard`, `VersusSession`, seeded RNG, `Game.serialize`/`restore` | §3.7.1–§3.7.7 | All sub-phases 7a–7f shipped. |
| **Dual-board host integration** (Versus v2) | §3.7.7 7e | `VersusSession` wired into main.js: real second simulation, visible AI well, opponent shockwaves, KO camera focus, VICTORY/DEFEAT overlay, Bot Strength selector. |
| **§12 Modern Tetris Mechanics** — SRS wall kicks, T-spin detection + scoring, B2B chain + Perfect Clear, modern combo table, garbage cancellation + spawn-delay window | §12.5 M1–M5 | TETR.IO-baseline guideline behavior at the simulation level. |
| **§13 polish #1 — HUD callouts** | v1 §13 | `ui/modern-callouts.js` subscribes to T_SPIN / B2B_CHAIN / PERFECT_CLEAR / GARBAGE_CANCELLED and renders transient text overlays. |
| **§13 polish #2 — stats persistence** | v1 §13 | Per-run accumulators in `Game._runStats`; per-mode bests grow `bestB2bChain` / `bestCombo` / `perfectClears` / `tspinClears` / `bestGarbageCancelled`. |
| **Versus garbage queue clarity** | v2-discovered | Per-side queue columns ("INCOMING TO YOU" / "INCOMING TO BOT") with always-visible 8-slot track + per-pip readiness state (dim / pulsing / bright). |
| **§1 polish — Stats UI surfacing** | v2 §1.1 (`fdac17c`) | `formatModeBestModern()` formatter; Stats tab renders `bestB2bChain` / `bestCombo` / `perfectClears` / `tspinClears` / `bestGarbageCancelled` per mode. |
| **§1 polish — VFX celebration recipes** | v2 §1.2 (`d1a4104`) | LINE_CLEAR shockwave/envReaction recolor on §12 flags (PC gold > T-spin violet > Mini dim violet > B2B cyan); SFX cues for T_SPIN / B2B_CHAIN / PERFECT_CLEAR; camera shake on B2B chain ≥ 2 + PC. |
| **§1 polish — Garbage drain flash** | v2 §1.3 (`7553c72`) | One-shot CSS animation on the queue container — pink on GARBAGE_APPLIED, cyan on GARBAGE_CANCELLED. |
| **§1 polish — In-run chips** | v2 §1.4 (`c123529`) | `ui/modern-chips.js` — persistent top-left readout of "B2B ×N" + "Combo ×N" while streaks active; complements transient callouts. |
| **§2.3 Pure Physics — Phase A** | v2 §2.3 | `gameplay/experimental/physics/` scaffolding + rules pack (`buildPhysicsRules`, registered) + pure connected-component layer-detection algorithm. No Rapier dependency yet — phase A is the JS-only foundation that phases B–F will build on. 38 new tests. |
| **§2.3 Pure Physics — Phase B** | v2 §2.3 | `physics/world.js` Rapier-backed wrapper + `@dimforge/rapier3d-compat` runtime dep. Lazy `loadRapier()` factory, `createPhysicsWorld()` async constructor, `PhysicsWorld` class with addBody / step / getPositions / removeBody[s] / highestY / awakeCount / wakeAll / dispose. Default geometry: floor + side walls. Tested against real Rapier (no mocks). 20 new tests; all green. |
| **§2.3 Pure Physics — Phases C+D** | v2 §2.3 | `app/physics-session.js` integration glue: PhysicsSession class wraps Game + PhysicsWorld + detectLayers. Subscribes to PIECE_LOCK (cell→body, board-erase). Per-tick: world.step() → detectLayers → removeBodies → emit `PHYSICS_LAYER_CLEARED` (new event). Cumulative counters for HUD (layersClearedTotal, cubesClearedTotal). 18 new tests against real Rapier. |
| **§2.3 Pure Physics — Phase E** | v2 §2.3 | `physics` registered in `Mode.AVAILABLE` / LABELS / DESCRIPTIONS / CONFIG (with `isExperimental: true` flag). New `physics` slot in `STATS_DEFAULTS.modeBests` (`bestLayersCleared` / `totalLayersCleared`). Custom `updateBest` hook on the rules pack. New `ui/physics-badge.js` HUD module: live Cubes / Awake / Layers metrics with violet pulse on each PHYSICS_LAYER_CLEARED. Stats-tab formatter extended: physics primary = score; secondary = "best run N · M total layers". |
| **§2.3 Pure Physics — Phase F** | v2 §2.3 | `vfx/director.js` extended with a PHYSICS_LAYER_CLEARED subscriber: per-layer violet shockwave at the layer's centerY, sfx('physics-layer'), camera shake scaling with simultaneous count (0.3 / 0.5 / 0.7). Skips silently when host lacks lineClearLayers / sfx / shake wiring. 4 new tests. |
| **§2.3 Pure Physics — Phase F+** | v2 §2.3 | Render integration: `BoardView` gains `noLockMeshes` opt that gates PIECE_LOCK / LINE_CLEAR / GARBAGE_APPLIED / ZEN_RESCUE handlers. New `world/physics-board-view.js` parallel renderer that snapshots `world.getPositions()` per frame, creates a cube mesh per new body (color from `session.getBodyColor(id)`), updates positions to match physics, and disposes meshes for removed bodies (with optional shatter). PhysicsSession extended with `_bodyColors` map + `getBodyColor(id)` accessor. main.js Mode.start gains a `physics` branch that lazy-loads Rapier via `session.start()`, constructs BoardView with `noLockMeshes:true`, mounts PhysicsBoardView alongside, and wires `session.tick()` + `physicsView.tick()` into the animate loop. 16 new tests (5 PhysicsSession color tracking + 11 PhysicsBoardView). |
| **§2.3 Pure Physics — Force-Physics Phase G** | v2 §2.3.1 (`177a16d`) | `physics/world.js` extended for compound bodies + force API. `addCompoundBody(cells, opts) → bodyId` (N cuboid colliders attached to one rigid body); `applyImpulse` / `applyTorqueImpulse` / `setLinvel` / `isBodySleeping`; `removeCollider(colliderId)` (auto-removes parent body when its collider count hits 0); `getColliderPositions()` returning per-collider `{colliderId, bodyId, x, y, z, color}`; `getBodyRotation(bodyId)` for renderer-side quaternion sync. `addBody` is now a 1-cell convenience wrapper. 16 new tests. |
| **§2.3 Pure Physics — Force-Physics Phase H** | v2 §2.3.1 (`5557cd5`) | `app/physics-session.js` rewritten for the Force-Physics lifecycle. PIECE_LOCK subscription replaced with PIECE_SPAWN (the active piece IS a compound body from spawn). Game is paused for the run (its grid-gravity goes dormant). Force methods (`applyMove` / `applyRotate` / `applySoftDrop` / `applyHardDrop`) route to PhysicsWorld's force API. Lock detection: body sleeps OR (hard-drop armed AND speed below commit threshold) → commit + `game.spawnPiece()` to advance the bag. Force constants centralized in `_FORCE` export for tuning. `onEndRun` callback for topouts. Layer clear emits `removedColliderIds` for the renderer. 27 tests. |
| **§2.3 Pure Physics — Force-Physics Phase J** | v2 §2.3.1 (`f193170`) | `world/physics-board-view.js` reworked: meshes keyed by `colliderId` (not `bodyId`) so a compound tetromino renders as 4 cubes that move + rotate as a unit, and a partial layer clear removes only the cleared cubes while the parent body's survivors stay. Per-tick: snapshot `world.getColliderPositions()`, create / update mesh per collider, copy parent body's quaternion. Removed colliders trigger a 250ms dissolve (opacity 1→0, scale 1→1.10) instead of v1 shatter. 13 tests. |
| **§2.3 Pure Physics — Force-Physics Phase K** | v2 §2.3.1 (delivered via H + J) | Layer-clear-without-shatter wiring. PhysicsSession's per-tick layer detector calls `world.removeCollider(colliderId)` for each cleared collider (rather than removing whole bodies), preserving any partial-piece survivor as a smaller compound body. PhysicsBoardView's reconciler observes the missing colliderIds and starts the dissolve animation per-cube. No separate phase commit — the contract was small enough to fold into the H + J commits with full test coverage on both sides. |
| **§2.3 Pure Physics — Force-Physics Phase I** | v2 §2.3.1 (`bd86167`) | `app/main.js` input routing. `tryMove` / `tryRotate` / `softDrop` / `hardDrop` / `holdActive` all branch on `isPhysicsMode()`; in physics mode they route to `physicsSession.applyMove(±1)` / `applyRotate(±1)` / `applySoftDrop()` / `applyHardDrop()` respectively. Held down-arrow applies soft-drop force per tick. BoardView is skipped entirely in physics mode (the active piece is a body from spawn — there's no pre-lock pose to render via the grid path). PhysicsSession's `onEndRun` is wired to the host's `endRun()` so topouts trigger the gameover overlay + cascade. Hold (Shift / KeyC) is a no-op in physics mode (mid-flight body swap would feel like rubber-banding). |

### 0.2 Architectural property to preserve

`gameplay/` stays Three.js-free, DOM-free, AudioContext-free. Every
rule pack is pure JS that runs in Node tests without a Three.js or
DOM stub. The §3.7 extraction made this property cash-in: a
`Game` class that two simulations + the future network layer can
instantiate side-by-side.

This property held through Phases 1–8, §3.7, §12, and §13 polish.
It is the load-bearing principle of v2 too.

### 0.3 Test surface

924 tests across 52 files (all green at the Force-Physics-rework
landing). Each shipped feature carried its own test file under the
same directory (rules packs ship a `*.test.js` sibling; the §12
detector ships `t-spin.test.js`; §13 stats writer extends
`end-of-run.test.js`; the Force-Physics rework adds 16 PhysicsWorld
compound-body tests, 28 PhysicsSession lifecycle tests including the
soft-drop velocity-cap regression, and 13 PhysicsBoardView dissolve /
collider-keyed reconciler tests).

---

## 1. Open polish work (small, deliberate)

These are the items §13 explicitly named. v2 polish landed in four
commits on `main` (`fdac17c`, `d1a4104`, `7553c72`, `c123529`).
**All four §1 items are now ✅ shipped.**

### 1.1 Stats UI surfacing — ✅ shipped (`fdac17c`)

**Why.** Per-mode bests now persist `bestB2bChain` / `bestCombo` /
`perfectClears` / `tspinClears` / `bestGarbageCancelled`, but
nothing in the Stats tab actually displays them. Players can't see
their own progression in the modern-rules dimensions.

**What.** Extend `ui/format/mode-stats.js` (the per-mode formatters
that drive the Stats tab) to render the new slots:

| Mode | Existing display | New rows |
|---|---|---|
| Classic | Score / Lines / Level | + Best B2B chain · Perfect Clears · T-spin Clears |
| Marathon | + Completed · Best Time | (same modern-rules row) |
| Sprint | Best Time / Completed | + Best Combo |
| Ultra | Score / Lines / Level | (same modern-rules row) |
| Zen | Longest Session · Total Lines | (same modern-rules row) |
| Versus | Wins / Losses / Draws · ELO | + Best B2B chain · Perfect Clears · Best Cancelled |

**Scope.** Pure formatter changes. No settings-panel structural
work — the Stats tab already calls into `mode-stats.js`. ~15 lines
of formatter code per mode, 6 modes; ~6 new test cases.

**Files.**
- `project/src/ui/format/mode-stats.js` — added `formatModeBestModern`
  formatter; tertiary line returned when any modern-rules field > 0.
- `project/src/ui/settings-panel.js` — Stats tab renders the new
  line as a third sub-row under existing primary + secondary.
- `project/src/ui/format/mode-stats.test.js` — 12 new tests covering
  per-mode field gating, plurals, locale separators, defensive
  malformed-input coercion.

### 1.2 VFX celebration presets — ✅ shipped (`d1a4104`)

**Why.** §13 polish #1 added text callouts for modern-rules events.
But the cinematic FX layer in `vfx/director.js` doesn't yet fire
celebration visuals on T-spins / B2B / Perfect Clears. The score
math correctly applies the bonus; the screen doesn't yet feel it.

**What.** Three concrete recipes added to the existing director:

1. **Camera punch on Tetris (4-line clear).** Stronger when
   `isB2B === true` (B2B chain continuation). Scale: 1× shake on a
   plain Tetris, 1.4× on B2B Tetris, 1.8× on B2B chain ≥ 3.
2. **Color burst on T-spin clear.** Violet (matches `PIECE_COLORS.T`)
   particle burst at the T's pivot, sized by `cleared` count.
   T-spin Triple gets a screen-edge tint flash on top of the burst.
3. **Gold all-clear shockwave on Perfect Clear.** Reuses the
   existing `triggerLineClearShockwave` from `app/main.js` but with
   `color = 0xffd400` and `rowCount = ROWS` (full-arena ring). The
   §3.7 polish already wired the `worldX` parameter so the shockwave
   can fire from either well.

**Scope.** Pure VFX layer; no gameplay changes. The director
already has `lineClearLayers` for sparkle/flash/shockwave/veil/
envReaction; this adds three new recipes that subscribe to the
§12 events directly.

**Files (shipped).**
- `project/src/vfx/director.js` — LineClearOrchestrator now reads
  `clearType` / `isB2B` / `isPerfectClear` from LINE_CLEAR payloads
  and applies a modern-accent color override (PC gold > T-spin
  violet > Mini dim violet > B2B cyan > existing). `isB2B` also
  bumps the intensity arg by +1 so the cyan ring reads as escalating
  chain energy. New T_SPIN / B2B_CHAIN / PERFECT_CLEAR subscribers
  fire SFX cues and (for B2B chain ≥ 2 / PC) a camera-shake impulse.
- `project/src/app/main.js` — `registerDirector` extended with
  `shake: (force) => shake.impulse(force)` wiring.
- `project/src/vfx/director.test.js` — 12 new tests: 5 §12 recipe
  wiring + 6 LINE_CLEAR color override + 1 floating-point
  toBeCloseTo for the chain-force formula.

### 1.3 Garbage-bar drain flash — ✅ shipped (`7553c72`)

**Why discovered (v2).** During the §13 polish playtest, the
queue's spawn-delay window (default 800ms) means pips appear and
disappear quickly. The earlier §13 follow-up (`b3721b2`) made the
queue track always-visible with permanent slots — but actual pip
appearances are still flicker-fast as garbage applies on the next
lock.

**What shipped.** A simpler design than the originally-spec'd "pip
linger animation" — a one-shot CSS animation on the queue
container fires when an entry actually drains:
- `GARBAGE_APPLIED` → pink flash on YOU's column ("the queue just
  hit me — pink stayed visible for ~320ms so I could read what
  landed")
- `GARBAGE_CANCELLED` → cyan flash on YOU's column ("I just ate
  that garbage with my outgoing clear")

Pip-by-pip exit animation would need DOM identity tracking across
re-renders; this container-level flash gives the same UX read with
a fraction of the complexity. The reflow trick (`void offsetWidth`)
restarts the animation on rapid back-to-back events.

**Files (shipped).**
- `project/src/ui/versus-badge.js` — added two CSS keyframes
  (queue-applied / queue-cancelled), a `flashDrain(queueEl, kind)`
  helper, and GARBAGE_APPLIED + GARBAGE_CANCELLED subscriptions.
  Pure CSS / DOM, no event surface changes.

### 1.4 In-run B2B / combo chips — ✅ shipped (`c123529`)

**Why.** The transient callouts (`ui/modern-callouts.js`) announce
each event for ~1.4s and fade. That's good for the "wow, B2B
Triple!" moment but loses the steady-state context: while a B2B
chain is active, the player can't glance up and confirm "yes,
I'm still in B2B territory at ×3". Same for combo.

**What shipped.** Two persistent live-status chips at the top-left:
- **B2B ×N** (cyan accent) — visible while chain ≥ 1. Bumps on
  each new event so the player feels the chain extending.
- **Combo ×N** (orange accent) — visible while combo ≥ 2. Combo=1
  stays hidden ("first clear isn't a streak yet"); chip appears
  on the second consecutive clear.

A single shared module (`ui/modern-chips.js`) instead of per-badge
copies — every mode uses modern rules, so the chips are
mode-agnostic. One mount point, one subscriber pair. Mounted
top-left so they don't fight for the per-mode badges' top-center
real estate.

**Implementation note.** B2B count comes directly from B2B_CHAIN
payload (Game emits it with the post-increment count). Combo count
is tracked locally via LINE_CLEAR (Game's `_combo` is incremented
exactly once per clearLines call, and clearLines is the only
LINE_CLEAR emitter — so LINE_CLEAR is a 1:1 proxy for the combo
step). Reset on COMBO_END / MODE_START / MODE_END.

**Files (shipped).**
- `project/src/ui/modern-chips.js` (new, 264 lines) — pure DOM
  module, follows the marathon-badge / versus-badge / modern-callouts
  precedent (no DOM tests since the project doesn't have jsdom
  configured).
- `project/src/app/main.js` — `createModernChips` mounted next to
  `createModernCallouts` at boot.

### 1.5 Polish landing order (post-mortem)

The recommended order at v2 publication held: 1.1 → 1.2 → 1.3 →
1.4. Each item shipped as its own commit on `main`. 1.4 was
originally "deferred" pending playtest, but the user requested
"all the polish" in one pass, so it landed in the same session.

Test surface: 705 (after 1.1) → 717 (after 1.2) → 717 (1.3 was
pure CSS, no new tests) → 717 (1.4 follows the existing UI-no-test
precedent). All green.

---

## 2. Speculative chapters (still behind the experimental wall)

The three speculative chapters from v1 (3D Tetris, Online Versus,
Pure Physics) remain unchanged in their design and unimplemented.
v2 doesn't restate the specs — they live in `archived/plan_gameplay_1.md`
§6, §7, §8 — but it does update the **prerequisites and ordering**
in light of what's now shipped.

### 2.1 3D Tetris (§6) — ~8 days · **Phase A shipped**

**Status.** Spec is in v1 §6. **Phase A ✅ shipped** (on
`feat/3d-tetris`) as a pure-JS foundation; phases B–G (3D board
representation, camera, rendering, HUD, mode-tab UX, kick tables,
VFX) remain.
**Prereq updates.** §3.7's `Game` class is the unblocker — 3D
ships as its own `Game` variant with a 3D board representation,
not a fork of `app/main.js`. The seeded RNG + serialize/restore
already work for any board shape.
**v2 risk note.** §12's modern-rules state (`_lastAction`,
`_b2b`, `_combo`) is currently 2D-rotation-aware (e.g. T-spin
corner check uses 4 corners). 3D would need to either:
  (a) skip modern-rules entirely (simplest — 3D Tetris doesn't
      have an established T-spin culture anyway), or
  (b) generalize the corner check to face-corners (24 corners
      around a 3D pivot — much harder, ill-defined).
  v2 recommendation: **(a)** for the experimental release, with
  modern rules as a future extension if 3D promotes out of
  experimental. Phase A's rules pack hard-codes (a) via
  `goalMultiplier: 1.0` and a `clearType`-ignoring `lineScore`.

**Phase plan:**

| Phase | Scope | Status | Effort |
|---|---|---|---|
| **A — Pure logic + scaffolding** | tetracubes, 3D rotation, layer detection, rules pack, registry entry | ✅ shipped | ½ day |
| B — Host bridge | `Game` 3D-aware board representation; piece spawn / collision / lock in 3D; depth=1 fallback for 2D modes | open | 1 day |
| C — Camera + render | tilted-ortho default rig, 45°-snap orbit, slice/X-ray hotkeys, instanced-cube render at 10×10×20 | open | 2 days |
| D — Input + 3D kick table | 3 rotation axes (yaw/pitch/roll); documented 6-face + 12-edge kick offsets per archived §6.4 | open | 1 day |
| E — HUD layout | top-bar variants of the side panels (the 10×10 footprint won't fit the 2D side layout); piece preview at low-res isometric | open | 1 day |
| F — Mode-tab UX | mode visibility flag, settings opt-in, beginner/advanced toggle (6.3.1 vs 6.3.3) | open | ½ day |
| G — VFX | layer-clear shatter cascade adapted for 10×10 footprint; "reveal the floor" beat | open | 1 day |

**Phase A — what shipped (`feat/3d-tetris`):**
- `gameplay/experimental/3d/tetracubes.js` — 8-piece library.
  Five flat (I/O/T/L/S, reuse 2D PIECE_COLORS), one branch (3D T,
  cube rises at the midpoint), chiral right/left screws (distinct
  pieces because the cube rotation group has no reflections).
  Sparse `[x,y,z]` cell lists, normalized to the origin corner.
- `gameplay/experimental/3d/rotation.js` — 90° `rotateX/Y/Z`,
  `normalize`, `canonicalize`, `enumerateRotations`. The
  enumerator walks (rotateX^a · rotateY^b · rotateZ^c) for
  a,b,c ∈ {0..3}, dedupes via canonical key, returns ≤24 unique
  orientations. Total over all 8 pieces: **90 distinct
  orientations** (3+3+12+24+12+12+12+12).
- `gameplay/experimental/3d/layer-detection.js` — `detectFullLayers`
  (per-Y bucket count against COLS×DEPTH), `settleAfterClear`
  (cells above each cleared layer drop by the count strictly
  below), and the `LAYER_CLEAR_SCORE = [0, 1000, 3000, 5000, 8000]`
  table from archived §6.5.
- `gameplay/experimental/3d/rules.js` — pack with `key: '3d'`,
  declared `dimensions: { COLS:10, ROWS:20, DEPTH:10 }`,
  `pieceSet: 'tetracubes'` for the host's piece-registry switch,
  and a 3D `updateBest` that tracks `bestLayerCount` (largest
  single-lock clear) + cumulative `totalLayersCleared`. Registered
  in `rules.js#BUILDERS` so `buildRules('3d')` works.
- `gameplay/experimental/README.md` — adds the 3D-mode section
  alongside the existing physics entry.
- 100 new tests (10 tetracubes + 25 rotation + 20 layer-detection
  + 25 rules + 1 registry integration). Pure JS — no THREE, no
  Rapier, no DOM. Test surface: 800 → 900, all green.

**Phase B prep notes:**
- `gameplay/board.js` is currently 2D (`Cell[Y][X]`). For 3D, the
  cleanest extension is `Cell[Z][Y][X]` storage indexed by
  `dimensions.DEPTH` — for 2D modes `DEPTH = 1` and the existing
  `for (z = 0; z < 1; z++)` loop is a no-op. The `Game` class
  reads `rules.dimensions` at construction time; nothing else
  about `Game` needs to know what dimensionality it's running.
- Spawn-collision topout: same path as Classic — host checks the
  spawn cell against the board and ends the run on collision. The
  rules pack's `endCondition` stays a no-op (matches the rest
  except the timer-based modes).
- The §3.7 `BotController` is grid-aware; a 3D bot is its own
  AI problem and out of scope for Phase B. Versus / online don't
  apply to 3D in v2.

### 2.2 Online Versus (§7) — ~16 days

**Status.** Spec is in v1 §7. Not started.
**Prereq updates.** The §3.7 sub-phase 7f seeded RNG +
`Game.serialize` / `Game.restore` are exactly what online needs
for replay validation + rollback. The §12 events ship over the
wire from day one — the wire format already has slots for
`T_SPIN` / `B2B_CHAIN` / `PERFECT_CLEAR` / `GARBAGE_*` payloads.
**v2 ordering.** Item 1.2 (VFX celebrations) should land before
online; otherwise the over-the-wire feed includes events the
client doesn't yet visualize, which leaves remote opponents'
T-spins / Perfect Clears feeling under-celebrated.

### 2.3 Pure Physics (§8) — ~5 days · **Phase A shipped**

**Status.** Spec is in v1 §8. **Phases A–F+ ✅ shipped**; only F++
(per-collision dust) remains as polish on the v1 design.
**Post-shipping pivot:** §2.3.1 below proposes a Force-Physics
revision (compound bodies + force-driven input + no-shatter layer
clear). Not yet implemented — the pivot supersedes parts of the
v1 design and adds Phases G–L.
**v2 update.** Physics mode by design breaks determinism —
recorded in v1 §11 and `gameplay/rules/versus.js` header. The §12
modern rules' `_b2b` / `_combo` / T-spin detection all assume the
board is a discrete grid; physics has continuous bodies. The
physics rules pack sets `goalMultiplier = 1.0` and ignores the
clearType arg in its `lineScore` so §12 paths can't promote the
score (a Tetris in physics mode is just 4 layers × 100, no T-spin
bonus possible).

**Post-pivot note:** with compound bodies (§2.3.1), the rules
pack stays unchanged. `lineScore(rowCount, level)` still receives
"layers cleared this tick" regardless of whether the cleared
colliders came from one parent body or many. The pack doesn't see
the body model at all — that's the host bridge's domain.

**Phase plan (revised in v2):**

| Phase | Scope | Status | Effort |
|---|---|---|---|
| **A — Pure logic + scaffolding** | rules pack, layer-detection algorithm, registry entry, experimental/ README | ✅ shipped | ½ day |
| **B — Rapier integration** | `physics/world.js` wrapping Rapier, lazy-import factory, body lifecycle primitives | ✅ shipped | 1 day |
| **C+D — Host bridge + layer detection** | `app/physics-session.js`: PIECE_LOCK → addBody, per-tick step + detectLayers + emit PHYSICS_LAYER_CLEARED, cumulative HUD counters | ✅ shipped | 1.5 days |
| **E — Mode integration + HUD** | physics in Mode.AVAILABLE, storage slot, ui/physics-badge.js, mode-stats formatter | ✅ shipped | ½ day |
| **F — VFX integration (recipe)** | director.js subscriber: per-layer violet shockwave + sfx + camera shake on PHYSICS_LAYER_CLEARED | ✅ shipped | ½ day |
| **F+ — Render integration** | BoardView `noLockMeshes` opt; `world/physics-board-view.js` parallel renderer; PhysicsSession color tracking; main.js host wiring (Mode.start branch + animate-loop tick) | ✅ shipped | 1 day |
| F++ — Per-collision dust (deferred, on v1 OR v2) | Rapier contact events → vfx/emitters/dust spawn at impact points. Cosmetic polish; not gating any other work. More compelling post-pivot (piece-on-piece "thunk" cue rather than per-cube spam). | open | ½ day |
| **— Force-Physics pivot (proposed, see §2.3.1) —** | | | |
| G — Compound body + force API in PhysicsWorld | `addCompoundBody`, `applyImpulse`, `applyTorqueImpulse`, `setLinvel`, `removeCollider`, `getColliderPositions` | open | 1 day |
| H — PhysicsSession lifecycle redesign (active body, lock detection) | One active compound body, force-driven input methods, sleep / hard-drop lock detection, spawn-next flow | open | 1.5 days |
| I — Force-driven input wiring | main.js's tryMove/tryRotate/etc. branches in physics mode to call `physicsSession.applyMove` / `applyRotate` / etc. | open | ½ day |
| J — Compound renderer rework | `PhysicsBoardView` keyed by `colliderId` instead of `bodyId`; per-tick compound body → world transform → child mesh placement; dissolve animation on removal | open | 1 day |
| K — Layer clear without shatter | detectLayers identifies cleared colliders → `removeCollider` per cleared collider; auto-remove parent body when its collider count hits 0; renderer dissolves removed meshes | open | ½ day |
| L — Physics tuning + playtest | Force-value calibration (lateral / torque / drop magnitudes), material tuning (friction / restitution / damping), sleep-threshold tuning for lock detection | open | ½ day |

**Phase A — what shipped (`<TBD-sha>`):**
- `gameplay/experimental/physics/rules.js` — `buildPhysicsRules()` with
  flat per-layer score (×100, no level multiplier), `physicsHighestY`-
  aware topout via `endCondition`, `clearType` ignored on `lineScore`.
  Registered in `rules.js#BUILDERS` so `buildRules('physics')` works.
- `gameplay/experimental/physics/layer-detection.js` — pure
  connected-component algorithm. Inputs `[{x,y,z}, ...]`, outputs
  `Layer[]` with `cubeIndices` + Y center. Honors the §8.5 spec: ≥10
  face-touching cubes within a 0.8 Y-band qualify; staircase
  diagonals are correctly rejected. O(n²); fine for the ~500-body
  budget the spec calls out.
- `gameplay/experimental/README.md` — sets the scaffolding pattern
  for future experimental modes (3D, etc.) + 30-day promote-or-delete
  policy reminder.
- 38 new tests (16 rules + 21 layer-detection + 1 registry
  integration). Pure JS — no Rapier dependency yet, so the wasm
  bundle stays out of `main`'s build until phase B explicitly opts
  in via lazy-import.

**Phase B — what shipped:**
- `@dimforge/rapier3d-compat` ^0.19.3 added as a runtime dep. Sync-init
  wasm variant works in vitest's Node environment without extra
  setup. Bundle hit ~600KB; isolated to physics-mode by the lazy
  loader (next bullet).
- `physics/world.js` (new top-level subsystem, mirroring `camera/`,
  `vfx/` etc.) — exposes `loadRapier()` (idempotent async loader)
  + `createPhysicsWorld(opts)` factory + `PhysicsWorld` class.
- The wrapper's host-facing API:
  - `addBody(x, y, z, opts?)` → numeric `bodyId` (stable for body
    lifetime; decoupled from Rapier's internal handle scheme).
  - `step()` — fixed 1/60s timestep for determinism.
  - `getPositions()` → `[{bodyId, x, y, z}, ...]` snapshot of all
    live dynamic bodies. Output ordering is insertion order; the
    `bodyId` lets the host map `detectLayers`' `cubeIndices` back
    to IDs for removal.
  - `removeBody(id)` / `removeBodies(ids)` — idempotent on unknown
    IDs; returns count actually removed.
  - `highestY` accessor — feeds the rules pack's
    `endCondition(state)` via `state.physicsHighestY > 22`.
  - `awakeCount` — for the HUD's "settled" indicator.
  - `wakeAll()` — re-activates settled bodies after a clear.
  - `dispose()` — frees the Rapier wasm world (idempotent).
- Default world geometry: floor at y=-0.5 (cuboid, full playfield
  width + 1 cell margin); side walls at x=-1 and x=cols (cuboid,
  height = rows + 4 to prevent over-the-top wedge escape). Both
  configurable via opts.
- Per-cube material per archived §8.4: friction 0.6, restitution
  0.1, linear damping 0.05, angular damping 0.10. Continuous
  collision detection enabled so a hard-dropped piece can't tunnel
  through the floor. Auto-sleep enabled so settled bodies don't
  burn CPU.
- 20 tests covering boot, body lifecycle, gravity / step, sleep /
  wake, highestY accessor, dispose. All against real Rapier (no
  mocks); tests use `toBeCloseTo` for position assertions to
  accommodate Rapier's semi-implicit Euler integration.

**Phase F+ — what shipped:**

The render integration that makes physics mode visually match the
simulation. Selecting physics from the Mode tab now produces a
playable experience where locked cubes drift under gravity, settle
in wedges, and shatter when their layer detects.

- **`world/board-view.js`** gains a `noLockMeshes: true` opt that
  gates the PIECE_LOCK / LINE_CLEAR / GARBAGE_APPLIED / ZEN_RESCUE
  handlers. Active piece + ghost rendering still happens (the
  falling tetromino is grid-driven before lock); only the
  post-lock cube management is suppressed. Other modes pass the
  default `false` and behave exactly as before.

- **`world/physics-board-view.js`** (new) — parallel renderer that
  reactively follows the PhysicsWorld:
  - Per-tick snapshot of `world.getPositions()`.
  - For each body without a mesh: create one via `makeCube(color)`
    where color comes from `session.getBodyColor(id)`. Adds it to
    the view's `stackGroup`.
  - For each body with a mesh: copy `(x, y, z)` through the
    host's `cellToWorld` bake (linear; works on continuous coords)
    into `mesh.position`.
  - For each mesh whose bodyId is no longer in the snapshot:
    remove from stackGroup, optionally call `shatter(mesh)` for
    visual feedback.

- **`app/physics-session.js`** extended with a `Map<bodyId, color>`
  + `getBodyColor(id)` accessor. PIECE_LOCK handler stashes the
  payload color per body it adds; `tick()` deletes entries on
  removeBodies; `stop()` clears the map. Defensive default of
  `0xffffff` when payload omits color.

- **`app/main.js`** Mode.start handler gains a `physics` branch
  between the `versus` and solo paths:
  - Constructs Game + BoardView (with `noLockMeshes: true`).
  - Constructs PhysicsSession + PhysicsBoardView, parented to the
    same `caseGroup` as BoardView.
  - Awaits `session.start()` (lazy-loads Rapier wasm — first run
    pays ~50ms, subsequent runs hit the loader cache).
  - On any subsequent Mode.start: tears down via `physicsView.dispose()`
    + `physicsSession.stop()` before constructing the next session.
  - Animate loop: when physics is active, calls `session.tick()`
    then `physicsView.tick()` BEFORE `game.tick()`, so the rules
    pack's `endCondition` reads `physicsHighestY` from the freshest
    snapshot.

16 new tests across the two new modules (5 PhysicsSession color
tracking + 11 PhysicsBoardView reconciliation). All against real
Rapier; pure-Node THREE meshes via stub factory.

**What remains (F++):** per-collision dust emission. Rapier exposes
contact events; the host can subscribe and spawn dust particles at
the impact world position. Cosmetic polish; doesn't gate any other
chapter. ~½ day; documented as F++ in the phase table above.

---

#### 2.3.1 Design pivot — Force Physics (post-shipping rethink)

After Phase F+ landed (the renderer that follows physics body
positions), playtest exposed two structural problems with the
v1 design:

1. **Grid-snap controls feel disconnected from the physics.** The
   active piece moves in discrete cell steps (instant teleport),
   then on lock the cells become 4 SEPARATE dynamic bodies. There's
   a discontinuity at lock: before, controls feel like classic
   Tetris; after, the cubes splash outward like an explosion. The
   player's input never *causes* the physics — the piece is moved
   by grid math, then handed off to physics as a fait accompli.

2. **Per-cube bodies + shatter creates visual chaos.** A locked
   piece's 4 cubes drift apart immediately because each is its own
   rigid body. Layer-clear shatters them further. The result is a
   stack that's hard to read — wedged shrapnel, not Tetris-shaped
   pieces.

The pivot — **Force Physics** — rebuilds the player↔simulation seam:

- **One compound rigid body per tetromino.** Rapier supports adding
  multiple `cuboid` colliders to a single rigid body. An L-piece is
  one body with 4 colliders attached at the right offsets. The
  body never splits — it lands as a Tetris-shaped piece.

- **Player input applies forces / impulses / torques** to the active
  body, not grid-position deltas:
  - **Left / Right** → lateral linear-velocity impulse (`±5 cells/sec`)
  - **Rotate CW / CCW** → torque-impulse around Z axis (`±2 N·m`)
  - **Soft drop** (Down arrow) → mild downward velocity boost (`-3 cells/sec`)
  - **Hard drop** (Spacebar) → strong downward impulse (`-15 cells/sec` instantly + commits the piece to "locked stack" status when it next sleeps)

- **No shatter on layer clear.** When the connected-component layer
  detector identifies a cleared slab (10+ colliders within a Y-band),
  the host:
    1. Identifies which colliders belong to the layer.
    2. Removes those colliders from their parent compound bodies
       (Rapier's `world.removeCollider(handle)`).
    3. If a parent body has zero remaining colliders, removes the
       body too.
    4. Otherwise, the body stays — with fewer colliders — and the
       remaining cubes settle naturally under gravity. (A surviving
       single-cube body falls like a single block; a surviving 3-cube
       L-shape continues to be one body with 3 colliders.)
    5. Visually: the cleared cubes **dissolve** with a soft fade
       (opacity 1 → 0 over 250ms) plus a subtle violet glow pulse.
       No shrapnel, no shatter particles.

##### Phase classification — what stays / what reworks / what's obsolete

| Shipped phase | Stays valid? | Needs rework | Obsolete |
|---|---|---|---|
| **A — rules pack** | ✅ Mostly. `lineScore`, `endCondition`, `physicsTopoutY` unchanged. | — | — |
| **A — layer-detection algorithm** | ✅ Algorithm is the same — operates on collider centers (was: body centers). The detector is collider-aware, not body-aware. | — | — |
| **B — `physics/world.js` PhysicsWorld wrapper** | Partial. `loadRapier` / `createPhysicsWorld` / step / dispose all stay. | `addBody(x,y,z)` joined by `addCompoundBody(cells, opts)`. New impulse / torque / setLinvel APIs. `removeCollider` granularity instead of `removeBody`. | — |
| **C+D — PhysicsSession** | Partial. Bus subscription pattern, lifecycle, layer-detection driver all stay. | PIECE_LOCK no longer maps cells → N bodies. Instead the active piece lifecycle is owned by the session: spawn (compound body), apply forces (player input), settle/lock (sleep heuristic), spawn next. | The 1-body-per-cell mental model is gone. |
| **E — mode availability + HUD badge** | ✅ Fully. The badge displays cube count / awake count / layers — counts now mean "collider count" / "awake body count" but the read-out is the same. | — | — |
| **F — VFX celebration recipe** | Partial. Per-layer violet shockwave + sfx + camera shake stays. | The shockwave's `rowCount` arg uses `layer.size` (collider count); per-collider dissolve replaces shatter. | The shatter-on-cube path is dropped. |
| **F+ — render integration** | Partial. `BoardView.noLockMeshes` opt + main.js Mode-start branch + animate-loop tick all stay. | `PhysicsBoardView` redesigned — meshes are now keyed by `colliderId` not `bodyId`; tracks compound-body transforms (translation + rotation) and applies to each child mesh. Dissolve-out replaces the bodyless-mesh path. | The 1-mesh-per-body simplification is gone. |

##### New phases for the Force-Physics revision

| Phase | Scope | Status |
|---|---|---|
| **G — PhysicsWorld compound + force API** | `addCompoundBody(cells, opts) → bodyId`; `applyImpulse(bodyId, vec)`; `applyTorqueImpulse(bodyId, vec)`; `setLinvel(bodyId, vec)`; `removeCollider(handle)` (replaces granular removeBody for layer clears); `getColliderPositions() → [{bodyId, colliderId, x, y, z, color}]` (replaces `getPositions()`); `getBodyRotation(bodyId)`. All against real Rapier in tests. | ✅ shipped (`177a16d`) |
| **H — PhysicsSession lifecycle redesign** | Active body slot (the player's current piece). PIECE_SPAWN handler builds a compound body for the freshly-spawned tetromino; Game is paused for the run. `applyMove` / `applyRotate` / `applySoftDrop` / `applyHardDrop` route to PhysicsWorld force methods. Lock detection: sleep heuristic (body's awake bit `false`) or hard-drop trigger (`_hardDropArmed` flag + speed-below-commit-threshold). On commit: `game.spawnPiece()` to advance the bag. Force constants centralized in `_FORCE` export. | ✅ shipped (`5557cd5`) |
| **I — Force-driven input wiring (main.js)** | The host's keyboard intent layer (`tryMove` / `tryRotate` / `softDrop` / `hardDrop` / `holdActive`) branches: in physics mode, route to `physicsSession.apply*` instead of `game.try*`. BoardView is skipped entirely in physics mode (the active piece IS a body from spawn — no pre-lock grid pose to render). Held down-arrow applies per-tick soft-drop force. Hold (Shift / C) is a no-op in physics mode. | ✅ shipped (`bd86167`) |
| **J — Compound renderer rework** | `PhysicsBoardView` keyed by `colliderId`. Per tick: snapshot `world.getColliderPositions()`, create / update mesh per collider, copy parent body's quaternion (cached per bodyId per tick). Dissolve animation (opacity 1→0 + scale 1→1.10 over 250ms) on collider removal — replaces the v1 shatter. | ✅ shipped (`f193170`) |
| **K — Layer-clear without shatter** | Detect cleared colliders (existing detectLayers algorithm). Session calls `world.removeCollider(handle)` for each cleared collider; PhysicsWorld auto-removes the parent body when its collider count drops to 0. Renderer observes the disappearance and starts dissolve. Layer event payload extended with `removedColliderIds: number[]`. | ✅ delivered via H + J (no separate commit) |
| **L — Physics tuning + playtest** | Force values are centralized in PhysicsSession's `_FORCE` export so a single-file edit retunes feel: `LATERAL_IMPULSE` 2.5, `ROTATE_TORQUE_IMPULSE` 1.2, `SOFT_DROP_IMPULSE` 3.0, `HARD_DROP_LINVEL` -15.0, `HARD_DROP_COMMIT_VEL` 1.5, `LATERAL_MAX_VEL` 8.0. Compound-body friction / restitution / damping use Rapier defaults; revisit if settling feels slippery. The 30-day promote-or-delete decision (per the §10 culture) folds in playtest data once the mode has live keyboard time. | 🟡 ready for playtest tuning (no in-CI knob) |

**Total Force-Physics rework:** delivered in 4 commits (`177a16d` G,
`5557cd5` H, `f193170` J, `bd86167` I — landing order followed
implementation-dependency, not the alphabetical labels). K folded into
H + J. L is gated on human keyboard time and tracked as the only
remaining open thread on this chapter.

##### Why this is worth doing

The v1 design was a competent "Tetris with a physics simulation
running afterward." The pivot makes physics the *medium* —
every input the player makes is a physical force, every cube on
the board is part of a real rigid body, and the experience
becomes "what happens when Tetris is a real toy in a real
gravity well, not a grid game." That's the original §8.2 promise
of physics mode (archived plan_gameplay_1.md):

> *In physics mode, the simulation is approximate — pieces lean,
> slip, settle into wedges. The visual identity becomes "blocks
> falling like a Tetris game **should** fall."*

The v1 hit half of that — pieces leaned and settled — but the
input model still felt like grid Tetris with a physics afterimage.
The pivot closes that gap.

##### What this changes for the F++ "per-collision dust" item

F++ becomes more compelling. With compound bodies, collisions are
between full pieces (not individual cubes), and the dust effect
becomes a meaningful "thunk" cue at piece-on-piece contact rather
than per-cube spam. F++ remains deferred but its design is clearer
post-pivot.

---

## 3. Risks (v2 forward-looking)

The v1 §11 risk table is largely retired (most rows now ✅
resolved per the v1 §11 final state). v2 carries forward only the
risks that remain *open* plus new ones discovered in v2 work.

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ✅ §12 events outpace HUD/VFX consumers | (resolved) | — | §1.1 surfaces persisted modern stats; §1.2 wires VFX presets + camera shake; §1.3 visualizes garbage drain; §1.4 shows persistent in-run chips. The score now both math-applies AND visually + audibly registers. |
| Modern-rules state needs 3D generalization for 3D Tetris (§6) | Medium (only if 3D ships) | Medium | Plan §2.1: scope 3D experimental as 2D-rules-only; revisit if 3D promotes. |
| Online wire format must carry §12 events from day one or feel broken | Medium (only if §7 ships before 1.2) | Medium | Land item 1.2 first. The events already flow through the bus; networking layer pipes them through. |
| Garbage-bar pips are too subtle / fade too fast for casual play | Low | Low | Item 1.3 adds a pip linger animation; further tweaks gated on playtest. |
| Sprint's "T-spin: score 0" rule is community-controversial (mode chooses to ignore the bonus to keep "time-only" semantics) | Low | Low | T_SPIN events still fire so the HUD callout appears; the score field is 0 by Sprint's `lineScore: () => 0`. Documented in `gameplay/rules/sprint.js` header. |
| Schedule slippage as 3D + online + physics overlap | High (only if all three ship in same window) | Medium | Stage-gate: ship one experimental chapter at a time; pause-or-promote at the 30-day mark per `plan_particle_2.md` §10 culture. |
| ✅ Force-Physics pivot disrupts already-shipped Phase A–F+ work | (resolved) | — | Phases G/H/J/I shipped (`177a16d` / `5557cd5` / `f193170` / `bd86167`); A's layer-detection algorithm + rules pack, E's HUD, and the F shockwave path were all preserved. Compound-body PhysicsWorld + collider-keyed PhysicsBoardView replaced the half of B/C+D/F+ that was 1-body-per-cell shaped, without breaking the kept pieces. |
| Force-Physics input feel ("the piece is too floaty / too sticky / too hard to control") | Medium (only post-shipping) | Medium | Force constants centralized in PhysicsSession's `_FORCE` export — single-file edit retunes feel. SOFT_DROP_MAX_VEL cap added in Phase L to prevent held-down-arrow from compounding past hard-drop magnitude. Real keyboard playtest is the only remaining follow-up; defer the 30-day promote-or-delete decision until that lands. |

---

## 4. Schedule

### 4.1 Landing order (post-mortem)

1. ✅ **1.1 Stats UI surfacing** — `fdac17c`
2. ✅ **1.2 VFX celebration presets** — `d1a4104`
3. ✅ **1.3 Garbage drain flash** — `7553c72`
4. ✅ **1.4 In-run B2B / combo chip** — `c123529` (originally deferred; landed in the same session as 1.1–1.3 per user request)
5. ✅ **2.3 Pure Physics — Force-Physics rework** — `177a16d` (G) / `5557cd5` (H) / `f193170` (J) / `bd86167` (I); K folded in. Playtest tuning (Phase L) is the only follow-up and gated on human keyboard time.

### 4.2 Remaining (speculative chapters)

6. **2.1 3D Tetris (experimental)** — 8 days (pause-or-promote; Phase A shipped)
7. **2.2 Online Versus** — 16 days (the §1.2 prerequisite is now met)

**Total speculative:** 24 days (was: 5 + 8 + 16; physics chapter
shipped its Force-Physics rework so its budget is retired); expect
1 chapter to actually ship next based on the 30-day promote-or-delete
policy.

### 4.3 Parallelization notes

- §1 polish items shipped sequentially in a single session — fastest
  path turned out to be "do them all in the recommended order" rather
  than parallelizing.
- Items 2.1, 2.2, 2.3 each carry their own risk and bandwidth
  budget; sequencing them helps avoid simultaneous-experimental
  fatigue.
- The §3.7 architectural floor unblocks all of (2.1, 2.2). Don't
  redesign it.

---

## 5. Final Word (v2 edition)

The original v1 plan's load-bearing claim — **"every mode is small once
the rules engine exists"** — held through every shipped item. Marathon
shipped at 30 lines of rules; T-spin detection added 120 lines of pure
detection that touches no rendering code; the modern-rules stats
extension touched 6 files but no new architectural surface.

v2's job is smaller than v1's: most of the design was made and shipped.
What's left is **completion of the player-visible polish** for the §12
modern-rules pass (Stats UI, VFX celebrations, garbage-bar finesse) and
the **deliberate gating of the speculative chapters** (3D, online,
physics) under the 30-day promote-or-delete culture.

The architectural property — `gameplay/` stays pure, hosts wire
bridges, modes are rule packs not forks — is the load-bearing
principle. v2 builds within it. If a future addition tempts a
violation, that's the moment to write a v3 plan and the
30-day decision instead of letting the surface drift.

---

*End of v2. Predecessor preserved at `document/archived/plan_gameplay_1.md`.*
