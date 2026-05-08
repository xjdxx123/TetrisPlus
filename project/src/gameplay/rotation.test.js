import { describe, it, expect } from 'vitest';
import { KICK_OFFSETS, nextRotation, rotationDelta } from './rotation.js';

describe('rotation', () => {
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
