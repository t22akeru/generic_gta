import * as THREE from 'three';
import { ROAD, BLOCK, CELL, GRID, WORLD, SIDEWALK_W, SIDEWALK_H, ROAD_Y } from './config.js?v=20260508-5';
import { tex, matStd, matTex, buildingMats } from './textures.js?v=20260508-5';
import { addBox } from './physics.js?v=20260508-5';
import { state } from './config.js?v=20260508-5';

const RAIL_ROAD_I = 4;
const RAIL_MEDIAN_W = 3.5;
const RAIL_EXT_W = RAIL_MEDIAN_W / 2;

function isRailRoadColumn(i) {
  return i === RAIL_ROAD_I;
}

function verticalRoadStart(i) {
  return i * CELL - (isRailRoadColumn(i) ? RAIL_EXT_W : 0);
}

function verticalRoadWidth(i) {
  return ROAD + (isRailRoadColumn(i) ? RAIL_MEDIAN_W : 0);
}

function westCarriageCenterX(i) {
  return i * CELL + ROAD / 4 - (isRailRoadColumn(i) ? RAIL_MEDIAN_W / 2 : 0);
}

function eastCarriageCenterX(i) {
  return i * CELL + ROAD * 3 / 4 + (isRailRoadColumn(i) ? RAIL_MEDIAN_W / 2 : 0);
}

function blockInsetWest(blockI) {
  return blockI === RAIL_ROAD_I ? RAIL_EXT_W : 0;
}

function blockInsetEast(blockI) {
  return blockI === RAIL_ROAD_I - 1 ? RAIL_EXT_W : 0;
}

// ── Road position check ───────────────────────────────────────────────────────
function isRoadPos(x, z) {
  const fracX = ((x % CELL) + CELL) % CELL;
  const fracZ = ((z % CELL) + CELL) % CELL;
  const railX1 = verticalRoadStart(RAIL_ROAD_I);
  const railX2 = railX1 + verticalRoadWidth(RAIL_ROAD_I);
  return fracX < ROAD || fracZ < ROAD || (x >= railX1 && x <= railX2);
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function mesh(geo, mat) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function box(w, h, d) { return new THREE.BoxGeometry(w, h, d); }

function baseMountainHeight(tx, tz, cw) {
  const wEx = Math.max(0, -tx);
  const nEx = Math.max(0, -tz);
  const eEx = Math.max(0, tx - cw);
  const sEx = Math.max(0, tz - cw);
  const mEx = wEx + nEx;
  const oEx = eEx + sEx;
  const oceanBlend = oEx / (mEx + oEx || 1);
  // 北・西側の山は12m後退させ、車道へ食い込まないようにする
  const nExAdj = Math.max(0, nEx - 12);
  const wExAdj = Math.max(0, wEx - 12);
  const mountainDist = Math.hypot(wExAdj, nExAdj);
  const hillStart = 1.5;
  const rise = Math.max(0, mountainDist - hillStart);
  const noise = Math.sin(tx * 0.038 + 1.1) * Math.cos(tz * 0.032) * 7
              + Math.sin(tx * 0.021 + 2.4) * Math.cos(tz * 0.024) * 14;
  const mountainY = ROAD_Y + Math.min(44, rise) + noise * Math.min(1, rise / 25);
  return { mountainY, oceanBlend };
}

function applyTunnelCutoutToTerrainMaterial(mat) {
  const trackX = RAIL_ROAD_I * CELL + ROAD / 2;
  const portalZ = -14.0;
  const halfW = 3.1;
  const topY = 9.2;
  const depth = 200.0;

  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWorldPos;`
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
vWorldPos = worldPosition.xyz;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec3 vWorldPos;`
      )
      .replace(
        '#include <alphamap_fragment>',
        `#include <alphamap_fragment>
if (vWorldPos.z < ${portalZ.toFixed(1)} - 0.6 && vWorldPos.z > ${portalZ.toFixed(1)} - ${depth.toFixed(1)} &&
    abs(vWorldPos.x - ${trackX.toFixed(3)}) < ${halfW.toFixed(1)} &&
    vWorldPos.y < ${topY.toFixed(1)}) {
  discard;
}`
      );
  };
  mat.customProgramCacheKey = () => 'terrain-tunnel-cutout-v1';
  mat.needsUpdate = true;
}

// ── Road graph ───────────────────────────────────────────────────────────────
export function buildRoadGraph() {
  // Nodes at every intersection: (i*CELL+ROAD/2, _, j*CELL+ROAD/2)
  const N = GRID + 1; // 6 nodes per axis
  for (let j = 0; j <= GRID; j++) {
    for (let i = 0; i <= GRID; i++) {
      const idx = j * N + i;
      state.roadNodes.push({ x: i * CELL + ROAD / 2, z: j * CELL + ROAD / 2, idx });
      state.roadAdj[idx] = [];
    }
  }
  // Connect horizontal
  for (let j = 0; j <= GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const a = j * N + i, b = j * N + (i + 1);
      state.roadAdj[a].push(b);
      state.roadAdj[b].push(a);
    }
  }
  // Connect vertical
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i <= GRID; i++) {
      const a = j * N + i, b = (j + 1) * N + i;
      state.roadAdj[a].push(b);
      state.roadAdj[b].push(a);
    }
  }
}

// ── Tree factory ─────────────────────────────────────────────────────────────
function makeTree(scene, x, z) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);

  // Trunk
  const trunk = mesh(
    new THREE.CylinderGeometry(0.18, 0.25, 2.5, 7),
    matTex(tex.bark)
  );
  trunk.position.y = 1.25;
  group.add(trunk);

  // Foliage blobs
  const leafMat = matTex(tex.leaves, { color: 0x2d7a1a });
  const offsets = [[0, 3.8, 0], [-0.6, 3.0, 0.5], [0.7, 2.8, -0.4], [0, 2.3, 0.6]];
  for (const [ox, oy, oz] of offsets) {
    const r = 0.8 + Math.random() * 0.6;
    const blob = mesh(new THREE.SphereGeometry(r, 7, 6), leafMat);
    blob.position.set(ox, oy, oz);
    group.add(blob);
  }

  scene.add(group);
  // Collision: trunk only
  addBox(x - 0.3, z - 0.3, x + 0.3, z + 0.3, 0, 3);
}

