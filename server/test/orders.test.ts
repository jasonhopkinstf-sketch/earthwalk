import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { latToY, lonToX, metersPerTile, xToLon, yToLat } from "../src/geo.ts";
import type { Features } from "../src/osm.ts";
import { GuestDirectory } from "../src/people.ts";
import { Rooms, type Way } from "../src/rooms.ts";
import { planRoute } from "../src/route.ts";
import { deedsOf, persona, systemPrompt, Talker, wishFrom, type Ask, type Deed, type Wish } from "../src/talk.ts";

type Msg = Record<string, any>;

test("plain words are understood without any AI, by the things that can do them", () => {
  const asked: [string, string, Wish | null][] = [
    ["follow me", "dog", { deed: "follow" }], ["Come with me!", "horse", { deed: "follow" }], ["come here", "cat", { deed: "come" }],
    ["stay", "cow", { deed: "stay" }], ["Stop!", "car", { deed: "stay" }], ["wait here please", "sheep", { deed: "stay" }],
    ["go home now", "dog", { deed: "home" }], ["off you go", "chicken", { deed: "home" }],
    ["do a trick", "dog", { deed: "trick" }], ["can you jump?", "rabbit", { deed: "trick" }],
    ["toot your horn! honk!", "car", { deed: "noise" }], ["moo for me", "cow", { deed: "noise" }], ["whistle", "train", { deed: "noise" }],
    ["take me to the beach", "horse", { deed: "goto", place: "beach" }], ["Drive us to Eiffel Tower, Paris.", "car", { deed: "goto", place: "Eiffel Tower, Paris" }],
    ["let's go to the old mill", "tractor", { deed: "goto", place: "old mill" }],
    // Not asked, or not something this kind of thing does.
    ["what do you eat?", "cow", null], ["hello there", "dog", null], ["follow me", "tree", null], ["follow me", "car", null],
    ["do a trick", "car", null], ["take me to the beach", "dog", null], ["come here", "house", null], ["jump", "train", null],
  ];
  for (const [said, sp, want] of asked) assert.deepEqual(wishFrom(said, sp), want, `"${said}" to a ${sp}`);
  assert.deepEqual(deedsOf("tree"), []);
  assert.deepEqual(deedsOf("sailboat"), []);
  assert.ok(deedsOf("horse").includes("goto") && !deedsOf("dog").includes("goto"));

  const prompt = systemPrompt(persona(5, "horse"), null, "horse");
  for (const must of ["follow them wherever they walk", "`do` tool", "while they are riding you", "hop on first"]) assert.ok(prompt.includes(must), `a horse is told: ${must}`);
  assert.ok(!systemPrompt(persona(5, "tree"), null, "tree").includes("`do` tool"), "a tree is offered nothing to do");
});

/** A stand-in for the AI service that answers and, when told to, calls the tool. */
function fakeAsk(answer: () => { text: string | null; act?: Msg }) {
  const calls: { messages: Msg[]; deeds: Deed[] }[] = [];
  const ask: Ask = async (_model, _system, messages, deeds = []) => {
    calls.push({ messages: messages as Msg[], deeds });
    return { ...answer(), inputTokens: 900, outputTokens: 60 };
  };
  return { ask, calls };
}

