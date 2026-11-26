// How cars move: the one rule every client follows (docs/PROTOCOL.md, "Traffic").
//
// The server works out each trip: the middle of the road the car follows and when it reaches each
// point. A car waits at one end, drives out, waits at the far end, and drives back, over and over.
// Where it is at a moment comes from the trip and the shared clock alone, so everyone agrees.
//
// No three.js here: this file is also run by the server's tests.

import { hash32 } from "./lifemotion.js";

const SALT_TRIP = 0x54524950;
const SALT_TRAIN = 0x54524149;
/** From the edge of the road to the middle of a parked car, in metres. */
export const KERB_IN = 0.95;
/** A car takes this many metres to pull out from the kerb into its lane, and to pull in again. */
export const EASE_M = 10;

/** A car, for keeping cars out of each other: how long and how wide, in metres. */
export const CAR_LONG = 4.3;
export const CAR_WIDE = 1.85;
/** The air a moving car leaves between itself and a car at the kerb. */
export const KERB_GAP = 0.4;
/** Two cars whose middles are this near along the road are side by side; a car steers out round one over SWERVE_M more. */
export const ABEAM_M = CAR_LONG + 0.2;
export const SWERVE_M = 10;
/** How much of the turn its path makes a car's body shows as it steers over. */
export const STEER = 0.5;
/** At an end of its trip a car is let in to the kerb, or out from it, over this many metres, whatever stands next door. */
export const END_FREE_M = 4.6;

/** The car's heading is taken across this many metres of road either side of it, so it rounds a corner. */
export const TURN_M = 3;

const smooth = (g) => g * g * (3 - 2 * g);

/** The point `d` metres along the middle of the road, or along the track. */
export function pointAt(trip, d) {
  const p = trip.path;
  let lo = 0;
  let hi = trip.n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (trip.dist[mid] <= d) lo = mid; else hi = mid;
  }
  const run = trip.dist[hi] - trip.dist[lo];
  const f = run > 0 ? Math.min(1, Math.max(0, (d - trip.dist[lo]) / run)) : 0;
  return [p[lo * 3] + (p[hi * 3] - p[lo * 3]) * f, p[lo * 3 + 1] + (p[hi * 3 + 1] - p[lo * 3 + 1]) * f];
}

/**
 * How far above the ground (or below it, in a tunnel) the way is `d` metres along it: from the trip's
 * `lift`, a number for each point of its path, where the server sent one. 0 on the ground.
 */
export function liftAt(trip, d) {
  const lift = trip.lift;
  if (!lift) return 0;
  let lo = 0;
  let hi = trip.n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (trip.dist[mid] <= d) lo = mid; else hi = mid;
  }
  const run = trip.dist[hi] - trip.dist[lo];
  const f = run > 0 ? Math.min(1, Math.max(0, (d - trip.dist[lo]) / run)) : 0;
  return lift[lo] + (lift[hi] - lift[lo]) * f;
}

/**
 * Makes a trip ready to replay.
 * @param {{ id: number, w: number, left: boolean, da: number, db: number, path: number[], lift?: number[] | null }} trip
 *   `path` is x, y, seconds, x, y, seconds...: metres east and south of any fixed point, and the
 *   seconds since setting off. `w` is the road's width, `da` and `db` the waits at each end. `lift`,
 *   when there is one, is how far above the ground each point of the path is.
 */
export function prepare(trip) {
  const n = Math.floor(trip.path.length / 3);
  const dist = new Float64Array(n);
  for (let i = 1; i < n; i++) dist[i] = dist[i - 1] + Math.hypot(trip.path[i * 3] - trip.path[i * 3 - 3], trip.path[i * 3 + 1] - trip.path[i * 3 - 2]);
  const time = trip.path[(n - 1) * 3 + 2];
  return { ...trip, n, dist, time, length: dist[n - 1], period: trip.da + trip.db + 2 * time };
}

