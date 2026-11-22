// What the map says about a building beyond its outline: its colours, the shape of its roof, a
// height measured to the top, a courtyard, a start above the ground.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChunkMesh, type Section, type SignSpot } from "../src/chunk.ts";
import { Elevation } from "../src/elevation.ts";
import { metersPerTile, xToLon, yToLat } from "../src/geo.ts";
import { parseOsm, signName, trimExtras, useOf, type Building, type Features, type OsmJson } from "../src/osm.ts";
import { colourOf, PAINTS, roofPaint, snapPaint, wallPaint } from "../src/paint.ts";
import { TEMPERATE } from "../src/styles.ts";

const CX = 33185;
const CY = 22545;
const GROUND = 50;
const S = metersPerTile(CY + 0.5);
/** A point so many metres east and south of the middle of the chunk. */
const at = (e: number, s: number): [number, number] => [CX + 0.5 + e / S, CY + 0.5 + s / S];
const rect = (w: number, d: number, e = 0, s = 0): [number, number][] => [at(e, s), at(e + w, s), at(e + w, s + d), at(e, s + d)];

/** Level ground, so heights can be checked to the centimetre. */
async function build(buildings: Building[]): Promise<Section[]> {
  const elev = new Elevation(async () => new Float32Array(256 * 256).fill(GROUND));
  await elev.ensure(CX - 0.5, CY - 0.5, CX + 1.5, CY + 1.5);
  const f: Features = { buildings, roads: [], areas: [], trees: [], addresses: [], coast: [] };
  return buildChunkMesh(CX, CY, f, elev, TEMPERATE).sections;
}
const isWall = (s: Section): boolean => s.mat.id >= 20 && s.mat.id <= 23;
const isRoof = (s: Section): boolean => s.mat.id === 24 || s.mat.id === 25;
const heights = (sections: Section[]): number[] => sections.flatMap((s) => s.pos.filter((_, i) => i % 3 === 2));
const rgba = (hex: number): number => ((hex << 8) | 0xff) >>> 0;

test("mapped colours are read as written and moved to the nearest of our paints", () => {
  assert.equal(colourOf("#377a62"), 0x377a62);
  assert.equal(colourOf("#CCC"), 0xcccccc);
  assert.equal(colourOf("Light Grey"), 0xd3d3d3);
  assert.equal(colourOf("rainbow"), null);
  assert.equal(colourOf(undefined), null);
  for (const text of ["red", "#ff0000", "white", "black", "#1a7fb2", "beige"]) assert.ok(PAINTS.includes(snapPaint(colourOf(text)!)), text);
  assert.equal(snapPaint(0x377a62), 0x377a62, "a paint of ours stays itself");
  const red = snapPaint(colourOf("red")!);
  assert.ok((red >>> 16) > 0x80 && (red & 0xff) < 0x60, "plain red comes out a red");
  assert.deepEqual(wallPaint({ "building:material": "brick" }), { colour: snapPaint(0xa9553f), brick: true });
  assert.deepEqual(wallPaint({ "building:colour": "white", "building:material": "brick" }), { colour: snapPaint(0xffffff), brick: true }, "painted brick is still brick");
  assert.equal(wallPaint({ building: "yes" }), null);
  assert.equal(roofPaint({ "roof:material": "slate" }), snapPaint(0x4f5560));
  assert.equal(roofPaint({ "roof:colour": "rainbow" }), null);
});

