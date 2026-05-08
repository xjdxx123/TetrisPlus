// Stage 8c env-reaction layer — §1.6 Layer 7 ("environment reaction").
//
// Vertical light streaks that rise from the cleared rows past the case top.
// Stage-accent color, additive, bloom-eligible, ~1.2 s lifetime. Fires only
// when `clearRecipe[tier].envReaction === true` for the active stage —
// today, only `aurora.tetris` is gated on, per `plan_particle_2.md` §9.5.
//
// Self-contained ES module: owns one `InstancedMesh` (capacity 48, ~144 verts
// total) and animates per-instance state in the vertex shader from a single
// `uTime` uniform. CPU work per frame is one uniform write; CPU work per
// spawn is one `Matrix4.setPosition` + one attribute slot.

import * as THREE from 'three';

const STREAK_CAPACITY = 48;
const LIFETIME_SEC    = 1.2;
const RISE_DISTANCE   = 22;     // world units the streak travels over its life
const STREAK_HEIGHT   = 14;     // world height of each quad (well past case top)
const STREAK_WIDTH    = 0.32;
// Pre-life sentinel — the vertex shader collapses any instance whose spawn
// time is more than `LIFETIME_SEC` in the past, so initializing to a large
// negative number means "never spawned" without any extra branch.
const NEVER = -1e6;

/**
 * Build a streak-emitter mesh + control surface.
 *
 * The emitter owns its own monotonic clock — `update(dt)` advances it and
 * `spawnRow` reads it. Keeping the time base inside the module means the
 * caller doesn't have to thread the engine clock through to every event
 * handler that wants to spawn a streak.
 *
 * @param {Object} opts
 * @param {THREE.Scene} opts.scene
 * @returns {{
 *   mesh: THREE.InstancedMesh,
 *   spawnRow: (worldY: number, color: number, intensity: number) => void,
 *   update: (dt: number) => void,
 *   dispose: () => void,
 * }}
 */
