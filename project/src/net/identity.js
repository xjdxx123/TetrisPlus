// Tier 2 client identity (plan_online_versus.md §2A).
//
// On first page load: generate a 16-char hex UUID slice, store in
// localStorage. Stable across browser sessions on the same device.
// No login UI; no signup form; no password reset flow. Clearing
// localStorage resets the identity (documented as the cost of zero-
// friction onboarding).
//
// Optional 16-char `displayName` defaults to `Player-${uid.slice(0,4)}`.
// User can edit via the Versus mode picker's [edit] inline input.
//
// Pure module + browser globals (localStorage, crypto). Node tests
// pass through a fake-storage adapter at construction.

const STORAGE_KEY_USER_ID      = 'tetris.userId';
const STORAGE_KEY_DISPLAY_NAME = 'tetris.displayName';
const USER_ID_LEN_HEX = 16;
const DISPLAY_NAME_MAX = 16;

/**
 * @typedef {Object} StorageLike
 * @property {(key:string) => string|null} getItem
 * @property {(key:string, value:string) => void} setItem
 * @property {(key:string) => void} [removeItem]
 */

/**
 * @typedef {Object} IdentityOpts
 * @property {StorageLike} [storage]
 *   Default `localStorage`. Tests pass an in-memory adapter.
 * @property {() => string} [uuid]
 *   Optional UUID-generator override. Default `crypto.randomUUID()`.
 *   Tests pass a deterministic generator.
 */

function defaultUuidGenerator() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for ancient browsers — never the production path.
  // eslint-disable-next-line no-restricted-syntax
  return ('xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx').replace(/[xy]/g, c => {
    // eslint-disable-next-line no-restricted-syntax
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function defaultStorage() {
  if (typeof localStorage !== 'undefined') return localStorage;
  // Node fallback — silently no-ops. The host should ALWAYS pass
  // a storage adapter under Node.
  return { getItem: () => null, setItem: () => {} };
}

function uuidToShortId(uuid) {
  // 36-char UUID → 16-char hex (drop hyphens, take first 16). Server-
  // side validates with /^[0-9a-f]{16}$/i (protocol.js USER_ID_RE).
  return String(uuid).replace(/-/g, '').slice(0, USER_ID_LEN_HEX).toLowerCase();
}

/**
 * Resolve the player's identity — load from storage if present,
 * else mint a fresh UUID + persist. Idempotent on repeated calls
 * within the same session (returns the same userId because storage
 * caches it).
 *
 * @param {IdentityOpts} [opts]
 * @returns {{ userId: string, displayName: string }}
 */
export function loadOrCreateIdentity(opts = {}) {
  const storage = opts.storage || defaultStorage();
  const uuidGen = opts.uuid || defaultUuidGenerator;

  let userId = storage.getItem(STORAGE_KEY_USER_ID);
  if (!userId || !/^[0-9a-f]{16}$/.test(userId)) {
    userId = uuidToShortId(uuidGen());
    try { storage.setItem(STORAGE_KEY_USER_ID, userId); }
    catch { /* storage full / quota — ephemeral identity, still usable this session */ }
  }

  let displayName = storage.getItem(STORAGE_KEY_DISPLAY_NAME);
  if (!displayName) {
    displayName = `Player-${userId.slice(0, 4).toUpperCase()}`;
    try { storage.setItem(STORAGE_KEY_DISPLAY_NAME, displayName); }
    catch { /* ignore */ }
  }

  return { userId, displayName };
}

/**
 * Persist a new display name. Throws if invalid (non-string, empty,
 * over the length cap).
 *
 * @param {string} newName
 * @param {StorageLike} [storage]
 */
export function setDisplayName(newName, storage) {
  if (typeof newName !== 'string') throw new Error('setDisplayName: must be string');
  const trimmed = newName.trim();
  if (trimmed.length === 0) throw new Error('setDisplayName: must be non-empty');
  if (trimmed.length > DISPLAY_NAME_MAX) {
    throw new Error(`setDisplayName: max ${DISPLAY_NAME_MAX} chars`);
  }
  (storage || defaultStorage()).setItem(STORAGE_KEY_DISPLAY_NAME, trimmed);
}

/** Reset identity — for "log out" / "play as someone else" UX. */
export function clearIdentity(storage) {
  const s = storage || defaultStorage();
  if (typeof s.removeItem === 'function') {
    s.removeItem(STORAGE_KEY_USER_ID);
    s.removeItem(STORAGE_KEY_DISPLAY_NAME);
  } else {
    // Fallback for adapters that only have setItem — overwrite with empty.
    s.setItem(STORAGE_KEY_USER_ID, '');
    s.setItem(STORAGE_KEY_DISPLAY_NAME, '');
  }
}

// Test/diagnostic exports.
export const _STORAGE_KEY_USER_ID      = STORAGE_KEY_USER_ID;
export const _STORAGE_KEY_DISPLAY_NAME = STORAGE_KEY_DISPLAY_NAME;
export const _DISPLAY_NAME_MAX         = DISPLAY_NAME_MAX;
