// Camera shake — additive impulse layer.
//
// Two phase-offset sines per axis sum to a chaotic-but-smooth signal. The
// frequency is driven by real-time `dtRender` (so the noise pitch stays
// constant during slow-mo) while the intensity decay is driven by `dtGame`
// (so a Tetris-grade shake stretches longer in wall-clock during slow-mo).
// That asymmetry is intentional game-feel.
//
// Two mutator APIs:
//   - impulse(magnitude): max with current — accumulates from short bumps
//   - setForce(magnitude): direct set, capped at maxIntensity — for combo
//     spikes that should overwrite a smaller in-flight shake.

import * as THREE from 'three';

export function createShake({
  maxIntensity = 1.6,
  frequency = 22,
  decayBase = 0.001, // intensity *= decayBase^dtGame each frame
} = {}) {
  let intensity = 0;
  let clock = 0;
  const offset = new THREE.Vector3();

  function noise(t) {
    return Math.sin(t) * 0.6 + Math.sin(t * 2.37 + 1.7) * 0.4;
  }

  return {
    get intensity() { return intensity; },
    get offset() { return offset; },

    impulse(magnitude) {
      if (magnitude > intensity) intensity = magnitude;
    },

    setForce(magnitude) {
      intensity = Math.min(maxIntensity, magnitude);
    },

    update(dtRender, dtGame) {
      if (intensity > 0.001) {
        clock += dtRender;
        const t = clock * frequency;
        offset.set(
          noise(t)       * intensity,
          noise(t + 100) * intensity,
          noise(t + 200) * intensity * 0.5,
        );
        intensity *= Math.pow(decayBase, dtGame);
      } else {
        offset.set(0, 0, 0);
      }
    },
  };
}
