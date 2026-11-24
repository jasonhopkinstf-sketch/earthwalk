import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import {
  BUILD_CAP, BUILDS_PER_CHUNK, HAZE_M, LOW_STEPS, choiceWords, chunkMetres, climbAt, descentAt, farWords, flightHeading, flyingWords, lowAt, lowSpeed,
  lowTopSpeed, metresBetween, overAt, overTopSpeed, planFlight, reachAhead, shortName, timeWords,
  LOW_TRIM_M, PACES, paceStep, roofClear, trimHeight,
} from "../public/js/flightplan.js";
import { GuestDirectory } from "../src/people.ts";
import { Rooms } from "../src/rooms.ts";

// "Fly me there": the sums of a flight (public/js/flightplan.js), and the one thing the server does for it.
const DEVONPORT = { lat: -36.8312, lon: 174.7965 };
const QUEENS_WHARF = { lat: -36.841, lon: 174.7683 };
const TITIRANGI = { lat: -36.9379, lon: 174.6563 };
const WELLINGTON = { lat: -41.2889, lon: 174.7772 };
const PARIS = { lat: 48.8583, lon: 2.2945 };

test("across a town is a low flight of about half a minute; anything further goes high and takes about a minute", () => {
  const town = planFlight(DEVONPORT, QUEENS_WHARF)!;
  assert.equal(town.kind, "low");
  assert.ok(Math.abs(town.metres - 2740) < 60, `2.7 km across the harbour: ${town.metres}`);
  assert.ok(town.seconds > 25 && town.seconds < 33, `about half a minute: ${town.seconds}`);
  assert.ok(town.height >= 60 && town.height <= 180);

  const city = planFlight(TITIRANGI, DEVONPORT)!;
  const country = planFlight(DEVONPORT, WELLINGTON)!;
  const world = planFlight(DEVONPORT, PARIS)!;
  for (const far of [city, country, world]) assert.equal(far.kind, "high");
  assert.ok(city.seconds < country.seconds && country.seconds < world.seconds, "further takes longer");
  assert.ok(country.seconds > 40 && country.seconds < 60, `across a country in under a minute: ${country.seconds}`);
  assert.ok(world.seconds < 70, `and right round the world in about a minute: ${world.seconds}`);
  for (const far of [city, country, world]) assert.equal(far.seconds, far.up + far.over + far.down);
  assert.ok(world.height > HAZE_M, "above where the ground is lost in the haze");

  // A hop of a few steps is not a flight.
  assert.equal(planFlight(DEVONPORT, { lat: DEVONPORT.lat + 0.0001, lon: DEVONPORT.lon }), null);
  // A hop of a hundred metres is, and takes a few seconds.
  const hop = planFlight(DEVONPORT, { lat: DEVONPORT.lat + 0.001, lon: DEVONPORT.lon })!;
  assert.equal(hop.kind, "low");
  assert.ok(hop.seconds >= 8 && hop.seconds < 12);
});

test("no flight asks the server for more of the world than one player may have built", () => {
  // The worst low flight: as many chunk edges as a low flight may cross, five chunks for each.
  for (const to of [QUEENS_WHARF, { lat: -36.8312, lon: 174.87 }, { lat: -36.88, lon: 174.7965 }, { lat: -36.86, lon: 174.76 }]) {
    const plan = planFlight(DEVONPORT, to)!;
    assert.equal(plan.kind, "low");
    assert.ok(plan.steps <= LOW_STEPS);
    assert.equal(plan.chunks, plan.steps * 5);
    assert.ok(plan.chunks * BUILDS_PER_CHUNK <= BUILD_CAP * 0.35, `${plan.chunks} chunks is at most 35% of the cap`);
  }
  // One chunk edge more and it goes high, where it asks only for the place: 25 chunks, as landing there at once does.
  const tileM = chunkMetres(DEVONPORT.lat);
  const justOver = planFlight(DEVONPORT, { lat: DEVONPORT.lat, lon: DEVONPORT.lon + ((LOW_STEPS + 1.5) * tileM) / (111_320 * Math.cos((DEVONPORT.lat * Math.PI) / 180)) })!;
  assert.equal(justOver.kind, "high");
  for (const to of [TITIRANGI, WELLINGTON, PARIS]) assert.equal(planFlight(DEVONPORT, to)!.chunks, 25);
  assert.equal(justOver.chunks, 25);
});

