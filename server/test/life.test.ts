import { test } from "node:test";
import assert from "node:assert/strict";
import { groundClasses } from "../src/chunk.ts";
import { Elevation } from "../src/elevation.ts";
import { hash32, metersPerTile, xToLon, yToLat } from "../src/geo.ts";
import { buildLabels } from "../src/labels.ts";
import { CREATURE_CAP, HOME_CAP, placeHomes } from "../src/life.ts";
import { fieldOf, parseOsm, type Features, type OsmJson, type Pt } from "../src/osm.ts";
import { callTime, CALL_SLOT, creatureAt, hash32 as clientHash, memberId, SPECIES } from "../public/js/lifemotion.js";

const CX = 33185;
const CY = 22545;
const S = metersPerTile(CY + 0.5);

function flat(): Elevation {
  return new Elevation(async () => new Float32Array(256 * 256).fill(40));
}
async function ready(): Promise<Elevation> {
  const elev = flat();
  await elev.ensure(CX - 0.5, CY - 0.5, CX + 1.5, CY + 1.5);
  return elev;
}
const sq = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[CX + x0, CY + y0], [CX + x1, CY + y0], [CX + x1, CY + y1], [CX + x0, CY + y1]];
const empty = (): Features => ({ buildings: [], roads: [], areas: [], trees: [], addresses: [], coast: [], fields: [] });
const metres = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]) * S;

/** Distance in metres from a point to the nearest part of a line. */
function toLine(p: Pt, pts: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    best = Math.min(best, Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t) * S);
  }
  return best;
}

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
    assert.ok(toLine(p, [...barn, barn[0]]) >= h.r + 2.9, "and off the barn");
    assert.ok(toLine(p, [...sq(0.6, 0.6, 0.8, 0.8), [CX + 0.6, CY + 0.6]]) >= h.r, "and out of the pond");
    if (h.sp !== "chicken") assert.ok(toLine(p, [...meadow, meadow[0]]) >= h.r - 1e-6, "and inside the field");
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
  assert.ok(homes.length >= 5);
  for (const h of homes) {
    assert.equal(h.sp, "cow");
    assert.ok(Number.isInteger(h.id) && h.id! > 0 && h.id! <= 0xffffffff);
    assert.ok(h.n! >= 2 && h.r! >= 7 && h.u >= 0 && h.u < 1 && h.v >= 0 && h.v < 1);
    assert.ok(Math.abs(h.h - elev.surfaceHeight(CX + h.u, CY + h.v)) < 1e-6);
    assert.equal(h.text, undefined, "older games skip an item with no text");
  }
});

test("the browser's hash is the server's hash", () => {
  for (const [a, b] of [[0, 0], [1, 2], [-5, 99], [0xffffffff, 7], [123456789, 987654321]]) assert.equal(clientHash(a, b), hash32(a, b));
});

test("animals stay in their circle, keep to a walking pace, and are the same for everyone", () => {
  const t0 = 1_795_000_000;
  for (const sp of Object.keys(SPECIES)) {
    for (const r of [3, 8, 22]) {
      const home = { id: hash32(r, sp.length), sp, n: 6, r };
      for (let k = 0; k < home.n; k++) {
        let last = creatureAt(home, k, t0);
        let walked = 0;
        let stood = 0;
        for (let i = 1; i <= 6000; i++) {
          const now = creatureAt(home, k, t0 + i * 0.1);
          assert.ok(Math.hypot(now.x, now.y) <= r + 1e-9, `${sp} left its circle`);
          const speed = Math.hypot(now.x - last.x, now.y - last.y) / 0.1;
          assert.ok(speed <= 6.5, `${sp} moved at ${speed.toFixed(1)} m/s`);
          assert.ok(now.moving || last.moving || speed < 1e-9, "a standing animal does not slide");
          if (now.moving) walked++; else stood++;
          assert.equal(now.id, memberId(home.id, k));
          last = now;
        }
        assert.ok(walked > 0 && stood > walked, `${sp} mostly stands and sometimes walks`);
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

test("members of a herd are different animals in different places", () => {
  const home = { id: 4242, sp: "sheep", n: 8, r: 15 };
  const at = Array.from({ length: home.n }, (_, k) => creatureAt(home, k, 1_795_000_000));
  assert.equal(new Set(at.map((a) => a.id)).size, home.n);
  for (let i = 0; i < at.length; i++) for (let j = i + 1; j < at.length; j++) assert.ok(Math.hypot(at[i].x - at[j].x, at[i].y - at[j].y) > 0.05);
});

test("animals call now and then, at a moment everyone agrees on", () => {
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
    const expected = 3000 / SPECIES[sp].call;
    assert.ok(calls > expected * 0.6 && calls < expected * 1.5, `${sp} called ${calls} times, about ${expected.toFixed(0)} expected`);
  }
});
