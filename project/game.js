import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';

// =============================================================
// Configuration
// =============================================================
const COLS = 10;
const ROWS = 20;
const DEPTH = 3;          // thicker than 2D — pieces fill all 3 depth slices
const CELL = 1.0;         // cube size in world units
const PLAY_W = COLS * CELL;
const PLAY_H = ROWS * CELL;
const PLAY_D = DEPTH * CELL;

// Tetromino colors (glass tints)
const PIECE_COLORS = {
  I: 0x4ad9ff, // cyan
  O: 0xffd246, // yellow
  T: 0xc768ff, // purple
  S: 0x5fff8a, // green
  Z: 0xff4a6b, // red
  J: 0x4a7dff, // blue
  L: 0xff9a3c, // orange
};

// Tetromino shapes — each piece has 4 rotation states (4×4 grids)
const PIECES = {
  I: [
    [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
    [[0,0,1,0],[0,0,1,0],[0,0,1,0],[0,0,1,0]],
    [[0,0,0,0],[0,0,0,0],[1,1,1,1],[0,0,0,0]],
    [[0,1,0,0],[0,1,0,0],[0,1,0,0],[0,1,0,0]],
  ],
  O: [
    [[0,1,1,0],[0,1,1,0],[0,0,0,0],[0,0,0,0]],
    [[0,1,1,0],[0,1,1,0],[0,0,0,0],[0,0,0,0]],
    [[0,1,1,0],[0,1,1,0],[0,0,0,0],[0,0,0,0]],
    [[0,1,1,0],[0,1,1,0],[0,0,0,0],[0,0,0,0]],
  ],
  T: [
    [[0,1,0,0],[1,1,1,0],[0,0,0,0],[0,0,0,0]],
    [[0,1,0,0],[0,1,1,0],[0,1,0,0],[0,0,0,0]],
    [[0,0,0,0],[1,1,1,0],[0,1,0,0],[0,0,0,0]],
    [[0,1,0,0],[1,1,0,0],[0,1,0,0],[0,0,0,0]],
  ],
  S: [
    [[0,1,1,0],[1,1,0,0],[0,0,0,0],[0,0,0,0]],
    [[0,1,0,0],[0,1,1,0],[0,0,1,0],[0,0,0,0]],
    [[0,0,0,0],[0,1,1,0],[1,1,0,0],[0,0,0,0]],
    [[1,0,0,0],[1,1,0,0],[0,1,0,0],[0,0,0,0]],
  ],
  Z: [
    [[1,1,0,0],[0,1,1,0],[0,0,0,0],[0,0,0,0]],
    [[0,0,1,0],[0,1,1,0],[0,1,0,0],[0,0,0,0]],
    [[0,0,0,0],[1,1,0,0],[0,1,1,0],[0,0,0,0]],
    [[0,1,0,0],[1,1,0,0],[1,0,0,0],[0,0,0,0]],
  ],
  J: [
    [[1,0,0,0],[1,1,1,0],[0,0,0,0],[0,0,0,0]],
    [[0,1,1,0],[0,1,0,0],[0,1,0,0],[0,0,0,0]],
    [[0,0,0,0],[1,1,1,0],[0,0,1,0],[0,0,0,0]],
    [[0,1,0,0],[0,1,0,0],[1,1,0,0],[0,0,0,0]],
  ],
  L: [
    [[0,0,1,0],[1,1,1,0],[0,0,0,0],[0,0,0,0]],
    [[0,1,0,0],[0,1,0,0],[0,1,1,0],[0,0,0,0]],
    [[0,0,0,0],[1,1,1,0],[1,0,0,0],[0,0,0,0]],
    [[1,1,0,0],[0,1,0,0],[0,1,0,0],[0,0,0,0]],
  ],
};
const PIECE_KEYS = Object.keys(PIECES);

// =============================================================
// Renderer / Scene / Camera
// =============================================================
const app = document.getElementById('app');

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);
renderer.domElement.style.position = 'absolute';
renderer.domElement.style.inset = '0';
renderer.domElement.style.zIndex = '2';

// CSS3D renderer for crisp HUD panels in 3D space
const cssRenderer = new CSS3DRenderer();
cssRenderer.setSize(window.innerWidth, window.innerHeight);
cssRenderer.domElement.style.position = 'absolute';
cssRenderer.domElement.style.inset = '0';
cssRenderer.domElement.style.zIndex = '3';
cssRenderer.domElement.style.pointerEvents = 'none';
app.appendChild(cssRenderer.domElement);

const scene = new THREE.Scene();
const cssScene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 200);
const DEFAULT_CAM_POS = new THREE.Vector3(14, 4, 26);
const DEFAULT_CAM_TARGET = new THREE.Vector3(0, 0, 0);
camera.position.copy(DEFAULT_CAM_POS);
camera.lookAt(DEFAULT_CAM_TARGET);

// Environment for PBR reflections
const pmrem = new THREE.PMREMGenerator(renderer);
const envScene = new RoomEnvironment();
const envTex = pmrem.fromScene(envScene, 0.04).texture;
scene.environment = envTex;

// Lighting
const hemi = new THREE.HemisphereLight(0xb0c8ff, 0x101018, 0.4);
scene.add(hemi);

const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
keyLight.position.set(8, 16, 12);
scene.add(keyLight);

const rimLight = new THREE.PointLight(0xff5a9a, 1.5, 60);
rimLight.position.set(-12, 6, -10);
scene.add(rimLight);

