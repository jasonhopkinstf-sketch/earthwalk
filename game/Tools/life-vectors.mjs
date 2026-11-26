// Prints test numbers from the browser's movement rules (lifemotion.js, trafficmotion.js), for
// checking the Windows game's C++ port against them:
//
//   node game/Tools/life-vectors.mjs <out.json>
//   UnrealEditor.exe <uproject> -game -EWLifeTest=<out.json>     (logs "EarthWalk: life test: ..." and quits)
//
// Fixed homes, trips and times go through hash32, creatureAt, callTime, tripPose, trainPose, pointAt
// and headingAt; the game runs the same inputs and reports the largest difference. And a made-up street
// with cars parked along it and four cars driving up and down it goes through setSpots, restPose and
// seven minutes of giveWay: the game must steer round the same cars and wait for the same ones.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const js = (name) => import(pathToFileURL(join(here, "../../server/public/js", name)).href);
const { hash32, creatureAt, callTime, memberId, SPECIES, CALL_SLOT } = await js("lifemotion.js");
const { prepare, tripPose, trainPose, pointAt, headingAt, setSpots, restPose, giveWay } = await js("trafficmotion.js");

const T0 = 1795262400; // late 2026, in seconds
const times = [];
for (let i = 0; i < 40; i++) times.push(T0 + i * 0.731 + (hash32(i, 77) / 4294967296) * 90000);
times.push(0, 1, 1e9 + 0.5, 4294967296.25, 2 ** 31 - 0.001, 2 ** 31 + 7.5);

const hashes = [];
for (const [a, b] of [[0, 0], [1, 0], [0, 1], [1, 2], [2863311530, 5], [4294967295, 4294967295], [123456789, 0x464f4355], [7, 2147483648], [305419896, 1073741823]]) {
  hashes.push({ a, b, h: hash32(a, b) });
}

const homes = [];
let seed = 12345;
const next = () => (seed = hash32(seed, 99));
for (const sp of Object.keys(SPECIES)) {
  for (let i = 0; i < 3; i++) {
    const id = Math.max(1, next());
    const r = sp === "bird" ? 40 + (next() % 60) : 1 + (next() % 4000) / 100;
    homes.push({ id, sp, n: 1 + (next() % 12), r });
  }
}
homes.push({ id: 4294967295, sp: "cow", n: 3, r: 80 }, { id: 1, sp: "cat", n: 1, r: 1 });

const creatures = [];
for (const home of homes) {
  for (let k = 0; k < home.n; k += Math.max(1, Math.floor(home.n / 3))) {
    for (const t of times) {
      const c = creatureAt(home, k, t);
      creatures.push({ home, k, t, id: c.id, x: c.x, y: c.y, alt: c.alt, yaw: c.yaw, moving: c.moving, gait: c.gait, pace: c.pace, graze: c.graze });
    }
  }
}

const calls = [];
for (const home of homes) {
  const id = memberId(home.id, 0);
  let found = 0;
  for (let i = 0; i < 400; i++) {
    const slot = Math.floor(T0 / CALL_SLOT) + i;
    const at = callTime(id, home.sp, slot);
    if (at !== null) found++;
    if (i < 12 || (at !== null && found <= 6)) calls.push({ id, sp: home.sp, slot, at });
  }
}
calls.push({ id: 5, sp: "cow", slot: -7, at: callTime(5, "cow", -7) }, { id: 5, sp: "cow", slot: 2 ** 30 + 3, at: callTime(5, "cow", 2 ** 30 + 3) });

// Paths: a made-up street with bends and a pause, in metres and seconds.
function makePath(id, points, pause) {
  const path = [];
  let x = (next() % 2000) / 10 - 100;
  let y = (next() % 2000) / 10 - 100;
  let ang = (next() % 628) / 100;
  let t = 0;
  for (let i = 0; i < points; i++) {
    path.push(x, y, t);
    if (pause && i === Math.floor(points / 2)) { t += 14; path.push(x, y, t); }
    const step = pause ? 12 : 4;
    ang += ((next() % 100) - 50) / 300;
    x += Math.cos(ang) * step;
    y += Math.sin(ang) * step;
    t += step / (3 + (next() % 80) / 10);
  }
  return path;
}
const trips = [];
for (let i = 0; i < 6; i++) {
  const id = Math.max(1, next());
  trips.push({ id, w: 3 + (next() % 90) / 10, left: i % 2 === 1, da: 5 + (next() % 90), db: 5 + (next() % 60), path: makePath(id, 20 + (next() % 60), false) });
}
trips.push({ id: 77, w: 2.5, left: false, da: 1, db: 1, path: [0, 0, 0, 4, 0, 1.5] });
const trains = [];
for (let i = 0; i < 4; i++) {
  const id = Math.max(1, next());
  trains.push({ id, w: 0, left: false, da: 10 + (next() % 40), db: 10 + (next() % 40), path: makePath(id, 30 + (next() % 80), true) });
}

const tripPoses = [];
for (const trip of trips) {
  const p = prepare(trip);
  for (const t of times) {
    for (const dt of [0, p.period * 0.13, p.period * 0.37, p.period * 0.61, p.period * 0.88]) {
      const pose = tripPose(p, t + dt);
      tripPoses.push({ trip: trips.indexOf(trip), t: t + dt, ...pose });
    }
  }
}
const trainPoses = [];
for (const train of trains) {
  const p = prepare(train);
  for (const t of times) {
    for (const dt of [0, p.period * 0.21, p.period * 0.47, p.period * 0.77]) {
      const pose = trainPose(p, t + dt);
      const at = pointAt(p, pose.along);
      trainPoses.push({ train: trains.indexOf(train), t: t + dt, ...pose, x: at[0], y: at[1], heading: headingAt(p, pose.along, 6), length: p.length, period: p.period });
    }
  }
}

