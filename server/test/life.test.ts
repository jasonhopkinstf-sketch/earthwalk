import { test } from "node:test";
import assert from "node:assert/strict";
import { groundClasses, placeTrees } from "../src/chunk.ts";
import { Elevation } from "../src/elevation.ts";
import { hash32, latToY, lonToX, metersPerTile, xToLon, yToLat } from "../src/geo.ts";
import { buildLabels } from "../src/labels.ts";
import { CREATURE_CAP, HOME_CAP, localFauna, localStars, MORE_CREATURE_CAP, MORE_HOME_CAP, placeHomes, placeWild, WILD_CREATURE_CAP, WILD_HOME_CAP, type Home } from "../src/life.ts";
import { deedsOf, TALKABLE } from "../src/talk.ts";
import { MOUNTS } from "../public/js/riding.js";
import { fieldOf, parseOsm, type Features, type OsmJson, type Pt } from "../src/osm.ts";
import { callTime, CALL_SLOT, creatureAt, hash32 as clientHash, memberId, SPECIES } from "../public/js/lifemotion.js";
import { RIGS } from "../public/js/liferigs.js";

const CX = 33185;
const CY = 22545;
const S = metersPerTile(CY + 0.5);

function flat(height = 40): Elevation {
  return new Elevation(async () => new Float32Array(256 * 256).fill(height));
}
async function ready(cx = CX, cy = CY, height = 40): Promise<Elevation> {
  const elev = flat(height);
  await elev.ensure(cx - 0.5, cy - 0.5, cx + 1.5, cy + 1.5);
  return elev;
}
const sqAt = (cx: number, cy: number, x0: number, y0: number, x1: number, y1: number): Pt[] => [[cx + x0, cy + y0], [cx + x1, cy + y0], [cx + x1, cy + y1], [cx + x0, cy + y1]];
const sq = (x0: number, y0: number, x1: number, y1: number): Pt[] => sqAt(CX, CY, x0, y0, x1, y1);
const empty = (): Features => ({ buildings: [], roads: [], areas: [], trees: [], addresses: [], coast: [], fields: [] });
const metres = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]) * S;
const closed = (ring: Pt[]): Pt[] => [...ring, ring[0]];
const inSq = (h: Home, cx: number, cy: number, x0: number, y0: number, x1: number, y1: number): boolean =>
  h.wx >= cx + x0 && h.wx <= cx + x1 && h.wy >= cy + y0 && h.wy <= cy + y1;

/** Distance in metres from a point to the nearest part of a line. */
function toLine(p: Pt, pts: Pt[], scale = S): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t) * scale);
  }
  return best;
}

/** The wild homes of a chunk whose whole ground is one class, somewhere on Earth. */
async function wildOn(lat: number, lon: number, cls: Features["areas"][number]["cls"] | null, height = 40): Promise<Home[]> {
  const cx = Math.floor(lonToX(lon));
  const cy = Math.floor(latToY(lat));
  const elev = await ready(cx, cy, height);
  const f = empty();
  if (cls) f.areas.push({ id: 1, cls, rings: [sqAt(cx, cy, -0.1, -0.1, 1.1, 1.1)] });
  const ground = groundClasses(cx, cy, f, elev);
  return placeWild(cx, cy, f, ground, placeTrees(cx, cy, f, ground), elev);
}
const kinds = (homes: Home[]): string[] => [...new Set(homes.map((h) => h.sp))].sort();

