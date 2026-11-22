import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { Journals, type JournalView, type StampNews } from "../src/journal.ts";
import { GuestDirectory } from "../src/people.ts";
import { clock, type Course, GATE_REACH_M, gatesAlong, newRace, ordinal, passed, placeOf, planCourse, stale } from "../src/race.ts";
import { Rooms } from "../src/rooms.ts";
import type { Route } from "../src/route.ts";

type Msg = Record<string, any>;
const metres = (a: [number, number], b: [number, number]): number =>
  Math.hypot((b[0] - a[0]) * 111_320, (b[1] - a[1]) * 111_320 * Math.cos((a[0] * Math.PI) / 180));
/** A point `north` and `east` metres from a corner of Gouda. */
const at = (north: number, east: number): [number, number] => [52.01 + north / 111_320, 4.71 + east / (111_320 * Math.cos((52.01 * Math.PI) / 180))];

test("gates stand at the start, about every 120 m along the road, and at the finish", () => {
  // 600 m north, then 360 m east.
  const path = [at(0, 0), at(300, 0), at(600, 0), at(600, 360)];
  const gates = gatesAlong(path);
  assert.equal(gates.length, 9, "960 m is eight gaps of 120 m");
  assert.deepEqual([metres(gates[0], path[0]) < 0.1, metres(gates[8], path[3]) < 0.1], [true, true]);
  for (let i = 1; i < gates.length; i++) {
    const d = metres(gates[i - 1], gates[i]);
    assert.ok(d > 80 && d < 125, `gate ${i} is ${d.toFixed(0)} m on (a corner cuts the straight-line distance a little)`);
  }
  assert.ok(metres(gates[5], at(600, 0)) < 40, "the gates follow the road round the corner");
  assert.deepEqual(gatesAlong([at(0, 0), at(80, 0)]).length, 2, "a short dash has just a start and a finish");
  assert.deepEqual(gatesAlong([at(0, 0)]), []);
  assert.deepEqual([ordinal(1), ordinal(2), ordinal(3), ordinal(4), clock(8340), clock(75_000)], ["first", "second", "third", "4th", "8.3 s", "1 min 15 s"]);
});

test("a course is a way by road of a good length to somewhere a few streets off", async () => {
  const asked: number[] = [];
  /** Roads only lead east: any other way there is no route, and east is a 700 m street. */
  const east = async (aLat: number, aLon: number, bLat: number, bLon: number): Promise<Route | null> => {
    const bearing = (Math.atan2((bLon - aLon) * Math.cos((aLat * Math.PI) / 180), bLat - aLat) * 180) / Math.PI;
    asked.push(Math.round(bearing));
    return Math.abs(bearing - 90) < 10 ? { path: [[aLat, aLon], at(0, 350), at(0, 700)], metres: 700 } : null;
  };
  const course = (await planCourse(52.01, 4.71, 3, east))!;
  assert.deepEqual([course.metres, course.gates.length], [700, 7]);
  assert.ok(asked.length >= 1 && asked.length <= 8 && asked.includes(90), "directions are tried until one will do");
  assert.equal(await planCourse(52.01, 4.71, 3, async () => null), null, "no roads, no race");
  assert.equal(await planCourse(52.01, 4.71, 3, async () => { throw new Error("map is down"); }), null);
  // Where every way is short, the longest of them is better than nothing; a way far too long is never used.
  const stubby = await planCourse(52.01, 4.71, 0, async (aLat, aLon, bLat, bLon) => ({ path: [[aLat, aLon], [bLat, bLon]], metres: bLat > aLat ? 200 : 160 }));
  assert.equal(stubby!.metres, 200);
  assert.equal(await planCourse(52.01, 4.71, 0, async (aLat, aLon, bLat, bLon) => ({ path: [[aLat, aLon], [bLat, bLon]], metres: 5000 })), null);
});

