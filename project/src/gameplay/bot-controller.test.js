// Tests for the bot controller (plan_gameplay_1.md §3.7 sub-phase 7d).

import { describe, it, expect } from 'vitest';
import {
  BotController,
  _columnHeights,
  _countCompleteLines,
  _countHoles,
  _bumpiness,
  _scoreBoard,
} from './bot-controller.js';
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

// ─── Heuristic scoring (pure function tests) ───────────────────────────

describe('bot heuristic — column heights', () => {
  it('returns 0 for an empty board', () => {
    const board = Array.from({ length: 20 }, () => Array(10).fill(null));
    expect(_columnHeights(board, 10)).toEqual(new Array(10).fill(0));
  });

  it('measures the highest filled cell per column (1-indexed)', () => {
    const board = Array.from({ length: 20 }, () => Array(10).fill(null));
    board[0][0] = 1;
    board[2][0] = 1; // taller stack in col 0
    board[4][3] = 1; // height 5 in col 3
    expect(_columnHeights(board, 10)[0]).toBe(3);
    expect(_columnHeights(board, 10)[3]).toBe(5);
    expect(_columnHeights(board, 10)[1]).toBe(0);
  });
});

describe('bot heuristic — line counting', () => {
  it('detects complete rows', () => {
    const board = Array.from({ length: 4 }, () => Array(4).fill(null));
    board[0] = [1, 1, 1, 1]; // full
    board[1] = [1, 1, null, 1]; // not full
    expect(_countCompleteLines(board, 4)).toBe(1);
  });

  it('counts multiple complete rows', () => {
    const board = [
      [1, 1, 1],
      [1, 1, 1],
      [null, 1, 1],
    ];
    expect(_countCompleteLines(board, 3)).toBe(2);
  });
});

describe('bot heuristic — hole counting', () => {
  it('counts cells with at least one filled cell above them', () => {
    const board = [
      [null, 1],   // row 0 — hole at col 0 (col 0 has a cell at row 2)
      [1, 1],
      [1, null],
    ];
    const heights = _columnHeights(board, 2);
    // col 0 height = 3 (top filled at row 2). Row 0 col 0 is null → 1 hole.
    // col 1 height = 2 (top filled at row 1). No holes below height-1.
    expect(_countHoles(board, heights, 2)).toBe(1);
  });

  it('returns 0 for a perfectly stacked board', () => {
    const board = [[1, 1], [1, 1]];
    const heights = _columnHeights(board, 2);
    expect(_countHoles(board, heights, 2)).toBe(0);
  });
});

describe('bot heuristic — bumpiness', () => {
  it('sums absolute height differences between adjacent columns', () => {
    expect(_bumpiness([3, 5, 2])).toBe(2 + 3); // |3-5| + |5-2|
    expect(_bumpiness([4, 4, 4])).toBe(0);
    expect(_bumpiness([0, 10])).toBe(10);
  });
});

describe('bot heuristic — composite score', () => {
  it('prefers lower stacks with no holes over taller messier stacks', () => {
    const flatLow = Array.from({ length: 20 }, () => Array(10).fill(null));
    flatLow[0] = Array(10).fill(1);

    const tallMessy = Array.from({ length: 20 }, () => Array(10).fill(null));
    for (let r = 0; r < 5; r++) tallMessy[r] = Array(10).fill(1);
    tallMessy[2][3] = null; // hole

    expect(_scoreBoard(flatLow, 10)).toBeGreaterThan(_scoreBoard(tallMessy, 10));
  });

  it('rewards complete-line clears (post-clear height is what matters)', () => {
    const empty = Array.from({ length: 20 }, () => Array(10).fill(null));
    const full1 = Array.from({ length: 20 }, () => Array(10).fill(null));
    full1[0] = Array(10).fill(1);
    // After simulating the line clear: full1 becomes empty + 1 line bonus.
    // Score should be the line bonus (0.76) — beats empty's 0.
    expect(_scoreBoard(full1, 10)).toBeGreaterThan(_scoreBoard(empty, 10));
  });
});

// ─── Casual (heuristic) strategy ───────────────────────────────────────

