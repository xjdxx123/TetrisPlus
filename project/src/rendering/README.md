# `rendering/` — Frame Graph & Pipeline

Owns the *act of drawing*. Does not own *what* is drawn — subsystems submit meshes to layer scenes.

## Layered frame graph

```
1. Geometry pass     (opaque: glass case, board)
2. Effects pass      (additive: sparkles, shards, ambient field)
3. Transparent pass  (sorted back-to-front: glass cubes, veil)
4. Post-processing   (bloom → vignette → SMAA → output)
5. CSS3D pass        (HUD anchored in 3D)
6. UI overlay        (DOM HUD)
7. Debug pass        (gizmos, on-toggle only)
```

Each layer has its own `Scene` root. Subsystems only register meshes into their own layer; reordering becomes a config change.

## Planned files

- `pipeline.js` — frame graph, layer composer, `renderFrame(camera)` entry point.
- `context.js` — `RenderContext` type passed to layers (camera, viewport, time, frame).
- [`layers/`](./layers/) — `world-layer.js`, `fx-layer.js`, `transparent-layer.js`, `hud3d-layer.js`.
- [`post/`](./post/) — `composer.js`, `bloom.js`, `vignette.js`, `smaa.js`.
- `debug-pass.js` — toggle-only.

## Imports

May import `three`, `engine/`, `shared/`. **May not import `gameplay/`** — the renderer never reads game state directly.
