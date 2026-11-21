// Where animals live. The server only decides the "homes": a spot, a kind of animal, how many,
// and a circle they may roam in that is clear of buildings, roads and the wrong kind of ground.
// Every client then works out the same movement from the home's identity and the shared clock
// (docs/PROTOCOL.md, "Life"), so nothing here runs while people play.
//
// `placeHomes` puts farm animals in fields. `placeWild` adds everything else: ducks on water,
// pigeons in town, a flock overhead, cats and dogs beside houses, rabbits, deer and squirrels,
// and a few animals that belong to one part of the world.

import { CHUNK_Z, hash32, metersPerTile, xToLon, yToLat } from "./geo.ts";
import { type Elevation, GRID } from "./elevation.ts";
import { BARN_KINDS, clipPolyline, groundClassId, PLAIN_KINDS, type TreeSpot } from "./chunk.ts";
import type { Building, Features, Field, FieldKind, GroundClass, Pt, Stock } from "./osm.ts";

export type Wild = "duck" | "pigeon" | "bird" | "cat" | "dog" | "rabbit" | "deer" | "squirrel" | "kangaroo" | "llama" | "camel" | "penguin";
export type Species = Stock | Wild;
/** One herd, flock or pet: `r` is the roam radius in metres, `id` its identity (the same on every visit). */
export interface Home { wx: number; wy: number; id: number; sp: Species; n: number; r: number }

/** Candidate spots per chunk side: one every 35 to 50 m, on a grid shared by the whole world. */
const LATTICE = 12;
/** Kept clear around the roam circle, so an animal stepping aside for a player stays off roads and walls. */
const MARGIN_M = 3;
/** Small animals in small places (pets, squirrels, ducks) keep a smaller margin. */
const SNUG_M = 1;
const BARN_NEAR_M = 150;
const FOREST_NEAR_M = 60;
export const HOME_CAP = 40;
export const CREATURE_CAP = 150;
export const WILD_HOME_CAP = 40;
export const WILD_CREATURE_CAP = 120;

interface Herd { min: number; max: number; area: number; few: number; many: number }
/** Smallest and largest roam radius in metres, square metres of circle per animal, and the head count limits. */
const HERDS: Record<Species, Herd> = {
  cow: { min: 7, max: 22, area: 60, few: 2, many: 7 },
  sheep: { min: 6, max: 18, area: 35, few: 3, many: 10 },
  horse: { min: 8, max: 22, area: 150, few: 1, many: 3 },
  chicken: { min: 3, max: 8, area: 8, few: 3, many: 8 },
  duck: { min: 2.5, max: 8, area: 20, few: 2, many: 5 },
  pigeon: { min: 3, max: 7, area: 10, few: 3, many: 7 },
  bird: { min: 35, max: 70, area: 1, few: 5, many: 9 },
  cat: { min: 2, max: 4, area: 1000, few: 1, many: 1 },
  dog: { min: 2, max: 4, area: 1000, few: 1, many: 1 },
  rabbit: { min: 4, max: 8, area: 30, few: 2, many: 5 },
  deer: { min: 8, max: 18, area: 160, few: 2, many: 4 },
  squirrel: { min: 2.5, max: 4, area: 30, few: 1, many: 2 },
  kangaroo: { min: 8, max: 18, area: 110, few: 2, many: 6 },
  llama: { min: 7, max: 16, area: 90, few: 2, many: 5 },
  camel: { min: 8, max: 18, area: 200, few: 1, many: 4 },
  penguin: { min: 3, max: 8, area: 12, few: 3, many: 9 },
};
/** A candidate spot is used when its seed is a multiple of this: how thickly each kind of field is stocked. */
const ODDS: Record<FieldKind, number> = { paddock: 1, farmyard: 2, meadow: 5, farmland: 4 };
const PRIORITY: FieldKind[] = ["paddock", "farmyard", "meadow", "farmland"];

type Box = [number, number, number, number];

