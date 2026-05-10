// BoardView — render side of one Game instance (plan_gameplay_1.md §3.7.6).
//
// Owns the THREE.Groups + per-cell mesh registry that mirror the data
// board in `Game._board`. Subscribes to gameplay events on the bus and
// reconciles cube state in response: spawn → rebuild active piece mesh,
// lock → settling cubes appear, line clear → shatter + animate down,
// garbage → push the stack up, zen rescue → shift down. The host owns
// the cube factory, the animation queues, and the cinematic FX layer
// (callout, slowmo, shake, popup) — those are ALSO subscribed to the
// same events but live outside BoardView so dual-board / 3D variants
// don't have to duplicate them.
//
// Why this exists: phase 7a left the bus subscribers in main.js but the
// state they mutate (cellMeshes + the three groups) was still module-
// scope. For Versus v2 (§7e) we need TWO independent simulations + TWO
// independent mesh sets — the two have to be tied together by class
// instance, not by shared module-scope data. BoardView is that class.
//
// Pure render module: no Game internals beyond `game.activePiece`,
// `game.collides()`, `game.getPieceCells()` — read-only reads. State
// mutations always go through Game's public API; BoardView only
// reflects what Game has already done.

import * as THREE from 'three';
import { EVENTS } from '../gameplay/events.js';

const GARBAGE_COLOR = 0x808080;

/**
 * @typedef {Object} BoardViewOpts
 * @property {import('../gameplay/game.js').Game} game
 * @property {import('../engine/events/bus.js').EventBus} bus
 * @property {THREE.Object3D} parent      Where to add the three groups.
 * @property {string}  [side]             Tag — 'player' / 'opponent'.
 * @property {number}  [cols]             Default 10.
 * @property {number}  [rows]             Default 20.
 * @property {number}  [depth]            Cube slices per cell. Default 3.
 * @property {(c:number, r:number, d:number) => THREE.Vector3} cellToWorld
 *   World position of the (col, row, depth) cell — host-owned because it
 *   bakes in scene-specific PLAY_W / PLAY_H / CELL constants.
 * @property {(color:number, opts?:any) => THREE.Mesh} makeCube
 *   Cube factory; opts include `{ active, settling, ghost }` style flags.
 * @property {(cube:THREE.Mesh) => void} shatter
 *   Particle-burst the cube on line-clear. Host owns the shard pool.
 * @property {(cube:THREE.Mesh, target:THREE.Vector3) => void} animateCubeTo
 *   Schedule a tween from the cube's current world position to `target`.
 * @property {(cube:THREE.Mesh) => void} startLockAnim
 *   Squash-and-stretch settle animation for a freshly-locked cube.
 * @property {(name:string, arg?:any) => void} [playSfx]
 *   Optional — `move` / `rotate` / `clear` cues. No-op if omitted (so
 *   tests / future headless replay viewers can construct without audio).
 * @property {boolean} [noLockMeshes]
 *   Optional — when true, BoardView skips creating static cubes on
 *   PIECE_LOCK and skips processing LINE_CLEAR / GARBAGE_APPLIED /
 *   ZEN_RESCUE events that would mutate the cellMeshes registry.
 *   Used by Pure Physics mode (plan v2 §2.3 F+) where `PhysicsBoardView`
 *   owns the locked-cube rendering — bodies move under gravity, so the
 *   grid-locked rendering would be incorrect. Active piece + ghost
 *   rendering still happens; only the post-lock cube management is
 *   suppressed. Default false.
 */

