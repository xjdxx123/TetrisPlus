// Nebula sky fragment shader — Stage 10 of plan_particle_2.md.
//
// 3-octave fbm of 3D simplex noise sampled along the view direction. Noise
// value (in [-1,1] → mapped to [0,1]) indexes a 1D palette LUT to produce
// the final color. Two LUTs (uPaletteA, uPaletteB) blended by uStageBlend
// support cross-fade transitions on stage change without re-baking textures.
//
// Brightness is multiplied by uIntensity (default 0.35) — nebula MUST stay
// dim enough to live behind the playfield without competing for bloom
// attention. Material has userData.enableBloom = false so it never bleeds
// into the bloom pass regardless of brightness.

// =============================================================
// 3D simplex noise — Stefan Gustavson / Ian McEwan, MIT.
// Inlined here (single-file shader) since Vite's `?raw` import doesn't
// process GLSL #include directives. ~80 lines but well-known and stable.
// =============================================================
vec4 permute(vec4 x) { return mod(((x*34.0)+1.0)*x, 289.0); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2  C = vec2(1.0/6.0, 1.0/3.0);
  const vec4  D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g  = step(x0.yzx, x0.xyz);
  vec3 l  = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + 1.0 * C.xxx;
  vec3 x2 = x0 - i2 + 2.0 * C.xxx;
  vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
  i = mod(i, 289.0);
  vec4 p = permute(permute(permute(
              i.z + vec4(0.0, i1.z, i2.z, 1.0)) +
              i.y + vec4(0.0, i1.y, i2.y, 1.0)) +
              i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 1.0/7.0;
  vec3  ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

// fbm — sum of octaves with non-integer lacunarity (2.07) to avoid axis
// alignment that would show as a visible grid in the noise.
float fbm(vec3 p) {
  float a = 0.0;
  float w = 0.5;
  for (int i = 0; i < 3; i++) {
    a += w * snoise(p);
    p *= 2.07;
    w *= 0.5;
  }
  return a;
}

uniform sampler2D uPaletteA;
uniform sampler2D uPaletteB;
uniform float     uStageBlend;   // 0..1
uniform float     uTime;
uniform float     uIntensity;
varying vec3      vWorldDir;

void main() {
  vec3 dir = normalize(vWorldDir);
  // Slow drift in time — non-uniform so the pattern doesn't read as
  // "translating uniformly" across the dome.
  vec3 sampPos = dir * 1.6 + vec3(uTime * 0.005, uTime * 0.003, uTime * 0.007);
  float n = fbm(sampPos);
  float pal = clamp(n * 0.5 + 0.5, 0.0, 1.0);
  vec3 a = texture2D(uPaletteA, vec2(pal, 0.5)).rgb;
  vec3 b = texture2D(uPaletteB, vec2(pal, 0.5)).rgb;
  vec3 col = mix(a, b, uStageBlend);
  gl_FragColor = vec4(col * uIntensity, 1.0);
}
