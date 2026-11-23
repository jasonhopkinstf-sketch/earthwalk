import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createApp } from "../src/app.ts";
import { GENERATOR_REV, type HomeDoor, painted } from "../src/chunk.ts";
import { cleanDecor, type Decor, emptyDecor, Homes, type HomesStore, howWon, type Lived, PIECES, PRIZES_SHOWN, SLOTS } from "../src/home.ts";
import { buildInterior, furnishedInterior, INSIDE } from "../src/interior.ts";
import { Journals, type JournalView } from "../src/journal.ts";
import { GuestDirectory } from "../src/people.ts";
import { type JournalKeeper, Rooms } from "../src/rooms.ts";

type Msg = Record<string, any>;
const GROUND = 12;
const S = 380;
/** A home 10 m by 7 m with its front wall along the north side and its door 4 m along. */
function home(seed: number, height = 5.85): HomeDoor {
  return { id: 77, corners: [[100, -50], [100, -57], [110, -57], [110, -50]], x: 106, y: -50, along: [-1, 0], out: [0, 1], floor: GROUND + 0.06, height, seed, wall: 0xf6e8c6, porch: false };
}
const where = (id: number, seed = 5) => ({ x: 1, y: 2, id, lat: 52.01, lon: 4.71, yaw: 0, home: { ...home(seed), id }, gen: GENERATOR_REV });
const shape = (m: ReturnType<typeof buildInterior>): unknown => m.sections.map((s) => [s.mat.id, s.mat.color, s.count]);

test("the catalogue: every piece has a slot, a name, and either a price or a way to be won", () => {
  assert.equal(new Set(PIECES.map((p) => p.id)).size, PIECES.length);
  for (const p of PIECES) {
    assert.ok(SLOTS.includes(p.slot) && p.name && p.hex.length > 0);
    assert.ok((p.price !== undefined) !== (p.feat !== undefined), `${p.id} is bought or won, not both`);
    assert.equal(howWon(p) === null, p.feat === undefined);
    if (p.feat) assert.equal(p.slot, "prize", "only prizes are won");
  }
  for (const slot of SLOTS) assert.ok(PIECES.some((p) => p.slot === slot), `something for ${slot}`);
  // A decor keeps only real pieces, each in its own slot, and no more prizes than a house shows.
  const all = PIECES.filter((p) => p.slot === "prize").map((p) => p.id);
  assert.deepEqual(cleanDecor({ walls: "sky", floor: "sky", sofa: "nonsense", bed: "bunk", rug: 3, prizes: ["chest", "chest", "bunk", ...all] }),
    { walls: "sky", bed: "bunk", prizes: ["chest", ...all.filter((id) => id !== "chest")].slice(0, PRIZES_SHOWN) });
  assert.deepEqual(cleanDecor(null), emptyDecor());
});

