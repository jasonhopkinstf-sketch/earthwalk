import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { Journals, type JournalView } from "../src/journal.ts";
import { levelPrizes } from "../src/progress.ts";
import { GuestDirectory } from "../src/people.ts";
import { AGILITY_REACH_M, agilityCourse, newRace, passed } from "../src/race.ts";
import { type JournalKeeper, Rooms } from "../src/rooms.ts";

type Msg = Record<string, any>;
const metres = (a: [number, number], b: [number, number]): number => Math.hypot((a[0] - b[0]) * 111_320, (a[1] - b[1]) * 111_320 * Math.cos((a[0] * Math.PI) / 180));

test("an agility course: nine obstacles in a ring before whoever sets it up, passed in order and only from close by", () => {
  const here: [number, number] = [52.01, 4.71];
  const north = agilityCourse(here[0], here[1], 0, 3), east = agilityCourse(here[0], here[1], 90, 3);
  assert.deepEqual([north.kind, north.reach, north.gates.length, north.obstacles!.length], ["agility", AGILITY_REACH_M, 9, 9]);
  assert.deepEqual([north.obstacles![0], north.obstacles![8]], ["start", "finish"]);
  assert.deepEqual([...north.obstacles!.slice(1, 8)].sort(), ["hoop", "jump", "jump", "jump", "table", "tunnel", "weave"]);
  assert.notDeepEqual(agilityCourse(here[0], here[1], 0, 4).obstacles, north.obstacles, "another day, another order");
  // The start is five metres ahead: north of somebody facing north, east of somebody facing east.
  assert.ok(Math.abs(metres(here, north.gates[0]) - 5) < 0.1 && north.gates[0][0] > here[0] && Math.abs(north.gates[0][1] - here[1]) < 1e-6);
  assert.ok(Math.abs(metres(here, east.gates[0]) - 5) < 0.1 && east.gates[0][1] > here[1] && Math.abs(east.gates[0][0] - here[0]) < 1e-6);
  for (let i = 1; i < 9; i++) {
    const gap = metres(north.gates[i - 1], north.gates[i]);
    assert.ok(gap > AGILITY_REACH_M * 2 && gap < 12, `obstacles ${i - 1} and ${i} are ${gap.toFixed(1)} m apart: no two passed at once`);
    assert.ok(metres(here, north.gates[i]) < 30);
  }
  assert.ok(north.metres > 40 && north.metres < 80);

  // Run as a race: only the next obstacle counts, and only from within a few steps of it.
  const race = newRace("a", "Sam", north, 1000);
  assert.deepEqual([race.kind, race.reach, race.obstacles], ["agility", AGILITY_REACH_M, north.obstacles]);
  race.state = "go";
  race.startAt = 2000;
  const near = (g: [number, number], m: number): [number, number] => [g[0] + m / 111_320, g[1]];
  assert.equal(passed(race, "a", ...near(north.gates[0], 5), 3000), null, "five metres off is not through it");
  assert.equal(passed(race, "a", ...north.gates[3], 3000), null, "nor is one further round");
  for (let i = 0; i < 8; i++) assert.equal(passed(race, "a", ...near(north.gates[i], 2), 3000 + i * 1000), "gate");
  assert.equal(passed(race, "a", ...north.gates[8], 12_000), "finish");
  assert.deepEqual([race.state, race.runners[0].time], ["over", 10_000]);
});

test("the journal: a round is paid for, and the quickest kept", async () => {
  const journals = new Journals({});
  const told: string[] = [];
  journals.listen((_key, news) => { if (news.kind === "race") told.push(`${news.title}. ${news.text}`); });
  await journals.joined("a", null, "family");
  assert.deepEqual((journals.view("a") as JournalView).agility, { runs: 0, bestSeconds: null });
  const { coins, level } = journals.view("a") as JournalView;
  journals.agility("a", 1, 1, 31_400);
  journals.agility("a", 1, 1, 40_000);
  journals.agility("a", 1, 1, 28_000);
  journals.agility("a", 1, 2, 29_000);
  const v = journals.view("a") as JournalView;
  assert.deepEqual([v.agility, v.coins - coins, v.stamps.find((s) => s.id === "agility")!.have], [{ runs: 4, bestSeconds: 28 }, 12 + 12 + 17 + 20 + levelPrizes(level.n, v.level.n), 4]); // and the prize of any level the rounds reached
  assert.deepEqual(told.map((t) => t.split(".")[0]), ["A clear round", "A clear round", "Your quickest round yet!", "You and your companion won!"]);
  await journals.close();
});

test("in a room: an agility course wants a companion, and a round run is told to the journal as one", async () => {
  const runs: unknown[] = [];
  let pet: string | null = null;
  const journal: JournalKeeper = {
    listen: () => {}, joined: async () => {}, left: () => {}, moved: () => {}, rode: () => {}, talked: () => {}, view: () => null,
    petOf: () => pet, setPet: (_key, sp) => { pet = sp; return true; },
    raced: () => { runs.push("a race"); },
    agility: (_key, place, of, ms) => { runs.push([place, of, ms > 0]); },
  };
  const rooms = new Rooms(new GuestDirectory(""), { journal, raceCountdownMs: 30 });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => rooms.wss.handleUpgrade(req, socket, head, (ws) => rooms.wss.emit("connection", ws, req)));
  await new Promise<void>((r) => server.listen(0, r));
  const ws = new WebSocket(`ws://localhost:${(server.address() as AddressInfo).port}/v1/ws`);
  const inbox: Msg[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
  await new Promise<void>((r) => ws.on("open", () => r()));
  const send = (m: Msg): void => ws.send(JSON.stringify(m));
  const next = async (t: string, ok: (m: Msg) => boolean = () => true): Promise<Msg> => {
    for (let i = 0; i < 300; i++) {
      const at = inbox.findIndex((m) => m.t === t && ok(m));
      if (at >= 0) return inbox.splice(at, 1)[0];
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for "${t}"`);
  };
  try {
    send({ t: "hello", name: "Sam", room: "family", avatar: "fox" });
    await next("welcome");
    send({ t: "pos", lat: 52.01, lon: 4.71, alt: 0, yaw: 0 });
    await new Promise((r) => setTimeout(r, 50));
    send({ t: "race", make: "agility" });
    assert.match((await next("error")).text, /a companion/);
    send({ t: "pet", sp: "cow" });
    await next("pet", (m) => m.sp === "cow");
    send({ t: "race", make: "agility" });
    const race = (await next("race")).race;
    assert.deepEqual([race.kind, race.gates.length, race.obstacles.length, race.reach, race.state], ["agility", 9, 9, AGILITY_REACH_M, "open"]);
    send({ t: "race", go: true });
    await next("race", (m) => m.race.state === "go");
    await new Promise((r) => setTimeout(r, 60));
    for (const [lat, lon] of race.gates) {
      send({ t: "pos", lat, lon, alt: 0, yaw: 0 });
      await next("race");
    }
    assert.deepEqual(runs, [[1, 1, true]], "an agility round, not a road race");
    ws.close();
  } finally {
    for (const client of rooms.wss.clients) client.terminate();
    server.close();
    rooms.wss.close();
  }
});