test("parseOsm keeps a building's colours, roof, starting height and courtyards", () => {
  const n = (id: number, e: number, s: number) => { const [wx, wy] = at(e, s); return { type: "node" as const, id, lon: xToLon(wx), lat: yToLat(wy) }; };
  const json: OsmJson = {
    elements: [
      n(1, 0, 0), n(2, 10, 0), n(3, 10, 8), n(4, 0, 8),
      { type: "way", id: 100, nodes: [1, 2, 3, 4, 1], tags: { building: "house", height: "9", "building:colour": "#377a62", "roof:colour": "red", "roof:shape": "hipped", "roof:direction": "NE", "roof:orientation": "across", min_height: "3" } },
      // A block round a courtyard: the outline is itself tagged as a building, with the details.
      n(11, 40, 0), n(12, 70, 0), n(13, 70, 30), n(14, 40, 30),
      n(21, 50, 10), n(22, 60, 10), n(23, 60, 20), n(24, 50, 20),
      { type: "way", id: 101, nodes: [11, 12, 13, 14, 11], tags: { building: "apartments", "building:levels": "5", "building:material": "brick" } },
      { type: "way", id: 102, nodes: [21, 22, 23, 24, 21] },
      { type: "relation", id: 300, members: [{ type: "way", ref: 101, role: "outer" }, { type: "way", ref: 102, role: "inner" }], tags: { type: "multipolygon", building: "yes" } },
    ],
  };
  const f = parseOsm(json);
  assert.equal(f.buildings.length, 2, "the outline of the block is not a second building");
  const house = f.buildings.find((b) => b.id === 100)!;
  assert.equal(house.colour, 0x377a62);
  assert.ok(PAINTS.includes(house.roofColour!));
  assert.equal(house.roof, "hipped");
  assert.equal(house.roofDirection, 45);
  assert.equal(house.roofAcross, true);
  assert.equal(house.minHeight, 3);
  assert.equal(house.measured, true);
  assert.equal(house.guessed, undefined);
  const block = f.buildings.find((b) => b.id < 0)!;
  assert.equal(block.holes?.length, 1);
  assert.equal(block.holes![0].length, 4);
  assert.equal(block.brick, true, "what the outline says about itself is kept");
  assert.ok(Math.abs(block.height - (5 * 3.1 + 1.2)) < 1e-9);
  assert.equal(block.measured, undefined, "floors are not a height in metres");
});

test("a building is painted the colour the map gives it, and brick is drawn as brick", async () => {
  const sections = await build([
    { id: 7, ring: rect(10, 6), height: 6, colour: 0x377a62, roofColour: 0x4a7fb5 },
    { id: 8, ring: rect(10, 6, 30, 0), height: 6, colour: 0xf2efe6, brick: true },
  ]);
  const walls = sections.filter(isWall);
  assert.ok(walls.some((s) => s.mat.color === rgba(0x377a62)), "green walls");
  assert.ok(walls.some((s) => s.mat.color === rgba(0xf2efe6) && s.mat.id === 23), "white brick is brick");
  assert.ok(sections.some((s) => isRoof(s) && s.mat.color === rgba(0x4a7fb5)), "a blue roof");
});

test("a height in metres is to the top of the roof", async () => {
  const measured = await build([{ id: 7, ring: rect(10, 6), height: 9, measured: true }]);
  assert.ok(Math.abs(Math.max(...heights(measured.filter(isRoof))) - (GROUND + 9)) < 0.05, "the ridge is 9 m up");
  const floors = await build([{ id: 7, ring: rect(10, 6), height: 9 }]);
  assert.ok(Math.max(...heights(floors.filter(isRoof))) > GROUND + 10.5, "counted in floors, the roof stands on top of that");
  const flat = await build([{ id: 7, ring: rect(10, 6), height: 9, measured: true, roof: "flat" }]);
  assert.ok(Math.abs(Math.max(...heights(flat.filter(isWall))) - (GROUND + 9)) < 0.05, "a flat roof takes nothing off the walls");
});

test("a hipped roof slopes at its ends too, and a pyramid comes to a point", async () => {
  const hipped = await build([{ id: 7, ring: rect(12, 6), height: 6, roof: "hipped" }]);
  const roof = hipped.filter(isRoof);
  assert.equal(roof.reduce((n, s) => n + s.idx.length, 0), 18, "two long slopes and two triangular ends");
  const eaves = GROUND + 6;
  assert.ok(Math.max(...heights(hipped.filter(isWall))) < eaves + 0.01, "no gable ends rise into it");
  const ridge = Math.max(...heights(roof));
  const top = roof.flatMap((s) => s.pos.filter((_, i) => i % 3 === 0 && s.pos[i + 2] > ridge - 0.01));
  assert.ok(Math.max(...top) - Math.min(...top) > 4 && Math.max(...top) - Math.min(...top) < 8, "the ridge is shorter than the house");

  const pyramid = await build([{ id: 7, ring: rect(8, 8), height: 6, roof: "pyramidal" }]);
  const point = pyramid.filter(isRoof);
  const apex = Math.max(...heights(point));
  const tips = new Set(point.flatMap((s) => s.pos.flatMap((v, i) => (i % 3 === 2 && v > apex - 0.01 ? [`${s.pos[i - 2].toFixed(2)},${s.pos[i - 1].toFixed(2)}`] : []))));
  assert.equal(tips.size, 1, "one point at the top");
  assert.equal(point.reduce((n, s) => n + s.idx.length, 0), 12, "four triangles");
});

