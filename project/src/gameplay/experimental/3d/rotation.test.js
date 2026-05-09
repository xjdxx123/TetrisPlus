// Tests for the 3D rotation primitive. Verifies the axis rotations
// individually (4× returns to identity), the normalize/canonicalize
// invariants, and the rotation-order counts that match cube group
// theory for each tetracube's symmetry class.

import { describe, it, expect } from 'vitest';
import {
  rotateX,
  rotateY,
  rotateZ,
  normalize,
  canonicalize,
  enumerateRotations,
  rotationOrder,
} from './rotation.js';
import { TETRACUBES } from './tetracubes.js';

describe('rotateX/rotateY/rotateZ', () => {
  it('rotateX: (x, y, z) → (x, -z, y)', () => {
    expect(rotateX([[1, 2, 3]])).toEqual([[1, -3, 2]]);
  });
  it('rotateY: (x, y, z) → (z, y, -x)', () => {
    expect(rotateY([[1, 2, 3]])).toEqual([[3, 2, -1]]);
  });
  it('rotateZ: (x, y, z) → (-y, x, z)', () => {
    expect(rotateZ([[1, 2, 3]])).toEqual([[-2, 1, 3]]);
  });

  it('applying any single-axis rotation 4 times returns the original (after normalize)', () => {
    const sample = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [1, 1, 0]];
    const original = canonicalize(sample);
    for (const fn of [rotateX, rotateY, rotateZ]) {
      let r = sample;
      for (let i = 0; i < 4; i++) r = fn(r);
      expect(canonicalize(r)).toBe(original);
    }
  });

  it('rotations preserve cell count', () => {
    const sample = TETRACUBES.B.cells.map((c) => [c[0], c[1], c[2]]);
    expect(rotateX(sample)).toHaveLength(4);
    expect(rotateY(sample)).toHaveLength(4);
    expect(rotateZ(sample)).toHaveLength(4);
  });
});

describe('normalize', () => {
  it('translates min corner to the origin', () => {
    const out = normalize([[5, 5, 5], [6, 5, 5]]);
    expect(out).toEqual([[0, 0, 0], [1, 0, 0]]);
  });

  it('handles negative coordinates from rotation', () => {
    const out = normalize([[0, -1, 0], [0, -1, 1]]);
    expect(out).toEqual([[0, 0, 0], [0, 0, 1]]);
  });

  it('returns [] for empty input', () => {
    expect(normalize([])).toEqual([]);
  });
});

describe('canonicalize', () => {
  it('produces the same key for translated copies of the same shape', () => {
    const a = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]];
    const b = [[5, 5, 5], [6, 5, 5], [7, 5, 5], [8, 5, 5]];
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('produces different keys for different shapes', () => {
    const i = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]];
    const o = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]];
    expect(canonicalize(i)).not.toBe(canonicalize(o));
  });

  it('is order-independent (cells reordered → same key)', () => {
    const a = [[0, 0, 0], [1, 0, 0], [2, 0, 0]];
    const b = [[2, 0, 0], [0, 0, 0], [1, 0, 0]];
    expect(canonicalize(a)).toBe(canonicalize(b));
  });
});

