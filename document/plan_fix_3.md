# TetrisPlus — Gameplay-Effects Fix Plan v3

Scope: visual polish on the **gameplay layer only** — what happens when a
player moves, locks, drops, clears, levels up, or loses. The background
(city, sky, fog, floor, mood preset visuals) is excluded. Owner is
rebuilding that backdrop from scratch.

Touches `project/tetris.html` exclusively.

---

## 0. Status recap (what already shipped)

From [plan_fix.md](plan_fix.md) and [plan_fix_2_completed.md](plan_fix_2_completed.md):

- Composer wired: `RenderPass → UnrealBloomPass → Vignette → SMAA → Output`
  ([tetris.html:400-446](../project/tetris.html#L400-L446))
- Shatter pooled into 2048-capacity instanced GPU shards
  ([tetris.html:1632-1645](../project/tetris.html#L1632-L1645))
- Sparkles pooled into a single `Points` ring buffer
- Flash **lights** pooled (`flashLightPool`, 4 slots) — no shader recompile
  on multi-line
- Cube material: opaque resin, no iridescence, sharp opaque edges, active
  piece +emissive (F1–F5)
- Saturated `PIECE_COLORS`, larger NEXT/HOLD previews, HOLD empty-slot
  placeholder
- BG toggle button (city/sky/floor visibility)

Gameplay-effect systems still have notable gaps. Catalog below.

---

## 1. What is *not* working at "premium" quality right now

| # | Issue | Where | Severity |
|---|---|---|---|
| E1 | Flash meshes still alloc'd per row-clear (`new PlaneGeometry`+`new MeshBasicMaterial` × 2 per row, dispose'd ~0.5s later). The pool covered lights only | [tetris.html:1934-1945, 1957-1971](../project/tetris.html#L1934-L1971) | High (alloc churn on tetrises) |
| E2 | Flash is **always white/amber** — strips the cleared row of its color identity | [tetris.html:1936, 1959](../project/tetris.html#L1936) | High (visual identity) |
| E3 | Shatter shards launch radially in random directions — looks like an explosion in vacuum, not glass shattering. Reference imagery wants shards radiating *outward from the row axis*, biased into the camera's depth | [tetris.html:1869-1874](../project/tetris.html#L1869-L1874) | Medium |
| E4 | Camera shake uses `Math.random()` per frame on each axis → reads as **video static / buffer corruption**, not impact | [tetris.html:2487-2496](../project/tetris.html#L2487-L2496) | High (cheap fix, big payoff) |
| E5 | No slow-mo / time dilation on multi-line clears. Punch-zoom + shake fire instantly with no anticipation | [tetris.html:2510-2522](../project/tetris.html#L2510-L2522) | Medium |
| E6 | No floating score popup at the clear location (`+100`, `+300`, `+800` floating up) | n/a | Medium (juice) |
| E7 | No "TETRIS!" / "DOUBLE!" / "TRIPLE!" callout text | n/a | Medium (juice) |
| E8 | No combo counter for back-to-back clears | n/a | Low |
| E9 | Hard drop has no afterimage / no streak / no impact ring at the lock row — visually identical to a slow drop with extra inertia | [tetris.html:1511-1519](../project/tetris.html#L1511-L1519) | High (hard drop is the "best" input — should *feel* it) |
| E10 | Lock has no squash/stretch on the freshly placed cubes — pieces just *appear* at the bottom | [tetris.html:1524-1554](../project/tetris.html#L1524-L1554) | Medium |
| E11 | Level-up is silent — score panel changes but nothing on screen marks the moment | [tetris.html:1564-1565](../project/tetris.html#L1564-L1565) | Medium |
| E12 | New piece spawns instantly at row=20 with no drop-in animation or fade | [tetris.html:1380-1402](../project/tetris.html#L1380-L1402) | Low (subtle) |
| E13 | Ghost piece is "transparent cube" — readable, but at a glance ambiguous with a real cube made dim by viewing angle. Reference convention is wireframe-only ghosts | [tetris.html:1452-1464](../project/tetris.html#L1452-L1464) | Medium |
| E14 | HUD numbers do not react when they change — score 12,400 → 12,500 just swaps text. No tick, no pulse, no color flash | [tetris.html:2156-2178](../project/tetris.html#L2156-L2178) | Medium |
| E15 | Game over is just a fade-in HTML overlay — the case + stack don't react. Reference imagery (and the original idea of "shattering glass") suggests the *whole stack* should shatter when you top out | [tetris.html:2204-2210](../project/tetris.html#L2204-L2210) | High (signature moment) |
| E16 | Rotation kick: `pieceRotVisual = dir > 0 ? -0.45 : 0.45; pieceRotVel = 0` ([tetris.html:1494](../project/tetris.html#L1494)). The line `pieceRotVel = 0` cancels half the spring's energy and the kick decays from a static offset rather than swinging through. Sibling bug to plan_fix.md D6 | [tetris.html:1494-1495](../project/tetris.html#L1494) | Low (one-line) |
| E17 | Soft drop awards `+1` per cell but has no visual signal — pressing Down feels identical whether the piece moves or not | [tetris.html:1503-1509](../project/tetris.html#L1503-L1509) | Low |

---

## 2. Direction (the framing)

The play case is now visually solid — opaque cubes, sharp edges, vivid
color. What's missing is **reaction**. Every meaningful gameplay event
should have:

1. **Anticipation** — a wind-up before the payoff (e.g. brief
   slow-down before a Tetris flash).
2. **Impact** — instantaneous high-contrast event (flash, shake, bloom
   spike, color flood).
3. **Resonance** — a fading aftermath (popup score, slow camera
   release, sparkle drift).

Most current effects fire only "impact" — no anticipation, weak resonance.
The fix plan below is structured around adding the missing phases to each
event class, not around adding new event classes.

---

## 3. Fix plan, grouped by event class

### 3.1 Line clear (the headline event)

The biggest perceived win is here. Three sub-fixes compose.

#### G1 — Color-tinted flash slabs, fully pooled

Replace [`triggerFlash`](../project/tetris.html#L1930) and the per-mesh
allocation at [tetris.html:1934-1971](../project/tetris.html#L1934-L1971).

- Pre-allocate **8 reusable flash slabs** at boot (4 horizontal + 4 vertical), shared geometry (`PlaneGeometry`), individual materials (so per-slab opacity/color animate independently).
- `triggerFlash(rows, colors[])` accepts the cleared row's average color (computed from `cellMeshes[r][c].userData.color`) and sets the slab's `material.color` + `emissive` accordingly.
- Slab `material.color` interpolates from white-hot → row color over 250ms (high-contrast initial blast, color identity in the trail).
- Recycle, never allocate.

Net: kills the remaining alloc churn on multi-line clears + each clear visibly *belongs* to its piece colors.

#### G2 — Shatter directionality

Replace random radial velocities at [tetris.html:1869-1874](../project/tetris.html#L1869-L1874) with **row-axis biased** trajectories:

- Compute a row-relative velocity: outward in X (away from row center, scaled by column distance), upward in Y (the existing burst), with a small random Z spread biased *toward camera* (positive Z) so shards arc into the viewer's space rather than half disappearing behind the case.
- Add **angular momentum** aligned with the burst direction so shards tumble while they fly, not just spin in place.
- Keep total shard count and the existing pool — only the per-instance write at spawn changes.

Net: shatter reads as "the row exploded outward" instead of "fireworks at the cell."

#### G3 — Slow-mo on Tetris (4-line) and partial slow-mo on triple

Implement once, scales for free:

- Add a `gameTimeScale` multiplier (default 1.0). Apply it to:
  - `dt` going into game logic (gravity, lock delay).
  - `dt` going into shard/sparkle/flash lifetimes (multiply where they tick).
  - **Not** to camera tween, controls, or rendering — those stay real-time so input still feels responsive.
- On `clearLines(rows)`:
  - `rows.length === 4` → `gameTimeScale = 0.35` for 280ms, then ramp back to 1.0 over 220ms.
  - `rows.length === 3` → `gameTimeScale = 0.55` for 180ms.
  - `rows.length <= 2` → no slow-mo (would feel like input lag for routine clears).
- The slow-mo extends the shatter trajectory visibly *and* gives the punch-zoom and camera shake longer to register before the next piece spawns.

#### G4 — Coherent camera shake

Replace [tetris.html:2487-2496](../project/tetris.html#L2487-L2496):

- Build a tiny 1D simplex/Perlin lookup once at boot (or use 3 phase-offset sine sums — cheaper, indistinguishable for shake).
- `shakeOffset.x = noise(t * 18 + 0)`, `.y = noise(t * 18 + 100)`, `.z = noise(t * 14 + 200) * 0.5` — multiplied by `shakeIntensity`.
- `shakeIntensity` decay unchanged.

Net: a directional, kinetic shake instead of static. The same intensity will *read* roughly twice as strong because it's coherent.

#### G5 — Floating "+score" popup at the clear location

CSS3D popup (no new renderer), pooled:

- 4-element pool of absolutely-positioned `<div>`s parented to a `CSS3DObject`.
- On clear, set position to `caseGroup` world-pos at the cleared rows' y-mean, x=0.
- Animate `transform: translateY(-N)` and `opacity: 1 → 0` over 1s via the existing animation loop (pool slot has `t` and `dur`).
- Text: `+800 × Level 7` for the score delta. Color: average cleared piece color.

Risk: CSS3D popups bleed through stack cubes. Mitigate by parenting them in front of the case (`+5` z) so they always render on the camera-facing side.

#### G6 — Multi-line callout banner

Companion to G5. On `rows.length >= 2`:

- Center-screen pooled CSS3D label: `DOUBLE!` / `TRIPLE!` / `TETRIS!` (4-line is the headline word).
- Briefly punches in (`scale: 0.6 → 1.05 → 1.0`) over 200ms, holds 350ms, fades in another 250ms.
- Color matches the average cleared color; subtle text-shadow bloom carries through the bloom pass since CSS3D layers separately.

---

### 3.2 Hard drop (the missing payoff)

Hard drop currently sets piece-velocity downward, locks, done. The most
satisfying input in Tetris should *look* the most satisfying.

#### G7 — Hard-drop streak

- On `hardDrop`, before locking, capture the piece's start-row and end-row.
- Spawn a single **instanced trail** (reuse the shard pool? — no, shard shader is physics-driven; better to add a tiny new pool of 16 elongated quads):
  - 4 quads per cell × up to 4 cells = 16 quads max, pre-allocated.
  - Each quad spans from start-y to lock-y, height = (start-y - lock-y), width = `CELL`.
  - Material: additive, color = piece color, fades opacity 0.5 → 0 over 0.25s.
- Net: a clear vertical streak from old position to lock position, color-tied to the piece.

Cheaper alternative if quad-pool is overkill: scale-Y a single per-piece "trail rectangle" and animate scale-Y down to 0 over 0.25s — same visual, half the meshes.

#### G8 — Impact ring at lock row

- One pre-allocated `RingGeometry` mesh at boot, parented under `caseGroup`, `visible: false`.
- On hard-drop lock, position at lock-row y, set `visible: true`, animate `scale 0.4 → 1.8` and `opacity 0.9 → 0` over 0.35s, hide at end.
- Color: piece color.
- Bonus: tiny `PointLight` flash from the existing `flashLightPool` at lock-row (intensity 8, decay 0.2s) — already pooled, no new infra.

#### G9 — Hard-drop screen kick

- Add `pieceVel.y -= 8 + dropped * 0.4` is already there ([tetris.html:1517](../project/tetris.html#L1517)) — that drives the bounce. Pair with `shakeIntensity = 0.15 + dropped * 0.02` (small, brief) so the camera registers the hit even on routine drops. Keeps the multi-line shake clearly louder.

---

### 3.3 Lock & settle

The moment a piece becomes part of the stack should be felt as a *click*.

#### G10 — Squash & stretch on locked cubes

- On `lockPiece`, after building the cube meshes ([tetris.html:1535-1540](../project/tetris.html#L1535-L1540)), push each cube into a new `lockAnims` list with an initial scale of `(1.18, 0.82, 1.18)`.
- Tick in animate loop: spring back to `(1, 1, 1)` over 0.18s with overshoot (cubic ease with k=1.05 peak).
- Cubes share geometry, so this is matrix-only — cheap.

Risk: with the cube's existing `cubeAnims` settle (used for shifting after a clear), the two systems must not double-write `cube.position`/`scale`. Use a separate `cube.scale` channel for `lockAnims`; positions stay independent.

#### G11 — Faint dust ring under freshly locked piece

- Reuse the impact ring pool from G8 with a smaller scale (0.3 → 0.9, opacity 0.4 → 0, 0.25s). Color: piece color.
- This makes routine landings feel grounded without needing a hard-drop.

#### G12 — Lock delay flash on the contact face

- 100ms before lock (i.e. when piece is at floor and gravity timer is about to fire `lockPiece`), pulse the piece's emissive intensity from `0.95 → 1.4 → 0.95`.
- Implemented by reading `lockTimer` if one exists; otherwise add a soft "is-grounded for 1+ frame" flag and animate from there.
- Subtle but communicates "this is locking next."

---

### 3.4 Active piece feedback

#### G13 — Fix the rotation-kick energy bug

[tetris.html:1494-1495](../project/tetris.html#L1494):
```diff
   if (success) {
-    pieceRotVisual = dir > 0 ? -0.45 : 0.45;
-    pieceRotVel = 0;
+    pieceRotVel = dir > 0 ? -8 : 8;
   }
```
Set the *velocity*, not the static offset. The existing spring at
[tetris.html:2435](../project/tetris.html#L2435) (`pieceRotVel += (-pieceRotVisual * 80 - pieceRotVel * 9) * dt`) then drives a swing-and-decay from zero offset, which is what a kick should look like.

#### G14 — Side-wall bonk

- In `tryMove(dx, 0)`, when the move *fails* against a wall (not a stack collision), apply a small `pieceVisualOffset.x += sign(dx) * 0.18` and `pieceVel.x = 0`. The existing spring decays it back over ~0.15s — looks like the piece bounced off the wall. Currently the failed move is silent.

#### G15 — Soft-drop trail dots

Cheap and good: spawn 1–2 sparkles from the bottom-of-piece every 50ms while soft-drop is held. Reuses the existing sparkle pool, no new infra.

---

### 3.5 Ghost piece

#### G16 — Wireframe-only ghost

[tetris.html:1452-1464](../project/tetris.html#L1452-L1464):
- Stop adding the body mesh in `makeCube({ ghost: true })` — return only the `LineSegments` edges + an empty group. Edges keep the existing additive blending and tint.
- Result: ghost reads as a *frame*, not a faint cube. No more "is that a real cube I can't see?" ambiguity.

Risk: edge geometry alone may be too thin. Mitigate by adding a *second* edge `LineSegments` slightly inset (90% scale) so the ghost has a "double-line" hint of volume.

---

### 3.6 Level up

#### G17 — Level-up flash

- When `newLevel > level` triggers ([tetris.html:1565](../project/tetris.html#L1565)):
  - Pulse the case-frame line emissive (the `frameMat` color we already have) from current → bright white → current over 0.35s.
  - Spawn a center-screen CSS3D label `LEVEL N` reusing the G6 callout pool.
  - Brief 0.25× extra bloom strength via `bloomPass.strength += 0.4` for 0.4s, then back.

Cost: ~10 LOC total since the callout pool already exists.

---

### 3.7 HUD reactions

#### G18 — Score panel pulse on increase

- In `updateHUD`, compare new score vs displayed score; if it grew, briefly add a CSS class `panel-pulse` to `scoreEl` that scales 1 → 1.06 → 1 over 0.25s with a cyan box-shadow flash.
- Same for the lines panel when `lines` increases.

#### G19 — Number tick animation

- Replace the instant `score.toLocaleString()` swap with a 0.4s ease that lerps from displayed-score to actual-score, written into the panel each frame.
- For small increments (+1 soft-drop) keep instant; only animate for clears (delta ≥ 100).

---

### 3.8 Game over (the signature moment)

#### G20 — Stack shatter on top-out

[`triggerGameOver`](../project/tetris.html#L2204) currently just shows the
HTML overlay. The whole *premise* of the visual ("Shattered" overlay
title, glass case theme) needs the case to actually shatter:

- Walk every cell in `cellMeshes`, call `shatter(cube)` on each, in a top-down sweep with a 12ms stagger per row (so it cascades, not all at once).
- `removeFromParent()` each cube as it shatters.
- Camera punch-zoom amount = 1.0 (full Tetris-strength), shake intensity = 1.6.
- Briefly tint the bloom pass strength up so the shatter blooms hard.
- Then fade in the HTML overlay over 0.6s.
- Required: shard pool capacity 2048 may not fit 600 cubes × 8 shards = 4800. Either bump capacity to 4096 (~80KB extra) or stagger the shatter sweep so the pool's ring-buffer recycles mid-cascade.

Net: top-out feels *catastrophic*, which is the entire vibe of the build.

---

## 4. Priority order

Sorted by visible-impact-per-engineering-hour. All Tier 1 items are
under a day's work each.

### Tier 1 — high impact, low effort (do first)

| # | Effort | Why first |
|---|---|---|
| G4 — Coherent camera shake | 30 min | Largest perceived-quality bump per LOC; current shake actively looks broken |
| G13 — Rotation-kick energy fix | 5 min | One line; fixes a bug that's been there since v1 |
| G17 — Level-up flash | 1 hr (uses G6's pool, plan G6 first) | Marks an event that's currently invisible |
| G18 — Score-panel pulse | 30 min | Pure CSS animation; HUD comes alive |
| G14 — Side-wall bonk | 30 min | Free reuse of existing spring |
| G9 — Hard-drop screen kick | 10 min | One line in `hardDrop()` |

### Tier 2 — high impact, moderate effort

| # | Effort | Why |
|---|---|---|
| G1 — Pooled color-tinted flash slabs | 3 hr | Kills remaining alloc churn + restores color identity (E1, E2 together) |
| G6 — Multi-line callout banner | 2 hr | Builds the CSS3D popup pool that G5/G17 reuse |
| G5 — Floating score popup | 1 hr (after G6's pool) | The "juice" everyone notices |
| G8 — Impact ring | 1.5 hr | Dramatic on hard-drop, cheap to extend to G11 |
| G10 — Squash & stretch on lock | 2 hr | Routine satisfaction every 30 seconds of play |
| G3 — Slow-mo on Tetris | 1.5 hr | Single-shot global multiplier; ties shatter, popup, callout together |

### Tier 3 — signature pieces

| # | Effort | Why |
|---|---|---|
| G7 — Hard-drop streak | 3 hr | Finally makes hard drop *feel* hard |
| G20 — Game-over stack shatter | 4 hr | Pays off the entire "glass case" premise |
| G16 — Wireframe ghost piece | 1.5 hr | Removes long-standing ambiguity |
| G2 — Shatter directionality | 2 hr | Subtle but elevates every clear |
| G19 — Number tick animation | 1.5 hr | HUD goes from "screen text" to "scoreboard" |

### Tier 4 — small polish

- G11 — Dust ring on every lock
- G12 — Lock-delay emissive pulse
- G15 — Soft-drop sparkle trail
- G17's bloom-strength bump (alone, without G17 callout)

---

## 5. Implementation strategy notes

### Shared infrastructure to build first (paves the way for several items)

1. **CSS3D popup pool** (foundation for G5, G6, G7's optional text, G17)
   - Pool of N=8 absolutely-positioned `<div>`s, each wrapped in a `CSS3DObject`.
   - One scheduler that updates `transform/opacity/scale` based on per-popup `(t, dur, fromX, toX, fromY, toY, fromOpacity, toOpacity)`.
   - Show/hide via `visible` flag — no scene add/remove.

2. **Quad pool for trails / rings** (foundation for G7, G8, G11)
   - Pool of 16 reusable `Mesh(PlaneGeometry, MeshBasicMaterial)`.
   - Scheduler animates scale/opacity/color/lifetime.
   - The flash slabs (G1) are the same primitive — could share the pool with a capacity bump to 24.

3. **Scratch math objects** — the existing `_shardWorld`, `_shardColorObj` pattern is good. Extend it: `_tmpVec3a/b/c` at module scope so spring/anim/popup math doesn't allocate inside the frame loop.

### Risk: bloom over-saturation on top of G1/G6/G7/G8/G17

Every Tier 2/3 item adds emissive content at full bloom. The current
`UnrealBloomPass` uses `threshold=0.85`. If the screen blooms uniformly
white during a Tetris (slabs + popup + shake + shards + level-up flash
all firing within 400ms), drop `threshold` to 0.92 *during* the slow-mo
window and restore. A 4-line of `r * dt` events is the only place this
matters; routine drops won't trigger it.

### Risk: time-scale interaction with controls

`gameTimeScale` (G3) must NOT scale input handling. The gravity/fall
timer in [tetris.html:2410-2420](../project/tetris.html#L2410-L2420) and
the lock timer should get the scaled `dt`. The DAS/ARR timers
([tetris.html:2255-2256](../project/tetris.html#L2255-L2256)) and
keypress responses must use real-time `dt` so the player still feels
responsive during slow-mo.

### Risk: G20's shard capacity

2048 shards / 8-per-cube = 256 cubes' worth before the ring buffer wraps.
Worst case the play volume holds 600 cubes (10×20×3). Either:
- Bump `SHARD_CAPACITY` to 4096 (memory: ~200KB extra per attribute, fine), or
- Stagger the shatter sweep over ≥0.5s so the ring buffer recycles mid-cascade (need to verify the shader's lifetime check correctly hides recycled instances).

Recommend: bump capacity. Memory cost is trivial; staggering is correct anyway and complements the bump.

---

## 6. Out of scope

Background work the owner is rebuilding from scratch — not touched here:

- City group (buildings, pillars, scan cones, stars).
- Sky dome + horizon glow.
- Floor + floor ring + ground grid.
- Mood preset system *as it relates to background colors* (the rim-light/frame/grid colors stay relevant for the case itself, e.g. G17's frame pulse).
- Fog band + the case-vs-city depth separation work in [plan_fix.md A3/A4](plan_fix.md).

Items already shipped (not re-listed in fixes above):

- F1–F5 from [plan_fix_2_completed.md](plan_fix_2_completed.md).
- The composer pipeline from plan_fix.md B4.
- The shard / sparkle / flash-light pools from plan_fix.md B1–B3 (still need G1 to fully pool the flash *planes*).

---

## 7. Success criteria

After Tier 1 + Tier 2:

- [ ] Camera shake reads as kinetic, not static (G4).
- [ ] Every line clear shows a popup score and tints the flash to the cleared color (G1, G5).
- [ ] Tetrises trigger slow-mo, a `TETRIS!` callout, and a stronger camera reaction (G3, G6).
- [ ] Hard drops feel meaningfully different from soft drops (G9 minimum, G7 + G8 ideal).
- [ ] Locking a piece visibly squashes-and-stretches it (G10).
- [ ] Level-ups are unmissable (G17).
- [ ] Score/lines panels react when their numbers change (G18).
- [ ] No new per-frame allocations in any line-clear or hard-drop path.

After Tier 3:

- [ ] Top-out shatters the entire stack before the overlay appears (G20).
- [ ] Ghost pieces are unambiguous wireframes (G16).
- [ ] Shatter shards radiate visibly outward from cleared rows, not radially (G2).
