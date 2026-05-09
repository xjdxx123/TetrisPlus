// Tests for PhysicsBoardView (plan v2 §2.3 Phase F+).
//
// The view is a thin reactive layer on top of PhysicsSession; tests
// drive a real session (with real Rapier) and assert the view's mesh
// registry reconciles correctly. THREE meshes are stubbed via a
// minimal factory that returns plain objects with `.position` so the
// behavior is testable in pure Node without a renderer.

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../engine/events/bus.js';
import { EVENTS } from '../gameplay/events.js';
import { Game } from '../gameplay/game.js';
import { buildRules } from '../gameplay/rules.js';
import { PhysicsSession } from '../app/physics-session.js';
import { PhysicsBoardView } from './physics-board-view.js';

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

// Lightweight cube stub — returns an object with `.position` (a real
// THREE.Vector3 so `mesh.position.copy(...)` works). Records the color
// it was created with so tests can verify the color path.
function makeCubeStub() {
  return vi.fn((color) => {
    const m = new THREE.Mesh(); // a real Mesh (works in Node — no renderer needed)
    m.userData.color = color;
    return m;
  });
}

async function makeFixture() {
  const bus = new EventBus({ replayBufferSize: 0, recorderSize: 0 });
  const game = new Game({ rules: buildRules('physics'), bus, rng: seededRng(1) });
  const session = new PhysicsSession({ bus, game });
  await session.start();
  const parent = new THREE.Group();
  const makeCube = makeCubeStub();
  const view = new PhysicsBoardView({ session, parent, makeCube });
  return { bus, game, session, parent, makeCube, view };
}

describe('PhysicsBoardView — construction', () => {
  it('throws on missing session / parent / makeCube', () => {
    expect(() => new PhysicsBoardView({})).toThrow(/session/);
    expect(() => new PhysicsBoardView({ session: {} })).toThrow(/parent/);
    expect(() => new PhysicsBoardView({ session: {}, parent: new THREE.Group() })).toThrow(/makeCube/);
  });

  it('attaches its stackGroup to parent on construction', async () => {
    const { parent, view } = await makeFixture();
    expect(view.stackGroup.parent).toBe(parent);
    expect(view.cubeCount).toBe(0);
    view.dispose();
  });
});