/** Compass heading in degrees of the path `d` metres along it, taken across `reach` metres either side. */
export function headingAt(trip, d, reach = TURN_M) {
  const a = pointAt(trip, Math.max(0, d - reach));
  const b = pointAt(trip, Math.min(trip.length, d + reach));
  return ((Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180) / Math.PI + 360) % 360;
}

/**
 * Where a train stands to be boarded, as metres along its track: each end of its run, and every station
 * on it (where the timetable has two points in one place, eight seconds or more apart).
 */
export function stopsAlong(train) {
  const out = [0];
  for (let i = 0; i + 1 < train.n; i++) {
    if (train.dist[i + 1] - train.dist[i] <= 0 && train.path[(i + 1) * 3 + 2] - train.path[i * 3 + 2] >= 8) out.push(train.dist[i]);
  }
  out.push(train.length);
  return out;
}

/**
 * Where a train is at shared time `t`: it waits at the start, runs out along its track (standing a
 * while at each station, where the path has two points in one place), waits at the far end and
 * runs back. A train is the same at both ends, so it never turns round.
 * @returns {{ along: number, back: boolean, moving: boolean, leg: number, stood: number }}
 *   `along`: metres along the track, from 0 to `train.length`. `back`: heading for the start.
 *   `stood`: how many seconds it has been standing at the end of its run it is at (legs 0 and 2), else 0.
 */
export function trainPose(train, t) {
  const tau = (((t + (hash32(train.id, SALT_TRAIN) / 4294967296) * train.period) % train.period) + train.period) % train.period;
  let leg = 0;
  let at = 0;
  if (tau >= train.da + train.time + train.db) { leg = 3; at = train.time - (tau - train.da - train.time - train.db); }
  else if (tau >= train.da + train.time) { leg = 2; at = train.time; }
  else if (tau >= train.da) { leg = 1; at = tau - train.da; }
  const p = train.path;
  let lo = 0;
  let hi = train.n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p[mid * 3 + 2] <= at) lo = mid; else hi = mid;
  }
  const span = p[hi * 3 + 2] - p[lo * 3 + 2];
  const f = span > 0 ? Math.min(1, Math.max(0, (at - p[lo * 3 + 2]) / span)) : 0;
  const run = train.dist[hi] - train.dist[lo];
  return { along: train.dist[lo] + run * f, back: leg === 0 || leg === 3, moving: (leg === 1 || leg === 3) && run > 0, leg, stood: leg === 0 ? tau : leg === 2 ? tau - train.da - train.time : 0 };
}

// ---------------------------------------------------------------- a train that carries on
//
// A train shuttles along its own run, which ends where its square of the map ends (about two kilometres), and
// there the track goes on as another train's run. Somebody riding does not want to be taken back: so where the
// track goes on, their train carries on along it, run after run, as far as the line does (traffic.js).

/** How long a train stands at the end of its run before it carries on down the line with whoever is aboard. */
export const THROUGH_DWELL_S = 6;
/** Two runs are the same track going on when an end of each is this near the other, and they point much the same way. */
export const JOIN_M = 12;

/**
 * A train run along once, by a clock of its own: `since` seconds after it set off from one end (the far end
 * when `back`), at the pace the timetable has, standing at each station as the timetable does.
 * @returns {{ along: number, moving: boolean, done: boolean }}  `done`: it has reached the other end.
 */
export function runPose(train, since, back) {
  const gone = Math.min(train.time, Math.max(0, since));
  const at = back ? train.time - gone : gone;
  const p = train.path;
  let lo = 0;
  let hi = train.n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p[mid * 3 + 2] <= at) lo = mid; else hi = mid;
  }
  const span = p[hi * 3 + 2] - p[lo * 3 + 2];
  const f = span > 0 ? Math.min(1, Math.max(0, (at - p[lo * 3 + 2]) / span)) : 0;
  const run = train.dist[hi] - train.dist[lo];
  return { along: train.dist[lo] + run * f, moving: since > 0 && since < train.time && run > 0, done: since >= train.time };
}

/**
 * The run a train goes on along from one end of its own (`far`: its far end, else its start): of `others`, the
 * one with an end nearest that point, within JOIN_M, that leads on much the way the train was going.
 * @returns {{ train: object, back: boolean } | null}  `back`: it is entered at its far end, and so run backwards.
 */
