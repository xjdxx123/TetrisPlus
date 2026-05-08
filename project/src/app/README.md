# `app/` — Composition Root

This is the only place where subsystems are wired together. Every other folder is leaf-pure with respect to its peers; the `app/` folder bolts them onto the same event bus and clock.

## Planned files

- `main.js` — entry point. Today it contains the entire game (extracted from the inline `<script>` in `tetris.html`). Subsequent PRs carve subsystems out of this file.
- `fsm.js` — app-level state machine: `Boot → MainMenu → Playing → Paused → GameOver`.
- `wiring.js` — event-bus subscriptions. `gameplay → director → vfx`, `audio → reactive → vfx`, etc.

## What goes here vs. elsewhere

- **In `app/`:** glue, orchestration, top-level lifecycle.
- **NOT in `app/`:** any actual gameplay rule, render pass, particle emitter, or shader. Those live in the subsystems.

If `app/` starts holding logic instead of wiring, we are reintroducing the god object.
