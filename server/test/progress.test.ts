import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { dayNumber, emptyDaily } from "../src/daily.ts";
import { GROUPS } from "../src/food.ts";
import { emptyJournal, type JournalDoc, Journals, type JournalView, levelOf, pointsOf, RIDDLES, standingOf, type StampNews } from "../src/journal.ts";
import { GuestDirectory } from "../src/people.ts";
import { countsOf, hintOf, levelCoins, levelPrizes, PARTS, type ProgressNews, whyOf } from "../src/progress.ts";
import { Rooms } from "../src/rooms.ts";
import { hungerOf } from "../public/js/care.js";

type Msg = Record<string, any>;
const NOW = Date.UTC(2026, 10, 24, 9);
/** The coins today's tasks have paid: which tasks there are depends on the day. */
const taskCoins = (v: JournalView): number => v.today.tasks.filter((t) => t.done).length * v.today.coinsEach + (v.today.all ? v.today.coinsAll : 0);

/** A journal keeper with a clock, and everything it tells player "a": stamps and progress. */
function keeper(startCoins = 0) {
  const clock = { now: NOW };
  const journals = new Journals({ now: () => clock.now, startCoins, placeDetail: async (lat, lon) => ({ name: `Square ${lat.toFixed(2)}`, country: lon < 5 ? "France" : "Italy" }) });
  const stamps: StampNews[] = [];
  const progress: ProgressNews[] = [];
  journals.listen((_key, n) => stamps.push(n));
  journals.listenProgress((_key, n) => progress.push(n));
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5)); // place names arrive a moment later
  return { journals, clock, stamps, progress, settle };
}

test("points: exploring counts as it always has, and eating well and looking after animals count too", () => {
  const d: JournalDoc = {
    ...emptyJournal(null, NOW), countries: { France: { first: 1, last: 1 }, Italy: { first: 2, last: 2 } }, continents: { Europe: 1 }, placeCount: 7,
    metresOnFoot: 3400, metresRidden: 5100, friendCount: 4, talked: { cow: 3, tree: 1 }, ridden: { horse: { times: 1, metres: 5100 } },
    earned: { "countries:1": 1, "friends:1": 1 }, solved: { cow: 1 }, days: 2, favoursDone: 3, huntsDone: 1, expeditionsDone: { alps: 1 },
    races: 2, racesWon: 1, games: 3, gamesWon: 1,
  };
  // What the passport's level counted before there was a bar.
  const exploring = 2 * 10 + 15 + 7 * 2 + 3 + 2 + 4 + 2 * 3 + 3 + 2 * 2 + 6 + 2 * 5 + 3 * 4 + 6 + 8 + 2 * 3 + 4 + 3 * 3 + 3;
  assert.equal(pointsOf(d), exploring);
  // And what eating well and caring add.
  Object.assign(d, { heartsFilled: 9, healthyDays: 1, caredFor: 2, cooked: { pancakes: 2, soup: 1 }, tricks: { dog: ["sit", "spin"] }, agilityRuns: 3 });
  assert.equal(pointsOf(d), exploring + 9 + 5 + 2 * 3 + 3 * 2 + 2 * 3 + 3 * 2);
  assert.equal(new Set(PARTS.map((p) => p.id)).size, PARTS.length, "each thing that earns points is counted once");
  assert.deepEqual([levelOf(0).n, levelOf(9).n, levelOf(10).n, levelOf(39).n, levelOf(40).n, levelOf(90).n], [1, 1, 2, 2, 3, 4]);
  assert.deepEqual([levelCoins(2), levelCoins(5), levelPrizes(1, 1), levelPrizes(1, 3), levelPrizes(2, 4)], [20, 50, 0, 50, 70], "a new level pays ten coins a level");
});