// ── Bench ────────────────────────────────────────────────────────────────────
function makeBench(scene, x, z, ry = 0) {
  const g = new THREE.Group();
  g.position.set(x, SIDEWALK_H, z);
  g.rotation.y = ry;

  const woodMat = matTex(tex.wood, { color: 0xc8a060 });
  const metalMat = matStd(0x444444, { roughness: 0.5, metalness: 0.7 });

  // Seat slats
  for (let i = -1; i <= 1; i++) {
    const s = mesh(box(1.5, 0.05, 0.22), woodMat);
    s.position.set(0, 0.44, i * 0.14);
    g.add(s);
  }
  // Back slats
  for (let i = -1; i <= 1; i++) {
    const s = mesh(box(1.5, 0.05, 0.18), woodMat);
    s.position.set(0, 0.75, -0.28 + i * 0.12);
    s.rotation.x = -0.3;
    g.add(s);
  }
  // Legs
  for (const lx of [-0.6, 0.6]) {
    const leg = mesh(box(0.06, 0.44, 0.55), metalMat);
    leg.position.set(lx, 0.22, 0);
    g.add(leg);
  }

  scene.add(g);
  addBox(x - 0.8, z - 0.4, x + 0.8, z + 0.4, 0, 1.0);
}

// ── Street light ─────────────────────────────────────────────────────────────
function makeStreetLight(scene, x, z, ry = 0) {
  const g = new THREE.Group();
  g.position.set(x, SIDEWALK_H, z);
  g.rotation.y = ry;

  const poleMat = matStd(0x555566, { roughness: 0.6, metalness: 0.7 });

  // Pole
  const pole = mesh(new THREE.CylinderGeometry(0.06, 0.09, 5.5, 8), poleMat);
  pole.position.y = 2.75;
  g.add(pole);

  // Arm
  const arm = mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.4, 6), poleMat);
  arm.position.set(0.65, 5.4, 0);
  arm.rotation.z = Math.PI / 2;
  g.add(arm);

  // Lamp head
  const lamp = mesh(new THREE.CylinderGeometry(0.18, 0.14, 0.34, 8), matStd(0xfff1b8, { emissive: 0xffdd99, emissiveIntensity: 1.4 }));
  lamp.position.set(1.2, 5.25, 0);
  g.add(lamp);

  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 8, 8),
    new THREE.MeshStandardMaterial({
      color: 0xfff3ba,
      emissive: 0xffe6a8,
      emissiveIntensity: 4.0,
      transparent: true,
      opacity: 0.9,
    })
  );
  halo.position.set(1.2, 5.15, 0);
  g.add(halo);

  // Point light (stronger at night via main.js)
  const light = new THREE.PointLight(0xfff5cc, 2.2, 28);
  light.position.set(1.2, 5.1, 0);
  g.add(light);

  scene.add(g);
  addBox(x - 0.15, z - 0.15, x + 0.15, z + 0.15, 0, 6);
}

// ── Bus stop ──────────────────────────────────────────────────────────────────
function makeBusStop(scene, x, z, ry = 0) {
  const g = new THREE.Group();
  g.position.set(x, SIDEWALK_H, z);
  g.rotation.y = ry;

  const frameMat = matStd(0x336699, { roughness: 0.4, metalness: 0.5 });
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0xaaddff, transparent: true, opacity: 0.4, roughness: 0.05 });

  // Frame posts
  for (const px of [-1.0, 1.0]) {
    const p = mesh(box(0.07, 2.8, 0.07), frameMat);
    p.position.set(px, 1.4, 0);
    g.add(p);
  }
  // Roof
  const roof = mesh(box(2.3, 0.1, 1.1), frameMat);
  roof.position.set(0, 2.85, 0);
  g.add(roof);
  // Glass panels
  const gp = mesh(box(2.0, 2.4, 0.06), glassMat);
  gp.position.set(0, 1.2, -0.5);
  g.add(gp);

  scene.add(g);
  addBox(x - 1.1, z - 0.6, x + 1.1, z + 0.6, 0, 3.0);
}

// ── Fire hydrant ──────────────────────────────────────────────────────────────
function makeHydrant(scene, x, z) {
  const g = new THREE.Group();
  g.position.set(x, SIDEWALK_H, z);

  const mat = matStd(0xcc2222, { roughness: 0.4, metalness: 0.3 });
  const body = mesh(new THREE.CylinderGeometry(0.13, 0.17, 0.6, 8), mat);
  body.position.y = 0.3;
  g.add(body);
  const top = mesh(new THREE.SphereGeometry(0.14, 8, 6), mat);
  top.position.y = 0.65;
  g.add(top);
  for (const rx of [-0.2, 0.2]) {
    const nub = mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.1, 6), matStd(0x222222));
    nub.rotation.z = Math.PI / 2;
    nub.position.set(rx, 0.38, 0);
    g.add(nub);
  }

  scene.add(g);
  addBox(x - 0.2, z - 0.2, x + 0.2, z + 0.2, 0, 0.8);
}

// ── Trash can ────────────────────────────────────────────────────────────────
function makeTrashCan(scene, x, z) {
  const g = new THREE.Group();
  g.position.set(x, SIDEWALK_H, z);
  const mat = matStd(0x2a2a2a, { roughness: 0.8 });
  const body = mesh(new THREE.CylinderGeometry(0.2, 0.17, 0.9, 8), mat);
  body.position.y = 0.45;
  g.add(body);
  scene.add(g);
  addBox(x - 0.22, z - 0.22, x + 0.22, z + 0.22, 0, 1.0);
}