describe('enumerateRotations — symmetry class counts', () => {
  // Each orbit size = 24 / |stabilizer| under the cube rotation
  // group. Pinned per-piece by piece geometry:
  //
  //   I:       3   (D4-axis along the bar; stabilizer order 8)
  //   O:       3   (D4-axis perpendicular to its plane; order 8)
  //   T:       12  (single C2 axis through the stem cell)
  //   L:       24  (no rotational symmetry — only mirror)
  //   S:       12  (C2 around the center of the offset)
  //   Branch:  12  (C2 around the stem-to-tip vertical axis)
  //   Screw R: 12  (C2 along a body diagonal — chiral pair stays disjoint)
  //   Screw L: 12

  it('I has 3 unique rotations', () => {
    expect(rotationOrder(TETRACUBES.I.cells)).toBe(3);
  });

  it('O has 3 unique rotations (one per coordinate plane)', () => {
    expect(rotationOrder(TETRACUBES.O.cells)).toBe(3);
  });

  it('T has 12 unique rotations', () => {
    expect(rotationOrder(TETRACUBES.T.cells)).toBe(12);
  });

  it('L has 24 unique rotations (no rotational symmetry)', () => {
    expect(rotationOrder(TETRACUBES.L.cells)).toBe(24);
  });

  it('S has 12 unique rotations', () => {
    expect(rotationOrder(TETRACUBES.S.cells)).toBe(12);
  });

  it('Branch has 12 unique rotations', () => {
    expect(rotationOrder(TETRACUBES.B.cells)).toBe(12);
  });

  it('right and left screws each have 12 unique rotations', () => {
    expect(rotationOrder(TETRACUBES.SR.cells)).toBe(12);
    expect(rotationOrder(TETRACUBES.SL.cells)).toBe(12);
  });

  it('total over all 8 pieces is 90 (3+3+12+24+12+12+12+12)', () => {
    const total =
      rotationOrder(TETRACUBES.I.cells)  +
      rotationOrder(TETRACUBES.O.cells)  +
      rotationOrder(TETRACUBES.T.cells)  +
      rotationOrder(TETRACUBES.L.cells)  +
      rotationOrder(TETRACUBES.S.cells)  +
      rotationOrder(TETRACUBES.B.cells)  +
      rotationOrder(TETRACUBES.SR.cells) +
      rotationOrder(TETRACUBES.SL.cells);
    expect(total).toBe(90);
  });

  it('every orbit size divides the cube rotation group order (24)', () => {
    for (const key of Object.keys(TETRACUBES)) {
      const n = rotationOrder(TETRACUBES[key].cells);
      expect(24 % n).toBe(0);
    }
  });
});

describe('enumerateRotations — chirality property', () => {
  it("right-screw rotations never produce a left-screw shape", () => {
    // The cube rotation group contains no reflections, so no rotation
    // of SR can equal SL. This is the load-bearing reason chirality
    // is encoded as two distinct pieces in the bag (tetracubes.js).
    const rightOrbit = new Set(
      enumerateRotations(TETRACUBES.SR.cells).map((cells) => canonicalize(cells))
    );
    const leftKey = canonicalize(TETRACUBES.SL.cells);
    expect(rightOrbit.has(leftKey)).toBe(false);
  });

  it("the orbits of SR and SL are disjoint", () => {
    const rightOrbit = new Set(
      enumerateRotations(TETRACUBES.SR.cells).map((cells) => canonicalize(cells))
    );
    const leftOrbit = new Set(
      enumerateRotations(TETRACUBES.SL.cells).map((cells) => canonicalize(cells))
    );
    for (const key of leftOrbit) expect(rightOrbit.has(key)).toBe(false);
  });
});

describe('enumerateRotations — invariants per orbit', () => {
  it('every rotation has the same cell count as the input', () => {
    const orbits = enumerateRotations(TETRACUBES.B.cells);
    for (const r of orbits) expect(r).toHaveLength(4);
  });

  it('every rotation is normalized (min coords = 0)', () => {
    const orbits = enumerateRotations(TETRACUBES.SR.cells);
    for (const r of orbits) {
      const minX = Math.min(...r.map((c) => c[0]));
      const minY = Math.min(...r.map((c) => c[1]));
      const minZ = Math.min(...r.map((c) => c[2]));
      expect(minX).toBe(0);
      expect(minY).toBe(0);
      expect(minZ).toBe(0);
    }
  });

  it('every rotation is integer-valued', () => {
    const orbits = enumerateRotations(TETRACUBES.T.cells);
    for (const r of orbits) {
      for (const [x, y, z] of r) {
        expect(Number.isInteger(x)).toBe(true);
        expect(Number.isInteger(y)).toBe(true);
        expect(Number.isInteger(z)).toBe(true);
      }
    }
  });
});
