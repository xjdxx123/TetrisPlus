# Tetris+ Gameplay Plan v2 — Post-§12 Forward Roadmap

**Date:** 2026-05-09 · **Test surface:** 693 tests across 43 files (all green) ·
**Predecessor:** `document/archived/plan_gameplay_1.md` (preserved for the
full design rationale, mode-by-mode specs, and shipped-implementation
notes). v2 picks up where v1 left off.

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

These are the items §13 explicitly named that have NOT yet shipped.
Each is small enough to land in a focused PR and adds clear player
value on top of features already in the codebase.

### 1.1 Stats UI surfacing (~half a day)

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
- `project/src/ui/format/mode-stats.js` — extend `formatModeBestPrimary` /
  `Secondary` / `Summary` per mode key.
- `project/src/ui/format/mode-stats.test.js` — assert the new rows
  render with non-zero values + degrade gracefully on zero.

### 1.2 VFX celebration presets (~1 day)

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

**Files.**
- `project/src/vfx/director.js` — add T_SPIN / B2B_CHAIN /
  PERFECT_CLEAR subscribers and route to existing layer apis.
- `project/src/vfx/presets/` — three new recipe constants if
  needed (or inline if small).
- `project/src/app/main.js` — pass any new layer impls to
  `registerDirector`; existing impl points are likely sufficient.

**Risk.** Visual feel is subjective. Tune in a `vfx/director.test.js`
case that asserts the recipe wiring (subscriber registered on the
right topic, calls the right api with the right args), not the
animation itself.

### 1.3 Garbage-bar polish — pip linger (~half a day)

**Why discovered (v2).** During the §13 polish playtest, the
queue's spawn-delay window (default 800ms) means pips appear and
disappear quickly. The §13 follow-up commit (`b3721b2`) made the
queue track always-visible with permanent slots — but actual pip
appearances are still flicker-fast as garbage applies on the next
lock.

**What.** When a pip is about to disappear (garbage applied to
board), fade it for ~250ms with a downward-slide animation
("garbage hit the well"). Not a real animation of the rows landing
— just a UI cue that the queue drained.

**Files.**
- `project/src/ui/versus-badge.js` — subscribe to `GARBAGE_APPLIED`
  + `GARBAGE_CANCELLED`, animate the pip exit before clearing the
  DOM element. CSS-only animation; the existing transition already
  handles opacity / transform.

**Scope.** ~30 lines of CSS + JS. No state surface changes.

### 1.4 §12 stats UI in HUD (`real-time` view, optional)

**Why.** The per-mode `bestB2bChain` etc. show up in Stats tab
post-run, but there's no in-run readout of "current B2B: ×3" or
"current combo: ×5". Players who hit a long combo get the
HUD callout once but no persistent indicator.

**What.** Add small chip(s) to the existing per-mode badges
(marathon-badge / classic — wherever there's room) showing:
- `B2B ×N` when `_b2b > 0`
- `COMBO ×N` when `_combo > 1`
- `PC?` indicator (subtle green flicker when board near-empty)

**Scope.** ~30 lines per badge × 5 badges. Each badge already
subscribes to `MODE_START` / `LINE_CLEAR` etc.; subscribing to
`B2B_CHAIN` / `COMBO_START` / `B2B_BREAK` / `COMBO_END` is
backward-compatible.

**Defer rationale.** Less critical than 1.1 + 1.2 since the
modern-callouts module already announces these on each event.
Ship this only if playtest reveals the callouts feel insufficient.

### 1.5 Recommended landing order for polish

1. **1.1 Stats UI surfacing** — half a day, immediate player-visible
   payoff. Should land before any speculative work picks up.
2. **1.2 VFX celebration presets** — one day. Big game-feel improvement
   for an already-shipped capability.
3. **1.3 Garbage-bar pip linger** — half a day. Quality-of-life on
   the v2 garbage clarity work.
4. **1.4 In-run B2B / combo chip** — defer until 1.1–1.3 land and
   playtest tells us whether the callouts alone are enough.

Total: 2 days for items 1–3. Item 4 only if needed.

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

### 2.3 Pure Physics (§8) — ~5 days

**Status.** Spec is in v1 §8. Not started. Independent of
everything else; lands when there's bandwidth.
**v2 update.** Physics mode by design breaks determinism —
recorded in v1 §11 and `gameplay/rules/versus.js` header. The §12
modern rules' `_b2b` / `_combo` / T-spin detection all assume the
board is a discrete grid; physics has continuous bodies. The
physics rules pack should set `goalMultiplier = 1.0` and skip
the modern-rules score paths (use a `clearType: 'physics'` branch
in `lineClearScore` or just override `lineScore` directly).

---

## 3. Risks (v2 forward-looking)

The v1 §11 risk table is largely retired (most rows now ✅
resolved per the v1 §11 final state). v2 carries forward only the
risks that remain *open* plus new ones discovered in v2 work.

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| §12 events outpace HUD/VFX consumers (1.1 / 1.2 not landed) | Acknowledged | Low | Player gets score correctly but doesn't feel the moment. §13 callouts cover the text part; VFX is the visual+haptic gap. Item 1.2 closes it. |
| Modern-rules state needs 3D generalization for 3D Tetris (§6) | Medium (only if 3D ships) | Medium | Plan §2.1: scope 3D experimental as 2D-rules-only; revisit if 3D promotes. |
| Online wire format must carry §12 events from day one or feel broken | Medium (only if §7 ships before 1.2) | Medium | Land item 1.2 first. The events already flow through the bus; networking layer pipes them through. |
| Garbage-bar pips are too subtle / fade too fast for casual play | Low | Low | Item 1.3 adds a pip linger animation; further tweaks gated on playtest. |
| Sprint's "T-spin: score 0" rule is community-controversial (mode chooses to ignore the bonus to keep "time-only" semantics) | Low | Low | T_SPIN events still fire so the HUD callout appears; the score field is 0 by Sprint's `lineScore: () => 0`. Documented in `gameplay/rules/sprint.js` header. |
| Schedule slippage as 3D + online + physics overlap | High (only if all three ship in same window) | Medium | Stage-gate: ship one experimental chapter at a time; pause-or-promote at the 30-day mark per `plan_particle_2.md` §10 culture. |

---

## 4. Schedule

### 4.1 Recommended landing order (v2)

1. **1.1 Stats UI surfacing** — ½ day
2. **1.2 VFX celebration presets** — 1 day
3. **1.3 Garbage-bar pip linger** — ½ day
4. **1.4 In-run B2B / combo chip** — ½ day (deferred; only if 1.1–1.3 leave a gap)
5. **2.3 Pure Physics (experimental)** — 5 days (independent; pause-or-promote)
6. **2.1 3D Tetris (experimental)** — 8 days (pause-or-promote)
7. **2.2 Online Versus** — 16 days (depends on 1.2 for visual completeness)

**Total polish:** 2 days for items 1–3 (the highest-value remainder).
**Total speculative:** 29 days; expect 1–2 chapters to actually ship
based on the 30-day promote-or-delete policy.

### 4.2 Parallelization notes

- Items 1.1, 1.2, 1.3 are all small (≤1 day each) and independent —
  any can ship first.
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
