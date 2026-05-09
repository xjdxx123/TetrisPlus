// PhysicsBoardView — render side of one PhysicsSession (plan v2 §2.3
// Phase F+).
//
// In physics mode, locked cubes are rigid bodies that drift / settle /
// wedge under gravity. The grid-based BoardView (`world/board-view.js`)
// can't render these correctly — it parents cubes to a static
// stackGroup and sets their world position from `cellToWorld(col, row)`,
// which never updates. This module is the parallel renderer that keeps
// each cube in sync with its physics body.
//
// Mounted alongside (not inside) a `BoardView` configured with
// `noLockMeshes: true`. The BoardView still owns the active piece + ghost
// rendering (those are still grid-driven before lock); PhysicsBoardView
// owns the locked-stack rendering.
//
// Wiring:
//   const session = new PhysicsSession({ bus, game });
//   await session.start();
//   const view = new PhysicsBoardView({ session, parent: caseGroup,
//                                        makeCube, cellToWorld });
//   // every animation frame:
//   session.tick();
//   view.tick();
//
// Pure render module. Consumes session.world.getPositions() snapshots;
// never mutates physics state itself. Tests run pure-Node by stubbing
// `makeCube` (no real THREE meshes needed for behavior tests).

import * as THREE from 'three';

/**
 * @typedef {Object} PhysicsBoardViewOpts
 * @property {import('../app/physics-session.js').PhysicsSession} session
 *   The active session. Must have been started already; the view reads
 *   `session.world.getPositions()` and `session.getBodyColor(id)`.
 * @property {THREE.Object3D} parent     Where to attach the stack group.
 * @property {(color:number, opts?:any) => THREE.Mesh} makeCube
 *   Cube factory (host-owned). Same signature as BoardView's makeCube.
 * @property {(c:number, r:number, d:number) => THREE.Vector3} [cellToWorld]
 *   Optional — when provided, physics-world (col, row, z) coordinates
 *   are translated through this fn to scene world position. Default
 *   identity (`new Vector3(c, r, d)`) so callers without scene-bake
 *   can use the view in pure tests. The host wires this to the same
 *   `cellToWorld` used by BoardView so both renderers agree on
 *   geometry.
 * @property {string} [side='player']
 *   Tag carried for dual-board layouts. Currently informational; the
 *   session already filters PIECE_LOCK by side.
 * @property {(cube: THREE.Mesh) => void} [shatter]
 *   Optional shatter callback for cubes that disappear (layer cleared
 *   or otherwise removed from the world). Falls back to a plain
 *   stackGroup.remove() when omitted.
 */

const DEFAULT_CELL_TO_WORLD = (c, r, d) => new THREE.Vector3(c, r, d);

export class PhysicsBoardView {
  /** @param {PhysicsBoardViewOpts} opts */
  constructor(opts) {
    if (!opts || !opts.session) throw new Error('PhysicsBoardView requires { session }');
    if (!opts.parent)           throw new Error('PhysicsBoardView requires { parent }');
    if (typeof opts.makeCube !== 'function') {
      throw new Error('PhysicsBoardView requires makeCube');
    }
    this._session     = opts.session;
    this._parent      = opts.parent;
    this._makeCube    = opts.makeCube;
    this._cellToWorld = opts.cellToWorld || DEFAULT_CELL_TO_WORLD;
    this._side        = opts.side || 'player';
    this._shatter     = typeof opts.shatter === 'function' ? opts.shatter : null;

    // Public group so the host's cinematic FX layer (which already
    // reads BoardView.stackGroup.position for shake-relative anchoring)
    // can use the same surface.
    this.stackGroup = new THREE.Group();
    this._parent.add(this.stackGroup);

    /** @type {Map<number, THREE.Mesh>} bodyId → mesh */
    this._meshes = new Map();
  }

  // ─── Public read-only accessors ──────────────────────────────────────

  get cubeCount() { return this._meshes.size; }

  // ─── Per-frame sync ──────────────────────────────────────────────────

  /**
   * Reconcile mesh state with the physics world. Called after
   * `session.tick()` each frame — the order matters because the session
   * may have removed bodies during its tick (layer clear).
   *
   * - Bodies in `getPositions()` that don't have a mesh: create one.
   *   Color comes from `session.getBodyColor(bodyId)`; missing/null
   *   defaults to white.
   * - Bodies in `getPositions()` that have a mesh: copy position into
   *   the mesh transform.
   * - Meshes whose bodyId is no longer in `getPositions()`: dispose
   *   (calling shatter() if wired).
   */
  tick() {
    const world = this._session.world;
    if (!world) {
      // Session not running — nothing to do. We don't tear meshes
      // down here in case the host is restarting; the explicit
      // dispose() path is the cleanup contract.
      return;
    }

    const positions = world.getPositions();
    const seenIds = new Set();
    for (const { bodyId, x, y, z } of positions) {
      seenIds.add(bodyId);
      let mesh = this._meshes.get(bodyId);
      if (!mesh) {
        // First sighting — spawn a cube at the body's position.
        const color = this._session.getBodyColor(bodyId);
        const safeColor = (typeof color === 'number') ? color : 0xffffff;
        mesh = this._makeCube(safeColor, { settling: true });
        this._meshes.set(bodyId, mesh);
        this.stackGroup.add(mesh);
      }
      // Convert physics-world coords (continuous col/row/z) to scene
      // world position via the cellToWorld bake. The function is
      // linear by convention so passing fractional col/row works.
      const world3 = this._cellToWorld(x, y, z);
      mesh.position.copy(world3);
      // TODO(F++): copy rotation too — Rapier bodies can rotate, and
      // the visual currently locks rotation to identity. Cubes are
      // visually symmetric on faces, so this is cosmetic. Wire when
      // the dust/contact polish lands.
    }

    // Remove meshes for bodies the world no longer tracks. Iterate
    // over a snapshot of the keys so deletion during iteration is safe.
    for (const bodyId of [...this._meshes.keys()]) {
      if (seenIds.has(bodyId)) continue;
      const mesh = this._meshes.get(bodyId);
      this._meshes.delete(bodyId);
      this.stackGroup.remove(mesh);
      if (this._shatter) {
        try { this._shatter(mesh); } catch { /* ignore — best-effort visual */ }
      }
    }
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Tear down — remove all meshes from the scene + drop the registry.
   * Idempotent. Does NOT touch the session; caller is responsible for
   * `session.stop()` separately.
   */
  dispose() {
    for (const mesh of this._meshes.values()) {
      this.stackGroup.remove(mesh);
    }
    this._meshes.clear();
    if (this._parent && this.stackGroup.parent === this._parent) {
      this._parent.remove(this.stackGroup);
    }
  }
}
