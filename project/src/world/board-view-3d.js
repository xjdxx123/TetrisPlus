// BoardView3D — render side of one 3D Tetris Game (plan v2 §2.1
// Phase C, archived plan_gameplay_1.md §6.6).
//
// Mirrors the 2D `BoardView` contract — same constructor opts, same
// pieceGroup / ghostGroup / stackGroup public structure, same set of
// bus-driven handlers (PIECE_MOVE / PIECE_ROTATE / PIECE_SPAWN /
// PIECE_LOCK / LINE_CLEAR / ZEN_RESCUE) — but cells live in a 3D
// `cellMeshes[depth][row][col]` registry instead of the 2D
// `cellMeshes[row][col]` of legacy. The well is 10×10×20 by default;
// every cell is one 1×1×1 cube (no visual depth-3 sub-slicing — that's
// a 2D rendering trick to fake thickness, but in 3D the depth axis is
// real so a cell is a single cube).
//
// Pure render module: no Game internals beyond `game.activePiece`,
// `game.collides()`, `game.getPieceCells()` — read-only reads. Tests
// run pure-Node by stubbing makeCube + the animation hooks.
//
// Why a separate class instead of a 2D-3D-polymorphic BoardView: the
// 2D path has a depth-3 visual-slice loop that's not meaningful in 3D
// (where depth is a true axis), and the 2D LINE_CLEAR wraps a row
// splice that doesn't compose with 3D's full-Y-slab clear. Forking
// keeps each class focused — 2D BoardView untouched, 3D BoardView3D
// owns the 3D-shaped contract.

import * as THREE from 'three';
import { EVENTS } from '../gameplay/events.js';

const GARBAGE_COLOR = 0x808080;

/**
 * @typedef {Object} BoardView3DOpts
 * @property {import('../gameplay/game.js').Game} game
 *   Must have been constructed with the 3D rules pack
 *   (`pieceSet === 'tetracubes'`, depth > 1).
 * @property {import('../engine/events/bus.js').EventBus} bus
 * @property {THREE.Object3D} parent       Where to attach the three groups.
 * @property {string}  [side]              Tag — 'player' / 'opponent'.
 * @property {number}  [cols]              Default 10.
 * @property {number}  [rows]              Default 20.
 * @property {number}  [depth]             Default 10.
 * @property {(c:number, r:number, d:number) => THREE.Vector3} cellToWorld
 *   World-space center of the (col, row, d) cell.
 * @property {(color:number, opts?:any) => THREE.Mesh} makeCube
 *   Cube factory; same signature as the 2D BoardView's.
 * @property {(cube:THREE.Mesh) => void} shatter
 * @property {(cube:THREE.Mesh, target:THREE.Vector3) => void} animateCubeTo
 * @property {(cube:THREE.Mesh) => void} startLockAnim
 * @property {(name:string, arg?:any) => void} [playSfx]
 */

