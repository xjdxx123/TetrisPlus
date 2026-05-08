# `src/` — Source Tree

The TetrisPlus engine is divided into focused subsystems with one-way dependencies. See [`document/plan_architecture.md`](../../document/plan_architecture.md) for the architecture proposal this layout implements.

## Layout

| Folder | Owns | May import |
|---|---|---|
| [`app/`](./app/) | composition root, app-level FSM, event wiring | everything |
| [`engine/`](./engine/) | game-agnostic primitives: clock, event bus, asset loader, RNG | `shared/` only |
| [`gameplay/`](./gameplay/) | pure simulation — board, pieces, scoring, rules | `engine/`, `shared/` (NO `three`, NO DOM, NO React) |
| [`input/`](./input/) | keyboard/gamepad capture, intent mapping | DOM, `engine/`, `shared/` |
| [`rendering/`](./rendering/) | renderer, frame graph, layers, post-processing | `three`, `engine/`, `shared/` |
| [`world/`](./world/) | board view, glass case, environment meshes | `three`, `materials/`, `gameplay/` snapshots only |
| [`camera/`](./camera/) | camera rig, orbit controls, shake/punch composition | `three`, `engine/events`, `shared/` |
| [`materials/`](./materials/) | material factories — glass, cube core, sparkle, shard | `three`, `shaders/` (raw GLSL) |
| [`shaders/`](./shaders/) | raw `.glsl` files; leaf module | nothing |
| [`vfx/`](./vfx/) | director, emitters, presets, reactive bindings | `three`, `materials/`, `engine/events` |
| [`audio/`](./audio/) | playback (AudioContext, BGM) and reactive analysis (FFT, beats) | DOM Web Audio, `engine/`, `shared/` (NO `three`) |
| [`ui/`](./ui/) | React HUD, menus, tweaks panel | React, `gameplay/` snapshots (read-only), `engine/events` |
| [`config/`](./config/) | live tweaks, mood presets, persistence | `engine/`, `shared/` |
| [`shared/`](./shared/) | pure utilities: math, color, types | nothing |

## The Hard Rules

1. **`gameplay/` has no graphics.** No `three`, no DOM, no React imports.
2. **Events flow up, snapshots flow down.** Gameplay emits events; visual layers subscribe.
3. **One owner per piece of state.** Read everywhere through snapshots; mutate only through the owner's API.
4. **One clock, many subscribers.** No subsystem starts its own `requestAnimationFrame`.

These rules are enforced via ESLint `no-restricted-imports` (see [`../eslint.config.js`](../eslint.config.js)).

## Status

This tree is being populated incrementally per the migration plan in [`plan_architecture.md`](../../document/plan_architecture.md) §9. Each PR fills in one subsystem and removes its inline equivalent from [`../tetris.html`](../tetris.html). Many folders are currently empty placeholders — that is expected.
