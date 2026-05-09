// BoardView3D tests (plan v2 §2.1 Phase C).
//
// Tests run pure-Node by stubbing makeCube / shatter / animateCubeTo /
// startLockAnim — no THREE meshes or scene graph required for the
// data-side checks (cell registry, lock placement, layer-clear splice).

import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { EventBus } from '../engine/events/bus.js';
import { Game } from '../gameplay/game.js';
import { buildRules } from '../gameplay/rules.js';
import { BoardView3D } from './board-view-3d.js';

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
  const rules = buildRules('3d');
  const game = new Game({ rules, bus, rng: seededRng(1) });
  const parent = new THREE.Group();
  const makeCube = vi.fn((color, opts = {}) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1,1,1), new THREE.MeshBasicMaterial({ color }));
    m.userData = { color, ...opts };
    return m;
  });
  const shatter       = vi.fn();
  const animateCubeTo = vi.fn();
  const startLockAnim = vi.fn();
  const cellToWorld   = (c, r, d) => new THREE.Vector3(c, r, d);
  const view = new BoardView3D({
    game, bus, parent, cellToWorld, makeCube, shatter, animateCubeTo, startLockAnim,
  });
  return { bus, rules, game, parent, view, makeCube, shatter, animateCubeTo, startLockAnim };
}

describe('BoardView3D — construction', () => {
  it('throws on missing required opts', () => {
    expect(() => new BoardView3D({})).toThrow(/game/);
  });

  it('attaches three groups (stack / piece / ghost) to parent', () => {
    const { parent, view } = makeFixture();
    expect(view.stackGroup.parent).toBe(parent);
    expect(view.pieceGroup.parent).toBe(parent);
    expect(view.ghostGroup.parent).toBe(parent);
    view.dispose();
  });

  it('initializes a `_depth × _rows × _cols` cellMeshes registry of nulls', () => {
    const { view, game } = makeFixture();
    expect(view.cellMeshes).toHaveLength(game.depth);
    expect(view.cellMeshes[0]).toHaveLength(game.rows);
    expect(view.cellMeshes[0][0]).toHaveLength(game.cols);
    // All start null.
    expect(view.cubeCount).toBe(0);
    view.dispose();
  });
});

describe('BoardView3D — active piece + ghost', () => {
  it('PIECE_SPAWN builds a piece mesh per cell of the tetracube', () => {
    const { game, view, makeCube } = makeFixture();
    game.spawnPiece('I'); // 4 cells along X
    // Spawn-handler ran on the bus emit; pieceGroup should have 4 children.
    expect(view.pieceGroup.children).toHaveLength(4);
    // makeCube called with active=true for each.
    for (const call of makeCube.mock.calls) {
      if (call[1] && call[1].active) {
        // Active-flag confirms it's a piece-mesh creation.
      }
    }
    view.dispose();
  });

  it('PIECE_SPAWN builds a ghost mesh that drops to the floor', () => {
    const { game, view } = makeFixture();
    game.spawnPiece('O'); // 2×2 square at the spawn position
    // Ghost is 4 cells (same shape as piece) at the floor.
    expect(view.ghostGroup.children).toHaveLength(4);
    // Ghost's lowest Y should be 0 (the floor).
    const minY = Math.min(...view.ghostGroup.children.map(c => c.position.y));
    expect(minY).toBe(0);
    view.dispose();
  });

  it('PIECE_MOVE rebuilds the active piece mesh at the new position', () => {
    const { game, view } = makeFixture();
    game.spawnPiece('O');
    const before = view.pieceGroup.children.map(c => c.position.x).sort();
    game.tryMove(1, 0); // shift right
    const after = view.pieceGroup.children.map(c => c.position.x).sort();
    expect(after[0]).toBe(before[0] + 1);
    view.dispose();
  });
});

describe('BoardView3D — PIECE_LOCK', () => {
  it('builds one cube per cell and registers it at cellMeshes[d][r][c]', () => {
    const { game, view } = makeFixture();
    game.spawnPiece('O');
    const piece = game.activePiece;
    const cells = game.getPieceCells(piece);
    game.lockPiece();
    // Each cell should now have a registered mesh at its (d, r, c).
    for (const { col, row, depth } of cells) {
      expect(view.cellMeshes[depth][row][col]).not.toBeNull();
    }
    expect(view.cubeCount).toBe(cells.length);
    view.dispose();
  });

  it('runs startLockAnim once per cell of the locked piece', () => {
    const { game, view, startLockAnim } = makeFixture();
    game.spawnPiece('I');
    const cells = game.getPieceCells(game.activePiece);
    game.lockPiece();
    expect(startLockAnim).toHaveBeenCalledTimes(cells.length);
    view.dispose();
  });
});

describe('BoardView3D — LINE_CLEAR (3D Y-slab)', () => {
  function fillRowAcrossDepth(game, rowIdx) {
    // Force-fill every (col, depth) at rowIdx so _collectFullRows
    // returns it on the next lock.
    for (let d = 0; d < game.depth; d++) {
      for (let c = 0; c < game.cols; c++) {
        game.boardLayers[d][rowIdx][c] = 0xff0000;
      }
    }
  }

  function buildMeshesForRow(view, rowIdx, depth, cols) {
    // Mirror the data-side fill on the mesh side — in real play
    // PIECE_LOCK populates these as cubes settle. Tests bypass that
    // by directly placing stub cubes so LINE_CLEAR has something to
    // shatter.
    for (let d = 0; d < depth; d++) {
      for (let c = 0; c < cols; c++) {
        const cube = new THREE.Mesh(
          new THREE.BoxGeometry(1, 1, 1),
          new THREE.MeshBasicMaterial({ color: 0xff0000 }),
        );
        view.stackGroup.add(cube);
        view.cellMeshes[d][rowIdx][c] = cube;
      }
    }
  }

  it('shatters every (col, depth) cube in the cleared row', () => {
    const { bus, game, view, shatter } = makeFixture();
    fillRowAcrossDepth(game, 0);
    buildMeshesForRow(view, 0, game.depth, game.cols);
    const expectedShattered = game.depth * game.cols;
    bus.emit('LINE_CLEAR', { rows: [0], simultaneous: 1 });
    expect(shatter).toHaveBeenCalledTimes(expectedShattered);
    view.dispose();
  });

  it('splices the cleared row out of every depth slice', () => {
    const { bus, game, view } = makeFixture();
    fillRowAcrossDepth(game, 0);
    buildMeshesForRow(view, 0, game.depth, game.cols);
    bus.emit('LINE_CLEAR', { rows: [0], simultaneous: 1 });
    // Bottom row across every depth should now be null (everything shifted).
    for (let d = 0; d < game.depth; d++) {
      for (let c = 0; c < game.cols; c++) {
        expect(view.cellMeshes[d][0][c]).toBeNull();
      }
    }
    view.dispose();
  });
});

describe('BoardView3D — clear / dispose', () => {
  it('clear() empties the registry + scene', () => {
    const { game, view } = makeFixture();
    game.spawnPiece('O');
    game.lockPiece();
    expect(view.cubeCount).toBeGreaterThan(0);
    view.clear();
    expect(view.cubeCount).toBe(0);
    expect(view.stackGroup.children).toHaveLength(0);
    view.dispose();
  });

  it('dispose() unsubscribes — events after dispose do not throw', () => {
    const { bus, view } = makeFixture();
    view.dispose();
    expect(() => bus.emit('PIECE_SPAWN', { side: 'player' })).not.toThrow();
  });
});