test("gates count in turn and only once the race is on; the first over the line wins", () => {
  const course: Course = { gates: [at(0, 0), at(120, 0), at(240, 0)], metres: 240 };
  const race = newRace("mum", "Mum", course, 1000);
  race.runners.push({ id: "kid", name: "Kid", gate: 0, time: null });
  assert.equal(passed(race, "mum", ...at(0, 0), 2000), null, "nobody has said go");
  race.state = "go";
  race.startAt = 10_000;
  assert.equal(passed(race, "mum", ...at(0, 0), 9000), null, "the countdown is still running");
  assert.equal(passed(race, "kid", ...at(240, 0), 11_000), null, "the finish first is no use: the start line comes first");
  assert.equal(passed(race, "gran", ...at(0, 0), 11_000), null, "and somebody who never joined is not racing");
  assert.equal(passed(race, "kid", ...at(0, GATE_REACH_M + 5), 11_000), null, "too far to one side");
  assert.equal(passed(race, "kid", ...at(0, GATE_REACH_M - 5), 11_000), "gate");
  assert.equal(passed(race, "kid", ...at(0, 0), 11_100), null, "one gate once");
  assert.equal(passed(race, "mum", ...at(3, 0), 12_000), "gate");
  assert.equal(passed(race, "mum", ...at(118, 0), 20_000), "gate");
  assert.equal(passed(race, "mum", ...at(240, 0), 30_000), "finish");
  assert.deepEqual([race.state, placeOf(race, "mum"), placeOf(race, "kid"), race.runners[0].time], ["go", 1, 0, 20_000]);
  assert.equal(passed(race, "mum", ...at(240, 0), 31_000), null, "finished is finished");
  assert.equal(passed(race, "kid", ...at(120, 0), 40_000), "gate");
  assert.equal(passed(race, "kid", ...at(240, 0), 50_000), "finish");
  assert.deepEqual([race.state, race.ended, placeOf(race, "kid"), placeOf(race, "mum")], ["over", 50_000, 2, 1]);
  // Results stay up a minute; a race nobody starts or finishes is cleared away in the end.
  assert.deepEqual([stale(race, 60_000), stale(race, 50_000 + 61_000)], [false, true]);
  const idle = newRace("mum", "Mum", course, 0);
  assert.deepEqual([stale(idle, 9 * 60_000), stale(idle, 11 * 60_000)], [false, true]);
});

