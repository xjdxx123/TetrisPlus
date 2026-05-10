// Online versus wire protocol — every message that flows between
// client and relay (and client-to-client over relay), encoded as
// JSON for now. See plan_online_versus.md §2 for the message
// catalog + design rationale, §2A for the Tier 2 identity model.
//
// Why JSON: debug-friendly, browser-native, ~2 KB/s peak per
// direction at 60Hz. Compression (per-message-deflate or a shared
// dictionary brotli) pulls per-tick payloads to ~12 bytes if
// profiling demands it; binary formats (MessagePack, custom typed-
// array) are a last resort.
//
// This module is browser + Node compatible — both client and server
// (Cloudflare Workers, replay-validation cron) import it. No DOM /
// no THREE / no audio. Pure encode + decode + validation.

/**
 * @typedef {import('../input/intents.js').InputFrame} InputFrame
 */

// ─── Message-type tags ─────────────────────────────────────────────────
//
// Compact one/two-letter tags for hot-path messages ('in', 'gar',
// 'snap'); legible English tags for control-plane messages where the
// payload byte cost dominates the type byte cost anyway. This is the
// same convention Tetrio's protocol uses.

export const MSG = Object.freeze({
  // Control plane (client → server)
  AUTH:          'auth',
  LOBBY_CREATE:  'lobby_create',
  LOBBY_JOIN:    'lobby_join',
  QUEUE_ENTER:   'queue_enter',
  QUEUE_LEAVE:   'queue_leave',
  MATCH_READY:   'match_ready',
  MATCH_RESIGN:  'match_resign',

  // Control plane (server → client)
  AUTH_OK:       'auth_ok',
  LOBBY_STATE:   'lobby_state',
  MATCH_FOUND:   'match_found',
  MATCH_START:   'match_start',
  MATCH_END:     'match_end',
  ERROR:         'error',

  // Realtime plane (client ↔ client via relay)
  INPUT:         'in',
  SNAPSHOT_HASH: 'snap',
  DESYNC_BLOB:   'desync',
  GARBAGE:       'gar',
  // Authoritative "my player just topped out at tick T" announcement.
  // Lets the peer skip its own (potentially desync'd) topout-detection
  // path and end the match with the right winner immediately. See
  // the TOPOUT receive handler in main.js for the rationale.
  TOPOUT:        'topout',
});

const KNOWN_TYPES = new Set(Object.values(MSG));

// ─── Field validators ──────────────────────────────────────────────────
//
// Defensive: every decoder runs these. A malformed message from a
// peer (intentional or accidental) should throw a clean error at the
// boundary, not corrupt state inside the simulation.

function isString(x)        { return typeof x === 'string'; }
function isInt(x)           { return Number.isInteger(x); }
function isNonNegInt(x)     { return Number.isInteger(x) && x >= 0; }
function isBool(x)          { return typeof x === 'boolean'; }
function isObj(x)           { return x !== null && typeof x === 'object' && !Array.isArray(x); }

function must(cond, msg) { if (!cond) throw new Error(`protocol: ${msg}`); }

// Tier 2 identity (plan §2A): 16-char UUID slice, hex.
const USER_ID_RE = /^[0-9a-f]{16}$/i;
function isUserId(x) { return isString(x) && USER_ID_RE.test(x); }

// Frame validator — InputFrame must have all 8 boolean intents.
function isInputFrame(f) {
  if (!isObj(f)) return false;
  return isBool(f.left)     && isBool(f.right)     && isBool(f.softDrop) && isBool(f.hardDrop)
      && isBool(f.rotateCW) && isBool(f.rotateCCW) && isBool(f.hold)     && isBool(f.pause);
}

// ─── Encoders ──────────────────────────────────────────────────────────
//
// Each encoder returns a frozen plain-object form (NOT a JSON string)
// so callers can layer their own transport-level wrapper (per-msg
// metadata, batching, compression). `serialize(msg)` is the convenience
// helper that does the JSON.stringify step.