export function joinOf(train, far, others) {
  const [x, y] = pointAt(train, far ? train.length : 0);
  const [bx, by] = pointAt(train, far ? train.length - 12 : 12);
  const going = [x - bx, y - by]; // the way it was going as it reached this end
  let best = null;
  let least = JOIN_M;
  for (const other of others) {
    if (other === train || other.id === train.id) continue;
    for (const back of [false, true]) {
      const [ox, oy] = pointAt(other, back ? other.length : 0);
      const d = Math.hypot(ox - x, oy - y);
      if (d >= least) continue;
      const [nx, ny] = pointAt(other, back ? other.length - 12 : 12);
      const on = [nx - ox, ny - oy]; // the way it leads on from that end
      const turn = Math.abs(Math.atan2(going[0] * on[1] - going[1] * on[0], going[0] * on[0] + going[1] * on[1]));
      if (turn > 1.2) continue;
      least = d;
      best = { train: other, back };
    }
  }
  return best;
}

/**
 * Where a point is against a trip's path: how many metres along the middle of the road the nearest point of it
 * is, how far to the side the point is of that (`aside`: positive to the right of the way out), and how far off.
 */
export function alongOf(trip, x, y) {
  const p = trip.path;
  let best = { along: 0, aside: 0, d: Infinity };
  for (let i = 0; i + 1 < trip.n; i++) {
    const ax = p[i * 3], ay = p[i * 3 + 1];
    const dx = p[i * 3 + 3] - ax, dy = p[i * 3 + 4] - ay;
    const len = trip.dist[i + 1] - trip.dist[i];
    if (len <= 0) continue;
    const f = Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / (len * len)));
    const d = Math.hypot(x - ax - dx * f, y - ay - dy * f);
    if (d < best.d) best = { along: trip.dist[i] + len * f, aside: ((x - ax) * -dy + (y - ay) * dx) / len, d };
  }
  return best;
}

/**
 * Tells a trip what stands at the kerbs of its road: `spots` are cars at rest, each { x, y, key }, in the path's
 * own metres. Those beside the road the trip follows are kept with it (`trip.spots`), and tripPose steers the
 * car out round them. `key` says whose spot it is, for asking each moment whether anything stands there.
 */
export function setSpots(trip, spots) {
  const kept = [];
  for (const s of spots) {
    if (Math.abs(s.x - trip.path[0]) > trip.length + 20 || Math.abs(s.y - trip.path[1]) > trip.length + 20) continue;
    const at = alongOf(trip, s.x, s.y);
    // Beside the road, not past an end of it, and not in the middle of it either.
    if (Math.abs(at.aside) < 0.6 || Math.abs(at.aside) > 7 || at.d > Math.abs(at.aside) + 0.5) continue;
    kept.push({ along: at.along, aside: at.aside, key: s.key });
  }
  trip.spots = kept;
  return trip;
}

const phaseOf = (trip) => (hash32(trip.id, SALT_TRIP) / 4294967296) * trip.period;

/** Where a trip's car stands while it waits: at the start of its trip, or (`far`) at the far end. */
export function restPose(trip, far) {
  return tripPose(trip, (far ? trip.da + trip.time + 0.5 : 0.5) - phaseOf(trip), () => 0);
}

/**
 * Where a car is at shared time `t` (seconds since 1970 on the server's clock).
 * `hold`, where the trip knows what stands at its kerbs (setSpots), says how much each spot counts just now:
 * 1 a car at rest there, 0 nothing, and between the two while one pulls in or out. Left out, they all count.
 * @returns {{ x: number, y: number, yaw: number, moving: boolean, leg: number, pace: number, inLane: boolean, lift: number }}
 *   `x`, `y` in the path's own metres, on the car's side of the road. `lift` is how far above the
 *   ground the road is there (on a bridge). `yaw` is the compass heading
 *   of the way it is going. `leg`: 0 waiting at the start, 1 driving out, 2 waiting at the far end,
 *   3 driving back. `inLane` is false while it is pulling out from a kerb or in to one. `out` is true
 *   while it has steered out of its lane round a car at the kerb. `tuck` (0 to 1) draws it in to its own kerb,
 *   as far as there is room: a car standing to let another by.
 */
