import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChunkMesh } from "../src/chunk.ts";
import { Elevation } from "../src/elevation.ts";
import { metersPerTile } from "../src/geo.ts";
import type { Features } from "../src/osm.ts";
import { houseStyle, STYLES, TEMPERATE, type HouseStyle } from "../src/styles.ts";

const CX = 33185;
const CY = 22545;
const GROUND = 40;
const S = metersPerTile(CY + 0.5);
const d = (metres: number): number => metres / S;

/** Level ground, so a wall's height is just how far its top is above `GROUND`. */
const level = (): Elevation => new Elevation(async () => new Float32Array(256 * 256).fill(GROUND));

async function build(f: Features, look: HouseStyle) {
  const elev = level();
  await elev.ensure(CX - 0.5, CY - 0.5, CX + 1.5, CY + 1.5);
  return buildChunkMesh(CX, CY, f, elev, look);
}

type Extra = Partial<Features["buildings"][number]>;

/** Twelve houses, 10 m by 6 m, well apart along the south side of a street. */
function street(extra: Extra = { height: 7.5, guessed: true }): Features {
  const buildings = Array.from({ length: 12 }, (_, i) => {
    const west = CX + 0.2 + d(i * 16);
    const north = CY + 0.5;
    const ring: [number, number][] = [[west, north], [west + d(10), north], [west + d(10), north + d(6)], [west, north + d(6)]];
    return { id: i + 1, ring, ...extra };
  });
  const roads = [{ id: 900, cls: "road" as const, width: 6, pts: [[CX + 0.1, CY + 0.5 - d(12)], [CX + 0.9, CY + 0.5 - d(12)]] as [number, number][] }];
  return { buildings, roads, areas: [], trees: [], addresses: [], coast: [] } as Features;
}

/** Buildings `side` metres square on a grid `pitch` metres apart, over the chunk and a way beyond it. */
function packed(side: number, pitch: number, extra: Extra = { height: 7.5, guessed: true }): Features {
  const buildings: Features["buildings"] = [];
  let id = 1;
  for (let j = -6; (j + 1) * pitch < S + 110; j++) {
    for (let i = -6; (i + 1) * pitch < S + 110; i++) {
      const west = CX + d(i * pitch + 1), north = CY + d(j * pitch + 1);
      buildings.push({ id: id++, ring: [[west, north], [west + d(side), north], [west + d(side), north + d(side)], [west, north + d(side)]], ...extra } as Features["buildings"][number]);
    }
  }
  return { buildings, roads: [], areas: [], trees: [], addresses: [], coast: [] } as Features;
}

type Mesh = Awaited<ReturnType<typeof build>>;
const heights = (m: Mesh, lo: number, hi: number): number[] => m.sections.filter((s) => s.mat.id >= lo && s.mat.id <= hi).flatMap((s) => s.pos.filter((_, i) => i % 3 === 2));
const colours = (m: Mesh, lo: number, hi: number): Set<number> => new Set(m.sections.filter((s) => s.mat.id >= lo && s.mat.id <= hi).map((s) => s.mat.color >>> 8));
const verts = (m: Mesh, id: number): number => m.sections.filter((s) => s.mat.id === id).reduce((n, s) => n + s.count, 0);

/** How tall each building of a `packed` grid came out, for those well inside the chunk. */
function wallTops(m: Mesh, pitch: number): number[] {
  const tops = new Map<string, number>();
  for (const s of m.sections.filter((x) => x.mat.id >= 20 && x.mat.id <= 23)) {
    for (let i = 0; i < s.pos.length; i += 3) {
      const e = s.pos[i], n = -s.pos[i + 1];
      if (e < 40 || n < 40 || e > S - 40 || n > S - 40) continue;
      const key = `${Math.floor((e - 0.5) / pitch)}/${Math.floor((n - 0.5) / pitch)}`;
      tops.set(key, Math.max(tops.get(key) ?? -Infinity, s.pos[i + 2] - GROUND));
    }
  }
  return [...tops.values()];
}

