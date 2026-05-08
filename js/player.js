import * as THREE from 'three';
import {
  state, CELL, ROAD, WORLD,
  CAM_R, CAM_PITCH_MAX, CAM_PITCH_MIN,
  PLAYER_H, PLAYER_R, WALK_SPD, RUN_SPD, SIDEWALK_H, ROAD_Y,
  raiseWanted
} from './config.js?v=20260508-5';
import { matStd } from './textures.js?v=20260508-5';
import { resolveAABB } from './physics.js?v=20260508-5';

let _playerGroundY = ROAD_Y;
let _jumpVel = 0;
const GRAVITY = 18;

function getGroundY(x, z) {
  for (const ramp of state.ramps) {
    if (x >= ramp.x1 && x <= ramp.x2 && z >= ramp.z1 && z <= ramp.z2) {
      const t = ramp.axis === 'z'
        ? (z - ramp.z1) / (ramp.z2 - ramp.z1)
        : (x - ramp.x1) / (ramp.x2 - ramp.x1);
      return ramp.yBase + t * (ramp.yTop - ramp.yBase);
    }
  }

  const CW = WORLD + ROAD;
  if (z >= CW) {
    const d = z - CW;
    if (d < 5) return 0.05;
    if (d < 19) return -0.10;
    return -0.38;
  }
  if (x >= CW) {
    const d = x - CW;
    if (d < 5) return 0.05;
    if (d < 19) return -0.10;
    return -0.38;
  }

  const fracX = ((x % CELL) + CELL) % CELL;
  const fracZ = ((z % CELL) + CELL) % CELL;
  let gY = (fracX >= ROAD && fracZ >= ROAD) ? (ROAD_Y + SIDEWALK_H + 0.06) : ROAD_Y;

  if (_playerGroundY > 0.5) {
    for (const b of state.buildingBoxes) {
      if (b.y2 > gY && b.y2 <= _playerGroundY + 1.5 && x >= b.x1 && x <= b.x2 && z >= b.z1 && z <= b.z2) {
        gY = b.y2;
      }
    }
  }
  return gY;
}

export let playerGroup;
let joints = {};
let weaponMesh = null;
let weaponMount = null;

function mb(w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true;
  return m;
}

function pivot(y) {
  const g = new THREE.Group();
  g.position.y = y;
  return g;
}

const aimDir = new THREE.Vector3();
const aimPos = new THREE.Vector3();
const aimTo = new THREE.Vector3();
const shotFlash = { timer: 0 };

export function canShoot() {
  return !state.gameOver && state.weaponCooldown <= 0 && state.ammo > 0;
}

function getAimPoint(entity, out) {
  entity.mesh.getWorldPosition(out);
  if (entity.kind === 'pedestrian') out.y += 0.9;
  else if (entity.kind === 'police') out.y += 1.0;
  else out.y += 0.8;
  return out;
}

function pickAutoAimTarget(camera) {
  const candidates = [];

  for (const ped of state.pedestrians) {
    if (!ped.dead && ped.mesh?.visible !== false) candidates.push(ped);
  }
  for (const cop of state.policeUnits) {
    if (!cop.dead && cop.mesh?.visible !== false) candidates.push(cop);
  }

  let best = null;
  let bestScore = Infinity;
  camera.getWorldDirection(aimDir);

  for (const entity of candidates) {
    const pos = getAimPoint(entity, aimPos);
    aimTo.copy(pos).sub(camera.position);
    const dist = aimTo.length();
    if (dist > 45 || dist < 0.001) continue;
    aimTo.multiplyScalar(1 / dist);
    const dot = aimDir.dot(aimTo);
    if (dot < 0.45) continue;

    const score = (1 - dot) * 4 + dist * 0.03;
    if (score < bestScore) {
      best = entity;
      bestScore = score;
    }
  }

  return best;
}

export function getAutoAimTarget(camera) {
  return pickAutoAimTarget(camera);
}

