import { describe, it, expect } from 'vitest';
import { createStarfield } from './starfield.js';

describe('starfield', () => {
  it('allocates exactly `count` points', () => {
    const sf = createStarfield({ count: 200, radius: 50 });
    const positions = sf.points.geometry.attributes.position;
    expect(positions.count).toBe(200);
    expect(positions.array).toHaveLength(600);
    sf.dispose();
  });

  it('stars sit on (or just inside) the requested sphere shell', () => {
    const sf = createStarfield({ count: 300, radius: 80 });
    const arr = sf.points.geometry.attributes.position.array;
    for (let i = 0; i < arr.length; i += 3) {
      const r = Math.hypot(arr[i], arr[i + 1], arr[i + 2]);
      // Outer shell at radius; inner ~8% are at 0.7 * radius. Allow 1% slop.
      expect(r).toBeGreaterThan(80 * 0.65);
      expect(r).toBeLessThan(80 * 1.01);
    }
    sf.dispose();
  });

  it('material flags itself bloom-eligible (Stage 2 hook)', () => {
    const sf = createStarfield({ count: 50 });
    expect(sf.material.userData.enableBloom).toBe(true);
    sf.dispose();
  });

  it('rotation accumulates with dt', () => {
    const sf = createStarfield({ count: 50, rotationSpeed: 0.5 });
    const r0 = sf.group.rotation.y;
    sf.update(2);
    expect(sf.group.rotation.y).toBeCloseTo(r0 + 1.0, 5);
    sf.update(1);
    expect(sf.group.rotation.y).toBeCloseTo(r0 + 1.5, 5);
    sf.dispose();
  });

  it('setPixelRatio writes the uPx uniform', () => {
    const sf = createStarfield({ count: 10, pixelRatio: 1 });
    sf.setPixelRatio(2.5);
    expect(sf.material.uniforms.uPx.value).toBe(2.5);
    sf.dispose();
  });
});