test("the map's fields are kept with what they are used for", () => {
  assert.deepEqual(fieldOf({ landuse: "meadow" }), { kind: "meadow" });
  assert.deepEqual(fieldOf({ landuse: "animal_keeping", animal_keeping: "horse" }), { kind: "paddock", stock: "horse" });
  assert.deepEqual(fieldOf({ landuse: "farmland", livestock: "dairy cattle" }), { kind: "farmland", stock: "cow" });
  assert.equal(fieldOf({ landuse: "residential" }), null);

  const n = (id: number, wx: number, wy: number) => ({ type: "node" as const, id, lon: xToLon(wx), lat: yToLat(wy) });
  const osm: OsmJson = { elements: [
    n(1, CX + 0.1, CY + 0.1), n(2, CX + 0.4, CY + 0.1), n(3, CX + 0.4, CY + 0.4), n(4, CX + 0.1, CY + 0.4),
    { type: "way", id: 50, nodes: [1, 2, 3, 4, 1], tags: { landuse: "meadow" } },
    { type: "way", id: 51, nodes: [1, 2, 3, 4, 1], tags: { landuse: "animal_keeping", animal_keeping: "sheep" } },
  ] };
  const f = parseOsm(osm);
  assert.deepEqual(f.fields!.map((x) => [x.id, x.kind, x.stock]), [[50, "meadow", undefined], [51, "paddock", "sheep"]]);
  assert.deepEqual(f.areas.map((a) => a.cls), ["grass"], "a paddock adds no ground cover, so the meshes are unchanged");
});

test("herds live in meadows, clear of roads, buildings and water, and inside their field", async () => {
  const elev = await ready();
  const f = empty();
  const meadow = sq(0.05, 0.05, 0.95, 0.95);
  f.areas.push({ id: 1, cls: "grass", rings: [meadow] }, { id: 2, cls: "water", rings: [sq(0.6, 0.6, 0.8, 0.8)] });
  f.fields!.push({ id: 1, kind: "meadow", rings: [meadow] });
  const road: Pt[] = [[CX - 0.2, CY + 0.5], [CX + 1.2, CY + 0.5]];
  f.roads.push({ id: 9, cls: "road", width: 6, pts: road });
  const barn = sq(0.2, 0.2, 0.25, 0.24);
  f.buildings.push({ id: 7, ring: barn, height: 6, kind: "barn" });

  const homes = placeHomes(CX, CY, f, groundClasses(CX, CY, f, elev));
  const herds = homes.filter((h) => h.sp !== "chicken");
  assert.ok(herds.length >= 5, `a chunk of meadow holds several herds (got ${herds.length})`);
  assert.equal(new Set(herds.map((h) => h.sp)).size, 1, "one kind of animal per field");
  assert.equal(new Set(homes.map((h) => h.id)).size, homes.length, "every home has its own identity");
  for (const h of homes) {
    const p: Pt = [h.wx, h.wy];
    assert.ok(h.r >= 3 && h.r <= 22 && h.n >= 1, `${h.sp} x${h.n} in ${h.r.toFixed(1)} m`);
    assert.ok(toLine(p, road) - 3 >= h.r + 2.9, "the roam circle stays off the road");
    assert.ok(toLine(p, closed(barn)) >= h.r + 2.9, "and off the barn");
    assert.ok(toLine(p, closed(sq(0.6, 0.6, 0.8, 0.8))) >= h.r, "and out of the pond");
    if (h.sp !== "chicken") assert.ok(toLine(p, closed(meadow)) >= h.r - 1e-6, "and inside the field");
  }
  for (const a of homes) for (const b of homes) if (a !== b) assert.ok(metres([a.wx, a.wy], [b.wx, b.wy]) >= a.r + b.r, "herds do not overlap");
  assert.ok(homes.some((h) => h.sp === "chicken") || hash32(7, 0xc1c) % 3 === 0, "chickens scratch about beside the barn");

  // The same map always gives the same herds: this is what lets every player see the same cow.
  assert.deepEqual(placeHomes(CX, CY, f, groundClasses(CX, CY, f, elev)), homes);
});

