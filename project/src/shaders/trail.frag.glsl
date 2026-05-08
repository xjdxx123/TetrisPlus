uniform sampler2D uTexture;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 t = texture2D(uTexture, gl_PointCoord);
  // HDR > 1.0 in vColor is intentional — additive + bloom does the rest.
  vec3 rgb = vColor * t.a * vAlpha;
  if (rgb.r + rgb.g + rgb.b < 0.003) discard;
  gl_FragColor = vec4(rgb, 1.0);
}
