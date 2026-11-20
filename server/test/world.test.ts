import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChunkMesh, insetRing, clipPolyline, encodeChunk, FORMAT_MAGIC, MATERIALS } from "../src/chunk.ts";
import { Elevation, GRID } from "../src/elevation.ts";
import { CHUNK_Z, latToY, lonToX, metersPerTile, xToLon, yToLat } from "../src/geo.ts";
import { buildLabels, generateLabels, type LabelsJson } from "../src/labels.ts";
import { buildingHeight, parseOsm, stitchRings, type Features, type OsmJson } from "../src/osm.ts";

const CX = 33185;
const CY = 22545;

/** A smooth synthetic hill, so tests need no network. */
function hills(): Elevation {
  return new Elevation(async (_z, x, y) => {
    const t = new Float32Array(256 * 256);
    for (let j = 0; j < 256; j++) for (let i = 0; i < 256; i++) {
      const gx = x * 256 + i;
      const gy = y * 256 + j;
      t[j * 256 + i] = 50 + 20 * Math.sin(gx / 40) + 15 * Math.cos(gy / 55);
    }
    return t;
  });
}

function lonLat(wx: number, wy: number): { lon: number; lat: number } {
  return { lon: xToLon(wx), lat: yToLat(wy) };
}

test("tile maths round-trips", () => {
  const x = lonToX(2.2945);
  const y = latToY(48.8583);
  assert.equal(Math.floor(x), CX);
  assert.equal(Math.floor(y), CY);
  assert.ok(Math.abs(xToLon(x) - 2.2945) < 1e-9);
  assert.ok(Math.abs(yToLat(y) - 48.8583) < 1e-9);
});

test("clipPolyline keeps only the inside pieces", () => {
  const pieces = clipPolyline([[-1, 0.5], [0.5, 0.5], [0.5, 2], [0.2, 0.2]], 0, 0, 1, 1);
  assert.equal(pieces.length, 2);
  assert.deepEqual(pieces[0], [[0, 0.5], [0.5, 0.5], [0.5, 1]]);
  assert.deepEqual(pieces[1][pieces[1].length - 1], [0.2, 0.2]);
  assert.equal(clipPolyline([[2, 2], [3, 3]], 0, 0, 1, 1).length, 0);
});

test("stitchRings joins fragments in either direction", () => {
  const rings = stitchRings([[1, 2, 3], [5, 4, 3], [5, 6, 1], [9, 10]]);
  assert.equal(rings.length, 1);
  assert.equal(rings[0][0], rings[0][rings[0].length - 1]);
  assert.equal(new Set(rings[0]).size, 6);
});

test("building heights prefer explicit tags", () => {
  assert.equal(buildingHeight(1, { building: "yes", height: "12.5 m" }), 12.5);
  assert.ok(Math.abs(buildingHeight(1, { building: "yes", "building:levels": "4" }) - 13.6) < 1e-9);
  const guess = buildingHeight(7, { building: "house" });
  assert.ok(guess > 5 && guess < 8.5);
});

