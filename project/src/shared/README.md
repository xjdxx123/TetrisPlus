# `shared/` — Pure Utilities

Leaf module. No imports outward. Anything that needs to be used from both `gameplay/` (no `three`) and visual subsystems (`three`-aware) lives here as plain math.

## Planned files

- `math.js` — clamp, lerp, smoothstep, easing curves.
- `color.js` — hex ↔ rgb conversions, color blending. Hex `0xRRGGBB` is the gameplay-side color type.
- `types.js` — shared type definitions (`InputFrame`, `BoardSnapshot`, `GameplayEvent`, etc.).
- `debug.js` — assertion helpers, dev-only logging.
