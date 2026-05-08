// Punch-zoom — a quick dolly toward a target then ease back. Sized by combo
// length: bigger combos punch harder and last slightly longer.
//
// Bell-shape envelope (peak at k=0.25) gives a fast dolly-in, slow ease-out.

import * as THREE from 'three';

export function createPunchZoom() {
  let active = false;
  let t = 0;
  let dur = 0;
  let amount = 0;
  const offset = new THREE.Vector3();
  const _dir = new THREE.Vector3();

  return {
    get active() { return active; },
    get offset() { return offset; },

    trigger(rowCount, shatterPower = 1) {
      amount = (0.10 + (rowCount - 1) * 0.06) * shatterPower;
      dur = 0.45 + rowCount * 0.06;
      t = 0;
      active = true;
    },

    update(dtGame, cameraPosition, target) {
      if (!active) {
        offset.set(0, 0, 0);
        return;
      }
      t += dtGame;
      const k = Math.min(1, t / dur);
      const env = k < 0.25
        ? (k / 0.25)
        : Math.pow(1 - (k - 0.25) / 0.75, 2);
      _dir.subVectors(target, cameraPosition).normalize();
      const dist = cameraPosition.distanceTo(target);
      offset.copy(_dir).multiplyScalar(dist * amount * env);
      if (k >= 1) active = false;
    },
  };
}