describe('PhysicsBoardView — tick', () => {
  it('creates a cube mesh per new physics body', async () => {
    const { bus, session, view, makeCube } = await makeFixture();
    bus.emit(EVENTS.PIECE_LOCK, {
      cells: [{ col: 4, row: 5 }, { col: 5, row: 5 }],
      color: 0x6cf0ff, side: 'player',
    });
    expect(session.bodyCount).toBe(2);
    view.tick();
    expect(view.cubeCount).toBe(2);
    expect(makeCube).toHaveBeenCalledTimes(2);
    // Color from PIECE_LOCK propagated through session → view.
    expect(makeCube).toHaveBeenNthCalledWith(1, 0x6cf0ff, { settling: true });
    session.stop();
    view.dispose();
  });

  it('updates mesh position from body position on each tick', async () => {
    const { bus, session, view } = await makeFixture();
    bus.emit(EVENTS.PIECE_LOCK, {
      cells: [{ col: 4, row: 10 }],
      color: 0xff0000, side: 'player',
    });
    view.tick();
    const mesh = [...view.stackGroup.children][0];
    const initialY = mesh.position.y;
    expect(initialY).toBeCloseTo(10, 1);

    // Advance the world a few ticks — body falls under gravity.
    for (let i = 0; i < 30; i++) {
      session.tick();
      view.tick();
    }
    expect(mesh.position.y).toBeLessThan(initialY);
    session.stop();
    view.dispose();
  });

  it('removes meshes for bodies no longer in the world (layer clear)', async () => {
    const { bus, session, view } = await makeFixture();
    const cells = [];
    for (let col = 0; col < 10; col++) cells.push({ col, row: 0 });
    bus.emit(EVENTS.PIECE_LOCK, { cells, color: 0x000000, side: 'player' });
    view.tick();
    expect(view.cubeCount).toBe(10);

    // Layer detection on the next session.tick clears the row → all
    // 10 bodies removed from the world.
    session.tick();
    view.tick();
    expect(view.cubeCount).toBe(0);
    session.stop();
    view.dispose();
  });

  it('calls shatter on each removed mesh when wired', async () => {
    const bus = new EventBus({ replayBufferSize: 0, recorderSize: 0 });
    const game = new Game({ rules: buildRules('physics'), bus, rng: seededRng(1) });
    const session = new PhysicsSession({ bus, game });
    await session.start();
    const shatter = vi.fn();
    const view = new PhysicsBoardView({
      session, parent: new THREE.Group(), makeCube: makeCubeStub(),
      shatter,
    });
    const cells = [];
    for (let col = 0; col < 10; col++) cells.push({ col, row: 0 });
    bus.emit(EVENTS.PIECE_LOCK, { cells, color: 0x000000, side: 'player' });
    view.tick();
    session.tick();
    view.tick();
    expect(shatter).toHaveBeenCalledTimes(10);
    session.stop();
    view.dispose();
  });

  it('handles the case where a body has no recorded color (fallback white)', async () => {
    const { bus, session, view, makeCube } = await makeFixture();
    bus.emit(EVENTS.PIECE_LOCK, {
      cells: [{ col: 0, row: 0 }],
      // color intentionally omitted
      side: 'player',
    });
    view.tick();
    // PhysicsSession defaults to 0xffffff when payload color is absent;
    // the view passes that through to makeCube unchanged.
    expect(makeCube).toHaveBeenCalledWith(0xffffff, { settling: true });
    session.stop();
    view.dispose();
  });

  it('tick is a no-op when session is not started', () => {
    const bus = new EventBus({ replayBufferSize: 0, recorderSize: 0 });
    const game = new Game({ rules: buildRules('physics'), bus, rng: seededRng(1) });
    const session = new PhysicsSession({ bus, game });
    // Do NOT call session.start()
    const view = new PhysicsBoardView({
      session, parent: new THREE.Group(), makeCube: makeCubeStub(),
    });
    expect(() => view.tick()).not.toThrow();
    expect(view.cubeCount).toBe(0);
  });

  it('uses cellToWorld bake to translate physics positions to scene world', async () => {
    const bus = new EventBus({ replayBufferSize: 0, recorderSize: 0 });
    const game = new Game({ rules: buildRules('physics'), bus, rng: seededRng(1) });
    const session = new PhysicsSession({ bus, game });
    await session.start();
    // Custom mapping: physics y becomes scene y * 2 (e.g. half-cell scaling).
    const cellToWorld = (c, r, d) => new THREE.Vector3(c * 2, r * 2, (d || 0) * 2);
    const view = new PhysicsBoardView({
      session, parent: new THREE.Group(), makeCube: makeCubeStub(), cellToWorld,
    });
    bus.emit(EVENTS.PIECE_LOCK, {
      cells: [{ col: 3, row: 7 }],
      color: 0xff0000, side: 'player',
    });
    view.tick();
    const mesh = [...view.stackGroup.children][0];
    expect(mesh.position.x).toBeCloseTo(3 * 2, 3);
    expect(mesh.position.y).toBeCloseTo(7 * 2, 3);
    session.stop();
    view.dispose();
  });
});

describe('PhysicsBoardView — dispose', () => {
  it('clears the mesh registry + detaches stackGroup from parent', async () => {
    const { parent, bus, session, view } = await makeFixture();
    bus.emit(EVENTS.PIECE_LOCK, {
      cells: [{ col: 0, row: 0 }, { col: 1, row: 0 }],
      color: 0xff0000, side: 'player',
    });
    view.tick();
    expect(view.cubeCount).toBe(2);
    view.dispose();
    expect(view.cubeCount).toBe(0);
    expect(view.stackGroup.parent).toBeNull();
    session.stop();
  });

  it('dispose is idempotent', async () => {
    const { view, session } = await makeFixture();
    expect(() => { view.dispose(); view.dispose(); }).not.toThrow();
    session.stop();
  });
});
