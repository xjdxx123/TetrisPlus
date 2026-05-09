// Seeded PRNG — the determinism foundation for replay + online versus
// (plan_gameplay_1.md §3.7 sub-phase 7f).
//
// Algorithm: mulberry32 — a tiny, fast 32-bit hash-based PRNG with a
// state of one uint32. Period 2^32, output uniform in [0, 1). Not
// cryptographically secure, but cryptographic strength is irrelevant
// here: the goal is reproducibility (same seed + same input sequence →
// same output sequence) so that a recorded run replays bit-for-bit and
// an online opponent's simulation matches ours frame-for-frame.
//
// Usage:
//   import { createSeededRng, fromString } from '../../shared/random/seeded.js';
//   const rng = createSeededRng(42);
//   rng();          // 0..1
//   rng.state;      // current uint32 — for serialize/restore
//   rng.setState(s);
//
// `Math.random` is BANNED from `gameplay/**` and `app/versus.js` via
// ESLint (eslint.config.js no-restricted-globals). All gameplay/ rng
// flows through this module.
//
// Pure module. No DOM, no THREE.

/**
 * @typedef {(() => number) & {
 *   state: number,
 *   setState: (s:number) => void,
 *   clone: () => SeededRng,
 * }} SeededRng
 */

/**
 * Build a PRNG seeded by the given integer. Returns a function with
 * extra `state` / `setState` / `clone` properties.
 *
 * @param {number} seed   Any integer; coerced to uint32. 0 is fine
 *                        (mulberry32's quality is uniform across seeds).
 * @returns {SeededRng}
 */
export function createSeededRng(seed = 1) {
  let s = (seed | 0) >>> 0;
  const fn = () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  Object.defineProperty(fn, 'state', {
    get() { return s >>> 0; },
    set(v) { s = (v | 0) >>> 0; },
    enumerable: true,
  });
  fn.setState = (v) => { s = (v | 0) >>> 0; };
  fn.clone    = () => createSeededRng(s);
  return fn;
}

/**
 * Hash a string into a uint32 seed. Used when callers want a "named"
 * seed (e.g. a match ID) without parsing it as an integer first.
 *
 * @param {string} str
 * @returns {number}   uint32 seed.
 */
export function fromString(str) {
  // FNV-1a 32-bit — small, well-distributed, no third-party dep.
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
