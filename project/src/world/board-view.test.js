// Tests for BoardView — the render mirror of one Game instance
// (plan_gameplay_1.md §3.7 sub-phase 7b). Exercises the bus-driven
// reconcile path: PIECE_SPAWN / LOCK / LINE_CLEAR / GARBAGE_APPLIED /
// ZEN_RESCUE all keep cellMeshes consistent with the data board.
//
// THREE is mocked locally because vitest runs in pure Node and three.js
// expects a WebGL context for some imports. We only use Object3D-shaped
// stubs (parent, add, remove, clear, position, children).

import { describe, it, expect, vi } from 'vitest';
import { BoardView } from './board-view.js';
import { Game } from '../gameplay/game.js';
import { buildRules } from '../gameplay/rules.js';
import { EVENTS } from '../gameplay/events.js';
import { EventBus } from '../engine/events/bus.js';

// Replace THREE.Group inside BoardView's module via vi.mock — the test
// runs in pure Node without a WebGL context. The factory is hoisted, so
// the stub classes have to be defined inline (no outer references).
vi.mock('three', () => {
  class FakeVec3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    clone() { return new FakeVec3(this.x, this.y, this.z); }
  }
  class FakeGroup {
    constructor() {
      this.children = [];
      this.parent = null;
      this.position = new FakeVec3();
      this.rotation = { z: 0 };
    }
    add(c)    { this.children.push(c); c.parent = this; }
    remove(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parent = null; }
    clear()   { for (const c of this.children) c.parent = null; this.children.length = 0; }
  }
  return { Group: FakeGroup, Vector3: FakeVec3 };
});

// Test-side helpers (not in the mock factory — these are used after the
// mock is set up). They mirror the THREE-mock shapes for cubes /
// fake parents in the harness below.
class FakeVec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
}
class FakeGroup {
  constructor() {
    this.children = [];
    this.parent = null;
    this.position = new FakeVec3();
    this.rotation = { z: 0 };
  }
  add(c)    { this.children.push(c); c.parent = this; }
  remove(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parent = null; }
  clear()   { for (const c of this.children) c.parent = null; this.children.length = 0; }
}

function buildHarness({ rules } = {}) {
  const bus  = new EventBus({ replayBufferSize: 0, recorderSize: 0 });
  const game = new Game({ rules: rules || buildRules('classic'), bus });
  const parent = new FakeGroup();
  // Counter-style fakes for the host-injected helpers.
  const cubeFactoryCalls = [];
  const animateCalls     = [];
  const shatterCalls     = [];
  const lockAnimCalls    = [];
  const sfxCalls         = [];
  const cellToWorld = (c, r, d) => new FakeVec3(c, r, d);
  const makeCube = (color, opts = {}) => {
    const cube = { position: new FakeVec3(), userData: { color }, opts };
    cubeFactoryCalls.push({ color, opts });
    return cube;
  };
  const view = new BoardView({
    game, bus, parent,
    cellToWorld,
    makeCube,
    shatter: (cube) => shatterCalls.push(cube),
    animateCubeTo: (cube, target) => animateCalls.push({ cube, target }),
    startLockAnim: (cube) => lockAnimCalls.push(cube),
    playSfx: (name, count) => sfxCalls.push({ name, count }),
  });
  return { bus, game, parent, view, cubeFactoryCalls, animateCalls, shatterCalls, lockAnimCalls, sfxCalls };
}

// ─── Construction ─────────────────────────────────────────────────────

describe('BoardView — construction', () => {
  it('throws on missing required deps', () => {
    expect(() => new BoardView({})).toThrow(/game/);
    expect(() => new BoardView({ game: {} })).toThrow(/bus/);
  });

  it('attaches stack/piece/ghost groups to parent', () => {
    const { parent, view } = buildHarness();
    expect(parent.children).toContain(view.stackGroup);
    expect(parent.children).toContain(view.pieceGroup);
    expect(parent.children).toContain(view.ghostGroup);
  });

  it('initializes a 20×10 cellMeshes registry of nulls', () => {
    const { view } = buildHarness();
    expect(view.cellMeshes.length).toBe(20);
    expect(view.cellMeshes[0].length).toBe(10);
    expect(view.cellMeshes.flat().every(c => c === null)).toBe(true);
  });
});

// ─── Spawn / move / rotate ────────────────────────────────────────────

describe('BoardView — piece + ghost rebuild on spawn/move/rotate', () => {
  it('rebuilds piece + ghost mesh on PIECE_SPAWN', () => {
    const { view, game } = buildHarness();
    expect(view.pieceGroup.children.length).toBe(0);
    game.spawnPiece('T');
    // T piece: 4 cells × 3 depth = 12 cubes in pieceGroup
    expect(view.pieceGroup.children.length).toBe(12);
    expect(view.ghostGroup.children.length).toBe(12);
  });

  it('rebuilds on PIECE_MOVE; sfx fires only for horizontal moves', () => {
    const { view, game, sfxCalls } = buildHarness();
    game.spawnPiece('T');
    sfxCalls.length = 0;
    game.tryMove(0, -1); // gravity step — silent
    game.tryMove(1, 0);  // sideways — sfx
    expect(view.pieceGroup.children.length).toBe(12);
    const moveSfx = sfxCalls.filter(c => c.name === 'move');
    expect(moveSfx.length).toBe(1);
  });

  it('rebuilds on PIECE_ROTATE and emits rotate sfx', () => {
    const { view, game, sfxCalls } = buildHarness();
    game.spawnPiece('T');
    sfxCalls.length = 0;
    game.tryRotate(1);
    expect(view.pieceGroup.children.length).toBe(12);
    expect(sfxCalls.some(c => c.name === 'rotate')).toBe(true);
  });
});

