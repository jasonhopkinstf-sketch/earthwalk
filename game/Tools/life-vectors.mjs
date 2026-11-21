// Prints test numbers from the browser's movement rules (lifemotion.js, trafficmotion.js), for
// checking the Windows game's C++ port against them:
//
//   node game/Tools/life-vectors.mjs <out.json>
//   UnrealEditor.exe <uproject> -game -EWLifeTest=<out.json>     (logs "EarthWalk: life test: ..." and quits)
//
// Fixed homes, trips and times go through hash32, creatureAt, callTime, tripPose, trainPose, pointAt
// and headingAt; the game runs the same inputs and reports the largest difference.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const js = (name) => import(pathToFileURL(join(here, "../../server/public/js", name)).href);
const { hash32, creatureAt, callTime, memberId, SPECIES, CALL_SLOT } = await js("lifemotion.js");
const { prepare, tripPose, trainPose, pointAt, headingAt } = await js("trafficmotion.js");

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

const file = process.argv[2];
if (!file) throw new Error("usage: node life-vectors.mjs <out.json>");
writeFileSync(file, JSON.stringify({ hashes, creatures, calls, trips, trains, tripPoses, trainPoses }));
console.log(`wrote ${file}: ${hashes.length} hashes, ${creatures.length} creatures, ${calls.length} calls, ${tripPoses.length} car poses, ${trainPoses.length} train poses`);
