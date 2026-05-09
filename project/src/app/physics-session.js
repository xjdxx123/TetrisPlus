// Pure Physics session — Force-Physics design (plan v2 §2.3.1 H).
//
// PhysicsSession is the integration glue between Game's piece queue,
// Rapier's PhysicsWorld, the layer-detection algorithm, and the host's
// input layer. The Force-Physics pivot rebuilds the player↔simulation
// seam: each tetromino is a single compound rigid body, and player
// input applies forces / impulses / torques rather than grid-snapped
// position deltas.
//
// Lifecycle:
//
//   constructor(opts)  — sync; validates opts
//   start()            — async; lazy-loads Rapier, subscribes to PIECE_SPAWN
//   stop()             — sync; unsub, dispose world, reset counters
//   tick()             — per frame: world.step → sleep-detect on active body
//                          → spawn next on commit → layer detect →
//                          remove cleared colliders → topout check
//
// Player input (called from the host's intent layer):
//   applyMove(dir)     — left / right (dir = ±1)
//   applyRotate(dir)   — CW / CCW (dir = ±1)
//   applySoftDrop()    — mild downward velocity boost
//   applyHardDrop()    — strong downward velocity + immediate commit
//
// Active body lifecycle:
//   - On PIECE_SPAWN, the session reads `game.activePiece` and its
//     cells, builds a compound body, stashes its bodyId as the active
//     body, and pauses the Game (so its grid gravity doesn't try to
//     drop the now-physics-driven piece).
//   - Player forces target the active body only.
//   - Lock detection: when the active body sleeps (Rapier's auto-sleep
//     after ~0.5s of low velocity), or when the player hard-drops and
//     the body's linear velocity drops below `HARD_DROP_COMMIT_VEL`,
//     the body is "committed": it stays in the world as a settled
//     stack body, and the session calls `game.spawnPiece()` to
//     advance the bag → PIECE_SPAWN fires → next active body spawns.
//
// Layer clear:
//   - `detectLayers` operates on `world.getColliderPositions()` so
//     compound-body cubes are first-class participants.
//   - For each cleared collider, the session calls
//     `world.removeCollider(colliderId)`. Surviving colliders stay
//     attached to their parent body (the half of an L-piece that
//     wasn't part of the layer continues to fall).
//   - `world.removeCollider` auto-removes the parent body when its
//     last collider goes — no explicit body cleanup needed here.
//
// Topout:
//   - If `world.highestY` exceeds `PHYSICS_TOPOUT_Y` (matches the
//     rules pack's `endCondition` threshold), the session fires its
//     `onEndRun({ reason:'topout' })` callback (single-shot per run).

import { EVENTS } from '../gameplay/events.js';
import { createPhysicsWorld } from '../physics/world.js';
import { detectLayers } from '../gameplay/experimental/physics/layer-detection.js';

const PHYSICS_TOPOUT_Y = 22;

// Force constants — calibrated in Phase L. Centralized here so the
// tuning surface is single-file.
const FORCE = Object.freeze({
  LATERAL_IMPULSE:        2.5,   // N·s on left/right tap (compound body mass ≈ 4 → ~0.6 m/s velocity change)
  ROTATE_TORQUE_IMPULSE:  1.2,   // N·m·s around Z
  SOFT_DROP_IMPULSE:      3.0,   // N·s downward (compounds with gravity)
  HARD_DROP_LINVEL:      -15.0,  // m/s — direct setLinvel, replaces existing velocity
  HARD_DROP_COMMIT_VEL:    1.5,  // m/s — once body's |v| drops below this after a hard-drop, commit
  LATERAL_MAX_VEL:         8.0,  // m/s lateral cap; impulse stops adding when |v.x| ≥ this
});