export class BoardView3D {
  /** @param {BoardView3DOpts} opts */
  constructor(opts) {
    if (!opts || !opts.game)  throw new Error('BoardView3D requires { game }');
    if (!opts.bus)            throw new Error('BoardView3D requires { bus }');
    if (!opts.parent)         throw new Error('BoardView3D requires { parent }');
    if (typeof opts.cellToWorld   !== 'function') throw new Error('BoardView3D requires cellToWorld');
    if (typeof opts.makeCube      !== 'function') throw new Error('BoardView3D requires makeCube');
    if (typeof opts.shatter       !== 'function') throw new Error('BoardView3D requires shatter');
    if (typeof opts.animateCubeTo !== 'function') throw new Error('BoardView3D requires animateCubeTo');
    if (typeof opts.startLockAnim !== 'function') throw new Error('BoardView3D requires startLockAnim');

    this._game  = opts.game;
    this._bus   = opts.bus;
    this._side  = opts.side  || 'player';
    this._cols  = opts.cols  || (this._game.cols  || 10);
    this._rows  = opts.rows  || (this._game.rows  || 20);
    this._depth = opts.depth || (this._game.depth || 10);

    this._cellToWorld   = opts.cellToWorld;
    this._makeCube      = opts.makeCube;
    this._shatter       = opts.shatter;
    this._animateCubeTo = opts.animateCubeTo;
    this._startLockAnim = opts.startLockAnim;
    this._playSfx       = opts.playSfx || (() => {});

    // THREE groups — public so the host can read pieceGroup.position
    // for any visual-inertia bobble (mirrors the 2D BoardView surface).
    this.stackGroup = new THREE.Group();
    this.pieceGroup = new THREE.Group();
    this.ghostGroup = new THREE.Group();
    this._parent = opts.parent;
    this._parent.add(this.stackGroup);
    this._parent.add(this.pieceGroup);
    this._parent.add(this.ghostGroup);

    // Mesh registry parallel to `game.boardLayers`. cellMeshes[d][r][c]
    // is either null or a single THREE.Mesh — one cube per cell. The
    // 2D BoardView stores `_depth` slices per cell to fake thickness;
    // we don't need that here because depth IS the third axis.
    this.cellMeshes = Array.from({ length: this._depth }, () =>
      Array.from({ length: this._rows }, () =>
        Array(this._cols).fill(null)
      )
    );

    this._unsubs = [];
    this._unsubs.push(this._bus.on(EVENTS.PIECE_MOVE,      (e) => this._onPieceMove(e)));
    this._unsubs.push(this._bus.on(EVENTS.PIECE_ROTATE,    () => this._onPieceRotate()));
    this._unsubs.push(this._bus.on(EVENTS.PIECE_SPAWN,     () => this._onPieceSpawn()));
    this._unsubs.push(this._bus.on(EVENTS.PIECE_LOCK,      (e) => this._onPieceLock(e)));
    this._unsubs.push(this._bus.on(EVENTS.LINE_CLEAR,      (e) => this._onLineClear(e)));
    this._unsubs.push(this._bus.on(EVENTS.GARBAGE_APPLIED, (e) => this._onGarbageApplied(e)));
    this._unsubs.push(this._bus.on(EVENTS.ZEN_RESCUE,      (e) => this._onZenRescue(e)));
    // Game.restore (rollback misprediction) — see BoardView's
    // counterpart for rationale. Rebuilds the entire mesh registry
    // from `game.board` so the rendered stack snaps to the snapshot
    // state before replay-forward starts incrementally mutating
    // cellMeshes again.
    this._unsubs.push(this._bus.on(EVENTS.STATE_RESTORED,  () => this._rebuildFromGame()));
  }

  /**
   * Wipe + rebuild the entire 3D stack mesh from `this._game.board`.
   * 3D analog of BoardView._rebuildFromGame — game.board returns the
   * full `[depth][row][col]` array so we walk every depth slice.
   */
  _rebuildFromGame() {
    if (!this._game) return;
    this.clear();
    // Use `boardLayers` (full 3D `[d][r][c]`) — `board` would only
    // give us the front depth slice. 2D modes have depth=1 so the
    // outer loop runs once; 3D rebuilds every depth slice.
    const layers = this._game.boardLayers;
    if (!Array.isArray(layers)) return;
    for (let d = 0; d < this._depth; d++) {
      const layer = layers[d];
      if (!Array.isArray(layer)) continue;
      for (let r = 0; r < this._rows; r++) {
        const rowArr = layer[r];
        if (!Array.isArray(rowArr)) continue;
        for (let c = 0; c < this._cols; c++) {
          const color = rowArr[c];
          if (color == null) continue;
          const cube = this._makeCube(color);
          cube.position.copy(this._cellToWorld(c, r, d));
          this.stackGroup.add(cube);
          this.cellMeshes[d][r][c] = cube;
        }
      }
    }
    this.rebuildPieceMesh();
    this.rebuildGhostMesh();
  }

  // ─── Public API ──────────────────────────────────────────────────────