export function tripPose(trip, t, hold = null, tuck = 0) {
  const tau = (((t + (hash32(trip.id, SALT_TRIP) / 4294967296) * trip.period) % trip.period) + trip.period) % trip.period;
  let leg = 0;
  let at = 0; // seconds along the path
  if (tau >= trip.da + trip.time + trip.db) { leg = 3; at = trip.time - (tau - trip.da - trip.time - trip.db); }
  else if (tau >= trip.da + trip.time) { leg = 2; at = trip.time; }
  else if (tau >= trip.da) { leg = 1; at = tau - trip.da; }
  const back = leg === 0 || leg === 3; // facing back towards the start

  // The stretch of path the car is on.
  const p = trip.path;
  let lo = 0;
  let hi = trip.n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p[mid * 3 + 2] <= at) lo = mid; else hi = mid;
  }
  const span = p[hi * 3 + 2] - p[lo * 3 + 2];
  const f = span > 0 ? Math.min(1, Math.max(0, (at - p[lo * 3 + 2]) / span)) : 0;
  const run = trip.dist[hi] - trip.dist[lo];
  const along = trip.dist[lo] + run * f;
  // The way it faces: along the road from a little behind it to a little ahead.
  const behind = pointAt(trip, Math.max(0, along - TURN_M));
  const ahead = pointAt(trip, Math.min(trip.length, along + TURN_M));
  const reach = Math.hypot(ahead[0] - behind[0], ahead[1] - behind[1]) * (back ? -1 : 1);
  const dx = reach ? (ahead[0] - behind[0]) / reach : 0;
  const dy = reach ? (ahead[1] - behind[1]) / reach : 0;

  // How far over from the middle of the road: it sets off from the far kerb (it was facing the other
  // way), settles into its lane, and pulls in to the kerb on its own side at the end.
  const driven = back ? trip.length - along : along;
  const kerb = Math.max(0.6, trip.w / 2 - KERB_IN);
  const lane = Math.min(trip.w / 4, kerb);
  const hand = trip.left ? -1 : 1;
  const g0 = smooth(Math.min(1, driven / EASE_M));
  const g1 = smooth(Math.min(1, (trip.length - driven) / EASE_M));
  // Its own side of the road, as the path sees it: to the right of the way out, or to the left.
  const mine = hand * (back ? -1 : 1);
  const spots = trip.spots && trip.spots.length > 0 ? trip.spots : null;
  /** How far over from the middle it is, towards its own kerb, once it has driven `dr` metres of this leg. */
  const ownAt = (dr) => {
    const d = Math.min(trip.length, Math.max(0, dr));
    const e0 = smooth(Math.min(1, d / EASE_M));
    const e1 = smooth(Math.min(1, (trip.length - d) / EASE_M));
    const eased = (lane * e0 - kerb * (1 - e0)) * e1 + kerb * (1 - e1);
    const own = tuck > 0 ? eased + (kerb - eased) * tuck * e0 : eased;
    if (!spots) return own;
    // Cars at the kerb: it keeps clear of each one it is beside, steering out before it and back in after.
    const at = back ? trip.length - d : d;
    const free = smooth(Math.min(1, Math.min(d, trip.length - d) / END_FREE_M));
    let most = Infinity; // the furthest towards its own kerb it may be
    let least = -Infinity; // and the furthest towards the other
    for (const s of spots) {
      const gap = Math.abs(s.along - at);
      if (gap >= ABEAM_M + SWERVE_M) continue;
      const counts = hold ? hold(s.key) : 1;
      if (!(counts > 0)) continue;
      const weight = (gap <= ABEAM_M ? 1 : 1 - smooth((gap - ABEAM_M) / SWERVE_M)) * Math.min(1, counts) * free;
      // (It moves over from where it would have been, no further than it must: so it steers gently.)
      const clear = Math.abs(s.aside) - CAR_WIDE - KERB_GAP;
      if ((s.aside > 0 ? 1 : -1) === mine) { if (clear < own) most = Math.min(most, own + (clear - own) * weight); }
      else if (-clear > own) least = Math.max(least, own + (-clear - own) * weight);
    }
    // (Cars at both kerbs with too little room between them: down the middle of what room there is.)
    return most < least ? (most + least) / 2 : Math.min(most, Math.max(least, own));
  };
  const own = ownAt(driven);
  const over = own * hand;
  // It points a little the way it is steering, as it pulls out, pulls in and goes round a car at the kerb:
  // half the turn its path makes, so that its corners do not swing into what it is passing.
  const steer = spots || g0 < 1 || g1 < 1 ? Math.max(-0.3, Math.min(0.3, Math.atan((ownAt(driven + 0.6) - ownAt(driven - 0.6)) / 1.2) * STEER)) * hand : 0;

  const moving = leg === 1 || leg === 3;
  return {
    x: p[lo * 3] + (p[hi * 3] - p[lo * 3]) * f - dy * over, // to the right of the way it faces is (-dy, dx)
    y: p[lo * 3 + 1] + (p[hi * 3 + 1] - p[lo * 3 + 1]) * f + dx * over,
    yaw: (((Math.atan2(dx, -dy) + (moving ? steer : 0)) * 180) / Math.PI + 360) % 360,
    moving, leg, pace: moving && span > 0 ? run / span : 0, inLane: moving && g0 === 1 && g1 === 1,
    lift: trip.lift ? trip.lift[lo] + (trip.lift[hi] - trip.lift[lo]) * f : 0,
    rolled: driven, // metres since it last set off: what its wheels have turned through
    out: moving && g0 === 1 && g1 === 1 && lane - own > 0.3 && !(tuck > 0),
  };
}