// ── Building factory ─────────────────────────────────────────────────────────
function makeBuilding(scene, bx, bz, bw, bd, bh, matType) {
  // Clamp building to stay strictly within its block — never protrude into roads or sidewalks
  const blockI = Math.floor(bx / CELL);
  const blockOriginX = blockI * CELL + ROAD;
  const blockOriginZ = Math.floor(bz / CELL) * CELL + ROAD;
  const minX = blockOriginX + SIDEWALK_W + blockInsetWest(blockI);
  const minZ = blockOriginZ + SIDEWALK_W;
  const maxX = blockOriginX + BLOCK - SIDEWALK_W - blockInsetEast(blockI);
  const maxZ = blockOriginZ + BLOCK - SIDEWALK_W;
  // Clamp start (near-side road edge)
  if (bx < minX) { bw -= (minX - bx); bx = minX; }
  if (bz < minZ) { bd -= (minZ - bz); bz = minZ; }
  // Clamp end (far-side road edge)
  bw = Math.min(bw, maxX - bx);
  bd = Math.min(bd, maxZ - bz);
  if (bw <= 0 || bd <= 0) return;

  const mats = buildingMats[matType]();
  if (mats[3] === null) mats[3] = matStd(0x888888);

  // Slight height variation per position to avoid identical twins
  const hVar = ((Math.floor(bx)*13 + Math.floor(bz)*7) % 5) * 1.5;
  bh = bh + hVar;

  const geo = box(bw, bh, bd);
  const m = mesh(geo, mats);
  m.position.set(bx + bw / 2, bh / 2, bz + bd / 2);
  scene.add(m);
  addBox(bx, bz, bx + bw, bz + bd, 0, bh);

  // Window rows on front and back faces
  const winMat = new THREE.MeshStandardMaterial({ color: 0xaaddff, roughness: 0.05, metalness: 0.1, emissive: 0x6a8bb0, emissiveIntensity: 0.75 });
  const winW = 0.7, winH = 0.55, winD = 0.05;
  const floors = Math.max(1, Math.floor(bh / 3) - 1);
  const cols   = Math.max(1, Math.floor(bw / 2.2));
  for (let fl = 1; fl <= floors; fl++) {
    for (let col = 0; col < cols; col++) {
      const wx = bx + (col + 0.5) * (bw / cols);
      const wy = fl * (bh / (floors + 1));
      // Front face (−Z)
      const wf = mesh(box(winW, winH, winD), winMat);
      wf.position.set(wx, wy, bz + 0.06);
      scene.add(wf);
      // Back face (+Z)
      const wb = mesh(box(winW, winH, winD), winMat);
      wb.position.set(wx, wy, bz + bd - 0.06);
      scene.add(wb);
    }
  }
  // Side windows
  const colsZ = Math.max(1, Math.floor(bd / 2.2));
  for (let fl = 1; fl <= floors; fl++) {
    for (let col = 0; col < colsZ; col++) {
      const wz = bz + (col + 0.5) * (bd / colsZ);
      const wy = fl * (bh / (floors + 1));
      const wl = mesh(box(winD, winH, winW), winMat);
      wl.position.set(bx + 0.06, wy, wz);
      scene.add(wl);
      const wr = mesh(box(winD, winH, winW), winMat);
      wr.position.set(bx + bw - 0.06, wy, wz);
      scene.add(wr);
    }
  }

  // Entrance (dark doorframe on south face)
  const doorMat = matStd(0x222222, { roughness: 0.8 });
  const door = mesh(box(Math.min(2.0, bw * 0.25), 2.5, 0.15), doorMat);
  door.position.set(bx + bw / 2, 1.25, bz + 0.08);
  scene.add(door);

  // Rooftop detail
  if (bh > 8) {
    const roof = mesh(box(bw * 0.55, 1.0, bd * 0.55), matStd(0x444455, { roughness: 0.7 }));
    roof.position.set(bx + bw / 2, bh + 0.5, bz + bd / 2);
    scene.add(roof);
    // Antenna
    const ant = mesh(new THREE.CylinderGeometry(0.04, 0.04, 3.5, 4), matStd(0x666666, { metalness: 0.8 }));
    ant.position.set(bx + bw / 2, bh + 2.25, bz + bd / 2);
    scene.add(ant);
  }
}

// ── Block builders ────────────────────────────────────────────────────────────
// Each block occupies a BLOCK×BLOCK area starting at (bx, bz)
function blockType0(scene, bx, bz) { // Tall office cluster
  const sw = SIDEWALK_W;
  const inner = BLOCK - sw * 2;
  // Main tower
  makeBuilding(scene, bx + sw, bz + sw, inner * 0.55, inner * 0.55, 22, 1);
  // Side wing
  makeBuilding(scene, bx + sw + inner * 0.6, bz + sw, inner * 0.38, inner, 14, 2);
  // Low annex
  makeBuilding(scene, bx + sw, bz + sw + inner * 0.6, inner * 0.55, inner * 0.38, 7, 0);
}

function blockType1(scene, bx, bz) { // Brick rowhouses
  const sw = SIDEWALK_W;
  const inner = BLOCK - sw * 2;
  const n = 3;
  const uw = inner / n;
  for (let i = 0; i < n; i++) {
    const h = 6 + Math.floor(Math.random() * 3) * 2;
    makeBuilding(scene, bx + sw + i * uw, bz + sw, uw - 0.5, inner, h, 0);
  }
}

function blockType2(scene, bx, bz) { // Mixed commercial
  const sw = SIDEWALK_W;
  const inner = BLOCK - sw * 2;
  makeBuilding(scene, bx + sw, bz + sw, inner * 0.6, inner * 0.5, 12, 6);
  makeBuilding(scene, bx + sw, bz + sw + inner * 0.55, inner * 0.6, inner * 0.43, 5, 0);
  makeBuilding(scene, bx + sw + inner * 0.65, bz + sw, inner * 0.33, inner, 9, 3);
}

function blockType3(scene, bx, bz) { // Industrial + park
  const sw = SIDEWALK_W;
  const inner = BLOCK - sw * 2;
  makeBuilding(scene, bx + sw, bz + sw, inner * 0.65, inner * 0.65, 8, 4);
  // Trees in the remaining corner
  const tx = bx + sw + inner * 0.72, tz = bz + sw + inner * 0.72;
  if (tx + 2 < bx + BLOCK - sw && tz + 2 < bz + BLOCK - sw) {
    makeTree(scene, tx, tz);
    makeTree(scene, tx + 3, tz + 2);
  }
  makeBuilding(scene, bx + sw, bz + sw + inner * 0.72, inner * 0.65, inner * 0.26, 6, 4);
}

