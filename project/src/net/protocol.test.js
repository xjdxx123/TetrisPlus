// Wire-protocol tests — every encoder ↔ decoder pair round-trips
// through JSON.parse(JSON.stringify(...)) without loss; every
// validator catches its bad-input cases at the boundary.

import { describe, it, expect } from 'vitest';
import { EMPTY_FRAME } from '../input/intents.js';
import {
  MSG, decode, serialize,
  encodeAuth, encodeAuthOk, encodeLobbyCreate, encodeLobbyJoin, encodeLobbyState,
  encodeQueueEnter, encodeQueueLeave,
  encodeMatchFound, encodeMatchReady, encodeMatchStart, encodeMatchResign, encodeMatchEnd,
  encodeError,
  encodeInput, encodeSnapshotHash, encodeDesyncBlob, encodeGarbage, encodeTopout,
} from './protocol.js';

const UID = '0123456789abcdef'; // valid 16-char hex
const FRAME = { ...EMPTY_FRAME, left: true, hardDrop: true };

/** Round-trip an encoder result through JSON + decode + assert equality. */
function roundTrip(msg) {
  const json = serialize(msg);
  const decoded = decode(json);
  expect(decoded).toEqual(msg);
  return decoded;
}

describe('protocol — control plane (client → server)', () => {
  it('auth — userId required (16-char hex), displayName optional', () => {
    const m = encodeAuth(UID, 'NicePlayer');
    expect(m.t).toBe(MSG.AUTH);
    expect(m.userId).toBe(UID);
    expect(m.displayName).toBe('NicePlayer');
    roundTrip(m);
    // No displayName.
    const bare = encodeAuth(UID);
    expect('displayName' in bare).toBe(false);
    roundTrip(bare);
  });

  it('auth — bad userId rejected', () => {
    expect(() => encodeAuth('short')).toThrow(/16-char hex/);
    expect(() => encodeAuth('not-hex-zzzzzzzz')).toThrow(/16-char hex/);
  });

  it('auth — over-long displayName rejected', () => {
    expect(() => encodeAuth(UID, 'X'.repeat(17))).toThrow(/16 chars/);
  });

  it('lobby_create / lobby_join', () => {
    roundTrip(encodeLobbyCreate({ mode: 'versus', gravityScalar: 1.0 }));
    roundTrip(encodeLobbyJoin('ABCD'));
    expect(() => encodeLobbyJoin('')).toThrow(/code/);
    expect(() => encodeLobbyCreate(null)).toThrow(/settings/);
  });

  it('queue_enter / queue_leave — eloRange optional', () => {
    roundTrip(encodeQueueEnter('us-east'));
    roundTrip(encodeQueueEnter('us-east', [1100, 1300]));
    roundTrip(encodeQueueLeave());
    expect(() => encodeQueueEnter('us-east', [1100])).toThrow(/eloRange/);
  });

  it('match_ready / match_resign', () => {
    roundTrip(encodeMatchReady('m-1', true));
    roundTrip(encodeMatchReady('m-1', false));
    roundTrip(encodeMatchResign('m-1'));
    expect(() => encodeMatchReady('m-1', 'yes')).toThrow(/ready/);
  });
});

describe('protocol — control plane (server → client)', () => {
  it('auth_ok — userId + elo + region', () => {
    roundTrip(encodeAuthOk(UID, 1234, 'us-west'));
    expect(() => encodeAuthOk(UID, 1.5, 'us-west')).toThrow(/elo/);
  });

  it('lobby_state', () => {
    const m = encodeLobbyState('ABCD', [{ userId: UID, name: 'Player-0123' }], { mode: 'versus' });
    roundTrip(m);
    expect(() => encodeLobbyState('ABCD', null, { mode: 'versus' })).toThrow(/players/);
  });

  it('match_found', () => {
    const opponent = { userId: 'fedcba9876543210', displayName: 'Foe', elo: 1300 };
    const settings = { mode: 'versus', gravityScalar: 1.0 };
    roundTrip(encodeMatchFound('m-1', 99, opponent, settings));
    roundTrip(encodeMatchFound('m-1', 99, opponent, settings, 'wss://relay/m-1'));
  });

  it('match_start', () => {
    roundTrip(encodeMatchStart('m-1', 0));
    roundTrip(encodeMatchStart('m-1', 12345));
    expect(() => encodeMatchStart('m-1', -1)).toThrow(/startTickAt/);
  });

  it('match_end — winner ∈ {me, opp, draw}', () => {
    roundTrip(encodeMatchEnd('m-1', 'me',   25));
    roundTrip(encodeMatchEnd('m-1', 'opp', -25));
    roundTrip(encodeMatchEnd('m-1', 'draw', 0));
    expect(() => encodeMatchEnd('m-1', 'tie', 0)).toThrow(/winner/);
  });

  it('error', () => {
    roundTrip(encodeError('NO_LOBBY', 'lobby not found'));
    expect(() => encodeError('NO_LOBBY')).toThrow(/message/);
  });
});