export class BoardView {
  /** @param {BoardViewOpts} opts */
  constructor(opts) {
    if (!opts || !opts.game) throw new Error('BoardView requires { game }');
    if (!opts.bus)   throw new Error('BoardView requires { bus }');
    if (!opts.parent) throw new Error('BoardView requires { parent }');
    if (typeof opts.cellToWorld !== 'function')   throw new Error('BoardView requires cellToWorld');
    if (typeof opts.makeCube !== 'function')      throw new Error('BoardView requires makeCube');
    if (typeof opts.shatter !== 'function')       throw new Error('BoardView requires shatter');
    if (typeof opts.animateCubeTo !== 'function') throw new Error('BoardView requires animateCubeTo');
    if (typeof opts.startLockAnim !== 'function') throw new Error('BoardView requires startLockAnim');

    this._game  = opts.game;
    this._bus   = opts.bus;
    this._side  = opts.side  || 'player';
    this._cols  = opts.cols  || 10;
    this._rows  = opts.rows  || 20;
    this._depth = opts.depth || 3;

    this._cellToWorld   = opts.cellToWorld;
    this._makeCube      = opts.makeCube;
    this._shatter       = opts.shatter;
    this._animateCubeTo = opts.animateCubeTo;
    this._startLockAnim = opts.startLockAnim;
    this._playSfx       = opts.playSfx || (() => {});
    this._noLockMeshes  = !!opts.noLockMeshes;

    // THREE groups — public so the host can read pieceGroup.position to
    // apply visual inertia without going through this module. They're
    // added to `parent` here and removed in dispose().
    this.stackGroup = new THREE.Group();
    this.pieceGroup = new THREE.Group();
    this.ghostGroup = new THREE.Group();
    this._parent = opts.parent;
    this._parent.add(this.stackGroup);
    this._parent.add(this.pieceGroup);
    this._parent.add(this.ghostGroup);

    // Mesh registry parallel to `game.board`. cellMeshes[r][c] is either
    // null or an array of `_depth` cube meshes. Public so the host's
    // game-over cascade can iterate it.
    this.cellMeshes = Array.from({ length: this._rows }, () => Array(this._cols).fill(null));

    // Subscribe to gameplay events. The host runs separate subscribers
    // for cinematic / HUD / inertia concerns — those stay in main.js so
    // dual-board doesn't double-fire them.
    this._unsubs = [];
    this._unsubs.push(this._bus.on(EVENTS.PIECE_MOVE,      (e) => this._onPieceMove(e)));
    this._unsubs.push(this._bus.on(EVENTS.PIECE_ROTATE,    () => this._onPieceRotate()));
    this._unsubs.push(this._bus.on(EVENTS.PIECE_SPAWN,     () => this._onPieceSpawn()));
    // Lock + line-clear + garbage + rescue handlers are gated by
    // `noLockMeshes` — physics mode (plan v2 §2.3 F+) replaces them
    // with `PhysicsBoardView`, which renders cubes from physics body
    // positions instead of the grid. Active piece + ghost rendering
    // remains via the unconditional handlers above.
    if (!this._noLockMeshes) {
      this._unsubs.push(this._bus.on(EVENTS.PIECE_LOCK,      (e) => this._onPieceLock(e)));
      this._unsubs.push(this._bus.on(EVENTS.LINE_CLEAR,      (e) => this._onLineClear(e)));
      this._unsubs.push(this._bus.on(EVENTS.GARBAGE_APPLIED, (e) => this._onGarbageApplied(e)));
      this._unsubs.push(this._bus.on(EVENTS.ZEN_RESCUE,      (e) => this._onZenRescue(e)));
      // Game.restore (called by the rollback engine on misprediction)
      // bulk-overwrites simulation state. The incremental event stream
      // we accumulate from misses the rewind — without this hook our
      // cellMeshes drift out of sync with game.board, and subsequent
      // events stack on top of the stale state. Rebuilding from
      // game.board on STATE_RESTORED clamps the mesh side back to
      // whatever the simulation just restored to.
      this._unsubs.push(this._bus.on(EVENTS.STATE_RESTORED,  () => this._rebuildFromGame()));
    }
  }

