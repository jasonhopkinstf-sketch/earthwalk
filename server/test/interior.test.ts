import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { homesOf, roomInside, type HomeDoor } from "../src/chunk.ts";
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
  return { id: 77, corners: [[100, -50], [100, -57], [110, -57], [110, -50]], x: 106, y: -50, along: [-1, 0], out: [0, 1], floor: GROUND + 0.06, height: 5.85, seed, wall: 0xf6e8c6, porch: false };
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

/** How long the front of a home's rooms is, and how far back they go. */
const size = (h: HomeDoor): [number, number] => [Math.hypot(h.corners[1][0] - h.corners[0][0], h.corners[1][1] - h.corners[0][1]), Math.hypot(h.corners[2][0] - h.corners[1][0], h.corners[2][1] - h.corners[1][1])];
/** Is a point inside an outline? */
function within(ring: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function village(): Features {
  const ring = (west: number, north: number, w: number, dep: number): [number, number][] => [[west, north], [west + d(w), north], [west + d(w), north + d(dep)], [west, north + d(dep)]];
  const buildings: Features["buildings"] = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, ring: ring(CX + 0.2 + d(i * 16), CY + 0.5, 10, 6), height: 6 }));
  const west = CX + 0.2, north = CY + 0.7;
  buildings.push({ id: 20, ring: [[west, north], [west + d(12), north], [west + d(12), north + d(5)], [west + d(5), north + d(5)], [west + d(5), north + d(11)], [west, north + d(11)]], height: 6 }); // L-shaped
  buildings.push({ id: 21, ring: ring(CX + 0.5, CY + 0.7, 10, 7), height: 7, kind: "barn" });
  buildings.push({ id: 22, ring: ring(CX + 0.6, CY + 0.7, 6, 6), height: 3, kind: "garage" });
  buildings.push({ id: 23, ring: ring(CX + 0.7, CY + 0.7, 4, 4), height: 6 }); // too small
  buildings.push({ id: 24, ring: ring(CX + 0.2, CY + 0.85, 30, 12), height: 6 }); // longer than any one home's rooms
  const roads = [{ id: 900, cls: "road" as const, width: 6, pts: [[CX + 0.1, CY + 0.5 - d(12)], [CX + 0.9, CY + 0.5 - d(12)]] as [number, number][] }];
  return { buildings, roads, areas: [], trees: [], addresses: [], coast: [] } as Features;
}

