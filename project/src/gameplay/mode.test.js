import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Mode } from './mode.js';

describe('Mode', () => {
  beforeEach(() => Mode._resetForTests());

  it('starts on classic with the full mode list available', () => {
    expect(Mode.current).toBe('classic');
    expect(Mode.available).toContain('classic');
    expect(Mode.available).toContain('versus');
    // 8 modes: 6 standard + 2 experimental (physics §2.3, 3d §2.1).
    expect(Mode.available).toHaveLength(8);
    expect(Mode.available).toContain('physics');
    expect(Mode.available).toContain('3d');
  });

  it('select switches the current mode and notifies listeners', () => {
    const seen = vi.fn();
    Mode.onChange(seen);
    expect(Mode.select('sprint')).toBe(true);
    expect(Mode.current).toBe('sprint');
    expect(seen).toHaveBeenCalledWith('sprint');
  });

  it('select rejects unknown modes without firing listeners', () => {
    const seen = vi.fn();
    Mode.onChange(seen);
    expect(Mode.select('battle-royale')).toBe(false);
    expect(seen).not.toHaveBeenCalled();
    expect(Mode.current).toBe('classic');
  });

  it('select is a no-op when picking the current mode', () => {
    const seen = vi.fn();
    Mode.onChange(seen);
    expect(Mode.select('classic')).toBe(false);
    expect(seen).not.toHaveBeenCalled();
  });

  it('onChange returns an unsubscribe function', () => {
    const seen = vi.fn();
    const off = Mode.onChange(seen);
    Mode.select('zen');
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    Mode.select('marathon');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('listener errors do not break other listeners', () => {
    const ok = vi.fn();
    Mode.onChange(() => { throw new Error('boom'); });
    Mode.onChange(ok);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    Mode.select('ultra');
    expect(ok).toHaveBeenCalledWith('ultra');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('no modes are flagged disabled (Phase 6 enabled Versus)', () => {
    // Pre-Phase-6 had `Mode.disabled.versus = true` because there was no
    // bot or rules pack. Now Versus ships with an AI bot opponent, so
    // every mode key is selectable.
    expect(Mode.disabled.versus).toBeFalsy();
    expect(Mode.disabled.classic).toBeFalsy();
  });
});

describe('Mode — config()', () => {
  beforeEach(() => Mode._resetForTests());

  it('returns the metadata blob for each known key', () => {
    const c = Mode.config('classic');
    expect(c.hudKind).toBe('classic');
    expect(c.goalLabel).toMatch(/Endless/i);
    expect(typeof c.isOnline).toBe('boolean');
    expect(typeof c.isExperimental).toBe('boolean');
  });

  it('falls back to classic for an unknown key', () => {
    expect(Mode.config('garbage-mode').hudKind).toBe('classic');
  });

  it('every standard key has a config entry', () => {
    for (const key of ['classic', 'marathon', 'sprint', 'ultra', 'zen', 'versus']) {
      const c = Mode.config(key);
      expect(typeof c.goalLabel).toBe('string');
      expect(typeof c.hudKind).toBe('string');
    }
  });
});

describe('Mode — start()/stop() lifecycle', () => {
  beforeEach(() => Mode._resetForTests());

  it('start() returns false until a host wires the lifecycle handler', () => {
    expect(Mode.start({ key: 'classic' })).toBe(false);
  });

  it('start() invokes the wired onStart with the resolved key + restart=true default', () => {
    const onStart = vi.fn();
    Mode._wireLifecycle({ onStart });
    Mode.select('marathon');
    expect(Mode.start()).toBe(true);
    expect(onStart).toHaveBeenCalledWith({ key: 'marathon', seed: undefined, restart: true });
  });

  it('start({ key }) selects the key first so listeners stay in sync', () => {
    const onStart = vi.fn();
    const seen = vi.fn();
    Mode._wireLifecycle({ onStart });
    Mode.onChange(seen);
    Mode.start({ key: 'sprint' });
    expect(Mode.current).toBe('sprint');
    expect(seen).toHaveBeenCalledWith('sprint');
    expect(onStart).toHaveBeenCalledWith({ key: 'sprint', seed: undefined, restart: true });
  });

  it('start({ restart: false }) preserves the flag through to the host', () => {
    const onStart = vi.fn();
    Mode._wireLifecycle({ onStart });
    Mode.start({ key: 'classic', restart: false });
    expect(onStart.mock.calls[0][0].restart).toBe(false);
  });

  it('start() with an unknown key returns false without invoking the host', () => {
    const onStart = vi.fn();
    Mode._wireLifecycle({ onStart });
    expect(Mode.start({ key: 'garbage' })).toBe(false);
    expect(onStart).not.toHaveBeenCalled();
  });

  it('stop() invokes the wired onStop with the reason', () => {
    const onStop = vi.fn();
    Mode._wireLifecycle({ onStop });
    Mode.stop('forfeit');
    expect(onStop).toHaveBeenCalledWith('forfeit');
  });

  it('stop() defaults the reason to forfeit', () => {
    const onStop = vi.fn();
    Mode._wireLifecycle({ onStop });
    Mode.stop();
    expect(onStop).toHaveBeenCalledWith('forfeit');
  });

  it('_resetForTests clears the lifecycle wiring', () => {
    Mode._wireLifecycle({ onStart: () => {}, onStop: () => {} });
    Mode._resetForTests();
    expect(Mode.start({ key: 'classic' })).toBe(false);
    expect(Mode.stop('forfeit')).toBe(false);
  });
});
