import { describe, it, expect } from 'vitest';
import { bakeCurlNoise3D } from './curl-noise.js';

describe('bakeCurlNoise3D', () => {
  it('returns a Data3DTexture sized to the requested resolution', () => {
    const f = bakeCurlNoise3D({ size: 16, frequency: 1.5, seed: 7 });
    expect(f.size).toBe(16);
    expect(f.texture.image.width).toBe(16);
    expect(f.texture.image.height).toBe(16);
    expect(f.texture.image.depth).toBe(16);
    f.dispose();
  });

  it('CPU sampler returns vectors in [-1, 1] for arbitrary coordinates', () => {
    const f = bakeCurlNoise3D({ size: 16, frequency: 1.5, seed: 7 });
    const out = new Float32Array(3);
    // Sweep with negative coords, fractional coords, large coords (wrap test).
    for (const [x, y, z] of [[0, 0, 0], [0.13, 0.7, 0.42], [-1.5, 3.2, 7.7]]) {
      f.sample(out, x, y, z);
      expect(out[0]).toBeGreaterThanOrEqual(-1);
      expect(out[0]).toBeLessThanOrEqual(1);
      expect(out[1]).toBeGreaterThanOrEqual(-1);
      expect(out[1]).toBeLessThanOrEqual(1);
      expect(out[2]).toBeGreaterThanOrEqual(-1);
      expect(out[2]).toBeLessThanOrEqual(1);
    }
    f.dispose();
  });

  it('CPU sampler is continuous: small coordinate steps produce small output deltas', () => {
    const f = bakeCurlNoise3D({ size: 32, frequency: 1.2, seed: 42 });
    const a = new Float32Array(3);
    const b = new Float32Array(3);
    f.sample(a, 0.42, 0.31, 0.17);
    f.sample(b, 0.42 + 1e-3, 0.31, 0.17);
    // With LinearFilter and 32 voxels, 1e-3 in normalized space is ~3% of a
    // voxel — output delta should be O(0.1) at most.
    const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    expect(d).toBeLessThan(0.2);
    f.dispose();
  });

  it('field is approximately divergence-free (curl construction)', () => {
    // Numerical divergence at a sample point: sum of partial derivatives along
    // each axis. For a field built as ∇ × F, this should hover near zero.
    const f = bakeCurlNoise3D({ size: 32, frequency: 1.6, seed: 1337 });
    const eps = 1 / 32; // one voxel step
    const px = new Float32Array(3), nx = new Float32Array(3);
    const py = new Float32Array(3), ny = new Float32Array(3);
    const pz = new Float32Array(3), nz = new Float32Array(3);
    let sumAbsDiv = 0;
    let n = 0;
    for (let i = 0; i < 100; i++) {
      const u = Math.random(), v = Math.random(), w = Math.random();
      f.sample(px, u + eps, v, w);  f.sample(nx, u - eps, v, w);
      f.sample(py, u, v + eps, w);  f.sample(ny, u, v - eps, w);
      f.sample(pz, u, v, w + eps);  f.sample(nz, u, v, w - eps);
      const div = (px[0] - nx[0]) + (py[1] - ny[1]) + (pz[2] - nz[2]);
      sumAbsDiv += Math.abs(div);
      n++;
    }
    // Divergence is dominated by quantization (8-bit RGB) + finite-difference
    // error in the bake itself; in practice it stays well under unit scale.
    // We just want to confirm no large bias has crept in.
    expect(sumAbsDiv / n).toBeLessThan(0.15);
    f.dispose();
  });
});
