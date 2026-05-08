import { describe, it, expect } from 'vitest';
import { PIECES, PIECE_COLORS, PIECE_KEYS } from './pieces.js';

describe('pieces', () => {
  it('exposes all 7 standard tetrominoes', () => {
    expect(PIECE_KEYS).toEqual(expect.arrayContaining(['I', 'O', 'T', 'S', 'Z', 'J', 'L']));
    expect(PIECE_KEYS).toHaveLength(7);
  });

  it('every piece has 4 rotation states of 4×4 grids', () => {
    for (const key of PIECE_KEYS) {
      const rots = PIECES[key];
      expect(rots).toHaveLength(4);
      for (const grid of rots) {
        expect(grid).toHaveLength(4);
        for (const row of grid) expect(row).toHaveLength(4);
      }
    }
  });

  it('every piece occupies exactly 4 cells in every rotation', () => {
    for (const key of PIECE_KEYS) {
      for (const grid of PIECES[key]) {
        const occupied = grid.flat().filter((c) => c === 1).length;
        expect(occupied).toBe(4);
      }
    }
  });

  it('every piece has a hex color', () => {
    for (const key of PIECE_KEYS) {
      expect(typeof PIECE_COLORS[key]).toBe('number');
      expect(PIECE_COLORS[key]).toBeGreaterThanOrEqual(0);
      expect(PIECE_COLORS[key]).toBeLessThanOrEqual(0xffffff);
    }
  });

  it('exported tables are frozen', () => {
    expect(Object.isFrozen(PIECES)).toBe(true);
    expect(Object.isFrozen(PIECE_COLORS)).toBe(true);
    expect(Object.isFrozen(PIECE_KEYS)).toBe(true);
  });
});
