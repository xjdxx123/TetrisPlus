// vfx/director — gameplay → cinematic translation.
//
// This is *the* place game-feel decisions live. Gameplay describes the world
// (LINE_CLEAR, HARD_DROP, LEVEL_UP, …); the director decides what the show
// looks like. Tuning the feel of a 4-line clear should mean editing one
// function in this file, not chasing edits across gameplay code.
//
// The director itself is pure logic — no THREE, no DOM, no audio APIs. It
// receives a small `api` object whose implementations live elsewhere (today:
// inline functions in app/main.js; tomorrow: vfx/emitters, materials, etc.).
// As subsystems extract, only the api wiring at the call site moves; the
// director's internals do not.
//
// Usage:
//   const stop = registerDirector(bus, {
//     impactRing, hardDropTrail, sfx, levelUpFx,
//   });
//   // … later, to tear down (tests, hot-reload):
//   stop();

import { EVENTS } from '../gameplay/events.js';

/**
 * @typedef {Object} DirectorApi
 * @property {(x: number, y: number, color: number) => void} impactRing
 * @property {(cells: Array<{col:number,row:number}>, dropRows: number, color: number) => void} hardDropTrail
 * @property {(name: string, arg?: any) => void} sfx
 * @property {(level: number) => void} levelUpFx
 */

/**
 * Wire gameplay events to cinematic effects.
 * Returns an unsubscribe function that detaches all handlers.
 *
 * @param {{ on: Function }} bus
 * @param {DirectorApi} api
 * @returns {() => void}
 */
export function registerDirector(bus, api) {
  const offs = [];

  // Hard drop: a settled-piece visual punch — ring at the impact row, vertical
  // light trail along the dropped path, and a punchy SFX. Trail length scales
  // with drop distance so a long drop reads visibly heavier than a short one.
  offs.push(
    bus.on(EVENTS.HARD_DROP, ({ ringX, ringY, color, cells, dropRows }) => {
      api.impactRing(ringX, ringY, color);
      api.hardDropTrail(cells, dropRows, color);
      api.sfx('drop');
    })
  );

  // Level up: deliberately small for now — just the existing UI callout.
  // When the cinematic palette grows (camera lift, exposure tween, etc.) this
  // is where they layer in.
  offs.push(
    bus.on(EVENTS.LEVEL_UP, ({ level }) => {
      api.levelUpFx(level);
    })
  );

  return () => {
    for (const off of offs) off();
    offs.length = 0;
  };
}
