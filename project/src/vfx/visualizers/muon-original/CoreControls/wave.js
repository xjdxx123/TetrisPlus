import * as THREE from "three";
import { Operations } from "../Utils/operations";
import { globalParams } from "..";
import { CoreControls } from ".";
// Patched: GUI module wasn't vendored (the GUIControls slider hookup below
// is dev-only live tuning, not a visual concern). `point.png` import was
// already commented out in the texture loader — dropped entirely.
import { getCurl } from "../Utils/curl";
import gsap from "gsap";
const texture = new THREE.TextureLoader().load(
  "https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/sprites/spark1.png"
);
export const Uniforms = {
  color: { value: new THREE.Color(0xffffff) },
  pointTexture: {
    value: texture,
  },
  time: {
    value: 1.0,
  },
  resolution: {
    value: new THREE.Vector2(),
  },
  isPlaying: {
    value: false,
  },
  beatScaler: {
    value: 1.0,
  },
  maxPoints: {
    value: 720,
  },
  radiusMultiplier: {
    value: 1.0,
  },
  spacing: {
    value: 1.0,
  },
  delta: {
    value: 0.0,
  },
};

export const freqData = (dataArray, maxPoints, isPlaying, split = 2) => {
  const _maxPoints = split > 1 ? maxPoints / split : maxPoints;

  const u_freqData = new Float32Array(_maxPoints * (split > 1 ? split : 1));
  let point = 0;
  if (isPlaying) {
    for (let iy = 0; iy < split; iy++) {
      for (let ix = 0; ix < _maxPoints; ix++) {
        point = Math.floor(
          Operations.map(
            iy % 2 == 0 ? ix : _maxPoints - ix,
            0,
            _maxPoints,
            0,
            dataArray.length
          )
        );
        u_freqData[ix + iy * _maxPoints] = dataArray[point];
      }
    }
  }
  return u_freqData;
};
export const sineWavePropagation = (
  wavesurfer,
  particles,
  particles2,
  sineCounter,
  dataArray,
  params,
  exponentialBassScaler,
  exponentialTrebleScaler,
  prevParams
) => {
  const beatScaler =
    exponentialTrebleScaler * 3.14 + exponentialBassScaler * 6.24 + 1.7;

  Uniforms.time.value = sineCounter;
  Uniforms.isPlaying.value = wavesurfer.isPlaying();
  Uniforms.beatScaler.value = beatScaler;
  Uniforms.maxPoints.value = params.maxPoints;
  Uniforms.radiusMultiplier.value = params.radiusMultiplier;
  Uniforms.spacing.value = params.spacing;
  const u_freqData = freqData(
    dataArray,
    params.maxPoints,
    wavesurfer.isPlaying()
  );

  particles.geometry.setAttribute(
    "u_freqData",
    new THREE.BufferAttribute(u_freqData, 1)
  );
  particles2.geometry.setAttribute(
    "u_freqData",
    new THREE.BufferAttribute(u_freqData, 1)
  );

  particles.geometry.attributes.position.needsUpdate = true;
  particles.geometry.attributes.scale.needsUpdate = true;
  particles2.geometry.attributes.position.needsUpdate = true;
  particles2.geometry.attributes.scale.needsUpdate = true;
};
export const wavePresetController = (params, _delta, particles) => {
  Uniforms.delta.value = _delta;
  let data = sessionStorage.getItem("initUpdateLockInterval");
  setTimeout(() => {
    globalParams.updateLock = !globalParams.updateLock;
  }, params.updateLockInterval * 100);
  // Patched: GUIControls.controlFolder.add(...) hookup dropped — dev-only
  // live tuning of updateLockInterval that we don't need for the A/B test.

  if (data === "false")
    sessionStorage.setItem("initUpdateLockInterval", "true");
  if (
    Math.abs(_delta) > params.deltaResponseLimit &&
    !globalParams.updateLock &&
    params.dynamicRadius
  ) {
    particles.rotation.z = Math.PI / 2;
    globalParams.updateLock = true;
    if (!params.visualizationPreset) {
      params.radiusMultiplier += _delta;
      params.radiusMultiplier = (params.radiusMultiplier % 1) + 0.001;
    }

    const vizPreset =
      CoreControls.visualizationPresets[globalParams.visualserPresetCounter];
    gsap.to(params, {
      duration: params.updateLockInterval,
      ease: "power4.out",
      radiusMultiplier: params.visualizationPreset
        ? vizPreset
        : params.radiusMultiplier,
    });

    if (params.visualizationPreset) {
      globalParams.visualserPresetCounter++;

      globalParams.visualserPresetCounter =
        globalParams.visualserPresetCounter %
        CoreControls.visualizationPresets.length;
    }
  }
};
