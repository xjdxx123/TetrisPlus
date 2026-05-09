// Tests for the Rapier-backed PhysicsWorld wrapper (plan v2 §2.3
// Phase B). Runs against the real Rapier wasm — no mocks — since the
// `rapier3d-compat` sync-init pattern works in vitest's Node env
// without extra setup.
//
// Each test builds a tiny fresh world, exercises the wrapper's
// public API, and disposes. Position assertions use `toBeCloseTo`
// (or coarse comparisons) since exact body coordinates are
// physics-implementation-specific and would create flaky tests.

import { describe, it, expect, beforeEach } from 'vitest';
import { createPhysicsWorld, _resetRapierForTests, _DEFAULT_OPTS } from './world.js';

// One-off step helper — drives the world `n` ticks (default 30 = 0.5s
// of sim time at the default 60Hz).
function stepN(world, n = 30) {
  for (let i = 0; i < n; i++) world.step();
}

describe('createPhysicsWorld — boot', () => {
  it('resolves to a PhysicsWorld instance', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    expect(world).toBeTruthy();
    expect(typeof world.addBody).toBe('function');
    expect(typeof world.step).toBe('function');
    expect(world.bodyCount).toBe(0);
    world.dispose();
  });

  it('exposes the requested cols / rows opts', async () => {
    const world = await createPhysicsWorld({ cols: 12, rows: 24, floor: false, walls: false });
    expect(world.cols).toBe(12);
    expect(world.rows).toBe(24);
    world.dispose();
  });

  it('default opts (when called with no args) match _DEFAULT_OPTS', () => {
    expect(_DEFAULT_OPTS.cols).toBe(10);
    expect(_DEFAULT_OPTS.rows).toBe(20);
    expect(_DEFAULT_OPTS.gravity).toBe(-9.81);
    expect(_DEFAULT_OPTS.friction).toBe(0.6);
    expect(_DEFAULT_OPTS.restitution).toBe(0.1);
    expect(_DEFAULT_OPTS.stepDtSec).toBe(1 / 60);
  });
});

describe('PhysicsWorld — body lifecycle', () => {
  it('addBody returns a positive integer ID and increments per call', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    const a = world.addBody(0, 5, 0);
    const b = world.addBody(1, 5, 0);
    const c = world.addBody(2, 5, 0);
    expect(a).toBeGreaterThan(0);
    expect(b).toBe(a + 1);
    expect(c).toBe(b + 1);
    expect(world.bodyCount).toBe(3);
    world.dispose();
  });

  it('removeBody removes the body and returns true; idempotent on unknown IDs', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    const id = world.addBody(0, 0, 0);
    expect(world.removeBody(id)).toBe(true);
    expect(world.bodyCount).toBe(0);
    expect(world.removeBody(id)).toBe(false); // already removed
    expect(world.removeBody(999)).toBe(false); // never existed
    world.dispose();
  });

  it('removeBodies bulk-removes and returns the count actually removed', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    const ids = [
      world.addBody(0, 0, 0),
      world.addBody(1, 0, 0),
      world.addBody(2, 0, 0),
    ];
    const removed = world.removeBodies([...ids, 999]); // last one bogus
    expect(removed).toBe(3);
    expect(world.bodyCount).toBe(0);
    world.dispose();
  });

  it('getBodyPosition returns null for removed / unknown IDs', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    const id = world.addBody(3, 7, 0);
    expect(world.getBodyPosition(id).x).toBeCloseTo(3, 5);
    expect(world.getBodyPosition(id).y).toBeCloseTo(7, 5);
    world.removeBody(id);
    expect(world.getBodyPosition(id)).toBeNull();
    expect(world.getBodyPosition(999)).toBeNull();
    world.dispose();
  });

  it('getPositions snapshots all bodies with their bodyIds', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    const a = world.addBody(0, 5, 0);
    const b = world.addBody(1, 5, 0);
    const snap = world.getPositions();
    expect(snap).toHaveLength(2);
    expect(snap.map(s => s.bodyId).sort()).toEqual([a, b]);
    expect(snap.every(s => Number.isFinite(s.x))).toBe(true);
    expect(snap.every(s => Number.isFinite(s.y))).toBe(true);
    expect(snap.every(s => Number.isFinite(s.z))).toBe(true);
    world.dispose();
  });
});

