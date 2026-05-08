import * as THREE from 'three';
import { state, raiseWanted, CAM_PITCH_MIN, CAM_PITCH_MAX } from './config.js?v=20260508-5';
import { buildCity, updateTrafficLights } from './city.js?v=20260508-5';
import { createPlayer, updatePlayer, enterExitCar, shootWeapon } from './player.js?v=20260508-5';
import { spawnNPCs, updateNPCs, spawnPoliceResponse, updatePoliceResponse } from './npc.js?v=20260508-5';
import { createTrain, updateTrain } from './train.js?v=20260508-5';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.88;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x87ceeb, 0.0035);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000);

const hemi = new THREE.HemisphereLight(0x87ceeb, 0x3a5a28, 0.7);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff5e0, 1.4);
sun.position.set(80, 120, 60);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 400;
sun.shadow.camera.left = sun.shadow.camera.bottom = -120;
sun.shadow.camera.right = sun.shadow.camera.top = 120;
sun.shadow.bias = -0.001;
scene.add(sun);

const fill = new THREE.DirectionalLight(0xaaccff, 0.3);
fill.position.set(-50, 40, -40);
scene.add(fill);

const skyDay = new THREE.Color(0x87ceeb);
const skyNight = new THREE.Color(0x0d1624);
const fogDay = new THREE.Color(0x87ceeb);
const fogNight = new THREE.Color(0x101826);
scene.background = skyDay.clone();

{
  const base = 'https://raw.githubusercontent.com/mrdoob/three.js/r164/examples/textures/cube/skybox/';
  const faces = ['px.jpg', 'nx.jpg', 'py.jpg', 'ny.jpg', 'pz.jpg', 'nz.jpg'];
  new THREE.CubeTextureLoader().setPath(base).load(
    faces,
    t => { scene.environment = t; },
    undefined,
    () => { scene.environment = null; }
  );
}

buildCity(scene);
state._scene = scene;
createPlayer(scene);
spawnNPCs(scene);
createTrain(scene);

window.addEventListener('keydown', e => { state.keys[e.code] = true; });
window.addEventListener('keyup', e => { state.keys[e.code] = false; });

window.addEventListener('keydown', e => {
  if (e.code === 'KeyE') enterExitCar(showNotice);
});

window.addEventListener('pointerdown', e => {
  if (!gameStarted) {
    startGame();
    return;
  }
  if (e.button !== 0) return;
  if (shootWeapon(camera, showNotice)) {
    const ammoEl = document.getElementById('ammo');
    if (ammoEl) ammoEl.textContent = `Ammo: ${state.ammo}`;
  }
});

document.addEventListener('mousemove', e => {
  if (!document.pointerLockElement) return;
  state.camYaw -= e.movementX * 0.003;
  state.camPitch += e.movementY * 0.003;
  state.camPitch = Math.max(CAM_PITCH_MIN, Math.min(CAM_PITCH_MAX, state.camPitch));
});

const overlay = document.getElementById('overlay');
let gameStarted = false;
function startGame() {
  gameStarted = true;
  overlay.style.display = 'none';
  canvas.requestPointerLock();
}
canvas.addEventListener('click', startGame);
overlay.addEventListener('click', startGame);

document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && gameStarted) overlay.style.display = 'flex';
});

let noticeTimer = 0;
const noticeEl = document.getElementById('notice');
function showNotice(msg) {
  noticeEl.textContent = msg;
  noticeEl.style.opacity = '1';
  noticeTimer = 3;
}

const starsFull = '★★★★★';
const starsEmpty = '☆☆☆☆☆';
function wantedStars(n) {
  return starsFull.slice(0, n) + starsEmpty.slice(n);
}

