import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { homesOf, type HomeDoor } from "../src/chunk.ts";
import { Elevation } from "../src/elevation.ts";
import { metersPerTile } from "../src/geo.ts";
import { buildInterior, INSIDE, LAYOUTS, planHome } from "../src/interior.ts";
import { buildLabels } from "../src/labels.ts";
import type { Features } from "../src/osm.ts";

const CX = 33185;
const CY = 22545;
const GROUND = 40;
const S = metersPerTile(CY + 0.5);
const d = (metres: number): number => metres / S;
const level = async (): Promise<Elevation> => {
  const elev = new Elevation(async () => new Float32Array(256 * 256).fill(GROUND));
  await elev.ensure(CX - 0.5, CY - 0.5, CX + 1.5, CY + 1.5);
  return elev;
};

test("thirty layouts, and every house gets rooms it can use", () => {
  assert.equal(LAYOUTS.length, 30);
  const used = new Set<number>();
  let planned = 0;
  for (const [width, depth] of [[6, 5], [7.5, 6], [9, 7], [10, 6], [12, 8], [14, 10], [8, 12], [18, 9], [22, 14]]) {
    for (let seed = 1; seed <= 60; seed++) {
      const door = width * (0.3 + (seed % 5) * 0.1);
      const plan = planHome(width, depth, door, seed * 7919)!;
      assert.ok(plan, `a ${width} by ${depth} m house can be laid out`);
      planned++;
      used.add(plan.layout);
      assert.deepEqual(planHome(width, depth, door, seed * 7919), plan, "the same house is always laid out the same way");
      // The rooms fill the house exactly, none too small to stand in.
      let area = 0;
      for (const r of plan.rooms) {
        assert.ok(r.a1 - r.a0 >= 2.1 && r.b1 - r.b0 >= 2.1, `a room ${(r.a1 - r.a0).toFixed(1)} by ${(r.b1 - r.b0).toFixed(1)} m`);
        assert.ok(r.a0 >= -1e-9 && r.a1 <= width + 1e-9 && r.b0 >= -1e-9 && r.b1 <= depth + 1e-9);
        area += (r.a1 - r.a0) * (r.b1 - r.b0);
      }
      assert.ok(Math.abs(area - width * depth) < 1e-6, "no gaps and no overlaps");
      // The front door opens into a hall or a living room, and every room is reached from there.
      const entrance = plan.rooms[plan.entrance];
      assert.ok(entrance.b0 === 0 && door > entrance.a0 + 0.6 && door < entrance.a1 - 0.6 && "HL".includes(entrance.kind));
      assert.equal(plan.doorways.length, plan.rooms.length - 1);
      const reached = new Set([plan.entrance]);
      for (const way of plan.doorways) {
        assert.ok(reached.has(way.from) && !reached.has(way.to), "each doorway leads on from a room already reached");
        reached.add(way.to);
        assert.ok(Math.abs(way.hi - way.lo - 0.9) < 1e-9, "a doorway is 0.9 m wide");
      }
      assert.equal(reached.size, plan.rooms.length);
    }
  }
  assert.ok(planned === 540 && used.size >= 20, `many layouts in use (${used.size} of 30)`);
  assert.equal(planHome(6, 5, 3, 1)!.rooms.length <= 3, true, "a small house has few rooms");
});

/** A home 10 m by 7 m with its front wall along the north side and its door 4 m along. */
function home(seed: number): HomeDoor {
  return { id: 77, corners: [[100, -50], [100, -57], [110, -57], [110, -50]], x: 106, y: -50, along: [-1, 0], out: [0, 1], floor: GROUND + 0.06, height: 5.85, seed, wall: 0xf6e8c6 };
}

test("the inside of a home: floors, walls, a ceiling and furniture, all within its own walls", () => {
  const kinds = new Set<number>();
  for (let seed = 1; seed <= 40; seed++) {
    const m = buildInterior(home(seed * 104729), S);
    assert.deepEqual(buildInterior(home(seed * 104729), S).sections.map((s) => [s.mat.id, s.mat.color, s.count]), m.sections.map((s) => [s.mat.id, s.mat.color, s.count]), "the same every time");
    let floor = 0;
    for (const s of m.sections) {
      assert.ok(s.mat.id >= 40 && s.mat.id <= 45, "surface ids of its own");
      assert.equal(s.mat.collision, s.mat.id === INSIDE.floor.id || s.mat.id === INSIDE.wall.id || s.mat.id === INSIDE.furniture.id);
      kinds.add(s.mat.id);
      for (let i = 0; i < s.pos.length; i += 3) {
        const [e, n, h] = [s.pos[i], s.pos[i + 1], s.pos[i + 2]];
        assert.ok(e > 100.02 && e < 109.98 && n < -50.02 && n > -56.98, `inside the walls: (${e.toFixed(2)}, ${n.toFixed(2)})`);
        assert.ok(h >= GROUND + 0.06 - 1e-6 && h <= GROUND + 0.06 + 2.6 + 1e-6, "between the floor and the ceiling");
      }
      if (s.mat.id === INSIDE.floor.id) {
        for (let i = 0; i < s.idx.length; i += 3) {
          const [p, q, r] = [s.idx[i] * 3, s.idx[i + 1] * 3, s.idx[i + 2] * 3];
          floor += Math.abs((s.pos[q] - s.pos[p]) * (s.pos[r + 1] - s.pos[p + 1]) - (s.pos[q + 1] - s.pos[p + 1]) * (s.pos[r] - s.pos[p])) / 2;
        }
      }
    }
    assert.ok(Math.abs(floor - 9.9 * 6.9) < 0.01, `floor from wall to wall (${floor.toFixed(1)} m2)`);
    const furniture = m.sections.filter((s) => s.mat.id === INSIDE.furniture.id).reduce((n, s) => n + s.count, 0);
    assert.ok(furniture >= 20 * 4, "something to sit on and something to look at");
  }
  assert.deepEqual([...kinds].sort(), [40, 41, 42, 43, 44, 45]);
});

