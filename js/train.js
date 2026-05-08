import * as THREE from 'three';
import { WORLD, ROAD, ROAD_Y, CELL, GRID, state } from './config.js?v=20260508-5';
import { matStd, matTex, tex } from './textures.js?v=20260508-5';
import { addBox } from './physics.js?v=20260508-5';

// ── Route constants ───────────────────────────────────────────────────────────
const RAIL_X       = 4 * CELL + ROAD / 2;
const RAIL_FROM_Z  = -150;  // 山奥まで延伸: 電車がトンネル内に消えるため
const RAIL_TO_Z    = WORLD + 340;  // 延長: 海上を渡り遠方の島の先まで
const STATION_Z    = WORLD * 0.48;   // one station in city
const MEDIAN_W     = 3.5;
const MEDIAN_H     = 0.45;
const ROAD_EXT_W   = MEDIAN_W / 2;   // 大通りのみ外側へ増設する幅

// Approximate t value of station (CatmullRom is nearly uniform here)
const TOTAL_Z      = RAIL_TO_Z - RAIL_FROM_Z;   // ≈300m
const STATION_T    = (STATION_Z - RAIL_FROM_Z) / TOTAL_Z;  // ≈0.50

const APPROACH_T   = 0.09;   // start slowing 27m before station
const STOP_T       = 0.018;  // stop within 5m of station
const FULL_SPEED   = 0.025;  // ~7.5 m/s ≈ 27 km/h
const SLOW_SPEED   = 0.003;  // ~0.9 m/s crawl near station
const STOP_SECONDS = 5;      // dwell at station

// ── State ─────────────────────────────────────────────────────────────────────
let trainCurve;
let trainMeshes = [];
let trainT         = 0.0;
let trainDir       = 1;
let stopTimer      = 0;
let stopped        = false;
let postStopDelay  = 0;  // prevents immediate re-stop after departure
// { hlMats:[], tlMats:[], isFrontEnd:bool }  isFrontEnd=true → +z端 (car0前面)
let cabEndLights   = [];

// ── Helpers ──────────────────────────────────────────────────────────────────
function mb(w, h, d, mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = true;
  return m;
}

// ── Station builder ───────────────────────────────────────────────────────────
// Platform is on the EAST side of the track so the train can pass without
// sinking into it.
function buildStation(scene) {
  const trackX = RAIL_X, cz = STATION_Z;
  const px       = trackX + 5.0; // east side only
  const platLen  = 34;
  const platDep  = 4.6;
  const platTopY = 3.8;
  const platSlab = 0.5;
  const concMat  = matTex(tex.concrete, { color: 0xbbbbbb });
  const roofMat  = matStd(0x223355, { roughness: 0.4, metalness: 0.3, emissive: 0x1a2a44, emissiveIntensity: 0.6 });
  const pilMat   = matStd(0x888888, { roughness: 0.5, metalness: 0.3 });

  const plat = mb(platDep, platSlab, platLen, concMat);
  plat.position.set(px, platTopY - platSlab / 2, cz);
  scene.add(plat);
  addBox(px - platDep / 2, cz - platLen / 2, px + platDep / 2, cz + platLen / 2, 0, platTopY);

  const pilH = platTopY - platSlab;
  for (const pz2 of [-platLen/2+2, -platLen/6, platLen/6, platLen/2-2]) {
    const pil = mb(0.35, pilH, 0.35, pilMat);
    pil.position.set(px, pilH / 2, cz + pz2);
    scene.add(pil);
  }

  const roof = mb(platDep + 3.0, 0.28, platLen - 1.5, roofMat);
  roof.position.set(px, platTopY + 3.3, cz);
  scene.add(roof);

  const line = mb(0.24, 0.05, platLen - 1.0, matStd(0xffee00, { roughness: 0.8, emissive: 0xffee88, emissiveIntensity: 0.8 }));
  line.position.set(px - platDep / 2 + 0.14, platTopY + 0.03, cz);
  scene.add(line);

  const rampLen = 10;
  const rampW = 3.0;
  const x1 = px - rampLen / 2;
  const x2 = px + rampLen / 2;
  const zRamp = cz + platLen / 2 - 2.6;
  const ramp = mb(Math.hypot(rampLen, platTopY), 0.16, rampW, concMat);
  ramp.rotation.z = Math.atan2(platTopY, rampLen);
  ramp.position.set((x1 + x2) / 2, platTopY / 2, zRamp);
  scene.add(ramp);
  state.ramps.push({
    x1, x2,
    z1: zRamp - rampW / 2,
    z2: zRamp + rampW / 2,
    yBase: platTopY,
    yTop: 0,
    axis: 'x',
  });
}

