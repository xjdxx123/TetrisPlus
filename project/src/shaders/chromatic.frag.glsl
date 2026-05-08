// Radial chromatic aberration. Sample R / G / B from offset UVs along the
// screen radial; offset magnitude grows with radius so the center stays
// crisp and the corners get a colour fringe.
//
// Stage 6 of plan_particle_2.md. uAmount in [0, 1]; multiplied by `r * 0.012`
// so even uAmount=1 only offsets ~6 px at the corner of a 1080p frame.
// That's intentionally restrained — full-screen CA reads as "broken VR" in
// seconds, not "cinematic feel."
//
// uAmount is bound to bands.air.norm in vfx/reactive/bindings.js — high-end
// shimmer (cymbals/hats) drives the offset, so the effect *feels* musical
// without competing with the bass-driven bloom.
uniform sampler2D tDiffuse;
uniform float uAmount;
varying vec2 vUv;
void main() {
  vec2 c = vec2(0.5);
  vec2 d = vUv - c;
  float r = length(d);
  vec2 dir = d / max(r, 1e-4);
  float amt = uAmount * r * 0.012;
  float r_ = texture2D(tDiffuse, vUv - dir * amt).r;
  float g_ = texture2D(tDiffuse, vUv).g;
  float b_ = texture2D(tDiffuse, vUv + dir * amt).b;
  gl_FragColor = vec4(r_, g_, b_, 1.0);
}
