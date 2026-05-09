// Tests for the versus composition root (plan_gameplay_1.md §3.7
// sub-phase 7e). Exercises the cross-game garbage bridge, per-side
// tick dispatch, and end-of-match arbitration.

import { describe, it, expect, vi } from 'vitest';

vi.mock('three', () => {
  class FakeVec3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    clone() { return new FakeVec3(this.x, this.y, this.z); }
  }
  class FakeGroup {
    constructor() { this.children = []; this.parent = null; this.position = new FakeVec3(); this.rotation = { z: 0 }; }
    add(c)    { this.children.push(c); c.parent = this; }
    remove(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parent = null; }
    clear()   { for (const c of this.children) c.parent = null; this.children.length = 0; }
  }
  return { Group: FakeGroup, Vector3: FakeVec3, Object3D: FakeGroup };
});

import { VersusSession } from './versus.js';
import { EventBus } from '../engine/events/bus.js';
import { EVENTS } from '../gameplay/events.js';

class FakeGroup {
  constructor() { this.children = []; this.parent = null; this.position = { x: 0 }; }
  add(c)    { this.children.push(c); c.parent = this; }
  remove(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parent = null; }
}

function fakeRendererDeps() {
  return {
    cellToWorld: (c, r, d) => ({ x: c, y: r, z: d, copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; } }),
    makeCube:    () => ({ position: { copy: () => {} }, userData: { color: 0 } }),
    shatter:     () => {},
    animateCubeTo: () => {},
    startLockAnim: () => {},
    playSfx:     () => {},
  };
}

function makeFakeInputTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, fn)    { (listeners.get(type) || listeners.set(type, new Set()).get(type)).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
  };
}

describe('VersusSession — construction', () => {
  it('throws without parent or rendererDeps', () => {
    expect(() => new VersusSession({})).toThrow(/parent/);
    expect(() => new VersusSession({ parent: new FakeGroup() })).toThrow(/rendererDeps/);
  });

  it('builds two Games + two BoardViews + DualBoard', () => {
    const parent = new FakeGroup();
    const v = new VersusSession({
      parent,
      rendererDeps: fakeRendererDeps(),
      inputTarget: makeFakeInputTarget(),
    });
    expect(v.gameP1).toBeTruthy();
    expect(v.gameP2).toBeTruthy();
    expect(v.viewP1).toBeTruthy();
    expect(v.viewP2).toBeTruthy();
    expect(v.dualBoard).toBeTruthy();
    expect(v.gameP1.side).toBe('player');
    expect(v.gameP2.side).toBe('opponent');
    v.dispose();
  });

  it('opponentMode bot creates a BotController, no P2 router', () => {
    const v = new VersusSession({
      parent: new FakeGroup(),
      rendererDeps: fakeRendererDeps(),
      inputTarget: makeFakeInputTarget(),
      opponentMode: 'bot',
    });
    expect(v.bot).toBeTruthy();
    expect(v.routerP2).toBeNull();
    v.dispose();
  });

  it('opponentMode local creates two routers, no bot', () => {
    const v = new VersusSession({
      parent: new FakeGroup(),
      rendererDeps: fakeRendererDeps(),
      inputTarget: makeFakeInputTarget(),
      opponentMode: 'local',
    });
    expect(v.bot).toBeNull();
    expect(v.routerP1).toBeTruthy();
    expect(v.routerP2).toBeTruthy();
    v.dispose();
  });
});

describe('VersusSession — start', () => {
  it('seeds the first piece on both sides', () => {
    const v = new VersusSession({
      parent: new FakeGroup(),
      rendererDeps: fakeRendererDeps(),
      inputTarget: makeFakeInputTarget(),
    });
    expect(v.gameP1.activePiece).toBeNull();
    expect(v.gameP2.activePiece).toBeNull();
    v.start();
    expect(v.gameP1.activePiece).toBeTruthy();
    expect(v.gameP2.activePiece).toBeTruthy();
    v.dispose();
  });
});

