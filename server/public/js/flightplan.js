// "Fly me there": the arithmetic of being flown to a place and watching the world go by. What kind of
// flight suits the distance, how long it takes, how fast and how high it goes at each moment, how many
// pieces of the world it asks the server for, and the words that offer it. The flying itself is flight.js.
//
// There are two kinds of flight, because of what the game can draw.
//
// A LOW flight is for across a town. The game draws the world two chunks round the player (a chunk is
// about 490 m at Auckland, 610 m at the equator, 310 m at Oslo), and a flight that stays low loads it
// along the whole way, a row of five chunks for every chunk crossed. The server lets one caller have 400
// new things built in five minutes (app.ts; a chunk and its trees and doors are two), so a low flight is
// kept to LOW_STEPS chunk crossings: at most 70 chunks, 140 of the 400.
//
// A HIGH flight is for anything further. The generated world has no far-off picture of the Earth: past
// 2.6 km everything is the haze the sky paints under its horizon. So a long flight climbs out over where
// it starts until that is all below it, crosses in the haze in a few seconds, however far it is, and
// comes down over the place. In the middle there is the sky, its clouds and the haze, and nothing else:
// nothing is asked for there and nothing is pretended. Such a flight asks for the 25 chunks round the
// place and no others, exactly as landing there at once does.
//
// No three.js and no page here: this file is also run by the server's tests.

import { CHUNK_Z, EARTH_CIRCUMFERENCE, TILES, latToY, lonToX, metersPerTile, xToLon, yToLat } from "./geo.js";

/** The game draws this many chunks each side of the player (world.js). */
export const SEEN_CHUNKS = 2;
/** A low flight crosses at most this many chunk edges, east-west and north-south together. */
export const LOW_STEPS = 14;
/** What the server lets one caller have built in five minutes (app.ts), and what one chunk costs of it. */
export const BUILD_CAP = 400;
export const BUILDS_PER_CHUNK = 2;
/** Past this the ground is all haze (the fog in main.js ends at 2600 m), so a high flight goes above it. */
export const HAZE_M = 2600;
export const HIGH_M = 3000;
/** A high flight's climb out and its coming down: seconds, and metres along the ground. */
export const UP_S = 14;
export const DOWN_S = 15;
export const ENDS_M = 2000;
/** Nearer than this there is nothing to fly: it is a few steps. */
export const TOO_NEAR_M = 40;

/** The metres across one chunk at a latitude: 611 m at the equator, 490 m at Auckland, 306 m at Oslo. */
export const chunkMetres = (lat) => metersPerTile(lat);

const RAD = Math.PI / 180;
const EARTH_RADIUS = EARTH_CIRCUMFERENCE / (2 * Math.PI);

/** 0 to 1, leaving and arriving gently. */
export const smooth = (u) => { const t = Math.min(1, Math.max(0, u)); return t * t * (3 - 2 * t); };
/** The same, gentler still at both ends: speed and its change are both nothing there. */
export const smoother = (u) => { const t = Math.min(1, Math.max(0, u)); return t * t * t * (t * (t * 6 - 15) + 10); };
/** How fast `smoother` is going, at most: 1.875 times its average. */
export const SMOOTHER_PEAK = 1.875;