function blockType4(scene, bx, bz) { // Luxury complex
  const sw = SIDEWALK_W;
  const inner = BLOCK - sw * 2;
  makeBuilding(scene, bx + sw, bz + sw, inner * 0.48, inner * 0.48, 18, 3);
  makeBuilding(scene, bx + sw + inner * 0.52, bz + sw, inner * 0.46, inner * 0.48, 14, 1);
  makeBuilding(scene, bx + sw, bz + sw + inner * 0.52, inner, inner * 0.46, 6, 3);
}

function blockType5(scene, bx, bz) { // Park / open space
  const sw = SIDEWALK_W;
  const inner = BLOCK - sw * 2;
  // Park ground
  const parkMat = matTex(tex.grass, { color: 0x4a8a30 });
  const parkGeo = new THREE.BoxGeometry(inner, 0.12, inner);
  const park = mesh(parkGeo, parkMat);
  park.position.set(bx + sw + inner / 2, SIDEWALK_H + 0.06, bz + sw + inner / 2);
  scene.add(park);
  // Trees
  for (let i = 0; i < 5; i++) {
    const tx = bx + sw + 2 + Math.random() * (inner - 4);
    const tz = bz + sw + 2 + Math.random() * (inner - 4);
    makeTree(scene, tx, tz);
  }
  // Benches
  makeBench(scene, bx + sw + inner * 0.25, bz + sw + inner * 0.5);
  makeBench(scene, bx + sw + inner * 0.75, bz + sw + inner * 0.5);
}

function blockType6(scene, bx, bz) { // Warehouse district
  const sw = SIDEWALK_W;
  const inner = BLOCK - sw * 2;
  makeBuilding(scene, bx + sw, bz + sw, inner, inner * 0.45, 7, 4);
  makeBuilding(scene, bx + sw, bz + sw + inner * 0.52, inner * 0.45, inner * 0.46, 10, 2);
  makeBuilding(scene, bx + sw + inner * 0.52, bz + sw + inner * 0.52, inner * 0.46, inner * 0.46, 5, 4);
}

const blockBuilders = [blockType0, blockType1, blockType2, blockType3, blockType4, blockType5, blockType6];

// ── Street furniture placement along sidewalks ────────────────────────────────
function placeFurniture(scene, bx, bz, side) {
  // side: 'n','s','e','w'
  const sw = SIDEWALK_W;
  let fx, fz, ry = 0;
  const offset = sw / 2;
  const rng = Math.random;
  const blockI = Math.floor((bx - ROAD) / CELL);
  const westInset = blockInsetWest(blockI);
  const eastInset = blockInsetEast(blockI);

  if (side === 'n') { fx = bx + BLOCK / 2; fz = bz + offset; ry = 0; }
  else if (side === 's') { fx = bx + BLOCK / 2; fz = bz + BLOCK - offset; ry = Math.PI; }
  else if (side === 'e') { fx = bx + BLOCK - offset - eastInset; fz = bz + BLOCK / 2; ry = Math.PI / 2; }
  else { fx = bx + offset + westInset; fz = bz + BLOCK / 2; ry = -Math.PI / 2; }

  const r = rng();
  if (r < 0.35) makeStreetLight(scene, fx, fz, ry);
  else if (r < 0.55) makeBench(scene, fx, fz, ry);
  else if (r < 0.68) makeBusStop(scene, fx, fz, ry);
  else if (r < 0.78) makeHydrant(scene, fx, fz);
  else if (r < 0.86) makeTrashCan(scene, fx, fz);
  // otherwise nothing
}

// ── Lane markings ─────────────────────────────────────────────────────────────
function makeLaneMarkings(scene) {
  const dashMat = matStd(0xffffff, { roughness: 1 });
  const centerMat = matStd(0xffee00, { roughness: 1 });

  for (let i = 0; i <= GRID; i++) {
    const rx = i * CELL; // start of vertical road
    const rz = i * CELL; // start of horizontal road

    // Vertical road center line
    for (let j = 0; j < GRID; j++) {
      if (i === RAIL_ROAD_I) continue; // 線路道路は train.js 側で個別描画
      const segZ = j * CELL + ROAD;
      const segLen = BLOCK;
      // Yellow center line — skip crosswalk zone (first 8m of block)
      const lineSkip = 8;
      const lineLen = segLen - lineSkip;
      const lineW = ROAD * 0.007;
      const cl = mesh(new THREE.BoxGeometry(lineW, 0.02, lineLen), centerMat);
      cl.position.set(rx + ROAD / 2, ROAD_Y + 0.01, segZ + lineSkip + lineLen / 2);
      scene.add(cl);
      // White lane-center dashes — one per direction lane (at ROAD/4 and ROAD*3/4)
      const dashW = ROAD * 0.006;
      for (let d = 0; d < segLen; d += 4) {
        if (d < 8) continue;           // crosswalk zone skip
        if (d >= segLen - 4) continue; // 末尾1本スキップ（停止線と重なる）
        const dl = mesh(new THREE.BoxGeometry(dashW, 0.02, 1.8), dashMat);
        dl.position.set(rx + ROAD / 4, ROAD_Y + 0.01, segZ + d + 2);
        scene.add(dl);
        const dr = mesh(new THREE.BoxGeometry(dashW, 0.02, 1.8), dashMat);
        dr.position.set(rx + ROAD * 3 / 4, ROAD_Y + 0.01, segZ + d + 2);
        scene.add(dr);
      }
    }

    // Horizontal road center line
    for (let j = 0; j < GRID; j++) {
      const segX = j * CELL + ROAD;
      const segLen = BLOCK;
      // Skip crosswalk zone (first 8m of block)
      const lineSkip = 8;
      const lineLen = segLen - lineSkip;
      const lineW = ROAD * 0.007;
      const cl = mesh(new THREE.BoxGeometry(lineLen, 0.02, lineW), centerMat);
      cl.position.set(segX + lineSkip + lineLen / 2, ROAD_Y + 0.01, rz + ROAD / 2);
      scene.add(cl);
      // White lane-center dashes for horizontal road
      const dashW = ROAD * 0.006;
      for (let d = 0; d < segLen; d += 4) {
        if (d < 8) continue;           // crosswalk zone skip
        if (d >= segLen - 4) continue; // 末尾1本スキップ（停止線と重なる）
        const du = mesh(new THREE.BoxGeometry(1.8, 0.02, dashW), dashMat);
        du.position.set(segX + d + 2, ROAD_Y + 0.01, rz + ROAD / 4);
        scene.add(du);
        const dd = mesh(new THREE.BoxGeometry(1.8, 0.02, dashW), dashMat);
        dd.position.set(segX + d + 2, ROAD_Y + 0.01, rz + ROAD * 3 / 4);
        scene.add(dd);
      }
    }
  }
}