test("furnished the owner's way, a house is still all inside its own walls, and the same every time", () => {
  const pieces = (slot: string): (string | undefined)[] => [undefined, ...PIECES.filter((p) => p.slot === slot).map((p) => p.id)];
  const prizes = PIECES.filter((p) => p.slot === "prize").map((p) => p.id);
  const within = (m: ReturnType<typeof buildInterior>, top: number, what: string): void => {
    for (const s of m.sections) {
      assert.ok(s.mat.id >= 40 && s.mat.id <= 45);
      for (let i = 0; i < s.pos.length; i += 3) {
        const [e, n, h] = [s.pos[i], s.pos[i + 1], s.pos[i + 2]];
        assert.ok(e > 100.02 && e < 109.98 && n < -50.02 && n > -56.98, `${what}: inside the walls (${e.toFixed(2)}, ${n.toFixed(2)})`);
        assert.ok(h >= GROUND + 0.06 - 1e-6 && h <= GROUND + 0.06 + top + 1e-6, `${what}: under the ceiling (${(h - GROUND - 0.06).toFixed(2)})`);
      }
    }
  };
  for (let seed = 1; seed <= 12; seed++) {
    const h = home(seed * 104729);
    assert.deepEqual(shape(buildInterior(h, S, null)), shape(buildInterior(h, S)), "no choices: the house as it was built");
    assert.deepEqual(shape(buildInterior(h, S, emptyDecor())), shape(buildInterior(h, S)));
    // Every piece of every slot, a few at a time.
    const n = Math.max(...["walls", "floor", "sofa", "bed", "rug"].map((slot) => pieces(slot).length));
    for (let k = 0; k < n; k++) {
      const at = (slot: string): string | undefined => { const list = pieces(slot); return list[(k + seed) % list.length]; };
      const decor = cleanDecor({ walls: at("walls"), floor: at("floor"), sofa: at("sofa"), bed: at("bed"), rug: at("rug"), prizes: [0, 1, 2, 3, 4, 5].map((j) => prizes[(k * 3 + seed + j) % prizes.length]) });
      const m = buildInterior(h, S, decor);
      within(m, 2.6, JSON.stringify(decor));
      assert.deepEqual(shape(buildInterior(h, S, decor)), shape(m), "the same every time");
    }
    // Under the lowest ceiling a house has, the tall pieces still fit.
    within(buildInterior(home(seed * 104729, 2.2), S, { bed: "poster", prizes: ["clock", "thanks", "friends"] }), 2.3, "a low house");
  }
  // The choices show: the walls in their paint, squares on every floor, and more to look at with prizes in.
  const h = home(7);
  const plain = buildInterior(h, S), night = buildInterior(h, S, { walls: "night", floor: "check", prizes: [] });
  const colours = (m: typeof plain, id: number): number[] => m.sections.filter((s) => s.mat.id === id).map((s) => s.mat.color);
  assert.deepEqual(colours(night, INSIDE.wall.id), [painted(INSIDE.wall, 0x2c3a6b).color], "one paint on every wall");
  assert.deepEqual(colours(night, INSIDE.floor.id).sort(), [painted(INSIDE.floor, 0x2b2b2f).color, painted(INSIDE.floor, 0xf2f0ea).color].sort());
  assert.ok(colours(night, INSIDE.glass.id).includes(painted(INSIDE.glass, 0xf2e394).color), "stars on the walls");
  const count = (m: typeof plain): number => m.sections.filter((s) => s.mat.id === INSIDE.furniture.id).reduce((sum, s) => sum + s.count, 0);
  assert.ok(count(buildInterior(h, S, { prizes: ["piano", "globe", "chest"] })) > count(plain) + 3 * 20, "three prizes standing in it");
});

test("who lives where: one house a person, one person a house, and moving takes the furnishing along", async () => {
  const kept: Lived[][] = [];
  const store: HomesStore = { load: async () => kept[kept.length - 1] ?? [], save: async (all) => void kept.push(JSON.parse(JSON.stringify(all))) };
  const homes = new Homes(store, () => 500);
  await homes.open();
  assert.deepEqual([homes.list(), homes.of("sam"), homes.at(1, 2, 77)], [[], null, null]);
  assert.equal(homes.claim("sam", "Sam", true, where(77)).got, "ok");
  assert.deepEqual(homes.list(), [{ x: 1, y: 2, id: 77, lat: 52.01, lon: 4.71, yaw: 0, name: "Sam", rev: 1 }]);
  assert.deepEqual([homes.claim("sam", "Sam", true, where(77)).got, homes.claim("kim", "Kim", true, where(77)).got], ["same", "taken"]);
  // Furnishing it; nonsense is left out.
  assert.deepEqual(homes.change("sam", { decor: { walls: "sky", sofa: "bunk", prizes: ["chest"] } as Decor })!.decor, { walls: "sky", prizes: ["chest"] });
  assert.equal(homes.change("kim", { decor: emptyDecor() }), null, "no house, nothing to furnish");
  // A guest's house is not written down.
  assert.equal(homes.claim("guest-1", "Visitor", false, where(78)).got, "ok");
  // Moving: the old house is free again, and the furnishing comes along.
  const moved = homes.claim("sam", "Sam", true, where(79));
  assert.deepEqual([moved.got, moved.left?.id, homes.at(1, 2, 77), homes.of("sam")!.id, homes.of("sam")!.decor], ["ok", 77, null, 79, { walls: "sky", prizes: ["chest"] }]);
  const before = homes.of("sam")!.rev;
  assert.equal(homes.claim("kim", "Kim", true, where(77)).got, "ok");
  assert.ok(homes.at(1, 2, 77)!.rev > before, "a new owner never gets a number the house has had");
  assert.deepEqual([homes.leave("kim")?.id, homes.leave("kim"), homes.at(1, 2, 77)], [77, null, null]);
  await homes.settled();
  assert.deepEqual(kept[kept.length - 1].map((l) => [l.owner, l.id]), [["sam", 79]], "only the lasting ones are kept");

  // Another day: the houses are read back.
  const again = new Homes(store);
  await again.open();
  assert.deepEqual([again.of("sam")!.id, again.of("sam")!.decor, again.of("guest-1"), again.at(1, 2, 79)!.name], [79, { walls: "sky", prizes: ["chest"] }, null, "Sam"]);
  // A file that cannot be read is an empty street.
  const broken = new Homes({ load: async () => { throw new Error("disk"); }, save: async () => { throw new Error("disk"); } });
  await broken.open();
  assert.equal(broken.claim("sam", "Sam", true, where(77)).got, "ok");
  await broken.settled();
});