// ---- a street for giving way: 240 m with a slow bend, four cars (two from each end), and cars parked at both kerbs
function streetPath(reversed) {
  const pts = [];
  let x = 30, y = -40, ang = 0.2;
  for (let i = 0; i <= 60; i++) { pts.push([x, y]); ang += 0.004; x += Math.cos(ang) * 4; y += Math.sin(ang) * 4; }
  if (reversed) pts.reverse();
  const path = [];
  let t = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) t += 4 / (i < 3 || i > pts.length - 4 ? 1.5 : 5.5);
    path.push(pts[i][0], pts[i][1], Math.round(t * 100) / 100);
  }
  return path;
}
const kerbTrips = [
  { id: 1001, w: 6, left: false, da: 7, db: 9, path: streetPath(false) },
  { id: 2002, w: 6, left: false, da: 21, db: 5, path: streetPath(false) },
  { id: 3003, w: 6, left: false, da: 11, db: 6, path: streetPath(true) },
  { id: 4004, w: 6, left: false, da: 4, db: 15, path: streetPath(true) },
];
const kerbReady = kerbTrips.map((trip) => prepare(trip));
// (Not level with a point of the path: there two stretches of it are equally near, and which is taken hangs on the last digit.)
const kerbParked = [];
for (const [id, along, side] of [[11, 45.3, 1], [12, 83.2, -1], [13, 118.6, 1], [14, 121.9, -1], [15, 166.7, 1], [16, 201.4, -1], [17, 150.9, -1]]) {
  const a = pointAt(kerbReady[0], along - 1);
  const b = pointAt(kerbReady[0], along + 1);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const at = pointAt(kerbReady[0], along);
  kerbParked.push({ id, x: at[0] - ((b[1] - a[1]) / len) * 2.05 * side, y: at[1] + ((b[0] - a[0]) / len) * 2.05 * side });
}
const kerbRests = [];
const kerbSpots = kerbParked.map((p) => ({ x: p.x, y: p.y, key: `p${p.id}` }));
kerbReady.forEach((trip, n) => {
  for (const far of [false, true]) {
    const at = restPose(trip, far);
    kerbRests.push({ trip: n, far, x: at.x, y: at.y, yaw: at.yaw });
    kerbSpots.push({ x: at.x, y: at.y, key: `${far ? "b" : "a"}${trip.id}` });
  }
});
for (const trip of kerbReady) setSpots(trip, kerbSpots.filter((s) => s.key !== `a${trip.id}` && s.key !== `b${trip.id}`));
// A pose with every spot taken; and one with some half taken or empty, and the car drawn in to its kerb a little.
const kerbHold = (key) => (key[0] === "p" ? (Number(key.slice(1)) % 3) / 2 : 0.5);
const kerbPoses = [];
kerbReady.forEach((trip, n) => {
  for (let t = T0; t < T0 + trip.period; t += 0.83) {
    const all = tripPose(trip, t);
    const some = tripPose(trip, t, kerbHold, 0.4);
    kerbPoses.push({ trip: n, t, x: all.x, y: all.y, yaw: all.yaw, out: all.out, sx: some.x, sy: some.y, syaw: some.yaw, sout: some.out });
  }
});
// Seven minutes of the four of them giving way, a tenth of a second at a time; parked car 15 has been driven off.
const giving = kerbReady.map((trip) => ({ trip, st: { lag: 0 } }));
const give = { t0: T0 + 3, dt: 0.1, steps: 4200, every: 150, rows: [], waited: 0, behind: 0 };
for (let i = 1; i <= give.steps; i++) {
  giveWay(giving, give.t0 + i * give.dt, give.dt, { gone: (key) => Number(key.slice(1)) === 15 });
  for (const c of giving) { if (c.st.byCar) give.waited++; give.behind = Math.max(give.behind, c.st.lag); }
  if (i % give.every === 0) giving.forEach((c, n) => give.rows.push({ step: i, car: n, x: c.pose.x, y: c.pose.y, yaw: c.pose.yaw, lag: c.st.lag, tuck: c.st.tuck, blocked: !!c.st.blocked }));
}
const kerb = { trips: kerbTrips, parked: kerbParked, rests: kerbRests, spots: kerbReady.map((trip) => trip.spots.map((s) => ({ along: s.along, aside: s.aside }))), poses: kerbPoses, give };

const file = process.argv[2];
if (!file) throw new Error("usage: node life-vectors.mjs <out.json>");
writeFileSync(file, JSON.stringify({ hashes, creatures, calls, trips, trains, tripPoses, trainPoses, kerb }));
console.log(`wrote ${file}: ${hashes.length} hashes, ${creatures.length} creatures, ${calls.length} calls, ${tripPoses.length} car poses, ${trainPoses.length} train poses, ${kerbPoses.length} poses beside parked cars, ${give.rows.length} of giving way (cars waited ${give.waited} tenths of a second for each other, ${give.behind.toFixed(1)} s behind at most)`);
