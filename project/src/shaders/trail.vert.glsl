// Hard-drop trail particles — same shape as ambient but with HDR color
// written directly (no uIntensity uniform; relies on bloom for headroom).
attribute vec3 aColor;
attribute float aSize;
attribute float aAlpha;
uniform float uPointScale;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vColor = aColor; vAlpha = aAlpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float sz = aSize * uPointScale / max(0.5, -mv.z);
  gl_PointSize = clamp(sz, 1.0, 80.0);
}
