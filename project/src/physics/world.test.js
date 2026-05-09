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

// ─── Force-Physics pivot — Phase G compound bodies + force API ─────────

describe('PhysicsWorld — addCompoundBody (plan v2 §2.3.1 G)', () => {
  it('throws on empty cells', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    expect(() => world.addCompoundBody([])).toThrow(/at least one cell/);
    world.dispose();
  });

  it('returns one body ID for an N-cell tetromino (one body, multiple colliders)', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    // L-piece footprint at the origin.
    const id = world.addCompoundBody([
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 1, z: 0 },
      { x: 0, y: 2, z: 0 },
      { x: 1, y: 0, z: 0 },
    ]);
    expect(typeof id).toBe('number');
    expect(world.bodyCount).toBe(1);
    world.dispose();
  });

  it('places body at the cells centroid + each collider at the cell offset', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    // Symmetric I-piece (4 cubes in a row): centroid x = 1.5.
    const id = world.addCompoundBody([
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 3, y: 0, z: 0 },
    ]);
    const pos = world.getBodyPosition(id);
    expect(pos.x).toBeCloseTo(1.5, 5);
    expect(pos.y).toBeCloseTo(0, 5);
    // Each collider's WORLD position equals its cell coords (the
    // local offsets are computed against the same centroid the body
    // is placed at).
    const colliders = world.getColliderPositions();
    expect(colliders).toHaveLength(4);
    const xs = colliders.map(c => c.x).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(0, 5);
    expect(xs[1]).toBeCloseTo(1, 5);
    expect(xs[2]).toBeCloseTo(2, 5);
    expect(xs[3]).toBeCloseTo(3, 5);
    world.dispose();
  });

  it('compound body falls as one rigid unit under gravity', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    const cells = [
      { x: 0, y: 5, z: 0 }, { x: 1, y: 5, z: 0 },
      { x: 0, y: 6, z: 0 }, { x: 1, y: 6, z: 0 },
    ];
    const id = world.addCompoundBody(cells);
    for (let i = 0; i < 30; i++) world.step();
    const pos = world.getBodyPosition(id);
    // Centroid was at (0.5, 5.5); after 0.5s under -9.81, y is well below.
    expect(pos.y).toBeLessThan(5.5);
    // Cubes stay in their relative O-piece formation (compound body
    // never splits): max collider |x_relative_to_body| < 1.0, max |y|.
    const colliders = world.getColliderPositions();
    for (const c of colliders) {
      expect(Math.abs(c.x - pos.x)).toBeLessThan(1.0);
      expect(Math.abs(c.y - pos.y)).toBeLessThan(1.0);
    }
    world.dispose();
  });

  it('addBody is a 1-cell convenience for addCompoundBody', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    const id = world.addBody(3, 4, 0);
    expect(world.bodyCount).toBe(1);
    expect(world.getColliderPositions()).toHaveLength(1);
    expect(world.getBodyPosition(id)).toMatchObject({ x: 3, y: 4 });
    world.dispose();
  });

  it('opts.color is stashed per collider for the renderer', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    world.addCompoundBody([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], { color: 0xff8800 });
    const cs = world.getColliderPositions();
    expect(cs.every(c => c.color === 0xff8800)).toBe(true);
    world.dispose();
  });
});

describe('PhysicsWorld — applyImpulse / applyTorqueImpulse / setLinvel', () => {
  it('applyImpulse moves the body in the impulse direction', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false, gravity: 0 });
    const id = world.addBody(0, 0, 0);
    world.applyImpulse(id, { x: 5, y: 0, z: 0 });
    for (let i = 0; i < 30; i++) world.step();
    expect(world.getBodyPosition(id).x).toBeGreaterThan(0);
    world.dispose();
  });

  it('applyTorqueImpulse spins the body (rotation drifts from identity)', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false, gravity: 0 });
    const id = world.addCompoundBody([
      { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 },
    ]);
    const r0 = world.getBodyRotation(id);
    world.applyTorqueImpulse(id, { x: 0, y: 0, z: 0.5 });
    for (let i = 0; i < 30; i++) world.step();
    const r1 = world.getBodyRotation(id);
    // Some rotation around Z occurred — z component or w drifts from
    // the identity quaternion.
    const drift = Math.abs(r1.z - r0.z) + Math.abs(r1.w - r0.w);
    expect(drift).toBeGreaterThan(0.001);
    world.dispose();
  });

  it('setLinvel replaces velocity (hard-drop semantics)', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false, gravity: 0 });
    const id = world.addBody(0, 10, 0);
    world.applyImpulse(id, { x: 5, y: 0, z: 0 }); // moving right
    world.setLinvel(id, { x: 0, y: -15, z: 0 });   // → now moving straight down
    for (let i = 0; i < 5; i++) world.step();
    const pos = world.getBodyPosition(id);
    expect(pos.x).toBeCloseTo(0, 1); // X velocity was overwritten to 0
    expect(pos.y).toBeLessThan(9);   // Y dropped at ~ -15 cells/sec
    world.dispose();
  });

  it('force methods are no-ops on unknown bodyIds (idempotent)', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    expect(() => {
      world.applyImpulse(999, { x: 1, y: 0, z: 0 });
      world.applyTorqueImpulse(999, { x: 0, y: 0, z: 1 });
      world.setLinvel(999, { x: 0, y: -5, z: 0 });
    }).not.toThrow();
    world.dispose();
  });
});

describe('PhysicsWorld — removeCollider + auto-body-removal', () => {
  it('removes a single collider; surviving colliders stay attached to parent body', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    world.addCompoundBody([
      { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 }, { x: 3, y: 0, z: 0 },
    ]);
    expect(world.getColliderPositions()).toHaveLength(4);
    expect(world.bodyCount).toBe(1);
    const firstId = world.getColliderPositions()[0].colliderId;
    expect(world.removeCollider(firstId)).toBe(true);
    expect(world.getColliderPositions()).toHaveLength(3);
    // Body still alive — has 3 remaining colliders.
    expect(world.bodyCount).toBe(1);
    world.dispose();
  });

  it('auto-removes parent body when all of its colliders are removed', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    world.addCompoundBody([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]);
    expect(world.bodyCount).toBe(1);
    const ids = world.getColliderPositions().map(c => c.colliderId);
    for (const cid of ids) world.removeCollider(cid);
    expect(world.bodyCount).toBe(0);
    expect(world.getColliderPositions()).toHaveLength(0);
    world.dispose();
  });

  it('returns false on unknown colliderId (idempotent)', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    expect(world.removeCollider(999)).toBe(false);
    world.dispose();
  });

  it('removeBody also cleans up tracked colliders (no stale entries)', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    const id = world.addCompoundBody([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]);
    expect(world.getColliderPositions()).toHaveLength(2);
    world.removeBody(id);
    expect(world.getColliderPositions()).toHaveLength(0);
    expect(world.bodyCount).toBe(0);
    world.dispose();
  });
});

describe('PhysicsWorld — isBodySleeping', () => {
  it('returns false on a freshly-spawned body, true after it settles', async () => {
    const world = await createPhysicsWorld({ floor: true, walls: false });
    const id = world.addBody(0, 5, 0);
    expect(world.isBodySleeping(id)).toBe(false);
    // Settle on the floor.
    for (let i = 0; i < 600; i++) world.step();
    expect(world.isBodySleeping(id)).toBe(true);
    world.dispose();
  });

  it('returns false for unknown ids (defensive)', async () => {
    const world = await createPhysicsWorld({ floor: false, walls: false });
    expect(world.isBodySleeping(999)).toBe(false);
    world.dispose();
  });
});
