// MatchRelay — Cloudflare Workers Durable Object that relays
// per-tick messages between the two clients of a single match.
// One DO per active match; the DO ID is the matchId.
//
// Plan v2 §2.2 / plan_online_versus.md §4. Validates auth, holds
// the WebSocket pair, forwards `in` / `gar` / `snap` / `desync`
// messages between them, and emits `match_end` when one side
// resigns or both disconnect.
//
// This is the *minimal* relay — it does NOT validate gameplay or
// arbitrate match outcomes. Replay validation (Phase H) handles
// outcome verification offline. The relay's only job is "make
// these two WebSockets see each other's bytes."
//
// Deployment: `wrangler.toml` declares MatchRelay as a Durable
// Object class; the Worker entrypoint (server/relay/worker.js)
// resolves a DO instance per matchId + forwards the WS upgrade
// to it. See server/relay/wrangler.example.toml for the binding
// shape.

import { decode, MSG, encodeError, encodeMatchEnd } from '../../src/net/protocol.js';

const REALTIME_TYPES = new Set([MSG.INPUT, MSG.GARBAGE, MSG.SNAPSHOT_HASH, MSG.DESYNC_BLOB]);
const CONTROL_FORWARD_TYPES = new Set([MSG.MATCH_READY, MSG.MATCH_RESIGN]);

export class MatchRelay {
  /**
   * @param {DurableObjectState} state
   * @param {Env} _env
   */
  constructor(state, _env) {
    this._state = state;
    /** @type {Map<string, WebSocket>} userId → socket */
    this._clients = new Map();
    /** Match metadata (matchId, seed, startedAt). Set by the Worker before the first WS upgrade. */
    this._meta = null;
    this._ended = false;
  }

  /** Worker entrypoint — handles all HTTP requests routed to this DO. */
  async fetch(request) {
    const url = new URL(request.url);

    // Initialize match metadata via POST /init (Worker calls this
    // when the matchmaking service decides on a pair).
    if (request.method === 'POST' && url.pathname.endsWith('/init')) {
      const body = await request.json().catch(() => null);
      if (!body || !body.matchId || typeof body.seed !== 'number' || !Array.isArray(body.players)) {
        return new Response('bad init payload', { status: 400 });
      }
      this._meta = { matchId: body.matchId, seed: body.seed, players: body.players, startedAt: 0 };
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // WebSocket upgrade — one client connects per call.
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 400 });
    }
    if (!this._meta) {
      return new Response('match not initialized', { status: 400 });
    }
    if (this._ended) {
      return new Response('match already ended', { status: 410 });
    }
    if (this._clients.size >= 2) {
      return new Response('match full', { status: 409 });
    }

    // Workers WebSocketPair API: accept one end, return the other.
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this._wireSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── WS plumbing ────────────────────────────────────────────────

  _wireSocket(socket) {
    let userId = null;

    socket.addEventListener('message', (e) => {
      let msg;
      try { msg = decode(e.data); }
      catch (err) {
        this._safeSend(socket, encodeError('PROTOCOL', 'decode failed: ' + err.message));
        return;
      }

      // First message MUST be auth.
      if (!userId) {
        if (msg.t !== MSG.AUTH) {
          this._safeSend(socket, encodeError('AUTH_REQUIRED', 'first message must be auth'));
          this._safeClose(socket, 1008, 'no auth');
          return;
        }
        // Validate userId is one of the match's expected players.
        const expected = this._meta.players.find(p => p.userId === msg.userId);
        if (!expected) {
          this._safeSend(socket, encodeError('AUTH_REJECTED', 'userId not in this match'));
          this._safeClose(socket, 1008, 'auth rejected');
          return;
        }
        if (this._clients.has(msg.userId)) {
          this._safeSend(socket, encodeError('AUTH_REJECTED', 'already connected'));
          this._safeClose(socket, 1008, 'duplicate connection');
          return;
        }
        userId = msg.userId;
        this._clients.set(userId, socket);
        return;
      }

      // Realtime forwarding — these get relayed verbatim to the OTHER client.
      if (REALTIME_TYPES.has(msg.t)) {
        this._forwardToPeer(userId, e.data);
        return;
      }

      // Control plane the relay forwards: ready / resign.
      if (CONTROL_FORWARD_TYPES.has(msg.t)) {
        this._forwardToPeer(userId, e.data);
        if (msg.t === MSG.MATCH_RESIGN) {
          // Resignation = match end. Tell both sides.
          this._endMatch({ winnerUserId: this._otherUserId(userId), reason: 'resign' });
        }
        return;
      }

      // Anything else from a connected client is ignored — those
      // belong to the lobby/queue plane, not match relay.
      this._safeSend(socket, encodeError('UNEXPECTED', `relay does not accept ${msg.t}`));
    });

    socket.addEventListener('close', () => {
      if (userId) this._clients.delete(userId);
      // If a side disconnects mid-match, the OTHER side wins by
      // forfeit (after a grace window — for the MVP we end
      // immediately).
      if (this._clients.size === 1 && !this._ended) {
        const survivor = [...this._clients.keys()][0];
        this._endMatch({ winnerUserId: survivor, reason: 'disconnect' });
      } else if (this._clients.size === 0) {
        // Both gone — match dies silently.
        this._ended = true;
      }
    });

    socket.addEventListener('error', () => {
      // A WS error is treated like a close — disconnect the side.
      if (userId) this._clients.delete(userId);
    });
  }

  _forwardToPeer(senderUserId, rawData) {
    for (const [uid, sock] of this._clients) {
      if (uid === senderUserId) continue;
      try { sock.send(rawData); }
      catch (err) { console.warn('[match-relay] forward failed:', err); }
    }
  }

  _otherUserId(userId) {
    for (const uid of this._clients.keys()) if (uid !== userId) return uid;
    return null;
  }

  _endMatch({ winnerUserId, reason }) {
    if (this._ended) return;
    this._ended = true;
    for (const [uid, sock] of this._clients) {
      const winner = (uid === winnerUserId) ? 'me' : (winnerUserId == null ? 'draw' : 'opp');
      // ELO delta computed by the matchmaking service after replay
      // validation; the relay doesn't know, so it sends 0. Replay
      // validation (Phase H) will publish the real delta to the
      // match record + each player's profile.
      this._safeSend(sock, encodeMatchEnd(this._meta.matchId, winner, 0));
      this._safeClose(sock, 1000, reason);
    }
    this._clients.clear();
  }

  _safeSend(sock, msg) {
    try { sock.send(JSON.stringify(msg)); }
    catch { /* ignore */ }
  }

  _safeClose(sock, code, reason) {
    try { sock.close(code, reason); }
    catch { /* ignore */ }
  }
}