test("a thing does what it agreed to, whether the AI or its own wits understood the asking", async () => {
  // Without the AI: its own wits, and a line to go with the deed.
  const plain = new Talker({ ask: null, spendFile: null });
  const stay = await plain.reply("family", 42, "cow", "stay there", "fox", null);
  assert.deepEqual([stay.wish, stay.ai], [{ deed: "stay" }, false]);
  assert.ok(stay.text.length > 3);
  assert.equal((await plain.reply("family", 42, "cow", "what do you eat?", "fox", null)).wish, undefined);
  // Nobody is carried who is not riding.
  const afoot = await plain.reply("family", 7, "horse", "take me to the beach", "fox", null, false);
  assert.equal(afoot.wish, undefined);
  assert.match(afoot.text, /Hop on first/);
  const riding = await plain.reply("family", 7, "horse", "take me to the beach", "fox", null, true);
  assert.deepEqual(riding.wish, { deed: "goto", place: "beach" });
  assert.match(riding.text, /beach/);

  // With the AI: it is offered the deeds this kind can do, told when it is being ridden, and its tool call is the wish.
  let reply: { text: string | null; act?: Msg } = { text: "Oh, very well. Lead on.", act: { action: "follow" } };
  const { ask, calls } = fakeAsk(() => reply);
  const talker = new Talker({ ask, monthlyUsd: 30, spendFile: null });
  const follow = await talker.reply("family", 9, "dog", "walk with me", "owl", null);
  assert.deepEqual([follow.text, follow.wish, follow.ai], ["Oh, very well. Lead on.", { deed: "follow" }, true]);
  assert.deepEqual(calls[0].deeds, deedsOf("dog"));
  assert.equal(calls[0].messages.at(-1)!.content, "An owl says: walk with me");

  reply = { text: "To the sea! Hold your hat.", act: { action: "goto", place: "  the beach,  Leigh " } };
  const carried = await talker.reply("family", 7, "horse", "to the beach", "owl", null, true);
  assert.deepEqual(carried.wish, { deed: "goto", place: "the beach, Leigh" });
  assert.equal(calls[1].messages.at(-1)!.content, "An owl, who is riding you, says: to the beach");
  assert.equal((await talker.reply("family", 8, "horse", "to the beach", "owl", null, false)).wish, undefined, "not from the ground, whatever the AI says");

  // Nonsense from the AI is not obeyed: a deed this kind cannot do, a goto with no place, no action at all.
  for (const [sp, act] of [["dog", { action: "goto", place: "the beach" }], ["car", { action: "follow" }], ["horse", { action: "goto" }], ["dog", { action: "explode" }], ["dog", {}]] as [string, Msg][]) {
    reply = { text: "Hmm.", act };
    assert.equal((await talker.reply("family", 11, sp, "do it", "owl", null, true)).wish, undefined, JSON.stringify(act));
  }
  // The tool with no words: it finds its own.
  reply = { text: null, act: { action: "trick" } };
  const trick = await talker.reply("family", 12, "dog", "do a trick", "owl", null);
  assert.deepEqual([trick.wish, trick.ai], [{ deed: "trick" }, true]);
  assert.ok(trick.text.length > 3);
});

/** A grid of streets 100 m apart round a place, as one data tile would give them. */
function grid(lat: number, lon: number): { features: Features; at: (e: number, n: number) => [number, number] } {
  const x0 = lonToX(lon), y0 = latToY(lat);
  const S = metersPerTile(y0);
  const at = (e: number, n: number): [number, number] => [yToLat(y0 - n / S), xToLon(x0 + e / S)];
  const roads: Features["roads"] = [];
  let id = 1;
  for (let i = 0; i <= 5; i++) {
    // Streets running east, and streets running north, each a point every 100 m so that they meet.
    roads.push({ id: id++, cls: "road", width: 6, hw: "residential", pts: [0, 1, 2, 3, 4, 5].map((k) => [x0 + (k * 100) / S, y0 - (i * 100) / S] as [number, number]) });
    if (i !== 2) roads.push({ id: id++, cls: "road", width: 6, hw: "residential", pts: [0, 1, 2, 3, 4, 5].map((k) => [x0 + (i * 100) / S, y0 - (k * 100) / S] as [number, number]) });
  }
  roads.push({ id: id++, cls: "path", width: 2, pts: [[x0, y0], [x0 + 500 / S, y0 - 500 / S]] }); // a footpath straight across: not for cars
  return { features: { buildings: [], roads, areas: [], trees: [], addresses: [], coast: [] } as Features, at };
}

