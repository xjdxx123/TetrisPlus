// Pure Physics session — host bridge between Game / PhysicsWorld /
// layer detection (plan v2 §2.3 Phases C+D, archived plan_gameplay_1.md
// §8.9 #2 + #3).
//
// PhysicsSession is the integration glue. It owns:
//   - A reference to the (already-constructed) Game.
//   - A PhysicsWorld it lazily creates on `start()`.
//   - A bus subscription on PIECE_LOCK that converts the locked piece's
//     cells into rigid bodies and erases them from Game's grid (so the
//     grid path stays empty and never accumulates state).
//   - A per-frame `tick()` that steps the world, snapshots positions,
//     runs `detectLayers`, and removes bodies belonging to any cleared
//     layer. Emits `PHYSICS_LAYER_CLEARED` for HUD / VFX subscribers.
//   - Read-only accessors (bodyCount, layersClearedTotal, awakeCount,
//     highestY) for HUDs and the rules pack's endCondition.
//
// The session is the ONLY place in the codebase that knows about both
// `gameplay/experimental/physics/` and `physics/world.js`. The rest of
// the app — Game, BoardView, the vfx director — sees physics through
// the same bus events as any other mode.
//
// Constructor is sync; `start()` is async because the first physics
// run pays the Rapier wasm init cost. Subsequent runs in the same
// process resolve instantly (the Rapier module is module-level cached
// per `physics/world.js#loadRapier`).

import { EVENTS } from '../gameplay/events.js';
import { createPhysicsWorld } from '../physics/world.js';
import { detectLayers } from '../gameplay/experimental/physics/layer-detection.js';

/**
 * @typedef {Object} PhysicsSessionOpts
 * @property {{on:(t:string,fn:Function,o?:any)=>Function, emit:Function}} bus
 *   Engine event bus. The session subscribes to PIECE_LOCK and emits
 *   PHYSICS_LAYER_CLEARED.
 * @property {import('../gameplay/game.js').Game} game
 *   The active Game instance. The session ERASES locked cells from
 *   `game.board` after handing them to physics, so the grid stays
 *   empty and Game.clearLines never fires (which is correct — physics
 *   doesn't use the grid clear path; it has detectLayers).
 * @property {string} [side='player']   Routes events for dual-board layouts.
 * @property {number} [cols=10]
 * @property {number} [rows=20]
 * @property {Object} [worldOpts]       Forwarded to createPhysicsWorld.
 * @property {{x:number,y:number,z:number}} [cellToWorld]
 *   Optional mapping from grid cell to world coordinates. Default
 *   identity (cell.col → x, cell.row → y, 0 → z) since the grid is
 *   already in world units in the existing renderer. Hosts that want
 *   to translate / scale the physics arena pass a custom mapping.
 */

/**
 * @typedef {Object} PhysicsLayerEvent
 * @property {Array<{centerY:number, minY:number, maxY:number, size:number}>} layers
 * @property {number} cubeCount      Total cubes cleared (across all layers).
 * @property {number} simultaneous   layers.length — mirrors LINE_CLEAR.simultaneous.
 * @property {string} side
 */

const DEFAULT_CELL_TO_WORLD = (col, row) => ({ x: col, y: row, z: 0 });

export class PhysicsSession {
  /** @param {PhysicsSessionOpts} opts */
  constructor(opts) {
    if (!opts || !opts.bus || !opts.game) {
      throw new Error('PhysicsSession requires { bus, game }');
    }
    this._bus       = opts.bus;
    this._game      = opts.game;
    this._side      = opts.side || 'player';
    this._cols      = opts.cols || 10;
    this._rows      = opts.rows || 20;
    this._worldOpts = opts.worldOpts || {};
    this._cellToWorld = opts.cellToWorld || DEFAULT_CELL_TO_WORLD;

    /** @type {import('../physics/world.js').PhysicsWorld | null} */
    this._world     = null;
    /** @type {Function | null} */
    this._unsubLock = null;
    /** @type {Function[]} */
    this._unsubs    = [];

    // Cumulative counter for HUDs. Resets on stop().
    this._layersClearedTotal = 0;
    this._cubesClearedTotal  = 0;

    // Per-body color tracking (plan v2 §2.3 F+). The PhysicsWorld is
    // render-agnostic — it tracks bodies but not colors. PhysicsView
    // queries this map to decide what color to paint each cube. Cleared
    // bodies are removed from the map in `tick()` to avoid leaks.
    /** @type {Map<number, number>} */
    this._bodyColors = new Map();
  }

  // ─── Public read-only accessors ──────────────────────────────────────

  get world()              { return this._world; }
  get bodyCount()          { return this._world ? this._world.bodyCount : 0; }
  get layersClearedTotal() { return this._layersClearedTotal; }
  get cubesClearedTotal()  { return this._cubesClearedTotal; }
  get awakeCount()         { return this._world ? this._world.awakeCount : 0; }
  get highestY()           { return this._world ? this._world.highestY : -Infinity; }
  get isStarted()          { return this._world != null; }

  /**
   * Per-body color lookup (plan v2 §2.3 F+). Returns the color the body
   * was added with, or null if the body has been removed (or never
   * existed). PhysicsView queries this once per new body it spots in
   * `world.getPositions()`.
   *
   * @param {number} bodyId
   * @returns {number | null}  0xRRGGBB hex, or null when unknown
   */
  getBodyColor(bodyId) {
    return this._bodyColors.has(bodyId) ? this._bodyColors.get(bodyId) : null;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Lazy-init Rapier + create the world + subscribe to PIECE_LOCK.
   * Idempotent — repeated calls are no-ops once the session is live.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (this._world) return;
    this._world = await createPhysicsWorld({
      cols: this._cols,
      rows: this._rows,
      ...this._worldOpts,
    });
    this._unsubLock = this._bus.on(EVENTS.PIECE_LOCK, (e) => this._onPieceLock(e));
    this._unsubs.push(this._unsubLock);
  }

