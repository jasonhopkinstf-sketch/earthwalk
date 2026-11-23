import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { createApp } from "../src/app.ts";
import { continentOf, FileJournalStore, Journals, levelOf, type JournalView, type StampNews } from "../src/journal.ts";
import { AccountDirectory, GuestDirectory } from "../src/people.ts";
import { Rooms } from "../src/rooms.ts";

type Msg = Record<string, any>;

test("continents, roughly", () => {
  const places: [string, number, number, string][] = [
    ["London", 51.5, -0.1, "Europe"], ["Reykjavik", 64.1, -21.9, "Europe"], ["Seville", 37.4, -6, "Europe"], ["Palermo", 38.1, 13.4, "Europe"],
    ["Athens", 38, 23.7, "Europe"], ["Istanbul", 41, 28.98, "Europe"], ["Moscow", 55.8, 37.6, "Europe"],
    ["Tunis", 36.8, 10.2, "Africa"], ["Algiers", 36.75, 3.06, "Africa"], ["Cairo", 30.04, 31.24, "Africa"], ["Nairobi", -1.3, 36.8, "Africa"], ["Cape Town", -33.9, 18.4, "Africa"],
    ["Jerusalem", 31.8, 35.2, "Asia"], ["Jeddah", 21.5, 39.2, "Asia"], ["Dubai", 25.2, 55.3, "Asia"], ["Ankara", 39.9, 32.9, "Asia"], ["Delhi", 28.6, 77.2, "Asia"],
    ["Tokyo", 35.7, 139.7, "Asia"], ["Jakarta", -6.2, 106.8, "Asia"],
    ["Sydney", -33.9, 151.2, "Oceania"], ["Auckland", -36.85, 174.76, "Oceania"], ["Honolulu", 21.3, -157.9, "Oceania"],
    ["New York", 40.7, -74, "North America"], ["Mexico City", 19.4, -99.1, "North America"], ["Panama City", 8.98, -79.5, "North America"],
    ["Bogota", 4.7, -74.1, "South America"], ["Rio de Janeiro", -22.9, -43.2, "South America"], ["Buenos Aires", -34.6, -58.4, "South America"],
    ["the South Pole", -89, 0, "Antarctica"],
  ];
  for (const [name, lat, lon, want] of places) assert.equal(continentOf(lat, lon), want, name);
});

/** A journal keeper with a clock the test moves and a map with two countries: France west of 5 degrees east, Italy beyond. */
function keeper(store: FileJournalStore | null = null) {
  const clock = { now: Date.UTC(2026, 10, 21, 9) };
  const news = new Map<string, StampNews[]>();
  const journals = new Journals({
    store, now: () => clock.now,
    placeDetail: async (lat, lon) => ({ name: `Square ${lat.toFixed(2)} ${lon.toFixed(2)}`, country: lon < 5 ? "France" : "Italy" }),
  });
  journals.listen((key, n) => news.set(key, [...(news.get(key) ?? []), n]));
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5)); // place names arrive a moment later
  return { journals, clock, news, settle };
}

