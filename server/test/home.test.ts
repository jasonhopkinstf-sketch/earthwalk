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
    assert.deepEqual(mine, { x: 1, y: 2, id: 77, lat: 52.0101, lon: 4.71, yaw: 90, name: "Sam", rev: 1, decor: { prizes: [] } });
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