// ── Crosswalks ────────────────────────────────────────────────────────────────
// Zebra stripes: each stripe runs PARALLEL to the road it's on.
// For N-S road (x ∈ [ix, ix+ROAD]): pedestrians walk E-W, stripes run N-S
//   → stripe long in Z (ROAD*0.75), narrow in X (0.45), step in X direction.
// For E-W road (z ∈ [iz, iz+ROAD]): pedestrians walk N-S, stripes run E-W
//   → stripe long in X (ROAD*0.75), narrow in Z (0.45), step in Z direction.
function makeCrosswalks(scene) {
  const mat = matStd(0xeeeeee, { roughness: 0.9 });
  const stripeW = 0.44;          // 縞の幅
  const step    = 1.6;           // 縞の中心間距離（固定）→ 間隔 step-stripeW ≈ 1.16m
  const baseNStripes = Math.min(14, Math.floor((ROAD - stripeW) / step) + 1);
  const baseTotalW  = (baseNStripes - 1) * step + stripeW;
  const baseStartOff = (ROAD - baseTotalW) / 2;
  const stripeL = ROAD * 0.20;   // 縞の奥行き（短め）

  for (let j = 0; j <= GRID; j++) {
    for (let i = 0; i <= GRID; i++) {
      const ix = i * CELL, iz = j * CELL;
      const roadW = verticalRoadWidth(i);
      const roadX = verticalRoadStart(i);
      const nStripesNS = Math.min(14, Math.floor((roadW - stripeW) / step) + 1);
      const totalWNS  = (nStripesNS - 1) * step + stripeW;
      const startOffNS = (roadW - totalWNS) / 2;

      // South side: N-S road crosswalk. Stripes long in Z, step in X.
      if (j < GRID) {
        for (let s = 0; s < nStripesNS; s++) {
          const cw = mesh(new THREE.BoxGeometry(stripeW, 0.025, stripeL), mat);
          cw.position.set(roadX + startOffNS + s * step, ROAD_Y + 0.007, iz + ROAD + 4.0);
          scene.add(cw);
        }
      }

      // East side: E-W road crosswalk. Stripes long in X, step in Z.
      if (i < GRID) {
        const eastCrossX = ix + ROAD + 4.0 + (isRailRoadColumn(i) ? RAIL_EXT_W : 0);
        for (let s = 0; s < baseNStripes; s++) {
          const cw = mesh(new THREE.BoxGeometry(stripeL, 0.025, stripeW), mat);
          cw.position.set(eastCrossX, ROAD_Y + 0.007, iz + baseStartOff + s * step);
          scene.add(cw);
        }
      }
    }
  }
}

// ── Stop lines ────────────────────────────────────────────────────────────────
// 左側通行: 各進行方向の左車線のみに停止線を引く
// 南/東アプローチ: 横断歩道の手前(stripeL/2 + 0.6m 先)に配置
// 北/西アプローチ: 交差点端の 1.5m 手前に配置
function makeStopLines(scene) {
  const mat = matStd(0xffffff, { roughness: 1 });
  const T = 0.025, W = 0.35;
  const H = ROAD_Y + 0.013;  // レーンマーキング(+0.01)より高く Z ファイト回避
  // 横断歩道中心は iz+ROAD+4.0、halved stripeL=ROAD*0.375 → 端 iz+ROAD+4+ROAD*0.1875
  // 停止線: 端 + 0.625m 先 → iz + ROAD + 4 + ROAD*0.1875 + 0.625 ≈ iz + ROAD + 6.5
  const stripeL_cw = ROAD * 0.20;
  const CW_STOP = ROAD + 4.0 + stripeL_cw / 2 + 0.625; // 横断歩道南/東端+0.625m
  const NO_CW   = -1.5;         // 横断歩道なし側（北/西）の停止線オフセット

  for (let j = 0; j <= GRID; j++) {
    for (let i = 0; i <= GRID; i++) {
      const ix = i * CELL, iz = j * CELL;
      const westCenterX = westCarriageCenterX(i);
      const eastCenterX = eastCarriageCenterX(i);

      // N-S 道路の停止線
      if (j > 0) {
        // 北アプローチ（南向き車=東半レーン, 左側通行）
        const sl = mesh(new THREE.BoxGeometry(ROAD / 2, T, W), mat);
        sl.position.set(eastCenterX, H, iz + NO_CW);
        scene.add(sl);
      }
      if (j < GRID) {
        // 南アプローチ（北向き車=西半レーン, 横断歩道手前）
        const sl = mesh(new THREE.BoxGeometry(ROAD / 2, T, W), mat);
        sl.position.set(westCenterX, H, iz + CW_STOP);
        scene.add(sl);
      }

      // E-W 道路の停止線
      if (i > 0) {
        // 西アプローチ（東向き車=北半レーン）
        const sl = mesh(new THREE.BoxGeometry(W, T, ROAD / 2), mat);
        sl.position.set(ix + NO_CW - (isRailRoadColumn(i) ? RAIL_EXT_W : 0), H, iz + ROAD / 4);
        scene.add(sl);
      }
      if (i < GRID) {
        // 東アプローチ（西向き車=南半レーン, 横断歩道手前）
        const sl = mesh(new THREE.BoxGeometry(W, T, ROAD / 2), mat);
        sl.position.set(ix + CW_STOP + (isRailRoadColumn(i) ? RAIL_EXT_W : 0), H, iz + ROAD * 3 / 4);
        scene.add(sl);
      }
    }
  }
}