test("a journal adds up where someone went, what they rode and whom they talked to", async () => {
  const { journals, clock, news, settle } = keeper();
  await journals.joined("a", null, "family");
  // A walk north through Paris: 60 steps of about 22 m, a second apart.
  for (let i = 0; i <= 60; i++) { clock.now += 1000; journals.moved("a", 48.85 + i * 0.0002, 2.35); }
  await settle();
  let v = journals.view("a") as JournalView;
  assert.ok(Math.abs(v.totals.km - 1.3) < 0.15, `about 1.3 km on foot, not ${v.totals.km}`);
  assert.equal(v.totals.kmRidden, 0);
  assert.deepEqual(v.countries.map((c) => c.name), ["France"]);
  assert.deepEqual(v.continents, ["Europe"]);
  assert.ok(v.totals.places >= 1 && v.places[0].name.startsWith("Square 48."));
  assert.equal(v.kept, false, "a guest's journal is for the visit only");

  // A journey by /goto adds no distance, but the new country counts.
  clock.now += 10_000;
  journals.moved("a", 43.77, 11.25);
  await settle();
  v = journals.view("a") as JournalView;
  assert.ok(v.totals.km < 1.5, "a jump is not a walk");
  assert.deepEqual(v.countries.map((c) => c.name), ["France", "Italy"]);

  // A ride: what is moved while on a horse is ridden, not walked.
  journals.rode("a", "horse", 77);
  for (let i = 1; i <= 60; i++) { clock.now += 1000; journals.moved("a", 43.77 + i * 0.0002, 11.25); }
  journals.rode("a", null);
  journals.moved("a", 43.77 + 61 * 0.0002, 11.25);
  await settle();
  v = journals.view("a") as JournalView;
  assert.ok(v.totals.kmRidden > 1.1 && v.totals.kmRidden < 1.5 && v.totals.km < 1.5);
  assert.deepEqual(v.riddenKinds, ["horse"]);

  // Friends: the same cow twice is one friend, a tree is another.
  journals.talked("a", 42, "cow", "Daisy", "", "Moo. I am Daisy.");
  journals.talked("a", 42, "cow", "Daisy", "what do you eat?", "Grass, mostly.");
  journals.talked("a", 9, "tree", "Old Oak", "", "Rustle.");
  v = journals.view("a") as JournalView;
  assert.equal(v.totals.friends, 2);
  assert.deepEqual(v.friends.map((f) => [f.name, f.sp, f.times]).sort(), [["Daisy", "cow", 2], ["Old Oak", "tree", 1]]);
  assert.deepEqual(v.talkedKinds.sort(), ["cow", "tree"]);

  // Stamps: told once each, as they are earned, and shown in the passport.
  const told = news.get("a")!.map((n) => `${n.kind}:${n.title}`);
  for (const want of ["stamp:Countries: 1", "country:France", "country:Italy", "stamp:On foot: 1", "stamp:Riding: 1", "stamp:Things ridden: 1", "stamp:Friends made: 1", "stamp:Tree talker"]) {
    assert.equal(told.filter((t) => t === want).length, 1, `told once: ${want} (heard ${told.join(", ")})`);
  }
  assert.ok(told.some((t) => t.startsWith("level:Level 2")), "and a level reached");
  const stamp = (id: string) => v.stamps.find((s) => s.id === id)!;
  assert.deepEqual([stamp("countries").have, stamp("countries").done, stamp("countries").next], [2, 1, 3]);
  assert.deepEqual([stamp("tree").done, stamp("train").done, stamp("halves").done], [1, 0, 0]);
  assert.ok(v.level.n >= 2 && v.level.points >= v.level.from && v.level.points < v.level.next);
  assert.deepEqual([levelOf(0).n, levelOf(9).n, levelOf(10).n, levelOf(39).n, levelOf(40).n], [1, 1, 2, 2, 3]);

  journals.left("a");
  assert.equal(journals.view("a"), null);
  await journals.close();
});

