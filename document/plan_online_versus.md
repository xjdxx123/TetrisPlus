# Tetris+ Online Versus — Implementation Plan

**Date:** 2026-05-09 · **Status:** design — not started.
**Scope:** the §2.2 chapter from `plan_gameplay_2.md`. Lifts the v1 §7
spec out of `archived/plan_gameplay_1.md`, refreshes it against
everything that's shipped since (seeded RNG, Game.serialize/restore,
VersusSession, modern-rules events, garbage queue + cancellation,
spawn-delay window), and turns the broad-strokes "16 days, sequenced
1–8" outline into the concrete phases this branch will land in.

This is the **single largest engineering subsystem in the project.**
Spread it across multiple sessions; do NOT attempt to ship in one
sitting. Each phase below has its own acceptance criteria and test
surface so a pause-and-resume mid-chapter is well-defined.

---

## 0. Where we stand

### 0.1 Already shipped (the architectural floor)

Everything below already exists on `main`. Online versus builds on
top — these pieces are not relitigated here.

| Capability | Where | Why it matters for online |
|---|---|---|
| **`Game` class** — per-instance simulation, no module-scope state | `gameplay/game.js` | Two clients = two `Game` instances per side per client. Each match runs 4 simulations total (2 per player × 2 players' clients), all deterministic from the same seed + inputs. |
| **Seeded RNG** — `createSeededRng(seed)` returns a fn with `.state` accessor for snapshot / restore | `shared/random/seeded.js` | Rollback needs `rng.state` in every snapshot. Replay validation needs the same seed → identical bag sequence on both sides. |
| **`Game.serialize()` / `Game.restore(blob)`** — full state round-trip, JSON-friendly, version-bumped | `gameplay/game.js` (v=2 since §2.1) | The snapshot primitive for rollback. A 2D Game blob is ~4KB; a 3D one is ~40KB. Snapshot every N ticks; reconcile by restoring the last accepted snapshot + replaying inputs. |
| **`VersusSession`** — two `Game`s + two `BoardView`s + garbage bridge, opponent input via `BotController` OR a second `InputRouter` | `app/versus.js` | The local-versus composition. Online swaps the `BotController` for a `RemoteOpponent` that consumes wire-delivered input frames. The composition stays the same. |
| **`EventBus`** — per-game bus, replay buffer, `recorderSize` for input capture | `engine/events/bus.js` | Already supports recorder tape; the wire-side feed is the same shape. |
| **Modern-rules events** — `T_SPIN` / `B2B_CHAIN` / `B2B_BREAK` / `PERFECT_CLEAR` / `COMBO_START` / `COMBO_END` | `gameplay/events.js` | These propagate over the wire as part of the bus replay; opponent's HUD picks them up the same way local does. |
| **Garbage protocol** — outgoing queue, cancellation broker, M5 spawn-delay window (`GARBAGE_DELAY_MS_DEFAULT = 800`), per-side hole columns | `gameplay/game.js` (`_processOutgoingGarbage` + `_drainInboundGarbage`) | The wire format is "one event per `GARBAGE_SENT` emission with `{tick, rows, holeCol}`." All the consumer logic (queue cap, cancellation, drain timing) is already correct. |
| **`InputRouter` + `BotController`** with the `InputFrame` shape `{intent, softDrop, hold}` | `input/intents.js` + `gameplay/bot-controller.js` | The wire's per-tick input payload is just `InputFrame` plus a tick number. |
| **§1.2 VFX celebration recipes** | `vfx/director.js` | A T-spin / Perfect Clear from the remote opponent fires the same shockwave / SFX it does locally. v2 §2.2 ordering note ("ship 1.2 first") is satisfied. |

### 0.2 What still leaks determinism today

A clean room is required before rollback can work. Two known leaks:

1. **`performance.now()` reads in `gameplay/game.js`** — `_sessionStart`
   is set from `performance.now()` in constructor + reset. It's only
   used to compute display "session length" for HUDs (cosmetic, not
   rules-relevant). Replace with `null` or a constant `0` when in
   online mode (or always — tests pass either way).
2. **No ESLint rule blocking new leaks.** v1 §7.11 risk #2 calls for a
   `no-restricted-syntax` rule on `gameplay/**` blocking `Math.random`,
   `performance.now()`, `Date.now()`, `setTimeout`, `setInterval`. Land
   this on Phase A so the audit can't regress.

Both are bounded — the simulation is otherwise deterministic by
construction. The §3.7 / §12 / §2.1 / §2.3 rework all maintained the
"`gameplay/` is pure JS, no DOM/audio/THREE/timers" property.

### 0.3 What the v1 spec assumed but the codebase has surpassed

The v1 §7.10 sequenced plan listed steps 1–3 as "Determinism audit",
"Input recorder", "Local Versus." All three are effectively shipped:

- **Determinism**: seeded RNG + Game.serialize/restore landed in §3.7
  sub-phase 7f.
- **Input recorder**: the bus has a recorder tape opt
  (`recorderSize`). Capturing inputs is a 1-line subscriber.
- **Local Versus**: VersusSession ships with bot opponent + dual-board.

So the v1 16-day estimate compresses. Realistic v2 effort, given the
shipped floor: **~10–12 days** end-to-end. Still the longest single
chapter; still must spread across sessions.

---

## 1. Architecture pillars (lifted from v1 §7.2, refreshed)

### Pillar A — Two clients, one source of truth: the simulation

Each client runs the **full** gameplay simulation locally for both
players. The wire transports `InputFrame`s, not state. Every event
the local player sees on their HUD also fires on the remote client's
opponent panel because that client re-simulated identical inputs
against an identical seed.

This is the model used by Tetrio, JStris, and every fighting game
with rollback netcode. It's the only model the shipped `Game` class
naturally supports.

### Pillar B — Determinism is non-negotiable

Online runs the existing `gameplay/` package unmodified. If anything
in there depends on wall-clock time, browser features, or unseeded
randomness, online breaks. Phase A locks this down with an ESLint
rule + a per-tick determinism test (run the same Game twice with the
same seed + inputs, assert identical `serialize()` blob).

### Pillar C — Server is thin and authoritative over the envelope, not the tick

The server validates **match outcomes** (replay validation),
**lobby state** (matchmaking, invitations, pre-match settings), and
**persistent ELO**. It does NOT run a per-tick simulation per match —
that's overkill for 1v1 and would 10× the hosting cost. Authority over
"this is a real match between these two players, with this seed,
that ended X-Y" is enough.

### Pillar D — Rollback over lockstep

Lockstep adds RTT/2 to local input feel. Tetris players reliably
notice 40ms; a 100ms RTT match would feel sluggish.

Rollback executes locally immediately + predicts the opponent +
reconciles when the remote frame arrives. The reshipped Game's
`serialize`/`restore` is exactly the snapshot primitive rollback
needs. With 60Hz simulation + `Game.serialize` being a few KB, the
rollback budget is generous: keep ~120 frames of history (~2 seconds)
+ snapshot every 30 frames (~500 ms cadence).

---

## 2. Wire format

Every message is a tagged JSON object with a `t` (type) field. Hot-
path messages (per-tick `input`) stay tiny (~32 bytes serialized) so
60Hz output is ~2 KB/s per direction. We can revisit binary
(MessagePack / custom typed-array) if profiling shows the JSON
overhead matters; the v1 spec preferred starting with JSON for
operational simplicity.

### 2.1 Control plane (lobby + match lifecycle)

```ts
// Client → server
{ t: 'auth',         token: string }                            // OAuth or anon-guest
{ t: 'lobby_create', settings: MatchSettings }                  // pre-match config
{ t: 'lobby_join',   code: string }                             // friend invitation flow
{ t: 'queue_enter',  region: string, eloRange?: [number,number] }
{ t: 'queue_leave' }
{ t: 'match_ready',  matchId: string, ready: boolean }          // both clients ack the seed + opponent identity
{ t: 'match_resign', matchId: string }                          // forfeit

// Server → client
{ t: 'auth_ok',      userId: string, elo: number, region: string }
{ t: 'lobby_state',  code: string, players: PlayerEntry[], settings: MatchSettings }
{ t: 'match_found',  matchId: string, seed: number, opponent: PlayerEntry, settings: MatchSettings, peerEndpoint?: string }
{ t: 'match_start',  matchId: string, startTickAt: number }     // both clients sim 0 at startTickAt
{ t: 'match_end',    matchId: string, winner: 'me'|'opp'|'draw', eloDelta: number }
{ t: 'error',        code: string, message: string }
```

`MatchSettings` mirrors the existing rules-pack opts surface —
`mode: 'versus'`, `gravityScalar`, `garbageDelayMs`, etc. — so a
match's rules are reproducible from the settings blob alone.

### 2.2 Realtime plane (per-tick input + opponent events)

**Input frames** — sent every tick the local player's input changed
OR every 8 ticks as a heartbeat (so the remote knows we're still
alive even when no key is pressed):

```ts
// Both directions (relayed via server, or P2P over WebRTC if available)
{ t: 'in', tick: number, frame: InputFrame }
```

`InputFrame` reuses `input/intents.js#InputFrame`:
`{ intent: 'left'|'right'|'rotateCW'|...|'none', softDrop: boolean, hold: boolean }`.

**Snapshot exchange** — every 60 ticks (~1 sec at 60Hz), each client
sends its hash of the recent state for sanity-checking. If the hashes
diverge for 3 consecutive snapshots, both clients enter a soft re-sync
(re-broadcast inputs + restore from the last agreed snapshot). Three
divergent snapshots = a determinism bug AND a debug signal: the
client that diverged uploads its full state for offline diagnosis.

```ts
{ t: 'snap', tick: number, hash: string }                       // 16-char hex of game.serialize() hash
{ t: 'desync', tick: number, blob: GameBlob }                   // only sent on consecutive divergence
```

**Garbage events** — when the local sim emits `GARBAGE_SENT`:

```ts
{ t: 'gar', tick: number, rows: number, holeCol: number }
```

`tick` is the local sender's tick at the moment of the LINE_CLEAR
that produced the outgoing garbage. The remote's sim re-derives
`holeCol` from its own sim of the same inputs; the wire copy is for
**validation** (cheating detection), not application — the remote
sim already produced the same value if both sims agree.

### 2.3 Why JSON, why now

JSON is debug-friendly, browser-native, and handles ~2 KB/s without
hesitation. Compression (per-message-deflate or shared-dictionary
brotli) pulls the per-tick payload to ~12 bytes if we ever need to
optimize. Custom binary formats are a last resort; the time to
optimize is "operational profile shows wire bytes are the bottleneck"
not "we suspected they would be."

---

## 3. Rollback netcode

### 3.1 Buffer sizes

- **Local input log:** every InputFrame for the last 240 ticks (~4
  sec). Used to replay forward from any historical snapshot.
- **Snapshot cadence:** save `game.serialize()` every 30 ticks (500
  ms). Keep the most recent 8 snapshots (~4 sec window) — matches the
  input log.
- **Remote input buffer:** indexed by tick. Inputs arrive
  out-of-order under packet loss; the buffer fills holes from
  re-transmissions and drives the rollback decision.

### 3.2 Per-tick decision

```text
function tick():
  localInput = readKeyboard()
  recordLocalInput(currentTick, localInput)
  sendToRemote({ t:'in', tick: currentTick, frame: localInput })

  if remoteInput[currentTick] is known:
    advance(localInput, remoteInput[currentTick])
  else:
    // Predict: assume remote pressed nothing.
    advance(localInput, EMPTY_FRAME)
    markPredictedAt(currentTick)

  currentTick++

function onRemoteInputArrived(tick, frame):
  if tick was predicted AND the actual frame differs from the prediction:
    // Rollback + resimulate.
    snap = nearestSnapshotBefore(tick)
    game.restore(snap.blob)
    for t in snap.tick .. currentTick:
      inputAt = remoteInput[t] || EMPTY_FRAME // default for any still-missing remote frames
      advance(localInputAt(t), inputAt)
    // The local view jumps to the reconciled state.
```

### 3.3 Snapshot scope

`Game.serialize()` already covers: board (3D-aware), active piece,
queues, score, lines, level, garbage queue, modern-rules state
(`_b2b`, `_combo`, `_lastAction`, `_lastKickIndex`), run stats,
and `rngState`. That's everything rollback needs.

The snapshot does NOT cover: render state (cellMeshes,
pieceVisualOffset, animations). That's by design — render state is
re-derived from gameplay events the next frame.

### 3.4 Visual smoothing

A misprediction that flips the opponent's row 3 from "almost full" to
"cleared" will visually pop. To soften:

- **Tween the opponent's score** between mispredicted + reconciled
  values over 200ms instead of snapping (the score tween already
  exists in main.js for local — extend it to the opponent panel).
- **No tween for the board** — show the reconciled state immediately;
  Tetris players read the board geometry critically and a 200ms-wrong
  board is misleading. A flicker of "row 3 was about to clear, now it
  isn't" is the honest signal.
- **Brief desync warning** on consecutive misprediction (≥ 3 in a
  second) — surfaces transient packet loss without alarming on a
  single off-frame.

---

## 4. Server services

| Service | Owns | Tech | Notes |
|---|---|---|---|
| **Auth** | Accounts, OAuth (Google + GitHub), anonymous guest IDs | Cloudflare Workers + D1 | Guests get a 24-hour ID; ELO not persisted. |
| **Lobby** | Match creation, friend-invite codes, pre-match settings | Cloudflare Durable Objects (one per active lobby) | DOs hold transient state cheaply. |
| **Matchmaking** | ELO-based queue, region affinity | Same — DO per region | Pair-and-release pattern; expect <10 concurrent searchers per region in early access. |
| **Realtime relay** | WS server for input/snapshot/garbage messages | Cloudflare Durable Objects (one per active match) | Each match is a DO; clients connect via WS to that DO. P2P WebRTC is a Phase E possibility but not Phase A. |
| **Match record** | Match history, replays, ELO updates | Cloudflare D1 + R2 (replay blobs) | Replay = `{seed, p1Inputs[], p2Inputs[], reportedOutcome}` — bytes are tiny per match. |
| **Replay validation** | Anti-cheat — re-runs every match server-side, asserts outcome | Cron-scheduled Worker; imports `gameplay/` directly | Each replay re-sims in <1s on Workers' CPU budget. |

**Why Cloudflare:** zero-cost for the expected hobby-scale launch
(<1k matches/day), DO model maps cleanly to "one isolated state
machine per match", `gameplay/` already runs under Node/Workers
because plan_architecture.md §4 forbids DOM-side imports inside it.

**Stack alternative:** if the team prefers self-hosted Node, a single
small VM (1 vCPU / 2 GB) handles the same workload. The plan stays
shape-compatible — the WS protocol is identical and `gameplay/`
imports the same.

---

## 5. Phase plan

Each phase is independently committable + tested + reviewable.
Effort estimates are calendar days for one focused contributor; the
phases are sequenced because each depends on the prior. Steps marked
**[parallel-ok]** can run alongside the previous phase by a second
contributor.

### Phase A — Determinism lockdown (½ day)

**Goal:** prove the simulation is bit-identical given seed + inputs.

- Replace `performance.now()` reads in `gameplay/game.js` with a
  test-overridable `now` opt (default `null` for online; optional
  Date.now() for HUDs that want a real wall clock).
- Add an ESLint rule (`no-restricted-syntax` + `no-restricted-imports`)
  on `src/gameplay/**` blocking `Math.random`, `performance.now`,
  `Date.now`, `setTimeout`, `setInterval`, `THREE`, `document`,
  `window`. The rule catches future regressions.
- New test: `gameplay/determinism.test.js` builds two fresh `Game`s
  with the same seed, replays the same 1000-tick input sequence
  through both, asserts `game.serialize()` is byte-identical.

**Acceptance:** the new test passes; ESLint reports no violations on
the existing `gameplay/` tree.

### Phase B — Input recorder + replay primitives (½ day)

**Goal:** capture per-tick input frames into a tape; replay any tape
against a fresh Game from the same seed + reproduce the run.

- New module `gameplay/replay/recorder.js` — subscribes to a
  per-tick input source (the host's `InputRouter`), stores
  `{tick, frame}` entries.
- New module `gameplay/replay/player.js` — given `{seed, inputs[]}`,
  constructs a Game + steps it through, returning the final
  serialized state + an event log.
- Round-trip test: record a 200-tick run → replay through the player
  → assert the player's final state matches the recorder's source's
  final state.

**Acceptance:** round-trip test green; recorder + player exposed
from `gameplay/replay/index.js`.

### Phase C — Wire protocol module (1 day)

**Goal:** type-safe message constructors + parsers for every wire
shape from §2 above. No transport yet — pure encode/decode.

- `net/protocol.js` — exports `encodeInput`, `decodeInput`,
  `encodeGarbage`, etc. JSON for now; the function shape is fixed so
  a future binary swap is trivial.
- `net/protocol.test.js` — every encoder/decoder round-trips through
  `JSON.parse(JSON.stringify(...))` without loss.

**Acceptance:** every message type in §2 has a tested encode/decode
pair; the module is browser + Node compatible (same import works
under both — needed for replay-validation Workers).

### Phase D — `RemoteOpponent` adapter (1 day)

**Goal:** drop-in replacement for `BotController` that reads
InputFrames from the wire instead of from a planning AI.

- `gameplay/remote-opponent.js` — implements the same surface
  (`getNextFrame()` + `tick(dtMs)` shim) but pulls from a remote
  input buffer (passed in at construction).
- `VersusSession` already supports `opponentMode: 'bot' | 'local'`.
  Add `'remote'` — wire it to a `RemoteOpponent` instance.

**Acceptance:** a unit test substitutes a fake remote input source
and runs a 60-tick versus session against it; both sims advance in
sync (asserted via `game.serialize()` hash equality on both sides
when given identical input streams).

### Phase E — Rollback engine (2 days)

**Goal:** the algorithm in §3.2, hooked into VersusSession.

- New `net/rollback.js` — owns the input log + snapshot ring +
  per-tick decision logic.
- VersusSession's tick loop calls into `rollback.tick(localInput)`
  instead of advancing both Games directly. The rollback engine
  decides whether to advance or to restore + replay.
- Tests use deterministic Games + a simulated wire with controllable
  latency + reordering. Three scenarios:
  1. Zero loss / zero latency — rollback never fires; sims stay in
     sync.
  2. Constant 100ms latency — rollback predicts EMPTY_FRAME, then
     reconciles every ~6 frames; per-frame perceptible work stays
     under budget.
  3. 5% packet loss + 200ms peak latency — rollback survives. Final
     state matches a no-loss reference run on the same input
     sequence.

**Acceptance:** all three scenarios green; the rollback path adds
< 0.5ms per tick on average for the latency-100ms case.

### Phase F — WebSocket transport (2 days) [parallel-ok with E]

**Goal:** real network bytes flowing between two clients via a
relay server.

- `net/transport-ws.js` — opens a WebSocket to the relay, ships
  encoded messages from `protocol.js`, dispatches incoming messages
  to a callback.
- A minimal Cloudflare Workers + Durable Objects server (one DO per
  match) — relays messages between the two connected clients.
  Doesn't validate match outcomes yet; that's Phase J.
- Manual test: two browser tabs, connect via a known match code, see
  each other's pieces move in (near-)real time.

**Acceptance:** end-to-end input loop measured at < 60ms RTT
local-to-local; the transport is swappable (a fake-transport
implementation drives the existing rollback tests).

### Phase G — Lobby + matchmaking (1.5 days)

**Goal:** UI + control-plane glue. No new gameplay logic.

- New mode entry: `'versus-online'` (or fold into existing
  `'versus'` via a sub-mode). Uses `VersusSession` with
  `opponentMode: 'remote'` + a transport-backed RemoteOpponent.
- Three lobby screens: friend invite (share a code), quickmatch
  queue (ELO-based), match-history viewer.
- Server-side: add `lobby_*` and `queue_*` DO handlers; persist ELO
  in D1; expose match history via REST.

**Acceptance:** two browsers can find each other via a shared code +
play a real Versus match. Quickmatch queue works between two
manually-queued players in different windows.

### Phase H — Replay validation server (1.5 days)

**Goal:** server-side proof that a reported outcome is consistent
with the inputs that produced it.

- A Cloudflare Workers cron that wakes up every 5 minutes, pulls any
  unvalidated matches from D1, re-runs each via the `gameplay/`
  package + the Phase B replayer, asserts the reported outcome.
- Failed validations get logged + flagged; the affected ELO updates
  are rolled back.

**Acceptance:** a known-good match validates green; a manually-
tampered match (modified score in the report) flags red.

### Phase I — Anti-cheat & soft launch (1 day)

**Goal:** observe + tune in the wild.

- Anomaly detection: flag accounts whose validation-failure rate is
  unusually high (> 1% over rolling 100 matches).
- Telemetry dashboard: ELO distribution, match outcome distribution,
  region-RTT histogram. Stored in D1 + queried via a small admin
  page.
- Soft-launch invite: 10 trusted testers, 1 week, daily check-ins.

**Acceptance:** the dashboard exists and updates; one week of soft-
launch data shows < 0.5% false-positive validation flags + > 95%
match-completion rate.

### Phase J — Hardening + polish (1 day)

**Goal:** address what soft-launch surfaced.

Reserved time. The exact contents come from Phase I observations —
likely candidates: better disconnect-handling, opponent-disconnect
forfeit timing, region-locked queues if cross-region pairs are
miserable, garbage-queue visualization tweaks.

---

## 6. Total effort

| Phase | Effort | Cumulative |
|---|---|---|
| A — Determinism lockdown | 0.5 | 0.5 |
| B — Input recorder + replay | 0.5 | 1.0 |
| C — Wire protocol module | 1.0 | 2.0 |
| D — RemoteOpponent adapter | 1.0 | 3.0 |
| E — Rollback engine | 2.0 | 5.0 |
| F — WebSocket transport (parallel-ok) | 2.0 | 7.0 |
| G — Lobby + matchmaking | 1.5 | 8.5 |
| H — Replay validation server | 1.5 | 10.0 |
| I — Anti-cheat + soft launch | 1.0 | 11.0 |
| J — Hardening + polish | 1.0 | 12.0 |

**~12 calendar-days** for one focused contributor, parallelizable
across two contributors after Phase D (one on E rollback, one on F
transport, joining at Phase G). The 4-day savings vs the v1 §7.10
estimate come from determinism + serialize/restore + VersusSession +
modern-rules events all having shipped in §3.7 / §12 / §1.2.

---

## 7. Risks (refreshed from v1 §7.11)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Determinism leak in `gameplay/` post-Phase-A | Low (audit + ESLint) | High (online silently desyncs) | Phase A's ESLint rule; the per-tick determinism test; the snapshot-hash exchange in §2.2 detects any leak in production. |
| Rollback resimulation budget blows on slow client (low-end mobile) | Medium | Medium | Snapshot cadence is tunable per-client based on observed reconciliation cost; if reconciliation > 8ms, drop to lockstep with a "high-latency" warning. |
| WebSocket relay capacity at scale | Low (hobby scale assumed) | Medium | Cloudflare DOs scale linearly; if bytes-per-match grow, switch to per-message-deflate compression first, P2P WebRTC second. |
| Cross-region pairing miserable (Asia ↔ EU = 250ms RTT) | Medium | Medium | Region-locked queues by default; cross-region opt-in with explicit warning. Phase I tunes the cutoff after observing real RTTs. |
| Replay-validation false-positive on legitimate edge case | Low (deterministic sim) | Medium | Validation differences trigger an investigation, NOT an automatic ELO claw-back. Manual review for the first 100 flagged matches. |
| 3D / Force-Physics modes don't have online support — players expect cross-mode online | Low | Low | Online is **2D modes only** at launch (Classic / Marathon / Sprint / Ultra / Versus). Both 3D and Force-Physics break determinism (3D fine in principle but rules are 2D-only by design; Force-Physics fundamentally non-deterministic). Document this in the mode picker. |
| 3D-mode `Game.serialize` v=2 blob shape rolling over a v=1 client | Low (no v=1 clients in the wild yet) | Low | The version field on every blob makes mismatched-client matching detectable + rejectable at lobby creation time. |
| Hosting cost surprise on Cloudflare free tier | Low (well within limits at hobby scale) | Low | Move to paid tier ($5/month minimum) before approaching free-tier ceilings. Telemetry from Phase I shows when. |
| Cheating attempts beyond the threat model (modified client) | Low (hobby) | Low | Replay validation handles 99%; client-side anti-cheat is explicitly out of scope per v1 §7.8. |

---

## 8. Acceptance for chapter completion

`§2.2 Online Versus` is **shipped** when:

- [ ] Phases A through I are committed and on `main` (J is open as
      ongoing polish).
- [ ] Two players in different cities can complete a Versus match
      end-to-end with no disconnect.
- [ ] The replay-validation cron has run for ≥ 1 week with < 1%
      false-positive rate.
- [ ] ELO updates are persistent and observable in the match-history
      view.
- [ ] The mode picker shows "Online Versus" gated behind sign-in
      with the correct experimental tag.
- [ ] `plan_gameplay_2.md` §0.1 + §4.1 are updated with the landing
      commits.
- [ ] Test surface remains > 95% green; the determinism test from
      Phase A never regresses.

---

## 9. What this plan deliberately does NOT cover

- **3D online versus.** Out of scope for the chapter. Determinism
  is fine but rules-pack wiring (1v1 garbage in 3D — what does a
  2D-style "row of garbage" look like in 3D?) is its own design
  problem.
- **Force-Physics online.** Fundamentally non-deterministic
  (collision-induced angular impulses depend on solver state).
  Would need server-authoritative simulation, which contradicts
  Pillar C.
- **Spectator mode / streaming.** Reserved for a follow-up; the
  data shape (replay blobs) supports it trivially but the UI is its
  own design pass.
- **2v2 / FFA / tournaments.** Same — the protocol generalizes but
  the lobby + matchmaking + display chrome multiply. Ship 1v1 first.
- **Mobile / touch input.** Online assumes desktop keyboard for
  Phase J. Touch is a separate ergonomics chapter.

---

## 10. Final word

Online Versus is the chapter that pays back every architectural
investment from §3.7 onward. The seeded RNG, `Game.serialize`, the
per-instance bus, the modern-rules events, the garbage queue with
cancellation + spawn-delay — none of those existed for online's
sake originally; they all paid off independently. Online is the
culmination, not a separate project: the moment two players in two
browsers run the same `Game` against the same seed + inputs and
arrive at the same `serialize()` blob, every previous chapter's
investment compounds.

Spread the work. Don't sprint it. Twelve calendar days across four
weeks beats four 12-hour days followed by a month of debugging
desync edge cases.