test("what earned the points is said in a few words, the most telling thing first", () => {
  const d = emptyJournal(null, NOW);
  const before = countsOf(d);
  assert.equal(whyOf(d, before, countsOf(d), NOW), null, "nothing has risen");
  // A new friend of a new kind: the kind is what is named, not the friend or the stamp that came with it.
  d.friends["cow:42"] = { name: "Daisy", sp: "cow", first: NOW, last: NOW, times: 1 };
  d.friendCount = 1;
  d.earned["friends:1"] = NOW;
  const friend = countsOf(d);
  assert.equal(whyOf(d, before, friend, NOW), "made friends with Daisy");
  d.talked.cow = 1;
  assert.equal(whyOf(d, before, countsOf(d), NOW), "met your first cow");
  // Feeding a hungry animal beats both.
  d.caredFor = 1;
  d.daily = { ...emptyDaily(dayNumber(NOW, 0)), cared: ["elephant:7"] };
  assert.equal(whyOf(d, before, countsOf(d), NOW), "fed a hungry elephant");
  // One thing at a time.
  const say = (edit: (doc: JournalDoc) => void): string | null => { const doc = emptyJournal(null, NOW); const was = countsOf(doc); edit(doc); return whyOf(doc, was, countsOf(doc), NOW); };
  assert.equal(say((x) => { x.countries.France = { first: NOW, last: NOW }; x.placeCount = 1; }), "a new country: France");
  assert.equal(say((x) => { x.places["48.86,2.34"] = { name: "Montmartre", country: "France", lat: 48.86, lon: 2.34, first: NOW, last: NOW, times: 1 }; x.placeCount = 1; }), "a new place: Montmartre");
  assert.equal(say((x) => { x.heartsFilled = 2; }), "filled two hearts");
  assert.equal(say((x) => { x.heartsFilled = 1; x.healthyDays = 1; }), "filled all five hearts");
  assert.equal(say((x) => { x.metresOnFoot = 1000; }), "walked a kilometre");
  assert.equal(say((x) => { x.ridden.train = { times: 1, metres: 0 }; }), "first ride on a train");
  assert.equal(say((x) => { x.earned["places:5"] = NOW; }), "a new stamp");
  assert.equal(say((x) => { x.cooked = { pancakes: 1 }; }), "cooked a meal");
  assert.equal(say((x) => { x.tricks = { dog: ["sit"] }; }), "taught a trick");
});

test("the hint names the least trouble that reaches the next level, and what it names is always enough", () => {
  const d = emptyJournal(null, NOW);
  const at = (points: number) => levelOf(points);
  assert.equal(hintOf(d, at(9), NOW, 4), "One new friend to level 2");
  assert.equal(hintOf(d, at(8), NOW, 4), "One new place to level 2");
  assert.equal(hintOf(d, at(7), NOW, 4), "Three new friends to level 2");
  assert.equal(hintOf(d, at(6), NOW, 4), "Two new places to level 2");
  assert.equal(hintOf(d, at(4), NOW, 4), "Solve one riddle for level 2");
  assert.equal(hintOf(d, at(4), NOW, 0), "Three new places to level 2", "no riddle is named when none waits to be solved");
  assert.equal(hintOf(d, at(0), NOW, 0), "One new country to level 2");
  assert.equal(hintOf(d, at(60), NOW, 0), "Three new countries to level 4");
  assert.equal(hintOf(d, at(120), NOW, 9), "Four new countries to level 5");
  // Hearts already part filled today are the nearest thing of all.
  const day = dayNumber(NOW, 0);
  d.daily = { ...emptyDaily(day), ate: ["fruit", "veg", "grain"] };
  assert.equal(hintOf(d, at(33), NOW, 0), "Fill your last two hearts for level 3");
  d.daily = { ...emptyDaily(day), ate: ["fruit", "veg", "grain", "protein"] };
  assert.equal(hintOf(d, at(84), NOW, 0), "Fill your last heart for level 4");
  d.daily = { ...emptyDaily(day), ate: GROUPS.map((g) => g.id), fed: true };
  assert.equal(hintOf(d, at(84), NOW, 0), "Three new places to level 4", "full hearts have no more to give today");
  d.daily = { ...emptyDaily(day - 1), ate: ["fruit", "veg", "grain", "protein"] };
  assert.equal(hintOf(d, at(84), NOW, 0), "Three new places to level 4", "yesterday's hearts are empty again today: there is no last heart to fill");
  // Whatever is named is worth at least what is wanted.
  for (let points = 0; points < 400; points++) {
    const level = at(points);
    const need = level.next - points;
    const m = /^(\w+) new (friend|place|countr)/.exec(hintOf(emptyJournal(null, NOW), level, NOW, 0))!;
    const n = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"].indexOf(m[1].toLowerCase());
    const count = n >= 0 ? n : Number(m[1]);
    assert.ok(count * (m[2] === "friend" ? 1 : m[2] === "place" ? 2 : 10) >= need, `${points} points: ${m[0]}`);
  }
});

