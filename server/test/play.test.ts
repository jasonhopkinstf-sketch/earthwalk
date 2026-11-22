import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { Journals, type JournalView } from "../src/journal.ts";
import { GuestDirectory } from "../src/people.ts";
import { beginPlay, FIELD_M, type Follower, HIDE_FOR_MS, joinPlay, leavePlay, newPlay, OUT_MS, outcomes, SAFE_MS, SEEK_FOR_MS, stalePlay, stepHerd, stepPlay, TAG_FOR_MS, type Where } from "../src/play.ts";
import { Rooms } from "../src/rooms.ts";

type Msg = Record<string, any>;
/** A point `north` and `east` metres from the middle of the field. */
const at = (north: number, east: number, alt = 0): Where => ({ lat: 52.01 + north / 111_320, lon: 4.71 + east / (111_320 * Math.cos((52.01 * Math.PI) / 180)), alt });

test("tag: a touch passes it on, nobody is tagged straight back, leaving the field makes you it, and least time wins", () => {
  const play = newPlay("tag", "mum", "Mum", 52.01, 4.71, 0);
  assert.deepEqual([play.radius, play.state, play.players.length], [FIELD_M.tag, "open", 1]);
  assert.equal(beginPlay(play, 0), false, "it takes two");
  assert.deepEqual([joinPlay(play, "kid", "Kid"), joinPlay(play, "kid", "Kid"), joinPlay(play, "gran", "Gran")], [true, false, true]);
  assert.equal(beginPlay(play, 1000, 5000, () => 0), true); // the lot falls on the first: Mum is it
  assert.deepEqual([play.state, play.it, play.startAt, play.endAt], ["go", "mum", 6000, 6000 + TAG_FOR_MS]);
  assert.equal(joinPlay(play, "late", "Late"), false, "nobody joins once it has begun");

  const here = new Map<string, Where>([["mum", at(0, 0)], ["kid", at(0, 2)], ["gran", at(30, 0)]]);
  const where = (id: string): Where | null => here.get(id) ?? null;
  assert.equal(stepPlay(play, where, 3000), false, "the countdown is still running");
  // Mum is beside Kid: Kid is it. Kid cannot tag her straight back, but can once she is no longer safe.
  assert.equal(stepPlay(play, where, 10_000), true);
  assert.deepEqual([play.it, play.safe?.id, play.players[0].itMs], ["kid", "mum", 4000]);
  assert.equal(stepPlay(play, where, 11_000), false, "no tag-backs");
  assert.equal(stepPlay(play, where, 10_000 + SAFE_MS + 100), true);
  assert.deepEqual([play.it, play.players[1].itMs], ["mum", SAFE_MS + 100]);
  // A touch needs to be close, and on the same level.
  here.set("mum", at(0, 0));
  here.set("kid", at(0, 40));
  here.set("gran", at(0, 2, 12));
  assert.equal(stepPlay(play, where, 20_000), false, "Gran is on a roof");
  here.set("gran", at(0, 5));
  assert.equal(stepPlay(play, where, 21_000), false, "five metres is not a touch");
  // Kid runs off the field: after a few seconds out there, Kid is it.
  here.set("kid", at(0, FIELD_M.tag + 30));
  assert.equal(stepPlay(play, where, 30_000), false);
  assert.equal(stepPlay(play, where, 30_000 + OUT_MS - 500), false, "a moment to come back");
  assert.equal(stepPlay(play, where, 30_000 + OUT_MS), true);
  assert.equal(play.it, "kid");
  // Coming back in time is no fault.
  here.set("kid", at(0, 40));
  here.set("gran", at(0, FIELD_M.tag + 30));
  stepPlay(play, where, 40_000);
  here.set("gran", at(0, 50));
  stepPlay(play, where, 42_000);
  here.set("gran", at(0, FIELD_M.tag + 30));
  assert.equal(stepPlay(play, where, 40_000 + OUT_MS + 500), false, "the count starts again each time");
  here.set("gran", at(20, 0));

  // Time: whoever was it least has won. Gran never was.
  assert.equal(stepPlay(play, where, play.endAt + 10), true);
  assert.deepEqual([play.state, stepPlay(play, where, play.endAt + 20)], ["over", false]);
  const result = outcomes(play);
  assert.deepEqual(result.map((o) => [o.id, o.won, o.coins]), [["mum", false, 10], ["kid", false, 10], ["gran", true, 20]]);
  assert.equal(play.players.reduce((sum, p) => sum + p.itMs, 0), TAG_FOR_MS, "every moment of the game somebody was it");
  assert.match(result[2].text, /^You were it for 0 s$/);
  assert.deepEqual([stalePlay(play, play.ended + 30_000), stalePlay(play, play.ended + 61_000)], [false, true]);
});

