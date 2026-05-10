// BroadcastChannel transport — two browser tabs join the same lobby
// code → BroadcastChannel routes their messages between each other.
// No server needed; only works for tabs on the same origin.
//
// Use case: local development + 2-tab playtesting before any
// Cloudflare deployment. Phase J host wiring uses this so the
// online-versus pipeline is end-to-end exercisable on a single
// machine (open the URL in two windows, both pick the same lobby
// code, play). When the real Worker relay is deployed, callers
// swap this for `transport-ws.js` — the surface is identical
// (`send` / `onMessage` / `close` + `auth` first message + the
// protocol shapes from `protocol.js`).
//
// Browser-only — uses the BroadcastChannel DOM global. Node tests
// pass through transport-fake.js.

import { decode, serialize } from './protocol.js';

/**
 * @typedef {Object} BroadcastTransportOpts
 * @property {string} channelName
 *   The BroadcastChannel name. By convention `tetris-online-${lobbyCode}`
 *   so two tabs picking the same lobby code see each other.
 * @property {string} userId   Tier 2 UUID — sent in the auth handshake.
 * @property {string} [displayName]
 * @property {(msg:object) => void} [onMessage]
 * @property {() => void}           [onOpen]
 * @property {(reason:string) => void} [onClose]
 */

export class BroadcastTransport {
  /** @param {BroadcastTransportOpts} opts */
  constructor(opts) {
    if (!opts || !opts.channelName) throw new Error('BroadcastTransport requires { channelName }');
    if (!opts.userId)               throw new Error('BroadcastTransport requires { userId }');
    if (typeof BroadcastChannel === 'undefined') {
      throw new Error('BroadcastTransport: BroadcastChannel not available (browser only).');
    }
    this._channelName = opts.channelName;
    this._userId      = opts.userId;
    this._displayName = opts.displayName;
    this._onMessage   = opts.onMessage || (() => {});
    this._onOpen      = opts.onOpen    || (() => {});
    this._onClose     = opts.onClose   || (() => {});

    this._channel = new BroadcastChannel(this._channelName);
    this._closed = false;

    this._channel.addEventListener('message', (e) => {
      let msg;
      try { msg = decode(e.data); }
      catch { return; /* malformed peer — drop silently */ }
      // Filter self-echo: BroadcastChannel doesn't echo to the sender
      // tab in modern browsers, but defensive — drop messages from
      // ourselves if we ever see one (e.g. shared-worker contexts).
      if (msg.userId && msg.userId === this._userId) return;
      try { this._onMessage(msg); }
      catch (err) { console.warn('[broadcast-transport] handler threw:', err); }
    });

    // Send the auth handshake immediately on construction (the channel
    // is open as soon as we attach). Async to give the host a chance
    // to set onOpen / onMessage AFTER construction.
    Promise.resolve().then(() => {
      if (this._closed) return;
      try {
        const auth = { t: 'auth', userId: this._userId };
        if (this._displayName) auth.displayName = this._displayName;
        this._channel.postMessage(serialize(auth));
      } catch { /* ignore */ }
      this._onOpen();
    });
  }

  /** Send an encoded plain-object message over the channel. */
  send(msg) {
    if (this._closed) return;
    try { this._channel.postMessage(serialize(msg)); }
    catch (err) { console.warn('[broadcast-transport] send threw:', err); }
  }

  /** Replace the receive handler. */
  onMessage(handler) { this._onMessage = handler || (() => {}); }

  /** Close the channel cleanly. */
  close() {
    if (this._closed) return;
    this._closed = true;
    try { this._channel.close(); }
    catch { /* ignore */ }
    this._onClose('client_close');
  }

  get isOpen() { return !this._closed; }
}
