import * as THREE from 'three';

const loader = new THREE.TextureLoader();

// ── Canvas texture factory ──────────────────────────────────────────────────
function canvasTex(w, h, fn, repeat = 1) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  fn(ctx, w, h);
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  return t;
}

// ── Polyhaven loader with canvas fallback ────────────────────────────────────
function phTex(id, fallback, repeatU = 4, repeatV = 4) {
  const url = `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/${id}/${id}_diff_1k.jpg`;
  const t = loader.load(url,
    () => { t.needsUpdate = true; },
    undefined,
    () => { /* fallback already used */ }
  );
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatU, repeatV);
  t.image = fallback.image;   // immediately show fallback while loading
  return t;
}

// ── Pre-built canvas textures ────────────────────────────────────────────────
export const tex = {
  road: canvasTex(512, 512, (ctx, w, h) => {
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, w, h);
    // Subtle asphalt grain
    for (let i = 0; i < 3000; i++) {
      const gx = Math.random() * w, gy = Math.random() * h;
      const gs = Math.random() * 1.5;
      const gc = Math.random() * 30 + 25;
      ctx.fillStyle = `rgb(${gc},${gc},${gc})`;
      ctx.fillRect(gx, gy, gs, gs);
    }
  }, 6),

  sidewalk: canvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#bbb';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#999';
    ctx.lineWidth = 2;
    for (let x = 0; x < w; x += 32) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
    for (let y = 0; y < h; y += 32) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
  }, 4),

  brick: canvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#8B4513';
    ctx.fillRect(0, 0, w, h);
    const bw = 64, bh = 24;
    for (let row = 0; row * bh < h; row++) {
      const off = (row % 2) * (bw / 2);
      ctx.fillStyle = `hsl(${10 + Math.random()*20}, 60%, ${30 + Math.random()*15}%)`;
      for (let col = -1; col * bw < w + bw; col++) {
        const bx = col * bw + off, by = row * bh;
        ctx.fillRect(bx + 1, by + 1, bw - 2, bh - 2);
      }
    }
    ctx.strokeStyle = '#c8a87a';
    ctx.lineWidth = 1;
    for (let row = 0; row * bh < h; row++) {
      ctx.beginPath(); ctx.moveTo(0, row*bh); ctx.lineTo(w, row*bh); ctx.stroke();
      const off = (row%2)*(bw/2);
      for (let col = -1; col * bw < w + bw; col++) {
        ctx.beginPath(); ctx.moveTo(col*bw+off, row*bh); ctx.lineTo(col*bw+off, row*bh+bh); ctx.stroke();
      }
    }
  }, 2),

  concrete: canvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#888';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 2000; i++) {
      const gx = Math.random()*w, gy = Math.random()*h;
      const gc = Math.random()*40+100;
      ctx.fillStyle = `rgb(${gc},${gc},${gc})`;
      ctx.fillRect(gx, gy, 1, 1);
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 64) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,h); ctx.stroke(); }
    for (let y = 0; y < h; y += 64) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke(); }
  }, 3),

  glass: canvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#4af';
    ctx.fillRect(0, 0, w, h);
    // Window grid
    ctx.fillStyle = 'rgba(200,240,255,0.35)';
    for (let x = 0; x < w; x += 24) for (let y = 0; y < h; y += 32) {
      ctx.fillRect(x+2, y+2, 18, 26);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fillRect(0, 0, w/4, h);
  }, 2),

  marble: canvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#e8e0d0';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(180,160,130,0.4)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 8; i++) {
      ctx.beginPath();
      ctx.moveTo(Math.random()*w, 0);
      for (let s = 0; s < 5; s++) ctx.bezierCurveTo(Math.random()*w,Math.random()*h,Math.random()*w,Math.random()*h,Math.random()*w,h);
      ctx.stroke();
    }
  }, 2),

  rust: canvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#6b3a28';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 1500; i++) {
      const gx = Math.random()*w, gy = Math.random()*h;
      const hue = 10 + Math.random()*20;
      const light = 30 + Math.random()*30;
      ctx.fillStyle = `hsl(${hue},60%,${light}%)`;
      ctx.fillRect(gx, gy, Math.random()*4, Math.random()*4);
    }
  }, 2),

  wood: canvasTex(256, 256, (ctx, w, h) => {
    for (let y = 0; y < h; y++) {
      const v = Math.sin(y * 0.15 + Math.sin(y * 0.05) * 3) * 0.5 + 0.5;
      const r = Math.floor(120 + v * 60), g = Math.floor(70 + v * 40), b = 30 + Math.floor(v * 20);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, y, w, 1);
    }
  }, 2),

  grass: canvasTex(512, 512, (ctx, w, h) => {
    ctx.fillStyle = '#3a6e2a';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 3000; i++) {
      const gx = Math.random()*w, gy = Math.random()*h;
      const light = 30 + Math.random()*30;
      ctx.fillStyle = `hsl(100,${40+Math.random()*30}%,${light}%)`;
      ctx.fillRect(gx, gy, 1+Math.random()*2, 1+Math.random()*3);
    }
  }, 8),

  bark: canvasTex(128, 256, (ctx, w, h) => {
    for (let y = 0; y < h; y += 3) {
      const v = Math.sin(y * 0.3) * 0.5 + 0.5;
      ctx.fillStyle = `hsl(25,${40+v*20}%,${15+v*15}%)`;
      ctx.fillRect(0, y, w, 3);
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    for (let y = 0; y < h; y += 8) {
      ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y+Math.random()*4-2); ctx.stroke();
    }
  }, 1),

  leaves: canvasTex(128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#1a5c10';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 500; i++) {
      const gx = Math.random()*w, gy = Math.random()*h;
      const light = 25 + Math.random()*25;
      ctx.fillStyle = `hsl(${100+Math.random()*30},60%,${light}%)`;
      ctx.fillRect(gx, gy, Math.random()*6, Math.random()*6);
    }
  }, 1),

  tarmac: canvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 1200; i++) {
      const gc = Math.random()*20+15;
      ctx.fillStyle = `rgb(${gc},${gc},${gc})`;
      ctx.fillRect(Math.random()*w, Math.random()*h, Math.random()*2, Math.random()*2);
    }
  }, 4),
};