test("the journal says so the moment points are earned: how many, for what, and the next step", async () => {
  const { journals, progress, stamps } = keeper();
  await journals.joined("a", null, "family");
  // Coming in: where they stand, and nothing earned.
  assert.deepEqual(progress.splice(0), [{ level: { n: 1, title: "Newcomer", points: 0, from: 0, next: 10, hint: "One new country to level 2" }, gained: 0, why: null }]);
  assert.deepEqual((journals.view("a") as JournalView).level, { n: 1, title: "Newcomer", points: 0, from: 0, next: 10, hint: "One new country to level 2" }, "the journal carries the same");

  // A first hello to a hedgehog: a friend (1), a new kind (3) and the stamp for a first friend (2).
  journals.talked("a", 42, "hedgehog", "Bristle", "", "Snuffle.");
  let told = progress.splice(0);
  assert.deepEqual(told, [{ level: { n: 1, title: "Newcomer", points: 6, from: 0, next: 10, hint: "Two new places to level 2" }, gained: 6, why: "met your first hedgehog" }]);
  // The same hedgehog again earns nothing, and nothing is said.
  journals.talked("a", 42, "hedgehog", "Bristle", "", "Snuffle.");
  assert.deepEqual(progress.splice(0), []);

  // A cow answers a riddle of level 1: the hello, then the riddle, which reaches level 2.
  stamps.length = 0;
  journals.talked("a", 43, "cow", "Daisy", "", "Moo.");
  told = progress.splice(0);
  assert.deepEqual(told.map((p) => [p.gained, p.why, p.level.n]), [[4, "met your first cow", 2], [8, "solved a riddle", 2]]);
  const fresh = RIDDLES.filter((r) => r.level === 2).length;
  assert.deepEqual(told[0].up, { n: 2, title: "Rambler", coins: 20, riddles: fresh }, "the new level, the coins it paid and the riddles it opened");
  assert.equal(told[1].up, undefined, "and it is told once");
  const level = stamps.find((n) => n.kind === "level")!;
  assert.deepEqual([level.title, level.text], ["Level 2: Rambler", "You are now a Rambler: 20 coins"], "games with no bar are told of the coins too");
  const v = journals.view("a") as JournalView;
  assert.equal(v.coins - taskCoins(v), 15 + 20, "the riddle and the level");
  assert.equal(told[1].level.points, pointsOf({ ...emptyJournal(null, NOW), friendCount: 2, talked: { hedgehog: 1, cow: 1 }, earned: { a: 1, b: 1 }, solved: { cow: 1 } }));
  await journals.close();
});

test("eating well moves the bar: a heart at a time, and more for all five", async () => {
  const { journals, progress } = keeper(500);
  await journals.joined("a", null, "family");
  progress.length = 0;
  const shop = journals.menuOf("a", "shop").items;
  const plain = GROUPS.map((g) => shop.find((f) => f.groups.length === 1 && f.groups[0] === g.id)!);
  assert.ok(plain.every(Boolean), "the shop has something plain of every kind");
  for (const food of plain) assert.equal(journals.buyFood("a", "shop", food.id), "ok");
  assert.equal(progress.length, 0, "buying earns nothing");
  for (const food of plain.slice(0, 4)) assert.equal(journals.eat("a", food.id), "ok");
  assert.deepEqual(progress.splice(0).map((p) => [p.gained, p.why]), [[1, "filled a heart"], [1, "filled a heart"], [1, "filled a heart"], [1, "filled a heart"]]);
  assert.equal((journals.view("a") as JournalView).level.hint, "Fill your last heart for level 2", "four points so far, and the last heart is worth six");
  assert.equal(journals.eat("a", plain[4].id), "ok");
  const full = progress.splice(0);
  // The last heart (1), the healthy day (5) and its stamp (2): level 2, with its prize.
  assert.deepEqual(full.map((p) => [p.gained, p.why, p.level.n, p.up?.coins]), [[8, "filled all five hearts", 2, 20]]);
  // A second helping fills nothing, and earns nothing.
  assert.equal(journals.buyFood("a", "shop", plain[0].id), "ok");
  assert.equal(journals.eat("a", plain[0].id), "ok");
  assert.equal(progress.length, 0);
  await journals.close();
});

