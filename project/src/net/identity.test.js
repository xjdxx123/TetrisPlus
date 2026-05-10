// Tier 2 identity tests — load + persist + edit + clear.

import { describe, it, expect } from 'vitest';
import {
  loadOrCreateIdentity, setDisplayName, clearIdentity,
  _STORAGE_KEY_USER_ID, _STORAGE_KEY_DISPLAY_NAME, _DISPLAY_NAME_MAX,
} from './identity.js';

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem:    k => map.has(k) ? map.get(k) : null,
    setItem:    (k, v) => map.set(k, String(v)),
    removeItem: k => map.delete(k),
    _dump:      () => Object.fromEntries(map),
  };
}

describe('identity — fresh boot', () => {
  it('mints a 16-char hex userId on first call + persists it', () => {
    const storage = makeStorage();
    const id = loadOrCreateIdentity({ storage, uuid: () => '0123456789abcdef-fedcba9876543210' });
    expect(id.userId).toBe('0123456789abcdef');
    expect(id.userId.length).toBe(16);
    expect(/^[0-9a-f]{16}$/.test(id.userId)).toBe(true);
    expect(storage.getItem(_STORAGE_KEY_USER_ID)).toBe('0123456789abcdef');
  });

  it('default displayName is `Player-XXXX` from the first 4 hex chars', () => {
    const storage = makeStorage();
    const id = loadOrCreateIdentity({ storage, uuid: () => 'cafebabe11111111' });
    expect(id.displayName).toBe('Player-CAFE');
  });

  it('persists displayName on first mint', () => {
    const storage = makeStorage();
    loadOrCreateIdentity({ storage, uuid: () => 'deadbeef00000000' });
    expect(storage.getItem(_STORAGE_KEY_DISPLAY_NAME)).toBe('Player-DEAD');
  });
});

describe('identity — returning user', () => {
  it('reuses the stored userId across calls', () => {
    const storage = makeStorage({
      [_STORAGE_KEY_USER_ID]: 'aaaaaaaaaaaaaaaa',
      [_STORAGE_KEY_DISPLAY_NAME]: 'NicePlayer',
    });
    const id = loadOrCreateIdentity({ storage });
    expect(id.userId).toBe('aaaaaaaaaaaaaaaa');
    expect(id.displayName).toBe('NicePlayer');
  });

  it('regenerates a userId if storage holds an invalid value', () => {
    const storage = makeStorage({
      [_STORAGE_KEY_USER_ID]: 'not-valid!',
    });
    const id = loadOrCreateIdentity({
      storage,
      uuid: () => 'fffffffffffffffe00000000',
    });
    expect(id.userId).toBe('fffffffffffffffe');
  });
});

describe('identity — setDisplayName', () => {
  it('persists a new display name', () => {
    const storage = makeStorage({ [_STORAGE_KEY_USER_ID]: 'aaaaaaaaaaaaaaaa' });
    setDisplayName('Cool Beans', storage);
    expect(storage.getItem(_STORAGE_KEY_DISPLAY_NAME)).toBe('Cool Beans');
  });

  it('rejects non-string / empty / too-long', () => {
    const storage = makeStorage();
    expect(() => setDisplayName(42, storage)).toThrow(/string/);
    expect(() => setDisplayName('', storage)).toThrow(/non-empty/);
    expect(() => setDisplayName('   ', storage)).toThrow(/non-empty/);
    expect(() => setDisplayName('X'.repeat(_DISPLAY_NAME_MAX + 1), storage)).toThrow(/max/);
  });

  it('trims whitespace', () => {
    const storage = makeStorage();
    setDisplayName('  Trimmed  ', storage);
    expect(storage.getItem(_STORAGE_KEY_DISPLAY_NAME)).toBe('Trimmed');
  });
});

describe('identity — clearIdentity', () => {
  it('removes both keys', () => {
    const storage = makeStorage({
      [_STORAGE_KEY_USER_ID]: 'aaaaaaaaaaaaaaaa',
      [_STORAGE_KEY_DISPLAY_NAME]: 'NicePlayer',
    });
    clearIdentity(storage);
    expect(storage.getItem(_STORAGE_KEY_USER_ID)).toBeNull();
    expect(storage.getItem(_STORAGE_KEY_DISPLAY_NAME)).toBeNull();
    // After clear, next load mints a fresh identity.
    const id = loadOrCreateIdentity({ storage, uuid: () => 'beefcafe00000000' });
    expect(id.userId).toBe('beefcafe00000000');
  });
});
