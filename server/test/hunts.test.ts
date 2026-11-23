import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { EXPEDITIONS, expeditionById, type Homecoming } from "../src/expeditions.ts";
import { huntCell, type HuntStop, planHunt, wayTo } from "../src/hunt.ts";
import { Journals, type JournalView, type StampNews } from "../src/journal.ts";
import { levelPrizes } from "../src/progress.ts";
import { latToY, lonToX, metersPerTile } from "../src/geo.ts";
import type { Features, Pt } from "../src/osm.ts";
import { GuestDirectory } from "../src/people.ts";
import { Rooms } from "../src/rooms.ts";

type Msg = Record<string, any>;
const HERE = { lat: 48.85, lon: 2.35 };
const metres = (aLat: number, aLon: number, bLat: number, bLon: number): number =>
  Math.hypot((bLat - aLat) * 111_320, (bLon - aLon) * 111_320 * Math.cos((aLat * Math.PI) / 180));

/** A little town round `HERE`: a church, a school, a pond, a wood, a stream, a railway, two named streets and a numbered house. */
function town(): Features {
  const ox = lonToX(HERE.lon), oy = latToY(HERE.lat);
  const S = metersPerTile(oy);
  const at = (east: number, north: number): Pt => [ox + east / S, oy - north / S];
  const box = (east: number, north: number, size: number): Pt[] => [at(east, north), at(east + size, north), at(east + size, north + size), at(east, north + size)];
  return {
    buildings: [
      { id: 1, ring: box(200, 100, 20), height: 12, kind: "church" },
      { id: 2, ring: box(-250, 150, 30), height: 8, kind: "school" },
      { id: 3, ring: box(60, -300, 10), height: 6, kind: "house", housenumber: "12", street: "Rue du Test" },
      { id: 4, ring: box(10, 10, 10), height: 6, kind: "house" },
    ],
    roads: [
      { id: 10, cls: "road", width: 6, pts: [at(-400, 300), at(400, 300)], name: "Avenue des Essais", hw: "residential" },
      { id: 11, cls: "road", width: 6, pts: [at(-300, -400), at(-300, 400)], name: "Rue du Test", hw: "residential" },
      { id: 12, cls: "stream", width: 3, pts: [at(350, -400), at(350, 400)] },
      { id: 13, cls: "rail", width: 3, pts: [at(-500, -350), at(500, -350)] },
    ],
    areas: [
      { id: 20, cls: "water", rings: [box(-150, -200, 40)] },
      { id: 21, cls: "forest", rings: [box(300, 350, 80)] },
      { id: 22, cls: "water", rings: [box(0, 0, 3)] }, // a puddle: too small to send anyone to
    ],
    trees: [], addresses: [], coast: [],
  };
}

test("a treasure hunt is made from the map: a short walk between places of different kinds, the same for everyone that day", async () => {
  const map = town();
  let loads = 0;
  const load = async (): Promise<Features> => { loads++; return map; };
  const hunt = (await planHunt(HERE.lat, HERE.lon, 20780, load))!;
  assert.equal(loads, 9, "the neighbourhood and the eight squares round it");
  assert.equal(hunt.length, 5);
  assert.equal(new Set(hunt.map((s) => s.kind)).size, 5, `five different kinds of place (${hunt.map((s) => s.kind).join(", ")})`);
  let from = huntCell(HERE.lat, HERE.lon) as { lat: number; lon: number };
  for (const s of hunt) {
    const d = metres(from.lat, from.lon, s.lat, s.lon);
    assert.ok(d >= 75 && d <= 710, `${s.what} is a short walk from the last (${Math.round(d)} m)`);
    assert.ok(s.reach >= 25 && s.reach <= 70 && s.riddle.length > 15 && !/undefined/.test(s.riddle + s.what));
    from = s;
  }
  // Anyone in the same neighbourhood on the same day gets the same hunt; tomorrow's is another.
  assert.deepEqual(await planHunt(HERE.lat + 0.003, HERE.lon - 0.004, 20780, load), hunt);
  const days = new Set<string>();
  for (let day = 20780; day < 20790; day++) days.add((await planHunt(HERE.lat, HERE.lon, day, load))!.map((s) => s.what).join());
  assert.ok(days.size >= 4, `ten days, several different hunts (${days.size})`);
  // The puddle is nobody's clue, and named things are named in their riddles.
  const all = new Map<string, HuntStop>();
  for (let day = 20780; day < 20880; day++) for (const s of (await planHunt(HERE.lat, HERE.lon, day, load))!) all.set(s.what, s);
  assert.ok(all.has("the church") && all.has("a school") && all.has("the water's edge") && all.has("a wood") && all.has("a stream") && all.has("the railway"));
  assert.match(all.get("Avenue des Essais")!.riddle, /Avenue des Essais/);
  assert.match(all.get("number 12, Rue du Test")!.riddle, /number 12.*Rue du Test/);
  assert.equal([...all.values()].filter((s) => s.kind === "water").length, 1);

  // Open country with one barn is no hunt, and a piece of map that will not load is done without.
  const empty: Features = { buildings: [], roads: [], areas: [], trees: [], addresses: [], coast: [] };
  assert.equal(await planHunt(HERE.lat, HERE.lon, 20780, async () => empty), null);
  let n = 0;
  const patchy = await planHunt(HERE.lat, HERE.lon, 20780, async () => { if (n++ % 2) throw new Error("no map"); return map; });
  assert.deepEqual(patchy, hunt);

  assert.equal(wayTo(48.85, 2.35, 48.85, 2.35), "very close by");
  assert.equal(wayTo(48.85, 2.35, 48.8527, 2.35), "about 300 metres to the north");
  assert.equal(wayTo(48.85, 2.35, 48.8482, 2.3527), "about 300 metres to the south-east");
  assert.match(wayTo(48.85, 2.35, 51.5, -0.12), /a long way off to the north-west, about 3\d\d km/);
});