/** Auth handshake — first message after WS connect. plan §2A. */
export function encodeAuth(userId, displayName) {
  must(isUserId(userId), 'auth: userId must be 16-char hex (UUID slice)');
  if (displayName != null) {
    must(isString(displayName) && displayName.length <= 16, 'auth: displayName ≤ 16 chars');
  }
  const out = { t: MSG.AUTH, userId };
  if (displayName != null) out.displayName = displayName;
  return Object.freeze(out);
}

/** Server confirms auth + returns persisted ELO + region. */
export function encodeAuthOk(userId, elo, region) {
  must(isUserId(userId), 'auth_ok: userId required');
  must(isInt(elo),       'auth_ok: elo (int) required');
  must(isString(region), 'auth_ok: region required');
  return Object.freeze({ t: MSG.AUTH_OK, userId, elo, region });
}

/** Create a friend-invite lobby with starting settings. */
export function encodeLobbyCreate(settings) {
  must(isObj(settings), 'lobby_create: settings object required');
  return Object.freeze({ t: MSG.LOBBY_CREATE, settings });
}

/** Join an existing lobby by code. */
export function encodeLobbyJoin(code) {
  must(isString(code) && code.length > 0, 'lobby_join: code required');
  return Object.freeze({ t: MSG.LOBBY_JOIN, code });
}

/** Server broadcasts current lobby occupants + settings. */
export function encodeLobbyState(code, players, settings) {
  must(isString(code), 'lobby_state: code required');
  must(Array.isArray(players), 'lobby_state: players[] required');
  must(isObj(settings), 'lobby_state: settings required');
  return Object.freeze({ t: MSG.LOBBY_STATE, code, players, settings });
}

/** Enter the matchmaking queue. */
export function encodeQueueEnter(region, eloRange) {
  must(isString(region), 'queue_enter: region required');
  if (eloRange != null) {
    must(Array.isArray(eloRange) && eloRange.length === 2 && isInt(eloRange[0]) && isInt(eloRange[1]),
      'queue_enter: eloRange must be [min, max] pair of ints');
  }
  const out = { t: MSG.QUEUE_ENTER, region };
  if (eloRange != null) out.eloRange = [...eloRange];
  return Object.freeze(out);
}

export function encodeQueueLeave() {
  return Object.freeze({ t: MSG.QUEUE_LEAVE });
}

/** Server announces a paired match. */
export function encodeMatchFound(matchId, seed, opponent, settings, peerEndpoint) {
  must(isString(matchId), 'match_found: matchId required');
  must(isInt(seed),       'match_found: seed (int) required');
  must(isObj(opponent),   'match_found: opponent object required');
  must(isObj(settings),   'match_found: settings required');
  if (peerEndpoint != null) must(isString(peerEndpoint), 'match_found: peerEndpoint must be string');
  const out = { t: MSG.MATCH_FOUND, matchId, seed, opponent, settings };
  if (peerEndpoint != null) out.peerEndpoint = peerEndpoint;
  return Object.freeze(out);
}

/** Both clients ack ready → server fires match_start with the start tick. */
export function encodeMatchReady(matchId, ready) {
  must(isString(matchId), 'match_ready: matchId required');
  must(isBool(ready),     'match_ready: ready (bool) required');
  return Object.freeze({ t: MSG.MATCH_READY, matchId, ready });
}

export function encodeMatchStart(matchId, startTickAt) {
  must(isString(matchId), 'match_start: matchId required');
  must(isNonNegInt(startTickAt), 'match_start: startTickAt (non-neg int) required');
  return Object.freeze({ t: MSG.MATCH_START, matchId, startTickAt });
}

/** Resignation / forfeit. */
export function encodeMatchResign(matchId) {
  must(isString(matchId), 'match_resign: matchId required');
  return Object.freeze({ t: MSG.MATCH_RESIGN, matchId });
}

