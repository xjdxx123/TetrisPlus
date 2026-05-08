// Curl-noise field — Stage 4 of plan_particle_2.md.
//
// Bakes a 3D RGBA8 texture once at boot whose RGB channels encode a
// divergence-free curl-noise vector field in [-1,1]. Hardware trilinear
// sampling on the GPU is essentially free; the same data is exposed to JS
// via `sample()` so CPU-integrated layers (the ambient field, today) read
// the *same* directions the GPU would, keeping the visual identical when
// Stage 9 promotes the integrator to the GPU.
//
// Why curl noise: linear (Perlin) noise has nonzero divergence, so particles
// advected along it converge into "rivers" that look fake. Curl(F) is
// divergence-free by construction — the field stays visually full forever
// and motion reads as fluid swirl, not random walk. (Bridson 2007; the
// Tetris Effect particle look depends on this.)

import * as THREE from 'three';

// Integer hash → [0,1). Three big primes; >>> 0 forces unsigned 32-bit.
function hash3(x, y, z) {
  let h = (x | 0) * 374761393 + (y | 0) * 668265263 + (z | 0) * 1274126177;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}
function smooth(t) { return t * t * (3 - 2 * t); }

// 3D value noise in [0,1]. Hash-lattice + smoothstep trilinear interp.
// The curl operator damps high-frequency hash artifacts, so this is
// sufficient in practice — a Perlin or simplex implementation would buy
// little visual quality at 5× the bake cost.
function valueNoise3(x, y, z, seed = 0) {
  const x0 = Math.floor(x), x1 = x0 + 1;
  const y0 = Math.floor(y), y1 = y0 + 1;
  const z0 = Math.floor(z), z1 = z0 + 1;
  const fx = smooth(x - x0), fy = smooth(y - y0), fz = smooth(z - z0);

  const c000 = hash3(x0 + seed, y0, z0);
  const c100 = hash3(x1 + seed, y0, z0);
  const c010 = hash3(x0 + seed, y1, z0);
  const c110 = hash3(x1 + seed, y1, z0);
  const c001 = hash3(x0 + seed, y0, z1);
  const c101 = hash3(x1 + seed, y0, z1);
  const c011 = hash3(x0 + seed, y1, z1);
  const c111 = hash3(x1 + seed, y1, z1);

  const c00 = c000 + (c100 - c000) * fx;
  const c10 = c010 + (c110 - c010) * fx;
  const c01 = c001 + (c101 - c001) * fx;
  const c11 = c011 + (c111 - c011) * fx;
  const c0  = c00  + (c10  - c00 ) * fy;
  const c1  = c01  + (c11  - c01 ) * fy;
  return c0 + (c1 - c0) * fz;
}

/**
 * Bake a 3D curl-noise texture and return a CPU+GPU view.
 *
 * @param {Object} opts
 * @param {number} [opts.size=64]       voxel resolution per axis. 64³ ≈ 256 KB
 *                                       and bakes in <100 ms; 128³ is sharper
 *                                       but ~8× the cost. The CPU sampler
 *                                       trilinears anyway, so 64 looks fine.
 * @param {number} [opts.frequency=1.6] noise cell density in field-space units.
 *                                       Higher = busier swirls.
 * @param {number} [opts.seed=1337]
 * @returns {{
 *   texture: THREE.Data3DTexture,
 *   size: number,
 *   sample: (out: Float32Array, x: number, y: number, z: number) => Float32Array,
 *   dispose: () => void,
 * }}
 */
