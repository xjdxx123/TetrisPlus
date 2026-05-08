// Glass / fresnel fragment — active-piece glow + ghost outline.
// Additive blending; alpha is also baked into the rgb so the rim has weight
// even when the renderer ignores the alpha channel.
//
// Stage 2: an extra edge-detect highlight component lifts the geometric
// edges of the cube above the smooth fresnel falloff. fwidth(vNormalW)
// spikes where the normal swings rapidly (across the bevel), giving us a
// near-free per-pixel edge mask. Multiplied by uEdgeIntensity so callers
// can pulse it on lock / level / beat without re-uploading the material.
uniform vec3 uColor;
uniform float uIntensity;
uniform float uPower;
uniform float uFloor;
uniform vec3 uEdgeColor;
uniform float uEdgeIntensity;
varying vec3 vNormalW;
varying vec3 vViewDirW;
void main() {
  float ndv = clamp(dot(normalize(vNormalW), normalize(vViewDirW)), 0.0, 1.0);
  float fres = pow(1.0 - ndv, uPower);
  // uFloor adds a faint body so the rim has weight, not just a hairline.
  float a = (uFloor + (1.0 - uFloor) * fres) * uIntensity;
  vec3 base = uColor * a;
  // Edge accent — additive on top of fresnel.
  float edge = clamp(length(fwidth(vNormalW)) * 6.0, 0.0, 1.0);
  base += uEdgeColor * edge * uEdgeIntensity;
  gl_FragColor = vec4(base, a);
}