  /**
   * Wipe + rebuild the entire stack mesh from `this._game.board`.
   * Triggered by STATE_RESTORED (rollback's restore-then-replay-forward
   * pattern). The replay's incremental events (PIECE_LOCK / LINE_CLEAR /
   * GARBAGE_APPLIED) fire AFTER this rebuild and pick up where the
   * snapshot leaves off, keeping mesh + data aligned through the
   * remaining replay steps.
   */
  _rebuildFromGame() {
    if (!this._game) return;
    // Tear down all stack cubes — clear() also wipes pieceGroup +
    // ghostGroup, which we'll rebuild via the existing helpers below.
    this.clear();
    // Re-create cubes for every non-null cell in game.board. 2D modes
    // have depth=1 so the outer loop runs once; 3D mode rebuilds all
    // depth slices (this BoardView class is the 2D path — 3D goes
    // through BoardView3D which has its own rebuild).
    const board = this._game.board;
    if (Array.isArray(board)) {
      for (let r = 0; r < this._rows; r++) {
        for (let c = 0; c < this._cols; c++) {
          // 2D `Game.board` getter returns `this._board[0]` — the front
          // depth slice — so `board[r][c]` is the color or null.
          const color = (board[r] && board[r][c] != null) ? board[r][c] : null;
          if (color == null) continue;
          const slices = [];
          for (let d = 0; d < this._depth; d++) {
            const cube = this._makeCube(color);
            cube.position.copy(this._cellToWorld(c, r, d));
            this.stackGroup.add(cube);
            slices.push(cube);
          }
          this.cellMeshes[r][c] = slices;
        }
      }
    }
    // Active piece + ghost — incremental events would have caught up
    // mid-replay, but rebuilding here makes the post-restore frame
    // visually consistent even before any subsequent input replays.
    this.rebuildPieceMesh();
    this.rebuildGhostMesh();
  }

  // ─── Public API ──────────────────────────────────────────────────────

  /**
   * Build the active piece's cubes from the current `game.activePiece`.
   * Also called from the host after construction to render the seeded
   * first piece (PIECE_SPAWN already fired during boot's spawnPiece, but
   * if BoardView was constructed *after* that emit, the listener missed
   * it — call this once explicitly).
   */
  rebuildPieceMesh() {
    this.pieceGroup.clear();
    const p = this._game && this._game.activePiece;
    if (!p) return;
    const cells = this._game.getPieceCells(p);
    for (const { col, row } of cells) {
      for (let d = 0; d < this._depth; d++) {
        const cube = this._makeCube(p.color, { active: true });
        cube.position.copy(this._cellToWorld(col, row, d));
        this.pieceGroup.add(cube);
      }
    }
  }

  /**
   * Build the ghost projection — the silhouette at the row the active
   * piece would lock into if dropped now.
   */
  rebuildGhostMesh() {
    this.ghostGroup.clear();
    const p = this._game && this._game.activePiece;
    if (!p) return;
    let r = p.row;
    while (!this._game.collides(p, p.col, r - 1, p.rot)) r--;
    const ghost = { ...p, row: r };
    const cells = this._game.getPieceCells(ghost);
    for (const { col, row } of cells) {
      for (let d = 0; d < this._depth; d++) {
        const cube = this._makeCube(p.color, { ghost: true });
        cube.position.copy(this._cellToWorld(col, row, d));
        this.ghostGroup.add(cube);
      }
    }
  }

  /**
   * Hard-reset all mesh state. Called from the host's resetRunState
   * before `game.reset()` so a Play-Again starts from a known empty
   * scene. The cellMeshes registry is nulled in place; the THREE groups
   * are cleared. Game's reset() will spawn the first piece, which fires
   * PIECE_SPAWN, which rebuilds the piece mesh in this view.
   */
  clear() {
    for (let r = 0; r < this._rows; r++) {
      for (let c = 0; c < this._cols; c++) {
        if (this.cellMeshes[r][c]) {
          for (const cube of this.cellMeshes[r][c]) this.stackGroup.remove(cube);
          this.cellMeshes[r][c] = null;
        }
      }
    }
    this.stackGroup.clear();
    this.pieceGroup.clear();
    this.ghostGroup.clear();
  }

  /**
   * Tear down. Unsubscribes the bus listeners and removes the three
   * groups from their parent. Called when a Game is replaced (mode swap)
   * or before app teardown.
   */
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

  _onPieceLock({ cells, color }) {
    for (const { col, row } of cells) {
      if (row >= this._rows) continue; // safety — Game already topped out
      const slices = [];
      for (let d = 0; d < this._depth; d++) {
        const cube = this._makeCube(color, { settling: true });
        cube.position.copy(this._cellToWorld(col, row, d));
        this.stackGroup.add(cube);
        slices.push(cube);
        this._startLockAnim(cube);
      }
      this.cellMeshes[row][col] = slices;
    }
  }

