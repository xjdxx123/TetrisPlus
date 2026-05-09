// Tests for PhysicsSession (Force-Physics design, plan v2 §2.3.1 H).
//
// Tests use a real PhysicsWorld (Rapier) plus a real Game instance. The
// session subscribes to PIECE_SPAWN; we trigger a spawn by either
// constructing a Game with a known seed and calling `game.spawnPiece()`,
// or by manually emitting the event with a hand-crafted active piece
// shape.

import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../engine/events/bus.js';
import { EVENTS } from '../gameplay/events.js';
import { Game } from '../gameplay/game.js';
import { buildRules } from '../gameplay/rules.js';
import { PhysicsSession, _FORCE, _PHYSICS_TOPOUT_Y } from './physics-session.js';

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

function makeFixture(opts = {}) {
  const bus = new EventBus({ replayBufferSize: 0, recorderSize: 0 });
  const rules = buildRules('physics');
  const game = new Game({ rules, bus, rng: seededRng(1) });
  const session = new PhysicsSession({ bus, game, ...opts });
  return { bus, game, session };
}

describe('PhysicsSession — construction', () => {
  it('throws without bus or game', () => {
    expect(() => new PhysicsSession({})).toThrow(/bus/);
    expect(() => new PhysicsSession({ bus: new EventBus() })).toThrow(/game/);
  });

  it('starts in non-running state (world: null, bodyCount: 0, no active body)', () => {
    const { session } = makeFixture();
    expect(session.isStarted).toBe(false);
    expect(session.world).toBeNull();
    expect(session.bodyCount).toBe(0);
    expect(session.activeBodyId).toBeNull();
    expect(session.highestY).toBe(-Infinity);
  });
});

describe('PhysicsSession — start / stop', () => {
  it('start() lazy-loads Rapier, creates world, AND pauses the Game', async () => {
    const { game, session } = makeFixture();
    expect(game.paused).toBe(false);
    await session.start();
    expect(session.isStarted).toBe(true);
    expect(game.paused).toBe(true); // grid path dormant in physics mode
    session.stop();
  });

  it('stop() un-pauses the Game so a non-physics mode can run normally', async () => {
    const { game, session } = makeFixture();
    await session.start();
    session.stop();
    expect(game.paused).toBe(false);
  });

  it('start() is idempotent', async () => {
    const { session } = makeFixture();
    await session.start();
    const w1 = session.world;
    await session.start();
    expect(session.world).toBe(w1);
    session.stop();
  });

  it('stop() is idempotent on a never-started session', () => {
    const { session } = makeFixture();
    expect(() => session.stop()).not.toThrow();
  });
});