export function bakeCurlNoise3D({ size = 64, frequency = 1.6, seed = 1337 } = {}) {
  const N = size;
  const N2 = N * N;
  const inv = 1 / N;

  // Pre-compute three independent scalar fields once. Computing curl from
  // these via finite differences avoids redundant noise calls (vs. sampling
  // 6 neighbors per voxel inline) and drops bake time ~6×.
  const fA = new Float32Array(N * N * N);
  const fB = new Float32Array(N * N * N);
  const fC = new Float32Array(N * N * N);
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const u = x * inv * frequency;
        const v = y * inv * frequency;
        const w = z * inv * frequency;
        const idx = z * N2 + y * N + x;
        // Three uncorrelated fields via different seed offsets — gives the
        // curl operator three independent scalar potentials to differ.
        fA[idx] = valueNoise3(u,           v,           w,           seed);
        fB[idx] = valueNoise3(u + 31.41,   v + 27.18,   w + 11.13,   seed + 17);
        fC[idx] = valueNoise3(u + 61.83,   v + 53.97,   w + 47.21,   seed + 31);
      }
    }
  }

  const wrap = (i) => ((i % N) + N) % N;
  const ix = (x, y, z) => wrap(z) * N2 + wrap(y) * N + wrap(x);

  // Curl of (fA, fB, fC) by central finite differences (wrapped). The 0.5
  // factor folds in 1/(2·dx); we drop dx because we re-normalize at the end.
  // Range tracked so we can pack to RGBA8 without clipping.
  const data = new Uint8Array(N * N * N * 4);
  const cx = new Float32Array(N * N * N);
  const cy = new Float32Array(N * N * N);
  const cz = new Float32Array(N * N * N);
  let maxAbs = 1e-6;
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const dCdy = (fC[ix(x, y + 1, z)] - fC[ix(x, y - 1, z)]) * 0.5;
        const dBdz = (fB[ix(x, y, z + 1)] - fB[ix(x, y, z - 1)]) * 0.5;
        const dAdz = (fA[ix(x, y, z + 1)] - fA[ix(x, y, z - 1)]) * 0.5;
        const dCdx = (fC[ix(x + 1, y, z)] - fC[ix(x - 1, y, z)]) * 0.5;
        const dBdx = (fB[ix(x + 1, y, z)] - fB[ix(x - 1, y, z)]) * 0.5;
        const dAdy = (fA[ix(x, y + 1, z)] - fA[ix(x, y - 1, z)]) * 0.5;
        const i = z * N2 + y * N + x;
        cx[i] = dCdy - dBdz;
        cy[i] = dAdz - dCdx;
        cz[i] = dBdx - dAdy;
        const m = Math.max(Math.abs(cx[i]), Math.abs(cy[i]), Math.abs(cz[i]));
        if (m > maxAbs) maxAbs = m;
      }
    }
  }

  // Normalize to [-1,1] and pack to RGBA8. Storing the same float values in
  // a JS-side mirror keeps the CPU sampler honest about what the GPU sees.
  const cpu = new Float32Array(N * N * N * 3);
  const k = 1 / maxAbs;
  for (let i = 0; i < N * N * N; i++) {
    const nx = cx[i] * k;
    const ny = cy[i] * k;
    const nz = cz[i] * k;
    cpu[i * 3 + 0] = nx;
    cpu[i * 3 + 1] = ny;
    cpu[i * 3 + 2] = nz;
    data[i * 4 + 0] = Math.round(nx * 127 + 128);
    data[i * 4 + 1] = Math.round(ny * 127 + 128);
    data[i * 4 + 2] = Math.round(nz * 127 + 128);
    data[i * 4 + 3] = 255;
  }

  const texture = new THREE.Data3DTexture(data, N, N, N);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.wrapR = THREE.RepeatWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;

  // Trilinear CPU sampler in normalized field space — coords get wrapped, so
  // any input range works. Returns into `out` to avoid GC churn in the hot
  // particle loop.
  function sample(out, x, y, z) {
    const fx = x * N, fy = y * N, fz = z * N;
    const x0 = Math.floor(fx), x1 = x0 + 1;
    const y0 = Math.floor(fy), y1 = y0 + 1;
    const z0 = Math.floor(fz), z1 = z0 + 1;
    const tx = fx - x0, ty = fy - y0, tz = fz - z0;
    const wx0 = wrap(x0), wx1 = wrap(x1);
    const wy0 = wrap(y0), wy1 = wrap(y1);
    const wz0 = wrap(z0), wz1 = wrap(z1);
    const i000 = (wz0 * N2 + wy0 * N + wx0) * 3;
    const i100 = (wz0 * N2 + wy0 * N + wx1) * 3;
    const i010 = (wz0 * N2 + wy1 * N + wx0) * 3;
    const i110 = (wz0 * N2 + wy1 * N + wx1) * 3;
    const i001 = (wz1 * N2 + wy0 * N + wx0) * 3;
    const i101 = (wz1 * N2 + wy0 * N + wx1) * 3;
    const i011 = (wz1 * N2 + wy1 * N + wx0) * 3;
    const i111 = (wz1 * N2 + wy1 * N + wx1) * 3;

    for (let c = 0; c < 3; c++) {
      const c00 = cpu[i000 + c] + (cpu[i100 + c] - cpu[i000 + c]) * tx;
      const c10 = cpu[i010 + c] + (cpu[i110 + c] - cpu[i010 + c]) * tx;
      const c01 = cpu[i001 + c] + (cpu[i101 + c] - cpu[i001 + c]) * tx;
      const c11 = cpu[i011 + c] + (cpu[i111 + c] - cpu[i011 + c]) * tx;
      const c0  = c00  + (c10  - c00 ) * ty;
      const c1  = c01  + (c11  - c01 ) * ty;
      out[c] = c0 + (c1 - c0) * tz;
    }
    return out;
  }

  return {
    texture,
    size: N,
    sample,
    dispose() { texture.dispose(); },
  };
}