test("ploughed farmland has animals only beside a farm building, and towns have none", async () => {
  const elev = await ready();
  const f = empty();
  const land = sq(0, 0, 1, 1);
  f.areas.push({ id: 1, cls: "farm", rings: [land] });
  f.fields!.push({ id: 1, kind: "farmland", rings: [land] });
  assert.equal(placeHomes(CX, CY, f, groundClasses(CX, CY, f, elev)).length, 0, "crops, not cows");

  f.buildings.push({ id: 8, ring: sq(0.5, 0.5, 0.54, 0.53), height: 6, kind: "cowshed" });
  const homes = placeHomes(CX, CY, f, groundClasses(CX, CY, f, elev));
  const cows = homes.filter((h) => h.sp === "cow");
  assert.ok(cows.length >= 1, "cows near the cowshed");
  for (const h of cows) assert.ok(metres([h.wx, h.wy], [CX + 0.52, CY + 0.515]) <= 150, "and only near it");

  const town = empty();
  town.areas.push({ id: 1, cls: "urban", rings: [land] });
  town.fields!.push({ id: 1, kind: "meadow", rings: [land] });
  assert.equal(placeHomes(CX, CY, town, groundClasses(CX, CY, town, elev)).length, 0, "no herds on paved ground");
});

test("the limits hold in a chunk that is all paddock", async () => {
  const elev = await ready();
  const f = empty();
  const land = sq(-0.1, -0.1, 1.1, 1.1);
  f.fields!.push({ id: 3, kind: "paddock", rings: [land], stock: "sheep" });
  const homes = placeHomes(CX, CY, f, groundClasses(CX, CY, f, elev));
  assert.ok(homes.length > 10 && homes.length <= HOME_CAP);
  assert.ok(homes.reduce((n, h) => n + h.n, 0) <= CREATURE_CAP);
});

test("labels carry the homes, standing on the ground", async () => {
  const elev = await ready();
  const f = empty();
  const meadow = sq(0.05, 0.05, 0.95, 0.95);
  f.areas.push({ id: 1, cls: "grass", rings: [meadow] });
  f.fields!.push({ id: 1, kind: "meadow", rings: [meadow], stock: "cow" });
  const homes = buildLabels(CX, CY, f, elev).filter((i) => i.kind === "home");
  const cows = homes.filter((h) => h.sp === "cow");
  assert.ok(cows.length >= 5);
  for (const h of cows) assert.ok(h.n! >= 2 && h.r! >= 7);
  assert.equal(new Set(homes.map((h) => h.id)).size, homes.length, "farm and wild homes all have their own identity");
  for (const h of homes) {
    assert.ok(h.sp! in SPECIES, `the browser knows how a ${h.sp} moves`);
    assert.ok(Number.isInteger(h.id) && h.id! > 0 && h.id! <= 0xffffffff);
    assert.ok(h.n! >= 1 && h.r! >= 2 && h.u >= 0 && h.u < 1 && h.v >= 0 && h.v < 1);
    assert.ok(Math.abs(h.h - elev.surfaceHeight(CX + h.u, CY + h.v)) < 1e-6);
    assert.equal(h.text, undefined, "older games skip an item with no text");
  }
});

test("ducks keep to the water, pigeons to town, rabbits to grass, and none of them to roads", async () => {
  const elev = await ready();
  const f = empty();
  f.areas.push(
    { id: 1, cls: "water", rings: [sq(0, 0, 0.45, 0.45)] },
    { id: 2, cls: "urban", rings: [sq(0.55, 0, 1, 0.45)] },
    { id: 3, cls: "grass", rings: [sq(0, 0.55, 1, 1)] },
  );
  const road: Pt[] = [[CX - 0.2, CY + 0.5], [CX + 1.2, CY + 0.5]];
  f.roads.push({ id: 9, cls: "road", width: 6, pts: road });
  const ground = groundClasses(CX, CY, f, elev);
  const homes = placeWild(CX, CY, f, ground, placeTrees(CX, CY, f, ground), elev).filter((h) => h.sp !== "bird");
  const where = (sp: string): Home[] => homes.filter((h) => h.sp === sp);
  assert.ok(where("duck").length >= 1 && where("pigeon").length >= 2 && where("rabbit").length >= 2, `got ${homes.map((h) => h.sp).join(" ")}`);
  for (const h of where("duck")) assert.ok(toLine([h.wx, h.wy], closed(sq(0, 0, 0.45, 0.45))) >= h.r && inSq(h, CX, CY, 0, 0, 0.45, 0.45), "a duck's circle is all water");
  for (const h of where("pigeon")) assert.ok(inSq(h, CX, CY, 0.55, 0, 1, 0.45));
  for (const h of where("rabbit")) assert.ok(inSq(h, CX, CY, 0, 0.55, 1, 1));
  for (const h of homes) if (h.sp !== "duck") assert.ok(toLine([h.wx, h.wy], road) - 3 >= h.r, `${h.sp} keeps off the road`);
  assert.deepEqual(placeWild(CX, CY, f, ground, placeTrees(CX, CY, f, ground), elev).filter((h) => h.sp !== "bird"), homes, "the same every time");
});

