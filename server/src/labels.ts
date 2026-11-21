// Builds the "labels" of one chunk: house numbers for letterboxes and street names
// for sign posts. Labels are a small JSON side-channel next to the EWC1 mesh
// (docs/PROTOCOL.md, "Labels"); clients may ignore them.
//
// Positions use the chunk's u/v convention (0..1 east/south across the chunk) and
// heights in metres above sea level; yaw is the compass heading the text faces.

import { CHUNK_Z, metersPerTile } from "./geo.ts";
import { Elevation } from "./elevation.ts";
import { clipPolyline, featuresForChunk, groundClasses, homesOf, placeTrees } from "./chunk.ts";
import { placeHomes, placeMachines, placeWild } from "./life.ts";
import { placeTraffic } from "./traffic.ts";
import { trainsFor, type Train } from "./rail.ts";
import { loadFeatures, type Features, type Pt, type Road } from "./osm.ts";

/** Bump when label placement changes, so cached label files are rebuilt. */
export const LABELS_REV = 7;

/** Labels built while the railway tracks could not be fetched: complete but for trains, and not to be kept. */
export const partialLabels = new WeakSet<Buffer>();

export interface LabelItem {
  kind: "house" | "street" | "tree" | "home" | "car" | "route" | "train" | "door";
  /** Plate text; absent on trees and homes. */
  text?: string;
  /** Homes (a herd, a flock or a pet): the animal, how many, and the home's identity; `r` is the roam radius in metres. */
  sp?: string;
  n?: number;
  id?: number;
  /**
   * Routes (a car's trip): the narrowest road's width in metres, 1 where people drive on the left, the
   * seconds it waits at each end, and the path as u, v, seconds, u, v, seconds... (docs/PROTOCOL.md, "Traffic").
   * Trains have `da`, `db` and `pts` too ("Trains").
   */
  w?: number;
  left?: number;
  da?: number;
  db?: number;
  pts?: number[];
  /** Trees: height and canopy radius in metres, and 1 for a conifer. */
  s?: number;
  r?: number;
  c?: number;
  /** Second plate of a street sign at a crossing. */
  text2?: string;
  u: number;
  v: number;
  h: number;
  yaw: number;
  yaw2?: number;
}
export interface LabelsJson { x: number; y: number; rev: number; items: LabelItem[] }

const HOUSE_MAX_ROAD_M = 120;
const HOUSE_OFFSET_M = 1.5;
const HOUSE_DEDUPE_M = 3;
const SIGN_CLEARANCE_M = 1.5;
const SIGN_DEDUPE_M = 25;
const HOUSE_CAP = 120;
const STREET_CAP = 40;
const TREE_CAP = 1500;

type Dir = [number, number];
interface Placed { it: LabelItem; at: Pt }

/** Compass heading in degrees of a direction in world units (x east, y south): 0 north, 90 east. */
const heading = (dx: number, dy: number): number => ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
const r1 = (v: number): number => Math.round(v * 10) / 10;
const r7 = (v: number): number => Math.round(v * 1e7) / 1e7;
const dist = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const pairKey = (a: string, b: string): string => [a.toLowerCase(), b.toLowerCase()].sort().join("|");

/** Nearest point of segment ab to p, with the squared distance. */
function nearestOnSegment(p: Pt, a: Pt, b: Pt): { q: Pt; d2: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  const q: Pt = [a[0] + dx * t, a[1] + dy * t];
  return { q, d2: (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 };
}

function nearestOnRoads(p: Pt, roads: Road[]): { q: Pt; d2: number } | null {
  let best: { q: Pt; d2: number } | null = null;
  for (const r of roads) {
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const n = nearestOnSegment(p, r.pts[i], r.pts[i + 1]);
      if (!best || n.d2 < best.d2) best = n;
    }
  }
  return best;
}

