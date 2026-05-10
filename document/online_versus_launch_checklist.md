# Online Versus — Soft-Launch Readiness Checklist

**Status:** living document, updated as Phase J landings tick boxes.
**Predecessor:** `document/plan_online_versus.md` (the implementation
plan); this file is the operational runbook for actually shipping
the chapter to real players.

---

## What "soft-launch" means here

Per `plan_online_versus.md` §5 Phase I:

> Soft-launch invite: 10 trusted testers, 1 week, daily check-ins.

We're NOT shooting for public launch. The goal is a controlled
exposure with tight feedback so anything that breaks under real
network conditions surfaces while the surface area is small enough
to debug.

**Ship gate**: every box below ticked + `plan_online_versus.md` §8
acceptance criteria all green.

---

## Code readiness (Phases A–H verifiable from the repo)

- [x] **Determinism contract enforceable** — ESLint rule blocks
      `Math.random` / `performance.now` / `Date.now` /
      `setTimeout` / `setInterval` from `gameplay/`. (Phase A,
      `b36ce67`)
- [x] **Determinism dynamic test** — same seed + same input
      sequence produces byte-identical `Game.serialize()`. Runs in
      CI on every PR. (Phase A)
- [x] **Replay subsystem** — `gameplay/replay/` records sparse
      input tapes + replays them against a fresh Game; rollback's
      "snapshot + replay forward" prerequisite test passes.
      (Phase B, `9dc2dd9`)
- [x] **Wire protocol** — `net/protocol.js` encode + decode for
      every message type, with field validation at boundary.
      (Phase C, `b8531e2`)
- [x] **RemoteOpponent adapter** — VersusSession `opponentMode:
      'remote'` works with a fake transport. (Phase D, `1c45929`)
- [x] **Rollback engine** — survives the three plan-§3.2 scenarios
      (zero-loss / 100ms-constant / 5%-loss + jitter); state
      reconciles to the no-loss reference in all three. (Phase E,
      `674a1e3`)
- [x] **WebSocket transport + relay DO** — client transport-ws.js
      + server/relay/match-relay.js + worker.js. (Phase F,
      `c8181e8`)
- [x] **Tier 2 identity** — UUID in localStorage; default display
      name; edit + clear flows. (Phase G, `92117cc`)
- [x] **ELO + matchmaking** — K=32 + ±64 cap; ELO-distance pair
      with wait-expansion + region-strict + priority-FIFO.
      (Phase G)
- [x] **Replay validation** — `validateMatch` re-simulates both
      sides + asserts winner. (Phase H, `274629c`)
- [x] **Validation cron** — Workers scheduled handler pulls
      unvalidated matches from D1 + commits result. (Phase H)
- [x] **Anomaly detection** — `checkPlayerHealth` flags accounts
      with > 1% validation-failure rate over 100 matches.
      (Phase I)
- [x] **Host UI integration** — Versus mode picker has an "Online"
      sub-mode; lobby panel reads identity from `net/identity.js`
      and constructs VersusSession with `opponentMode: 'remote'` +
      a WebSocketTransport pointed at the relay endpoint. Lobby UX
      polished in Track 2 (`338695e`): URL pre-fill (`?lobby=XXX`),
      Copy Invite Link button, display-name edit via prompt()
      persisted through `setDisplayName`. Matchmaking-queue UI
      (server-side ELO pair) NOT yet wired — friend-code lobby is
      the only path; queue UI is a future polish item.
- [x] **Disconnect grace window** — Mid-match WS close triggers
      `_handleTransportClose` which shows the `#onlineDisconnect`
      overlay with a 30s countdown. On expiry (or "Forfeit Now"
      click), host fires `gameP2.forceTopOut('disconnect_forfeit',
      'opponent')` — routes through VersusSession's standard
      side-end → endRun(winner='player') flow. Reconnect-resume
      (re-establishing WS + re-syncing rollback) is deferred —
      current implementation is "wait, then forfeit-win" only.
      (Track 2, `338695e`)
