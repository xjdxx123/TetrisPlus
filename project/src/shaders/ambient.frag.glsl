uniform sampler2D uTexture;
uniform float uIntensity;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 t = texture2D(uTexture, gl_PointCoord);
  // Additive output: alpha channel of the sprite is the spatial mask;
  // vAlpha is the temporal envelope; vColor is the per-particle hue.
  vec3 rgb = vColor * t.a * vAlpha * uIntensity;
  if (rgb.r + rgb.g + rgb.b < 0.003) discard;
  gl_FragColor = vec4(rgb, 1.0);
}
