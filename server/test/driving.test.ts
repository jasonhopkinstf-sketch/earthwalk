import { test } from "node:test";
import assert from "node:assert/strict";
import { type Car, newCar, stepCar } from "../public/js/cardrive.js";
import { MOUNTS } from "../public/js/riding.js";

const CAR = MOUNTS.car.drive!;
const DT = 1 / 60;
/** Drives for `seconds` with the pedals and wheel held, moving the car over open ground. */
function drive(car: Car, at: { x: number; z: number }, seconds: number, throttle: number, steer = 0, handbrake = false, d = CAR): void {
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    stepCar(car, d, DT, throttle, steer, handbrake);
    at.x += car.vx * DT;
    at.z += car.vz * DT;
  }
}
const slide = (car: Car): number => car.vx * Math.cos(car.heading) + car.vz * Math.sin(car.heading);

test("a car gathers speed, tops out, rolls to a stop, brakes harder than it pulls, and reverses slowly", () => {
  const car = newCar(0);
  const at = { x: 0, z: 0 };
  drive(car, at, 1, 1);
  assert.ok(car.speed > 5 && car.speed < 8, `a second from rest: ${car.speed.toFixed(1)} m/s`);
  assert.ok(at.z < -2 && Math.abs(at.x) < 1e-9, "north is towards -z, and it runs straight");
  drive(car, at, 3, 1);
  assert.ok(car.speed > 17 && car.speed < 23, `four seconds from rest: ${car.speed.toFixed(1)} m/s`);
  drive(car, at, 30, 1);
  assert.ok(car.speed > CAR.top - 0.5 && car.speed <= CAR.top, "flat out, and no faster");

  // Foot off: it rolls on and slows by itself. Brakes stop it in about two seconds.
  const rolling = newCar(0);
  drive(rolling, { x: 0, z: 0 }, 4, 1);
  const before = rolling.speed;
  drive(rolling, { x: 0, z: 0 }, 2, 0);
  assert.ok(rolling.speed < before - 2 && rolling.speed > before / 2, "coasting");
  drive(rolling, { x: 0, z: 0 }, 60, 0);
  assert.equal(rolling.speed, 0, "and in the end it stands still, without creeping backwards");
  drive(car, at, 1, -1);
  assert.ok(car.speed < CAR.top - 14, "the brakes bite");
  drive(car, at, 1.5, -1);
  assert.ok(car.speed <= 0.5 && car.speed > -4, "stopped, and just beginning to back up");
  drive(car, at, 10, -1);
  assert.ok(car.speed < -CAR.reverse + 0.5 && car.speed >= -CAR.reverse, "reverse is slow");
});

test("steering turns the car, less sharply the faster it goes, and a hard bend leaves it sliding a little", () => {
  const turnIn = (seconds: number): { turned: number; slid: number; speed: number } => {
    const car = newCar(0);
    const at = { x: 0, z: 0 };
    drive(car, at, seconds, 1);
    const speed = car.speed;
    let slid = 0;
    for (let i = 0; i < 60; i++) { drive(car, at, DT, 1, 1); slid = Math.max(slid, Math.abs(slide(car))); }
    return { turned: car.heading, slid, speed };
  };
  const slow = turnIn(0.6), fast = turnIn(8);
  assert.ok(slow.turned > 0.5 && fast.turned > 0.3, "steering right turns clockwise");
  // The turning circle: far tighter at a crawl than at speed.
  assert.ok(slow.speed / slow.turned < 12 && fast.speed / fast.turned > 30, `tight when slow (${(slow.speed / slow.turned).toFixed(0)} m), wide when fast (${(fast.speed / fast.turned).toFixed(0)} m)`);
  assert.ok(fast.slid > slow.slid && fast.slid < 6, `it slides more at speed, but not wildly (${slow.slid.toFixed(2)} and ${fast.slid.toFixed(2)} m/s)`);

  // Left is the mirror of right, and the wheel straightens when let go.
  const left = newCar(0), right = newCar(0);
  drive(left, { x: 0, z: 0 }, 2, 1, -1);
  drive(right, { x: 0, z: 0 }, 2, 1, 1);
  assert.ok(Math.abs(left.heading + right.heading) < 1e-9 && left.heading < 0);
  drive(right, { x: 0, z: 0 }, 1.5, 1, 0);
  assert.ok(Math.abs(right.turn) < 0.02 && Math.abs(slide(right)) < 0.1, "straight again, and gripping");

  // The handbrake: the tail steps out much further, and the car comes round quicker.
  const grip = newCar(0), loose = newCar(0);
  for (const car of [grip, loose]) drive(car, { x: 0, z: 0 }, 3, 1);
  drive(grip, { x: 0, z: 0 }, 0.7, 0, 1, false);
  drive(loose, { x: 0, z: 0 }, 0.7, 0, 1, true);
  assert.ok(Math.abs(slide(loose)) > Math.abs(slide(grip)) * 2.5, `a real slide (${slide(grip).toFixed(2)} against ${slide(loose).toFixed(2)} m/s)`);
  assert.ok(loose.heading > grip.heading && loose.speed < grip.speed);
});

test("a tractor is slower than a car in every way, and everything with an engine says how it handles", () => {
  const tractor = MOUNTS.tractor.drive!;
  const a = newCar(0), b = newCar(0);
  drive(a, { x: 0, z: 0 }, 20, 1);
  drive(b, { x: 0, z: 0 }, 20, 1, 0, false, tractor);
  assert.ok(b.speed < a.speed / 2 && b.speed > tractor.top - 0.5);
  for (const sp of ["car", "taxi", "tractor"]) {
    const d = MOUNTS[sp].drive!;
    assert.ok(d.top > d.reverse && d.brake > d.pull && d.base > 1 && d.grip > 1, sp);
  }
  for (const sp of ["horse", "boat", "train", "cow"]) assert.equal(MOUNTS[sp].drive, undefined, `${sp} is ridden, not driven`);
});
