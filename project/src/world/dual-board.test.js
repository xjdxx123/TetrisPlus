// Tests for DualBoard — the side-by-side scene anchor layout
// (plan_gameplay_1.md §3.7 sub-phase 7e).

import { describe, it, expect, vi } from 'vitest';
import { DualBoard } from './dual-board.js';

vi.mock('three', () => {
  class FakeVec3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  }
  class FakeGroup {
    constructor() { this.children = []; this.parent = null; this.position = new FakeVec3(); }
    add(c)    { this.children.push(c); c.parent = this; }
    remove(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parent = null; }
  }
  return { Group: FakeGroup, Vector3: FakeVec3, Object3D: FakeGroup };
});

class FakeGroup {
  constructor() { this.children = []; this.parent = null; this.position = { x: 0, y: 0, z: 0 }; }
  add(c)    { this.children.push(c); c.parent = this; }
  remove(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parent = null; }
}

describe('DualBoard — construction', () => {
  it('throws without a parent', () => {
    expect(() => new DualBoard({})).toThrow(/parent/);
  });

  it('creates two anchor groups offset symmetrically', () => {
    const parent = new FakeGroup();
    const dual = new DualBoard({ parent, separation: 20 });
    expect(parent.children).toContain(dual.leftAnchor);
    expect(parent.children).toContain(dual.rightAnchor);
    expect(dual.leftAnchor.position.x).toBe(-10);
    expect(dual.rightAnchor.position.x).toBe(10);
  });

  it('uses default separation of 18 when unspecified', () => {
    const parent = new FakeGroup();
    const dual = new DualBoard({ parent });
    expect(dual.leftAnchor.position.x).toBe(-9);
    expect(dual.rightAnchor.position.x).toBe(9);
  });
});

describe('DualBoard — anchorFor / anchors', () => {
  it('looks up anchors by side tag', () => {
    const parent = new FakeGroup();
    const dual = new DualBoard({ parent });
    expect(dual.anchorFor('player')).toBe(dual.leftAnchor);
    expect(dual.anchorFor('opponent')).toBe(dual.rightAnchor);
    expect(dual.anchorFor('nope')).toBeNull();
  });

  it('returns both anchors via anchors()', () => {
    const parent = new FakeGroup();
    const dual = new DualBoard({ parent });
    const arr = dual.anchors();
    expect(arr).toEqual([dual.leftAnchor, dual.rightAnchor]);
  });

  it('respects custom side tags', () => {
    const parent = new FakeGroup();
    const dual = new DualBoard({ parent, leftSide: 'p1', rightSide: 'p2' });
    expect(dual.anchorFor('p1')).toBe(dual.leftAnchor);
    expect(dual.anchorFor('p2')).toBe(dual.rightAnchor);
  });
});

describe('DualBoard — setSeparation + dispose', () => {
  it('updates anchor positions when separation changes', () => {
    const parent = new FakeGroup();
    const dual = new DualBoard({ parent, separation: 10 });
    dual.setSeparation(40);
    expect(dual.leftAnchor.position.x).toBe(-20);
    expect(dual.rightAnchor.position.x).toBe(20);
  });

  it('ignores invalid separation values', () => {
    const parent = new FakeGroup();
    const dual = new DualBoard({ parent, separation: 10 });
    dual.setSeparation(-5);
    dual.setSeparation(0);
    dual.setSeparation('big');
    expect(dual.leftAnchor.position.x).toBe(-5); // unchanged
    expect(dual.rightAnchor.position.x).toBe(5);
  });

  it('dispose removes both anchors from parent', () => {
    const parent = new FakeGroup();
    const dual = new DualBoard({ parent });
    dual.dispose();
    expect(parent.children).not.toContain(dual.leftAnchor);
    expect(parent.children).not.toContain(dual.rightAnchor);
  });
});