const STOPS: HuntStop[] = [
  { kind: "church", what: "the church", riddle: "I wear a tower.", lat: 48.852, lon: 2.35, reach: 30 },
  { kind: "water", what: "the water's edge", riddle: "I show you the sky.", lat: 48.852, lon: 2.354, reach: 30 },
  { kind: "street", what: "Rue du Test", riddle: "Find the street called Rue du Test.", lat: 48.849, lon: 2.354, reach: 25 },
];
function keeper(plan: (lat: number, lon: number, day: number) => Promise<HuntStop[] | null> = async () => STOPS) {
  const clock = { now: Date.UTC(2026, 10, 22, 9) };
  const news = new Map<string, StampNews[]>();
  const journals = new Journals({ now: () => clock.now, placeDetail: async () => ({ name: "Somewhere", country: "France" }), planHunt: plan });
  journals.listen((key, n) => news.set(key, [...(news.get(key) ?? []), n]));
  return { journals, clock, news };
}

test("a hunt is begun from where you stand, each clue is found by standing there, and the treasure is at the last", async () => {
  const { journals, clock, news } = keeper();
  await journals.joined("a", null, "family");
  assert.equal(await journals.startHunt("a"), "nowhere", "nobody knows where they are yet");
  journals.moved("a", HERE.lat, HERE.lon);
  assert.equal(await journals.startHunt("a"), "ok");
  assert.equal(await journals.startHunt("a"), "busy");
  const first = news.get("a")!.find((n) => n.kind === "hunt")!;
  assert.deepEqual([first.title, first.text], ["A treasure hunt!", "Clue 1 of 3: I wear a tower. It is about 200 metres to the north."]);
  let v = journals.view("a") as JournalView;
  assert.deepEqual(v.hunt, { at: 0, of: 3, clue: "I wear a tower.", way: "about 200 metres to the north", minutes: 0 });

  // Walking past the second clue first finds nothing; the church does.
  clock.now += 60_000;
  journals.moved("a", 48.852, 2.354);
  assert.equal((journals.view("a") as JournalView).hunt!.at, 0);
  clock.now += 60_000;
  journals.moved("a", 48.8521, 2.3501);
  v = journals.view("a") as JournalView;
  assert.deepEqual([v.hunt!.at, v.hunt!.clue, v.hunt!.minutes], [1, "I show you the sky.", 2]);
  const found = news.get("a")!.find((n) => n.title === "Found it: the church")!;
  assert.match(found.text, /^Clue 2 of 3: I show you the sky\. It is about 300 metres to the east\.$/);
  clock.now += 60_000;
  journals.moved("a", 48.852, 2.354);
  clock.now += 60_000;
  journals.moved("a", 48.849, 2.3541);
  v = journals.view("a") as JournalView;
  assert.deepEqual([v.hunt, v.huntsDone, v.huntBestMinutes, v.coins], [null, 1, 4, 50 + levelPrizes(1, v.level.n)]); // the treasure, and the prizes of the levels reached on the way
  const treasure = news.get("a")!.find((n) => n.title === "Treasure found!")!;
  assert.deepEqual(treasure.at, { lat: 48.849, lon: 2.3541 }, "where the finder stood");
  assert.equal(treasure.text, "It was at Rue du Test. 3 clues in 4 minutes: 50 coins.");
  assert.ok(news.get("a")!.some((n) => n.kind === "prize" && /Feathered cap/.test(n.title)) && v.hats.find((h) => h.id === "feather")!.owned, "the first treasure wins a hat");
  assert.ok(news.get("a")!.some((n) => n.title === "Treasures found: 1"));
  assert.match(v.hats.find((h) => h.id === "feather")!.how!, /treasure hunt/);

  // Another can be begun at once, and given up.
  assert.equal(await journals.startHunt("a"), "ok");
  assert.deepEqual([journals.dropHunt("a"), journals.dropHunt("a"), (journals.view("a") as JournalView).hunt], [true, false, null]);
  await journals.close();

  const bare = keeper(async () => null);
  await bare.journals.joined("b", null, "family");
  bare.journals.moved("b", 0, -30);
  assert.equal(await bare.journals.startHunt("b"), "none", "nothing on the map out at sea");
  await bare.journals.close();
});