/**
 * @typedef {Object} PhysicsSessionOpts
 * @property {{on:(t:string,fn:Function,o?:any)=>Function, emit:Function}} bus
 * @property {import('../gameplay/game.js').Game} game
 *   The active Game instance. The session reads `game.activePiece` +
 *   `game.getPieceCells()` on PIECE_SPAWN and calls `game.spawnPiece()`
 *   on commit to advance the bag. Game is paused on session start so
 *   its grid-gravity tick doesn't try to drop the now-physics-driven
 *   piece.
 * @property {string} [side='player']
 * @property {number} [cols=10]
 * @property {number} [rows=20]
 * @property {Object} [worldOpts]
 *   Forwarded to createPhysicsWorld (gravity, friction, etc.).
 * @property {(c:number, r:number) => {x:number, y:number, z:number}} [cellToWorld]
 *   Optional grid → physics-world mapping. Default identity.
 * @property {(info: { reason:'topout' }) => void} [onEndRun]
 *   Single-shot callback fired when the world's highestY crosses
 *   PHYSICS_TOPOUT_Y. The host wires its own endRun() here to
 *   trigger MODE_END + stats persistence.
 */

/**
 * @typedef {Object} PhysicsLayerEvent
 * @property {Array<{centerY:number, minY:number, maxY:number, size:number}>} layers
 * @property {number} cubeCount
 * @property {number} simultaneous
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
    this._onEndRun  = (typeof opts.onEndRun === 'function') ? opts.onEndRun : null;

    /** @type {import('../physics/world.js').PhysicsWorld | null} */
    this._world     = null;
    /** @type {Function[]} */
    this._unsubs    = [];

    // Active body — the piece the player is currently controlling.
    // Set on PIECE_SPAWN; cleared on commit (sleep heuristic or
    // hard-drop trigger).
    this._activeBodyId = null;
    this._activePieceColor = 0xffffff;
    // Hard-drop "fast commit" flag — set by applyHardDrop, consulted
    // each tick. Lets a hard-dropped body commit before Rapier's
    // auto-sleep timer (~0.5s) elapses.
    this._hardDropArmed = false;

    // Cumulative counter for HUDs. Resets on stop().
    this._layersClearedTotal = 0;
    this._cubesClearedTotal  = 0;

    // Topout single-shot guard — Phase H wires the host callback.
    this._endRunFired = false;

    // Last-known highestY snapshot for `getRulesStateAugment()`. Read
    // by the host before calling rules.endCondition (legacy v1 path —
    // the v2 design routes topout through `onEndRun` directly, but the
    // augment is kept for callers that still inspect Game's snapshot).
    this._lastHighestY = -Infinity;
  }

  // ─── Public read-only accessors ──────────────────────────────────────

  get world()              { return this._world; }
  get bodyCount()          { return this._world ? this._world.bodyCount : 0; }
  get layersClearedTotal() { return this._layersClearedTotal; }
  get cubesClearedTotal()  { return this._cubesClearedTotal; }
  get awakeCount()         { return this._world ? this._world.awakeCount : 0; }
  get highestY()           { return this._world ? this._world.highestY : -Infinity; }
  get isStarted()          { return this._world != null; }
  get activeBodyId()       { return this._activeBodyId; }

  /**
   * Returns the color the body was added with, or null if the body has
   * been removed (or never existed).
   *
   * In Force Physics, color is stashed per collider via PhysicsWorld
   * during addCompoundBody (Phase G). This getter walks the world's
   * collider registry to find one belonging to the requested body.
   *
   * @param {number} bodyId
   * @returns {number | null}
   */
  getBodyColor(bodyId) {
    if (!this._world) return null;
    for (const c of this._world.getColliderPositions()) {
      if (c.bodyId === bodyId) return c.color;
    }
    return null;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Lazy-init Rapier + create the world + subscribe to PIECE_SPAWN.
   * Pauses the Game so its grid-gravity doesn't fight the physics body.
   * Idempotent.
   */
  async start() {
    if (this._world) return;
    this._world = await createPhysicsWorld({
      cols: this._cols,
      rows: this._rows,
      ...this._worldOpts,
    });
    // Pause the Game — its grid path is dormant in physics mode.
    // Game still tracks the active piece (for the bag + score), but
    // tick / lockPiece / clearLines never fire. PhysicsSession owns
    // gravity (via Rapier) + lock detection (via sleep heuristic).
    this._game.setPaused(true);

    this._unsubs.push(this._bus.on(EVENTS.PIECE_SPAWN, (e) => this._onPieceSpawn(e)));
    this._endRunFired = false;
  }

  /**
   * Tear down. Resets counters; unpauses the Game so a subsequent
   * non-physics mode runs normally.
   */
  stop() {
    for (const off of this._unsubs) {
      try { off(); } catch { /* ignore */ }
    }
    this._unsubs.length = 0;
    if (this._world) {
      this._world.dispose();
      this._world = null;
    }
    this._game.setPaused(false);
    this._activeBodyId = null;
    this._activePieceColor = 0xffffff;
    this._hardDropArmed = false;
    this._layersClearedTotal = 0;
    this._cubesClearedTotal  = 0;
    this._endRunFired = false;
    this._lastHighestY = -Infinity;
  }

  // ─── Player input ────────────────────────────────────────────────────

  /**
   * Lateral nudge — apply linear impulse to the active body. Capped
   * by `LATERAL_MAX_VEL` so mashing doesn't compound velocity into
   * runaway speed.
   *
   * @param {number} dir   +1 = right, -1 = left, 0 = no-op
   */
  applyMove(dir) {
    if (!this._activeBodyId || !this._world) return;
    const sign = (dir | 0);
    if (sign === 0) return;
    const v = this._world._bodies.get(this._activeBodyId)?.linvel?.();
    if (v && Math.abs(v.x) > FORCE.LATERAL_MAX_VEL && Math.sign(v.x) === Math.sign(sign)) {
      return; // already at cap in this direction
    }
    this._world.applyImpulse(this._activeBodyId, {
      x: sign * FORCE.LATERAL_IMPULSE, y: 0, z: 0,
    });
  }

  /**
   * Spin the piece — torque impulse around the screen-perpendicular
   * Z axis.
   *
   * @param {number} dir   +1 = CW, -1 = CCW
   */
  applyRotate(dir) {
    if (!this._activeBodyId || !this._world) return;
    const sign = (dir | 0);
    if (sign === 0) return;
    this._world.applyTorqueImpulse(this._activeBodyId, {
      x: 0, y: 0, z: sign * FORCE.ROTATE_TORQUE_IMPULSE,
    });
  }

  /** Mild downward force — held repeatedly while soft-drop key is down. */
  applySoftDrop() {
    if (!this._activeBodyId || !this._world) return;
    this._world.applyImpulse(this._activeBodyId, {
      x: 0, y: -FORCE.SOFT_DROP_IMPULSE, z: 0,
    });
  }

  /**
   * Hard drop — directly set the body's linear velocity to a strong
   * downward magnitude (overwrites whatever it was) and arm the
   * fast-commit path so the body locks the moment it slows down.
   * The piece keeps falling under physics; the player just released
   * control.
   */
  applyHardDrop() {
    if (!this._activeBodyId || !this._world) return;
    this._world.setLinvel(this._activeBodyId, {
      x: 0, y: FORCE.HARD_DROP_LINVEL, z: 0,
    });
    this._hardDropArmed = true;
  }

  // ─── Per-frame tick ──────────────────────────────────────────────────

  /**
   * Advance the simulation one step + run lock-detect / layer-detect /
   * topout-check. Returns the layer-clear event payload (if one fired)
   * or null.
   *
   * @returns {PhysicsLayerEvent | null}
   */
  tick() {
    if (!this._world) return null;

    this._world.step();
    this._lastHighestY = this._world.highestY;

    // Lock detection — promote the active body to "settled stack" when:
    //   (a) Rapier's auto-sleep marks it as resting (~0.5s of low |v|)
    //   (b) a hard-drop is armed and the body has slowed below HARD_DROP_COMMIT_VEL
    if (this._activeBodyId != null) {
      const sleeping = this._world.isBodySleeping(this._activeBodyId);
      let commit = false;
      if (sleeping) {
        commit = true;
      } else if (this._hardDropArmed) {
        const v = this._world._bodies.get(this._activeBodyId)?.linvel?.();
        if (v) {
          const speed = Math.sqrt(v.x*v.x + v.y*v.y + v.z*v.z);
          if (speed < FORCE.HARD_DROP_COMMIT_VEL) commit = true;
        }
      }
      if (commit) {
        this._activeBodyId = null;
        this._hardDropArmed = false;
        // Advance the bag → fires PIECE_SPAWN → handler creates the
        // next compound body and stashes it as activeBodyId.
        try { this._game.spawnPiece(); }
        catch (err) { console.warn('[physics] spawnPiece threw:', err); }
      }
    }

    // Layer detection on COLLIDER positions (compound bodies might
    // contribute multiple cubes to one layer; the algorithm doesn't
    // care which body each cube belongs to).
    const layerEvent = this._processLayers();

    // Topout — single-shot host callback.
    if (!this._endRunFired
        && this._world.highestY > PHYSICS_TOPOUT_Y
        && this._onEndRun) {
      this._endRunFired = true;
      try { this._onEndRun({ reason: 'topout' }); }
      catch (err) { console.warn('[physics] onEndRun threw:', err); }
    }

    return layerEvent;
  }

  _processLayers() {
    const colliders = this._world.getColliderPositions();
    const layers = detectLayers(colliders);
    if (layers.length === 0) return null;

    // Map cubeIndices (positions array indices) to colliderIds and
    // remove. PhysicsWorld auto-removes parent bodies when their
    // last collider goes.
    const removedColliderIds = new Set();
    for (const layer of layers) {
      for (const idx of layer.cubeIndices) {
        removedColliderIds.add(colliders[idx].colliderId);
      }
    }
    for (const cid of removedColliderIds) {
      this._world.removeCollider(cid);
    }
    // Wake settled bodies so they fall into the gap.
    this._world.wakeAll();

    const cubeCount = removedColliderIds.size;
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
      // Force-Physics extension: surface the actual collider IDs so
      // the renderer can run a dissolve animation on the matching
      // meshes (Phase J/K).
      removedColliderIds: [...removedColliderIds],
    };
    this._bus.emit(EVENTS.PHYSICS_LAYER_CLEARED, payload);
    return payload;
  }

  /**
   * State-augment for the rules pack's endCondition. Kept for
   * back-compat with the v1 path that read physicsHighestY through
   * Game's snapshot. v2's preferred path is `onEndRun` callback.
   *
   * @returns {{ physicsHighestY: number }}
   */
  getRulesStateAugment() {
    return {
      physicsHighestY: (typeof this._lastHighestY === 'number') ? this._lastHighestY : -Infinity,
    };
  }

  // ─── Internal — PIECE_SPAWN bridge ───────────────────────────────────

  _onPieceSpawn(e) {
    if (!this._world) return;
    if (e && e.side != null && e.side !== this._side) return;

    // Read the freshly-spawned active piece's cells from Game. Game's
    // grid representation is still the source of truth for "what
    // shape did the bag give us"; the cells array maps directly to
    // compound-body collider positions.
    const piece = this._game.activePiece;
    if (!piece) return;
    const cells = this._game.getPieceCells(piece);
    if (!cells || cells.length === 0) return;

    // Build the compound body. cellToWorld maps grid (col, row) to
    // physics-world coords; default identity since the existing
    // renderer already uses `cellToWorld(col, row, depth)` to bake
    // scene positions linearly.
    const points = cells.map(({ col, row }) => {
      const w = this._cellToWorld(col, row);
      return { x: w.x, y: w.y, z: w.z || 0 };
    });
    const color = (typeof e?.color === 'number') ? (e.color | 0) : 0xffffff;
    this._activeBodyId = this._world.addCompoundBody(points, { color });
    this._activePieceColor = color;
    this._hardDropArmed = false;
  }
}

// Test / introspection accessors.
export const _FORCE = FORCE;
export const _PHYSICS_TOPOUT_Y = PHYSICS_TOPOUT_Y;
