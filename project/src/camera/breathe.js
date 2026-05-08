// Camera FOV breathing — slow sinusoidal oscillation around a base FOV.
//
// Stage 1 of plan_particle_2.md. Subtle on purpose (~0.4° amplitude on a 38°
// FOV ≈ 1%). Reads as "the world is alive" rather than "the camera is moving."
//
// Stage 5 will multiply the amplitude by `bands.bass.smoothed` so the FOV
// expands gently on the drop. For now, pure time-driven sine.
//
// Uses the engine clock's totalSec — no internal time accumulation, so the
// breathing pauses cleanly when the clock pauses (slow-mo, future pause).

export function createBreathe({
  amplitudeDeg = 0.4,
  periodSec = 9,
} = {}) {
  let baseFov = null;
  let intensity = 1.3; // multiplier for Stage 5 audio modulation
  let enabled = true;

  return {
    // Capture the camera's base FOV once at boot. Subsequent calls become a
    // no-op so we don't accidentally double-bind after a renderer resize.
    bindBase(camera) {
      if (baseFov === null) baseFov = camera.fov;
    },

    update(camera, totalSec) {
      if (baseFov === null) this.bindBase(camera);
      // When disabled, snap FOV back to base if drifted, then bail.
      if (!enabled) {
        if (camera.fov !== baseFov) {
          camera.fov = baseFov;
          camera.updateProjectionMatrix();
        }
        return;
      }
      const phase = (totalSec / periodSec) * Math.PI * 2;
      const delta = Math.sin(phase) * amplitudeDeg * intensity;
      camera.fov = baseFov + delta;
      camera.updateProjectionMatrix();
    },

    // Stage 5 hook — audio-reactive bindings will write here.
    setIntensity(v) { intensity = v; },

    // Effects-panel toggle. When disabled, FOV is restored to the base on
    // the next update tick (visible immediately, before the next render).
    setEnabled(b) { enabled = !!b; },

    // For tests / introspection.
    get baseFov() { return baseFov; },
    get enabled() { return enabled; },
  };
}