function sampleOsm(): OsmJson {
  const n = (id: number, wx: number, wy: number, tags?: Record<string, string>) => ({ type: "node" as const, id, ...lonLat(wx, wy), tags });
  return {
    elements: [
      n(1, CX + 0.4, CY + 0.4), n(2, CX + 0.5, CY + 0.4), n(3, CX + 0.5, CY + 0.5), n(4, CX + 0.4, CY + 0.5),
      { type: "way", id: 100, nodes: [1, 2, 3, 4, 1], tags: { building: "yes", height: "10", "addr:housenumber": "12", "addr:street": "High Street" } },
      n(5, CX - 0.5, CY + 0.7), n(16, CX + 0.5, CY + 0.7), n(6, CX + 1.5, CY + 0.7),
      { type: "way", id: 101, nodes: [5, 16, 6], tags: { highway: "residential", name: "High Street" } },
      { type: "way", id: 102, nodes: [5, 6], tags: { highway: "primary", tunnel: "yes" } },
      // Mill Lane runs south from High Street, sharing node 16 with it.
      n(17, CX + 0.5, CY + 0.55), n(18, CX + 0.5, CY + 0.95),
      { type: "way", id: 106, nodes: [17, 16, 18], tags: { highway: "residential", name: "Mill Lane" } },
      n(19, CX + 0.2, CY + 0.6, { "addr:housenumber": "7" }),
      n(7, CX + 0.0, CY + 0.0), n(8, CX + 0.3, CY + 0.0), n(9, CX + 0.3, CY + 0.3), n(10, CX + 0.0, CY + 0.3),
      { type: "way", id: 103, nodes: [7, 8, 9, 10, 7], tags: { natural: "wood" } },
      n(11, CX + 0.8, CY + 0.2, { natural: "tree" }),
      // multipolygon lake made of two half rings
      n(12, CX + 0.6, CY + 0.8), n(13, CX + 0.9, CY + 0.8), n(14, CX + 0.9, CY + 0.95), n(15, CX + 0.6, CY + 0.95),
      { type: "way", id: 104, nodes: [12, 13, 14] },
      { type: "way", id: 105, nodes: [12, 15, 14] },
      { type: "relation", id: 200, members: [{ type: "way", ref: 104, role: "outer" }, { type: "way", ref: 105, role: "outer" }], tags: { type: "multipolygon", natural: "water" } },
    ],
  };
}

test("parseOsm classifies features", () => {
  const f = parseOsm(sampleOsm());
  assert.equal(f.buildings.length, 1);
  assert.equal(f.buildings[0].height, 10);
  assert.equal(f.buildings[0].housenumber, "12");
  assert.equal(f.buildings[0].street, "High Street");
  assert.equal(f.roads.length, 2, "tunnels are skipped");
  assert.equal(f.roads[0].cls, "road");
  assert.deepEqual(f.roads.map((r) => r.name).sort(), ["High Street", "Mill Lane"]);
  assert.deepEqual(f.areas.map((a) => a.cls).sort(), ["forest", "water"]);
  assert.equal(f.trees.length, 1);
  assert.equal(f.addresses.length, 1);
  assert.equal(f.addresses[0].housenumber, "7");
  assert.equal(f.addresses[0].street, undefined);
});

async function mesh(cx: number, cy: number, f: Features) {
  const elev = hills();
  await elev.ensure(cx - 0.5, cy - 0.5, cx + 1.5, cy + 1.5);
  return { elev, mesh: buildChunkMesh(cx, cy, f, elev) };
}

test("chunk mesh is well formed and faces outward", async () => {
  const { mesh: m } = await mesh(CX, CY, parseOsm(sampleOsm()));
  const ids = m.sections.map((s) => s.mat.id);
  for (const want of [MATERIALS.ground, MATERIALS.forest, MATERIALS.water, MATERIALS.road, MATERIALS.tree]) {
    assert.ok(ids.includes(want.id), `section ${want.id} present`);
  }
  assert.ok(m.sections.some((s) => s.mat.id >= 20 && s.mat.id <= 23), "walls present");
  assert.ok(m.sections.some((s) => s.mat.id === 24 || s.mat.id === 25), "roof present");

  for (const s of m.sections) {
    assert.equal(s.idx.length % 3, 0);
    assert.equal(s.pos.length, s.nrm.length);
    for (const i of s.idx) assert.ok(i >= 0 && i < s.count);
    for (const v of s.pos) assert.ok(Number.isFinite(v));
    // Every triangle's geometric normal must agree with its stored vertex normals.
    for (let t = 0; t < s.idx.length; t += 3) {
      const [a, b, c] = [s.idx[t] * 3, s.idx[t + 1] * 3, s.idx[t + 2] * 3];
      const u = [s.pos[b] - s.pos[a], s.pos[b + 1] - s.pos[a + 1], s.pos[b + 2] - s.pos[a + 2]];
      const v = [s.pos[c] - s.pos[a], s.pos[c + 1] - s.pos[a + 1], s.pos[c + 2] - s.pos[a + 2]];
      const g = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const len = Math.hypot(g[0], g[1], g[2]);
      if (len < 1e-6) continue;
      const dot = (g[0] * s.nrm[a] + g[1] * s.nrm[a + 1] + g[2] * s.nrm[a + 2]) / len;
      assert.ok(dot > 0.2, `section ${s.mat.id} triangle ${t / 3} faces the wrong way (dot ${dot.toFixed(2)})`);
    }
  }
});