test("expeditions: an album is filled by meeting, a tour by standing there, and a lost animal walks home with you", async () => {
  const { journals, clock, news } = keeper();
  await journals.joined("a", null, "family");
  journals.moved("a", HERE.lat, HERE.lon);
  let v = journals.view("a") as JournalView;
  assert.equal(v.expeditions.length, EXPEDITIONS.length);
  assert.ok(v.expeditions.every((e) => e.state === "open" && e.have === 0 && e.items.length >= 1));

  // The farmyard album: only meetings after setting out count.
  journals.talked("a", 1, "cow", "Daisy", "", "Moo.");
  assert.deepEqual([journals.startExpedition("a", "farm"), journals.startExpedition("a", "nonsense")], ["ok", "unknown"]);
  for (const [i, sp] of ["sheep", "horse", "chicken", "pig", "goat"].entries()) journals.talked("a", 10 + i, sp, "Friend", "", "Hello.");
  journals.talked("a", 10, "sheep", "Friend", "", "Hello again.");
  v = journals.view("a") as JournalView;
  const farm = v.expeditions.find((e) => e.id === "farm")!;
  assert.deepEqual([farm.state, farm.have, farm.need], ["active", 5, 6]);
  assert.deepEqual(farm.items.filter((i) => i.got).map((i) => i.name), ["sheep", "horse", "hen", "pig", "goat"]);
  const before = v.coins;
  journals.talked("a", 2, "cow", "Maud", "", "Moo.");
  v = journals.view("a") as JournalView;
  assert.deepEqual([v.expeditions.find((e) => e.id === "farm")!.state, v.coins - before >= 50, journals.startExpedition("a", "farm")], ["done", true, "done"]);
  assert.ok(news.get("a")!.some((n) => n.title === "Expedition done: The farmyard album") && news.get("a")!.some((n) => n.title === "Expeditions: 1"));

  // Five capitals: Paris is where we are standing, which counts the moment we set out.
  assert.equal(journals.startExpedition("a", "capitals"), "ok");
  assert.equal((journals.view("a") as JournalView).expeditions.find((e) => e.id === "capitals")!.have, 1);
  for (const [lat, lon] of [[51.5074, -0.1278], [52.52, 13.405], [41.9, 12.5], [0, 0], [-41.29, 174.78]]) { clock.now += 10_000; journals.moved("a", lat, lon); }
  v = journals.view("a") as JournalView;
  assert.equal(v.expeditions.find((e) => e.id === "capitals")!.state, "done");
  assert.ok(news.get("a")!.some((n) => n.title === "Five capitals: 3 of 5" && n.text === "You have reached Berlin"));

  // No more than three at once, and one lost animal at a time.
  assert.deepEqual(["wonders", "aotearoa", "penguin", "minibeasts"].map((id) => journals.startExpedition("a", id)), ["ok", "ok", "ok", "full"]);
  assert.equal(journals.dropExpedition("a", "aotearoa"), true);
  assert.equal(journals.startExpedition("a", "camel"), "busy");
  // The penguin walks with the player, whatever companion they had chosen, until the far south.
  v = journals.view("a") as JournalView;
  assert.deepEqual([v.passenger, journals.petOf("a"), v.pets.includes("penguin")], ["penguin", "penguin", false]);
  clock.now += 10_000;
  journals.moved("a", -36.85, 174.76);
  assert.equal(journals.petOf("a"), "penguin", "Auckland is not far enough south");
  clock.now += 10_000;
  journals.moved("a", -77.85, 166.67);
  v = journals.view("a") as JournalView;
  assert.deepEqual([v.passenger, journals.petOf("a"), v.pets.includes("penguin"), v.expeditions.find((e) => e.id === "penguin")!.state], [null, null, true, "done"]);
  assert.ok(news.get("a")!.some((n) => /^The penguin is home, in the far south\. 80 coins\. A penguin will keep you company/.test(n.text)));
  assert.deepEqual([journals.setPet("a", "penguin"), journals.petOf("a")], [true, "penguin"]);
  await journals.close();

  // Every lost animal's home is where it says, and not where the family lives.
  const homes: Record<string, [number, number]> = { penguin: [-77.85, 166.67], camel: [23.4, 25.6], kangaroo: [-33.87, 151.21], panda: [30.66, 104.07], reindeer: [69.65, 18.96], llama: [-13.53, -71.97] };
  for (const [id, [lat, lon]] of Object.entries(homes)) {
    const e = expeditionById(id) as Homecoming;
    assert.ok(e.home(lat, lon) && !e.home(-36.85, 174.76) && !e.home(52.01, 4.71), id);
  }
  assert.equal(new Set(EXPEDITIONS.map((e) => e.id)).size, EXPEDITIONS.length);
});