export function shootWeapon(camera, notify) {
  if (state.gameOver || state.inCar) return false;
  if (state.ammo <= 0) {
    notify?.('弾切れ');
    return false;
  }
  if (state.weaponCooldown > 0) return false;

  state.ammo--;
  state.weaponCooldown = 0.18;
  shotFlash.timer = 0.12;

  const entity = pickAutoAimTarget(camera);
  if (!entity) {
    notify?.('パンッ');
    return true;
  }

  if (entity.kind === 'pedestrian' && !entity.dead) {
    entity.dead = true;
    entity.deadTimer = 2.8;
    entity._fallSpeed = 1.1;
    entity.mesh.visible = true;
    entity.mesh.rotation.set(-0.2, entity.mesh.rotation.y, entity.mesh.rotation.z);
    entity.mesh.rotation.z += (Math.random() < 0.5 ? -1 : 1) * 0.35;
    entity.mesh.position.y = 0.08;
    raiseWanted(1);
    notify?.('歩行者を撃った');
    return true;
  }

  if (entity.kind === 'police' && !entity.dead) {
    entity.hp = Math.max(0, entity.hp - 100);
    entity.dead = true;
    entity.deadTimer = 2.5;
    entity._fallSpeed = 1.0;
    entity._hitFlash = 0.18;
    entity.mesh.visible = true;
    entity.mesh.rotation.set(-0.15, entity.mesh.rotation.y, entity.mesh.rotation.z);
    entity.mesh.rotation.z += (Math.random() < 0.5 ? -1 : 1) * 0.3;
    entity.mesh.position.y = 0.08;
    raiseWanted(2);
    notify?.('警官を倒した');
    return true;
  }

  notify?.('パンッ');
  return true;
}


function updateAimMarker(camera) {
  let marker = document.getElementById('aim-marker');
  if (!marker) {
    marker = document.createElement('div');
    marker.id = 'aim-marker';
    marker.textContent = '◆';
    marker.style.cssText = 'position:fixed;left:0;top:0;transform:translate(-50%,-50%);color:#0f0;text-shadow:0 0 6px #000;font:700 18px Courier New, monospace;pointer-events:none;z-index:25;';
    document.body.appendChild(marker);
  }

  const entity = pickAutoAimTarget(camera);
  if (!entity) {
    marker.style.display = 'none';
    return;
  }
  marker.style.display = 'block';

  const pos = getAimPoint(entity, aimPos);
  const v = pos.clone().project(camera);
  const x = (v.x * 0.5 + 0.5) * window.innerWidth;
  const y = (-v.y * 0.5 + 0.5) * window.innerHeight - 28;
  marker.style.left = x + 'px';
  marker.style.top = y + 'px';
}

export function updateShotFeedback(dt) {
  if (shotFlash.timer > 0) {
    shotFlash.timer = Math.max(0, shotFlash.timer - dt);
    let flash = document.getElementById('muzzle-flash');
    if (!flash) {
      flash = document.createElement('div');
      flash.id = 'muzzle-flash';
      flash.style.cssText = 'position:fixed;left:50%;top:50%;width:22px;height:22px;transform:translate(-50%,-50%);border-radius:50%;background:radial-gradient(circle, rgba(255,240,180,1) 0%, rgba(255,180,40,0.85) 40%, rgba(255,120,0,0) 80%);pointer-events:none;z-index:24;';
      document.body.appendChild(flash);
    }
    flash.style.display = 'block';
    flash.style.opacity = String(shotFlash.timer / 0.12);
  } else {
    const flash = document.getElementById('muzzle-flash');
    if (flash) flash.style.display = 'none';
  }
}

