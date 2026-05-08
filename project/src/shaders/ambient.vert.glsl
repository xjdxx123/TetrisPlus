// Ambient drift-field particles (CPU-driven positions; this shader handles
// distance-attenuated screen-space sizing and per-particle alpha/color).
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
uniform float uPointScale;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor;
  vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  // Distance-attenuated screen-space size. Clamp to avoid massive
  // overdraw on particles that drift very close to the camera.
  float sz = aSize * uPointScale / max(0.5, -mv.z);
  gl_PointSize = clamp(sz, 1.0, 64.0);
}