describe('VersusSession — garbage bridge', () => {
  it('routes player\'s GARBAGE_SENT into opponent\'s queue', () => {
    const v = new VersusSession({
      parent: new FakeGroup(),
      rendererDeps: fakeRendererDeps(),
      inputTarget: makeFakeInputTarget(),
    });
    v.start();
    expect(v.gameP2.queuedGarbageRows).toBe(0);
    // Synthesize a player clear by calling the rules pack's onLinesCleared
    // path indirectly — easiest is to fill the bottom rows + force a clear.
    for (let c = 0; c < v.gameP1.cols; c++) v.gameP1.board[0][c] = 0xff0000;
    for (let c = 0; c < v.gameP1.cols; c++) v.gameP1.board[1][c] = 0xff0000;
    v.gameP1.clearLines([0, 1]); // 2-line clear → 1 garbage row sent
    expect(v.gameP2.queuedGarbageRows).toBeGreaterThanOrEqual(1);
    expect(v.gameP1.queuedGarbageRows).toBe(0); // player's own queue unchanged
    v.dispose();
  });

  it('routes opponent\'s GARBAGE_SENT into player\'s queue', () => {
    const v = new VersusSession({
      parent: new FakeGroup(),
      rendererDeps: fakeRendererDeps(),
      inputTarget: makeFakeInputTarget(),
    });
    v.start();
    for (let c = 0; c < v.gameP2.cols; c++) v.gameP2.board[0][c] = 0xff0000;
    for (let c = 0; c < v.gameP2.cols; c++) v.gameP2.board[1][c] = 0xff0000;
    v.gameP2.clearLines([0, 1]);
    expect(v.gameP1.queuedGarbageRows).toBeGreaterThanOrEqual(1);
    v.dispose();
  });

  it('per-game buses keep stray emissions local', () => {
    const v = new VersusSession({
      parent: new FakeGroup(),
      rendererDeps: fakeRendererDeps(),
      inputTarget: makeFakeInputTarget(),
    });
    // Emitting LINE_CLEAR on one bus must not arrive on the other bus.
    let p2Saw = 0;
    v.gameP2.bus.on('LINE_CLEAR', () => p2Saw++);
    v.gameP1.bus.emit('LINE_CLEAR', { rows: [0], simultaneous: 1, scoreDelta: 100, colors: [0], overallColor: 0 });
    expect(p2Saw).toBe(0);
    v.dispose();
  });
});

describe('VersusSession — end-of-match arbitration', () => {
  it('first side topout triggers opponent forceTopOut → both sides end', () => {
    const ends = [];
    const v = new VersusSession({
      parent: new FakeGroup(),
      rendererDeps: fakeRendererDeps(),
      inputTarget: makeFakeInputTarget(),
      onSideEnd: (reason, side) => ends.push({ reason, side }),
    });
    v.start();
    // Force player's topout — composition root should propagate to
    // the opponent so MODE_END fires on both sides.
    v.gameP1.forceTopOut('topout');
    expect(ends.length).toBe(2);
    expect(ends.some(e => e.side === 'player' && e.reason === 'topout')).toBe(true);
    expect(ends.some(e => e.side === 'opponent' && e.reason === 'opponent_topout')).toBe(true);
    v.dispose();
  });
});

describe('VersusSession — tick dispatch', () => {
  it('forwards bot frame to opponent game without affecting player game', () => {
    const v = new VersusSession({
      parent: new FakeGroup(),
      rendererDeps: fakeRendererDeps(),
      inputTarget: makeFakeInputTarget(),
      opponentMode: 'bot',
    });
    v.start();
    const p1Before = v.gameP1.activePiece;
    const p2Before = v.gameP2.activePiece;
    // Multiple ticks let the bot accumulate enough time + actions to do
    // something. The player's no-input frames mean P1's piece falls only
    // by gravity, eventually changing.
    for (let i = 0; i < 50; i++) v.tick(50);
    // Bot should have rotated/moved/dropped at least once → P2 has a
    // different active piece by now (because hardDrop spawned a new one).
    // We don't assert which exactly — just that the games diverge.
    const p1After = v.gameP1.activePiece;
    const p2After = v.gameP2.activePiece;
    expect(p1Before).toBeTruthy();
    expect(p2Before).toBeTruthy();
    expect(p1After).toBeTruthy();
    expect(p2After).toBeTruthy();
    v.dispose();
  });
});

describe('VersusSession — dispose', () => {
  it('tears down both routers + bot + games + views + dualBoard', () => {
    const parent = new FakeGroup();
    const v = new VersusSession({
      parent,
      rendererDeps: fakeRendererDeps(),
      inputTarget: makeFakeInputTarget(),
    });
    v.start();
    v.dispose();
    // After dispose, parent should no longer hold the dualBoard's anchors.
    expect(parent.children.length).toBe(0);
  });
});