export function createPlayer(scene) {
  playerGroup = new THREE.Group();
  playerGroup.userData.entity = { kind: 'player' };

  weaponMount = new THREE.Group();
  weaponMount.position.set(0.05, -0.28, 0.10);
  weaponMount.rotation.set(-0.14, 0.18, 0.34);

  weaponMesh = new THREE.Group();
  const gunBody = mb(0.34, 0.14, 0.62, matStd(0x222222, { roughness: 0.35, metalness: 0.35 }));
  gunBody.position.set(0.06, -0.03, 0.02);
  weaponMesh.add(gunBody);

  const barrel = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, 0.42, 10),
    matStd(0x444444, { roughness: 0.25, metalness: 0.6 })
  );
  barrel.castShadow = true;
  barrel.rotation.z = Math.PI / 2;
  barrel.position.set(0.22, -0.03, 0.02);
  weaponMesh.add(barrel);

  const grip = mb(0.12, 0.18, 0.20, matStd(0x1b1b1b, { roughness: 0.5, metalness: 0.2 }));
  grip.position.set(-0.03, -0.14, -0.02);
  grip.rotation.x = -0.35;
  weaponMesh.add(grip);

  weaponMesh.position.set(0.02, -0.02, -0.04);
  weaponMesh.rotation.set(0.10, Math.PI * 0.5, -0.18);
  weaponMount.add(weaponMesh);

  const skin = matStd(0xffcc99, { roughness: 0.9 });
  const shirt = matStd(0x2255cc, { roughness: 0.9 });
  const pants = matStd(0x223355, { roughness: 0.9 });
  const shoe = matStd(0x111111, { roughness: 0.9 });
  const hair = matStd(0x332211, { roughness: 0.9 });

  // Torso
  const torso = mb(0.5, 0.65, 0.25, shirt);
  torso.position.y = 0.95;
  playerGroup.add(torso);

  // Head
  const head = mb(0.38, 0.38, 0.32, skin);
  head.position.y = 1.56;
  playerGroup.add(head);
  const headHair = mb(0.40, 0.12, 0.34, hair);
  headHair.position.set(0, 1.74, 0);
  playerGroup.add(headHair);

  // Neck
  const neck = mb(0.14, 0.14, 0.14, skin);
  neck.position.y = 1.37;
  playerGroup.add(neck);

  // Face
  const eyeMat = matStd(0x111111, { roughness: 0.9 });
  const lEye = mb(0.08, 0.08, 0.04, eyeMat);
  lEye.position.set(-0.09, 1.59, 0.17);
  playerGroup.add(lEye);
  const rEye = mb(0.08, 0.08, 0.04, eyeMat);
  rEye.position.set(0.09, 1.59, 0.17);
  playerGroup.add(rEye);
  const nose = mb(0.05, 0.04, 0.06, matStd(0xeebb99, { roughness: 0.9 }));
  nose.position.set(0, 1.49, 0.18);
  playerGroup.add(nose);

  // Arms
  const lShoulderPiv = pivot(1.25);
  lShoulderPiv.position.x = -0.32;
  playerGroup.add(lShoulderPiv);
  const lUpperArm = mb(0.16, 0.38, 0.16, shirt);
  lUpperArm.position.y = -0.19;
  lShoulderPiv.add(lUpperArm);
  const lElbowPiv = pivot(-0.38);
  lShoulderPiv.add(lElbowPiv);
  const lForeArm = mb(0.14, 0.34, 0.14, skin);
  lForeArm.position.y = -0.17;
  lElbowPiv.add(lForeArm);

  const rShoulderPiv = pivot(1.25);
  rShoulderPiv.position.x = 0.32;
  playerGroup.add(rShoulderPiv);
  const rUpperArm = mb(0.16, 0.38, 0.16, shirt);
  rUpperArm.position.y = -0.19;
  rShoulderPiv.add(rUpperArm);
  const rElbowPiv = pivot(-0.38);
  rShoulderPiv.add(rElbowPiv);
  const rForeArm = mb(0.14, 0.34, 0.14, skin);
  rForeArm.position.y = -0.17;
  rElbowPiv.add(rForeArm);

  // Legs
  const lHipPiv = pivot(0.62);
  lHipPiv.position.x = -0.14;
  playerGroup.add(lHipPiv);
  const lThigh = mb(0.2, 0.44, 0.2, pants);
  lThigh.position.y = -0.22;
  lHipPiv.add(lThigh);
  const lKneePiv = pivot(-0.44);
  lHipPiv.add(lKneePiv);
  const lShin = mb(0.16, 0.4, 0.16, pants);
  lShin.position.y = -0.2;
  lKneePiv.add(lShin);
  const lFoot = mb(0.17, 0.1, 0.3, shoe);
  lFoot.position.set(0, -0.45, 0.06);
  lKneePiv.add(lFoot);

  const rHipPiv = pivot(0.62);
  rHipPiv.position.x = 0.14;
  playerGroup.add(rHipPiv);
  const rThigh = mb(0.2, 0.44, 0.2, pants);
  rThigh.position.y = -0.22;
  rHipPiv.add(rThigh);
  const rKneePiv = pivot(-0.44);
  rHipPiv.add(rKneePiv);
  const rShin = mb(0.16, 0.4, 0.16, pants);
  rShin.position.y = -0.2;
  rKneePiv.add(rShin);
  const rFoot = mb(0.17, 0.1, 0.3, shoe);
  rFoot.position.set(0, -0.45, 0.06);
  rKneePiv.add(rFoot);

  joints = { lShoulderPiv, rShoulderPiv, lElbowPiv, rElbowPiv, lHipPiv, rHipPiv, lKneePiv, rKneePiv };
  rShoulderPiv.rotation.z = -0.14;
  rElbowPiv.rotation.z = 0.18;
  rForeArm.add(weaponMount);

  playerGroup.position.set(state.px, 0, state.pz);
  scene.add(playerGroup);
  return playerGroup;
}