describe('PhysicsSession — PIECE_SPAWN bridge (Force-Physics, plan v2 §2.3.1)', () => {
  it('PIECE_SPAWN creates ONE compound body for the whole tetromino', async () => {
    const { game, session } = makeFixture();
    await session.start();
    game.spawnPiece('T'); // emits PIECE_SPAWN
    // Compound body: bodyCount === 1 even though the T-piece has 4 cells.
    expect(session.bodyCount).toBe(1);
    expect(session.activeBodyId).toBe(1); // first body in monotonic ID space
    // The world has 4 colliders (one per cell of the T).
    expect(session.world.getColliderPositions()).toHaveLength(4);
    session.stop();
  });

  it('records the lock color per active piece', async () => {
    const { bus, game, session } = makeFixture();
    await session.start();
    // Manually emit PIECE_SPAWN with an explicit color so the test
    // doesn't depend on PIECE_COLORS lookup.
    game.spawnPiece('T');
    bus.emit(EVENTS.PIECE_SPAWN, {
      key: 'T', color: 0xb84cff, rotation: 0, side: 'player',
    });
    // Active body's cubes should all carry the spawned color.
    const id = session.activeBodyId;
    expect(session.getBodyColor(id)).toBe(0xb84cff);
    session.stop();
  });

  it('ignores PIECE_SPAWN from a different side (dual-board)', async () => {
    const bus = new EventBus({ replayBufferSize: 0, recorderSize: 0 });
    const game = new Game({ rules: buildRules('physics'), bus, rng: seededRng(1) });
    const session = new PhysicsSession({ bus, game, side: 'player' });
    await session.start();
    // Trigger an opponent-side spawn via raw bus emission. The session
    // shouldn't react.
    bus.emit(EVENTS.PIECE_SPAWN, { key: 'T', color: 0, rotation: 0, side: 'opponent' });
    expect(session.bodyCount).toBe(0);
    expect(session.activeBodyId).toBeNull();
    session.stop();
  });

  it('defensively re-pauses Game on every PIECE_SPAWN — game.reset() must not strand physics mode in grid-gravity', async () => {
    const { game, session } = makeFixture();
    await session.start();
    expect(game.paused).toBe(true);

    // game.reset() un-pauses the game and then calls spawnPiece(),
    // which fires PIECE_SPAWN. The session's handler must re-pause
    // before returning so the very next game.tick() doesn't run grid
    // gravity in parallel with physics. (Symptom of the bug: the active
    // piece would grid-fall, hit row 0, lockPiece + spawnNext would fire
    // on top of the still-airborne physics body, and PIECE_SPAWN would
    // re-enter mid-flight — producing a pile of overlapping compound
    // bodies at the spawn cell rather than one piece per turn.)
    game.reset();
    expect(game.paused).toBe(true);
    // Run several game.tick() frames; gravity must stay dormant.
    for (let i = 0; i < 10; i++) game.tick(16.67);
    expect(game.paused).toBe(true);
    session.stop();
  });
});

describe('PhysicsSession — force-driven input (plan v2 §2.3.1 H)', () => {
  it('applyMove no-ops when there is no active body', async () => {
    const { session } = makeFixture();
    await session.start();
    expect(() => session.applyMove(1)).not.toThrow();
    session.stop();
  });

  it('applyMove(+1) accelerates the active body to the right', async () => {
    const { game, session } = makeFixture();
    await session.start();
    game.spawnPiece('T');
    const beforeX = session.world._bodies.get(session.activeBodyId).linvel().x;
    session.applyMove(1);
    const afterX = session.world._bodies.get(session.activeBodyId).linvel().x;
    expect(afterX).toBeGreaterThan(beforeX);
    session.stop();
  });

  it('applyMove direction sign matches the dir arg', async () => {
    const { game, session } = makeFixture();
    await session.start();
    game.spawnPiece('T');
    session.applyMove(-1);
    const v = session.world._bodies.get(session.activeBodyId).linvel();
    expect(v.x).toBeLessThan(0);
    session.stop();
  });

  it('applyMove caps lateral velocity (mashing does not run away)', async () => {
    const { game, session } = makeFixture();
    await session.start();
    game.spawnPiece('T');
    // Mash 50 times to the right.
    for (let i = 0; i < 50; i++) session.applyMove(1);
    const v = session.world._bodies.get(session.activeBodyId).linvel();
    // Allow a small overshoot beyond the cap (one final impulse can
    // exceed it before the next call sees |v.x| > cap).
    expect(v.x).toBeLessThan(_FORCE.LATERAL_MAX_VEL + _FORCE.LATERAL_IMPULSE);
    session.stop();
  });

  it('applyRotate spins the active body (rotation drifts from identity)', async () => {
    const { game, session } = makeFixture();
    await session.start();
    game.spawnPiece('T');
    const r0 = session.world.getBodyRotation(session.activeBodyId);
    session.applyRotate(1);
    for (let i = 0; i < 30; i++) session.tick();
    const r1 = session.world.getBodyRotation(session.activeBodyId);
    // After rotation impulse + sim ticks, quaternion has drifted.
    const drift = Math.abs(r1.x - r0.x) + Math.abs(r1.y - r0.y)
                + Math.abs(r1.z - r0.z) + Math.abs(r1.w - r0.w);
    expect(drift).toBeGreaterThan(0.001);
    session.stop();
  });

  it('applySoftDrop adds downward velocity', async () => {
    const { game, session } = makeFixture();
    await session.start();
    game.spawnPiece('T');
    const before = session.world._bodies.get(session.activeBodyId).linvel().y;
    session.applySoftDrop();
    const after = session.world._bodies.get(session.activeBodyId).linvel().y;
    expect(after).toBeLessThan(before);
    session.stop();
  });

  it('applySoftDrop is capped at SOFT_DROP_MAX_VEL — sustained press does not compound past hard-drop magnitude', async () => {
    const { game, session } = makeFixture();
    await session.start();
    game.spawnPiece('T');
    // Pre-set a downward velocity beyond the cap; further soft-drop
    // calls should be no-ops on the velocity (impulse skipped).
    session.world.setLinvel(session.activeBodyId, {
      x: 0, y: -(_FORCE.SOFT_DROP_MAX_VEL + 0.5), z: 0,
    });
    const before = session.world._bodies.get(session.activeBodyId).linvel().y;
    session.applySoftDrop();
    session.applySoftDrop();
    session.applySoftDrop();
    const after = session.world._bodies.get(session.activeBodyId).linvel().y;
    // Cap engaged — y velocity should be unchanged (not more negative).
    expect(after).toBeCloseTo(before, 5);
    session.stop();
  });

  it('applyHardDrop sets a strong downward velocity AND arms commit', async () => {
    const { game, session } = makeFixture();
    await session.start();
    game.spawnPiece('T');
    session.applyHardDrop();
    const v = session.world._bodies.get(session.activeBodyId).linvel();
    expect(v.y).toBeCloseTo(_FORCE.HARD_DROP_LINVEL, 1);
    expect(v.x).toBeCloseTo(0, 5);
    expect(session._hardDropArmed).toBe(true);
    session.stop();
  });

  it('input methods are no-ops when world not started', () => {
    const { session } = makeFixture();
    expect(() => {
      session.applyMove(1);
      session.applyRotate(1);
      session.applySoftDrop();
      session.applyHardDrop();
    }).not.toThrow();
  });
});