test("hide and seek: hiders are safe while they hide, found by coming close, and anyone still hidden at the end has won", () => {
  const play = newPlay("hide", "mum", "Mum", 52.01, 4.71, 0);
  joinPlay(play, "kid", "Kid");
  joinPlay(play, "gran", "Gran");
  joinPlay(play, "dad", "Dad");
  beginPlay(play, 0, 5000, () => 0.3); // the lot falls on the second: Kid seeks
  assert.deepEqual([play.it, play.seekAt, play.endAt], ["kid", 5000 + HIDE_FOR_MS, 5000 + HIDE_FOR_MS + SEEK_FOR_MS]);
  const here = new Map<string, Where>([["mum", at(0, 0)], ["kid", at(0, 1)], ["gran", at(60, 0)], ["dad", at(0, 80)]]);
  const where = (id: string): Where | null => here.get(id) ?? null;
  assert.equal(stepPlay(play, where, 20_000), false, "the seeker is still counting, however close they stand");
  here.set("mum", at(-40, 0));
  assert.equal(stepPlay(play, where, play.seekAt + 1000), false, "nobody is near");
  // The seeker walks up to Mum; then looks for Gran on the wrong floor of a house, then the right one.
  here.set("kid", at(-40, 3));
  assert.equal(stepPlay(play, where, play.seekAt + 20_000), true);
  assert.deepEqual(play.players.map((p) => !!p.found), [true, false, false, false]);
  here.set("gran", at(60, 0, 9));
  here.set("kid", at(60, 1, 0));
  assert.equal(stepPlay(play, where, play.seekAt + 40_000), false);
  here.set("kid", at(60, 1, 8));
  assert.equal(stepPlay(play, where, play.seekAt + 50_000), true);
  // Dad wanders off the field and is counted found.
  here.set("dad", at(0, FIELD_M.hide + 40));
  stepPlay(play, where, play.seekAt + 60_000);
  assert.equal(stepPlay(play, where, play.seekAt + 60_000 + OUT_MS), true);
  assert.equal(play.state, "over", "everyone found: over before the clock");
  assert.deepEqual(outcomes(play).map((o) => [o.id, o.won, o.coins, o.title]), [
    ["mum", false, 10, "You were found"], ["kid", true, 25, "You found everyone!"], ["gran", false, 10, "You were found"], ["dad", false, 10, "You were found"],
  ]);

  // Another game: the clock runs out with one still hidden.
  const second = newPlay("hide", "mum", "Mum", 52.01, 4.71, 0);
  joinPlay(second, "kid", "Kid");
  joinPlay(second, "gran", "Gran");
  beginPlay(second, 0, 5000, () => 0);
  here.set("mum", at(0, 0));
  here.set("kid", at(0, 2));
  here.set("gran", at(70, 0));
  stepPlay(second, where, second.seekAt + 5000);
  assert.equal(stepPlay(second, where, second.endAt), true);
  assert.deepEqual(outcomes(second).map((o) => [o.id, o.won, o.coins]), [["mum", false, 15], ["kid", false, 10], ["gran", true, 20]]);
  assert.equal(outcomes(second)[2].title, "You were never found!");
});

