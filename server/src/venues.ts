// Which buildings that are not homes can be walked into, what each is inside, and where its doors
// are. A house has rooms (interior.ts); a shop, a café, an office, a mall, a block of flats, a hotel, a
// church, a school, a hospital, a factory or a petrol station has the inside venue.ts lays out for it, with a way through: the door on the street, and a second
// door on another side wherever one of its walls is free.
//
// Like a house's rooms, the inside is the largest rectangle that fits within the real walls behind
// the front door, up to a size that depends on what the building is. The second door is on the real
// wall where the rectangle reaches it; where it does not (a building of an awkward shape), the door
// outside is on whichever wall is free, and the door inside is on the nearest wall of the room, so
// going through it moves you a few metres. docs/PROTOCOL.md, "Inside other buildings".

import { CHUNK_Z, hash32, metersPerTile } from "./geo.ts";
import { BARN_KINDS, type ChunkMesh, encodeChunk, face, featuresForChunk, type HomeDoor, homesOf, type MaterialDef, painted, roomInside, Section, type Shell, shellsOf } from "./chunk.ts";
import type { Elevation } from "./elevation.ts";
import { buildInterior } from "./interior.ts";
import { type Building, type Features, loadFeatures, useOf } from "./osm.ts";
import { layVenue, type NamedShop, tradeOf, useWord, type VenueDoor, type VenueKind, type VenueSpec } from "./venue.ts";

type XY = [number, number];

/** Bump when what is inside these buildings, or who, changes: the people file is kept beside the mesh. */
// (2: churches, schools, hospitals, factories and warehouses opened, and a mall's way to a side door got walls. 1 went out in 0.2.47.)
export const VENUES_REV = 2;
/** A chunk of a city centre has a hundred such buildings; this many open, those the map names first. */
export const VENUE_CAP = 40;
/** The animals the people inside are: the six a player can be, so both games already draw them sitting and walking. */
export const FIGURES = ["fox", "bear", "rabbit", "cat", "owl", "frog"];

/** How big the room may be for each kind of place, and the least it must be, in metres; and how high its ceiling may be. */
const SIZE: Record<VenueKind, { wide: number; deep: number; least: number; ceiling: number }> = {
  office: { wide: 30, deep: 24, least: 6, ceiling: 3.0 },
  shop: { wide: 16, deep: 16, least: 4.5, ceiling: 3.0 },
  cafe: { wide: 14, deep: 12, least: 4.5, ceiling: 3.0 },
  mall: { wide: 40, deep: 60, least: 11, ceiling: 4.2 },
  lobby: { wide: 12, deep: 10, least: 4.5, ceiling: 3.2 },
  church: { wide: 22, deep: 34, least: 6, ceiling: 5.5 },
  school: { wide: 30, deep: 36, least: 6, ceiling: 3.0 },
  hospital: { wide: 30, deep: 36, least: 6, ceiling: 3.0 },
  factory: { wide: 30, deep: 40, least: 6, ceiling: 6.0 },
};
const SLOPE_M = 6;
const CEILING_LEAST_M = 2.3;

/** One door: where it is on the real wall and the way out of it, the ground there, and the same door seen from inside (on the room's wall). */
export interface VenueEntry { x: number; y: number; out: XY; g: number; ix: number; iy: number; iout: XY; /** The mesh draws a door here already (the front door of a block of flats). */ drawn?: boolean }
export interface Venue {
  id: number;
  kind: VenueKind;
  /** The word for what it is (venue.ts, `useWord`): its kind, but "mosque", "temple" or "clinic" where it is one of those. */
  use: string;
  name?: string;
  /** The room's frame: its front corner, the way along the front wall and the way back into the building; chunk-local metres. */
  A: XY; ta: XY; tb: XY;
  floor: number;
  spec: VenueSpec;
  /** The front door first. */
  doors: VenueEntry[];
  /** True when its front door is a home's front door (a small shop that opened as a house before): the labels already list that one. */
  home: boolean;
}

