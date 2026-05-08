# `world/` — World View

Reactive views over `gameplay/` snapshots. Given a `BoardSnapshot`, produce/update meshes — never the other way around.

## Planned files

- `board-view.js` — reconciles `Game.snapshot().board` with cell meshes (`cellMeshes[]` today at [`../../tetris.html`](../../tetris.html) lines 1472–1759).
- `piece-view.js` — active piece visualization.
- `ghost-view.js` — drop-target ghost.
- `glass-case.js` — walls, frame edges, back grid, inner floor (today at [`../../tetris.html`](../../tetris.html) lines 1319–1471).
- `environment.js` — lighting and ambient setup (today at [`../../tetris.html`](../../tetris.html) lines 580–620).

## Rule

The world is a *cache* over gameplay state, not the source. If `Game` reset to a different snapshot, `BoardView.sync(snapshot)` should fully reconcile without retained side state.