// ── Material helpers ─────────────────────────────────────────────────────────
export function matStd(color, options = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.0, ...options });
}

export function matTex(texture, options = {}) {
  return new THREE.MeshStandardMaterial({ map: texture, roughness: 0.85, metalness: 0.0, ...options });
}

export function matGlass() {
  return new THREE.MeshPhysicalMaterial({
    map: tex.glass,
    color: 0x88ccff,
    roughness: 0.05,
    metalness: 0.1,
    transmission: 0.6,
    transparent: true,
    opacity: 0.75,
  });
}

export function matCar(color) {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.25,
    metalness: 0.6,
    clearcoat: 1.0,
    clearcoatRoughness: 0.1,
  });
}

// ── Window wall textures ──────────────────────────────────────────────────────
function winWallTex(bgHex, winHex, cols, rows, groundFloorStyle) {
  return canvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = bgHex;
    ctx.fillRect(0, 0, w, h);
    const cw = w / cols, rh = h / rows;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const ground = r === rows - 1;
        if (ground && groundFloorStyle === 'shop') {
          // Wide shop window
          ctx.fillStyle = '#334455';
          ctx.fillRect(c * cw + 2, r * rh + rh * 0.2, cw - 4, rh * 0.65);
        } else if (ground && groundFloorStyle === 'door') {
          ctx.fillStyle = c === Math.floor(cols / 2) ? '#1a1a2a' : winHex;
          ctx.fillRect(c * cw + 3, r * rh + 3, cw - 6, rh - 4);
        } else {
          ctx.fillStyle = winHex;
          ctx.fillRect(c * cw + 4, r * rh + 3, cw - 8, rh - 6);
        }
      }
    }
    // Vertical structural lines
    ctx.strokeStyle = 'rgba(0,0,0,0.2)';
    ctx.lineWidth = 2;
    for (let c = 0; c <= cols; c++) { ctx.beginPath(); ctx.moveTo(c*cw,0); ctx.lineTo(c*cw,h); ctx.stroke(); }
  }, 2);
}

tex.officeWin   = winWallTex('#3a3a4a', '#aaddff', 6, 10, 'shop');
tex.apartWin    = winWallTex('#8B4513', '#ffe8c0', 4, 8,  'door');
tex.modernWin   = winWallTex('#555566', '#88ccff', 5, 9,  'shop');
tex.luxuryWin   = winWallTex('#e8e0d0', '#aaddee', 4, 6,  'door');
tex.industrialW = winWallTex('#6b3a28', '#cc6633', 3, 4,  'door');
tex.warehouseW  = winWallTex('#555544', '#886644', 3, 3,  'shop');
tex.comboWin    = winWallTex('#884422', '#99bbdd', 5, 8,  'shop');

// 7 different building wall material sets (multi-material arrays)
export const buildingMats = [
  // 0: Brick apartment with warm windows
  () => [matTex(tex.apartWin), matTex(tex.apartWin), matTex(tex.concrete,{color:0xbbbbbb}), null, matTex(tex.apartWin), matTex(tex.apartWin)],
  // 1: Glass office tower
  () => [matTex(tex.officeWin), matTex(tex.officeWin), matTex(tex.concrete,{color:0x444444}), null, matTex(tex.officeWin), matTex(tex.officeWin)],
  // 2: Modern concrete with windows
  () => [matTex(tex.modernWin), matTex(tex.modernWin), matTex(tex.concrete,{color:0x999999}), null, matTex(tex.modernWin), matTex(tex.modernWin)],
  // 3: Luxury marble with light windows
  () => [matTex(tex.luxuryWin), matTex(tex.luxuryWin), matTex(tex.marble,{color:0xfaf0e0}), null, matTex(tex.luxuryWin), matTex(tex.luxuryWin)],
  // 4: Industrial warehouse
  () => [matTex(tex.industrialW), matTex(tex.industrialW), matTex(tex.rust,{color:0x7a4030}), null, matTex(tex.industrialW), matTex(tex.industrialW)],
  // 5: Warehouse / storage
  () => [matTex(tex.warehouseW), matTex(tex.warehouseW), matTex(tex.concrete,{color:0x888888}), null, matTex(tex.warehouseW), matTex(tex.warehouseW)],
  // 6: Mixed brick+glass corner building
  () => [matTex(tex.comboWin), matTex(tex.apartWin), matTex(tex.concrete,{color:0xaaaaaa}), null, matTex(tex.comboWin), matTex(tex.apartWin)],
];