  /**
   * Build the active piece's cubes from the current `game.activePiece`.
   * One cube per (col, row, depth) cell.
   */
  rebuildPieceMesh() {
    this.pieceGroup.clear();
    const p = this._game && this._game.activePiece;
    if (!p) return;
    const cells = this._game.getPieceCells(p);
    for (const { col, row, depth } of cells) {
      const cube = this._makeCube(p.color, { active: true });
      cube.position.copy(this._cellToWorld(col, row, depth));
      this.pieceGroup.add(cube);
    }
  }

  /**
   * Ghost projection — render the piece's silhouette at the row it
   * would lock into if dropped now. The drop axis is Y (row);
   * collide-down until further drop would intersect.
   */
  rebuildGhostMesh() {
    this.ghostGroup.clear();
    const p = this._game && this._game.activePiece;
    if (!p) return;
    let r = p.row;
    while (!this._game.collides(p, p.col, r - 1, p.rot)) r--;
    const ghost = { ...p, row: r };
    const cells = this._game.getPieceCells(ghost);
    for (const { col, row, depth } of cells) {
      const cube = this._makeCube(p.color, { ghost: true });
      cube.position.copy(this._cellToWorld(col, row, depth));
      this.ghostGroup.add(cube);
    }
  }

  /**
   * Hard-reset all mesh state. Called from the host's resetRunState
   * before `game.reset()` so a Play-Again starts from a known empty
   * scene.
   */
  clear() {
    for (let d = 0; d < this._depth; d++) {
      for (let r = 0; r < this._rows; r++) {
        for (let c = 0; c < this._cols; c++) {
          const cube = this.cellMeshes[d][r][c];
          if (cube) {
            this.stackGroup.remove(cube);
            this.cellMeshes[d][r][c] = null;
          }
        }
      }
    }
    this.stackGroup.clear();
    this.pieceGroup.clear();
    this.ghostGroup.clear();
  }

  /** Tear down — unsubscribe + detach groups. */
  dispose() {
    for (const u of this._unsubs) {
      try { u(); } catch { /* ignore */ }
    }
    this._unsubs.length = 0;
    this.clear();
    if (this._parent) {
      this._parent.remove(this.stackGroup);
      this._parent.remove(this.pieceGroup);
      this._parent.remove(this.ghostGroup);
    }
    this._game = null;
  }

  // ─── Read-only diagnostics (test surface) ────────────────────────────

  get cubeCount() {
    let n = 0;
    for (let d = 0; d < this._depth; d++) {
      for (let r = 0; r < this._rows; r++) {
        for (let c = 0; c < this._cols; c++) {
          if (this.cellMeshes[d][r][c]) n++;
        }
      }
    }
    return n;
  }

  // ─── Bus handlers (private) ──────────────────────────────────────────

  _onPieceMove({ dCol }) {
    this.rebuildPieceMesh();
    this.rebuildGhostMesh();
    if (dCol !== 0) this._playSfx('move');
  }

  _onPieceRotate() {
    this.rebuildPieceMesh();
    this.rebuildGhostMesh();
    this._playSfx('rotate');
  }

  _onPieceSpawn() {
    this.rebuildPieceMesh();
    this.rebuildGhostMesh();
  }

  /**
   * PIECE_LOCK — `cells` carries `{col, row, depth}` triples in 3D.
   * Build one mesh per cell, register it in cellMeshes, run the
   * settle animation. The 2D BoardView wraps an inner depth-3 loop
   * for visual thickness; in 3D the depth IS the cell index, so each
   * cell is a single cube.
   */
  _onPieceLock({ cells, color }) {
    for (const cell of cells) {
      const col   = cell.col;
      const row   = cell.row;
      const depth = (cell.depth | 0);
      if (row >= this._rows) continue;        // safety — Game already topped out
      if (depth < 0 || depth >= this._depth) continue;
      const cube = this._makeCube(color, { settling: true });
      cube.position.copy(this._cellToWorld(col, row, depth));
      this.stackGroup.add(cube);
      this._startLockAnim(cube);
      this.cellMeshes[depth][row][col] = cube;
    }
  }

