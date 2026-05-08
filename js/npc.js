import * as THREE from 'three';
import { state, CELL, ROAD, GRID, WORLD, SIDEWALK_H, SIDEWALK_W, BLOCK } from './config.js?v=20260508-5';
import { raiseWanted } from './config.js?v=20260508-5';
import { resolveAABB } from './physics.js?v=20260508-5';
import { matStd, matCar } from './textures.js?v=20260508-5';
import { addBox } from './physics.js?v=20260508-5';
import { trafficState } from './city.js?v=20260508-5';

const POLICE_ROUND = 0;
const POLICE_LIMIT = 4;
const POLICE_SPAWN_DIST = 24;

function getDistance2(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

function makePoliceBody(scene, color = 0x2244cc) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.75, 4.2), matStd(color, { roughness: 0.35, metalness: 0.4 }));
  body.position.y = 0.72;
  body.castShadow = true;
  g.add(body);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.45, 1.8), matStd(0xffffff, { roughness: 0.4, metalness: 0.2 }));
  roof.position.set(0, 1.3, -0.2);
  roof.castShadow = true;
  g.add(roof);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.12, 0.25), matStd(0xff4444));
  bar.position.set(0, 1.58, -0.6);
  g.add(bar);
  scene.add(g);
  return g;
}

function createPoliceUnit(scene, x, z) {
  const mesh = makePoliceBody(scene, 0x1f3f8f);
  mesh.position.set(x, 0.33, z);
  const unit = {
    kind: 'police',
    mesh,
    x,
    z,
    hp: 100,
    dead: false,
    deadTimer: 0,
    speed: 8.5,
    mode: 'car',
    _targetTimer: 0,
    _hitFlash: 0,
    update(dt) {
      if (this._hitFlash > 0) {
        this._hitFlash = Math.max(0, this._hitFlash - dt);
        this.mesh.scale.setScalar(1 + this._hitFlash * 0.12);
      } else {
        this.mesh.scale.setScalar(1);
      }
      if (this.dead) {
        this.deadTimer -= dt;
        this.mesh.rotation.x = Math.PI / 2;
        return;
      }
      const dx = state.px - this.x;
      const dz = state.pz - this.z;
      const dist = Math.hypot(dx, dz);
      const targetYaw = Math.atan2(-dx, -dz);
      this.mesh.rotation.y += (((targetYaw - this.mesh.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * Math.min(1, dt * 3);
      const step = Math.min(this.speed * dt, Math.max(0.01, dist - 2.0));
      if (dist > 2.2) {
        this.x += (-Math.sin(this.mesh.rotation.y)) * step;
        this.z += (-Math.cos(this.mesh.rotation.y)) * step;
      }
      const p = resolveAABB(this.x, 0.33, this.z, 1.0);
      this.x = p.x;
      this.z = p.z;
      this.mesh.position.set(this.x, 0.33, this.z);
      if (dist < 2.6 && state._playerHitCooldown <= 0) {
        state.hp = Math.max(0, state.hp - 12);
        state._playerHitCooldown = 1.0;
        this._hitFlash = 0.12;
        this.mesh.rotation.z = Math.sin(performance.now() * 0.03) * 0.05;
        this.mesh.rotation.x = -0.15;
        this.mesh.rotation.z = Math.sin(performance.now() * 0.03) * 0.02;
        raiseWanted(1);
      }
    },
  };
  mesh.userData.entity = unit;
  return unit;
}

export function spawnPoliceResponse(dt) {
  if (state.wanted <= 0 || !state._scene) return;
  state.policeUnits = state.policeUnits.filter(c => !c.dead || c.deadTimer > 0);
  const targetCount = Math.min(POLICE_LIMIT, Math.max(1, state.wanted));
  if (state.policeUnits.length >= targetCount) return;

  state.policeDispatchTimer = (state.policeDispatchTimer || 0) + dt;
  const delay = Math.max(1.6, 5.5 - state.wanted * 0.7);
  if (state.policeDispatchTimer < delay) return;
  state.policeDispatchTimer = 0;

  let bestNode = null;
  let bestDist = Infinity;
  for (const node of state.roadNodes) {
    const d2 = getDistance2(node.x, node.z, state.px, state.pz);
    if (d2 < 50 * 50 || d2 > 160 * 160) continue;
    if (d2 < bestDist) {
      bestDist = d2;
      bestNode = node;
    }
  }
  if (!bestNode) bestNode = state.roadNodes[Math.floor(Math.random() * state.roadNodes.length)];
  if (!bestNode) return;

  const unit = createPoliceUnit(state._scene, bestNode.x, bestNode.z);
  unit.mesh.rotation.y = Math.atan2(state.px - bestNode.x, state.pz - bestNode.z);
  state.policeUnits.push(unit);
}

export function updatePoliceResponse(dt) {
  for (const cop of state.policeUnits) cop.update(dt);
  state.policeUnits = state.policeUnits.filter(c => !c.dead || c.deadTimer > 0);
}

const RAIL_ROAD_X = 4 * CELL + ROAD / 2;
const RAIL_MEDIAN_W = 3.5;
const RAIL_EXT_W = RAIL_MEDIAN_W / 2;
const RAIL_ROAD_I = 4;
const STOP_NO_CW = ROAD / 2 + 1.5;
const STOP_CW = (ROAD + 4.0 + (ROAD * 0.20) / 2 + 0.625) - ROAD / 2;

// ── Seeded RNG (for deterministic placement) ──────────────────────────────────
function rng(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff; };
}

function getLaneOffsetsForSegment(from, to) {
  const isRailBoulevard =
    Math.abs(from.x - to.x) < 0.001 &&
    Math.abs(from.x - RAIL_ROAD_X) < 0.001;
  const medianShift = isRailBoulevard ? RAIL_MEDIAN_W / 2 : 0;
  return {
    inner: medianShift + ROAD / 8,
    outer: medianShift + ROAD * 3 / 8,
  };
}

function getLaneOffsetForRole(from, to, role) {
  const laneOffsets = getLaneOffsetsForSegment(from, to);
  return role === 'outer' ? laneOffsets.outer : laneOffsets.inner;
}

function getRandomLaneRole() {
  return Math.random() < 0.5 ? 'inner' : 'outer';
}

function getStopDistanceForSegment(from, to) {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const hitsRailIntersection =
    Math.abs(dz) < 0.001 &&
    Math.abs(to.x - RAIL_ROAD_X) < 0.001;

  if (Math.abs(dz) > Math.abs(dx)) {
    return dz > 0 ? STOP_NO_CW : STOP_CW;
  }

  const railExtra = hitsRailIntersection ? RAIL_EXT_W : 0;
  return dx > 0 ? STOP_NO_CW + railExtra : STOP_CW + railExtra;
}

function getTurnDirection(nodes, fromIdx, toIdx, nextIdx) {
  if (nextIdx == null) return 0;
  const from = nodes[fromIdx];
  const via = nodes[toIdx];
  const next = nodes[nextIdx];
  if (!from || !via || !next) return 0;
  const dx0 = via.x - from.x;
  const dz0 = via.z - from.z;
  const len0 = Math.hypot(dx0, dz0) || 1;
  const fwdX = dx0 / len0;
  const fwdZ = dz0 / len0;
  const dx1 = next.x - via.x;
  const dz1 = next.z - via.z;
  const len1 = Math.hypot(dx1, dz1) || 1;
  const cross = fwdX * dz1 - fwdZ * dx1;
  if (Math.abs(cross) <= len1 * 0.5) return 0;
  return cross < 0 ? -1 : 1;
}

function getPlannedTurnDirection(car) {
  return car._turning ? (car._turnDir || 0) : getTurnDirection(car._nodes, car.fromIdx, car.toIdx, car._nextToIdx);
}

function getDistanceToNode(car, nodeIdx) {
  const node = car._nodes[nodeIdx];
  if (!node) return Infinity;
  if (car._turning) return Math.hypot(car.x - node.x, car.z - node.z);
  if (car.toIdx !== nodeIdx) return Infinity;
  const from = car._nodes[car.fromIdx];
  const to = car._nodes[car.toIdx];
  return (1 - car.t) * Math.hypot(to.x - from.x, to.z - from.z);
}

function isRailRoadZone(x) {
  const railX1 = RAIL_ROAD_I * CELL - RAIL_EXT_W;
  const railX2 = railX1 + ROAD + RAIL_MEDIAN_W;
  return x >= railX1 && x <= railX2;
}

// ── Traffic car class ─────────────────────────────────────────────────────────
const CAR_COLORS = [0xcc2222, 0x2244cc, 0x22bb55, 0xddcc11, 0xcc6600, 0xaa22aa, 0xeeeeee, 0x111122, 0x559944, 0xcc4444];
// 車線オフセットは各車がインスタンスごとに保持（外側 or 内側車線）

// Car type definitions: [bodyW, bodyH, bodyL, cabinW, cabinH, cabinL, cabinZ, wheelR, wheelBase]
const CAR_TYPES = [
  // 0: Sedan
  { bW:2.0,  bH:0.70, bL:4.2, cW:1.65, cH:0.60, cL:2.1, cZ:-0.15, wR:0.33, wB:1.30, mass:1.0  },
  // 1: SUV
  { bW:2.2,  bH:0.85, bL:4.6, cW:2.0,  cH:0.75, cL:2.0, cZ:-0.3,  wR:0.40, wB:1.45, mass:1.5  },
  // 2: Sports car (wide, low)
  { bW:2.1,  bH:0.55, bL:4.4, cW:1.8,  cH:0.45, cL:1.7, cZ:0.10,  wR:0.30, wB:1.35, mass:0.9  },
  // 3: Van / box truck
  { bW:2.2,  bH:1.35, bL:5.0, cW:2.1,  cH:0.0,  cL:0.0, cZ:0.0,   wR:0.38, wB:1.60, mass:2.0  },
  // 4: Muscle car (wide, long, low)
  { bW:2.15, bH:0.60, bL:4.9, cW:1.85, cH:0.48, cL:1.9, cZ:0.05,  wR:0.32, wB:1.40, mass:1.2  },
  // 5: Hatchback (short, tall)
  { bW:1.88, bH:0.76, bL:3.8, cW:1.68, cH:0.60, cL:1.8, cZ:0.08,  wR:0.30, wB:1.10, mass:0.85 },
  // 6: Luxury sedan (long, sleek)
  { bW:2.05, bH:0.68, bL:5.2, cW:1.8,  cH:0.55, cL:2.3, cZ:-0.2,  wR:0.34, wB:1.50, mass:1.3  },
  // 7: Pickup truck (cab + open bed)
  { bW:2.25, bH:0.82, bL:5.5, cW:2.05, cH:0.78, cL:2.1, cZ:-0.85, wR:0.40, wB:1.70, mass:1.8  },
  // 8: Mini / compact
  { bW:1.65, bH:0.78, bL:3.2, cW:1.50, cH:0.65, cL:1.5, cZ:0.10,  wR:0.28, wB:0.95, mass:0.7  },
  // 9: Station wagon
  { bW:2.0,  bH:0.78, bL:4.6, cW:1.75, cH:0.65, cL:2.5, cZ:0.10,  wR:0.33, wB:1.35, mass:1.1  },
  // 10: Taxi / cab (yellow-able)
  { bW:2.0,  bH:0.72, bL:4.4, cW:1.68, cH:0.62, cL:2.1, cZ:-0.1,  wR:0.33, wB:1.30, mass:1.0  },
];

export class TrafficCar {
  constructor(scene, fromIdx, toIdx = null, startT = 0) {
    this.driver  = null;
    this.speed   = (5 + Math.random() * 5) * 1.3;
    this._nodes  = state.roadNodes;
    this._adj    = state.roadAdj;
    this.fromIdx = fromIdx;
    const neighbors = state.roadAdj[fromIdx];
    this.toIdx = toIdx ?? neighbors[Math.floor(Math.random() * neighbors.length)];
    this.t = startT;
    this._type = Math.floor(Math.random() * CAR_TYPES.length);
    const from = state.roadNodes[this.fromIdx];
    const to   = state.roadNodes[this.toIdx];
    this._laneRole          = getRandomLaneRole();
    this._laneOffset        = getLaneOffsetForRole(from, to, this._laneRole);
    this._currentLaneOffset = this._laneOffset;
    // 開始位置: セグメント上のstartT位置に車線オフセットを適用
    const _dx0 = to.x - from.x, _dz0 = to.z - from.z;
    const _l0  = Math.hypot(_dx0, _dz0) || 1;
    this.x = from.x + _dx0 * startT + (_dz0 / _l0) * this._laneOffset;
    this.z = from.z + _dz0 * startT + (-_dx0 / _l0) * this._laneOffset;
    this._yaw = Math.atan2(-_dx0, -_dz0);
    this._steerYaw          = 0;
    this._stoppedAtRed      = false;
    this._waitingAtYield    = false;
    // ── 物理オフセット (衝突による経路からの逸脱) ─────────────────────────
    this._vx = 0; this._vz = 0;
    this._ox = 0; this._oz = 0;
    this._rx = this.x; this._rz = this.z;
    // ── ノックバック専用 ──────────────────────────────────────────────────
    this._kbvx = 0; this._kbvz = 0; this._kbTimer = 0; this._kbRotSpd = 0;
    // ── 立ち往生検知 ──────────────────────────────────────────────────────
    this._stuckTimer = 0; this._stuckCheckTimer = 0;
    this._lastCheckX = this.x; this._lastCheckZ = this.z;
    // Bezier turn state
    this._turning    = false;
    this._turnU      = 0;
    this._turnP0     = null;
    this._turnP1     = null;
    this._turnP2     = null;
    this._turnP3     = null;  // 三次Bezier用 (左折のみ)
    this._turnArcLen = 1;
    this._turnDir = 0;
    // Look-ahead: pre-determine next direction at t=0.5
    this._nextToIdx  = null;
    this.mesh = this._buildMesh(scene);
    this._updatePos();
  }

  _buildMesh(scene) {
    // タイプ10(タクシー)は黄色固定、それ以外はランダム
    const color = this._type === 10 ? 0xf5c518 : CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)];
    const tp = CAR_TYPES[this._type];
    const g = new THREE.Group();
    const bodyMat = matCar(color);
    const winMat  = new THREE.MeshStandardMaterial({ color: 0x88ccff, roughness: 0.05, transparent: true, opacity: 0.68 });
    const hlMat   = matStd(0xffffcc, { emissive: 0xffffcc, emissiveIntensity: 0.4 });
    const tlMat   = matStd(0xff2200, { emissive: 0xff2200, emissiveIntensity: 0.3 });
    const wheelMat= matStd(0x111111, { roughness: 0.9 });
    const rimMat  = matStd(0x999999, { roughness: 0.2, metalness: 0.8 });
    const darkMat = matStd(0x111111, { roughness: 0.8 });

    function mb(w, h, d, mat) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.castShadow = true;
      return m;
    }

    const bodyY = tp.wR + tp.bH / 2 - 0.05;

    // Body
    const body = mb(tp.bW, tp.bH, tp.bL, bodyMat);
    body.position.y = bodyY;
    g.add(body);

    if (this._type === 3) {
      // Van: box shape, no separate cabin
      const topBox = mb(tp.bW - 0.05, 0.95, tp.bL * 0.55, bodyMat);
      topBox.position.set(0, bodyY + tp.bH/2 + 0.475, tp.bL * 0.12);
      g.add(topBox);
      // Windshield
      const ws = mb(tp.bW - 0.2, 0.7, 0.06, winMat);
      ws.position.set(0, bodyY + tp.bH/2 + 0.35, -tp.bL/2 + 0.05);
      g.add(ws);
    } else {
      // Cabin
      if (tp.cH > 0) {
        const cabin = mb(tp.cW, tp.cH, tp.cL, bodyMat);
        cabin.position.set(0, bodyY + tp.bH/2 + tp.cH/2, tp.cZ);
        g.add(cabin);

        // Windows
        const winH = tp.cH * 0.7;
        const winY = bodyY + tp.bH/2 + tp.cH/2;
        // Front
        const wf = mb(tp.cW * 0.82, winH, 0.06, winMat);
        wf.position.set(0, winY, tp.cZ - tp.cL/2 + 0.05);
        g.add(wf);
        // Rear
        const wr = mb(tp.cW * 0.75, winH * 0.85, 0.06, winMat);
        wr.position.set(0, winY - 0.05, tp.cZ + tp.cL/2 - 0.05);
        g.add(wr);
        // Sides
        for (const sx of [-tp.cW/2, tp.cW/2]) {
          const ws = mb(0.06, winH, tp.cL * 0.78, winMat);
          ws.position.set(sx, winY, tp.cZ);
          g.add(ws);
        }
      }
    }

    // Bumper / grille detail
    const grille = mb(tp.bW * 0.6, tp.bH * 0.25, 0.08, darkMat);
    grille.position.set(0, tp.wR + 0.12, -tp.bL/2 - 0.04);
    g.add(grille);

    // Headlights
    for (const hx of [-tp.bW*0.38, tp.bW*0.38]) {
      const hl = mb(0.28, 0.18, 0.08, hlMat);
      hl.position.set(hx, bodyY - 0.05, -tp.bL/2 - 0.04);
      g.add(hl);
    }
    // Tail lights
    for (const hx of [-tp.bW*0.38, tp.bW*0.38]) {
      const tl = mb(0.25, 0.16, 0.06, tlMat);
      tl.position.set(hx, bodyY - 0.05, tp.bL/2 + 0.04);
      g.add(tl);
    }

    // Wheels (4x)
    for (const [wx, wz] of [[-tp.bW/2-0.05,-tp.wB],[tp.bW/2+0.05,-tp.wB],[-tp.bW/2-0.05,tp.wB],[tp.bW/2+0.05,tp.wB]]) {
      const wh = new THREE.Mesh(new THREE.CylinderGeometry(tp.wR, tp.wR, 0.22, 12), wheelMat);
      wh.rotation.z = Math.PI / 2;
      wh.position.set(wx, tp.wR, wz);
      g.add(wh);
      // Spoke rim
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(tp.wR * 0.6, tp.wR * 0.6, 0.23, 6), rimMat);
      rim.rotation.z = Math.PI / 2;
      rim.position.set(wx, tp.wR, wz);
      g.add(rim);
    }

    // Side mirror stubs
    for (const sx of [-tp.bW/2 - 0.12, tp.bW/2 + 0.12]) {
      const mir = mb(0.1, 0.08, 0.22, matStd(color, { roughness: 0.3 }));
      mir.position.set(sx, bodyY + tp.bH/2 + 0.05, -tp.bL/4);
      g.add(mir);
    }

    // タイプ別特殊パーツ
    if (this._type === 4) {
      // マッスルカー: リアスポイラー
      const spoH = 0.20;
      for (const sx of [-tp.bW * 0.28, tp.bW * 0.28]) {
        const post = mb(0.07, spoH, 0.07, darkMat);
        post.position.set(sx, bodyY + tp.bH/2 + tp.cH + spoH/2, tp.bL/2 - 0.22);
        g.add(post);
      }
      const wing = mb(tp.bW * 0.72, 0.06, 0.30, darkMat);
      wing.position.set(0, bodyY + tp.bH/2 + tp.cH + spoH + 0.03, tp.bL/2 - 0.22);
      g.add(wing);
      // フードスクープ
      const scoop = mb(0.30, 0.07, 0.55, darkMat);
      scoop.position.set(0, bodyY + tp.bH/2 + 0.04, -tp.bL/2 + 1.1);
      g.add(scoop);
    }

    if (this._type === 7) {
      // ピックアップトラック: オープンベッド (後半部)
      const bedL = tp.bL * 0.38;
      const bedZ = tp.bL/2 - bedL/2;
      const bedH = 0.42;
      const bedMat = matStd(color, { roughness: 0.5 });
      // サイドレール
      for (const sx of [-tp.bW/2 + 0.05, tp.bW/2 - 0.05]) {
        const rail = mb(0.08, bedH, bedL, bedMat);
        rail.position.set(sx, bodyY + tp.bH/2 + bedH/2, bedZ);
        g.add(rail);
      }
      // リアゲート
      const gate = mb(tp.bW - 0.18, bedH, 0.07, bedMat);
      gate.position.set(0, bodyY + tp.bH/2 + bedH/2, tp.bL/2 + 0.04);
      g.add(gate);
      // ベッドフロア
      const floor = mb(tp.bW - 0.2, 0.06, bedL, darkMat);
      floor.position.set(0, bodyY + tp.bH/2 + 0.03, bedZ);
      g.add(floor);
    }

    if (this._type === 10) {
      // タクシー: ルーフサイン
      const sign = mb(0.55, 0.14, 0.28, matStd(0xffffff, { emissive: 0xffee88, emissiveIntensity: 0.5 }));
      sign.position.set(0, bodyY + tp.bH/2 + tp.cH + 0.10, 0);
      g.add(sign);
    }

    scene.add(g);
    return g;
  }

  _updatePos() {
    let dx, dz, rx, rz;

    if (this._turning) {
      const u  = this._turnU;
      const iu = 1 - u;
      const P0 = this._turnP0, P1 = this._turnP1, P2 = this._turnP2;
      if (this._turnP3) {
        const P3 = this._turnP3;
        rx = iu*iu*iu*P0.x + 3*iu*iu*u*P1.x + 3*iu*u*u*P2.x + u*u*u*P3.x;
        rz = iu*iu*iu*P0.z + 3*iu*iu*u*P1.z + 3*iu*u*u*P2.z + u*u*u*P3.z;
        dx = 3*iu*iu*(P1.x-P0.x) + 6*iu*u*(P2.x-P1.x) + 3*u*u*(P3.x-P2.x);
        dz = 3*iu*iu*(P1.z-P0.z) + 6*iu*u*(P2.z-P1.z) + 3*u*u*(P3.z-P2.z);
      } else {
        rx = iu*iu*P0.x + 2*iu*u*P1.x + u*u*P2.x;
        rz = iu*iu*P0.z + 2*iu*u*P1.z + u*u*P2.z;
        dx = 2*iu*(P1.x - P0.x) + 2*u*(P2.x - P1.x);
        dz = 2*iu*(P1.z - P0.z) + 2*u*(P2.z - P1.z);
      }
    } else {
      const from = this._nodes[this.fromIdx];
      const to   = this._nodes[this.toIdx];
      const t    = this.t;
      const cx = from.x + (to.x - from.x) * t;
      const cz = from.z + (to.z - from.z) * t;
      dx = to.x - from.x;
      dz = to.z - from.z;
      const len = Math.sqrt(dx*dx + dz*dz) || 1;
      const nxR = dx / len, nzR = dz / len;
      rx = cx + nzR * this._currentLaneOffset;
      rz = cz - nxR * this._currentLaneOffset;
    }

    // 経路座標を保持し、衝突オフセットを加算して実座標を決定
    this._rx = rx; this._rz = rz;
    this.x = rx + this._ox;
    this.z = rz + this._oz;

    this.mesh.position.set(this.x, 0.33, this.z);
    const targetYaw = Math.atan2(-dx, -dz);
    let diff = targetYaw - this._yaw;
    while (diff >  Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    this._yaw += diff * (this._turning ? 0.22 : 0.12);
    this.mesh.rotation.y = this._yaw + this._steerYaw;
  }

  _respawn() {
    const nodes = this._nodes, adj = this._adj;
    const fi = Math.floor(Math.random() * nodes.length);
    const nbrs = adj[fi];
    const ti = nbrs[Math.floor(Math.random() * nbrs.length)];
    const fn = nodes[fi], tn = nodes[ti];
    const dx = tn.x - fn.x, dz = tn.z - fn.z;
    const len = Math.hypot(dx, dz) || 1;
    const t = 0.15 + Math.random() * 0.7;
    const nxR = dz / len, nzR = -dx / len;
    this._laneRole = getRandomLaneRole();
    this._laneOffset = getLaneOffsetForRole(fn, tn, this._laneRole);
    this._currentLaneOffset = this._laneOffset;
    this.fromIdx = fi; this.toIdx = ti; this.t = t;
    this._rx = fn.x + dx * t + nxR * this._laneOffset;
    this._rz = fn.z + dz * t + nzR * this._laneOffset;
    this.x = this._rx; this.z = this._rz;
    this._ox = 0; this._oz = 0; this._vx = 0; this._vz = 0;
    this._kbTimer = 0; this._kbvx = 0; this._kbvz = 0; this._kbRotSpd = 0;
    this._turning = false; this._turnDir = 0; this._nextToIdx = null; this._stoppedAtRed = false; this._waitingAtYield = false;
    this._stuckTimer = 0; this._stuckCheckTimer = 0;
    this._lastCheckX = this.x; this._lastCheckZ = this.z;
    this._yaw = Math.atan2(-(tn.x - fn.x), -(tn.z - fn.z));
    this.mesh.position.set(this.x, 0.33, this.z);
    this.mesh.rotation.y = this._yaw;
  }

  _startBezier(fwdX, fwdZ, curNodeIdx, nextNodeIdx, nextLaneOffset) {
    const curNode  = this._nodes[curNodeIdx];
    const nextNode = this._nodes[nextNodeIdx];
    const dx_new = nextNode.x - curNode.x, dz_new = nextNode.z - curNode.z;
    const lenNew  = Math.hypot(dx_new, dz_new) || 1;
    const nfwdX   = dx_new / lenNew, nfwdZ = dz_new / lenNew;
    const cross   = fwdX * dz_new - fwdZ * dx_new;
    const oldRX = fwdZ, oldRZ = -fwdX;
    const newRX = nfwdZ, newRZ = -nfwdX;
    const exitAdvance = cross < 0 ? ROAD * 0.8 : ROAD * 0.46;
    this._turnDir = cross < 0 ? -1 : 1;
    this._waitingAtYield = false;

    // P0: current car position (already lane-offset, seamless handoff)
    const P0 = { x: this.x, z: this.z };
    // Pend: R meters along new direction from intersection node, same lane as this car
    const Pend = { x: curNode.x + nfwdX * exitAdvance + newRX * nextLaneOffset,
                   z: curNode.z + nfwdZ * exitAdvance + newRZ * nextLaneOffset };

    let P1, P2, P3 = null;

    if (cross < 0) {
      // 左折: 三次Bezier — P0→交差点中心距離を基準にハンドル長を決める
      const distToCenter = Math.hypot(P0.x - curNode.x, P0.z - curNode.z);
      const t1 = distToCenter * 0.45;  // P0から交差点中心の45%: ノードより手前に収まる
      const t2 = ROAD * 0.45;          // 終点側ハンドル
      P1 = { x: P0.x + t1 * fwdX, z: P0.z + t1 * fwdZ };
      P2 = { x: Pend.x - t2 * nfwdX, z: Pend.z - t2 * nfwdZ };
      P3 = Pend;
    } else {
      // 右折: 内側コーナー基準の四分円に近いBezierにして、より滑らかな弧を描かせる。
      // 経路自体は各車の象限内に収めるので、対向右折とも中央で交差しにくい。
      const cornerRadius = Math.max(this._currentLaneOffset, nextLaneOffset, ROAD * 0.34);
      const entryArc = {
        x: curNode.x + oldRX * cornerRadius,
        z: curNode.z + oldRZ * cornerRadius,
      };
      const exitArc = {
        x: curNode.x + newRX * cornerRadius,
        z: curNode.z + newRZ * cornerRadius,
      };
      const tangentLen = Math.min(ROAD * 0.34, Math.max(0.85, cornerRadius * 0.56));
      P1 = {
        x: entryArc.x + fwdX * tangentLen,
        z: entryArc.z + fwdZ * tangentLen,
      };
      P2 = {
        x: exitArc.x - nfwdX * tangentLen,
        z: exitArc.z - nfwdZ * tangentLen,
      };
      P3 = Pend;
    }

    // アーク長を8点サンプリングで近似 (二次 or 三次)
    let arcLen = 0, px = P0.x, pz = P0.z;
    for (let k = 1; k <= 8; k++) {
      const u = k / 8, iu = 1 - u;
      let sx, sz;
      if (P3) {
        sx = iu*iu*iu*P0.x + 3*iu*iu*u*P1.x + 3*iu*u*u*P2.x + u*u*u*P3.x;
        sz = iu*iu*iu*P0.z + 3*iu*iu*u*P1.z + 3*iu*u*u*P2.z + u*u*u*P3.z;
      } else {
        sx = iu*iu*P0.x + 2*iu*u*P1.x + u*u*P2.x;
        sz = iu*iu*P0.z + 2*iu*u*P1.z + u*u*P2.z;
      }
      arcLen += Math.hypot(sx - px, sz - pz);
      px = sx; pz = sz;
    }

    this._turning    = true;
    this._turnU      = 0;
    this._turnP0     = P0;
    this._turnP1     = P1;
    this._turnP2     = P2;
    this._turnP3     = P3;
    this._turnArcLen = Math.max(arcLen, 0.5);
    this._laneOffset = nextLaneOffset;
    this._currentLaneOffset = nextLaneOffset;
    this.fromIdx = curNodeIdx;
    this.toIdx   = nextNodeIdx;
    this.t       = Math.min(exitAdvance / lenNew, 0.45);
  }

  update(dt) {
    if (this.driver === 'player') return;

    // 遠くの車はスキップ (距離カリング: >220m)
    const _dcx = this.x - state.px, _dcz = this.z - state.pz;
    if (_dcx * _dcx + _dcz * _dcz > 220 * 220) return;

    // ── ノックバックモード: 衝突時に経路を離れて飛ぶ ──────────────────────
    if (this._kbTimer > 0) {
      this._kbTimer -= dt;
      // 摩擦で速度を減衰 (約0.46秒で半減: 自然なスライド感)
      const friction = Math.exp(-1.5 * dt);
      this._kbvx    *= friction;
      this._kbvz    *= friction;
      this._kbRotSpd *= friction;
      this.x += this._kbvx * dt;
      this.z += this._kbvz * dt;
      this.mesh.rotation.y += this._kbRotSpd * dt;  // スピン
      this._yaw = this.mesh.rotation.y;
      this.mesh.position.set(this.x, 0.33, this.z);
      if (this._kbTimer <= 0) {
        // 最近傍道路セグメントを探してルートを再設定
        // → 古いルート位置（遠い）ではなく現在地に近い道路から自然に再開
        const nodes = this._nodes, adj = this._adj;
        let bestD2 = Infinity, bFi = 0, bTi = 1, bT = 0;
        for (let fi = 0; fi < nodes.length; fi++) {
          for (const ti of adj[fi]) {
            if (ti <= fi) continue;
            const fn = nodes[fi], tn = nodes[ti];
            const sdx = tn.x - fn.x, sdz = tn.z - fn.z;
            const sl2 = sdx * sdx + sdz * sdz;
            if (sl2 < 0.1) continue;
            const tt = Math.max(0, Math.min(1,
              ((this.x - fn.x) * sdx + (this.z - fn.z) * sdz) / sl2));
            const px = fn.x + sdx * tt, pz = fn.z + sdz * tt;
            const d2 = (this.x - px) ** 2 + (this.z - pz) ** 2;
            if (d2 < bestD2) { bestD2 = d2; bFi = fi; bTi = ti; bT = tt; }
          }
        }
        this.fromIdx = bFi; this.toIdx = bTi; this.t = bT;
        const fn = nodes[bFi], tn = nodes[bTi];
        const sdx = tn.x - fn.x, sdz = tn.z - fn.z;
        const sl  = Math.hypot(sdx, sdz) || 1;
        const nxF = sdx / sl, nzF = sdz / sl;
        this._laneOffset = getLaneOffsetForRole(fn, tn, this._laneRole);
        this._currentLaneOffset = this._laneOffset;
        this._rx  = fn.x + sdx * bT + nzF * this._currentLaneOffset;
        this._rz  = fn.z + sdz * bT - nxF * this._currentLaneOffset;
        // _ox/_oz = 最近傍道路までの距離 (最大6mに制限して急激な復帰を防ぐ)
        this._ox  = Math.max(-6, Math.min(6, this.x - this._rx));
        this._oz  = Math.max(-6, Math.min(6, this.z - this._rz));
        this._vx  = 0; this._vz = 0;
        this._turning = false; this._turnDir = 0; this._nextToIdx = null; this._waitingAtYield = false;
      }
      return;
    }

    // ── 経路逸脱が大きい場合は即スナップ (境界・建物に挟まれた対策) ─────────
    if (Math.abs(this._ox) > 5 || Math.abs(this._oz) > 5) {
      this._ox = 0; this._oz = 0; this._vx = 0; this._vz = 0;
    }

    // ── 立ち往生検知 (赤信号停車中を除く) ──────────────────────────────────
    this._stuckCheckTimer += dt;
    if (this._stuckCheckTimer >= 2) {
      const moved = Math.hypot(this.x - this._lastCheckX, this.z - this._lastCheckZ);
      if (moved < 1.5 && !this._stoppedAtRed && !this._waitingAtYield) {
        this._stuckTimer += 2;
        if (this._stuckTimer >= 6) { this._respawn(); return; }
      } else {
        this._stuckTimer = 0;
      }
      this._lastCheckX = this.x; this._lastCheckZ = this.z;
      this._stuckCheckTimer = 0;
    }

    // ── 物理スプリング: 経路への復帰 ─────────────────────────────────────
    const SPRING = 8.0, DAMP = 6.5;
    this._vx += (-SPRING * this._ox - DAMP * this._vx) * dt;
    this._vz += (-SPRING * this._oz - DAMP * this._vz) * dt;
    this._ox += this._vx * dt;
    this._oz += this._vz * dt;

    // ── Bezier turn mode ─────────────────────────────────────────────────────
    if (this._turning) {
      this._waitingAtYield = false;
      this._turnU += (this.speed * 0.7 * dt) / this._turnArcLen;
      if (this._turnU >= 1) {
        this._turning = false;
        this._turnDir = 0;
        this._turnU   = 0;
        this._turnP3  = null;
        this._waitingAtYield = false;
        const exitFrom = this._nodes[this.fromIdx];
        const exitTo = this._nodes[this.toIdx];
        this._yaw = Math.atan2(-(exitTo.x - exitFrom.x), -(exitTo.z - exitFrom.z));
        this._steerYaw = 0;
      }
      this._updatePos();
      return;
    }

    const from = this._nodes[this.fromIdx];
    const to   = this._nodes[this.toIdx];
    const dx0 = to.x - from.x, dz0 = to.z - from.z;
    const segLen = Math.hypot(dx0, dz0);
    const fwdX = dx0 / (segLen || 1), fwdZ = dz0 / (segLen || 1);

    // ── 次方向を事前確定（t=0.5で実施）＋ターン方向に応じた車線決定 ──────
    if (this.t >= 0.5 && this._nextToIdx === null) {
      const adj2 = this._adj[this.toIdx];
      const fwd2 = adj2.filter(n => n !== this.fromIdx);
      const pool2 = fwd2.length > 0 ? fwd2 : adj2;
      this._nextToIdx = pool2[Math.floor(Math.random() * pool2.length)];

      // ターン方向を判定して目標車線を設定
      const cNode2 = this._nodes[this.toIdx];
      const nNode2 = this._nodes[this._nextToIdx];
      const dx_n2 = nNode2.x - cNode2.x, dz_n2 = nNode2.z - cNode2.z;
      const cross2 = fwdX * dz_n2 - fwdZ * dx_n2;
      const lenN2  = Math.hypot(dx_n2, dz_n2) || 1;
      if (Math.abs(cross2) > lenN2 * 0.5) {
        // 左側通行: 左折は左(外側)車線、右折は右(内側)車線
        this._laneRole = cross2 < 0 ? 'outer' : 'inner';
        this._laneOffset = getLaneOffsetForRole(from, to, this._laneRole);
      }
    }

    // 車線オフセットをスムーズに補間
    const prevOffset = this._currentLaneOffset;
    this._currentLaneOffset += (this._laneOffset - this._currentLaneOffset) * Math.min(1, dt * 2.5);

    // 車線変更ステアリング表現: 横移動速度をヨー角に変換
    const lateralVel = (this._currentLaneOffset - prevOffset) / (dt || 0.016);
    const steerTarget = Math.atan2(lateralVel, this.speed) * 1.6;
    this._steerYaw += (steerTarget - this._steerYaw) * Math.min(1, dt * 5);

    // ── 交差点の速度制御 ──────────────────────────────────────────────────
    const distToNode    = (1 - this.t) * segLen;
    const distFromStart = this.t * segLen;
    const stopLineDist = getStopDistanceForSegment(from, to);
    const stopBuffer = CAR_TYPES[this._type].bL * 0.5 + 0.35;
    const stopHoldDist = stopLineDist + stopBuffer;
    const stopT = Math.max(0, 1 - stopHoldDist / segLen);
    const isBeforeStopLine = this.t <= stopT + 0.0001;
    const ACCEL_DIST = ROAD;
    const LOOK_AHEAD = ROAD;
    const LANE_W_PED = 1.0;             // 人間は真正面のみ検知(横方向1m以内)
    const LANE_W     = ROAD / 4 - 0.5;  // 車は同車線幅で検知

    const isNS = Math.abs(dz0) > Math.abs(dx0);
    const redForMe = isNS ? trafficState.carRedNS : trafficState.carRedEW;

    let speedFactor = 1.0;
    if (redForMe && isBeforeStopLine) {
      // 停止線の手前で、車両前端が線を越えない位置まで確実に減速・停止する。
      speedFactor = Math.max(0, (distToNode - stopHoldDist) / (ROAD * 1.5));
      if (speedFactor === 0) this._stoppedAtRed = true;
    }
    // すでに停止線を越えている車は、赤に変わっても交差点を抜け切る。
    // 赤信号停止後の発進のみ加速フェーズを適用（直進青信号時は減速なし）
    if (!redForMe && this._stoppedAtRed && distFromStart < ACCEL_DIST) {
      speedFactor = Math.max(0.4, distFromStart / ACCEL_DIST);
    }

    const plannedTurnDir = getTurnDirection(this._nodes, this.fromIdx, this.toIdx, this._nextToIdx);

    // 右左折のみ予兆減速（直進は青信号で減速なし）
    if (!redForMe && plannedTurnDir !== 0 && distToNode < ROAD * 1.5) {
      speedFactor = Math.min(speedFactor, Math.max(0.55, distToNode / (ROAD * 1.5)));
    }

    let yieldForRightTurn = false;
    if (plannedTurnDir > 0 && distToNode < ROAD * 1.6) {
      for (const other of state.npcCars) {
        if (other === this) continue;
        const sameIntersection =
          (other._turning && other.fromIdx === this.toIdx) ||
          (!other._turning && other.toIdx === this.toIdx);
        if (!sameIntersection) continue;
        if (getPlannedTurnDirection(other) <= 0) continue;
        const otherDist = getDistanceToNode(other, this.toIdx);
        const otherHasPriority =
          other._turning ||
          otherDist + 0.75 < distToNode ||
          (Math.abs(otherDist - distToNode) <= 0.75 && other.fromIdx < this.fromIdx);
        if (otherHasPriority) {
          yieldForRightTurn = true;
          break;
        }
      }
    }

    if (yieldForRightTurn && isBeforeStopLine) {
      speedFactor = Math.min(speedFactor, Math.max(0, (distToNode - stopHoldDist) / ROAD));
    }
    this._waitingAtYield = yieldForRightTurn && isBeforeStopLine;

    // ── 歩行者・プレイヤー・他車への前方回避 ─────────────────────────────
    let effectiveSpeed = this.speed * speedFactor;

    for (const ped of state.pedestrians) {
      if (ped.dead) continue;
      const pdx = ped.x - this.x, pdz = ped.z - this.z;
      const ahead = pdx * fwdX + pdz * fwdZ;
      if (ahead > 0 && ahead < LOOK_AHEAD) {
        const side = Math.abs(pdx * fwdZ - pdz * fwdX);
        if (side < LANE_W_PED) {
          effectiveSpeed = Math.min(effectiveSpeed, this.speed * (ahead / LOOK_AHEAD) * 0.25);
        }
      }
    }
    if (!state.inCar) {
      const pdx = state.px - this.x, pdz = state.pz - this.z;
      const ahead = pdx * fwdX + pdz * fwdZ;
      if (ahead > 0 && ahead < LOOK_AHEAD) {
        const side = Math.abs(pdx * fwdZ - pdz * fwdX);
        if (side < LANE_W_PED) {
          effectiveSpeed = Math.min(effectiveSpeed, this.speed * (ahead / LOOK_AHEAD) * 0.25);
        }
      }
    }
    for (const other of state.npcCars) {
      if (other === this || other._turning) continue;
      const cdx = other.x - this.x, cdz = other.z - this.z;
      const ahead = cdx * fwdX + cdz * fwdZ;
      if (ahead > 0 && ahead < LOOK_AHEAD) {
        const side = Math.abs(cdx * fwdZ - cdz * fwdX);
        if (side < LANE_W) {
          effectiveSpeed = Math.min(effectiveSpeed, this.speed * (ahead / LOOK_AHEAD) * 0.3);
        }
      }
    }

    this._effectiveSpeed = effectiveSpeed;
    const nextT = this.t + (effectiveSpeed * dt) / segLen;
    if ((redForMe || yieldForRightTurn) && isBeforeStopLine) {
      this.t = Math.min(nextT, stopT);
      if (redForMe && this.t >= stopT - 0.0001) this._stoppedAtRed = true;
    } else {
      this.t = nextT;
    }

    // ── ターン開始判定 ────────────────────────────────────────────────────
    if ((!redForMe || !isBeforeStopLine) && !yieldForRightTurn && this._nextToIdx !== null && distToNode >= 0 && this.t < 1.0) {
      const cNode = this._nodes[this.toIdx];
      const nNode = this._nodes[this._nextToIdx];
      const dx_n = nNode.x - cNode.x, dz_n = nNode.z - cNode.z;
      const lenN = Math.hypot(dx_n, dz_n) || 1;
      const crossN = fwdX * dz_n - fwdZ * dx_n;
      if (Math.abs(crossN) > lenN * 0.5) {
        // 左折は早め(ROAD*0.9手前)、右折は遅め(ROAD*0.45手前)
        const earlyDist = crossN < 0 ? ROAD * 0.9 : ROAD * 0.45;
        if (distToNode < earlyDist) {
          this._updatePos();
          const nextLaneOffset = getLaneOffsetForRole(cNode, nNode, this._laneRole);
          this._startBezier(fwdX, fwdZ, this.toIdx, this._nextToIdx, nextLaneOffset);
          this._nextToIdx = null;
          return;
        }
      }
    }

    if (this.t >= 1) {
      const oldFrom  = this.fromIdx;
      const nextFrom = this.toIdx;
      let nextTo = this._nextToIdx;
      if (nextTo === null) {
        const adj  = this._adj[nextFrom];
        const fwd  = adj.filter(n => n !== oldFrom);
        const pool = fwd.length > 0 ? fwd : adj;
        nextTo = pool[Math.floor(Math.random() * pool.length)];
      }
      this._nextToIdx    = null;
      this._stoppedAtRed = false;  // 新セグメント開始でリセット
      this._waitingAtYield = false;

      const curNode  = this._nodes[nextFrom];
      const nextNode = this._nodes[nextTo];
      const dx_new = nextNode.x - curNode.x, dz_new = nextNode.z - curNode.z;
      const lenNew  = Math.hypot(dx_new, dz_new) || 1;
      const cross   = fwdX * dz_new - fwdZ * dx_new;

      if (Math.abs(cross) > lenNew * 0.5) {
        // 交差点でカーブ（Bezierアーク）— P0 をノード中心の自車線位置にスナップ
        const oldRX = fwdZ, oldRZ = -fwdX;
        this.x = curNode.x + oldRX * this._laneOffset;
        this.z = curNode.z + oldRZ * this._laneOffset;
        const nextLaneOffset = getLaneOffsetForRole(curNode, nextNode, this._laneRole);
        this._startBezier(fwdX, fwdZ, nextFrom, nextTo, nextLaneOffset);
      } else {
        // 直進
        this.t       = 0;
        this.fromIdx = nextFrom;
        this.toIdx   = nextTo;
        this._laneOffset = getLaneOffsetForRole(curNode, nextNode, this._laneRole);
        this._currentLaneOffset = this._laneOffset;
      }
    }

    this._updatePos();
  }
}