test("the way by road: along the streets, round the corners, and only where there are roads", async () => {
  const { features, at } = grid(52.01, 4.71);
  const load = async (): Promise<Features> => features;
  const [aLat, aLon] = at(5, 8), [bLat, bLon] = at(395, 305);
  const route = (await planRoute(aLat, aLon, bLat, bLon, load))!;
  assert.ok(route, "there is a way");
  assert.ok(Math.abs(route.metres - 700) < 5, `seven blocks by road, not ${route.metres} m (the footpath across would be shorter)`);
  assert.ok(route.path.length > 60 && route.path.length < 120, "a point every eight metres or so");
  // Every point is on a street: its distance east or north of the corner is a whole number of blocks.
  const x0 = lonToX(4.71), y0 = latToY(52.01), S = metersPerTile(y0);
  for (const [lat, lon] of route.path) {
    const e = (lonToX(lon) - x0) * S, n = (y0 - latToY(lat)) * S;
    const off = (v: number): number => Math.abs(v - Math.round(v / 100) * 100);
    assert.ok(off(e) < 1 || off(n) < 1, `(${e.toFixed(0)}, ${n.toFixed(0)}) is on a street`);
  }
  for (let i = 1; i < route.path.length; i++) {
    const step = Math.hypot((route.path[i][0] - route.path[i - 1][0]) * 111_320, (route.path[i][1] - route.path[i - 1][1]) * 111_320 * Math.cos((52.01 * Math.PI) / 180));
    assert.ok(step > 1 && step < 14, `steps of a few metres (${step.toFixed(1)})`);
  }
  assert.deepEqual(route.path.at(-1)!.map((v) => +v.toFixed(4)), at(400, 300).map((v) => +v.toFixed(4)), "it ends at the corner nearest the place");

  assert.equal(await planRoute(aLat, aLon, ...at(4000, 300), load), null, "too far to look for a way");
  assert.equal(await planRoute(aLat, aLon, ...at(250, 1200), load), null, "nowhere near a road");
  assert.equal(await planRoute(aLat, aLon, bLat, bLon, async () => ({ ...features, roads: [] })), null, "no roads, no way");
});

test("the way by road: it starts and ends on a street, not up a driveway, and a driveway is no short cut", async () => {
  const { features, at } = grid(52.01, 4.71);
  const x0 = lonToX(4.71), y0 = latToY(52.01), S = metersPerTile(y0);
  const pt = (e: number, n: number): [number, number] => [x0 + e / S, y0 - n / S];
  const near = (got: number[], want: number[], what: string): void => assert.deepEqual(got.map((v) => +v.toFixed(4)), want.map((v) => +v.toFixed(4)), what);
  // A driveway from a street corner up to a house, and a car park aisle cutting a block corner to corner.
  const drive = { id: 900, cls: "road" as const, width: 3.5, hw: "service", pts: [pt(200, 100), pt(230, 130)] };
  const aisle = { id: 901, cls: "road" as const, width: 3.5, hw: "service", pts: [pt(300, 300), pt(400, 400)] };
  const withLanes: Features = { ...features, roads: [...features.roads, drive, aisle] };
  const load = async (): Promise<Features> => withLanes;

  // Called from the house at the top of the driveway: the car waits at the corner, on the street.
  const fromHouse = (await planRoute(...at(232, 132), ...at(500, 100), load))!;
  near(fromHouse.path[0], at(200, 100), "it starts at the street corner, not at the top of the driveway");
  const toHouse = (await planRoute(...at(500, 100), ...at(232, 132), load))!;
  near(toHouse.path.at(-1)!, at(200, 100), "and it ends there, too");

  // Corner to corner of a block: 200 m round by the streets, not 141 m through the car park.
  const round = (await planRoute(...at(300, 300), ...at(400, 400), load))!;
  assert.ok(Math.abs(round.metres - 200) < 3, `round by the streets (${round.metres} m)`);

  // Where there are only lanes, a lane is the way, and its length is its real length.
  const only = (await planRoute(...at(302, 302), ...at(398, 398), async () => ({ ...features, roads: [aisle] })))!;
  assert.ok(only && Math.abs(only.metres - 141) < 3, `through the car park when that is all there is (${only?.metres} m)`);
});

