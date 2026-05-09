import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadSettings, saveSettings,
  loadStats, saveStats,
  _resetForTests, STORAGE_KEYS,
} from './storage.js';

// Stub localStorage on globalThis so the module's safeStorage() lookup
// finds it in pure-Node test runs.
function installFakeLocalStorage() {
  const map = new Map();
  globalThis.localStorage = {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    clear() { map.clear(); },
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] || null; },
  };
  return map;
}

describe('storage — loadSettings', () => {
  beforeEach(() => {
    installFakeLocalStorage();
    _resetForTests();
  });

  it('returns the full default tree when nothing is saved', () => {
    const s = loadSettings();
    expect(s.effects.shatterPower).toBe(2.5);
    expect(s.audio.muted).toBe(false);
    expect(s.mode).toBe('classic');
    expect(s.panel).toEqual({ x: 0, y: 0, z: 6, yaw: 0, pitch: 0, hidden: false });
  });

  it('deep-merges a partial saved blob with defaults', () => {
    globalThis.localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify({
      effects: { shatterPower: 1.0, mood: 'icy' },
      mode: 'sprint',
    }));
    const s = loadSettings();
    expect(s.effects.shatterPower).toBe(1.0); // overridden
    expect(s.effects.mood).toBe('icy');       // overridden
    expect(s.effects.bloom).toBe(0.7);        // default backfilled
    expect(s.audio.bgm).toBe(0.32);           // default backfilled
    expect(s.mode).toBe('sprint');            // overridden
  });

  it('survives a corrupt blob without throwing', () => {
    globalThis.localStorage.setItem(STORAGE_KEYS.settings, '{not json');
    expect(() => loadSettings()).not.toThrow();
    const s = loadSettings();
    expect(s.effects.shatterPower).toBe(2.5);
  });

  it('returns a fresh mutable object on every call', () => {
    const a = loadSettings();
    a.effects.shatterPower = 99;
    const b = loadSettings();
    expect(b.effects.shatterPower).toBe(2.5); // not 99 — a was a clone
  });
});

describe('storage — saveSettings', () => {
  beforeEach(() => {
    installFakeLocalStorage();
    _resetForTests();
    vi.useFakeTimers();
  });

  it('debounces rapid writes', () => {
    saveSettings({ mode: 'sprint' });
    saveSettings({ mode: 'ultra' });
    saveSettings({ mode: 'zen' });
    // Nothing in storage yet — debounce hasn't elapsed.
    expect(globalThis.localStorage.getItem(STORAGE_KEYS.settings)).toBeNull();
    vi.advanceTimersByTime(260);
    const blob = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEYS.settings));
    // Last write wins after debounce.
    expect(blob.mode).toBe('zen');
  });

  it('flushes synchronously when { flush: true }', () => {
    saveSettings({ mode: 'sprint' }, { flush: true });
    const blob = JSON.parse(globalThis.localStorage.getItem(STORAGE_KEYS.settings));
    expect(blob.mode).toBe('sprint');
  });

  it('round-trips through loadSettings', () => {
    saveSettings({ effects: { shatterPower: 1.4 }, mode: 'marathon' }, { flush: true });
    const s = loadSettings();
    expect(s.effects.shatterPower).toBe(1.4);
    expect(s.mode).toBe('marathon');
  });
});

describe('storage — stats', () => {
  beforeEach(() => {
    installFakeLocalStorage();
    _resetForTests();
  });

  it('loadStats returns the default tree on a fresh install', () => {
    const s = loadStats();
    expect(s.highScore).toBe(0);
    expect(s.totals.linesCleared).toBe(0);
    // Phase-1 of the rules engine added `attempts` to every mode-best slot.
    expect(s.modeBests.classic).toEqual({ score: 0, lines: 0, level: 1, attempts: 0 });
    // Every mode key gets a default slot — backfilled on existing saves
    // via the deep-merge load path, so older blobs don't break.
    for (const key of ['classic', 'marathon', 'sprint', 'ultra', 'zen', 'versus']) {
      expect(s.modeBests[key]).toBeDefined();
      expect(s.modeBests[key].attempts).toBe(0);
    }
  });

  it('saveStats with flush:true writes synchronously', () => {
    saveStats({ highScore: 1000, totals: { linesCleared: 10, piecesPlaced: 30, playTimeMs: 1234 } }, { flush: true });
    const s = loadStats();
    expect(s.highScore).toBe(1000);
    expect(s.totals.linesCleared).toBe(10);
  });

  it('falls back to in-memory shadow when localStorage is unavailable', () => {
    delete globalThis.localStorage;
    _resetForTests();
    saveStats({ highScore: 42 }, { flush: true });
    const s = loadStats();
    expect(s.highScore).toBe(42);
  });
});