/** Unit direction of a polyline at vertex i (central difference where possible). */
function directionAt(pts: Pt[], i: number): Dir {
  const a = pts[Math.max(0, i - 1)];
  const b = pts[Math.min(pts.length - 1, i + 1)];
  const len = dist(a, b) || 1;
  return [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
}

/** The point halfway along a polyline and the unit direction of the segment it lies on. */
function midpoint(piece: Pt[]): { at: Pt; dir: Dir } {
  let total = 0;
  for (let i = 0; i + 1 < piece.length; i++) total += dist(piece[i], piece[i + 1]);
  let walk = total / 2;
  for (let i = 0; i + 1 < piece.length; i++) {
    const seg = dist(piece[i], piece[i + 1]);
    if (walk > seg && i + 2 < piece.length) { walk -= seg; continue; }
    const dir: Dir = seg === 0 ? [1, 0] : [(piece[i + 1][0] - piece[i][0]) / seg, (piece[i + 1][1] - piece[i][1]) / seg];
    return { at: [piece[i][0] + dir[0] * walk, piece[i][1] + dir[1] * walk], dir };
  }
  return { at: piece[0], dir: [1, 0] };
}

export function buildLabels(cx: number, cy: number, features: Features, elev: Elevation, trains: Train[] = []): LabelItem[] {
  const S = metersPerTile(cy + 0.5, CHUNK_Z);
  const m = (metres: number): number => metres / S;
  const inChunk = (p: Pt): boolean => p[0] >= cx && p[0] < cx + 1 && p[1] >= cy && p[1] < cy + 1;
  const centreDist = (p: Pt): number => dist(p, [cx + 0.5, cy + 0.5]);
  const item = (kind: LabelItem["kind"], text: string, p: Pt, yaw: number): LabelItem => {
    const u = r7(p[0] - cx);
    const v = r7(p[1] - cy);
    return { kind, text, u, v, h: elev.surfaceHeight(cx + u, cy + v), yaw: r1(yaw) };
  };

  const streets = features.roads.filter((r) => r.cls === "road");
  const named = streets.filter((r) => r.name);
  const byName = new Map<string, Road[]>();
  for (const r of named) {
    const key = r.name!.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), r]);
  }
  const candidates = (street?: string): Road[] =>
    (street && byName.get(street.toLowerCase())) || (named.length ? named : streets);

  // ---- houses: a letterbox at the building corner nearest its street, facing the street
  const houses: Placed[] = [];
  const maxD2 = m(HOUSE_MAX_ROAD_M) ** 2;
  const placeHouse = (text: string, ring: Pt[], street?: string): void => {
    const roads = candidates(street);
    let best: { p: Pt; q: Pt; d2: number } | null = null;
    for (const p of ring) {
      const n = nearestOnRoads(p, roads);
      if (n && (!best || n.d2 < best.d2)) best = { p, ...n };
    }
    if (!best || best.d2 > maxD2 || best.d2 < 1e-18) return;
    const d = Math.sqrt(best.d2);
    const dx = (best.q[0] - best.p[0]) / d;
    const dy = (best.q[1] - best.p[1]) / d;
    const at: Pt = [best.p[0] + dx * m(HOUSE_OFFSET_M), best.p[1] + dy * m(HOUSE_OFFSET_M)];
    if (houses.some((h) => dist(h.at, at) < m(HOUSE_DEDUPE_M))) return;
    houses.push({ it: item("house", text, at, heading(dx, dy)), at });
  };
  for (const b of features.buildings) {
    if (!b.housenumber) continue;
    let mx = 0;
    let my = 0;
    for (const [x, y] of b.ring) { mx += x; my += y; }
    if (inChunk([mx / b.ring.length, my / b.ring.length])) placeHouse(b.housenumber, b.ring, b.street);
  }
  for (const a of features.addresses) {
    if (inChunk(a.at)) placeHouse(a.housenumber, [a.at], a.street);
  }
  houses.sort((a, b) => centreDist(a.at) - centreDist(b.at));

  // ---- streets: a node shared by differently named roads is a crossing
  interface Hit { road: Road; i: number }
  const nodes = new Map<string, { at: Pt; hits: Hit[] }>();
  for (const road of named) {
    road.pts.forEach((p, i) => {
      const key = `${p[0]},${p[1]}`;
      let n = nodes.get(key);
      if (!n) nodes.set(key, (n = { at: p, hits: [] }));
      n.hits.push({ road, i });
    });
  }
  const crossings: Placed[] = [];
  const namesWithCrossing = new Set<string>();
  for (const { at, hits } of nodes.values()) {
    if (new Set(hits.map((h) => h.road.name!.toLowerCase())).size < 2) continue;
    for (const h of hits) namesWithCrossing.add(h.road.name!.toLowerCase());
    if (!inChunk(at)) continue;
    const sorted = [...hits].sort((a, b) => b.road.width - a.road.width);
    const first = sorted[0];
    const second = sorted.find((h) => h.road.name!.toLowerCase() !== first.road.name!.toLowerCase())!;
    const key = pairKey(first.road.name!, second.road.name!);
    // Dual carriageways cross a side street twice within a few metres: one sign is enough.
    if (crossings.some((c) => pairKey(c.it.text!, c.it.text2!) === key && dist(c.at, at) < m(SIGN_DEDUPE_M))) continue;
    const d1 = directionAt(first.road.pts, first.i);
    const d2 = directionAt(second.road.pts, second.i);
    const n1: Dir = [-d1[1], d1[0]];
    const n2: Dir = [-d2[1], d2[0]];
    const off = m(Math.max(first.road.width, second.road.width) / 2 + SIGN_CLEARANCE_M);
    // Of the four corners of the crossing, stand on the one with the most room (a T-junction has two).
    let corner: { at: Pt; a: number; b: number; clear: number } | null = null;
    for (const a of [1, -1]) {
      for (const b of [1, -1]) {
        const p: Pt = [at[0] + (a * n1[0] + b * n2[0]) * off, at[1] + (a * n1[1] + b * n2[1]) * off];
        const clear = Math.min(nearestOnRoads(p, [first.road])!.d2, nearestOnRoads(p, [second.road])!.d2);
        if (!corner || clear > corner.clear) corner = { at: p, a, b, clear };
      }
    }
    // Each plate faces back across its own road, so it reads from that road.
    const it = item("street", first.road.name!, corner!.at, heading(-corner!.a * n1[0], -corner!.a * n1[1]));
    it.text2 = second.road.name!;
    it.yaw2 = r1(heading(-corner!.b * n2[0], -corner!.b * n2[1]));
    crossings.push({ it, at: corner!.at });
  }
  crossings.sort((a, b) => centreDist(a.at) - centreDist(b.at));

  // ---- streets with no crossing anywhere in the tile: one plate halfway along their piece in this chunk
  const plates: (Placed & { len: number })[] = [];
  for (const [key, roads] of byName) {
    if (namesWithCrossing.has(key)) continue;
    let best: { piece: Pt[]; len: number; road: Road } | null = null;
    for (const road of roads) {
      for (const piece of clipPolyline(road.pts, cx, cy, cx + 1, cy + 1)) {
        let len = 0;
        for (let i = 0; i + 1 < piece.length; i++) len += dist(piece[i], piece[i + 1]);
        if (!best || len > best.len) best = { piece, len, road };
      }
    }
    if (!best || best.len === 0) continue;
    const { at, dir } = midpoint(best.piece);
    const n: Dir = [-dir[1], dir[0]];
    const off = m(best.road.width / 2 + SIGN_CLEARANCE_M);
    const p: Pt = [at[0] + n[0] * off, at[1] + n[1] * off];
    plates.push({ it: item("street", best.road.name!, p, heading(-n[0], -n[1])), at: p, len: best.len });
  }
  plates.sort((a, b) => b.len - a.len);

  // ---- trees, as placed in the mesh, so clients with their own tree models can draw them
  const trees: LabelItem[] = [];
  const cls = groundClasses(cx, cy, features, elev);
  const spots = placeTrees(cx, cy, features, cls);
  const step = Math.max(1, Math.ceil(spots.length / TREE_CAP));
  for (let i = 0; i < spots.length; i += step) {
    const t = spots[i];
    const u = r7(t.wx - cx);
    const v = r7(t.wy - cy);
    trees.push({ kind: "tree", u, v, h: elev.surfaceHeight(cx + u, cy + v), yaw: t.seed % 360, s: r1(t.height), r: r1(t.radius), c: t.conifer ? 1 : 0 });
  }

  // ---- animals: where each herd, flock and pet lives. Clients move them (docs/PROTOCOL.md, "Life").
  const farm = placeHomes(cx, cy, features, cls);
  const wild = placeWild(cx, cy, features, cls, spots, elev, farm);
  const homes: LabelItem[] = [...farm, ...wild, ...placeMachines(cx, cy, features, cls, [...farm, ...wild])].map((home) => {
    const u = r7(home.wx - cx);
    const v = r7(home.wy - cy);
    return { kind: "home", sp: home.sp, n: home.n, r: r1(home.r), id: home.id, u, v, h: elev.surfaceHeight(cx + u, cy + v), yaw: 0 };
  });

  // ---- front doors that open: `id` is the building, `h` its floor, `yaw` the way out (docs/PROTOCOL.md, "Inside houses")
  const doors: LabelItem[] = homesOf(cx, cy, features, elev).map((home) => ({
    kind: "door", id: home.id, u: r7(home.x / S), v: r7(-home.y / S), h: Math.round(home.floor * 100) / 100,
    yaw: r1(((Math.atan2(home.out[0], home.out[1]) * 180) / Math.PI + 360) % 360),
  }));

  // ---- cars: the parked ones, and the trips the others make. Clients drive them (docs/PROTOCOL.md, "Traffic").
  const r5 = (v: number): number => Math.round(v * 1e5) / 1e5;
  const traffic = placeTraffic(cx, cy, features);
  const cars: LabelItem[] = traffic.parked.map((car) => {
    const u = r7(car.wx - cx);
    const v = r7(car.wy - cy);
    return { kind: "car", id: car.id, u, v, h: elev.surfaceHeight(cx + u, cy + v), yaw: r1(car.yaw) };
  });
  const routes: LabelItem[] = traffic.trips.map((trip) => {
    const u = r5(trip.path[0][0] - cx);
    const v = r5(trip.path[0][1] - cy);
    return {
      kind: "route", id: trip.id, u, v, h: elev.surfaceHeight(cx + u, cy + v), yaw: 0,
      w: r1(trip.w), left: trip.left ? 1 : 0, da: trip.dwellA, db: trip.dwellB,
      pts: trip.path.flatMap(([x, y, t]) => [r5(x - cx), r5(y - cy), t]),
    };
  });

  // ---- trains: the same item goes out with every chunk the run passes through, so its path can be long
  const railway: LabelItem[] = trains.map((train) => {
    const u = r5(train.path[0][0] - cx);
    const v = r5(train.path[0][1] - cy);
    return {
      kind: "train", id: train.id, u, v, h: elev.surfaceHeight(Math.min(cx + 1, Math.max(cx, cx + u)), Math.min(cy + 1, Math.max(cy, cy + v))), yaw: 0,
      da: train.wa, db: train.wb, pts: train.path.flatMap(([x, y, t]) => [r5(x - cx), r5(y - cy), t]),
    };
  });

  return [
    ...houses.slice(0, HOUSE_CAP).map((h) => h.it),
    ...[...crossings, ...plates].slice(0, STREET_CAP).map((s) => s.it),
    ...trees,
    ...homes,
    ...doors,
    ...cars,
    ...routes,
    ...railway,
  ];
}

/** The labels JSON for one chunk, ready to serve. */
export async function generateLabels(
  cx: number, cy: number, elev: Elevation, load = loadFeatures,
  // With the map swapped out (tests), the railways are not fetched either.
  trains: (cx: number, cy: number) => Promise<Train[]> = load === loadFeatures ? trainsFor : async () => [],
): Promise<Buffer> {
  const features = await featuresForChunk(cx, cy, load);
  await elev.ensure(cx - 0.5, cy - 0.5, cx + 1.5, cy + 1.5);
  // The railways come from a download of their own. If it fails, everything else is still worth sending.
  let railway: Train[] = [];
  let partial = false;
  try {
    railway = await trains(cx, cy);
  } catch (err) {
    partial = true;
    console.warn(`labels ${cx}/${cy}: no trains this time: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body: LabelsJson = { x: cx, y: cy, rev: LABELS_REV, items: buildLabels(cx, cy, features, elev, railway) };
  const out = Buffer.from(JSON.stringify(body), "utf8");
  if (partial) partialLabels.add(out);
  return out;
}
