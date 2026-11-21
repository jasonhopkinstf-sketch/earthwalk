// Where farm animals live. The server only decides the "homes": a spot, a kind of animal, how many,
// and a circle they may roam in that is clear of buildings, roads and water. Every client then works
// out the same movement from the home's identity and the shared clock (docs/PROTOCOL.md, "Life"),
// so nothing here runs while people play.

import { CHUNK_Z, hash32, metersPerTile } from "./geo.ts";
import { GRID } from "./elevation.ts";
import { BARN_KINDS, clipPolyline, groundClassId } from "./chunk.ts";
import type { Building, Features, Field, FieldKind, Pt, Stock } from "./osm.ts";

/** One herd or flock: `r` is the roam radius in metres, `id` its identity (the same on every visit). */
export interface Home { wx: number; wy: number; id: number; sp: Stock; n: number; r: number }

/** Candidate spots per chunk side: one every 35 to 50 m, on a grid shared by the whole world. */
const LATTICE = 12;
/** Kept clear around the roam circle, so an animal stepping aside for a player stays off roads and walls. */
const MARGIN_M = 3;
const BARN_NEAR_M = 150;
export const HOME_CAP = 40;
export const CREATURE_CAP = 150;

interface Herd { min: number; max: number; area: number; few: number; many: number }
/** Smallest and largest roam radius in metres, square metres of circle per animal, and the head count limits. */
const HERDS: Record<Stock, Herd> = {
  cow: { min: 7, max: 22, area: 60, few: 2, many: 7 },
  sheep: { min: 6, max: 18, area: 35, few: 3, many: 10 },
  horse: { min: 8, max: 22, area: 150, few: 1, many: 3 },
  chicken: { min: 3, max: 8, area: 8, few: 3, many: 8 },
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

/**
 * The homes of one chunk. `cls` is `groundClasses` for the same chunk.
 *
 * Animals live on meadows, in paddocks and farmyards, and on farmland only beside a farm building
 * (most mapped farmland is crops). A barn with no mapped yard still gets a few chickens beside it.
 */
export function placeHomes(cx: number, cy: number, features: Features, cls: Uint8Array): Home[] {
  const S = metersPerTile(cy + 0.5, CHUNK_Z);
  const pad = (22 + MARGIN_M + 10) / S;
  const near = (b: Box, by = pad): boolean => b[2] >= cx - by && b[0] <= cx + 1 + by && b[3] >= cy - by && b[1] <= cy + 1 + by;

  const fields = (features.fields ?? []).map((f) => ({ f, box: boxOf(f.rings.flat()) })).filter((x) => near(x.box, 0));
  const buildings = features.buildings.map((b) => ({ b, box: boxOf(b.ring) })).filter((x) => near(x.box));
  const barns = features.buildings.filter((b) => b.kind && BARN_KINDS.test(b.kind)).map((b) => ({ b, at: centroid(b.ring) }));
  // Paths are left out on purpose: a cow may stand on a footpath, but never on a road, a railway or in a stream.
  const lines = features.roads.filter((r) => r.cls !== "path").flatMap((r) =>
    clipPolyline(r.pts, cx - pad, cy - pad, cx + 1 + pad, cy + 1 + pad).map((pts) => ({ pts, half: r.width / 2 })));
  const open = new Set([0, groundClassId("farm"), groundClassId("grass")]);
  const cell = S / GRID;

  /** The largest clear circle round a point, in metres, up to `max`; 0 when the point itself is no good. */
  const clearRadius = (p: Pt, max: number, field?: Field): number => {
    let r = max;
    if (field) for (const ring of field.rings) r = Math.min(r, lineDist(p, ring, true) * S);
    for (const { b, box } of buildings) {
      const by = (r + MARGIN_M) / S;
      if (p[0] < box[0] - by || p[0] > box[2] + by || p[1] < box[1] - by || p[1] > box[3] + by) continue;
      if (inRing(p, b.ring)) return 0;
      r = Math.min(r, lineDist(p, b.ring, true) * S - MARGIN_M);
    }
    for (const l of lines) r = Math.min(r, lineDist(p, l.pts, false) * S - l.half - MARGIN_M);
    if (r <= 0) return 0;
    // Ground cover, for the cells of this chunk the circle could touch.
    const gi = (p[0] - cx) * GRID;
    const gj = (p[1] - cy) * GRID;
    const span = Math.ceil((r + MARGIN_M) / cell) + 1;
    for (let j = Math.max(0, Math.floor(gj) - span); j <= Math.min(GRID - 1, Math.floor(gj) + span); j++) {
      for (let i = Math.max(0, Math.floor(gi) - span); i <= Math.min(GRID - 1, Math.floor(gi) + span); i++) {
        if (open.has(cls[j * GRID + i])) continue;
        const d = Math.hypot(i + 0.5 - gi, j + 0.5 - gj) * cell - cell * 0.71;
        r = Math.min(r, d - MARGIN_M);
      }
    }
    return Math.max(0, r);
  };

  const homes: Home[] = [];
  const add = (p: Pt, id: number, sp: Stock, clear: number): boolean => {
    const k = HERDS[sp];
    let r = Math.min(clear, k.max);
    for (const h of homes) r = Math.min(r, Math.hypot(h.wx - p[0], h.wy - p[1]) * S - h.r - 2);
    if (r < k.min) return false;
    const n = Math.min(k.many, Math.max(k.few, Math.round((Math.PI * r * r) / k.area)));
    homes.push({ wx: p[0], wy: p[1], id: id >>> 0 || 1, sp, n, r });
    return true;
  };

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
      const X = cx * LATTICE + i;
      const Y = cy * LATTICE + j;
      const seed = hash32(X, Y ^ 0x4c494645);
      const p: Pt = [(X + 0.2 + (0.6 * ((seed >>> 4) % 1000)) / 1000) / LATTICE, (Y + 0.2 + (0.6 * ((seed >>> 14) % 1000)) / 1000) / LATTICE];
      let field: Field | null = null;
      for (const { f, box } of fields) {
        if (p[0] < box[0] || p[0] > box[2] || p[1] < box[1] || p[1] > box[3] || !inRings(p, f.rings)) continue;
        if (!field || PRIORITY.indexOf(f.kind) < PRIORITY.indexOf(field.kind)) field = f;
      }
      if (!field) continue;
      const odds = field.stock && field.kind !== "paddock" ? 2 : ODDS[field.kind];
      if ((seed >>> 24) % odds !== 0) continue;
      const sp = speciesFor(field, p);
      if (sp) add(p, seed, sp, clearRadius(p, HERDS[sp].max, field));
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
      if (add(p, seed, "chicken", clearRadius(p, 6))) break;
    }
  }

  // ---- limits: thin the homes evenly, then shrink the herds
  const step = Math.max(1, Math.ceil(homes.length / HOME_CAP));
  const kept = homes.filter((_, i) => i % step === 0);
  const total = kept.reduce((n, h) => n + h.n, 0);
  if (total > CREATURE_CAP) for (const h of kept) h.n = Math.max(1, Math.floor((h.n * CREATURE_CAP) / total));
  return kept;
}
