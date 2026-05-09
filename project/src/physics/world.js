// Pure Physics — Rapier-backed world wrapper (plan v2 §2.3 Phase B,
// archived plan_gameplay_1.md §8.9 #1).
//
// `physics/` is its own top-level subsystem (matching `camera/`,
// `vfx/`, `audio/` etc.) — the rules pack stays pure JS in
// `gameplay/experimental/physics/rules.js`; the Rapier-backed
// simulation lives here, behind a lazy-init factory so the ~600KB
// wasm bundle only loads when a physics-mode run actually starts.
//
// The wrapper exposes a small host-facing API:
//
//   addBody(x, y, z, opts?) → bodyId    // numeric handle
//   step(dt?)                            // 60Hz fixed by default
//   getPositions() → CubePosition[]      // snapshot of all live bodies
//   getBodyPosition(bodyId) → CubePosition | null
//   removeBody(bodyId), removeBodies(ids)
//   highestY                             // for the rules pack's endCondition
//   awakeCount                           // for sleep-heuristic HUDs
//   dispose()                            // free the wasm world
//
// The host owns the gameplay-side bridge: on `lockPiece`, convert the
// active piece's cells to physics bodies via addBody; per-frame, call
// step() then getPositions() and feed the array to detectLayers (from
// gameplay/experimental/physics/layer-detection.js); on layer-clear,
// removeBodies(layer.cubeIndices.map(i => liveIds[i])).
//
// Tested with the real Rapier — wasm runs in vitest's Node env without
// extra setup thanks to the `compat` package's sync-init pattern.

let _RAPIER = null;
let _initPromise = null;

/**
 * Lazily initialize the Rapier wasm runtime. Idempotent — repeated
 * calls return the same module reference. The first call awaits the
 * sync-init wasm decode (~50ms on modern hardware); subsequent calls
 * resolve immediately.
 *
 * @returns {Promise<typeof import('@dimforge/rapier3d-compat')>}
 */
export async function loadRapier() {
  if (_RAPIER) return _RAPIER;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const mod = await import('@dimforge/rapier3d-compat');
    await mod.init();
    _RAPIER = mod;
    return mod;
  })();
  return _initPromise;
}

/**
 * Test-only — reset the Rapier module cache so a subsequent
 * `loadRapier()` call re-initializes. Real callers never use this.
 */
export function _resetRapierForTests() {
  _RAPIER = null;
  _initPromise = null;
}

// ─── PhysicsWorld class ────────────────────────────────────────────────

/**
 * @typedef {Object} CubePosition
 * @property {number} x
 * @property {number} y
 * @property {number} z
 */

/**
 * @typedef {Object} PhysicsWorldOpts
 * @property {number} [cols=10]    Playfield width in cells.
 * @property {number} [rows=20]    Playfield height in cells (cosmetic — Rapier itself is unbounded above).
 * @property {number} [gravity=-9.81]   Y-acceleration in m/s² (cells/s², equivalently — units are 1 cell).
 * @property {boolean} [floor=true]     Add a static floor at y=-0.5 spanning the playfield width.
 * @property {boolean} [walls=true]     Add static side walls at x=-0.5 and x=cols-0.5.
 * @property {number} [friction=0.6]    Per-cube friction. Calibrated per archived §8.4.
 * @property {number} [restitution=0.1] Per-cube bounciness. Low — cubes settle, don't bounce around.
 * @property {number} [stepDtSec=1/60]  Fixed timestep. Matches gameplay tick.
 */

const DEFAULT_OPTS = Object.freeze({
  cols: 10,
  rows: 20,
  gravity: -9.81,
  floor: true,
  walls: true,
  friction: 0.6,
  restitution: 0.1,
  stepDtSec: 1 / 60,
});

/**
 * Build a Rapier-backed physics world ready for cube spawn / step /
 * snapshot / remove. Awaits the wasm init before resolving.
 *
 * @param {PhysicsWorldOpts} [opts]
 * @returns {Promise<PhysicsWorld>}
 */
