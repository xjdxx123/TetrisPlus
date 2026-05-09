// 3D Tetris kick tables (plan v2 §2.1 Phase D-2, archived
// plan_gameplay_1.md §6.4).
//
// In 2D Tetris, a rotation that would intersect the wall / floor /
// stack tries up to 5 SRS offset tests in order; the first non-
// colliding offset wins. In 3D, the analogue is 19 offsets:
//
//   1. identity   — (0, 0, 0)               — no kick
//   2. 6 face     — (±1,0,0), (0,±1,0), (0,0,±1)
//   3. 12 edge    — every (±1,±1,0) / (±1,0,±1) / (0,±1,±1)
//
// The test order is biased by the rotation axis: a Z-axis rotation
// tries (dx, dy) shifts first (mirroring 2D SRS), an X-axis rotation
// tries (dy, dz), a Y-axis rotation tries (dx, dz). Edge offsets come
// after face offsets in all cases.
//
// Pure module — operates on integer offset triples. No piece geometry
// dependencies; the caller in `Game._tryRotate3D` applies each offset
// to the piece's (col, row, depth) and tests collision.

/**
 * @typedef {Object} Kick3D
 * @property {number} dx
 * @property {number} dy
 * @property {number} dz
 */

const ZERO = Object.freeze({ dx: 0, dy: 0, dz: 0 });

// Face offsets — 6 axis-aligned unit vectors. Order preference is
// "horizontal nudge first" (matches the 2D SRS bias toward lateral
// kicks) — players expect a tetracube that almost-fits to step
// sideways before stepping up.
const FACE_X = Object.freeze([
  Object.freeze({ dx:  1, dy: 0, dz: 0 }),
  Object.freeze({ dx: -1, dy: 0, dz: 0 }),
]);
const FACE_Y = Object.freeze([
  Object.freeze({ dx: 0, dy:  1, dz: 0 }),
  Object.freeze({ dx: 0, dy: -1, dz: 0 }),
]);
const FACE_Z = Object.freeze([
  Object.freeze({ dx: 0, dy: 0, dz:  1 }),
  Object.freeze({ dx: 0, dy: 0, dz: -1 }),
]);

// Edge offsets — 12 vectors. Grouped by which 2D plane they lie in
// so per-axis kick tables can prepend the relevant in-plane edges.
const EDGE_XY = Object.freeze([
  Object.freeze({ dx:  1, dy:  1, dz: 0 }),
  Object.freeze({ dx: -1, dy:  1, dz: 0 }),
  Object.freeze({ dx:  1, dy: -1, dz: 0 }),
  Object.freeze({ dx: -1, dy: -1, dz: 0 }),
]);
const EDGE_XZ = Object.freeze([
  Object.freeze({ dx:  1, dy: 0, dz:  1 }),
  Object.freeze({ dx: -1, dy: 0, dz:  1 }),
  Object.freeze({ dx:  1, dy: 0, dz: -1 }),
  Object.freeze({ dx: -1, dy: 0, dz: -1 }),
]);
const EDGE_YZ = Object.freeze([
  Object.freeze({ dx: 0, dy:  1, dz:  1 }),
  Object.freeze({ dx: 0, dy: -1, dz:  1 }),
  Object.freeze({ dx: 0, dy:  1, dz: -1 }),
  Object.freeze({ dx: 0, dy: -1, dz: -1 }),
]);

/**
 * Build the kick test sequence for a rotation around `axis`. The
 * returned array starts with the identity (no-kick) test, then
 * face-neighbors in the rotation plane, then face-neighbors out of
 * plane, then edge-neighbors in plane, then remaining edges. Order
 * is the order players will EXPERIENCE — first hit wins.
 *
 * @param {'x'|'y'|'z'} axis
 * @returns {Readonly<Kick3D>[]}
 */
export function getKicks3D(axis) {
  switch (axis) {
    case 'x':
      // X-axis rotation — pivot stays at the piece's X. The plane
      // perpendicular to X is the YZ plane, so YZ kicks first.
      return Object.freeze([
        ZERO,
        ...FACE_Y, ...FACE_Z,   // in-plane faces
        ...FACE_X,              // out-of-plane face
        ...EDGE_YZ,             // in-plane edges
        ...EDGE_XY, ...EDGE_XZ, // out-of-plane edges
      ]);
    case 'y':
      // Y-axis rotation — XZ plane is in-plane.
      return Object.freeze([
        ZERO,
        ...FACE_X, ...FACE_Z,
        ...FACE_Y,
        ...EDGE_XZ,
        ...EDGE_XY, ...EDGE_YZ,
      ]);
    case 'z':
    default:
      // Z-axis rotation — XY plane is in-plane (matches 2D Tetris
      // intuition: lateral nudge first).
      return Object.freeze([
        ZERO,
        ...FACE_X, ...FACE_Y,
        ...FACE_Z,
        ...EDGE_XY,
        ...EDGE_XZ, ...EDGE_YZ,
      ]);
  }
}

/** Total number of kick tests for any axis (identity + 6 faces + 12 edges). */
export const KICK_TEST_COUNT = 1 + 6 + 12;