// ── Traffic lights ────────────────────────────────────────────────────────────
// 4 independent signal groups:
//   _carNS / _carEW : car signals for N-S and E-W roads (opposite phases)
//   _pedNS / _pedEW : ped signals crossing N-S / E-W road (inverted from car)
const _carNS = [], _carEW = [], _pedNS = [], _pedEW = [];
let _tlTimer = 0;

const TL_STAGES = [
  {
    t: 10.0,
    ns: { r: 0.03, y: 0.03, g: 2.5 },
    ew: { r: 2.5,  y: 0.03, g: 0.03 },
    pedNS: { r: 2.5,  y: 0.03, g: 0.03 },
    pedEW: { r: 0.03, y: 0.03, g: 2.5  },
  },
  {
    t: 1.5,
    ns: { r: 0.03, y: 2.5,  g: 0.03 },
    ew: { r: 2.5,  y: 0.03, g: 0.03 },
    pedNS: { r: 2.5,  y: 0.03, g: 0.03 },
    pedEW: { r: 0.03, y: 0.03, g: 2.5  },
  },
  {
    t: 0.8,
    ns: { r: 2.5,  y: 0.03, g: 0.03 },
    ew: { r: 2.5,  y: 0.03, g: 0.03 },
    pedNS: { r: 2.5,  y: 0.03, g: 0.03 },
    pedEW: { r: 2.5,  y: 0.03, g: 0.03 },
  },
  {
    t: 10.0,
    ns: { r: 2.5,  y: 0.03, g: 0.03 },
    ew: { r: 0.03, y: 0.03, g: 2.5  },
    pedNS: { r: 0.03, y: 0.03, g: 2.5  },
    pedEW: { r: 2.5,  y: 0.03, g: 0.03 },
  },
  {
    t: 1.5,
    ns: { r: 2.5,  y: 0.03, g: 0.03 },
    ew: { r: 0.03, y: 2.5,  g: 0.03 },
    pedNS: { r: 0.03, y: 0.03, g: 2.5  },
    pedEW: { r: 2.5,  y: 0.03, g: 0.03 },
  },
  {
    t: 0.8,
    ns: { r: 2.5,  y: 0.03, g: 0.03 },
    ew: { r: 2.5,  y: 0.03, g: 0.03 },
    pedNS: { r: 2.5,  y: 0.03, g: 0.03 },
    pedEW: { r: 2.5,  y: 0.03, g: 0.03 },
  },
];
const TL_TOTAL = TL_STAGES.reduce((s, p) => s + p.t, 0);

// Shared signal state — imported by npc.js
// carRedNS: N-S car signals red  /  carRedEW: E-W car signals red
export const trafficState = { carRedNS: false, carRedEW: true };

function _getStage(t) {
  let acc = 0;
  for (const p of TL_STAGES) { if (t < acc + p.t) return p; acc += p.t; }
  return TL_STAGES[0];
}
function _applyGroup(group, ph) {
  for (const { red, yel, grn } of group) {
    red.material.emissiveIntensity = ph.r;
    if (yel) yel.material.emissiveIntensity = ph.y;
    grn.material.emissiveIntensity = ph.g;
  }
}

export function updateTrafficLights(dt) {
  _tlTimer = (_tlTimer + dt) % TL_TOTAL;
  const stage = _getStage(_tlTimer);

  _applyGroup(_carNS, stage.ns);
  _applyGroup(_carEW, stage.ew);

  trafficState.carRedNS = stage.ns.r > 0.5;
  trafficState.carRedEW = stage.ew.r > 0.5;

  _applyGroup(_pedNS, stage.pedNS);
  _applyGroup(_pedEW, stage.pedEW);
}

// Pedestrian signal — slightly smaller than before
function makeTrafficLight(scene, x, z, ry = 0, tlArray = _pedNS) {
  const g = new THREE.Group();
  g.position.set(x, ROAD_Y, z);
  g.rotation.y = ry;

  const poleMat = matStd(0x333333, { roughness: 0.6, metalness: 0.5 });
  const pole = mesh(new THREE.CylinderGeometry(0.05, 0.07, 3.5, 8), poleMat);
  pole.position.y = 1.75;
  g.add(pole);

  const headMat = matStd(0x111111, { roughness: 0.8 });
  // 歩行者用は赤・緑のみ（黄色なし）→ 2灯ヘッド
  const head = mesh(new THREE.BoxGeometry(0.38, 0.72, 0.32), headMat);
  head.position.set(0, 3.7, 0);
  g.add(head);

  function light(color, iy) {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.4, emissive: new THREE.Color(color), emissiveIntensity: 0.45 });
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.10, 8, 6), m);
    s.position.set(0, 3.7 + iy, 0.17);
    g.add(s);
    return s;
  }
  const red = light(0xff2200,  0.15);
  const grn = light(0x00cc22, -0.15);

  scene.add(g);
  addBox(x - 0.1, z - 0.1, x + 0.1, z + 0.1, 0, 4.0);
  tlArray.push({ red, yel: null, grn });
}