test("feeding a hungry animal says which", async () => {
  const { journals, progress, clock } = keeper(500);
  await journals.joined("a", null, "family");
  const day = dayNumber(clock.now, 0);
  let thing = 100;
  while (!hungerOf("horse", thing, day)) thing++;
  assert.equal(journals.buyFood("a", "shop", hungerOf("horse", thing, day)!), "ok");
  progress.length = 0;
  journals.talked("a", thing, "horse", "Bramble", "", "Neigh.");
  // Fed (3) and its stamp (2), a friend (1) and its stamp (2), a new kind (3).
  assert.deepEqual(progress.map((p) => [p.gained, p.why]), [[11, "fed a hungry horse"]]);
  await journals.close();
});

test("a level's prize is paid once, and never for levels reached before there were prizes", async () => {
  const kept: JournalDoc = { ...emptyJournal("abc", NOW), placeCount: 42, earned: { "places:5": 1, "places:25": 1 }, coins: 7 }; // 88 points: level 3, two short of level 4
  const store = { load: async () => structuredClone(kept), save: async () => {}, append: async () => {} };
  const clock = { now: NOW };
  const journals = new Journals({ store, now: () => clock.now });
  const progress: ProgressNews[] = [];
  journals.listenProgress((_key, n) => progress.push(n));
  await journals.joined("a", "abc", "family");
  assert.deepEqual([progress[0].level.n, progress[0].gained, (journals.view("a") as JournalView).coins], [3, 0, 7], "nothing is paid for the levels they came with");
  assert.equal(standingOf(kept, NOW).hint, "One new place to level 4");
  progress.length = 0;
  journals.talked("a", 1, "tree", "Old Barkley", "", "Creak.");
  const up = progress.find((p) => p.up)!.up!;
  assert.deepEqual([up.n, up.coins], [4, 40], "only the new one");
  const v = journals.view("a") as JournalView;
  assert.equal(v.coins - taskCoins(v), 7 + 40 + 15, "the level, and the riddle the tree answered");
  await journals.close();
});

test("in a room: the bar's news goes to the player who earned it, and to nobody else", async () => {
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
    const next = async (t: string, ok: (m: Msg) => boolean = () => true): Promise<Msg> => {
      for (let i = 0; i < 300; i++) {
        const at = inbox.findIndex((m) => m.t === t && ok(m));
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
    // Each is told where they stand as they come in.
    const standing = await mum.next("progress");
    assert.deepEqual(standing, { t: "progress", level: { n: 1, title: "Newcomer", points: 0, from: 0, next: 10, hint: "One new country to level 2" }, gained: 0, why: null });
    assert.equal((await kid.next("progress")).gained, 0);
    mum.ws.send(JSON.stringify({ t: "talk", thing: 42, sp: "hedgehog" }));
    const earned = await mum.next("progress");
    assert.deepEqual([earned.gained, earned.why, earned.level.points], [6, "met your first hedgehog", 6]);
    await new Promise((r) => setTimeout(r, 1300)); // things are not talked to faster than this
    mum.ws.send(JSON.stringify({ t: "talk", thing: 43, sp: "cow" }));
    const up = await mum.next("progress", (m) => !!m.up);
    assert.deepEqual([up.up.n, up.up.title, up.up.coins], [2, "Rambler", 20]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(kid.inbox.filter((m) => m.t === "progress").length, 0, "the other player hears none of it");
    mum.ws.close();
    kid.ws.close();
  } finally {
    rooms.close();
    server.close();
    await journals.close();
  }
});