test("a signed-in person's journal is kept on disk, with a log of everything; a guest's is not", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-journal-"));
  try {
    const first = keeper(new FileJournalStore(dir));
    await first.journals.joined("m1", "abc123", "family");
    await first.journals.joined("g1", null, "family");
    for (let i = 0; i <= 50; i++) { first.clock.now += 1000; first.journals.moved("m1", 48.85 + i * 0.0002, 2.35); first.journals.moved("g1", 48.85 + i * 0.0002, 2.36); }
    await first.settle();
    first.journals.talked("m1", 42, "cow", "Daisy", "what do you eat?", "Grass, mostly.");
    first.journals.talked("g1", 42, "cow", "Daisy", "hello", "Moo.");
    first.clock.now += 5 * 60_000;
    first.journals.left("m1");
    first.journals.left("g1");
    await first.journals.close();

    assert.deepEqual((await readdir(dir)).sort(), ["abc123.json", "abc123.log"], "one summary and one log, and nothing for the guest");
    const log = (await readFile(path.join(dir, "abc123.log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Msg);
    assert.deepEqual([...new Set(log.map((l) => l.k))].filter((k) => k !== "task" && k !== "day").sort(), ["at", "go", "join", "leave", "level", "place", "riddle", "stamp", "talk"]);
    const talk = log.find((l) => l.k === "talk")!;
    assert.deepEqual([talk.sp, talk.thing, talk.name, talk.said, talk.reply], ["cow", 42, "Daisy", "what do you eat?", "Grass, mostly."]);
    assert.ok(log.filter((l) => l.k === "at").length >= 8, "a point of the trail about every hundred metres");

    // Another day, another start of the server: the journal carries on from where it was.
    const second = keeper(new FileJournalStore(dir));
    const offline = await second.journals.viewPerson("abc123");
    assert.equal(offline.kept, true);
    assert.deepEqual([offline.totals.visits, offline.totals.friends, offline.countries[0].name], [1, 1, "France"]);
    assert.ok(offline.totals.minutes >= 5 && offline.totals.km > 0.9);
    await second.journals.joined("m2", "abc123", "family");
    const back = second.journals.view("m2") as JournalView;
    assert.equal(back.totals.visits, 2);
    assert.ok(!(second.news.get("m2") ?? []).some((n) => n.title === "Countries: 1"), "stamps already earned are not announced again");
    assert.equal((await second.journals.viewPerson("nobody")).totals.visits, 0, "someone with no journal yet has an empty one");
    await second.journals.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("in a room: each player can read their own journal and hears only their own stamps", async () => {
  const { journals } = keeper();
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
    const next = async (t: string): Promise<Msg> => {
      for (let i = 0; i < 300; i++) {
        const at = inbox.findIndex((m) => m.t === t);
        if (at >= 0) return inbox.splice(at, 1)[0];
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for "${t}"`);
    };
    await next("welcome");
    return { ws, inbox, next };
  };
  try {
    const mum = await join("Mum");
    const kid = await join("Kid");
    await new Promise((r) => setTimeout(r, 50));
    mum.ws.send(JSON.stringify({ t: "pos", lat: 48.85, lon: 2.35, alt: 0, yaw: 0 }));
    let stamp = await mum.next("stamp");
    while (stamp.kind === "task") stamp = await mum.next("stamp"); // today's tasks are told first
    assert.ok(["Countries: 1", "France"].includes(stamp.title));
    mum.ws.send(JSON.stringify({ t: "ride", thing: 7, sp: "horse" }));
    mum.ws.send(JSON.stringify({ t: "talk", thing: 42, sp: "cow" }));
    await mum.next("say");
    mum.ws.send(JSON.stringify({ t: "journal" }));
    const mine = (await mum.next("journal")).journal as JournalView;
    assert.deepEqual([mine.totals.countries, mine.totals.friends, mine.riddenKinds, mine.kept], [1, 1, ["horse"], false]);

    kid.ws.send(JSON.stringify({ t: "journal" }));
    const theirs = (await kid.next("journal")).journal as JournalView;
    assert.deepEqual([theirs.totals.countries, theirs.totals.friends, theirs.riddenKinds], [0, 0, []], "the other player's journal has none of it");
    assert.equal(kid.inbox.filter((m) => m.t === "stamp" && m.kind !== "task").length, 0, "and they were told about none of the stamps");
    mum.ws.close();
    kid.ws.close();
  } finally {
    rooms.close();
    server.close();
    await journals.close();
  }
});

test("GET /v1/journal gives a signed-in person their own journal, and nobody anyone else's", async () => {
  const accounts = new AccountDirectory();
  const ann = accounts.signIn({ sub: "g-1", email: "ann@example.com", name: "Ann" })!;
  const ben = accounts.signIn({ sub: "g-2", email: "ben@example.com", name: "Ben" })!;
  const app = createApp({ accounts, placeDetail: async () => ({ name: "Montmartre, Paris", country: "France" }) });
  await new Promise<void>((r) => app.server.listen(0, r));
  const base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/v1/journal`)).status, 401, "not without signing in");
    await app.journals.joined("m1", ann.person.id, "family");
    app.journals.moved("m1", 48.8867, 2.3431);
    app.journals.talked("m1", 42, "cow", "Daisy", "", "Moo.");
    await new Promise((r) => setTimeout(r, 20));
    const get = async (token: string): Promise<JournalView> => (await fetch(`${base}/v1/journal?person=${ann.person.id}`, { headers: { Authorization: `Bearer ${token}` } })).json() as Promise<JournalView>;
    const hers = await get(ann.token);
    assert.deepEqual([hers.totals.friends, hers.countries.map((c) => c.name)], [1, ["France"]]);
    const his = await get(ben.token);
    assert.deepEqual([his.totals.friends, his.countries], [0, []], "asking for Ann's by name still gets Ben his own");
  } finally {
    app.close();
  }
});

test("riddles unlock with the levels, are solved out in the world, and each one solved wins a companion", async () => {
  const { journals, news, settle } = keeper();
  await journals.joined("a", null, "family");
  journals.moved("a", 48.85, 2.35);
  await settle();
  let v = journals.view("a") as JournalView;
  assert.equal(v.level.n, 2, "arriving somewhere is enough for the second level");
  assert.deepEqual(v.riddles.map((r) => r.id), ["cow", "tree", "house", "car", "snail", "frog", "bee", "butterfly", "mouse", "hedgehog"], "ten to begin with");
  assert.ok(v.riddles.every((r) => !r.solved && r.answer === null), "none answered");
  assert.deepEqual([v.moreRiddles, v.pets, v.pet], [{ count: 6, level: 3 }, [], null]);
  for (const r of v.riddles) assert.ok(r.text.length > 40 && !new RegExp(`\b${r.id}\b`, "i").test(r.text), `the ${r.id} riddle does not give its answer away`);
  assert.equal(journals.setPet("a", "cow"), false, "no companion before its riddle is solved");

  // Talking to a crab now does nothing for the crab riddle, which is not unlocked yet.
  journals.talked("a", 5, "crab", "Pincer", "", "Hello.");
  // Talking to a cow answers the first riddle.
  journals.talked("a", 42, "cow", "Daisy", "", "Moo.");
  v = journals.view("a") as JournalView;
  assert.deepEqual(v.riddles.find((r) => r.id === "cow"), { id: "cow", text: v.riddles[0].text, solved: true, answer: "a cow" });
  assert.deepEqual(v.pets, ["cow"]);
  const told = news.get("a")!.filter((n) => n.kind === "riddle");
  assert.ok(told.some((n) => n.title === "Riddle solved!" && /It was a cow: 15 coins. Now a cow will keep you company/.test(n.text)), `told so (heard ${told.map((n) => n.title + ": " + n.text).join(" | ")})`);
  assert.deepEqual([journals.setPet("a", "cow"), journals.petOf("a"), journals.setPet("a", "elephant"), journals.petOf("a")], [true, "cow", false, "cow"]);

  // More friends, a higher level, more riddles; and the crab must be met again now that its riddle is out.
  for (const [i, sp] of ["snail", "frog", "bee", "mouse", "tree", "house", "car"].entries()) {
    if ((journals.view("a") as JournalView).level.n >= 3) break;
    journals.talked("a", 100 + i, sp, "Somebody", "", "Hello.");
  }
  v = journals.view("a") as JournalView;
  assert.ok(v.level.n >= 3 && v.riddles.some((r) => r.id === "crab" && !r.solved), "the crab riddle is out, and not solved by the earlier chat");
  assert.ok(news.get("a")!.some((n) => n.kind === "riddle" && /new riddles/.test(n.title)), "and the player is told there are new ones");
  journals.talked("a", 5, "crab", "Pincer", "", "Hello again.");
  journals.rode("a", "train", 9);
  v = journals.view("a") as JournalView;
  assert.ok(v.riddles.find((r) => r.id === "crab")!.solved && v.pets.includes("crab"));
  assert.ok(v.riddles.find((r) => r.id === "train")!.solved && !v.pets.includes("bird"), "riding the train answers its riddle");
  assert.equal(v.stamps.find((s) => s.id === "riddles")!.have, v.riddles.filter((r) => r.solved).length);
  assert.equal(journals.setPet("a", null), true);
  assert.equal(journals.petOf("a"), null);
  journals.left("a");
  await journals.close();
});

test("in a room: a companion comes when chosen, friends are told, and it is there again next visit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-pets-"));
  const accounts = new AccountDirectory();
  const ann = accounts.signIn({ sub: "g-1", email: "ann@example.com", name: "Ann" })!;
  const { journals } = keeper(new FileJournalStore(dir));
  const rooms = new Rooms(accounts, { journal: journals });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => rooms.wss.handleUpgrade(req, socket, head, (ws) => rooms.wss.emit("connection", ws, req)));
  await new Promise<void>((r) => server.listen(0, r));
  const url = `ws://localhost:${(server.address() as AddressInfo).port}/v1/ws`;
  const join = async (name: string, token?: string) => {
    const ws = new WebSocket(url);
    const inbox: Msg[] = [];
    ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ t: "hello", name, room: "family", avatar: "fox", ...(token ? { token } : {}) }));
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
  try {
    const mum = await join("Ann", ann.token);
    const kid = await join("Kid");
    await new Promise((r) => setTimeout(r, 50));
    mum.ws.send(JSON.stringify({ t: "pet", sp: "cow" }));
    assert.equal((await mum.next("error")).code, "locked", "not before the riddle is solved");
    mum.ws.send(JSON.stringify({ t: "talk", thing: 42, sp: "cow" }));
    await mum.next("say");
    assert.equal((await mum.next("stamp")).kind !== undefined, true);
    mum.ws.send(JSON.stringify({ t: "pet", sp: "cow" }));
    const seen = await kid.next("pet");
    assert.deepEqual([seen.id, seen.sp, typeof seen.thing], [mum.id, "cow", "number"]);
    assert.equal((await mum.next("pet")).thing, seen.thing);
    const late = await join("Grandad");
    assert.deepEqual(late.welcome.peers.find((p: Msg) => p.id === mum.id).pet, { sp: "cow", thing: seen.thing }, "a newcomer sees it too");

    // She leaves and comes back another time: the same cow comes along without being asked.
    mum.ws.close();
    await new Promise((r) => setTimeout(r, 100));
    const again = await join("Ann", ann.token);
    let back: Msg;
    do back = await kid.next("pet"); while (back.id !== again.id);
    assert.deepEqual([back.sp, back.thing], ["cow", seen.thing], "the very same cow");
    again.ws.send(JSON.stringify({ t: "pet" }));
    do back = await kid.next("pet"); while (back.id !== again.id);
    assert.equal(back.sp, undefined, "and it goes home when told");
    for (const c of [again, kid, late]) c.ws.close();
    await new Promise((r) => setTimeout(r, 150)); // let their journals be written before the folder goes
  } finally {
    rooms.close();
    server.close();
    await journals.close();
    await rm(dir, { recursive: true, force: true });
  }
});