test("roads sit just above the terrain mesh", async () => {
  const { mesh: m, elev } = await mesh(CX, CY, parseOsm(sampleOsm()));
  const road = m.sections.find((s) => s.mat.id === MATERIALS.road.id)!;
  const S = m.metersPerTile;
  for (let i = 0; i < road.count; i++) {
    const lift = road.pos[i * 3 + 2] - elev.surfaceHeight(CX + road.pos[i * 3] / S, CY - road.pos[i * 3 + 1] / S);
    assert.ok(lift > 0.1 && lift < 0.3, `lift ${lift}`);
  }
});

test("neighbouring chunks share identical edge heights", async () => {
  const empty: Features = { buildings: [], roads: [], areas: [], trees: [], addresses: [], coast: [] };
  const a = await mesh(CX, CY, empty);
  const b = await mesh(CX + 1, CY, empty);
  const edge = (m: typeof a.mesh, e: number): Map<number, number> => {
    const out = new Map<number, number>();
    for (const s of m.sections) for (let i = 0; i < s.count; i++) {
      if (Math.abs(s.pos[i * 3] - e) < 1e-6) out.set(Math.round((-s.pos[i * 3 + 1] / m.metersPerTile) * GRID), s.pos[i * 3 + 2]);
    }
    return out;
  };
  const east = edge(a.mesh, a.mesh.metersPerTile);
  const west = edge(b.mesh, 0);
  assert.equal(east.size, GRID + 1);
  for (const [k, h] of east) assert.equal(west.get(k), h);
});

test("encodeChunk writes the documented layout", async () => {
  const { mesh: m } = await mesh(CX, CY, parseOsm(sampleOsm()));
  const buf = encodeChunk(CX, CY, m);
  assert.equal(buf.readUInt32LE(0), FORMAT_MAGIC);
  assert.equal(buf.readUInt32LE(8), CX);
  assert.equal(buf.readUInt32LE(12), CY);
  assert.equal(buf.readUInt32LE(20), m.sections.length);
  let o = 24;
  for (const s of m.sections) {
    assert.equal(buf.readUInt32LE(o), s.mat.id);
    const nv = buf.readUInt32LE(o + 12);
    const ni = buf.readUInt32LE(o + 16);
    assert.equal(nv, s.count);
    o += 20;
    for (let i = 0; i < nv; i++) {
      const u = buf.readFloatLE(o + i * 12);
      const v = buf.readFloatLE(o + i * 12 + 4);
      assert.ok(u > -0.6 && u < 1.6 && v > -0.6 && v < 1.6);
    }
    o += nv * 24 + ni * 4;
  }
  assert.equal(o, buf.length);
  assert.equal(CHUNK_Z, 16);
});

test("coastlines put the sea on their right-hand side", async () => {
  // A coast running north through the middle of the chunk: land (left) is west, sea is east.
  const coast: Features = { buildings: [], roads: [], areas: [], trees: [], addresses: [], coast: [[[CX + 0.5, CY + 1.2], [CX + 0.5, CY + 0.5], [CX + 0.5, CY - 0.2]]] };
  const { mesh: m } = await mesh(CX, CY, coast);
  const S = m.metersPerTile;
  const water = m.sections.find((s) => s.mat.id === MATERIALS.water.id)!;
  const land = m.sections.find((s) => s.mat.id === MATERIALS.ground.id)!;
  assert.ok(water && land);
  for (let i = 0; i < water.count; i++) assert.ok(water.pos[i * 3] >= S * 0.5 - 1e-6, "water only east of the coast");
  for (let i = 0; i < land.count; i++) assert.ok(land.pos[i * 3] <= S * 0.5 + 1e-6, "land only west of the coast");
});