test("a low flight leaves and arrives gently, is up early and down late, and is fastest in the middle", () => {
  const plan = planFlight(DEVONPORT, QUEENS_WHARF)!;
  assert.deepEqual(lowAt(plan, 0), { s: 0, lift: 0 });
  assert.deepEqual(lowAt(plan, plan.seconds), { s: 1, lift: 0 });
  assert.deepEqual(lowAt(plan, plan.seconds * 2), { s: 1, lift: 0 }, "and stays there");
  const quarter = lowAt(plan, plan.seconds * 0.26);
  assert.equal(quarter.lift, 1);
  assert.ok(quarter.s < 0.12, "up before it has gone far: mostly up, at first");
  assert.equal(lowAt(plan, plan.seconds * 0.5).lift, 1);
  let was = -1;
  for (let t = 0; t <= plan.seconds; t += 0.5) {
    const { s, lift } = lowAt(plan, t);
    assert.ok(s >= was && lift >= 0 && lift <= 1);
    was = s;
  }
  // The speed is the slope of how far along it is.
  const t = plan.seconds * 0.4, dt = 0.01;
  const slope = ((lowAt(plan, t + dt).s - lowAt(plan, t - dt).s) * plan.metres) / (2 * dt);
  assert.ok(Math.abs(slope - lowSpeed(plan, t)) < 0.5);
  assert.equal(lowSpeed(plan, 0), 0);
  assert.equal(lowSpeed(plan, plan.seconds), 0);
  assert.ok(Math.abs(lowSpeed(plan, plan.seconds / 2) - lowTopSpeed(plan)) < 1e-6);
  assert.ok(lowTopSpeed(plan) > 150 && lowTopSpeed(plan) < 200, `about 170 m/s at its fastest: ${lowTopSpeed(plan)}`);
});

test("a high flight climbs out near where it started, crosses along a straight line on the map, and comes straight down at the end", () => {
  const plan = planFlight(DEVONPORT, PARIS)!;
  assert.deepEqual(climbAt(plan, 0), { along: 0, lift: 0 });
  assert.deepEqual(climbAt(plan, plan.up), { along: plan.ends, lift: 1 });
  const early = climbAt(plan, plan.up * 0.3), half = climbAt(plan, plan.up * 0.5);
  assert.ok(early.along < 0.05 * plan.ends && early.lift > early.along / plan.ends, "mostly up at first");
  assert.ok(half.lift * plan.height < 1000, `half the climb is spent in the first kilometre, where there is something to see: ${half.lift * plan.height}`);
  assert.deepEqual(descentAt(plan, 0), { left: plan.ends, lift: 1 });
  assert.deepEqual(descentAt(plan, plan.down), { left: 0, lift: 0 });
  const late = descentAt(plan, plan.down * 0.85);
  assert.ok(late.left < 20 && late.lift * plan.height > 50, "the last of it is straight down");
  assert.ok(descentAt(plan, plan.down * 0.5).lift * plan.height < 1300, "and half the coming down is spent in the last kilometre or so");

  // Crossing: from where the climb left it to where the coming down starts, the shorter way round (west, from Auckland to Paris).
  const begin = overAt(plan, 0), end = overAt(plan, plan.over), across = overAt(plan, plan.over / 2);
  assert.ok(Math.abs(metresBetween(begin.lat, begin.lon, DEVONPORT.lat, DEVONPORT.lon) - plan.ends) < 30);
  assert.ok(Math.abs(metresBetween(end.lat, end.lon, PARIS.lat, PARIS.lon) - plan.ends) < 30);
  assert.equal(begin.w, 0);
  assert.equal(end.w, 1);
  assert.ok(across.lon > 60 && across.lon < 120, `half way is over Asia, not the Pacific: ${across.lon}`);
  assert.ok(flightHeading(plan).east < 0 && flightHeading(plan).south < 0, "heading west and north");
  for (let t = 0; t <= plan.over; t += 1) {
    const at = overAt(plan, t);
    assert.ok(Math.abs(at.lat) <= 85 && at.lon >= -180 && at.lon <= 180, "always somewhere the server will take as a position");
  }
  // The other way round the world: east over the date line from Auckland to Hawaii.
  const pacific = planFlight(DEVONPORT, { lat: 21.3, lon: -157.85 })!;
  assert.ok(flightHeading(pacific).east > 0);
  const mid = overAt(pacific, pacific.over / 2);
  assert.ok(mid.lon > 178 || mid.lon < -170, `over the date line: ${mid.lon}`);
  assert.ok(overTopSpeed(plan) > 500_000, "hundreds of kilometres a second in the haze, where there is nothing to pass");
  // A high flight that is only just one: the two ends do not overlap.
  const near = planFlight(TITIRANGI, DEVONPORT)!;
  assert.ok(near.ends * 2 < near.metres);
});

