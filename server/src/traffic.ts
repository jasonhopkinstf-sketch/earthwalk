// Cars. The server decides where cars are parked and works out every trip a car makes: the streets
// it follows and when it reaches each point. Clients replay a trip from the shared clock
// (docs/PROTOCOL.md, "Traffic"), so everyone sees the same car in the same place and nothing here
// runs while people play.
//
// A trip goes out from one kerb to another a few streets away and, after a wait, back again. Trips
// are short, so any client that can see a car already has the piece of world under it.

import { CHUNK_Z, hash32, metersPerTile, xToLon, yToLat } from "./geo.ts";
import type { Features, Pt, Road } from "./osm.ts";

/** A parked car: where it stands (already at the kerb) and the compass heading it faces. */
export interface ParkedCar { wx: number; wy: number; yaw: number; id: number }
/**
 * A trip: `path` is the middle of the road as [x, y, seconds since setting off], a point every 4 m or so.
 * `w` is the width in metres of the narrowest road on the way, `left` whether the country drives on the
 * left, and `dwellA`/`dwellB` how long the car waits at each end.
 */
export interface Trip {
  id: number; w: number; left: boolean; dwellA: number; dwellB: number; path: [number, number, number][];
  /** Which road each point of `path` is on (its id): for finding how high a point is where the road is a bridge. Not sent. */
  roads: number[];
}

export const PARKED_CAP = 60;
export const TRIP_CAP = 14;

/** Roads cars use, with their pace in metres a second. Gentle: a player runs at 11. */
const SPEED: Record<string, number> = { living_street: 3, residential: 5.5, road: 5.5, unclassified: 6.5, tertiary: 8, secondary: 9.5, primary: 11 };
/** Roads cars park along. */
const PARK_ON = /^(residential|living_street|unclassified|tertiary|road)$/;
const SLOT_M = 9; // a kerb space
const NEAR_HOMES_M = 35;
const JUNCTION_CLEAR_M = 10;
/** A car pulls in to a kerb, and out from it, along this much of it: nothing else stands there. */
const KERB_CLEAR_M = 14;
/** Kerb spaces are worked out this far beyond the chunk, so that a trip knows what stands along its whole way. */
const SPACES_REACH_M = 520;
const STEP_M = 4;
const ACCEL = 1.5; // metres a second, each second
const ROLL = 0.8; // pace when pulling out and when coming to rest

/**
 * Where people drive on the left: the British Isles, southern and eastern Africa, the Indian
 * subcontinent, south-east Asia, Japan, Australia and New Zealand. Rough boxes, so a few places
 * near a border will be wrong.
 */
export function drivesLeft(lat: number, lon: number): boolean {
  const box = (s: number, w: number, n: number, e: number): boolean => lat >= s && lat <= n && lon >= w && lon <= e;
  return (box(49.9, -11, 61, 1.8) && !(lat < 51.2 && lon > 1.45)) // Britain and Ireland, without the tip of France
    || box(-47.5, 112, -9, 179.9) // Australia and New Zealand
    || box(30, 129, 46, 146) // Japan
    || (box(5, 68, 31, 92.5) && !(lat > 28.5 && lon > 80)) // India, Pakistan, Nepal, Bhutan, Bangladesh, Sri Lanka, without Tibet
    || box(-11, 95, 20.5, 105) || box(0.8, 99.5, 7.5, 119.5) || box(-11, 105, -5.5, 141) // Thailand, Malaysia, Singapore, Indonesia
    || box(22.1, 113.8, 22.6, 114.5) // Hong Kong
    || box(-35, 11.5, 5, 41.5) // southern and eastern Africa
    || box(34.5, 32.2, 35.8, 34.7); // Cyprus
}

const key = (p: Pt): string => `${p[0]},${p[1]}`;
/** Compass heading in degrees of a direction (x east, y south): 0 north, 90 east. */
const heading = (dx: number, dy: number): number => ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;

function inRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The parked cars and trips of one chunk. */
export function placeTraffic(cx: number, cy: number, features: Features): { parked: ParkedCar[]; trips: Trip[] } {
  const S = metersPerTile(cy + 0.5, CHUNK_Z);
  const left = drivesLeft(yToLat(cy + 0.5), xToLon(cx + 0.5));
  const hand = left ? -1 : 1;
  // One-way streets are left out: a car that went down one could not come back the same way.
  const roads = features.roads.filter((r) => r.cls === "road" && r.hw !== undefined && r.hw in SPEED && !r.oneway && r.pts.length >= 2);
  const nodes = new Map<string, { r: number; i: number }[]>();
  roads.forEach((road, r) => road.pts.forEach((p, i) => {
    const k = key(p);
    nodes.set(k, [...(nodes.get(k) ?? []), { r, i }]);
  }));
  // Junctions count every road, one-way streets too: nobody parks across the mouth of one.
  const shared = new Map<string, number>();
  for (const road of features.roads) if (road.cls === "road") for (const p of road.pts) shared.set(key(p), (shared.get(key(p)) ?? 0) + 1);
  const meets = (p: Pt): boolean => (shared.get(key(p)) ?? 0) > 1;
  const metres = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]) * S;

  const boxes = features.buildings.map((b) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of b.ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return { ring: b.ring, x0, y0, x1, y1 };
  });
  const reach = NEAR_HOMES_M / S;
  const homesNear = (p: Pt): boolean => boxes.some((b) => p[0] > b.x0 - reach && p[0] < b.x1 + reach && p[1] > b.y0 - reach && p[1] < b.y1 + reach);
  const indoors = (p: Pt): boolean => boxes.some((b) => p[0] > b.x0 && p[0] < b.x1 && p[1] > b.y0 && p[1] < b.y1 && inRing(p, b.ring));

  // ---- kerb spaces: every 9 m along both sides of streets where people live, one in five taken
  // (`here`: in this chunk, and so this chunk's to send. The others are its neighbours', known here so that no trip
  // of ours ends where one of their cars stands.)
  interface Space { road: number; seg: number; f: number; side: number; slot: number; seed: number; at: Pt; kerb: Pt; face: [number, number]; here: boolean }
  const spaces: Space[] = [];
  const far = SPACES_REACH_M / S;
  roads.forEach((road, r) => {
    if (!PARK_ON.test(road.hw!) || road.width < 4.5 || road.bridge) return; // (nobody parks on a bridge)
    const along: number[] = [0];
    for (let i = 1; i < road.pts.length; i++) along.push(along[i - 1] + metres(road.pts[i - 1], road.pts[i]));
    const junctions = road.pts.map((p, i) => (meets(p) ? along[i] : -1)).filter((d) => d >= 0);
    let slot = 0;
    for (let i = 0; i + 1 < road.pts.length; i++) {
      const a = road.pts[i];
      const b = road.pts[i + 1];
      const len = along[i + 1] - along[i];
      if (len === 0) continue;
      const d: [number, number] = [(b[0] - a[0]) * S / len, (b[1] - a[1]) * S / len]; // unit, in metres
      for (; (slot + 0.5) * SLOT_M < along[i + 1]; slot++) {
        const s = (slot + 0.5) * SLOT_M;
        const f = (s - along[i]) / len;
        const at: Pt = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
        if (at[0] < cx - far || at[0] >= cx + 1 + far || at[1] < cy - far || at[1] >= cy + 1 + far) continue;
        const here = at[0] >= cx && at[0] < cx + 1 && at[1] >= cy && at[1] < cy + 1;
        if (junctions.some((j) => Math.abs(j - s) < JUNCTION_CLEAR_M)) continue;
        // A street under six metres has room for cars along one kerb only, if anything is to get past them.
        for (const side of road.width >= 6 ? [1, -1] : [hash32(road.id, 7) % 2 === 0 ? 1 : -1]) {
          const seed = hash32(hash32(road.id, slot), side + 2);
          if (seed % 5 !== 0) continue;
          const off = (side * (road.width / 2 - 0.95)) / S; // to the right of the way the road is drawn, or to the left
          const kerb: Pt = [at[0] - d[1] * off, at[1] + d[0] * off];
          if (!homesNear(kerb) || indoors(kerb)) continue;
          // A car at the kerb faces the way its side of the road flows.
          spaces.push({ road: r, seg: i, f, side, slot, seed, at, kerb, face: [d[0] * side * hand, d[1] * side * hand], here });
        }
      }
    }
  });

  // ---- trips: one parked car in four goes out and comes back
  const trips: Trip[] = [];
  const parked: ParkedCar[] = [];
  const taken = new Set(spaces.map((sp) => `${sp.road}:${sp.side}:${sp.slot}`));
  const ends: Pt[] = []; // the kerbs our trips so far end at
  for (const sp of spaces) {
    if (!sp.here) continue;
    const trip = (sp.seed >>> 8) % 4 === 0 && trips.length < TRIP_CAP ? route(sp) : null;
    if (trip) trips.push(trip);
    else parked.push({ wx: sp.kerb[0], wy: sp.kerb[1], yaw: heading(sp.face[0], sp.face[1]), id: sp.seed || 1 });
  }
  const step = Math.max(1, Math.ceil(parked.length / PARKED_CAP));
  return { parked: parked.filter((_, i) => i % step === 0), trips };

  /**
   * A trip from a kerb space: out along the street away from the way the parked car faces (it turns
   * round to set off), following the roads for 120 to 420 m. At a junction it mostly keeps straight on.
   */
  function route(sp: Space): Trip | null {
    const target = 120 + ((sp.seed >>> 12) % 300);
    const out: [number, number] = [-sp.face[0], -sp.face[1]];
    let r = sp.road;
    const first = roads[r];
    const seg: [number, number] = [first.pts[sp.seg + 1][0] - first.pts[sp.seg][0], first.pts[sp.seg + 1][1] - first.pts[sp.seg][1]];
    let dir = seg[0] * out[0] + seg[1] * out[1] > 0 ? 1 : -1;
    // The car pulls out along the kerb ahead of it, and pulls in along it when it comes home: so the next space
    // that way must be empty, or it would go through whatever stands there.
    // And it crosses the road as it sets off, so the space ahead on the other side must be empty too.
    if (taken.has(`${sp.road}:${sp.side}:${sp.slot + dir}`) || taken.has(`${sp.road}:${-sp.side}:${sp.slot + dir}`)) return null;
    let i = dir > 0 ? sp.seg + 1 : sp.seg; // the next point of the road ahead
    const line: { p: Pt; vmax: number; meet: boolean; road: number }[] = [{ p: sp.at, vmax: SPEED[first.hw!], meet: false, road: first.id }];
    const seen = new Set<string>();
    let width = first.width;
    let length = 0;
    for (let hops = 0; hops < 200 && length < target + 30; hops++) {
      const p = roads[r].pts[i];
      const k = key(p);
      if (seen.has(k)) break; // never round in a ring
      seen.add(k);
      length += metres(line[line.length - 1].p, p);
      const here = nodes.get(k)!;
      line.push({ p, vmax: SPEED[roads[r].hw!], meet: meets(p), road: roads[r].id });
      // The ways on from here, except back the way we came.
      const from = line[line.length - 2].p;
      const inDir: [number, number] = [p[0] - from[0], p[1] - from[1]];
      const ways: { r: number; i: number; dir: number; turn: number }[] = [];
      for (const h of here) {
        for (const d of [1, -1]) {
          const q = roads[h.r].pts[h.i + d];
          if (!q || (q[0] === from[0] && q[1] === from[1])) continue;
          const o: [number, number] = [q[0] - p[0], q[1] - p[1]];
          const turn = Math.abs(Math.atan2(inDir[0] * o[1] - inDir[1] * o[0], inDir[0] * o[0] + inDir[1] * o[1]));
          if (turn < 2.6) ways.push({ r: h.r, i: h.i + d, dir: d, turn }); // no doubling back
        }
      }
      if (ways.length === 0) break; // a dead end
      ways.sort((a, b) => a.turn - b.turn);
      const pick = hash32(sp.seed, hops);
      const next = ways.length === 1 || pick % 10 < 6 ? ways[0] : ways[1 + ((pick >>> 4) % (ways.length - 1))];
      r = next.r;
      i = next.i;
      dir = next.dir;
      width = Math.min(width, roads[r].width);
    }
    if (length < 80) return null;

    // ---- the far end: at the target distance or short of it, never within 10 m of a junction, and at a
    // stretch of kerb with nothing standing along it: no parked car, and no other trip's end
    const dist: number[] = [0];
    for (let n = 1; n < line.length; n++) dist.push(dist[n - 1] + metres(line[n - 1].p, line[n].p));
    const meetsAt = line.map((l, n) => (l.meet ? dist[n] : -1)).filter((d) => d >= 0);
    /** The kerb the car would stand at, `want` metres along the way, and the way the road runs there (a unit, in metres). */
    const kerbAt = (want: number): { kerb: Pt; d: [number, number] } => {
      let s = 0;
      while (s + 2 < line.length && dist[s + 1] < want) s++;
      const len = dist[s + 1] - dist[s] || 1;
      const f = Math.min(1, Math.max(0, (want - dist[s]) / len));
      const d: [number, number] = [((line[s + 1].p[0] - line[s].p[0]) * S) / len, ((line[s + 1].p[1] - line[s].p[1]) * S) / len];
      const off = (hand * (width / 2 - 0.95)) / S; // its own side of the road: the right of the way it is going, or the left
      const p: Pt = [line[s].p[0] + (line[s + 1].p[0] - line[s].p[0]) * f, line[s].p[1] + (line[s + 1].p[1] - line[s].p[1]) * f];
      return { kerb: [p[0] - d[1] * off, p[1] + d[0] * off], d };
    };
    const kerbClear = (want: number): boolean => {
      const { kerb, d } = kerbAt(want);
      const beside = (q: Pt): boolean => {
        const ex = (q[0] - kerb[0]) * S;
        const ey = (q[1] - kerb[1]) * S;
        const across = Math.abs(-ex * d[1] + ey * d[0]);
        const along = ex * d[0] + ey * d[1];
        // Along its own kerb; and at the other kerb, the stretch it crosses the road by as it sets off for home.
        return across < 2.2 ? Math.abs(along) < KERB_CLEAR_M : across < 8 && along > -KERB_CLEAR_M && along < 3;
      };
      return !spaces.some((o) => beside(o.kerb)) && !ends.some(beside);
    };
    let total = -1;
    for (let want = Math.min(target, dist[dist.length - 1] - 3); want >= 60 && total < 0; want -= 5) {
      if (!meetsAt.some((d) => Math.abs(d - want) < JUNCTION_CLEAR_M) && kerbClear(want)) total = want;
    }
    if (total < 0) return null;
    ends.push(kerbAt(total).kerb);

    // ---- a point every 4 m, each with the fastest the car may go there
    const count = Math.max(2, Math.round(total / STEP_M));
    const ds = total / count;
    const pts: Pt[] = [];
    const via: number[] = [];
    const cap: number[] = [];
    for (let n = 0, s = 0; n <= count; n++) {
      const want = n * ds;
      while (s + 2 < line.length && dist[s + 1] < want) s++;
      const f = dist[s + 1] === dist[s] ? 0 : Math.min(1, (want - dist[s]) / (dist[s + 1] - dist[s]));
      pts.push([line[s].p[0] + (line[s + 1].p[0] - line[s].p[0]) * f, line[s].p[1] + (line[s + 1].p[1] - line[s].p[1]) * f]);
      via.push(line[s + 1].road);
      const slow = meetsAt.some((d) => Math.abs(d - want) < 7) ? 0.55 : 1; // ease off for junctions
      cap.push(line[s + 1].vmax * slow);
    }
    for (let n = 1; n < count; n++) {
      // Ease off for bends too: the sharper, the slower.
      const a: [number, number] = [pts[n][0] - pts[n - 1][0], pts[n][1] - pts[n - 1][1]];
      const b: [number, number] = [pts[n + 1][0] - pts[n][0], pts[n + 1][1] - pts[n][1]];
      const bend = Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]));
      cap[n] *= Math.min(1, Math.max(0.3, 1 - bend / 1.2));
    }
    cap[0] = ROLL;
    cap[count] = ROLL;
    for (let n = 1; n <= count; n++) cap[n] = Math.min(cap[n], Math.sqrt(cap[n - 1] ** 2 + 2 * ACCEL * ds)); // speeding up
    for (let n = count - 1; n >= 0; n--) cap[n] = Math.min(cap[n], Math.sqrt(cap[n + 1] ** 2 + 2 * ACCEL * ds)); // slowing down
    const path: [number, number, number][] = [[pts[0][0], pts[0][1], 0]];
    for (let n = 1, t = 0; n <= count; n++) {
      t += ds / ((cap[n - 1] + cap[n]) / 2);
      path.push([pts[n][0], pts[n][1], Math.round(t * 100) / 100]);
    }
    return { id: sp.seed || 1, w: width, left, dwellA: 60 + ((sp.seed >>> 3) % 180), dwellB: 30 + ((sp.seed >>> 17) % 90), path, roads: via };
  }
}

/** For tests and tools: which roads a client's car may be on. */
export const drivable = (road: Road): boolean => road.cls === "road" && road.hw !== undefined && road.hw in SPEED && !road.oneway;
