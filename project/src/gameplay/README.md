# `gameplay/` — Pure Simulation Core

The brain. Has no idea the renderer exists.

## The boundary rule

> `gameplay/` must run under Node with no DOM, no `THREE`, no `AudioContext`.

If `import { Game } from './game.js'` ever fails outside the browser, isolation is broken.

## Public surface

```js
class Game {
  constructor(opts);                    // { seed, rules? }
  tick(dtMs, input);                    // advance simulation
  snapshot();                           // -> Readonly<BoardSnapshot>
  events;                               // -> EventStream<GameplayEvent>
  serialize();                          // -> save blob (replay support)
  restore(blob);                        // load save blob
}
```

That is the entire surface. No setters, no callbacks, no globals. Colors are hex `0xRRGGBB`, not `THREE.Color`.

## Planned files

- `game.js` — the public `Game` class.
- `board.js` — grid state, line-clear detection.
- `piece.js` — tetromino definitions.
- `rotation.js` — kick tables (SRS or whichever ruleset).
- `scoring.js` — score, level, lines, gravity curve.
- `rules.js` — config: lock delay, ARE, line-clear delay.
- `events.js` — gameplay event type constants.

## Today

The simulation lives interleaved with rendering at [`../../tetris.html`](../../tetris.html) lines 1472–2306. Step 2 of the migration plan extracts it here.
