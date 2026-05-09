// Tests for PhysicsSession (plan v2 §2.3 Phases C+D).
//
// Tests use a real PhysicsWorld (Rapier) plus a real Game instance —
// no mocks for the physics. We drive PIECE_LOCK events by manually
// emitting on the bus.

import { describe, it, expect } from 'vitest';
import { EventBus } from '../engine/events/bus.js';
import { EVENTS } from '../gameplay/events.js';
import { Game } from '../gameplay/game.js';
import { buildRules } from '../gameplay/rules.js';
import { PhysicsSession } from './physics-session.js';

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

function makeFixture() {
  const bus = new EventBus({ replayBufferSize: 0, recorderSize: 0 });
  const rules = buildRules('physics');
  const game = new Game({ rules, bus, rng: seededRng(1) });
  const session = new PhysicsSession({ bus, game });
  return { bus, game, session };
}

describe('PhysicsSession — construction', () => {
  it('throws without bus or game', () => {
    expect(() => new PhysicsSession({})).toThrow(/bus/);
    expect(() => new PhysicsSession({ bus: new EventBus() })).toThrow(/game/);
  });

  it('starts in non-running state (world: null, bodyCount: 0)', () => {
    const { session } = makeFixture();
    expect(session.isStarted).toBe(false);
    expect(session.world).toBeNull();
    expect(session.bodyCount).toBe(0);
    expect(session.highestY).toBe(-Infinity);
  });
});

describe('PhysicsSession — start / stop', () => {
  it('start() lazy-loads Rapier and creates the world', async () => {
    const { session } = makeFixture();
    await session.start();
    expect(session.isStarted).toBe(true);
    expect(session.world).toBeTruthy();
    session.stop();
  });

  it('start() is idempotent — repeated calls are no-ops', async () => {
    const { session } = makeFixture();
    await session.start();
    const w1 = session.world;
    await session.start();
    expect(session.world).toBe(w1);
    session.stop();
  });

  it('stop() disposes the world + clears state', async () => {
    const { session } = makeFixture();
    await session.start();
    session.stop();
    expect(session.isStarted).toBe(false);
    expect(session.world).toBeNull();
    expect(session.layersClearedTotal).toBe(0);
  });

  it('stop() is idempotent on a never-started session', () => {
    const { session } = makeFixture();
    expect(() => session.stop()).not.toThrow();
  });
});

describe('PhysicsSession — PIECE_LOCK bridge', () => {
  it('cells in a PIECE_LOCK event become physics bodies', async () => {
    const { bus, session } = makeFixture();
    await session.start();
    bus.emit(EVENTS.PIECE_LOCK, {
      cells: [{ col: 4, row: 5 }, { col: 5, row: 5 }, { col: 6, row: 5 }],
      color: 0xff0000, side: 'player',
    });
    expect(session.bodyCount).toBe(3);
    session.stop();
  });

  it('erases each locked cell from the game board (so clearLines stays a no-op)', async () => {
    const { bus, game, session } = makeFixture();
    // Pre-fill row 5 to confirm the erase wipes it.
    game.board[5][4] = 0xaaaaaa;
    game.board[5][5] = 0xaaaaaa;
    await session.start();
    bus.emit(EVENTS.PIECE_LOCK, {
      cells: [{ col: 4, row: 5 }, { col: 5, row: 5 }],
      color: 0xff0000, side: 'player',
    });
    expect(game.board[5][4]).toBeNull();
    expect(game.board[5][5]).toBeNull();
    session.stop();
  });

  it('ignores events from a different side (dual-board case)', async () => {
    const bus = new EventBus({ replayBufferSize: 0, recorderSize: 0 });
    const game = new Game({ rules: buildRules('physics'), bus, rng: seededRng(1) });
    const session = new PhysicsSession({ bus, game, side: 'player' });
    await session.start();
    bus.emit(EVENTS.PIECE_LOCK, {
      cells: [{ col: 0, row: 0 }],
      color: 0, side: 'opponent',
    });
    expect(session.bodyCount).toBe(0);
    bus.emit(EVENTS.PIECE_LOCK, {
      cells: [{ col: 0, row: 0 }],
      color: 0, side: 'player',
    });
    expect(session.bodyCount).toBe(1);
    session.stop();
  });

  it('after stop(), PIECE_LOCK events are ignored', async () => {
    const { bus, session } = makeFixture();
    await session.start();
    session.stop();
    bus.emit(EVENTS.PIECE_LOCK, {
      cells: [{ col: 0, row: 0 }], color: 0, side: 'player',
    });
    expect(session.bodyCount).toBe(0);
  });
});