const fillLight = new THREE.PointLight(0x6cf0ff, 1.2, 60);
fillLight.position.set(14, -4, -8);
scene.add(fillLight);

// Floor
const floorGeo = new THREE.PlaneGeometry(120, 120);
const floorMat = new THREE.MeshStandardMaterial({
  color: 0x0a0d18,
  roughness: 0.25,
  metalness: 0.4,
  envMapIntensity: 0.6,
});
const floor = new THREE.Mesh(floorGeo, floorMat);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -PLAY_H / 2 - 0.5;
scene.add(floor);

// Subtle floor grid glow
const gridHelper = new THREE.GridHelper(80, 40, 0x1a3a5a, 0x0a1a2a);
gridHelper.position.y = -PLAY_H / 2 - 0.49;
gridHelper.material.opacity = 0.25;
gridHelper.material.transparent = true;
scene.add(gridHelper);

// =============================================================
// Orbit Controls
// =============================================================
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.copy(DEFAULT_CAM_TARGET);
controls.minDistance = 12;
controls.maxDistance = 60;
controls.maxPolarAngle = Math.PI * 0.85;
controls.minPolarAngle = Math.PI * 0.1;
controls.mouseButtons = {
  LEFT: THREE.MOUSE.ROTATE,
  MIDDLE: THREE.MOUSE.DOLLY,
  RIGHT: THREE.MOUSE.PAN,
};
controls.touches = {
  ONE: THREE.TOUCH.ROTATE,
  TWO: THREE.TOUCH.DOLLY_PAN,
};

// =============================================================
// Glass cube material factory
// =============================================================
const cubeGeometry = new THREE.BoxGeometry(CELL * 0.94, CELL * 0.94, CELL * 0.94);
// Slight bevel via edges
const edgeGeometry = new THREE.EdgesGeometry(cubeGeometry);

const materialCache = new Map();
function getCubeMaterial(color, opts = {}) {
  const key = color + ':' + (opts.ghost ? 'g' : 'n');
  if (materialCache.has(key)) return materialCache.get(key);
  const mat = new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0.0,
    roughness: 0.08,
    transmission: opts.ghost ? 0.0 : 0.85,
    thickness: 0.6,
    ior: 1.45,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    transparent: true,
    opacity: opts.ghost ? 0.18 : 0.92,
    envMapIntensity: 1.4,
    emissive: color,
    emissiveIntensity: opts.ghost ? 0.2 : 0.25,
    side: THREE.DoubleSide,
  });
  materialCache.set(key, mat);
  return mat;
}

function makeCube(color, opts = {}) {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(cubeGeometry, getCubeMaterial(color, opts));
  group.add(mesh);

  // Edge highlight
  const edgeMat = new THREE.LineBasicMaterial({
    color: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.4),
    transparent: true,
    opacity: opts.ghost ? 0.15 : 0.55,
  });
  const edges = new THREE.LineSegments(edgeGeometry, edgeMat);
  group.add(edges);

  // Inner glowing core for extra hot-spot
  if (!opts.ghost) {
    const coreGeo = new THREE.BoxGeometry(CELL * 0.45, CELL * 0.45, CELL * 0.45);
    const coreMat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    group.add(core);
  }

  group.userData.color = color;
  return group;
}

// =============================================================
// Glass case (playfield container)
// =============================================================
const caseGroup = new THREE.Group();
scene.add(caseGroup);

// Translucent shell
const shellGeo = new THREE.BoxGeometry(PLAY_W + 0.4, PLAY_H + 0.4, PLAY_D + 0.4);
const shellMat = new THREE.MeshPhysicalMaterial({
  color: 0xeaf6ff,
  metalness: 0.0,
  roughness: 0.04,
  transmission: 1.0,
  thickness: 0.2,
  ior: 1.5,
  transparent: true,
  opacity: 0.06,
  side: THREE.BackSide,
  envMapIntensity: 1.2,
});
const shell = new THREE.Mesh(shellGeo, shellMat);
caseGroup.add(shell);

// Edge frame — thin glowing wireframe around the cuboid
const frameEdges = new THREE.EdgesGeometry(shellGeo);
const frameMat = new THREE.LineBasicMaterial({
  color: 0xaee7ff,
  transparent: true,
  opacity: 0.7,
});
const frame = new THREE.LineSegments(frameEdges, frameMat);
caseGroup.add(frame);

// Top opening — remove a top "lid" by drawing an inner outline
const topRimGeo = new THREE.BoxGeometry(PLAY_W + 0.2, 0.04, PLAY_D + 0.2);
const topRimEdges = new THREE.EdgesGeometry(topRimGeo);
const topRim = new THREE.LineSegments(topRimEdges, new THREE.LineBasicMaterial({
  color: 0xffffff, transparent: true, opacity: 0.5,
}));
topRim.position.y = PLAY_H / 2 + 0.04;
caseGroup.add(topRim);

// Inner grid lines on back wall (subtle gameplay aid)
const backGridMat = new THREE.LineBasicMaterial({
  color: 0x4a8acc, transparent: true, opacity: 0.12,
});
const backGridGeo = new THREE.BufferGeometry();
const backVerts = [];
const backZ = -PLAY_D / 2 - 0.01;
for (let i = 0; i <= COLS; i++) {
  const x = -PLAY_W / 2 + i * CELL;
  backVerts.push(x, -PLAY_H / 2, backZ, x, PLAY_H / 2, backZ);
}
for (let j = 0; j <= ROWS; j++) {
  const y = -PLAY_H / 2 + j * CELL;
  backVerts.push(-PLAY_W / 2, y, backZ, PLAY_W / 2, y, backZ);
}
backGridGeo.setAttribute('position', new THREE.Float32BufferAttribute(backVerts, 3));
const backGrid = new THREE.LineSegments(backGridGeo, backGridMat);
caseGroup.add(backGrid);