test("the journal: pieces are bought once with coins, and prizes are won by doing things", async () => {
  const journals = new Journals({});
  const told: string[] = [];
  journals.listen((_key, news) => { if (news.kind === "prize") told.push(`${news.title}: ${news.text}`); });
  await journals.joined("a", null, "family");
  let v = journals.view("a") as JournalView;
  assert.equal(v.house.pieces.length, PIECES.length);
  assert.ok(v.house.pieces.every((p) => !p.owned));
  assert.deepEqual(v.house.pieces.find((p) => p.id === "owl"), { id: "owl", slot: "prize", name: "Wise owl statue", price: null, how: "Solve 5 riddles", owned: false, hex: [0xb9c0c6, 0xe0b23c] });
  assert.deepEqual([journals.takePiece("a", "sky"), journals.takePiece("a", "owl"), journals.takePiece("a", "nonsense"), journals.takePiece("nobody", "sky")], ["poor", "prize", "unknown", "unknown"]);
  // Six riddles answered: coins, and the owl for five of them.
  for (const [i, sp] of ["cow", "tree", "house", "car", "snail", "frog", "bee"].entries()) journals.talked("a", 50 + i, sp, "Friend", "", "Hello.");
  v = journals.view("a") as JournalView;
  assert.ok(v.house.pieces.find((p) => p.id === "owl")!.owned, "won");
  assert.ok(told.some((t) => /owl/i.test(t) && /house of your own/.test(t)), told.join(" | "));
  const coins = v.coins;
  assert.deepEqual([journals.takePiece("a", "sky"), journals.takePiece("a", "sky"), journals.takePiece("a", "owl")], ["ok", "ok", "ok"]);
  v = journals.view("a") as JournalView;
  assert.deepEqual([v.coins, v.house.pieces.find((p) => p.id === "sky")!.owned], [coins - 20, true], "paid for once");
  await journals.close();
});