describe('PhysicsSession — lock detection + auto-spawn next', () => {
  it('commits active body when it sleeps; advances the bag for the next piece', async () => {
    const { game, session } = makeFixture({
      // Tight world for fast settling.
      worldOpts: { gravity: -9.81 },
    });
    await session.start();
    game.spawnPiece('O'); // start with O-piece for predictable settle
    expect(session.activeBodyId).toBe(1);
    // Tick enough times for the O-piece to fall to the floor and sleep.
    for (let i = 0; i < 800; i++) session.tick();
    // After enough sleep, session should have committed and spawned next.
    expect(session.activeBodyId).not.toBe(1);
    expect(session.activeBodyId).toBeGreaterThan(1);
    session.stop();
  });

  it('hard-drop fast-commits once the body slows below the threshold', async () => {
    const { game, session } = makeFixture();
    await session.start();
    game.spawnPiece('O');
    const initialId = session.activeBodyId;
    session.applyHardDrop();
    // Hard drop sends body at -15 m/s. After ~1s of falling + floor
    // bounce, |v| should drop below HARD_DROP_COMMIT_VEL and the
    // session should commit ahead of the auto-sleep timer.
    for (let i = 0; i < 240; i++) session.tick();
    expect(session.activeBodyId).not.toBe(initialId);
    session.stop();
  });
});