// ── Train car builder: JR E235 Yokosuka/Sobu line ────────────────────────────
function buildE235Car(scene, isFrontCab, isRearCab = false) {
  const g = new THREE.Group();
  const carL = 19.0;
  const carW = 2.8;

  // ── Materials ─────────────────────────────────────────────────────────────
  const silverMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.05, metalness: 0.25, clearcoat: 1.0, clearcoatRoughness: 0.02, envMapIntensity: 1.5,
  });
  const blueMat = new THREE.MeshPhysicalMaterial({
    color: 0x1a52c0, roughness: 0.3, metalness: 0.2, clearcoat: 0.4,
    emissive: 0x0f234f, emissiveIntensity: 0.25,
  });
  const yellowMat = matStd(0xf0d832, { roughness: 0.5 });
  const grayMat   = matStd(0x8a8a8a, { roughness: 0.85, metalness: 0.05 });
  const roofMat   = yellowMat;
  const glassMat  = new THREE.MeshStandardMaterial({
    color: 0x4a6070, roughness: 0.05, transparent: true, opacity: 0.65,
  });
  const frameMat = matStd(0x1e1e1e, { roughness: 0.85 });
  const underMat = matStd(0x181818, { roughness: 0.9, metalness: 0.5 });
  const metalMat = matStd(0x888899, { roughness: 0.3, metalness: 0.8 });

  // ── Y-boundaries (屋根グレーなし — 上帯が最上部) ────────────────────────
  const yUBot  = 0.00, yUTop  = 0.55;   // underframe
  const yS1Bot = 0.55, yS1Top = 1.05;   // 銀 下部パネル
  const yBLBot = 1.05, yBLTop = 1.55;   // 青帯 中央
  const yYLBot = 1.55, yYLTop = 1.70;   // 黄帯 中央
  const yS2Bot = 1.70, yS2Top = 2.90;   // 銀 窓エリア
  const yBUBot = 2.90, yBUTop = 3.30;   // 青帯 上部
  const yYUBot = 3.30, yYUTop = 3.44;   // 黄帯 上部 ← 最上部 (屋根なし)

  const ymid = (a, b) => (a + b) / 2;
  const yht  = (a, b) =>  b - a;

  // Underframe
  const uf = mb(carW - 0.12, yht(yUBot, yUTop), carL - 0.5, underMat);
  uf.position.y = ymid(yUBot, yUTop);
  g.add(uf);

  // 銀 下部パネル
  const s1 = mb(carW, yht(yS1Bot, yS1Top), carL, silverMat);
  s1.position.y = ymid(yS1Bot, yS1Top);
  g.add(s1);

  // 青帯 中央
  const blL = mb(carW, yht(yBLBot, yBLTop), carL, blueMat);
  blL.position.y = ymid(yBLBot, yBLTop);
  g.add(blL);

  // 黄帯 中央
  const ylL = mb(carW, yht(yYLBot, yYLTop), carL, yellowMat);
  ylL.position.y = ymid(yYLBot, yYLTop);
  g.add(ylL);

  // 銀 窓エリア
  const s2 = mb(carW, yht(yS2Bot, yS2Top), carL, silverMat);
  s2.position.y = ymid(yS2Bot, yS2Top);
  g.add(s2);

  // 青帯 上部
  const blU = mb(carW, yht(yBUBot, yBUTop), carL, blueMat);
  blU.position.y = ymid(yBUBot, yBUTop);
  g.add(blU);

  // 屋根
  const roof = mb(carW, 0.14, carL - 0.2, roofMat);
  roof.position.y = yYUTop - 0.07;
  g.add(roof);

  // 最上部帯
  const ylU = mb(carW, yht(yYUBot, yYUTop), carL, yellowMat);
  ylU.position.y = ymid(yYUBot, yYUTop);
  g.add(ylU);

  // ── Side doors & windows ──────────────────────────────────────────────────
  // ドアは車体ほぼ全高（青帯をまたぐ）、幅1.3m、上部に大きな窓
  const doorZs = [-carL * 0.375, -carL * 0.125, carL * 0.125, carL * 0.375];
  const doorW2 = 1.30;
  const doorBot = yS1Bot + 0.05;
  const doorTop = yBUBot - 0.08;   // 上部帯の直下まで
  const doorH   = doorTop - doorBot;
  const doorY   = ymid(doorBot, doorTop);
  // ドア窓: 窓エリア(yS2)内でドア幅分
  const dwH  = yS2Top - yS2Bot - 0.10;
  const dwBot= yS2Bot + 0.05;
  // 客窓
  const winH = 0.60;
  const winY = yS2Bot + 0.28 + winH / 2;

  for (const sx of [-carW / 2 - 0.003, carW / 2 + 0.003]) {
    for (const dz of doorZs) {
      // ドア窓ガラス (上部)
      const dw = mb(0.04, dwH, doorW2 - 0.12, glassMat);
      dw.position.set(sx, dwBot + dwH / 2, dz);
      g.add(dw);
      // ドア縦枠 (両端)
      for (const ez of [dz - doorW2 / 2, dz + doorW2 / 2]) {
        const ef = mb(0.05, doorH + 0.08, 0.07, frameMat);
        ef.position.set(sx, doorY, ez);
        g.add(ef);
      }
      // ドア上枠
      const tf = mb(0.05, 0.07, doorW2 + 0.08, frameMat);
      tf.position.set(sx, doorTop + 0.02, dz);
      g.add(tf);
      // ドア中央の仕切り線 (観音開き境界)
      const cf = mb(0.04, dwH, 0.06, frameMat);
      cf.position.set(sx, dwBot + dwH / 2, dz);
      g.add(cf);
    }

    // 客窓 (ドア間 + 端部)
    const gaps = [
      [-carL / 2 + 0.5,       doorZs[0] - doorW2 / 2 - 0.18],
      [doorZs[0] + doorW2 / 2 + 0.18, doorZs[1] - doorW2 / 2 - 0.18],
      [doorZs[1] + doorW2 / 2 + 0.18, doorZs[2] - doorW2 / 2 - 0.18],
      [doorZs[2] + doorW2 / 2 + 0.18, doorZs[3] - doorW2 / 2 - 0.18],
      [doorZs[3] + doorW2 / 2 + 0.18, carL / 2 - 0.5],
    ];
    for (const [z1, z2] of gaps) {
      const span = z2 - z1;
      if (span < 0.6) continue;
      const nw = Math.max(1, Math.round(span / 2.1));
      for (let wi = 0; wi < nw; wi++) {
        const wz = z1 + (wi + 0.5) * (span / nw);
        const ww = Math.min(1.55, span / nw - 0.38);
        const w = mb(0.04, winH, ww, glassMat);
        w.position.set(sx, winY, wz);
        g.add(w);
      }
    }
  }

  // ── 前頭部ヘルパー (前後兼用) ─────────────────────────────────────────────
  // endZ: 車端Z座標, dir: +1=前(+z突き出し), -1=後(-z突き出し)
  function addCabFace(endZ, dir) {
    const dep  = 0.38;
    const surf = endZ + dir * (dep + 0.01);  // 表面要素のZ

    // 全面ブルー (台枠上端〜最上部)
    const face = mb(carW, yht(yS1Bot, yYUTop), dep, blueMat);
    face.position.set(0, ymid(yS1Bot, yYUTop), endZ + dir * dep / 2);
    g.add(face);

    // 側面帯の回り込み: 黄帯 中央 をフェイスに重ねる
    const fYL = mb(carW + 0.02, yht(yYLBot, yYLTop), 0.05, yellowMat);
    fYL.position.set(0, ymid(yYLBot, yYLTop), surf);
    g.add(fYL);

    // 側面帯の回り込み: 黄帯 上部
    const fYU = mb(carW + 0.02, yht(yYUBot, yYUTop), 0.05, yellowMat);
    fYU.position.set(0, ymid(yYUBot, yYUTop), surf);
    g.add(fYU);

    // ワイドスクリーン (窓エリア全高 × 幅72%)
    const wsW = carW * 0.72;
    const wsH = yht(yS2Bot + 0.10, yS2Top - 0.06);
    const ws  = mb(wsW, wsH, 0.05, glassMat);
    ws.position.set(0, ymid(yS2Bot + 0.10, yS2Top - 0.06), surf);
    g.add(ws);

    // 行先表示器 (上帯・上部中央)
    const dest = mb(carW * 0.54, 0.20, 0.05, new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: 0xffaa33, emissiveIntensity: 2.0, roughness: 0.15,
    }));
    dest.position.set(0, yBUTop - 0.14, surf);
    g.add(dest);

    // ── 上部ライト群 (上帯内・左右対称) ────────────────────────────────────
    // 上帯を左右3ゾーンに分割: [テール][ヘッド | ヘッド][テール]
    const lightY = yBUBot + 0.16;  // 上帯下部

    // ヘッドライト (常時white発光 — visible で ON/OFF)
    const hlOnMat = new THREE.MeshStandardMaterial({
      color: 0xffffff, emissive: 0xf3f7ff, emissiveIntensity: 4.2, roughness: 0.04,
    });
    // テールライト (常時red発光 — visible で ON/OFF)
    const tlOnMat = new THREE.MeshStandardMaterial({
      color: 0xff1111, emissive: 0xff2200, emissiveIntensity: 2.4, roughness: 0.2,
    });

    // ヘッドライト 2本 (内寄り横長バー)
    const hlMeshes = [];
    for (const hx of [-carW * 0.20, carW * 0.20]) {
      const hlMesh = mb(0.60, 0.12, 0.05, hlOnMat);
      hlMesh.position.set(hx, lightY, surf);
      hlMesh.visible = false;  // createTrain で初期化
      g.add(hlMesh);
      hlMeshes.push(hlMesh);
    }

    // テールライト 2個 (外角、小型正方形)
    const tlMeshes = [];
    for (const hx of [-carW * 0.44, carW * 0.44]) {
      const tlMesh = mb(0.24, 0.20, 0.05, tlOnMat);
      tlMesh.position.set(hx, lightY, surf);
      tlMesh.visible = false;  // createTrain で初期化
      g.add(tlMesh);
      tlMeshes.push(tlMesh);
    }

    // cabEndLights に登録 (isFrontEnd: +z端ならtrue)
    cabEndLights.push({ hlMeshes, tlMeshes, isFrontEnd: dir > 0 });

    // 車番表示 (中央帯・左寄り)
    const num = mb(0.52, 0.18, 0.05, new THREE.MeshStandardMaterial({
      color: 0x111111, emissive: 0xaaffdd, emissiveIntensity: 1.2, roughness: 0.4,
    }));
    num.position.set(-carW * 0.30, ymid(yBLBot, yBLTop), surf);
    g.add(num);
  }

  // 前端 (car0: +z) / 後端 (car3: -z)
  if (isFrontCab) addCabFace(carL / 2,  +1);
  if (isRearCab)  addCabFace(-carL / 2, -1);

  // ── Couplers ──────────────────────────────────────────────────────────────
  for (const cz of [-carL / 2 - 0.22, carL / 2 + 0.22]) {
    const coupler = mb(0.36, 0.28, 0.38, metalMat);
    coupler.position.set(0, 0.52, cz);
    g.add(coupler);
  }

  // ── Bogies (2 per car) ────────────────────────────────────────────────────
  const bogMat = matStd(0x252525, { roughness: 0.85, metalness: 0.6 });
  const whlMat = matStd(0x303030, { roughness: 0.8,  metalness: 0.8 });

  for (const bz of [-carL / 2 + 5.0, carL / 2 - 5.0]) {
    const bog = new THREE.Group();
    bog.position.set(0, 0.33, bz);
    bog.add(mb(2.55, 0.22, 2.3, bogMat));
    for (const wx of [-1.1, 1.1]) {
      for (const wz2 of [-0.8, 0.8]) {
        const wh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.37, 0.37, 0.24, 10), whlMat
        );
        wh.rotation.z = Math.PI / 2;
        wh.position.set(wx, -0.12, wz2);
        bog.add(wh);
      }
    }
    g.add(bog);
  }

  scene.add(g);
  return g;
}