test("how far ahead the world is asked for, and how long that leaves to build it", () => {
  const tileM = chunkMetres(DEVONPORT.lat);
  assert.ok(Math.abs(tileM - 489.5) < 1, `a chunk at Auckland: ${tileM}`);
  const walk = reachAhead(tileM, 4.5), low = reachAhead(tileM, 100), fast = reachAhead(tileM, 300);
  assert.ok(Math.abs(low.near - 3 * tileM) < 1e-6 && Math.abs(low.far - 4 * tileM) < 1e-6);
  assert.ok(walk.seconds > 300, "minutes, at a walk");
  assert.ok(Math.abs(low.seconds - 14.7) < 0.2, `about fifteen seconds at 100 m/s: ${low.seconds}`);
  assert.ok(Math.abs(fast.seconds - 4.9) < 0.1, `about five at 300 m/s: ${fast.seconds}`);
  assert.equal(reachAhead(tileM, 0).seconds, Infinity);
});

test("the words that offer the choice, and the words while flying, say plainly what will be seen", () => {
  const town = choiceWords("Queens Wharf, Auckland CBD, Auckland, New Zealand", planFlight(DEVONPORT, QUEENS_WHARF))!;
  assert.equal(town.title, "Queens Wharf, New Zealand");
  assert.match(town.sub, /^2\.7 km from here/);
  assert.equal(town.now.label, "Go there now");
  assert.equal(town.fly.label, "Fly there and watch");
  assert.match(town.fly.about, /over the rooftops, about half a minute/);
  const far = choiceWords("Tour Eiffel, Paris, France", planFlight(DEVONPORT, PARIS))!;
  assert.match(far.sub, /^18,\d\d\d km from here/);
  assert.match(far.fly.about, /about a minute/);
  assert.match(far.fly.about, /land in between is not drawn/, "nothing is promised that will not be shown");
  assert.equal(choiceWords("Here", null), null, "nothing to choose when there is no flight to make");

  assert.equal(farWords(350), "350 m");
  assert.equal(farWords(2440), "2.4 km");
  assert.equal(farWords(1_240_000), "1,240 km");
  assert.equal(timeWords(12), "about 10 seconds");
  assert.equal(timeWords(30), "about half a minute");
  assert.equal(timeWords(58), "about a minute");
  assert.equal(shortName("12.50000, 45.00000"), "12.50000, 45.00000");
  assert.equal(shortName("-36.84100, 174.76830"), "-36.84100, 174.76830");
  assert.equal(shortName("Tour Eiffel, 5, Avenue Anatole France, Quartier du Gros-Caillou, Paris, Île-de-France, 75007, France"), "Tour Eiffel, France");
  assert.equal(shortName("Devonport, Auckland"), "Devonport, Auckland");
  assert.equal(shortName("Paris"), "Paris");
  const over = flyingWords("Tour Eiffel, 5, Paris, France", "over", 9_000_000);
  assert.equal(over.head, "Flying to Tour Eiffel, France");
  assert.equal(over.sub, "9,000 km to go  ·  high over the haze, where no land is drawn");
  assert.match(flyingWords("Tour Eiffel", "wait", 2000).sub, /still being built/);
  for (const part of ["up", "down", "settle"] as const) {
    assert.deepEqual(flyingWords("Queens Wharf", part, 800, { high: 12, pace: 0.4 }), { head: "Flying to Queens Wharf", sub: "800 m to go", hint: "Esc takes over   ·   V looks from above" });
  }
  // A low flight is the passenger's to trim: the words say how, and how they have it.
  const low = flyingWords("Queens Wharf", "low", 800, { high: 12.4, pace: 0.4 });
  assert.equal(low.sub, "800 m to go  ·  12 m up, slowly");
  assert.equal(flyingWords("Queens Wharf", "low", 800, { high: 3, pace: 0.1 }).sub, "800 m to go  ·  3 m up, at a stroll");
  // Flown low, it skims the roofs; as the sums have it, it keeps well over them.
  assert.deepEqual([roofClear(3), roofClear(8), roofClear(12), roofClear(180)], [3.5, 6, 8, 8]);
  assert.equal(low.hint, "Space / C up, down   ·   1 / 2 slower, faster   ·   Esc takes over   ·   V from above");
  assert.equal(flyingWords("Queens Wharf", "low", 800, { high: 60, pace: 1 }).sub, "800 m to go  ·  60 m up");
  assert.equal(flyingWords("Queens Wharf", "low", 800).sub, "800 m to go");
  assert.deepEqual([paceStep(1, -1), paceStep(1, 1), paceStep(0.25, -1), paceStep(2, 1), paceStep(0.4, 1), paceStep(0.1, -1)], [0.6, 1.5, 0.15, 2, 0.6, 0.1]);
  assert.deepEqual(PACES.includes(1) && LOW_TRIM_M, [3, 300]);
  // Held for a second it is about 2.7 times as high or as low, and never past the ends.
  assert.ok(Math.abs(trimHeight(60, -1, 1) - 60 / Math.E) < 1e-9 && Math.abs(trimHeight(60, 1, 1) - 60 * Math.E) < 1e-9);
  assert.deepEqual([trimHeight(4, -1, 5), trimHeight(200, 1, 5)], [3, 300]);
});