function boxOf(ring: Pt[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function inRing(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Inside an area with holes: within an odd number of its rings. */
const inRings = (p: Pt, rings: Pt[][]): boolean => rings.reduce((n, ring) => n + (inRing(p, ring) ? 1 : 0), 0) % 2 === 1;

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
}

/** Distance from a point to a line, or to the edge of a ring when `closed`. */
function lineDist(p: Pt, pts: Pt[], closed: boolean): number {
  let best = Infinity;
  for (let i = closed ? 0 : 1, j = closed ? pts.length - 1 : 0; i < pts.length; j = i++) {
    best = Math.min(best, segDist(p, pts[j], pts[i]));
  }
  return best;
}

function centroid(ring: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / ring.length, y / ring.length];
}

/** Twice the area of a ring, in world units squared (the sign gives its winding). */
function area2(ring: Pt[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a;
}

const classes = (...names: (GroundClass | "plain")[]): Set<number> => new Set(names.map((n) => (n === "plain" ? 0 : groundClassId(n))));

interface Clear { open: Set<number> | null; margin?: number; field?: Field; afloat?: boolean }

/** What the placers share for one chunk: its obstacles, and the test for a clear circle. */
function site(cx: number, cy: number, features: Features, cls: Uint8Array) {
  const S = metersPerTile(cy + 0.5, CHUNK_Z);
  const pad = (22 + MARGIN_M + 10) / S;
  const near = (b: Box, by = pad): boolean => b[2] >= cx - by && b[0] <= cx + 1 + by && b[3] >= cy - by && b[1] <= cy + 1 + by;
  const buildings = features.buildings.map((b) => ({ b, box: boxOf(b.ring) })).filter((x) => near(x.box));
  // Paths are left out on purpose: a cow may stand on a footpath, but never on a road, a railway or in a stream.
  const lines = features.roads.filter((r) => r.cls !== "path").flatMap((r) =>
    clipPolyline(r.pts, cx - pad, cy - pad, cx + 1 + pad, cy + 1 + pad).map((pts) => ({ pts, half: r.width / 2, stream: r.cls === "stream" })));
  const cell = S / GRID;
  const inChunk = (p: Pt): boolean => p[0] >= cx && p[0] < cx + 1 && p[1] >= cy && p[1] < cy + 1;
  const classAt = (p: Pt): number =>
    cls[Math.min(GRID - 1, Math.max(0, Math.floor((p[1] - cy) * GRID))) * GRID + Math.min(GRID - 1, Math.max(0, Math.floor((p[0] - cx) * GRID)))];

  /**
   * The largest clear circle round a point, in metres, up to `max`; 0 when the point itself is no good.
   * `open` lists the ground the circle may cover (null: any). `afloat` is for animals on the water,
   * which mind bridges but not the stream they swim in.
   */
  const clearRadius = (p: Pt, max: number, { open, margin = MARGIN_M, field, afloat = false }: Clear): number => {
    let r = max;
    if (field) for (const ring of field.rings) r = Math.min(r, lineDist(p, ring, true) * S);
    for (const { b, box } of buildings) {
      const by = (r + margin) / S;
      if (p[0] < box[0] - by || p[0] > box[2] + by || p[1] < box[1] - by || p[1] > box[3] + by) continue;
      if (inRing(p, b.ring)) return 0;
      r = Math.min(r, lineDist(p, b.ring, true) * S - margin);
    }
    for (const l of lines) if (!(afloat && l.stream)) r = Math.min(r, lineDist(p, l.pts, false) * S - l.half - margin);
    if (r <= 0) return 0;
    if (!open) return r;
    if (inChunk(p) && !open.has(classAt(p))) return 0;
    // Ground cover, for the cells of this chunk the circle could touch.
    const gi = (p[0] - cx) * GRID;
    const gj = (p[1] - cy) * GRID;
    const span = Math.ceil((r + margin) / cell) + 1;
    for (let j = Math.max(0, Math.floor(gj) - span); j <= Math.min(GRID - 1, Math.floor(gj) + span); j++) {
      for (let i = Math.max(0, Math.floor(gi) - span); i <= Math.min(GRID - 1, Math.floor(gi) + span); i++) {
        if (open.has(cls[j * GRID + i])) continue;
        const d = Math.hypot(i + 0.5 - gi, j + 0.5 - gj) * cell - cell * 0.71;
        r = Math.min(r, d - margin);
      }
    }
    return Math.max(0, r);
  };

  /** Is any cell of this class within `metres` of the point? */
  const classNear = (p: Pt, id: number, metres: number): boolean => {
    const gi = Math.floor((p[0] - cx) * GRID);
    const gj = Math.floor((p[1] - cy) * GRID);
    const span = Math.ceil(metres / cell);
    for (let j = Math.max(0, gj - span); j <= Math.min(GRID - 1, gj + span); j++) {
      for (let i = Math.max(0, gi - span); i <= Math.min(GRID - 1, gi + span); i++) {
        if (cls[j * GRID + i] === id && Math.hypot(i - gi, j - gj) * cell <= metres) return true;
      }
    }
    return false;
  };

  /** Is any cell that is not of this class within `metres` of the point? */
  const shoreNear = (p: Pt, id: number, metres: number): boolean => {
    const gi = Math.floor((p[0] - cx) * GRID);
    const gj = Math.floor((p[1] - cy) * GRID);
    const span = Math.ceil(metres / cell);
    for (let j = Math.max(0, gj - span); j <= Math.min(GRID - 1, gj + span); j++) {
      for (let i = Math.max(0, gi - span); i <= Math.min(GRID - 1, gi + span); i++) {
        if (cls[j * GRID + i] !== id && Math.hypot(i - gi, j - gj) * cell <= metres) return true;
      }
    }
    return false;
  };

  return { S, buildings, inChunk, classAt, clearRadius, classNear, shoreNear };
}

/** Adds homes to `homes`, shrinking each circle so it overlaps none already placed there or in `taken`. */
function adder(S: number, homes: Home[], taken: Home[] = []) {
  return (p: Pt, id: number, sp: Species, clear: number, count?: number): boolean => {
    const k = HERDS[sp];
    let r = Math.min(clear, k.max);
    for (const list of [homes, taken]) for (const h of list) r = Math.min(r, Math.hypot(h.wx - p[0], h.wy - p[1]) * S - h.r - 2);
    if (r < k.min) return false;
    const n = count ?? Math.min(k.many, Math.max(k.few, Math.round((Math.PI * r * r) / k.area)));
    homes.push({ wx: p[0], wy: p[1], id: id >>> 0 || 1, sp, n, r });
    return true;
  };
}

/** Thins homes evenly down to a number, then shrinks the groups until the head count fits. */
function capped(homes: Home[], maxHomes: number, maxCreatures: number): Home[] {
  const step = Math.max(1, Math.ceil(homes.length / maxHomes));
  const kept = homes.filter((_, i) => i % step === 0);
  const total = kept.reduce((n, h) => n + h.n, 0);
  if (total > maxCreatures) for (const h of kept) h.n = Math.max(1, Math.floor((h.n * maxCreatures) / total));
  return kept;
}

/** The spot of a world-wide grid in cell (i, j) of this chunk, nudged by its seed. */
function latticeSpot(cx: number, cy: number, i: number, j: number, salt: number): { p: Pt; seed: number } {
  const X = cx * LATTICE + i;
  const Y = cy * LATTICE + j;
  const seed = hash32(X, Y ^ salt);
  return { seed, p: [(X + 0.2 + (0.6 * ((seed >>> 4) % 1000)) / 1000) / LATTICE, (Y + 0.2 + (0.6 * ((seed >>> 14) % 1000)) / 1000) / LATTICE] };
}

/**
 * The farm homes of one chunk. `cls` is `groundClasses` for the same chunk.
 *
 * Animals live on meadows, in paddocks and farmyards, and on farmland only beside a farm building
 * (most mapped farmland is crops). A barn with no mapped yard still gets a few chickens beside it.
 */
export function placeHomes(cx: number, cy: number, features: Features, cls: Uint8Array): Home[] {
  const { S, clearRadius } = site(cx, cy, features, cls);
  const fields = (features.fields ?? []).map((f) => ({ f, box: boxOf(f.rings.flat()) }))
    .filter(({ box }) => box[2] >= cx && box[0] <= cx + 1 && box[3] >= cy && box[1] <= cy + 1);
  const barns = features.buildings.filter((b) => b.kind && BARN_KINDS.test(b.kind)).map((b) => ({ b, at: centroid(b.ring) }));
  const open = classes("plain", "farm", "grass");
  const homes: Home[] = [];
  const add = adder(S, homes);

  const barnNear = (p: Pt): Building | null => {
    let best: Building | null = null;
    let bestD = BARN_NEAR_M / S;
    for (const { b, at } of barns) {
      const d = Math.hypot(at[0] - p[0], at[1] - p[1]);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  };
  const speciesFor = (f: Field, p: Pt): Stock | null => {
    if (f.stock) return f.stock;
    if (f.kind === "farmyard") return "chicken";
    if (f.kind === "paddock") return "horse";
    const pick = hash32(f.id, 0x57) % 10; // one kind of animal per field
    if (f.kind === "meadow") return pick < 5 ? "cow" : pick < 8 ? "sheep" : "horse";
    const barn = barnNear(p);
    if (!barn) return null;
    return barn.kind === "stable" ? "horse" : barn.kind === "cowshed" ? "cow" : pick < 6 ? "cow" : "sheep";
  };

  // ---- herds in fields, tried at the spots of a grid that covers the whole world
  for (let j = 0; j < LATTICE; j++) {
    for (let i = 0; i < LATTICE; i++) {
      const { p, seed } = latticeSpot(cx, cy, i, j, 0x4c494645);
      let field: Field | null = null;
      for (const { f, box } of fields) {
        if (p[0] < box[0] || p[0] > box[2] || p[1] < box[1] || p[1] > box[3] || !inRings(p, f.rings)) continue;
        if (!field || PRIORITY.indexOf(f.kind) < PRIORITY.indexOf(field.kind)) field = f;
      }
      if (!field) continue;
      const odds = field.stock && field.kind !== "paddock" ? 2 : ODDS[field.kind];
      if ((seed >>> 24) % odds !== 0) continue;
      const sp = speciesFor(field, p);
      if (sp) add(p, seed, sp, clearRadius(p, HERDS[sp].max, { open, field }));
    }
  }

  // ---- a few chickens beside two barns in three, wherever there is room
  for (const { b, at } of barns) {
    if (at[0] < cx || at[0] >= cx + 1 || at[1] < cy || at[1] >= cy + 1) continue;
    const seed = hash32(b.id, 0xc1c);
    if (seed % 3 === 0) continue;
    if (homes.some((h) => h.sp === "chicken" && Math.hypot(h.wx - at[0], h.wy - at[1]) * S < 30)) continue;
    const reach = Math.max(...b.ring.map((q) => Math.hypot(q[0] - at[0], q[1] - at[1])));
    for (let k = 0; k < 8; k++) {
      const a = (((seed >>> 3) + k) % 8) * (Math.PI / 4);
      const p: Pt = [at[0] + Math.cos(a) * (reach + 7 / S), at[1] + Math.sin(a) * (reach + 7 / S)];
      if (add(p, seed, "chicken", clearRadius(p, 6, { open }))) break;
    }
  }

  return capped(homes, HOME_CAP, CREATURE_CAP);
}

/**
 * Animals that belong to one part of the world, by where the chunk is: kangaroos in Australia, llamas
 * high in the Andes, camels on the sands from the Sahara to the Thar, penguins on far southern shores.
 */
export function localStars(lat: number, lon: number): { kangaroo: boolean; llama: boolean; camel: boolean; penguin: boolean } {
  return {
    kangaroo: lat < -10 && lat > -44 && lon > 112 && lon < 154,
    llama: lat < 2 && lat > -35 && lon > -81 && lon < -62,
    camel: lat > 12 && lat < 36 && lon > -17 && lon < 75,
    penguin: lat < -33,
  };
}

/**
 * Everything that is not a farm animal. `trees` are the chunk's trees (`placeTrees`), `farm` the
 * homes `placeHomes` gave it, which these keep clear of.
 *
 * - Ducks: on ponds and lakes within 60 m of the bank (not the sea), and along rivers and canals at least 7 m wide.
 * - Pigeons: on open paved or built-up ground. One flock of birds circles over about half the chunks.
 * - Cats and dogs: beside one home in four.
 * - Rabbits on grass; deer on open ground within 60 m of a wood; squirrels under park trees
 *   (but not in Australia).
 * - Local stars (see `localStars`): kangaroos in place of deer and on some grass, llamas on high
 *   open ground, camels and penguins on sand.
 */
export function placeWild(cx: number, cy: number, features: Features, cls: Uint8Array, trees: TreeSpot[], elev: Elevation, farm: Home[] = []): Home[] {
  const { S, buildings, inChunk, classAt, clearRadius, classNear, shoreNear } = site(cx, cy, features, cls);
  const star = localStars(yToLat(cy + 0.5), xToLon(cx + 0.5));
  const [water, sand, grass, forest, urban, paved] = (["water", "sand", "grass", "forest", "urban", "paved"] as const).map(groundClassId);
  const land = classes("plain", "farm", "grass");
  const town = classes("plain", "urban", "paved", "grass");
  const garden = classes("plain", "urban", "paved", "grass", "farm");
  // The sea is water too, but it has no outline on the map, or is outlined as a bay: ducks keep to ponds, lakes and
  // rivers, and within 60 m of their banks.
  const ponds = features.areas.filter((a) => a.cls === "water" && !a.salt).map((a) => ({ a, box: boxOf(a.rings.flat()) }));
  const inland = (p: Pt): boolean => ponds.some(({ a, box }) => p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3] && inRings(p, a.rings));
  const homes: Home[] = [];
  const add = adder(S, homes, farm);
  const at = (sp: Species, p: Pt, seed: number, clear: Clear): boolean => add(p, seed, sp, clearRadius(p, HERDS[sp].max, clear));

  // ---- by the ground under each spot of the world-wide grid
  for (let j = 0; j < LATTICE; j++) {
    for (let i = 0; i < LATTICE; i++) {
      const { p, seed } = latticeSpot(cx, cy, i, j, 0x57494c44);
      const c = classAt(p);
      const pick = (seed >>> 24) % 24;
      if (c === water) {
        if (pick % 5 === 0 && inland(p) && shoreNear(p, water, 60)) at("duck", p, seed, { open: classes("water"), margin: SNUG_M, afloat: true });
      } else if (c === sand) {
        if (star.penguin && pick % 2 === 0) at("penguin", p, seed, { open: classes("sand", "plain") });
        else if (star.camel && pick % 3 === 0) at("camel", p, seed, { open: classes("sand", "plain") });
      } else if (c === urban || c === paved) {
        if (pick % 5 === 0) at("pigeon", p, seed, { open: town });
      } else if (c === grass || c === 0) {
        const high = star.llama && elev.surfaceHeight(p[0], p[1]) >= 2000;
        if (high && pick % 4 === 0) at("llama", p, seed, { open: land });
        else if (classNear(p, forest, FOREST_NEAR_M) && pick % 5 === 1) at(star.kangaroo ? "kangaroo" : "deer", p, seed, { open: land });
        else if (c === grass && star.kangaroo && pick % 12 === 2) at("kangaroo", p, seed, { open: land });
        else if (c === grass && pick % 12 === 5) at("rabbit", p, seed, { open: land });
      }
    }
  }

  // ---- ducks along rivers and canals that are drawn as a line, one group every 90 m or so
  for (const road of features.roads) {
    if (road.cls !== "stream" || road.width < 7) continue;
    const spacing = 90 / S;
    let k = 0;
    for (const piece of clipPolyline(road.pts, cx, cy, cx + 1, cy + 1)) {
      let next = ((hash32(road.id, 5) % 90) / 90) * spacing;
      for (let s = 0; s + 1 < piece.length; s++) {
        const len = Math.hypot(piece[s + 1][0] - piece[s][0], piece[s + 1][1] - piece[s][1]);
        for (; next <= len; next += spacing, k++) {
          const f = len === 0 ? 0 : next / len;
          const p: Pt = [piece[s][0] + (piece[s + 1][0] - piece[s][0]) * f, piece[s][1] + (piece[s + 1][1] - piece[s][1]) * f];
          const seed = hash32(hash32(road.id, k), hash32(cx, cy));
          if (seed % 2 === 0) add(p, seed, "duck", Math.min(road.width / 2 - 0.8, clearRadius(p, 6, { open: null, margin: SNUG_M, afloat: true })));
        }
        next -= len;
      }
    }
  }

  // ---- squirrels under some of the trees that stand on grass
  for (const t of trees) {
    const p: Pt = [t.wx + 1.5 / S, t.wy];
    if (star.kangaroo || t.seed % 30 !== 0 || !inChunk(p) || classAt(p) !== grass) continue; // there are no squirrels in Australia
    at("squirrel", p, hash32(t.seed, 0x5351), { open: town, margin: SNUG_M });
  }

  // ---- a cat or a dog beside one home in four
  for (const { b } of buildings) {
    const c = centroid(b.ring);
    if (!inChunk(c)) continue;
    const kind = b.kind ?? "";
    const areaM2 = (Math.abs(area2(b.ring)) / 2) * S * S;
    if (areaM2 < 35 || areaM2 >= 400 || b.height >= 13 || BARN_KINDS.test(kind) || PLAIN_KINDS.test(kind)) continue;
    const seed = hash32(b.id, 0x504554);
    if (seed % 4 !== 0) continue;
    const sp: Species = (seed >>> 8) % 100 < 55 ? "cat" : "dog";
    const reach = Math.max(...b.ring.map((q) => Math.hypot(q[0] - c[0], q[1] - c[1])));
    for (let k = 0; k < 8; k++) {
      const a = (((seed >>> 3) + k) % 8) * (Math.PI / 4);
      const p: Pt = [c[0] + Math.cos(a) * (reach + 4 / S), c[1] + Math.sin(a) * (reach + 4 / S)];
      if (add(p, seed, sp, clearRadius(p, HERDS[sp].max, { open: garden, margin: SNUG_M }), (seed >>> 16) % 6 === 0 ? 2 : 1)) break;
    }
  }

  const kept = capped(homes, WILD_HOME_CAP, WILD_CREATURE_CAP);

  // ---- a flock circling overhead, over about half the chunks. It flies above everything, so anywhere will do.
  const sky = hash32(cx, cy ^ 0x534b59);
  if (sky % 2 === 0) {
    const k = HERDS.bird;
    kept.push({
      wx: cx + 0.2 + (0.6 * ((sky >>> 4) % 1000)) / 1000, wy: cy + 0.2 + (0.6 * ((sky >>> 14) % 1000)) / 1000,
      id: sky || 1, sp: "bird", n: k.few + ((sky >>> 24) % (k.many - k.few + 1)), r: k.min + ((sky >>> 8) % (k.max - k.min + 1)),
    });
  }
  return kept;
}