// Floor inside case (where pieces land)
const innerFloorGeo = new THREE.PlaneGeometry(PLAY_W, PLAY_D);
const innerFloorMat = new THREE.MeshStandardMaterial({
  color: 0x0a1428,
  roughness: 0.2,
  metalness: 0.6,
  transparent: true,
  opacity: 0.6,
});
const innerFloor = new THREE.Mesh(innerFloorGeo, innerFloorMat);
innerFloor.rotation.x = -Math.PI / 2;
innerFloor.position.y = -PLAY_H / 2 + 0.005;
caseGroup.add(innerFloor);

// =============================================================
// Coordinate helpers — board cell -> world position
// Board origin: column 0 = left, row 0 = bottom, depth slice 0 = back
// =============================================================
function cellToWorld(c, r, d) {
  return new THREE.Vector3(
    -PLAY_W / 2 + (c + 0.5) * CELL,
    -PLAY_H / 2 + (r + 0.5) * CELL,
    -PLAY_D / 2 + (d + 0.5) * CELL,
  );
}

// =============================================================
// Game State
// =============================================================
// Board is COLS × ROWS (no depth dim — pieces always fill all depth slices).
// Cell stores piece color or null.
const board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
// Mesh registry parallel to board: meshes[r][c] = array of cube meshes (one per depth slice)
const cellMeshes = Array.from({ length: ROWS }, () => Array(COLS).fill(null));

const stackGroup = new THREE.Group();
caseGroup.add(stackGroup);

// Active piece group
const pieceGroup = new THREE.Group();
caseGroup.add(pieceGroup);
const ghostGroup = new THREE.Group();
caseGroup.add(ghostGroup);

let activePiece = null;
let nextQueue = [];
let holdPiece = null;
let canHold = true;
let score = 0;
let lines = 0;
let level = 1;
let gameOver = false;
let paused = false;

// Inertia / smooth visual offset on the active piece group
const pieceVisualOffset = new THREE.Vector3(0, 0, 0); // current offset
const pieceTargetOffset = new THREE.Vector3(0, 0, 0); // target (always 0 — settles back)
const pieceVel = new THREE.Vector3(0, 0, 0);
let pieceRotVisual = 0;
let pieceRotTarget = 0;
let pieceRotVel = 0;

// Falling timing
let fallTimer = 0;
function fallInterval() {
  // Speeds up with level
  return Math.max(0.08, 0.85 * Math.pow(0.85, level - 1));
}

// =============================================================
// Bag randomizer
// =============================================================
function refillBag() {
  const bag = [...PIECE_KEYS];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  nextQueue.push(...bag);
}
function nextPieceKey() {
  if (nextQueue.length < 4) refillBag();
  return nextQueue.shift();
}

// =============================================================
// Active Piece
// =============================================================
function spawnPiece(key) {
  const p = {
    key: key || nextPieceKey(),
    rot: 0,
    col: 3,
    row: ROWS - 2, // top
  };
  p.color = PIECE_COLORS[p.key];
  if (collides(p, p.col, p.row, p.rot)) {
    triggerGameOver();
    return;
  }
  activePiece = p;
  rebuildPieceMesh();
  rebuildGhostMesh();
  canHold = true;
  // Reset visual inertia
  pieceVisualOffset.set(0,0,0);
  pieceVel.set(0,0,0);
  pieceRotVisual = 0;
  pieceRotTarget = 0;
  pieceRotVel = 0;
  updateHUD();
}

function getPieceCells(piece, rot = piece.rot) {
  const shape = PIECES[piece.key][rot];
  const cells = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      if (shape[r][c]) {
        // shape[r][c] — r = row from top, c = col from left
        // We translate so piece.col/piece.row is bottom-left of bounding box
        // shape uses top-down rows; convert: cellRow = piece.row + (3 - r)
        cells.push({ col: piece.col + c, row: piece.row + (3 - r) });
      }
    }
  }
  return cells;
}

function collides(piece, col, row, rot) {
  const test = { ...piece, col, row, rot };
  const cells = getPieceCells(test, rot);
  for (const { col: c, row: r } of cells) {
    if (c < 0 || c >= COLS) return true;
    if (r < 0) return true;
    if (r >= ROWS + 4) continue; // allow above top
    if (r < ROWS && board[r][c]) return true;
  }
  return false;
}

function rebuildPieceMesh() {
  pieceGroup.clear();
  if (!activePiece) return;
  const cells = getPieceCells(activePiece);
  for (const { col, row } of cells) {
    for (let d = 0; d < DEPTH; d++) {
      const cube = makeCube(activePiece.color);
      cube.position.copy(cellToWorld(col, row, d));
      pieceGroup.add(cube);
    }
  }
}

function rebuildGhostMesh() {
  ghostGroup.clear();
  if (!activePiece) return;
  // Find lowest valid row
  let r = activePiece.row;
  while (!collides(activePiece, activePiece.col, r - 1, activePiece.rot)) {
    r--;
  }
  const ghost = { ...activePiece, row: r };
  const cells = getPieceCells(ghost);
  for (const { col, row } of cells) {
    for (let d = 0; d < DEPTH; d++) {
      const cube = makeCube(activePiece.color, { ghost: true });
      cube.position.copy(cellToWorld(col, row, d));
      // Make ghost a thin wireframe-y look
      cube.children.forEach(child => {
        if (child.material) child.material.transparent = true;
      });
      ghostGroup.add(cube);
    }
  }
}

