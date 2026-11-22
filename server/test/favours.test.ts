import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { askLine, asksUnprompted, type Favour, favourNotes, favourOf, favourWords, offersHelp } from "../src/favours.ts";
import { Journals, type JournalView, type StampNews } from "../src/journal.ts";
import { GuestDirectory } from "../src/people.ts";
import { Rooms } from "../src/rooms.ts";
import { aKind, Talker } from "../src/talk.ts";
import { dayNumber } from "../src/daily.ts";

type Msg = Record<string, any>;

function keeper() {
  const clock = { now: Date.UTC(2026, 10, 22, 9) };
  const news = new Map<string, StampNews[]>();
  const journals = new Journals({ now: () => clock.now, placeDetail: async () => ({ name: "Somewhere", country: "France" }) });
  journals.listen((key, n) => news.set(key, [...(news.get(key) ?? []), n]));
  return { journals, clock, news, day: dayNumber(clock.now) };
}
const HERE = { lat: 48.85, lon: 2.35 };
/** A thing of a kind whose favour today is of the kind wanted, found by trying identities in turn. */
function giver(sp: string, kind: Favour["kind"], day: number, from = 1): { thing: number; f: Favour } {
  for (let thing = from; thing < from + 500; thing++) {
    const f = favourOf(thing, sp, "Pat", aKind(sp), day, 0, HERE, aKind);
    if (f?.kind === kind) return { thing, f };
  }
  throw new Error(`no ${sp} asks a ${kind} favour`);
}
const walk = (k: ReturnType<typeof keeper>, key: string, fromLat: number, metres: number): number => {
  const steps = Math.ceil(metres / 20);
  for (let i = 1; i <= steps; i++) { k.clock.now += 1000; k.journals.moved(key, fromLat + (i * 20) / 111_320, HERE.lon); }
  return fromLat + (steps * 20) / 111_320;
};

test("every kind of thing asks a favour that suits it, the same one for everyone that day", () => {
  const day = 20500;
  const kinds = (sp: string): Set<string> => {
    const seen = new Set<string>();
    for (let thing = 1; thing < 200; thing++) seen.add(favourOf(thing, sp, "Pat", aKind(sp), day, 0, HERE, aKind)!.kind);
    return seen;
  };
  assert.deepEqual([...kinds("donkey")].sort(), ["ride", "walk"], "a donkey wants a run or a walk");
  assert.deepEqual([...kinds("cow")].sort(), ["greet", "ride", "walk"], "a cow may also send a hello to the herd");
  assert.deepEqual([...kinds("cat")].sort(), ["greet", "walk"]);
  assert.deepEqual([...kinds("car")], ["ride"]);
  assert.deepEqual([...kinds("train")], ["ride"]);
  assert.deepEqual([...kinds("house")].sort(), ["carry", "greet", "look"]);
  assert.deepEqual([...kinds("tree")].sort(), ["carry", "greet", "look"]);
  assert.equal(favourOf(7, "taxi", "Zip", "a taxi", day, 0, HERE, aKind), null, "a taxi is at work already");
  // The same thing asks the same favour all day, of anyone; tomorrow it may ask another.
  assert.deepEqual(favourOf(42, "cow", "Daisy", "a cow", day, 5, HERE, aKind), favourOf(42, "cow", "Daisy", "a cow", day, 5, HERE, aKind));
  const week = new Set<string>();
  for (let d = day; d < day + 14; d++) week.add(favourOf(42, "cow", "Daisy", "a cow", d, 0, HERE, aKind)!.text);
  assert.ok(week.size >= 3, "a fortnight of different favours from one cow");
  // Where the player is unknown, nothing is asked that has to be measured from there.
  for (let thing = 1; thing < 100; thing++) assert.equal(favourOf(thing, "house", "Pat", "a house", day, 0, null, aKind)!.kind, "greet");
  // Each favour says plainly what to do, in the passport and in the thing's own mouth.
  for (const sp of ["horse", "cat", "car", "train", "sailboat", "house", "tree", "bird", "snail"]) {
    for (let thing = 1; thing < 40; thing++) {
      const f = favourOf(thing, sp, "Pat", aKind(sp), day, 0, HERE, aKind)!;
      assert.ok(f.text.includes("Pat") && f.coins >= 15 && !/undefined|null/.test(f.text + askLine(f, aKind)), `${sp} ${thing}: ${f.text}`);
      assert.ok(askLine(f, aKind).startsWith("Would you do me a favour?"));
      if (f.kind !== "greet") assert.ok(f.text.includes(String(f.metres)) && askLine(f, aKind).includes(String(f.metres)), "the distance is said");
    }
  }
  // About one thing in three asks without being asked.
  let unprompted = 0;
  for (let thing = 1; thing <= 600; thing++) if (asksUnprompted(thing, day)) unprompted++;
  assert.ok(unprompted > 150 && unprompted < 250, `about a third (${unprompted} of 600)`);
  for (const said of ["can I help?", "Do you need anything", "any jobs for me", "I want a mission", "is there something we could do for you?"]) assert.ok(offersHelp(said), said);
  for (const said of ["hello", "what do you eat?", "follow me", "take me to the beach"]) assert.ok(!offersHelp(said), said);
});

