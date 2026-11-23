import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { homesOf } from "../src/chunk.ts";
import { Elevation } from "../src/elevation.ts";
import { metersPerTile } from "../src/geo.ts";
import { findHome, INSIDE } from "../src/interior.ts";
import { buildLabels } from "../src/labels.ts";
import type { Features } from "../src/osm.ts";
import { layVenue, type Laid, type VenueKind, type VenueSpec } from "../src/venue.ts";
import { jobOf, persona, ROLES, TALKABLE, Talker } from "../src/talk.ts";
import { FIGURES, generateInside, VENUE_CAP, venueMesh, venuesOf, venueWho } from "../src/venues.ts";
import { STROLL_PACE, STROLL_WAIT, strollAt } from "../public/js/peoplemotion.js";

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

/** Where a door is on the floor of a room, and the unit vector into the room from it. */
function doorAt(laid: Laid, n: number): { a: number; b: number; da: number; db: number } {
  const { width: W, depth: D } = laid.spec;
  const door = laid.doors[n];
  return door.side === 0 ? { a: door.at, b: 0, da: 0, db: 1 } : door.side === 1 ? { a: door.at, b: D, da: 0, db: -1 } : door.side === 2 ? { a: 0, b: door.at, da: 1, db: 0 } : { a: W, b: door.at, da: -1, db: 0 };
}

/**
 * The floor of a room as squares of 20 cm, and which of them somebody 60 cm across can stand on: not within
 * 30 cm of anything solid that stands higher than a step and lower than their head.
 */
function standing(laid: Laid): { free: (a: number, b: number) => boolean; reach: (from: [number, number]) => (a: number, b: number) => boolean } {
  const { width: W, depth: D } = laid.spec;
  const C = 0.2, R = 0.3;
  const na = Math.ceil(W / C), nb = Math.ceil(D / C);
  const blocked = new Uint8Array(na * nb);
  for (const p of laid.pieces) {
    if (p.form !== "box" || !p.mat.collision || p.z1 <= 0.3 || p.z0 >= 1.7) continue;
    for (let i = Math.max(0, Math.floor((p.a0 - R) / C)); i <= Math.min(na - 1, Math.floor((p.a1 + R) / C)); i++) {
      for (let j = Math.max(0, Math.floor((p.b0 - R) / C)); j <= Math.min(nb - 1, Math.floor((p.b1 + R) / C)); j++) {
        const ca = (i + 0.5) * C, cb = (j + 0.5) * C;
        if (ca > p.a0 - R && ca < p.a1 + R && cb > p.b0 - R && cb < p.b1 + R) blocked[j * na + i] = 1;
      }
    }
  }
  const cell = (a: number, b: number): number => Math.min(nb - 1, Math.max(0, Math.floor(b / C))) * na + Math.min(na - 1, Math.max(0, Math.floor(a / C)));
  const free = (a: number, b: number): boolean => a > R && a < W - R && b > R && b < D - R && !blocked[cell(a, b)];
  const reach = (from: [number, number]): ((a: number, b: number) => boolean) => {
    const seen = new Uint8Array(na * nb);
    const queue = [cell(from[0], from[1])];
    seen[queue[0]] = 1;
    while (queue.length) {
      const at = queue.pop()!;
      const i = at % na, j = Math.floor(at / na);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const x = i + di, y = j + dj;
        if (x < 0 || x >= na || y < 0 || y >= nb || seen[y * na + x] || !free((x + 0.5) * C, (y + 0.5) * C)) continue;
        seen[y * na + x] = 1;
        queue.push(y * na + x);
      }
    }
    return (a, b) => seen[cell(a, b)] === 1;
  };
  return { free, reach };
}

const SIZES: Record<VenueKind, [number, number][]> = {
  office: [[6, 6], [9, 7], [12, 9], [16, 12], [22, 15], [30, 24], [8, 20]],
  shop: [[4.5, 5], [6, 8], [9, 11], [16, 16], [12, 6]],
  cafe: [[4.5, 5], [7, 6], [10, 9], [14, 12]],
  mall: [[11, 14], [15, 20], [18, 30], [30, 44], [40, 60], [12, 40]],
  lobby: [[4.5, 5], [6, 6], [9, 7], [12, 10]],
};

