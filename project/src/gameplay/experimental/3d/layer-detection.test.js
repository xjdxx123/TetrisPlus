import { describe, it, expect } from 'vitest';
import { detectFullLayers, settleAfterClear, LAYER_CLEAR_SCORE } from './layer-detection.js';

/** Helper: produce all cells of a single full Y-slab on a cols × depth grid. */
function fullLayer(y, cols = 10, depth = 10) {
  const cells = [];
  for (let x = 0; x < cols; x++) {
    for (let z = 0; z < depth; z++) {
      cells.push([x, y, z]);
    }
  }
  return cells;
}

describe('detectFullLayers', () => {
  it('returns [] when no layer is full', () => {
    expect(detectFullLayers([])).toEqual([]);
    expect(detectFullLayers([[0, 0, 0], [1, 0, 0]])).toEqual([]);
  });

  it('detects a single full layer at Y=0', () => {
    expect(detectFullLayers(fullLayer(0))).toEqual([0]);
  });

  it('detects a full layer above empty space', () => {
    expect(detectFullLayers(fullLayer(5))).toEqual([5]);
  });

  it('detects multiple full layers, sorted bottom-up', () => {
    const cells = [...fullLayer(2), ...fullLayer(0), ...fullLayer(7)];
    expect(detectFullLayers(cells)).toEqual([0, 2, 7]);
  });

  it('does not report a layer with one missing cell', () => {
    const cells = fullLayer(3).slice(1); // drop the very first cell
    expect(detectFullLayers(cells)).toEqual([]);
  });

  it('honours custom cols/depth (smaller footprint = fewer cells needed)', () => {
    expect(detectFullLayers(fullLayer(0, 4, 4), 4, 4)).toEqual([0]);
    // Same cell list, but interpreted as 5x5 → not full
    expect(detectFullLayers(fullLayer(0, 4, 4), 5, 5)).toEqual([]);
  });

  it('ignores cells outside the cols/depth bounds', () => {
    const cells = [...fullLayer(0), [-1, 0, 0], [10, 0, 0], [0, 0, 10]];
    expect(detectFullLayers(cells)).toEqual([0]);
  });

  it('treats duplicate cells idempotently (does not double-count)', () => {
    const cells = [...fullLayer(0), ...fullLayer(0).slice(0, 5)];
    expect(detectFullLayers(cells)).toEqual([0]);
  });

  it('returns [] when cols or depth is zero', () => {
    expect(detectFullLayers(fullLayer(0), 0, 10)).toEqual([]);
    expect(detectFullLayers(fullLayer(0), 10, 0)).toEqual([]);
  });

  it('rejects non-integer coordinates without crashing', () => {
    const cells = [...fullLayer(0), [0.5, 0, 0]];
    expect(detectFullLayers(cells)).toEqual([0]);
  });
});

describe('settleAfterClear', () => {
  it('returns a copy when no layers are cleared', () => {
    const cells = [[1, 2, 3], [4, 5, 6]];
    const out = settleAfterClear(cells, []);
    expect(out).toEqual(cells);
    expect(out).not.toBe(cells); // shallow copy
  });

  it('drops a single cleared layer; cells above shift down by 1', () => {
    const cells = [[0, 0, 0], [0, 1, 0], [0, 2, 0], [0, 3, 0]];
    expect(settleAfterClear(cells, [1])).toEqual([
      [0, 0, 0],
      [0, 1, 0], // was Y=2, dropped to Y=1
      [0, 2, 0], // was Y=3, dropped to Y=2
    ]);
  });

  it('drops multiple cleared layers; cells above shift down by total below them', () => {
    const cells = [[0, 0, 0], [0, 1, 0], [0, 2, 0], [0, 3, 0], [0, 4, 0]];
    expect(settleAfterClear(cells, [1, 3])).toEqual([
      [0, 0, 0],
      [0, 1, 0], // was Y=2, one cleared below (Y=1) → drop 1
      [0, 2, 0], // was Y=4, two cleared below (Y=1, Y=3) → drop 2
    ]);
  });

  it('cleared cells are removed entirely (not just relocated)', () => {
    const cells = fullLayer(0); // 100 cells at Y=0
    expect(settleAfterClear(cells, [0])).toEqual([]);
  });

  it('handles cleared layers passed in arbitrary order', () => {
    const cells = [[0, 0, 0], [0, 1, 0], [0, 2, 0], [0, 3, 0]];
    expect(settleAfterClear(cells, [3, 0])).toEqual([
      [0, 0, 0], // was Y=1, one cleared below (Y=0) → Y=0
      [0, 1, 0], // was Y=2, one cleared below (Y=0) → Y=1
    ]);
  });

  it('preserves x and z coordinates', () => {
    const cells = [[3, 0, 7], [3, 1, 7], [3, 2, 7]];
    expect(settleAfterClear(cells, [1])).toEqual([
      [3, 0, 7],
      [3, 1, 7],
    ]);
  });

  it('does not mutate the input cells', () => {
    const cells = [[0, 0, 0], [0, 1, 0]];
    const snapshot = JSON.stringify(cells);
    settleAfterClear(cells, [0]);
    expect(JSON.stringify(cells)).toBe(snapshot);
  });
});

describe('LAYER_CLEAR_SCORE', () => {
  it('matches the archived §6.5 table: [0, 1000, 3000, 5000, 8000]', () => {
    expect(LAYER_CLEAR_SCORE).toEqual([0, 1000, 3000, 5000, 8000]);
  });

  it('is monotonically increasing (more layers = more score)', () => {
    for (let i = 1; i < LAYER_CLEAR_SCORE.length; i++) {
      expect(LAYER_CLEAR_SCORE[i]).toBeGreaterThan(LAYER_CLEAR_SCORE[i - 1]);
    }
  });

  it('escalates faster than 2D (multi-layer bonuses are super-linear)', () => {
    // 2-layer is 3× single-layer (vs. 2D's standard double-clear which
    // is ~3×). The shape matches; the absolute values are 10× higher.
    expect(LAYER_CLEAR_SCORE[2] / LAYER_CLEAR_SCORE[1]).toBe(3);
    // 4-layer ("Tetris" in 3D) is 8× a single-layer clear.
    expect(LAYER_CLEAR_SCORE[4] / LAYER_CLEAR_SCORE[1]).toBe(8);
  });
});