describe('PhysicsSession — tick + layer detection', () => {
  it('tick() returns null when no layer forms', async () => {
    const { bus, session } = makeFixture();
    await session.start();
    bus.emit(EVENTS.PIECE_LOCK, {
      cells: [{ col: 4, row: 0 }],
      color: 0, side: 'player',
    });
    for (let i = 0; i < 30; i++) {
      const result = session.tick();
      expect(result).toBeNull();
    }
    session.stop();
  });

  it('tick() emits PHYSICS_LAYER_CLEARED when ≥10 cubes form a layer', async () => {
    const { bus, session } = makeFixture();
    await session.start();
    const cells = [];
    for (let col = 0; col < 10; col++) cells.push({ col, row: 0 });
    bus.emit(EVENTS.PIECE_LOCK, { cells, color: 0, side: 'player' });
    expect(session.bodyCount).toBe(10);

    const events = [];
    const off = bus.on(EVENTS.PHYSICS_LAYER_CLEARED, (e) => events.push(e));
    session.tick();
    off();

    expect(events.length).toBe(1);
    expect(events[0].cubeCount).toBe(10);
    expect(events[0].simultaneous).toBe(1);
    expect(events[0].layers[0].size).toBe(10);
    expect(session.bodyCount).toBe(0);
    expect(session.layersClearedTotal).toBe(1);
    expect(session.cubesClearedTotal).toBe(10);
    session.stop();
  });

  it('multiple distinct layers in one tick emit a single event with simultaneous=N', async () => {
    const { bus, session } = makeFixture();
    await session.start();
    const cells = [];
    for (let col = 0; col < 10; col++) cells.push({ col, row: 0 });
    for (let col = 0; col < 10; col++) cells.push({ col, row: 5 });
    bus.emit(EVENTS.PIECE_LOCK, { cells, color: 0, side: 'player' });

    const events = [];
    const off = bus.on(EVENTS.PHYSICS_LAYER_CLEARED, (e) => events.push(e));
    session.tick();
    off();

    expect(events.length).toBe(1);
    expect(events[0].simultaneous).toBe(2);
    expect(events[0].cubeCount).toBe(20);
    session.stop();
  });

  it('cumulative counters survive across ticks', async () => {
    const { bus, session } = makeFixture();
    await session.start();
    const row0 = [];
    for (let col = 0; col < 10; col++) row0.push({ col, row: 0 });
    bus.emit(EVENTS.PIECE_LOCK, { cells: row0, color: 0, side: 'player' });
    session.tick();
    const row5 = [];
    for (let col = 0; col < 10; col++) row5.push({ col, row: 5 });
    bus.emit(EVENTS.PIECE_LOCK, { cells: row5, color: 0, side: 'player' });
    session.tick();
    expect(session.layersClearedTotal).toBe(2);
    expect(session.cubesClearedTotal).toBe(20);
    session.stop();
  });

  it('tick() returns null after stop() (defensive — no-op on disposed)', async () => {
    const { session } = makeFixture();
    await session.start();
    session.stop();
    expect(session.tick()).toBeNull();
  });
});

describe('PhysicsSession — getRulesStateAugment', () => {
  it('returns physicsHighestY for the rules pack endCondition', async () => {
    const { bus, session } = makeFixture();
    await session.start();
    bus.emit(EVENTS.PIECE_LOCK, {
      cells: [{ col: 4, row: 10 }],
      color: 0, side: 'player',
    });
    session.tick();
    const augment = session.getRulesStateAugment();
    expect(augment).toHaveProperty('physicsHighestY');
    expect(augment.physicsHighestY).toBeGreaterThan(9);
    expect(augment.physicsHighestY).toBeLessThan(11);
    session.stop();
  });

  it('returns -Infinity when never ticked', () => {
    const { session } = makeFixture();
    expect(session.getRulesStateAugment().physicsHighestY).toBe(-Infinity);
  });
});

describe('PhysicsSession — counter reset on stop+start', () => {
  it('layersClearedTotal resets when restarting after stop', async () => {
    const { bus, session } = makeFixture();
    await session.start();
    const cells = [];
    for (let col = 0; col < 10; col++) cells.push({ col, row: 0 });
    bus.emit(EVENTS.PIECE_LOCK, { cells, color: 0, side: 'player' });
    session.tick();
    expect(session.layersClearedTotal).toBe(1);
    session.stop();
    expect(session.layersClearedTotal).toBe(0);
    await session.start();
    expect(session.layersClearedTotal).toBe(0);
    session.stop();
  });
});