// =============================================================
// Movement
// =============================================================
function tryMove(dCol, dRow) {
  if (!activePiece || gameOver || paused) return false;
  const nc = activePiece.col + dCol;
  const nr = activePiece.row + dRow;
  if (collides(activePiece, nc, nr, activePiece.rot)) return false;
  activePiece.col = nc;
  activePiece.row = nr;
  rebuildPieceMesh();
  rebuildGhostMesh();
  return true;
}

function tryRotate(dir) {
  if (!activePiece || gameOver || paused) return;
  const nrot = (activePiece.rot + (dir > 0 ? 1 : 3)) % 4;
  // Wall kick attempts
  const kicks = [0, -1, 1, -2, 2];
  for (const k of kicks) {
    if (!collides(activePiece, activePiece.col + k, activePiece.row, nrot)) {
      activePiece.col += k;
      activePiece.rot = nrot;
      // Kick visual rotation
      pieceRotTarget += dir > 0 ? Math.PI * 0.5 : -Math.PI * 0.5;
      // Actually, snap target to 0 — we just want a quick wobble
      pieceRotTarget = 0;
      pieceRotVisual = dir > 0 ? -0.45 : 0.45;
      pieceRotVel = 0;
      rebuildPieceMesh();
      rebuildGhostMesh();
      return;
    }
  }
}

function softDrop() {
  if (!tryMove(0, -1)) {
    lockPiece();
  } else {
    score += 1;
  }
}

function hardDrop() {
  if (!activePiece || gameOver || paused) return;
  let dropped = 0;
  while (tryMove(0, -1)) dropped++;
  score += dropped * 2;
  // Big downward inertia visual on settled piece
  pieceVel.y -= 8 + dropped * 0.4;
  lockPiece();
}

// =============================================================
// Locking & Line Clear
// =============================================================
function lockPiece() {
  if (!activePiece) return;
  const cells = getPieceCells(activePiece);
  for (const { col, row } of cells) {
    if (row >= ROWS) {
      triggerGameOver();
      return;
    }
    board[row][col] = activePiece.color;
    // Build mesh slices for this cell (one cube per depth slice)
    const slices = [];
    for (let d = 0; d < DEPTH; d++) {
      const cube = makeCube(activePiece.color);
      cube.position.copy(cellToWorld(col, row, d));
      stackGroup.add(cube);
      slices.push(cube);
    }
    cellMeshes[row][col] = slices;
  }
  // Settle bounce
  pieceVel.y = -1.0;

  // Find full rows
  const fullRows = [];
  for (let r = 0; r < ROWS; r++) {
    if (board[r].every(c => c !== null)) fullRows.push(r);
  }
  if (fullRows.length > 0) {
    clearLines(fullRows);
  }
  spawnPiece();
}

function clearLines(rows) {
  // Sort top-down so we can splice safely
  rows.sort((a, b) => b - a);
  // Score per Tetris standard
  const lineScore = [0, 100, 300, 500, 800][rows.length] || 800;
  score += lineScore * level;
  lines += rows.length;
  const newLevel = Math.floor(lines / 10) + 1;
  if (newLevel > level) level = newLevel;

  // Shatter effect for all cleared cells
  for (const r of rows) {
    for (let c = 0; c < COLS; c++) {
      const slices = cellMeshes[r][c];
      if (slices) {
        for (const cube of slices) {
          shatter(cube);
          stackGroup.remove(cube);
        }
        cellMeshes[r][c] = null;
      }
    }
  }
  // Big flash
  triggerFlash(rows);

  // Camera shake
  shakeIntensity = Math.min(1.0, 0.25 + rows.length * 0.18);

  // Remove rows from board, drop above rows down
  for (const r of rows) {
    board.splice(r, 1);
    cellMeshes.splice(r, 1);
    board.push(Array(COLS).fill(null));
    cellMeshes.push(Array(COLS).fill(null));
  }
  // Re-position remaining cubes
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const slices = cellMeshes[r][c];
      if (slices) {
        for (let d = 0; d < DEPTH; d++) {
          // Animate to new position
          const target = cellToWorld(c, r, d);
          animateCubeTo(slices[d], target);
        }
      }
    }
  }
  updateHUD();
}

const cubeAnims = [];
function animateCubeTo(cube, target) {
  cubeAnims.push({
    cube,
    from: cube.position.clone(),
    to: target.clone(),
    t: 0,
    dur: 0.35,
  });
}

// =============================================================
// Shatter / Particles
// =============================================================
const shards = []; // {mesh, vel, angVel, life, maxLife}
const shardGroup = new THREE.Group();
scene.add(shardGroup);

const sparkles = []; // additive points
const sparkleGroup = new THREE.Group();
scene.add(sparkleGroup);

const SHARD_GEOMS = [];
for (let i = 0; i < 6; i++) {
  // Random small tetrahedral or thin geometry to look like glass shards
  const g = new THREE.TetrahedronGeometry(0.18 + Math.random() * 0.12, 0);
  SHARD_GEOMS.push(g);
}

