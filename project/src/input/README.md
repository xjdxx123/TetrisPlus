# `input/` — Input Capture & Intent Mapping

Captures raw device events and turns them into game-agnostic intents. `gameplay/` consumes intents, never key codes.

## Planned files

- `keyboard.js` — `keydown` / `keyup` capture, configurable bindings.
- `gamepad.js` — `Gamepad API` polling.
- `das-arr.js` — Delayed Auto-Shift / Auto-Repeat Rate shaping for hold-to-move.
- `intents.js` — `InputFrame` type passed into `Game.tick`.

## Intents

```
MOVE_LEFT, MOVE_RIGHT, SOFT_DROP, HARD_DROP,
ROTATE_CW, ROTATE_CCW, HOLD, PAUSE
```

The keyboard module does not know what `HARD_DROP` *does* — that's `gameplay/`'s problem.

## Today

Inline at [`../../tetris.html`](../../tetris.html) lines 2790–2927 (`keydown` handlers driving game state directly).