function inRing(e: number, n: number, ring: XY[]): boolean {
  let odd = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > n !== yj > n && e < ((xj - xi) * (n - yi)) / (yj - yi) + xi) odd = !odd;
  }
  return odd;
}

const HOUSES = /^(house|detached|semidetached_house|terrace|bungalow|cabin|static_caravan|houseboat|farm)$/;
const FLATS = /^(apartments|dormitory|residential|hotel)$/;
const OFFICES = /^(office|commercial|government|civic|public)$/;
const NOT_ROOMS = /^(garage|garages|shed|carport|roof|greenhouse|hut|toilets|transformer_tower|service|kiosk)$/;
const MALL_NAME = /\b(mall|arcade|shopping|galler|plaza|market|passage|centre commercial|emporium)\b/i;
const STAYS = /^tourism=(hotel|hostel|motel|guest_house)$/;
/** Buildings of a university or a college are schools inside, though no flag flies outside them. */
const COLLEGES = /^(university|college)$/;
/** Where things are made, and where they are kept. */
const WORKS = /^(industrial|factory|manufacture|warehouse)$/;

/** The buildings of a chunk that are not homes and can be walked into. */
function findVenues(cx: number, cy: number, features: Features, elev: Elevation): Venue[] {
  const S = metersPerTile(cy + 0.5, CHUNK_Z);
  const E = (wx: number): number => (wx - cx) * S;
  const N = (wy: number): number => -(wy - cy) * S;
  const ground = (e: number, n: number): number => elev.surfaceHeight(cx + e / S, cy - n / S);
  const homes = new Map<number, HomeDoor>(homesOf(cx, cy, features, elev).map((h) => [h.id, h]));
  const shells = new Map<number, Shell>(shellsOf(cx, cy, features, elev).map((s) => [s.id, s]));

  // Streets and paths near the chunk, for telling which walls face one.
  const ways: XY[] = [];
  for (const road of features.roads) {
    if (road.cls !== "road" && road.cls !== "path") continue;
    for (let i = 0; i < road.pts.length; i++) {
      const [wx, wy] = road.pts[i];
      if (wx < cx - 0.3 || wx > cx + 1.3 || wy < cy - 0.3 || wy > cy + 1.3) continue;
      ways.push([E(wx), N(wy)]);
      if (i + 1 < road.pts.length) {
        const [nx, ny] = road.pts[i + 1];
        const steps = Math.min(40, Math.floor((Math.hypot(nx - wx, ny - wy) * S) / 12));
        for (let k = 1; k < steps; k++) ways.push([E(wx + ((nx - wx) * k) / steps), N(wy + ((ny - wy) * k) / steps)]);
      }
    }
  }
  const facesWay = (e: number, n: number, o: XY, within: number): boolean => {
    for (const [qe, qn] of ways) {
      const de = qe - e, dn = qn - n;
      if (de * o[0] + dn * o[1] > 1 && Math.hypot(de, dn) < within) return true;
    }
    return false;
  };

  // Every building near the chunk, in its metres, with a box round it: what may stand against a wall.
  interface Near { b: Building; ring: XY[]; x0: number; x1: number; y0: number; y1: number }
  const near: Near[] = [];
  for (const b of features.buildings) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const ring = b.ring.map(([x, y]): XY => {
      const e = E(x), n = N(y);
      if (e < x0) x0 = e; if (e > x1) x1 = e; if (n < y0) y0 = n; if (n > y1) y1 = n;
      return [e, n];
    });
    if (x1 < -0.4 * S || x0 > 1.4 * S || y1 < -1.4 * S || y0 > 0.4 * S) continue;
    near.push({ b, ring, x0, x1, y0, y1 });
  }
  const builtOn = (e: number, n: number, but: Building): boolean => {
    for (const o of near) if (o.b !== but && e >= o.x0 && e <= o.x1 && n >= o.y0 && n <= o.y1 && inRing(e, n, o.ring)) return true;
    return false;
  };

  const found: (Venue & { rank: number })[] = [];
  for (const { b, ring: ring0, x0, x1, y0, y1 } of near) {
    let mx = 0, my = 0;
    for (const [x, y] of b.ring) { mx += x; my += y; }
    mx /= b.ring.length; my /= b.ring.length;
    if (mx < cx || mx >= cx + 1 || my < cy || my >= cy + 1) continue;
    const shell = shells.get(b.id);
    if (!shell || shell.raised) continue; // mapped in 3D pieces, or standing on legs
    const home = homes.get(b.id);
    if (home && !home.use) continue; // a home
    let ring = ring0;
    let area2 = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area2 += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    if (area2 < 0) ring = [...ring].reverse();
    const area = Math.abs(area2) / 2;
    const k = b.kind ?? "";
    if (area < 35 || NOT_ROOMS.test(k) || BARN_KINDS.test(k)) continue;

    // What the map names inside it: shops and places to eat (a mall's), and anywhere to stay.
    const shops: NamedShop[] = [];
    let stays = false, trade: string | undefined;
    for (const place of features.places ?? []) {
      const e = E(place.at[0]), n = N(place.at[1]);
      if (e < x0 || e > x1 || n < y0 || n > y1 || !inRing(e, n, ring)) continue;
      if (STAYS.test(place.kind)) stays = true;
      const [key, value] = place.kind.split("=");
      const use = useOf({ [key]: value });
      if (use === "shop" || use === "food") {
        if (shops.length < 24 && !shops.some((s) => s.name === place.name)) shops.push({ name: place.name.slice(0, 30), ...(use === "food" ? { food: true } : {}) });
        if (key === "shop" && b.name && place.name.startsWith(b.name)) trade = value;
      }
    }

    // ---- what it is
    const big = area >= 400 || b.height >= 13;
    let kind: VenueKind | null = null;
    let hotel = false;
    let faith: "mosque" | "temple" | undefined;
    let fuel = false;
    const wantsMall = (shops.length >= 3 && area >= 250) || area >= 2500 || MALL_NAME.test(b.name ?? "");
    if (b.use === "food") kind = shops.length >= 3 && area >= 400 ? "mall" : "cafe";
    else if (b.use === "shop") kind = wantsMall ? "mall" : "shop";
    else if (b.use === "church" || b.use === "mosque" || b.use === "temple") { kind = "church"; if (b.use !== "church") faith = b.use; }
    else if (b.use === "school") kind = "school";
    else if (b.use === "hospital") kind = "hospital";
    else if (b.use === "fuel") { kind = "shop"; fuel = true; } // a petrol station's shop
    else if (b.use) kind = null;
    else if (home && !home.use) kind = null;
    else if (k === "hotel" || (stays && !HOUSES.test(k))) { kind = "lobby"; hotel = true; }
    else if (FLATS.test(k)) kind = "lobby";
    else if (COLLEGES.test(k)) kind = "school";
    else if (WORKS.test(k)) kind = "factory";
    else if (HOUSES.test(k)) kind = null;
    else if (OFFICES.test(k)) kind = "office";
    else if (k === "" || k === "yes") {
      // "A building", and no more: if it is a big one it is an office, or now and then a row of shops of our own.
      if (big) kind = shops.length >= 2 || hash32(b.id, 0x4b494e44) % 6 >= 4 ? "mall" : "office";
    }
    if (!kind) continue;
    // (A building that has its name from one of the shops inside it is not called that as a row of shops.)
    const name = kind === "mall" && b.name && shops.some((s) => s.name.startsWith(b.name!) || b.name!.startsWith(s.name)) ? undefined : b.name;

    // ---- its front door: the home's, the one the mesh draws, the middle of its shopfront, or the wall facing the street
    let door: { x: number; y: number; along: XY; out: XY } | null = home ? { x: home.x, y: home.y, along: home.along, out: home.out } : shell.door ?? shell.front ?? null;
    if (!door) {
      let best = -1, bestScore = Infinity;
      for (let i = 0; i < ring.length; i++) {
        const [ae, an] = ring[i], [be, bn] = ring[(i + 1) % ring.length];
        const len = Math.hypot(be - ae, bn - an);
        if (len < 2.6) continue;
        const me = (ae + be) / 2, mn = (an + bn) / 2;
        const o: XY = [(bn - an) / len, -(be - ae) / len];
        if (builtOn(me + o[0] * 1.5, mn + o[1] * 1.5, b)) continue;
        let score = 1000 - len;
        for (const [qe, qn] of ways) {
          const de = qe - me, dn = qn - mn;
          if (de * o[0] + dn * o[1] <= 1) continue;
          const dist = Math.hypot(de, dn);
          if (dist < 90 && dist < score) score = dist;
        }
        if (score < bestScore) { bestScore = score; best = i; }
      }
      if (best < 0) continue;
      const [ae, an] = ring[best], [be, bn] = ring[(best + 1) % ring.length];
      const len = Math.hypot(be - ae, bn - an);
      door = { x: (ae + be) / 2, y: (an + bn) / 2, along: [(be - ae) / len, (bn - an) / len], out: [(bn - an) / len, -(be - ae) / len] };
    }

    // ---- its room: as much as its kind may have of what fits behind that door. A mall too small to be one is a shop or an office.
    const roomFor = (as: VenueKind): XY[] | null => roomInside(ring, door!.x, door!.y, door!.along, door!.out, SIZE[as].wide, SIZE[as].deep, SIZE[as].least);
    let corners = roomFor(kind);
    if (!corners && kind === "mall") {
      kind = b.use === "shop" ? "shop" : b.use === "food" ? "cafe" : "office";
      corners = roomFor(kind);
    }
    if (!corners && home) corners = fromHome(home);
    if (!corners) continue;
    const A = corners[0];
    let width = Math.hypot(corners[1][0] - A[0], corners[1][1] - A[1]), depth = Math.hypot(corners[2][0] - corners[1][0], corners[2][1] - corners[1][1]);
    const ta: XY = [(corners[1][0] - A[0]) / width, (corners[1][1] - A[1]) / width];
    const tb: XY = [(corners[2][0] - corners[1][0]) / depth, (corners[2][1] - corners[1][1]) / depth];
    const P = (a: number, c: number): XY => [A[0] + ta[0] * a + tb[0] * c, A[1] + ta[1] * a + tb[1] * c];
    // A courtyard is not part of the room: the room stops short of it.
    for (const yard of b.holes ?? []) {
      for (let i = 0; i < yard.length; i++) {
        const p = yard[i], q = yard[(i + 1) % yard.length];
        const steps = Math.max(1, Math.ceil((Math.hypot(q[0] - p[0], q[1] - p[1]) * S) / 1.0));
        for (let s = 0; s < steps; s++) {
          const e = E(p[0] + ((q[0] - p[0]) * s) / steps) - A[0], n = N(p[1] + ((q[1] - p[1]) * s) / steps) - A[1];
          const a = e * ta[0] + n * ta[1], c = e * tb[0] + n * tb[1];
          if (a > -0.6 && a < width + 0.6 && c > -0.6 && c < depth + 0.6) depth = Math.min(depth, c - 0.6);
        }
      }
    }
    if (depth < SIZE[kind].least && !home) continue;

    // ---- its floor: level with the highest ground under the room, so no hillside comes up through it
    let low = Infinity, high = -Infinity;
    const na = Math.max(1, Math.ceil(width / 2.5)), nb = Math.max(1, Math.ceil(depth / 2.5));
    for (let i = 0; i <= na; i++) for (let j = 0; j <= nb; j++) {
      const [e, n] = P((width * i) / na, (depth * j) / nb);
      const g = ground(e, n);
      if (g < low) low = g;
      if (g > high) high = g;
    }
    if (!home && high - low > SLOPE_M) continue;
    const floor = home ? home.floor : high + 0.06;
    const ceiling = Math.min(SIZE[kind].ceiling, shell.top - floor - 0.12);
    if (ceiling < CEILING_LEAST_M) continue;

    // ---- its second door: on another side of the room, where the real wall is there and nothing is built against it
    const frontAt = Math.min(width - 1, Math.max(1, (door.x - A[0]) * ta[0] + (door.y - A[1]) * ta[1]));
    const sides: { side: 1 | 2 | 3; len: number; at: (s: number) => XY; out: XY }[] = [
      { side: 1, len: width, at: (s) => P(s, depth), out: tb },
      { side: 2, len: depth, at: (s) => P(0, s), out: [-ta[0], -ta[1]] },
      { side: 3, len: depth, at: (s) => P(width, s), out: ta },
    ];
    /** Is the real wall just outside this spot of the room's side, with open air beyond it? */
    const open = (p: XY, o: XY): boolean => !inRing(p[0] + o[0] * 0.6, p[1] + o[1] * 0.6, ring) && !builtOn(p[0] + o[0] * 1.2, p[1] + o[1] * 1.2, b) && !builtOn(p[0] + o[0] * 2.2, p[1] + o[1] * 2.2, b);
    let second: { side: 1 | 2 | 3; lo: number; hi: number; score: number; outside?: { x: number; y: number; out: XY } } | null = null;
    for (const s of sides) {
      // The longest run of the side where a door (0.85 m either way) would be all on open wall.
      const STEP = 0.4;
      let run: [number, number] | null = null, best: [number, number] | null = null;
      let clearFor = 0;
      for (let d = 0.35; d <= s.len - 0.35 + 1e-6; d += STEP) {
        clearFor = open(s.at(d), s.out) ? clearFor + STEP : 0;
        const centre = d - 0.85;
        if (clearFor >= 1.7 + STEP - 1e-6 && centre >= 1.2 && centre <= s.len - 1.2) {
          run = run ? [run[0], centre] : [centre, centre];
          if (!best || run[1] - run[0] > best[1] - best[0]) best = run;
        } else if (clearFor === 0) run = null;
      }
      if (!best) continue;
      const mid = s.at((best[0] + best[1]) / 2);
      const score = (facesWay(mid[0], mid[1], s.out, 45) ? 100 : 0) + (s.side === 1 ? 20 : 10) + Math.min(10, best[1] - best[0]);
      if (!second || score > second.score) second = { side: s.side, lo: best[0], hi: best[1], score };
    }
    if (!second) {
      // No side of the room is on a free wall: any other free wall of the building will do, the most unlike the front one.
      let bestScore = -Infinity;
      for (let i = 0; i < ring.length; i++) {
        const [ae, an] = ring[i], [be, bn] = ring[(i + 1) % ring.length];
        const len = Math.hypot(be - ae, bn - an);
        if (len < 2.6) continue;
        const o: XY = [(bn - an) / len, -(be - ae) / len];
        const same = o[0] * door.out[0] + o[1] * door.out[1];
        const me = (ae + be) / 2, mn = (an + bn) / 2;
        if (same > 0.5 || builtOn(me + o[0] * 1.2, mn + o[1] * 1.2, b) || builtOn(me + o[0] * 2.2, mn + o[1] * 2.2, b)) continue;
        const score = (facesWay(me, mn, o, 45) ? 100 : 0) - same * 20 + Math.min(10, len);
        if (score <= bestScore) continue;
        bestScore = score;
        // (The door inside is on the side of the room that faces most nearly the same way.)
        let side = sides[0];
        for (const s of sides) if (s.out[0] * o[0] + s.out[1] * o[1] > side.out[0] * o[0] + side.out[1] * o[1]) side = s;
        if (side.len < 2.6) continue;
        second = { side: side.side, lo: 1.2, hi: side.len - 1.2, score, outside: { x: me, y: mn, out: o } };
      }
    }

    // ---- laid out
    const seed = hash32(b.id, 0x56454e55);
    const spec: VenueSpec = {
      kind, width: Math.round(width * 100) / 100, depth: Math.round(depth * 100) / 100, ceiling: Math.round(ceiling * 100) / 100, seed,
      doors: [{ side: 0, at: Math.round(frontAt * 100) / 100 }, ...(second ? [{ side: second.side, at: (second.lo + second.hi) / 2, lo: second.lo, hi: second.hi } as VenueDoor] : [])],
      ...(name ? { name } : {}),
      ...(kind === "shop" ? { trade: fuel ? "motor" : tradeOf(trade ?? (b.kind === "supermarket" ? "supermarket" : undefined), b.name, seed) } : {}),
      ...(kind === "shop" && fuel ? { fuel } : {}),
      ...(kind === "factory" && k === "warehouse" ? { store: true } : {}),
      ...(kind === "mall" && shops.length ? { shops } : {}),
      ...(hotel ? { hotel } : {}),
      ...(kind === "church" && faith ? { faith } : {}),
    };
    const laid = layVenue(spec);
    const doors: VenueEntry[] = [];
    const g = (x: number, y: number, o: XY): number => Math.round(ground(x + o[0] * 0.3, y + o[1] * 0.3) * 100) / 100;
    const inFront = P(laid.doors[0].at, 0);
    doors.push({ x: door.x, y: door.y, out: door.out, g: g(door.x, door.y, door.out), ix: inFront[0], iy: inFront[1], iout: [-tb[0], -tb[1]], ...(!home && door === shell.door ? { drawn: true } : {}) });
    if (second && laid.doors[1]) {
      const s = sides.find((x) => x.side === laid.doors[1].side)!;
      const inside = s.at(laid.doors[1].at);
      let outside = second.outside;
      if (!outside) {
        // Straight out through the real wall, which is within a stride. (A mall's back door is at the end of
        // its walk, which may not be where the wall is free: the door outside is then the nearest place that is.)
        const from = s.at(Math.min(second.hi, Math.max(second.lo, laid.doors[1].at)));
        let reach = 0;
        while (reach < 0.7 && inRing(from[0] + s.out[0] * (reach + 0.05), from[1] + s.out[1] * (reach + 0.05), ring)) reach += 0.05;
        outside = { x: from[0] + s.out[0] * reach, y: from[1] + s.out[1] * reach, out: s.out };
      }
      doors.push({ x: outside.x, y: outside.y, out: outside.out, g: g(outside.x, outside.y, outside.out), ix: inside[0], iy: inside[1], iout: s.out });
    }
    const rank = (home ? 5000 : 0) + (b.name ? 2000 : 0) + (b.use ? 1000 : 0) + Math.min(999, area / 20);
    // (What was laid out is not kept: a chunk's labels need only the doors, and a mall is a thousand pieces. It is laid out again, the same, when somebody walks in.)
    found.push({ id: b.id, kind, use: useWord(spec), ...(name ? { name } : {}), A, ta, tb, floor, spec, doors, home: !!home, rank });
  }
  found.sort((p, q) => q.rank - p.rank || p.id - q.id);
  return found.slice(0, VENUE_CAP).map(({ rank: _rank, ...venue }) => venue);
}

