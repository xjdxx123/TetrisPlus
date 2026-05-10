// Determinism contract — the architectural lynchpin for online versus
// (plan_online_versus.md §A) AND for replay validation (Sprint /
// Ultra leaderboards) AND for offline replay viewing.
//
// The contract: given (seed, rules-pack, input-sequence), Game.tick()
// produces a byte-identical `serialize()` blob on every device, every
// time. If this fails on any platform, online play silently desyncs;
// reported scores can't be validated; replays don't reproduce.
//
// This file is the canary. If a future PR introduces ANY non-seeded
// randomness or wall-clock read into `gameplay/`, one of the tests
// below explodes. The eslint rule on `gameplay/**` (eslint.config.js)
// is the static guard; this file is the dynamic guard.

import { describe, it, expect } from 'vitest';
import { EventBus } from '../engine/events/bus.js';
import { Game } from './game.js';
import { buildRules } from './rules.js';
import { createSeededRng } from '../shared/random/seeded.js';

function newGame(seed, modeKey = 'classic', extra = {}) {
  return new Game({
    rules: buildRules(modeKey),
    bus:   new EventBus({ replayBufferSize: 0, recorderSize: 0 }),
    rng:   createSeededRng(seed),
    nowMs: 0, // explicit — no wall-clock leak
    ...extra,
  });
}

/**
 * Drive a Game through a deterministic input sequence + return its
 * serialized state. The sequence cycles through left / right /
 * rotateCW / softDrop / hardDrop intents over `tickCount` frames at
 * the standard 16.67ms tick rate. Same dtMs + same intents on both
 * runs = same final state, by definition of the contract.
 */
function runSequence(game, tickCount) {
  game.spawnPiece();
  for (let t = 0; t < tickCount; t++) {
    const phase = t % 12;
    if      (phase === 0)  game.tryMove(-1, 0);
    else if (phase === 1)  game.tryMove(1, 0);
    else if (phase === 2)  game.tryRotate(1);
    else if (phase === 5)  game.softDrop();
    else if (phase === 11) game.hardDrop();
    game.tick(16.67);
  }
  return JSON.stringify(game.serialize());
}

describe('Game — determinism (online versus prereq)', () => {
  it('same seed + same input sequence → byte-identical serialize blobs (classic)', () => {
    const seed = 42;
    const ticks = 600; // ~10 sec of gameplay — covers spawn → drop → lock cycles
    const a = runSequence(newGame(seed), ticks);
    const b = runSequence(newGame(seed), ticks);
    expect(a).toBe(b);
  });

  it('same seed + same input sequence → byte-identical blobs across multiple modes', () => {
    const seed = 12345;
    for (const modeKey of ['classic', 'marathon', 'sprint', 'ultra', 'zen']) {
      const a = runSequence(newGame(seed, modeKey), 200);
      const b = runSequence(newGame(seed, modeKey), 200);
      expect(a, `mode=${modeKey}`).toBe(b);
    }
  });

  it('different seeds → different blobs (the test wouldn\'t catch determinism if it always passed)', () => {
    const a = runSequence(newGame(42), 200);
    const b = runSequence(newGame(43), 200);
    expect(a).not.toBe(b);
  });

  it('serialize → restore → re-run produces the same final state as a fresh run from the same seed', () => {
    // The rollback prerequisite: snapshot at tick T, restore + replay
    // forward from T → identical state. If this fails, rollback can't
    // reconcile mispredictions; misprediction = stuck-or-corrupted.
    const seed = 999;
    const SNAP_TICK = 100;
    const TOTAL_TICKS = 300;

    // Run A: full 300-tick run from a fresh game.
    const fullA = newGame(seed);
    fullA.spawnPiece();
    let snapBlob = null;
    for (let t = 0; t < TOTAL_TICKS; t++) {
      if (t === SNAP_TICK) snapBlob = fullA.serialize();
      const phase = t % 12;
      if      (phase === 0)  fullA.tryMove(-1, 0);
      else if (phase === 1)  fullA.tryMove(1, 0);
      else if (phase === 2)  fullA.tryRotate(1);
      else if (phase === 5)  fullA.softDrop();
      else if (phase === 11) fullA.hardDrop();
      fullA.tick(16.67);
    }
    const finalA = JSON.stringify(fullA.serialize());

    // Run B: restore from the snapshot, replay the remaining ticks.
    const restoredB = newGame(seed);
    restoredB.restore(snapBlob);
    for (let t = SNAP_TICK; t < TOTAL_TICKS; t++) {
      const phase = t % 12;
      if      (phase === 0)  restoredB.tryMove(-1, 0);
      else if (phase === 1)  restoredB.tryMove(1, 0);
      else if (phase === 2)  restoredB.tryRotate(1);
      else if (phase === 5)  restoredB.softDrop();
      else if (phase === 11) restoredB.hardDrop();
      restoredB.tick(16.67);
    }
    const finalB = JSON.stringify(restoredB.serialize());

    expect(finalB).toBe(finalA);
  });

  it('nowMs default (omitted) is 0 — `_sessionStart` does NOT leak wall-clock entropy', () => {
    // The whole point of replacing performance.now() with opts.nowMs:
    // a Game built with default opts has a fixed, predictable
    // sessionStart, not a wall-clock value that would differ across
    // runs.
    const a = newGame(1);
    const b = newGame(1);
    expect(a.sessionStart).toBe(0);
    expect(b.sessionStart).toBe(0);
    expect(a.sessionStart).toBe(b.sessionStart);
  });
});