function shatter(cube) {
  const color = cube.userData.color;
  const center = cube.position.clone();
  // Apply caseGroup transform — but we add shards to scene not caseGroup,
  // so convert to world space.
  const world = new THREE.Vector3();
  cube.getWorldPosition(world);

  const count = 14;
  for (let i = 0; i < count; i++) {
    const geom = SHARD_GEOMS[Math.floor(Math.random() * SHARD_GEOMS.length)];
    const mat = new THREE.MeshPhysicalMaterial({
      color,
      transmission: 0.7,
      roughness: 0.1,
      metalness: 0.0,
      thickness: 0.2,
      transparent: true,
      opacity: 0.9,
      emissive: color,
      emissiveIntensity: 0.3,
      ior: 1.45,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.copy(world);
    mesh.position.x += (Math.random() - 0.5) * 0.3;
    mesh.position.y += (Math.random() - 0.5) * 0.3;
    mesh.position.z += (Math.random() - 0.5) * 0.3;
    mesh.scale.setScalar(0.7 + Math.random() * 0.7);
    shardGroup.add(mesh);

    // Velocity — outward burst, mostly horizontal
    const angle = Math.random() * Math.PI * 2;
    const speed = 4 + Math.random() * 6;
    const vy = 2 + Math.random() * 4;
    const vel = new THREE.Vector3(
      Math.cos(angle) * speed,
      vy,
      Math.sin(angle) * speed * 0.6,
    );
    const angVel = new THREE.Vector3(
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 12,
      (Math.random() - 0.5) * 12,
    );
    shards.push({
      mesh,
      vel,
      angVel,
      life: 0,
      maxLife: 1.6 + Math.random() * 0.6,
    });
  }

  // Sparkle additive points
  spawnSparkles(world, color, 8);
}

function spawnSparkles(pos, color, count) {
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i*3+0] = pos.x;
    positions[i*3+1] = pos.y;
    positions[i*3+2] = pos.z;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.3,
    color,
    transparent: true,
    opacity: 1.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    map: makeSparkleTexture(),
  });
  const points = new THREE.Points(geom, mat);
  sparkleGroup.add(points);

  const vels = [];
  for (let i = 0; i < count; i++) {
    vels.push(new THREE.Vector3(
      (Math.random() - 0.5) * 8,
      (Math.random() - 0.2) * 5,
      (Math.random() - 0.5) * 8,
    ));
  }
  sparkles.push({ points, vels, life: 0, maxLife: 1.2 });
}

let _sparkleTex = null;
function makeSparkleTexture() {
  if (_sparkleTex) return _sparkleTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32,32,0,32,32,32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.6)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0,0,64,64);
  _sparkleTex = new THREE.CanvasTexture(c);
  return _sparkleTex;
}

// Flash plane on cleared rows
const flashes = []; // {mesh, life, maxLife}
function triggerFlash(rows) {
  // Big light blast at the row positions
  for (const r of rows) {
    const y = -PLAY_H / 2 + (r + 0.5) * CELL;
    const geo = new THREE.PlaneGeometry(PLAY_W * 1.6, CELL * 1.4);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1.0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(0, y, 0);
    caseGroup.add(mesh);
    flashes.push({ mesh, life: 0, maxLife: 0.55 });

    // Add a big point light
    const light = new THREE.PointLight(0xffffff, 12, 30);
    light.position.set(0, y, 0);
    caseGroup.add(light);
    flashes.push({ light, life: 0, maxLife: 0.5, isLight: true });

    // Crossing beam plane
    const geoZ = new THREE.PlaneGeometry(PLAY_W * 1.6, CELL * 1.4);
    const matZ = new THREE.MeshBasicMaterial({
      color: 0xffd0a0,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const meshZ = new THREE.Mesh(geoZ, matZ);
    meshZ.rotation.y = Math.PI / 2;
    meshZ.position.set(0, y, 0);
    caseGroup.add(meshZ);
    flashes.push({ mesh: meshZ, life: 0, maxLife: 0.45 });
  }
}

// =============================================================
// HUD Panels — CSS3D so they look crisp, draggable in 3D
// =============================================================
function makePanelEl(html, opts={}) {
  const el = document.createElement('div');
  el.innerHTML = html;
  el.className = 'hud-panel ' + (opts.cls || '');
  el.style.cssText = `
    pointer-events: auto;
    background: linear-gradient(180deg, rgba(18,22,38,0.85), rgba(8,10,18,0.85));
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 14px;
    padding: 14px 18px;
    color: #f3f5fb;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    box-shadow:
      0 12px 48px rgba(0,0,0,0.6),
      inset 0 1px 0 rgba(255,255,255,0.06),
      0 0 0 1px rgba(108,240,255,0.05),
      0 0 36px rgba(108,240,255,0.08);
    backdrop-filter: blur(12px) saturate(140%);
    -webkit-backdrop-filter: blur(12px) saturate(140%);
    cursor: grab;
    user-select: none;
    min-width: 130px;
  `;
  return el;
}

function panelHTML(label, value, sub) {
  return `
    <div style="font-size:10px; letter-spacing:0.22em; color:#8b93ad; text-transform:uppercase; font-weight:600;">${label}</div>
    <div style="font-size:28px; font-weight:700; letter-spacing:0.02em; margin-top:4px; color:#fff; text-shadow: 0 0 18px rgba(108,240,255,0.3);">${value}</div>
    ${sub ? `<div style="font-size:11px; letter-spacing:0.16em; color:#8b93ad; text-transform:uppercase; margin-top:6px;">${sub}</div>` : ''}
  `;
}

const scoreEl = makePanelEl(panelHTML('Score', '0', 'Level 1'));
scoreEl.id = 'panel-score';
const scoreObj = new CSS3DObject(scoreEl);
scoreObj.position.set(-13, 4, 4);
scoreObj.scale.setScalar(0.025);
cssScene.add(scoreObj);

const linesEl = makePanelEl(panelHTML('Lines', '0', 'Faces cleared'));
linesEl.id = 'panel-lines';
const linesObj = new CSS3DObject(linesEl);
linesObj.position.set(13, -5, 4);
linesObj.scale.setScalar(0.025);
cssScene.add(linesObj);

// Next panel — shows mini cube preview in CSS
const nextEl = makePanelEl(`
  <div style="font-size:10px; letter-spacing:0.22em; color:#8b93ad; text-transform:uppercase; font-weight:600;">Next</div>
  <div id="next-preview" style="margin-top:8px; height:80px; width:100px; display:flex; align-items:center; justify-content:center; position:relative;"></div>
`);
nextEl.id = 'panel-next';
const nextObj = new CSS3DObject(nextEl);
nextObj.position.set(13, 5, 4);
nextObj.scale.setScalar(0.025);
cssScene.add(nextObj);

// Hold panel
const holdEl = makePanelEl(`
  <div style="font-size:10px; letter-spacing:0.22em; color:#8b93ad; text-transform:uppercase; font-weight:600;">Hold</div>
  <div id="hold-preview" style="margin-top:8px; height:80px; width:100px; display:flex; align-items:center; justify-content:center; position:relative;"></div>
`);
holdEl.id = 'panel-hold';
const holdObj = new CSS3DObject(holdEl);
holdObj.position.set(-13, -5, 4);
holdObj.scale.setScalar(0.025);
cssScene.add(holdObj);

// Make panels draggable in 3D space (project mouse onto a plane parallel to camera)
function makeDraggable(el, obj) {
  let dragging = false;
  let dragOffset = new THREE.Vector3();
  let dragPlane = new THREE.Plane();
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    dragging = true;
    el.style.cursor = 'grabbing';
    el.setPointerCapture(e.pointerId);

    // Plane perpendicular to camera, through panel position
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    dragPlane.setFromNormalAndCoplanarPoint(camDir, obj.position);

    // Compute initial intersection
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const intersect = new THREE.Vector3();
    raycaster.ray.intersectPlane(dragPlane, intersect);
    dragOffset.copy(obj.position).sub(intersect);

    // Disable orbit while dragging panel
    controls.enabled = false;
  });

  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(mouse, camera);
    const intersect = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(dragPlane, intersect)) {
      obj.position.copy(intersect).add(dragOffset);
    }
  });

  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    el.style.cursor = 'grab';
    try { el.releasePointerCapture(e.pointerId); } catch {}
    controls.enabled = true;
  }
  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', endDrag);
  el.addEventListener('lostpointercapture', endDrag);
}
makeDraggable(scoreEl, scoreObj);
makeDraggable(linesEl, linesObj);
makeDraggable(nextEl, nextObj);
makeDraggable(holdEl, holdObj);