export async function createPhysicsWorld(opts = {}) {
  const RAPIER = await loadRapier();
  return new PhysicsWorld(RAPIER, { ...DEFAULT_OPTS, ...opts });
}

export class PhysicsWorld {
  /**
   * @param {typeof import('@dimforge/rapier3d-compat')} RAPIER
   * @param {PhysicsWorldOpts} opts
   */
  constructor(RAPIER, opts) {
    this._RAPIER = RAPIER;
    this._opts   = Object.freeze({ ...opts });
    this._world  = new RAPIER.World({ x: 0, y: opts.gravity, z: 0 });
    this._world.timestep = opts.stepDtSec;

    // Body bookkeeping — caller works with numeric IDs that we map
    // back to the Rapier `RigidBody` handle internally. This decouples
    // the host from Rapier's specific handle semantics (Rapier uses
    // typed-array indices that can churn; our `_nextId` is monotonic
    // and stable across the body's lifetime).
    /** @type {Map<number, any>} */
    this._bodies = new Map();
    this._nextId = 1;

    // Force-Physics pivot (plan v2 §2.3.1): compound bodies need
    // per-collider tracking so layer-clear can remove individual
    // colliders without destroying the whole body.
    //   _colliders: colliderId → { handle, bodyId, colorIfAny }
    //   _bodyColliders: bodyId → array of colliderIds
    /** @type {Map<number, { handle: any, bodyId: number, color: number }>} */
    this._colliders = new Map();
    /** @type {Map<number, number[]>} */
    this._bodyColliders = new Map();
    this._nextColliderId = 1;

    /** @type {any[]} */
    this._staticHandles = [];

    if (opts.floor) this._addFloor();
    if (opts.walls) this._addWalls();
  }

  // ─── Read-only accessors ────────────────────────────────────────────

  get cols() { return this._opts.cols; }
  get rows() { return this._opts.rows; }
  get bodyCount() { return this._bodies.size; }

  /**
   * Maximum Y coordinate among all dynamic bodies. -Infinity when the
   * world is empty. The rules pack consumes this via its
   * `endCondition(state)` — `state.physicsHighestY > PHYSICS_TOPOUT_Y`
   * triggers a topout. Cheap to read; we don't cache because the
   * Y of every body changes every step.
   */
  get highestY() {
    let max = -Infinity;
    for (const body of this._bodies.values()) {
      const y = body.translation().y;
      if (y > max) max = y;
    }
    return max;
  }

  /**
   * Count of bodies that are CURRENTLY awake (moving / recently
   * disturbed). Bodies that haven't moved in ~1 second auto-sleep
   * per Rapier's defaults. Used by the HUD to show "settled cubes:
   * N" — bigger number = more chaos, smaller = stack is at rest.
   */
  get awakeCount() {
    let count = 0;
    for (const body of this._bodies.values()) {
      if (!body.isSleeping()) count++;
    }
    return count;
  }

  // ─── Body lifecycle ─────────────────────────────────────────────────

  /**
   * Spawn a 1×1×1 cube at (x, y, z). Returns a numeric ID stable for
   * the body's lifetime; pass it back to `removeBody(id)` or
   * `getBodyPosition(id)`.
   *
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @param {{velocity?: {x:number,y:number,z:number}}} [opts]
   * @returns {number} bodyId
   */
  addBody(x, y, z = 0, opts = {}) {
    // Single-cuboid body — implemented as a compound body with one
    // collider so the bookkeeping stays uniform with addCompoundBody.
    return this.addCompoundBody([{ x, y, z }], opts);
  }

