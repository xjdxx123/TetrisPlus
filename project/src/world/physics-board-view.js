// PhysicsBoardView — Force-Physics renderer (plan v2 §2.3.1 J).
//
// Reactively follows a `PhysicsSession`'s collider state. One mesh per
// COLLIDER (not per body) so a compound tetromino renders as 4 cubes
// that move + rotate as a unit, and a partial layer clear removes only
// the affected cube meshes while the parent body's other cubes stay.
//
// Per-tick reconciliation:
//   - For each collider in `session.world.getColliderPositions()`:
//       new colliderId      → makeCube(color), parent to stackGroup
//       existing colliderId → mesh.position = collider world position;
//                              mesh.quaternion = parent body's rotation
//   - For each tracked colliderId no longer in the snapshot: start a
//     dissolve animation (250ms opacity 1 → 0, scale 1 → 1.1) instead
//     of the v1 shatter. After the animation, remove from scene.
//
// Mounted alongside (not inside) a `BoardView` configured with
// `noLockMeshes: true`. BoardView still owns the active piece's pre-
// lock visuals (the falling tetromino mesh + ghost) — wait, in Force
// Physics there is no "pre-lock" anymore: the piece IS a physics body
// from spawn. So `noLockMeshes` should ALSO suppress the active piece
// mesh. The host wires a separate "physics ghost" if/when wanted.
// (Phase I host wiring resolves which BoardView features stay vs.
// disable for physics mode.)
//
// Pure render module. Tests run pure-Node by stubbing makeCube.

import * as THREE from 'three';

const DEFAULT_CELL_TO_WORLD = (c, r, d) => new THREE.Vector3(c, r, d);

// Dissolve animation tunables (plan v2 §2.3.1 K).
const DISSOLVE = Object.freeze({
  DURATION_MS: 250,
  // Scale slightly up while fading so the cube reads as "dissolving"
  // instead of just shrinking out.
  END_SCALE: 1.10,
});

/**
 * @typedef {Object} PhysicsBoardViewOpts
 * @property {import('../app/physics-session.js').PhysicsSession} session
 * @property {THREE.Object3D} parent
 * @property {(color:number, opts?:any) => THREE.Mesh} makeCube
 * @property {(c:number, r:number, d:number) => THREE.Vector3} [cellToWorld]
 * @property {string} [side='player']
 */

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

    this.stackGroup = new THREE.Group();
    this._parent.add(this.stackGroup);

    /** @type {Map<number, THREE.Mesh>} colliderId → mesh */
    this._meshes = new Map();
    /**
     * Active dissolve animations, keyed by mesh (not colliderId — the
     * collider is gone by the time the dissolve starts). Each entry
     * has the start time and the original scale so we can interpolate.
     * @type {Map<THREE.Mesh, { startMs: number, baseScale: number }>}
     */
    this._dissolving = new Map();

    // Now-fn — overridable for deterministic tests.
    this._now = (typeof opts.now === 'function')
      ? opts.now
      : (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  }

  // ─── Read-only accessors ────────────────────────────────────────────

  get cubeCount()        { return this._meshes.size; }
  get dissolvingCount()  { return this._dissolving.size; }

  // ─── Per-frame sync ─────────────────────────────────────────────────

  /**
   * Reconcile mesh state with the world's COLLIDER positions. Called
   * after `session.tick()` each frame.
   */
  tick() {
    const world = this._session.world;
    if (!world) {
      // Session not started — still drive any in-flight dissolves so
      // a stop() between ticks doesn't strand them on screen.
      this._tickDissolves();
      return;
    }

    const positions = world.getColliderPositions();
    const seenIds = new Set();
    // Body rotation cache per-tick — avoids re-querying for each
    // collider belonging to the same body.
    const rotationCache = new Map();

    for (const { colliderId, bodyId, x, y, z, color } of positions) {
      seenIds.add(colliderId);
      let mesh = this._meshes.get(colliderId);
      if (!mesh) {
        const safeColor = (typeof color === 'number') ? color : 0xffffff;
        mesh = this._makeCube(safeColor, { settling: true });
        this._meshes.set(colliderId, mesh);
        this.stackGroup.add(mesh);
      }
      // World position from the physics snapshot, baked through
      // cellToWorld so scene units match.
      const wp = this._cellToWorld(x, y, z);
      if (mesh.position && typeof mesh.position.copy === 'function') {
        mesh.position.copy(wp);
      } else if (mesh.position) {
        mesh.position.x = wp.x; mesh.position.y = wp.y; mesh.position.z = wp.z;
      }
      // Body rotation — Rapier's collider position is already
      // world-space, but the cube mesh should also INHERIT the parent
      // body's rotation so it visually tumbles instead of staying
      // axis-aligned.
      let q = rotationCache.get(bodyId);
      if (q === undefined) {
        q = world.getBodyRotation(bodyId);
        rotationCache.set(bodyId, q);
      }
      if (q && mesh.quaternion && typeof mesh.quaternion.set === 'function') {
        mesh.quaternion.set(q.x, q.y, q.z, q.w);
      }
    }

    // Start dissolves for colliders that vanished this tick.
    for (const colliderId of [...this._meshes.keys()]) {
      if (seenIds.has(colliderId)) continue;
      const mesh = this._meshes.get(colliderId);
      this._meshes.delete(colliderId);
      this._beginDissolve(mesh);
    }

    this._tickDissolves();
  }

  // ─── Dissolve animation (plan v2 §2.3.1 K — replaces v1 shatter) ────

  _beginDissolve(mesh) {
    if (!mesh) return;
    const baseScale = (mesh.scale && typeof mesh.scale.x === 'number') ? mesh.scale.x : 1;
    this._dissolving.set(mesh, {
      startMs: this._now(),
      baseScale,
    });
  }

  _tickDissolves() {
    if (this._dissolving.size === 0) return;
    const now = this._now();
    const toRemove = [];
    for (const [mesh, info] of this._dissolving) {
      const t = Math.min(1, (now - info.startMs) / DISSOLVE.DURATION_MS);
      // Opacity fade — guarded on material existing + supporting opacity.
      if (mesh.material) {
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          if (m && 'transparent' in m) m.transparent = true;
          if (m && 'opacity' in m)     m.opacity     = 1 - t;
        }
      }
      // Scale up slightly so the cube reads as dissolving outward.
      if (mesh.scale && typeof mesh.scale.set === 'function') {
        const s = info.baseScale * (1 + (DISSOLVE.END_SCALE - 1) * t);
        mesh.scale.set(s, s, s);
      }
      if (t >= 1) toRemove.push(mesh);
    }
    for (const mesh of toRemove) {
      this._dissolving.delete(mesh);
      this.stackGroup.remove(mesh);
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  dispose() {
    for (const mesh of this._meshes.values()) this.stackGroup.remove(mesh);
    this._meshes.clear();
    for (const mesh of this._dissolving.keys()) this.stackGroup.remove(mesh);
    this._dissolving.clear();
    if (this._parent && this.stackGroup.parent === this._parent) {
      this._parent.remove(this.stackGroup);
    }
  }
}

// Test / introspection accessors.
export const _DISSOLVE = DISSOLVE;