/** Metres between two places, as the crow flies. */
export function metresBetween(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * RAD, dLon = (bLon - aLon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** How long a low flight of so many metres takes: 300 m in 15 s, 1 km in 23 s, 3 km in 30 s, never under 8 s. */
export const lowSeconds = (metres) => Math.min(40, Math.max(8, 15 + 15 * Math.log10(Math.max(1, metres) / 300)));
/** How long a high flight spends in the haze: 5 s for 10 km, 13 s for 100 km, 21 s for 1000 km, 31 s for right round the world. */
export const overSeconds = (metres) => Math.min(40, Math.max(5, 5 + 8 * Math.log10(Math.max(1, metres) / 10_000)));
/** How high above the ground and the roofs a low flight goes: 60 m for a hop, 180 m for across a town. */
export const lowHeight = (metres) => Math.min(180, Math.max(60, 40 + metres / 20));

/**
 * The flight from one place to another ({ lat, lon } each), or null when they are too near to fly between.
 * It goes along a straight line on the map (so due east stays due east), the shorter way round the world.
 *
 * `kind` is "low" or "high"; `metres` how far it is as the crow flies; `seconds` how long the flight takes
 * when the world at the far end is there in time; `up`, `over`, `down` the three parts of a high flight
 * in seconds (a low flight is all one); `height` how far above the ground it goes; `ends` the metres along
 * the ground a high flight covers climbing out, and again coming down; `steps` the chunk edges it crosses;
 * `chunks` the most new chunks it asks the server for; and `fx`, `fy`, `dx`, `dy` where it starts and how
 * far it goes, in chunks (x east, y south).
 */
export function planFlight(from, to) {
  const lat0 = Math.min(85, Math.max(-85, from.lat)), lat1 = Math.min(85, Math.max(-85, to.lat));
  const metres = metresBetween(lat0, from.lon, lat1, to.lon);
  if (!(metres >= TOO_NEAR_M)) return null;
  const fx = lonToX(from.lon), fy = latToY(lat0);
  let dx = lonToX(to.lon) - fx;
  if (dx > TILES / 2) dx -= TILES; else if (dx < -TILES / 2) dx += TILES; // the shorter way round
  const dy = latToY(lat1) - fy;
  const steps = Math.abs(Math.floor(fx + dx) - Math.floor(fx)) + Math.abs(Math.floor(fy + dy) - Math.floor(fy));
  const wide = 2 * SEEN_CHUNKS + 1;
  const base = { metres, fx, fy, dx, dy, steps, to: { lat: lat1, lon: to.lon } };
  if (steps <= LOW_STEPS) {
    const seconds = lowSeconds(metres);
    return { ...base, kind: "low", seconds, up: 0, over: 0, down: 0, height: lowHeight(metres), ends: 0, chunks: wide * steps };
  }
  const ends = Math.min(ENDS_M, metres * 0.35);
  const over = overSeconds(metres);
  return { ...base, kind: "high", seconds: UP_S + over + DOWN_S, up: UP_S, over, down: DOWN_S, height: HIGH_M, ends, chunks: wide * wide };
}

/** Which way a flight goes, as a compass heading in radians (0 north, clockwise) and as a step east and south. */
export function flightHeading(plan) {
  const length = Math.hypot(plan.dx, plan.dy);
  return { east: plan.dx / length, south: plan.dy / length, yaw: Math.atan2(plan.dx, -plan.dy) };
}

/**
 * A low flight after `t` seconds: `s` is how far along it is (0 to 1) and `lift` how much of its height it
 * has (0 on the ground, 1 at its height). It is up after a quarter of the time, having gone a tenth of the
 * way, and starts down with a third of the time left.
 */
export function lowAt(plan, t) {
  const u = Math.min(1, Math.max(0, t / plan.seconds));
  return { s: smoother(u), lift: Math.min(smooth(u / 0.26), smooth((1 - u) / 0.34)) };
}

/** How fast a low flight is going over the ground after `t` seconds, in metres a second. */
export function lowSpeed(plan, t) {
  const u = Math.min(1, Math.max(0, t / plan.seconds));
  return (plan.metres / plan.seconds) * 30 * u * u * (1 - u) * (1 - u);
}

/** The fastest a low flight goes, in the middle. */
export const lowTopSpeed = (plan) => (plan.metres / plan.seconds) * SMOOTHER_PEAK;

/**
 * Climbing out, `t` seconds in: metres gone along the ground (slowly at first: mostly up), and how much of the
 * height has been gained. Half the time is spent in the first kilometre up, where there is a town to watch
 * dropping away; the rest of the height, where there is only haze, goes quickly.
 */
export const climbAt = (plan, t) => ({ along: plan.ends * Math.min(1, Math.max(0, t / plan.up)) ** 2.6, lift: smooth(t / plan.up) ** 1.7 });
/**
 * Coming down, `t` seconds in: metres still to go along the ground (the last of it is straight down), and how
 * much of the height is left. Quickly through the haze, and the second half of the time in the last kilometre.
 */
export const descentAt = (plan, t) => ({ left: plan.ends * (1 - Math.min(1, Math.max(0, t / plan.down))) ** 2.6, lift: (1 - smooth(t / plan.down)) ** 1.3 });

/**
 * Where a high flight is on the map while it crosses in the haze, `t` seconds into that part: from where the
 * climb out left it to where the coming down starts. `tileM0` and `tileM1` are the metres in a chunk at the
 * two ends. Returns { lat, lon, w } with `w` how far across it is, 0 to 1.
 */
export function overAt(plan, t, tileM0 = metersPerTile(yToLat(plan.fy)), tileM1 = metersPerTile(plan.to.lat)) {
  const { east, south } = flightHeading(plan);
  const x0 = plan.fx + (east * plan.ends) / tileM0, y0 = plan.fy + (south * plan.ends) / tileM0;
  const x1 = plan.fx + plan.dx - (east * plan.ends) / tileM1, y1 = plan.fy + plan.dy - (south * plan.ends) / tileM1;
  const w = smooth(t / plan.over);
  const x = x0 + (x1 - x0) * w, y = y0 + (y1 - y0) * w;
  return { lat: yToLat(Math.min(TILES - 1e-6, Math.max(0, y))), lon: xToLon((((x % TILES) + TILES) % TILES)), w };
}

/** The fastest a high flight goes over the ground, in the middle of the haze: metres a second, near enough. */
export const overTopSpeed = (plan) => (Math.max(0, plan.metres - 2 * plan.ends) / plan.over) * 1.5;

/**
 * How far ahead of a flyer the world is asked for: the game asks for `SEEN_CHUNKS` chunks round a point
 * that a low flight keeps one chunk ahead of the flyer. `tileM` is the metres in a chunk there, `speed`
 * metres a second. Returns the metres ahead that have been asked for (to the nearer and the further edge of
 * the chunk the flyer is over) and the seconds until the flyer gets there: what there is to build it in.
 */
export function reachAhead(tileM, speed) {
  const near = (SEEN_CHUNKS + 1) * tileM, far = (SEEN_CHUNKS + 2) * tileM;
  return { near, far, seconds: speed > 0 ? near / speed : Infinity };
}

/** "350 m", "2.4 km", "1,240 km". */
export function farWords(metres) {
  if (metres < 950) return `${Math.max(10, Math.round(metres / 10) * 10)} m`;
  if (metres < 99_500) return `${(metres / 1000).toFixed(1)} km`;
  return `${Math.round(metres / 1000).toLocaleString("en-US")} km`;
}

/** "about 20 seconds", "about half a minute", "about a minute". */
export function timeWords(seconds) {
  if (seconds < 25) return `about ${Math.max(10, Math.round(seconds / 5) * 5)} seconds`;
  if (seconds < 36) return "about half a minute";
  if (seconds < 52) return "about three quarters of a minute";
  if (seconds < 75) return "about a minute";
  return `about ${Math.round(seconds / 30) / 2} minutes`;
}

/**
 * A place's name short enough for a heading: what it is and the country it is in, "Tour Eiffel, France" from
 * the whole address. (House numbers and postcodes are left out; a name that is only numbers, a latitude and a
 * longitude, stays as it is.)
 */
export function shortName(name) {
  const whole = String(name ?? "").trim();
  const parts = whole.split(",").map((part) => part.trim()).filter((part) => part && !/^[\d\s.-]+$/.test(part));
  if (!parts.length) return whole;
  return parts.length > 2 ? `${parts[0]}, ${parts[parts.length - 1]}` : parts.join(", ");
}

/**
 * The words that offer the choice once a place is found. `plan` is null when the place is too near to fly
 * to, or there is nowhere to take off from, and then there is nothing to choose.
 */
export function choiceWords(name, plan) {
  if (!plan) return null;
  return {
    title: shortName(name),
    sub: `${farWords(plan.metres)} from here. How would you like to get there?`,
    now: { label: "Go there now", about: "You land there at once." },
    fly: {
      label: "Fly there and watch",
      about: plan.kind === "low"
        ? `You are carried over the rooftops, ${timeWords(plan.seconds)}.`
        : `Up over where you are, across high in the haze, and down over it, ${timeWords(plan.seconds)}. The land in between is not drawn.`,
    },
  };
}

/**
 * What is said while flying: `head` and `sub` at the top of the screen, where the place the player is in is
 * otherwise named, and `hint` along the foot of it. `part` is "low", "up", "over", "wait", "down" or "settle".
 */
export function flyingWords(name, part, metresLeft) {
  const to = `${farWords(metresLeft)} to go`;
  return {
    head: `Flying to ${shortName(name)}`,
    sub: part === "over" ? `${to}  ·  high over the haze, where no land is drawn` : part === "wait" ? "the world here is still being built" : to,
    hint: "Esc takes over   ·   V looks from above",
  };
}