  /**
   * Spawn a compound rigid body composed of N unit-cube colliders, one
   * at each `(x, y, z)` cell position in the input. The body's center
   * of mass is the centroid of the cells; each collider's local
   * translation is the cell's offset from that centroid. This is the
   * core primitive for Force-Physics tetrominoes (plan v2 §2.3.1):
   * an L-piece is `addCompoundBody([(0,0,0),(0,1,0),(0,2,0),(1,0,0)])`.
   *
   * Returns the body ID. The collider IDs are assigned internally and
   * exposed via `getColliderPositions()`. Per-collider removal goes
   * through `removeCollider(colliderId)`; a body whose last collider
   * is removed is auto-deleted (so the host doesn't leak ghost bodies).
   *
   * @param {Array<{x:number, y:number, z?:number}>} cells
   * @param {{
   *   color?: number,
   *   damping?: number,
   *   angularDamping?: number,
   *   velocity?: {x:number,y:number,z:number},
   * }} [opts]
   * @returns {number} bodyId
   */
  addCompoundBody(cells, opts = {}) {
    if (!Array.isArray(cells) || cells.length === 0) {
      throw new Error('addCompoundBody requires at least one cell');
    }
    const RAPIER = this._RAPIER;

    // Centroid — body's translation. Local collider translations are
    // cell - centroid so the body's frame is centered on the piece.
    let cx = 0, cy = 0, cz = 0;
    for (const c of cells) {
      cx += c.x;
      cy += c.y;
      cz += (c.z || 0);
    }
    cx /= cells.length;
    cy /= cells.length;
    cz /= cells.length;

    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(cx, cy, cz)
      .setLinearDamping(opts.damping ?? 0.05)
      .setAngularDamping(opts.angularDamping ?? 0.10)
      .setCanSleep(true);
    if (opts.velocity) {
      desc.setLinvel(opts.velocity.x | 0, opts.velocity.y | 0, opts.velocity.z | 0);
    }
    const body = this._world.createRigidBody(desc);

    const bodyId = this._nextId++;
    this._bodies.set(bodyId, body);

    const colliderIds = [];
    const color = (typeof opts.color === 'number') ? (opts.color | 0) : 0xffffff;
    for (const cell of cells) {
      const cd = RAPIER.ColliderDesc.cuboid(0.5, 0.5, 0.5)
        .setTranslation(cell.x - cx, cell.y - cy, (cell.z || 0) - cz)
        .setFriction(this._opts.friction)
        .setRestitution(this._opts.restitution)
        .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.DEFAULT);
      const collider = this._world.createCollider(cd, body);
      const colliderId = this._nextColliderId++;
      this._colliders.set(colliderId, { handle: collider, bodyId, color });
      colliderIds.push(colliderId);
    }
    this._bodyColliders.set(bodyId, colliderIds);
    return bodyId;
  }

  /**
   * Apply a one-shot linear impulse (kg·m/s) to the body's center of
   * mass. Used for player-driven left/right "nudges" in Force Physics.
   *
   * @param {number} bodyId
   * @param {{x:number, y:number, z:number}} vec
   */
  applyImpulse(bodyId, vec) {
    const body = this._bodies.get(bodyId);
    if (!body || !vec) return;
    body.applyImpulse({ x: +vec.x || 0, y: +vec.y || 0, z: +vec.z || 0 }, true);
  }

  /**
   * Apply a one-shot angular impulse (kg·m²/s) about the world axes.
   * Used for player-driven rotation in Force Physics — Z-axis impulse
   * spins the piece around the screen-perpendicular axis.
   *
   * @param {number} bodyId
   * @param {{x:number, y:number, z:number}} vec
   */
  applyTorqueImpulse(bodyId, vec) {
    const body = this._bodies.get(bodyId);
    if (!body || !vec) return;
    body.applyTorqueImpulse({ x: +vec.x || 0, y: +vec.y || 0, z: +vec.z || 0 }, true);
  }

  /**
   * Set the body's linear velocity directly. Used for hard drop —
   * instantly sets a strong downward velocity instead of an additive
   * impulse, so a hard-dropped piece moves at a known speed regardless
   * of its prior motion.
   *
   * @param {number} bodyId
   * @param {{x:number, y:number, z:number}} vec
   */
  setLinvel(bodyId, vec) {
    const body = this._bodies.get(bodyId);
    if (!body || !vec) return;
    body.setLinvel({ x: +vec.x || 0, y: +vec.y || 0, z: +vec.z || 0 }, true);
  }

  /**
   * Sleep state of a single body. Used by PhysicsSession to detect
   * "the active piece has settled" — Rapier auto-sleeps bodies whose
   * velocity stays below threshold for ~0.5s.
   *
   * @param {number} bodyId
   * @returns {boolean}  true when sleeping, false when awake or unknown
   */
  isBodySleeping(bodyId) {
    const body = this._bodies.get(bodyId);
    return body ? body.isSleeping() : false;
  }

  /**
   * Remove a single collider from its parent body. When the parent's
   * collider count drops to 0, the parent body is auto-removed too.
   * Returns true on a real removal; false if the colliderId is unknown
   * (idempotent on repeated removes).
   *
   * Used for Force-Physics layer clear: detectLayers identifies cleared
   * collider IDs; the host calls removeCollider per cleared ID. The
   * surviving colliders stay attached to their parent body and the
   * remaining cubes settle naturally under gravity.
   *
   * @param {number} colliderId
   * @returns {boolean}
   */
  removeCollider(colliderId) {
    const entry = this._colliders.get(colliderId);
    if (!entry) return false;
    // The `wakeUp` flag is true so neighbors that were resting on this
    // collider get re-evaluated this step; otherwise they'd float.
    this._world.removeCollider(entry.handle, true);
    this._colliders.delete(colliderId);

    const list = this._bodyColliders.get(entry.bodyId);
    if (list) {
      const idx = list.indexOf(colliderId);
      if (idx >= 0) list.splice(idx, 1);
      if (list.length === 0) {
        // Body has no colliders left — clean up.
        this._bodyColliders.delete(entry.bodyId);
        const body = this._bodies.get(entry.bodyId);
        if (body) {
          this._world.removeRigidBody(body);
          this._bodies.delete(entry.bodyId);
        }
      }
    }
    return true;
  }

  /**
   * Remove a single body by ID. Idempotent — unknown IDs are ignored.
   *
   * @param {number} bodyId
   * @returns {boolean} true if the body existed and was removed
   */
  removeBody(bodyId) {
    const body = this._bodies.get(bodyId);
    if (!body) return false;
    // Clean up tracked colliders before nuking the body so the
    // collider registry doesn't keep stale entries pointing at a
    // freed Rapier handle.
    const list = this._bodyColliders.get(bodyId);
    if (list) {
      for (const colliderId of list) this._colliders.delete(colliderId);
      this._bodyColliders.delete(bodyId);
    }
    this._world.removeRigidBody(body);
    this._bodies.delete(bodyId);
    return true;
  }

  /**
   * Bulk remove. The host calls this on layer-clear with the list of
   * cube IDs that detectLayers identified.
   *
   * @param {Iterable<number>} bodyIds
   * @returns {number} count of bodies actually removed
   */
  removeBodies(bodyIds) {
    let removed = 0;
    for (const id of bodyIds) {
      if (this.removeBody(id)) removed++;
    }
    return removed;
  }

  // ─── Snapshot / read ────────────────────────────────────────────────

  /**
   * Snapshot every live body's center position. Output ordering is
   * insertion order (matches Map iteration). Each entry includes the
   * `bodyId` so the host can map detectLayers' `cubeIndices` back to
   * the IDs to remove.
   *
   * @returns {Array<CubePosition & { bodyId: number }>}
   */
  getPositions() {
    const out = [];
    for (const [bodyId, body] of this._bodies) {
      const t = body.translation();
      out.push({ bodyId, x: t.x, y: t.y, z: t.z });
    }
    return out;
  }

  /**
   * Snapshot every live collider's WORLD-space position (Force-Physics
   * pivot, plan v2 §2.3.1). Compound bodies have multiple colliders
   * each — this is what `detectLayers` operates on so a "layer" is a
   * connected component of cubes irrespective of which parent body
   * they belong to.
   *
   * Each entry includes the parent `bodyId`, the `colliderId` (for
   * removeCollider after layer detect), the world-space position, and
   * the color stashed at addCompoundBody time.
   *
   * @returns {Array<{ colliderId: number, bodyId: number, x: number, y: number, z: number, color: number }>}
   */
  getColliderPositions() {
    const out = [];
    for (const [colliderId, entry] of this._colliders) {
      const t = entry.handle.translation();
      out.push({
        colliderId, bodyId: entry.bodyId,
        x: t.x, y: t.y, z: t.z,
        color: entry.color,
      });
    }
    return out;
  }

  /**
   * Body's world-space rotation as a quaternion `{x, y, z, w}`. Used by
   * the renderer to copy parent transforms onto child cube meshes.
   * Null when the body is unknown.
   *
   * @param {number} bodyId
   * @returns {{x:number, y:number, z:number, w:number} | null}
   */
  getBodyRotation(bodyId) {
    const body = this._bodies.get(bodyId);
    if (!body) return null;
    const r = body.rotation();
    return { x: r.x, y: r.y, z: r.z, w: r.w };
  }

  /**
   * Single-body lookup. Returns null when the body has been removed.
   *
   * @param {number} bodyId
   * @returns {CubePosition | null}
   */
  getBodyPosition(bodyId) {
    const body = this._bodies.get(bodyId);
    if (!body) return null;
    const t = body.translation();
    return { x: t.x, y: t.y, z: t.z };
  }

  // ─── Step ───────────────────────────────────────────────────────────

  /**
   * Advance the simulation by one fixed timestep (default 1/60s).
   * Fixed-step for determinism — the gameplay loop calls this once
   * per render frame; if the frame is longer than expected, the
   * simulation lags slightly rather than slowing down. This is the
   * standard physics-loop pattern for game tick decoupling.
   */
  step() {
    this._world.step();
  }

  /**
   * Wake every body. Called when external state changes (e.g. a layer
   * cleared and shifted the stack down) so settled bodies don't stay
   * floating in mid-air.
   */
  wakeAll() {
    for (const body of this._bodies.values()) body.wakeUp();
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Free the underlying Rapier world. Required to release the wasm
   * memory — JS GC alone won't reclaim it. Call on Mode.stop or when
   * disposing the host.
   */
  dispose() {
    if (this._world) {
      try { this._world.free(); } catch { /* ignore */ }
      this._world = null;
    }
    this._bodies.clear();
    this._colliders.clear();
    this._bodyColliders.clear();
    this._staticHandles.length = 0;
  }

  // ─── Internal — boundary geometry ───────────────────────────────────

  _addFloor() {
    const RAPIER = this._RAPIER;
    const cols = this._opts.cols;
    // Floor: static, half-cell below y=0, half-extent (cols/2 + 0.5) wide.
    const fixed = this._world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(cols / 2 - 0.5, -0.5, 0)
    );
    const c = RAPIER.ColliderDesc.cuboid(cols / 2 + 0.5, 0.5, 5)
      .setFriction(this._opts.friction)
      .setRestitution(this._opts.restitution);
    this._world.createCollider(c, fixed);
    this._staticHandles.push(fixed);
  }

  _addWalls() {
    const RAPIER = this._RAPIER;
    const cols = this._opts.cols;
    const rows = this._opts.rows;
    // Tall walls — span well above `rows` so a wedged cube can't
    // squeeze over the top under any normal gameplay.
    const wallHalfHeight = (rows + 4) / 2;
    const wallHalfDepth  = 5;
    const wallY = wallHalfHeight - 0.5;

    const left = this._world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(-1, wallY, 0)
    );
    const leftCollider = RAPIER.ColliderDesc.cuboid(0.5, wallHalfHeight, wallHalfDepth)
      .setFriction(this._opts.friction)
      .setRestitution(this._opts.restitution);
    this._world.createCollider(leftCollider, left);

    const right = this._world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(cols, wallY, 0)
    );
    const rightCollider = RAPIER.ColliderDesc.cuboid(0.5, wallHalfHeight, wallHalfDepth)
      .setFriction(this._opts.friction)
      .setRestitution(this._opts.restitution);
    this._world.createCollider(rightCollider, right);

    this._staticHandles.push(left, right);
  }
}

// Test / introspection accessors.
export const _DEFAULT_OPTS = DEFAULT_OPTS;