test("leaving: a game ends with its maker or when too few are left; if it leaves tag, another takes over", () => {
  const tag = newPlay("tag", "mum", "Mum", 52.01, 4.71, 0);
  joinPlay(tag, "kid", "Kid");
  joinPlay(tag, "gran", "Gran");
  beginPlay(tag, 0, 0, () => 0.5); // Kid is it
  assert.equal(leavePlay(tag, "nobody", 1000), "on");
  assert.equal(leavePlay(tag, "kid", 1000), "gone");
  assert.ok(tag.it === "mum" || tag.it === "gran");
  assert.equal(leavePlay(tag, "gran", 2000), "ended", "one player is no game");
  const hide = newPlay("hide", "mum", "Mum", 52.01, 4.71, 0);
  joinPlay(hide, "kid", "Kid");
  joinPlay(hide, "gran", "Gran");
  beginPlay(hide, 0, 0, () => 0.5); // Kid seeks
  assert.equal(leavePlay(hide, "gran", 1000), "gone");
  assert.equal(leavePlay(hide, "kid", 2000), "ended", "no seeker, no game");
  const open = newPlay("tag", "mum", "Mum", 52.01, 4.71, 0);
  joinPlay(open, "kid", "Kid");
  assert.deepEqual([leavePlay(open, "kid", 0), leavePlay(open, "mum", 0)], ["gone", "ended"]);
  assert.deepEqual([stalePlay(newPlay("tag", "a", "A", 0, 0, 0), 9 * 60_000), stalePlay(newPlay("tag", "a", "A", 0, 0, 0), 11 * 60_000)], [false, true]);
});

test("in a room: a game of tag from setting up to the coins, with the room told at every turn", async () => {
  const journals = new Journals({});
  const rooms = new Rooms(new GuestDirectory(""), { journal: journals, playCountdownMs: 100, playLot: () => 0 });
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
    const go = (p: Where): void => ws.send(JSON.stringify({ t: "pos", lat: p.lat, lon: p.lon, alt: p.alt, yaw: 0 }));
    return { ws, inbox, next, welcome, id: welcome.id as string, go };
  };
  try {
    const mum = await join("Mum");
    const kid = await join("Kid");
    assert.equal(kid.welcome.play, null);
    mum.go(at(0, 0));
    kid.go(at(0, 30));
    await new Promise((r) => setTimeout(r, 50));
    mum.ws.send(JSON.stringify({ t: "play", make: "tag" }));
    let told = (await kid.next("play")).play;
    assert.deepEqual([told.kind, told.byName, told.state, told.radius, told.players.map((p: Msg) => p.name)], ["tag", "Mum", "open", FIELD_M.tag, ["Mum"]]);
    mum.ws.send(JSON.stringify({ t: "play", go: true }));
    assert.match((await mum.next("error")).text, /at least two/);
    kid.ws.send(JSON.stringify({ t: "race", make: true }));
    assert.equal((await kid.next("error")).text, "There is a game set up here already");
    kid.ws.send(JSON.stringify({ t: "play", make: "hide" }));
    assert.equal((await kid.next("error")).text, "There is a game set up here already");
    kid.ws.send(JSON.stringify({ t: "play", go: true }));
    assert.equal((await kid.next("error")).text, "Only Mum can start this game");
    kid.ws.send(JSON.stringify({ t: "play", join: true }));
    await mum.next("play", (m) => m.play?.players.length === 2);
    const gran = await join("Gran");
    assert.deepEqual([gran.welcome.play.kind, gran.welcome.play.players.length], ["tag", 2]);

    mum.ws.send(JSON.stringify({ t: "play", go: true }));
    told = (await kid.next("play", (m) => m.play?.state === "go")).play;
    assert.deepEqual([told.it, told.endAt - told.startAt], [mum.id, TAG_FOR_MS]);
    await new Promise((r) => setTimeout(r, 200));
    // Mum walks up to Kid: Kid is it, and everyone is told.
    mum.go(at(0, 29));
    told = (await gran.next("play", (m) => m.play?.it === kid.id)).play;
    assert.equal(told.safe.id, mum.id);

    // The clock is wound on to the end by the test; the next look at the game settles it and pays everyone.
    const live = (rooms as unknown as { rooms: Map<string, { play: { endAt: number } }> }).rooms.get("family")!.play;
    live.endAt = Date.now() - 1;
    kid.go(at(0, 31));
    told = (await mum.next("play", (m) => m.play?.state === "over")).play;
    assert.ok(told.players[0].itMs > 0 && told.players[0].itMs < told.players[1].itMs + 5000);
    const titles = [(await mum.next("stamp", (m) => m.kind === "play")).title, (await kid.next("stamp", (m) => m.kind === "play")).title].sort();
    assert.ok(titles.includes("You won at tag!") && titles.includes("Tag is over"), titles.join(" / "));
    mum.ws.send(JSON.stringify({ t: "journal" }));
    kid.ws.send(JSON.stringify({ t: "journal" }));
    const [a, b] = [(await mum.next("journal")).journal as JournalView, (await kid.next("journal")).journal as JournalView];
    assert.deepEqual([a.stamps.find((s) => s.id === "games")!.have, b.stamps.find((s) => s.id === "games")!.have], [1, 1]);
    assert.equal(a.coins + b.coins, 30, "ten each for playing and ten for the winner");
    assert.equal(gran.inbox.filter((m) => m.t === "stamp" && m.kind === "play").length, 0);

    // Hide and seek can be set up while the results are still showing; its maker leaving ends it.
    kid.ws.send(JSON.stringify({ t: "play", make: "hide" }));
    assert.deepEqual((await mum.next("play", (m) => m.play?.kind === "hide")).play.radius, FIELD_M.hide);
    kid.ws.close();
    assert.equal((await mum.next("play", (m) => m.play === null)).play, null);
    mum.ws.close();
    gran.ws.close();
  } finally {
    rooms.close();
    server.close();
    await journals.close();
  }
});