test("inner rings of an area are holes", async () => {
  const sq = (a: number, b: number): [number, number][] => [[CX + a, CY + a], [CX + b, CY + a], [CX + b, CY + b], [CX + a, CY + b]];
  const lake: Features = { buildings: [], roads: [], areas: [{ id: 1, cls: "water", rings: [sq(0.1, 0.9), sq(0.4, 0.6)] }], trees: [], addresses: [], coast: [] };
  const { mesh: m } = await mesh(CX, CY, lake);
  const S = m.metersPerTile;
  const water = m.sections.find((s) => s.mat.id === MATERIALS.water.id)!;
  let touchesIsland = false;
  for (let t = 0; t < water.idx.length; t += 3) {
    const e = (water.pos[water.idx[t] * 3] + water.pos[water.idx[t + 1] * 3] + water.pos[water.idx[t + 2] * 3]) / 3 / S;
    const n = -(water.pos[water.idx[t] * 3 + 1] + water.pos[water.idx[t + 1] * 3 + 1] + water.pos[water.idx[t + 2] * 3 + 1]) / 3 / S;
    assert.ok(e > 0.09 && e < 0.91 && n > 0.09 && n < 0.91, "water stays inside the lake");
    if (e > 0.42 && e < 0.58 && n > 0.42 && n < 0.58) touchesIsland = true;
  }
  assert.equal(touchesIsland, false, "the island is dry");
});

test("labels: letterboxes face the street and signs stand at crossings", async () => {
  const f = parseOsm(sampleOsm());
  const elev = hills();
  await elev.ensure(CX - 0.5, CY - 0.5, CX + 1.5, CY + 1.5);
  const items = buildLabels(CX, CY, f, elev);
  const S = metersPerTile(CY + 0.5);
  const metres = (du: number, dv: number): number => Math.hypot(du, dv) * S;
  const bearing = (du: number, dv: number): number => ((Math.atan2(du, -dv) * 180) / Math.PI + 360) % 360;
  const apart = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

  // Number 12 stands 1.5 m off the building corner nearest High Street (which runs along v = 0.7), facing it.
  const twelve = items.find((i) => i.kind === "house" && i.text === "12");
  assert.ok(twelve, "house 12 has a letterbox");
  const corners = f.buildings[0].ring.map(([x, y]) => [x - CX, y - CY]);
  const nearest = Math.min(...corners.map(([u, v]) => metres(twelve.u - u, twelve.v - v)));
  assert.ok(Math.abs(nearest - 1.5) < 0.05, `letterbox is ${nearest} m from the building`);
  assert.ok(twelve.v > 0.5, "letterbox is on the street side of the building");
  assert.ok(apart(twelve.yaw, bearing(0, 0.7 - twelve.v)) < 5, `yaw ${twelve.yaw} faces the road`);

  const seven = items.find((i) => i.kind === "house" && i.text === "7");
  assert.ok(seven, "the standalone address node has a letterbox");
  assert.ok(metres(seven.u - 0.2, seven.v - 0.6) < 2, "it stays near its node");

  const signs = items.filter((i) => i.kind === "street" && [i.text, i.text2].sort().join() === "High Street,Mill Lane");
  assert.equal(signs.length, 1, "one sign post for the crossing");
  assert.ok(metres(signs[0].u - 0.5, signs[0].v - 0.7) < 8, "the sign stands at the crossing");
  assert.ok(Math.abs(apart(signs[0].yaw, signs[0].yaw2!) - 90) < 5, `plates ${signs[0].yaw}/${signs[0].yaw2} face across their streets`);

  for (const it of items) {
    assert.ok(Math.abs(it.h - elev.surfaceHeight(CX + it.u, CY + it.v)) < 1e-6, `${it.text} stands on the terrain`);
    assert.ok(it.u >= -0.05 && it.u <= 1.05 && it.v >= -0.05 && it.v <= 1.05, `${it.text} is inside the chunk`);
  }
});

test("generateLabels returns well-formed JSON for an empty area", async () => {
  const empty: Features = { buildings: [], roads: [], areas: [], trees: [], addresses: [], coast: [] };
  const buf = await generateLabels(CX, CY, hills(), async () => empty);
  const json = JSON.parse(buf.toString("utf8")) as LabelsJson;
  assert.equal(json.x, CX);
  assert.equal(json.y, CY);
  assert.equal(typeof json.rev, "number");
  assert.equal(json.items.length, 0);
});