test("each part of the world has its own style of house", () => {
  const places: [string, number, number, number, string][] = [
    ["London", 51.51, -0.13, 20, "england"], ["Edinburgh", 55.95, -3.19, 60, "scotland"], ["Galway", 53.27, -9.05, 10, "ireland"],
    ["Paris", 48.86, 2.35, 40, "paris"], ["Lyon", 45.76, 4.83, 170, "france"], ["Marseille", 43.3, 5.37, 20, "south of france"],
    ["Amsterdam", 52.37, 4.9, 0, "lowlands"], ["Gouda", 52.01, 4.71, 0, "lowlands"], ["Copenhagen", 55.68, 12.57, 5, "denmark"],
    ["Berlin", 52.52, 13.4, 35, "central europe"], ["Zermatt", 46.02, 7.75, 1600, "alpine"], ["Zurich", 47.37, 8.54, 410, "central europe"],
    ["Bergen", 60.39, 5.32, 10, "nordic"], ["Reykjavik", 64.15, -21.94, 20, "nordic"],
    ["Florence", 43.77, 11.25, 50, "italy"], ["Palermo", 38.12, 13.36, 15, "italy"], ["Seville", 37.39, -5.99, 10, "iberia"], ["Lisbon", 38.72, -9.14, 30, "iberia"],
    ["Athens", 37.98, 23.73, 70, "balkan"], ["Mykonos", 37.45, 25.33, 10, "aegean"], ["Istanbul", 41.01, 28.98, 40, "balkan"],
    ["Dubai", 25.2, 55.27, 5, "desert"], ["Marrakech", 31.63, -8.0, 460, "desert"], ["Tunis", 36.8, 10.18, 10, "desert"], ["Algiers", 36.75, 3.06, 20, "desert"],
    ["Nairobi", -1.29, 36.82, 1700, "africa"], ["Cape Town", -33.92, 18.42, 20, "south africa"],
    ["Delhi", 28.61, 77.21, 215, "south asia"], ["Kochi", 9.93, 76.27, 5, "south india"], ["Lhasa", 29.65, 91.1, 3650, "himalaya"],
    ["Beijing", 39.9, 116.4, 45, "china"], ["Tokyo", 35.68, 139.69, 40, "japan"], ["Seoul", 37.57, 126.98, 40, "korea"], ["Bangkok", 13.76, 100.5, 2, "south-east asia"],
    ["Sydney", -33.87, 151.21, 20, "australia"], ["Auckland", -36.85, 174.76, 20, "new zealand"],
    ["New York", 40.71, -74.01, 10, "north america"], ["Toronto", 43.65, -79.38, 80, "north america"], ["Santa Fe", 35.69, -105.94, 2190, "pueblo"],
    ["Los Angeles", 34.05, -118.24, 90, "sunbelt"], ["Miami", 25.76, -80.19, 2, "sunbelt"], ["Houston", 29.76, -95.37, 15, "north america"],
    ["Mexico City", 19.43, -99.13, 2240, "mexico"], ["Monterrey", 25.67, -100.3, 540, "mexico"], ["Havana", 23.11, -82.37, 50, "caribbean"],
    ["Rio de Janeiro", -22.91, -43.17, 10, "tropical america"], ["Cusco", -13.53, -71.97, 3400, "andes"], ["Buenos Aires", -34.6, -58.38, 25, "southern cone"],
    ["Moscow", 55.75, 37.62, 150, "temperate"], ["the middle of the Pacific", 0, -150, 0, "temperate"],
  ];
  for (const [name, lat, lon, alt, want] of places) assert.equal(houseStyle(lat, lon, alt).name, want, name);
  assert.ok(new Set(places.map((p) => p[4])).size >= STYLES.length - 1, "nearly every style is somewhere on the list");
});

test("every style has enough of everything for a street of different houses", () => {
  assert.equal(new Set(STYLES.map((s) => s.name)).size, STYLES.length, "no two share a name");
  for (const s of STYLES) {
    const colour = (c: number): boolean => Number.isInteger(c) && c >= 0 && c <= 0xffffff;
    for (const list of [s.paints, s.bricks, s.big, s.roofs, s.doors]) assert.ok(list.every(colour), `${s.name}: colours`);
    assert.ok(new Set(s.paints).size >= 3 && s.big.length >= 3 && new Set(s.roofs).size >= 3 && s.doors.length >= 3, `${s.name}: a choice of paints, roofs and doors`);
    assert.ok(s.brickShare >= 0 && s.brickShare <= 8 && s.bigBrickShare >= 0 && s.bigBrickShare <= 8, `${s.name}: shares of brick`);
    assert.ok(s.bricks.length > 0 || (s.brickShare === 0 && s.bigBrickShare === 0), `${s.name}: brick houses need bricks`);
    assert.ok(s.garden.every((n) => n >= 0) && s.garden[0] + s.garden[1] + s.garden[2] <= 8, `${s.name}: garden edges`);
    assert.ok(s.bungalows >= 0 && s.bungalows <= 5 && s.chimneys >= 0 && s.chimneys <= 5 && s.cityChimneys >= 0 && s.cityChimneys <= 5, `${s.name}: shares of five`);
    for (const [few, most] of [s.town, s.city]) assert.ok(few >= 1 && most >= few && most <= 12, `${s.name}: storeys`);
    assert.ok(s.city[1] >= s.town[1], `${s.name}: a city is no lower than a town`);
    assert.ok(s.pitch >= 0.4 && s.pitch <= 1.6 && s.eaves >= 0.2 && s.eaves <= 1.2, `${s.name}: roof slope and overhang`);
    assert.notEqual(s.roof, "mansard", `${s.name}: mansards are for streets and cities`);
  }
});