function animateWalk(speed) {
  if (speed < 0.5) {
    for (const j of Object.values(joints)) j.rotation.x = 0;
    return;
  }
  state.walkPhase += speed * 0.07;
  const s = Math.sin(state.walkPhase);
  const amp = Math.min(0.75, speed * 0.06);

  joints.lShoulderPiv.rotation.x = s * amp;
  joints.rShoulderPiv.rotation.x = -s * amp;
  joints.lElbowPiv.rotation.x = -Math.abs(s) * amp * 0.6;
  joints.rElbowPiv.rotation.x = -Math.abs(s) * amp * 0.6;
  joints.lHipPiv.rotation.x = -s * amp * 1.1;
  joints.rHipPiv.rotation.x = s * amp * 1.1;
  joints.lKneePiv.rotation.x = Math.max(0, -s) * amp * 1.0;
  joints.rKneePiv.rotation.x = Math.max(0, s) * amp * 1.0;
}

export function updatePlayer(dt, camera) {
  if (state.weaponCooldown > 0) state.weaponCooldown = Math.max(0, state.weaponCooldown - dt);
  updateAimMarker(camera);
  updateShotFeedback(dt);

  if (state.inCar) {
    if (weaponMount) weaponMount.visible = false;
    updateDriving(dt, camera);
    return;
  }

  if (weaponMount) {
    weaponMount.visible = true;
    weaponMount.rotation.y = 0.08;
    weaponMount.rotation.z = 0.2 + Math.sin(state.walkPhase * 0.7) * 0.02;
    weaponMount.rotation.x = -0.2 + Math.sin(state.weaponCooldown * 40) * 0.015;
  }

  const k = state.keys;
  const spd = (k['ShiftLeft'] || k['ShiftRight']) ? RUN_SPD : WALK_SPD;
  const yaw = state.camYaw;

  const fwdX = Math.sin(yaw);
  const fwdZ = Math.cos(yaw);
  const rgtX = -fwdZ;
  const rgtZ = fwdX;

  let mx = 0, mz = 0;
  if (k['KeyW'] || k['ArrowUp']) mx += fwdX, mz += fwdZ;
  if (k['KeyS'] || k['ArrowDown']) mx -= fwdX, mz -= fwdZ;
  if (k['KeyA'] || k['ArrowLeft']) mx -= rgtX, mz -= rgtZ;
  if (k['KeyD'] || k['ArrowRight']) mx += rgtX, mz += rgtZ;

  const len = Math.sqrt(mx * mx + mz * mz);
  let speed = 0;
  if (len > 0.001) {
    mx /= len; mz /= len;
    speed = spd;
    state.px += mx * spd * dt;
    state.pz += mz * spd * dt;
    playerGroup.rotation.y = Math.atan2(mx, mz);
  }

  const r = resolveAABB(state.px, state.py, state.pz, PLAYER_R);
  state.px = r.x;
  state.pz = r.z;
  const BEACH_LIMIT = WORLD + ROAD + 19;
  state.px = Math.max(PLAYER_R, Math.min(BEACH_LIMIT, state.px));
  state.pz = Math.max(PLAYER_R, Math.min(BEACH_LIMIT, state.pz));

  const targetGY = getGroundY(state.px, state.pz);
  const isGrounded = _playerGroundY <= targetGY + 0.05 && _jumpVel <= 0;
  if (k['Space'] && isGrounded) _jumpVel = 7;

  if (_jumpVel > 0 || _playerGroundY > targetGY + 0.05) {
    _jumpVel -= GRAVITY * dt;
    _playerGroundY += _jumpVel * dt;
    if (_playerGroundY < targetGY) {
      _playerGroundY = targetGY;
      _jumpVel = 0;
    }
  } else {
    _playerGroundY += (targetGY - _playerGroundY) * Math.min(1, dt * 12);
  }
  state.py = _playerGroundY + PLAYER_H / 2;
  playerGroup.position.set(state.px, _playerGroundY, state.pz);

  if (state._blinkTimer > 0) {
    state._blinkTimer -= dt;
    playerGroup.visible = Math.floor(state._blinkTimer * 8) % 2 === 0;
  } else {
    playerGroup.visible = true;
  }

  if (state.hp < state.maxHp && state._playerHitCooldown <= 0) {
    state._hpRegenTimer = (state._hpRegenTimer || 0) + dt;
    if (state._hpRegenTimer >= 4) {
      state.hp = Math.min(state.maxHp, state.hp + 5);
      state._hpRegenTimer = 0;
    }
  } else {
    state._hpRegenTimer = 0;
  }

  animateWalk(speed);

  const pitch = state.camPitch;
  const hDist = CAM_R * Math.cos(pitch);
  const vDist = CAM_R * Math.sin(pitch);
  camera.position.set(
    state.px - Math.sin(yaw) * hDist,
    state.py + vDist,
    state.pz - Math.cos(yaw) * hDist
  );
  camera.lookAt(state.px, state.py + 0.6, state.pz);
}

