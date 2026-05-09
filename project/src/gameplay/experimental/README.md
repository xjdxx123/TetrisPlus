# gameplay/experimental/

Speculative gameplay modes that live behind the **30-day promote-or-delete**
policy from `plan_particle_2.md` §10. Modes here:

- ship as their own subdirectory under this root (`./physics/`,
  `./3d/`, etc.)
- are pure-JS just like the rest of `gameplay/` — no THREE, no DOM,
  no AudioContext (per the `plan_architecture.md` §4 rule)
- register their rules pack in `gameplay/rules.js#BUILDERS` so the
  rules engine can build them via `buildRules(modeKey)`
- are gated by feature visibility (Mode tab UI), not by the rules
  engine — the engine itself is permissive about which keys are
  buildable

## Active experiments

### `./physics/` — Pure Physics (plan v2 §2.3)

Each cube is a rigid body. "Line clear" is replaced by a connected-
component layer-detection pass. Phase A (this directory) ships:

- `rules.js` — pack with `key: 'physics'`, flat per-layer scoring,
  `physicsHighestY`-aware topout. Pure JS; no Rapier dependency.
- `layer-detection.js` — pure connected-component algorithm operating
  on cube position arrays. Detects "slabs" of ≥10 face-touching cubes
  whose Y centers fall within a 0.8 tolerance band. Produces "good
  emergent" slightly-tilted clears per archived spec §8.5.

Phases B–F (Rapier integration, body lifecycle, mode HUD, VFX)
land in follow-up sessions on top of this foundation.

## Promotion policy

A mode in this directory is reviewed at the 30-day mark from its
first commit:
- **Playtest delights** → promote: move out of `experimental/`, gain
  its own polish budget, settle into the standard mode roster.
- **Doesn't land** → delete without ceremony: remove the directory,
  unregister from `BUILDERS`, leave a one-line note in
  `document/plan_gameplay_2.md` recording the experiment.

The pure-JS-only rule applies even at the experimental tier — if a
mode genuinely needs THREE / DOM / wasm, that lives in the host
(`app/`) or its own dedicated subsystem (`physics/world.js` for
Rapier, etc.) and is wired through the rules pack via the `Rules`
contract. The experimental rules pack itself stays testable in
pure Node.
