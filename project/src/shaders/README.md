# `shaders/` — Raw GLSL

Leaf folder. Contains only `*.vert.glsl` and `*.frag.glsl` source. No JavaScript here.

## Planned extractions (from inline strings in `../../tetris.html`)

| File | Currently inline at |
|---|---|
| `glass.vert.glsl` / `glass.frag.glsl` | lines 1248–1274 (FRESNEL_VERT / FRESNEL_FRAG) and 1241–1318 (case glass) |
| `vignette.frag.glsl` | inside the `VignetteShader` ShaderPass definition |
| `sparkle.vert.glsl` / `sparkle.frag.glsl` | lines 811–1104 |
| `shard.vert.glsl` / `shard.frag.glsl` | lines 1919–2166 |
| `ambient.frag.glsl` | lines 621–810 |

Loaded via Vite `?raw` imports — `import glassFrag from '../shaders/glass.frag.glsl?raw';`. Hot-reload supported in dev.
