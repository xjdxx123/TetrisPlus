import { describe, it, expect } from 'vitest';
import { lineClearScore, levelForLines, SOFT_DROP_POINTS_PER_CELL, HARD_DROP_POINTS_PER_CELL } from './scoring.js';

describe('scoring', () => {
  it('lineClearScore matches standard Tetris values at level 1', () => {
    expect(lineClearScore(0, 1)).toBe(0);
    expect(lineClearScore(1, 1)).toBe(100);
    expect(lineClearScore(2, 1)).toBe(300);
    expect(lineClearScore(3, 1)).toBe(500);
    expect(lineClearScore(4, 1)).toBe(800);
  });

  it('lineClearScore scales linearly with level', () => {
    expect(lineClearScore(4, 5)).toBe(4000);
    expect(lineClearScore(1, 10)).toBe(1000);
  });

  it('lineClearScore caps oversized inputs at 4-row value', () => {
    expect(lineClearScore(5, 1)).toBe(800);
    expect(lineClearScore(99, 2)).toBe(1600);
  });

  it('levelForLines starts at 1 and advances every 10 lines', () => {
    expect(levelForLines(0)).toBe(1);
    expect(levelForLines(9)).toBe(1);
    expect(levelForLines(10)).toBe(2);
    expect(levelForLines(99)).toBe(10);
    expect(levelForLines(100)).toBe(11);
  });

  it('drop-point constants are stable', () => {
    expect(SOFT_DROP_POINTS_PER_CELL).toBe(1);
    expect(HARD_DROP_POINTS_PER_CELL).toBe(2);
  });
});

// ─── M2: T-spin scoring tables (plan §12.5 M2) ────────────────────────

describe('scoring — T-spin clearType', () => {
  it('T-spin no-clear (0 rows) awards 400 × level', () => {
    expect(lineClearScore(0, 1, 'tspin')).toBe(400);
    expect(lineClearScore(0, 5, 'tspin')).toBe(2000);
  });

  it('T-spin Single = 800 × level', () => {
    expect(lineClearScore(1, 1, 'tspin')).toBe(800);
    expect(lineClearScore(1, 7, 'tspin')).toBe(5600);
  });

  it('T-spin Double = 1200 × level', () => {
    expect(lineClearScore(2, 1, 'tspin')).toBe(1200);
    expect(lineClearScore(2, 3, 'tspin')).toBe(3600);
  });

  it('T-spin Triple = 1600 × level', () => {
    expect(lineClearScore(3, 1, 'tspin')).toBe(1600);
    expect(lineClearScore(3, 4, 'tspin')).toBe(6400);
  });

  it('T-spin Mini no-clear = 100 × level', () => {
    expect(lineClearScore(0, 1, 'mini')).toBe(100);
    expect(lineClearScore(0, 9, 'mini')).toBe(900);
  });

  it('T-spin Mini Single = 200 × level', () => {
    expect(lineClearScore(1, 1, 'mini')).toBe(200);
    expect(lineClearScore(1, 6, 'mini')).toBe(1200);
  });

  it('Mini >Single falls back to regular T-spin table (defensive)', () => {
    // Mini Double / Triple don't exist in the guideline; the function
    // upgrades to the regular T-spin table rather than silently returning
    // zero or out-of-bounds.
    expect(lineClearScore(2, 1, 'mini')).toBe(1200); // = T-spin Double
    expect(lineClearScore(3, 1, 'mini')).toBe(1600); // = T-spin Triple
  });

  it('clearType "normal" / undefined uses the standard table', () => {
    expect(lineClearScore(4, 1, 'normal')).toBe(800);
    expect(lineClearScore(4, 1)).toBe(800);
  });
});