// Car signal — larger, horizontal
function makeCarTrafficLight(scene, x, z, ry, tlArray = _carNS) {
  const g = new THREE.Group();
  g.position.set(x, ROAD_Y, z);
  g.rotation.y = ry;

  const poleMat = matStd(0x333333, { roughness: 0.6, metalness: 0.5 });
  const pole = mesh(new THREE.CylinderGeometry(0.08, 0.12, 6.5, 8), poleMat);
  pole.position.y = 3.25;
  g.add(pole);

  // Horizontal arm
  const arm = mesh(new THREE.CylinderGeometry(0.05, 0.05, 3.5, 6), poleMat);
  arm.position.set(1.75, 6.2, 0);
  arm.rotation.z = Math.PI / 2;
  g.add(arm);

  const headMat = matStd(0x111111, { roughness: 0.8 });
  const head = mesh(new THREE.BoxGeometry(2.2, 0.72, 0.55), headMat);
  head.position.set(3.5, 5.85, 0);
  g.add(head);

  function light(color, ix) {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.4, emissive: new THREE.Color(color), emissiveIntensity: 0.45 });
    const s = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), m);
    s.position.set(3.5 + ix, 5.85, 0.28);
    g.add(s);
    return s;
  }
  const red = light(0xff2200,  0.74);
  const yel = light(0xffaa00,  0.0);
  const grn = light(0x00cc22, -0.74);

  scene.add(g);
  addBox(x - 0.1, z - 0.1, x + 0.1, z + 0.1, 0, 7.0);
  tlArray.push({ red, yel, grn });
}

function makeTrafficLights(scene) {
  for (let j = 0; j <= GRID; j++) {
    for (let i = 0; i <= GRID; i++) {
      const ix = i * CELL, iz = j * CELL;
      const sw = SIDEWALK_W;
      const roadX = verticalRoadStart(i);
      const roadW = verticalRoadWidth(i);
      const hasN = j > 0;
      const hasS = j < GRID;
      const hasW = i > 0;
      const hasE = i < GRID;

      if (hasS) {
        // Ped signals crossing N-S road → green when N-S cars stopped
        makeTrafficLight(scene, roadX - sw / 2,       iz + ROAD + 4.0,  Math.PI / 2,  _pedNS);
        makeTrafficLight(scene, roadX + roadW + sw / 2, iz + ROAD + 4.0, -Math.PI / 2, _pedNS);
      }
      // N-S car signals (approachごとに存在判定)
      if (hasS) {
        makeCarTrafficLight(scene, roadX - sw / 2,       iz + ROAD + sw / 2, 0,        _carNS);
      }
      if (hasN) {
        makeCarTrafficLight(scene, roadX + roadW + sw / 2, iz - sw / 2,       Math.PI,  _carNS);
      }

      if (hasE) {
        // Ped signals crossing E-W road → green when E-W cars stopped
        makeTrafficLight(scene, ix + ROAD + 4.0 + (isRailRoadColumn(i) ? RAIL_EXT_W : 0), iz - sw / 2,        0,        _pedEW);
        makeTrafficLight(scene, ix + ROAD + 4.0 + (isRailRoadColumn(i) ? RAIL_EXT_W : 0), iz + ROAD + sw / 2, Math.PI,  _pedEW);
      }
      // E-W car signals (approachごとに存在判定)
      if (hasW) {
        makeCarTrafficLight(scene, ix - sw / 2 - (isRailRoadColumn(i) ? RAIL_EXT_W : 0), iz - sw / 2,        -Math.PI / 2, _carEW);
      }
      if (hasE) {
        makeCarTrafficLight(scene, ix + ROAD + sw / 2 + (isRailRoadColumn(i) ? RAIL_EXT_W : 0), iz + ROAD + sw / 2,  Math.PI / 2, _carEW);
      }
    }
  }
}