// Render mini piece preview into a panel
function renderMiniPiece(container, key) {
  container.innerHTML = '';
  if (!key) return;
  const shape = PIECES[key][0];
  const color = PIECE_COLORS[key];
  const cellSize = 16;
  // Find bounds
  let minR=4, maxR=-1, minC=4, maxC=-1;
  for (let r=0;r<4;r++) for (let c=0;c<4;c++) {
    if (shape[r][c]) {
      if (r<minR) minR=r;
      if (r>maxR) maxR=r;
      if (c<minC) minC=c;
      if (c>maxC) maxC=c;
    }
  }
  const w = (maxC-minC+1)*cellSize;
  const h = (maxR-minR+1)*cellSize;
  const grid = document.createElement('div');
  grid.style.cssText = `
    position: relative;
    width: ${w}px;
    height: ${h}px;
    transform: rotateX(20deg) rotateY(-25deg);
    transform-style: preserve-3d;
  `;
  for (let r=minR;r<=maxR;r++) {
    for (let c=minC;c<=maxC;c++) {
      if (shape[r][c]) {
        const cell = document.createElement('div');
        const hex = '#' + color.toString(16).padStart(6,'0');
        cell.style.cssText = `
          position: absolute;
          left: ${(c-minC)*cellSize}px;
          top: ${(r-minR)*cellSize}px;
          width: ${cellSize-1}px;
          height: ${cellSize-1}px;
          background: linear-gradient(135deg, ${hex}cc, ${hex}66);
          border: 1px solid ${hex};
          border-radius: 2px;
          box-shadow:
            inset 0 0 6px rgba(255,255,255,0.4),
            inset 0 -3px 4px rgba(0,0,0,0.3),
            0 0 8px ${hex}88;
        `;
        grid.appendChild(cell);
      }
    }
  }
  container.appendChild(grid);
}

function updateHUD() {
  scoreEl.innerHTML = panelHTML('Score', score.toLocaleString(), `Level ${level}`);
  linesEl.innerHTML = panelHTML('Lines', lines, `Faces cleared`);
  // Re-bind drag (innerHTML wipes children but element reference is preserved)
  // Need to also re-render previews
  nextEl.innerHTML = `
    <div style="font-size:10px; letter-spacing:0.22em; color:#8b93ad; text-transform:uppercase; font-weight:600;">Next</div>
    <div id="next-preview" style="margin-top:8px; height:80px; width:100px; display:flex; align-items:center; justify-content:center; position:relative;"></div>
  `;
  holdEl.innerHTML = `
    <div style="font-size:10px; letter-spacing:0.22em; color:#8b93ad; text-transform:uppercase; font-weight:600;">Hold</div>
    <div id="hold-preview" style="margin-top:8px; height:80px; width:100px; display:flex; align-items:center; justify-content:center; position:relative;"></div>
  `;
  const np = nextEl.querySelector('#next-preview');
  const hp = holdEl.querySelector('#hold-preview');
  if (np && nextQueue.length > 0) renderMiniPiece(np, nextQueue[0]);
  if (hp && holdPiece) renderMiniPiece(hp, holdPiece);
}