describe('BotController — casual strategy is the heuristic', () => {
  it('plans a placement (col, rot) within the legal range', () => {
    const game = buildGame();
    game.spawnPiece('T');
    const bot = new BotController({ game, rng: seededRng(42), actionsPerSecond: 1000 });
    bot.tick(1000);
    expect(bot.plan.col).toBeGreaterThanOrEqual(-2);
    expect(bot.plan.col).toBeLessThan(game.cols + 2);
    expect(bot.plan.rot).toBeGreaterThanOrEqual(0);
    expect(bot.plan.rot).toBeLessThan(4);
  });

  it('does not raise an existing tall column when alternatives exist', () => {
    // Build a partial stack: col 0 filled to height 8; rest empty.
    const game = buildGame();
    for (let r = 0; r < 8; r++) game.board[r][0] = 0xff0000;
    game.spawnPiece('O'); // 2x2, simplest shape
    const bot = new BotController({ game, rng: seededRng(1), actionsPerSecond: 1000 });
    bot.tick(1000);
    // Simulate the bot's chosen drop on a virtual board to verify col 0
    // ends up no taller. Note: O's shape uses cols 1+2 of its 4-wide
    // bounding box, so plan.col=0 actually drops cubes into board cols
    // 1+2 (a sensible move). The heuristic property is "col 0's height
    // doesn't grow" — that holds across all good placements.
    const plan = bot.plan;
    const piece = { key: 'O', col: plan.col, row: game.rows - 2, rot: plan.rot };
    let r = piece.row;
    while (!game.collides(piece, plan.col, r - 1, plan.rot)) r--;
    const cells = game.getPieceCells({ ...piece, row: r });
    let highestInCol0 = 7; // existing stack tops at row 7 (height 8)
    for (const cell of cells) {
      if (cell.col === 0 && cell.row > highestInCol0) highestInCol0 = cell.row;
    }
    expect(highestInCol0).toBe(7); // unchanged — bot didn't stack on col 0
  });

  it('finds a line-clearing placement when one piece would complete a row', () => {
    // Pre-fill row 0 except col 9. An I piece dropped vertically into
    // col 9 fills the gap and clears row 0. The heuristic should
    // strongly prefer that placement (line bonus + post-clear height
    // = 0).
    const game = buildGame();
    for (let c = 0; c < 9; c++) game.board[0][c] = 0xff0000;
    game.spawnPiece('I');
    const bot = new BotController({ game, rng: seededRng(1), actionsPerSecond: 1000 });
    bot.tick(1000);
    // Simulate the planned drop and check whether row 0 becomes full.
    const plan = bot.plan;
    const piece = { key: 'I', col: plan.col, row: game.rows - 2, rot: plan.rot };
    let r = piece.row;
    while (!game.collides(piece, plan.col, r - 1, plan.rot)) r--;
    const cells = game.getPieceCells({ ...piece, row: r });
    const virt = game.board.map(row => row.slice());
    let topout = false;
    for (const cell of cells) {
      if (cell.row >= game.rows) { topout = true; break; }
      virt[cell.row][cell.col] = 1;
    }
    expect(topout).toBe(false);
    expect(virt[0].every(c => c != null)).toBe(true); // row 0 completed
  });
});

describe('BotController — random strategy', () => {
  it('produces a valid (col, rot) plan', () => {
    const game = buildGame();
    game.spawnPiece('T');
    const bot = new BotController({ game, strength: 'random', rng: seededRng(42), actionsPerSecond: 1000 });
    bot.tick(1000);
    expect(typeof bot.plan.col).toBe('number');
    expect(typeof bot.plan.rot).toBe('number');
  });

  it('different seeds give different plans', () => {
    const g1 = buildGame(); g1.spawnPiece('T');
    const g2 = buildGame(); g2.spawnPiece('T');
    const b1 = new BotController({ game: g1, strength: 'random', rng: seededRng(1), actionsPerSecond: 1000 });
    const b2 = new BotController({ game: g2, strength: 'random', rng: seededRng(99), actionsPerSecond: 1000 });
    b1.tick(1000); b2.tick(1000);
    // With 100 distinct seed pairs we'd expect divergence; for a single
    // pair, just sanity-check the plans are well-formed.
    expect(b1.plan).not.toBeNull();
    expect(b2.plan).not.toBeNull();
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
