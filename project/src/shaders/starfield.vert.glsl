// Starfield — fixed-position points on a far sphere shell.
// Per-vertex aSize is in pixels-at-unit-distance; gl_PointSize divides by -mv.z
// so closer stars stay readable while distant ones don't bloat under bloom.
attribute float aSize;
attribute float aSeed;
uniform float uPx;       // pixel-density scalar (DPR-aware from JS)
varying float vSize;
varying float vSeed;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = aSize * uPx;
  vSize = aSize;
  vSeed = aSeed;
}
