// Regression test for the "piece locked in mid-air, empty below" bug
// triggered when 2+ GARBAGE_APPLIED events fire in one lockPiece tick.
//
// Background: main.js owns a `cubeAnims` queue + a per-frame consumer
// loop that lerps `cube.position` from `from` to `to`. When two
// `animateCubeTo(sameCube, ...)` calls happen in one tick (multi-row
// garbage drain), BOTH entries stay in the queue. The consumer loop
// iterates in REVERSE (length-1 → 0), so the OLDER entry writes
// `cube.position` AFTER the newer one — the older's stale `to` wins.
// Result: locked-stack cubes settle 1+ rows below their intended row
// when drain shifts them up by 2+ rows in a single tick. Visually the
// piece appears suspended above empty cells.
//
// Fix (main.js animateCubeTo): drop any in-flight entry for the same
// cube before pushing the new one (last-write-wins).
//
// This test reproduces the queue + consumer logic in isolation. The
// real animateCubeTo / animate loop live in main.js (the composition
// root). Extracting them into a testable module is the next refactor;
// for now this lockstep clone catches the same class of regression.

import { describe, it, expect } from 'vitest';

// ─── Minimal clone of main.js's animation queue + consumer ──────────

function makeQueue({ dedupe }) {
  const cubeAnims = [];

  function animateCubeTo(cube, target) {
    if (dedupe) {
      // Last-write-wins: drop any in-flight tween for this cube before
      // queuing the new one (the production fix in main.js).
      for (let i = cubeAnims.length - 1; i >= 0; i--) {
        if (cubeAnims[i].cube === cube) cubeAnims.splice(i, 1);
      }
    }
    cubeAnims.push({
      cube,
      from: { x: cube.position.x, y: cube.position.y, z: cube.position.z },
      to:   { x: target.x,        y: target.y,        z: target.z },
      t: 0,
      dur: 0.35,
    });
  }

  // Mirror main.js:5234 — reverse iteration, splice on completion.
  function tick(dtSec) {
    for (let i = cubeAnims.length - 1; i >= 0; i--) {
      const a = cubeAnims[i];
      a.t += dtSec;
      const k = Math.min(1, a.t / a.dur);
      const ease = 1 - Math.pow(1 - k, 3);
      a.cube.position.x = a.from.x + (a.to.x - a.from.x) * ease;
      a.cube.position.y = a.from.y + (a.to.y - a.from.y) * ease;
      a.cube.position.z = a.from.z + (a.to.z - a.from.z) * ease;
      if (k >= 1) cubeAnims.splice(i, 1);
    }
  }

  return { animateCubeTo, tick, queueSize: () => cubeAnims.length };
}

function makeCube(y) {
  return { position: { x: 0, y, z: 0 } };
}

function runToCompletion(q) {
  // 0.35s @ 60Hz ≈ 21 frames. Run a few extra to ensure all anims splice.
  for (let i = 0; i < 30; i++) q.tick(1 / 60);
}

// ─── Reproduction of the symptom ───────────────────────────────────

describe('cubeAnims race when 2+ GARBAGE_APPLIED fire in one tick', () => {
  it('without dedupe: piece + first-garbage settle at wrong rows (the bug)', () => {
    const q = makeQueue({ dedupe: false });

    // Initial state mirrors the moment right after Game.lockPiece writes
    // the piece at row 0 and PIECE_LOCK has run — all cubes are at
    // world-y=0. Then 2 GARBAGE_APPLIED events fire in the same tick.
    const garbage2 = makeCube(0); // newest, target row 0
    const garbage1 = makeCube(0); // first drained, target row 1
    const piece    = makeCube(0); // shifted from row 0 → row 2

    // Reproduce the call sequence _onGarbageApplied makes:
    //   call 1 (1st garbage drained): cellMeshes is [garbage1, piece, ...]
    q.animateCubeTo(garbage1, { x: 0, y: 0, z: 0 }); // garbage1 → row 0 (no-op)
    q.animateCubeTo(piece,    { x: 0, y: 1, z: 0 }); // piece    → row 1

    //   call 2 (2nd garbage drained): cellMeshes is [garbage2, garbage1, piece, ...]
    q.animateCubeTo(garbage2, { x: 0, y: 0, z: 0 }); // garbage2 → row 0 (no-op)
    q.animateCubeTo(garbage1, { x: 0, y: 1, z: 0 }); // garbage1 → row 1 (was row 0)
    q.animateCubeTo(piece,    { x: 0, y: 2, z: 0 }); // piece    → row 2 (was row 1)

    runToCompletion(q);

    // The CORRECT final state is garbage2=0, garbage1=1, piece=2.
    // Without dedupe the older animations win and the cubes are stuck.
    expect(garbage2.position.y).toBe(0);  // correct (only one anim)
    expect(garbage1.position.y).toBe(0);  // BUG — should be 1
    expect(piece.position.y).toBe(1);     // BUG — should be 2
  });

  it('with dedupe: every cube settles at its final intended row', () => {
    const q = makeQueue({ dedupe: true });

    const garbage2 = makeCube(0);
    const garbage1 = makeCube(0);
    const piece    = makeCube(0);

    q.animateCubeTo(garbage1, { x: 0, y: 0, z: 0 });
    q.animateCubeTo(piece,    { x: 0, y: 1, z: 0 });

    q.animateCubeTo(garbage2, { x: 0, y: 0, z: 0 });
    q.animateCubeTo(garbage1, { x: 0, y: 1, z: 0 });
    q.animateCubeTo(piece,    { x: 0, y: 2, z: 0 });

    // Sanity: queue holds 3 entries (one per cube), not 5 — the older
    // duplicates were spliced when the newer ones queued.
    expect(q.queueSize()).toBe(3);

    runToCompletion(q);

    expect(garbage2.position.y).toBeCloseTo(0);
    expect(garbage1.position.y).toBeCloseTo(1);
    expect(piece.position.y).toBeCloseTo(2);
  });

  it('with dedupe: extends to 3-row drain (the obvious case the user reported)', () => {
    const q = makeQueue({ dedupe: true });

    const g3 = makeCube(0);
    const g2 = makeCube(0);
    const g1 = makeCube(0);
    const piece = makeCube(0);

    // Call 1: drain garbage-1 → cellMeshes [g1, piece]
    q.animateCubeTo(g1,    { x: 0, y: 0, z: 0 });
    q.animateCubeTo(piece, { x: 0, y: 1, z: 0 });
    // Call 2: drain garbage-2 → cellMeshes [g2, g1, piece]
    q.animateCubeTo(g2,    { x: 0, y: 0, z: 0 });
    q.animateCubeTo(g1,    { x: 0, y: 1, z: 0 });
    q.animateCubeTo(piece, { x: 0, y: 2, z: 0 });
    // Call 3: drain garbage-3 → cellMeshes [g3, g2, g1, piece]
    q.animateCubeTo(g3,    { x: 0, y: 0, z: 0 });
    q.animateCubeTo(g2,    { x: 0, y: 1, z: 0 });
    q.animateCubeTo(g1,    { x: 0, y: 2, z: 0 });
    q.animateCubeTo(piece, { x: 0, y: 3, z: 0 });

    expect(q.queueSize()).toBe(4); // exactly one per cube

    runToCompletion(q);

    expect(g3.position.y).toBeCloseTo(0);
    expect(g2.position.y).toBeCloseTo(1);
    expect(g1.position.y).toBeCloseTo(2);
    expect(piece.position.y).toBeCloseTo(3);
  });
});