test("desert houses are sand-coloured with flat roofs behind a parapet, and a low wall round the garden", async () => {
  const dubai = houseStyle(25.2, 55.27);
  const m = await build(street(), dubai);
  const wallTop = Math.max(...heights(m, 20, 23));
  const roofs = heights(m, 24, 25);
  assert.ok(Math.max(...roofs) < wallTop - 0.3 && Math.min(...roofs) > wallTop - 4.2, "every roof lies flat, below the top of the walls (bungalows and porches lower than two-storey houses)");
  assert.equal(verts(m, 28), 0, "no chimneys");
  assert.equal(verts(m, 32) + verts(m, 33), 0, "no hedges or picket fences");
  const walls = colours(m, 20, 23);
  for (const c of walls) assert.ok([...dubai.paints, ...dubai.bricks].includes(c), "walls in the paints of the place");
  const woodwork = colours(m, 27, 27);
  assert.ok([...walls].some((c) => woodwork.has(c)), "garden walls in the colour of the house");

  const plain = await build(street(), TEMPERATE);
  assert.ok(Math.max(...heights(plain, 24, 25)) > Math.max(...heights(plain, 20, 23)) - 0.01 && verts(plain, 28) > 0, "where roofs are pitched they still are");
});

test("English houses are mostly brick with a chimney each; Italian roofs are low and Nordic ones steep", async () => {
  const england = await build(street(), houseStyle(51.51, -0.13));
  assert.ok(verts(england, 23) > verts(england, 20), "more brick than paint");
  assert.ok(verts(england, 28) >= 11 * 20, "a chimney on nearly every house");

  // The same two-storey house under three skies: how far its ridge stands above its eaves.
  const rise = async (look: HouseStyle): Promise<number> => {
    const m = await build(street({ height: 6 }), look);
    return Math.max(...heights(m, 24, 25)) - (GROUND + 6);
  };
  const [italy, plain, nordic] = [await rise(houseStyle(43.77, 11.25)), await rise(TEMPERATE), await rise(houseStyle(60.39, 5.32))];
  assert.ok(italy < plain - 0.4 && plain < nordic - 0.3, `low ${italy.toFixed(2)}, usual ${plain.toFixed(2)}, steep ${nordic.toFixed(2)}`);

  const florence = await build(street(), houseStyle(43.77, 11.25));
  for (const c of colours(florence, 24, 25)) assert.ok((c >>> 16) > (c & 0xff) + 60, "terracotta roofs");
});

test("where buildings crowd together, homes nobody measured stand as tall as the place builds them", async () => {
  // A city centre: 14 m buildings 18 m apart cover three fifths of the ground.
  const centre = packed(14, 18);
  const paris = houseStyle(48.86, 2.35);
  const p = await build(centre, paris);
  const parisTops = wallTops(p, 18);
  assert.ok(parisTops.length > 100);
  for (const t of parisTops) assert.ok(t > 15.5 && t < 20.5, `a Paris block ${t.toFixed(1)} m tall`); // five or six storeys: 14 m is too narrow for seven
  assert.ok(Math.max(...heights(p, 24, 25)) > GROUND + Math.max(...parisTops) + 1, "mansards rise above the walls");
  for (const c of colours(p, 24, 25)) assert.ok(paris.roofs.includes(c), "in grey zinc");
  for (const c of colours(p, 20, 23)) assert.ok(paris.big.includes(c), "over stone-coloured walls");
  assert.ok(verts(p, 28) > 0, "with chimneys");
  assert.ok(verts(p, 26) > 0 && verts(p, 32) + verts(p, 33) === 0, "street doors, and no front gardens");

  const plainTops = wallTops(await build(centre, TEMPERATE), 18);
  for (const t of plainTops) assert.ok(t > 12.9 && t < 16.6 + 5.2, `four or five storeys elsewhere, under a gable: ${t.toFixed(1)} m`);
  const gulf = await build(centre, houseStyle(25.2, 55.27));
  assert.ok(Math.max(...heights(gulf, 24, 25)) < GROUND + Math.max(...wallTops(gulf, 18)), "flat roofs on a desert city");

  // A built-up street: 10 m houses 16 m apart. Two or three storeys.
  const townTops = wallTops(await build(packed(10, 16), TEMPERATE), 16);
  for (const t of townTops) assert.ok(t > 5.8 && t < 14.2, `a town house ${t.toFixed(1)} m tall`); // gable ends rise into the roof
  assert.ok(Math.max(...townTops) - Math.min(...townTops) > 2.5, "of both heights");

  // Houses standing apart stay houses, and a building somebody measured keeps its height wherever it is.
  for (const t of heights(await build(street(), paris), 20, 23)) assert.ok(t - GROUND < 6.6 + 4, "one or two storeys on an open street");
  const measured = wallTops(await build(packed(14, 18, { height: 6 }), paris), 18);
  for (const t of measured) assert.ok(Math.abs(t - 6) < 0.01, "a measured height is kept");
});
