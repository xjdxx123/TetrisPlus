// localStorage-based transport — fallback for environments where
// BroadcastChannel doesn't work (some private-mode windows, certain
// corporate proxies, browser extensions intercepting BC, etc.).
//
// Mechanism: each `send(msg)` writes a unique key into localStorage
// (`tetris.bcast.{channel}.{seq}`) + immediately removes it. Other
// tabs on the same origin observe the write via the `storage` event
// (which fires only in OTHER tabs, never the originator — convenient,
// no self-echo filter needed).
//
// Same surface as transport-broadcast.js / transport-ws.js — call
// sites just swap the constructor.
//
// Quirks:
//   - localStorage events fire ONLY on tabs that have a listener
//     attached BEFORE the write. There's a tiny race window during
//     transport construction.
//   - localStorage is shared across the origin; the per-channel key
//     prefix isolates different lobbies. We GC keys older than 30s
//     so a long-running tab doesn't accumulate dead messages.
//   - Storage quota: the GC + immediate-remove pattern keeps the
//     working set tiny (one key per in-flight message, removed
//     synchronously after the write that fired the event).

import { decode, serialize } from './protocol.js';

const KEY_TTL_MS  = 30 * 1000;

/**
 * @typedef {Object} StorageTransportOpts
 * @property {string} channelName
 * @property {string} userId
 * @property {string} [displayName]
 * @property {(msg:object) => void} [onMessage]
 * @property {() => void}           [onOpen]
 * @property {(reason:string) => void} [onClose]
 */

export class StorageTransport {
  /** @param {StorageTransportOpts} opts */
  constructor(opts) {
    if (!opts || !opts.channelName) throw new Error('StorageTransport requires { channelName }');
    if (!opts.userId)               throw new Error('StorageTransport requires { userId }');
    if (typeof window === 'undefined' || typeof localStorage === 'undefined') {
      throw new Error('StorageTransport: localStorage not available (browser only).');
    }
    this._channelName = opts.channelName;
    this._userId      = opts.userId;
    this._displayName = opts.displayName;
    this._onMessage   = opts.onMessage || (() => {});
    this._onOpen      = opts.onOpen    || (() => {});
    this._onClose     = opts.onClose   || (() => {});

    this._keyPrefix = `tetris.bcast.${this._channelName}.`;
    this._closed = false;
    this._seq = 0;

    // GC any stale entries from prior runs.
    this._gcStaleKeys();

    this._listener = (e) => this._onStorageEvent(e);
    window.addEventListener('storage', this._listener);

    // Send auth handshake on next microtask (matches BroadcastTransport
    // semantics so callers can swap them transparently).
    Promise.resolve().then(() => {
      if (this._closed) return;
      try {
        const auth = { t: 'auth', userId: this._userId };
        if (this._displayName) auth.displayName = this._displayName;
        this._postRaw(serialize(auth));
      } catch { /* ignore */ }
      this._onOpen();
    });
  }

  send(msg) {
    if (this._closed) return;
    try { this._postRaw(serialize(msg)); }
    catch (err) { console.warn('[storage-transport] send threw:', err); }
  }

  onMessage(handler) { this._onMessage = handler || (() => {}); }

  close() {
    if (this._closed) return;
    this._closed = true;
    window.removeEventListener('storage', this._listener);
    this._listener = null;
    this._onClose('client_close');
  }

  get isOpen() { return !this._closed; }

  // ─── Internal ────────────────────────────────────────────────────

  _postRaw(serialized) {
    // Unique key combining a per-instance seq + wall clock so two
    // concurrent sends from different tabs never collide. Wall-clock
    // is "metadata for routing" not gameplay state — simulation never
    // reads this — so the determinism rule's no-Date.now() ban
    // doesn't apply at this layer.
    // eslint-disable-next-line no-restricted-syntax
    const key = `${this._keyPrefix}${Date.now()}-${this._seq++}`;
    try {
      // The write fires `storage` events on OTHER tabs that share the
      // origin. We immediately remove our own key so the storage area
      // doesn't grow; the event payload (e.newValue) is captured at
      // event time, so removal AFTER the event is fine.
      localStorage.setItem(key, serialized);
      // Defer removal so the event has time to dispatch on listeners
      // (Chrome dispatches synchronously but Safari/FF can defer).
      setTimeout(() => { try { localStorage.removeItem(key); } catch { /* ignore */ } }, 0);
    } catch (err) {
      // Quota / disabled storage — surface as send failure.
      throw err;
    }
  }

  _onStorageEvent(e) {
    if (this._closed) return;
    if (!e || !e.key || !e.key.startsWith(this._keyPrefix)) return;
    // `storage` event fires for both setItem AND removeItem.
    // We only care about set (newValue !== null).
    if (e.newValue == null) return;
    let msg;
    try { msg = decode(e.newValue); }
    catch { return; }
    // Defensive self-echo filter (storage events shouldn't fire for
    // the originating tab, but some browsers leak in edge cases).
    if (msg.userId && msg.userId === this._userId) return;
    try { this._onMessage(msg); }
    catch (err) { console.warn('[storage-transport] handler threw:', err); }
  }

  _gcStaleKeys() {
    try {
      // eslint-disable-next-line no-restricted-syntax
      const cutoff = Date.now() - KEY_TTL_MS;
      const drop = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(this._keyPrefix)) continue;
        // Key shape: `${prefix}${ts}-${seq}` — parse the ts.
        const tail = key.slice(this._keyPrefix.length);
        const ts = parseInt(tail.split('-')[0] || '0', 10);
        if (Number.isFinite(ts) && ts < cutoff) drop.push(key);
      }
      for (const k of drop) localStorage.removeItem(k);
    } catch { /* ignore */ }
  }
}