// ── Main city builder ─────────────────────────────────────────────────────────
export function buildCity(scene) {
  buildRoadGraph();

  // ─ Island terrain ─────────────────────────────────────────────────────────
  // 都市エリアは島として海に囲まれ、遠方に山脈が見える
  const CW   = WORLD + ROAD;            // 都市全体幅 (外周道路含む)
  const midX = CW / 2, midZ = CW / 2;  // 都市中心
  const terrainGeo = new THREE.PlaneGeometry(2400, 2400, 180, 180);
  terrainGeo.rotateX(-Math.PI / 2);
  const posAttr = terrainGeo.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    const tx = posAttr.getX(i) + midX;
    const tz = posAttr.getZ(i) + midZ;
    const inside = tx >= -1 && tx <= CW + 1 && tz >= -1 && tz <= CW + 1;
    let ty;
    if (inside) {
      ty = -0.5;
    } else {
      const { mountainY, oceanBlend } = baseMountainHeight(tx, tz, CW);
      ty = mountainY * (1 - oceanBlend) + (-6.0) * oceanBlend;
    }
    posAttr.setY(i, ty);
  }
  terrainGeo.computeVertexNormals();
  const terrainMat = matTex(tex.grass);
  applyTunnelCutoutToTerrainMaterial(terrainMat);
  const terrain = mesh(terrainGeo, terrainMat);
  terrain.position.set(midX, 0, midZ);
  scene.add(terrain);

  // ─ 外周歩道 + ビーチ + 海 (南+東側) ────────────────────────────────────
  const SWALK = 5;   // 歩道幅
  const BEACH = 14;  // ビーチ幅

  // 外周歩道 (南側)
  const outerSwMatS = matTex(tex.sidewalk);
  const swS = new THREE.Mesh(new THREE.PlaneGeometry(CW + SWALK, SWALK), outerSwMatS);
  swS.rotation.x = -Math.PI / 2;
  swS.position.set(CW / 2 + SWALK / 2, 0.05, CW + SWALK / 2);
  scene.add(swS);
  // 外周歩道 (東側)
  const swE = new THREE.Mesh(new THREE.PlaneGeometry(SWALK, CW), outerSwMatS);
  swE.rotation.x = -Math.PI / 2;
  swE.position.set(CW + SWALK / 2, 0.05, CW / 2);
  scene.add(swE);

  // ビーチ (南側)
  const sandMat = new THREE.MeshStandardMaterial({ color: 0xe8d5a3, roughness: 0.95, metalness: 0 });
  const bS = new THREE.Mesh(new THREE.PlaneGeometry(CW + SWALK + BEACH, BEACH), sandMat);
  bS.rotation.x = -Math.PI / 2;
  bS.position.set((CW + SWALK + BEACH) / 2, -0.10, CW + SWALK + BEACH / 2);
  scene.add(bS);
  // ビーチ (東側)
  const bE = new THREE.Mesh(new THREE.PlaneGeometry(BEACH, CW + SWALK), sandMat);
  bE.rotation.x = -Math.PI / 2;
  bE.position.set(CW + SWALK + BEACH / 2, -0.10, (CW + SWALK) / 2);
  scene.add(bE);

  // 浅瀬 (ターコイズ)
  const shallowMat = new THREE.MeshStandardMaterial({
    color: 0x1eaabf, roughness: 0.12, metalness: 0.08,
    transparent: true, opacity: 0.85, depthWrite: false,
  });
  const shallow = new THREE.Mesh(new THREE.PlaneGeometry(3200, 3200), shallowMat);
  shallow.rotation.x = -Math.PI / 2;
  shallow.position.set(CW + 500, -0.38, CW + 500);
  scene.add(shallow);

  // 深海
  const waterMat = new THREE.MeshStandardMaterial({
    color: 0x1272b0, roughness: 0.08, metalness: 0.12,
    transparent: true, opacity: 0.92, depthWrite: false,
  });
  const water = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), waterMat);
  water.rotation.x = -Math.PI / 2;
  water.position.set(CW + 1500, -0.65, CW + 1500);
  scene.add(water);

  // ─ Road surface ─
  const roadMat = matTex(tex.road);
  // Full ground under roads — exactly fit city boundary (0 to WORLD+ROAD)
  const fullGround = mesh(
    new THREE.PlaneGeometry(WORLD + ROAD, WORLD + ROAD),
    roadMat
  );
  fullGround.rotation.x = -Math.PI / 2;
  fullGround.position.set((WORLD + ROAD) / 2, ROAD_Y, (WORLD + ROAD) / 2);
  scene.add(fullGround);

  // ─ Block surfaces (sidewalk + ground) ─
  const swMat = matTex(tex.sidewalk);
  const blockGroundMat = matStd(0x888888);

  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const bx = i * CELL + ROAD;
      const bz = j * CELL + ROAD;
      const shrinkWest = blockInsetWest(i);
      const shrinkEast = blockInsetEast(i);
      const blockUsableW = BLOCK - shrinkWest - shrinkEast;

      // Block ground
      const bg = mesh(new THREE.BoxGeometry(blockUsableW, 0.12, BLOCK), blockGroundMat);
      bg.position.set(bx + shrinkWest + blockUsableW / 2, ROAD_Y + 0.02, bz + BLOCK / 2);
      scene.add(bg);

      // Sidewalk strips (N, S, E, W edges of each block)
      const sw = SIDEWALK_W;
      const swGeos = [
        // North strip
        { w: blockUsableW, d: sw, ox: shrinkWest + blockUsableW / 2, oz: sw / 2 },
        // South strip
        { w: blockUsableW, d: sw, ox: shrinkWest + blockUsableW / 2, oz: BLOCK - sw / 2 },
        // East strip (sides)
        { w: sw - shrinkEast, d: BLOCK - sw * 2, ox: BLOCK - shrinkEast - (sw - shrinkEast) / 2, oz: BLOCK / 2 },
        // West strip
        { w: sw - shrinkWest, d: BLOCK - sw * 2, ox: (sw - shrinkWest) / 2 + shrinkWest, oz: BLOCK / 2 },
      ];
      for (const s of swGeos) {
        if (s.w <= 0.02) continue;
        const swMesh = mesh(new THREE.BoxGeometry(s.w, SIDEWALK_H, s.d), swMat);
        swMesh.position.set(bx + s.ox, ROAD_Y + SIDEWALK_H / 2 + 0.06, bz + s.oz);
        scene.add(swMesh);
      }

      // Curbs (slightly raised edges)
      const curbMat = matStd(0xaaaaaa);
      const curbH = 0.08;
      const curbs = [
        { w: blockUsableW + 0.2, d: 0.15, ox: shrinkWest + blockUsableW / 2, oz: 0 },
        { w: blockUsableW + 0.2, d: 0.15, ox: shrinkWest + blockUsableW / 2, oz: BLOCK },
        { w: 0.15, d: BLOCK, ox: shrinkWest, oz: BLOCK / 2 },
        { w: 0.15, d: BLOCK, ox: BLOCK - shrinkEast, oz: BLOCK / 2 },
      ];
      for (const c of curbs) {
        const cm = mesh(new THREE.BoxGeometry(c.w, curbH, c.d), curbMat);
        cm.position.set(bx + c.ox, ROAD_Y + SIDEWALK_H + curbH / 2, bz + c.oz);
        scene.add(cm);
      }

      // Build the block content — hand-crafted layout, max 3 of each type in 5×5
      const BLOCK_LAYOUT = [
        [0, 1, 2, 3, 4],
        [5, 6, 1, 2, 0],
        [3, 4, 5, 6, 2],
        [1, 0, 3, 4, 5],
        [6, 2, 0, 1, 3],
      ];
      const blockType = BLOCK_LAYOUT[j][i];
      blockBuilders[blockType](scene, bx, bz);

      // Street furniture on each side
      placeFurniture(scene, bx, bz, 'n');
      placeFurniture(scene, bx, bz, 's');
      if (i === 0) placeFurniture(scene, bx, bz, 'w');
      if (i === GRID - 1) placeFurniture(scene, bx, bz, 'e');
    }
  }

  // ─ Lane markings, crosswalks, stop lines & traffic lights ─
  makeLaneMarkings(scene);
  makeCrosswalks(scene);
  makeStopLines(scene);
  makeTrafficLights(scene);

  // ─ 都市境界沿いの街路樹 ──────────────────────────────────────────────────
  for (let k = 0; k < 80; k++) {
    const t = k / 80;
    let tx, tz;
    if      (t < 0.25) { tx = ROAD + 1 + Math.random()*3; tz = (t/0.25)*WORLD; }
    else if (t < 0.5)  { tx = (t-0.25)/0.25*WORLD;        tz = ROAD + 1 + Math.random()*3; }
    else if (t < 0.75) { tx = WORLD-ROAD-1-Math.random()*3; tz = (t-0.5)/0.25*WORLD; }
    else               { tx = (t-0.75)/0.25*WORLD;          tz = WORLD-ROAD-1-Math.random()*3; }
    if (!isRoadPos(tx, tz)) makeTree(scene, tx, tz);
  }

}