test("every inside has a way through, and nobody stands in the furniture", () => {
  let laidOut = 0, people = 0;
  const roles = new Set<string>();
  for (const kind of Object.keys(SIZES) as VenueKind[]) {
    for (const [width, depth] of SIZES[kind]) {
      for (let n = 0; n < 24; n++) {
        const seed = (n + 1) * 7919 + width * 31;
        const front = Math.min(width - 1, Math.max(1, width * (0.15 + (n % 8) * 0.1)));
        // The second door: on the back, on either side, or nowhere; sometimes with only a short stretch of wall to be on.
        const side = ([1, 2, 3, 1] as const)[n % 4];
        const len = side === 1 ? width : depth;
        const tight = n % 3 === 0;
        const lo = tight ? Math.min(len - 1.2, 1.2 + (len - 2.4) * 0.7) : 1.2, hi = len - 1.2;
        const spec: VenueSpec = {
          kind, width, depth, ceiling: kind === "mall" ? 4.2 : 3, seed, name: "The Test Rooms", ...(n % 2 ? { hotel: true } : {}),
          doors: n % 6 === 5 || hi < lo ? [{ side: 0, at: front }] : [{ side: 0, at: front }, { side, at: (lo + hi) / 2, lo, hi }],
        };
        const laid = layVenue(spec);
        laidOut++;
        const what = `${kind} ${width} by ${depth} m, seed ${seed}, doors ${JSON.stringify(laid.doors)}`;
        assert.deepEqual(layVenue(spec), laid, "the same building is always the same inside");
        assert.equal(laid.doors.length, spec.doors.length, what);
        // Everything is inside the room, floor to ceiling.
        for (const p of laid.pieces) {
          assert.ok(p.a0 >= -1e-6 && p.a1 <= width + 1e-6 && p.b0 >= -1e-6 && p.b1 <= depth + 1e-6, `${what}: a piece outside the room: ${JSON.stringify(p)}`);
          assert.ok(p.z0 >= -1e-6 && p.z1 <= spec.ceiling + 1e-6 && p.z1 >= p.z0, `${what}: a piece through the ceiling: ${JSON.stringify(p)}`);
          assert.ok(p.mat.id >= 40 && p.mat.id <= 45);
        }
        // From a step inside the front door, the other door can be walked to.
        const { free, reach } = standing(laid);
        const f = doorAt(laid, 0);
        const start: [number, number] = [f.a + f.da * 0.9, f.b + f.db * 0.9];
        assert.ok(free(...start), `${what}: the front door is blocked`);
        const reached = reach(start);
        if (laid.doors[1]) {
          const s = doorAt(laid, 1);
          if (kind !== "mall" && spec.doors[1].lo !== undefined) assert.ok(laid.doors[1].at >= spec.doors[1].lo! - 1e-6 && laid.doors[1].at <= spec.doors[1].hi! + 1e-6, `${what}: the second door is where its wall allows`);
          assert.ok(reached(s.a + s.da * 0.9, s.b + s.db * 0.9), `${what}: no way through to the second door`);
        }
        // Whoever is in there is in the room, and whoever stands or strolls has floor under them that can be reached.
        for (const p of laid.people) {
          people++;
          roles.add(p.role);
          assert.ok(p.a > 0.2 && p.a < width - 0.2 && p.b > 0.2 && p.b < depth - 0.2, `${what}: somebody in the wall: ${JSON.stringify(p)}`);
          assert.ok(Math.abs(Math.hypot(p.fa, p.fb) - 1) < 1e-6);
          if (p.pose === "sit") assert.ok(p.seat! > 0.3 && p.seat! < 0.6);
          if (p.pose === "walk") {
            assert.ok(p.path && p.path.length >= 4 && p.path.length % 2 === 0, `${what}: a stroller with nowhere to go`);
            for (let i = 0; i + 3 < p.path!.length; i += 2) {
              const [a0, b0, a1, b1] = p.path!.slice(i, i + 4);
              const steps = Math.max(1, Math.ceil(Math.hypot(a1 - a0, b1 - b0) / 0.2));
              for (let k = 0; k <= steps; k++) assert.ok(reached(a0 + ((a1 - a0) * k) / steps, b0 + ((b1 - b0) * k) / steps), `${what}: a stroller walks into something at ${(a0 + ((a1 - a0) * k) / steps).toFixed(1)}, ${(b0 + ((b1 - b0) * k) / steps).toFixed(1)}`);
            }
          }
        }
        for (const l of laid.lettering) assert.ok(l.text && l.a >= 0 && l.a <= width && l.b >= 0 && l.b <= depth && l.z > 0.3 && l.z < spec.ceiling && l.w > 0.3, `${what}: lettering out of place: ${JSON.stringify(l)}`);
        for (const t of laid.tills) assert.ok(t.a > 0 && t.a < width && t.b > 0 && t.b < depth && (t.use === "shop" || t.use === "food") && t.text);
        // A shop has its counter and its keeper, a café its counter and its barista, however small or awkward it is.
        if (kind === "shop" || kind === "cafe") assert.ok(laid.tills.length === 1 && laid.people.some((p) => p.role === (kind === "shop" ? "keeper" : "barista")), `${what}: no counter`);
        const cap = { office: 20, shop: 4, cafe: 10, mall: 25, lobby: 4 }[kind];
        assert.ok(laid.people.length <= cap, `${what}: ${laid.people.length} people`);
        // Not too much to send: a quad is 120 bytes.
        const faces = laid.pieces.reduce((sum, p) => sum + (p.form === "box" ? (p.under ? 6 : 5) : 1), 0);
        assert.ok(faces * 120 < (kind === "mall" ? 520_000 : 200_000), `${what}: ${Math.round((faces * 120) / 1024)} KB`);
      }
    }
  }
  assert.ok(laidOut === 26 * 24 && people > laidOut * 3, `${people} people in ${laidOut} places`);
  assert.deepEqual([...roles].sort(), ["barista", "caretaker", "guest", "keeper", "meeting", "reception", "resident", "shopper", "worker"]);
  // What each kind of place has in it.
  const office = layVenue({ kind: "office", width: 22, depth: 15, ceiling: 3, seed: 4127, name: "Harbour Works", doors: [{ side: 0, at: 9 }, { side: 1, at: 9, lo: 2, hi: 20 }] });
  assert.ok(office.people.filter((p) => p.role === "worker" && p.pose === "sit").length >= 4, "workers at their desks");
  assert.ok(office.people.some((p) => p.role === "meeting") && office.people.some((p) => p.role === "reception"), "a meeting, and somebody at the front desk");
  assert.ok(office.lettering.some((l) => l.text === "KITCHEN") && office.lettering.some((l) => /^ROOM \d$/.test(l.text)) && office.lettering.some((l) => l.text === "Harbour Works"));
  assert.equal(office.doors[1].at, 9, "the back door faces the front door when its wall lets it");
  const cafe = layVenue({ kind: "cafe", width: 10, depth: 9, ceiling: 3, seed: 5150, name: "Kettle & Crumb", doors: [{ side: 0, at: 5 }] });
  assert.deepEqual(cafe.tills.map((t) => [t.use, t.text]), [["food", "Kettle & Crumb"]], "food is sold at the counter");
  assert.ok(cafe.people.some((p) => p.role === "barista") && cafe.people.filter((p) => p.role === "guest").length >= 2);
  const mall = layVenue({ kind: "mall", width: 30, depth: 44, ceiling: 4.2, seed: 2024, name: "Riverside Mall", shops: [{ name: "Unity Books" }, { name: "Little Bird Kitchen", food: true }], doors: [{ side: 0, at: 15 }, { side: 1, at: 8, lo: 3, hi: 9 }] });
  const fronts = mall.lettering.map((l) => l.text);
  assert.ok(fronts.includes("Unity Books") && fronts.includes("Little Bird Kitchen") && fronts.length >= 10 && new Set(fronts).size === fronts.length, "the shops the map names first, then ours, each once");
  assert.equal(mall.doors[1].at, 15, "a mall's back door is at the end of its walk");
  assert.ok(mall.tills.some((t) => t.use === "food" && t.text === "Little Bird Kitchen"));
  assert.ok(mall.people.filter((p) => p.pose === "walk").length >= 4 && mall.people.some((p) => p.role === "keeper"));
  const hotel = layVenue({ kind: "lobby", width: 12, depth: 10, ceiling: 3.2, seed: 9, name: "Hotel Kiwi", hotel: true, doors: [{ side: 0, at: 6 }, { side: 1, at: 6, lo: 2, hi: 10 }] });
  assert.ok(hotel.people.some((p) => p.role === "reception") && hotel.lettering.some((l) => l.text === "LIFT") && hotel.lettering.some((l) => l.text === "Hotel Kiwi"));
  const flats = layVenue({ kind: "lobby", width: 9, depth: 7, ceiling: 3, seed: 11, doors: [{ side: 0, at: 4 }, { side: 3, at: 3.5, lo: 2, hi: 5 }] });
  assert.ok(flats.lettering.some((l) => l.text === "LETTERS") && flats.people.some((p) => p.role === "caretaker" || p.role === "resident"));
});