/** Server announces final outcome + ELO delta. */
export function encodeMatchEnd(matchId, winner, eloDelta) {
  must(isString(matchId), 'match_end: matchId required');
  must(['me','opp','draw'].includes(winner), 'match_end: winner must be me|opp|draw');
  must(isInt(eloDelta), 'match_end: eloDelta (int) required');
  return Object.freeze({ t: MSG.MATCH_END, matchId, winner, eloDelta });
}

/** Generic error envelope. */
export function encodeError(code, message) {
  must(isString(code),    'error: code required');
  must(isString(message), 'error: message required');
  return Object.freeze({ t: MSG.ERROR, code, message });
}

// Realtime plane ─────────────────────────────────────────────────────

/** Per-tick input frame. plan §2.2 */
export function encodeInput(tick, frame) {
  must(isNonNegInt(tick), 'in: tick (non-neg int) required');
  must(isInputFrame(frame), 'in: frame (InputFrame with all 8 boolean intents) required');
  return Object.freeze({ t: MSG.INPUT, tick, frame: { ...frame } });
}

/** Snapshot hash exchange (~1Hz). plan §2.2 */
export function encodeSnapshotHash(tick, hash) {
  must(isNonNegInt(tick), 'snap: tick (non-neg int) required');
  must(isString(hash) && hash.length >= 8 && hash.length <= 64, 'snap: hash (8..64 char hex) required');
  return Object.freeze({ t: MSG.SNAPSHOT_HASH, tick, hash });
}

/** Desync upload — full game blob for offline diagnosis. plan §2.2 */
export function encodeDesyncBlob(tick, blob) {
  must(isNonNegInt(tick), 'desync: tick (non-neg int) required');
  must(isObj(blob),       'desync: blob object required');
  return Object.freeze({ t: MSG.DESYNC_BLOB, tick, blob });
}

/** Outgoing garbage event. plan §2.2 */
export function encodeGarbage(tick, rows, holeCol) {
  must(isNonNegInt(tick),    'gar: tick (non-neg int) required');
  must(isNonNegInt(rows) && rows > 0, 'gar: rows (positive int) required');
  must(isNonNegInt(holeCol), 'gar: holeCol (non-neg int) required');
  return Object.freeze({ t: MSG.GARBAGE, tick, rows, holeCol });
}

/**
 * "My player just topped out" — authoritative loss announcement.
 * The receiver treats this as "peer lost, I won" regardless of its
 * own local simulation state. Without this, both clients have to
 * derive the winner from their local view, which can disagree if
 * the simulations have drifted (deterministic-garbage hiccup,
 * rollback edge cases, etc).
 */
export function encodeTopout(tick) {
  must(isNonNegInt(tick), 'topout: tick (non-neg int) required');
  return Object.freeze({ t: MSG.TOPOUT, tick });
}

// ─── Decoder ───────────────────────────────────────────────────────────

/**
 * Decode a JSON string OR a parsed object into a validated message.
 * Throws on any structural / type / range error so the boundary
 * catches malformed peers before the simulation sees them.
 *
 * @param {string|object} raw
 * @returns {object} validated message
 */