test("somebody being flown to a place is seen by friends as ever, but the server downloads nothing ahead of them", async () => {
  const moved: [number, number][] = [];
  const rooms = new Rooms(new GuestDirectory(""), { moved: (_id: string, lat: number, lon: number) => { moved.push([lat, lon]); } });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => rooms.wss.handleUpgrade(req, socket, head, (ws) => rooms.wss.emit("connection", ws, req)));
  await new Promise<void>((r) => server.listen(0, r));
  const url = `ws://localhost:${(server.address() as AddressInfo).port}/v1/ws`;
  const join = async (name: string) => {
    const ws = new WebSocket(url);
    const got: Record<string, any>[] = [];
    ws.on("message", (d) => got.push(JSON.parse(d.toString())));
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ t: "hello", name, room: "sky" }));
    const until = async (t: string) => {
      for (let i = 0; i < 300; i++) {
        const at = got.findIndex((m) => m.t === t);
        if (at >= 0) return got.splice(at, 1)[0];
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`no "${t}"`);
    };
    return { ws, until };
  };
  try {
    const flyer = await join("Flyer");
    const me = await flyer.until("welcome");
    const friend = await join("Friend");
    await friend.until("welcome");
    flyer.ws.send(JSON.stringify({ t: "pos", lat: -36.83, lon: 174.79, alt: 12, yaw: 300 }));
    assert.deepEqual((await friend.until("peers")).p, [[me.id, -36.83, 174.79, 12, 300]]);
    assert.deepEqual(moved, [[-36.83, 174.79]], "on the ground, the server looks ahead of them");
    // High over the haze, half way to Paris.
    flyer.ws.send(JSON.stringify({ t: "pos", lat: 10.5, lon: 90.25, alt: 3012, yaw: 300, flown: true }));
    assert.deepEqual((await friend.until("peers")).p, [[me.id, 10.5, 90.25, 3012, 300]], "friends are told where the flyer is");
    assert.equal(moved.length, 1, "and nothing more is looked for ahead of them");
    // Landed.
    flyer.ws.send(JSON.stringify({ t: "pos", lat: 48.8583, lon: 2.2945, alt: 35, yaw: 300 }));
    await friend.until("peers");
    assert.deepEqual(moved[1], [48.8583, 2.2945]);
    flyer.ws.close();
    friend.ws.close();
  } finally {
    rooms.close();
    server.close();
  }
});
