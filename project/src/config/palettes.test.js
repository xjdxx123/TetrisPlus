import { describe, it, expect } from 'vitest';
import { _buildLUT, PALETTE_NAMES } from './palettes.js';

describe('palettes', () => {
  it('PALETTE_NAMES includes the starter set', () => {
    expect(PALETTE_NAMES).toEqual(expect.arrayContaining(['deep-cyan', 'ember', 'aurora', 'void']));
  });

  it('LUT has 256x4 RGBA entries', () => {
    const stops = [
      { t: 0, color: [0, 0, 0] },
      { t: 1, color: [1, 1, 1] },
    ];
    const data = _buildLUT(stops);
    expect(data).toHaveLength(256 * 4);
  });

  it('endpoints map to first/last stop colors (within FP rounding)', () => {
    // ±1 byte tolerance — IEEE-754 means 255 * 0.9 = 229.4999… not 229.5,
    // so Math.round gives 229 instead of the "obvious" 230. We don't need
    // exact rounding behavior, just that endpoints land where expected.
    const stops = [
      { t: 0, color: [0.10, 0.20, 0.30] },
      { t: 1, color: [0.80, 0.90, 0.40] },
    ];
    const data = _buildLUT(stops);
    expect(Math.abs(data[0] - 26)).toBeLessThanOrEqual(1);
    expect(Math.abs(data[1] - 51)).toBeLessThanOrEqual(1);
    expect(Math.abs(data[2] - 77)).toBeLessThanOrEqual(1);
    const last = 255 * 4;
    expect(Math.abs(data[last + 0] - 204)).toBeLessThanOrEqual(1);
    expect(Math.abs(data[last + 1] - 230)).toBeLessThanOrEqual(1);
    expect(Math.abs(data[last + 2] - 102)).toBeLessThanOrEqual(1);
  });

  it('linearly interpolates between stops', () => {
    const stops = [
      { t: 0, color: [0, 0, 0] },
      { t: 1, color: [1, 1, 1] },
    ];
    const data = _buildLUT(stops);
    // Midpoint should be ~mid-grey
    const mid = 128 * 4;
    expect(data[mid]).toBeGreaterThan(120);
    expect(data[mid]).toBeLessThan(135);
  });

  it('alpha is always 255', () => {
    const data = _buildLUT([{ t: 0, color: [0, 0, 0] }, { t: 1, color: [1, 1, 1] }]);
    for (let i = 3; i < data.length; i += 4) {
      expect(data[i]).toBe(255);
    }
  });

  it('clamps out-of-range color values to [0, 255]', () => {
    const data = _buildLUT([
      { t: 0, color: [-0.5, 1.5, 0.5] },
      { t: 1, color: [0.5, -0.5, 1.5] },
    ]);
    for (let i = 0; i < data.length; i++) {
      expect(data[i]).toBeGreaterThanOrEqual(0);
      expect(data[i]).toBeLessThanOrEqual(255);
    }
  });
});