// ── Create train ──────────────────────────────────────────────────────────────
export function createTrain(scene) {
  cabEndLights = [];  // reset on reload

  // Straight route N-S along RAIL_X
  trainCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(RAIL_X, 3.5, RAIL_FROM_Z),
    new THREE.Vector3(RAIL_X, 3.5, RAIL_FROM_Z + 40),
    new THREE.Vector3(RAIL_X, 3.5, WORLD * 0.25),
    new THREE.Vector3(RAIL_X, 3.5, STATION_Z - 10),
    new THREE.Vector3(RAIL_X, 3.5, STATION_Z),
    new THREE.Vector3(RAIL_X, 3.5, STATION_Z + 10),
    new THREE.Vector3(RAIL_X, 3.5, WORLD * 0.75),
    new THREE.Vector3(RAIL_X, 3.5, WORLD + ROAD),       // 都市南端
    new THREE.Vector3(RAIL_X, 3.5, WORLD + 140),        // 橋中間
    new THREE.Vector3(RAIL_X, 3.5, WORLD + 260),        // 島付近
    new THREE.Vector3(RAIL_X, 3.5, RAIL_TO_Z - 40),
    new THREE.Vector3(RAIL_X, 3.5, RAIL_TO_Z),
  ], false);

  // ── Track bed (ballast) ───────────────────────────────────────────────────
  const tLen = RAIL_TO_Z - RAIL_FROM_Z;
  const ballast = mb(2.6, 0.28, tLen, matStd(0x888880, { roughness: 0.95 }));
  ballast.position.set(RAIL_X, 3.25, (RAIL_FROM_Z + RAIL_TO_Z) / 2);
  scene.add(ballast);

  // ── Rails ─────────────────────────────────────────────────────────────────
  const railMat = matStd(0xaaaaaa, { roughness: 0.2, metalness: 0.9 });
  for (const off of [-0.74, 0.74]) {
    const pts = [];
    for (let i = 0; i <= 400; i++) {
      const p = trainCurve.getPointAt(i / 400);
      const tan = trainCurve.getTangentAt(i / 400).normalize();
      const right = new THREE.Vector3(-tan.z, 0, tan.x);
      pts.push(p.clone().addScaledVector(right, off));
    }
    const railGeo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false), 400, 0.052, 4, false);
    scene.add(new THREE.Mesh(railGeo, railMat));
  }

  // ── Dense ties (one every ~0.6m) ──────────────────────────────────────────
  const tieMat = matTex(tex.bark, { color: 0x5a3020 });
  const TIE_N = 750;  // 延長分の枕木密度を維持
  for (let i = 0; i < TIE_N; i++) {
    const t  = i / TIE_N;
    const p   = trainCurve.getPointAt(t);
    const tan = trainCurve.getTangentAt(t).normalize();
    const tie = mb(1.9, 0.14, 0.26, tieMat);
    tie.position.set(p.x, p.y - 0.08, p.z);
    tie.rotation.y = Math.atan2(tan.x, tan.z);
    scene.add(tie);
  }

  // ── Rail corridor boulevard (線路道路のみ個別レイアウト) ───────────────────
  // 構成: 車線 車線 中央分離帯(線路) 車線 車線
  // 線路道路のみ総幅を ROAD + MEDIAN_W に拡張し、車線幅は通常道路と同じに保つ。
  const roadMat = matTex(tex.road);
  const medMat = matStd(0x556644, { roughness: 0.9 });
  const laneMat = matStd(0xffffff, { roughness: 1 });
  const corridorZ1 = 0;
  const corridorZ2 = WORLD + ROAD;
  const corridorLen = corridorZ2 - corridorZ1;

  // 既存道路(ROAD幅)の外側に、線路道路だけ追加路面を敷いて総幅を拡張
  const leftExt = mb(ROAD_EXT_W, 0.03, corridorLen, roadMat);
  leftExt.position.set(RAIL_X - (ROAD / 2 + ROAD_EXT_W / 2), ROAD_Y + 0.005, (corridorZ1 + corridorZ2) / 2);
  scene.add(leftExt);
  const rightExt = mb(ROAD_EXT_W, 0.03, corridorLen, roadMat);
  rightExt.position.set(RAIL_X + (ROAD / 2 + ROAD_EXT_W / 2), ROAD_Y + 0.005, (corridorZ1 + corridorZ2) / 2);
  scene.add(rightExt);

  // 片側2車線の境界線位置（通常道路と同じ lane width = ROAD/4）
  const leftDividerX = RAIL_X - MEDIAN_W / 2 - ROAD / 4;
  const rightDividerX = RAIL_X + MEDIAN_W / 2 + ROAD / 4;

  // 片側2車線の境界破線（交差点/横断歩道ゾーンはスキップ）
  for (let j = 0; j < GRID; j++) {
    const segZ1 = j * CELL + ROAD + 8;
    const segZ2 = (j + 1) * CELL - 2;
    if (segZ2 <= segZ1) continue;
    const segLen = segZ2 - segZ1;
    for (let d = 0; d < segLen; d += 4) {
      if (d >= segLen - 4) continue;
      const z = segZ1 + d + 2;
      const lDash = mb(0.06, 0.03, 1.8, laneMat);
      lDash.position.set(leftDividerX, ROAD_Y + 0.012, z);
      scene.add(lDash);
      const rDash = mb(0.06, 0.03, 1.8, laneMat);
      rDash.position.set(rightDividerX, ROAD_Y + 0.012, z);
      scene.add(rDash);
    }
  }

  // 中央分離帯のみ交差点部分を空ける
  for (let j = 0; j < GRID; j++) {
    const segZ1 = j * CELL + ROAD + 8;     // crosswalk/stopline zoneを避ける
    const segZ2 = (j + 1) * CELL - 2;      // 次交差点手前で止める
    if (segZ2 <= segZ1) continue;
    const segLen = segZ2 - segZ1;
    const median = mb(MEDIAN_W, MEDIAN_H, segLen, medMat);
    median.position.set(RAIL_X, ROAD_Y + MEDIAN_H / 2, (segZ1 + segZ2) / 2);
    scene.add(median);
    addBox(RAIL_X - MEDIAN_W / 2, segZ1, RAIL_X + MEDIAN_W / 2, segZ2, 0, ROAD_Y + MEDIAN_H + 0.06);
  }

  // ── Pillars（電車底面 y≈3.44 の下に収める → 柱上端 y=3.1）────────────────
  // 電車は y=3.5 の曲線上を走行、車輪フランジ底面 ≈ y+0.38-0.06-0.38 ≈ y-0.06 = 3.44
  const PILLAR_TOP = 3.1;   // 電車底面3.44より0.34mの余裕
  const pilMat = matTex(tex.concrete, { color: 0x888888 });
  for (let z = RAIL_FROM_Z + 15; z < RAIL_TO_Z; z += 10) {
    if (z < -5 || z > WORLD + 5) continue;
    // Skip intersection zones (fracZ < ROAD means z falls inside an intersection)
    const fracZ = ((z % CELL) + CELL) % CELL;
    if (fracZ < ROAD) continue;
    const shaftH = PILLAR_TOP - MEDIAN_H;
    const shaft = mb(0.55, shaftH, 0.55, pilMat);
    shaft.position.set(RAIL_X, MEDIAN_H + shaftH / 2, z);
    shaft.castShadow = true;
    scene.add(shaft);
    // 小さなブラケット（柱上端）
    const cap = mb(1.0, 0.2, 1.0, pilMat);
    cap.position.set(RAIL_X, PILLAR_TOP + 0.1, z);
    scene.add(cap);
    // 柱の当たり判定（上端はPILLAR_TOP+0.2まで）
    addBox(RAIL_X - 0.35, z - 0.35, RAIL_X + 0.35, z + 0.35, 0, PILLAR_TOP + 0.2);
  }

  // ── Station ───────────────────────────────────────────────────────────────
  buildStation(scene);

  // ── 山側アプローチ盛土 (z=0〜ポータル間の線路下を自然に見せる) ──────────────
  {
    const apZ1 = 0, apZ2 = -14;  // 市街地北端→ポータル
    const apLen = apZ1 - apZ2;   // = 14m
    const apH   = 3.3;
    const rockMat = matStd(0x6a6055, { roughness: 0.95 });
    const emb = mb(3.0, apH, apLen, rockMat);
    emb.position.set(RAIL_X, apH / 2, (apZ1 + apZ2) / 2);
    scene.add(emb);
  }

  // ── トンネルポータル (北側) ────────────────────────────────────────────────
  {
    const pz = -14;
    const px = RAIL_X;
    const stoneMat = matStd(0xb0aaa0, { roughness: 0.85 });
    const darkMat2 = matStd(0x060606, { roughness: 1.0 });
    const fillMat  = matStd(0x7a7060, { roughness: 0.9 });
    const tunMat   = matStd(0x9a9488, { roughness: 0.85 });
    const OW = 6.0, OH = 9.0, TW = 8.0, TH = 10.5, dep = 3.0;

    // 左柱 (幅1.0m)
    const lw = mb((TW - OW) / 2, TH, dep, stoneMat);
    lw.position.set(px - OW / 2 - (TW - OW) / 4, TH / 2, pz);
    scene.add(lw);
    // 右柱 (幅1.0m)
    const rw = mb((TW - OW) / 2, TH, dep, stoneMat);
    rw.position.set(px + OW / 2 + (TW - OW) / 4, TH / 2, pz);
    scene.add(rw);
    // 上部まぐさ
    const lintel = mb(TW, TH - OH, dep, stoneMat);
    lintel.position.set(px, OH + (TH - OH) / 2, pz);
    scene.add(lintel);
    // キーストーン
    const key = mb(1.0, 0.9, dep + 0.4, matStd(0x3e3830, { roughness: 0.95 }));
    key.position.set(px, OH + 0.3, pz);
    scene.add(key);
    // バットレス
    for (const sx of [-TW / 2 - 1.2, TW / 2 + 1.2]) {
      const butt = mb(2.4, TH + 1.0, dep + 0.8, matStd(0x4a4035, { roughness: 0.98 }));
      butt.position.set(px + sx, (TH + 1.0) / 2, pz);
      scene.add(butt);
    }

    // 線路より下の開口部を地面で埋める (y=0〜3.3m)
    const baseFill = mb(OW - 0.1, 3.3, dep, fillMat);
    baseFill.position.set(px, 1.65, pz);
    scene.add(baseFill);

    // ── 可視トンネル区間 (ポータルから12m先まで坑道が見える) ─────────────
    const visLen = 12;
    // 天井板
    const tunCeil = mb(OW + 0.05, 0.8, visLen, tunMat);
    tunCeil.position.set(px, OH - 0.4, pz - visLen / 2);
    scene.add(tunCeil);
    // 左右側壁
    for (const sx of [-(OW / 2 + 0.25), OW / 2 + 0.25]) {
      const sw = mb(0.5, OH, visLen, tunMat);
      sw.position.set(px + sx, OH / 2, pz - visLen / 2);
      scene.add(sw);
    }
    // 路盤 (線路下の地面)
    const tunFloor = mb(OW + 0.05, 3.3, visLen, fillMat);
    tunFloor.position.set(px, 1.65, pz - visLen / 2);
    scene.add(tunFloor);
    // 坑道入口の薄明かり
    const tunLight = new THREE.PointLight(0xaabbee, 1.2, 34);
    tunLight.position.set(px, OH * 0.55, pz - 5);
    scene.add(tunLight);

    // トンネル暗部 (可視区間の奥から深部まで)
    // 山側地形を自然に戻しても坑道内の見え抜けが出ないよう、暗部を少し広く取る。
    const tDark = mb(OW + 2.4, OH + 1.2, 180, darkMat2);
    tDark.position.set(px, OH / 2 + 0.3, pz - visLen - 90);
    scene.add(tDark);
  }

  // ── 海上橋梁 (南側: 海に入った地点から遠方の島へ) ──────────────────────────
  // 外周歩道(5m) + ビーチ(14m) = 19m 先から海が始まる
  {
    const CW2 = WORLD + ROAD;
    const ISLAND_Z = WORLD + 280;         // 島の中心Z (線路直線上)
    const bridgeZ1 = CW2;                 // ビーチ開始地点から橋・支柱を設置
    const bridgeZ2 = ISLAND_Z - 40;      // 島の手前まで橋を延ばす
    const bridgeLen = bridgeZ2 - bridgeZ1;
    const px = RAIL_X;
    const concMat2 = matStd(0x999999, { roughness: 0.6 });
    const steelMat  = matStd(0x778899, { roughness: 0.3, metalness: 0.7 });

    // 橋桁 (デッキ)
    const deck = mb(5.4, 0.5, bridgeLen, concMat2);
    deck.position.set(px, 2.88, (bridgeZ1 + bridgeZ2) / 2);
    scene.add(deck);

    // 側面ガーダー
    for (const sx of [-2.7, 2.7]) {
      const girder = mb(0.32, 0.85, bridgeLen, steelMat);
      girder.position.set(px + sx, 2.5, (bridgeZ1 + bridgeZ2) / 2);
      scene.add(girder);
      // 手すり
      const railing = mb(0.12, 0.65, bridgeLen, steelMat);
      railing.position.set(px + sx, 3.5, (bridgeZ1 + bridgeZ2) / 2);
      scene.add(railing);
      // 手すり支柱
      for (let rz = bridgeZ1 + 5; rz < bridgeZ2; rz += 7) {
        const post = mb(0.12, 1.1, 0.12, steelMat);
        post.position.set(px + sx, 3.1, rz);
        scene.add(post);
      }
    }

    // 橋起点 (ビーチ始端) に最初の支柱
    for (const sx of [-1.9, 1.9]) {
      const p0 = mb(1.1, 3.5, 1.1, concMat2);
      p0.position.set(px + sx, 3.5 / 2 - 0.2, bridgeZ1);
      scene.add(p0);
      const f0 = mb(2.2, 0.6, 2.2, concMat2);
      f0.position.set(px + sx, -0.3, bridgeZ1);
      scene.add(f0);
    }
    const bm0 = mb(5.4, 0.38, 0.75, concMat2);
    bm0.position.set(px, 2.7, bridgeZ1);
    scene.add(bm0);

    // 支持パイロン (28mごと)
    for (let pz2 = bridgeZ1 + 28; pz2 < bridgeZ2 - 5; pz2 += 28) {
      for (const sx of [-1.9, 1.9]) {
        const pylonH = 3.5;
        const pylon = mb(1.1, pylonH, 1.1, concMat2);
        pylon.position.set(px + sx, pylonH / 2 - 0.2, pz2);
        scene.add(pylon);
        const foot = mb(2.2, 0.6, 2.2, concMat2);
        foot.position.set(px + sx, -0.3, pz2);
        scene.add(foot);
      }
      const beam = mb(5.4, 0.38, 0.75, concMat2);
      beam.position.set(px, 2.7, pz2);
      scene.add(beam);
    }
  }

  // ── 遠方の島 (橋の先に見える目的地) ────────────────────────────────────────
  {
    const iz = WORLD + 280;   // 線路直線上 (ISLAND_Z と同値)
    const ix = RAIL_X;        // 線路と同じX座標
    const isGrass = matStd(0x4a8a30, { roughness: 0.9 });
    const isSand  = new THREE.MeshStandardMaterial({ color: 0xe8d5a3, roughness: 0.95 });
    const isRock  = matStd(0x5a5248, { roughness: 0.9 });

    // 砂浜の土台
    const sandBase = new THREE.Mesh(new THREE.CylinderGeometry(42, 46, 2.2, 14), isSand);
    sandBase.position.set(ix, -0.9, iz);
    scene.add(sandBase);
    // 草の丘
    const hill = new THREE.Mesh(new THREE.ConeGeometry(30, 24, 12), isGrass);
    hill.position.set(ix, 10, iz);
    scene.add(hill);
    // 岩峰
    const peak = new THREE.Mesh(new THREE.ConeGeometry(10, 16, 8), isRock);
    peak.position.set(ix - 6, 24, iz - 5);
    scene.add(peak);
    // 灯台
    const lhBody = new THREE.Mesh(
      new THREE.CylinderGeometry(2.5, 3.2, 24, 10),
      matStd(0xfafafa, { roughness: 0.4 })
    );
    lhBody.position.set(ix + 20, 12, iz - 14);
    scene.add(lhBody);
    const lhCap = mb(7, 1.2, 7, matStd(0x223355, { roughness: 0.5 }));
    lhCap.position.set(ix + 20, 24.6, iz - 14);
    scene.add(lhCap);
    const lhGlass = new THREE.Mesh(
      new THREE.SphereGeometry(2.0, 8, 8),
      matStd(0xffee88, { emissive: 0xffee88, emissiveIntensity: 2.8 })
    );
    lhGlass.position.set(ix + 20, 26.2, iz - 14);
    scene.add(lhGlass);
    // 樹木
    for (const [ox, oz, h] of [[-10, -6, 12], [-19, 8, 16], [5, 15, 10], [16, 6, 13], [-4, 22, 9]]) {
      const trunkH = h * 0.45;
      const trunk2 = new THREE.Mesh(
        new THREE.CylinderGeometry(0.28, 0.42, trunkH, 6),
        matStd(0x5a3020, { roughness: 0.9 })
      );
      trunk2.position.set(ix + ox, trunkH / 2 + 1.5, iz + oz);
      scene.add(trunk2);
      const crown2 = new THREE.Mesh(
        new THREE.ConeGeometry(h * 0.28, h * 0.55, 7),
        matStd(0x2d7a1a, { roughness: 0.9 })
      );
      crown2.position.set(ix + ox, trunkH + h * 0.27 + 1.5, iz + oz);
      scene.add(crown2);
    }
  }

  // ── Train cars: cab(0) + 2 middle + cab(3) (JR E235 Yokosuka/Sobu) ────────
  for (let i = 0; i < 4; i++) {
    const car = buildE235Car(scene, i === 0, i === 3);
    trainMeshes.push(car);
  }

  // Start near one end
  trainT = 0.05;

  // 初期ライト状態 (trainDir=+1 で出発: +z端が先頭)
  for (const end of cabEndLights) {
    const leading = end.isFrontEnd;
    for (const m of end.hlMeshes) m.visible =  leading;
    for (const m of end.tlMeshes) m.visible = !leading;
  }
}

