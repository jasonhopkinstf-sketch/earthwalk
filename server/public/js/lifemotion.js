// How farm animals move: the one rule every client follows (docs/PROTOCOL.md, "Life").
//
// The server says where a herd lives (a "home": identity, animal, head count, roam radius). Where
// each animal is at a moment is worked out from that and the shared clock alone, never by stepping
// a simulation forward, so two players always agree, whenever they arrived.
//
// No three.js here: this file is also run by the server's tests.

/** The same hash as server/src/geo.ts. */
export function hash32(a, b = 0) {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

/**
 * Per animal: seconds per step (stand, then walk), the share of a step spent walking, walking pace
 * in metres a second, and how often it calls (once in `call` slots of CALL_SLOT seconds, on average).
 */
export const SPECIES = {
  cow: { step: 24, walk: 0.35, pace: 0.8, call: 14 },
  sheep: { step: 18, walk: 0.35, pace: 0.9, call: 11 },
  horse: { step: 20, walk: 0.4, pace: 1.4, call: 30 },
  chicken: { step: 5, walk: 0.45, pace: 1.1, call: 5 },
};
/** Every this many steps the whole herd moves to another part of its circle. */
export const HERD_STEPS = 8;
export const CALL_SLOT = 3;

const SALT_FOCUS = 0x464f4355;
const SALT_SPOT = 0x53504f54;
const SALT_PHASE = 0x50484153;
const SALT_GRAZE = 0x47524153;
const SALT_CALL = 0x43414c4c;
const WRAP = 0x40000000;

const unit = (a, b) => hash32(a, b) / 4294967296;
/** A point spread evenly over the unit disc, picked by a seed and a counter. x is east, y is south. */
function disc(seed, n) {
  const k = ((n % WRAP) + WRAP) % WRAP;
  const rad = Math.sqrt(unit(seed, 2 * k));
  const ang = 2 * Math.PI * unit(seed, 2 * k + 1);
  return [rad * Math.cos(ang), rad * Math.sin(ang)];
}

/** The identity of animal number `k` (from 0) of a home. */
export const memberId = (homeId, k) => hash32(homeId, k + 1);

/**
 * Where animal `k` of a home is at shared time `t` (seconds since 1970 on the server's clock).
 *
 * @param {{ id: number, sp: string, n: number, r: number }} home
 * @returns {{ id: number, x: number, y: number, yaw: number, moving: boolean, gait: number, pace: number, graze: boolean }}
 *   `x`, `y`: metres east and south of the home's centre, always within `home.r` of it.
 *   `yaw`: compass heading in degrees. `gait`: metres walked so far in this step, for swinging legs.
 *   `pace`: metres a second right now. `graze`: head down while standing.
 */
export function creatureAt(home, k, t) {
  const sp = SPECIES[home.sp] ?? SPECIES.cow;
  const id = memberId(home.id, k);
  // Each animal shuffles about its own small patch; the patches sit round a point the herd shares.
  const patch = Math.min((sp.pace * sp.walk * sp.step) / 2, home.r * 0.5);
  const room = Math.max(0, home.r - patch);
  // How far the shared point may be from the centre: small enough that moving with it is a trot, not a sprint.
  const drift = Math.min(room * 0.4, 0.75 * sp.pace * sp.walk * sp.step);
  const spread = room - drift;
  const focusSeed = hash32(home.id, SALT_FOCUS);
  const spot = disc(hash32(id, SALT_SPOT), 0);
  const at = (n) => {
    const focus = disc(focusSeed, Math.floor(n / HERD_STEPS));
    const own = disc(id, n);
    return [focus[0] * drift + spot[0] * spread + own[0] * patch, focus[1] * drift + spot[1] * spread + own[1] * patch];
  };

  const q = (t + unit(id, SALT_PHASE) * sp.step) / sp.step;
  const n = Math.floor(q);
  const f = q - n;
  const stand = 1 - sp.walk;
  const from = at(n);
  const to = at(n + 1);
  const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
  if (f < stand) {
    const before = at(n - 1);
    return {
      id, x: from[0], y: from[1], yaw: heading(from[0] - before[0], from[1] - before[1]),
      moving: false, gait: 0, pace: 0, graze: unit(id, (n % WRAP) ^ SALT_GRAZE) < 0.7,
    };
  }
  const g = (f - stand) / sp.walk;
  const s = g * g * (3 - 2 * g);
  return {
    id, x: from[0] + (to[0] - from[0]) * s, y: from[1] + (to[1] - from[1]) * s, yaw: heading(to[0] - from[0], to[1] - from[1]),
    moving: true, gait: length * s, pace: (length * 6 * g * (1 - g)) / (sp.walk * sp.step), graze: false,
  };
}

/** Compass heading in degrees of a direction (x east, y south): 0 north, 90 east. */
function heading(dx, dy) {
  return dx === 0 && dy === 0 ? 0 : ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
}

/**
 * When animal `id` of kind `sp` calls (moos, bleats...) during call slot `slot` (= floor(t / CALL_SLOT)):
 * the shared time in seconds, or null when it stays quiet. Everyone hears the same animal at the same moment.
 */
export function callTime(id, sp, slot) {
  const every = (SPECIES[sp] ?? SPECIES.cow).call;
  const k = ((slot % WRAP) + WRAP) % WRAP;
  if (hash32(id, k ^ SALT_CALL) % every !== 0) return null;
  return (slot + unit(id, k + 1)) * CALL_SLOT;
}
