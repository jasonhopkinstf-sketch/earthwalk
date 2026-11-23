// Bridges and tunnels: what the map says about them, the heights worked out for them, and what is drawn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChunkMesh, MATERIALS, type Section } from "../src/chunk.ts";
import { Elevation } from "../src/elevation.ts";
import { metersPerTile, xToLon, yToLat } from "../src/geo.ts";
import { parseOsm, type Features, type OsmJson, type Pt, type Road } from "../src/osm.ts";
import { deckDepth, kitOf, prepareSpans, rampsOf, solveSpans, tubeHeight, type Profile } from "../src/spans.ts";
import { TEMPERATE } from "../src/styles.ts";

const CX = 33184; // an even number, so the chunk is the north-west one of its piece of the map
const CY = 22544;
const S = metersPerTile(CY + 0.5);
/** A point so many metres east and south of the middle of the chunk. */
const at = (e: number, s: number): Pt => [CX + 0.5 + e / S, CY + 0.5 + s / S];
const GROUND = 50;

/** Ground whose height is a function of how many metres east and south of the middle of the chunk a place is. */
async function land(height: (e: number, s: number) => number = () => GROUND, reach = 2): Promise<Elevation> {
  const elev = new Elevation(async (_z, x, y) => {
    const out = new Float32Array(256 * 256);
    for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
      out[j * 256 + i] = height(((x * 256 + i + 0.5) / 32 - CX - 0.5) * S, ((y * 256 + j + 0.5) / 32 - CY - 0.5) * S);
    }
    return out;
  });
  await elev.ensure(CX - reach, CY - reach, CX + 1 + reach, CY + 1 + reach);
  return elev;
}
const road = (id: number, pts: Pt[], more: Partial<Road> = {}): Road => ({ id, cls: "road", width: 7, pts, hw: "secondary", ...more });
const world = (roads: Road[], tunnels: Road[] = []): Features => ({ buildings: [], roads, areas: [], trees: [], addresses: [], coast: [], tunnels });
const profileOf = (f: Features, elev: Elevation, id: number): Profile => solveSpans(kitOf(f), elev).profiles.get(id)!;
const section = (sections: Section[], id: number): Section[] => sections.filter((s) => s.mat.id === id);
const tops = (sections: Section[]): number[] => sections.flatMap((s) => s.pos.filter((_, i) => i % 3 === 2));

test("the map's bridges and tunnels are kept: bridges among the roads, tunnels apart, pipes and corridors not at all", () => {
  let next = 1;
  const nodes: OsmJson["elements"] = [];
  const way = (id: number, tags: Record<string, string>, e = 0): OsmJson["elements"][number] => {
    const ids = [0, 60].map((s) => { const [wx, wy] = at(e, s); nodes.push({ type: "node", id: next, lon: xToLon(wx), lat: yToLat(wy) }); return next++; });
    return { type: "way", id, nodes: ids, tags };
  };
  const ways = [
    way(1, { highway: "primary", bridge: "yes", layer: "2" }),
    way(2, { highway: "footway", bridge: "boardwalk" }, 10),
    way(3, { highway: "motorway", tunnel: "yes", layer: "-1" }, 20),
    way(4, { railway: "rail", tunnel: "yes", layer: "-3" }, 30),
    way(5, { waterway: "stream", tunnel: "culvert", layer: "-1" }, 40),
    way(6, { highway: "footway", tunnel: "building_passage" }, 50),
    way(7, { highway: "corridor", tunnel: "yes", layer: "-2" }, 60),
    way(8, { highway: "footway", layer: "-1" }, 70),
    way(9, { highway: "footway", tunnel: "yes", indoor: "yes" }, 80),
    way(10, { highway: "footway", tunnel: "yes" }, 90),
    way(11, { highway: "residential" }, 100),
  ];
  const f = parseOsm({ elements: [...nodes, ...ways] });
  assert.deepEqual(f.roads.map((r) => r.id).sort((a, b) => a - b), [1, 2, 11]);
  const [big, boards, plain] = [1, 2, 11].map((id) => f.roads.find((r) => r.id === id)!);
  assert.deepEqual([big.bridge, big.layer, big.form], [true, 2, undefined]);
  assert.deepEqual([boards.bridge, boards.layer, boards.form], [true, 1, "boardwalk"], "a bridge with no layer is one up");
  assert.equal(plain.bridge, undefined);
  assert.deepEqual((f.tunnels ?? []).map((r) => [r.id, r.cls, r.layer, r.tunnel]), [[3, "road", -1, true], [4, "rail", -3, true], [10, "path", -1, true]]);
});

