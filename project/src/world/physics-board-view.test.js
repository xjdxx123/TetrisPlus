// Tests for PhysicsBoardView (Force-Physics design, plan v2 §2.3.1 J).
//
// The renderer is keyed by COLLIDER, not by body — a compound
// tetromino contributes 4 collider meshes that share one parent
// body's rotation. Tests use a real PhysicsSession (with real
// Rapier) plus a stubbed makeCube factory for pure-Node behavior
// testing.

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../engine/events/bus.js';
import { EVENTS } from '../gameplay/events.js';
import { Game } from '../gameplay/game.js';
import { buildRules } from '../gameplay/rules.js';
import { PhysicsSession } from '../app/physics-session.js';
import { PhysicsBoardView, _DISSOLVE } from './physics-board-view.js';

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

// makeCube stub — returns a real THREE.Mesh with a transparent-able
// material so dissolve assertions can read opacity.
function makeCubeStub() {
  return vi.fn((color) => {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: false, opacity: 1 });
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
    m.userData.color = color;
    return m;
  });
}

async function makeFixture(opts = {}) {
  const bus = new EventBus({ replayBufferSize: 0, recorderSize: 0 });
  const game = new Game({ rules: buildRules('physics'), bus, rng: seededRng(1) });
  const session = new PhysicsSession({ bus, game });
  await session.start();
  const parent = new THREE.Group();
  const makeCube = makeCubeStub();
  // Allow tests to inject a deterministic now() for dissolve assertions.
  const view = new PhysicsBoardView({
    session, parent, makeCube,
    now: opts.now,
  });
  return { bus, game, session, parent, makeCube, view };
}

describe('PhysicsBoardView — construction', () => {
  it('throws on missing session / parent / makeCube', () => {
    expect(() => new PhysicsBoardView({})).toThrow(/session/);
    expect(() => new PhysicsBoardView({ session: {} })).toThrow(/parent/);
    expect(() => new PhysicsBoardView({ session: {}, parent: new THREE.Group() })).toThrow(/makeCube/);
  });

  it('attaches its stackGroup to parent on construction', async () => {
    const { parent, view, session } = await makeFixture();
    expect(view.stackGroup.parent).toBe(parent);
    expect(view.cubeCount).toBe(0);
    session.stop();
    view.dispose();
  });
});

describe('PhysicsBoardView — collider-keyed rendering (plan v2 §2.3.1 J)', () => {
  it('creates ONE mesh per collider, not per body', async () => {
    const { game, session, view, makeCube } = await makeFixture();
    // T-piece spawn — one compound body, 4 colliders.
    game.spawnPiece('T');
    expect(session.bodyCount).toBe(1);
    expect(session.world.getColliderPositions()).toHaveLength(4);

    view.tick();
    expect(view.cubeCount).toBe(4);
    expect(makeCube).toHaveBeenCalledTimes(4);
    session.stop();
    view.dispose();
  });

  it('updates each cube\'s position from its collider position', async () => {
    const { game, session, view } = await makeFixture();
    game.spawnPiece('I'); // horizontal I-piece
    view.tick();
    // Sample a mesh and confirm its position roughly matches one
    // of the collider positions.
    const positions = session.world.getColliderPositions();
    const meshes = [...view.stackGroup.children];
    expect(meshes).toHaveLength(4);
    // Each mesh's x should be close to one of the collider xs.
    const expectedXs = positions.map(p => p.x).sort((a, b) => a - b);
    const meshXs = meshes.map(m => m.position.x).sort((a, b) => a - b);
    for (let i = 0; i < 4; i++) {
      expect(meshXs[i]).toBeCloseTo(expectedXs[i], 3);
    }
    session.stop();
    view.dispose();
  });

  it('cubes inherit parent body rotation (compound tumbles as one unit)', async () => {
    const { game, session, view } = await makeFixture();
    game.spawnPiece('I');
    // Apply torque + tick to spin the body.
    session.applyRotate(1);
    for (let i = 0; i < 30; i++) {
      session.tick();
      view.tick();
    }
    const meshes = [...view.stackGroup.children];
    // After spin, the mesh quaternion's z or w should differ from
    // the identity (0,0,0,1).
    const drift = meshes.reduce((acc, m) => {
      const q = m.quaternion;
      return acc + Math.abs(q.x) + Math.abs(q.y) + Math.abs(q.z) + Math.abs(1 - q.w);
    }, 0);
    expect(drift).toBeGreaterThan(0.001);
    session.stop();
    view.dispose();
  });

  it('partial compound clear: cleared collider mesh dissolves; survivor stays', async () => {
    let now = 0;
    const { session, view } = await makeFixture({ now: () => now });
    // Compound body with 2 colliders.
    session.world.addCompoundBody([
      { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 },
    ]);
    view.tick();
    expect(view.cubeCount).toBe(2);

    // Manually remove the bottom collider (simulates layer clear in K).
    const cs = session.world.getColliderPositions();
    const bottom = cs.find(c => c.y < 0.5);
    session.world.removeCollider(bottom.colliderId);
    expect(session.world.getColliderPositions()).toHaveLength(1);

    // Tick the view — bottom mesh begins dissolving, survivor stays.
    view.tick();
    expect(view.cubeCount).toBe(1);                      // tracked map
    expect(view.dissolvingCount).toBe(1);                // dissolving in-flight
    expect(view.stackGroup.children.length).toBe(2);     // both still in scene during fade

    // Advance time past dissolve duration; survivor mesh persists.
    now = _DISSOLVE.DURATION_MS + 10;
    view.tick();
    expect(view.dissolvingCount).toBe(0);
    expect(view.stackGroup.children.length).toBe(1);
    session.stop();
    view.dispose();
  });

  it('uses violet fallback when collider has no recorded color', async () => {
    const { session, view, makeCube } = await makeFixture();
    // Bypass the spawn path and add a body without color metadata.
    // PhysicsWorld defaults to 0xffffff in addCompoundBody when
    // opts.color is omitted.
    session.world.addCompoundBody([{ x: 0, y: 0, z: 0 }]);
    view.tick();
    expect(makeCube).toHaveBeenCalledWith(0xffffff, { settling: true });
    session.stop();
    view.dispose();
  });

  it('tick is a no-op when session is not started', () => {
    const bus = new EventBus({ replayBufferSize: 0, recorderSize: 0 });
    const game = new Game({ rules: buildRules('physics'), bus, rng: seededRng(1) });
    const session = new PhysicsSession({ bus, game });
    const view = new PhysicsBoardView({
      session, parent: new THREE.Group(), makeCube: makeCubeStub(),
    });
    expect(() => view.tick()).not.toThrow();
    expect(view.cubeCount).toBe(0);
  });
});

