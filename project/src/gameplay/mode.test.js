import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Mode } from './mode.js';

describe('Mode', () => {
  beforeEach(() => Mode._resetForTests());

  it('starts on classic with the full mode list available', () => {
    expect(Mode.current).toBe('classic');
    expect(Mode.available).toContain('classic');
    expect(Mode.available).toContain('versus');
    expect(Mode.available).toHaveLength(6);
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

  it('versus is flagged disabled', () => {
    expect(Mode.disabled.versus).toBe(true);
    expect(Mode.disabled.classic).toBeFalsy();
  });
});