// ---------------------------------------------------------------- giving way
//
// A trip is a timetable, and every car keeps its own with no thought for the others. So that they do not
// drive through each other, each game holds a car back when it would run into another: the car falls behind
// its timetable (its `lag`, in seconds) while it waits, and makes the time up afterwards. Cars at the kerb are
// not waited for: tripPose steers round them. What is worked out here is who waits for whom.

/** How far ahead a car looks, in seconds of its own timetable, for anything it would run into. */
export const AHEAD_S = [0.6, 1.2, 1.8, 2.4, 3.0, 3.6, 4.2];
/**
 * And further ahead than that, for one thing only: a car coming the other way where there is room for one,
 * between cars parked at both kerbs. It is waited for before the narrow stretch, not in it.
 */
export const FAR_S = [5.4, 6.6, 7.8, 9.0, 10.2, 11.4, 12.6];
const LOOKS = [...AHEAD_S, ...FAR_S];
/** Two cars that have waited for each other this long are let through each other, so nothing stands for ever. */
export const STUCK_S = 8;
/** The longest a car falls behind its timetable before it stops waiting for anything. */
export const LAG_MOST_S = 90;

/** A car's box on the ground, a little larger than the car. */
function boxOf(pose) {
  const a = (pose.yaw * Math.PI) / 180;
  return { x: pose.x, y: pose.y, fx: Math.sin(a), fy: -Math.cos(a) };
}
/**
 * Whether two cars' boxes are inside each other. For giving way a car counts as a little larger than it is, so
 * that cars keep some air between them; `long` and `wide` say another size (the car's own, for a test).
 */