test("a skillion roof is one slope, facing the way the map says, with the walls carried up to it", async () => {
  // Facing east: low on the east wall, high on the west.
  const sections = await build([{ id: 7, ring: rect(10, 6), height: 5, roof: "skillion", roofDirection: 90 }]);
  const roof = sections.filter(isRoof);
  let east = 0, west = 0;
  for (const s of roof) for (let i = 0; i < s.pos.length; i += 3) { if (s.pos[i] === Math.max(...s.pos.filter((_, k) => k % 3 === 0))) east = s.pos[i + 2]; if (s.pos[i] === Math.min(...s.pos.filter((_, k) => k % 3 === 0))) west = s.pos[i + 2]; }
  assert.ok(west > east + 0.7, "it falls to the east");
  for (const s of roof) for (let i = 0; i < s.nrm.length; i += 3) assert.ok(s.nrm[i] > 0.05 && s.nrm[i + 2] > 0.8, "and faces east and up");
  assert.ok(Math.abs(Math.max(...heights(sections.filter(isWall))) - west) < 0.01, "the high wall reaches the roof");
});

test("domes and onion domes are round, and face outwards all the way up", async () => {
  // A sixteen-sided drum, 10 m across.
  const ring: [number, number][] = Array.from({ length: 16 }, (_, k) => at(20 + 5 * Math.cos((k * Math.PI) / 8), 20 + 5 * Math.sin((k * Math.PI) / 8)));
  for (const shape of ["dome", "onion", "cone"]) {
    const sections = await build([{ id: 7, ring, height: 8, roof: shape }]);
    const roof = sections.filter(isRoof);
    const z = heights(roof);
    assert.ok(Math.max(...z) > GROUND + 8 + 3, `${shape}: it rises well above the walls`);
    let mx = 0, my = 0, count = 0;
    for (const s of sections.filter(isWall)) for (let i = 0; i < s.pos.length; i += 3) { mx += s.pos[i]; my += s.pos[i + 1]; count++; }
    mx /= count;
    my /= count;
    let under = 0;
    for (const s of roof) {
      for (let i = 0; i < s.idx.length; i += 3) {
        const [a, b, c] = [s.idx[i], s.idx[i + 1], s.idx[i + 2]].map((v) => [s.pos[v * 3], s.pos[v * 3 + 1], s.pos[v * 3 + 2]]);
        // The triangle's own normal, from its winding, agrees with the normal it was given...
        const g = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
        const n = [s.nrm[s.idx[i] * 3], s.nrm[s.idx[i] * 3 + 1], s.nrm[s.idx[i] * 3 + 2]];
        assert.ok(g[0] * n[0] + g[1] * n[1] + g[2] * n[2] > 0, `${shape}: wound to agree with its normal`);
        // ...and that normal points away from the middle of the building.
        const out = n[0] * ((a[0] + b[0] + c[0]) / 3 - mx) + n[1] * ((a[1] + b[1] + c[1]) / 3 - my);
        assert.ok(out > -1e-6, `${shape}: faces outwards`);
        if (n[2] < -0.05) under++;
      }
    }
    assert.equal(under > 0, shape === "onion", `${shape}: only an onion bulges out over its walls`);
  }
});

