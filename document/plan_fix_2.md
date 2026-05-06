# TetrisPlus — Visual Diff Fix Plan v2

Scope: align the live build (`project/tetris.html`) with the reference picture
[`project/uploads/fa0e5853-c63b-46f0-baf0-660f95921aa3.png`](../project/uploads/fa0e5853-c63b-46f0-baf0-660f95921aa3.png).
Current state captured in
[`project/screenshots/current.png`](../project/screenshots/current.png).

This is a focused follow-up to [plan_fix.md](plan_fix.md) — narrower, framed
strictly by what the two pictures look like side-by-side.

---

## 1. Side-by-side observation

| # | Aspect | Reference (target) | Current build | Severity |
|---|---|---|---|---|
| D1 | Cube color saturation | Solid, opaque, glossy candy colors — red, orange, yellow, green, blue, violet — each cube reads as a distinct hue at any depth | Cubes are washed-out, semi-transparent stained glass; iridescent sheen blends adjacent cells together | **High** |
| D2 | Cube body opacity | Effectively opaque with strong specular highlights; you can't see the back wall through any cube | `transparent: true; opacity: 0.7` — back wall, floor, and other cubes leak through every cell | **High** |
| D3 | Cube emissive lift | Each cube has a saturated inner glow visible from any angle | Inner glow exists but is faint compared to the bloomed reference | Medium |
| D4 | Edge / bevel definition | Cubes have a clear bright bevel between adjacent cells, so the stack reads as a stack of *individual* blocks | Bevel edges fade out at the alpha-pass boundary; adjacent cells smear together | Medium |
| D5 | Glass case wall presence | Walls are clearly there: bright top rim, vertical seams catch light, faint blue tint of "thick glass" | Walls are barely visible — only the top rim reads; vertical seams nearly invisible against city | Medium (covered in plan_fix.md A1) |
| D6 | NEXT panel content | Big, bright cyan I-piece icon, immediately legible | Tiny dim square; the piece preview is so small at panel scale it looks empty | **High** |
| D7 | HOLD panel content | Big violet T-piece icon, same prominence as NEXT | Empty / no piece icon | High (partly state, partly scale — see §3.6) |
| D8 | LINES panel | Reads "23" — large numeric, same panel style as SCORE | Visible in the corner but the number ("0") is so small the panel looks empty | Medium |
| D9 | SCORE panel | "12450 / LEVEL 7" — large, prominent | "64 / LEVEL 7" — visible but smaller relative to the case | Low (mostly gameplay state; see §2) |
| D10 | Line-clear shatter / light burst | A dramatic shatter is mid-frame: glass shards radiating outward + central white-hot bloom | Static frame, no shatter active | Low (timing — see §2) |
| D11 | Active piece visibility | Bright saturated orange bar at top — clearly the moving piece | Faint cyan piece at top, low contrast against the case | Medium |
| D12 | Background brightness | Warm bokeh, soft horizon, never overpowers the case | Cooler, dimmer, but the case is so washed out the background still competes | Medium (covered by plan_fix.md A3/A4) |

---

## 2. What is *not* a bug

These differences are inherent to the moment captured, not the code:

- **Stack height / score / lines count.** Reference is mid-game (12,450 pts,
  23 lines, deep stack). Screenshot is early-game (64 pts, 0 lines, two
  pieces locked). No code change can make a fresh game look like the 8th
  minute.
