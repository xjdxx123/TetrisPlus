// applyFrameToGame — the single canonical "how does an InputFrame
// become Game state changes for one tick?" function. Extracted from
// `app/versus.js#_dispatchSide` so the same dispatch path is shared
// between:
//
//   - VersusSession (live local versus + bot)
//   - replay/player.js (offline replay reconstruction)
//   - online versus's RemoteOpponent + rollback engine (Phase D / E)
//
// Having ONE function means the live path and the replay path can't
// drift — a bug fix to dispatch order automatically applies to
// everything that re-runs the same input sequence. Determinism
// (plan_online_versus.md §A) requires this single source of truth.
//
// Pure module: no THREE, no DOM, no audio. Operates on Game's public
// API only.

/**
 * @typedef {import('../../input/intents.js').InputFrame} InputFrame
 * @typedef {import('../game.js').Game} Game
 */

/**
 * Apply one tick's `InputFrame` to a Game. Mirrors the legacy
 * VersusSession._dispatchSide ordering: discrete intents (rotate /
 * hold / hard-drop / pause) fire FIRST so they can reposition the
 * piece before gravity acts; held movement comes next; finally
 * `game.tick(dtMs, {softDrop})` advances time.
 *
 * @param {Game} game
 * @param {InputFrame} frame
 * @param {number} dtMs    Tick duration in ms (typically 1000/60 ≈ 16.67).
 */
export function applyFrameToGame(game, frame, dtMs) {
  if (!game || !frame) return;
  if (game.gameOver || game.paused) return;

  // Discrete intents — fire BEFORE held movement / gravity so a
  // rotate-into-position-then-fall sequence resolves the rotation
  // first.
  if (frame.rotateCW)  game.tryRotate(1);
  if (frame.rotateCCW) game.tryRotate(-1);
  if (frame.hold)      game.holdActive();

  // Held movement — single-step per frame; the host's DAS layer is
  // responsible for re-emitting `left`/`right` on each tick if the
  // key stays down. Online's wire feed delivers held=true frames at
  // ~16ms cadence under DAS, matching the local path.
  if (frame.left)      game.tryMove(-1, 0);
  if (frame.right)     game.tryMove(1, 0);

  if (frame.hardDrop) {
    const result = game.hardDrop();
    if (result) game.lockPiece();
  }
  if (frame.pause) game.setPaused(!game.paused);

  // Soft-drop is a per-tick gravity multiplier consumed by Game.tick;
  // it doesn't have a discrete event of its own.
  game.tick(dtMs, { softDrop: !!frame.softDrop });
}