test("a courtyard is open to the sky, with walls round it", async () => {
  const sections = await build([{ id: 7, ring: rect(30, 30), height: 12, holes: [rect(10, 10, 10, 10)] }]);
  // The middle of the yard in the mesh's own measure: metres east of the chunk's north-west corner, and north of it (so negative).
  const mid = 0.5 * S + 15;
  const midN = -(0.5 * S + 15);
  const covers = (s: Section, e: number, n: number): boolean => {
    for (let i = 0; i < s.idx.length; i += 3) {
      const [a, b, c] = [s.idx[i], s.idx[i + 1], s.idx[i + 2]].map((v) => [s.pos[v * 3], s.pos[v * 3 + 1]]);
      const d1 = (e - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (n - b[1]);
      const d2 = (e - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (n - c[1]);
      const d3 = (e - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (n - a[1]);
      if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return true;
    }
    return false;
  };
  const roof = sections.filter(isRoof);
  assert.ok(!roof.some((s) => covers(s, mid, midN)), "no roof over the yard");
  assert.ok(roof.some((s) => covers(s, mid - 10, midN)), "roof over the building beside it");
  // Walls round the yard face into it: within 5.1 m of its middle, pointing at the middle.
  let inward = 0;
  for (const s of sections.filter(isWall)) {
    for (let i = 0; i < s.pos.length; i += 3) {
      const de = mid - s.pos[i], dn = midN - s.pos[i + 1];
      if (Math.max(Math.abs(de), Math.abs(dn)) > 5.1) continue;
      assert.ok(s.nrm[i] * de + s.nrm[i + 1] * dn > 0, "a yard wall faces the yard");
      inward++;
    }
  }
  assert.equal(inward, 16, "four walls of four corners each");
});

test("a building mapped as starting above the ground stands clear of it, and has no front door", async () => {
  const sections = await build([{ id: 7, ring: rect(10, 6), height: 9, minHeight: 4, roof: "flat" }]);
  const walls = sections.filter(isWall);
  assert.ok(Math.abs(Math.min(...heights(walls)) - (GROUND + 4)) < 0.01, "its walls start 4 m up");
  assert.ok(walls.some((s) => s.nrm.some((v, i) => i % 3 === 2 && v < -0.9)), "it has an underside");
  assert.ok(!sections.some((s) => s.mat.id === 26), "no door");
  const grounded = await build([{ id: 7, ring: rect(10, 6), height: 9, roof: "flat" }]);
  assert.ok(Math.min(...heights(grounded.filter(isWall))) < GROUND, "an ordinary building goes into the ground");
});

test("the pieces of a building mapped in 3D go to the building they stand in, with the named places", () => {
  const n = (id: number, e: number, s: number, tags?: Record<string, string>) => { const [wx, wy] = at(e, s); return { type: "node" as const, id, lon: xToLon(wx), lat: yToLat(wy), ...(tags ? { tags } : {}) }; };
  const json: OsmJson = {
    elements: [
      n(1, 0, 0), n(2, 20, 0), n(3, 20, 20), n(4, 0, 20),
      { type: "way", id: 100, nodes: [1, 2, 3, 4, 1], tags: { building: "yes", height: "60" } },
      n(11, 40, 0), n(12, 50, 0), n(13, 50, 10), n(14, 40, 10),
      { type: "way", id: 101, nodes: [11, 12, 13, 14, 11], tags: { building: "yes", "building:part": "yes" } },
    ],
  };
  const extra = trimExtras({
    elements: [
      n(1, 0, 0), n(2, 20, 0), n(3, 20, 20), n(4, 0, 20),
      n(5, 5, 5), n(6, 15, 5), n(7, 15, 15), n(8, 5, 15),
      { type: "way", id: 200, nodes: [1, 2, 3, 4, 1], tags: { "building:part": "yes", "building:levels": "3", "building:colour": "white" } },
      { type: "way", id: 201, nodes: [5, 6, 7, 8, 5], tags: { "building:part": "yes", height: "60", min_height: "40", "roof:shape": "pyramidal", "roof:height": "10" } },
      // The second building is its own piece and nothing more: that is no 3D model.
      n(11, 40, 0), n(12, 50, 0), n(13, 50, 10), n(14, 40, 10),
      { type: "way", id: 101, nodes: [11, 12, 13, 14, 11], tags: { "building:part": "yes" } },
      // A piece standing in no building is a building of that one piece.
      n(21, 80, 80), n(22, 90, 80), n(23, 90, 90), n(24, 80, 90),
      { type: "way", id: 202, nodes: [21, 22, 23, 24, 21], tags: { "building:part": "yes", height: "9" } },
      n(31, 3, 3, { name: " Tower Café ", amenity: "cafe", cuisine: "coffee", phone: "1234" }),
      n(32, 4, 4, { amenity: "bench" }),
    ],
  });
  const cafe = extra.elements.find((el) => el.id === 31)!;
  assert.deepEqual(cafe.tags, { name: "Tower Café", amenity: "cafe" }, "a place keeps its name and what it is, and nothing else");
  assert.equal(extra.elements.find((el) => el.id === 32)!.tags, undefined, "a bench is only a point");
  const f = parseOsm(json, extra);
  const tower = f.buildings.find((b) => b.id === 100)!;
  assert.deepEqual(tower.parts?.map((p) => p.id), [200, 201]);
  const [podium, spire] = tower.parts!;
  assert.ok(Math.abs(podium.height - (3 * 3.1 + 1.2)) < 1e-9);
  assert.equal(podium.storeys, true);
  assert.ok(PAINTS.includes(podium.colour!));
  assert.equal(spire.height, 60);
  assert.equal(spire.minHeight, 40);
  assert.equal(spire.roof, "pyramidal");
  assert.equal(spire.measured, true);
  assert.equal(f.buildings.find((b) => b.id === 101)!.parts, undefined);
  const alone = f.buildings.find((b) => b.parts?.[0]?.id === 202)!;
  assert.equal(alone.height, 9);
  assert.equal(f.buildings.length, 3);
  assert.deepEqual(f.places?.map((p) => [p.name, p.kind]), [["Tower Café", "amenity=cafe"]]);
});

test("a building mapped in 3D is drawn from its pieces: a podium with windows, and a spire that starts in mid-air", async () => {
  const sections = await build([{
    id: 7, ring: rect(20, 20), height: 60,
    parts: [
      { id: 200, ring: rect(20, 20), height: 10.5, storeys: true, colour: 0xf2efe6 },
      { id: 201, ring: rect(4, 4, 8, 8), height: 60, minHeight: 40, measured: true, roof: "pyramidal", roofHeight: 10 },
    ],
  }]);
  const plain = sections.filter((s) => s.mat.id === 29);
  assert.equal(plain.length, 1, "the spire has no windows");
  const z = heights(plain);
  assert.ok(Math.abs(Math.min(...z) - (GROUND + 40)) < 0.01, "it starts 40 m up");
  assert.ok(Math.abs(Math.max(...z) - (GROUND + 50)) < 0.01, "its walls stop where its roof begins");
  assert.ok(plain[0].nrm.some((v, i) => i % 3 === 2 && v < -0.9), "and it has an underside");
  assert.ok(Math.abs(Math.max(...heights(sections.filter(isRoof))) - (GROUND + 60)) < 0.01, "the point of its roof is 60 m up");
  const podium = sections.filter((s) => isWall(s) && s.mat.color === rgba(0xf2efe6));
  assert.equal(podium.length, 1, "the podium is a wall with windows, in its own paint");
  assert.ok(Math.abs(Math.max(...heights(podium)) - (GROUND + 10.5)) < 0.01);
  assert.ok(Math.max(...heights(sections.filter(isWall))) < GROUND + 11, "nothing is drawn of the outline's own 60 m");
  assert.ok(!sections.some((s) => s.mat.id === 26), "no front door");
});

test("what a building is, and what it is called, come from its own tags or from the one named place inside it", () => {
  assert.equal(useOf({ amenity: "place_of_worship" }), "church");
  assert.equal(useOf({ amenity: "place_of_worship", religion: "muslim" }), "mosque");
  assert.equal(useOf({ building: "temple" }), "temple");
  assert.equal(useOf({ shop: "bakery" }), "shop");
  assert.equal(useOf({ shop: "vacant" }), null);
  assert.equal(useOf({ amenity: "cafe" }), "food");
  assert.equal(useOf({ building: "school" }), "school");
  assert.equal(useOf({ amenity: "fuel" }), "fuel");
  assert.equal(useOf({ amenity: "clinic" }), "hospital");
  assert.equal(useOf({ building: "house" }), null);
  assert.equal(signName("  Saint   Mary's  "), "Saint Mary's");
  assert.equal(signName(""), null);
  assert.equal(signName("The Very Long Name Of A Shop That Goes On And On"), "The Very Long Name Of A Shop");

  const n = (id: number, e: number, s: number, tags?: Record<string, string>) => { const [wx, wy] = at(e, s); return { type: "node" as const, id, lon: xToLon(wx), lat: yToLat(wy), ...(tags ? { tags } : {}) }; };
  const json: OsmJson = {
    elements: [
      n(1, 0, 0), n(2, 10, 0), n(3, 10, 8), n(4, 0, 8),
      { type: "way", id: 100, nodes: [1, 2, 3, 4, 1], tags: { building: "church", name: "Saint Mary's" } },
      n(11, 30, 0), n(12, 40, 0), n(13, 40, 8), n(14, 30, 8),
      { type: "way", id: 101, nodes: [11, 12, 13, 14, 11], tags: { building: "yes" } },
    ],
  };
  const extra = trimExtras({ elements: [n(31, 35, 4, { name: "Corner Café", amenity: "cafe" }), n(32, 36, 5, { name: "Another", shop: "books" }), n(33, 5, 4, { name: "Parish Office", office: "religion" })] });
  const f = parseOsm(json, extra);
  const church = f.buildings.find((b) => b.id === 100)!;
  assert.deepEqual([church.name, church.use], ["Saint Mary's", "church"], "its own name stays");
  const cafe = f.buildings.find((b) => b.id === 101)!;
  assert.deepEqual([cafe.name, cafe.use], ["Corner Café", "food"], "the first place named in it names it");
});

test("a church has a tower, a shop a shopfront, and a named building a sign on its front wall", async () => {
  const elev = new Elevation(async () => new Float32Array(256 * 256).fill(GROUND));
  await elev.ensure(CX - 0.5, CY - 0.5, CX + 1.5, CY + 1.5);
  const f: Features = {
    buildings: [
      { id: 7, ring: rect(20, 10), height: 9, roof: "flat", name: "Saint Mary's", use: "church" },
      { id: 8, ring: rect(12, 8, 60, 0), height: 6, roof: "flat", name: "Corner Café", use: "food" },
      { id: 9, ring: rect(12, 8, 100, 0), height: 6, roof: "flat", use: "school" },
      { id: 10, ring: rect(30, 12, 0, 60), height: 12, roof: "flat", name: "City Hospital", use: "hospital" },
      { id: 11, ring: rect(10, 8, 60, 60), height: 6, roof: "flat" },
    ],
    roads: [], areas: [], trees: [], addresses: [], coast: [],
  };
  const signs: SignSpot[] = [];
  const sections = buildChunkMesh(CX, CY, f, elev, TEMPERATE, undefined, signs).sections;
  assert.deepEqual(signs.map((s) => s.text).sort(), ["City Hospital", "Corner Café", "Saint Mary's"], "one sign for each name, none for the nameless");
  for (const s of signs) {
    assert.ok(s.z > GROUND + 2 && s.z < GROUND + 4, "at about door-top height");
    assert.ok(s.width >= 1.6 && s.width <= 9);
    assert.ok(Math.abs(Math.hypot(s.out[0], s.out[1]) - 1) < 1e-9);
  }
  assert.ok(Math.max(...heights(sections.filter(isWall))) > GROUND + 9 + 4.9, "the church tower stands well above its roof");
  assert.ok(Math.max(...heights(sections.filter(isRoof))) > GROUND + 9 + 8, "and has a spire");
  const awnings = [0xb8372b, 0x2f5d3a, 0x2e4a6e, 0xe8c84a, 0x8f3a2e, 0x377a62].map(rgba);
  assert.ok(sections.some((s) => s.mat.id === 27 && awnings.includes(s.mat.color)), "the café has an awning");
  assert.ok(sections.some((s) => s.mat.id === 26 && s.mat.color === rgba(0x9fc3d6)), "and a shop window");
  assert.ok(sections.some((s) => s.mat.id === 26 && s.mat.color === rgba(0xd0302a)), "the hospital has a red cross (or the school a red flag)");
  assert.ok(Math.max(...heights(sections.filter((s) => s.mat.id === 27 && s.mat.color === rgba(0xb9bec4)))) > GROUND + 6.9, "the school has a flagpole");
});
