// Soft circular point with radial alpha falloff. Discards near-zero alpha
// to avoid the additive-fragment cost on the corners of the point sprite.
// vSeed lets each star pick a slightly biased hue without a per-vertex color
// attribute (cheap variation, same draw call).
uniform vec3 uColor;
uniform vec3 uColorAccent;
varying float vSize;
varying float vSeed;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = length(d);
  float a = smoothstep(0.5, 0.0, r);
  if (a < 0.02) discard;
  // Mix between base + accent by per-star seed; weighted toward base.
  vec3 col = mix(uColor, uColorAccent, vSeed * 0.35);
  // Brightness ramps with sprite size — bigger points read as nearer/brighter.
  float intensity = 0.35 + 0.55 * (vSize / 2.6);
  gl_FragColor = vec4(col, a * intensity);
}