- [x] **Replay download** — `_startOnlineMatch` constructs an
      `InputRecorder` pinned to the local seed + 'versus' + 60Hz;
      each rollback tick records `(recordedTick, tickFrame)`. The
      gameOver overlay's "Download Replay" button serializes the
      tape and triggers a `match-${lobbyCode}-${seed}.json` download
      via Blob + URL.createObjectURL. Format matches the wire
      protocol + validation server's expected shape. (Track 2,
      `338695e`)

---

## Operational readiness

### Server deployment

- [ ] **`server/relay`** deployed to Cloudflare Workers via
      `wrangler deploy` against the production account.
      `wrangler.example.toml` copied + edited; D1 + DO bindings
      filled in.
- [ ] **`server/validation/validation-cron.js`** deployed as a
      separate Worker with a `[triggers.crons]` entry every 5
      minutes.
- [ ] **D1 schema migration** applied — `matches` table with
      `match_id, seed, mode_key, p1_*, p2_*, reported_winner,
      validated, reject_reason`; `players` table with `user_id,
      elo, delta_pending, region`.
- [ ] **R2 bucket** created for replay blobs (eventual — current
      MVP stores tape JSON inline in D1).
- [ ] **Health check** — `GET /health` on each Worker returns
      200 + a tiny JSON `{ ok: true, version: ... }`.

### Telemetry

- [ ] **Per-match metrics emitted** to a Cloudflare Analytics
      Engine binding: matchId, seed, durationMs, validated bool,
      RTT ms (rolling avg from snapshot exchange), rollback count,
      desync count.
- [ ] **Player profile endpoint** (`GET /api/profile/:userId`)
      returns ELO, last-N validation rate, region. Used by the
      admin dashboard + the in-app "Playing as: X" row.
- [ ] **Admin dashboard skeleton** — small Worker page reading
      from the analytics binding + D1, gated behind a hard-coded
      env-var allow list of admin UUIDs.

### Rollout plan

- [ ] **Closed alpha** — author + 1 trusted tester. Run 50 matches
      across 1 week. Acceptance: zero hard desyncs (a desync that
      a `desync` blob upload couldn't explain), every match
      validates green.
- [ ] **Soft launch** — invite 10 testers via friend-code, 1 week,
      daily standup or written check-in. Acceptance: < 1%
      validation-failure rate, > 95% match-completion rate, no
      reports of "the opponent's pieces flicker".
- [ ] **Public launch** — gated behind a settings-panel "Online
      mode (beta)" toggle for the next 30 days. The 30-day
      promote-or-delete policy from `plan_particle_2.md` §10
      applies.

---

## Threat model — known acceptable, known to NOT do

- ✅ Replay validation handles speed-hacks, score-hacks, modified-
      bag attacks. The cron rejects + claws back ELO.
- ✅ Per-match ELO cap (`ELO_PER_MATCH_CAP = 64`) prevents a
      streak-of-cheats from blasting a player's rating before
      anomaly detection kicks in.
- ❌ NOT shipping client-side anti-cheat (DOM/JS introspection).
      Plan §7.8 explicitly out of scope.
- ❌ NOT defending against state actors / coordinated multi-account
      smurfing at hobby scale. If we hit > 1k DAU we'll add phone-
      verify gating per `plan_online_versus.md` §7 risks.

---

## Disaster checklist

| Symptom observed in the wild | First thing to check |
|---|---|
| Many simultaneous "match not initialized" errors | Workers DO binding may have rolled back; redeploy. |
| Validation cron flagging > 5% of matches | Likely a determinism leak introduced in a recent gameplay/ PR. Run `gameplay/determinism.test.js` against the suspect commit. |
| Players report "I see my opponent's pieces flicker constantly" | Network conditions exceed the 200ms reconciliation budget. Add a "high latency" warning on RTT > 200ms (already designed in plan §3.4 — wire it). |
| ELO inflation across the board | Anomaly threshold may be too loose. Tighten `failureRateFlag` from 0.01 → 0.005. |
| Anomaly false-positives flagging legit players | Run the validation against the flagged matches manually; if validateMatch agrees with the cron, the player IS cheating. If it disagrees → determinism bug. |
