// ===== City Grid Constants =====
export const ROAD      = 16;   // Road width (m)
export const BLOCK     = 28;   // Block width (m, between roads)
export const CELL      = ROAD + BLOCK;  // one full cell (road + block)
export const GRID      = 5;    // 5×5 grid of blocks
export const WORLD     = GRID * CELL;   // total world size

export const SIDEWALK_W = 2.2;  // Sidewalk width
export const SIDEWALK_H = 0.14; // Sidewalk elevation above road
export const ROAD_Y     = 0.01; // Road surface Y
export const CURB_H     = 0.10; // Curb height

// ===== Camera =====
export const CAM_R         = 8.5;
export const CAM_PITCH_DEF = 0.30;
export const CAM_PITCH_MIN = -0.15;
export const CAM_PITCH_MAX = 1.3;

// ===== Player =====
export const PLAYER_H = 1.8;
export const PLAYER_R = 0.35;
export const WALK_SPD = 6;
export const RUN_SPD  = 13;

// ===== Shared Mutable State =====
export const state = {
  // Player position & camera
  px: 2 * CELL + ROAD / 2,
  py: PLAYER_H / 2 + SIDEWALK_H + 0.05,
  pz: 2 * CELL + ROAD / 2,
  camYaw:   0,
  camPitch: CAM_PITCH_DEF,

  // Game state
  inCar:    null,
  wanted:   0,
  walkPhase: 0,
  running:  false,
  timeOfDay: 0.28,
  dayLength: 420,

  // Input
  keys: {},

  // Player health
  hp:      100,
  maxHp:   100,
  gameOver: false,

  // Weapon
  weapon: 'pistol',
  ammo: 99,
  weaponCooldown: 0,

  // Police response
  policeUnits: [],
  policeDispatchTimer: 0,

  // Physics objects
  buildingBoxes: [],  // { x1, z1, x2, z2, y1, y2 }
  cars:          [],  // player-placed cars (parked)
  npcCars:       [],  // TrafficCar instances
  pedestrians:   [],  // Pedestrian instances
  ramps:         [],  // { x1,x2,z1,z2, yBase,yTop, axis:'x'|'z' }

  // Road graph
  roadNodes: [],
  roadAdj:   {},

  // Internal timers
  _bumpTimer:         0,
  _playerHitCooldown: 0,
  _blinkTimer:        0,
  _hpRegenTimer:      0,
};

export function raiseWanted(amount = 1) {
  state.wanted = Math.min(5, state.wanted + amount);
  state.policeDispatchTimer = 0;
  state._wantedDecay = 0;
}
