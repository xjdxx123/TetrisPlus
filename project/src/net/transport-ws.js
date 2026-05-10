// WebSocket transport — production wire for online versus.
//
// Wraps a browser WebSocket, encodes/decodes through protocol.js,
// exposes the same `send` / `onMessage` / `close` surface as
// FakeTransport so the rest of the stack (RollbackEngine,
// VersusSession with opponentMode='remote', match lobby UI) is
// transport-agnostic.
//
// Reconnect strategy: passive — if the underlying WebSocket closes
// unexpectedly, the transport surfaces an `onClose` callback. The
// host decides whether to reconnect or end the match (a Versus
// disconnect ≥ 30s = forfeit per plan §5 Phase J).
//
// Browser-only — uses the WebSocket DOM global. Node tests run
// against FakeTransport.

import { decode, serialize } from './protocol.js';

/**
 * @typedef {Object} WSTransportOpts
 * @property {string}   url              wss:// endpoint of the relay DO
 * @property {string}   userId           Tier 2 UUID — sent immediately as auth msg on connect
 * @property {string}   [displayName]
 * @property {(msg:object) => void} [onMessage]
 * @property {() => void}           [onOpen]
 * @property {(reason:string) => void} [onClose]
 * @property {(err:Error)=>void}     [onError]
 */

export class WebSocketTransport {
  /** @param {WSTransportOpts} opts */
  constructor(opts) {
    if (!opts || !opts.url) throw new Error('WebSocketTransport requires { url }');
    if (!opts.userId)       throw new Error('WebSocketTransport requires { userId }');
    this._url         = opts.url;
    this._userId      = opts.userId;
    this._displayName = opts.displayName;
    this._onMessage   = opts.onMessage || (() => {});
    this._onOpen      = opts.onOpen    || (() => {});
    this._onClose     = opts.onClose   || (() => {});
    this._onError     = opts.onError   || (() => {});

    this._socket = null;
    this._open = false;
    /** Messages queued while the socket is still connecting. */
    this._pending = [];

    this._connect();
  }

  // ─── Public surface ──────────────────────────────────────────────

  /** Send an encoded plain-object message. Queues if socket isn't open yet. */
  send(msg) {
    const text = serialize(msg);
    if (!this._open) { this._pending.push(text); return; }
    try { this._socket.send(text); }
    catch (err) { this._onError(err); }
  }

  /** Replace the receive handler. */
  onMessage(handler) { this._onMessage = handler || (() => {}); }

  /** Close the WS cleanly. */
  close() {
    if (this._socket) {
      try { this._socket.close(1000, 'client_close'); }
      catch { /* ignore */ }
      this._socket = null;
    }
    this._open = false;
  }

  get isOpen() { return this._open; }

  // ─── Internal ────────────────────────────────────────────────────

  _connect() {
    let WS;
    if (typeof WebSocket !== 'undefined') WS = WebSocket;
    else throw new Error('WebSocketTransport: WebSocket global not available (browser-only).');

    this._socket = new WS(this._url);

    this._socket.addEventListener('open', () => {
      this._open = true;
      // First message is always auth — Tier 2 UUID + optional display name.
      // §2A — server uses this to identify the connection + bind to the
      // matching match DO.
      try {
        const auth = { t: 'auth', userId: this._userId };
        if (this._displayName) auth.displayName = this._displayName;
        this._socket.send(serialize(auth));
      } catch (err) { this._onError(err); }
      // Drain anything the host queued before the socket opened.
      for (const text of this._pending) {
        try { this._socket.send(text); } catch (err) { this._onError(err); }
      }
      this._pending.length = 0;
      this._onOpen();
    });

    this._socket.addEventListener('message', (e) => {
      let msg;
      try { msg = decode(e.data); }
      catch (err) {
        this._onError(new Error('decode failed: ' + err.message));
        return;
      }
      try { this._onMessage(msg); }
      catch (err) { this._onError(err); }
    });

    this._socket.addEventListener('close', (e) => {
      this._open = false;
      const reason = e && e.reason ? e.reason : 'closed';
      this._onClose(reason);
    });

    this._socket.addEventListener('error', () => {
      this._onError(new Error('websocket error'));
    });
  }
}