test("in a room: a lost animal is seen at its player's side, and a hunt is begun and given up from the passport", async () => {
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
    const welcome = await next("welcome");
    return { ws, inbox, next, id: welcome.id as string };
  };
  try {
    const mum = await join("Mum");
    const kid = await join("Kid");
    await new Promise((r) => setTimeout(r, 50));
    mum.ws.send(JSON.stringify({ t: "expedition", start: "hunt" }));
    assert.equal((await mum.next("error")).code, "nowhere");
    await mum.next("journal");
    mum.ws.send(JSON.stringify({ t: "pos", lat: HERE.lat, lon: HERE.lon, alt: 0, yaw: 0 }));
    await new Promise((r) => setTimeout(r, 50));
    mum.ws.send(JSON.stringify({ t: "expedition", start: "hunt" }));
    assert.deepEqual(((await mum.next("journal")).journal as JournalView).hunt?.clue, "I wear a tower.");
    assert.equal((await mum.next("stamp", (m) => m.kind === "hunt")).title, "A treasure hunt!");
    mum.ws.send(JSON.stringify({ t: "pos", lat: 48.852, lon: 2.35, alt: 0, yaw: 0 }));
    assert.equal((await mum.next("stamp", (m) => m.kind === "hunt")).title, "Found it: the church");
    mum.ws.send(JSON.stringify({ t: "expedition", drop: "hunt" }));
    assert.equal(((await mum.next("journal")).journal as JournalView).hunt, null);

    // The penguin comes along where everyone can see it, and goes home at the far south.
    mum.ws.send(JSON.stringify({ t: "expedition", start: "penguin" }));
    const seen = await kid.next("pet");
    assert.deepEqual([seen.id, seen.sp, typeof seen.thing], [mum.id, "penguin", "number"]);
    assert.equal(((await mum.next("journal")).journal as JournalView).passenger, "penguin");
    mum.ws.send(JSON.stringify({ t: "expedition", start: "camel" }));
    assert.equal((await mum.next("error")).text, "One lost animal at a time");
    mum.ws.send(JSON.stringify({ t: "pos", lat: -77.85, lon: 166.67, alt: 0, yaw: 0 }));
    assert.deepEqual(await kid.next("pet"), { t: "pet", id: mum.id }, "home, and gone from her side");
    assert.equal((await mum.next("stamp", (m) => m.kind === "expedition" && /^Expedition done/.test(m.title))).title, "Expedition done: Take the lost penguin home");
    assert.equal(kid.inbox.filter((m) => m.t === "stamp" && (m.kind === "hunt" || m.kind === "expedition")).length, 0, "her news is hers alone");
    mum.ws.close();
    kid.ws.close();
  } finally {
    rooms.close();
    server.close();
    await journals.close();
  }
});
