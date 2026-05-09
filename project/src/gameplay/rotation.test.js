import { describe, it, expect } from 'vitest';
import {
  KICK_OFFSETS,
  getKickOffsets,
  nextRotation,
  rotationDelta,
  _SRS_KICKS_JLSTZ,
  _SRS_KICKS_I,
} from './rotation.js';

describe('rotation — legacy 1D kick alias', () => {
  it('kick offsets are tried in expected order', () => {
    expect(KICK_OFFSETS).toEqual([0, -1, 1, -2, 2]);
  });

  it('nextRotation increments forward through 0..3 then wraps', () => {
    expect(nextRotation(0, 1)).toBe(1);
    expect(nextRotation(1, 1)).toBe(2);
    expect(nextRotation(2, 1)).toBe(3);
    expect(nextRotation(3, 1)).toBe(0);
  });

  it('nextRotation decrements backward through 3..0 then wraps', () => {
    expect(nextRotation(0, -1)).toBe(3);
    expect(nextRotation(3, -1)).toBe(2);
  });

  it('rotationDelta is direction-only — magnitude is ignored', () => {
    expect(rotationDelta(1)).toBe(1);
    expect(rotationDelta(99)).toBe(1);
    expect(rotationDelta(-1)).toBe(3);
    expect(rotationDelta(0)).toBe(3); // zero treated as backward; matches existing behavior
  });
});

// ─── SRS getKickOffsets ────────────────────────────────────────────────

describe('rotation — getKickOffsets (SRS, plan §12.5 M1)', () => {
  // Sanity — ALL piece keys produce a non-empty array for ALL adjacent
  // rotation pairs. Adjacent = diff ∈ {1, 3} (mod 4); the 4 transitions
  // we care about are (0↔1), (1↔2), (2↔3), (3↔0).
  const PAIRS = [[0,1],[1,0],[1,2],[2,1],[2,3],[3,2],[3,0],[0,3]];

  it('every piece × every adjacent rotation pair returns a non-empty array', () => {
    for (const key of ['I','O','T','S','Z','J','L']) {
      for (const [from, to] of PAIRS) {
        const o = getKickOffsets(key, from, to);
        expect(Array.isArray(o), `${key} ${from}->${to}`).toBe(true);
        expect(o.length, `${key} ${from}->${to}`).toBeGreaterThan(0);
      }
    }
  });

  it('every kick array starts with the in-place test (0,0)', () => {
    for (const key of ['I','O','T','S','Z','J','L']) {
      for (const [from, to] of PAIRS) {
        const o = getKickOffsets(key, from, to);
        expect(o[0]).toEqual({ dCol: 0, dRow: 0 });
      }
    }
  });

  it('JLSTZ pieces share the same kick table', () => {
    for (const [from, to] of PAIRS) {
      const tBase = getKickOffsets('T', from, to);
      for (const key of ['J','L','S','Z']) {
        expect(getKickOffsets(key, from, to)).toEqual(tBase);
      }
    }
  });

  it('I piece has its own (different) kick table', () => {
    // The first NON-zero kick test in J 0→R is (-1, 0); in I 0→R it's (-2, 0).
    expect(getKickOffsets('J', 0, 1)[1]).toEqual({ dCol: -1, dRow:  0 });
    expect(getKickOffsets('I', 0, 1)[1]).toEqual({ dCol: -2, dRow:  0 });
  });

  it('O piece kicks are a 1-element in-place-only array', () => {
    for (const [from, to] of PAIRS) {
      expect(getKickOffsets('O', from, to)).toEqual([{ dCol: 0, dRow: 0 }]);
    }
  });

  it('JLSTZ 0→R guideline values (canonical spot-check)', () => {
    // Reference: harddrop.com/wiki/SRS, JLSTZ wall-kick data.
    expect(getKickOffsets('T', 0, 1)).toEqual([
      { dCol:  0, dRow:  0 },
      { dCol: -1, dRow:  0 },
      { dCol: -1, dRow: +1 },
      { dCol:  0, dRow: -2 },
      { dCol: -1, dRow: -2 },
    ]);
  });

  it('JLSTZ R→0 guideline values (canonical spot-check)', () => {
    expect(getKickOffsets('T', 1, 0)).toEqual([
      { dCol:  0, dRow:  0 },
      { dCol: +1, dRow:  0 },
      { dCol: +1, dRow: -1 },
      { dCol:  0, dRow: +2 },
      { dCol: +1, dRow: +2 },
    ]);
  });

  it('JLSTZ R→2 reuses the R→0 sign pattern (rightward kicks)', () => {
    // Per the SRS guideline, R→0 and R→2 share the same kick offsets —
    // both are CW or CCW rotations leaving the R-state, and both prefer
    // a rightward bump first.
    expect(getKickOffsets('T', 1, 2)).toEqual(getKickOffsets('T', 1, 0));
  });

  it('I-piece 0→R guideline values (canonical spot-check)', () => {
    expect(getKickOffsets('I', 0, 1)).toEqual([
      { dCol:  0, dRow:  0 },
      { dCol: -2, dRow:  0 },
      { dCol: +1, dRow:  0 },
      { dCol: -2, dRow: -1 },
      { dCol: +1, dRow: +2 },
    ]);
  });

  it('throws on unknown piece key (not silently empty)', () => {
    expect(() => getKickOffsets('X', 0, 1)).toThrow(/unknown piece key/);
  });

  it('all returned arrays and offset objects are frozen', () => {
    const arr = getKickOffsets('T', 0, 1);
    expect(Object.isFrozen(arr)).toBe(true);
    expect(Object.isFrozen(arr[0])).toBe(true);
  });

  it('kick tables are NOT mutated by repeated calls', () => {
    const a = getKickOffsets('T', 0, 1);
    const b = getKickOffsets('T', 0, 1);
    expect(a).toBe(b); // identity — table is the canonical const
  });

  // Symmetry sanity — JLSTZ tables encode 8 transitions; I encodes 8.
  it('SRS_KICKS_JLSTZ has all 4×2 adjacent transitions defined', () => {
    let count = 0;
    for (const from of [0,1,2,3]) {
      for (const to of [0,1,2,3]) {
        if (_SRS_KICKS_JLSTZ[from] && _SRS_KICKS_JLSTZ[from][to]) count++;
      }
    }
    expect(count).toBe(8); // 4 rotations × 2 adjacent neighbors each
  });

  it('SRS_KICKS_I has all 4×2 adjacent transitions defined', () => {
    let count = 0;
    for (const from of [0,1,2,3]) {
      for (const to of [0,1,2,3]) {
        if (_SRS_KICKS_I[from] && _SRS_KICKS_I[from][to]) count++;
      }
    }
    expect(count).toBe(8);
  });
});