function updateDriving(dt, camera) {
  const car = state.inCar;
  const k = state.keys;

  if (car._drivingSpeed === undefined) car._drivingSpeed = 0;
  const ACCEL = 20;
  const COAST_DECEL = 4;
  const BRAKE_DECEL = 22;
  const MAX_FWD = 16;
  const MAX_REV = 6;

  const goFwd = k['KeyW'] || k['ArrowUp'];
  const goRev = k['KeyS'] || k['ArrowDown'];

  if (goFwd) {
    car._drivingSpeed = Math.min(MAX_FWD, car._drivingSpeed + ACCEL * dt);
  } else if (goRev) {
    if (car._drivingSpeed > 0) car._drivingSpeed = Math.max(0, car._drivingSpeed - BRAKE_DECEL * dt);
    else car._drivingSpeed = Math.max(-MAX_REV, car._drivingSpeed - ACCEL * 0.6 * dt);
  } else {
    if (car._drivingSpeed > 0) car._drivingSpeed = Math.max(0, car._drivingSpeed - COAST_DECEL * dt);
    else if (car._drivingSpeed < 0) car._drivingSpeed = Math.min(0, car._drivingSpeed + COAST_DECEL * dt);
  }

  const steerDir = car._drivingSpeed >= 0 ? 1 : -1;
  if (k['KeyA'] || k['ArrowLeft']) car.mesh.rotation.y += 1.8 * dt * steerDir;
  if (k['KeyD'] || k['ArrowRight']) car.mesh.rotation.y -= 1.8 * dt * steerDir;

  if (state._bumpTimer > 0) {
    state._bumpTimer -= dt;
    car._drivingSpeed *= Math.max(0, state._bumpTimer / 0.3);
  }

  const carYaw = car.mesh.rotation.y;
  if (car._drivingSpeed !== 0) {
    car.mesh.position.x -= Math.sin(carYaw) * car._drivingSpeed * dt;
    car.mesh.position.z -= Math.cos(carYaw) * car._drivingSpeed * dt;
  }

  if ('x' in car) {
    car.x = car.mesh.position.x;
    car.z = car.mesh.position.z;
  }

  state.px = car.mesh.position.x;
  state.pz = car.mesh.position.z;
  state.py = 1.0;

  for (const b of state.buildingBoxes) {
    const margin = 2.2;
    const cx2 = Math.max(b.x1, Math.min(state.px, b.x2));
    const cz2 = Math.max(b.z1, Math.min(state.pz, b.z2));
    const dx = state.px - cx2, dz = state.pz - cz2;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < margin && dist > 0.01) {
      const push = (margin - dist) / dist;
      car.mesh.position.x += dx * push;
      car.mesh.position.z += dz * push;
      state.px = car.mesh.position.x;
      state.pz = car.mesh.position.z;
    }
  }

  car.mesh.position.x = Math.max(2, Math.min(WORLD + ROAD - 2, car.mesh.position.x));
  car.mesh.position.z = Math.max(2, Math.min(WORLD + ROAD - 2, car.mesh.position.z));
  state.px = car.mesh.position.x;
  state.pz = car.mesh.position.z;
  if ('x' in car) { car.x = state.px; car.z = state.pz; }

  if (playerGroup) playerGroup.visible = false;

  const targetCamYaw = Math.PI + carYaw;
  let diff = targetCamYaw - state.camYaw;
  while (diff > Math.PI) diff -= 2 * Math.PI;
  while (diff < -Math.PI) diff += 2 * Math.PI;
  state.camYaw += diff * Math.min(1, dt * 2.5);

  const pitch = state.camPitch;
  const hDist = CAM_R * 1.4 * Math.cos(pitch);
  const vDist = CAM_R * 1.4 * Math.sin(pitch);
  camera.position.set(
    state.px - Math.sin(state.camYaw) * hDist,
    state.py + vDist + 0.6,
    state.pz - Math.cos(state.camYaw) * hDist
  );
  camera.lookAt(state.px, state.py + 0.8, state.pz);

  document.getElementById('speed').textContent = `Speed: ${Math.abs(car._drivingSpeed * 5).toFixed(0)} km/h`;
}