describe('PhysicsSession — layer detection (collider-keyed)', () => {
  it('emits PHYSICS_LAYER_CLEARED with removedColliderIds when ≥10 colliders form a layer', async () => {
    const { bus, session } = makeFixture();
    await session.start();
    // Spawn a row of 10 separate single-cube bodies at row 0 directly
    // via the world (skipping the PIECE_SPAWN path so we don't have to
    // construct 10 tetrominoes).
    for (let col = 0; col < 10; col++) {
      session.world.addBody(col, 0, 0, {});
    }
    expect(session.bodyCount).toBe(10);

    const events = [];
    const off = bus.on(EVENTS.PHYSICS_LAYER_CLEARED, (e) => events.push(e));
    session.tick();
    off();

    expect(events.length).toBe(1);
    expect(events[0].cubeCount).toBe(10);
    expect(events[0].simultaneous).toBe(1);
    expect(events[0].layers[0].size).toBe(10);
    expect(Array.isArray(events[0].removedColliderIds)).toBe(true);
    expect(events[0].removedColliderIds.length).toBe(10);
    expect(session.bodyCount).toBe(0); // each body had its only collider removed → auto-cleanup
    expect(session.layersClearedTotal).toBe(1);
    session.stop();
  });

  it('compound body partial layer clear: only the cleared collider is removed; body survives', async () => {
    const { bus, session } = makeFixture();
    await session.start();
    // Row of 9 single-cube bodies at row 0.
    for (let col = 0; col < 9; col++) session.world.addBody(col, 0, 0);
    // One compound body spanning row 0 col 9 + row 1 col 9 (vertical
    // pair at the right edge). Only the bottom collider is in the
    // layer at row 0; the top collider stays attached to the body.
    const compoundId = session.world.addCompoundBody([
      { x: 9, y: 0, z: 0 },
      { x: 9, y: 1, z: 0 },
    ]);
    expect(session.bodyCount).toBe(10); // 9 singles + 1 compound

    const events = [];
    const off = bus.on(EVENTS.PHYSICS_LAYER_CLEARED, (e) => events.push(e));
    session.tick();
    off();

    expect(events.length).toBe(1);
    expect(events[0].cubeCount).toBe(10); // 9 singles + 1 collider from the compound
    // The 9 single-cube bodies are gone (their only collider removed).
    // The compound body is still alive — its top collider survives.
    const survivors = session.world.getColliderPositions();
    expect(survivors).toHaveLength(1);
    expect(survivors[0].bodyId).toBe(compoundId);
    expect(survivors[0].y).toBeCloseTo(1, 0);
    session.stop();
  });
});

describe('PhysicsSession — topout via onEndRun', () => {
  it('fires onEndRun({reason:"topout"}) when highestY exceeds threshold', async () => {
    const onEndRun = vi.fn();
    const { session } = makeFixture({ onEndRun });
    await session.start();
    // Place a body well above the topout threshold.
    session.world.addBody(0, _PHYSICS_TOPOUT_Y + 5, 0);
    session.tick();
    expect(onEndRun).toHaveBeenCalledTimes(1);
    expect(onEndRun).toHaveBeenCalledWith({ reason: 'topout' });
    session.stop();
  });

  it('topout is single-shot (subsequent ticks do not re-fire)', async () => {
    const onEndRun = vi.fn();
    const { session } = makeFixture({ onEndRun });
    await session.start();
    session.world.addBody(0, _PHYSICS_TOPOUT_Y + 10, 0);
    for (let i = 0; i < 10; i++) session.tick();
    expect(onEndRun).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it('does not fire when no body crosses the threshold', async () => {
    const onEndRun = vi.fn();
    const { session } = makeFixture({ onEndRun });
    await session.start();
    session.world.addBody(0, 1, 0); // well below threshold
    for (let i = 0; i < 30; i++) session.tick();
    expect(onEndRun).not.toHaveBeenCalled();
    session.stop();
  });
});

describe('PhysicsSession — getRulesStateAugment', () => {
  it('returns physicsHighestY from the most recent tick', async () => {
    const { session } = makeFixture();
    await session.start();
    session.world.addBody(0, 10, 0);
    session.tick();
    expect(session.getRulesStateAugment().physicsHighestY).toBeCloseTo(10, 1);
    session.stop();
  });

  it('returns -Infinity before first tick', () => {
    const { session } = makeFixture();
    expect(session.getRulesStateAugment().physicsHighestY).toBe(-Infinity);
  });
});

describe('PhysicsSession — counter reset on stop+start', () => {
  it('layersClearedTotal resets when restarting after stop', async () => {
    const { session } = makeFixture();
    await session.start();
    for (let col = 0; col < 10; col++) session.world.addBody(col, 0, 0);
    session.tick();
    expect(session.layersClearedTotal).toBe(1);
    session.stop();
    expect(session.layersClearedTotal).toBe(0);
    await session.start();
    expect(session.layersClearedTotal).toBe(0);
    session.stop();
  });
});
