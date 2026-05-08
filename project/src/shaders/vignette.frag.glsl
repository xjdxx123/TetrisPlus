uniform sampler2D tDiffuse;
uniform float uIntensity;
uniform float uRadius;
varying vec2 vUv;
void main() {
  vec4 col = texture2D(tDiffuse, vUv);
  float d = distance(vUv, vec2(0.5));
  float v = smoothstep(uRadius, uRadius + 0.5, d);
  col.rgb *= 1.0 - v * uIntensity;
  gl_FragColor = col;
}
