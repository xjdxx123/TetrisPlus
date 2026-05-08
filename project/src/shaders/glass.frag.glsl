// Glass / fresnel fragment — active-piece glow + ghost outline.
// Additive blending; alpha is also baked into the rgb so the rim has weight
// even when the renderer ignores the alpha channel.
uniform vec3 uColor;
uniform float uIntensity;
uniform float uPower;
uniform float uFloor;
varying vec3 vNormalW;
varying vec3 vViewDirW;
void main() {
  float ndv = clamp(dot(normalize(vNormalW), normalize(vViewDirW)), 0.0, 1.0);
  float fres = pow(1.0 - ndv, uPower);
  // uFloor adds a faint body so the rim has weight, not just a hairline.
  float a = (uFloor + (1.0 - uFloor) * fres) * uIntensity;
  gl_FragColor = vec4(uColor * a, a);
}