test("a bridge runs straight from the ground at one end to the ground at the other, however deep the valley", async () => {
  // A valley 30 m deep and 160 m wide across the middle of the chunk.
  const elev = await land((e) => GROUND - 30 * Math.max(0, 1 - (e / 80) ** 2));
  const f = world([road(1, [at(-140, 0), at(-100, 0)]), road(2, [at(-100, 0), at(100, 0)], { bridge: true, layer: 1 }), road(3, [at(100, 0), at(140, 0)])]);
  const p = profileOf(f, elev, 2);
  assert.deepEqual(p.ends, ["ground", "ground"]);
  assert.ok(Math.abs(p.h[0] - GROUND) < 0.05 && Math.abs(p.h[p.h.length - 1] - GROUND) < 0.05, "it meets the ground at both ends");
  const mid = p.h[Math.floor(p.h.length / 2)];
  assert.ok(mid >= GROUND && mid < GROUND + 3, `level across, with a slight arch (${mid})`);
  assert.ok(Math.max(...p.h.map((h, i) => h - p.g[i])) > 28, "high above the valley floor");
  for (let i = 1; i < p.h.length; i++) assert.ok(Math.abs(p.h[i] - p.h[i - 1]) <= 0.071 * (p.d[i] - p.d[i - 1]) + 1e-6, "never steeper than a road may be");

  const sections = buildChunkMesh(CX, CY, f, elev, TEMPERATE).sections;
  const deck = section(sections, MATERIALS.deck.id), body = section(sections, MATERIALS.structure.id);
  assert.ok(deck.length > 0 && body.length > 0, "a deck and what holds it up");
  assert.ok(deck.every((s) => s.mat.collision) && body.every((s) => s.mat.collision), "both are solid: the deck is walked on");
  assert.ok(Math.min(...tops(deck)) > GROUND - 0.5, "the deck stays up over the valley");
  assert.ok(Math.min(...tops(body)) < GROUND - 25, "piers go down to the valley floor");
  // The bridge is not also drawn as a road lying in the valley.
  const lying = section(sections, MATERIALS.road.id).flatMap((s) => s.pos.filter((_, i) => i % 3 === 2));
  assert.ok(Math.min(...lying) > GROUND - 1, "no road is draped across the valley floor");
});

test("a bridge is lifted clear of the road under it, and the roads that meet it climb to it on ramps", async () => {
  const elev = await land();
  const over = road(2, [at(-20, 0), at(20, 0)], { bridge: true, layer: 1 });
  const f = world([
    road(1, [at(-200, 0), at(-20, 0)]), over, road(3, [at(20, 0), at(200, 0)]),
    road(4, [at(0, -150), at(0, 150)], { hw: "primary", width: 9 }), // passes under, at right angles
  ]);
  const spans = solveSpans(kitOf(f), elev);
  const p = spans.profiles.get(2)!;
  assert.equal(spans.crossings.length, 1);
  const need = GROUND + 5.2 + deckDepth(over);
  assert.ok(Math.max(...p.h) >= need - 0.01, `clear of the road under it (${Math.max(...p.h)} of ${need})`);
  assert.ok(p.h[0] > GROUND + 4, "too short to come down itself: its ends are in the air");
  const ramps = rampsOf(f, spans);
  assert.deepEqual([...ramps.keys()].sort(), [1, 3], "the roads at each end are ramps; the road under it is not");
  const west = ramps.get(1)!;
  assert.ok(Math.abs(west.lift[west.lift.length - 1] - (p.h[0] - GROUND)) < 0.01, "the ramp meets the bridge at its height");
  assert.equal(west.lift[0], 0, "and starts on the ground");
  const S0 = metersPerTile(west.pts[0][1]);
  const start = west.pts.findIndex((_, i) => west.lift[i] > 0);
  const long = Math.hypot(west.pts[start][0] - west.pts[west.pts.length - 1][0], west.pts[start][1] - west.pts[west.pts.length - 1][1]) * S0;
  assert.ok(long > 40 && long <= 80, `a ramp of sensible length (${long} m)`);

  const sections = buildChunkMesh(CX, CY, f, elev, TEMPERATE).sections;
  const deck = tops(section(sections, MATERIALS.deck.id));
  assert.ok(Math.max(...deck) > need, "the deck is drawn at its height");
  assert.ok(deck.some((h) => h > GROUND + 1 && h < GROUND + 4), "and the ramps on the way up to it");
});

