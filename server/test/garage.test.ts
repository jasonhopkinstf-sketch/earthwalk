import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { CAR_BODIES, CAR_PAINTS } from "../src/garage.ts";
import { Journals, type JournalView } from "../src/journal.ts";
import { GuestDirectory } from "../src/people.ts";
import { Rooms } from "../src/rooms.ts";

type Msg = Record<string, any>;

test("everyone has a car; plain paints are free, the rest are bought once with coins", async () => {
  const clock = { now: Date.UTC(2026, 10, 22, 9) };
  const journals = new Journals({ now: () => clock.now });
  await journals.joined("a", null, "family");
  let v = journals.view("a") as JournalView;
  assert.deepEqual([v.garage.body, v.garage.paint, journals.carOf("a")], ["car", "red", { body: "car", paint: 0xd94a3a }]);
  assert.equal(v.garage.paints.length, CAR_PAINTS.length);
  assert.deepEqual(v.garage.paints.filter((p) => p.owned).map((p) => p.id), ["red", "blue", "yellow", "green"]);
  assert.deepEqual(v.garage.bodies.map((b) => [b.id, b.owned]), [["car", true], ["van", false]]);
  assert.equal(new Set(CAR_PAINTS.map((p) => p.id)).size, CAR_PAINTS.length);
  assert.ok(CAR_BODIES.every((b) => ["car", "van"].includes(b.id)), "only bodies the games can already draw");

  // A free paint costs nothing; a bought one needs the coins, and is then theirs.
  assert.deepEqual([journals.setCar("a", { paint: "blue" }), journals.carOf("a").paint], ["ok", 0x3f7fd0]);
  assert.deepEqual([journals.setCar("a", { paint: "gold" }), journals.setCar("a", { body: "van" }), journals.setCar("a", { paint: "tartan" }), journals.setCar("a", {})], ["poor", "poor", "unknown", "unknown"]);
  assert.equal(journals.carOf("a").paint, 0x3f7fd0, "nothing changed");
  // Six riddles answered are 90 coins.
  for (const [i, sp] of ["cow", "tree", "house", "car", "snail", "frog", "bee"].entries()) journals.talked("a", 50 + i, sp, "Friend", "", "Hello.");
  const coins = (journals.view("a") as JournalView).coins;
  assert.ok(coins >= 90);
  assert.deepEqual([journals.setCar("a", { paint: "pink" }), journals.setCar("a", { body: "van" })], ["ok", coins - 30 >= 80 ? "ok" : "poor"]);
  v = journals.view("a") as JournalView;
  assert.ok(v.garage.paint === "pink" && v.garage.paints.find((p) => p.id === "pink")!.owned && v.coins <= coins - 30);
  const after = v.coins;
  assert.deepEqual([journals.setCar("a", { paint: "red" }), journals.setCar("a", { paint: "pink" }), (journals.view("a") as JournalView).coins], ["ok", "ok", after], "paid for once");
  await journals.close();
});

test("in a room: a car is called to its owner, seen by all, driven only by its owner, and stays where it is left", async () => {
  const journals = new Journals({});
  const rooms = new Rooms(new GuestDirectory(""), { journal: journals });
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
        const at = inbox.findIndex((m) => m.t === t && ok(m));
        if (at >= 0) return inbox.splice(at, 1)[0];
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for "${t}"`);
    };
    const welcome = await next("welcome");
    return { ws, inbox, next, welcome, id: welcome.id as string };
  };
  try {
    const mum = await join("Mum");
    const kid = await join("Kid");
    assert.deepEqual(kid.welcome.cars, []);
    await new Promise((r) => setTimeout(r, 50));
    mum.ws.send(JSON.stringify({ t: "garage", call: true }));
    assert.equal((await mum.next("error")).code, "nowhere");
    mum.ws.send(JSON.stringify({ t: "pos", lat: 52.01, lon: 4.71, alt: 0, yaw: 0 }));
    kid.ws.send(JSON.stringify({ t: "pos", lat: 52.01, lon: 4.71, alt: 0, yaw: 0 }));
    await new Promise((r) => setTimeout(r, 50));

    // Called: it draws up three metres to her right (east, since she faces north), in her colours, for all to see.
    mum.ws.send(JSON.stringify({ t: "garage", paint: "green" }));
    assert.equal(((await mum.next("journal")).journal as JournalView).garage.paint, "green");
    mum.ws.send(JSON.stringify({ t: "garage", call: true }));
    const car = await kid.next("car");
    assert.deepEqual([car.id, car.body, car.paint, car.lat, car.yaw], [mum.id, "car", 0x4caf6a, 52.01, 0]);
    const east = (car.lon - 4.71) * 111_320 * Math.cos((52.01 * Math.PI) / 180);
    assert.ok(Math.abs(east - 3) < 0.05, `three metres to the east (${east.toFixed(2)})`);
    assert.ok(Number.isInteger(car.thing) && car.thing > 0);
    await mum.next("car");

    // The child cannot drive it off, but rides along once Mum is at the wheel.
    kid.ws.send(JSON.stringify({ t: "ride", thing: car.thing, sp: "car" }));
    const no = await kid.next("error");
    assert.deepEqual([no.code, no.text], ["taken", "That is Mum's car. Hop in when they are driving."]);
    mum.ws.send(JSON.stringify({ t: "ride", thing: car.thing, sp: "car" }));
    assert.equal((await kid.next("ride", (m) => m.id === mum.id)).seat, 0);
    kid.ws.send(JSON.stringify({ t: "ride", thing: car.thing, sp: "car" }));
    assert.equal((await mum.next("ride", (m) => m.id === kid.id)).seat, 1);
    mum.ws.send(JSON.stringify({ t: "garage", call: true }));
    assert.equal((await mum.next("error")).text, "You are sitting in it");

    // A new coat of paint shows at once. Where she gets out, it stays: it is told as her car, not as a thing left.
    mum.ws.send(JSON.stringify({ t: "garage", paint: "blue" }));
    assert.equal((await kid.next("car")).paint, 0x3f7fd0);
    mum.ws.send(JSON.stringify({ t: "pos", lat: 52.02, lon: 4.72, alt: 0, yaw: 90 }));
    await new Promise((r) => setTimeout(r, 50));
    mum.ws.send(JSON.stringify({ t: "ride" }));
    const parked = await kid.next("car", (m) => m.lat === 52.02);
    assert.deepEqual([parked.lon, parked.yaw, parked.thing], [4.72, 90, car.thing]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(kid.inbox.filter((m) => m.t === "left").length, 0);

    // Someone who comes later is told where it stands. Sent away, or when its owner leaves, it is gone.
    const late = await join("Gran");
    assert.deepEqual(late.welcome.cars.map((c: Msg) => [c.id, c.lat, c.paint]), [[mum.id, 52.02, 0x3f7fd0]]);
    mum.ws.send(JSON.stringify({ t: "garage", away: true }));
    assert.deepEqual(await late.next("car"), { t: "car", id: mum.id });
    mum.ws.send(JSON.stringify({ t: "garage", call: true }));
    await late.next("car", (m) => m.thing === car.thing);
    mum.ws.close();
    assert.deepEqual(await late.next("car"), { t: "car", id: mum.id });
    kid.ws.close();
    late.ws.close();
  } finally {
    rooms.close();
    server.close();
    await journals.close();
  }
});