test("a round-up: animals following a player count when their leader steps into the pen, and enough of them wins", () => {
  const play = newPlay("herd", "mum", "Mum", 52.01, 4.71, 0);
  assert.equal(play.radius, FIELD_M.herd);
  assert.equal(beginPlay(play, 0, 1000), true, "one player is enough");
  assert.deepEqual([play.goal, play.it, play.endAt], [5, null, 1000 + 5 * 60_000]);
  const pair = newPlay("herd", "mum", "Mum", 52.01, 4.71, 0);
  joinPlay(pair, "kid", "Kid");
  beginPlay(pair, 0, 0);
  assert.equal(pair.goal, 7, "two more for each friend");

  const here = new Map<string, Where>([["mum", at(40, 0)]]);
  const where = (id: string): Where | null => here.get(id) ?? null;
  let led: Follower[] = [{ thing: 11, sp: "sheep" }, { thing: 12, sp: "sheep" }];
  const followers = (): Follower[] => led;
  assert.deepEqual(stepHerd(play, where, followers, 500), { changed: false, penned: [] }, "not begun");
  assert.deepEqual(stepHerd(play, where, followers, 5000).penned, [], "leading them about the field is not bringing them in");
  here.set("mum", at(3, 2));
  assert.deepEqual(stepHerd(play, where, followers, 6000).penned, [{ thing: 11, sp: "sheep", by: "mum" }, { thing: 12, sp: "sheep", by: "mum" }]);
  assert.deepEqual(stepHerd(play, where, followers, 7000), { changed: false, penned: [] }, "each animal counts once");
  assert.equal(stepPlay(play, where, 7000), false, "the rules of tag have nothing to say here");
  // Three more, of any kind: a cow, a duck and a snail.
  led = [{ thing: 11, sp: "sheep" }, { thing: 20, sp: "cow" }, { thing: 21, sp: "duck" }, { thing: 22, sp: "snail" }, { thing: 23, sp: "pig" }];
  const last = stepHerd(play, where, followers, 60_000);
  assert.deepEqual([last.penned.map((f) => f.thing), play.state, play.penned.length], [[20, 21, 22], "over", 5], "the pen is full at five: the pig stays out");
  assert.deepEqual(outcomes(play).map((o) => [o.won, o.coins, o.title, o.text]), [[true, 30, "The herd is home!", "5 of 5 brought in, 5 by you"]]);

  // Time runs out with some in: nobody has failed, and everyone is paid for what was done.
  here.set("kid", at(0, 1));
  here.set("mum", at(50, 0));
  stepHerd(pair, where, (id) => (id === "kid" ? [{ thing: 31, sp: "goat" }] : []), 10_000);
  assert.deepEqual(stepHerd(pair, where, () => [], pair.endAt), { changed: true, penned: [] });
  assert.deepEqual(outcomes(pair).map((o) => [o.id, o.won, o.coins, o.text]), [["mum", false, 12, "1 of 7 brought in, 0 by you"], ["kid", false, 12, "1 of 7 brought in, 1 by you"]]);
  assert.equal(leavePlay(pair, "kid", 0), "gone");
  const solo = newPlay("herd", "mum", "Mum", 52.01, 4.71, 0);
  joinPlay(solo, "kid", "Kid");
  beginPlay(solo, 0, 0);
  assert.equal(leavePlay(solo, "kid", 1), "gone", "one may carry on a round-up alone");
});