test("where bridges cross, the one the map puts higher clears the lower", async () => {
  const elev = await land((e, s) => GROUND - 12 * Math.max(0, 1 - Math.hypot(e, s) / 60)); // a hollow, so that neither lies on the ground
  const low = road(1, [at(-90, 0), at(90, 0)], { bridge: true, layer: 1 });
  const high = road(2, [at(0, -90), at(0, 90)], { bridge: true, layer: 2 });
  const spans = solveSpans(kitOf(world([low, high])), elev);
  const mid = (id: number): number => { const p = spans.profiles.get(id)!; return p.h[Math.floor(p.h.length / 2)]; };
  // (Heights are worked out every few metres, so the highest point is within a step of the crossing.)
  assert.ok(Math.max(...spans.profiles.get(2)!.h) >= mid(1) + 5.2 + deckDepth(high) - 0.01, `${mid(2)} over ${mid(1)}`);
});

test("a long bridge over the sea rises in an arch, and stands on piers in the water", async () => {
  const elev = await land((e) => (Math.abs(e) < 300 ? -5 : 6), 3);
  const f = world([road(1, [at(-380, 0), at(-320, 0)]), road(2, [at(-320, 0), at(0, 0)], { bridge: true, layer: 1 }), road(3, [at(0, 0), at(320, 0)], { bridge: true, layer: 1 }), road(4, [at(320, 0), at(380, 0)])]);
  const spans = solveSpans(kitOf(f), elev);
  const a = spans.profiles.get(2)!, b = spans.profiles.get(3)!;
  assert.deepEqual([a.ends, b.ends], [["ground", "joined"], ["joined", "ground"]]);
  assert.ok(Math.abs(a.h[a.h.length - 1] - b.h[0]) < 1e-9, "the two stretches meet at one height");
  assert.ok(b.h[0] > 6 + 12, `well above the water in the middle (${b.h[0]})`);
  assert.ok(a.run > 600 && a.sea > 500, "the run is measured from ground to ground, and how much of it is over the sea");
  const body = section(buildChunkMesh(CX, CY, f, elev, TEMPERATE).sections, MATERIALS.structure.id);
  assert.ok(Math.min(...tops(body)) < -2, "piers stand on the sea bed");
});

test("a run of bridge that carries on into the next piece of the map is given the same heights from both pieces", async () => {
  const elev = await land((e) => GROUND - 20 * Math.max(0, 1 - ((e - 240) / 200) ** 2), 4);
  // The chunk is 400-odd metres wide and a piece of the map two chunks: this bridge starts in one piece and ends in the next.
  // The western piece reaches 1.5 chunks east of the middle of this chunk, and its margin a little further.
  const wA = road(1, [at(-150, 0), at(60, 0)]), b1 = road(2, [at(60, 0), at(1.9 * S, 0)], { bridge: true, layer: 1 });
  const b2 = road(3, [at(1.9 * S, 0), at(2.6 * S, 0)], { bridge: true, layer: 1 }), wB = road(4, [at(2.6 * S, 0), at(2.8 * S, 0)]);
  // Each piece holds only what touches it (and its margin): the western one never sees the far end of the bridge.
  const west = world([wA, b1]), east = world([b1, b2, wB]);
  const dx = CX >> 1, dy = CY >> 1;
  const load = async (x: number): Promise<Features> => (x === dx ? west : east);
  const alone = solveSpans(kitOf(west), elev).profiles.get(2)!;
  const fromWest = (await prepareSpans(dx, dy, west, elev, load)).profiles.get(2)!;
  const fromEast = (await prepareSpans(dx + 1, dy, east, elev, load)).profiles.get(2)!;
  assert.deepEqual(fromWest.h, fromEast.h);
  assert.deepEqual(fromWest.ends, ["ground", "joined"]);
  assert.notDeepEqual(alone.h, fromWest.h, "by itself the western piece would have ended the bridge too soon");
});

test("a tunnel starts at the ground at each mouth and goes under it between them", async () => {
  const elev = await land();
  const tube = road(2, [at(-150, 0), at(150, 0)], { tunnel: true, layer: -1 });
  const f = world([road(1, [at(-200, 0), at(-150, 0)]), road(3, [at(150, 0), at(200, 0)])], [tube]);
  const p = profileOf(f, elev, 2);
  assert.deepEqual(p.ends, ["ground", "ground"]);
  assert.ok(Math.abs(p.h[0] - GROUND) < 0.01 && Math.abs(p.h[p.h.length - 1] - GROUND) < 0.01);
  const deepest = Math.min(...p.h);
  assert.ok(deepest <= GROUND - tubeHeight(tube) - 2 && deepest > GROUND - 12, `deep enough for its roof to be under the ground (${deepest})`);
  for (let i = 1; i < p.h.length; i++) assert.ok(Math.abs(p.h[i] - p.h[i - 1]) <= 0.101 * (p.d[i] - p.d[i - 1]) + 1e-6, "it dives no steeper than one in ten");
  // Under a hill it need not dive: it runs level from mouth to mouth.
  const hill = await land((e) => GROUND + 40 * Math.max(0, 1 - (e / 140) ** 2));
  const level = profileOf(f, hill, 2);
  assert.ok(level.h.every((h) => Math.abs(h - GROUND) < 0.6), "level under a hill");
});

