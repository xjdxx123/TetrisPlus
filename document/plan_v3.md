# Tetris+ Forward Roadmap v3

**Date:** 2026-05-11 · **Predecessor:** [`archived/plan_gameplay_2.md`](archived/plan_gameplay_2.md)

v2 shipped end-to-end:
- §1 polish work (Stats UI, VFX celebrations, garbage flash, B2B/combo
  chips) — all four items ✅
- §2.1 3D Tetris — all phases A–G ✅
- §2.2 Online Versus — all phases A–I ✅ (detailed plan archived at
  [`archived/plan_online_versus.md`](archived/plan_online_versus.md))
- §2.3 Pure Physics — phases A–F+ ✅ (F++ deferred, L pending playtest)

Since v2 closed, an unplanned chapter materialised: **scene-embedded
audio-reactive visualizer + live beat tracking + external tab capture +
event-driven flashes**. ~25 commits, none originally in v2 scope. The
visual feature is shipped (commit `63cf90f` is the latest); the system
architecture is documented as a reference in
[`audio_and_vfx.md`](audio_and_vfx.md); forward work tracked in its own
plan ([`plan_audio_interaction.md`](plan_audio_interaction.md)).

v3 captures only what's open. Three chapters:

1. **Pure Physics tail** — the two open items inherited from v2 §2.3.
2. **Audio interaction roadmap** — defers to the dedicated plan.
3. **Online Versus operational work** — defers to the launch checklist.

---

## 1. Pure Physics tail

Pure Physics shipped phases A–F+ in v2. Two items remain.

### 1.1 Phase F++ — per-collision dust (deferred)

**Status.** Open, deferred since v2.

**Scope.** Subscribe to Rapier's contact events; when two cubes
collide above an impulse threshold, spawn a small dust burst at the
contact point. Cosmetic polish, no gameplay impact.

**Why deferred.** Felt low-priority compared to the audio-reactive
chapter that ended up consuming the session. Rapier contact events are
straightforward but the emitter wiring (which `vfx/emitters/` instance
to use, how to bake world-space contact coords through the
`physics-board-view` layer) needs ~½ day of focused integration.

**Trigger to revisit.** A playtester points at the Pure Physics mode
and says "the collisions look limp." Until then, defer further.

**Effort.** ~½ day if started.

### 1.2 Phase L — playtest tuning

**Status.** Open.

**Scope.** Pure Physics is "shipped" but the gravity / restitution /
friction / spawn-spread numbers were last touched ~2 months ago and
haven't been retuned since the Force-Physics pivot (the K fold-in
mentioned in archived v2 §2.3). After enough real playtesting:

- Decide whether the default settings give the "satisfying tower
  collapse" feel the chapter promises.
- Decide whether the Layer-Clear threshold (currently 8 cubes / layer)
  reads right at typical play.
- Decide whether the per-cube colour palette should keep being inherited
  from the piece colour or shift to the recipe-driven §1.2 mood palette.

**Why open.** Tuning is playtest-driven; can't be done from spec alone.

**Effort.** ~½ day of dedicated play + tweak cycles.

---

## 2. Audio interaction

Tracked separately in [`plan_audio_interaction.md`](plan_audio_interaction.md).

That plan covers the audio chapter that grew unplanned from this
session and now has a clear roadmap of its own. **Short summary** for
the v3 reader:

- **Shipped this session**: spiral visualizer, FB → live tracker → spiral,
  external tab capture, game-event hooks, direct kick-envelope flash,
  Settings panel integration, debug overlay (FFT spectrum + Beat lab +
  onsets).
- **Medium-term (weeks)**: BPM accuracy via realtime-bpm-analyzer
  swap, per-BGM visual presets, secondary beat-driven effects
  (rotation, pre-beat hue), conditional HARD_DROP reaction.
- **Long-term (months)**: harmonic-reactive colour via Meyda chroma /
  MFCC, audio-source-aware Settings, multi-visualizer system, ML beat
  tracker exploration.

The architectural floor (FeatureBus as the single audio surface, the
`bindings.js` rule that no other module writes audio → visuals) is
**load-bearing** for everything in that plan — preserve it.

---

## 3. Online Versus operational

Tracked separately in
[`online_versus_launch_checklist.md`](online_versus_launch_checklist.md).

All code phases (A–I) of online versus shipped in v2. **What remains
is operational**:

- Server deployment (Cloudflare Workers + D1 + R2)
- Telemetry pipeline
- Rollout (closed alpha → soft launch → public)

The checklist itself is the authoritative tracker — v3 just notes the
chapter is in "code done, ops pending" state.

---

## 4. What v3 deliberately doesn't track

- **Audio architecture details** — see `audio_and_vfx.md`. Reference
  doc, not a plan. Update it when audio architecture changes.
- **Audio forward work** — see `plan_audio_interaction.md`. Has its
  own M/L/speculative breakdown.
- **Online versus rollout** — see the launch checklist. Has its own
  pre-deploy and post-deploy items.
- **Anything game-engine-deep** — the §3.7 game container, modern
  rules pack, mode framework all shipped in v1/v2 and aren't expected
  to need further work. If they do, that's a v4 trigger.

---

## 5. Final word

v3 is thin on purpose. The remaining work is:

| Chapter | Where it lives | Effort | Risk |
|---|---|---|---|
| Pure Physics F++ | this doc §1.1 | ½ day | Low — cosmetic |
| Pure Physics L | this doc §1.2 | ½ day | Low — tuning |
| Audio interaction | `plan_audio_interaction.md` | ~2-3 weeks (M) + open-ended (L) | Medium — depends on third-party library quality |
| Online ops | `online_versus_launch_checklist.md` | ~1 week of deploy + alpha | Medium — first prod traffic always reveals surprises |

If you're picking up the project cold, read in this order:
1. This file (v3) — what's open.
2. `audio_and_vfx.md` — how the current audio system works.
3. `plan_audio_interaction.md` — where audio is going.
4. `online_versus_launch_checklist.md` — what blocks online launch.

Archived predecessors:
- v1 → `archived/plan_gameplay_1.md`
- v2 → `archived/plan_gameplay_2.md`
- Online versus full plan → `archived/plan_online_versus.md`

---

*End of v3. Next plan is `plan_audio_interaction.md`.*