// =============================================================
// Hold
// =============================================================
function holdActive() {
  if (!activePiece || !canHold || gameOver || paused) return;
  const cur = activePiece.key;
  if (holdPiece) {
    const swap = holdPiece;
    holdPiece = cur;
    spawnPiece(swap);
  } else {
    holdPiece = cur;
    spawnPiece();
  }
  canHold = false;
  updateHUD();
}

// =============================================================
// Game Over
// =============================================================
function triggerGameOver() {
  if (gameOver) return;
  gameOver = true;
  document.getElementById('goScore').textContent = score.toLocaleString();
  document.getElementById('goLines').textContent = lines;
  document.getElementById('goLevel').textContent = level;
  document.getElementById('gameOver').classList.add('show');
}
document.getElementById('goRestart').addEventListener('click', () => {
  // Reset
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      board[r][c] = null;
      if (cellMeshes[r][c]) {
        for (const cube of cellMeshes[r][c]) stackGroup.remove(cube);
        cellMeshes[r][c] = null;
      }
    }
  }
  stackGroup.clear();
  pieceGroup.clear();
  ghostGroup.clear();
  shardGroup.clear();
  sparkleGroup.clear();
  shards.length = 0;
  sparkles.length = 0;
  flashes.length = 0;
  cubeAnims.length = 0;
  score = 0;
  lines = 0;
  level = 1;
  gameOver = false;
  paused = false;
  activePiece = null;
  holdPiece = null;
  nextQueue = [];
  document.getElementById('gameOver').classList.remove('show');
  spawnPiece();
});

// =============================================================
// Input
// =============================================================
const keyState = { left: false, right: false, down: false };
const dasState = { left: 0, right: 0 };
const DAS = 0.16; // delay-auto-shift
const ARR = 0.045; // auto-repeat rate

window.addEventListener('keydown', (e) => {
  if (gameOver) return;
  switch (e.code) {
    case 'ArrowLeft':
      if (!keyState.left) {
        if (tryMove(-1, 0)) {
          pieceVel.x -= 4;
        }
        keyState.left = true;
        dasState.left = 0;
      }
      e.preventDefault();
      break;
    case 'ArrowRight':
      if (!keyState.right) {
        if (tryMove(1, 0)) {
          pieceVel.x += 4;
        }
        keyState.right = true;
        dasState.right = 0;
      }
      e.preventDefault();
      break;
    case 'ArrowDown':
      keyState.down = true;
      e.preventDefault();
      break;
    case 'ArrowUp':
    case 'KeyX':
      tryRotate(1);
      e.preventDefault();
      break;
    case 'KeyZ':
      tryRotate(-1);
      e.preventDefault();
      break;
    case 'Space':
      hardDrop();
      e.preventDefault();
      break;
    case 'KeyC':
    case 'ShiftLeft':
    case 'ShiftRight':
      holdActive();
      e.preventDefault();
      break;
    case 'KeyP':
      paused = !paused;
      break;
    case 'KeyR':
      resetCamera();
      break;
  }
});
window.addEventListener('keyup', (e) => {
  switch (e.code) {
    case 'ArrowLeft': keyState.left = false; break;
    case 'ArrowRight': keyState.right = false; break;
    case 'ArrowDown': keyState.down = false; break;
  }
});

function resetCamera() {
  // Tween camera back to default
  camTween.from = camera.position.clone();
  camTween.to = DEFAULT_CAM_POS.clone();
  camTween.fromTarget = controls.target.clone();
  camTween.toTarget = DEFAULT_CAM_TARGET.clone();
  camTween.t = 0;
  camTween.dur = 0.7;
  camTween.active = true;
}

const camTween = { active: false, t: 0, dur: 0.7, from:null, to:null, fromTarget:null, toTarget:null };

// =============================================================
// Camera shake
// =============================================================
let shakeIntensity = 0;
const shakeOffset = new THREE.Vector3();

