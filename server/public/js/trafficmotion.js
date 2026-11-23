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
 * Makes a trip ready to replay.
 * @param {{ id: number, w: number, left: boolean, da: number, db: number, path: number[] }} trip
 *   `path` is x, y, seconds, x, y, seconds...: metres east and south of any fixed point, and the
 *   seconds since setting off. `w` is the road's width, `da` and `db` the waits at each end.
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
 * @returns {{ along: number, back: boolean, moving: boolean, leg: number }}
 *   `along`: metres along the track, from 0 to `train.length`. `back`: heading for the start.
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
  return { along: train.dist[lo] + run * f, back: leg === 0 || leg === 3, moving: (leg === 1 || leg === 3) && run > 0, leg };
}

/**
 * Where a car is at shared time `t` (seconds since 1970 on the server's clock).
 * @returns {{ x: number, y: number, yaw: number, moving: boolean, leg: number, pace: number, inLane: boolean }}
 *   `x`, `y` in the path's own metres, on the car's side of the road. `yaw` is the compass heading
 *   of the way it is going. `leg`: 0 waiting at the start, 1 driving out, 2 waiting at the far end,
 *   3 driving back. `inLane` is false while it is pulling out from a kerb or in to one.
 */
export function tripPose(trip, t) {
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
  const g0 = smooth(Math.min(1, driven / EASE_M));
  const g1 = smooth(Math.min(1, (trip.length - driven) / EASE_M));
  const over = ((lane * g0 - kerb * (1 - g0)) * g1 + kerb * (1 - g1)) * (trip.left ? -1 : 1);

  const moving = leg === 1 || leg === 3;
  return {
    x: p[lo * 3] + (p[hi * 3] - p[lo * 3]) * f - dy * over, // to the right of the way it faces is (-dy, dx)
    y: p[lo * 3 + 1] + (p[hi * 3 + 1] - p[lo * 3 + 1]) * f + dx * over,
    yaw: ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360,
    moving, leg, pace: moving && span > 0 ? run / span : 0, inLane: moving && g0 === 1 && g1 === 1,
  };
}