test("ducks follow a river that is only drawn as a line, but not a ditch", async () => {
  const elev = await ready();
  const f = empty();
  const river: Pt[] = [[CX - 0.2, CY + 0.3], [CX + 1.2, CY + 0.35]];
  f.roads.push({ id: 5, cls: "stream", width: 14, pts: river }, { id: 6, cls: "stream", width: 2, pts: [[CX - 0.2, CY + 0.8], [CX + 1.2, CY + 0.8]] });
  const ground = groundClasses(CX, CY, f, elev);
  const ducks = placeWild(CX, CY, f, ground, [], elev).filter((h) => h.sp === "duck");
  assert.ok(ducks.length >= 1, "the river has ducks");
  for (const h of ducks) assert.ok(toLine([h.wx, h.wy], river) < 0.01 && h.r <= 6.2 + 1e-9, "on the river, within its banks");
});

test("a cat or a dog lives beside some homes, in its own small patch clear of walls", async () => {
  const elev = await ready();
  const f = empty();
  f.areas.push({ id: 1, cls: "urban", rings: [sq(-0.1, -0.1, 1.1, 1.1)] });
  const side = 10 / S;
  for (let j = 0; j < 8; j++) for (let i = 0; i < 12; i++) {
    const x = 0.05 + i * 0.075;
    const y = 0.08 + j * 0.11;
    f.buildings.push({ id: 1000 + j * 12 + i, ring: sq(x, y, x + side, y + side), height: 6, kind: "house" });
  }
  f.buildings.push({ id: 5000, ring: sq(0.9, 0.9, 0.9 + side, 0.9 + side), height: 6, kind: "garage" });
  const ground = groundClasses(CX, CY, f, elev);
  const pets = placeWild(CX, CY, f, ground, [], elev).filter((h) => h.sp === "cat" || h.sp === "dog");
  assert.ok(pets.length >= 8 && pets.length <= 40, `${pets.length} pets among 96 homes`);
  assert.ok(pets.some((h) => h.sp === "cat") && pets.some((h) => h.sp === "dog"));
  for (const h of pets) {
    assert.ok(h.n >= 1 && h.n <= 2 && h.r >= 2 && h.r <= 4);
    const nearest = Math.min(...f.buildings.map((b) => toLine([h.wx, h.wy], closed(b.ring))));
    assert.ok(nearest >= h.r + 0.99 && nearest <= 12, `a ${h.sp} ${nearest.toFixed(1)} m from the nearest wall with a ${h.r.toFixed(1)} m patch`);
  }
});