// =============================================================
// Animation Loop
// =============================================================
let lastTime = performance.now();
function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  // ---- DAS / ARR for held arrows ----
  if (!gameOver && !paused && activePiece) {
    if (keyState.left) {
      dasState.left += dt;
      if (dasState.left > DAS) {
        while (dasState.left > DAS) {
          if (tryMove(-1, 0)) {
            pieceVel.x -= 1.2;
          }
          dasState.left -= ARR;
        }
      }
    }
    if (keyState.right) {
      dasState.right += dt;
      if (dasState.right > DAS) {
        while (dasState.right > DAS) {
          if (tryMove(1, 0)) {
            pieceVel.x += 1.2;
          }
          dasState.right -= ARR;
        }
      }
    }

    // Soft-drop
    if (keyState.down) {
      fallTimer += dt * 12;
    }
    fallTimer += dt;
    if (fallTimer > fallInterval()) {
      fallTimer = 0;
      if (!tryMove(0, -1)) {
        lockPiece();
      }
    }
  }

  // ---- Piece visual inertia ----
  // Spring toward 0 offset; velocity decays
  const stiffness = 60;
  const damping = 9;
  const accel = new THREE.Vector3()
    .copy(pieceVisualOffset).multiplyScalar(-stiffness)
    .add(pieceVel.clone().multiplyScalar(-damping));
  pieceVel.addScaledVector(accel, dt);
  pieceVisualOffset.addScaledVector(pieceVel, dt);

  // Rotation wobble
  pieceRotVel += (-pieceRotVisual * 80 - pieceRotVel * 9) * dt;
  pieceRotVisual += pieceRotVel * dt;

  // Scale offset down to keep within visible bounds
  const maxOff = 0.45;
  pieceVisualOffset.clampLength(-maxOff, maxOff);

  pieceGroup.position.copy(pieceVisualOffset);
  pieceGroup.rotation.z = pieceRotVisual * 0.15;

  // ---- Cube settle anims ----
  for (let i = cubeAnims.length - 1; i >= 0; i--) {
    const a = cubeAnims[i];
    a.t += dt;
    const k = Math.min(1, a.t / a.dur);
    const ease = 1 - Math.pow(1 - k, 3);
    a.cube.position.lerpVectors(a.from, a.to, ease);
    if (k >= 1) cubeAnims.splice(i, 1);
  }

  // ---- Shards ----
  const gravity = -16;
  for (let i = shards.length - 1; i >= 0; i--) {
    const s = shards[i];
    s.life += dt;
    s.vel.y += gravity * dt;
    // Air drag
    s.vel.multiplyScalar(1 - 0.6 * dt);
    s.mesh.position.addScaledVector(s.vel, dt);
    s.mesh.rotation.x += s.angVel.x * dt;
    s.mesh.rotation.y += s.angVel.y * dt;
    s.mesh.rotation.z += s.angVel.z * dt;
    // Floor bounce
    const floorY = -PLAY_H / 2 - 0.45;
    if (s.mesh.position.y < floorY) {
      s.mesh.position.y = floorY;
      s.vel.y *= -0.35;
      s.vel.x *= 0.6;
      s.vel.z *= 0.6;
    }
    if (s.life > s.maxLife - 0.4) {
      const fade = (s.maxLife - s.life) / 0.4;
      s.mesh.material.opacity = Math.max(0, 0.9 * fade);
    }
    if (s.life >= s.maxLife) {
      shardGroup.remove(s.mesh);
      s.mesh.material.dispose();
      shards.splice(i, 1);
    }
  }

  // ---- Sparkles ----
  for (let i = sparkles.length - 1; i >= 0; i--) {
    const s = sparkles[i];
    s.life += dt;
    const positions = s.points.geometry.attributes.position.array;
    const N = s.vels.length;
    for (let j = 0; j < N; j++) {
      s.vels[j].y += gravity * 0.4 * dt;
      s.vels[j].multiplyScalar(1 - 0.8 * dt);
      positions[j*3+0] += s.vels[j].x * dt;
      positions[j*3+1] += s.vels[j].y * dt;
      positions[j*3+2] += s.vels[j].z * dt;
    }
    s.points.geometry.attributes.position.needsUpdate = true;
    s.points.material.opacity = Math.max(0, 1.0 - s.life / s.maxLife);
    if (s.life >= s.maxLife) {
      sparkleGroup.remove(s.points);
      s.points.geometry.dispose();
      s.points.material.dispose();
      sparkles.splice(i, 1);
    }
  }

  // ---- Flashes ----
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i];
    f.life += dt;
    const k = f.life / f.maxLife;
    if (f.isLight) {
      f.light.intensity = 12 * (1 - k);
      if (k >= 1) {
        caseGroup.remove(f.light);
        flashes.splice(i, 1);
      }
    } else {
      f.mesh.material.opacity = Math.max(0, 1 - k);
      f.mesh.scale.x = 1 + k * 0.5;
      f.mesh.scale.y = 1 + k * 3;
      if (k >= 1) {
        caseGroup.remove(f.mesh);
        f.mesh.material.dispose();
        flashes.splice(i, 1);
      }
    }
  }

  // ---- Camera shake ----
  if (shakeIntensity > 0.001) {
    shakeOffset.set(
      (Math.random() - 0.5) * shakeIntensity,
      (Math.random() - 0.5) * shakeIntensity,
      (Math.random() - 0.5) * shakeIntensity * 0.5,
    );
    shakeIntensity *= Math.pow(0.001, dt);
  } else {
    shakeOffset.set(0,0,0);
  }

  // ---- Camera tween ----
  if (camTween.active) {
    camTween.t += dt;
    const k = Math.min(1, camTween.t / camTween.dur);
    const ease = 1 - Math.pow(1 - k, 3);
    camera.position.lerpVectors(camTween.from, camTween.to, ease);
    controls.target.lerpVectors(camTween.fromTarget, camTween.toTarget, ease);
    if (k >= 1) camTween.active = false;
  }

  controls.update();

  // Apply shake
  camera.position.add(shakeOffset);
  renderer.render(scene, camera);
  cssRenderer.render(cssScene, camera);
  // Remove shake so it doesn't accumulate
  camera.position.sub(shakeOffset);
}
animate();

// =============================================================
// Resize
// =============================================================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  cssRenderer.setSize(window.innerWidth, window.innerHeight);
});

// =============================================================
// Help toggle
// =============================================================
const helpEl = document.getElementById('help');
const helpToggle = document.getElementById('helpToggle');
helpToggle.addEventListener('click', () => {
  helpEl.classList.toggle('hidden');
});

// =============================================================
// Boot
// =============================================================
spawnPiece();
updateHUD();
