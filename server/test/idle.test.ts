import { test } from "node:test";
import assert from "node:assert/strict";
import { CYCLE_S, FIDGETS, fidgetPose, IDLE_AFTER_S, idleAt, MUTTERS, noFidget, SAY_FOR_S, SAY_FROM_S, seedOf } from "../public/js/idlemoves.js";
import { fillOf, levelUpOf, noteOf, tipOf } from "../public/js/progressview.js";

test("the progress bar: how full it is, the note for points earned, and the words of a new level", () => {
  const level = { n: 3, title: "Wanderer", points: 52, from: 40, next: 90, hint: "One new country to level 4" };
  assert.equal(fillOf(level), 12 / 50);
  assert.deepEqual([fillOf({ ...level, points: 40 }), fillOf({ ...level, points: 90 }), fillOf({ ...level, points: 500 }), fillOf(null)], [0, 1, 1, 0], "never less than empty or more than full");
  assert.deepEqual(noteOf({ gained: 3, why: "fed a hungry cow" }), { points: "+3", text: "fed a hungry cow" });
  assert.deepEqual(noteOf({ gained: 2, why: null }), { points: "+2", text: "well done" });
  assert.equal(noteOf({ gained: 0, why: null }), null, "where a player stands is no news");
  assert.deepEqual(levelUpOf({ n: 4, title: "Explorer", coins: 40, riddles: 6 }), { title: "Level 4!", name: "Explorer", text: "40 coins and 6 new riddles" });
  assert.deepEqual(levelUpOf({ n: 7, title: "Globetrotter", coins: 70, riddles: 0 }), { title: "Level 7!", name: "Globetrotter", text: "70 coins" });
  assert.equal(levelUpOf({ n: 2, title: "Rambler", coins: 20, riddles: 1 })!.text, "20 coins and a new riddle");
  assert.equal(levelUpOf(undefined), null);
  assert.equal(tipOf(level), "Level 3, Wanderer: 52 points, 38 more to level 4. Click to open your passport (P).");
});

test("idle: nothing for half a minute, then a fidget every nine seconds, every one before any again", () => {
  const seed = seedOf("member-abc");
  assert.equal(idleAt(0, seed), null);
  assert.equal(idleAt(IDLE_AFTER_S - 0.01, seed), null);
  const first = idleAt(IDLE_AFTER_S, seed)!;
  assert.deepEqual([first.n, first.u, first.say], [0, 0, null], "it begins the moment the half minute is up, and has not spoken yet");
  assert.deepEqual(idleAt(IDLE_AFTER_S + 1, seed), idleAt(IDLE_AFTER_S + 1, seed), "the same every time it is asked");
  for (const name of ["a", "member-abc", "Mia", "6f1c2e", "x".repeat(40)]) {
    const s = seedOf(name);
    const eight = Array.from({ length: FIDGETS.length }, (_x, n) => idleAt(IDLE_AFTER_S + n * CYCLE_S + 0.1, s)!.fidget);
    assert.equal(new Set(eight).size, FIDGETS.length, `${name}: all eight in the first eight cycles (${eight.join(" ")})`);
    // A fidget plays from the start of its cycle, then the figure rests until the next.
    for (let n = 0; n < 8; n++) {
      const start = IDLE_AFTER_S + n * CYCLE_S;
      const f = FIDGETS[idleAt(start, s)!.fidget];
      assert.ok(f.seconds < CYCLE_S - 2, `${f.id} leaves a rest before the next`);
      assert.ok(Math.abs(idleAt(start + f.seconds / 2, s)!.u! - 0.5) < 1e-9);
      assert.equal(idleAt(start + f.seconds + 0.01, s)!.u, null);
      // It speaks in every other cycle, for a few seconds.
      const speaking = idleAt(start + SAY_FROM_S + 1, s)!.say;
      assert.equal(speaking !== null, n % 2 === 0);
      if (speaking !== null) assert.ok(MUTTERS[speaking], "something there is to say");
      assert.equal(idleAt(start + SAY_FROM_S + SAY_FOR_S + 0.1, s)!.say, null);
    }
    const said = [0, 2, 4, 6, 8, 10].map((n) => idleAt(IDLE_AFTER_S + n * CYCLE_S + 1, s)!.say);
    assert.equal(new Set(said).size, said.length, "and never the same thing twice running");
  }
  assert.notEqual(seedOf("Mia"), seedOf("Max"), "figures have numbers of their own");
});

test("idle: every fidget starts and ends at rest, and stays within what a figure can do", () => {
  const rest = noFidget();
  for (let i = 0; i < FIDGETS.length; i++) {
    const f = FIDGETS[i];
    // A whole number of turns is at rest too: the figure faces the way it did.
    const turns = (p: ReturnType<typeof noFidget>) => ({ ...p, spin: Math.abs(p.spin / (2 * Math.PI) - Math.round(p.spin / (2 * Math.PI))) < 1e-9 ? 0 : p.spin });
    const flat = (p: ReturnType<typeof noFidget>) => JSON.parse(JSON.stringify(turns(p), (_k, v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 + 0 : v)));
    assert.deepEqual(flat(fidgetPose(i, 0)), flat(rest), `${f.id} begins at rest`);
    assert.deepEqual(flat(fidgetPose(i, 1)), flat(rest), `${f.id} ends at rest`);
    let most = 0;
    for (let u = 0; u <= 1; u += 0.01) {
      const p = fidgetPose(i, u);
      const all = [p.lift, p.squash, p.pitch, p.roll, p.twist, p.headPitch, p.headYaw, p.headRoll, ...p.armSwing, ...p.armOut, ...p.footSwing, ...p.footLift, p.tailYaw, p.tailUp, p.spin];
      assert.ok(all.every(Number.isFinite), `${f.id} at ${u}`);
      assert.ok(p.lift >= -0.001 && p.lift < 0.4 && Math.abs(p.squash) < 0.2 && Math.abs(p.headPitch) < 0.9 && Math.abs(p.pitch) < 0.4, `${f.id} at ${u}: nothing unnatural`);
      assert.ok(p.footLift.every((y) => y >= 0), "feet do not go through the ground");
      most = Math.max(most, ...all.slice(0, -1).map(Math.abs), Math.abs(p.spin) / 10);
    }
    assert.ok(most > 0.2, `${f.id} is something to see`);
  }
  // Between fidgets nothing is added, whatever was left in the pose before.
  const p = fidgetPose(1, 0.5);
  assert.deepEqual(fidgetPose(1, null, p), rest);
  assert.equal(new Set(FIDGETS.map((f) => f.id)).size, 8);
});
