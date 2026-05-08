# TetrisPlus — Visual / Rendering / Performance Fix Plan

Scope: `project/tetris.html` (canonical). `project/game.js` is an older parallel build with strictly worse practices (per-shard `MeshPhysicalMaterial`, per-cube edge materials); the same fixes apply if it ships.

Stack assumed: Three.js r160, WebGL2, browser, 60 FPS target, single canvas + a `CSS3DRenderer` overlay for HUD.

---

## 1. Problem Analysis

### 1.1 Rendering / visual clarity

| # | Symptom | Where |
|---|---|---|
| R1 | Glass case is essentially invisible — blends into the background; cubes look like they float in space, no contained-volume read | [tetris.html:1075-1092](project/tetris.html#L1075-L1092) |
| R2 | Cube glass is "double-transparent" — transmission=1.0 AND transparent=true + opacity=1.0 force every cube into the alpha pass and through the wall's transmission buffer | [tetris.html:988-1014](project/tetris.html#L988-L1014) |
| R3 | Background skyline competes with the playfield: 80 individual emissive building meshes ringing the case at radius 38–62, plus 6 colored pillars, 3 scan cones, 600-point star field, horizon glow, sky dome | [tetris.html:626-917](project/tetris.html#L626-L917) |
| R4 | No depth separation between case and city — both sit in the same fog band (35–110), share saturation, share value range; the eye cannot tell which is gameplay | [tetris.html:624](project/tetris.html#L624) |
| R5 | Edge frame and top rim use `LineBasicMaterial` with `depthWrite:false` + `AdditiveBlending` and `renderOrder:10` — they bleed through cubes near the silhouette | [tetris.html:1138-1163](project/tetris.html#L1138-L1163) |
| R6 | Ghost piece is alpha-blended with `transmission=0` plus same emissive — ends up brighter than ghost-should-be in some viewing angles | [tetris.html:984-1014](project/tetris.html#L984-L1014) |

### 1.2 Material / lighting

| # | Symptom | Where |
|---|---|---|
| M1 | Wall material: `transmission:1.0`, `opacity:0.35`, `attenuationDistance:30`, `thickness:0.3`, `DoubleSide` — attenuation across 0.3 of 30 units = ~1% tint, so the case has no visible "body" of glass; opacity then alpha-blends a near-black wall with no depth contrast | [tetris.html:1075-1092](project/tetris.html#L1075-L1092) |
| M2 | Cubes use `MeshPhysicalMaterial` with full `transmission:1.0` + `clearcoat:1.0` + `iridescence:0.25` — most expensive PBR feature combo Three.js ships, on potentially 600+ cubes | [tetris.html:988-1014](project/tetris.html#L988-L1014) |
| M3 | Lighting is overpacked: hemi + directional + 3 point lights + topAccent + per-flash dynamic point lights. Adding/removing point lights at runtime triggers shader recompile spikes (a common Three.js stutter cause) | [tetris.html:485-506](project/tetris.html#L485-L506), [tetris.html:1648-1652](project/tetris.html#L1648-L1652) |
| M4 | Cube has 3 nested meshes (glass body + edge `LineSegments` + emissive inner core). At 600+ cubes that's 1800+ draw calls just for stack | [tetris.html:1042-1064](project/tetris.html#L1042-L1064) |
| M5 | `envMapIntensity:1.6` on cubes + `1.6` on walls + tone-mapped exposure 1.15 — combined the case rim is over-bright and washes out the cube color contrast | [tetris.html:357-358](project/tetris.html#L357-L358), [tetris.html:1009](project/tetris.html#L1009), [tetris.html:1090](project/tetris.html#L1090) |

### 1.3 Post-processing

| # | Symptom | Where |
|---|---|---|
| P1 | `EffectComposer`, `RenderPass`, `UnrealBloomPass`, `OutputPass` are imported but **never wired** — `renderer.render(scene, camera)` is called directly. The "neon city" look depends on bloom; without it, emissive meshes look flat | [tetris.html:273-276](project/tetris.html#L273-L276), [tetris.html:2262](project/tetris.html#L2262) |
| P2 | No depth-of-field, no vignette, no chromatic aberration, no fog gradient — flat tonemapped output | n/a |
| P3 | Antialias is left to MSAA (`antialias:true`); once a composer is added, MSAA on the default framebuffer is irrelevant for offscreen passes — needs FXAA or SMAA pass | [tetris.html:353](project/tetris.html#L353) |

### 1.4 Performance bottlenecks

| # | Symptom | Where | Cost |
|---|---|---|---|
| F1 | `rebuildPieceMesh()` + `rebuildGhostMesh()` allocate fresh `Mesh` + `LineSegments` + inner `Mesh` on **every move/rotate** (~24 meshes per keypress) | [tetris.html:1331-1365](project/tetris.html#L1331-L1365) | GC pressure on every input |
| F2 | `shatter()` spawns `8 × shatterPower` shards per cube × 3 depth slices × 10 cols × N rows. A 4-line tetris with `shatterPower=2.5` = 4 × 10 × 3 × 20 = **2,400 individual shard meshes** in one frame | [tetris.html:1556-1592](project/tetris.html#L1556-L1592) | Frame stutter on multi-clear |
| F3 | `spawnSparkles()` allocates a fresh `BufferGeometry` + `PointsMaterial` per cube cleared, dispose'd ~1.2s later. 4-line tetris = 120 buffer + material allocs | [tetris.html:1594-1624](project/tetris.html#L1594-L1624) | GC + WebGL handle churn |
| F4 | `triggerFlash()` adds a fresh `PointLight` to the scene per cleared row + 2 fresh `MeshBasicMaterial`+`PlaneGeometry`. Adding point lights at runtime forces Three.js to **recompile every material that responds to lights** | [tetris.html:1630-1670](project/tetris.html#L1630-L1670) | One-frame freeze on first multi-clear |
| F5 | 80 building meshes are not instanced, each has its own emissive texture sample but uses one of 6 shared textures — should be `InstancedMesh` | [tetris.html:677-727](project/tetris.html#L677-L727) | Steady-state draw call overhead |
| F6 | Stack cubes are not instanced; each is a 3-mesh `Group`. 600 cubes = 1800 draw calls + 600 transmission samples | [tetris.html:1042-1064](project/tetris.html#L1042-L1064) | Steady-state GPU cost |
| F7 | Cube `transmission:1.0` is the costliest path in `MeshPhysicalMaterial` — it duplicates the entire opaque pass into a transmission buffer per material **per frame** | [tetris.html:992](project/tetris.html#L992) | Constant GPU drain |
| F8 | `pixelRatio` clamped at 2 (good) but `antialias:true` on top of high DPR doubles fragment work — overkill | [tetris.html:353-354](project/tetris.html#L353-L354) | ~5–15% perf |
| F9 | Stars use `Points` with sparkle texture and 600 verts — fine, but uses `sizeAttenuation:true` with no LOD, contributes to fill on full screen | [tetris.html:799-832](project/tetris.html#L799-L832) | Minor fill |

### 1.5 Game feel

| # | Symptom | Where |
|---|---|---|
| G1 | Piece inertia spring is good, but no anticipation/squash before lock — pieces just *appear* settled | [tetris.html:2109-2129](project/tetris.html#L2109-L2129) |
| G2 | Camera shake is hard `Math.random()` jitter — looks like buffer corruption rather than impact | [tetris.html:2221-2230](project/tetris.html#L2221-L2230) |
| G3 | No slow-mo / time-dilation hook on multi-line clears (the punch-zoom is the only feedback) | [tetris.html:2024-2030](project/tetris.html#L2024-L2030) |
| G4 | Hard-drop has no trail, no impact ring, no afterimage — feels equivalent to soft-drop visually | [tetris.html:1412-1420](project/tetris.html#L1412-L1420) |
| G5 | Line-clear flash is white-only, ignores cleared piece colors → loses identity of what was destroyed | [tetris.html:1635-1668](project/tetris.html#L1635-L1668) |

---

## 2. Root Causes

1. **Glass is too transparent because the material is *both* refractive and alpha-blended.** Transmission already shows what's behind; pulling opacity to 0.35 doesn't make it "more glass," it just makes the wall fade into nothing. The case has no perceptual edge.
2. **No post-processing pipeline.** Bloom passes are imported and ignored, so the emissive city, neon edges, and shatter effects render flat — the "premium" feel is left on the table.
3. **No depth separation between gameplay and backdrop.** Same fog band, similar saturation, similar emissive intensity. The eye has nothing to lock onto.
4. **Effects are built from per-event allocations.** Each line-clear creates hundreds of `Mesh`/`Geometry`/`Material`/`Light` instances; multi-line clears multiply that. The stutter is GC + shader-recompile, not raw GPU cost.
5. **No instancing on scene-scale geometry** (stack cubes, buildings, shards). Each cell costs a full draw call × 3 sub-meshes; multiplied by transmission, the pipeline submits thousands of draws per frame.

---

## 3. Fix Plan

### A. Rendering & Visual Improvements

#### A1 — Glass case redesign (the headline fix)

Goal: the case reads as a contained volume from any angle, never disappears against the city.

- **Drop opacity blending entirely on the walls.** Set `transparent: false` so they render in the opaque pass; let `transmission` carry the see-through. This also removes most sort bugs.
- **Make the glass *thicker* and *tinted*.** Set `thickness: 1.2`, `attenuationDistance: 4.0`, `attenuationColor: 0x9ec8ff`. The eye now sees a faint blue volume that stays visible against any backdrop.
- **Add fresnel rim via clearcoat reflection.** `clearcoat: 1.0`, `clearcoatRoughness: 0.05`, `ior: 1.5`. The grazing-angle reflection is what reads as "glass."
- **Add inside-edge bevels.** Build the case as 4 thin slabs with `BoxGeometry` *plus* an inner `EdgesGeometry` running both at the bottom AND the vertical seams (currently only the outer frame is highlighted). The inner seams catch light and outline the play volume.
- **Add a soft frosted band at the base of each wall** (~0.5 units up) using a vertical roughness gradient — anchors the case to the floor.
- **Subtle internal volumetric light shaft** from above the case down — single faded plane with additive blending (one draw call), provides depth without volumetrics cost.

#### A2 — Cube material simplification

- **Stop forcing cubes into the transparent pass.** Set `transparent: false`, `opacity: 1.0` on non-ghost cubes. Keep `transmission`, but pair with `transmissionResolutionScale: 0.5` (Three.js ≥ r155) to halve the transmission buffer cost.
- Drop `iridescence` — it's a per-fragment cost on every cube and the visual gain is invisible against the bloom pass.
- Reduce `envMapIntensity` from 1.6 → 1.0 so the rim doesn't overwhelm cube color.
- Move emissive intensity from 0.08 → 0.3 so cubes still glow when sitting still in low-light.
- **Collapse the 3-mesh-per-cube group into a single `InstancedMesh`** for the stack (see C2). Edges and inner core become a separate single InstancedMesh each, sharing the same instance matrices.

#### A3 — Depth separation: fog, DOF, hierarchy

- **Two-zone fog**: tighten gameplay fog (`scene.fog` → 25–55) so the case sits in clear air but the city is hazed out. The current fog (35–110) lets the city compete.
- **Add `BokehPass` (or cheaper `unreal/DepthOfFieldPass` substitute via custom shader)** — focus distance = camera→target distance, aperture small. The city blurs naturally; the case stays sharp.
- **Desaturate the city.** Drop building `emissiveIntensity` from 1.6 → 0.6 and shift colors toward a single hue family per scene (already done in mood presets but not enforced — currently each building randomly picks any of 6 colors). Pick at most 2 hues from the mood palette.
- **Reduce city light count.** 80 buildings → 40 (instanced). 6 pillars → 3. 3 scan cones → 2. The city was already mostly hidden by fog; we're paying for what nobody sees.
- **Vignette via post-process** (1 fullscreen quad, ~0.05ms) pulls eye to center.

#### A4 — Background treatment

- Replace the explicit emissive-textured building meshes with a single **billboarded `PlaneGeometry` skybox layer** showing a pre-baked city silhouette + bokeh, rendered once and parallax-scrolled with camera angle. This removes 80+ draw calls and looks identical at distance.
- Keep 4–6 hero buildings as real geometry near the foreground for parallax cue.
- Sky dome stays. Star field can drop to 200 points.

---

### B. Effects System Redesign

The current line-clear path is the worst-offending hot path. Replace with shader-driven, pooled effects.

#### B1 — Replace per-shard `Mesh` shatter with a single GPU-instanced shard system

- One `InstancedMesh` of `TetrahedronGeometry`, capacity = 1024 shards, allocated once at boot.
- Per-instance attributes (`InstancedBufferAttribute`): `aSpawnTime`, `aVelocity`, `aColor`, `aSeed`.
- Custom vertex shader animates position via `time - aSpawnTime`, applies gravity, drag, and rotation entirely on the GPU. CPU just sets a free-list index when spawning a cell's worth of shards.
- Fragment shader: `aColor` × additive bloom-target with a soft falloff (no texture lookup needed).
- Net effect: line clear becomes **1 draw call regardless of shard count**, zero per-frame allocations.

#### B2 — Replace `spawnSparkles` per-cell with a global pooled `Points` system

- One `BufferGeometry` of capacity 4096 sparkle vertices, pre-allocated.
- One `PointsMaterial` (or shader material with size-attenuation + lifetime fade in shader).
- A ring buffer of free indices; `spawnSparkles(pos, color, count)` writes positions + lifetimes into the next `count` slots. Old sparkles fade out via `alpha = 1 - clamp((t - aSpawn) / lifetime, 0, 1)` in the shader.
- Net effect: one draw call for all sparkles ever, no allocs.

#### B3 — Replace per-row `triggerFlash` with a fullscreen shader pulse + a *static* light pool

- Pre-create **3 reusable `PointLight`s** at scene boot, parented under `caseGroup`, all with `intensity:0`. Animate intensity for flash; never add/remove. This kills shader recompile spikes.
- Replace the two flash planes per row with a single **shader pass on a horizontal "cleared row" slab** — `ShaderMaterial` with a soft bloom kernel + per-row color from the cleared cell colors (passed as `uColor` uniform). Reuse 4 pre-allocated slabs (max 4 rows = a Tetris).
- Flash color = average of the cleared row's piece colors → preserves identity (G5).

#### B4 — Bloom + post-process pipeline (already imported, finally wire it up)

```
RenderPass(scene, camera)
  → UnrealBloomPass(threshold=0.85, strength=0.6, radius=0.7)
  → BokehPass (or fast-DOF custom)
  → VignettePass (custom one-liner)
  → SMAAPass (cheap antialias for offscreen targets)
  → OutputPass
```

Set `renderer.antialias = false` once composer is in place; SMAA replaces it.

#### B5 — Hard-drop trail + impact ring (G4)

- Hard-drop: spawn an instanced "afterimage" of the falling piece — 4 ghost copies along the drop path, each with a 0.15s fadeout via the same instanced cube system.
- Impact ring: one additive ring mesh at the lock-row, scales 0→2× over 0.25s. Pre-allocated.

#### B6 — Slow-mo on multi-line clears (G3)

- On `rows.length >= 3`, scale `dt` down to 0.4× for ~250ms (real-time), then ramp back to 1.0× over 200ms. Implemented as a single multiplier on the animation loop's `dt` going into game logic + effects (not into rendering — rendering stays 60fps).
- The punch-zoom and shake already exist; pair them with the slow-mo for cinematic impact.

---

### C. Performance Optimization

Priority is by impact / effort.

#### C1 — Static light pool (1 hour, kills the worst stutter)

The dynamic `PointLight` add/remove in `triggerFlash` is almost certainly the main multi-line-clear stutter. Pre-allocate. Single highest-leverage change.

#### C2 — `InstancedMesh` for stack cubes (~half a day)

- One `InstancedMesh` for cube bodies (`MeshPhysicalMaterial` with transmission), capacity 600 (= COLS×ROWS×DEPTH).
- One `InstancedMesh` for inner emissive cores (`MeshBasicMaterial` additive).
- One `InstancedMesh` (or `LineSegments` baked into a single `BufferGeometry` rebuilt incrementally) for edges. Edges are the hardest because Three.js doesn't instance LineSegments well — alternative: bake edges into a thin emissive lip on the cube body's UVs (an emissive "rim map") and skip the line geometry entirely. **Recommended: drop separate edge geometry, replace with rim-light shader chunk on the body material.**
- Cell→instanceIndex map keeps O(1) updates. Stack updates become matrix writes only.

Outcome: 1800 draw calls → 2.

#### C3 — `InstancedMesh` for buildings + reduced count (~2 hours)

- 40 instanced buildings sharing one geometry, one of 2 materials (split by texture). 80 draw calls → 2.
- Bake emissive textures into a single 2K atlas to drop to 1 material + 1 draw call.

#### C4 — Pooled shatter / sparkle / flash (see B1–B3, ~1 day)

Removes the per-frame allocation spikes that show up as multi-line stutter.

#### C5 — Drop `iridescence`, halve transmission resolution (~10 min)

- `transmissionResolutionScale: 0.5` cuts the transmission pass cost in half.
- Removing `iridescence` removes a per-fragment branch on every cube.

#### C6 — Disable MSAA once composer ships (~5 min)

`renderer = new THREE.WebGLRenderer({ antialias: false })`, let SMAA handle it.

#### C7 — Avoid mesh recreation on every move (~30 min)

- Allocate piece + ghost as 4 reusable cube `Mesh` slots × 3 depth slices = 12 piece slots + 12 ghost slots.
- On move/rotate, *update positions* instead of clearing + recreating the group.
- Easier still: once stack is `InstancedMesh`, the active piece can use the *same* InstancedMesh with a "preview" instance range, just rewriting matrices. Same for ghost.

#### C8 — Pre-allocate `Vector3`s in hot loops (~10 min)

`shatter()` and `clearLines()` allocate fresh `Vector3` per shard. Use a scratch vector at module scope.

#### C9 — `frustumCulled` review

The case + cubes never leave the frame — `frustumCulled = false` on the `caseGroup` saves a per-mesh frustum test each frame. Negligible but free.

**Priority impact:** C1 + C4 fix the user-reported stutter. C2 + C3 fix steady-state cost. C5 + C6 are free.

---

### D. Game Feel Enhancements

#### D1 — Smooth camera shake (Perlin noise instead of `Math.random`)

Replace per-axis `random() - 0.5` with a 3-channel noise lookup keyed by `time` so the shake is *coherent* (looks like a hit, not like static):
```
shakeOffset.x = noise(time * 18, 0) * intensity
shakeOffset.y = noise(time * 18, 100) * intensity
shakeOffset.z = noise(time * 14, 200) * intensity * 0.5
```

#### D2 — Squash & stretch on lock

- On `lockPiece`, scale the locked cubes to `(1.15, 0.85, 1.15)` instantly, then spring back to `(1,1,1)` over 0.18s. Sells the impact.
- Implement via instance-matrix scale in C2's instanced cube system.

#### D3 — Slow-mo + chromatic aberration on Tetris (4-line)

- 250ms time dilation (B6).
- Briefly increase post-process chromatic-aberration uniform (peak 0.005, decay 0.4s) — single uniform, no perf cost.

#### D4 — Hard-drop afterimage (B5).

#### D5 — Ghost piece distinction

Currently ghost is just transparent + low emissive — reads as "broken cube" not "preview." Replace with a wireframe-only render (single `LineSegments` per cell, additive, color-tinted) so it never looks like a real cube.

#### D6 — Rotation kick — already exists ([tetris.html:1395](project/tetris.html#L1395)) but `pieceRotTarget = 0` line two lines later cancels the kick angle. Bug: remove the override so the kick actually animates instead of decaying from a frozen offset.

---

## 4. Priority Roadmap

### Phase 1 — Must-fix (ship first; resolves all reported issues)

| Task | Section | Reason |
|---|---|---|
| Wire up the post-process pipeline (bloom + vignette + SMAA) | B4 | Imports already in file; biggest visual upgrade per line of code |
| Glass case redesign (opaque-pass walls, thicker+tinted, better fresnel) | A1 | Directly addresses the "blends with background" complaint |
| Static light pool (no dynamic add/remove on flash) | C1, B3 | Eliminates the worst multi-line stutter (likely root cause) |
| Pooled shatter (instanced GPU shards) | B1, C4 | Eliminates the second source of stutter, looks better |
| Pooled sparkles | B2, C4 | Removes alloc churn |
| Two-zone fog + bloom-driven city desaturation | A3, A4 | Background stops competing for attention |
| Drop iridescence, set `transmissionResolutionScale: 0.5`, disable MSAA in favor of SMAA | A2, C5, C6 | Free 10–20% perf |
| Fix rotation-kick bug (D6) | D6 | One-line bug |

### Phase 2 — Major visual upgrade

- `InstancedMesh` for stack cubes + remove per-cube edge geometry in favor of rim-light shader chunk (C2, A2)
- `InstancedMesh` for buildings + texture atlas (C3)
- Replace background buildings beyond inner ring with parallax skybox (A4)
- DOF / bokeh pass (A3, B4)
- Squash-and-stretch on lock (D2)
- Coherent camera shake (D1)
- Hard-drop afterimage + impact ring (B5)

### Phase 3 — Polish / juice

- Slow-mo on Tetris with chromatic-aberration burst (D3, B6)
- Color-aware line-clear flash (B3 final form)
- Wireframe ghost (D5)
- Inner volumetric light shaft in case (A1)
- Frosted band at wall base (A1)
- Stack cubes use the same instanced system as the active piece (C7)

---

## 5. Implementation Strategy

### Phase 1 — file-by-file

**`project/tetris.html`**

1. **Composer wiring** — after renderer creation (~line 360), add:
   - `composer = new EffectComposer(renderer)`
   - `RenderPass`, `UnrealBloomPass(threshold=0.85, strength=0.6, radius=0.7)`, custom `VignettePass` (10-line `ShaderPass`), `SMAAPass`, `OutputPass`
   - Replace `renderer.render(scene, camera)` at [tetris.html:2262](project/tetris.html#L2262) with `composer.render()`. Keep the cssRenderer.render() call directly after.
   - Update resize handler to call `composer.setSize`.
   - Risk: tone mapping + bloom can over-bloom highlights. Tune `threshold` first, then `strength`.

2. **Case material rewrite** — [tetris.html:1075-1129](project/tetris.html#L1075-L1129)
   - Set `transparent: false` on `wallMat` and `bottomMat`; remove `opacity`.
   - `thickness: 1.2`, `attenuationColor: 0x9ec8ff`, `attenuationDistance: 4.0`.
   - Add an inner `EdgesGeometry` LineSegments that traces the *interior* edges of the case (currently only outer frame).
   - Risk: sort-bugs against cubes if cubes also stay in alpha pass. Mitigated by A2.

3. **Cube material cleanup** — [tetris.html:984-1014](project/tetris.html#L984-L1014)
   - `transparent: false`, `opacity: 1.0` on non-ghost path.
   - Remove iridescence fields.
   - `transmissionResolutionScale: 0.5` (Three.js r155+; check version).
   - Ghost cubes: keep `transparent: true`, drop emissive entirely, render as `LineSegments`-only (Phase 3 polishes this further).

4. **Static light pool** — replace [tetris.html:1648-1652](project/tetris.html#L1648-L1652)
   - At scene boot, create `flashLightPool = [pl1, pl2, pl3, pl4]`, all `intensity: 0`, parented under `caseGroup`.
   - In `triggerFlash`, pull next free light, set position + intensity, push into `flashes` with `isLight: true`.
   - In animation tick, fade `intensity` to 0 and return to pool. Never `caseGroup.remove(light)`.

5. **Pooled shatter system** — replace [tetris.html:1556-1592](project/tetris.html#L1556-L1592)
   - At boot: `shardMesh = new InstancedMesh(SHARD_GEOM, shardShaderMat, 1024)`, `shardMesh.frustumCulled = false`, set initial scales to 0.
   - Free-list `shardFreeList` of indices.
   - `shatter(cube)` writes per-instance attributes (spawn time, velocity, color, seed) and `instanceMatrix.needsUpdate = true`.
   - Vertex shader integrates physics from `time - aSpawnTime`. Lifetime fade by scale → 0.
   - Risk: 1024 capacity may be tight for `shatterPower=2.5` Tetris (2400 shards). Cap shard count per cube based on total active or raise to 4096.

6. **Pooled sparkle system** — replace [tetris.html:1594-1624](project/tetris.html#L1594-L1624)
   - Single `Points` of capacity 4096, ring buffer.
   - Shader-driven lifetime fade.

7. **Two-zone fog + city desaturation** — [tetris.html:624](project/tetris.html#L624) + [tetris.html:677-727](project/tetris.html#L677-L727)
   - `scene.fog = new THREE.Fog(moodColor, 25, 55)`.
   - Drop `emissiveIntensity` to 0.6, restrict each building's color to one of 2 mood-aligned hues.

8. **Phase 1 free wins** — [tetris.html:353](project/tetris.html#L353), [tetris.html:1395](project/tetris.html#L1395)
   - `antialias: false`.
   - Remove the `pieceRotTarget = 0` line that defeats the rotation kick.

**Risks**
- Composer + transmission interaction: `MeshPhysicalMaterial.transmission` requires the renderer's auto-clear; verify with a test scene that bloom doesn't double-blur the transmission buffer.
- SMAA + DPR=2 on a 4K display can be GPU-bound. Drop SMAA for FXAA on lower-tier GPUs (auto-detect via `renderer.capabilities.maxTextures` heuristic).
- Removing `transparent:true` on cubes may unmask Z-fighting with the case walls if their bounds touch — verify clearance.

### Phase 2

**InstancedMesh stack** — biggest change, isolate behind a `Stack` class:
- `Stack.set(col, row, depth, color)` writes a matrix + color attribute.
- `Stack.clear(col, row, depth)` zeros the matrix scale (cheap "hide").
- `Stack.shiftDown(rows[])` writes new matrices for surviving cubes — animated via the existing `cubeAnims` system but driven by lerping the `aTargetMatrix` attribute in the shader.
- Risk: edge highlight on cubes had to die. Replace with a rim-light effect in the cube's fragment shader (`onBeforeCompile` injecting a fresnel emissive term). Verify it reads as a beveled edge in motion.

**Building instancing** — straightforward `InstancedMesh` swap; the per-building rotation goes into the instance matrix.

**Hard-drop afterimage** — uses the same instanced active-piece system; just keep N copies of the piece's instance range with timestamps.

### Phase 3

- Slow-mo: a single `gameDtScale` global multiplier. Apply only to game logic + effect lifetimes; rendering stays at real time.
- Volumetric light shaft + frosted band: shader-only, single quad each. Cheap.

---

## 6. Risks & Tradeoffs

| Risk | Where | Mitigation |
|---|---|---|
| Bloom over-blooms emissive UI panels (CSS3D) | B4 | CSS3D renders to a separate DOM layer, not the WebGL canvas — bloom doesn't affect them. Verified by current architecture. |
| Pre-allocated shard pool too small for `shatterPower=2.5` Tetris | B1 | Either raise capacity to 4096 (negligible memory: ~200 KB) or cap `shardsPerCube` based on simultaneous load. |
| Custom shader maintenance burden | B1, B2, A2 rim-light | Keep shaders inline in the HTML file; document the per-instance attribute layout. Three.js `onBeforeCompile` is fragile across versions — pin Three.js to r160 (already done). |
| Removing `transparent:true` from cubes regresses rendering of overlapping ghost cubes | A2 | Ghost path keeps alpha; only non-ghost cubes go opaque. |
| Time-dilation breaks input feel if applied to input handling | B6, D3 | Apply scale only to gravity/effect lifetimes; input still polls real time. |
| `InstancedMesh` doesn't support per-instance `MeshPhysicalMaterial.transmission` cleanly across all GPUs | C2 | Acceptable: the cubes keep transmission via the *material* (one shader); per-instance variation is just color (via `InstancedBufferAttribute`). Validated by Three.js `webgl_instancing_dynamic` example pattern. |
| Reducing building count makes the city feel emptier | A4 | Compensate with the parallax skybox layer; verify subjectively. |
| DOF/bokeh is expensive on integrated GPUs | A3, B4 | Make it gated by a quality preset (the existing TWEAKS panel is the natural home — add a `quality: low/med/high` toggle). |
| MSAA→SMAA swap may show aliasing on thin edges | C6 | SMAA handles thin geometry well; if aliasing persists on the case frame lines, add a thin opaque-pass border behind the additive lines so they get SMAA-filtered. |

---

## Success criteria checklist

- [ ] Glass case is visible from any orbit angle against any backdrop (A1, A3)
- [ ] Background never crosses the case silhouette readably (A3, A4)
- [ ] Multi-line clears (especially Tetris) hit a stable 60 fps with no recompile spike (C1, B1, B2, B3)
- [ ] Cube colors read clearly even when stacked deep (A2, M5)
- [ ] Effects look "premium" — bloom-lit, color-coherent, with anticipation+impact (B4, B5, D2, D3)
- [ ] No additional gameplay regressions (movement, scoring, collision unchanged)