test("a ride and a walk are done on the move, and the thing says thank you", async () => {
  const k = keeper();
  const { journals, news, day } = k;
  await journals.joined("a", null, "family");
  journals.moved("a", HERE.lat, HERE.lon);

  // A horse that wants a run. Asking it for a job gets the favour; riding another horse does not count.
  const run = giver("horse", "ride", day);
  let talk = journals.beforeTalk("a", run.thing, "horse", "Pat", true);
  assert.deepEqual([talk.offer?.kind, talk.offer?.metres, talk.open], ["ride", run.f.metres, null]);
  assert.ok(news.get("a")!.some((n) => n.kind === "favour" && n.title === "A favour for Pat" && n.text === run.f.text));
  let v = journals.view("a") as JournalView;
  assert.deepEqual(v.favours.map((f) => [f.id, f.have, f.goal, f.unit]), [[`horse:${run.thing}`, 0, run.f.metres, "m"]]);
  talk = journals.beforeTalk("a", run.thing, "horse", "Pat", true);
  assert.deepEqual([talk.offer, talk.open?.id], [null, `horse:${run.thing}`], "asked again, it reminds and does not ask twice");

  journals.rode("a", "horse", run.thing + 1000);
  let lat = walk(k, "a", HERE.lat, run.f.metres + 60);
  journals.rode("a", null);
  assert.equal((journals.view("a") as JournalView).favours[0].have, 0, "a different horse");
  journals.rode("a", "horse", run.thing);
  lat = walk(k, "a", lat, run.f.metres / 2);
  v = journals.view("a") as JournalView;
  assert.ok(v.favours[0].have > 0 && v.favours[0].have < run.f.metres, "half way");
  lat = walk(k, "a", lat, run.f.metres / 2 + 40);
  journals.rode("a", null);
  v = journals.view("a") as JournalView;
  assert.deepEqual([v.favours.length, v.favoursDone, v.coins >= 20], [0, 1, true]);
  const done = news.get("a")!.find((n) => n.title === "Favour done")!;
  assert.deepEqual([done.thing, done.sp, typeof done.say, done.text.endsWith("20 coins")], [run.thing, "horse", "string", true]);
  assert.ok(news.get("a")!.some((n) => n.title === "Favours done: 1"), "and it is stamped in the passport");
  talk = journals.beforeTalk("a", run.thing, "horse", "Pat", true);
  assert.deepEqual([talk.offer, talk.later], [null, true], "one favour a day from each thing");

  // A cat that wants a walk: only steps on foot with the cat following count.
  const stroll = giver("cat", "walk", day);
  assert.equal(journals.beforeTalk("a", stroll.thing, "cat", "Pat", true).offer?.kind, "walk");
  lat = walk(k, "a", lat, 100);
  assert.equal((journals.view("a") as JournalView).favours[0].have, 0, "not following yet");
  journals.following("a", stroll.thing, true);
  lat = walk(k, "a", lat, 100);
  journals.following("a", stroll.thing, false);
  lat = walk(k, "a", lat, 400);
  const part = (journals.view("a") as JournalView).favours[0].have;
  assert.ok(part >= 80 && part <= 120, `about 100 m of it (${part})`);
  journals.following("a", stroll.thing, true);
  walk(k, "a", lat, stroll.f.metres);
  assert.deepEqual([(journals.view("a") as JournalView).favours.length, (journals.view("a") as JournalView).favoursDone], [0, 2]);
  await journals.close();
});