export function createEnvReaction({ scene }) {
  // Anchor at base — the geometry origin is the bottom of the streak so a
  // single Matrix4.setPosition call places the streak at the cleared row.
  const geo = new THREE.PlaneGeometry(STREAK_WIDTH, STREAK_HEIGHT);
  geo.translate(0, STREAK_HEIGHT * 0.5, 0);

  // Per-instance state. `aSpawn` is wall-clock time at spawn; `aSeed` gives
  // each streak a stable [0,1) value the vertex shader uses for jitter so
  // streaks at the same spawn frame don't move identically.
  const aSpawn = new Float32Array(STREAK_CAPACITY).fill(NEVER);
  const aSeed  = new Float32Array(STREAK_CAPACITY);
  for (let i = 0; i < STREAK_CAPACITY; i++) aSeed[i] = Math.random();
  const aSpawnAttr = new THREE.InstancedBufferAttribute(aSpawn, 1);
  const aSeedAttr  = new THREE.InstancedBufferAttribute(aSeed, 1);
  geo.setAttribute('aSpawn', aSpawnAttr);
  geo.setAttribute('aSeed',  aSeedAttr);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor:    { value: new THREE.Color(0xa0e6ff) },
      uTime:     { value: 0 },
      uLifetime: { value: LIFETIME_SEC },
      uRise:     { value: RISE_DISTANCE },
    },
    vertexShader: /* glsl */`
      attribute float aSpawn;
      attribute float aSeed;
      uniform float uTime;
      uniform float uLifetime;
      uniform float uRise;
      varying float vAlpha;
      varying float vV;
      void main() {
        float age = uTime - aSpawn;
        // Inactive instances collapse to (0,0,0,0) and the fragment shader
        // discards them via vAlpha=0. Cheaper than a frustum-cull dance.
        if (age < 0.0 || age > uLifetime) {
          gl_Position = vec4(0.0);
          vAlpha = 0.0;
          vV = 0.0;
          return;
        }
        float k = age / uLifetime;
        // Eased upward — slow start, fast middle, slow end. Reads as
        // "thrown upward" rather than "linearly translated."
        float ease = 1.0 - pow(1.0 - k, 2.0);
        vec3 p = position;
        p.y += ease * uRise;
        // Tiny horizontal sway so a band of streaks doesn't read as a
        // hard wall. Per-instance phase via aSeed.
        p.x += sin(uTime * 1.4 + aSeed * 6.2832) * 0.06;

        vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * viewMatrix * wp;

        // Envelope: 12% fade-in, 60% steady, 28% fade-out.
        float a;
        if (k < 0.12)      a = k / 0.12;
        else if (k < 0.72) a = 1.0;
        else               a = max(0.0, 1.0 - (k - 0.72) / 0.28);
        // Gentle dim with age so the tail doesn't over-bloom.
        vAlpha = a * (1.0 - 0.25 * k);
        vV = uv.y;
      }
    `,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      varying float vAlpha;
      varying float vV;
      void main() {
        // Bright at base, fall off toward the top — streaks read as
        // "shooting up" rather than "uniform pillar."
        float top  = smoothstep(1.0, 0.35, vV);
        float a = top * vAlpha;
        if (a < 0.005) discard;
        gl_FragColor = vec4(uColor * a, a);
      }
    `,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  // Selective-bloom flag — env-reaction is one of the surfaces that *should*
  // bloom heavily (per §1.6 Layer 7 the env reaction is the loudest peripheral
  // event when it fires). Without this flag selective-bloom would render it
  // as black during the bloom pass.
  mat.userData.enableBloom = true;

  const mesh = new THREE.InstancedMesh(geo, mat, STREAK_CAPACITY);
  mesh.frustumCulled = false;
  mesh.count = STREAK_CAPACITY;
  // Initialize matrices well outside the camera so the instanceMatrix buffer
  // is uploaded once with valid (if invisible) values.
  const _scratch = new THREE.Matrix4().setPosition(0, -1e3, 0);
  for (let i = 0; i < STREAK_CAPACITY; i++) mesh.setMatrixAt(i, _scratch);
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);

  let cursor = 0;
  let elapsed = 0;   // monotonic seconds since module init; matches uTime.
  const _pos    = new THREE.Vector3();
  const _matrix = new THREE.Matrix4();

  /**
   * Emit a band of streaks at the given world Y. `intensity` is the
   * tetromino tier (1=single, …, 4=tetris); we use it only to widen the
   * X spread on bigger clears — the streak count is fixed so a Tetris
   * doesn't run away with the pool.
   */
  function spawnRow(worldY, color, intensity) {
    const STREAKS_PER_TRIGGER = 16;
    const xSpread = 4.5 + intensity * 0.6;   // playfield is ±5 in X
    const zSpread = 1.2;                      // shallow depth jitter
    mat.uniforms.uColor.value.setHex(color);
    for (let i = 0; i < STREAKS_PER_TRIGGER; i++) {
      const slot = cursor;
      cursor = (cursor + 1) % STREAK_CAPACITY;
      // Even-ish spacing across X with a small random offset; the regular
      // rhythm reads as "a wall of streaks", random alone reads as noise.
      const t = (i + Math.random() * 0.6) / STREAKS_PER_TRIGGER;
      const x = (t - 0.5) * 2 * xSpread;
      const z = (Math.random() - 0.5) * 2 * zSpread;
      _pos.set(x, worldY, z);
      _matrix.identity();
      _matrix.setPosition(_pos);
      mesh.setMatrixAt(slot, _matrix);
      aSpawn[slot] = elapsed;
    }
    mesh.instanceMatrix.needsUpdate = true;
    aSpawnAttr.needsUpdate = true;
  }

  function update(dt) {
    elapsed += dt;
    mat.uniforms.uTime.value = elapsed;
  }

  function dispose() {
    scene.remove(mesh);
    geo.dispose();
    mat.dispose();
  }

  return { mesh, spawnRow, update, dispose };
}