function formatTimeOfDay(t) {
  const hours = (t * 24) % 24;
  const h = Math.floor(hours);
  const m = Math.floor((hours - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function applyDayNight(dt) {
  state.timeOfDay = (state.timeOfDay + dt / state.dayLength) % 1;
  const angle = state.timeOfDay * Math.PI * 2;
  const dayFactor = Math.max(0, Math.sin(angle));
  const nightFactor = 1 - dayFactor;
  const nightLight = nightFactor * nightFactor;

  sun.position.set(Math.cos(angle) * 120, Math.sin(angle) * 120, 60);
  sun.intensity = 0.24 + dayFactor * 1.18;
  hemi.intensity = 0.32 + dayFactor * 0.48;
  fill.intensity = 0.16 + dayFactor * 0.16;
  renderer.toneMappingExposure = 0.74 + dayFactor * 0.26;
  scene.fog.color.copy(fogDay).lerp(fogNight, nightFactor);
  scene.fog.density = 0.0020 + nightFactor * 0.0015;
  scene.background.copy(skyDay).lerp(skyNight, nightFactor);

  scene.traverse(obj => {
    if (!obj.isPointLight) return;
    obj.userData._baseIntensity ??= obj.intensity;
    obj.userData._baseDistance ??= obj.distance;
    const hex = obj.color.getHex();
    const warm = hex === 0xfff5cc || hex === 0xfff1c7 || hex === 0xffee88 || hex === 0xff7700 || hex === 0xffeecc;
    const cool = hex === 0xddeeff || hex === 0x9999aa;
    const boost = warm ? 1.9 : cool ? 1.25 : 1.0;
    obj.intensity = obj.userData._baseIntensity * (1 + nightLight * boost);
    if (obj.userData._baseDistance) obj.distance = obj.userData._baseDistance * (1 + nightLight * 0.2);
  });
}

function syncHud() {
  document.getElementById('wanted').textContent = `Wanted: ${wantedStars(state.wanted)}`;
  document.getElementById('posinfo').textContent = `Pos: ${state.px.toFixed(0)}, ${state.pz.toFixed(0)}`;
  const ammoEl = document.getElementById('ammo');
  if (ammoEl) ammoEl.textContent = `Ammo: ${state.ammo}`;
  const timeEl = document.getElementById('time');
  if (timeEl) timeEl.textContent = `Time: ${formatTimeOfDay(state.timeOfDay)}`;
  if (!state.inCar) document.getElementById('speed').textContent = 'Speed: 0 km/h';
  const hpPct = (state.hp / state.maxHp) * 100;
  const hpFill = document.getElementById('hpfill');
  hpFill.style.width = hpPct + '%';
  hpFill.style.background = hpPct > 50 ? '#2f2' : hpPct > 25 ? '#fa0' : '#f22';
}

function loop() {
  if (!state.gameOver) requestAnimationFrame(loop);

  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  try {
    applyDayNight(dt);
    updatePlayer(dt, camera);
    updateNPCs(dt);
    updateTrafficLights(dt);
    spawnPoliceResponse(dt);
    updatePoliceResponse(dt);
    updateTrain(dt);
  } catch (e) {
    const errEl = document.getElementById('errbox') || (() => {
      const d = document.createElement('div');
      d.id = 'errbox';
      d.style.cssText = 'position:fixed;top:0;left:0;right:0;background:rgba(200,0,0,0.9);color:#fff;font:12px monospace;padding:8px;z-index:9999;white-space:pre-wrap;max-height:40vh;overflow:auto;';
      document.body.appendChild(d);
      return d;
    })();
    errEl.textContent = 'ERROR: ' + e.message + '\n' + (e.stack || '');
  }

  const movingCars = state.npcCars.filter(c => {
    if (c.driver === 'player') {
      return state.keys['KeyW'] || state.keys['ArrowUp'] || state.keys['KeyS'] || state.keys['ArrowDown'];
    }
    return true;
  });
  if (state.inCar && state.inCar.mesh) movingCars.push(state.inCar);

  for (const car of movingCars) {
    const cx2 = car.x ?? (car.mesh && car.mesh.position.x) ?? state.px;
    const cz2 = car.z ?? (car.mesh && car.mesh.position.z) ?? state.pz;
    const carY = car.mesh ? car.mesh.position.y : 0.33;
    const carSpd = car._drivingSpeed !== undefined ? Math.abs(car._drivingSpeed) : (car._effectiveSpeed ?? car.speed ?? 0);
    if (carSpd < 7) continue;

    const carYaw = car.mesh ? car.mesh.rotation.y : 0;
    const carFwdX = -Math.sin(carYaw), carFwdZ = -Math.cos(carYaw);

    for (const ped of state.pedestrians) {
      if (ped.dead) continue;
      const d = Math.hypot(cx2 - ped.x, cz2 - ped.z);
      const dy = Math.abs(carY - (ped.mesh ? ped.mesh.position.y : 0.14));
      const toPedX = (ped.x - cx2) / (d || 1), toPedZ = (ped.z - cz2) / (d || 1);
      const frontDot = toPedX * carFwdX + toPedZ * carFwdZ;
      if (d < 2.2 && dy < 2.0 && frontDot > 0.55) {
        ped.dead = true;
        ped.deadTimer = 3.0;
        ped.mesh.rotation.x = Math.PI / 2;
        const dx = ped.x - cx2, dz = ped.z - cz2;
        const mag = Math.sqrt(dx * dx + dz * dz) || 1;
        ped.x += (dx / mag) * 3;
        ped.z += (dz / mag) * 3;
        ped.mesh.position.set(ped.x, 0.1, ped.z);
        if (car === state.inCar || car.driver === 'player') {
          raiseWanted(1);
          state._bumpTimer = 0.3;
        }
      }
    }
  }

  if (!state.inCar && !state.gameOver) {
    if (state._playerHitCooldown > 0) {
      state._playerHitCooldown -= dt;
    } else {
      for (const car of state.npcCars) {
        if (car.driver === 'player') continue;
        const effectiveSpd = car._effectiveSpeed ?? car.speed;
        if (effectiveSpd < 2.0) continue;
        const carY = car.mesh ? car.mesh.position.y : 0.33;
        const dy = Math.abs(carY - state.py);
        if (dy > 2.5) continue;
        const carYaw = car.mesh ? car.mesh.rotation.y : car._yaw ?? 0;
        const carFwdX = -Math.sin(carYaw), carFwdZ = -Math.cos(carYaw);
        const relX = state.px - car.x, relZ = state.pz - car.z;
        const d = Math.hypot(relX, relZ);
        if (d >= 3.0) continue;
        const ahead = relX * carFwdX + relZ * carFwdZ;
        const side = Math.abs(relX * carFwdZ - relZ * carFwdX);
        if (ahead < -0.6 || ahead > 3.2 || side > 1.7) continue;
        state.hp = Math.max(0, state.hp - 25);
        state._playerHitCooldown = 2.0;
        state._blinkTimer = 1.0;
        document.getElementById('redflash').style.opacity = '0.6';
        setTimeout(() => { document.getElementById('redflash').style.opacity = '0'; }, 300);
        showNotice('⚠️ 車に轢かれた！');
        if (state.hp <= 0) {
          state.gameOver = true;
          document.getElementById('gameover').style.display = 'flex';
        }
        break;
      }
    }
  }

  for (const ped of state.pedestrians) {
    if (!ped.dead) continue;
    ped.deadTimer -= dt;
    if (ped.deadTimer <= 0) ped.mesh.visible = false;
  }

  if (state.wanted > 0) {
    state._wantedDecay = (state._wantedDecay || 0) + dt;
    if (state._wantedDecay > 30) {
      state.wanted--;
      state._wantedDecay = 0;
    }
  }

  if (noticeTimer > 0) {
    noticeTimer -= dt;
    if (noticeTimer <= 0) noticeEl.style.opacity = '0';
  }

  syncHud();
  renderer.render(scene, camera);
}

let last = performance.now();
loop();