describe('PhysicsBoardView — dissolve animation', () => {
  it('opacity fades from 1 to 0 over DISSOLVE.DURATION_MS', async () => {
    let now = 0;
    const { session, view } = await makeFixture({ now: () => now });
    session.world.addBody(0, 0, 0);
    view.tick();
    const mesh = [...view.stackGroup.children][0];
    expect(mesh.material.opacity).toBe(1);

    // Remove the body.
    const cid = session.world.getColliderPositions()[0].colliderId;
    session.world.removeCollider(cid);
    view.tick();
    expect(mesh.material.opacity).toBe(1); // tick at t=0 starts; opacity not yet animated until next tick

    // Advance to half duration; opacity should be ~0.5.
    now = _DISSOLVE.DURATION_MS / 2;
    view.tick();
    expect(mesh.material.opacity).toBeGreaterThan(0.4);
    expect(mesh.material.opacity).toBeLessThan(0.6);

    // Advance to full duration; opacity 0.
    now = _DISSOLVE.DURATION_MS;
    view.tick();
    expect(mesh.material.opacity).toBe(0);
    session.stop();
    view.dispose();
  });

  it('mesh scales up slightly during dissolve (visual cue)', async () => {
    let now = 0;
    const { session, view } = await makeFixture({ now: () => now });
    session.world.addBody(0, 0, 0);
    view.tick();
    const mesh = [...view.stackGroup.children][0];
    expect(mesh.scale.x).toBe(1);

    const cid = session.world.getColliderPositions()[0].colliderId;
    session.world.removeCollider(cid);
    view.tick(); // start dissolve at t=0

    now = _DISSOLVE.DURATION_MS;
    view.tick();
    expect(mesh.scale.x).toBeCloseTo(_DISSOLVE.END_SCALE, 5);
    session.stop();
    view.dispose();
  });

  it('mesh is removed from scene after dissolve completes', async () => {
    let now = 0;
    const { session, view } = await makeFixture({ now: () => now });
    session.world.addBody(0, 0, 0);
    view.tick();
    const cid = session.world.getColliderPositions()[0].colliderId;
    session.world.removeCollider(cid);
    view.tick();
    expect(view.stackGroup.children.length).toBe(1);
    now = _DISSOLVE.DURATION_MS + 10;
    view.tick();
    expect(view.stackGroup.children.length).toBe(0);
    session.stop();
    view.dispose();
  });
});

describe('PhysicsBoardView — dispose', () => {
  it('clears mesh + dissolve registries and detaches stackGroup', async () => {
    const { session, view, parent } = await makeFixture();
    session.world.addCompoundBody([
      { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 },
    ]);
    view.tick();
    expect(view.cubeCount).toBe(2);
    view.dispose();
    expect(view.cubeCount).toBe(0);
    expect(view.dissolvingCount).toBe(0);
    expect(view.stackGroup.parent).toBeNull();
    session.stop();
  });

  it('dispose is idempotent', async () => {
    const { session, view } = await makeFixture();
    expect(() => { view.dispose(); view.dispose(); }).not.toThrow();
    session.stop();
  });
});