test("deer keep near woods, and the local stars turn up only where they belong", async () => {
  // A wood in the north half of the chunk, open ground in the south: deer along its edge.
  const elev = await ready();
  const f = empty();
  f.areas.push({ id: 1, cls: "forest", rings: [sq(-0.1, -0.1, 1.1, 0.5)] }, { id: 2, cls: "grass", rings: [sq(-0.1, 0.5, 1.1, 1.1)] });
  const ground = groundClasses(CX, CY, f, elev);
  const homes = placeWild(CX, CY, f, ground, placeTrees(CX, CY, f, ground), elev);
  const deer = homes.filter((h) => h.sp === "deer");
  assert.ok(deer.length >= 1, `deer by the wood (got ${kinds(homes)})`);
  for (const h of deer) assert.ok(h.wy >= CY + 0.5 + h.r / S && (h.wy - CY - 0.5) * S <= 60 + 1e-6, "on the open ground, within 60 m of the trees");
  assert.ok(!homes.some((h) => ["kangaroo", "llama", "camel", "penguin"].includes(h.sp)), "no strangers in Paris");

  assert.deepEqual(localStars(48.86, 2.29), { kangaroo: false, llama: false, camel: false, penguin: false });
  assert.ok(kinds(await wildOn(-35.3, 149.1, "grass")).includes("kangaroo"), "kangaroos on the grass near Canberra");
  assert.ok(!kinds(await wildOn(48.86, 2.29, "grass")).includes("kangaroo"));
  assert.ok(kinds(await wildOn(-13.5, -72, null, 3400)).includes("llama"), "llamas on the high ground near Cusco");
  assert.ok(!kinds(await wildOn(-12, -77, null, 100)).includes("llama"), "but not down at the coast in Lima");
  assert.ok(kinds(await wildOn(25, 30, "sand")).includes("camel"), "camels on Egyptian sand");
  assert.ok(kinds(await wildOn(-45.9, 170.5, "sand")).includes("penguin"), "penguins on a beach near Dunedin");
  assert.deepEqual(kinds(await wildOn(43.5, -1.5, "sand")).filter((k) => k === "camel" || k === "penguin"), [], "a beach in France has neither");
  assert.ok(!kinds(await wildOn(-35.3, 149.1, "grass")).includes("squirrel"), "and Australia has no squirrels");

  // The open sea (water with no outline on the map) has no ducks.
  const cx = Math.floor(lonToX(151.3));
  const cy = Math.floor(latToY(-33.9));
  const sea = empty();
  sea.coast.push([[cx - 0.5, cy + 1.5], [cx - 0.5, cy - 0.5]]); // a coast running north, just west of the chunk: land on its left, so the chunk is sea
  const seaElev = await ready(cx, cy, 0);
  const water = groundClasses(cx, cy, sea, seaElev);
  assert.ok(water.every((c) => c === water[0]) && water[0] !== 0, "the chunk is all sea");
  assert.ok(!placeWild(cx, cy, sea, water, [], seaElev).some((h) => h.sp === "duck"), "no ducks out at sea");

  // Nor on a bay, nor far out on a big lake.
  const big = sqAt(cx, cy, -0.5, -0.5, 1.5, 1.5);
  for (const [salt, shore] of [[true, true], [false, false]]) {
    const lake = empty();
    lake.areas.push({ id: 1, cls: "water", rings: [big], ...(salt ? { salt: true } : {}) });
    if (shore) lake.areas.push({ id: 2, cls: "grass", rings: [sqAt(cx, cy, 0, 0, 1, 0.3)] });
    const g = groundClasses(cx, cy, lake, seaElev);
    assert.ok(!placeWild(cx, cy, lake, g, [], seaElev).some((h) => h.sp === "duck"), salt ? "no ducks on a bay" : "no ducks in the middle of a big lake");
  }
});

test("the limits for wild animals hold in a chunk packed with homes, and a flock flies over about half the chunks", async () => {
  const elev = await ready();
  const f = empty();
  f.areas.push({ id: 1, cls: "grass", rings: [sq(-0.1, -0.1, 1.1, 1.1)] });
  const side = 7 / S;
  for (let j = 0; j < 22; j++) for (let i = 0; i < 22; i++) f.buildings.push({ id: 9000 + j * 22 + i, ring: sq(0.02 + i * 0.044, 0.02 + j * 0.044, 0.02 + i * 0.044 + side, 0.02 + j * 0.044 + side), height: 6, kind: "house" });
  const ground = groundClasses(CX, CY, f, elev);
  const homes = placeWild(CX, CY, f, ground, placeTrees(CX, CY, f, ground), elev);
  const others = homes.filter((h) => h.sp !== "bird");
  assert.ok(others.length > 20 && others.length <= WILD_HOME_CAP + MORE_HOME_CAP, `${others.length} homes`);
  assert.ok(others.reduce((n, h) => n + h.n, 0) <= WILD_CREATURE_CAP + MORE_CREATURE_CAP);

  let flocks = 0;
  for (let i = 0; i < 200; i++) {
    const birds = (await wildOn(48.86, 2.29 + i * 0.0055, null)).filter((h) => h.sp === "bird");
    assert.ok(birds.length <= 1);
    for (const b of birds) assert.ok(b.n >= 5 && b.n <= 9 && b.r >= 35 && b.r <= 70);
    flocks += birds.length;
  }
  assert.ok(flocks > 70 && flocks < 130, `${flocks} flocks over 200 chunks`);
});