// ── Pedestrian class ──────────────────────────────────────────────────────────
const PED_COLORS = [
  [0xcc6633, 0x334477], [0xffccaa, 0x553311], [0xaa8866, 0x224422],
  [0xffe0cc, 0x770022], [0x886644, 0x115511],
];

export class Pedestrian {
  constructor(scene, x, z) {
    this.x = x;
    this.z = z;
    this.homeX = x;
    this.homeZ = z;
    this.speed = 1.2 + Math.random() * 0.8;
    this.dir   = Math.random() * Math.PI * 2;
    this.walkPhase = Math.random() * Math.PI * 2;
    this.turnTimer = 2 + Math.random() * 4;

    this.mesh = this._buildMesh(scene);
    this.mesh.userData.entity = this;
    this.mesh.position.set(x, SIDEWALK_H, z);
  }

  _buildMesh(scene) {
    const g = new THREE.Group();
    const [skinC, shirtC] = PED_COLORS[Math.floor(Math.random() * PED_COLORS.length)];
    const skin  = matStd(skinC, { roughness: 0.9 });
    const shirt = matStd(shirtC, { roughness: 0.9 });
    const pants = matStd(0x223344, { roughness: 0.9 });
    const shoe  = matStd(0x111111, { roughness: 0.9 });

    function mb(w, h, d, mat) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.castShadow = true;
      return m;
    }

