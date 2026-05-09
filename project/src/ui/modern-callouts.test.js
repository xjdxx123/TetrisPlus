// Tests for the pure formatter in modern-callouts.js.
//
// DOM rendering is not tested (matches the project's existing UI
// precedent — `marathon-badge.js` / `versus-badge.js` etc. ship
// without test files). What IS tested is the topic→callout-string
// translation, since that's the player-visible truth.

import { describe, it, expect } from 'vitest';
import { formatCallout, _SUPPRESSED_TOPICS } from './modern-callouts.js';

describe('formatCallout — T_SPIN', () => {
  it('regular T-spin no-clear → "T-SPIN"', () => {
    expect(formatCallout('T_SPIN', { kind: 'tspin', cleared: 0 }))
      .toEqual({ text: 'T-SPIN', kind: 'tspin' });
  });

  it('regular T-spin Single / Double / Triple', () => {
    expect(formatCallout('T_SPIN', { kind: 'tspin', cleared: 1 }))
      .toEqual({ text: 'T-SPIN SINGLE', kind: 'tspin' });
    expect(formatCallout('T_SPIN', { kind: 'tspin', cleared: 2 }))
      .toEqual({ text: 'T-SPIN DOUBLE', kind: 'tspin' });
    expect(formatCallout('T_SPIN', { kind: 'tspin', cleared: 3 }))
      .toEqual({ text: 'T-SPIN TRIPLE', kind: 'tspin' });
  });

  it('T-spin Mini: no-clear → "T-SPIN MINI", Single → "T-SPIN MINI SINGLE"', () => {
    expect(formatCallout('T_SPIN', { kind: 'mini', cleared: 0 }))
      .toEqual({ text: 'T-SPIN MINI', kind: 'mini' });
    expect(formatCallout('T_SPIN', { kind: 'mini', cleared: 1 }))
      .toEqual({ text: 'T-SPIN MINI SINGLE', kind: 'mini' });
  });

  it('cleared ≥ 4 (defensive) → no suffix, base label only', () => {
    expect(formatCallout('T_SPIN', { kind: 'tspin', cleared: 4 }))
      .toEqual({ text: 'T-SPIN', kind: 'tspin' });
  });
});

describe('formatCallout — B2B_CHAIN', () => {
  it('count = 1 (first difficult clear of a chain) → suppressed (null)', () => {
    expect(formatCallout('B2B_CHAIN', { count: 1 })).toBeNull();
  });

  it('count = 2 → "BACK-TO-BACK ×2"', () => {
    expect(formatCallout('B2B_CHAIN', { count: 2 }))
      .toEqual({ text: 'BACK-TO-BACK ×2', kind: 'b2b' });
  });

  it('high count carries through verbatim', () => {
    expect(formatCallout('B2B_CHAIN', { count: 9 }).text).toBe('BACK-TO-BACK ×9');
    expect(formatCallout('B2B_CHAIN', { count: 42 }).text).toBe('BACK-TO-BACK ×42');
  });
});

describe('formatCallout — PERFECT_CLEAR', () => {
  it('Single PC → "PERFECT CLEAR · SINGLE"', () => {
    expect(formatCallout('PERFECT_CLEAR', { cleared: 1 }))
      .toEqual({ text: 'PERFECT CLEAR · SINGLE', kind: 'pc' });
  });

  it('Tetris PC → "PERFECT CLEAR · TETRIS"', () => {
    expect(formatCallout('PERFECT_CLEAR', { cleared: 4 }))
      .toEqual({ text: 'PERFECT CLEAR · TETRIS', kind: 'pc' });
  });

  it('cleared = 0 (defensive: no-clear can never PC) → bare "PERFECT CLEAR"', () => {
    expect(formatCallout('PERFECT_CLEAR', { cleared: 0 }))
      .toEqual({ text: 'PERFECT CLEAR', kind: 'pc' });
  });
});

describe('formatCallout — GARBAGE_CANCELLED', () => {
  it('rows > 0 → "CANCELLED ×N"', () => {
    expect(formatCallout('GARBAGE_CANCELLED', { rows: 4 }))
      .toEqual({ text: 'CANCELLED ×4', kind: 'cancelled' });
  });

  it('rows = 0 → suppressed (null)', () => {
    expect(formatCallout('GARBAGE_CANCELLED', { rows: 0 })).toBeNull();
  });

  it('negative rows defensively suppressed', () => {
    expect(formatCallout('GARBAGE_CANCELLED', { rows: -1 })).toBeNull();
  });
});

describe('formatCallout — suppression / negative cases', () => {
  it('null payload → null', () => {
    expect(formatCallout('T_SPIN', null)).toBeNull();
  });

  it('non-object payload → null', () => {
    expect(formatCallout('T_SPIN', 42)).toBeNull();
    expect(formatCallout('T_SPIN', 'oops')).toBeNull();
  });

  it('unknown topic → null', () => {
    expect(formatCallout('NOT_A_TOPIC', { count: 1 })).toBeNull();
    expect(formatCallout('LINE_CLEAR', { simultaneous: 4 })).toBeNull();
  });

  it('explicitly suppressed topics produce no callout', () => {
    for (const topic of _SUPPRESSED_TOPICS) {
      expect(formatCallout(topic, { count: 5 })).toBeNull();
    }
  });

  it('exposes the suppression list for documentation / introspection', () => {
    expect(_SUPPRESSED_TOPICS).toEqual(['COMBO_START', 'COMBO_END', 'B2B_BREAK']);
  });
});
