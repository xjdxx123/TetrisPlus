// Procedural moon — Lambertian shading + multi-octave FBM surface detail.
//
// Three layered passes drive the visible texture:
//   1. Mare/highlands albedo: one low-frequency FBM picks between a darker
//      basaltic gray (mare) and a lighter dust gray (highlands). Reads as
//      "the dark patches on the moon."
//   2. Cratering: a higher-frequency FBM creates rim-light + dimple effects.
//      We treat its gradient as a fake bump field that perturbs the lit
//      normal — convincing without going through tangent-space mapping.
//   3. Fine grain: a final high-frequency noise multiplies the albedo so
//      the surface never reads as flat-colored regions, even at distance.
//
// Lit by a fixed `uSunDir` — the playfield's lighting is irrelevant for a
// celestial body, and a fixed direction lets the terminator (day/night
// boundary) sit where it composes nicely against the case.
//
// Selective-bloom: NOT bloom-eligible. The moon is reflective material,
// not a light source — without this discipline it'd halo into the rest of
// the scene and stop reading as solid.

uniform vec3  uSunDir;          // world-space, normalized
uniform vec3  uHighlandColor;   // light dust gray
uniform vec3  uMareColor;       // dark basalt gray
uniform vec3  uEarthshine;      // faint cool ambient on the dark side
uniform float uIntensity;       // 0..1 master fade for effects-panel toggle
uniform float uBumpStrength;
uniform float uMareScale;
uniform float uCraterScale;
uniform float uFineScale;
uniform float uTerminatorSoftness; // 0=hard line, 1=barely visible
varying vec3  vNormalW;
varying vec3  vLocal;

// Hash-based 3D value noise. Same shape as the curl-noise CPU sampler,
// kept inline so this shader is self-contained.
float hash3(vec3 p) {
  p = fract(p * vec3(443.8975, 397.2973, 491.1871));
  p += dot(p, p.yxz + 19.19);
  return fract((p.x + p.y) * p.z);
}
float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash3(i + vec3(0.0, 0.0, 0.0));
  float n100 = hash3(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash3(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash3(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash3(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash3(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash3(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash3(i + vec3(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
    mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
    f.z
  );
}
float fbm(vec3 p, int octaves) {
  float v = 0.0;
  float a = 0.5;
  // Loop bound is constant (GLSL ES 1.0 requirement); the octaves param
  // gates with `if`. 6 is plenty for a moon — beyond this the visible
  // detail is sub-pixel.
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    v += a * noise3(p);
    p *= 2.07;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec3 N = normalize(vNormalW);
  vec3 L = normalize(uSunDir);

  // Sample noise in object-local space so the pattern rotates with the
  // moon, not with the camera. `vLocal` is the un-transformed sphere
  // position — sampling on a sphere means the noise sits *on* the
  // surface, not floating in 3-space.
  vec3 sp = normalize(vLocal);

  // Mare / highlands albedo. Low-freq FBM thresholded into a soft mask.
  float mare = smoothstep(0.42, 0.62, fbm(sp * uMareScale, 4));
  vec3 albedo = mix(uHighlandColor, uMareColor, mare);

  // Cratering — sample fbm at three small offsets to get a crude gradient,
  // use that to perturb the lit normal. The result reads as bumpy surface
  // self-shadowing without a true normal map. Step size is tuned to match
  // the crater frequency so the bumps look coherent.
  float eps = 0.04;
  float h0 = fbm(sp * uCraterScale, 5);
  float hx = fbm((sp + vec3(eps, 0.0, 0.0)) * uCraterScale, 5);
  float hy = fbm((sp + vec3(0.0, eps, 0.0)) * uCraterScale, 5);
  float hz = fbm((sp + vec3(0.0, 0.0, eps)) * uCraterScale, 5);
  vec3 grad = (vec3(hx, hy, hz) - vec3(h0)) / eps;
  vec3 Nb = normalize(N + grad * uBumpStrength);

  // Fine grain — multiplies into albedo so flat regions still feel
  // "dusted." Cheap; one extra FBM call but at high frequency the eye
  // reads it as texture, not as banded noise.
  float grain = fbm(sp * uFineScale, 3);
  albedo *= (0.85 + 0.30 * grain);

  // Lambertian against the perturbed normal. We blend toward "fully lit"
  // by uTerminatorSoftness so the reference's mostly-lit-disc look is
  // achievable without losing the bump-driven micro-shading.
  float ndlRaw = max(0.0, dot(Nb, L));
  float ndl = mix(ndlRaw, 0.5 + 0.5 * ndlRaw, uTerminatorSoftness);

  // Terminator on the un-perturbed normal — keeps the day/night boundary
  // from looking jagged at the edge bumps. Width grows with softness so a
  // nearly-full moon has no visible terminator line at all.
  float halfW = mix(0.05, 0.55, uTerminatorSoftness);
  float terminator = smoothstep(-halfW, halfW, dot(N, L));

  // Compose: lit side uses albedo*ndl gated by terminator; dark side
  // gets a cool earthshine ambient so it never goes black against the
  // night sky.
  vec3 lit = albedo * ndl * terminator;
  vec3 dark = uEarthshine * (1.0 - terminator);
  vec3 color = (lit + dark) * uIntensity;

  gl_FragColor = vec4(color, 1.0);
}