/** The room of a home that is a shop, from the corners it was given as a home: the two on the wall its door is on first. */
function fromHome(home: HomeDoor): XY[] {
  const c = home.corners;
  let front = 0, nearest = Infinity;
  for (let i = 0; i < 4; i++) {
    const p = c[i], q = c[(i + 1) % 4];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const off = Math.abs(((home.x - p[0]) * (q[1] - p[1]) - (home.y - p[1]) * (q[0] - p[0])) / len);
    if (off < nearest) { nearest = off; front = i; }
  }
  return [0, 1, 2, 3].map((i) => c[(front + i) % 4]);
}

const memo = new WeakMap<Features, Map<string, Venue[]>>();
/** The buildings of a chunk that are not homes and can be walked into. Kept a while: a chunk's labels and each of its insides all ask. */
export function venuesOf(cx: number, cy: number, features: Features, elev: Elevation): Venue[] {
  let byChunk = memo.get(features);
  if (!byChunk) memo.set(features, (byChunk = new Map()));
  const key = `${cx}/${cy}`;
  let found = byChunk.get(key);
  if (!found) {
    found = findVenues(cx, cy, features, elev);
    byChunk.set(key, found);
    if (byChunk.size > 16) byChunk.delete(byChunk.keys().next().value!);
  }
  return found;
}