export function boxesMeet(a, b, long = CAR_LONG + 0.5, wide = CAR_WIDE + 0.1) {
  const HALF_LONG = long / 2;
  const HALF_WIDE = wide / 2;
  const rx = b.x - a.x, ry = b.y - a.y;
  if (rx * rx + ry * ry > 36) return false;
  // Along each box's two axes in turn: apart along any one of them is apart.
  const dot = Math.abs(a.fx * b.fx + a.fy * b.fy), cross = Math.abs(a.fx * b.fy - a.fy * b.fx);
  if (Math.abs(rx * a.fx + ry * a.fy) > HALF_LONG + HALF_LONG * dot + HALF_WIDE * cross) return false;
  if (Math.abs(-rx * a.fy + ry * a.fx) > HALF_WIDE + HALF_LONG * cross + HALF_WIDE * dot) return false;
  if (Math.abs(rx * b.fx + ry * b.fy) > HALF_LONG + HALF_LONG * dot + HALF_WIDE * cross) return false;
  if (Math.abs(-rx * b.fy + ry * b.fx) > HALF_WIDE + HALF_LONG * cross + HALF_WIDE * dot) return false;
  return true;
}

/** How much a trip's car counts as standing at each end of its trip: 1 at rest there, less as it pulls out or in. */
function restsAt(trip, pose) {
  const gone = 1 - smooth(Math.min(1, pose.rolled / EASE_M));
  const come = 1 - smooth(Math.min(1, (trip.length - pose.rolled) / EASE_M));
  if (pose.leg === 0) return [1, 0];
  if (pose.leg === 2) return [0, 1];
  return pose.leg === 1 ? [gone, come] : [come, gone];
}

/**
 * One moment of giving way, for the cars a game has. Each of `cars` is { trip, st }: `st` is the car's own
 * and is kept from one moment to the next ({ lag: 0 } to begin with). Afterwards each has its `pose`: where
 * it is now, lag and all.
 * @param {{ trip: object, st: object, pose?: object }[]} cars
 * @param {number} t   the shared clock
 * @param {number} dt  seconds since the last moment
 * @param {{ gone?: (key: string) => boolean, also?: (car: object) => boolean }} [how]
 *   `gone`: whether a parked car's spot is empty just now (somebody drove it off). `also`: whether something
 *   else is in a car's way (a player), which holds it back the same.
 */