// ── Update train ──────────────────────────────────────────────────────────────
export function updateTrain(dt) {
  const dist = Math.abs(trainT - STATION_T);

  let speed = 0;
  if (stopped) {
    stopTimer += dt;
    if (stopTimer >= STOP_SECONDS) {
      stopped       = false;
      stopTimer     = 0;
      postStopDelay = 4.0;  // coast away before checking stop zone again
    }
  } else if (postStopDelay > 0) {
    postStopDelay -= dt;
    speed = SLOW_SPEED * 2;  // accelerate gently out of station
  } else {
    if (dist < STOP_T) {
      stopped = true;
      stopTimer = 0;
      speed = 0;
    } else if (dist < APPROACH_T) {
      const ratio = (dist - STOP_T) / (APPROACH_T - STOP_T);
      speed = SLOW_SPEED + ratio * ratio * (FULL_SPEED - SLOW_SPEED);
    } else {
      speed = FULL_SPEED;
    }
  }

  trainT += speed * dt * trainDir;

  // Bounce at endpoints
  if (trainT >= 0.96) { trainT = 0.96; trainDir = -1; postStopDelay = 0; }
  if (trainT <= 0.04) { trainT = 0.04; trainDir =  1; postStopDelay = 0; }

  // ライト切替は不要 — 方向反転時に全車が rotation.y += PI されるため、
  // car0 の +z 前頭面は常に進行方向を向き続ける。初期状態を維持するだけで正しい。

  // Position each car along the curve
  const CAR_SPACING = 20.0 / (RAIL_TO_Z - RAIL_FROM_Z);  // 20m center-to-center
  for (let i = 0; i < trainMeshes.length; i++) {
    const t = Math.max(0.001, Math.min(0.999, trainT - i * CAR_SPACING * trainDir));
    const pos = trainCurve.getPointAt(t);
    const tan = trainCurve.getTangentAt(t).normalize();
    trainMeshes[i].position.copy(pos);
    trainMeshes[i].rotation.y = Math.atan2(tan.x, tan.z) + (trainDir < 0 ? Math.PI : 0);
  }
}