test("in a room: one sets a race up, others join, its maker says go, and everyone is told how it goes", async () => {
  const news = new Map<string, StampNews[]>();
  const journals = new Journals({});
  journals.listen((key, n) => news.set(key, [...(news.get(key) ?? []), n]));
  const gates = [at(0, 0), at(120, 0), at(240, 0)];
  let courses = 0;
  const rooms = new Rooms(new GuestDirectory(""), { journal: journals, raceCountdownMs: 150, course: async (lat) => { courses++; return lat > 60 ? null : { gates, metres: 240 }; } });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => rooms.wss.handleUpgrade(req, socket, head, (ws) => rooms.wss.emit("connection", ws, req)));
  await new Promise<void>((r) => server.listen(0, r));
  const url = `ws://localhost:${(server.address() as AddressInfo).port}/v1/ws`;
  const join = async (name: string) => {
    const ws = new WebSocket(url);
    const inbox: Msg[] = [];
    ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ t: "hello", name, room: "family", avatar: "fox" }));
    const next = async (t: string, ok: (m: Msg) => boolean = () => true): Promise<Msg> => {
      for (let i = 0; i < 300; i++) {
        const found = inbox.findIndex((m) => m.t === t && ok(m));
        if (found >= 0) return inbox.splice(found, 1)[0];
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for "${t}"`);
    };
    const welcome = await next("welcome");
    const go = (p: [number, number]): void => ws.send(JSON.stringify({ t: "pos", lat: p[0], lon: p[1], alt: 0, yaw: 0 }));
    return { ws, inbox, next, welcome, id: welcome.id as string, go };
  };
  try {
    const mum = await join("Mum");
    const kid = await join("Kid");
    assert.equal(kid.welcome.race, null);
    await new Promise((r) => setTimeout(r, 50));
    mum.ws.send(JSON.stringify({ t: "race", make: true }));
    assert.equal((await mum.next("error")).code, "nowhere");
    kid.ws.send(JSON.stringify({ t: "race", join: true }));
    assert.equal((await kid.next("error")).text, "There is no race just now");
    mum.go(at(-5, 0));
    kid.go(at(-8, 2));
    await new Promise((r) => setTimeout(r, 50));

    mum.ws.send(JSON.stringify({ t: "race", make: true }));
    let told = (await kid.next("race")).race;
    assert.deepEqual([told.by, told.byName, told.state, told.metres, told.gates.length, told.runners.map((r: Msg) => r.name)], [mum.id, "Mum", "open", 240, 3, ["Mum"]]);
    kid.ws.send(JSON.stringify({ t: "race", make: true }));
    assert.equal((await kid.next("error")).text, "Mum has a race set up already");
    kid.ws.send(JSON.stringify({ t: "race", go: true }));
    assert.equal((await kid.next("error")).text, "Only Mum can start this race");
    kid.ws.send(JSON.stringify({ t: "race", join: true }));
    assert.deepEqual((await mum.next("race", (m) => m.race?.runners.length === 2)).race.runners.map((r: Msg) => [r.name, r.gate, r.time]), [["Mum", 0, null], ["Kid", 0, null]]);
    // Someone who arrives now is told about it.
    const gran = await join("Gran");
    assert.deepEqual([gran.welcome.race.state, gran.welcome.race.runners.length], ["open", 2]);

    // Go! Standing on the line before the countdown ends counts for nothing; after it, the gates fall in turn.
    kid.go(at(0, 0));
    mum.ws.send(JSON.stringify({ t: "race", go: true }));
    told = (await kid.next("race", (m) => m.race?.state === "go")).race;
    assert.ok(told.startAt > Date.now() && told.startAt < Date.now() + 1000);
    gran.ws.send(JSON.stringify({ t: "race", join: true }));
    assert.equal((await gran.next("error")).text, "That race has already started");
    await new Promise((r) => setTimeout(r, 250));
    for (const p of [at(0, 1), at(120, 0), at(240, 0)]) { kid.go(p); await new Promise((r) => setTimeout(r, 30)); }
    told = (await mum.next("race", (m) => m.race?.runners[1]?.time != null)).race;
    assert.deepEqual([told.state, told.runners[1].gate, told.runners[0].gate], ["go", 3, 0]);
    assert.equal((await kid.next("stamp", (m) => m.kind === "race")).title, "You won the race!");
    for (const p of [at(0, 0), at(120, 0), at(240, 0)]) { mum.go(p); await new Promise((r) => setTimeout(r, 30)); }
    told = (await gran.next("race", (m) => m.race?.state === "over")).race;
    assert.ok(told.runners[0].time > told.runners[1].time && told.runners[1].time > 0);
    assert.equal((await mum.next("stamp", (m) => m.kind === "race")).title, "You came second of 2");
    kid.ws.send(JSON.stringify({ t: "journal" }));
    mum.ws.send(JSON.stringify({ t: "journal" }));
    const [first, second] = [(await kid.next("journal")).journal as JournalView, (await mum.next("journal")).journal as JournalView];
    assert.deepEqual([first.stamps.find((s) => s.id === "races")!.have, first.stamps.find((s) => s.id === "wins")!.have, second.stamps.find((s) => s.id === "wins")!.have], [1, 1, 0]);
    assert.ok(first.coins >= 30 && second.coins >= 15 && first.coins - second.coins === 15, "15 coins for finishing, 15 more for winning");

    // With the results still up, a new race may be set up; its maker leaving ends it, and where there are no roads there is none.
    kid.ws.send(JSON.stringify({ t: "race", make: true }));
    assert.deepEqual((await mum.next("race", (m) => m.race?.by === kid.id)).race.state, "open");
    mum.ws.send(JSON.stringify({ t: "race", join: true }));
    await kid.next("race", (m) => m.race?.runners.length === 2);
    mum.ws.send(JSON.stringify({ t: "race", stop: true }));
    assert.deepEqual((await kid.next("race", (m) => m.race?.runners.length === 1)).race.runners.map((r: Msg) => r.name), ["Kid"], "a runner who drops out leaves the rest to it");
    kid.ws.close();
    assert.equal((await mum.next("race", (m) => m.race === null)).race, null);
    gran.go([70, 20]);
    await new Promise((r) => setTimeout(r, 50));
    gran.ws.send(JSON.stringify({ t: "race", make: true }));
    assert.match((await gran.next("error")).text, /no roads here to race along/);
    assert.ok(courses >= 3);
    mum.ws.close();
    gran.ws.close();
  } finally {
    rooms.close();
    server.close();
    await journals.close();
  }
});