test("homes open their doors, and the labels say where", async () => {
  const elev = await level();
  const f = village();
  const homes = homesOf(CX, CY, f, elev);
  assert.deepEqual(homes.map((h) => h.id).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 20, 24], "not the barn, the garage or the tiny one");
  for (const h of homes) {
    assert.equal(h.corners.length, 4);
    if (h.id !== 24) assert.ok(Math.abs(h.out[0]) < 1e-6 && Math.abs(h.out[1] - 1) < 1e-6, "the street is to the north, and so is the way out");
    if (h.id <= 6) assert.ok(Math.abs(h.y + 0.5 * S) < 0.01, "the door is on the north wall");
    assert.ok(Math.abs(h.floor - (GROUND + 0.06)) < 1e-6);
  }
  // A plain house gives the whole of itself to its rooms.
  assert.ok(Math.abs(size(homes.find((h) => h.id === 1)!)[0] - 10) < 0.01 && Math.abs(size(homes.find((h) => h.id === 1)!)[1] - 6) < 0.01);
  // The L-shaped one gives the bar its door is on: 12 m along the front, 5 m back.
  const ell = homes.find((h) => h.id === 20)!;
  assert.ok(Math.abs(size(ell)[0] - 12) < 0.01 && Math.abs(size(ell)[1] - 5) < 0.01, `the L-shaped house: ${size(ell).map((v) => v.toFixed(2)).join(" by ")}`);
  // The long one gives 24 m of its 30, with the door inside that.
  const long = homes.find((h) => h.id === 24)!;
  assert.ok(Math.abs(size(long)[0] - 24) < 0.01 && Math.abs(size(long)[1] - 12) < 0.01, `the long house: ${size(long).map((v) => v.toFixed(2)).join(" by ")}`);
  for (const h of [ell, long]) {
    const ring = f.buildings.find((b) => b.id === h.id)!.ring.map(([wx, wy]): [number, number] => [(wx - CX) * S, -(wy - CY) * S]);
    const m = buildInterior(h, S);
    let floor = 0;
    for (const s of m.sections) {
      for (let i = 0; i < s.pos.length; i += 3) assert.ok(within(ring, s.pos[i], s.pos[i + 1]), `house ${h.id}: everything inside its own walls`);
      if (s.mat.id === INSIDE.floor.id) floor += s.idx.length / 3;
    }
    assert.ok(floor > 0);
    const along = (h.x - h.corners[0][0]) * h.along[0] + (h.y - h.corners[0][1]) * h.along[1];
    assert.ok(Math.abs(along) >= 0.85 - 1e-6 && Math.abs(along) <= size(h)[0] - 0.85 + 1e-6, "the door is in the front wall of the rooms, clear of its ends");
  }
  assert.equal(homesOf(CX, CY, f, elev), homes, "worked out once for a chunk, then remembered");

  const doors = buildLabels(CX, CY, f, elev).filter((it) => it.kind === "door");
  assert.deepEqual(doors.map((it) => it.id).sort((a, b) => a! - b!), [1, 2, 3, 4, 5, 6, 20, 24]);
  for (const it of doors) {
    const h = homes.find((x) => x.id === it.id)!;
    assert.ok(Math.abs(it.u * S - h.x) < 0.01 && Math.abs(-it.v * S - h.y) < 0.01 && it.yaw === (h.id === 24 ? 180 : 0) && Math.abs(it.h - h.floor) < 0.01);
    assert.ok(Math.abs(it.g! - GROUND) < 0.01 && (it.porch === 1) === h.porch, "and the ground at the door, and whether it has a porch");
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

test("the room inside a house of any shape: the largest that has the door in its front wall", () => {
  const area = (c: [number, number][]): number => Math.hypot(c[1][0] - c[0][0], c[1][1] - c[0][1]) * Math.hypot(c[2][0] - c[1][0], c[2][1] - c[1][1]);
  // An L: a bar 12 m by 5 m along the south, and a leg 5 m wide running 6 m further north at its west end.
  const ell: [number, number][] = [[0, 0], [12, 0], [12, 5], [5, 5], [5, 11], [0, 11]];
  // The door on the south wall: the bar, whichever end the door is nearer.
  for (const x of [2, 6, 10]) {
    const c = roomInside(ell, x, 0, [1, 0], [0, -1])!;
    assert.ok(Math.abs(area(c) - 60) < 1e-6, `door at ${x}: ${area(c).toFixed(1)} m2`);
    assert.deepEqual(c.map(([e, n]) => [Math.round(e * 100) / 100, Math.round(n * 100) / 100]), [[0, 0], [12, 0], [12, 5], [0, 5]], "counter-clockwise from the front wall");
  }
  // The door on the west wall, up the leg: the leg and the end of the bar, 11 m along and 5 m back.
  const west = roomInside(ell, 0, 8, [0, -1], [-1, 0])!;
  assert.ok(Math.abs(area(west) - 55) < 1e-6);
  // The door on the west wall, at the end of the bar: the bar, end on, 5 m along and 12 m back.
  const end = roomInside(ell, 0, 3, [0, -1], [-1, 0])!;
  assert.ok(Math.abs(area(end) - 60) < 1e-6);
  // The door on the north end of the leg: the leg, all 11 m of it back to the south wall.
  const north = roomInside(ell, 2.5, 11, [-1, 0], [0, 1])!;
  assert.ok(Math.abs(area(north) - 55) < 1e-6);
  // The door in the corner of the L, on the wall facing north: the bar again.
  const inner = roomInside(ell, 9, 5, [-1, 0], [0, 1])!;
  assert.ok(Math.abs(area(inner) - 60) < 1e-6);

  // A house with a slanting back wall keeps its rooms in front of the slant.
  const slant: [number, number][] = [[0, 0], [10, 0], [10, 9], [0, 6]];
  const s = roomInside(slant, 5, 0, [1, 0], [0, -1])!;
  for (const [e, n] of s) assert.ok(within(slant, e + (e < 5 ? 0.01 : -0.01), n + (n < 3 ? 0.01 : -0.01)), "inside the slanting house");
  assert.ok(area(s) >= 60 - 1e-6, "at least the square in front of the slant");

  // A very big house gives 24 m by 24 m, round its door.
  const big = roomInside([[0, 0], [60, 0], [60, 40], [0, 40]], 50, 0, [1, 0], [0, -1])!;
  assert.ok(Math.abs(area(big) - 24 * 24) < 1e-6 && big[0][0] <= 50 - 0.85 && big[1][0] >= 50 + 0.85 && big[1][0] <= 60 + 1e-9);
  // Too small, too thin, or the door too near a corner for any room to have it: no rooms.
  assert.equal(roomInside([[0, 0], [3.5, 0], [3.5, 9], [0, 9]], 1.7, 0, [1, 0], [0, -1]), null);
  assert.equal(roomInside([[0, 0], [9, 0], [9, 3], [0, 3]], 4, 0, [1, 0], [0, -1]), null);
  assert.equal(roomInside(ell, 11.6, 0, [1, 0], [0, -1]), null);
});

test("homes on a hillside open too: the floor is above the ground all round, the ceiling under the top of the walls", async () => {
  // Ground that climbs steeply to the east: about 3 m across a 10 m house.
  const elev = new Elevation(async () => Float32Array.from({ length: 256 * 256 }, (_, i) => GROUND + (i % 256) * 3.8));
  await elev.ensure(CX - 0.5, CY - 0.5, CX + 1.5, CY + 1.5);
  const f = village();
  f.buildings.find((b) => b.id === 3)!.height = 3; // a bungalow: its walls end not far above the high side
  const homes = homesOf(CX, CY, f, elev);
  for (const id of [1, 2, 3, 4, 5, 6, 20]) assert.ok(homes.some((h) => h.id === id), `house ${id} opens on the slope`);
  let low = 0;
  for (const h of homes) {
    const b = f.buildings.find((x) => x.id === h.id)!;
    const grounds = b.ring.map(([wx, wy]) => elev.surfaceHeight(wx, wy));
    assert.ok(Math.max(...grounds) - Math.min(...grounds) > 1.5, "the ground does fall away");
    assert.ok(h.floor > Math.max(...grounds), "the floor is above the ground at every corner");
    assert.ok(h.height >= 2.4 - 1e-6);
    let top = -Infinity;
    for (const s of buildInterior(h, S).sections) for (let i = 2; i < s.pos.length; i += 3) top = Math.max(top, s.pos[i]);
    assert.ok(top <= h.floor - 0.06 + h.height + 1e-4, "the ceiling is under the top of the walls");
    assert.ok(top - h.floor >= 2.3 - 1e-4 && top - h.floor <= 2.6 + 1e-4, "and high enough to stand under");
    if (top - h.floor < 2.6 - 1e-4) low++;
  }
  assert.ok(low >= 1, "the bungalow's ceiling is the lower one");
});