    // Same scale as player

    const torso = mb(0.5, 0.65, 0.25, shirt);
    torso.position.y = 0.95; g.add(torso);

    const head = mb(0.38, 0.36, 0.32, skin);
    head.position.y = 1.53; g.add(head);

    // Arms
    this.lArm = new THREE.Group(); this.lArm.position.set(-0.32, 1.25, 0); g.add(this.lArm);
    const la = mb(0.14, 0.55, 0.14, shirt); la.position.y = -0.27; this.lArm.add(la);

    this.rArm = new THREE.Group(); this.rArm.position.set(0.32, 1.25, 0); g.add(this.rArm);
    const ra = mb(0.14, 0.55, 0.14, shirt); ra.position.y = -0.27; this.rArm.add(ra);

    // Legs
    this.lLeg = new THREE.Group(); this.lLeg.position.set(-0.14, 0.62, 0); g.add(this.lLeg);
    const ll = mb(0.18, 0.55, 0.18, pants); ll.position.y = -0.27; this.lLeg.add(ll);
    const lf = mb(0.16, 0.1, 0.28, shoe); lf.position.set(0, -0.6, 0.05); this.lLeg.add(lf);

    this.rLeg = new THREE.Group(); this.rLeg.position.set(0.14, 0.62, 0); g.add(this.rLeg);
    const rl = mb(0.18, 0.55, 0.18, pants); rl.position.y = -0.27; this.rLeg.add(rl);
    const rf = mb(0.16, 0.1, 0.28, shoe); rf.position.set(0, -0.6, 0.05); this.rLeg.add(rf);

