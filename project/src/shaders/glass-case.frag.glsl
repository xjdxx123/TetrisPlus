// Glass case fragment — fresnel-driven alpha for case walls / bottom.
//
// Real glass is nearly invisible head-on and brightens at grazing edges where
// the surface curvature catches reflections. With no env map to sample,
// MeshPhysicalMaterial can't reproduce that — it either flashes at single
// reflection angles (metallic) or tints uniformly (rough), the latter reading
// as plastic. This shader bakes the fresnel directly: face-on alpha is tiny,
// rim alpha is high, with a smooth ramp between.
uniform vec3 uTint;
uniform vec3 uRimColor;
uniform float uTintAlpha;
uniform float uRimAlpha;
uniform float uPower;
varying vec3 vNormalW;
varying vec3 vViewDirW;
void main() {
  // abs() so back-side fragments (DoubleSide off here, but harmless) and
  // any normal flips read symmetrically.
  float ndv = clamp(abs(dot(normalize(vNormalW), normalize(vViewDirW))), 0.0, 1.0);
  float fres = pow(1.0 - ndv, uPower);
  vec3 col = mix(uTint, uRimColor, fres);
  float a = uTintAlpha + (uRimAlpha - uTintAlpha) * fres;
  gl_FragColor = vec4(col, a);
}