/** The inside of one such building as a mesh, in its chunk's coordinates, with the surfaces of a house's inside. */
export function venueMesh(v: Venue, S: number): ChunkMesh {
  const sections = new Map<string, Section>();
  const sec = (m: MaterialDef, hex: number): Section => {
    const mat = painted(m, hex);
    const key = `${mat.id}:${mat.color}`;
    let s = sections.get(key);
    if (!s) sections.set(key, (s = new Section(mat)));
    return s;
  };
  const { A, ta, tb } = v;
  const at = (a: number, b: number, z: number): [number, number, number] => [A[0] + ta[0] * a + tb[0] * b, A[1] + ta[1] * a + tb[1] * b, v.floor + z];
  const dir = (da: number, db: number, dz: number): [number, number, number] => [ta[0] * da + tb[0] * db, ta[1] * da + tb[1] * db, dz];
  for (const p of layVenue(v.spec).pieces) {
    const s = sec(p.mat, p.hex);
    const { a0, a1, b0, b1, z0, z1 } = p;
    if (p.form === "floor") face(s, [at(a0, b0, z0), at(a1, b0, z0), at(a1, b1, z0), at(a0, b1, z0)], dir(0, 0, 1));
    else if (p.form === "ceiling") face(s, [at(a0, b0, z0), at(a1, b0, z0), at(a1, b1, z0), at(a0, b1, z0)], dir(0, 0, -1));
    else if (p.form === "wallA") face(s, [at(a0, b0, z0), at(a0, b1, z0), at(a0, b1, z1), at(a0, b0, z1)], dir(p.facing ?? 1, 0, 0));
    else if (p.form === "wallB") face(s, [at(a0, b0, z0), at(a1, b0, z0), at(a1, b0, z1), at(a0, b0, z1)], dir(0, p.facing ?? 1, 0));
    else {
      if (a1 - a0 < 1e-4 || b1 - b0 < 1e-4 || z1 - z0 < 1e-4) continue;
      face(s, [at(a0, b0, z0), at(a0, b1, z0), at(a0, b1, z1), at(a0, b0, z1)], dir(-1, 0, 0));
      face(s, [at(a1, b0, z0), at(a1, b1, z0), at(a1, b1, z1), at(a1, b0, z1)], dir(1, 0, 0));
      face(s, [at(a0, b0, z0), at(a1, b0, z0), at(a1, b0, z1), at(a0, b0, z1)], dir(0, -1, 0));
      face(s, [at(a0, b1, z0), at(a1, b1, z0), at(a1, b1, z1), at(a0, b1, z1)], dir(0, 1, 0));
      face(s, [at(a0, b0, z1), at(a1, b0, z1), at(a1, b1, z1), at(a0, b1, z1)], dir(0, 0, 1));
      if (p.under) face(s, [at(a0, b0, z0), at(a1, b0, z0), at(a1, b1, z0), at(a0, b1, z0)], dir(0, 0, -1));
    }
  }
  return { sections: [...sections.values()].filter((s) => s.idx.length > 0).sort((p, q) => p.mat.id - q.mat.id || p.mat.color - q.mat.color), metersPerTile: S };
}

