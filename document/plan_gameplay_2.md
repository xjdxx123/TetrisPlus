# Tetris+ Gameplay Plan v2 — Post-§12 Forward Roadmap

**Date:** 2026-05-09 · **Test surface:** 754 tests across 45 files (all green) ·
**Predecessor:** `document/archived/plan_gameplay_1.md` (preserved for the
full design rationale, mode-by-mode specs, and shipped-implementation
notes). v2 picks up where v1 left off.

**Status:** all four §1 polish items (1.1 Stats UI surfacing, 1.2 VFX
celebration recipes, 1.3 Garbage drain flash, 1.4 In-run B2B/combo
chips) ✅ shipped on main. v2 now spans only the speculative chapters
(§2) — 3D Tetris, Online Versus, Pure Physics — gated behind the
30-day promote-or-delete culture.

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

### 0.2 Architectural property to preserve

`gameplay/` stays Three.js-free, DOM-free, AudioContext-free. Every
rule pack is pure JS that runs in Node tests without a Three.js or
DOM stub. The §3.7 extraction made this property cash-in: a
`Game` class that two simulations + the future network layer can
instantiate side-by-side.

This property held through Phases 1–8, §3.7, §12, and §13 polish.
It is the load-bearing principle of v2 too.

### 0.3 Test surface

693 tests across 43 files (all green at v2 publication). Each
shipped feature carried its own test file under the same directory
(rules packs ship a `*.test.js` sibling; the §12 detector ships
`t-spin.test.js`; §13 stats writer extends `end-of-run.test.js`).

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

### 2.1 3D Tetris (§6) — ~8 days

**Status.** Spec is in v1 §6. Not started.
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
  experimental.

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

**Status.** Spec is in v1 §8. **Phase A ✅ shipped** as a foundation;
phases B–F (Rapier integration through VFX polish) remain.
**v2 update.** Physics mode by design breaks determinism —
recorded in v1 §11 and `gameplay/rules/versus.js` header. The §12
modern rules' `_b2b` / `_combo` / T-spin detection all assume the
board is a discrete grid; physics has continuous bodies. The
physics rules pack sets `goalMultiplier = 1.0` and ignores the
clearType arg in its `lineScore` so §12 paths can't promote the
score (a Tetris in physics mode is just 4 layers × 100, no T-spin
bonus possible).

**Phase plan (revised in v2):**

| Phase | Scope | Status | Effort |
|---|---|---|---|
| **A — Pure logic + scaffolding** | rules pack, layer-detection algorithm, registry entry, experimental/ README | ✅ shipped | ½ day |
| B — Rapier integration | `physics/world.js` wrapping Rapier, lazy-import on Mode.start({key:'physics'}) | open | 1 day |
| C — Body lifecycle | grid→bodies on lock; cleanup on layer-clear; sleep heuristics | open | 1 day |
| D — Layer detection wiring | per-frame body-position snapshot → `detectLayers` → emit clear events | open | ½ day |
| E — Mode integration + HUD | `ui/physics-badge.js`, Mode tab visibility, settings opt-in | open | ½ day |
| F — VFX integration | dust on collision, layer-clear shatter adapts to body positions | open | 1 day |

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

**Phase B prep notes:**
- `npm install @dimforge/rapier3d-compat` (the sync-init variant
  is friendlier than the wasm-fetching default; bundle hit ~600KB
  per archived §8.3).
- Lazy-load via dynamic `await import()` inside the host's
  `Mode.start` handler so non-physics modes don't pay the wasm cost.
- A `physics/world.js` wrapper exposes the host-facing API:
  `addBody(x, y, z) → bodyId`, `step(dt)`, `getPositions() →
  CubePosition[]`, `removeBodies(ids)`. The rules pack stays unaware
  of Rapier — it consumes the layer-detection result via the host.

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

---

## 4. Schedule

### 4.1 Landing order (post-mortem)

1. ✅ **1.1 Stats UI surfacing** — `fdac17c`
2. ✅ **1.2 VFX celebration presets** — `d1a4104`
3. ✅ **1.3 Garbage drain flash** — `7553c72`
4. ✅ **1.4 In-run B2B / combo chip** — `c123529` (originally deferred; landed in the same session as 1.1–1.3 per user request)

### 4.2 Remaining (speculative chapters)

5. **2.3 Pure Physics (experimental)** — 5 days (independent; pause-or-promote)
6. **2.1 3D Tetris (experimental)** — 8 days (pause-or-promote)
7. **2.2 Online Versus** — 16 days (the §1.2 prerequisite is now met)

**Total speculative:** 29 days; expect 1–2 chapters to actually ship
based on the 30-day promote-or-delete policy.

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
