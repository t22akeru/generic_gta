import { state } from './config.js?v=20260508-5';

// Add an AABB obstacle (infinite height unless y1/y2 specified)
export function addBox(x1, z1, x2, z2, y1 = 0, y2 = 100) {
  state.buildingBoxes.push({
    x1: Math.min(x1, x2), z1: Math.min(z1, z2),
    x2: Math.max(x1, x2), z2: Math.max(z1, z2),
    y1, y2,
  });
}

// Push a capsule (x, py, z, radius r) out of all solid obstacles.
// Returns { x, z } after resolution.
export function resolveAABB(x, py, z, r) {
  const MARGIN = 0.01;

  // Buildings and static furniture
  for (const b of state.buildingBoxes) {
    if (py + 1.8 < b.y1 || py - 0.5 > b.y2) continue;

    // Handle player inside box — push to nearest edge
    if (x > b.x1 && x < b.x2 && z > b.z1 && z < b.z2) {
      const pushes = [
        { dx: b.x1 - x - r - MARGIN, dz: 0 },
        { dx: b.x2 - x + r + MARGIN, dz: 0 },
        { dx: 0, dz: b.z1 - z - r - MARGIN },
        { dx: 0, dz: b.z2 - z + r + MARGIN },
      ];
      const best = pushes.reduce((a, c) =>
        Math.abs(a.dx) + Math.abs(a.dz) < Math.abs(c.dx) + Math.abs(c.dz) ? a : c
      );
      x += best.dx; z += best.dz;
      continue;
    }

    const cx = Math.max(b.x1, Math.min(x, b.x2));
    const cz = Math.max(b.z1, Math.min(z, b.z2));
    const dx = x - cx, dz = z - cz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < r + MARGIN) {
      const push = (r + MARGIN - dist) / (dist || 1);
      x += dx * push;
      z += dz * push;
    }
  }

  // NPC cars (skip the one being driven)
  for (const c of state.npcCars) {
    if (c === state.inCar) continue;
    const dx = x - c.x, dz = z - c.z;
    const dist = Math.sqrt(dx*dx + dz*dz);
    const minD = r + 2.0;
    if (dist < minD) {
      const push = (minD - dist) / (dist || 1);
      x += dx * push;
      z += dz * push;
    }
  }

  // Parked player cars
  for (const c of state.cars) {
    if (c === state.inCar) continue;
    if (!c.mesh) continue;
    const cp = c.mesh.position;
    const dx = x - cp.x, dz = z - cp.z;
    const dist = Math.sqrt(dx*dx + dz*dz);
    const minD = r + 2.2;
    if (dist < minD) {
      const push = (minD - dist) / (dist || 1);
      x += dx * push;
      z += dz * push;
    }
  }

  // Pedestrians (soft push, both ways)
  for (const p of state.pedestrians) {
    if (p.dead || p.mesh?.visible === false) continue;
    const dx = x - p.x, dz = z - p.z;
    const dist = Math.sqrt(dx*dx + dz*dz);
    const minD = r + 0.4;
    if (dist < minD && dist > 0.001) {
      const push = (minD - dist) / dist * 0.5;
      x += dx * push;
      z += dz * push;
      p.x -= dx * push;
      p.z -= dz * push;
    }
  }

  return { x, z };
}

// World boundary clamp
export function clampWorld(v, r, worldSize) {
  return Math.max(r, Math.min(worldSize - r, v));
}