  /**
   * LINE_CLEAR — Game's clearLines emit fires *before* it splices its
   * board, so cellMeshes still has the cleared-row cubes when we run.
   * We shatter + null those entries, then mirror Game's row splice on
   * cellMeshes, then animate the surviving cubes down to their new
   * world positions.
   */
  _onLineClear({ rows, simultaneous }) {
    this._playSfx('clear', simultaneous);
    for (const r of rows) {
      for (let c = 0; c < this._cols; c++) {
        const slices = this.cellMeshes[r][c];
        if (slices) {
          for (const cube of slices) {
            this._shatter(cube);
            this.stackGroup.remove(cube);
          }
          this.cellMeshes[r][c] = null;
        }
      }
    }
    // Mirror Game.clearLines: splice cleared rows in DESCENDING order
    // so the array shift from each splice doesn't move the next
    // target. Iterating ascending would silently skip every other
    // cleared row (Tetris-clear of [3,4,5,6] would land as [3,5,7,9],
    // leaving phantom mesh blocks at rows 4/6/8 — and Game.clearLines
    // had the SAME bug at the data side, so they stayed in sync but
    // both were wrong).
    const sortedRows = [...rows].sort((a, b) => b - a);
    for (const r of sortedRows) {
      this.cellMeshes.splice(r, 1);
      this.cellMeshes.push(Array(this._cols).fill(null));
    }
    for (let r = 0; r < this._rows; r++) {
      for (let c = 0; c < this._cols; c++) {
        const slices = this.cellMeshes[r][c];
        if (!slices) continue;
        for (let d = 0; d < this._depth; d++) {
          this._animateCubeTo(slices[d], this._cellToWorld(c, r, d));
        }
      }
    }
  }

  /**
   * GARBAGE_APPLIED — Game popped its top board row and unshifted a
   * fresh garbage row at the bottom. Mirror on the mesh side: dispose
   * the popped top cubes, build new garbage cubes at row 0, animate
   * the survivors upward.
   */
  _onGarbageApplied({ rows, holeColumn }) {
    const safeHole = ((holeColumn % this._cols) + this._cols) % this._cols;
    for (let i = 0; i < rows; i++) {
      const topMeshes = this.cellMeshes.pop();
      if (topMeshes) {
        for (let c = 0; c < this._cols; c++) {
          const slices = topMeshes[c];
          if (slices) for (const cube of slices) this.stackGroup.remove(cube);
        }
      }
      const newMeshRow = new Array(this._cols).fill(null);
      for (let c = 0; c < this._cols; c++) {
        if (c === safeHole) continue;
        const slices = [];
        for (let d = 0; d < this._depth; d++) {
          const cube = this._makeCube(GARBAGE_COLOR);
          cube.position.copy(this._cellToWorld(c, 0, d));
          this.stackGroup.add(cube);
          slices.push(cube);
        }
        newMeshRow[c] = slices;
      }
      this.cellMeshes.unshift(newMeshRow);
    }
    for (let r = 0; r < this._rows; r++) {
      for (let c = 0; c < this._cols; c++) {
        const slices = this.cellMeshes[r][c];
        if (!slices) continue;
        for (let d = 0; d < this._depth; d++) {
          this._animateCubeTo(slices[d], this._cellToWorld(c, r, d));
        }
      }
    }
  }

  /**
   * ZEN_RESCUE — Game removed N rows from the bottom and shifted the
   * stack down. Mirror on the mesh side BEFORE the retry-spawn fires
   * PIECE_SPAWN.
   */
  _onZenRescue({ rowsRemoved }) {
    for (let i = 0; i < rowsRemoved; i++) {
      const removedMeshRow = this.cellMeshes.splice(0, 1)[0];
      if (removedMeshRow) {
        for (let c = 0; c < this._cols; c++) {
          const slices = removedMeshRow[c];
          if (slices) for (const cube of slices) this.stackGroup.remove(cube);
        }
      }
      this.cellMeshes.push(Array(this._cols).fill(null));
    }
    for (let r = 0; r < this._rows; r++) {
      for (let c = 0; c < this._cols; c++) {
        const slices = this.cellMeshes[r][c];
        if (!slices) continue;
        for (let d = 0; d < this._depth; d++) {
          this._animateCubeTo(slices[d], this._cellToWorld(c, r, d));
        }
      }
    }
  }
}

export const _GARBAGE_COLOR = GARBAGE_COLOR;