test("small rectangular houses get a gable roof", async () => {
  const S = metersPerTile(CY + 0.5);
  const d = (metres: number): number => metres / S;
  const ring: [number, number][] = [[CX + 0.5, CY + 0.5], [CX + 0.5 + d(10), CY + 0.5], [CX + 0.5 + d(10), CY + 0.5 + d(6)], [CX + 0.5, CY + 0.5 + d(6)]];
  const f: Features = { buildings: [{ id: 7, ring, height: 6 }], roads: [], areas: [], trees: [], addresses: [], coast: [] };
  const { mesh: m } = await mesh(CX, CY, f);
  const z = (s: { pos: number[] }): number[] => s.pos.filter((_, i) => i % 3 === 2);
  const roof = m.sections.find((s) => s.mat.id === 24 || s.mat.id === 25)!;
  const walls = m.sections.find((s) => s.mat.id >= 20 && s.mat.id <= 23)!;
  const eaves = Math.min(...z(roof));
  assert.ok(Math.max(...z(roof)) > eaves + 1.5, "the ridge rises above the eaves");
  assert.ok(Math.max(...z(walls)) > eaves + 1.5, "gable ends rise into the roof");
  assert.equal(roof.idx.length, 12, "two slopes of two triangles each");
});

test("L-shaped houses get a roof that slopes in from every wall", async () => {
  const S = metersPerTile(CY + 0.5);
  const d = (metres: number): number => metres / S;
  const at = (e: number, s: number): [number, number] => [CX + 0.5 + d(e), CY + 0.5 + d(s)];
  // A 16 x 14 m L with wings 7 m wide.
  const ring = [at(0, 0), at(16, 0), at(16, 7), at(7, 7), at(7, 14), at(0, 14)];
  const f: Features = { buildings: [{ id: 7, ring, height: 6 }], roads: [], areas: [], trees: [], addresses: [], coast: [] };
  const { mesh: m } = await mesh(CX, CY, f);
  const roof = m.sections.find((s) => s.mat.id === 24 || s.mat.id === 25)!;
  const z = roof.pos.filter((_, i) => i % 3 === 2);
  assert.ok(Math.max(...z) > Math.min(...z) + 1.2, "the roof rises above the eaves");
  for (let i = 0; i < roof.idx.length; i += 3) {
    const [a, b, c] = [roof.idx[i], roof.idx[i + 1], roof.idx[i + 2]].map((v) => [roof.pos[v * 3], roof.pos[v * 3 + 1]]);
    assert.ok((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) >= -1e-9, "roof triangles face up");
  }
  for (let i = 2; i < roof.nrm.length; i += 3) assert.ok(roof.nrm[i] > 0.3, "roof normals point up");
});

test("insetRing refuses shapes too narrow for the inset", () => {
  const L: [number, number][] = [[0, 0], [16, 0], [16, 7], [7, 7], [7, 14], [0, 14]];
  const inner = insetRing(L, 2.6)!;
  assert.equal(inner.length, 6);
  assert.deepEqual(inner.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]), [[2.6, 2.6], [13.4, 2.6], [13.4, 4.4], [4.4, 4.4], [4.4, 11.4], [2.6, 11.4]]);
  assert.equal(insetRing(L, 3.6), null, "a 7 m wing cannot be inset by 3.6 m from both sides");
  assert.equal(insetRing([[0, 0], [20, 0], [20, 3], [0, 3]], 1.8), null);
});

test("labels carry the trees the mesh plants", async () => {
  const f = parseOsm(sampleOsm());
  const elev = hills();
  await elev.ensure(CX - 0.5, CY - 0.5, CX + 1.5, CY + 1.5);
  const trees = buildLabels(CX, CY, f, elev).filter((i) => i.kind === "tree");
  const { mesh: m } = await mesh(CX, CY, f);
  const cones = m.sections.find((s) => s.mat.id === MATERIALS.tree.id)!;
  assert.equal(trees.length, cones.count / 7, "one item per cone (6 base vertices and an apex)");
  for (const t of trees) {
    assert.ok(t.s! >= 6 && t.s! < 13.1 && t.r! >= 1.6 && t.r! < 3.3, "sizes as placed");
    assert.ok(t.u >= 0 && t.u < 1 && t.v >= 0 && t.v < 1, "inside the chunk");
  }
});