describe('protocol — realtime plane', () => {
  it('input — tick + InputFrame round-trip', () => {
    const m = encodeInput(123, FRAME);
    expect(m.t).toBe(MSG.INPUT);
    expect(m.tick).toBe(123);
    expect(m.frame.left).toBe(true);
    expect(m.frame.hardDrop).toBe(true);
    expect(m.frame.right).toBe(false);
    roundTrip(m);
  });

  it('input — bad InputFrame rejected', () => {
    // Missing intent.
    const bad = { left: true, right: false }; // missing softDrop, hardDrop, etc.
    expect(() => encodeInput(0, bad)).toThrow(/frame/);
  });

  it('input — negative tick rejected', () => {
    expect(() => encodeInput(-1, FRAME)).toThrow(/tick/);
  });

  it('snapshot hash — 8..64 char hex string', () => {
    roundTrip(encodeSnapshotHash(60, 'a1b2c3d4'));
    roundTrip(encodeSnapshotHash(60, 'a'.repeat(64)));
    expect(() => encodeSnapshotHash(60, 'short')).toThrow(/hash/);
    expect(() => encodeSnapshotHash(60, 'x'.repeat(65))).toThrow(/hash/);
  });

  it('desync blob — full game state for offline diagnosis', () => {
    const blob = { v: 2, cols: 10, rows: 20, depth: 1, board: [[]] };
    roundTrip(encodeDesyncBlob(120, blob));
  });

  it('garbage — tick + rows + holeCol', () => {
    roundTrip(encodeGarbage(345, 4, 7));
    expect(() => encodeGarbage(345, 0, 7)).toThrow(/rows/); // 0 rows is meaningless
    expect(() => encodeGarbage(345, 4, -1)).toThrow(/holeCol/);
  });

  it('topout — tick required, validates non-neg int', () => {
    const m = encodeTopout(456);
    expect(m.t).toBe(MSG.TOPOUT);
    expect(m.tick).toBe(456);
    roundTrip(m);
    roundTrip(encodeTopout(0));
    expect(() => encodeTopout(-1)).toThrow(/tick/);
    expect(() => encodeTopout(1.5)).toThrow(/tick/);
    expect(() => encodeTopout('zero')).toThrow(/tick/);
  });
});

describe('protocol — decode', () => {
  it('parses JSON strings', () => {
    const json = serialize(encodeInput(0, EMPTY_FRAME));
    const m = decode(json);
    expect(m.t).toBe(MSG.INPUT);
  });

  it('accepts already-parsed objects', () => {
    const m = decode(encodeInput(0, EMPTY_FRAME));
    expect(m.t).toBe(MSG.INPUT);
  });

  it('rejects malformed JSON', () => {
    expect(() => decode('{not valid json')).toThrow(/JSON/);
  });

  it('rejects unknown message types', () => {
    expect(() => decode({ t: 'mystery', x: 1 })).toThrow(/unknown message type/);
  });

  it('rejects missing type tag', () => {
    expect(() => decode({ x: 1 })).toThrow(/message type tag/);
  });

  it('rejects payloads that pass type check but fail field validation', () => {
    expect(() => decode({ t: MSG.INPUT, tick: 'zero', frame: EMPTY_FRAME }))
      .toThrow(/tick/);
    expect(() => decode({ t: MSG.GARBAGE, tick: 0, rows: -1, holeCol: 0 }))
      .toThrow(/rows/);
  });

  it('encoded → decoded preserves field order + value parity (every msg type)', () => {
    // Smoke test all 16 message constructors via roundTrip.
    roundTrip(encodeAuth(UID));
    roundTrip(encodeAuthOk(UID, 1200, 'eu'));
    roundTrip(encodeLobbyCreate({ mode: 'versus' }));
    roundTrip(encodeLobbyJoin('ABCD'));
    roundTrip(encodeLobbyState('ABCD', [], { mode: 'versus' }));
    roundTrip(encodeQueueEnter('us-east'));
    roundTrip(encodeQueueLeave());
    roundTrip(encodeMatchFound('m', 1, { userId: UID }, { mode: 'versus' }));
    roundTrip(encodeMatchReady('m', true));
    roundTrip(encodeMatchStart('m', 0));
    roundTrip(encodeMatchResign('m'));
    roundTrip(encodeMatchEnd('m', 'me', 10));
    roundTrip(encodeError('CODE', 'message'));
    roundTrip(encodeInput(0, EMPTY_FRAME));
    roundTrip(encodeSnapshotHash(0, 'abcd1234'));
    roundTrip(encodeDesyncBlob(0, { board: [] }));
    roundTrip(encodeGarbage(0, 1, 0));
    roundTrip(encodeTopout(0));
  });
});

describe('protocol — encoders return frozen objects', () => {
  it('attempting to mutate encoder output throws (or silently fails) — the wire object is immutable', () => {
    const m = encodeInput(0, EMPTY_FRAME);
    // strict mode in test env throws; non-strict silently fails.
    // Either way, the value doesn't change.
    try { m.tick = 999; } catch { /* ignore */ }
    expect(m.tick).toBe(0);
  });
});
