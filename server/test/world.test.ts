import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChunkMesh, clipPolyline, encodeChunk, FORMAT_MAGIC, MATERIALS } from "../src/chunk.ts";
import { Elevation, GRID } from "../src/elevation.ts";
import { CHUNK_Z, latToY, lonToX, xToLon, yToLat } from "../src/geo.ts";
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
      { type: "way", id: 100, nodes: [1, 2, 3, 4, 1], tags: { building: "yes", height: "10" } },
      n(5, CX - 0.5, CY + 0.7), n(6, CX + 1.5, CY + 0.7),
      { type: "way", id: 101, nodes: [5, 6], tags: { highway: "residential" } },
      { type: "way", id: 102, nodes: [5, 6], tags: { highway: "primary", tunnel: "yes" } },
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
  assert.equal(f.roads.length, 1, "tunnels are skipped");
  assert.equal(f.roads[0].cls, "road");
  assert.deepEqual(f.areas.map((a) => a.cls).sort(), ["forest", "water"]);
  assert.equal(f.trees.length, 1);
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
  const empty: Features = { buildings: [], roads: [], areas: [], trees: [], coast: [] };
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
  const coast: Features = { buildings: [], roads: [], areas: [], trees: [], coast: [[[CX + 0.5, CY + 1.2], [CX + 0.5, CY + 0.5], [CX + 0.5, CY - 0.2]]] };
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
  const lake: Features = { buildings: [], roads: [], areas: [{ id: 1, cls: "water", rings: [sq(0.1, 0.9), sq(0.4, 0.6)] }], trees: [], coast: [] };
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