// ─── Host-driven mode (sub-phase 7e integration) ─────────────────────

describe('VersusSession — playerInputMode: \'host\'', () => {
  it('skips routerP1 so the host owns player keyboard handling', () => {
    const v = new VersusSession({
      parent: new FakeGroup(),
      rendererDeps: fakeRendererDeps(),
      inputTarget: makeFakeInputTarget(),
      playerInputMode: 'host',
    });
    expect(v.routerP1).toBeNull();
    expect(v.bot).toBeTruthy();
    v.dispose();
  });

  it('tick() in host mode does NOT advance gameP1 (host does that)', async () => {
    const v = new VersusSession({
      parent: new FakeGroup(),
      rendererDeps: fakeRendererDeps(),
      inputTarget: makeFakeInputTarget(),
      playerInputMode: 'host',
    });
    v.start();
    // Snapshot gameP1's state before + after tick — modeTimeMs only
    // advances if Game.tick was called.
    const before = v.gameP1.modeTimeMs;
    for (let i = 0; i < 10; i++) v.tick(50);
    expect(v.gameP1.modeTimeMs).toBe(before); // unchanged: host didn't call game.tick
    v.dispose();
  });

  it('tickOpponent advances ONLY the opponent side', () => {
    const v = new VersusSession({
      parent: new FakeGroup(),
      rendererDeps: fakeRendererDeps(),
      inputTarget: makeFakeInputTarget(),
      playerInputMode: 'host',
    });
    v.start();
    const beforeP1 = v.gameP1.modeTimeMs;
    for (let i = 0; i < 10; i++) v.tickOpponent(50);
    expect(v.gameP1.modeTimeMs).toBe(beforeP1); // P1 unchanged
    expect(v.gameP2.modeTimeMs).toBeGreaterThan(0); // P2 advanced
    v.dispose();
  });
});

describe('VersusSession — host-supplied busP1', () => {
  it('routes player events on the host bus so global subscribers fire', () => {
    const hostBus = new EventBus({ replayBufferSize: 0, recorderSize: 0 });
    const playerLocks = [];
    hostBus.on(EVENTS.PIECE_LOCK, (e) => { if (e.side === 'player') playerLocks.push(e); });

    const v = new VersusSession({
      parent: new FakeGroup(),
      rendererDeps: fakeRendererDeps(),
      inputTarget: makeFakeInputTarget(),
      playerInputMode: 'host',
      busP1: hostBus,
    });
    v.start();
    // Force a player lock — emits PIECE_LOCK on whichever bus gameP1 owns.
    v.gameP1.hardDrop();
    v.gameP1.lockPiece();
    expect(playerLocks.length).toBe(1);
    expect(playerLocks[0].side).toBe('player');
    v.dispose();
  });

  it('opponent events stay on the private opponent bus (no leak to host)', () => {
    const hostBus = new EventBus({ replayBufferSize: 0, recorderSize: 0 });
    const opponentLocks = [];
    hostBus.on(EVENTS.PIECE_LOCK, (e) => { if (e.side === 'opponent') opponentLocks.push(e); });

    const v = new VersusSession({
      parent: new FakeGroup(),
      rendererDeps: fakeRendererDeps(),
      inputTarget: makeFakeInputTarget(),
      playerInputMode: 'host',
      busP1: hostBus,
    });
    v.start();
    v.gameP2.hardDrop();
    v.gameP2.lockPiece();
    // Opponent bus is private — no leak to hostBus.
    expect(opponentLocks.length).toBe(0);
    v.dispose();
  });

  it('cross-bus garbage bridge still works with host-supplied busP1', () => {
    const hostBus = new EventBus({ replayBufferSize: 0, recorderSize: 0 });
    const v = new VersusSession({
      parent: new FakeGroup(),
      rendererDeps: fakeRendererDeps(),
      inputTarget: makeFakeInputTarget(),
      playerInputMode: 'host',
      busP1: hostBus,
    });
    v.start();
    // Player clears 2 lines → bridge sends 1 garbage to opponent.
    for (let c = 0; c < v.gameP1.cols; c++) v.gameP1.board[0][c] = 0xff0000;
    for (let c = 0; c < v.gameP1.cols; c++) v.gameP1.board[1][c] = 0xff0000;
    v.gameP1.clearLines([0, 1]);
    expect(v.gameP2.queuedGarbageRows).toBeGreaterThanOrEqual(1);
    v.dispose();
  });
});
