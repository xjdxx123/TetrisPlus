# `materials/` — Material Factories

Configured `ShaderMaterial` / `MeshStandardMaterial` instances. Geometry lives elsewhere (`world/`, `vfx/emitters/`); meshing decisions live elsewhere; materials are pure factories.

## Planned files

- `glass.js` — fresnel refraction glass (today inline at [`../../tetris.html`](../../tetris.html) lines 1126–1318, with shaders at 1248–1274).
- `cube-core.js` — emissive core / settling glow.
- `shard.js` — shatter shard material.
- `sparkle.js` — line-clear sparkle material.
- `ambient.js` — drift-field billboard material.

## Imports

`three` and `shaders/` only. Each factory returns a configured material plus typed uniform getters/setters so callers don't poke `.uniforms.foo.value` directly.
