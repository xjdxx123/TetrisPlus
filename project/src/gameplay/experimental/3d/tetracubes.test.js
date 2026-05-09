// Sanity tests for the tetracube piece library. These guard the
// shape data itself (count, connectedness, chirality flags); rotation
// behaviour is exercised in `./rotation.test.js`.

import { describe, it, expect } from 'vitest';
import { TETRACUBES, TETRACUBE_KEYS, TETRACUBE_COLORS } from './tetracubes.js';

/** Are two cells face-adjacent (Manhattan distance == 1)? */
function faceAdjacent(a, b) {
  const dx = Math.abs(a[0] - b[0]);
  const dy = Math.abs(a[1] - b[1]);
  const dz = Math.abs(a[2] - b[2]);
  return dx + dy + dz === 1;
}

/** True iff the cells form one face-connected component. */
function isConnected(cells) {
  if (cells.length === 0) return false;
  const visited = new Set([0]);
  const queue = [0];
  while (queue.length) {
    const i = queue.pop();
    for (let j = 0; j < cells.length; j++) {
      if (visited.has(j)) continue;
      if (faceAdjacent(cells[i], cells[j])) {
        visited.add(j);
        queue.push(j);
      }
    }
  }
  return visited.size === cells.length;
}

describe('tetracubes', () => {
  it('exports exactly 8 pieces', () => {
    expect(TETRACUBE_KEYS).toHaveLength(8);
  });

  it('every piece has exactly 4 cells', () => {
    for (const key of TETRACUBE_KEYS) {
      expect(TETRACUBES[key].cells.length).toBe(4);
    }
  });

  it('every piece is face-connected', () => {
    for (const key of TETRACUBE_KEYS) {
      const piece = TETRACUBES[key];
      expect(isConnected(piece.cells)).toBe(true);
    }
  });

  it('cells are distinct integer triples', () => {
    for (const key of TETRACUBE_KEYS) {
      const seen = new Set();
      for (const [x, y, z] of TETRACUBES[key].cells) {
        expect(Number.isInteger(x)).toBe(true);
        expect(Number.isInteger(y)).toBe(true);
        expect(Number.isInteger(z)).toBe(true);
        const k = `${x},${y},${z}`;
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    }
  });

  it('cells start at the origin corner of their bounding box', () => {
    // The base orientation is normalized so min(x)=min(y)=min(z)=0.
    // This invariant is what `rotation.normalize` will restore after
    // rotating, so it's worth pinning at the data level too.
    for (const key of TETRACUBE_KEYS) {
      const cells = TETRACUBES[key].cells;
      const minX = Math.min(...cells.map((c) => c[0]));
      const minY = Math.min(...cells.map((c) => c[1]));
      const minZ = Math.min(...cells.map((c) => c[2]));
      expect(minX).toBe(0);
      expect(minY).toBe(0);
      expect(minZ).toBe(0);
    }
  });

  it('flat pieces (I/O/T/L/S) lie in z=0', () => {
    for (const key of ['I', 'O', 'T', 'L', 'S']) {
      const piece = TETRACUBES[key];
      expect(piece.kind).toBe('flat');
      for (const [, , z] of piece.cells) expect(z).toBe(0);
    }
  });

  it('branch piece is genuinely 3D (spans 2 z values)', () => {
    const branch = TETRACUBES.B;
    expect(branch.kind).toBe('branch');
    const zs = new Set(branch.cells.map((c) => c[2]));
    expect(zs.size).toBe(2);
  });

  it('screw pieces are chiral and span all 3 axes', () => {
    for (const key of ['SR', 'SL']) {
      const piece = TETRACUBES[key];
      expect(piece.kind).toBe('screw');
      expect(['R', 'L']).toContain(piece.chirality);
      const xs = new Set(piece.cells.map((c) => c[0]));
      const ys = new Set(piece.cells.map((c) => c[1]));
      const zs = new Set(piece.cells.map((c) => c[2]));
      expect(xs.size).toBe(2);
      expect(ys.size).toBe(2);
      expect(zs.size).toBe(2);
    }
    expect(TETRACUBES.SR.chirality).toBe('R');
    expect(TETRACUBES.SL.chirality).toBe('L');
  });

  it('screws are mirror images (no rotation maps one to the other — proven via rotation.test.js)', () => {
    // The chirality test above is the data-level guard; the
    // "no rotation maps SR to SL" property is structural and verified
    // in rotation.test.js by enumerating all 24 rotations of SR and
    // checking SL's canonical key is not in the result set.
    expect(TETRACUBES.SR.chirality).not.toBe(TETRACUBES.SL.chirality);
  });

  it('every piece has a color in TETRACUBE_COLORS', () => {
    for (const key of TETRACUBE_KEYS) {
      expect(TETRACUBE_COLORS[key]).toBeTypeOf('number');
      expect(TETRACUBE_COLORS[key]).toBeGreaterThan(0);
      expect(TETRACUBE_COLORS[key]).toBeLessThan(0x1000000);
    }
  });
});