test("in a room: orders reach everyone, newcomers learn of them, and only a rider is taken anywhere", async () => {
  const wishes: Record<string, Wish> = {
    "follow me": { deed: "follow" }, "come here": { deed: "come" }, "stay": { deed: "stay" }, "go home": { deed: "home" },
    "do a trick": { deed: "trick" }, "to the beach": { deed: "goto", place: "the beach" }, "to nowhere": { deed: "goto", place: "nowhere" },
  };
  const talker = {
    greet: () => ({ name: "Biscuit", text: "Woof.", ai: false }),
    reply: async (_room: string, _thing: number, _sp: string, said: string, _speaker: string, _place: string | null, riding?: boolean) =>
      ({ name: "Biscuit", text: "Right you are.", ai: false, ...(wishes[said] && (wishes[said].deed !== "goto" || riding) ? { wish: wishes[said] } : {}) }),
  };
  const asked: string[] = [];
  const wayTo = async (lat: number, lon: number, place: string, sp: string): Promise<Way | null> => {
    asked.push(`${lat.toFixed(2)},${lon.toFixed(2)}|${place}|${sp}`);
    return place === "nowhere" ? null : { name: "Goat Island Beach", lat: -36.27, lon: 174.8, path: [[-36.298, 174.798], [-36.27, 174.8]] };
  };
  const rooms = new Rooms(new GuestDirectory(""), { talker, wayTo, placeName: async () => "Leigh" });
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
    const next = async (t: string): Promise<Msg> => {
      for (let i = 0; i < 300; i++) {
        const at = inbox.findIndex((m) => m.t === t);
        if (at >= 0) return inbox.splice(at, 1)[0];
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for "${t}"`);
    };
    const welcome = await next("welcome");
    return { ws, inbox, next, id: welcome.id as string, welcome };
  };
  const pause = (): Promise<void> => new Promise((r) => setTimeout(r, 1250)); // things are not talked to faster than this
  try {
    const mum = await join("Mum");
    const kid = await join("Kid");
    mum.ws.send(JSON.stringify({ t: "pos", lat: -36.2989, lon: 174.7985, alt: 0, yaw: 0 }));
    await new Promise((r) => setTimeout(r, 50));
    const say = (c: typeof mum, thing: number, sp: string, text: string): void => c.ws.send(JSON.stringify({ t: "talk", thing, sp, text, lat: -36.2988, lon: 174.7986 }));

    say(mum, 42, "dog", "follow me");
    const follow = await kid.next("order");
    assert.deepEqual([follow.thing, follow.sp, follow.act, follow.by, follow.lat, follow.lon], [42, "dog", "follow", mum.id, -36.2988, 174.7986]);
    assert.ok(follow.until > follow.at + 60_000);
    assert.equal((await mum.next("order")).act, "follow");

    await pause();
    say(mum, 43, "cat", "come here");
    const come = await kid.next("order");
    assert.deepEqual([come.act, come.to], ["come", [-36.2989, 174.7985]], "to where the asker stood");
    await mum.next("order");

    const late = await join("Grandad");
    assert.deepEqual(late.welcome.orders.map((o: Msg) => [o.thing, o.act]).sort(), [[42, "follow"], [43, "come"]], "a newcomer is told what is afoot");

    await pause();
    say(mum, 42, "dog", "do a trick");
    assert.deepEqual([(await kid.next("order")).act, (await late.next("order")).act], ["trick", "trick"]);
    await mum.next("order");
    await pause();
    say(mum, 42, "dog", "go home");
    assert.deepEqual([(await kid.next("order")).act, (await mum.next("order")).act], ["home", "home"]);

    // Take me to: nothing from the ground; riding, the rider alone is sent the way.
    await pause();
    say(mum, 77, "car", "to the beach");
    await mum.next("say");
    mum.ws.send(JSON.stringify({ t: "ride", thing: 77, sp: "car" }));
    await mum.next("ride");
    await pause();
    say(mum, 77, "car", "to the beach");
    const go = await mum.next("order");
    assert.deepEqual([go.act, go.thing, go.name, go.lat, go.lon, go.path.length], ["goto", 77, "Goat Island Beach", -36.27, 174.8, 2]);
    assert.deepEqual(asked, ["-36.30,174.80|the beach|car"], "asked once, from where the rider is");
    await pause();
    say(mum, 77, "car", "to nowhere");
    assert.equal((await mum.next("error")).code, "nowhere");
    // Hello and where to in the same breath, as "Go to..." in a car does: both are answered, and off it goes.
    await pause();
    mum.inbox.length = 0;
    mum.ws.send(JSON.stringify({ t: "talk", thing: 77, sp: "car" }));
    say(mum, 77, "car", "to the beach");
    assert.equal((await mum.next("order")).act, "goto");
    assert.deepEqual(mum.inbox.filter((m) => m.t === "error"), [], "the telling is not refused for coming straight after the hello");
    // Two things said in the same breath are still one too many.
    say(mum, 77, "car", "stay");
    assert.equal((await mum.next("error")).code, "slow");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(kid.inbox.filter((m) => m.t === "order").length, 0, "nobody else is sent a rider's journey");

    // Whoever gave an order leaves: what they were leading goes home.
    mum.ws.close();
    const freed = await kid.next("order");
    assert.deepEqual([freed.thing, freed.act], [43, "home"]);
    kid.ws.close();
    late.ws.close();
  } finally {
    rooms.close();
    server.close();
  }
});