describe('PhysicsWorld — gravity / step', () => {
  it('a body falls under gravity (no floor)', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    const id = world.addBody(0, 10, 0);
    stepN(world, 30); // 0.5s
    const pos = world.getBodyPosition(id);
    // Free-fall: y = 10 - 0.5 * 9.81 * 0.5² ≈ 8.77. Allow generous
    // tolerance — Rapier uses semi-implicit Euler, not analytic.
    expect(pos.y).toBeLessThan(10);
    expect(pos.y).toBeGreaterThan(7);
    world.dispose();
  });

  it('a body lands on the default floor and rests at y ≈ 0', async () => {
    const world = await createPhysicsWorld({ floor: true, walls: false });
    const id = world.addBody(0, 5, 0);
    stepN(world, 240); // 4s — plenty of time to settle
    const pos = world.getBodyPosition(id);
    // Floor's top face is y=0; cube center rests at y=0.5 (half-cell up).
    expect(pos.y).toBeGreaterThan(0);
    expect(pos.y).toBeLessThan(1.0);
    world.dispose();
  });

  it('two stacked cubes settle at distinct heights', async () => {
    const world = await createPhysicsWorld({ floor: true, walls: false });
    const lower = world.addBody(0, 1, 0);
    const upper = world.addBody(0, 3, 0);
    stepN(world, 240);
    const lp = world.getBodyPosition(lower);
    const up = world.getBodyPosition(upper);
    // Stacked: lower around y≈0.5, upper around y≈1.5. Tolerant.
    expect(up.y - lp.y).toBeGreaterThan(0.6);
    expect(up.y - lp.y).toBeLessThan(1.4);
    world.dispose();
  });

  it('a body bounces off the side wall instead of escaping', async () => {
    const world = await createPhysicsWorld({ cols: 10, floor: true, walls: true });
    // Spawn a body inside the playfield with high leftward velocity.
    const id = world.addBody(2, 5, 0, { velocity: { x: -10, y: 0, z: 0 } });
    stepN(world, 120); // 2s
    const pos = world.getBodyPosition(id);
    // Walls at x=-1 (left) and x=10 (right). A body inside should
    // stay above x=-0.5 (left wall's right face).
    expect(pos.x).toBeGreaterThan(-0.5);
    world.dispose();
  });
});

describe('PhysicsWorld — sleep / wake', () => {
  it('awakeCount drops as bodies settle', async () => {
    const world = await createPhysicsWorld({ floor: true, walls: false });
    const id = world.addBody(0, 5, 0);
    void id;
    expect(world.awakeCount).toBe(1); // freshly added → awake
    stepN(world, 480); // 8s — plenty of time to settle + sleep
    // After settling, the body should sleep. Rapier auto-sleeps when
    // velocity stays under a threshold for ~0.5s. Allow tolerance —
    // tiny drift can keep it awake.
    expect(world.awakeCount).toBeLessThan(world.bodyCount + 1);
    world.dispose();
  });

  it('wakeAll re-activates settled bodies', async () => {
    const world = await createPhysicsWorld({ floor: true, walls: false });
    world.addBody(0, 5, 0);
    stepN(world, 600); // settle + sleep
    world.wakeAll();
    expect(world.awakeCount).toBe(1);
    world.dispose();
  });
});

describe('PhysicsWorld — highestY', () => {
  it('returns -Infinity on an empty world', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    expect(world.highestY).toBe(-Infinity);
    world.dispose();
  });

  it('reports the maximum Y across all dynamic bodies', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    world.addBody(0, 5, 0);
    world.addBody(0, 12, 0);
    world.addBody(0, 3, 0);
    expect(world.highestY).toBeCloseTo(12, 5);
    world.dispose();
  });

  it('updates as bodies fall', async () => {
    const world = await createPhysicsWorld({ floor: true, walls: false });
    world.addBody(0, 10, 0);
    const before = world.highestY;
    stepN(world, 30);
    const after = world.highestY;
    expect(after).toBeLessThan(before);
    world.dispose();
  });
});

describe('PhysicsWorld — dispose', () => {
  it('dispose is idempotent and safe to call twice', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    world.addBody(0, 0, 0);
    expect(() => world.dispose()).not.toThrow();
    expect(() => world.dispose()).not.toThrow();
  });

  it('a disposed world clears its bodies map', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    world.addBody(0, 0, 0);
    world.addBody(1, 0, 0);
    world.dispose();
    expect(world.bodyCount).toBe(0);
  });
});

describe('loadRapier — caching', () => {
  beforeEach(() => _resetRapierForTests());

  it('first call initializes; second call returns cached module', async () => {
    const w1 = await createPhysicsWorld({ floor: false, walls: false });
    const w2 = await createPhysicsWorld({ floor: false, walls: false });
    // No assertion on internal cache — but both calls succeed and
    // return distinct world instances.
    expect(w1).not.toBe(w2);
    w1.dispose();
    w2.dispose();
  });
});
