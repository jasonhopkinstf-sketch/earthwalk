// How animals move: the one rule every client follows (docs/PROTOCOL.md, "Life").
//
// The server says where a herd, a flock or a pet lives (a "home": identity, animal, head count,
// roam radius). Where each animal is at a moment is worked out from that and the shared clock
// alone, never by stepping a simulation forward, so two players always agree, whenever they arrived.
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
 * Per animal: seconds per step (stand, then walk), the share of a step spent walking, pace in
 * metres a second, and how often it calls (once in `call` slots of CALL_SLOT seconds on average;
 * 0 for an animal with no voice). Ducks follow the walking rule on water. `fly` marks the flock
 * that circles overhead, which has a rule of its own.
 */
export const SPECIES = {
  cow: { step: 24, walk: 0.35, pace: 0.8, call: 14 },
  sheep: { step: 18, walk: 0.35, pace: 0.9, call: 11 },
  horse: { step: 20, walk: 0.4, pace: 1.4, call: 30 },
  chicken: { step: 5, walk: 0.45, pace: 1.1, call: 5 },
  duck: { step: 9, walk: 0.6, pace: 0.45, call: 9 },
  pigeon: { step: 4, walk: 0.5, pace: 0.5, call: 8 },
  cat: { step: 30, walk: 0.2, pace: 0.9, call: 40 },
  dog: { step: 9, walk: 0.45, pace: 1.5, call: 25 },
  rabbit: { step: 7, walk: 0.3, pace: 1.6, call: 0 },
  deer: { step: 22, walk: 0.35, pace: 1.1, call: 0 },
  squirrel: { step: 4, walk: 0.45, pace: 1.5, call: 0 },
  kangaroo: { step: 16, walk: 0.3, pace: 2.0, call: 0 },
  llama: { step: 22, walk: 0.35, pace: 0.9, call: 0 },
  camel: { step: 26, walk: 0.35, pace: 0.9, call: 0 },
  penguin: { step: 8, walk: 0.5, pace: 0.5, call: 12 },
  bird: { step: 1, walk: 1, pace: 9, call: 10, fly: true },
};
/** Every this many steps the whole herd moves to another part of its circle. */
export const HERD_STEPS = 8;
export const CALL_SLOT = 3;

const SALT_FOCUS = 0x464f4355;
const SALT_SPOT = 0x53504f54;
const SALT_PHASE = 0x50484153;
const SALT_GRAZE = 0x47524153;
const SALT_CALL = 0x43414c4c;
const SALT_FLOCK = 0x464c4f43;
const WRAP = 0x40000000;
const TURN = Math.PI * 2;

const unit = (a, b) => hash32(a, b) / 4294967296;
/** A point spread evenly over the unit disc, picked by a seed and a counter. x is east, y is south. */
function disc(seed, n) {
  const k = ((n % WRAP) + WRAP) % WRAP;
  const rad = Math.sqrt(unit(seed, 2 * k));
  const ang = TURN * unit(seed, 2 * k + 1);
  return [rad * Math.cos(ang), rad * Math.sin(ang)];
}
/** A whole number of turns is dropped before taking the angle, so huge times lose no precision. */
const cycle = (t, seconds) => TURN * ((t / seconds) % 1);

/** The identity of animal number `k` (from 0) of a home. */
export const memberId = (homeId, k) => hash32(homeId, k + 1);

/**
 * Where animal `k` of a home is at shared time `t` (seconds since 1970 on the server's clock).
 *
 * @param {{ id: number, sp: string, n: number, r: number }} home
 * @returns {{ id: number, x: number, y: number, alt: number, yaw: number, moving: boolean, gait: number, pace: number, graze: boolean }}
 *   `x`, `y`: metres east and south of the home's centre, within `home.r` of it.
 *   `alt`: metres above the ground at the home's centre (0 except for flocks).
 *   `yaw`: compass heading in degrees. `gait`: metres moved so far in this step, for swinging legs.
 *   `pace`: metres a second right now. `graze`: head down while standing.
 */
export function creatureAt(home, k, t) {
  const sp = SPECIES[home.sp] ?? SPECIES.cow;
  if (sp.fly) return flyerAt(home, k, t, sp);
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
      id, x: from[0], y: from[1], alt: 0, yaw: heading(from[0] - before[0], from[1] - before[1]),
      moving: false, gait: 0, pace: 0, graze: unit(id, (n % WRAP) ^ SALT_GRAZE) < 0.7,
    };
  }
  const g = (f - stand) / sp.walk;
  const s = g * g * (3 - 2 * g);
  return {
    id, x: from[0] + (to[0] - from[0]) * s, y: from[1] + (to[1] - from[1]) * s, alt: 0, yaw: heading(to[0] - from[0], to[1] - from[1]),
    moving: true, gait: length * s, pace: (length * 6 * g * (1 - g)) / (sp.walk * sp.step), graze: false,
  };
}

/**
 * A bird of the flock that circles over a home. The flock flies a ring round the home's centre,
 * about 0.7 of `home.r` across, that slowly breathes in and out; bird 0 leads and the rest trail
 * behind it in a V. `alt` is 32 to 50 m, rising and falling a little.
 */
function flyerAt(home, k, t, sp) {
  const id = memberId(home.id, k);
  const seed = hash32(home.id, SALT_FLOCK);
  const way = seed & 1 ? 1 : -1; // clockwise or not
  const lap = (TURN * home.r * 0.7) / sp.pace; // seconds for one turn of the ring
  const a = way * cycle(t, lap) + TURN * unit(seed, 1);
  const ring = home.r * (0.6 + 0.15 * Math.sin(cycle(t, 47) + TURN * unit(seed, 2)));
  const out = [Math.cos(a), Math.sin(a)];
  const ahead = [-way * out[1], way * out[0]];
  const row = Math.ceil(k / 2);
  const side = k === 0 ? 0 : k % 2 ? 1 : -1;
  const back = row * 2.4 + 0.5 * Math.sin(cycle(t, 3.1) + k);
  const across = side * row * 1.7;
  return {
    id, x: out[0] * (ring + across) - ahead[0] * back, y: out[1] * (ring + across) - ahead[1] * back,
    alt: 32 + 18 * unit(seed, 3) + 2.5 * Math.sin(cycle(t, 11) + k * 1.3),
    yaw: heading(ahead[0], ahead[1]), moving: true, gait: (t % 1000) * sp.pace, pace: sp.pace, graze: false,
  };
}

/** Compass heading in degrees of a direction (x east, y south): 0 north, 90 east. */
function heading(dx, dy) {
  return dx === 0 && dy === 0 ? 0 : ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
}

/**
 * When animal `id` of kind `sp` calls (moos, quacks...) during call slot `slot` (= floor(t / CALL_SLOT)):
 * the shared time in seconds, or null when it stays quiet. Everyone hears the same animal at the same moment.
 */
export function callTime(id, sp, slot) {
  const every = (SPECIES[sp] ?? SPECIES.cow).call;
  if (!every) return null;
  const k = ((slot % WRAP) + WRAP) % WRAP;
  if (hash32(id, k ^ SALT_CALL) % every !== 0) return null;
  return (slot + unit(id, k + 1)) * CALL_SLOT;
}