export interface WhoJson {
  x: number; y: number; id: number; rev: number;
  /** What it is: a kind of place (docs/PROTOCOL.md lists them). */
  use: string; name?: string;
  /** The room: how far it is from one corner to the opposite one, in metres (a game is "inside" while within that of its doors). */
  size: number;
  people: { id: number; sp: string; role: string; pose: string; u: number; v: number; h: number; yaw: number; seat?: number; pts?: number[] }[];
  signs: { text: string; u: number; v: number; h: number; yaw: number; w: number }[];
  tills: { u: number; v: number; use: string; text: string }[];
}

/** Who is inside, what is written up in there, and where food is sold, in the chunk's own measures (docs/PROTOCOL.md). */
export function venueWho(v: Venue, cx: number, cy: number, S: number): WhoJson {
  const { A, ta, tb } = v;
  const r7 = (n: number): number => Math.round(n * 1e7) / 1e7;
  const r2 = (n: number): number => Math.round(n * 100) / 100;
  const uv = (a: number, b: number): [number, number] => [r7((A[0] + ta[0] * a + tb[0] * b) / S), r7(-(A[1] + ta[1] * a + tb[1] * b) / S)];
  const yaw = (fa: number, fb: number): number => {
    const e = ta[0] * fa + tb[0] * fb, n = ta[1] * fa + tb[1] * fb;
    return Math.round((((Math.atan2(e, n) * 180) / Math.PI + 360) % 360) * 10) / 10;
  };
  const laid = layVenue(v.spec);
  return {
    x: cx, y: cy, id: v.id, rev: VENUES_REV, use: v.use, ...(v.name ? { name: v.name } : {}),
    size: r2(Math.hypot(v.spec.width, v.spec.depth)),
    people: laid.people.map((p) => {
      const [u, w] = uv(p.a, p.b);
      const id = hash32(v.spec.seed, 0x50454f50 + p.n) || 1;
      const pts: number[] = [];
      for (let i = 0; p.path && i + 1 < p.path.length; i += 2) pts.push(...uv(p.path[i], p.path[i + 1]));
      return { id, sp: FIGURES[hash32(id, 0x46494755) % FIGURES.length], role: p.role, pose: p.pose, u, v: w, h: r2(v.floor), yaw: yaw(p.fa, p.fb), ...(p.seat !== undefined ? { seat: p.seat } : {}), ...(pts.length ? { pts } : {}) };
    }),
    signs: laid.lettering.map((l) => {
      const [u, w] = uv(l.a + l.fa * 0.03, l.b + l.fb * 0.03);
      return { text: l.text, u, v: w, h: r2(v.floor + l.z), yaw: yaw(l.fa, l.fb), w: r2(l.w) };
    }),
    tills: laid.tills.map((t) => {
      const [u, w] = uv(t.a, t.b);
      return { u, v: w, use: t.use, text: t.text };
    }),
  };
}

/**
 * The inside of building `id` of a chunk: a home's rooms, or what a shop, an office or a mall has inside,
 * with (for those) who is in there. Null when that chunk has no such building to walk into.
 */
export async function generateInside(cx: number, cy: number, id: number, elev: Elevation, load: (dx: number, dy: number) => Promise<Features> = loadFeatures): Promise<{ mesh: Buffer; who: Buffer | null } | null> {
  const features = await featuresForChunk(cx, cy, load);
  await elev.ensure(cx - 0.5, cy - 0.5, cx + 1.5, cy + 1.5);
  const S = metersPerTile(cy + 0.5, CHUNK_Z);
  const venue = venuesOf(cx, cy, features, elev).find((v) => v.id === id);
  if (venue) return { mesh: encodeChunk(cx, cy, venueMesh(venue, S)), who: Buffer.from(JSON.stringify(venueWho(venue, cx, cy, S)), "utf8") };
  const home = homesOf(cx, cy, features, elev).find((h) => h.id === id);
  // (What is not a home has no rooms: a petrol station, or a shop too many for its chunk.)
  return home && !home.use ? { mesh: encodeChunk(cx, cy, buildInterior(home, S)), who: null } : null;
}
