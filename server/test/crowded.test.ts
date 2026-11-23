// A chunk crowded with houses can be drawn more plainly (EARTHWALK_CROWDED). It is off unless the setting says a
// number, so this file sets one before the chunk builder is loaded: a file of its own, since the setting is read once.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Elevation } from "../src/elevation.ts";
import { metersPerTile } from "../src/geo.ts";
import type { Building, Features } from "../src/osm.ts";
import { TEMPERATE } from "../src/styles.ts";
import type { Section } from "../src/chunk.ts";

process.env.EARTHWALK_CROWDED = "400";
const { buildChunkMesh } = await import("../src/chunk.ts");

const CX = 33185;
const CY = 22545;
const S = metersPerTile(CY + 0.5);
const at = (e: number, s: number): [number, number] => [CX + 0.5 + e / S, CY + 0.5 + s / S];
const rect = (w: number, d: number, e = 0, s = 0): [number, number][] => [at(e, s), at(e + w, s), at(e + w, s + d), at(e, s + d)];
async function build(buildings: Building[]): Promise<Section[]> {
  const elev = new Elevation(async () => new Float32Array(256 * 256).fill(50));
  await elev.ensure(CX - 0.5, CY - 0.5, CX + 1.5, CY + 1.5);
  const f: Features = { buildings, roads: [], areas: [], trees: [], addresses: [], coast: [] };
  return buildChunkMesh(CX, CY, f, elev, TEMPERATE).sections;
}

test("with the setting on, a chunk crowded with houses is drawn more plainly: every house whole, with less on it", async () => {
  // Rows of small houses twelve metres apart: twenty rows of twenty are drawn in full, twenty-one of twenty-one are a crowd.
  const town = (rows: number): Building[] => {
    const out: Building[] = [];
    for (let i = 0; i < rows; i++) for (let k = 0; k < rows; k++) out.push({ id: 1000 + i * 100 + k, ring: rect(7, 6, (i - rows / 2) * 12, (k - rows / 2) * 12), height: 5, kind: "house" });
    return out;
  };
  const corners = (sections: Section[], pick: (s: Section) => boolean): number => sections.filter(pick).reduce((sum, s) => sum + s.pos.length / 3, 0);
  const isDoor = (s: Section): boolean => s.mat.id === 26 || s.mat.id === 27;
  const isWall = (s: Section): boolean => s.mat.id >= 20 && s.mat.id <= 23;
  const isRoof = (s: Section): boolean => s.mat.id === 24 || s.mat.id === 25;
  const full = await build(town(20)), plain = await build(town(21));
  const fullEach = corners(full, () => true) / 400, plainEach = corners(plain, () => true) / 441;
  assert.ok(plainEach < fullEach * 0.75, `a house of a crowd is ${plainEach.toFixed(0)} corners, one drawn in full ${fullEach.toFixed(0)}`);
  assert.ok(corners(plain, isDoor) / 441 >= 8, "every house of a crowd still has its door and door frame");
  assert.ok(corners(plain, isDoor) / 441 < corners(full, isDoor) / 400 / 2, "flat on the wall, not boxes");
  assert.ok(corners(plain, isWall) / 441 >= 16 && corners(plain, isRoof) > 0, "and its walls and roof");
  assert.equal(corners(plain, (s) => s.mat.id === 28), 0, "no chimneys in a crowd");
});
