// Tests for the seeded PRNG (plan_gameplay_1.md §3.7 sub-phase 7f).

import { describe, it, expect } from 'vitest';
import { createSeededRng, fromString } from './seeded.js';

describe('createSeededRng', () => {
  it('returns a function producing values in [0, 1)', () => {
    const rng = createSeededRng(1);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is deterministic — same seed → same sequence', () => {
    const a = createSeededRng(42);
    const b = createSeededRng(42);
    for (let i = 0; i < 50; i++) {
      expect(a()).toBe(b());
    }
  });

  it('different seeds → different sequences (with high probability)', () => {
    const a = createSeededRng(1);
    const b = createSeededRng(2);
    let same = true;
    for (let i = 0; i < 10; i++) {
      if (a() !== b()) { same = false; break; }
    }
    expect(same).toBe(false);
  });

  it('exposes mutable state for serialize/restore', () => {
    const rng = createSeededRng(7);
    rng(); rng(); rng();
    const snap = rng.state;
    expect(typeof snap).toBe('number');
    expect(snap).toBeGreaterThanOrEqual(0);
    // setState rewinds to the same point.
    const a1 = rng();
    rng.setState(snap);
    const a2 = rng();
    expect(a1).toBe(a2);
  });

  it('state property is settable too', () => {
    const rng = createSeededRng(7);
    rng();
    const snap = rng.state;
    rng();
    rng();
    rng.state = snap;
    const next1 = rng();
    rng.state = snap;
    const next2 = rng();
    expect(next1).toBe(next2);
  });

  it('clone() forks a rng with the same state, independent advancement', () => {
    const a = createSeededRng(99);
    a(); a();
    const b = a.clone();
    expect(b()).toBe(a()); // same next value
    a(); // advances a only
    const aNext = a();
    expect(b() === aNext).toBe(false); // diverged
  });

  it('seed=0 still produces a valid sequence', () => {
    const rng = createSeededRng(0);
    const v = rng();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThan(1);
  });

  it('coerces non-integer seeds via | 0', () => {
    const a = createSeededRng(3.7);
    const b = createSeededRng(3);
    expect(a()).toBe(b());
  });
});

describe('fromString', () => {
  it('produces a uint32 seed', () => {
    const s = fromString('match-12345');
    expect(typeof s).toBe('number');
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(0xffffffff);
  });

  it('is deterministic', () => {
    expect(fromString('hello')).toBe(fromString('hello'));
  });

  it('different inputs produce different outputs (collision-free for short distinct strings)', () => {
    expect(fromString('a')).not.toBe(fromString('b'));
    expect(fromString('match-1')).not.toBe(fromString('match-2'));
  });

  it('empty string is well-defined', () => {
    expect(typeof fromString('')).toBe('number');
  });
});