- **Shatter / line-clear flash mid-air.** The reference froze a single frame
  during a line clear; the screenshot froze a quiet moment. The shatter
  *system* exists in code ([tetris.html:1852](../project/tetris.html#L1852))
  and fires on `clearLines`. Not a defect on its own.

We exclude these from the fix list. Everything below is a real visual gap.

---

## 3. Root-cause analysis

### 3.1 Cube body looks like stained glass instead of candy plastic (D1, D2, D3)

[`getCubeMaterial`](../project/tetris.html#L1047) at
[tetris.html:1047-1081](../project/tetris.html#L1047-L1081):

```js
const mat = new THREE.MeshPhysicalMaterial({
  color: c,
  metalness: 0.0,
  roughness: 0.08,
  ior: 1.5,
  clearcoat: 1.0,
  clearcoatRoughness: 0.03,
  iridescence: 0.35,                 // ← desaturates color
  iridescenceIOR: 1.3,
  iridescenceThicknessRange: [100, 400],
  specularIntensity: 1.0,
  specularColor: 0xffffff,
  transparent: true,                  // ← forces alpha pass
  opacity: opts.ghost ? 0.12 : 0.7,   // ← cubes are 30% see-through
  envMapIntensity: 1.0,
  emissive: c,
  emissiveIntensity: opts.ghost ? 0.15 : 0.45,
  ...
});
```

Three independent settings stack to make the cube look thin and grey:

1. **`opacity: 0.7`** — every cube blends 30% of whatever is behind it. With
   3 cubes in a row down the depth axis, the back row is multiplicatively
   washed by the front rows. The reference is *not* "transparent glass" — it
   is **opaque resin** that just *looks* glossy.
2. **`iridescence: 0.35`** — physically correct rainbow film over every
   surface. It actively works against the goal of "make this red cube
   unambiguously red." Iridescence belongs on bubbles and oil slicks, not on
   stack pieces meant to be color-coded.
3. **`emissiveIntensity: 0.45`** combined with low opacity — the
   self-illumination is partly thrown away through the alpha channel. The
   cube glow is what bloom feeds on; bleeding it through alpha steals it.

The author's comment block ("Glass-look without `transmission`…") explains
the intent: avoid the transmission-buffer exclusion bug. That intent is
fine, but the parameters chosen for the workaround are the visual problem —
opacity 0.7 + iridescence is the wrong recipe for that goal. The reference
look is achievable while still keeping the cubes in the wall's transmission
buffer (i.e. still alpha-blended), but at a much higher opacity and without
iridescence.

### 3.2 Edge bevels disappear into adjacent cells (D4)

[`getEdgeMaterial`](../project/tetris.html#L1084) uses additive blending:

```js
return new THREE.LineBasicMaterial({
  color: ec,
  transparent: true,
  opacity: ghost ? 0.2 : 0.7,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
```

Additive blending means an edge of cube A and the body of cube B
*add together* in screen space. With both at opacity 0.7, a stack of
similarly-colored cubes shows the bevel as a soft glow that smears into the
neighbor — not as the *sharp seam* in the reference.

In the reference the seam between two same-color cubes is visible as a
slight darker line (the contact crease). That's an opaque feature, not an
additive one.

### 3.3 NEXT preview looks empty (D6)

[`renderMiniPiece`](../project/tetris.html#L2107) and the panel definition
at [tetris.html:2027-2035](../project/tetris.html#L2027-L2035):

```js
const cellSize = 16;            // px in panel local space
...
nextObj.scale.setScalar(0.025); // panel is then scaled to 1/40 in world
```

The preview cell is rendered at 16 px in panel-local CSS coordinates, and
the entire panel is scaled to **0.025** in world space. The play case is
~10×20 world units, so a 16-px cell ends up roughly the same on-screen size
as a single stack cube — but the panel sits 3× farther from the camera than
the case face. Net result: the preview piece on screen is ~⅓ the size of
the cubes in the playfield. The reference's NEXT icon is roughly the same
size as 4 stack cubes — about 4× larger than current.

`renderMiniPiece` itself works (the I-piece shape will draw if `nextQueue[0]`
is set). The bug is **scale**, not logic.

Verify: open a mid-game session and inspect `#next-preview` — it will have
content, just a tiny one. The reference clearly biases toward a panel piece
that's *bigger than the stack cubes* for legibility.

### 3.4 HOLD preview looks empty (D7)

Two compounding issues:

1. **Same scale problem as NEXT** (§3.3) — even when populated, the icon
   would be small.
2. **`holdPiece` starts `null`** ([tetris.html](../project/tetris.html))
   and is only set when the player presses C / Shift. The screenshot was
   taken before that input. So the panel is *correctly* empty in code, but
   the reference picture clearly intends HOLD to show a *placeholder* (or
   to look like the same ornate panel even when empty).

Fix should: (a) make the preview cell ~3× larger, and (b) draw a faint
"empty slot" outline when `holdPiece` is null instead of an empty div, so
the panel never looks broken.

### 3.5 LINES panel reads "empty" at a glance (D8)

Same root cause as NEXT/HOLD scale issue: the value `0` (or `23`) is
rendered at the panel's CSS font-size of 28px, but the panel itself is at
0.025 world scale and positioned at z=4 (further from camera than the
case). The number is visible but small.

The reference panels are clearly larger relative to the case. Either:
- the panels are at a higher world scale (bigger font), or
- they're closer to the camera (smaller z offset), or
- they use a chunkier numeric font.

### 3.6 Cube color choice list — vibrancy ceiling (D1)

`PIECE_COLORS` at [tetris.html:293](../project/tetris.html#L293):

```js
I: 0x4ad9ff,  // cyan
O: 0xffd246,  // yellow
T: 0xc768ff,  // purple
S: 0x5fff8a,  // green
Z: 0xff4a6b,  // red
J: 0x4a7dff,  // blue
L: 0xff9a3c,  // orange
```

These are reasonable but slightly muted (the cyan is mid-saturation,
the purple is pinkish). The reference has more pure / poster-paint hues —
nearer to fully-saturated primaries. With opacity dialed up (§3.1), a hue
bump on top will land each cube clearly into its color slot.

### 3.7 Active piece is dim against the case (D11)

The active piece is the *same* material as locked pieces. With opacity 0.7
and the cubes sitting right against the front glass wall, the front-most
cube is doubled-up (its own alpha + the wall's alpha) — and gets the
*least* light because it's behind the wall's specular sheet. The reference
makes the active piece pop; this is partly opacity (§3.1) and partly the
wall reading more clearly so the front cube isn't visually competing with
its own outline.

A small cheat: give the active piece a **boosted emissive** (or a tiny
emissive-only inner pulse) to lift it a notch over locked pieces. That
matches the reference and reinforces "this is the piece you control."

---

## 4. Fix plan

Order: cheapest-first, biggest-visual-impact-first, anything that risks
regressing other behavior last.

### F1 — Make cubes opaque-feeling (resolves D1, D2, D3, partially D4)

**File**: [project/tetris.html](../project/tetris.html), function
[`getCubeMaterial`](../project/tetris.html#L1047) at lines 1047-1081.

Change non-ghost branch:

```diff
   const mat = new THREE.MeshPhysicalMaterial({
     color: c,
     metalness: 0.0,
-    roughness: 0.08,
+    roughness: 0.18,
     ior: 1.5,
     clearcoat: 1.0,
-    clearcoatRoughness: 0.03,
-    iridescence: 0.35,
-    iridescenceIOR: 1.3,
-    iridescenceThicknessRange: [100, 400],
+    clearcoatRoughness: 0.06,
     specularIntensity: 1.0,
     specularColor: 0xffffff,
-    transparent: true,
-    opacity: opts.ghost ? 0.12 : 0.7,
+    transparent: opts.ghost ? true : false,
+    opacity:    opts.ghost ? 0.12 : 1.0,
     envMapIntensity: 1.0,
     emissive: c,
-    emissiveIntensity: opts.ghost ? 0.15 : 0.45,
+    emissiveIntensity: opts.ghost ? 0.15 : 0.65,
     side: THREE.FrontSide,
-    depthWrite: !opts.ghost,
+    depthWrite: true,
   });
```

What this does:
- Drops iridescence (it was the "rainbow desaturation" sheen).
- Pushes the cube into the **opaque pass** when not a ghost. They can't
  bleed each other and they pick up sharp specular hits.
- Slightly higher roughness (0.18) softens the mirror highlight so the
  base color reads — at 0.08 the blocks were almost chrome-mirroring the
  env map.
- Emissive intensity up so the inner color still lifts when bloom is wired.

**Risk**: cubes are now opaque, but the **case walls** still alpha-blend
([tetris.html:1144](../project/tetris.html#L1144)). The wall's
`renderOrder = 10` (line 1167) means cubes (renderOrder 2) draw first and
walls draw on top — that order is now **correct** for opaque cubes seen
through alpha walls. No change needed on walls for this step.

**Sanity check after this change**: drop a piece, confirm you can no longer
see the floor through stacked cubes. Confirm the case walls still let you
see the cubes through them.

### F2 — Tighten edges so seams between cubes read sharp (D4)

[`getEdgeMaterial`](../project/tetris.html#L1084) at lines 1084-1093.

```diff
 function getEdgeMaterial(color, ghost) {
-  const ec = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.55);
+  const ec = new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.75);
   return new THREE.LineBasicMaterial({
     color: ec,
-    transparent: true,
-    opacity: ghost ? 0.2 : 0.7,
-    blending: THREE.AdditiveBlending,
-    depthWrite: false,
+    transparent: ghost,
+    opacity: ghost ? 0.2 : 1.0,
+    blending: ghost ? THREE.AdditiveBlending : THREE.NormalBlending,
+    depthWrite: !ghost,
   });
 }
```

Edges on locked cubes become opaque + normal-blended, so the bevel
between two adjacent cubes is a **discrete bright line** (closer to the
reference). Ghost edges keep additive so they still float.

### F3 — Bump piece color saturation slightly (D1)

[`PIECE_COLORS`](../project/tetris.html#L293) at lines 293-301.

Push each color a notch toward fully saturated:

```diff
 const PIECE_COLORS = {
-  I: 0x4ad9ff,
-  O: 0xffd246,
-  T: 0xc768ff,
-  S: 0x5fff8a,
-  Z: 0xff4a6b,
-  J: 0x4a7dff,
-  L: 0xff9a3c,
+  I: 0x22e6ff,  // pure cyan
+  O: 0xffd400,  // pure yellow
+  T: 0xb84cff,  // pure violet
+  S: 0x39ff7a,  // pure green
+  Z: 0xff2c5a,  // pure red
+  J: 0x2a6cff,  // pure blue
+  L: 0xff8a1c,  // pure orange
 };
```

Tiny change. Combined with F1 (opaque + emissive lift), each cube now reads
as a poster color instead of a glass tint.

### F4 — Scale up HUD panel previews so NEXT/HOLD/LINES are legible (D6, D7, D8)

Two small changes in [tetris.html](../project/tetris.html):

**(a)** [`renderMiniPiece`](../project/tetris.html#L2107) — bump `cellSize`:

```diff
 function renderMiniPiece(container, key) {
   container.innerHTML = '';
   if (!key) return;
   const shape = PIECES[key][0];
   const color = PIECE_COLORS[key];
-  const cellSize = 16;
+  const cellSize = 28;
```

Also bump the panel preview container's height/width so the larger piece
fits — at the panel definitions
[tetris.html:2027-2035](../project/tetris.html#L2027-L2035) and
[tetris.html:2038-2046](../project/tetris.html#L2038-L2046):

```diff
-  <div id="next-preview" style="margin-top:8px; height:80px; width:100px; ...
+  <div id="next-preview" style="margin-top:8px; height:120px; width:140px; ...
```

(Same for `#hold-preview`.)

**(b)** Also update the same containers inside `updateHUD` at
[tetris.html:2164-2171](../project/tetris.html#L2164-L2171), since
`updateHUD` rewrites `innerHTML` and the inline styles there are the
authoritative version after the first frame.

**(c)** Empty-slot placeholder for HOLD — when `holdPiece` is null, draw
a faint outlined rectangle so the panel never looks broken. Inside
`updateHUD` after the existing preview rebuild:

```js
const hp = holdEl.querySelector('#hold-preview');
if (hp) {
  if (holdPiece) renderMiniPiece(hp, holdPiece);
  else {
    hp.innerHTML = `<div style="
      width:60px; height:60px;
      border:1.5px dashed rgba(108,240,255,0.25);
      border-radius:6px;"></div>`;
  }
}
```

### F5 — Make the active piece pop (D11)

In [`makeCube`](../project/tetris.html#L1106) at line 1106, accept an
`active: true` flag and bump emissive on the body material clone:

```diff
-function makeCube(color, opts = {}) {
+function makeCube(color, opts = {}) {
   const group = new THREE.Group();
-  const mesh = new THREE.Mesh(cubeGeometry, getCubeMaterial(color, opts));
+  let bodyMat = getCubeMaterial(color, opts);
+  if (opts.active) {
+    bodyMat = bodyMat.clone();
+    bodyMat.emissiveIntensity = 0.95;
+  }
+  const mesh = new THREE.Mesh(cubeGeometry, bodyMat);
```

Then at [tetris.html:1440](../project/tetris.html#L1440) (active piece
build in `rebuildPieceMesh`), pass `{ active: true }`. Locked cubes
remain at the F1 default (0.65). This single bump is the difference
between "blocks at the top" and "the piece you control."

**Cost note**: cloning a material per-piece-render does undo the cache
hit, but the active piece is at most 4 cubes and is rebuilt only on
move/rotate. The clone count is bounded.

A cheaper alternative is to add a second `active` cache key in
`getCubeMaterial` (matching the existing `:g` ghost key) so each piece
type has exactly one shared "active" material. Use this if F1+F5 are
shipped together.

### F6 — Verify and (if needed) ship plan_fix.md A1 walls + B4 composer

The case-wall and bloom items belong to [plan_fix.md](plan_fix.md) and
land partial fixes to D5 and D12 here. Specifically:

- Wall opacity-pass change (plan_fix.md §3 step 2) makes the case
  glass read more solidly *with* the now-opaque cubes (F1) — the two
  fixes complement each other.
- Composer wiring (plan_fix.md §3 step 1) is the missing 50% of the
  cube-pop story — bloom on the now-brighter cube emissive (F1, F5) is
  what gives the reference its "glow."

If plan_fix.md hasn't shipped yet, do those two before F1–F5 and you'll
see compound benefit. If it has, F1–F5 are still independently correct.

---

## 5. Validation checklist

After applying F1–F5, the following should be true side-by-side with the
reference:

- [ ] Stack cubes are visibly **opaque** — you cannot see the floor or
      the back wall through any locked cube.
- [ ] Adjacent same-color cubes show a **discrete bright bevel** between
      them, not a soft additive glow.
- [ ] Each piece color is unambiguous at any depth slice (red is red
      not pink-grey, blue is blue not slate-blue, etc.).
- [ ] NEXT panel shows a piece icon roughly the size of a stack cube
      (not 1/3 of one).
- [ ] HOLD panel shows either a piece or a clear empty-slot frame —
      never a blank box.
- [ ] LINES panel's number is readable from the default camera distance
      without leaning in.
- [ ] The active (currently-falling) piece is *visibly brighter* than
      locked pieces.
- [ ] No regression: cubes still read through the case walls (i.e. you
      can see the stack from any orbit angle).

---

## 6. Out of scope

These differences are real but already covered by
[plan_fix.md](plan_fix.md) — not duplicated here:

- Glass case rim fade-out into the city (plan_fix.md A1).
- Background skyline competing with case (plan_fix.md A3, A4).
- Post-processing pipeline (plan_fix.md B4).
- Multi-line clear stutter (plan_fix.md C1, B1–B3).
- Shatter system performance (plan_fix.md B1).

Things deliberately not changed:

- Panel positions in 3D space (`scoreObj.position.set(-13, 4, 4)` etc.).
  Reference shows panels at the same corners; only their *contents* are
  the issue.
- The mood preset system. The screenshot's `void` mood is a valid choice;
  the cube/panel fixes apply to every mood.
- Active-piece rotation kick / inertia. Feels fine in motion.