export function decode(raw) {
  let msg;
  if (typeof raw === 'string') {
    try { msg = JSON.parse(raw); }
    catch (err) { throw new Error('protocol.decode: not valid JSON: ' + err.message); }
  } else {
    msg = raw;
  }
  if (!isObj(msg)) throw new Error('protocol.decode: payload must be an object');
  if (!isString(msg.t)) throw new Error('protocol.decode: missing message type tag `t`');
  if (!KNOWN_TYPES.has(msg.t)) throw new Error(`protocol.decode: unknown message type "${msg.t}"`);

  // Per-type validation. Re-runs the same checks the encoders did so
  // the contract is symmetric — anything decode() accepts, encode()
  // would have produced (and vice versa).
  switch (msg.t) {
    case MSG.AUTH:
      must(isUserId(msg.userId), `${msg.t}: userId must be 16-char hex`);
      if (msg.displayName != null) must(isString(msg.displayName) && msg.displayName.length <= 16, `${msg.t}: displayName ≤ 16 chars`);
      break;
    case MSG.AUTH_OK:
      must(isUserId(msg.userId), `${msg.t}: userId required`);
      must(isInt(msg.elo),       `${msg.t}: elo required`);
      must(isString(msg.region), `${msg.t}: region required`);
      break;
    case MSG.LOBBY_CREATE:
      must(isObj(msg.settings), `${msg.t}: settings required`);
      break;
    case MSG.LOBBY_JOIN:
      must(isString(msg.code) && msg.code.length > 0, `${msg.t}: code required`);
      break;
    case MSG.LOBBY_STATE:
      must(isString(msg.code) && Array.isArray(msg.players) && isObj(msg.settings),
        `${msg.t}: code+players[]+settings required`);
      break;
    case MSG.QUEUE_ENTER:
      must(isString(msg.region), `${msg.t}: region required`);
      if (msg.eloRange != null) {
        must(Array.isArray(msg.eloRange) && msg.eloRange.length === 2 && isInt(msg.eloRange[0]) && isInt(msg.eloRange[1]),
          `${msg.t}: eloRange must be [min,max]`);
      }
      break;
    case MSG.QUEUE_LEAVE:
      // No fields beyond `t`.
      break;
    case MSG.MATCH_FOUND:
      must(isString(msg.matchId) && isInt(msg.seed) && isObj(msg.opponent) && isObj(msg.settings),
        `${msg.t}: matchId+seed+opponent+settings required`);
      if (msg.peerEndpoint != null) must(isString(msg.peerEndpoint), `${msg.t}: peerEndpoint must be string`);
      break;
    case MSG.MATCH_READY:
      must(isString(msg.matchId) && isBool(msg.ready), `${msg.t}: matchId+ready required`);
      break;
    case MSG.MATCH_START:
      must(isString(msg.matchId) && isNonNegInt(msg.startTickAt), `${msg.t}: matchId+startTickAt required`);
      break;
    case MSG.MATCH_RESIGN:
      must(isString(msg.matchId), `${msg.t}: matchId required`);
      break;
    case MSG.MATCH_END:
      must(isString(msg.matchId) && ['me','opp','draw'].includes(msg.winner) && isInt(msg.eloDelta),
        `${msg.t}: matchId+winner+eloDelta required`);
      break;
    case MSG.ERROR:
      must(isString(msg.code) && isString(msg.message), `${msg.t}: code+message required`);
      break;
    case MSG.INPUT:
      must(isNonNegInt(msg.tick) && isInputFrame(msg.frame), `${msg.t}: tick+frame required`);
      break;
    case MSG.SNAPSHOT_HASH:
      must(isNonNegInt(msg.tick) && isString(msg.hash) && msg.hash.length >= 8 && msg.hash.length <= 64,
        `${msg.t}: tick+hash required`);
      break;
    case MSG.DESYNC_BLOB:
      must(isNonNegInt(msg.tick) && isObj(msg.blob), `${msg.t}: tick+blob required`);
      break;
    case MSG.GARBAGE:
      must(isNonNegInt(msg.tick) && isNonNegInt(msg.rows) && msg.rows > 0 && isNonNegInt(msg.holeCol),
        `${msg.t}: tick+rows+holeCol required`);
      break;
    case MSG.TOPOUT:
      must(isNonNegInt(msg.tick), `${msg.t}: tick required`);
      break;
    default:
      // Unreachable — KNOWN_TYPES check above already filtered.
      throw new Error(`protocol.decode: unhandled message type "${msg.t}"`);
  }
  return msg;
}

/** Convenience: encode → JSON.stringify in one step. */
export function serialize(msg) {
  return JSON.stringify(msg);
}