function village(): Features {
  const ring = (west: number, north: number, w: number, dep: number): [number, number][] => [[west, north], [west + d(w), north], [west + d(w), north + d(dep)], [west, north + d(dep)]];
  const buildings: Features["buildings"] = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, ring: ring(CX + 0.2 + d(i * 16), CY + 0.5, 10, 6), height: 6 }));
  const west = CX + 0.2, north = CY + 0.7;
  buildings.push({ id: 20, ring: [[west, north], [west + d(12), north], [west + d(12), north + d(5)], [west + d(5), north + d(5)], [west + d(5), north + d(11)], [west, north + d(11)]], height: 6 }); // L-shaped
  buildings.push({ id: 21, ring: ring(CX + 0.5, CY + 0.7, 10, 7), height: 7, kind: "barn" });
  buildings.push({ id: 22, ring: ring(CX + 0.6, CY + 0.7, 6, 6), height: 3, kind: "garage" });
  buildings.push({ id: 23, ring: ring(CX + 0.7, CY + 0.7, 4, 4), height: 6 }); // too small
  const roads = [{ id: 900, cls: "road" as const, width: 6, pts: [[CX + 0.1, CY + 0.5 - d(12)], [CX + 0.9, CY + 0.5 - d(12)]] as [number, number][] }];
  return { buildings, roads, areas: [], trees: [], addresses: [], coast: [] } as Features;
}

test("plain four-square homes open their doors, and the labels say where", async () => {
  const elev = await level();
  const f = village();
  const homes = homesOf(CX, CY, f, elev);
  assert.deepEqual(homes.map((h) => h.id).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6], "not the L-shaped house, the barn, the garage or the tiny one");
  for (const h of homes) {
    assert.equal(h.corners.length, 4);
    assert.ok(Math.abs(h.out[0]) < 1e-6 && Math.abs(h.out[1] - 1) < 1e-6, "the street is to the north, and so is the way out");
    assert.ok(Math.abs(h.y + 0.5 * S) < 0.01, "the door is on the north wall");
    assert.ok(Math.abs(h.floor - (GROUND + 0.06)) < 1e-6);
  }
  assert.equal(homesOf(CX, CY, f, elev), homes, "worked out once for a chunk, then remembered");

  const doors = buildLabels(CX, CY, f, elev).filter((it) => it.kind === "door");
  assert.deepEqual(doors.map((it) => it.id).sort((a, b) => a! - b!), [1, 2, 3, 4, 5, 6]);
  for (const it of doors) {
    const h = homes.find((x) => x.id === it.id)!;
    assert.ok(Math.abs(it.u * S - h.x) < 0.01 && Math.abs(-it.v * S - h.y) < 0.01 && it.yaw === 0 && Math.abs(it.h - h.floor) < 0.01);
  }
});

test("GET /v1/interior serves the inside of a home, and says so when there is none", async () => {
  const asked: string[] = [];
  const kept = new Map<string, Buffer>();
  const options = {
    buildInterior: async (x: number, y: number, id: number) => { asked.push(`${x}/${y}/${id}`); return id === 7 ? Buffer.from("rooms") : null; },
    readCache: async (rel: string) => kept.get(rel) ?? null,
    writeCache: async (rel: string, data: Buffer) => void kept.set(rel, data),
  };
  const open = createApp(options);
  const locked = createApp({ ...options, accessCode: "otter-42" });
  await Promise.all([open, locked].map((a) => new Promise<void>((r) => a.server.listen(0, r))));
  const base = (a: typeof open): string => `http://localhost:${(a.server.address() as AddressInfo).port}`;
  try {
    const res = await fetch(`${base(open)}/v1/interior/16/1/2/7`);
    assert.deepEqual([res.status, await res.text()], [200, "rooms"]);
    assert.equal((await fetch(`${base(open)}/v1/interior/16/1/2/7`)).status, 200);
    assert.deepEqual(asked, ["1/2/7"], "built once, then kept");
    assert.equal((await fetch(`${base(open)}/v1/interior/16/1/2/8`)).status, 404);
    assert.equal((await fetch(`${base(open)}/v1/interior/15/1/2/7`)).status, 400);
    assert.equal((await fetch(`${base(locked)}/v1/interior/16/1/2/7`)).status, 401);
    assert.equal((await fetch(`${base(locked)}/v1/interior/16/1/2/7`, { headers: { Authorization: "Bearer otter-42" } })).status, 200);
  } finally {
    open.close();
    locked.close();
  }
});
