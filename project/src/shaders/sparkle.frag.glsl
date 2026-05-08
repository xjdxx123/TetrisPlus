uniform sampler2D uMap;
varying vec3  vColor;
varying float vAlpha;
void main() {
  if (vAlpha <= 0.001) discard;
  vec4 tex = texture2D(uMap, gl_PointCoord);
  gl_FragColor = vec4(vColor, vAlpha) * tex;
}