export function enterExitCar(notify) {
  if (state.inCar) {
    const car = state.inCar;
    state.inCar = null;
    if (playerGroup) playerGroup.visible = true;

    car._drivingSpeed = 0;

    if (car.driver !== undefined) {
      car.driver = null;
      const cx = car.mesh ? car.mesh.position.x : state.px;
      const cz = car.mesh ? car.mesh.position.z : state.pz;
      const laneOffset = car._currentLaneOffset ?? car._laneOffset ?? ROAD / 8;
      let bestFrom = 0, bestTo = 1, bestT = 0, bestDist = Infinity;
      for (let fromIdx = 0; fromIdx < state.roadNodes.length; fromIdx++) {
        const from = state.roadNodes[fromIdx];
        for (const toIdx of state.roadAdj[fromIdx]) {
          const to = state.roadNodes[toIdx];
          const dx = to.x - from.x, dz = to.z - from.z;
          const segLen2 = dx * dx + dz * dz;
          if (segLen2 < 0.001) continue;
          const t = Math.max(0, Math.min(1, ((cx - from.x) * dx + (cz - from.z) * dz) / segLen2));
          const segLen = Math.sqrt(segLen2);
          const cxRoad = from.x + dx * t;
          const czRoad = from.z + dz * t;
          const nxR = dz / segLen, nzR = -dx / segLen;
          const laneX = cxRoad + nxR * laneOffset;
          const laneZ = czRoad + nzR * laneOffset;
          const d = Math.hypot(cx - laneX, cz - laneZ);
          if (d < bestDist) {
            bestDist = d;
            bestFrom = fromIdx;
            bestTo = toIdx;
            bestT = t;
          }
        }
      }
      const from = state.roadNodes[bestFrom];
      const to = state.roadNodes[bestTo];
      const dx = to.x - from.x, dz = to.z - from.z;
      const segLen = Math.hypot(dx, dz) || 1;
      const nxR = dz / segLen, nzR = -dx / segLen;
      const rx = from.x + dx * bestT + nxR * laneOffset;
      const rz = from.z + dz * bestT + nzR * laneOffset;

      car.fromIdx = bestFrom;
      car.toIdx = bestTo;
      car.t = bestT;
      car._rx = rx;
      car._rz = rz;
      car._ox = cx - rx;
      car._oz = cz - rz;
      car._vx = 0;
      car._vz = 0;
      car._yaw = car.mesh ? car.mesh.rotation.y : Math.atan2(-dx, -dz);
      car._steerYaw = 0;
      car._turning = false;
      car._turnU = 0;
      car._turnP0 = null;
      car._turnP1 = null;
      car._turnP2 = null;
      car._turnP3 = null;
      car._nextToIdx = null;
      car._stoppedAtRed = false;
      car.x = cx; car.z = cz;
    }

    if (car.mesh) {
      const cy = car.mesh.rotation.y;
      state.px = car.mesh.position.x + Math.cos(cy) * 3;
      state.pz = car.mesh.position.z - Math.sin(cy) * 3;
    }
    _playerGroundY = ROAD_Y;
    _jumpVel = 0;
    notify?.('車を降りた');
    return;
  }

  let bestCar = null, bestNpc = null, bestDist = 5.5;
  for (const c of state.cars) {
    if (!c.mesh) continue;
    const d = Math.hypot(c.mesh.position.x - state.px, c.mesh.position.z - state.pz);
    if (d < bestDist) { bestDist = d; bestCar = c; }
  }
  for (const c of state.npcCars) {
    const d = Math.hypot(c.x - state.px, c.z - state.pz);
    if (d < bestDist) { bestDist = d; bestNpc = c; }
  }

  if (bestCar) {
    state.inCar = bestCar;
    if (bestCar.mesh) state.camYaw = Math.PI + bestCar.mesh.rotation.y;
    notify?.('車に乗った');
  } else if (bestNpc) {
    bestNpc.driver = 'player';
    state.inCar = bestNpc;
    bestNpc.speed = 0;
    state.camYaw = Math.PI + bestNpc.mesh.rotation.y;
    raiseWanted(1);
    notify?.('🚨 ドライバーを引きずり出した！');
  }
}