  /**
   * LINE_CLEAR — Game's clearLines emit fires *before* it splices its
   * board, so cellMeshes still has the full Y-slab when we run.
   * Shatter every (col, depth) cube in each cleared row, splice the
   * cleared row out of EACH depth slice, then animate survivors down.
   */
  _onLineClear({ rows, simultaneous }) {
    this._playSfx('clear', simultaneous);

    // Shatter the cleared rows across every depth slice.
    for (const r of rows) {
      for (let d = 0; d < this._depth; d++) {
        for (let c = 0; c < this._cols; c++) {
          const cube = this.cellMeshes[d][r][c];
          if (cube) {
            this._shatter(cube);
            this.stackGroup.remove(cube);
            this.cellMeshes[d][r][c] = null;
          }
        }
      }
    }

    // Splice each cleared row out of every depth slice + push a fresh
    // empty row at the top. Sort top-down so the splice indices stay
    // valid as we mutate.
    const rowsDescending = rows.slice().sort((a, b) => b - a);
    for (const r of rowsDescending) {
      for (let d = 0; d < this._depth; d++) {
        this.cellMeshes[d].splice(r, 1);
        this.cellMeshes[d].push(Array(this._cols).fill(null));
      }
    }

    // Animate every surviving cube to its new world-space position.
    for (let d = 0; d < this._depth; d++) {
      for (let r = 0; r < this._rows; r++) {
        for (let c = 0; c < this._cols; c++) {
          const cube = this.cellMeshes[d][r][c];
          if (!cube) continue;
          this._animateCubeTo(cube, this._cellToWorld(c, r, d));
        }
      }
    }
  }

  /**
   * GARBAGE_APPLIED — pop top row + push garbage at bottom. 3D version
   * applies the same operation to every depth slice (every (col, depth)
   * gets the same hole column for navigability).
   */
  _onGarbageApplied({ rows, holeColumn }) {
    const safeHole = ((holeColumn % this._cols) + this._cols) % this._cols;
    for (let i = 0; i < rows; i++) {
      // Pop top row of every depth slice.
      for (let d = 0; d < this._depth; d++) {
        const top = this.cellMeshes[d].pop();
        if (top) {
          for (let c = 0; c < this._cols; c++) {
            const cube = top[c];
            if (cube) this.stackGroup.remove(cube);
          }
        }
        // Build a new bottom row for this depth.
        const newRow = new Array(this._cols).fill(null);
        for (let c = 0; c < this._cols; c++) {
          if (c === safeHole) continue;
          const cube = this._makeCube(GARBAGE_COLOR);
          cube.position.copy(this._cellToWorld(c, 0, d));
          this.stackGroup.add(cube);
          newRow[c] = cube;
        }
        this.cellMeshes[d].unshift(newRow);
      }
    }
    // Animate survivors to their new positions.
    for (let d = 0; d < this._depth; d++) {
      for (let r = 0; r < this._rows; r++) {
        for (let c = 0; c < this._cols; c++) {
          const cube = this.cellMeshes[d][r][c];
          if (!cube) continue;
          this._animateCubeTo(cube, this._cellToWorld(c, r, d));
        }
      }
    }
  }

  /**
   * ZEN_RESCUE — remove `rowsRemoved` rows from the bottom + shift the
   * stack down. Mirrors Game.shiftStackDown across every depth slice.
   */
  _onZenRescue({ rowsRemoved }) {
    for (let i = 0; i < rowsRemoved; i++) {
      for (let d = 0; d < this._depth; d++) {
        const removed = this.cellMeshes[d].splice(0, 1)[0];
        if (removed) {
          for (let c = 0; c < this._cols; c++) {
            const cube = removed[c];
            if (cube) this.stackGroup.remove(cube);
          }
        }
        this.cellMeshes[d].push(Array(this._cols).fill(null));
      }
    }
    for (let d = 0; d < this._depth; d++) {
      for (let r = 0; r < this._rows; r++) {
        for (let c = 0; c < this._cols; c++) {
          const cube = this.cellMeshes[d][r][c];
          if (!cube) continue;
          this._animateCubeTo(cube, this._cellToWorld(c, r, d));
        }
      }
    }
  }
}