test("every animal has a figure, a way of moving, and a voice the browser can make", async () => {
  assert.deepEqual(Object.keys(RIGS).sort(), Object.keys(SPECIES).sort());
  const sounds = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../public/js/sounds.js", import.meta.url), "utf8"));
  for (const [name, rig] of Object.entries(RIGS)) {
    assert.ok(rig.parts.length >= 5 && rig.coats.length >= 1, `${name} is drawn`);
    for (const voice of [rig.voice, rig.alarm]) if (voice) assert.ok(sounds.includes(`\n  ${voice}(ctx, out, t0, p) {`), `${name} says ${voice}`);
    assert.equal(!!rig.voice, SPECIES[name].call > 0, `${name}: a voice exactly when it calls`);
  }
});

test("the browser's hash is the server's hash", () => {
  for (const [a, b] of [[0, 0], [1, 2], [-5, 99], [0xffffffff, 7], [123456789, 987654321]]) assert.equal(clientHash(a, b), hash32(a, b));
});

test("animals stay in their circle, keep to a walking pace, and are the same for everyone", () => {
  const t0 = 1_795_000_000;
  for (const sp of Object.keys(SPECIES).filter((k) => !SPECIES[k].fly && !SPECIES[k].lap)) {
    for (const r of [2, 3, 8, 22]) {
      const home = { id: hash32(r, sp.length), sp, n: 6, r };
      for (let k = 0; k < home.n; k++) {
        let last = creatureAt(home, k, t0);
        let walked = 0;
        let stood = 0;
        for (let i = 1; i <= 6000; i++) {
          const now = creatureAt(home, k, t0 + i * 0.1);
          assert.ok(Math.hypot(now.x, now.y) <= r + 1e-9, `${sp} left its circle`);
          const speed = Math.hypot(now.x - last.x, now.y - last.y) / 0.1;
          assert.ok(speed <= 3.8 * SPECIES[sp].pace + 0.1, `${sp} moved at ${speed.toFixed(1)} m/s`);
          assert.ok(now.moving || last.moving || speed < 1e-9, "a standing animal does not slide");
          if (now.moving) walked++; else stood++;
          assert.equal(now.id, memberId(home.id, k));
          assert.equal(now.alt, 0);
          last = now;
        }
        assert.ok(walked > 0 && stood > 0, `${sp} stands and walks`);
      }
      // Asked twice, or by two players, the answer is the same to the last digit.
      assert.deepEqual(creatureAt(home, 2, t0 + 123.456), creatureAt({ ...home }, 2, t0 + 123.456));
      // A clock that is a tenth of a second out moves an animal by well under a metre.
      const a = creatureAt(home, 1, t0 + 500);
      const b = creatureAt(home, 1, t0 + 500.1);
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 0.7);
    }
  }
});