// ─── Lock ─────────────────────────────────────────────────────────────

describe('BoardView — PIECE_LOCK creates settling cubes', () => {
  it('writes settling cubes into cellMeshes for each locked cell', () => {
    const { view, game, lockAnimCalls } = buildHarness();
    game.spawnPiece('O');
    game.hardDrop();
    game.lockPiece();
    // O = 4 cells × 3 depth = 12 settling cubes registered in cellMeshes.
    let count = 0;
    for (let r = 0; r < 20; r++) for (let c = 0; c < 10; c++) {
      if (view.cellMeshes[r][c]) count += view.cellMeshes[r][c].length;
    }
    expect(count).toBe(12);
    expect(lockAnimCalls.length).toBe(12);
  });
});

// ─── Line clear ───────────────────────────────────────────────────────

describe('BoardView — LINE_CLEAR shatter + splice + animate', () => {
  it('shatters cubes in cleared rows and animates remaining stack', () => {
    const { bus, game, view, shatterCalls, animateCalls } = buildHarness();
    // Pre-populate a row of cubes (mimicking a prior lock).
    for (let c = 0; c < 10; c++) {
      view.cellMeshes[0][c] = [
        { userData: { color: 0xff0000 } },
        { userData: { color: 0xff0000 } },
        { userData: { color: 0xff0000 } },
      ];
      view.stackGroup.add(view.cellMeshes[0][c][0]);
    }
    // Fire LINE_CLEAR for row 0.
    bus.emit(EVENTS.LINE_CLEAR, {
      rows: [0],
      simultaneous: 1,
      colors: [0xff0000],
      overallColor: 0xff0000,
      scoreDelta: 100,
      side: 'player',
    });
    // 30 cubes shattered (10 cells × 3 depth)
    expect(shatterCalls.length).toBe(30);
    // cellMeshes splice: row 0 removed, rest shift down. Top becomes null.
    expect(view.cellMeshes[19].every(c => c === null)).toBe(true);
    // No remaining cubes to animate (we only seeded row 0)
    expect(animateCalls.length).toBe(0);
    // Use game in this scope so unused-arg lint stays clean.
    expect(game.score).toBe(0);
  });
});

// ─── Garbage applied ──────────────────────────────────────────────────

describe('BoardView — GARBAGE_APPLIED mirrors data shift', () => {
  it('inserts a garbage row mesh at the bottom and animates survivors', () => {
    const { bus, view, animateCalls } = buildHarness();
    // Seed a single cube in row 0 so we can verify it animates upward.
    view.cellMeshes[0][3] = [{ userData: { color: 0xabcdef } }];
    view.stackGroup.add(view.cellMeshes[0][3][0]);
    bus.emit(EVENTS.GARBAGE_APPLIED, { rows: 1, holeColumn: 5, side: 'player' });
    // After garbage applied: new row 0 is the garbage row (9 cells of cube,
    // hole at col 5). Old row 0 is now at row 1 — animateCalls should
    // include a target for that surviving cube.
    const garbageCells = view.cellMeshes[0].filter(c => c !== null).length;
    expect(garbageCells).toBe(9);
    expect(view.cellMeshes[0][5]).toBeNull();
    // The seeded cube (now at row 1) gets animated upward.
    expect(animateCalls.length).toBeGreaterThan(0);
  });
});

// ─── Zen rescue ───────────────────────────────────────────────────────

describe('BoardView — ZEN_RESCUE shifts mesh rows down', () => {
  it('disposes bottom rows + animates survivors', () => {
    const { bus, view, animateCalls } = buildHarness();
    // Seed row 0 + row 5 with cubes so we can verify the shift.
    view.cellMeshes[0][0] = [{ userData: { color: 0x111111 } }];
    view.cellMeshes[5][0] = [{ userData: { color: 0x222222 } }];
    view.stackGroup.add(view.cellMeshes[0][0][0]);
    view.stackGroup.add(view.cellMeshes[5][0][0]);
    bus.emit(EVENTS.ZEN_RESCUE, { rowsRemoved: 2, side: 'player' });
    // Bottom 2 rows removed → row 5 was shifted to row 3.
    expect(view.cellMeshes[3][0]).not.toBeNull();
    expect(view.cellMeshes[3][0][0].userData.color).toBe(0x222222);
    expect(animateCalls.length).toBeGreaterThan(0);
  });
});

// ─── Reset / dispose ──────────────────────────────────────────────────

describe('BoardView — clear + dispose', () => {
  it('clear() empties cellMeshes and the three groups', () => {
    const { view, game } = buildHarness();
    game.spawnPiece('T');
    game.hardDrop();
    game.lockPiece();
    expect(view.pieceGroup.children.length).toBeGreaterThan(0);

    view.clear();
    expect(view.pieceGroup.children.length).toBe(0);
    expect(view.ghostGroup.children.length).toBe(0);
    expect(view.stackGroup.children.length).toBe(0);
    expect(view.cellMeshes.flat().every(c => c === null)).toBe(true);
  });

  it('dispose unsubscribes from the bus + removes groups from parent', () => {
    const { bus, view, parent } = buildHarness();
    view.dispose();
    // Re-emitting after dispose is a no-op for this view.
    const beforeChildren = parent.children.length;
    bus.emit(EVENTS.LINE_CLEAR, { rows: [], simultaneous: 0, colors: [], overallColor: 0, scoreDelta: 0 });
    expect(parent.children.length).toBe(beforeChildren);
    // Groups removed from parent.
    expect(parent.children).not.toContain(view.stackGroup);
    expect(parent.children).not.toContain(view.pieceGroup);
    expect(parent.children).not.toContain(view.ghostGroup);
  });
});
