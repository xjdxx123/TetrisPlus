// Tests for the bot controller (plan_gameplay_1.md §3.7 sub-phase 7d).

import { describe, it, expect } from 'vitest';
import { BotController } from './bot-controller.js';
import { Game } from './game.js';
import { buildRules } from './rules.js';
import { EventBus } from '../engine/events/bus.js';

/** Deterministic PRNG so plan choices are reproducible across runs. */
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildGame(seed = 1) {
  const bus = new EventBus({ replayBufferSize: 0, recorderSize: 0 });
  const rules = buildRules('classic');
  return new Game({ rules, bus, rng: seededRng(seed) });
}

describe('BotController — construction', () => {
  it('throws without a game', () => {
    expect(() => new BotController({})).toThrow(/game/);
  });

  it('rejects unknown strengths', () => {
    expect(() => new BotController({ game: buildGame(), strength: 'wizard' })).toThrow(/strength/);
  });

  it('defaults to casual', () => {
    const bot = new BotController({ game: buildGame() });
    expect(bot.strength).toBe('casual');
  });
});

describe('BotController — plan + execute (casual)', () => {
  it('returns an empty frame when there is no active piece', () => {
    const game = buildGame();
    const bot = new BotController({ game, rng: seededRng(42) });
    const f = bot.tick(100);
    expect(f.left || f.right || f.hardDrop).toBe(false);
  });

  it('plans on first tick after a piece spawns', () => {
    const game = buildGame();
    game.spawnPiece('T');
    const bot = new BotController({ game, rng: seededRng(42), actionsPerSecond: 1000 });
    bot.tick(1000); // well past the action interval
    expect(bot.plan).not.toBeNull();
    expect(typeof bot.plan.col).toBe('number');
    expect(typeof bot.plan.rot).toBe('number');
  });

  it('rate-limits actions by actionsPerSecond', () => {
    const game = buildGame();
    game.spawnPiece('T');
    const bot = new BotController({ game, rng: seededRng(42), actionsPerSecond: 5 });
    // 5 aps = 200 ms interval. A 50ms tick should not produce action yet.
    const f1 = bot.tick(50);
    expect(f1.left || f1.right || f1.rotateCW || f1.hardDrop).toBe(false);
    const f2 = bot.tick(200);
    // After accumulating ≥200ms, an action fires.
    expect(f2.left || f2.right || f2.rotateCW || f2.hardDrop).toBe(true);
  });

  it('issues exactly one intent per action frame', () => {
    const game = buildGame();
    game.spawnPiece('T');
    const bot = new BotController({ game, rng: seededRng(42), actionsPerSecond: 1000 });
    const f = bot.tick(1000);
    const count = [
      f.left, f.right, f.rotateCW, f.rotateCCW, f.hardDrop, f.hold,
    ].filter(Boolean).length;
    // Could be zero (already in position with rot 0 — possible if seed
    // happens to produce col=3, rot=0). But never more than one.
    expect(count).toBeLessThanOrEqual(1);
  });

  it('eventually fires hardDrop after enough action frames', () => {
    // Realistic loop — apply each frame's intents to the Game so the
    // active piece converges on the planned column. Without this, the
    // bot would keep saying "move right" forever because the piece
    // doesn't actually move.
    const game = buildGame();
    game.spawnPiece('T');
    const bot = new BotController({ game, rng: seededRng(7), actionsPerSecond: 1000 });
    let dropped = false;
    for (let i = 0; i < 50 && !dropped; i++) {
      const f = bot.tick(1000);
      if (f.left)      game.tryMove(-1, 0);
      if (f.right)     game.tryMove(1, 0);
      if (f.rotateCW)  game.tryRotate(1);
      if (f.rotateCCW) game.tryRotate(-1);
      if (f.hardDrop) dropped = true;
    }
    expect(dropped).toBe(true);
  });
});

describe('BotController — re-plans on piece change', () => {
  it('new spawn invalidates the prior plan', () => {
    const game = buildGame();
    game.spawnPiece('T');
    const bot = new BotController({ game, rng: seededRng(99), actionsPerSecond: 1000 });
    bot.tick(1000); // builds plan
    const planA = bot.plan;
    expect(planA).not.toBeNull();

    game.spawnPiece('I'); // forces a new active piece
    bot.tick(1000);
    expect(bot.plan).not.toBe(planA); // re-planned
  });
});

describe('BotController — mirror strength', () => {
  it('copies the reference game\'s active-piece position', () => {
    const ref = buildGame(1);
    ref.spawnPiece('T');
    ref.tryMove(2, 0); // ref piece is now at col 5

    const own = buildGame(2);
    own.spawnPiece('T');
    const bot = new BotController({ game: own, strength: 'mirror', mirrorOf: ref, actionsPerSecond: 1000 });
    bot.tick(1000);
    expect(bot.plan.col).toBe(ref.activePiece.col);
    expect(bot.plan.rot).toBe(ref.activePiece.rot);
  });

  it('falls back to a degenerate plan when reference has no piece', () => {
    const ref = buildGame(1); // never spawned
    const own = buildGame(2);
    own.spawnPiece('T');
    const bot = new BotController({ game: own, strength: 'mirror', mirrorOf: ref, rng: seededRng(5) });
    bot.tick(1000);
    expect(bot.plan).not.toBeNull();
  });
});

describe('BotController — reset', () => {
  it('clears plan + last-seen so the next tick re-plans', () => {
    const game = buildGame();
    game.spawnPiece('T');
    const bot = new BotController({ game, actionsPerSecond: 1000 });
    bot.tick(1000);
    expect(bot.plan).not.toBeNull();
    bot.reset();
    expect(bot.plan).toBeNull();
  });
});

describe('BotController — game over / pause gates', () => {
  it('returns empty frame when game over', () => {
    const game = buildGame();
    game.spawnPiece('T');
    game.forceTopOut('forfeit');
    const bot = new BotController({ game, actionsPerSecond: 1000 });
    const f = bot.tick(1000);
    expect(f.left || f.right || f.hardDrop || f.rotateCW).toBe(false);
  });

  it('returns empty frame when paused', () => {
    const game = buildGame();
    game.spawnPiece('T');
    game.setPaused(true);
    const bot = new BotController({ game, actionsPerSecond: 1000 });
    const f = bot.tick(1000);
    expect(f.left || f.right || f.hardDrop || f.rotateCW).toBe(false);
  });
});