    scene.add(g);
    return g;
  }

  update(dt) {
    if (this.dead) {
      this.deadTimer = Math.max(0, this.deadTimer - dt);
      this._fallSpeed = Math.min(2.2, (this._fallSpeed || 1.0) + dt * 3.0);
      this.mesh.rotation.x = Math.min(Math.PI / 2, this.mesh.rotation.x + dt * 2.6);
      this.mesh.rotation.z *= 0.96;
      this.mesh.position.y = Math.max(0.04, this.mesh.position.y - this._fallSpeed * dt * 0.12);
      if (this.deadTimer <= 0) this.mesh.visible = false;
      return;
    }

    // 遠くの歩行者はスキップ (距離カリング: >140m)
    const _dpx = this.x - state.px, _dpz = this.z - state.pz;
    if (_dpx * _dpx + _dpz * _dpz > 140 * 140) return;

    this.turnTimer -= dt;
    if (this.turnTimer <= 0) {
      const dirs8 = [0, Math.PI/4, Math.PI/2, 3*Math.PI/4, Math.PI, -3*Math.PI/4, -Math.PI/2, -Math.PI/4];
      this.dir = dirs8[Math.floor(Math.random() * 8)];
      this.turnTimer = 2 + Math.random() * 5;
    }

    // Steer back toward home block if drifted too far
    const homeDist = Math.hypot(this.x - this.homeX, this.z - this.homeZ);
    if (homeDist > BLOCK * 0.45) {
      const hdx = this.homeX - this.x, hdz = this.homeZ - this.z;
      this.dir = Math.atan2(hdx, hdz) + (Math.random() - 0.5) * 0.4;
      this.turnTimer = 1.5 + Math.random() * 2;
    }

    // 次フレームの位置が道路ゾーンに入るか確認
    const nx = this.x + Math.sin(this.dir) * this.speed * dt;
    const nz = this.z + Math.cos(this.dir) * this.speed * dt;
    const nfX = ((nx % CELL) + CELL) % CELL;
    const nfZ = ((nz % CELL) + CELL) % CELL;
    const blockedRail = isRailRoadZone(nx);
    // 歩行者は常に車道ゾーンへ踏み込まない
    const blocked = nfX < ROAD || nfZ < ROAD || blockedRail;

    if (!blocked) {
      this.x = nx;
      this.z = nz;

      // Keep off roads — redirect if already on road zone
      const fracX = (this.x % CELL + CELL) % CELL;
      const fracZ = (this.z % CELL + CELL) % CELL;
      const onRailRoad = isRailRoadZone(this.x);
      if ((fracX < ROAD && fracZ < ROAD) || onRailRoad) {
        const hdx = this.homeX - this.x, hdz = this.homeZ - this.z;
        const ang = Math.atan2(hdx, hdz);
        const dirs8 = [0, Math.PI/4, Math.PI/2, 3*Math.PI/4, Math.PI, -3*Math.PI/4, -Math.PI/2, -Math.PI/4];
        this.dir = dirs8.reduce((best, d) => {
          const da = Math.abs(((d - ang) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
          const ba = Math.abs(((best - ang) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
          return da < ba ? d : best;
        }, dirs8[0]);
      } else if (fracX < ROAD) {
        this.dir = Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2;
      } else if (fracZ < ROAD || onRailRoad) {
        this.dir = Math.random() < 0.5 ? 0 : Math.PI;
      }

      const margin = BLOCK * 0.6;
      this.x = Math.max(Math.max(2, this.homeX - margin), Math.min(Math.min(WORLD - 2, this.homeX + margin), this.x));
      this.z = Math.max(Math.max(2, this.homeZ - margin), Math.min(Math.min(WORLD - 2, this.homeZ + margin), this.z));
    }

    // アニメーション（停止中は止める）
    this.walkPhase += blocked ? 0 : dt * this.speed * 2.5;
    const s = Math.sin(this.walkPhase);
    const amp = 0.55;
    this.lArm.rotation.x =  s * amp;
    this.rArm.rotation.x = -s * amp;
    this.lLeg.rotation.x = -s * amp;
    this.rLeg.rotation.x =  s * amp;

    this.mesh.position.set(this.x, SIDEWALK_H, this.z);
    this.mesh.rotation.y = this.dir;
  }
}

// ── Spawn NPCs ────────────────────────────────────────────────────────────────
export function spawnNPCs(scene) {
  const r = rng(42);

  // 全道路セグメントに均等配置 (横断30 + 縦断30 = 60セグメント)
  const N6 = GRID + 1;
  const segs = [];
  for (let j = 0; j <= GRID; j++)
    for (let i = 0; i < GRID; i++)
      segs.push([j * N6 + i, j * N6 + (i + 1)]);   // 横セグメント
  for (let j = 0; j < GRID; j++)
    for (let i = 0; i <= GRID; i++)
      segs.push([j * N6 + i, (j + 1) * N6 + i]);   // 縦セグメント
  // シャッフル (シード済みRNG)
  for (let i = segs.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [segs[i], segs[j]] = [segs[j], segs[i]];
  }
  const carCount = Math.min(72, Math.ceil(segs.length * 1.2));
  for (let i = 0; i < carCount; i++) {
    const [fi, ti] = segs[i % segs.length];
    const car = new TrafficCar(scene, fi, ti, 0.1 + r() * 0.8);
    state.npcCars.push(car);
  }

  // Pedestrians — evenly distributed across all 25 blocks (1-2 per block)
  const sw = SIDEWALK_W;
  for (let bj = 0; bj < GRID; bj++) {
    for (let bi = 0; bi < GRID; bi++) {
      const bx = bi * CELL + ROAD;
      const bz = bj * CELL + ROAD;
      const westInset = bi === RAIL_ROAD_I ? RAIL_EXT_W : 0;
      const eastInset = bi === RAIL_ROAD_I - 1 ? RAIL_EXT_W : 0;
      // Place ~6 pedestrians per block on the 4 sidewalk strips
      const count = 6;
      for (let k = 0; k < count; k++) {
        const side = (k + Math.floor(r() * 2)) % 4;
        let px, pz;
        if (side === 0) { px = bx + sw * 0.5 + westInset; pz = bz + sw + r() * (BLOCK - sw * 2); }
        else if (side === 1) { px = bx + BLOCK - sw * 0.5 - eastInset; pz = bz + sw + r() * (BLOCK - sw * 2); }
        else if (side === 2) { px = bx + sw + r() * (BLOCK - sw * 2); pz = bz + sw * 0.5; }
        else { px = bx + sw + r() * (BLOCK - sw * 2); pz = bz + BLOCK - sw * 0.5; }
        const ped = new Pedestrian(scene, px, pz);
        state.pedestrians.push(ped);
      }
    }
  }
}

// ── 正確な2D OBB SAT衝突判定 ─────────────────────────────────────────────────
// 重なりがあれば { overlap, nx, nz } を返す（BをAから押し出す方向がnx,nz）
// 重なりなければ null
function getOBBPenetration(ax, az, ayaw, tpA, bx, bz, byaw, tpB) {
  const hLA = tpA.bL * 0.5, hWA = tpA.bW * 0.5;
  const hLB = tpB.bL * 0.5, hWB = tpB.bW * 0.5;
  const dx = bx - ax, dz = bz - az;
  const sA = Math.sin(ayaw), cA = Math.cos(ayaw);
  const sB = Math.sin(byaw), cB = Math.cos(byaw);

  // 4軸: A前方向, A右方向, B前方向, B右方向
  const axes = [[-sA, -cA], [cA, -sA], [-sB, -cB], [cB, -sB]];

  let minSep = Infinity, bestNx = 1, bestNz = 0;
  for (const [nx, nz] of axes) {
    const extA = Math.abs(-sA * nx - cA * nz) * hLA + Math.abs(cA * nx - sA * nz) * hWA;
    const extB = Math.abs(-sB * nx - cB * nz) * hLB + Math.abs(cB * nx - sB * nz) * hWB;
    const proj = dx * nx + dz * nz;
    const sep  = extA + extB - Math.abs(proj);
    if (sep <= 0) return null;  // 分離軸あり → 衝突なし
    if (sep < minSep) {
      minSep = sep;
      // BをAから押し出す方向に合わせる
      const sign = proj >= 0 ? 1 : -1;
      bestNx = nx * sign;
      bestNz = nz * sign;
    }
  }
  return { overlap: minSep + 0.15, nx: bestNx, nz: bestNz };
}

// ── 車OBBを建物AABBから押し出す ───────────────────────────────────────────────
function pushCarFromBuildings(x, z, yaw, tp) {
  const halfMax = Math.max(tp.bL, tp.bW) * 0.5 + 0.3;
  for (const b of state.buildingBoxes) {
    // 粗い距離チェックで早期リターン
    if (x + halfMax < b.x1 || x - halfMax > b.x2 ||
        z + halfMax < b.z1 || z - halfMax > b.z2) continue;

    // 車の中心が建物内部にある場合: 最近傍の辺に向けて押し出す
    if (x > b.x1 && x < b.x2 && z > b.z1 && z < b.z2) {
      const opts = [
        { dx: b.x1 - x, dz: 0 },
        { dx: b.x2 - x, dz: 0 },
        { dx: 0, dz: b.z1 - z },
        { dx: 0, dz: b.z2 - z },
      ];
      const best = opts.reduce((a, c) =>
        Math.hypot(a.dx, a.dz) < Math.hypot(c.dx, c.dz) ? a : c
      );
      const len = Math.hypot(best.dx, best.dz) || 0.001;
      const bn  = Math.atan2(best.dx, best.dz);
      const ext = Math.abs(Math.cos(bn - yaw)) * tp.bL * 0.5
               + Math.abs(Math.sin(bn - yaw)) * tp.bW * 0.5 + 0.2;
      x += (best.dx / len) * (len + ext);
      z += (best.dz / len) * (len + ext);
      continue;
    }

    // 車の外側: AABBの最近傍点からの距離でOBB押し出し
    const cx = Math.max(b.x1, Math.min(x, b.x2));
    const cz = Math.max(b.z1, Math.min(z, b.z2));
    const dx = x - cx, dz = z - cz;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.001) continue;
    const dir = Math.atan2(dx, dz);
    const ext = Math.abs(Math.cos(dir - yaw)) * tp.bL * 0.5
              + Math.abs(Math.sin(dir - yaw)) * tp.bW * 0.5 + 0.2;
    if (dist < ext) {
      x += (dx / dist) * (ext - dist);
      z += (dz / dist) * (ext - dist);
    }
  }
  return { x, z };
}

// ── 全車衝突解決 ─────────────────────────────────────────────────────────────
function resolveCarCollisions() {
  const cars = state.npcCars;
  const N    = cars.length;
  // プレイヤー付近のみ衝突解決 (遠方はスキップ)
  const COL_RANGE_SQ = 80 * 80;

  // ─ プレイヤー車 vs NPC (2パス) ───────────────────────────────────────────
  if (state.inCar && state.inCar.mesh) {
    const pcar  = state.inCar;
    const ptp   = CAR_TYPES[pcar._type ?? 0] ?? CAR_TYPES[0];
    const pyaw  = pcar.mesh.rotation.y;
    const pMass = ptp.mass * 1.5;
    const pSpd  = pcar._drivingSpeed ?? 0;
    const pfwdX = -Math.sin(pyaw), pfwdZ = -Math.cos(pyaw);

    for (const B of cars) {
      if (B === pcar || !B.mesh) continue;
      // プレイヤーから遠い車はスキップ
      const _bx = B.x - state.px, _bz = B.z - state.pz;
      if (_bx * _bx + _bz * _bz > COL_RANGE_SQ) continue;
      const tpB  = CAR_TYPES[B._type];
      const pen  = getOBBPenetration(
        pcar.mesh.position.x, pcar.mesh.position.z, pyaw, ptp,
        B.x, B.z, B._yaw, tpB);
      if (!pen) continue;

      const { overlap, nx, nz } = pen;
      const mTot = pMass + tpB.mass;

      // 位置分離
      pcar.mesh.position.x -= nx * overlap * (tpB.mass / mTot);
      pcar.mesh.position.z -= nz * overlap * (tpB.mass / mTot);
      state.px = pcar.mesh.position.x;
      state.pz = pcar.mesh.position.z;
      if ('x' in pcar) { pcar.x = state.px; pcar.z = state.pz; }
      B.x += nx * overlap * (pMass / mTot);
      B.z += nz * overlap * (pMass / mTot);
      B.mesh.position.set(B.x, 0.33, B.z);

      if (B._kbTimer > 0) {
        // ノックバック中: プレイヤー方向に向かう速度成分をキャンセル
        const vnB = B._kbvx * nx + B._kbvz * nz;
        if (vnB < 0) { B._kbvx -= vnB * nx; B._kbvz -= vnB * nz; }
      } else {
        B._ox = B.x - B._rx;
        B._oz = B.z - B._rz;
      }

      // インパルス: NPC がノックバック中でない場合のみ
      if (B._kbTimer <= 0) {
        const playerVn = pfwdX * nx * pSpd + pfwdZ * nz * pSpd;
        const npcVn    = (-Math.sin(B._yaw) * nx + -Math.cos(B._yaw) * nz) * (B._effectiveSpeed ?? B.speed);
        const relV = playerVn - npcVn;
        if (relV >= 0.5) {
          const RESTIT  = 0.25;
          const impulse = (1 + RESTIT) * relV * pMass * tpB.mass / mTot;
          const npcDv   = impulse / tpB.mass;
          B._kbvx = nx * npcDv;
          B._kbvz = nz * npcDv;
          B._kbTimer = 2.0;
          const npcFwdX = -Math.sin(B._yaw), npcFwdZ = -Math.cos(B._yaw);
          B._kbRotSpd   = (nx * npcFwdZ - nz * npcFwdX) * npcDv * 0.18;
          pcar._drivingSpeed = Math.max(0, pSpd - (impulse / pMass) * 0.6);
        }
      }
    }
  }

  // ─ NPC vs NPC (2パスで安定化) ────────────────────────────────────────────
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < N; i++) {
      const A = cars[i];
      if (!A.mesh || A.driver === 'player') continue;
      const tpA = CAR_TYPES[A._type];

      for (let j = i + 1; j < N; j++) {
        const B = cars[j];
        if (!B.mesh || B.driver === 'player') continue;
        if (A._kbTimer > 0 && B._kbTimer > 0) continue;
        // 両方ともプレイヤーから遠い場合はスキップ
        const _ajx = A.x - state.px, _ajz = A.z - state.pz;
        if (_ajx * _ajx + _ajz * _ajz > COL_RANGE_SQ) continue;
        const tpB = CAR_TYPES[B._type];

        const pen = getOBBPenetration(A.x, A.z, A._yaw, tpA, B.x, B.z, B._yaw, tpB);
        if (!pen) continue;

        const { overlap, nx, nz } = pen;
        const mA = tpA.mass, mB = tpB.mass, mTot = mA + mB;

        // 位置分離
        A.x -= nx * overlap * (mB / mTot);
        A.z -= nz * overlap * (mB / mTot);
        B.x += nx * overlap * (mA / mTot);
        B.z += nz * overlap * (mA / mTot);
        A.mesh.position.set(A.x, 0.33, A.z);
        B.mesh.position.set(B.x, 0.33, B.z);

        // ノックバック速度キャンセル or オフセット同期
        if (A._kbTimer > 0) {
          const vnA = A._kbvx * nx + A._kbvz * nz;
          if (vnA > 0) { A._kbvx -= vnA * nx; A._kbvz -= vnA * nz; }
        } else {
          A._ox = A.x - A._rx;
          A._oz = A.z - A._rz;
        }
        if (B._kbTimer > 0) {
          const vnB = B._kbvx * nx + B._kbvz * nz;
          if (vnB < 0) { B._kbvx -= vnB * nx; B._kbvz -= vnB * nz; }
        } else {
          B._ox = B.x - B._rx;
          B._oz = B.z - B._rz;
        }

        // インパルス: 両方ノックバック中でない場合のみ (1パス目のみ)
        if (pass === 0 && A._kbTimer <= 0 && B._kbTimer <= 0) {
          const aVn = (-Math.sin(A._yaw) * nx + -Math.cos(A._yaw) * nz) * (A._effectiveSpeed ?? A.speed);
          const bVn = (-Math.sin(B._yaw) * nx + -Math.cos(B._yaw) * nz) * (B._effectiveSpeed ?? B.speed);
          const relV = aVn - bVn;
          if (relV >= 0.5) {
            const RESTIT  = 0.2;
            const impulse = (1 + RESTIT) * relV * mA * mB / mTot;
            const aDv = impulse / mA, bDv = impulse / mB;
            A._kbvx = -nx * aDv; A._kbvz = -nz * aDv; A._kbTimer = 1.5;
            B._kbvx =  nx * bDv; B._kbvz =  nz * bDv; B._kbTimer = 1.5;
            const aFwdX = -Math.sin(A._yaw), aFwdZ = -Math.cos(A._yaw);
            const bFwdX = -Math.sin(B._yaw), bFwdZ = -Math.cos(B._yaw);
            A._kbRotSpd = -(nx * aFwdZ - nz * aFwdX) * aDv * 0.18;
            B._kbRotSpd =  (nx * bFwdZ - nz * bFwdX) * bDv * 0.18;
          }
        }
      }
    }
  }

  // ─ 全NPC車を建物・ワールド境界から押し出す ────────────────────────────────
  for (const car of cars) {
    if (!car.mesh || car.driver === 'player') continue;
    const tp = CAR_TYPES[car._type];
    const r  = pushCarFromBuildings(car.x, car.z, car._yaw, tp);
    car.x = Math.max(1, Math.min(WORLD + ROAD - 1, r.x));
    car.z = Math.max(1, Math.min(WORLD + ROAD - 1, r.z));
    if (car._kbTimer <= 0) {
      car._ox = car.x - car._rx;
      car._oz = car.z - car._rz;
    }
    car.mesh.position.set(car.x, 0.33, car.z);
  }

  // プレイヤー車も建物から押し出す
  if (state.inCar && state.inCar.mesh) {
    const pcar = state.inCar;
    const ptp  = CAR_TYPES[pcar._type ?? 0] ?? CAR_TYPES[0];
    const r    = pushCarFromBuildings(state.px, state.pz, pcar.mesh.rotation.y, ptp);
    pcar.mesh.position.x = r.x;
    pcar.mesh.position.z = r.z;
    state.px = r.x; state.pz = r.z;
    if ('x' in pcar) { pcar.x = r.x; pcar.z = r.z; }
  }
}

// ── Update all NPCs ───────────────────────────────────────────────────────────
export function updateNPCs(dt) {
  for (const c of state.npcCars) c.update(dt);
  for (const p of state.pedestrians) p.update(dt);
  resolveCarCollisions();
}
