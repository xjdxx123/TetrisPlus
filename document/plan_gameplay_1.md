# Gameplay Roadmap — Modes, Variants, Speculative Directions

**Document type:** Engineering execution plan
**Companion to:** [`plan_architecture.md`](./plan_architecture.md) (subsystem boundaries), [`plan_UI_1.md`](./plan_UI_1.md) (settings panel + Mode tab), [`plan_particle_2.md`](./plan_particle_2.md) (VFX roadmap that gameplay events feed)
**Status:** Pre-implementation. The Mode tab UI exists; the rule packs do not. This document defines them.
**Author:** Senior gameplay engineer, written for the team

---

## 0. Implementation Status (Grounded)

This section is the truth on the ground as of **2026-05-08**. The gameplay rule pack today is a single classic implementation; everything else is UI surface plus a `Mode` namespace that fires listeners but does not yet alter rules.

### 0.1 What ships today

| Layer | Status | Where | What's there |
|---|---|---|---|
| Mode registry | ✅ | [`src/gameplay/mode.js`](../project/src/gameplay/mode.js) | 6 keys (`classic`, `marathon`, `sprint`, `ultra`, `zen`, `versus`), labels, descriptions, disabled-set for `versus`, `select()`, `onChange()` |
| Mode persistence | ✅ | [`src/engine/storage.js`](../project/src/engine/storage.js) | hydrated at boot ([`main.js:92`](../project/src/app/main.js#L92)) |
| Mode tab UI | ✅ | [`src/ui/settings-panel.js:277-329`](../project/src/ui/settings-panel.js#L277-L329) | 3×2 button grid, "▶ Start with selected mode", v1 honest-status note |
| Bag randomizer | ✅ | [`src/app/main.js:1714-1725`](../project/src/app/main.js#L1714-L1725) | seven-bag, `Math.random()` (not seeded — see §4.2 of `plan_architecture.md`) |
| Rotation kicks | ✅ | [`src/gameplay/rotation.js`](../project/src/gameplay/rotation.js) | simplified 5-offset kick (0, ±1, ±2). Not full SRS |
| Scoring | ✅ | [`src/gameplay/scoring.js`](../project/src/gameplay/scoring.js) | line value × level, soft/hard drop points, level every 10 lines |
| Gravity curve | ✅ | [`src/app/main.js:1706-1709`](../project/src/app/main.js#L1706-L1709) | `0.85 * 0.85^(level-1) / TWEAKS.gravity`, floor 0.04s |
| Top-out detection | ✅ | [`src/app/main.js:1738-1741`](../project/src/app/main.js#L1738-L1741) | spawn collision → `triggerGameOver()` |
| Stats persistence | ✅ | [`src/engine/storage.js`](../project/src/engine/storage.js) | high score, per-mode bests (score-only), totals |
| **Per-mode rules** | ❌ | — | every mode resolves to classic. The Start button just calls `goRestart`. |
| **Per-mode end conditions** | ❌ | — | only `triggerGameOver()` (top-out) exists |
| **Per-mode scoring multipliers** | ❌ | — | `lineClearScore` takes no mode argument |
| **Per-mode HUD** | ❌ | — | HUD shows `score / lines / level` regardless. No timer, no goal counter |
| **Mode-aware stats schema** | ⚠ | [`src/engine/storage.js:43-54`](../project/src/engine/storage.js#L43-L54) | `modeBests` exists but only stores `{score, lines, level}`. Sprint needs `time`, Ultra needs `score-at-T`, etc. |
| Online stack | ❌ | — | no networking layer, no transport, no auth |
| Physics | ❌ | — | no rapier/cannon/box2d. Gameplay is grid-only |
| 3D-axis rotation | ❌ | — | board is `Cell[ROWS][COLS]` 2D + rendered with depth slices |

### 0.2 What "Mode tab" honestly is today

A persisted preference plus a button. `Mode.select('sprint')` writes `'sprint'` to storage and fires listeners; nothing reads `Mode.current` to alter rules. The note in the panel — *"Modes coming soon — Classic plays now"* — is accurate. This document closes that gap.

### 0.3 Architectural property to preserve

The `gameplay/` core stays Three.js-free, DOM-free, AudioContext-free (`plan_architecture.md` §4, ESLint `no-restricted-imports`). That property is what makes the Sprint timer, Ultra countdown, Marathon goal-line, and Zen no-top-out *implementations* tractable: each is a small additive piece on the simulation side, not a fork of the renderer.

---

## 1. Architectural Principles (read before coding)

These rules guard against the two failure modes the architecture refactor was designed to prevent — gameplay coupling to presentation, and per-mode forks of the render path.

1. **Modes are rule packs, not forks.** A mode is a small bundle of overrides on a single `Rules` object: scoring multiplier, end-condition predicate, gravity curve, optional event hooks. The gameplay loop reads from `rules`, never from `Mode.current` directly.
2. **End conditions are predicates, not branches.** `Rules.endCondition(state)` returns `null` or `{ reason, payload }`. The simulation calls it once per locked piece (and once per second for time-based modes). No `if (mode === 'sprint')` scattered through the code.
3. **Mode UI is a view of mode state.** The HUD reads `Game.snapshot().modeView` (a small typed object: `{ kind: 'sprint', linesRemaining, timeMs, target } | { kind: 'ultra', timeRemainingMs } | …`). It never reads `Mode.current`.
4. **The simulation is deterministic.** Given seed + input frames, `Game.tick(...)` produces an identical board, score, and event stream. This is what unlocks Sprint replay validation, Ultra leaderboard anti-cheat, and Versus rollback netcode (§7).
5. **Online = local + transport.** Versus is a single-player simulation per client + a deterministic input transport. The simulation never knows it's online; the network layer never knows about pieces. (`plan_architecture.md` §1.1 + §2.1 already enforce this shape.)
6. **Speculative modes ship behind a flag.** 3D, physics, and online live under `gameplay/experimental/` with the same 30-day promote-or-delete policy as `vfx/experimental/` (`plan_particle_2.md` §10).
7. **One rules.js per mode, max ~150 lines.** If a mode rule pack is bigger than that, it's smuggling presentation into rules. Pull it out.
8. **HUD-only differences are HUD-only.** "Sprint shows a timer" is a HUD subscription to `modeView`, not a rule. Don't add a mode-specific `Game` field for visual conveniences.

---

## 2. Cross-Cutting Concerns

### 2.1 The `Rules` object

Today the simulation reads scoring/level/gravity from imports in `gameplay/scoring.js` and a tweak object. The mode work needs a single config struct passed at game start:

```js
// gameplay/rules.js
export function buildRules(modeKey, opts = {}) { /* returns the spec below */ }

/**
 * @typedef {Object} Rules
 * @property {string}   key                          // 'classic' | 'marathon' | …
 * @property {(rows, level) => number} lineScore     // override of lineClearScore
 * @property {number}   softDropPerCell              // default 1
 * @property {number}   hardDropPerCell              // default 2
 * @property {(level) => number} fallIntervalSec     // override of fallInterval()
 * @property {(state) => null | EndResult} endCondition  // top-out is added on top of this
 * @property {(state, lines) => void}  onLinesCleared      // hook (e.g., Marathon multiplier)
 * @property {(state, dtMs) => void}   onTick                // hook (e.g., Ultra countdown)
 * @property {boolean}  resetsHighScoreSlot          // false for Zen
 * @property {ModeView} initialModeView              // shape consumed by HUD
 */
```

`onTick` and `onLinesCleared` are the seams where Sprint/Ultra/Marathon hang their counters without polluting the core simulation. They run inside the gameplay tick on the gameplay thread; they never reach into render or audio.

### 2.2 New gameplay events

The current taxonomy in [`gameplay/events.js`](../project/src/gameplay/events.js) is rich enough for classic. Modes need three additions:

| Event | Payload | Emitted from |
|---|---|---|
| `MODE_GOAL_PROGRESS` | `{ kind: 'lines'|'time'|'score', value, target }` | `gameplay/rules.js` after `onLinesCleared`/`onTick` when value crosses a milestone (every 10% or every 5 lines, whichever is coarser) |
| `MODE_END` | `{ reason: 'goal'|'time'|'topout'|'forfeit', score, lines, level, timeMs }` | replaces `GAME_OVER` for non-topout endings; classic still fires `GAME_OVER` for topouts. `MODE_END` is the universal terminal. |
| `GARBAGE_RECEIVED` | `{ rows: GarbageRow[], source: 'opponent'|'mode' }` | Versus + future Co-op modes |

`GAME_OVER` stays the topout signal. `MODE_END` is the win signal *and* the topout signal (with `reason: 'topout'`). The director listens to `MODE_END`; legacy listeners that only care about topout listen to `GAME_OVER`.

### 2.3 Mode lifecycle

```
[Mode tab]                       [Mode]                    [Game]                  [Director]
   │ click Start                    │                         │                        │
   │ ─ Mode.start() ───────────────►│                         │                        │
   │                                │ buildRules(key) ───────►│                        │
   │                                │                         │ reset board, score…    │
   │                                │                         │ emit MODE_START ──────►│  (HUD updates: timer/goal)
   │                                │                         │                        │
   │      …play loop…               │                         │ tick / lock / clear    │
   │                                │                         │ emit MODE_GOAL_PROGRESS┤
   │                                │                         │                        │
   │                                │                         │ rules.endCondition →   │
   │                                │                         │ emit MODE_END ────────►│  (HUD shows result)
```

- `MODE_START` payload: `{ key, seed, initialModeView }`. Replays use the seed.
- `MODE_END` and `MODE_START` are emitted on the bus *after* the gameplay state has settled, so subscribers get a consistent snapshot.

### 2.4 Stats schema upgrade

Per-mode bests need richer fields than today's `{score, lines, level}`. Add a typed slot per mode key:

```js
modeBests: {
  classic:  { score: 0, lines: 0, level: 1, attempts: 0 },
  marathon: { score: 0, lines: 0, level: 1, completed: false, bestTimeMs: null },
  sprint:   { bestTimeMs: null, attempts: 0, completed: false },     // null = no record
  ultra:    { bestScore: 0, bestLines: 0, attempts: 0 },
  zen:      { longestSessionMs: 0, totalLines: 0 },
  versus:   { wins: 0, losses: 0, eloMmr: 1200 },
}
```

`engine/storage.js` already deep-merges incoming blobs against defaults, so adding a field is forward-compatible — old saves backfill the missing keys at load time. **No migration code required**; the merge is the migration.

### 2.5 The HUD's `modeView`

The HUD doesn't know which mode it's rendering. It receives:

```js
type ModeView =
  | { kind: 'classic' }
  | { kind: 'marathon', linesRemaining: number, multiplier: number }
  | { kind: 'sprint',   linesRemaining: number, timeMs: number }
  | { kind: 'ultra',    timeRemainingMs: number, score: number }
  | { kind: 'zen',      shiftDownsTriggered: number }
  | { kind: 'versus',   opponentScore: number, latencyMs: number, garbageInbound: number };
```

A `<ModeBadge>` in `ui/HUD/` switches on `kind`. New modes ship with a `kind` literal and a tiny renderer; nothing in the core HUD changes.

### 2.6 What gameplay never owns

- Input device choice (keyboard vs gamepad) — `input/`.
- Audio cueing of mode events (countdown beeps, goal-met fanfare) — `audio/playback` + `vfx/director` listening to `MODE_END`.
- Visual goal flair (Marathon's 150-line cascade, Sprint's split-second flash) — `vfx/director`.
- Network transport — `net/` (new, §7).

If a mode requires a new audio cue, the cue lives in `vfx/director.js` (or a new `audio/director.js` for sound-only reactions). Rules don't import `playSfx`.

---

## 3. The Six Standard Modes

Each mode answers a fixed template:

1. **Goal** — what the player is trying to do, in one sentence.
2. **End conditions** — when the run ends and why.
3. **Rules** — concrete table of overrides on the default `Rules`.
4. **HUD** — what the player sees.
5. **Stats** — what gets persisted and how it's compared.
6. **Scoring** — the multiplier and how it interacts with the line-clear pipeline.
7. **Implementation plan** — the files touched, in order.
8. **Edge cases** — the things that bite if not addressed up front.
9. **Risk + mitigation**.
10. **Effort estimate**.

---

### 3.1 Classic — Endless ✅ Default

#### 1. Goal
Survive forever. Every line cleared adds to score. Speed escalates via the level curve. Run ends only on topout.

#### 2. End conditions
- **Topout** → `GAME_OVER` event → high-score plumbing in `triggerGameOver()` (already shipped).
- No other ending. `Rules.endCondition` returns `null` always.

#### 3. Rules
| Field | Value | Notes |
|---|---|---|
| `lineScore` | `lineClearScore` | unchanged |
| `softDropPerCell` | 1 | |
| `hardDropPerCell` | 2 | |
| `fallIntervalSec` | `(lvl) => Math.max(0.04, 0.85*0.85^(lvl-1)/TWEAKS.gravity)` | unchanged |
| `endCondition` | `() => null` | only topout (handled outside rules) |
| `onLinesCleared` | none | |
| `onTick` | none | |
| `initialModeView` | `{ kind: 'classic' }` | |

#### 4. HUD
Today's HUD: `Score / Lines / Level`. No new badges.

#### 5. Stats
`modeBests.classic = { score, lines, level, attempts }`. `attempts++` at `MODE_START`; the rest update at `MODE_END`.

#### 6. Scoring
Stock — `lineClearScore(rows) * level`.

#### 7. Implementation plan
1. Move the inline `triggerGameOver()` body's high-score write into a `gameplay/end-of-run.js` helper; `MODE_END` listeners call it.
2. `gameplay/rules.js`: add the `classic` rules pack as the default — no field overrides, all defaults.
3. Wire `Mode.start()` (new — see §6) to `buildRules('classic')` and `goRestart`.

#### 8. Edge cases
- Topout that clears a line on the same lock: today the line clear runs before topout detection; preserve. Add a regression test.
- Pause counts as session time? **No** — `playTimeMs` excludes paused intervals (existing behavior; document it in the rules pack).

#### 9. Risk + mitigation
Lowest risk. The `classic` rules pack is the *baseline test* for the rules engine — if Classic doesn't behave identically before vs. after the refactor, the rules engine is wrong.

#### 10. Effort
**0.5 day** — most of the work is in the rules-engine plumbing, not the rules themselves.

---

### 3.2 Marathon — 150 Lines, Score Multiplier

#### 1. Goal
Clear 150 lines. Final score is multiplied; topouts before 150 record an incomplete attempt.

#### 2. End conditions
- `linesCleared >= 150` → `MODE_END { reason: 'goal' }` with the bonus already applied.
- Topout → `MODE_END { reason: 'topout' }` (incomplete; standard scoring).

#### 3. Rules
| Field | Value | Notes |
|---|---|---|
| `lineScore` | `lineClearScore` | unchanged base; multiplier applied at `MODE_END` |
| `endCondition` | `s => s.linesCleared >= 150 ? { reason: 'goal' } : null` | |
| `onLinesCleared` | emit `MODE_GOAL_PROGRESS` at every 10-line milestone | |
| `initialModeView` | `{ kind: 'marathon', linesRemaining: 150, multiplier: 1.5 }` | multiplier read by HUD; applied to score at goal |

Multiplier value: **1.5×** — chosen to make Marathon's "150-line completion" comparable to a strong Classic run (~150 lines * average score density gives a meaningful but not dwarfing bonus). Tunable in `config/mode-balance.js` so live-balance changes don't touch rules.

#### 4. HUD
- A `<MarathonBadge>` reads `modeView` and shows: `Lines remaining: 87 / 150`, `Multiplier: 1.5×` (greyed until the goal triggers).
- At `MODE_GOAL_PROGRESS` milestones, the badge pulses cyan briefly. Implementation: badge subscribes to the event with `replay: true` (bus already supports this — `plan_particle_2.md` §2.4).

#### 5. Stats
`modeBests.marathon = { score, lines, level, completed, bestTimeMs }`. `bestTimeMs` is the duration of the *fastest 150-line completion*; null if never completed.

#### 6. Scoring
Standard during the run. At `MODE_END { reason: 'goal' }`, `score = round(score * 1.5)`; the bonus is announced in the result panel as "+50% Marathon Bonus". Topouts skip the multiplier.

#### 7. Implementation plan
1. `gameplay/rules/marathon.js`: encodes the override.
2. `gameplay/end-of-run.js`: handles the multiplier branch.
3. `ui/HUD/MarathonBadge.jsx` (or vanilla equivalent): subscribes to `MODE_GOAL_PROGRESS`.
4. `vfx/director.js`: listens to `MODE_END { reason: 'goal' }` and fires a "GOAL" preset (similar to existing tetris-clear, but bigger).

#### 8. Edge cases
- A multi-line clear that crosses 150 (e.g., player at 148, scores a tetris): goal fires; the 4-line score still applies pre-multiplier. Verify by test.
- Pause clock: `bestTimeMs` excludes paused intervals — same as `playTimeMs`.
- Multiplier on the *whole* run including soft/hard drop points? **Yes** — simpler, easier to reason about. Decision documented in the rules pack header.

#### 9. Risk + mitigation
- *Risk:* The 1.5× multiplier might trivialize Classic high scores. *Mitigation:* per-mode leaderboard slots (`modeBests.classic` ≠ `modeBests.marathon`) — they don't compete.
- *Risk:* Players grind to 149 lines, then top-out intentionally for a Classic high score. *Mitigation:* both modes' bests track separately; this is fine.

#### 10. Effort
**1 day** — rules pack + HUD badge + multiplier branch + tests.

---

### 3.3 Sprint — 40 Lines for Time

#### 1. Goal
Clear 40 lines as fast as possible. No score in the leaderboard sense — `bestTimeMs` is the only metric.

#### 2. End conditions
- `linesCleared >= 40` → `MODE_END { reason: 'goal', timeMs }`.
- Topout → `MODE_END { reason: 'topout' }` (no record).

#### 3. Rules
| Field | Value | Notes |
|---|---|---|
| `lineScore` | `(rows, lvl) => 0` | score doesn't matter in Sprint; setting to 0 makes the HUD honest |
| `fallIntervalSec` | classic curve | Sprint at high levels would be unfair; lock at level 1 *gravity* but allow soft/hard drops freely |
| `endCondition` | `s => s.linesCleared >= 40 ? { reason: 'goal' } : null` | |
| `onTick` | accumulate `state.timeMs += dtMs` | this is the displayed timer |
| `onLinesCleared` | emit `MODE_GOAL_PROGRESS { kind: 'lines', value, target: 40 }` every 5 lines | |
| `initialModeView` | `{ kind: 'sprint', linesRemaining: 40, timeMs: 0 }` | |

**Open question — gravity curve:** Sprint at standard gravity is solved by hard-dropping. Two options:
- **Option A:** lock gravity at level 1 (the player gets to set the pace via soft/hard drop). This is the closest match to community Sprint conventions.
- **Option B:** standard level curve. Faster gravity at higher levels punishes setup time.

Recommendation: **Option A**. Reflects standard Sprint expectations; competitive baseline for future leaderboard ranking.

#### 4. HUD
- `<SprintBadge>` shows the live timer (mm:ss.ms) + `Lines remaining: 31 / 40`. Timer ticks at the gameplay tick rate, not the render tick — gameplay drives `modeView.timeMs`.
- On `MODE_END { reason: 'goal' }`, the badge swaps to "**Cleared in 0:53.412**" and stops the clock.

#### 5. Stats
`modeBests.sprint = { bestTimeMs, attempts, completed }`. Completion percentage = `completed / attempts`. `null` for `bestTimeMs` until the first finish.

#### 6. Scoring
Zero. The score field on the HUD shows `—` (a grey em-dash) when `kind === 'sprint'` so it's clearly intentional.

#### 7. Implementation plan
1. `gameplay/rules/sprint.js`: rules pack with gravity-lock and zero scoring.
2. `gameplay/state.js`: ensure `state.timeMs` is on the snapshot. Increments only when `!paused && !gameOver`.
3. `ui/HUD/SprintBadge.jsx`: timer display, formatted with `formatMs(ms)` helper.
4. `ui/HUD/ScoreSlot.jsx`: hides or em-dashes when `modeView.kind === 'sprint'`.

#### 8. Edge cases
- Timer must not advance during `paused` or `lineClearAnim` if the line clear is locked into a fixed-duration freeze. Decision: line-clear freeze counts as game time (player chose to clear right then). Pause does not.
- A Sprint started, paused, and resumed across days: the `playTimeMs` tracking already excludes paused intervals; reuse the same gating predicate.
- `MODE_END` arrives mid-line-clear-animation: the recorded `timeMs` is the time at the *lock* that triggered the 40th line, not the time at end-of-animation. This is the spec the speedrunning community uses.

#### 9. Risk + mitigation
- *Risk:* Cheating via tab throttling or DevTools (pause `requestAnimationFrame` to plan moves). *Mitigation v1:* none. Sprint is a personal best by default; cloud leaderboards (post-MVP) will require replay validation, which is why the simulation must be deterministic from §1 onwards.
- *Risk:* Pause-buffering (open menu mid-game to think). *Mitigation:* pause is allowed but timer freezes; honest behavior. Compare to PPT/Tetrio defaults.

#### 10. Effort
**1 day** — most work is the timer plumbing on `state.timeMs` + the HUD slot. Rules pack itself is ~30 lines.

---

### 3.4 Ultra — 2 Minutes, Maximize Score

#### 1. Goal
Score as much as possible in 2 minutes. Time-attack inverse of Sprint.

#### 2. End conditions
- `state.timeMs >= 120_000` → `MODE_END { reason: 'time' }`.
- Topout before time runs out → `MODE_END { reason: 'topout' }` (recorded with score-at-topout, but flagged as incomplete).

#### 3. Rules
| Field | Value | Notes |
|---|---|---|
| `lineScore` | `lineClearScore` | full score, level multiplier intact |
| `fallIntervalSec` | classic curve | level still ramps inside the 2 minutes |
| `endCondition` | `s => s.timeMs >= 120000 ? { reason: 'time' } : null` | |
| `onTick` | `state.timeMs += dtMs; emit MODE_GOAL_PROGRESS at 30/60/90/110/115/118/119s` | the late dense ramp is the "final-seconds" tension hook |
| `initialModeView` | `{ kind: 'ultra', timeRemainingMs: 120000, score: 0 }` | |

#### 4. HUD
- `<UltraBadge>` shows the countdown timer prominently (large monospace digits). At ≤10s, color shifts to red and the timer pulses on each second.
- Score is the secondary number: live during play, becomes the headline at `MODE_END`.

#### 5. Stats
`modeBests.ultra = { bestScore, bestLines, attempts }`. Topouts contribute their score-at-topout to `bestScore` if higher (a topout 1s before time-out shouldn't void a great run).

#### 6. Scoring
Stock. `bestScore` is the only meaningful metric; `bestLines` is informational. No multiplier on top of standard scoring — the time pressure is the multiplier.

#### 7. Implementation plan
1. `gameplay/rules/ultra.js`: rules pack with the time predicate and pulse milestones.
2. `ui/HUD/UltraBadge.jsx`: countdown display + color/scale ramp.
3. `audio/director.js` (new module — sibling of `vfx/director.js`): listens for the late-second milestones and triggers a soft tick (existing `playSfx('move')` is too noisy; add a `tick-soft` clip — or reuse). Audio decisions here go through audio director, not rules.

#### 8. Edge cases
- Player tops out at 119.5s: scored normally with `reason: 'topout'`. The result panel can show "topped out 0.5s before time" as flavor.
- A line-clear animation that straddles the 2-minute mark: rules end at `state.timeMs >= 120000` checked *before* the next lock. Decision: the line clear that put `timeMs` over the limit *counts*; subsequent locks don't.
- Tab inactivation: when the tab is hidden, `requestAnimationFrame` throttles. The fixed gameplay clock still advances at 60Hz internally because `Clock` (`engine/time/clock.js`) decouples sim ticks from rAF. If the player hides the tab for 30s, that's 30s gone from their Ultra timer — which is correct, since Ultra is a 2-minute *wall clock*, not a 2-minute *active gameplay* mode. (If we want the latter, the rules pack switches to using only `dtMs` from gameplay ticks. Document the choice.)

  **Decision:** wall-clock. Hiding the tab forfeits the time. This matches every other implementation of Ultra and is the simpler rule.

#### 9. Risk + mitigation
- *Risk:* Player gets a rare 4-line clear at exactly 119.9s that wouldn't have completed before timeout if rules cut the clear off. *Mitigation:* the recorded `score` is the score at `MODE_END`, which fires *after* the line-clear pipeline runs to completion. Pipeline emits its events synchronously inside the same lock — no race.
- *Risk:* Players cheese Ultra by spamming hard-drops with no setup. *Mitigation:* none, this is the intended high-skill ceiling. Hard-drop spam tops out quickly.

#### 10. Effort
**1 day** — countdown HUD is the bulk; rules pack is ~50 lines.

---

### 3.5 Zen — No Topout, Endless

#### 1. Goal
Practice mode. Topouts shift the stack down instead of ending the run. Not competitive — pure flow.

#### 2. End conditions
- The player ends it manually (a "Stop session" button in the result panel that's accessible mid-game *only in Zen*).
- Wall-clock time-of-day is **not** an end condition. Sessions can be long.
- `Rules.endCondition` returns `null`. The `Mode.stop()` call (new — see §6) emits `MODE_END { reason: 'forfeit' }`.

#### 3. Rules
| Field | Value | Notes |
|---|---|---|
| `lineScore` | `lineClearScore` | score still accumulates, but doesn't gate run end |
| `fallIntervalSec` | a *gentler* curve — `(lvl) => Math.max(0.4, 1.0 * 0.92^(lvl-1))` | the floor (0.4s) is forgiving even at very high level |
| `onTopOut` | shift stack down by 4 rows; the active piece respawns; emit `ZEN_RESCUE { rowsRemoved }` on the bus | replaces topout |
| `endCondition` | `() => null` | |
| `resetsHighScoreSlot` | `false` | Zen scores never write to `highScore` — only to `modeBests.zen` |
| `initialModeView` | `{ kind: 'zen', shiftDownsTriggered: 0 }` | |

The "shift down" rescue is the spec for Zen; without it, Zen is just slow Classic.

#### 4. HUD
- `<ZenBadge>` shows: `Lines: 87 · Pieces: 234 · Shifts: 2`. No level number, no score (or a small grey one).
- A "Stop session" button in the corner of the playfield (new — only visible in Zen).

#### 5. Stats
`modeBests.zen = { longestSessionMs, totalLines }`. The "best" is the *longest session*, not score. Total lines accumulate across all Zen sessions ever (not best-session) — Zen is the slow-burn mode.

#### 6. Scoring
Existed for color: still counts internally, never written to high score. Stat panel does not show Zen score.

#### 7. Implementation plan
1. `gameplay/rules/zen.js`: rules pack including the topout interceptor.
2. `gameplay/topout.js` (extracted from `triggerGameOver`): now consults `rules.onTopOut`; default returns `{ end: true }`, Zen returns `{ end: false, shift: 4 }`.
3. `gameplay/board.js`: implement the row-shift operation as a board mutation; emit `ZEN_RESCUE`.
4. `ui/HUD/ZenBadge.jsx` + `ui/HUD/StopSessionButton.jsx`.
5. `vfx/director.js`: subscribes to `ZEN_RESCUE` to fire a "stack settles" preset (cascading particle wash, no penalty flash — Zen rescues are restorative, not punishing).

#### 8. Edge cases
- A topout *while a piece is falling* (e.g., locked piece mid-clear-anim): the existing `gameOver` flag gates input. In Zen, replace with a `zenRescuing` flag that pauses input for ~600ms while the shift animation plays.
- The shift removes the bottom 4 rows (or fewer if the stack height is < 4 above the topout line). Document precisely; encode in `gameplay/board.shiftDown(rows)`.
- Visual: shift-down is jarring. The director's preset should fade the bottom rows out (~250ms) before the visual snap, then drop the upper stack into place over ~300ms with a small bounce. Reuses existing settle animation primitives.
- Multiplayer cross-talk: in Versus we explicitly *want* topout to end the round. So the rules pack for Versus does not opt into Zen rescues. Reason re-stated for the file header.

#### 9. Risk + mitigation
- *Risk:* Players use Zen as cheese-mode for unbounded runs that compete with Classic. *Mitigation:* Zen score never enters high score (`resetsHighScoreSlot: false` plus per-mode bests).
- *Risk:* Shift-down animation is hard to get right; bad version is worse than topout. *Mitigation:* ship with a placeholder ("clear bottom 4 rows + brief flash") and refine; the rule logic and the visual polish are independent.

#### 10. Effort
**1.5 days** — extra cost is the topout interceptor, the shift-down board op (with tests for stack-height edge cases), and the rescue VFX preset.

---

### 3.6 Versus — Local for now, Online in §7

#### 1. Goal
Beat your opponent: be the last player standing. Cleared lines (≥2) send "garbage" to the opponent's stack.

#### 2. End conditions
- One side tops out → `MODE_END { reason: 'topout', winner: 'left'|'right' }` for the other side.
- Forfeit → `MODE_END { reason: 'forfeit' }`.
- Time-out (mode-config option, 3 min default; off by default for casual): the higher score wins; tiebreaker is the cleaner stack (lower stack height).

#### 3. Rules
Versus is **two simulations** running in lockstep, not one shared state. Each side has its own `Game` with its own `Rules`. Rules per side:

| Field | Value | Notes |
|---|---|---|
| `lineScore` | `lineClearScore` | unchanged |
| `fallIntervalSec` | classic curve | |
| `endCondition` | `() => null` | "topout = end" handled by the Versus framework, not rules |
| `onLinesCleared` | computes outgoing garbage rows and emits `GARBAGE_SENT { rows, target: 'opponent' }` | the *only* gameplay-side mode hook |
| `onGarbageReceived` | mutates the board to insert garbage rows from the bottom | applied between piece locks; never mid-fall |
| `initialModeView` | `{ kind: 'versus', opponentScore: 0, latencyMs: 0, garbageInbound: 0 }` | |

**Garbage table** (standard Tetris convention):
| Lines cleared | Garbage sent |
|---|---|
| 1 | 0 |
| 2 | 1 |
| 3 | 2 |
| 4 (Tetris) | 4 |
| Combo | +1 per combo step (capped 4) |
| T-spin (future) | +2 |

Garbage rows are full minus a single hole at a randomized column (deterministic from the shared seed).

#### 4. HUD
- Two playfields side-by-side; each has its own `<HUD>` cluster (score, lines, level, next, hold).
- `<VersusBadge>` per side: shows incoming garbage queue (small stacked indicator: `>>` arrows pulsing red), opponent score, latency (online only).

#### 5. Stats
`modeBests.versus = { wins, losses, eloMmr }`. Local Versus increments `wins/losses` only; ELO is reserved for online.

#### 6. Scoring
Per-side score is informational. The win/loss is the metric. Tiebreaker (time-out variant) uses score.

#### 7. Implementation plan
- v1 (local): two `Game` instances inside one window. Player 1 keys = the existing keymap; Player 2 keys = a configurable secondary set (e.g., WASD + RShift). Garbage is sent via the local bus directly — no network.
- v2 (online): see §7. Same `Game` per side, transport-mediated input.

Files (v1):
1. `gameplay/rules/versus.js`: garbage table, send/receive hooks.
2. `gameplay/garbage.js`: pure function `applyGarbage(board, rows, holeColumn) -> board`. Uses seeded RNG (passed in).
3. `app/versus.js`: composition root that builds two `Game`s, two `BoardView`s, and routes inputs.
4. `world/dual-board.js`: layout the two cases side-by-side. The CSS3D HUD cluster needs a "side" prop (left vs right) to position correctly.
5. `ui/HUD/VersusBadge.jsx`: incoming garbage indicator.
6. `input/intents.js`: secondary keymap for player 2.

#### 8. Edge cases
- Two simultaneous topouts: declare a draw. `MODE_END { reason: 'topout', winner: null }`.
- Outgoing garbage queued when the opponent is mid-clear-anim: the receiver's `onGarbageReceived` only fires between locks, so the queue can grow. Cap at 20 rows in the queue (anti-griefing for slow players); after 20, additional garbage is dropped on the floor with a "BLOCKED" indicator.
- Reset between rounds: round wins are tracked separately from career wins. `MODE_END` for one round triggers a 3-second post-round panel; the player can click "Next round" or "Quit". Career stats update only on quit.

#### 9. Risk + mitigation
- *Risk:* The CSS3D layout for two HUD clusters bunches up. *Mitigation:* a `Side: 'left'|'right'` prop on the panels; left positions go negative-X, right positions positive-X.
- *Risk:* P2 keymap conflicts with browser shortcuts. *Mitigation:* per-key warning if the bound combo is a known browser shortcut.

#### 10. Effort
**3 days** for v1 local. Online is its own ~5-7 day chapter (§7).

---

## 4. Mode Plumbing — Proposed Changes to `Mode.js`

The existing `Mode` namespace is a registry + persistence + listener wrapper. To support the rules engine, three additions:

### 4.1 `Mode.start(opts)`

```js
Mode.start({ key = Mode.current, seed = randomSeed(), restart = true } = {})
```

- Builds rules via `buildRules(key)`.
- If `restart`, performs the existing `goRestart` reset.
- Constructs a fresh game session and emits `MODE_START` on the bus.
- Returns the new session handle (for tests; the live game uses the bus).

This replaces the current "Start" button calling `goRestart` directly. The `Mode.start` call is the single entry point — the button, a hotkey, or a future menu all go through it.

### 4.2 `Mode.stop(reason)`

```js
Mode.stop(reason = 'forfeit')
```

- Forces an end via `MODE_END { reason }`. Used by Zen's "Stop session" button and Versus's "Forfeit" button.
- For modes whose `endCondition` already returned a result, `Mode.stop` is a no-op — the engine has already ended.

### 4.3 `Mode.config(key)`

Returns the rules pack metadata that the UI needs without booting the game:

```js
Mode.config('marathon') → {
  goalLabel: '150 lines',
  multiplier: 1.5,
  hudKind: 'marathon',
  estimatedDurationMin: 8,
  isOnline: false,
  isExperimental: false,
}
```

The Mode tab uses this to render goal/duration/etc. text without hardcoding strings in the UI module.

### 4.4 Backward-compat

`Mode.select(name)` keeps working. The settings tab calls `Mode.select` followed by `_persistSettingsSnapshot` as it does today; the change is that `Mode.start` is now the single point that *triggers* a game with that mode's rules. The two are decoupled — selecting a mode doesn't restart the run.

---

## 5. Settings Panel Changes

The Mode tab in [`settings-panel.js:277-329`](../project/src/ui/settings-panel.js#L277-L329) needs to render mode-specific config and connect to `Mode.start`.

### 5.1 Per-mode goal/description rendering

Replace the inline note "Modes coming soon — Classic plays now" with a dynamic block:

```
Mode: Marathon
Goal: 150 lines (1.5× multiplier on completion)
Estimated duration: ~8 minutes

[ Modes grid (existing 3×2) ]

Personal best: 145,200 (best time 7:42)
Attempts: 14, completed 9

[ ▶ Start Marathon ]
```

The "Personal best" line reads from `modeBests[selectedMode]` and uses the formatter from `Mode.config(key)`.

### 5.2 Mode-specific options

Some modes have parameters worth surfacing:
- **Versus:** "Time limit (off / 3 min / 5 min)", "Player 2 keymap (preset / custom)".
- **Ultra:** "Duration (90s / 2 min / 3 min)" — purist 2-min default + variants.
- **Sprint:** "Lines (40 / 20 / 100)" — community variants.

Implement as a small `<ModeOptions>` slot that switches on `Mode.current`. The options become arguments passed to `Mode.start({ key, options })`. Persist them in `settings.modeOptions[key]`.

### 5.3 Disabled handling

`versus` is currently `disabled: true` in `Mode.disabled`. Once §7 (or even §3.6 v1 local) ships, flip the flag in `mode.js`. The UI already greys disabled buttons.

### 5.4 Stats tab updates

The Stats tab needs to format per-mode bests in the new richer schema:
- `bestTimeMs` for Sprint → `mm:ss.ms`.
- `wins/losses` for Versus → `12W–7L` plus ELO.
- `longestSessionMs` for Zen → `h m`.

Each format lives in `ui/format/mode-stats.js`; the tab dispatches on the mode key to pick the renderer. This keeps the stats tab from growing per-mode `if` blocks.

---

## 6. Speculative — 3D Tetris (10 × 10 × 20)

A first-class chapter. This is the single biggest design departure in the document; it changes what "Tetris" *is*.

### 6.1 Goal
Tetris in three dimensions. The board is a 10×10 grid wide, 20 tall. Pieces are 3D polycubes. "Lines" become "layers" — completed horizontal slabs (a full 10×10 floor) clear and the stack settles down.

### 6.2 The container and axes
- **X**: horizontal width (10 cells), left-right keys.
- **Y**: vertical (20 cells), gravity axis.
- **Z**: depth (10 cells), in-out keys.

Camera is a tilted ortho-ish perspective so X and Z are both visible; the player's spatial mental model is "looking down at a glass aquarium with cubes falling." Free orbit allowed but snaps to 8 cardinal yaws (every 45°) on key release for input clarity (45° aligns the keymap to the visible sides).

### 6.3 The piece set
Three options, in increasing difficulty/novelty:

**6.3.1 Classic 4-cube polyominoes (flat in one plane).** The 7 standard tetrominoes, oriented flat, can be rotated around X, Y, or Z. Spawn axis is configurable. Easiest mental load.

**6.3.2 Classic 4-cube + 5 new 3D pieces.** Add a fixed library of 3D-only pieces — e.g., the L-shaped bend in 3D (3 cells along X, 1 cell up Z), the corner cube, the staircase. Approximately 5–7 hand-authored 3D pieces.

**6.3.3 Generic 4-cube polycubes.** Spawn random 4-cell connected 3D shapes from a library (the "pentacubes" world is well-studied; there are 8 tetracubes — perfect choice). These can require up to 24 distinct rotations to enumerate (the rotation group of a cube). Bag-randomized like the standard 7-bag.

**Recommendation:** Ship with **6.3.3** — the 8 tetracubes. It's the "real" 3D Tetris design space, has documented enumerations to draw from, and isn't prohibitively large.

### 6.4 Rotation
Three rotation axes (X, Y, Z). Each rotation is 90° around the chosen axis. Total rotation group of a cube has 24 elements; combined with the 8 tetracube shapes, the per-piece state is bounded (≤24 × 8 = 192 distinct visual states, deduped to fewer via piece symmetry).

**Controls:**
- `Z` / `X` — yaw (Y-axis) rotate left/right.
- `Q` / `E` — pitch (X-axis) tip forward/back.
- `R` / `F` — roll (Z-axis) rotate left/right.
- `Tab` — cycle named rotation (rare, for pieces with awkward defaults).

**Wall kicks in 3D** — the existing 5-offset 1D kick generalizes to the 6 face-neighbor offsets in 3D plus 12 edge-neighbor offsets, attempted in order. This is a known graphics-research problem ("3D kick tables"); we adopt a documented set rather than inventing one.

### 6.5 Line clears → layer clears
A "layer" is a full Y-slab: every cell at row Y is occupied across all 10×10 = 100 cells. The clear pipeline:
1. After lock, scan all 20 layers for fullness.
2. Multi-layer clears are valued exponentially: 1 layer = 1000, 2 = 3000, 3 = 5000, 4 = 8000 — *much* steeper than 2D Tetris because filling a 10×10 layer is much harder.
3. Cleared layers are removed; layers above settle.

### 6.6 Performance & rendering
- 10 × 10 × 20 = 2000 cells; with the existing per-cell mesh model, that's a non-issue. The instanced cube path already uses `InstancedMesh` per color group; scales linearly.
- Layer-clear VFX needs careful design: a 10×10 layer clearing fires 100 × DEPTH (currently 3) shard particles. Existing pool of 2000 shards (`plan_particle_2.md` §0) — single-layer clear consumes 300 of those, fine. A 4-layer clear is 1200 shards, near the cap. Stage 3 of `plan_particle_2.md` (depth-layered ambient) and Stage 9 (GPU sim) are pre-requisites for 4-layer 3D clears at 60fps.
- HUD overlap: the 10×10 footprint is twice as wide as the 2D 10-wide grid. The CSS3D side panels need to either (a) reposition further out, or (b) move to a top/bottom layout for 3D mode. Decision: move them to a top bar in 3D mode; the 2D layout's "side panels" don't fit a 10×10 footprint anyway.

### 6.7 Camera
- **Default**: a tilted top-down view at ~30° pitch, 0° yaw. Equivalent to Tetris 2D's "side-on" — players see X-vs-Y immediately and the Z-stack reads as "depth."
- **Free orbit**: middle-mouse drag rotates yaw freely; releases snap to nearest 45° to keep keymap directions stable.
- **Slice view**: `[` / `]` to lock the camera to looking *along* one axis. Useful for stacking precision in tight Z-corners.
- **Auto-frame on lock**: small zoom-out when a piece nears Y=18 — the same camera punch the 2D mode uses for tetris clears.

### 6.8 Rules pack
| Field | Value | Notes |
|---|---|---|
| `dimensions` | `{ COLS: 10, ROWS: 20, DEPTH: 10 }` | new on the rules pack — `gameplay/board.js` reads this |
| `lineScore` | `(layers, lvl) => [0, 1000, 3000, 5000, 8000][layers] * lvl` | exponential bias |
| `pieceSet` | `'tetracubes'` | switch in `gameplay/pieces.js` to load the 3D set |
| `endCondition` | classic topout (Y=20) | |
| `initialModeView` | `{ kind: '3d', layersCleared: 0, level: 1 }` | |

### 6.9 Implementation plan
1. **Generalize the board.** `gameplay/board.js` becomes 3D-capable: `Cell[Z][Y][X]` (storage), with `dimensions.DEPTH = 1` for 2D modes. Most reads/writes already loop ROWS×COLS — extend to 3D loops conditionally.
2. **Generalize the piece data.** `gameplay/pieces.js` adds a 3D shape format: `{ rotation0: Bool[2][2][2], … }`. Convert the 7 tetrominoes mechanically (depth=1).
3. **Implement 3D rotation.** A 3D rotation matrix function in `shared/math.js` (`rotate3d(shape, axis, dir)`). Apply, normalize bounds, then attempt kicks.
4. **Tetracube library.** Hand-author the 8 tetracube shapes plus their 24 rotations (or compute at boot from a single base orientation each).
5. **Camera mode swap.** `camera/3d-mode.js`: a different default rig that the renderer activates when `Mode.current === '3d'`.
6. **Layer-clear pipeline.** `gameplay/clear.js` already fires line-clear; extend it to scan layers (Y-slabs) when `dimensions.DEPTH > 1`.
7. **3D HUD layout.** Top/bottom bar variants of existing panels.
8. **Tetracube VFX.** New presets for the layer-clear cascade — taller, slabby, with a "reveal the floor" beat.

### 6.10 Edge cases
- **Asymmetric topout:** an X=0,Z=0 column tops out before others. Same rule — any cell at Y=20 spawning into collision is topout.
- **24-rotation enumeration:** straight-line tetracube has only 3 unique rotations (rotational symmetry). Don't pre-generate all 24 for symmetric pieces; canonicalize on insert and store unique forms only.
- **Mouse capture for camera:** orbit drag must not interfere with click-to-aim (we don't have click-to-aim — leaves orbit free). Document.
- **Piece preview:** 3D pieces in the Next/Hold panels need a small isometric thumbnail. Reuse the existing CSS3D piece preview infrastructure; render with the 3D camera at low resolution.

### 6.11 Risk + mitigation
- *Risk:* The control surface (3 rotation axes + camera + move) is overwhelming. *Mitigation:* ship 6.3.1 (flat tetrominoes, single rotation axis at a time) as a beginner toggle; **6.3.3** is the "advanced" default. Two difficulty profiles inside 3D mode is a feature.
- *Risk:* The visual flat-on-flat compositing makes it hard to see what's actually inside a stack of 100s of cubes. *Mitigation:* (a) fade-out walls feature — when the camera angle would put a wall between viewer and piece, the wall renders translucent; (b) a slice-view hotkey that hides everything outside the active Y-slab (great for setup); (c) X-ray mode for cubes 3+ rows below the active piece.
- *Risk:* Layer clears at 10×10 are *vastly* harder than 2D 10-row clears; players never trigger them. *Mitigation:* tune the line-value table generously (above) so even single-layer clears feel rewarding, and start with a forgiving `fallIntervalSec` curve. Alternative if even single-layer clears prove too rare: the 10×10 footprint can become 6×6 (still 3D, but easier) — surveyed against the literature on existing 3D Tetris implementations.
- *Risk:* The simulation cost grows: collision check is O(piece-cells × 1) per attempt, but the *stack* visualization is 2000 instanced meshes vs. 600 in 2D. With instancing and frustum culling on the renderer this is well within the existing render budget. Verify.

### 6.12 Effort
**5 days** to a playable v1 (flat tetrominoes only — design 6.3.1).
**+2 days** to add 6.3.3 tetracubes (the rotation + kick work is the bulk).
**+1 day** for 3D HUD + camera polish.
**Total: ~8 days.**

The first ship doesn't need polish — get it playable first, iterate. Treat 3D Tetris as an *experimental* mode under `gameplay/experimental/3d/` for the first 30 days; if it proves out, promote to `gameplay/rules/3d.js` (`plan_particle_2.md` §10 retention policy).

---

## 7. Speculative — Online Multiplayer (Versus over the Wire)

The single largest engineering chapter in this document. Deserves its own design pass; the headlines are below.

### 7.1 Goal
1v1 online Versus. Matchmaking, lobbies, the exact garbage rules from §3.6, persistent ELO. Stretch: 2v2, FFA, spectate.

### 7.2 Architecture pillars

**Pillar A: Two clients, one source of truth — the simulation.** Each client runs the *full* gameplay simulation locally for both players. The wire transports inputs, not state. This is the same model used by serious competitive Tetris (Tetrio, JStris) and by every fighting game with rollback netcode.

**Pillar B: Determinism is a hard requirement, not an optimization.** The architecture refactor's seeded RNG (`shared/random/seeded.js`) and `dtMs`-only time inputs (`gameplay/` never reads `performance.now()`) are exactly the property online Versus needs. If they aren't already enforced by tests on land, they must be before this chapter starts.

**Pillar C: Authoritative server, but thin.** The server validates match outcomes, manages lobbies/matchmaking, persists ELO. It does **not** run the simulation per match (server-authoritative tick is overkill for 1v1 turn-based-ish gameplay). The server's authority is over the *match envelope*, not per-frame state.

### 7.3 The transport layer

WebSocket for control + input traffic; WebRTC data channel for the low-latency input loop if/when the WebSocket variant proves too laggy. Start with WebSocket — operationally simpler.

Frame budget: input messages are tiny (`{ tick, intents }` ≈ 16 bytes), 60Hz max. ~1 KB/s per direction. WebSockets handle this trivially.

### 7.4 The tick model

Two viable approaches:

**7.4.1 Lockstep — both clients delay inputs by ~120ms RTT and execute simultaneously.** Pros: simple, deterministic, no rollback needed. Cons: input lag adds ~RTT/2 to the player's local feel — at 80ms ping, a 40ms perceptible delay on every key. Tetris players notice 40ms.

**7.4.2 Rollback — execute locally immediately, predict the opponent, reconcile when their input arrives.** Pros: zero perceived input lag for the local player. Cons: complex; requires the simulation to be *resettable* to any past state and re-stepped through N frames. Cost per resimulation: trivial (a tetris simulation is ~microseconds per tick).

**Decision: rollback.** The simulation is small enough that resimulation is free, and the perceptible-latency win is large. This is exactly why §1.4 hard-required determinism: rollback **is** "save snapshot, replay inputs, reconcile."

### 7.5 The garbage protocol

Garbage is sent on `LINE_CLEAR` events. Wire format:

```json
{ "type": "garbage", "fromTick": 1234, "rows": 4, "holeCol": 7 }
```

`holeCol` is computed deterministically from the seed + tick on the *sender's* simulation, so the receiver can validate it without trusting the sender. (Sender cheating to choose `holeCol` is detected at validation.)

### 7.6 Server services

| Service | Owns | Tech |
|---|---|---|
| **Auth** | accounts, OAuth, anonymous-guest IDs | a thin Node service or Cloudflare Workers |
| **Lobby** | match creation, invitation links, pre-match settings | same |
| **Matchmaking** | ELO-based queue, region-aware | same; ELO state in Postgres |
| **Match record** | match history, replays, ELO updates | Postgres + S3 (replays) |
| **Anti-cheat** | replay validation against deterministic simulation | offline batch — replay each match server-side after end, verify outcome matches reported result |
| **Realtime relay** | WS server (or peer-to-peer-via-server signaling for WebRTC) | a Node WS service or Cloudflare Durable Objects |

### 7.7 The replay validation property

This is the architectural lynchpin. After a match ends, both clients submit:
- The seed.
- The full input sequence per side (tick-indexed).
- The reported outcome.

The server replays both simulations from the same code as the client (a `gameplay/` import, since gameplay is browser-agnostic — `plan_architecture.md` §4: "must run under Node with no DOM"). If the simulation outcome doesn't match the reported outcome, the match is flagged. ELO is awarded only on validated matches.

Cheating attempts detected:
- Modified game speed → input timestamps don't match simulation outputs.
- Modified scoring → re-simulated score differs.
- Modified piece sequence → seed-derived bag doesn't match the inputs that worked.

### 7.8 Anti-cheat threat model

This is a hobby project; the threat model is "low-effort cheats break leaderboards," not "state actor." Mitigations:
- Replay validation (above) — handles 99% of speed-hack and score-hack cheating.
- Server-side ELO bounds — gains capped per match.
- Anomaly detection — flag accounts whose replay-validation diff rate is unusually high.

We do **not** ship client-side anti-cheat (browser DOM/JS introspection). Not effective; alienates technical users.

### 7.9 Latency strategy

| Latency band | Strategy |
|---|---|
| < 50ms | Rollback runs imperceptibly; misprediction reconciliation is invisible. |
| 50–150ms | Rollback runs; reconciliation can cause brief stack flicker on the opponent's side. Acceptable. |
| 150–300ms | Rollback works but reconciliation events visible. Show "high latency" warning to both players. |
| > 300ms | Refuse the match; offer rematch with a closer-region opponent. |

The latency budget of 50ms is the design target; the > 300ms cutoff is the ship-stopper.

### 7.10 Implementation plan (sequenced)

1. **Determinism audit + seeded RNG** (1 day): every `Math.random` in `gameplay/` becomes a seeded source. Tests for determinism (run sim twice with same seed + inputs, assert identical state) gate the rest.
2. **Input sequence recorder** (½ day): the tick-indexed input stream is captured + replayable from any saved seed. This is the same property used for offline replays.
3. **Local Versus (§3.6)** (3 days): two `Game`s in one window, garbage protocol routed via the local bus. Validates the garbage table before the wire is involved.
4. **WS transport + lobby** (3 days): a lobby UI, friend-invite link, WS connection between two clients. No matchmaking yet.
5. **Rollback netcode** (3 days): client-side rollback + reconciliation. Test with artificial latency injection.
6. **Server replay validation** (2 days): the gameplay package imported into a Node service, replays validated nightly.
7. **Matchmaking + ELO** (2 days): queue UI, ELO table, match-history view.
8. **Anti-cheat tuning + soft launch** (2 days): observe replay-diff rate in the wild; tune thresholds.

**Total: ~16 days.** Deliberately spread; this is the longest single subsystem in the project.

### 7.11 Risk + mitigation
- *Risk:* Hosting cost. *Mitigation:* WS load is trivial (tiny messages, 1v1 only); a single small VM hosts thousands of concurrent matches. Replay validation runs on cron, not realtime; cheap.
- *Risk:* Determinism bugs (a `setTimeout`-based animation timer leaks into rules). *Mitigation:* hard ESLint rule blocking `Math.random`, `performance.now()`, and `setTimeout` from `gameplay/**`. Add to the existing `no-restricted-imports` set on day one of this chapter.
- *Risk:* Smurfing/multi-account ELO inflation. *Mitigation:* low priority for hobby scale; phone-verification gate on ranked at 1000+ daily active users (not on day one).

### 7.12 Effort
**~16 days**, can be parallelized across two contributors after step 1 (one on transport, one on rollback).

---

## 8. Speculative — Pure Physics Mode

The most "fun curiosity" of the speculative set. Lower stakes — small, focused mode that complements the rest by *being weird*.

### 8.1 Goal
Each cube is a rigid body. Gravity is real (downward acceleration, restitution, friction). Pieces stick together until they lock; locked pieces are released into the physics world. "Line clear" is replaced by a proximity rule: a horizontal layer of N adjacent cubes resting at similar Y triggers a clear.

### 8.2 Why this matters
It's a different *medium*: in classic Tetris, the simulation is a perfect grid. In physics mode, the simulation is approximate — pieces lean, slip, settle into wedges. The visual identity becomes "blocks falling like a Tetris game *should* fall."

This is firmly the "experimental for fun" lane; it's not a competitive mode and shouldn't compete on score with the others.

### 8.3 Stack: Rapier vs. Cannon vs. Box2D-3D

| Lib | Pros | Cons |
|---|---|---|
| **Rapier** (rapier3d) | wasm, deterministic-ish, modern API, well-maintained | bundle is ~600KB |
| **Cannon-es** | mature, JS-native | older API, slower for many bodies |
| **Box2D 3D** | n/a — Box2D is 2D only | — |

**Recommendation: Rapier.** The deterministic-ish property matters for the "physics mode replay" feature; modern API matches Three.js better; bundle hit is acceptable for a non-default mode.

### 8.4 Bodies & collision
- One rigid body per locked cube. The active falling piece is *kinematic* (still grid-driven for placement); on lock, each cube is converted to a rigid body and released into the physics world.
- Collision shape: a unit cube with a small skin (Rapier `cuboid(0.5)`).
- Material: medium friction (~0.6), low restitution (~0.1) — cubes settle, don't bounce around.

### 8.5 Layer detection
A "complete row" no longer exists in the grid sense. Replacement rule:
- A "layer" is a set of N≥10 adjacent cubes (face-touching) whose Y centers are within a tolerance band (±0.4 of a cell). Connected-component check on the cubes' positions.
- When such a layer forms, the cubes in it are removed and points awarded.
- This produces emergent "diagonal lines" sometimes — a player can clear a row that's slightly tilted because the cubes settled wedged. This is the *good* surprise of physics mode.

### 8.6 Rules pack
| Field | Value | Notes |
|---|---|---|
| `lineScore` | layers cleared × 100 (no level multiplier — physics is its own thing) | |
| `endCondition` | a cube rests at Y > 22 (stack overflow) | physics topout, not grid topout |
| `onLock` | hand cubes off to Rapier; the falling piece becomes kinematic-only until lock | |
| `physicsTickHz` | 60Hz fixed | matches gameplay tick |
| `initialModeView` | `{ kind: 'physics', settledCubes, layersCleared }` | |

### 8.7 Performance
- Rapier handles ~500 bodies at 60Hz comfortably in wasm. With the existing 2000-cell budget *cleared regularly*, the live body count stays in the low hundreds.
- Wakeup heuristics: bodies that haven't moved for 1 second sleep until disturbed. Rapier supports this natively. Critical for performance.

### 8.8 Visual
- The stack now *looks* like physics — wobbling, settling, scuttling small cubes. This is the visual identity.
- Cube animations from `vfx/` no longer apply per-cell (cells aren't stable); visual is driven by Rapier transforms.
- A subtle dust puff per cube at high-velocity collision makes settling readable.

### 8.9 Implementation plan
1. **Rapier integration** (1 day): `physics/world.js` wrapping the Rapier world; clock-driven step.
2. **Body lifecycle** (1 day): convert grid cells to bodies on lock; clean up bodies on layer-clear.
3. **Layer detection** (1 day): connected-component per frame on resting cubes; stable across consecutive frames before triggering (debounce so a cube wobbling in/out of the band doesn't oscillate).
4. **Physics rules pack** (½ day): the rules + scoring.
5. **Mode HUD** (½ day): cube count, layers cleared, settle indicator.
6. **VFX integration** (1 day): cube collision sounds + dust; existing line-clear shatter adapts to layer-clear (use the cube body positions as emitter points).

### 8.10 Edge cases
- **Pieces not "stuck" together:** during the falling phase, the piece is kinematic — its 3 cells move as one. On lock, they become 3 separate bodies. Players will sometimes drop a piece that immediately splits because of the floor's wedge — this is intended; it's the physical signature.
- **Stack forever bouncing:** failsafe — if the *physics step time* exceeds 2ms three frames in a row, force-sleep all bodies below Y=10. (Stuck-loop guard.)
- **Quick scoring abuse:** players might find a way to wedge cubes that auto-clear. This is fine — it's the emergent fun. Not a balance problem at the experimental tier.

### 8.11 Risk + mitigation
- *Risk:* Rapier wasm bundle bloats the main bundle. *Mitigation:* lazy-import on physics-mode start; don't load it for the other modes.
- *Risk:* Determinism is "ish" — two clients won't agree on a settled stack. *Mitigation:* don't run physics mode in Versus. It's single-player.
- *Risk:* Visual chaos = unreadable. *Mitigation:* tune restitution low, friction high, gravity strong. The starter values above are conservative.

### 8.12 Effort
**5 days** to playable v1. Add 1 day for VFX polish.

---

## 9. Ordering & Schedule

### 9.1 Recommended landing order

Each item is independently shippable; the game stays playable through every PR.

1. **Rules engine plumbing** — `gameplay/rules.js`, `MODE_START` / `MODE_END` events, `Mode.start()` / `Mode.stop()`. Classic still works; nothing visible changes. *(1 day)*
2. **Marathon** — first real rule pack on the new engine; validates the engine's seams. *(1 day)*
3. **Sprint** — adds the `state.timeMs` HUD plumbing. *(1 day)*
4. **Ultra** — countdown HUD + late-second milestones. *(1 day)*
5. **Zen** — topout interceptor + shift-down board op. *(1.5 days)*
6. **Versus (local)** — first multi-player chapter, no networking. *(3 days)*
7. **Mode tab UX upgrade** — per-mode goal/description/options/best display. *(0.5 day)*
8. **Stats schema renderer** — per-mode formatters. *(0.5 day)*

**Total core modes: ~9.5 days.** This is the "ship six modes" plan.

After core modes:

9. **3D Tetris (experimental)** — flat tetrominoes first, tetracubes later. *(8 days, see §6.12)*
10. **Pure physics (experimental)** — *(5 days, see §8.12)*
11. **Online Versus** — *(16 days, see §7.12)*

### 9.2 Parallelization notes
- Item 1 (rules engine) is a hard prerequisite for 2–6.
- Items 2–5 can run in parallel after 1 lands, since each touches its own rules pack file.
- 6 (Versus local) needs 1 but is independent of 2–5.
- 9 (3D) requires generalizing `board.js` — coordinate with whoever ships 1.
- 10 (physics) is fully independent; can land any time after 1.
- 11 (online) requires 6 (Versus local) plus a determinism audit; can begin its determinism work in parallel with 2–5.

### 9.3 Test strategy

The rules engine is the most testable surface in the codebase. Vitest cases per mode:
- `classic`: spawn, clear, level up, top-out, score sums.
- `marathon`: 10/50/100/149/150-line milestones; multiplier on goal vs. on topout.
- `sprint`: timer accumulation across pause; goal at exactly 40 lines; topout at 39 (no record).
- `ultra`: timer expiration mid-clear; topout at 119s.
- `zen`: topout interception → shift down; score never enters high score.
- `versus`: garbage table per row count; combo accumulation; simultaneous topout draw.

Each rules pack ships with its test file as a sibling. Total test surface per mode ~50 lines; total ~300 lines of new tests for the six.

### 9.4 Telemetry hooks (optional)

A single `events.js` topic — `MODE_END` — is enough to track adoption per mode locally. If we ever wire telemetry to a server, it's a single subscriber:

```js
bus.on('MODE_END', (e) => {
  fetch('/telemetry/mode-end', { method: 'POST', body: JSON.stringify(e) });
});
```

Today the listener is unused. Mark the hook as future-only.

---

## 10. Mode Plumbing Details (the file-touch list)

Concrete files that change for each phase, mapped to the architecture in `plan_architecture.md` and the existing tree.

### 10.1 Phase 1 — Rules engine

| File | Change |
|---|---|
| `gameplay/rules.js` | **new** — `buildRules(modeKey, opts)` and the `Rules` typedef |
| `gameplay/state.js` | **new** — extracted from inline `main.js` state; adds `timeMs`, `modeView` |
| `gameplay/end-of-run.js` | **new** — the high-score / stats write moves here |
| `gameplay/events.js` | adds `MODE_START`, `MODE_END`, `MODE_GOAL_PROGRESS`, `GARBAGE_RECEIVED`, `GARBAGE_SENT` |
| `gameplay/mode.js` | adds `Mode.start()`, `Mode.stop()`, `Mode.config()` |
| `app/main.js` | shrinks: `triggerGameOver` becomes `endRun({reason:'topout'})` calling `gameplay/end-of-run.js`. Fall interval reads from `rules.fallIntervalSec` |
| `engine/storage.js` | `STATS_DEFAULTS.modeBests` extended for the new per-mode shapes |

### 10.2 Phase 2-5 — One mode each

For each mode `M`:
| File | Change |
|---|---|
| `gameplay/rules/${M}.js` | **new** — the rules pack |
| `gameplay/rules/${M}.test.js` | **new** — Vitest suite for the rules pack |
| `ui/HUD/${M}Badge.jsx` | **new** — mode-specific HUD slot |
| `ui/format/mode-stats.js` | extend with the mode's format function |

### 10.3 Phase 6 — Versus (local)

| File | Change |
|---|---|
| `gameplay/rules/versus.js` | **new** |
| `gameplay/garbage.js` | **new** — pure functions for the garbage table |
| `app/versus.js` | **new** — composition root for two `Game`s |
| `world/dual-board.js` | **new** — side-by-side layout |
| `input/intents.js` | secondary keymap for player 2 |

### 10.4 Phase 7 — Mode tab UX

| File | Change |
|---|---|
| `ui/settings-panel.js:277-329` | extends mode tab with per-mode options + best display |
| `gameplay/mode.js` | `Mode.config(key)` returns the new metadata |

### 10.5 Phase 9 — 3D Tetris

| File | Change |
|---|---|
| `gameplay/experimental/3d/rules.js` | **new** |
| `gameplay/experimental/3d/pieces.js` | **new** — the 8 tetracubes |
| `gameplay/board.js` | generalized to optional 3rd dimension |
| `shared/math.js` | `rotate3d(shape, axis, dir)` |
| `camera/3d-mode.js` | **new** — camera rig variant |
| `world/board-view.js` | conditional 3D-grid path |

### 10.6 Phase 10 — Physics

| File | Change |
|---|---|
| `gameplay/experimental/physics/rules.js` | **new** |
| `physics/world.js` | **new** — Rapier wrapper |
| `physics/body-lifecycle.js` | **new** — grid → body conversion |
| `gameplay/board.js` | hooks at lock-time delegate to physics rules pack |

### 10.7 Phase 11 — Online Versus

| File | Change |
|---|---|
| `net/transport.js` | **new** — WS client |
| `net/lobby.js` | **new** — lobby state machine |
| `net/rollback.js` | **new** — client-side rollback |
| `net/replay.js` | **new** — replay packet format |
| `server/` | **new top-level** — Node service for matchmaking + validation |
| `gameplay/random/seeded.js` | hardening (probably already exists; verify) |

---

## 11. Risks (Whole-Document)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Rules engine refactor regresses Classic | Medium | High | Vitest snapshot of Classic behavior locked in *before* refactor; PR-1 must produce identical event traces. |
| Sprint gravity-lock decision (§3.3) is community-wrong | Low | Medium | Surface as an option (Sprint variant: gravity locked / classic / hardmode). |
| Marathon multiplier (1.5×) makes Classic feel underweight | Low | Low | Per-mode bests separate already; not a balance crisis. Tune in `config/mode-balance.js`. |
| Zen rescue animation looks worse than topout | Medium | Medium | Ship placeholder; iterate on VFX. Don't block Zen on perfect VFX. |
| Versus local layout breaks with current HUD positions | High | Medium | The `Side: 'left'/'right'` prop refactor is a known cost; add to phase 6 budget. |
| 3D rotation control is incomprehensible to most players | High | Medium | Beginner toggle (flat tetrominoes, single rotation axis); X-ray + slice-view defaults on. |
| Online ELO inflation via smurfs | Low (at scale) | Low | Out of scope for v1; phone-verification at 1000+ DAU. |
| Physics mode breaks determinism for Versus | n/a | n/a | Physics is single-player only; Versus disallows physics rules pack. Documented in `gameplay/rules/versus.js` header. |
| Schedule slippage as 3D + online + physics overlap | High | Medium | Stage-gate: all six standard modes ship before any speculative mode begins. |

---

## 12. Final Word

The single most useful property of this plan is that **every mode is small once the rules engine exists**. Marathon is 30 lines of rules + 50 lines of HUD + 30 lines of test. The hard work is the engine plumbing in phase 1 — and that work *also* unlocks the deterministic simulation that online Versus needs.

The speculative modes (3D, online, physics) live behind the experimental wall on day one. They prove out under the same 30-day promote-or-delete policy that's already in the project's culture (`plan_particle_2.md` §10). If the 3D mode delights, it gets promoted and gains its own polish budget. If it doesn't, it's deleted without ceremony.

Build the engine straight. Ship the six standard modes one rule pack at a time. Decide about 3D, physics, and online based on how the first six feel.

---

*End of document.*
