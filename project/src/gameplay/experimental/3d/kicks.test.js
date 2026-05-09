// 3D kick-table tests (plan v2 §2.1 Phase D-2).

import { describe, it, expect } from 'vitest';
import { getKicks3D, KICK_TEST_COUNT } from './kicks.js';

describe('getKicks3D', () => {
  it('every axis returns 19 tests (identity + 6 face + 12 edge)', () => {
    expect(getKicks3D('x')).toHaveLength(KICK_TEST_COUNT);
    expect(getKicks3D('y')).toHaveLength(KICK_TEST_COUNT);
    expect(getKicks3D('z')).toHaveLength(KICK_TEST_COUNT);
    expect(KICK_TEST_COUNT).toBe(19);
  });

  it('first test is identity (no kick) for every axis', () => {
    for (const axis of ['x', 'y', 'z']) {
      const ks = getKicks3D(axis);
      expect(ks[0]).toEqual({ dx: 0, dy: 0, dz: 0 });
    }
  });

  it('Z-axis bias — first non-identity kicks are in the XY plane', () => {
    // Mirrors 2D SRS: rotating around Z, the player expects a lateral
    // nudge before any vertical or depth shift. So tests 1..4 should
    // be (±1, 0, 0) or (0, ±1, 0).
    const ks = getKicks3D('z');
    for (let i = 1; i <= 4; i++) {
      expect(ks[i].dz).toBe(0);
    }
  });

  it('X-axis bias — first non-identity kicks are in the YZ plane', () => {
    const ks = getKicks3D('x');
    for (let i = 1; i <= 4; i++) {
      expect(ks[i].dx).toBe(0);
    }
  });

  it('Y-axis bias — first non-identity kicks are in the XZ plane', () => {
    const ks = getKicks3D('y');
    for (let i = 1; i <= 4; i++) {
      expect(ks[i].dy).toBe(0);
    }
  });

  it('all 6 face neighbors appear before any edge neighbors', () => {
    for (const axis of ['x', 'y', 'z']) {
      const ks = getKicks3D(axis);
      // Faces have exactly one non-zero component; edges have exactly
      // two. The first 7 entries (identity + 6 faces) should each have
      // ≤ 1 non-zero component.
      for (let i = 0; i < 7; i++) {
        const nonzero = (ks[i].dx !== 0 ? 1 : 0) +
                        (ks[i].dy !== 0 ? 1 : 0) +
                        (ks[i].dz !== 0 ? 1 : 0);
        expect(nonzero).toBeLessThanOrEqual(1);
      }
      // Entries 7..18 are edges → exactly 2 non-zero components each.
      for (let i = 7; i < 19; i++) {
        const nonzero = (ks[i].dx !== 0 ? 1 : 0) +
                        (ks[i].dy !== 0 ? 1 : 0) +
                        (ks[i].dz !== 0 ? 1 : 0);
        expect(nonzero).toBe(2);
      }
    }
  });

  it('all entries are unique (no duplicate offsets within a single axis table)', () => {
    for (const axis of ['x', 'y', 'z']) {
      const ks = getKicks3D(axis);
      const keys = ks.map(k => `${k.dx},${k.dy},${k.dz}`);
      const unique = new Set(keys);
      expect(unique.size).toBe(KICK_TEST_COUNT);
    }
  });

  it('returned tables are immutable (frozen)', () => {
    const ks = getKicks3D('z');
    expect(Object.isFrozen(ks)).toBe(true);
    expect(Object.isFrozen(ks[0])).toBe(true);
  });
});
