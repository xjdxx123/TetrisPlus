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