test("a flock circles its home in a loose V, well above the roofs, the same for everyone", () => {
  const t0 = 1_795_000_000;
  for (const r of [35, 52, 70]) {
    const home = { id: hash32(r, 77), sp: "bird", n: 9, r };
    let turned = 0;
    let last = creatureAt(home, 0, t0);
    for (let i = 1; i <= 3000; i++) {
      const t = t0 + i * 0.1;
      const lead = creatureAt(home, 0, t);
      assert.ok(lead.alt >= 29 && lead.alt <= 53, `flying at ${lead.alt.toFixed(0)} m`);
      const speed = Math.hypot(lead.x - last.x, lead.y - last.y) / 0.1;
      assert.ok(speed > 4 && speed < 14, `the leader flies at ${speed.toFixed(1)} m/s`);
      turned += Math.abs(((lead.yaw - last.yaw + 540) % 360) - 180);
      for (let k = 1; k < home.n; k++) {
        const bird = creatureAt(home, k, t);
        const gap = Math.hypot(bird.x - lead.x, bird.y - lead.y);
        assert.ok(gap > 1.5 && gap < 14, `bird ${k} is ${gap.toFixed(1)} m from the leader`);
        assert.ok(Math.hypot(bird.x, bird.y) <= r + 4, "the flock stays over its home");
      }
      last = lead;
    }
    assert.ok(turned > 360, "it comes round again within five minutes");
    assert.deepEqual(creatureAt(home, 4, t0 + 9.87), creatureAt({ ...home }, 4, t0 + 9.87));
  }
});

test("members of a herd are different animals in different places", () => {
  const home = { id: 4242, sp: "sheep", n: 8, r: 15 };
  const at = Array.from({ length: home.n }, (_, k) => creatureAt(home, k, 1_795_000_000));
  assert.equal(new Set(at.map((a) => a.id)).size, home.n);
  for (let i = 0; i < at.length; i++) for (let j = i + 1; j < at.length; j++) assert.ok(Math.hypot(at[i].x - at[j].x, at[i].y - at[j].y) > 0.05);
});

test("animals with a voice call now and then, at a moment everyone agrees on", () => {
  for (const sp of Object.keys(SPECIES)) {
    const id = memberId(77, 3);
    let calls = 0;
    for (let slot = 600_000_000; slot < 600_003_000; slot++) {
      const at = callTime(id, sp, slot);
      if (at === null) continue;
      calls++;
      assert.ok(at >= slot * CALL_SLOT && at < (slot + 1) * CALL_SLOT);
      assert.equal(callTime(id, sp, slot), at);
    }
    if (SPECIES[sp].call === 0) {
      assert.equal(calls, 0, `a ${sp} is silent`);
      continue;
    }
    const expected = 3000 / SPECIES[sp].call;
    assert.ok(calls > expected * 0.6 && calls < expected * 1.5, `${sp} called ${calls} times, about ${expected.toFixed(0)} expected`);
  }
});