  /**
   * Tear down: unsubscribe the bus listener, dispose the world,
   * reset cumulative counters. Idempotent.
   */
  stop() {
    for (const off of this._unsubs) {
      try { off(); } catch { /* ignore */ }
    }
    this._unsubs.length = 0;
    this._unsubLock = null;
    if (this._world) {
      this._world.dispose();
      this._world = null;
    }
    this._layersClearedTotal = 0;
    this._cubesClearedTotal  = 0;
    this._bodyColors.clear();
  }

  // ─── Per-frame tick ──────────────────────────────────────────────────

  /**
   * Advance the physics world one step, run layer detection, and remove
   * any cubes that belong to a cleared layer. Emits
   * `PHYSICS_LAYER_CLEARED` when at least one layer drops.
   *
   * Also pushes `physicsHighestY` into the Game's state-snapshot path
   * (via a host-readable field) so the rules pack's `endCondition`
   * observes the real body positions on each tick.
   *
   * @returns {PhysicsLayerEvent | null}  the event that was emitted, or null
   */
  tick() {
    if (!this._world) return null;

    this._world.step();

    // Push the current highestY into a read-back location the rules
    // pack consults via `state.physicsHighestY`. Game's getStateSnapshot
    // doesn't know about physics; the host owns the merge. We expose
    // the value here so the host can inject it cheaply on each tick.
    // (See `getRulesStateAugment()` below — host calls it inside its
    // tick before the rules pack's endCondition runs.)
    // Stored as a simple field; consumers read via getRulesStateAugment.
    this._lastHighestY = this._world.highestY;

    // Detect layers from the current snapshot. Empty world → empty
    // snapshot → no layers. Cheap.
    const positions = this._world.getPositions();
    const layers = detectLayers(positions);
    if (layers.length === 0) return null;

    // Map cubeIndices (positions array indices) back to bodyIds and
    // remove. Build the event payload before removal so VFX can fire
    // bursts at the correct world-space positions.
    const removedIds = new Set();
    for (const layer of layers) {
      for (const idx of layer.cubeIndices) removedIds.add(positions[idx].bodyId);
    }
    this._world.removeBodies(removedIds);
    // Drop color metadata for removed bodies so the map doesn't leak
    // unbounded over the run.
    for (const id of removedIds) this._bodyColors.delete(id);
    // Shift down: wake settled bodies so they fall into the gaps
    // instead of floating where the cleared layer used to be.
    this._world.wakeAll();

    const cubeCount = removedIds.size;
    this._layersClearedTotal += layers.length;
    this._cubesClearedTotal  += cubeCount;

    /** @type {PhysicsLayerEvent} */
    const payload = {
      layers: layers.map(l => ({
        centerY: l.centerY,
        minY:    l.minY,
        maxY:    l.maxY,
        size:    l.cubeIndices.length,
      })),
      cubeCount,
      simultaneous: layers.length,
      side: this._side,
    };
    this._bus.emit(EVENTS.PHYSICS_LAYER_CLEARED, payload);
    return payload;
  }

  /**
   * Returns the augment object the host should mix into Game's state
   * snapshot before calling `rules.endCondition(state)`. Currently
   * just `physicsHighestY`; future fields (e.g. settledCount) plug
   * in here.
   *
   * @returns {{ physicsHighestY: number }}
   */
  getRulesStateAugment() {
    return {
      physicsHighestY: (typeof this._lastHighestY === 'number') ? this._lastHighestY : -Infinity,
    };
  }

  // ─── Internal — PIECE_LOCK bridge ────────────────────────────────────

  _onPieceLock(e) {
    if (!this._world || !e || !Array.isArray(e.cells)) return;
    if (e.side != null && e.side !== this._side) return;

    // For each locked cell, spawn a body at the corresponding world
    // position. The cellToWorld mapping defaults to identity since the
    // existing renderer already places grid cells at world (col, row).
    // Then erase the cell from the Game's board so:
    //   (a) BoardView's PIECE_LOCK handler — which fires AFTER us in
    //       subscription order if main.js subscribes us first — sees
    //       an empty footprint and skips creating the static cube
    //       (TODO: BoardView currently uses the event payload `cells`
    //       directly, not the board state; main.js host integration
    //       in Phase F will need a `noLockMeshes` opt or similar to
    //       suppress BoardView's static cube creation in physics mode).
    //   (b) Game.clearLines never fires (fullRows always 0 in physics
    //       since the cells are erased before the grid path runs).
    const lockColor = (typeof e.color === 'number') ? (e.color | 0) : 0xffffff;
    for (const { col, row } of e.cells) {
      const w = this._cellToWorld(col, row);
      const bodyId = this._world.addBody(w.x, w.y, w.z);
      this._bodyColors.set(bodyId, lockColor);
      // Erase from Game's board. This is safe — Game already counted
      // fullRows BEFORE emitting PIECE_LOCK, so altering the board
      // here doesn't affect that count, and clearLines's row-removal
      // is a no-op on already-empty rows.
      const board = this._game.board;
      if (board && board[row] && col >= 0 && col < board[row].length) {
        board[row][col] = null;
      }
    }
  }
}