test("in a room: a round-up alone, with animals told to follow and settled in the pen", async () => {
  const journals = new Journals({});
  const rooms = new Rooms(new GuestDirectory(""), { journal: journals, playCountdownMs: 50 });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => rooms.wss.handleUpgrade(req, socket, head, (ws) => rooms.wss.emit("connection", ws, req)));
  await new Promise<void>((r) => server.listen(0, r));
  const ws = new WebSocket(`ws://localhost:${(server.address() as AddressInfo).port}/v1/ws`);
  const inbox: Msg[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
  await new Promise<void>((r) => ws.on("open", () => r()));
  const next = async (t: string, ok: (m: Msg) => boolean = () => true): Promise<Msg> => {
    for (let i = 0; i < 300; i++) {
      const found = inbox.findIndex((m) => m.t === t && ok(m));
      if (found >= 0) return inbox.splice(found, 1)[0];
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for "${t}"`);
  };
  const go = (p: Where): void => ws.send(JSON.stringify({ t: "pos", lat: p.lat, lon: p.lon, alt: p.alt, yaw: 0 }));
  try {
    ws.send(JSON.stringify({ t: "hello", name: "Mum", room: "family", avatar: "fox" }));
    const me = (await next("welcome")).id as string;
    go(at(0, 0));
    await new Promise((r) => setTimeout(r, 50));
    ws.send(JSON.stringify({ t: "play", make: "herd" }));
    assert.deepEqual([(await next("play")).play.kind], ["herd"]);
    ws.send(JSON.stringify({ t: "play", go: true }));
    const begun = (await next("play", (m) => m.play?.state === "go")).play;
    assert.deepEqual([begun.goal, begun.penned], [5, []]);
    await new Promise((r) => setTimeout(r, 100));
    // Out in the field, a sheep is told to follow; nothing is in the pen until she walks back into it.
    go(at(60, 0));
    ws.send(JSON.stringify({ t: "talk", thing: 77, sp: "sheep", text: "Follow me!" }));
    const following = await next("order", (m) => m.thing === 77);
    assert.deepEqual([following.act, following.by], ["follow", me]);
    go(at(30, 0));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(inbox.some((m) => m.t === "play" && m.play?.penned.length), false);
    go(at(2, 1));
    const told = (await next("play", (m) => m.play?.penned.length === 1)).play;
    assert.deepEqual([told.penned, told.players[0].itMs, told.state], [[77], 1, "go"]);
    // The sheep stops following and stands in the pen, within its fence.
    const stays = await next("order", (m) => m.thing === 77 && m.act === "stay");
    const fromMiddle = Math.hypot((stays.lat - 52.01) * 111_320, (stays.lon - 4.71) * 111_320 * Math.cos((52.01 * Math.PI) / 180));
    assert.ok(fromMiddle < FIELD_M.herd, `${fromMiddle.toFixed(1)} m from the middle of the pen`);

    // Ending the game lets the animals go home.
    ws.send(JSON.stringify({ t: "play", stop: true }));
    assert.equal((await next("play", (m) => m.play === null)).play, null);
    assert.deepEqual([(await next("order", (m) => m.thing === 77 && m.act === "home")).sp], ["sheep"]);
    ws.close();
  } finally {
    rooms.close();
    server.close();
    await journals.close();
  }
});