test("in a room: a house is made one's own, everybody is told, pieces are swapped, and a guest's goes when they leave", async () => {
  const homes = new Homes(null, () => 0);
  const bought: string[] = [];
  const journal: JournalKeeper & { takePiece: NonNullable<JournalKeeper["takePiece"]> } = {
    listen: () => {}, joined: async () => {}, left: () => {}, moved: () => {}, rode: () => {}, talked: () => {}, view: () => ({ coins: 7 }),
    takePiece: (_key, id) => (id === "piano" ? "poor" : id === "owl" ? "prize" : (bought.push(id), "ok")),
  };
  const asked: string[] = [];
  const rooms = new Rooms(new GuestDirectory(""), {
    journal, homes, worldRev: GENERATOR_REV,
    findHome: async (x, y, id) => { asked.push(`${x}/${y}/${id}`); return id === 9 ? null : { home: { ...home(id), id }, lat: 52.0101, lon: 4.71, yaw: 90 }; },
  });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => rooms.wss.handleUpgrade(req, socket, head, (ws) => rooms.wss.emit("connection", ws, req)));
  await new Promise<void>((r) => server.listen(0, r));
  const url = `ws://localhost:${(server.address() as AddressInfo).port}/v1/ws`;
  const join = async (name: string, room = "family") => {
    const ws = new WebSocket(url);
    const inbox: Msg[] = [];
    ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ t: "hello", name, room, avatar: "fox" }));
    const next = async (t: string, ok: (m: Msg) => boolean = () => true): Promise<Msg> => {
      for (let i = 0; i < 300; i++) {
        const at = inbox.findIndex((m) => m.t === t && ok(m));
        if (at >= 0) return inbox.splice(at, 1)[0];
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for "${t}"`);
    };
    const welcome = await next("welcome");
    return { ws, inbox, next, welcome, send: (m: Msg) => ws.send(JSON.stringify(m)) };
  };
  try {
    const sam = await join("Sam");
    const kim = await join("Kim", "elsewhere"); // houses are in the world, not in a room
    assert.deepEqual([sam.welcome.lived, sam.welcome.house], [[], null]);
    sam.send({ t: "house", claim: { x: 1, y: 2, id: 77 } });
    assert.equal((await sam.next("error")).code, "nowhere");
    sam.send({ t: "pos", lat: 52.01, lon: 4.71, alt: 0, yaw: 0 });
    kim.send({ t: "pos", lat: 52.03, lon: 4.71, alt: 0, yaw: 0 });
    await new Promise((r) => setTimeout(r, 2100));
    sam.send({ t: "house", claim: { x: 1, y: 2, id: 9 } });
    assert.equal((await sam.next("error")).code, "nohome");
    await new Promise((r) => setTimeout(r, 2100));
    sam.send({ t: "house", claim: { x: 1, y: 2, id: 77 } });
    const mine = (await sam.next("house")).house;
    assert.deepEqual([mine.x, mine.y, mine.id, mine.lat, mine.lon, mine.yaw, mine.name, mine.rev, mine.decor, mine.animals], [1, 2, 77, 52.0101, 4.71, 90, "Sam", 1, { prizes: [] }, []]);
    assert.deepEqual(await kim.next("lived"), { t: "lived", x: 1, y: 2, id: 77, lat: 52.0101, lon: 4.71, yaw: 90, name: "Sam", rev: 1 });
    await sam.next("lived");
    // Somebody else cannot have it, near or far; and a house is not moved into from two kilometres off.
    kim.send({ t: "house", claim: { x: 1, y: 2, id: 77 } });
    assert.deepEqual([(await kim.next("error")).text], ["Sam lives here"]);
    kim.send({ t: "house", claim: { x: 1, y: 2, id: 78 } });
    assert.equal((await kim.next("error")).code, "far");
    assert.deepEqual(asked, ["1/2/9", "1/2/77", "1/2/78"]);

    // Swapping pieces: bought if need be, refused when there are not the coins or it is a prize not won.
    sam.send({ t: "house", put: { slot: "walls", id: "sky" } });
    assert.deepEqual((await sam.next("house")).house.decor, { walls: "sky", prizes: [] });
    assert.deepEqual([(await kim.next("lived")).rev, (await sam.next("journal")).journal], [2, { coins: 7 }]);
    sam.send({ t: "house", put: { slot: "prize", id: "piano" } });
    assert.equal((await sam.next("error")).code, "poor");
    sam.send({ t: "house", put: { slot: "prize", id: "owl" } });
    assert.equal((await sam.next("error")).code, "locked");
    sam.send({ t: "house", put: { slot: "sofa", id: "sky" } });
    assert.equal((await sam.next("error")).code, "locked", "a paint is not a sofa");
    sam.send({ t: "house", put: { slot: "prize", id: "chest" } });
    assert.deepEqual((await sam.next("house")).house.decor, { walls: "sky", prizes: ["chest"] });
    sam.send({ t: "house", put: { slot: "prize", id: "chest", on: false } });
    assert.deepEqual((await sam.next("house")).house.decor, { walls: "sky", prizes: [] });
    sam.send({ t: "house", put: { slot: "walls" } });
    assert.deepEqual((await sam.next("house")).house.decor, { prizes: [] }, "back to how the house came");
    assert.deepEqual(bought, ["sky", "chest", "chest"]);
    kim.send({ t: "house", put: { slot: "walls", id: "sky" } });
    assert.equal((await kim.next("error")).code, "nohome");

    // Whoever arrives later is told of it; and a guest's house goes when they do.
    const late = await join("Late");
    assert.deepEqual(late.welcome.lived.map((h: Msg) => [h.id, h.name]), [[77, "Sam"]]);
    kim.inbox.length = 0;
    sam.ws.close();
    assert.deepEqual(await kim.next("lived"), { t: "lived", x: 1, y: 2, id: 77, gone: true });
    assert.deepEqual(homes.list(), []);
    late.ws.close();
    kim.ws.close();
  } finally {
    for (const client of rooms.wss.clients) client.terminate(); // whatever happened above, nothing is left holding the test open
    server.close();
    rooms.wss.close();
  }
});

test("GET /v1/interior gives a lived-in house furnished its owner's way, without reading the map", async () => {
  const homes = new Homes();
  homes.claim("sam", "Sam", true, where(77));
  const asked: string[] = [];
  const app = createApp({
    homes, buildInterior: async (x, y, id) => { asked.push(`${x}/${y}/${id}`); return Buffer.from("rooms"); },
    readCache: async () => null, writeCache: async () => {},
  });
  await new Promise<void>((r) => app.server.listen(0, r));
  const base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  const inside = async (id: number): Promise<Buffer> => Buffer.from(await (await fetch(`${base}/v1/interior/16/1/2/${id}`)).arrayBuffer());
  try {
    const plain = await inside(77);
    assert.ok(plain.equals(furnishedInterior(1, 2, where(77).home, emptyDecor())));
    homes.change("sam", { decor: { walls: "night", bed: "bunk", prizes: ["piano"] } });
    const done = await inside(77);
    assert.ok(done.equals(furnishedInterior(1, 2, where(77).home, { walls: "night", bed: "bunk", prizes: ["piano"] })) && !done.equals(plain), "changed with the choices");
    assert.deepEqual(asked, [], "not built from the map");
    // Somebody else moves in after them: the rooms are theirs, not what was kept of the last owner's.
    homes.leave("sam");
    homes.claim("kim", "Kim", true, where(77));
    assert.ok((await inside(77)).equals(plain), "a new owner starts with the house as it came");
    homes.change("kim", { decor: { walls: "sky", prizes: [] } });
    assert.ok((await inside(77)).equals(furnishedInterior(1, 2, where(77).home, { walls: "sky", prizes: [] })), "and furnishes it their own way");
    assert.equal((await inside(78)).toString(), "rooms", "a house nobody lives in is as before");
    assert.deepEqual(asked, ["1/2/78"]);
  } finally {
    app.close();
  }
});

test("the garden: a young animal is fed once a day until it is grown, then gives something once a day, and waits when nobody comes", async () => {
  const { BREEDS, GARDEN_MAX, gardenView, sizeOf, viewOfLived } = await import("../src/home.ts");
  const homes = new Homes(null, () => 0);
  assert.deepEqual([homes.adopt("sam", "chicken"), homes.adopt("sam", "dragon")], ["nohome", "unknown"]);
  homes.claim("sam", "Sam", true, where(77));
  const rev = homes.of("sam")!.rev;
  assert.equal(homes.adopt("sam", "chicken"), "ok");
  const chick = homes.of("sam")!.garden![0];
  assert.deepEqual([gardenView(homes.of("sam")!.garden!, 10), sizeOf(chick)], [[{ sp: "chicken", name: "chick", fed: 0, meals: 3, grown: false, hungry: true, ready: false, gives: "an egg" }], 0.45]);
  assert.deepEqual(viewOfLived(homes.of("sam")!).garden, [{ sp: "chicken", size: 0.45 }]);
  // One meal a day, however often it is offered; ten days away change nothing.
  assert.deepEqual([homes.hungry("sam", 0, 10), homes.fed("sam", 0, 10)?.fed, homes.hungry("sam", 0, 10), homes.fed("sam", 0, 10), homes.gather("sam", 0, 10)], ["ok", 1, "today", null, null]);
  assert.deepEqual([homes.hungry("sam", 0, 20), homes.fed("sam", 0, 20)?.fed, homes.fed("sam", 0, 21)?.fed], ["ok", 2, 3]);
  assert.deepEqual([homes.hungry("sam", 0, 22), sizeOf(chick), gardenView(homes.of("sam")!.garden!, 22)[0].name, gardenView(homes.of("sam")!.garden!, 22)[0].ready], ["grown", 1, "hen", true]);
  // Grown: an egg a day.
  assert.deepEqual([homes.gather("sam", 0, 22)?.gives.food, homes.gather("sam", 0, 22), homes.gather("sam", 0, 23)?.gives.what], ["egg", null, "an egg"]);
  assert.equal(homes.of("sam")!.rev, rev, "the garden does not change the inside of the house");
  // A garden holds so many; one can go; they move house with their owner.
  for (let i = 1; i < GARDEN_MAX; i++) assert.equal(homes.adopt("sam", BREEDS[i % BREEDS.length].sp), "ok");
  assert.deepEqual([homes.adopt("sam", "cow"), homes.release("sam", 1), homes.release("sam", 9), homes.of("sam")!.garden!.length], ["full", true, false, GARDEN_MAX - 1]);
  homes.claim("sam", "Sam", true, where(79));
  assert.deepEqual([homes.of("sam")!.id, homes.of("sam")!.garden!.length, homes.of("sam")!.garden![0].fed], [79, GARDEN_MAX - 1, 3]);
  for (const b of BREEDS) assert.ok(b.price > 0 && b.meals >= 3 && (b.gives.food || b.gives.coins));
});

test("in a room: a young animal is bought, fed from the lunch box and, grown, gives what it gives", async () => {
  const homes = new Homes(null, () => 0);
  const purse = { coins: 60, day: 100, larder: ["a carrot", "a loaf of bread", "an apple"], got: [] as string[] };
  const journal: JournalKeeper = {
    listen: () => {}, joined: async () => {}, left: () => {}, moved: () => {}, rode: () => {}, talked: () => {}, view: () => ({ coins: purse.coins }),
    dayFor: () => purse.day,
    spend: (_key, coins) => (purse.coins >= coins ? ((purse.coins -= coins), true) : false),
    earn: (_key, gain) => { if (gain.food === "full") return false; purse.got.push(gain.food ?? `${gain.coins} coins`); return true; },
    fodder: () => { const name = purse.larder.shift(); return name ? { id: name, name } : null; },
  };
  const rooms = new Rooms(new GuestDirectory(""), { journal, homes, findHome: async (_x, _y, id) => ({ home: { ...home(id), id }, lat: 52.01, lon: 4.71, yaw: 0 }) });
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
    return { ws, inbox, next, send: (m: Msg) => ws.send(JSON.stringify(m)) };
  };
  try {
    const sam = await join("Sam");
    const kim = await join("Kim");
    sam.send({ t: "garden", adopt: "chicken" });
    assert.equal((await sam.next("error")).code, "nohome");
    sam.send({ t: "pos", lat: 52.01, lon: 4.71, alt: 0, yaw: 0 });
    await new Promise((r) => setTimeout(r, 2100));
    sam.send({ t: "house", claim: { x: 1, y: 2, id: 77 } });
    await sam.next("house");
    await kim.next("lived");
    // A chick for twenty coins; a calf is beyond what is left; no dragons.
    sam.send({ t: "garden", adopt: "chicken" });
    assert.match((await sam.next("stamp")).title, /^A chick has come to live in your garden$/);
    assert.deepEqual((await kim.next("lived")).garden, [{ sp: "chicken", size: 0.45 }]);
    let mine = (await sam.next("house")).house;
    assert.deepEqual([mine.animals, mine.gardenMax, mine.breeds.length, purse.coins], [[{ sp: "chicken", name: "chick", fed: 0, meals: 3, grown: false, hungry: true, ready: false, gives: "an egg" }], 4, 4, 40]);
    sam.send({ t: "garden", adopt: "cow" });
    assert.equal((await sam.next("error")).code, "poor");
    sam.send({ t: "garden", adopt: "dragon" });
    assert.equal((await sam.next("error")).code, "locked");
    // Fed from the lunch box, once a day, three days running; then it is a hen.
    sam.send({ t: "garden", gather: 0 });
    assert.equal((await sam.next("error")).text, "It is not grown yet");
    sam.send({ t: "garden", feed: 0 });
    assert.equal((await sam.next("stamp")).title, "Your chick ate a carrot");
    sam.send({ t: "garden", feed: 0 });
    assert.match((await sam.next("error")).text, /It has eaten today/);
    purse.day++;
    sam.send({ t: "garden", feed: 0 });
    assert.equal((await sam.next("stamp")).title, "Your chick ate a loaf of bread");
    purse.day++;
    sam.send({ t: "garden", feed: 0 });
    assert.equal((await sam.next("stamp")).title, "Your chick is a grown hen!");
    assert.deepEqual(purse.larder, []);
    sam.inbox.length = 0;
    sam.send({ t: "garden", feed: 0 });
    assert.equal((await sam.next("error")).text, "It is grown, and feeds itself now");
    sam.send({ t: "garden", gather: 0 });
    assert.equal((await sam.next("stamp")).title, "Your hen gave you an egg");
    sam.send({ t: "garden", gather: 0 });
    assert.match((await sam.next("error")).text, /It has given today/);
    assert.deepEqual(purse.got, ["egg"]);
    mine = (await sam.next("house", (m) => m.house?.animals?.[0]?.grown)).house;
    assert.deepEqual([mine.animals[0].name, mine.animals[0].ready, mine.garden], ["hen", false, [{ sp: "chicken", size: 1 }]]);
    // With nothing it eats in the lunch box, a new one goes unfed, and nothing is lost by that.
    sam.send({ t: "garden", adopt: "sheep" });
    await sam.next("stamp");
    sam.send({ t: "garden", feed: 1 });
    assert.match((await sam.next("error")).text, /nothing it eats in your lunch box/);
    sam.send({ t: "garden", release: 1 });
    assert.equal((await sam.next("house", (m) => m.house?.animals?.length === 1)).house.animals.length, 1);
  } finally {
    for (const client of rooms.wss.clients) client.terminate();
    server.close();
    rooms.wss.close();
  }
});

/** Where on Earth a point of the test home's chunk is (the home is in chunk 1, 2). */
async function onEarth(x: number, y: number): Promise<{ lat: number; lon: number }> {
  const { metersPerTile, xToLon, yToLat, CHUNK_Z } = await import("../src/geo.ts");
  const tile = metersPerTile(2.5, CHUNK_Z);
  return { lat: yToLat(2 - y / tile), lon: xToLon(1 + x / tile) };
}

test("free placing: a thing is put down a step in front of its owner, facing them, and the rooms are built round it", async () => {
  const { spotIn, turnedIn, PRIZE_SIZE } = await import("../src/interior.ts");
  for (const p of PIECES.filter((x) => x.slot === "prize")) assert.ok(PRIZE_SIZE[p.id], `${p.id} has a size`);
  assert.deepEqual(Object.keys(PRIZE_SIZE).sort(), PIECES.filter((x) => x.slot === "prize").map((x) => x.id).sort());
  // A decor keeps a place only for what is on show, and only a sensible one.
  assert.deepEqual(cleanDecor({ prizes: ["piano", "globe"], placed: { piano: { a: 3, b: 2, k: 1 }, globe: { a: "x", b: 2, k: 1 }, chest: { a: 1, b: 1, k: 0 }, plant: { a: 1, b: 1, k: 9 } } }),
    { prizes: ["piano", "globe"], placed: { piano: { a: 3, b: 2, k: 1 } } });

  let placedSomewhere = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const h = home(seed * 104729);
    const decor: Decor = { prizes: ["globe", "piano", "plant"] };
    // Standing just inside the front door (it is 4 m along the front wall), looking into the house (south).
    const here = await onEarth(104, -51.2);
    assert.equal(spotIn(h, 1, 2, decor, "globe", (await onEarth(104, -40)).lat, (await onEarth(104, -40)).lon, 180), null, "not from outside the house");
    assert.equal(spotIn(h, 1, 2, decor, "nonsense", here.lat, here.lon, 180), null);
    // Somewhere in the house with clear floor ahead (where that is depends on how it is cut into rooms).
    let spot: ReturnType<typeof spotIn> = null;
    let stood: [number, number] = [0, 0];
    for (const [x, y] of [[104, -51.2], [107, -51.5], [102, -52], [108, -53], [103, -53.5], [105.5, -52.5], [101.5, -54], [108.5, -54.5]] as [number, number][]) {
      const at = await onEarth(x, y);
      spot = spotIn(h, 1, 2, decor, "globe", at.lat, at.lon, 180);
      stood = [x, y];
      if (spot) { here.lat = at.lat; here.lon = at.lon; break; }
    }
    if (!spot) continue;
    placedSomewhere++;
    assert.equal(spot.k, 1, "it faces whoever put it down: towards the front of the house");
    const ahead = spot.b - (-50 - stood[1]);
    assert.ok(Math.abs(spot.a - (110 - stood[0])) < 0.05 && ahead > 0.7 && ahead < 1.7, `a step ahead of them (${spot.a}, ${spot.b})`);
    decor.placed = { globe: spot };
    // A second thing cannot be put on top of it; turning it keeps it where it is.
    const again = spotIn(h, 1, 2, decor, "plant", here.lat, here.lon, 180);
    if (again) assert.ok(Math.abs(again.b - spot.b) > 0.5, "the next thing stands clear of the first");
    const turned = turnedIn(h, decor, "globe");
    assert.ok(turned && turned.a === spot.a && turned.b === spot.b && turned.k !== spot.k);
    assert.equal(turnedIn(h, decor, "piano"), null, "nothing to turn that has not been put anywhere");
    // The house is built with it there, all inside its walls, the same every time, with as much furniture as before or more of the owner's.
    const built = buildInterior(h, S, decor);
    assert.deepEqual(shape(buildInterior(h, S, decor)), shape(built));
    for (const s of built.sections) {
      for (let i = 0; i < s.pos.length; i += 3) {
        assert.ok(s.pos[i] > 100.02 && s.pos[i] < 109.98 && s.pos[i + 1] < -50.02 && s.pos[i + 1] > -56.98, "inside the walls");
      }
    }
    const where = (m: typeof built): number[] => m.sections.flatMap((s) => Array.from(s.pos, (v) => Math.round(v * 100)));
    assert.notDeepEqual(where(built), where(buildInterior(h, S, { prizes: ["globe", "piano", "plant"] })), "it stands somewhere else than against its wall");
    // In another house the place may not do: then it stands against a wall again, and nothing breaks.
    assert.ok(buildInterior(home(seed * 7 + 3), S, decor).sections.length > 0);
    assert.ok(buildInterior(home(seed, 2.2), S, { prizes: ["globe"], placed: { globe: { a: 99, b: 99, k: 0 } } }).sections.length > 0);
  }
  assert.ok(placedSomewhere >= 8, `nearly every layout has clear floor somewhere (${placedSomewhere} of 10)`);
});

test("in a room: something on show is put where its owner stands, turned, and sent back to the wall", async () => {
  const homes = new Homes(null, () => 0);
  const journal: JournalKeeper = {
    listen: () => {}, joined: async () => {}, left: () => {}, moved: () => {}, rode: () => {}, talked: () => {}, view: () => null,
    takePiece: () => "ok",
  };
  const door = await onEarth(106, -50);
  // A house of one big room, so that there is clear floor wherever its owner stands.
  let seed = 1;
  const { planHome } = await import("../src/interior.ts");
  while (planHome(9.9, 6.9, 5.95, seed)?.rooms.length !== 1 && seed < 500) seed++;
  const rooms = new Rooms(new GuestDirectory(""), { journal, homes, findHome: async (_x, _y, id) => ({ home: { ...home(seed), id }, lat: door.lat, lon: door.lon, yaw: 0 }) });
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
    const inside = await onEarth(104, -51.5);
    send({ t: "pos", lat: inside.lat, lon: inside.lon, alt: 0, yaw: 180 });
    await new Promise((r) => setTimeout(r, 2100));
    send({ t: "house", claim: { x: 1, y: 2, id: 77 } });
    await next("house");
    send({ t: "house", place: { id: "globe" } });
    assert.equal((await next("error")).text, "Put it on show first");
    send({ t: "house", put: { slot: "prize", id: "globe" } });
    await next("house");
    send({ t: "house", place: { id: "globe", turn: true } });
    assert.equal((await next("error")).text, "Put it somewhere first");
    send({ t: "house", place: { id: "globe" } });
    const put = (await next("house")).house;
    assert.deepEqual([Object.keys(put.decor.placed), put.decor.placed.globe.k], [["globe"], 1]);
    await next("lived", (m) => m.rev === put.rev);
    send({ t: "house", place: { id: "globe", turn: true } });
    const turned = (await next("house")).house;
    assert.ok(turned.decor.placed.globe.k !== 1 && turned.decor.placed.globe.a === put.decor.placed.globe.a && turned.rev > put.rev);
    send({ t: "house", place: { id: "globe", wall: true } });
    assert.deepEqual((await next("house")).house.decor, { prizes: ["globe"] });
    // From outside there is nowhere to put it; and what is put away loses its place.
    const outside = await onEarth(104, -40);
    send({ t: "pos", lat: outside.lat, lon: outside.lon, alt: 0, yaw: 180 });
    await new Promise((r) => setTimeout(r, 50));
    send({ t: "house", place: { id: "globe" } });
    assert.match((await next("error")).text, /no room for it there/);
    ws.close();
  } finally {
    for (const client of rooms.wss.clients) client.terminate();
    server.close();
    rooms.wss.close();
  }
});