test("many more animals, each where it belongs", async () => {
  const has = (homes: Home[], ...any: string[]): boolean => homes.some((h) => any.includes(h.sp));
  // Grass in Paris: insects, and nothing from another continent.
  const paris = await wildOn(48.86, 2.29, "grass");
  assert.ok(has(paris, "butterfly") && has(paris, "bee", "grasshopper", "ladybird", "snail", "ant"), `insects on the grass (got ${kinds(paris)})`);
  assert.ok(!has(paris, "elephant", "giraffe", "zebra", "lion", "monkey", "panda", "koala", "bison", "reindeer", "capybara", "flamingo", "seal"), "no strangers");
  // The Serengeti.
  const plains = await wildOn(-2.3, 34.8, "grass");
  assert.ok(has(plains, "zebra") && has(plains, "giraffe", "elephant", "lion"), `the big animals of the plains (got ${kinds(plains)})`);
  assert.ok(has(await wildOn(44.5, -103.5, "grass"), "bison"), "bison in South Dakota");
  assert.ok(has(await wildOn(68.5, 23.6, "grass"), "reindeer"), "reindeer in Lapland");
  assert.ok(!has(await wildOn(68.5, 23.6, "grass"), "butterfly", "bee", "grasshopper", "ladybird", "ant", "snail"), "and no insects that far north");
  assert.ok(has(await wildOn(46.5, 8, "grass", 1900), "marmot") && !has(await wildOn(46.5, 8, "grass", 500), "marmot"), "marmots high in the Alps, not down in the valley");
  // Beaches: crabs and gulls anywhere, seals in the cold, flamingos in the warm.
  assert.ok(has(await wildOn(43.5, -1.5, "sand"), "crab") && has(await wildOn(43.5, -1.5, "sand"), "seagull"), "crabs and gulls on a French beach");
  assert.ok(has(await wildOn(57.2, -6.2, "sand"), "seal") && !has(await wildOn(25, 30, "sand"), "seal"), "seals on Skye, not in Egypt");
  assert.ok(has(await wildOn(12.2, -68.3, "sand"), "flamingo") && !has(await wildOn(57.2, -6.2, "sand"), "flamingo"), "flamingos on Bonaire, not on Skye");
  assert.ok(has(await wildOn(48.86, 2.29, "urban"), "sparrow"), "sparrows in town");

  // A wood beside open ground: a fox in Europe, a panda in Sichuan, monkeys in the tropics.
  const edge = async (lat: number, lon: number): Promise<Home[]> => {
    const cx = Math.floor(lonToX(lon)), cy = Math.floor(latToY(lat));
    const elev = await ready(cx, cy, 40);
    const f = empty();
    f.areas.push({ id: 1, cls: "forest", rings: [sqAt(cx, cy, -0.1, -0.1, 1.1, 0.5)] }, { id: 2, cls: "grass", rings: [sqAt(cx, cy, -0.1, 0.5, 1.1, 1.1)] });
    const ground = groundClasses(cx, cy, f, elev);
    return placeWild(cx, cy, f, ground, placeTrees(cx, cy, f, ground), elev);
  };
  let foxes = 0, pandas = 0, monkeys = 0;
  for (let i = 0; i < 6; i++) {
    foxes += (await edge(48.86, 2.29 + i * 0.006)).filter((h) => h.sp === "fox").length;
    pandas += (await edge(30.7, 103.9 + i * 0.006)).filter((h) => h.sp === "panda").length;
    monkeys += (await edge(-3.1, -60 + i * 0.006)).filter((h) => h.sp === "monkey").length;
  }
  assert.ok(foxes >= 1 && pandas >= 1 && monkeys >= 1, `${foxes} foxes, ${pandas} pandas, ${monkeys} monkeys`);

  // A pond with grass round it: frogs or a heron on the bank, a swan, an otter or dragonflies on the water.
  const cx = Math.floor(lonToX(4.7)), cy = Math.floor(latToY(52));
  const elev = await ready(cx, cy, 40);
  const f = empty();
  f.areas.push({ id: 1, cls: "grass", rings: [sqAt(cx, cy, -0.1, -0.1, 1.1, 1.1)] }, { id: 2, cls: "water", rings: [sqAt(cx, cy, 0.3, 0.3, 0.7, 0.7)] });
  const ground = groundClasses(cx, cy, f, elev);
  const pond = placeWild(cx, cy, f, ground, [], elev);
  assert.ok(has(pond, "frog", "heron", "beaver") && has(pond, "swan", "otter", "dragonfly"), `life in and round the pond (got ${kinds(pond)})`);
  assert.ok(has(pond, "duck"), "and the ducks are still there");

  const fauna = localFauna(48.86, 2.29);
  assert.deepEqual([fauna.savanna, fauna.koala, fauna.reindeer, fauna.hedgehog, fauna.marmot], [false, false, false, true, true]);
  assert.ok(localFauna(-27.5, 153).koala && !localFauna(-27.5, 153).monkey && !localFauna(-27.5, 153).hedgehog, "koalas in Queensland, and neither monkeys nor hedgehogs");
});

test("every animal can be talked to, and whatever can be ridden can be told where to go", () => {
  for (const name of Object.keys(RIGS)) {
    if (name === "bird") continue; // the flock overhead is out of earshot
    assert.ok(TALKABLE.has(name), `${name} has a name and a character`);
  }
  assert.ok(Object.keys(RIGS).length >= 55, `${Object.keys(RIGS).length} kinds of animal and machine`);
  for (const [name, mount] of Object.entries(MOUNTS)) {
    if (["boat", "sailboat", "train"].includes(name)) continue;
    assert.ok(deedsOf(name).includes("goto"), `a ${name} can take its rider somewhere`);
    assert.ok((mount as { seat: number }).seat > 0.2);
  }
});