test("a hello is passed on, a parcel is carried far enough, and a look around ends back where it began", async () => {
  const k = keeper();
  const { journals, news, day } = k;
  await journals.joined("a", null, "family");
  journals.moved("a", HERE.lat, HERE.lon);

  // A hello from a cow to another of the herd: the cow herself will not do, nor will a sheep.
  let from = 1;
  let hello = giver("cow", "greet", day, from);
  while (hello.f.want !== "cow") hello = giver("cow", "greet", day, (from = hello.thing + 1));
  assert.equal(journals.beforeTalk("a", hello.thing, "cow", "Pat", true).offer?.want, "cow");
  assert.deepEqual(journals.beforeTalk("a", hello.thing, "cow", "Pat", false).arrived, []);
  assert.deepEqual(journals.beforeTalk("a", [5, 6, 7, 8].find((t) => !asksUnprompted(t, day))!, "sheep", "Woolly", false).arrived, []);
  const other = [900001, 900002, 900003].find((t) => !asksUnprompted(t, day))!;
  const met = journals.beforeTalk("a", other, "cow", "Maud", false);
  assert.deepEqual([met.arrived.map((f) => f.id), met.offer], [[`cow:${hello.thing}`], null]);
  assert.equal((journals.view("a") as JournalView).favoursDone, 1);

  // A parcel from one house to another at least so far away: next door is too near.
  const parcel = giver("house", "carry", day);
  assert.equal(journals.beforeTalk("a", parcel.thing, "house", "Pat", true).offer?.kind, "carry");
  const quiet = Array.from({ length: 12 }, (_, i) => 910001 + i).filter((t) => !asksUnprompted(t, day));
  assert.deepEqual(journals.beforeTalk("a", quiet[0], "house", "Next Door", false).arrived, [], "too near");
  let lat = walk(k, "a", HERE.lat, parcel.f.metres + 30);
  assert.equal(journals.beforeTalk("a", quiet[1], "house", "Far House", false).arrived.length, 1);
  assert.equal((journals.view("a") as JournalView).favoursDone, 2);

  // A tree that cannot leave its spot: go far enough, be told so, then come back and talk to it.
  journals.moved("a", HERE.lat, HERE.lon); // (a jump back to where the tree is)
  const tree = giver("tree", "look", day);
  assert.equal(journals.beforeTalk("a", tree.thing, "tree", "Pat", true).offer?.kind, "look");
  assert.equal(journals.beforeTalk("a", tree.thing, "tree", "Pat", false).back, null, "not yet");
  assert.match((journals.view("a") as JournalView).favours[0].next, /metres away first/);
  lat = walk(k, "a", HERE.lat, tree.f.metres + 30);
  assert.ok(news.get("a")!.some((n) => n.title === "Far enough"));
  assert.match((journals.view("a") as JournalView).favours[0].next, /go back and talk to Pat/);
  const back = journals.beforeTalk("a", tree.thing, "tree", "Pat", false);
  assert.equal(back.back?.id, `tree:${tree.thing}`);
  const v = journals.view("a") as JournalView;
  assert.deepEqual([v.favoursDone, v.favours.length, v.coins >= 15 + 25 + 25], [3, 0, true], news.get("a")!.map((n) => `${n.title}: ${n.text}`).join(" | "));
  void lat;

  // No more than three at once; one can be given up; old ones are forgotten after a few days.
  const asked: number[] = [];
  for (let thing = 2000; asked.length < 4; thing++) {
    const talk = journals.beforeTalk("a", thing, "snail", "Slow", true);
    if (asked.length < 3) assert.ok(talk.offer, "room for three");
    else assert.deepEqual([talk.offer, talk.full], [null, true]);
    asked.push(thing);
  }
  assert.equal((journals.view("a") as JournalView).favours.length, 3);
  assert.deepEqual([journals.dropFavour("a", `snail:${asked[0]}`), journals.dropFavour("a", "snail:1")], [true, false]);
  assert.equal((journals.view("a") as JournalView).favours.length, 2);
  k.clock.now += 5 * 24 * 3600_000;
  journals.beforeTalk("a", 123456, "taxi", "Zip", false);
  assert.equal((journals.view("a") as JournalView).favours.length, 0, "forgotten, with no blame");
  await journals.close();
});

test("without an AI the favour is asked and thanked for in plain words; with one, it is told what has happened", async () => {
  const day = 20500;
  const quiet = { arrived: [], back: null, offer: null, open: null, full: false, later: false };
  const ride = giver("horse", "ride", day).f;
  assert.equal(favourWords("Hello there.", quiet, false, aKind), "Hello there.");
  assert.equal(favourWords("Hello there.", { ...quiet, offer: ride }, false, aKind), `Hello there. ${askLine(ride, aKind)}`);
  assert.equal(favourWords("I like oats.", { ...quiet, offer: ride }, true, aKind), askLine(ride, aKind), "asked outright, it comes straight to the point");
  assert.match(favourWords("x", { ...quiet, full: true }, true, aKind), /hands are full/);
  assert.match(favourWords("x", { ...quiet, later: true }, true, aKind), /tomorrow/);
  const parcel = giver("house", "carry", day).f;
  assert.match(favourWords("x", { ...quiet, arrived: [parcel] }, false, aKind), /^A parcel from Pat\?/);
  assert.deepEqual(favourNotes(quiet, aKind), []);
  const notes = favourNotes({ ...quiet, arrived: [parcel], offer: ride }, aKind);
  assert.ok(notes.length === 2 && /a parcel from Pat the house/.test(notes[0]) && notes[1].includes(String(ride.metres)));

  // The notes reach the model as part of what it is told, for this answer only.
  const systems: string[] = [];
  const talker = new Talker({ ask: async (_model, system) => { systems.push(system); return { text: "Neigh! Would you ride me a little way?", inputTokens: 10, outputTokens: 10 }; }, spendFile: null });
  const said = await talker.reply("family", 42, "horse", "can I help?", "fox", null, false, notes);
  assert.equal(said.ai, true);
  assert.ok(systems[0].includes("Right now:") && systems[0].includes(notes[1]));
  await talker.reply("family", 42, "horse", "thanks", "fox", null);
  assert.ok(!systems[1].includes("Right now:"));
});

