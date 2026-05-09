import { describe, it, expect } from 'vitest';
import { garbageForLineCount, pickHoleColumn, applyGarbageToBoard, _GARBAGE_TABLE, _COMBO_BONUS_MAX } from './garbage.js';

describe('garbageForLineCount', () => {
  it('matches the standard Tetris table for a non-combo clear', () => {
    expect(garbageForLineCount(1)).toBe(0);
    expect(garbageForLineCount(2)).toBe(1);
    expect(garbageForLineCount(3)).toBe(2);
    expect(garbageForLineCount(4)).toBe(4);
  });

  it('returns 0 for invalid / zero / negative line counts', () => {
    expect(garbageForLineCount(0)).toBe(0);
    expect(garbageForLineCount(-1)).toBe(0);
    expect(garbageForLineCount(NaN)).toBe(0);
  });

  it('caps over-4 line counts at the tetris value (defensive)', () => {
    expect(garbageForLineCount(7)).toBe(4);
    expect(garbageForLineCount(99)).toBe(4);
  });

  it('combo bonus adds +1 per step up to the cap', () => {
    expect(garbageForLineCount(2, 0)).toBe(1);     // base only
    expect(garbageForLineCount(2, 1)).toBe(2);     // +1
    expect(garbageForLineCount(2, 4)).toBe(1 + _COMBO_BONUS_MAX);
    expect(garbageForLineCount(2, 100)).toBe(1 + _COMBO_BONUS_MAX);
  });

  it('combo never amplifies a 0-base clear (single-line clears never send)', () => {
    expect(garbageForLineCount(1, 0)).toBe(0);
    expect(garbageForLineCount(1, 5)).toBe(0);
    expect(garbageForLineCount(1, 99)).toBe(0);
  });

  it('exposes the table + combo cap for tests that pin specific values', () => {
    expect(_GARBAGE_TABLE).toEqual([0, 0, 1, 2, 4]);
    expect(_COMBO_BONUS_MAX).toBe(4);
  });
});

describe('pickHoleColumn', () => {
  it('returns an in-range integer for the given cols', () => {
    for (let i = 0; i < 50; i++) {
      const c = pickHoleColumn(10, Math.random);
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThan(10);
      expect(Number.isInteger(c)).toBe(true);
    }
  });

  it('uses the injected RNG (deterministic for tests)', () => {
    expect(pickHoleColumn(10, () => 0)).toBe(0);
    expect(pickHoleColumn(10, () => 0.7)).toBe(7);
    expect(pickHoleColumn(10, () => 0.999)).toBe(9);
  });

  it('throws on bad cols', () => {
    expect(() => pickHoleColumn(0)).toThrow();
    expect(() => pickHoleColumn(-1)).toThrow();
    expect(() => pickHoleColumn(NaN)).toThrow();
  });
});

// Helper — a fresh "empty board" of the requested dimensions.
function emptyBoard(rows, cols) {
  const out = [];
  for (let r = 0; r < rows; r++) out.push(new Array(cols).fill(null));
  return out;
}

describe('applyGarbageToBoard', () => {
  it('inserts a single garbage row at the bottom with the hole at holeColumn', () => {
    const board = emptyBoard(20, 10);
    const COLOR = 0x808080;
    const result = applyGarbageToBoard(board, 1, 4, COLOR);
    expect(result.overflowed).toBe(false);
    // Bottom row (index 0) is the new garbage row.
    expect(board[0].length).toBe(10);
    for (let c = 0; c < 10; c++) {
      if (c === 4) expect(board[0][c]).toBeNull();
      else         expect(board[0][c]).toBe(COLOR);
    }
    // Top row (index 19) was empty before and pushed off — replaced by
    // the row that USED to be at index 18 (also empty). All clear.
    expect(board[19].every(c => c === null)).toBe(true);
  });

  it('keeps board height constant after garbage insertion', () => {
    const board = emptyBoard(20, 10);
    applyGarbageToBoard(board, 4, 3, 0x808080);
    expect(board.length).toBe(20);
    expect(board[0].length).toBe(10);
  });

  it('shifts existing stack upward by N rows', () => {
    const board = emptyBoard(20, 10);
    // Plant a single block at row 3 (above the bottom).
    board[3][2] = 0xff0000;
    applyGarbageToBoard(board, 2, 1, 0x808080);
    // The block should now be at row 5 (3 + 2 garbage rows).
    expect(board[5][2]).toBe(0xff0000);
    // Garbage occupies the bottom 2 rows (0 + 1) — NOT the original
    // block's row 3, which is now whatever was below the block before.
    expect(board[0].some(c => c === 0x808080)).toBe(true);
    expect(board[1].some(c => c === 0x808080)).toBe(true);
    expect(board[3].every(c => c === null)).toBe(true);
  });

  it('reports overflowed=true when a popped top row had non-null cells', () => {
    const board = emptyBoard(20, 10);
    // Put a block in the top row.
    board[19][5] = 0xff0000;
    const result = applyGarbageToBoard(board, 1, 0, 0x808080);
    expect(result.overflowed).toBe(true);
  });

  it('reports overflowed=false when the popped top rows were empty', () => {
    const board = emptyBoard(20, 10);
    // Stack only goes up to row 5.
    for (let r = 0; r < 6; r++) board[r][0] = 0x33ff33;
    const result = applyGarbageToBoard(board, 4, 7, 0x808080);
    expect(result.overflowed).toBe(false);
  });

  it('a multi-row garbage drop overflows once per non-empty popped row', () => {
    const board = emptyBoard(20, 10);
    // Top three rows (17, 18, 19) all have a single block — those will
    // be popped off when 3 rows of garbage are applied.
    for (let r = 17; r < 20; r++) board[r][0] = 0xff0000;
    const result = applyGarbageToBoard(board, 3, 4, 0x808080);
    expect(result.overflowed).toBe(true);
  });

  it('hole-column wraps modulo cols (defensive against bad inputs)', () => {
    const board = emptyBoard(20, 10);
    applyGarbageToBoard(board, 1, 13, 0x808080);   // 13 mod 10 = 3
    expect(board[0][3]).toBeNull();
  });

  it('rows=0 is a no-op', () => {
    const board = emptyBoard(20, 10);
    board[5][5] = 0xff0000;
    const result = applyGarbageToBoard(board, 0, 4, 0x808080);
    expect(result.overflowed).toBe(false);
    expect(board[5][5]).toBe(0xff0000);
    expect(board.length).toBe(20);
  });

  it('non-finite rows is a no-op', () => {
    const board = emptyBoard(20, 10);
    expect(applyGarbageToBoard(board, NaN, 4, 0x808080).overflowed).toBe(false);
    expect(applyGarbageToBoard(board, -1,  4, 0x808080).overflowed).toBe(false);
  });
});