test("a tunnel is a tube under the ground: a floor to stand on, walls and a ceiling, and a mouth where it comes out", async () => {
  // A hill 40 m high over the tunnel, whose mouths are in its sides.
  const elev = await land((e) => GROUND + 40 * Math.max(0, 1 - (e / 160) ** 2));
  const tube = road(2, [at(-150, 0), at(150, 0)], { tunnel: true, layer: -1 });
  const f = world([road(1, [at(-200, 0), at(-150, 0)]), road(3, [at(150, 0), at(200, 0)])], [tube]);
  const sections = buildChunkMesh(CX, CY, f, elev, TEMPERATE).sections;
  const floor = section(sections, MATERIALS.deck.id), lining = section(sections, MATERIALS.lining.id);
  assert.ok(floor.length > 0 && lining.length > 0);
  assert.ok(floor.every((s) => s.mat.collision) && lining.every((s) => s.mat.collision), "the floor is stood on and the walls are solid");
  const base = profileOf(f, elev, 2).h[0]; // the ground at a mouth
  assert.ok(base > GROUND + 3 && base < GROUND + 6);
  assert.ok(tops(floor).every((h) => Math.abs(h - base - 0.2) < 0.7), "the floor runs level under the hill");
  const high = tubeHeight(tube);
  // Walls from the floor to the ceiling; the frame of the mouth stands above the ceiling.
  const walls = tops(lining);
  assert.ok(Math.min(...walls) < base + 0.3 && walls.some((h) => Math.abs(h - (base + 0.2 + high)) < 0.05));
  assert.ok(Math.max(...walls) > base + high + 1, "a frame round the mouth");
  // The ground: whole over the middle of the hill, cut away round the mouths, with other ground (9) round the cut.
  const cut = section(sections, MATERIALS.cut.id);
  assert.ok(cut.length > 0 && cut.every((s) => s.mat.collision), "ground round the mouth, and the bank over the tunnel there");
  const terrain = sections.filter((s) => s.mat.id <= 8);
  // Every point of the terrain's grid is still in the terrain sections, cut cells or not: 65 by 65.
  const grid = new Set<string>();
  for (const s of terrain) for (let i = 0; i < s.pos.length; i += 3) grid.add(`${Math.round((s.pos[i] / S) * 64)},${Math.round((-s.pos[i + 1] / S) * 64)}`);
  assert.equal(grid.size, 65 * 65);
  // No terrain triangle lies in the tunnel's way at a mouth (150 m west of the middle, on the line of the road).
  const over = (e: number, n: number): number => terrain.reduce((count, s) => {
    for (let t = 0; t < s.idx.length; t += 3) {
      const [a, b, c] = [s.idx[t], s.idx[t + 1], s.idx[t + 2]].map((v) => [s.pos[v * 3] - S / 2 - e, s.pos[v * 3 + 1] + S / 2 - n]);
      const side = (p: number[], q: number[]): number => p[0] * q[1] - p[1] * q[0];
      const [d1, d2, d3] = [side(a, b), side(b, c), side(c, a)];
      if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) count++;
    }
    return count;
  }, 0);
  assert.equal(over(-140.3, 0.4), 0, "the terrain is cut away just inside the mouth");
  assert.equal(over(1.3, 0.7), 1, "and whole over the middle of the hill");
  assert.equal(over(-140.3, 60.7), 1, "and beside the tunnel");
});

test("underground paths with no way in from the street are left out; a tunnel that ends underground ends in a wall", async () => {
  const elev = await land();
  const corridor = road(5, [at(0, 50), at(80, 50)], { cls: "path", width: 2, hw: undefined, tunnel: true, layer: -2 });
  const subway = road(6, [at(0, 90), at(80, 90)], { cls: "path", width: 2, hw: undefined, tunnel: true, layer: -1 });
  const siding = road(7, [at(0, 130), at(200, 130)], { cls: "rail", width: 3, hw: undefined, tunnel: true, layer: -1 });
  const f = world([road(1, [at(-50, 90), at(0, 90)], { cls: "path", width: 2 }), road(2, [at(-50, 130), at(0, 130)], { cls: "rail", width: 3 })], [corridor, subway, siding]);
  const spans = solveSpans(kitOf(f), elev);
  assert.equal(spans.profiles.has(5), false);
  assert.deepEqual(spans.profiles.get(6)!.ends, ["ground", "blind"]);
  assert.deepEqual(spans.profiles.get(7)!.ends, ["ground", "blind"]);
});