test("in a room: asking a thing for a job gets one, in its speech bubble and in the passport", async () => {
  const { journals, day } = keeper();
  const rooms = new Rooms(new GuestDirectory(""), { journal: journals });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => rooms.wss.handleUpgrade(req, socket, head, (ws) => rooms.wss.emit("connection", ws, req)));
  await new Promise<void>((r) => server.listen(0, r));
  const ws = new WebSocket(`ws://localhost:${(server.address() as AddressInfo).port}/v1/ws`);
  const inbox: Msg[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
  await new Promise<void>((r) => ws.on("open", () => r()));
  const next = async (t: string, ok: (m: Msg) => boolean = () => true): Promise<Msg> => {
    for (let i = 0; i < 300; i++) {
      const at = inbox.findIndex((m) => m.t === t && ok(m));
      if (at >= 0) return inbox.splice(at, 1)[0];
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for "${t}"`);
  };
  try {
    ws.send(JSON.stringify({ t: "hello", name: "Kid", room: "family", avatar: "fox" }));
    await next("welcome");
    ws.send(JSON.stringify({ t: "pos", lat: HERE.lat, lon: HERE.lon, alt: 0, yaw: 0 }));
    await new Promise((r) => setTimeout(r, 50));
    // A cat that does not ask of its own accord says only hello; asked for a job, it asks its favour.
    let cat = 1;
    while (asksUnprompted(cat, day) || favourOf(cat, "cat", "x", "a cat", day, 0, HERE, aKind)!.kind !== "walk") cat++;
    ws.send(JSON.stringify({ t: "talk", thing: cat, sp: "cat" }));
    const hello = await next("say");
    assert.ok(!/favour/.test(hello.text), hello.text);
    await new Promise((r) => setTimeout(r, 1300));
    ws.send(JSON.stringify({ t: "talk", thing: cat, sp: "cat", text: "Can I help you with anything?" }));
    const ask = await next("say");
    assert.match(ask.text, /^Would you do me a favour\? I would love a walk\. Say "follow me" and take me \d+ metres with you\.$/);
    const told = await next("stamp", (m) => m.kind === "favour");
    assert.equal(told.title, `A favour for ${ask.name}`);
    assert.ok(!("thing" in told) && !("say" in told));

    // "Follow me", then the walk: the cat says thank you when it is far enough.
    await new Promise((r) => setTimeout(r, 1300));
    ws.send(JSON.stringify({ t: "talk", thing: cat, sp: "cat", text: "follow me" }));
    await next("order");
    await next("say", (m) => m.thing === cat); // its answer to "follow me"
    const metres = Number(/(\d+) metres/.exec(ask.text)![1]);
    for (let i = 1; i <= Math.ceil(metres / 20) + 2; i++) ws.send(JSON.stringify({ t: "pos", lat: HERE.lat + (i * 20) / 111_320, lon: HERE.lon, alt: 0, yaw: 0 }));
    const done = await next("stamp", (m) => m.title === "Favour done");
    assert.ok(done.text.endsWith("20 coins"));
    const thanks = await next("say", (m) => m.thing === cat);
    assert.deepEqual([thanks.name, /Thank you/.test(thanks.text)], [ask.name, true]);

    // One given up from the passport comes off the list.
    let horse = 5000;
    while (favourOf(horse, "horse", "x", "a horse", day, 0, HERE, aKind)!.kind !== "ride") horse++;
    await new Promise((r) => setTimeout(r, 1300));
    ws.send(JSON.stringify({ t: "talk", thing: horse, sp: "horse", text: "any jobs?" }));
    await next("say");
    ws.send(JSON.stringify({ t: "journal" }));
    const mine = (await next("journal")).journal as JournalView;
    assert.deepEqual([mine.favours.map((f) => f.id), mine.favoursDone], [[`horse:${horse}`], 1]);
    ws.send(JSON.stringify({ t: "favour", drop: `horse:${horse}` }));
    assert.deepEqual(((await next("journal")).journal as JournalView).favours, []);
    ws.close();
  } finally {
    rooms.close();
    server.close();
    await journals.close();
  }
});