function within(ring: [number, number][], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A street of things that are not homes, between a road to the north and a lane to the south. */
function town(): Features {
  const ring = (west: number, north: number, w: number, dep: number): [number, number][] => [[west, north], [west + d(w), north], [west + d(w), north + d(dep)], [west, north + d(dep)]];
  const north = CY + 0.3;
  const at = (metres: number): number => CX + 0.05 + d(metres);
  const buildings: Features["buildings"] = [
    { id: 1, ring: ring(at(0), north, 10, 8), height: 6, name: "Kettle Café", use: "food" },
    { id: 2, ring: ring(at(20), north, 22, 15), height: 12, kind: "office", name: "Harbour Works" },
    { id: 3, ring: ring(at(50), north, 30, 21), height: 15 }, // a big building, and no more is known
    { id: 4, ring: ring(at(90), north, 10, 6), height: 6 }, // a house
    { id: 5, ring: ring(at(110), north, 25, 20), height: 9, name: "St Mary", use: "church" },
    { id: 6, ring: ring(at(145), north, 30, 15), height: 16, kind: "apartments" },
    { id: 7, ring: ring(at(185), north, 50, 60), height: 9, kind: "retail", name: "Riverside Mall", use: "shop" },
    // Three in a row, wall to wall: the middle one's only free walls are its front and its back.
    { id: 8, ring: ring(at(245), north, 8, 12), height: 7, kind: "retail", use: "shop", name: "Left" },
    { id: 9, ring: ring(at(253), north, 8, 12), height: 7, kind: "retail", use: "shop", name: "Paper Kite Books" },
    { id: 10, ring: ring(at(261), north, 8, 12), height: 7, kind: "retail", use: "shop", name: "Right" },
    // An office round a courtyard.
    { id: 11, ring: ring(at(280), north, 30, 30), height: 14, kind: "office", holes: [ring(at(290), north + d(10), 10, 10)] },
    { id: 12, ring: ring(at(320), north, 14, 12), height: 14, kind: "hotel", name: "Hotel Kiwi" },
    { id: 13, ring: ring(at(340), north, 5, 5), height: 3, kind: "garage" },
    { id: 14, ring: ring(at(350), north, 20, 20), height: 8, kind: "warehouse" },
  ];
  const roads = [
    { id: 900, cls: "road" as const, width: 6, pts: [[CX + 0.02, north - d(10)], [CX + 0.98, north - d(10)]] as [number, number][] },
    { id: 901, cls: "path" as const, width: 2, pts: [[CX + 0.02, north + d(70)], [CX + 0.98, north + d(70)]] as [number, number][] },
  ];
  const places = [
    { id: 5001, at: [at(190), north + d(5)] as [number, number], name: "Unity Books", kind: "shop=books" },
    { id: 5002, at: [at(200), north + d(20)] as [number, number], name: "Little Bird Kitchen", kind: "amenity=cafe" },
    { id: 5003, at: [at(210), north + d(30)] as [number, number], name: "Moa Outdoors", kind: "shop=outdoor" },
  ];
  return { buildings, roads, areas: [], trees: [], addresses: [], coast: [], places } as Features;
}

test("shops, cafés, offices, malls, flats and hotels open, each with a door on two sides", async () => {
  const elev = await level();
  const f = town();
  const venues = venuesOf(CX, CY, f, elev);
  const by = new Map(venues.map((v) => [v.id, v]));
  assert.deepEqual(venues.map((v) => v.id).sort((a, b) => a - b), [1, 2, 3, 6, 7, 8, 9, 10, 11, 12], "not the house, the church, the garage or the warehouse");
  assert.deepEqual([1, 2, 6, 7, 9, 11, 12].map((id) => by.get(id)!.kind), ["cafe", "office", "lobby", "mall", "shop", "office", "lobby"]);
  assert.ok(["office", "mall"].includes(by.get(3)!.kind), "a big building the map says nothing about is an office or a row of shops");
  assert.deepEqual(homesOf(CX, CY, f, elev).filter((h) => !h.use).map((h) => h.id), [4], "the house is still a home");
  assert.equal(venuesOf(CX, CY, f, elev), venues, "worked out once for a chunk, then remembered");
  assert.deepEqual(by.get(7)!.spec.shops, [{ name: "Unity Books" }, { name: "Little Bird Kitchen", food: true }, { name: "Moa Outdoors" }], "a mall has the shops the map names in it");
  assert.equal(by.get(9)!.spec.trade, "books");
  assert.ok(by.get(12)!.spec.hotel && !by.get(6)!.spec.hotel);
  assert.deepEqual([1, 2, 7, 9].map((id) => by.get(id)!.home), [true, true, false, false], "a small café or office opens by the front door it always had");

  for (const v of venues) {
    const b = f.buildings.find((x) => x.id === v.id)!;
    const ring = b.ring.map(([wx, wy]): [number, number] => [(wx - CX) * S, -(wy - CY) * S]);
    const what = `${v.kind} ${v.id}`;
    // Two doors, on different walls, each on the outline with open air outside it; the front one faces the road to the north.
    assert.equal(v.doors.length, 2, `${what}: a way through`);
    assert.ok(v.doors[0].out[1] > 0.99, `${what}: the front door faces the street`);
    assert.ok(v.doors[0].out[0] * v.doors[1].out[0] + v.doors[0].out[1] * v.doors[1].out[1] < 0.5, `${what}: the second door is on another side`);
    for (const door of v.doors) {
      assert.ok(within(ring, door.x - door.out[0] * 0.3, door.y - door.out[1] * 0.3) && !within(ring, door.x + door.out[0] * 0.3, door.y + door.out[1] * 0.3), `${what}: a door on its wall`);
      for (const other of f.buildings) if (other !== b) assert.ok(!within(other.ring.map(([wx, wy]): [number, number] => [(wx - CX) * S, -(wy - CY) * S]), door.x + door.out[0] * 1.5, door.y + door.out[1] * 1.5), `${what}: a door into the neighbour`);
      assert.ok(within(ring, door.ix - door.iout[0] * 0.9, door.iy - door.iout[1] * 0.9), `${what}: a step inside the door is inside the building`);
      assert.ok(Math.abs(door.g - GROUND) < 0.01);
    }
    // The mesh: within the real walls (and out of the courtyard), between the floor and the ceiling.
    const mesh = venueMesh(v, S);
    const yards = (b.holes ?? []).map((h) => h.map(([wx, wy]): [number, number] => [(wx - CX) * S, -(wy - CY) * S]));
    let floor = 0;
    for (const s of mesh.sections) {
      assert.ok(s.mat.id >= 40 && s.mat.id <= 45, "the surfaces of a house's inside");
      assert.equal(s.mat.collision, s.mat.id === INSIDE.floor.id || s.mat.id === INSIDE.wall.id || s.mat.id === INSIDE.furniture.id);
      for (let i = 0; i < s.pos.length; i += 3) {
        const [e, n, h] = [s.pos[i], s.pos[i + 1], s.pos[i + 2]];
        // (A hand's breadth of leave: the room's corners are on the walls themselves.)
        const mid = [(ring[0][0] + ring[2][0]) / 2, (ring[0][1] + ring[2][1]) / 2];
        assert.ok(within(ring, e + (mid[0] - e) * 0.002, n + (mid[1] - n) * 0.002), `${what}: outside its walls at (${e.toFixed(2)}, ${n.toFixed(2)})`);
        for (const yard of yards) assert.ok(!within(yard, e, n), `${what}: in the courtyard`);
        assert.ok(h >= v.floor - 1e-6 && h <= v.floor + v.spec.ceiling + 1e-6, `${what}: between the floor and the ceiling`);
      }
      if (s.mat.id === INSIDE.floor.id) floor += s.idx.length / 3;
    }
    assert.ok(floor > 0 && Math.abs(v.floor - (GROUND + 0.06)) < 1e-6);
    // Who is inside: in the building, each their own animal, the same every time.
    const who = venueWho(v, CX, CY, S);
    assert.deepEqual(venueWho(v, CX, CY, S), who);
    assert.deepEqual([who.x, who.y, who.id, who.use], [CX, CY, v.id, v.kind]);
    assert.equal(new Set(who.people.map((p) => p.id)).size, who.people.length);
    for (const p of who.people) {
      assert.ok(within(ring, p.u * S, -p.v * S) && FIGURES.includes(p.sp) && p.id > 0 && p.yaw >= 0 && p.yaw < 360 && Math.abs(p.h - v.floor) < 0.01, `${what}: ${JSON.stringify(p)}`);
      for (let i = 0; p.pts && i < p.pts.length; i += 2) assert.ok(within(ring, p.pts[i] * S, -p.pts[i + 1] * S));
    }
    for (const s of who.signs) assert.ok(within(ring, s.u * S, -s.v * S) && s.h > v.floor && s.text.length > 0);
  }
  // The row of three: the middle shop's second door can only be at the back, on the real wall.
  const mid = by.get(9)!;
  assert.ok(mid.doors[1].out[1] < -0.99 && Math.hypot(mid.doors[1].ix - mid.doors[1].x, mid.doors[1].iy - mid.doors[1].y) < 0.3);
  // The office round a courtyard keeps its rooms in front of the yard.
  assert.ok(by.get(11)!.spec.depth <= 10 - 0.5, `stops short of the courtyard (${by.get(11)!.spec.depth} m deep)`);
  // The mall is as big as a mall may be; the café is its whole building.
  assert.deepEqual([by.get(7)!.spec.width, by.get(7)!.spec.depth], [40, 60]);
  assert.deepEqual([by.get(1)!.spec.width, by.get(1)!.spec.depth], [10, 8]);

  // ---- the labels
  const items = buildLabels(CX, CY, f, elev);
  const doors = items.filter((it) => it.kind === "door");
  assert.deepEqual(doors.map((it) => [it.id, it.use, it.text]).sort((p, q) => (p[0] as number) - (q[0] as number)), [[1, "cafe", "Kettle Café"], [2, "office", "Harbour Works"], [4, undefined, undefined]], "a house's door, and the café's and the small office's, which say what they are");
  const entries = items.filter((it) => it.kind === "entry");
  assert.equal(entries.length, venues.reduce((n, v) => n + v.doors.length, 0) - 2, "every other door of theirs is an entry");
  for (const it of entries) {
    const v = by.get(it.id!)!;
    const door = v.doors.find((x) => Math.abs(it.u * S - x.x) < 0.01 && Math.abs(-it.v * S - x.y) < 0.01)!;
    assert.ok(door && it.use === v.kind && Math.abs(it.h - v.floor) < 0.01 && Math.abs(it.g! - GROUND) < 0.01, JSON.stringify(it));
    const out = [Math.sin((it.yaw * Math.PI) / 180), Math.cos((it.yaw * Math.PI) / 180)];
    assert.ok(Math.abs(out[0] - door.out[0]) < 0.01 && Math.abs(out[1] - door.out[1]) < 0.01, "yaw is the way out");
    // Where the door inside is somewhere else, the labels say where.
    const apart = Math.hypot(door.ix - door.x, door.iy - door.y) > 0.8;
    assert.equal(it.iu !== undefined, apart || door.iout[0] * door.out[0] + door.iout[1] * door.out[1] < 0.98);
    if (it.iu !== undefined) assert.ok(Math.abs(it.iu * S - door.ix) < 0.01 && Math.abs(-it.iv! * S - door.iy) < 0.01 && it.iyaw !== undefined);
  }
  // A block of flats or a hotel (and a big building the map says nothing about, which is drawn as one) has a front door in the mesh already.
  assert.deepEqual([...new Set(entries.filter((it) => it.drawn).map((it) => it.id))].sort((p, q) => p! - q!), [3, 6, 12]);
  assert.deepEqual(entries.filter((it) => it.text).map((it) => it.text).sort(), ["Hotel Kiwi", "Left", "Paper Kite Books", "Right", "Riverside Mall"], "its name comes with its front door");
  assert.ok(JSON.stringify(entries).length < venues.length * 2 * 190, "under 190 bytes a door");

  // ---- nobody can make a café their home; the house, they can
  const load = async (): Promise<Features> => f;
  assert.equal(await findHome(CX, CY, 1, elev, load), null);
  assert.ok(await findHome(CX, CY, 4, elev, load));
  // ---- and the route's two halves
  const cafe = await generateInside(CX, CY, 1, elev, load);
  assert.ok(cafe && cafe.mesh.readUInt32LE(0) === 0x31435745 && JSON.parse(cafe.who!.toString("utf8")).use === "cafe");
  const house = await generateInside(CX, CY, 4, elev, load);
  assert.ok(house && house.mesh.length > 1000 && house.who === null, "a house has rooms and nobody in them");
  assert.equal(await generateInside(CX, CY, 5, elev, load), null, "the church is shut");
});

test("a city block opens no more buildings than a chunk may carry, the named ones first", async () => {
  const elev = await level();
  const buildings: Features["buildings"] = [];
  for (let i = 0; i < 60; i++) {
    const west = CX + 0.05 + d((i % 12) * 30), north = CY + 0.1 + d(Math.floor(i / 12) * 60);
    buildings.push({ id: 100 + i, ring: [[west, north], [west + d(24), north], [west + d(24), north + d(20)], [west, north + d(20)]], height: 14, kind: "office", ...(i % 5 === 0 ? { name: `Office ${i}` } : {}) });
  }
  const f = { buildings, roads: [], areas: [], trees: [], addresses: [], coast: [] } as unknown as Features;
  const venues = venuesOf(CX, CY, f, elev);
  assert.equal(venues.length, VENUE_CAP);
  assert.ok(buildings.filter((b) => b.name).every((b) => venues.some((v) => v.id === b.id)), "every named one is in");
});

test("GET /v1/inside says who is in a shop, and the interior route serves its rooms", async () => {
  const asked: string[] = [];
  const kept = new Map<string, Buffer>();
  const options = {
    buildInside: async (x: number, y: number, id: number) => {
      asked.push(`${x}/${y}/${id}`);
      return id === 7 ? { mesh: Buffer.from("shop"), who: Buffer.from('{"use":"shop","people":[]}') } : id === 8 ? { mesh: Buffer.from("rooms"), who: null } : null;
    },
    readCache: async (rel: string) => kept.get(rel) ?? null,
    writeCache: async (rel: string, data: Buffer) => void kept.set(rel, data),
  };
  const open = createApp(options);
  const locked = createApp({ ...options, accessCode: "otter-42" });
  await Promise.all([open, locked].map((a) => new Promise<void>((r) => a.server.listen(0, r))));
  const base = (a: typeof open): string => `http://localhost:${(a.server.address() as AddressInfo).port}`;
  try {
    const who = await fetch(`${base(open)}/v1/inside/16/1/2/7`);
    assert.deepEqual([who.status, who.headers.get("content-type"), await who.json()], [200, "application/json; charset=utf-8", { use: "shop", people: [] }]);
    const rooms = await fetch(`${base(open)}/v1/interior/16/1/2/7`);
    assert.deepEqual([rooms.status, await rooms.text()], [200, "shop"]);
    assert.equal((await fetch(`${base(open)}/v1/inside/16/1/2/7`)).status, 200);
    assert.deepEqual(asked, ["1/2/7"], "both halves are built together, once, and kept");
    // A house has rooms and nobody in them; a building that is shut has neither.
    assert.equal((await fetch(`${base(open)}/v1/interior/16/1/2/8`)).status, 200);
    assert.equal((await fetch(`${base(open)}/v1/inside/16/1/2/8`)).status, 404);
    assert.equal((await fetch(`${base(open)}/v1/inside/16/1/2/9`)).status, 404);
    // A building mapped as a relation has a number below zero.
    assert.equal((await fetch(`${base(open)}/v1/inside/16/1/2/-9`)).status, 404);
    assert.ok(asked.includes("1/2/-9"));
    assert.equal((await fetch(`${base(open)}/v1/inside/15/1/2/7`)).status, 400);
    assert.equal((await fetch(`${base(locked)}/v1/inside/16/1/2/7`)).status, 401);
    assert.equal((await fetch(`${base(locked)}/v1/inside/16/1/2/7`, { headers: { Authorization: "Bearer otter-42" } })).status, 200);
  } finally {
    open.close();
    locked.close();
  }
});

test("a stroller is in the same place for everybody: out along the path, a wait, back, a wait", () => {
  // An L of 6 m and 3 m: 9 m at 0.9 m/s is ten seconds each way, with four seconds at each end.
  const pts = [10, 20, 10, 26, 13, 26];
  const period = 2 * (9 / STROLL_PACE + STROLL_WAIT);
  assert.equal(period, 28);
  const id = 123456789;
  // Find when they set off: the start of a round is somewhere in one period, different for each of them.
  let start = 0;
  for (let t = 0; t < period; t += 0.01) {
    const a = strollAt(id, pts, t), b = strollAt(id, pts, t + 0.02);
    if (!a.moving && b.moving && Math.hypot(b.x - 10, b.z - 20) < 0.1) { start = t + 0.01; break; }
  }
  const at = (s: number): ReturnType<typeof strollAt> => strollAt(id, pts, start + s);
  const near = (p: { x: number; z: number }, x: number, z: number): boolean => Math.hypot(p.x - x, p.z - z) < 0.05;
  assert.ok(near(at(0.02), 10, 20) && at(1).moving && near(at(1), 10, 20.9), "sets off along the first stretch");
  assert.ok(Math.abs(at(1).fx) < 1e-9 && at(1).fz === 1, "facing the way they walk");
  assert.ok(near(at(8), 11.2, 26) && at(8).fx === 1, "round the corner");
  assert.ok(near(at(11), 13, 26) && !at(11).moving && at(11).fx === -1, "standing at the far end, turned round");
  assert.ok(at(15).moving && near(at(15), 12.1, 26) && at(15).fx === -1, "on the way back");
  assert.ok(near(at(25), 10, 20) && !at(25).moving && at(25).fz === 1, "home again, turned to set off");
  assert.deepEqual(at(period + 3), at(3), "and round again, the same");
  // Never faster than the pace, never off the path, and not everybody in step.
  for (let s = 0; s < period; s += 0.25) {
    const p = at(s), q = at(s + 0.25);
    assert.ok(Math.hypot(q.x - p.x, q.z - p.z) <= STROLL_PACE * 0.25 + 1e-9);
    assert.ok((Math.abs(p.x - 10) < 1e-9 && p.z >= 20 - 1e-9 && p.z <= 26 + 1e-9) || (Math.abs(p.z - 26) < 1e-9 && p.x >= 10 - 1e-9 && p.x <= 13 + 1e-9), "on the path");
  }
  const other = strollAt(987654321, pts, start + 3);
  assert.ok(Math.hypot(other.x - at(3).x, other.z - at(3).z) > 0.5 || other.moving !== at(3).moving, "each in their own time");
  assert.deepEqual(strollAt(id, [5, 5, 5, 5], 77), { x: 5, z: 5, fx: 0, fz: 1, moving: false }, "a path of no length is somewhere to stand");
});

test("whoever is inside knows what they do there, with an AI to ask or without", async () => {
  // Only a role there is: anything else a game sends is nobody's job.
  assert.deepEqual(jobOf("barista", { use: "cafe", name: "Kettle & Crumb" }), { role: "barista", place: "Kettle & Crumb" });
  assert.deepEqual(jobOf("keeper", { use: "shop" }), { role: "keeper", place: "this shop" });
  assert.deepEqual(jobOf("worker", null), { role: "worker", place: "this place" });
  for (const bad of ["boss", "constructor", "__proto__", "", 7, null, undefined]) assert.equal(jobOf(bad, { use: "shop" }), null);
  for (const role of ["worker", "meeting", "reception", "keeper", "barista", "shopper", "guest", "caretaker", "resident"]) {
    assert.ok(ROLES[role].hello.length === 2 && ROLES[role].lines.length >= 3 && ROLES[role].is.includes("{place}"), role);
  }
  for (const sp of FIGURES) assert.ok(TALKABLE.has(sp), `${sp} can be talked to`);

  // Without an AI: a hello about the job, then lines about it turn and turn about with the animal's own.
  const quiet = new Talker({ ask: null, spendFile: null });
  const job = jobOf("barista", { use: "cafe", name: "Kettle & Crumb" })!;
  const name = persona(4242, "rabbit").name;
  const hello = quiet.greet(4242, "rabbit", job);
  assert.ok(hello.name === name && /Kettle & Crumb|What can I get you/.test(hello.text) && hello.text.includes(name) && !hello.text.includes("{"), hello.text);
  assert.notEqual(quiet.greet(4242, "rabbit").text, hello.text, "out of doors the same rabbit is only a rabbit");
  const first = await quiet.reply("room", 4242, "rabbit", "hello there", "fox", null, false, [], false, job);
  const second = await quiet.reply("room", 4242, "rabbit", "and then?", "fox", null, false, [], false, job);
  assert.ok(ROLES.barista.lines.includes(first.text) !== ROLES.barista.lines.includes(second.text), `${first.text} / ${second.text}`);

  // With one: it is told what they do and where, and still that they are a rabbit.
  const asked: string[] = [];
  const talker = new Talker({ ask: async (_model, system) => { asked.push(system); return { text: "One hot chocolate, coming up!", inputTokens: 500, outputTokens: 20 }; }, monthlyUsd: 30, spendFile: null });
  const said = await talker.reply("room", 4242, "rabbit", "what do you do?", "fox", "Ponsonby, Auckland", false, [], false, job);
  assert.deepEqual([said.text, said.ai], ["One hot chocolate, coming up!", true]);
  assert.ok(asked[0].includes("make the drinks and serve the food at Kettle & Crumb") && asked[0].includes("a rabbit") && asked[0].includes("indoors"), asked[0].slice(-400));
  await talker.reply("room", 4242, "rabbit", "what do you do?", "fox", null);
  assert.ok(!asked[1].includes("Kettle & Crumb"), "and nothing of the sort when it has no job");
});