export function giveWay(cars, t, dt, how = {}) {
  // What stands at each trip's two ends just now, for the cars that steer round them.
  const rests = new Map();
  for (const c of cars) {
    const st = c.st;
    if (!(st.lag >= 0)) st.lag = 0;
    if (!Number.isFinite(st.rate)) st.rate = 0;
    if (!(st.tuck >= 0)) st.tuck = 0;
    const [a, b] = restsAt(c.trip, tripPose(c.trip, t - st.lag, () => 0));
    rests.set(`a${c.trip.id}`, a);
    rests.set(`b${c.trip.id}`, b);
  }
  const hold = (key) => (key.charCodeAt(0) === 112 ? (how.gone?.(key) ? 0 : 1) : rests.get(key) ?? 0); // 112: "p", a parked car
  for (const c of cars) {
    const tau = t - c.st.lag;
    c.pose = tripPose(c.trip, tau, hold, c.st.tuck);
    c.box = boxOf(c.pose);
    c.ahead = LOOKS.map((s) => {
      const pose = tripPose(c.trip, tau + s, hold);
      return pose.moving ? boxOf(pose) : null;
    });
    c.going = c.pose.moving || c.ahead.some((box) => box);
    // Who gives way to whom when two would meet: a car pulling out waits for one in its lane, and a car in its
    // lane for one that is already out round a parked car or pulling in.
    const left = c.trip.length - c.pose.rolled;
    c.rank = !c.pose.moving || c.pose.rolled < EASE_M ? 0 : c.pose.out || left < EASE_M ? 2 : 1;
    c.waits = 0; // 2: for something it is about to run into; 1: for a car coming the other way through a narrow stretch ahead
    c.jam = false;
  }
  /**
   * Whether `a`, going on as its timetable has it, would run into `b`: where b will be, or where b stands if it
   * is waiting. 2: within the next few seconds. 1: later than that, head on. 0: no.
   */
  const wouldHit = (a, b) => {
    const still = !!b.st.blocked;
    for (let i = 0; i < LOOKS.length; i++) {
      const mine = a.ahead[i];
      if (!mine) continue;
      const far = i >= AHEAD_S.length;
      if (still) {
        if (!far && boxesMeet(mine, b.box)) return 2;
        continue;
      }
      for (let j = i - 1; j <= i + 1; j++) {
        const theirs = j < 0 ? b.box : j < LOOKS.length ? b.ahead[j] ?? b.ahead.findLast((box, k) => box && k < j) ?? b.box : null;
        if (!theirs || (far && mine.fx * theirs.fx + mine.fy * theirs.fy > -0.7)) continue;
        if (boxesMeet(mine, theirs)) return far ? 1 : 2;
      }
    }
    return 0;
  };
  for (let i = 0; i < cars.length; i++) {
    const a = cars[i];
    for (let j = i + 1; j < cars.length; j++) {
      const b = cars[j];
      if (!a.going || !b.going) continue; // (a car at rest at the kerb is steered round, not waited for)
      const rx = b.box.x - a.box.x, ry = b.box.y - a.box.y;
      if (rx * rx + ry * ry > 150 * 150) continue;
      if (boxesMeet(a.box, b.box)) continue; // (inside each other already: nothing is gained by holding them there)
      const ab = t < a.st.ghost ? 0 : wouldHit(a, b);
      const ba = t < b.st.ghost ? 0 : wouldHit(b, a);
      if (!ab && !ba) continue;
      if (ab && ba) {
        // Each would run into the other. If one is standing already, the other cannot go through it, so both
        // stand: a jam, once both have. Otherwise the one behind waits; and of two that face each other, the
        // one of lower rank.
        if (a.st.blocked || b.st.blocked) {
          if (a.st.blocked && b.st.blocked && ab === 2 && ba === 2) a.jam = b.jam = true;
          a.waits = Math.max(a.waits, ab);
          b.waits = Math.max(b.waits, ba);
          continue;
        }
        const aBehind = rx * a.box.fx + ry * a.box.fy > 0 && -(rx * b.box.fx + ry * b.box.fy) <= 0;
        const bBehind = -(rx * b.box.fx + ry * b.box.fy) > 0 && rx * a.box.fx + ry * a.box.fy <= 0;
        const aWaits = aBehind ? true : bBehind ? false : a.rank !== b.rank ? a.rank < b.rank : a.trip.id > b.trip.id;
        if (aWaits) a.waits = Math.max(a.waits, ab); else b.waits = Math.max(b.waits, ba);
      } else if (ab) a.waits = Math.max(a.waits, ab);
      else b.waits = Math.max(b.waits, ba);
    }
  }
  const ease = 1 - Math.exp(-5 * dt);
  for (const c of cars) {
    const st = c.st;
    // Two that wait for each other: after a while the one with the smaller number goes, through the other if need be.
    st.stuck = c.jam ? (st.stuck ?? 0) + dt : 0;
    if (st.stuck > STUCK_S + (c.trip.id % 7)) { st.ghost = t + 6; st.stuck = 0; c.waits = 0; }
    // For a car coming through a narrow stretch it waits where there is room: so, out round a parked car
    // itself, it goes on until it is back in its lane, and waits there.
    const byCar = c.waits === 2 || (c.waits === 1 && !c.pose.out);
    // (A car that has fallen as far behind as it may stops waiting, and drives on.)
    const blocked = (byCar || (how.also ? !!how.also(c) : false)) && st.lag < LAG_MOST_S;
    // Held back, its clock stops; free again, it makes the time up: gently on the road, at once while it stands at a kerb.
    const want = blocked ? 1 : byCar || st.lag <= 0 ? 0 : c.pose.moving ? -0.3 : -1;
    st.rate += (want - st.rate) * ease;
    st.lag = Math.min(LAG_MOST_S, Math.max(0, st.lag + st.rate * dt));
    if (st.lag === 0 && st.rate < 0) st.rate = 0;
    // Standing for another car, it draws in to its kerb as far as there is room, to let the other by.
    st.tuck = Math.min(1, Math.max(0, st.tuck + (blocked && byCar && st.rate > 0.8 ? dt : -dt) * 1.2));
    st.blocked = blocked;
    st.byCar = byCar;
  }
}
