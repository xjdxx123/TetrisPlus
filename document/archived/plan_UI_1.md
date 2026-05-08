# TetrisPlus — UI Plan v1: Floating 3D Settings Panel

Scope: a single draggable + rotatable CSS3D panel that lives in the same world
as the case and HUD, exposing every visible/audible knob the engine has plus
mode selection and a persisted high score. All work targets
[`project/tetris.html`](../project/tetris.html) — same architecture as the
existing HUD/score/lines/next/hold panels.

---

## 0. Status recap — what already exists, reuse don't reinvent

- **CSS3D pipeline**: `cssRenderer`, `cssScene` already running every frame in
  the animate loop. `CSS3DObject` wrapping a styled `<div>` is the existing
  pattern ([tetris.html:2061-2095](../project/tetris.html#L2061-L2095)).
- **Panel chrome**: `makePanelEl(html, opts)` produces the glassmorphic look
  already used by Score/Lines/Next/Hold. Reuse it for visual consistency
  ([tetris.html:2026-2050](../project/tetris.html#L2026-L2050)).
- **Drag-only helper**: `makeDraggable(el, obj)` projects pointer onto a
  camera-aligned plane and translates `obj.position`. Disables `controls`
  during drag. Currently translate-only — no rotation
  ([tetris.html:2098-2149](../project/tetris.html#L2098-L2149)).
- **TWEAKS** state object: 3 knobs today (`gravity`, `mood`, `shatterPower`).
  Persisted to a host parent via postMessage, not localStorage
  ([tetris.html:342-348](../project/tetris.html#L342-L348)).
- **2D tweaks panel** (legacy): a fixed-position right-side HTML panel that
  duplicates 3 of the knobs. Toggled by host-protocol postMessage events
  ([tetris.html:3315-3447](../project/tetris.html#L3315-L3447)).
- **Audio bus** (`sfx`): exposes `voiceVolume`, `sfxVolume`, `bgmVolume`,
  `muted` and `setMuted(b)` ([tetris.html:3010-3107](../project/tetris.html#L3010-L3107)).
- **Mute toggle button** (🔊): bottom-right cluster next to the help (`?`)
  button ([tetris.html:303-305](../project/tetris.html#L303-L305)).
- **Mood presets**: 4 entries (`neon`, `icy`, `ember`, `void`) recoloring rim
  light, fill light, frame ([tetris.html:350-357](../project/tetris.html#L350-L357)).
- **Bloom pass**: `bloomPass.strength` is the live knob — already mutated by
  level-up flash, cheap to expose ([tetris.html:508-514](../project/tetris.html#L508-L514)).
- **No persistence**: `localStorage` is unused. High score, settings — none of
  it survives a reload right now.
- **No game mode concept**: there is one mode (classic). `gameOver` /
  `triggerGameOver` is the only end condition.

---

## 1. Goals (the contract this plan delivers)

1. A single 3D panel with all settings + stats + mode selection.
2. **Drag in 3D**: same feel as the existing HUD panels.
3. **Rotate in 3D**: new gesture — pitch + yaw, clamped so the panel stays
   readable.
4. **Open/close**: not always on screen. Toggle via a gear (⚙) button in the
   existing bottom-right cluster, plus an `O` keybinding.
5. **Persisted state**: all settings + high score survive a reload (via
   `localStorage`).
6. **Live changes**: every slider modifies the running game in real time. No
   "apply" button.
7. **Mode buttons present, mode logic future**: each mode is a button that
   visually selects, persists the choice, and (for now) restarts in classic
   rules. Document the extension contract for later modes.
8. **Doesn't break the existing 2D tweaks panel** — host-protocol path stays
   intact for the editor app; the 3D panel becomes the in-game surface.

---

## 2. Information architecture — four tabs

A single panel hosts four tab views. Tabs swap content; the panel root, drag
state, position/rotation, and chrome stay constant. Tab order matches user
priority: visuals (the most-tweaked thing), then audio, then mode, then the
stats brag-page.

```
┌──────────────────────────────────────────────────┐
│  TETRISPLUS · SETTINGS                  ⊙ ✕      │  ← header (drag handle, reset, close)
├────────┬────────┬────────┬───────────────────────┤
│Effects │ Audio  │  Mode  │  Stats                │  ← tabs
├────────┴────────┴────────┴───────────────────────┤
│                                                  │
│   <active-tab content>                           │
│                                                  │
└──────────────────────────────────────────────────┘
```

### 2.1 Tab: Effects (visuals + particles + lights)

Sliders unless noted. Default values match current TWEAKS / pass settings.

| Control | Range | Wired to | Notes |
|---|---|---|---|
| Shatter power | 0.4 – 2.5 | `TWEAKS.shatterPower` | Already drives shards, sparkles, shake, punch-zoom — single multiplier. |
| Bloom intensity | 0.0 – 1.5 | `bloomPass.strength` (with `_bloomBaseStrength` saved) | Live. Beware level-up flash temporarily overrides; it should `_bloomBaseStrength = bloomPass.strength` *after* user changes. |
| Camera shake amt | 0.0 – 1.5 | `TWEAKS.shakeMul` (new) — multiply where `shakeIntensity =` is set | Lets nervous players turn it down without nuking shatter power. |
| Slow-mo strength | 0.0 – 1.0 | `TWEAKS.slowmoMul` (new) — scales `slowmo.holdScale` away from 1.0 | At 0 → no slow-mo. At 1 → current values. At 0.5 → halfway between current and real-time. |
| Drop trail intensity | 0.0 – 1.0 | `TWEAKS.trailMul` (new) — scales `startOpacity` of `trailFx` slots | Clean look ↔ heavy streaks. |
| Energized rim glow | 0.0 – 1.5 | `TWEAKS.rimGlowMul` (new) — multiplied into the active-piece fresnel `uIntensity` | Existing rim system (G16/active highlight); new multiplier hooked in the per-frame update. |
| Glass mood (preset) | segmented: `neon` `icy` `ember` `void` | `TWEAKS.mood` | Existing presets; runs `applyMood()` on change. |
| Particles density | low / mid / high | `TWEAKS.particleQuality` (new); maps to a multiplier on per-cube shard count cap | Cheap mobile-friendly preset. Discrete to communicate "this affects perf." |
| Vignette | toggle on/off | `vignettePass.uniforms.uIntensity` | If absent, leave the slot but mark "TODO". |
| **Reset effects** | button | restores everything in this tab to defaults | Shows a brief flash on the panel border to confirm. |

Notes:
- The new `shakeMul`, `slowmoMul`, `trailMul`, `rimGlowMul`, `particleQuality`
  fields go into `TWEAKS` and `TWEAK_DEFAULTS`. The hook points already exist
  — these are pure multipliers added at the consumer site.
- The legacy 2D tweaks panel only knows about `gravity`, `mood`,
  `shatterPower`. It keeps working unchanged. The 3D panel is the
  superset; mood + shatter changes from either flow round-trip through
  `TWEAKS` + `applyMood()`.

### 2.2 Tab: Audio

| Control | Range | Wired to |
|---|---|---|
| Master mute | toggle | `setMuted(b)` — same call the 🔊 button uses. |
| BGM volume | 0.0 – 1.0 | `sfx.bgmVolume` + `sfx.bgmEl.volume` |
| Voice volume | 0.0 – 1.0 | `sfx.voiceVolume` + `sfx.voiceGain.gain.value` |
| SFX volume | 0.0 – 1.0 | `sfx.sfxVolume` + `sfx.sfxGain.gain.value` |
| Test announcer | button | `playVoice('rempage')` |
| Test SFX | button | `playSfx('clear', 4)` |

The slider should go straight to `gain.value`; do **not** ramp on `input`
events at slider granularity — the audio API handles that smoothly enough at
the rates a human drags.

### 2.3 Tab: Mode

```
[ Classic ] [ Marathon ] [ Sprint ]
[ Ultra   ] [ Zen      ] [ Versus ]
            ▶  Start with selected mode
```

Each button is a segmented selector that writes `selectedMode` into a new
`Mode` namespace. Today every mode resolves to classic rules — the start
button is just `triggerGameOver()` + reset path. The buttons read as "modes
exist, they just all play the same right now."

| Mode | Future behavior contract |
|---|---|
| Classic | Current rules. Endless. |
| Marathon | Classic, ends at 150 lines, score multiplier. |
| Sprint | Race to 40 lines, time displayed. |
| Ultra | 2-minute timer, max score. |
| Zen | No game-over (top-out shifts the stack down instead). |
| Versus | Placeholder — would need network or AI. Disabled-looking until then. |

Each button shows a "▶ playing" badge if it equals `selectedMode`. After a
game-over, the next reset uses the selected mode — keeps the path simple
(no mid-game switching).

### 2.4 Tab: Stats

```
HIGH SCORE          287,400
─────────────────────────────────
Best by mode
  Classic           287,400
  Marathon          —
  Sprint            —
  Ultra             —

Totals
  Lines cleared     1,124
  Pieces placed     2,983
  Time played       1h 42m

[Reset stats]                ← confirm-twice button
```

Reads from the persisted blob in §3.1. Reset is destructive so it requires a
second click within 2s ("Click again to confirm").

---

## 3. Implementation strategy

### 3.1 Persistence — a single source of truth

Two `localStorage` keys, both versioned so future schema changes don't
mis-merge:

```js
// localStorage["tetrisplus.settings.v1"]
{
  effects: {
    shatterPower: 2.5,
    bloom: 0.7,
    shakeMul: 1.0,
    slowmoMul: 1.0,
    trailMul: 1.0,
    rimGlowMul: 1.0,
    mood: 'void',
    particleQuality: 'mid',
    vignette: true,
  },
  audio: { muted: false, bgm: 0.32, voice: 0.95, sfx: 0.55 },
  mode: 'classic',
  panel: { x: 0, y: 0, z: 6, yaw: 0, pitch: 0, hidden: true },
}

// localStorage["tetrisplus.stats.v1"]
{
  highScore: 0,
  modeBests: { classic: { score: 0, lines: 0, level: 1 } /* sprint: { time: ... } */ },
  totals: { linesCleared: 0, piecesPlaced: 0, playTimeMs: 0 },
  lastUpdated: '2026-05-07T14:32:01Z',
}
```

API (one module, ~40 LOC):

```js
const Store = {
  loadSettings(),   // returns parsed obj or DEFAULTS, never throws
  saveSettings(obj),// debounced 250ms; flushes on visibilitychange=hidden
  loadStats(),
  saveStats(obj),   // debounced 250ms; immediate on game-over
};
```

Notes:
- Boot sequence calls `Store.loadSettings()` *before* `applyMood()` and any
  `bloomPass.strength` baseline capture, so user values take effect on the
  first frame.
- `Store.saveStats({ highScore, ... })` runs unconditionally inside
  `triggerGameOver` after the cascade is scheduled.
- The host-protocol postMessage path stays for `gravity` / `mood` /
  `shatterPower` so the editor app's persistence still works. Two writers to
  the same TWEAKS object is fine; the *last* one to fire wins, and they
  agree at boot because both load the same defaults.

### 3.2 Drag + rotate gesture handler

New helper, generalizes the existing `makeDraggable`:

```js
function makeDraggableRotatable(el, obj, {
  pitchClamp     = Math.PI / 6, // ±30° — beyond this CSS3D text gets unreadable
  yawClamp       = Math.PI / 2, // ±90°
  rotateSensitivity = 0.005,    // rad per pixel
  onChange,                     // optional, called with {x,y,z,yaw,pitch} for persistence
} = {}) { /* ... */ }
```

Gesture model:

| Input | Action |
|---|---|
| Left click + drag on body | Translate (existing logic) |
| **Right click + drag** anywhere | Rotate (yaw from dx, pitch from dy) |
| Left click + drag on a `[data-grab="rotate"]` corner widget | Rotate (touchscreen-friendly fallback) |
| Double click on header | Reset to default position + orientation (300ms ease) |

Implementation notes:
- Suppress browser context menu on the panel: `el.addEventListener('contextmenu', e => e.preventDefault())`.
- Track gesture start in a single `gesture = { kind, startX, startY, startObjPos, startEuler }` so the existing translate plane logic and the new rotate logic don't fight.
- Apply rotation as `obj.rotation.set(pitch, yaw, 0)` — never roll. Roll makes
  text rotate sideways; nobody wants that.
- Clamp pitch and yaw with `THREE.MathUtils.clamp`.
- Disable `controls.enabled` for both gesture kinds (existing pattern).
- Two-finger touch rotate: out of scope; one-finger drag still works for
  translate.

### 3.3 Panel scaffold

```js
const settings = createSettingsPanel({
  onModeChange:    (m) => Mode.select(m),
  onTriggerReset:  () => softResetGame(Mode.current),
});
// settings = { el, obj, open(), close(), toggle(), refreshStats() }
```

Internal layout: a single root `<div>` from `makePanelEl`, with the tab
header/content built by `createSettingsPanel`. Tab switching toggles a
`data-active-tab` attribute on root; CSS uses that to show/hide each
`.tab-pane`.

Sizes:
- CSS pixel size: ~360px × ~480px tall.
- World scale: `0.025` (matches existing HUD panels). World footprint ≈
  9 × 12 units. The case is 10 × 20 × 3, so the panel is comparable to the
  case in width.
- Default position: `(0, 0, 6)` — center, in front of the case in +Z. Default
  rotation: identity.

Show/hide animation:
- `obj.visible = true`, scale tween 0.6 → target_scale (0.025) + opacity 0 → 1
  over 0.2s using a small entry-tween record in the animate loop.
- On close, reverse, then `visible = false` so it stops eating pointer events.

### 3.4 Toggle button

Add a third button to the bottom-right cluster (currently 🔊 + ?), to the
left of 🔊:

```html
<button class="settings-toggle" id="settingsToggle" title="Settings (O)">⚙</button>
```

CSS shares the rule with `.help-toggle, .audio-toggle` — bump the existing
selector: `.help-toggle, .audio-toggle, .settings-toggle`. Each gets a
`right` value in its own selector. (The pattern is already established.)

Keybinding: `O` (settings). Add to the existing `keydown` switch.

### 3.5 Effects-tab wiring (just the new knobs)

Each new knob is *one* multiplier inserted at the consumer site. Concrete
diffs (illustrative):

```js
// Camera shake (1598)
- shakeIntensity = Math.min(1.6, (0.25 + rows.length * 0.22) * TWEAKS.shatterPower);
+ shakeIntensity = Math.min(1.6, (0.25 + rows.length * 0.22) * TWEAKS.shatterPower * TWEAKS.shakeMul);

// Slow-mo (slowmo.holdScale assignment)
- slowmo.holdScale = 0.35;
+ slowmo.holdScale = 1.0 - (1.0 - 0.35) * TWEAKS.slowmoMul;

// Trail (spawnHardDropTrail)
- trailFx.push({ slot, life: 0, maxLife: 0.45, startOpacity: 0.5 });
+ trailFx.push({ slot, life: 0, maxLife: 0.45, startOpacity: 0.5 * TWEAKS.trailMul });

// Active rim (per-frame update site of fresnel uIntensity)
- mat.uniforms.uIntensity.value = pulse * (1 + 0.85 * moveBoost);
+ mat.uniforms.uIntensity.value = pulse * (1 + 0.85 * moveBoost) * TWEAKS.rimGlowMul;
```

Each is one line plus a default in `TWEAK_DEFAULTS`.

### 3.6 Audio-tab wiring

All four audio sliders write into the existing `sfx.*` fields. The `Master
mute` toggle calls `setMuted` which already updates the 🔊 button class.
Settings panel's mute toggle and the 🔊 button are two views of the same
state — both UIs poll/listen to `sfx.muted` so flipping one updates the
other. Implementation: emit a `setMuted` (already exists) that also
patches the panel checkbox if present.

### 3.7 Mode skeleton

```js
const Mode = {
  current: 'classic',
  available: ['classic', 'marathon', 'sprint', 'ultra', 'zen', 'versus'],
  select(name) {
    if (!this.available.includes(name)) return;
    this.current = name;
    Store.saveSettings({ mode: name });
    /* future: set up per-mode timers/win-conditions here */
  },
};
```

The "Start with selected mode" button calls the existing reset path. No
per-mode game-loop branching today — that's a deliberate stub.

When real modes ship, `triggerGameOver` consults `Mode.current` for the
end condition and `clearLines` consults it for scoring multipliers. The
panel UI doesn't change.

### 3.8 High-score plumbing

Inside `triggerGameOver`, after the cascade is scheduled:

```js
const stats = Store.loadStats();
if (score > (stats.highScore || 0)) stats.highScore = score;
const best = (stats.modeBests[Mode.current] ||= {});
if (score > (best.score || 0)) {
  best.score = score; best.lines = lines; best.level = level;
}
stats.totals.linesCleared += lines;
stats.totals.piecesPlaced += /* tracked in spawnPiece */;
stats.totals.playTimeMs   += Math.round(performance.now() - sessionStart);
stats.lastUpdated = new Date().toISOString();
Store.saveStats(stats);
settings.refreshStats(); // re-render the Stats tab if open
```

`piecesPlaced` needs a counter — increment once in `spawnPiece`. `sessionStart`
is captured at boot and resets on `goRestart`.

The Stats tab reads `Store.loadStats()` whenever it's *opened* (not every
frame), plus `settings.refreshStats()` is called from `triggerGameOver` so
an open panel updates immediately.

---

## 4. Visual / interaction details

- **Header** carries the panel title + drag-handle indicator (the entire
  header is the translate-grab zone). Right-edge icons:
  - `⊙` reset position/orientation (also: double-click anywhere on header)
  - `✕` close
- **Tabs** are segmented buttons styled like the existing `.tw-segmented` —
  same font, same active-state cyan glow, mouse hover matches.
- **Sliders** mirror the legacy panel's look: full-width range input with a
  right-aligned numeric readout; cyan accent color (`#6cf0ff`).
- **Toggle switches** for booleans (mute, vignette) — small CSS toggle, not a
  checkbox.
- **Confirmation flashes**: when sliders snap to defaults, the slider track
  pulses cyan once; when "Reset stats" runs, the row turns red briefly. Pure
  CSS animations — no JS scheduling needed.
- **Pointer-events on `<input>` inside CSS3D**: works because CSS3DRenderer
  preserves child events; the outer wrapper just gets a transform rewrite.
  We do NOT set `pointer-events: none` anywhere on the panel chrome.

---

## 5. Order of implementation (priority)

### Tier 1 — foundation (must land first, ~½ day)

1. **Storage module** (§3.1). Smallest surface, everything else assumes it.
2. **`makeDraggableRotatable`** helper (§3.2). Generalize the existing helper
   so the panel infra works.
3. **Settings-panel scaffold** with empty tabs + toggle button + key
   binding (§3.3, §3.4). Visible, draggable, rotatable, persistent
   position. No content yet.

### Tier 2 — the surface (½ day)

4. **Effects tab** (§3.5) — wire all sliders. New `TWEAKS` fields with
   defaults; one-line edits at each consumer site.
5. **Audio tab** (§3.6) — sliders + test buttons.
6. **Mode tab** (§3.7) — segmented buttons, persistence, no real mode
   logic yet.
7. **Stats tab** + high-score plumbing (§3.8) — read on open + on game-over.

### Tier 3 — polish (¼ day)

8. **Show/hide animation** (scale + opacity tween in animate loop).
9. **Reset-orientation tween** on double-click.
10. **Sync the 🔊 button with panel-side mute toggle** (both reflect
    `sfx.muted`).
11. **Confirmation flashes** for resets.

---

## 6. Risks & open questions

- **Pointer-events through CSS3D**: confirmed working in the existing HUD
  panels (sliders inside `tweaks-panel` work today), but the legacy 2D
  panel sits in the DOM normally. The new 3D panel's controls fire pointer
  events from a transformed element; verify slider drag still resolves
  correct deltas at 0.025 world scale (it should — `clientX`/`clientY` are
  always in viewport space). Test before claiming done.
- **CSS3D readability when pitched**: at >30° pitch, font hinting falls
  apart. Hard pitch clamp at ±30°; offer a "Reset orientation" button for
  recovery if a player pulls it past comfort.
- **Slider perf during slow-mo**: changing `slowmoMul` while slow-mo is
  active causes a discontinuity. Acceptable; it's a settings tweak, not
  expected mid-game. Document it.
- **localStorage quota / privacy mode**: wrap reads/writes in try/catch and
  fall back to in-memory; settings just don't persist. Don't crash.
- **Two writers** to TWEAKS (3D panel + legacy 2D panel + host messages).
  Last write wins. Both UIs read the live value on open, so they don't show
  stale values. Acceptable.
- **High score reset on `goRestart`**: the current restart path nukes
  `score`, `lines`, etc. The high-score write happens *before* that path
  runs, inside `triggerGameOver`. Verify ordering: `triggerGameOver` →
  cascade → overlay → user clicks Play Again → restart path. High-score
  write must happen at `triggerGameOver` entry, not in the restart handler,
  otherwise it's never recorded for top-outs that you actually quit on.
- **Mode buttons being decorative is honest** but might confuse players.
  Mitigation: a single inline note in the Mode tab — "Modes coming soon —
  Classic plays now." When a real mode lands, drop the note.

---

## 7. Out of scope for v1

- Per-mode game-loop logic (Sprint timer, Ultra countdown, Zen no-top-out,
  versus). Buttons stub out the contract — implementations land in v2.
- Achievements, daily challenges, profile/avatars.
- Cloud sync of stats. localStorage only.
- Mobile/touch rotation gesture (two-finger). Drag works on touch via
  pointer events; rotate via right-click is desktop-only for now.
- Color customization beyond the 4 mood presets.
- Custom keybindings.

---

## 8. Success criteria

- [ ] Pressing `O` (or the new ⚙ button) toggles a 3D panel in front of the case.
- [ ] Panel can be dragged anywhere in 3D and stays where it's left across reloads.
- [ ] Panel can be right-click-dragged to rotate; pitch is clamped; double-click resets orientation.
- [ ] Every Effects slider modifies the running game live with no perceptible lag.
- [ ] Audio sliders match the live `sfx.*` gain bus; the 🔊 button and the panel's master-mute toggle stay in sync.
- [ ] Mode tab shows the 6 mode buttons; the selected one is highlighted; the choice persists across reloads. (Actual rule changes are stubbed — Classic plays.)
- [ ] Stats tab shows high score, per-mode bests, totals, all read from `localStorage`.
- [ ] After a game-over, the high score increments persistently if beaten.
- [ ] The legacy 2D tweaks panel still works for mood / gravity / shatter (host-protocol path is undisturbed).
- [ ] No new per-frame allocations in the panel render or drag/rotate handler.

---

## 9. Files touched (predicted)

Single file: [`project/tetris.html`](../project/tetris.html). Estimated line
delta: +500/-15. Major regions:

| Region | Net | What |
|---|---|---|
| `<head>` styles | +60 | tab/slider/toggle styles for the panel |
| Body markup | +1 | one button (`#settingsToggle`) |
| `TWEAK_DEFAULTS` | +5 | `shakeMul`, `slowmoMul`, `trailMul`, `rimGlowMul`, `particleQuality` |
| Storage module | +60 | `Store` namespace with debounced save + load |
| `makeDraggableRotatable` helper | +90 | new gesture wrapper |
| `createSettingsPanel` | +250 | scaffold + four tabs |
| Toggle wiring (button + key) | +20 | event handlers |
| Hook diffs at consumer sites | +5 (one per knob) | shake/slow/trail/rim multipliers |
| `triggerGameOver` stats hook | +12 | high-score write |
| `spawnPiece` piecesPlaced++ | +1 | counter |
| `applyMood` / boot order shuffle | +5 | load settings before applying |
| Cleanup at game restart | +3 | reset session timer |

Total: under 600 LOC of net additions, no architectural new modules outside
the single file (matches the project's chosen structure).
