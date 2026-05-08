# `engine/` — Game-Agnostic Primitives

Framework code that knows nothing about Tetris. If we forked this project to make a different game, `engine/` would come along unchanged.

## Submodules

- [`time/`](./time/) — single `requestAnimationFrame` driver, fixed-timestep tick, render tick, slow-mo time scaling. Replaces today's tangled inline `animate()` loop in [`../../tetris.html`](../../tetris.html) (lines 3090–3336).
- [`events/`](./events/) — typed pub/sub bus, replay buffer for late subscribers, debug recorder.
- [`assets/`](./assets/) — texture/audio/shader loader, manifest, cache.
- [`random/`](./random/) — seeded RNG. Used by gameplay so the simulation is deterministic.

## Imports

Engine modules may import from `shared/` only. Any import of `three`, DOM, React, or another subsystem here is a layering violation.
