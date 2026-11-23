// Builds one world chunk (a zoom-16 map tile, roughly 400-600 m across) into
// ready-to-render triangle meshes. The game client only uploads these buffers,
// so all world-generation logic lives (and is tested) here.
//
// Geometry is built in chunk-local metres: e = east, n = north, h = height above
// sea level, origin at the chunk's north-west corner. See docs/PROTOCOL.md for
// the binary layout and the coordinate conventions.

import earcut from "earcut";
import { CHUNK_Z, hash32, metersPerTile, xToLon, yToLat } from "./geo.ts";
import { Elevation, GRID } from "./elevation.ts";
import { BLOCK_Z, type Building, DATA_MARGIN, DATA_Z, loadFeatures, type Features, type GroundClass, type Pt, type Road } from "./osm.ts";
import { COVER, kindAt, TALL_UNKNOWN, tallAt } from "./cover.ts";
import { type HouseStyle, houseStyle, type RoofForm } from "./styles.ts";
import { prepareSpans, rampsOf, spansOf } from "./spans.ts";
import { drawSpans, planTunnels, type SpanCtx } from "./spanmesh.ts";

export const FORMAT_MAGIC = 0x31435745; // "EWC1" little-endian
export const FORMAT_VERSION = 1;
/** Bump when generated geometry changes, so cached chunks are rebuilt. */
export const GENERATOR_REV = 15;
/**
 * More buildings of its own than this, and a chunk is drawn more plainly (0: never). A TRIAL, off unless
 * the setting EARTHWALK_CROWDED gives a number, until the game's owner has chosen. Measured 2026-11-24 on
 * one arrival in the old middle of Jaipur (25 chunks of 224 to 945 buildings): 84 MB as it is, 66 MB with
 * 600, 55 MB with 400. Devonport's fullest chunks have 460 to 530.
 */
const CROWDED = Number(process.env.EARTHWALK_CROWDED ?? 0) || 0;
export const FLAG_COLLISION = 1;

export interface MaterialDef { id: number; color: number; collision: boolean }
const rgb = (hex: number): number => ((hex << 8) | 0xff) >>> 0; // 0xRRGGBB -> RGBA8

export const MATERIALS = {
  ground: { id: 0, color: rgb(0x8a9a5b), collision: true },
  grass: { id: 1, color: rgb(0x6faa4a), collision: true },
  forest: { id: 2, color: rgb(0x4d7a3a), collision: true },
  farm: { id: 3, color: rgb(0xc2b86b), collision: true },
  sand: { id: 4, color: rgb(0xe3d3a0), collision: true },
  urban: { id: 5, color: rgb(0xa9a79c), collision: true },
  paved: { id: 6, color: rgb(0x8d8d8d), collision: true },
  water: { id: 7, color: rgb(0x3f7fb5), collision: true },
  rock: { id: 8, color: rgb(0x8c857b), collision: true },
  /** Ground that is not on the terrain's grid: what is left round the mouth of a tunnel, where the grid was cut away. */
  cut: { id: 9, color: rgb(0x8a9a5b), collision: true },
  road: { id: 10, color: rgb(0x4a4a4e), collision: false },
  path: { id: 11, color: rgb(0xc9b28a), collision: false },
  rail: { id: 12, color: rgb(0x5b4a3f), collision: false },
  stream: { id: 13, color: rgb(0x3f7fb5), collision: false },
  pavement: { id: 14, color: rgb(0xd2cab8), collision: false },
  marking: { id: 15, color: rgb(0xf4f1e6), collision: false },
  /** A road, path or railway that is not on the ground: the top of a bridge, a ramp up to one, the floor of a tunnel. Stood and driven on, at whatever height it is; its colour is that of what it carries. */
  deck: { id: 16, color: rgb(0x4a4a4e), collision: true },
  /** What holds a bridge up and in: piers, the sides and underside of the deck, solid side walls, arches. */
  structure: { id: 17, color: rgb(0xb9bec4), collision: true },
  /** Railings and cables: thin things with the sky between them. */
  railing: { id: 18, color: rgb(0xf4f1e6), collision: true },
  /** The inside of a tunnel and its mouth: walls and ceiling. */
  lining: { id: 19, color: rgb(0x9a9ea6), collision: true },
  wall0: { id: 20, color: rgb(0xd9cdb8), collision: true },
  wall1: { id: 21, color: rgb(0xc4a48a), collision: true },
  wall2: { id: 22, color: rgb(0xb9bec4), collision: true },
  wall3: { id: 23, color: rgb(0xa9553f), collision: true },
  roof0: { id: 24, color: rgb(0x6e6a66), collision: true },
  roof1: { id: 25, color: rgb(0x8f4a3a), collision: true },
  door: { id: 26, color: rgb(0xb5372e), collision: false },
  trim: { id: 27, color: rgb(0xf4f1e6), collision: false },
  chimney: { id: 28, color: rgb(0xb5553c), collision: false },
  /** A structure with no windows: a mast, a spire, a drum, the pod of a tower. */
  plain: { id: 29, color: rgb(0xb9bec4), collision: true },
  hedge: { id: 32, color: rgb(0x3f9a45), collision: false },
  fence: { id: 33, color: rgb(0xf4f1e6), collision: false },
  tree: { id: 30, color: rgb(0x2f6b2f), collision: false },
} satisfies Record<string, MaterialDef>;

const GROUND_ORDER: GroundClass[] = ["urban", "farm", "grass", "forest", "sand", "rock", "paved", "water"]; // later wins
/** The value `groundClasses` gives a cell of this class (0 is plain ground with no class). */
export const groundClassId = (c: GroundClass): number => GROUND_ORDER.indexOf(c) + 1;
// ---- house paints. A building keeps its own colours, chosen by its id, so a street is a row of
// different houses. The wall and roof ids say how a surface is drawn (docs/PROTOCOL.md); a section's
// colour says what paint it has, so one id can come in several sections. Which paints a place has,
// and what its roofs are like, comes from its part of the world (styles.ts): painted or boarded
// houses are wall0, brick and stone ones wall3, and flats, shops and anything large wall1 or wall2.

const BARN_RED = 0xb8372b;
const BARN_ROOF = 0x4a4f5c;
/** Shop awnings. */
const AWNINGS = [0xb8372b, 0x2f5d3a, 0x2e4a6e, 0xe8c84a, 0x8f3a2e, 0x377a62];
/** School flags: plain colours, nobody's in particular. */
const FLAGS = [0xd0302a, 0x3f78c0, 0x4f9a4f, 0xf0d040];
/** Flat roofs where roofs are usually pitched: felt and gravel. */
const FLAT_ROOFS = [0x7a7f86, 0x6e6a66, 0x8a8f96, 0x9a958c];
export const BARN_KINDS = /^(barn|farm|farm_auxiliary|stable|cowshed|sty|granary)$/;
/** Buildings that are small but are not somebody's house: no front door, porch or chimney. */
export const PLAIN_KINDS = /^(garage|garages|shed|carport|roof|greenhouse|kiosk|hut|industrial|warehouse|retail|commercial|supermarket|service|toilets|transformer_tower)$/;
/** Buildings people live in, or that the map only calls a building: when large, these follow the local style of flats. */
const DWELLING_KINDS = /^(|residential|house|detached|semidetached_house|terrace|apartments|bungalow|dormitory|hotel)$/;

export const painted = (m: MaterialDef, hex: number): MaterialDef => ({ id: m.id, color: rgb(hex), collision: m.collision });
/** A roof in a colour: the warm ones (clay, rust) are roof1, the cool and pale ones roof0. */
const roofIn = (hex: number): MaterialDef => painted((hex >>> 16) > (hex & 0xff) + 40 && ((hex >>> 8) & 0xff) < 0xb0 ? MATERIALS.roof1 : MATERIALS.roof0, hex);

export class Section {
  readonly mat: MaterialDef;
  readonly pos: number[] = [];
  readonly nrm: number[] = [];
  readonly idx: number[] = [];
  constructor(mat: MaterialDef) {
    this.mat = mat;
  }
  get count(): number {
    return this.pos.length / 3;
  }
  vert(e: number, n: number, h: number, ne: number, nn: number, nh: number): number {
    this.pos.push(e, n, h);
    this.nrm.push(ne, nn, nh);
    return this.count - 1;
  }
  /** Adds a triangle wound counter-clockwise when seen from the side its normal points to. */
  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }
  /** Adds a triangle for an upward-facing surface, fixing the winding if needed. */
  triUp(a: number, b: number, c: number): void {
    const p = this.pos;
    const cross = (p[b * 3] - p[a * 3]) * (p[c * 3 + 1] - p[a * 3 + 1]) - (p[b * 3 + 1] - p[a * 3 + 1]) * (p[c * 3] - p[a * 3]);
    if (cross >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }
}

export interface ChunkMesh { sections: Section[]; metersPerTile: number }

function pointInRing(x: number, y: number, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Clips a polyline to an axis-aligned box, returning the pieces that fall inside. */
export function clipPolyline(pts: Pt[], x0: number, y0: number, x1: number, y1: number): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    let t0 = 0;
    let t1 = 1;
    let ok = true;
    for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
      if (p === 0) {
        if (q < 0) { ok = false; break; }
      } else {
        const r = q / p;
        if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
        else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
      }
    }
    if (!ok) {
      if (cur.length >= 2) out.push(cur);
      cur = [];
      continue;
    }
    const a: Pt = t0 === 0 ? [ax, ay] : [ax + dx * t0, ay + dy * t0];
    const b: Pt = t1 === 1 ? [bx, by] : [ax + dx * t1, ay + dy * t1];
    if (cur.length === 0 || t0 > 0) {
      if (cur.length >= 2) out.push(cur);
      cur = [a];
    }
    cur.push(b);
    if (t1 < 1) {
      if (cur.length >= 2) out.push(cur);
      cur = [];
    }
  }
  if (cur.length >= 2) out.push(cur);
  return out;
}

const MASK_PAD = 12;
const MASK_W = 2 * GRID + 2 * MASK_PAD;
const LAND = 1;
const SEA = 2;
const masks = new WeakMap<Features, Uint8Array>();

/**
 * Land/sea for every terrain cell of a data tile (2x2 chunks plus a margin): 0 unknown, LAND or SEA.
 *
 * OpenStreetMap draws coastlines with land on the left of the direction of travel. The lines are
 * drawn onto the cell grid as walls, the cells just left and right of each line are labelled, and
 * the labels then spread outwards until they meet a wall. Unlike "which side of the nearest line",
 * this follows the real shape of bays and harbours.
 */
export function seaMask(features: Features, X0: number, Y0: number): Uint8Array {
  const cached = masks.get(features);
  if (cached) return cached;
  const W = MASK_W;
  const mask = new Uint8Array(W * W);
  masks.set(features, mask);
  if (features.coast.length === 0) return mask;

  const wall = new Uint8Array(W * W);
  const queue: number[] = [];
  const pad = MASK_PAD / GRID;
  const seed = (x: number, y: number, label: number): void => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    if (i < 0 || j < 0 || i >= W || j >= W) return;
    const k = j * W + i;
    if (wall[k] || mask[k]) return;
    mask[k] = label;
    queue.push(k);
  };
  const pieces = features.coast.flatMap((line) => clipPolyline(line, X0 - pad, Y0 - pad, X0 + 2 + pad, Y0 + 2 + pad));
  const toGrid = (p: Pt): [number, number] => [(p[0] - X0) * GRID + MASK_PAD, (p[1] - Y0) * GRID + MASK_PAD];
  // Pass 1: walls. Pass 2: seeds (so no seed lands on a cell a later line turns into a wall).
  for (const pass of [0, 1]) {
    for (const piece of pieces) {
      for (let s = 0; s + 1 < piece.length; s++) {
        const [ax, ay] = toGrid(piece[s]);
        const [bx, by] = toGrid(piece[s + 1]);
        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy);
        if (len === 0) continue;
        const steps = Math.max(1, Math.ceil(len / 0.25));
        for (let t = 0; t <= steps; t++) {
          const x = ax + (dx * t) / steps;
          const y = ay + (dy * t) / steps;
          if (pass === 0) {
            const i = Math.min(W - 1, Math.max(0, Math.floor(x)));
            const j = Math.min(W - 1, Math.max(0, Math.floor(y)));
            wall[j * W + i] = 1;
            // The wall cell itself takes the side its centre is on (y grows south, so left is (dy, -dx)).
            mask[j * W + i] = dx * (j + 0.5 - ay) - dy * (i + 0.5 - ax) < 0 ? LAND : SEA;
          } else {
            const ox = (dy / len) * 1.3;
            const oy = (-dx / len) * 1.3;
            seed(x + ox, y + oy, LAND);
            seed(x - ox, y - oy, SEA);
          }
        }
      }
    }
  }
  for (let head = 0; head < queue.length; head++) {
    const k = queue[head];
    const i = k % W;
    const label = mask[k];
    for (const n of [i > 0 ? k - 1 : -1, i < W - 1 ? k + 1 : -1, k - W, k + W]) {
      if (n < 0 || n >= W * W || wall[n] || mask[n]) continue;
      mask[n] = label;
      queue.push(n);
    }
  }
  return mask;
}

/** Bounding box of a ring, or null when it misses the chunk entirely. */
function inBox(ring: Pt[], cx: number, cy: number): [number, number, number, number] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < cx || x0 > cx + 1 || y1 < cy || y0 > cy + 1) return null;
  return [x0, y0, x1, y1];
}

/** Ground cover per terrain cell: 0 = default ground, else 1 + index into GROUND_ORDER. */
export function groundClasses(cx: number, cy: number, features: Features, elev: Elevation): Uint8Array {
  const cls = new Uint8Array(GRID * GRID); // 0 = default ground, else 1 + index into GROUND_ORDER
  const rowHits: number[] = [];
  for (let order = 0; order < GROUND_ORDER.length; order++) {
    for (const area of features.areas) {
      if (area.cls !== GROUND_ORDER[order]) continue;
      // Edges that cross this chunk's rows, as flat [ax, ay, bx, by].
      const edges: number[] = [];
      let x0 = Infinity;
      let x1 = -Infinity;
      for (const ring of area.rings) {
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const [ax, ay] = ring[j];
          const [bx, by] = ring[i];
          if (ax < x0) x0 = ax;
          if (ax > x1) x1 = ax;
          if (Math.max(ay, by) < cy || Math.min(ay, by) > cy + 1) continue;
          edges.push(ax, ay, bx, by);
        }
      }
      if (edges.length === 0 || x1 < cx || x0 > cx + 1) continue;
      // Scanline fill with the even-odd rule, sampling cell centres.
      for (let j = 0; j < GRID; j++) {
        const y = cy + (j + 0.5) / GRID;
        rowHits.length = 0;
        for (let k = 0; k < edges.length; k += 4) {
          const ay = edges[k + 1];
          const by = edges[k + 3];
          if (ay > y !== by > y) rowHits.push(edges[k] + ((y - ay) / (by - ay)) * (edges[k + 2] - edges[k]));
        }
        if (rowHits.length < 2) continue;
        rowHits.sort((p, q) => p - q);
        for (let h = 0; h + 1 < rowHits.length; h += 2) {
          const i0 = Math.max(0, Math.ceil((rowHits[h] - cx) * GRID - 0.5));
          const i1 = Math.min(GRID - 1, Math.floor((rowHits[h + 1] - cx) * GRID - 0.5));
          for (let i = i0; i <= i1; i++) cls[j * GRID + i] = order + 1;
        }
      }
    }
  }

  // ---- where the map says nothing, what satellites saw there (cover.ts): woods, scrub, grass, crops, bare ground.
  // Where the map says only "a built-up area", the trees and grass in it are taken too: gardens and greens.
  const cover = features.cover;
  if (cover) {
    const per = 2 ** (CHUNK_Z - BLOCK_Z);
    const cell = metersPerTile(cy + 0.5) / GRID;
    const id = (c: GroundClass): number => GROUND_ORDER.indexOf(c) + 1;
    const urban = id("urban"), grass = id("grass");
    const wild: Record<number, number> = {
      [COVER.trees]: id("forest"), [COVER.mangroves]: id("forest"), [COVER.shrubs]: grass, [COVER.grass]: grass, [COVER.wetland]: grass, [COVER.moss]: grass,
      [COVER.crops]: id("farm"), [COVER.built]: urban, [COVER.snow]: id("rock"),
    };
    // Bare ground among buildings is yards, car parks and building sites, not a beach: where a chunk has more
    // built-up ground than bare, its bare ground is drawn as the town's.
    let built = 0, bare = 0;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const kind = kindAt(cover, (cx + (i + 0.5) / GRID) / per, (cy + (j + 0.5) / GRID) / per);
        if (kind === COVER.built) built++;
        else if (kind === COVER.bare) bare++;
      }
    }
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const own = cls[j * GRID + i];
        if (own !== 0 && own !== urban) continue;
        const kind = kindAt(cover, (cx + (i + 0.5) / GRID) / per, (cy + (j + 0.5) / GRID) / per);
        if (own === urban) {
          if (kind === COVER.trees || kind === COVER.grass || kind === COVER.shrubs) cls[j * GRID + i] = grass;
        } else if (kind === COVER.bare && built > bare) {
          cls[j * GRID + i] = urban;
        } else if (kind === COVER.bare) {
          // Bare ground is sand where it lies flat (a desert, a beach, a dry river bed) and rock where it is steep.
          const x = cx + i / GRID, y = cy + j / GRID, d = 1 / GRID;
          const steep = Math.max(Math.abs(elev.rawHeight(x + d, y) - elev.rawHeight(x, y)), Math.abs(elev.rawHeight(x, y + d) - elev.rawHeight(x, y))) / cell;
          cls[j * GRID + i] = id(steep > 0.35 ? "rock" : "sand");
        } else if (wild[kind]) cls[j * GRID + i] = wild[kind];
      }
    }
  }

  // ---- sea (OSM has no polygon for it, only coastlines)
  const waterCls = GROUND_ORDER.indexOf("water") + 1;
  const X0 = (cx >> 1) << 1; // the data tile is 2x2 chunks
  const Y0 = (cy >> 1) << 1;
  const mask = seaMask(features, X0, Y0);
  const emptyArea = features.roads.length === 0 && features.buildings.length === 0;
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const m = mask[(j + (cy - Y0) * GRID + MASK_PAD) * MASK_W + i + (cx - X0) * GRID + MASK_PAD];
      // No coastline anywhere near: "at or below sea level" means sea, but only in empty areas,
      // so inhabited land below sea level (polders) stays dry.
      const sea = m === SEA || (m === 0 && emptyArea && Math.max(
        elev.rawHeight(cx + i / GRID, cy + j / GRID), elev.rawHeight(cx + (i + 1) / GRID, cy + j / GRID),
        elev.rawHeight(cx + i / GRID, cy + (j + 1) / GRID), elev.rawHeight(cx + (i + 1) / GRID, cy + (j + 1) / GRID)) <= 0);
      if (sea) cls[j * GRID + i] = waterCls;
    }
  }
  return cls;
}

export interface TreeSpot { wx: number; wy: number; seed: number; height: number; radius: number; conifer: boolean }

/**
 * Where trees stand: mapped single trees, plus scattered ones in forests and (sparsely) on grass. Where
 * the ground cover is known (cover.ts), trees also stand wherever a satellite saw trees on grass (a park's
 * wooded corner, a garden), bushes stand on scrub, and every tree is as tall as the trees there really are.
 * Scattered trees keep off the roads, paths and railways.
 */
export function placeTrees(cx: number, cy: number, features: Features, cls: Uint8Array): TreeSpot[] {
  const out: TreeSpot[] = [];
  const footprintBoxes = features.buildings.map((b) => ({ b, box: inBox(b.ring, cx, cy) })).filter((x) => x.box);
  const insideBuilding = (wx: number, wy: number): boolean =>
    footprintBoxes.some(({ b, box }) => wx >= box![0] && wx <= box![2] && wy >= box![1] && wy <= box![3] && pointInRing(wx, wy, b.ring));
  // No tree in a tunnel's way near its mouths: for its first 80 m or so a tunnel is not yet under the ground
  // (it dives from the mouth), and a tree there would stand in the tunnel with its top through the roof.
  const S = metersPerTile(cy + 0.5);
  const MOUTH_REACH_M = 85;
  const inTunnelMouth = (wx: number, wy: number): boolean => (features.tunnels ?? []).some((way) => {
    const reach = way.width / 2 + 2.6; // the tube's wall, and room for a trunk
    let along = 0, best = Infinity, bestAlong = 0;
    for (let i = 0; i + 1 < way.pts.length; i++) {
      const ax = (way.pts[i][0] - wx) * S, ay = (way.pts[i][1] - wy) * S;
      const dx = (way.pts[i + 1][0] - way.pts[i][0]) * S, dy = (way.pts[i + 1][1] - way.pts[i][1]) * S;
      const len = Math.hypot(dx, dy);
      const f = len > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / (len * len))) : 0;
      const off = Math.hypot(ax + dx * f, ay + dy * f);
      if (off < best) { best = off; bestAlong = along + len * f; }
      along += len;
    }
    return best < reach && Math.min(bestAlong, along - bestAlong) < MOUTH_REACH_M;
  });
  const cover = features.cover;
  const per = 2 ** (CHUNK_Z - BLOCK_Z);
  /** `grown`: 2 for a tree of a wood (as tall as the trees there are, however low), 1 for one standing alone, 0 for a bush. */
  const add = (wx: number, wy: number, seed: number, conifer: boolean, grown: 0 | 1 | 2 = 1): void => {
    if (inTunnelMouth(wx, wy)) return;
    let height = 6 + (seed % 700) / 100, radius = 1.6 + ((seed >>> 10) % 160) / 100;
    const tall = cover ? tallAt(cover, wx / per, wy / per) : TALL_UNKNOWN;
    if (grown === 0) {
      height = 1.4 + (seed % 160) / 100;
      radius = 0.9 + ((seed >>> 10) % 80) / 100;
    } else if (tall !== TALL_UNKNOWN && tall >= (grown === 2 ? 3 : 5)) {
      // The tallest trees there are `tall` metres: this one is between two thirds of that and all of it.
      height = Math.min(45, tall * (0.66 + (seed % 35) / 100));
      radius = clamp(height * (0.2 + ((seed >>> 10) % 10) / 100), 1.2, 7);
    } else if (tall !== TALL_UNKNOWN && grown === 2) {
      // A wood where nothing stands tall: young trees, or low growth.
      height = 3 + (seed % 200) / 100;
      radius = 1.1 + ((seed >>> 10) % 80) / 100;
    }
    out.push({ wx, wy, seed, height: Math.round(height * 100) / 100, radius: Math.round(radius * 100) / 100, conifer });
  };
  for (const t of features.trees) {
    if (t.at[0] >= cx && t.at[0] < cx + 1 && t.at[1] >= cy && t.at[1] < cy + 1) add(t.at[0], t.at[1], hash32(t.id), false);
  }
  // Which roads, paths and railways pass through or beside each cell, so that no scattered tree stands on one.
  const lanes: number[] = []; // ax, ay, bx, by (chunk metres), half width with room for a trunk
  const inCell = new Map<number, number[]>();
  const cellM = S / GRID;
  for (const road of features.roads) {
    if (road.cls === "stream" && road.width < 4) continue; // a brook runs under the trees
    const half = road.width / 2 + 1.3;
    const r = Math.ceil(half / cellM);
    for (let k = 0; k + 1 < road.pts.length; k++) {
      const [ax, ay] = road.pts[k], [bx, by] = road.pts[k + 1];
      if (Math.max(ax, bx) < cx - 0.05 || Math.min(ax, bx) > cx + 1.05 || Math.max(ay, by) < cy - 0.05 || Math.min(ay, by) > cy + 1.05) continue;
      const lane = lanes.length;
      lanes.push((ax - cx) * S, (ay - cy) * S, (bx - cx) * S, (by - cy) * S, half);
      const steps = Math.min(4096, Math.ceil(Math.hypot(bx - ax, by - ay) * GRID * 2) + 1);
      let last = -1;
      for (let q = 0; q <= steps; q++) {
        const i = Math.floor((ax + ((bx - ax) * q) / steps - cx) * GRID), j = Math.floor((ay + ((by - ay) * q) / steps - cy) * GRID);
        if (j * 4096 + i === last) continue;
        last = j * 4096 + i;
        for (let dj = -r; dj <= r; dj++) {
          for (let di = -r; di <= r; di++) {
            const x = i + di, y = j + dj;
            if (x < 0 || y < 0 || x >= GRID || y >= GRID) continue;
            const list = inCell.get(y * GRID + x);
            if (!list) inCell.set(y * GRID + x, [lane]);
            else if (list[list.length - 1] !== lane) list.push(lane);
          }
        }
      }
    }
  }
  const onRoad = (wx: number, wy: number, i: number, j: number): boolean => {
    const list = inCell.get(j * GRID + i);
    if (!list) return false;
    const px = (wx - cx) * S, py = (wy - cy) * S;
    for (const lane of list) {
      const ax = lanes[lane], ay = lanes[lane + 1], dx = lanes[lane + 2] - ax, dy = lanes[lane + 3] - ay;
      const len2 = dx * dx + dy * dy;
      const f = len2 > 0 ? clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1) : 0;
      if (Math.hypot(px - ax - dx * f, py - ay - dy * f) < lanes[lane + 4]) return true;
    }
    return false;
  };
  const forestCls = GROUND_ORDER.indexOf("forest") + 1;
  const grassCls = GROUND_ORDER.indexOf("grass") + 1;
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const c = cls[j * GRID + i];
      if (c !== forestCls && c !== grassCls) continue;
      const seed = hash32(cx * GRID + i, cy * GRID + j);
      const kind = cover && c === grassCls ? kindAt(cover, (cx + (i + 0.5) / GRID) / per, (cy + (j + 0.5) / GRID) / per) : 0;
      // On grass: a tree in every cell a satellite saw trees in, a bush in every other cell of scrub, and one cell in nine has a tree regardless.
      const wooded = c === forestCls || kind === COVER.trees;
      const bush = !wooded && kind === COVER.shrubs && seed % 2 === 0;
      if (!wooded && !bush && seed % 9 !== 0) continue;
      const wx = cx + (i + 0.15 + ((seed >>> 4) % 70) / 100) / GRID;
      const wy = cy + (j + 0.15 + ((seed >>> 12) % 70) / 100) / GRID;
      if (insideBuilding(wx, wy) || onRoad(wx, wy, i, j)) continue;
      add(wx, wy, seed >>> 3, c === forestCls && (seed >>> 20) % 5 < 2, bush ? 0 : wooded ? 2 : 1);
    }
  }
  return out;
}

export type XY = [number, number];
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Drops near-duplicate and nearly collinear vertices (turns under about 12 degrees). */
function simplifyRing(ring: XY[]): XY[] {
  const out: XY[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[(i + n - 1) % n];
    const q = ring[i];
    const r = ring[(i + 1) % n];
    const ax = q[0] - p[0], ay = q[1] - p[1], bx = r[0] - q[0], by = r[1] - q[1];
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 0.3) continue;
    const sin = Math.abs(ax * by - ay * bx) / (la * lb || 1);
    const dot = (ax * bx + ay * by) / (la * lb || 1);
    if (sin < 0.21 && dot > 0) continue;
    out.push(q);
  }
  return out;
}

const isConvex = (ring: XY[]): boolean => {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n], r = ring[(i + 2) % n];
    if ((q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]) < -1e-6) return false;
  }
  return true;
};

const isRectangle = (ring: XY[]): boolean => {
  if (ring.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const p = ring[i], q = ring[(i + 1) % 4], r = ring[(i + 2) % 4];
    const ax = q[0] - p[0], ay = q[1] - p[1], bx = r[0] - q[0], by = r[1] - q[1];
    if (Math.abs(ax * bx + ay * by) > 0.26 * Math.hypot(ax, ay) * Math.hypot(bx, by)) return false;
  }
  return true;
};

/** A quad or triangle on a roof slope, with the face normal pointing up and out. */
function slopeFace(sec: Section, pts: [number, number, number][]): void {
  const [p, q, r] = pts;
  let nx = (q[1] - p[1]) * (r[2] - p[2]) - (q[2] - p[2]) * (r[1] - p[1]);
  let ny = (q[2] - p[2]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[2] - p[2]);
  let nz = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
  const len = Math.hypot(nx, ny, nz) || 1;
  const first = sec.count;
  for (const [e, n, h] of pts) sec.vert(e, n, h, nx / len, ny / len, nz / len);
  for (let i = 1; i + 1 < pts.length; i++) sec.triUp(first, first + i, first + i + 1);
}

/** A vertical gable triangle over edge a-b of a counter-clockwise ring, in the wall section. */
function gableEnd(walls: Section, a: XY, b: XY, eaves: number, ridge: [number, number, number]): void {
  const de = b[0] - a[0], dn = b[1] - a[1];
  const len = Math.hypot(de, dn) || 1;
  const ne = dn / len, nn = -de / len;
  const v0 = walls.vert(a[0], a[1], eaves, ne, nn, 0);
  const v1 = walls.vert(b[0], b[1], eaves, ne, nn, 0);
  const v2 = walls.vert(ridge[0], ridge[1], ridge[2], ne, nn, 0);
  walls.tri(v0, v1, v2);
}

/** Distance from a point to the segment a-b. */
function segmentDistance(x: number, y: number, a: XY, b: XY): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = clamp(((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t);
}

const segmentsCross = (a: XY, b: XY, c: XY, d: XY): boolean => {
  const side = (p: XY, q: XY, r: XY): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
};

/**
 * A counter-clockwise ring moved inwards by `d` metres (mitred corners), or null when the shape is
 * too narrow for that: a wing would collapse or the outline would cross itself.
 */
export function insetRing(ring: XY[], d: number): XY[] | null {
  const n = ring.length;
  const out: XY[] = [];
  for (let i = 0; i < n; i++) {
    const p = ring[(i + n - 1) % n], q = ring[i], r = ring[(i + 1) % n];
    const la = Math.hypot(q[0] - p[0], q[1] - p[1]), lb = Math.hypot(r[0] - q[0], r[1] - q[1]);
    if (la < 1e-6 || lb < 1e-6) return null;
    // Inward is to the left of travel on a counter-clockwise ring.
    const n1: XY = [-(q[1] - p[1]) / la, (q[0] - p[0]) / la];
    const n2: XY = [-(r[1] - q[1]) / lb, (r[0] - q[0]) / lb];
    const k = 1 + n1[0] * n2[0] + n1[1] * n2[1];
    if (k < 0.3) return null; // a spike: the mitre would shoot far away
    out.push([q[0] + ((n1[0] + n2[0]) / k) * d, q[1] + ((n1[1] + n2[1]) / k) * d]);
  }
  for (let i = 0; i < n; i++) {
    const a = out[i], b = out[(i + 1) % n];
    // Every edge must keep its direction (it flips when the edge was shorter than the corners eat up)...
    const o = ring[i], o2 = ring[(i + 1) % n];
    if ((b[0] - a[0]) * (o2[0] - o[0]) + (b[1] - a[1]) * (o2[1] - o[1]) <= 0) return null;
    // ...every corner must really be `d` inside the outline...
    if (!pointInRing(a[0], a[1], ring as Pt[])) return null;
    for (let j = 0; j < n; j++) if (segmentDistance(a[0], a[1], ring[j], ring[(j + 1) % n]) < d * 0.98) return null;
    // ...and the new outline must not cross itself.
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(a, b, out[j], out[(j + 1) % n])) return null;
    }
  }
  return out;
}

/** A flat polygon with a given normal, wound to agree with it. */
export function face(sec: Section, pts: [number, number, number][], n: [number, number, number]): void {
  const [a, b, c] = pts;
  const gx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
  const gy = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  const gz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const flip = gx * n[0] + gy * n[1] + gz * n[2] < 0;
  const first = sec.count;
  for (const [e, nn, h] of pts) sec.vert(e, nn, h, n[0], n[1], n[2]);
  for (let i = 1; i + 1 < pts.length; i++) {
    if (flip) sec.tri(first, first + i + 1, first + i);
    else sec.tri(first, first + i, first + i + 1);
  }
}

/**
 * A box placed against (or standing free of) a wall. `t` runs along the wall and `o` points out of
 * it, both unit vectors; w is the extent along the wall, d the extent out of it, z the heights.
 * Faces the box does not show (the back against the wall, the bottom in the ground) are left out.
 */
function box(sec: Section, x: number, y: number, t: XY, o: XY, w0: number, w1: number, d0: number, d1: number, z0: number, z1: number, back = false, bottom = false): void {
  const p = (w: number, d: number, z: number): [number, number, number] => [x + t[0] * w + o[0] * d, y + t[1] * w + o[1] * d, z];
  face(sec, [p(w0, d1, z0), p(w1, d1, z0), p(w1, d1, z1), p(w0, d1, z1)], [o[0], o[1], 0]);
  face(sec, [p(w0, d0, z0), p(w0, d1, z0), p(w0, d1, z1), p(w0, d0, z1)], [-t[0], -t[1], 0]);
  face(sec, [p(w1, d0, z0), p(w1, d1, z0), p(w1, d1, z1), p(w1, d0, z1)], [t[0], t[1], 0]);
  face(sec, [p(w0, d0, z1), p(w1, d0, z1), p(w1, d1, z1), p(w0, d1, z1)], [0, 0, 1]);
  if (back) face(sec, [p(w0, d0, z0), p(w1, d0, z0), p(w1, d0, z1), p(w0, d0, z1)], [-o[0], -o[1], 0]);
  if (bottom) face(sec, [p(w0, d0, z0), p(w1, d0, z0), p(w1, d1, z0), p(w0, d1, z0)], [0, 0, -1]);
}

/** Where a chimney can stand on a pitched roof: a point on the ridge and the way the ridge runs. */
interface RidgeSpot { x: number; y: number; z: number; along: XY }

/** A mapped roof shape (roof:shape), as one of the few kinds of roof built here. "" when unmapped or unknown. */
function roofShape(b: Building): string {
  const s = (b.roof ?? "").toLowerCase();
  if (s === "flat") return "flat";
  if (s === "skillion" || s === "lean_to") return "skillion";
  if (/^(dome|onion|cone|pyramidal|mansard)$/.test(s)) return s;
  if (/hipped|^many$/.test(s)) return "hipped"; // half-hipped and hipped-and-gabled too
  if (/gabled|gambrel|saltbox|round|sawtooth|crosspitched/.test(s)) return "gabled";
  return "";
}

/** A quad or triangle on a round roof, facing away from the middle of the building: under a bulge that is downwards. */
function outFace(sec: Section, pts: [number, number, number][], mx: number, my: number): void {
  const [p, q, r] = pts;
  let nx = (q[1] - p[1]) * (r[2] - p[2]) - (q[2] - p[2]) * (r[1] - p[1]);
  let ny = (q[2] - p[2]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[2] - p[2]);
  let nz = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  let ce = 0, cn = 0;
  for (const [e, n] of pts) { ce += e / pts.length; cn += n / pts.length; }
  const away = nx * (ce - mx) + ny * (cn - my);
  if (Math.abs(away) < 1e-9 ? nz < 0 : away < 0) { nx = -nx; ny = -ny; nz = -nz; }
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-9) return;
  face(sec, pts, [nx / len, ny / len, nz / len]);
}

/** What kind of roof a building gets when the map does not say: see `HouseStyle` in styles.ts. */
interface RoofLook {
  form: RoofForm;
  /** Buildings this tall or taller get a flat roof even where roofs are pitched. */
  maxPitched: number;
  pitch: number;
  eaves: number;
}
/** Width of the pavement beside a town street, in metres. */
const PAVEMENT = 1.6;

/**
 * Roofs: a gable on rectangular houses, a hip on other small convex ones, and on L-shaped and other
 * mid-sized low buildings a hip that follows the outline (sloping in from every wall to a flat strip
 * along the middle). Flat on everything else and whenever OSM says flat: big or tall buildings stay
 * flat unless OSM says otherwise.
 */
function addRoof(ring: XY[], top: number, b: Building, areaM2: number, height: number, look: RoofLook, walls: Section, roof: Section, flatRoof: Section, soffit: Section, holes: XY[][] = []): RidgeSpot | null {
  const shape = roofShape(b);
  const EAVES = look.eaves;
  const flatTag = shape === "flat" || shape === "skillion";
  const tagged = /^(gabled|hipped|pyramidal|mansard|dome|onion|cone)$/.test(shape);
  /** The way a mapped roof faces, looking downhill: a unit vector (east, north). */
  const facing: XY | null = b.roofDirection === undefined ? null : [Math.sin((b.roofDirection * Math.PI) / 180), Math.cos((b.roofDirection * Math.PI) / 180)];
  const mansard = !flatTag && (shape === "mansard" || (!tagged && look.form === "mansard" && height < 26 && areaM2 < 4000));
  const pitched = !flatTag && !mansard && (tagged || (look.form === "pitched" && areaM2 < 1500 && height < look.maxPitched));
  const simple = pitched || mansard ? simplifyRing(ring) : [];

  /** Slopes in from every wall by `d` metres, rising `rise`, with a flat top. Null when the outline is too narrow for it. */
  const crown = (d: number, rise: number): RidgeSpot | null => {
    const inner = insetRing(simple, d);
    if (!inner) return null;
    for (let i = 0; i < simple.length; i++) {
      const j = (i + 1) % simple.length;
      slopeFace(roof, [[simple[i][0], simple[i][1], top], [simple[j][0], simple[j][1], top], [inner[j][0], inner[j][1], top + rise], [inner[i][0], inner[i][1], top + rise]]);
    }
    const first = roof.count;
    for (const [e, n] of inner) roof.vert(e, n, top + rise, 0, 0, 1);
    const tris = earcut(inner.flat());
    for (let i = 0; i < tris.length; i += 3) roof.triUp(first + tris[i], first + tris[i + 1], first + tris[i + 2]);
    // A chimney can stand just inside the longest edge of the flat top.
    let longest = 0;
    let spot: RidgeSpot = { x: inner[0][0], y: inner[0][1], z: top + rise, along: [1, 0] };
    for (let i = 0; i < inner.length; i++) {
      const p = inner[i], q = inner[(i + 1) % inner.length];
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (len <= longest) continue;
      longest = len;
      const u: XY = [(q[0] - p[0]) / len, (q[1] - p[1]) / len];
      spot = { x: p[0] + (q[0] - p[0]) * 0.35 - u[1] * 0.3, y: p[1] + (q[1] - p[1]) * 0.35 + u[0] * 0.3, z: top + rise, along: u };
    }
    return spot;
  };

  if (holes.length) {
    // A building round a courtyard: a flat roof with the yard cut out of it.
    const flat = look.form === "flat" ? roof : flatRoof;
    const first = flat.count;
    const flatPts: number[] = [];
    const starts: number[] = [];
    for (const [e, n] of ring) { flat.vert(e, n, top, 0, 0, 1); flatPts.push(e, n); }
    for (const hole of holes) {
      starts.push(flatPts.length / 2);
      for (const [e, n] of hole) { flat.vert(e, n, top, 0, 0, 1); flatPts.push(e, n); }
    }
    const tris = earcut(flatPts, starts);
    for (let i = 0; i < tris.length; i += 3) flat.triUp(first + tris[i], first + tris[i + 1], first + tris[i + 2]);
    return null;
  }
  if (shape === "skillion" && ring.length <= 48) {
    // One slope, from its high wall to its low one. Unmapped, it falls towards its longest wall.
    const rise = Math.min(height * 0.6, b.roofHeight ?? clamp(0.12 * Math.sqrt(areaM2), 0.8, 3));
    let fall: XY = facing ?? [0, 1];
    if (!facing) {
      let longest = 0;
      for (let i = 0; i < ring.length; i++) {
        const de = ring[(i + 1) % ring.length][0] - ring[i][0], dn = ring[(i + 1) % ring.length][1] - ring[i][1];
        const len = Math.hypot(de, dn);
        if (len > longest) { longest = len; fall = [dn / len, -de / len]; }
      }
    }
    const up = ring.map(([e, n]) => -(e * fall[0] + n * fall[1]));
    const lowest = Math.min(...up), span = Math.max(...up) - lowest || 1;
    const z = up.map((v) => top + (rise * (v - lowest)) / span);
    const k = rise / span, nl = Math.hypot(k, 1);
    const first = roof.count;
    ring.forEach(([e, n], i) => roof.vert(e, n, z[i], (fall[0] * k) / nl, (fall[1] * k) / nl, 1 / nl));
    const tris = earcut(ring.flat());
    for (let i = 0; i < tris.length; i += 3) roof.triUp(first + tris[i], first + tris[i + 1], first + tris[i + 2]);
    // The walls carry on up to meet it.
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length;
      const de = ring[j][0] - ring[i][0], dn = ring[j][1] - ring[i][1], len = Math.hypot(de, dn);
      if (len < 0.01 || (z[i] - top < 0.02 && z[j] - top < 0.02)) continue;
      const ne = dn / len, nn = -de / len;
      const v0 = walls.vert(ring[i][0], ring[i][1], top, ne, nn, 0);
      const v1 = walls.vert(ring[j][0], ring[j][1], top, ne, nn, 0);
      const v2 = walls.vert(ring[j][0], ring[j][1], z[j], ne, nn, 0);
      const v3 = walls.vert(ring[i][0], ring[i][1], z[i], ne, nn, 0);
      if (z[j] - top >= 0.02) walls.tri(v0, v1, v2);
      if (z[i] - top >= 0.02) walls.tri(v0, v2, v3);
    }
    return null;
  }
  if (/^(dome|onion|cone|pyramidal)$/.test(shape) && ring.length >= 3 && ring.length <= 64 && areaM2 < 8000 && isConvex(ring)) {
    // Round roofs and points: the outline drawn in towards the middle as it rises, by the roof's profile.
    let mx = 0, my = 0;
    for (const [x, y] of ring) { mx += x / ring.length; my += y / ring.length; }
    const radius = Math.sqrt(areaM2 / Math.PI);
    const rise = Math.min(60, b.roofHeight ?? roundRise(shape, radius));
    const profile: XY[] = shape === "dome" ? [[1, 0], [0.95, 0.31], [0.81, 0.59], [0.59, 0.81], [0.31, 0.95], [0, 1]]
      : shape === "onion" ? [[1, 0], [1.12, 0.14], [1.1, 0.32], [0.85, 0.55], [0.45, 0.74], [0.16, 0.88], [0, 1]]
      : [[1, 0], [0, 1]];
    const at = (pt: XY, r: number, h: number): [number, number, number] => [mx + (pt[0] - mx) * r, my + (pt[1] - my) * r, top + rise * h];
    for (let k = 0; k + 1 < profile.length; k++) {
      const [r0, h0] = profile[k], [r1, h1] = profile[k + 1];
      for (let i = 0; i < ring.length; i++) {
        const p = ring[i], q = ring[(i + 1) % ring.length];
        outFace(roof, r1 > 0 ? [at(p, r0, h0), at(q, r0, h0), at(q, r1, h1), at(p, r1, h1)] : [at(p, r0, h0), at(q, r0, h0), [mx, my, top + rise * h1]], mx, my);
      }
    }
    return null;
  }
  if (mansard && simple.length >= 3 && simple.length <= 24) {
    // A mansard: steep sides and a flat top, whatever the size of the building.
    for (const d of [1.5, 1.1, 0.8]) {
      const spot = crown(d, Math.min(height * 0.5, b.roofHeight ?? d * 1.8));
      if (spot) return spot;
    }
  }
  if (pitched && (areaM2 < 400 || (tagged && areaM2 < 3000)) && simple.length >= 3 && simple.length <= 8 && isConvex(simple)) {
    const rise = Math.min(height * 0.8, b.roofHeight ?? clamp(0.35 * Math.sqrt(areaM2), 1.8, 5) * look.pitch);
    if (isRectangle(simple)) {
      // Ridge along the longer sides, unless the map says which way the roof faces.
      const [p0, p1, p2, p3] = simple;
      const side01 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
      let long = side01 >= Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      if (b.roofAcross) long = !long;
      else if (facing && shape !== "hipped") long = Math.abs(((p1[0] - p0[0]) * facing[0] + (p1[1] - p0[1]) * facing[1]) / side01) < 0.7071;
      const [a, b2, c, d] = long ? [p0, p1, p2, p3] : [p1, p2, p3, p0];
      const r0: [number, number, number] = [(d[0] + a[0]) / 2, (d[1] + a[1]) / 2, top + rise];
      const r1: [number, number, number] = [(b2[0] + c[0]) / 2, (b2[1] + c[1]) / 2, top + rise];
      // The slopes run on past the walls: out over the gable ends and down past the eaves.
      const run = Math.hypot(b2[0] - a[0], b2[1] - a[1]) || 1;
      const u: XY = [(b2[0] - a[0]) / run, (b2[1] - a[1]) / run]; // along the ridge
      const span = Math.hypot(a[0] - d[0], a[1] - d[1]) || 1;
      const out: XY = [(a[0] - d[0]) / span, (a[1] - d[1]) / span]; // from the ridge towards side a-b2
      const drop = (EAVES * rise) / (span / 2);
      const eave = (p: XY, alongRidge: number, side: number): [number, number, number] =>
        [p[0] + u[0] * EAVES * alongRidge + out[0] * EAVES * side, p[1] + u[1] * EAVES * alongRidge + out[1] * EAVES * side, top - drop];
      if (shape === "hipped") {
        // A hip: the ends slope too, so the ridge stops short of each end by half the width of the house.
        const inset = Math.min(span / 2, run / 2);
        const H0: [number, number, number] = [r0[0] + u[0] * inset, r0[1] + u[1] * inset, r0[2]];
        const H1: [number, number, number] = [r1[0] - u[0] * inset, r1[1] - u[1] * inset, r1[2]];
        const A = eave(a, -1, 1), B = eave(b2, 1, 1), C = eave(c, 1, -1), D = eave(d, -1, -1);
        const hips: [number, number, number][][] = run - 2 * inset > 0.05 ? [[A, B, H1, H0], [C, D, H0, H1], [B, C, H1], [D, A, H0]] : [[A, B, H0], [C, D, H0], [B, C, H0], [D, A, H0]];
        for (const pts of hips) {
          slopeFace(roof, pts);
          const first = roof.count - pts.length;
          const n: [number, number, number] = [-roof.nrm[first * 3], -roof.nrm[first * 3 + 1], -roof.nrm[first * 3 + 2]];
          face(soffit, pts.map(([e, nn, h]) => [e, nn, h - 0.04]), n);
        }
        return { x: (H0[0] + H1[0]) / 2, y: (H0[1] + H1[1]) / 2, z: top + rise, along: u };
      }
      const R0: [number, number, number] = [r0[0] - u[0] * EAVES, r0[1] - u[1] * EAVES, r0[2]];
      const R1: [number, number, number] = [r1[0] + u[0] * EAVES, r1[1] + u[1] * EAVES, r1[2]];
      const slopes: [number, number, number][][] = [
        [eave(a, -1, 1), eave(b2, 1, 1), R1, R0],
        [eave(c, 1, -1), eave(d, -1, -1), R0, R1],
      ];
      for (const pts of slopes) {
        slopeFace(roof, pts);
        // The underside, seen from the street under the eaves.
        const first = roof.count - 4;
        const n: [number, number, number] = [-roof.nrm[first * 3], -roof.nrm[first * 3 + 1], -roof.nrm[first * 3 + 2]];
        face(soffit, pts.map(([e, nn, h]) => [e, nn, h - 0.04]), n);
      }
      gableEnd(walls, b2, c, top, r1);
      gableEnd(walls, d, a, top, r0);
      return { x: r0[0] + (r1[0] - r0[0]) * 0.3, y: r0[1] + (r1[1] - r0[1]) * 0.3, z: top + rise, along: u };
    }
    // Hip: the outline pulled in towards the middle and raised, with a small flat top.
    let mx = 0, my = 0;
    for (const [x, y] of simple) { mx += x; my += y; }
    mx /= simple.length;
    my /= simple.length;
    const inner: XY[] = simple.map(([x, y]) => [mx + (x - mx) * 0.35, my + (y - my) * 0.35]);
    for (let i = 0; i < simple.length; i++) {
      const j = (i + 1) % simple.length;
      slopeFace(roof, [[simple[i][0], simple[i][1], top], [simple[j][0], simple[j][1], top], [inner[j][0], inner[j][1], top + rise], [inner[i][0], inner[i][1], top + rise]]);
    }
    const first = roof.count;
    for (const [e, n] of inner) roof.vert(e, n, top + rise, 0, 0, 1);
    const tris = earcut(inner.flat());
    for (let i = 0; i < tris.length; i += 3) roof.triUp(first + tris[i], first + tris[i + 1], first + tris[i + 2]);
    const edge = Math.hypot(simple[1][0] - simple[0][0], simple[1][1] - simple[0][1]) || 1;
    return { x: mx, y: my, z: top + rise, along: [(simple[1][0] - simple[0][0]) / edge, (simple[1][1] - simple[0][1]) / edge] };
  }
  if (pitched && simple.length >= 4 && simple.length <= 24) {
    // Any other outline: slope in from every wall as far as the shape allows, leaving a flat strip on top.
    for (const d of [4.5, 3.5, 2.6, 1.8]) {
      const spot = crown(d, Math.min(height * 0.8, b.roofHeight ?? d * 0.7 * look.pitch));
      if (spot) return spot;
    }
  }
  if (look.form === "flat" && !flatTag && areaM2 >= 12 && areaM2 < 1500) {
    // Where roofs are flat by custom, the walls carry on up as a low parapet round a roof you could sit on.
    const outline = simplifyRing(ring);
    const inner = outline.length >= 3 && outline.length <= 24 ? insetRing(outline, 0.28) : null;
    if (inner) {
      const sill = top - 0.4;
      for (let i = 0; i < outline.length; i++) {
        const j = (i + 1) % outline.length;
        face(walls, [[outline[i][0], outline[i][1], top], [outline[j][0], outline[j][1], top], [inner[j][0], inner[j][1], top], [inner[i][0], inner[i][1], top]], [0, 0, 1]);
        const len = Math.hypot(inner[j][0] - inner[i][0], inner[j][1] - inner[i][1]) || 1;
        const inward: [number, number, number] = [-(inner[j][1] - inner[i][1]) / len, (inner[j][0] - inner[i][0]) / len, 0];
        face(walls, [[inner[i][0], inner[i][1], sill], [inner[j][0], inner[j][1], sill], [inner[j][0], inner[j][1], top], [inner[i][0], inner[i][1], top]], inward);
      }
      const first = roof.count;
      for (const [e, n] of inner) roof.vert(e, n, sill, 0, 0, 1);
      const tris = earcut(inner.flat());
      for (let i = 0; i < tris.length; i += 3) roof.triUp(first + tris[i], first + tris[i + 1], first + tris[i + 2]);
      return null;
    }
  }
  // Flat, and where roofs are not flat by custom, in roofing felt and not the colour of tiles.
  const flat = look.form === "flat" ? roof : flatRoof;
  const first = flat.count;
  for (const [e, n] of ring) flat.vert(e, n, top, 0, 0, 1);
  const tris = earcut(ring.flat());
  for (let i = 0; i < tris.length; i += 3) flat.triUp(first + tris[i], first + tris[i + 1], first + tris[i + 2]);
  return null;
}

/** How high a round or pointed roof is for its width, where the map does not say. */
function roundRise(shape: string, radius: number): number {
  return shape === "dome" ? radius * 0.9 : shape === "onion" ? radius * 1.9 : shape === "cone" ? radius * 1.6 : clamp(radius * 0.9, 1.5, 8);
}

/**
 * How far a building's roof will rise above its walls, near enough. A height mapped in metres is to
 * the top of the roof, so the walls of such a building stop this much short of it.
 */
function roofRise(b: Building, areaM2: number, height: number, look: RoofLook): number {
  const shape = roofShape(b);
  if (shape === "flat") return 0;
  if (b.roofHeight !== undefined) return b.roofHeight;
  if (shape === "skillion") return clamp(0.12 * Math.sqrt(areaM2), 0.8, 3);
  if (/^(dome|onion|cone|pyramidal)$/.test(shape)) return roundRise(shape, Math.sqrt(areaM2 / Math.PI));
  if (shape === "mansard" || (!shape && look.form === "mansard" && height < 26 && areaM2 < 4000)) return 2.5;
  if (shape || (look.form === "pitched" && areaM2 < 400 && height < look.maxPitched)) return clamp(0.35 * Math.sqrt(areaM2), 1.8, 5) * look.pitch;
  return 0;
}

/**
 * Where a building's name goes: the middle of a board on its front wall (chunk-local metres east and
 * north, metres above the sea), the way it faces, and how wide it may be. The games draw the board.
 */
export interface SignSpot { text: string; x: number; y: number; z: number; out: XY; width: number; /** True for a shop, a church, a school...: these keep their signs where a chunk has too many. */ known?: boolean; /** What kind of place it is, where the map says: a shop, somewhere to eat... */ use?: string }
/** A city centre has a name on every building: a chunk keeps this many, the shops, churches and schools first. */
const SIGN_CAP = 20;

/**
 * A home that can be walked into: its outline (four corners, chunk-local metres, counter-clockwise),
 * where its front door is on that outline and which way is out, how high its floor is and how tall
 * its walls, and the numbers its inside is made from (interior.ts).
 */
export interface HomeDoor {
  id: number;
  corners: XY[];
  /** The door: its place on the wall, the unit vector along that wall, and the one pointing out of the house. */
  x: number; y: number; along: XY; out: XY;
  floor: number;
  height: number;
  seed: number;
  wall: number;
  /** Has it a porch over the door? (A sign over the door has to stand on it to be seen.) */
  porch: boolean;
  /** "shop", "food", "office" or "hotel" where the map says it is one: it is that inside, not a home (venues.ts). */
  use?: string;
  name?: string;
}
/**
 * What building a chunk's mesh works out about each building that is not mapped in 3D, for whoever
 * lays out its inside (venues.ts): how high its walls stand, the ground at its lowest and highest
 * corner, whether it stands on legs, where its front door is drawn (homes and flats) and where its
 * name and shopfront go (anything with a name or a use). Metres, chunk-local, as in `HomeDoor`.
 */
export interface Shell {
  id: number;
  top: number; lo: number; hi: number;
  raised: boolean;
  door?: { x: number; y: number; along: XY; out: XY };
  front?: { x: number; y: number; along: XY; out: XY };
}
/**
 * The room a home gives to its inside is at least `HOME_MIN_M` a side and at most `HOME_MAX_M` (a
 * bigger house gives that much of itself, round its door). On ground that drops more than
 * `HOME_SLOPE_M` across the house, the door stays shut.
 */
const HOME_MIN_M = 4;
const HOME_MAX_M = 24;
const HOME_SLOPE_M = 6;
/** The front door is at least this far from each end of the room's front wall. */
const HOME_DOOR_CLEAR_M = 0.85;

/** Does a shape (counter-clockwise, metres) keep inside an outline all the way round? Tried a hand's breadth in from its edge. */
function liesInside(shape: XY[], ring: XY[]): boolean {
  const IN = 0.06;
  const inside = (x: number, y: number): boolean => {
    let odd = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
    }
    return odd;
  };
  for (let i = 0; i < shape.length; i++) {
    const p = shape[i], q = shape[(i + 1) % shape.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len < IN * 4) continue;
    const tx = (q[0] - p[0]) / len, ty = (q[1] - p[1]) / len;
    const steps = Math.max(2, Math.ceil(len / 0.4));
    for (let k = 0; k <= steps; k++) {
      const s = IN * 2 + ((len - IN * 4) * k) / steps;
      if (!inside(p[0] + tx * s - ty * IN, p[1] + ty * s + tx * IN)) return false;
    }
  }
  return true;
}

/**
 * The largest rectangle inside a house of any outline (`ring`, counter-clockwise) that has one side
 * along the wall its front door is on and the door in that side: where the rooms go when the house
 * is not a plain rectangle itself. `x, y` is the door, `t` runs along its wall and `o` points out.
 * Four corners, counter-clockwise, starting with the two on the front wall; null when no room of
 * `HOME_MIN_M` a side fits.
 */
export function roomInside(ring: XY[], x: number, y: number, t: XY, o: XY, maxWide = HOME_MAX_M, maxDeep = HOME_MAX_M, least = HOME_MIN_M): XY[] | null {
  // The house in the door's own frame: `a` along the wall from the door, `b` back into the house.
  const pts = ring.map(([e, n]): XY => [(e - x) * t[0] + (n - y) * t[1], -((e - x) * o[0] + (n - y) * o[1])]);
  const lo = Math.min(...pts.map((p) => p[0])), hi = Math.max(...pts.map((p) => p[0]));
  // Where a side of the room may be: under every corner of the house, and every metre between.
  const marks = pts.map((p) => p[0]);
  for (let a = Math.ceil(lo); a < hi; a++) marks.push(a);
  marks.sort((p, q) => p - q);
  const at: number[] = [];
  for (const a of marks) if (!at.length || a - at[at.length - 1] > 0.02) at.push(a);

  /** Looking back into the house from half a metre inside the front wall at `a`: how near the wall behind is, and the one in front. */
  const PROBE = 0.5;
  const span = (a: number): [number, number] => {
    let front = -Infinity, back = Infinity, behind = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      if ((p[0] <= a) === (q[0] <= a)) continue;
      const b = p[1] + ((a - p[0]) / (q[0] - p[0])) * (q[1] - p[1]);
      if (b > PROBE) { behind++; if (b < back) back = b; } else if (b > front) front = b;
    }
    return behind % 2 === 1 ? [front, back] : [0, 0]; // an even count: this spot is not in the house at all
  };
  // Between two marks the walls run straight, so the tightest place is just inside one end or the other.
  const gaps: [number, number][] = [];
  for (let i = 0; i + 1 < at.length; i++) {
    const [f0, b0] = span(at[i] + 0.01), [f1, b1] = span(at[i + 1] - 0.01);
    gaps.push([Math.max(f0, f1), Math.min(b0, b1)]);
  }

  let best: [number, number, number, number] | null = null;
  let bestArea = 0;
  for (let i = 0; i + 1 < at.length && at[i] <= -HOME_DOOR_CLEAR_M; i++) {
    let front = 0, back = Infinity;
    for (let j = i + 1; j < at.length; j++) {
      front = Math.max(front, gaps[j - 1][0]);
      back = Math.min(back, gaps[j - 1][1]);
      // The door's wall must be the front of the room all the way along, give or take a wall's thickness.
      if (front > 0.25 || back - front < least) break;
      if (at[j] < HOME_DOOR_CLEAR_M) continue;
      const wide = Math.min(at[j] - at[i], maxWide), deep = Math.min(back - front, maxDeep);
      if (wide < least || wide * deep <= bestArea) continue;
      const left = Math.max(at[i], Math.min(-wide / 2, at[j] - wide)); // a house wider than the most: that much of it, round the door
      bestArea = wide * deep;
      best = [left, left + wide, front, front + deep];
    }
  }
  if (!best) return null;
  const [a0, a1, b0, b1] = best;
  const back = (a: number, b: number): XY => [x + t[0] * a - o[0] * b, y + t[1] * a - o[1] * b];
  return [back(a0, b0), back(a1, b0), back(a1, b1), back(a0, b1)];
}

/**
 * `look` is the style of the houses; left out, it is the style of where the chunk is in the world.
 * `homes`, when given, is filled with the homes that can be walked into.
 */
export function buildChunkMesh(cx: number, cy: number, features: Features, elev: Elevation, look?: HouseStyle, homes?: HomeDoor[], signs?: SignSpot[], shells?: Shell[]): ChunkMesh {
  const S = metersPerTile(cy + 0.5, CHUNK_Z);
  const sections = new Map<string, Section>();
  const sec = (m: MaterialDef): Section => {
    const key = `${m.id}:${m.color}`;
    let s = sections.get(key);
    if (!s) sections.set(key, (s = new Section(m)));
    return s;
  };
  const E = (wx: number): number => (wx - cx) * S;
  const N = (wy: number): number => -(wy - cy) * S;
  const ground = (wx: number, wy: number): number => elev.surfaceHeight(wx, wy);
  /** Smooth terrain normal (east, north, up) from the raw elevation field. */
  const groundNormal = (wx: number, wy: number): [number, number, number] => {
    const d = 1 / GRID;
    const dE = (elev.rawHeight(wx + d, wy) - elev.rawHeight(wx - d, wy)) / (2 * d * S);
    const dN = (elev.rawHeight(wx, wy - d) - elev.rawHeight(wx, wy + d)) / (2 * d * S);
    const len = Math.hypot(dE, dN, 1);
    return [-dE / len, -dN / len, 1 / len];
  };

  const cls = groundClasses(cx, cy, features, elev);
  const URBAN = GROUND_ORDER.indexOf("urban") + 1;
  const PAVED = GROUND_ORDER.indexOf("paved") + 1;
  // Land use is often not mapped where houses are, so buildings count too: the cells within about
  // 40 m of one (a border of cells round the chunk is kept, since streets run on past its edge).
  const NEAR = 5;
  const PADDED = GRID + 2 * NEAR;
  const nearBuilding = new Uint8Array(PADDED * PADDED);
  for (const b of features.buildings) {
    for (const [wx, wy] of b.ring) {
      const i = Math.floor((wx - cx) * GRID) + NEAR, j = Math.floor((wy - cy) * GRID) + NEAR;
      for (let dj = -NEAR; dj <= NEAR; dj++) {
        for (let di = -NEAR; di <= NEAR; di++) {
          const x = i + di, y = j + dj;
          if (x >= 0 && x < PADDED && y >= 0 && y < PADDED) nearBuilding[y * PADDED + x] = 1;
        }
      }
    }
  }
  /** True where people live: residential or paved ground, or buildings close by. */
  const builtUp = (wx: number, wy: number): boolean => {
    const fi = Math.floor((wx - cx) * GRID), fj = Math.floor((wy - cy) * GRID);
    const c = cls[clamp(fj, 0, GRID - 1) * GRID + clamp(fi, 0, GRID - 1)];
    if (c === URBAN || c === PAVED) return true;
    const x = fi + NEAR, y = fj + NEAR;
    return x >= 0 && x < PADDED && y >= 0 && y < PADDED && nearBuilding[y * PADDED + x] === 1;
  };

  // ---- terrain
  const heights = new Float32Array((GRID + 1) * (GRID + 1));
  for (let j = 0; j <= GRID; j++) {
    for (let i = 0; i <= GRID; i++) {
      heights[j * (GRID + 1) + i] = elev.gridHeight(cx * GRID + i, cy * GRID + j);
    }
  }
  const terrainVerts = new Map<number, Map<number, number>>(); // material id -> grid vertex -> index
  const terrainVert = (s: Section, i: number, j: number): number => {
    let m = terrainVerts.get(s.mat.id);
    if (!m) terrainVerts.set(s.mat.id, (m = new Map()));
    const key = j * (GRID + 1) + i;
    let v = m.get(key);
    if (v === undefined) {
      const wx = cx + i / GRID;
      const wy = cy + j / GRID;
      const [ne, nn, nh] = groundNormal(wx, wy);
      v = s.vert(E(wx), N(wy), heights[key], ne, nn, nh);
      m.set(key, v);
    }
    return v;
  };
  // Where a tunnel comes up through the ground, the ground is cut away round it (spans.ts, spanmesh.ts).
  const spans = spansOf(features, elev);
  const spanCtx: SpanCtx = { cx, cy, S, sec, ground, mats: MATERIALS, painted };
  const tunnels = planTunnels(spanCtx, spans, GRID);
  const CUT = 6; // a cut cell is drawn as this many smaller squares a side, less those in the tunnel
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const c = cls[j * GRID + i];
      const s = sec(c === 0 ? MATERIALS.ground : MATERIALS[GROUND_ORDER[c - 1]]);
      const a = terrainVert(s, i, j);
      const b = terrainVert(s, i + 1, j);
      const d = terrainVert(s, i, j + 1);
      const e = terrainVert(s, i + 1, j + 1);
      if (tunnels.cells?.[j * GRID + i]) {
        // The corners stay in the section, so that the terrain's grid of heights is whole for whoever reads it;
        // the cell itself is drawn as other ground (9), in the same colour, with the tunnel's way through left open.
        const patch = sec(painted(MATERIALS.cut, s.mat.color >>> 8));
        const at = (u: number, v: number): [number, number] => [cx + (i + u / CUT) / GRID, cy + (j + v / CUT) / GRID];
        for (let v = 0; v < CUT; v++) {
          for (let u = 0; u < CUT; u++) {
            const corners = [at(u, v), at(u + 1, v), at(u, v + 1), at(u + 1, v + 1)];
            if (tunnels.inHole(...at(u + 0.5, v + 0.5)) || corners.some(([wx, wy]) => tunnels.inHole(wx, wy))) continue;
            const [pa, pb, pd, pe] = corners.map(([wx, wy]) => {
              const [ne, nn, nh] = groundNormal(wx, wy);
              return patch.vert(E(wx), N(wy), ground(wx, wy), ne, nn, nh);
            });
            patch.triUp(pa, pe, pb);
            patch.triUp(pa, pd, pe);
          }
        }
        continue;
      }
      // Diagonal a-e; must match Elevation.surfaceHeight.
      s.triUp(a, e, b);
      s.triUp(a, d, e);
    }
  }
  if (tunnels.cells) {
    // A kind of ground all of whose cells here were cut away has no triangle left, and a section with none is
    // not sent: its corners of the grid go into one that is, so that the grid of heights stays whole.
    const sent = [...sections.values()].find((s) => s.mat.id <= 8 && s.idx.length > 0);
    if (sent) for (const s of sections.values()) {
      if (s.mat.id > 8 || s.idx.length > 0) continue;
      for (let i = 0; i < s.pos.length; i += 3) sent.vert(s.pos[i], s.pos[i + 1], s.pos[i + 2], s.nrm[i], s.nrm[i + 1], s.nrm[i + 2]);
    }
  }

  // ---- roads, paths, rails and streams: ribbons draped on the terrain
  const ribbon = (road: Road): void => {
    const mat = MATERIALS[road.cls];
    const lift = road.cls === "stream" ? 0.06 : road.cls === "rail" ? 0.09 : road.cls === "path" ? 0.12 : 0.16 + Math.min(road.width, 12) * 0.004;
    const half = road.width / 2;
    const pad = (half + 1) / S;
    for (const piece of clipPolyline(road.pts, cx - pad, cy - pad, cx + 1 + pad, cy + 1 + pad)) {
      // Resample so the ribbon follows the terrain between map nodes.
      const line: [number, number][] = [];
      for (let i = 0; i < piece.length; i++) {
        const e = E(piece[i][0]);
        const n = N(piece[i][1]);
        if (i > 0) {
          const [pe, pn] = line[line.length - 1];
          const len = Math.hypot(e - pe, n - pn);
          if (len < 0.05) continue;
          const steps = Math.ceil(len / 6);
          for (let k = 1; k < steps; k++) line.push([pe + ((e - pe) * k) / steps, pn + ((n - pn) * k) / steps]);
        }
        line.push([e, n]);
      }
      if (line.length < 2) continue;
      const s = sec(mat);
      let prevL = -1;
      let prevR = -1;
      // Town streets get a pavement each side. It lies a little lower than the road, so where two
      // streets meet, each road covers the other's pavement instead of being crossed by it.
      const paved = road.cls === "road" && road.width >= 5 && road.width < 10;
      const walk = paved ? sec(MATERIALS.pavement) : null;
      let prevWalk: number[] | null = null;
      for (let i = 0; i < line.length; i++) {
        const a = line[Math.max(0, i - 1)];
        const b = line[Math.min(line.length - 1, i + 1)];
        let te = b[0] - a[0];
        let tn = b[1] - a[1];
        const tl = Math.hypot(te, tn) || 1;
        te /= tl;
        tn /= tl;
        const le = line[i][0] - tn * half; // left of travel direction
        const ln = line[i][1] + te * half;
        const re = line[i][0] + tn * half;
        const rn = line[i][1] - te * half;
        const lw: Pt = [cx + le / S, cy - ln / S];
        const rw: Pt = [cx + re / S, cy - rn / S];
        const nl = groundNormal(lw[0], lw[1]);
        const nr = groundNormal(rw[0], rw[1]);
        const L = s.vert(le, ln, ground(lw[0], lw[1]) + lift, nl[0], nl[1], nl[2]);
        const R = s.vert(re, rn, ground(rw[0], rw[1]) + lift, nr[0], nr[1], nr[2]);
        if (prevL >= 0) {
          s.triUp(prevL, prevR, R);
          s.triUp(prevL, R, L);
        }
        prevL = L;
        prevR = R;

        if (walk) {
          // Only where the land is lived on: a road through fields or forest has verges, not pavements.
          const here = builtUp(cx + line[i][0] / S, cy - line[i][1] / S);
          let now: number[] | null = null;
          if (here) {
            now = [];
            for (const side of [1, -1]) {
              for (const reach of [half, half + PAVEMENT]) {
                const e = line[i][0] - tn * reach * side;
                const n = line[i][1] + te * reach * side;
                const wx = cx + e / S, wy = cy - n / S;
                const [ne, nn, nh] = groundNormal(wx, wy);
                now.push(walk.vert(e, n, ground(wx, wy) + 0.09, ne, nn, nh));
              }
            }
          }
          if (now && prevWalk) {
            for (const k of [0, 2]) {
              walk.triUp(prevWalk[k], prevWalk[k + 1], now[k + 1]);
              walk.triUp(prevWalk[k], now[k + 1], now[k]);
            }
          }
          prevWalk = now;
        }
      }

      // A dashed line down the middle of the wider roads, stopping short of the ends where roads meet.
      if (road.cls === "road" && road.width >= 6.5) {
        const marks = sec(MATERIALS.marking);
        const lift = 0.19 + Math.min(road.width, 12) * 0.004;
        let total = 0;
        for (let i = 1; i < line.length; i++) total += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
        let at = 0;
        for (let i = 1; i < line.length; i++) {
          const [ae, an] = line[i - 1];
          const [be, bn] = line[i];
          const len = Math.hypot(be - ae, bn - an);
          if (len < 0.05) continue;
          const te = (be - ae) / len, tn = (bn - an) / len;
          // Dashes are 3 m long, 8 m apart, placed by distance along the road so they do not bunch at bends.
          for (let d = Math.ceil((at - 3) / 8) * 8; d < at + len; d += 8) {
            const from = Math.max(d, at), to = Math.min(d + 3, at + len);
            if (to - from < 0.3 || d < 7 || d + 3 > total - 7) continue;
            const corners: number[] = [];
            for (const along of [from - at, to - at]) {
              for (const side of [0.09, -0.09]) {
                const e = ae + te * along - tn * side;
                const n = an + tn * along + te * side;
                const wx = cx + e / S, wy = cy - n / S;
                const [ne, nn, nh] = groundNormal(wx, wy);
                corners.push(marks.vert(e, n, ground(wx, wy) + lift, ne, nn, nh));
              }
            }
            marks.triUp(corners[0], corners[1], corners[3]);
            marks.triUp(corners[0], corners[3], corners[2]);
          }
          at += len;
        }
      }
    }
  };
  // A stretch on a bridge is not on the ground: it is drawn as a bridge, at the height worked out for it (spans.ts).
  for (const road of features.roads) if (!spans.profiles.has(road.id)) ribbon(road);
  drawSpans(spanCtx, features, spans, rampsOf(features, spans), tunnels);

  // ---- buildings: extruded footprints, owned by the chunk containing their centroid
  // Road points near this chunk (chunk-local metres), for finding the wall that faces the street.
  const roadPoints: [number, number, number][] = []; // east, north, half width with any pavement
  for (const road of features.roads) {
    if (road.cls !== "road") continue;
    for (let i = 0; i < road.pts.length; i++) {
      const [wx, wy] = road.pts[i];
      if (wx < cx - 0.25 || wx > cx + 1.25 || wy < cy - 0.25 || wy > cy + 1.25) continue;
      const reach = road.width / 2 + (road.width >= 5 && road.width < 10 ? PAVEMENT : 0);
      roadPoints.push([E(wx), N(wy), reach]);
      // Long straight pieces have few points; add some along the way.
      if (i + 1 < road.pts.length) {
        const [nx, ny] = road.pts[i + 1];
        const steps = Math.min(40, Math.floor((Math.hypot(nx - wx, ny - wy) * S) / 12));
        for (let k = 1; k < steps; k++) roadPoints.push([E(wx + ((nx - wx) * k) / steps), N(wy + ((ny - wy) * k) / steps), reach]);
      }
    }
  }
  // ---- buildings, in the style of this part of the world
  const style = look ?? houseStyle(yToLat(cy + 0.5), xToLon(cx + 0.5), ground(cx + 0.5, cy + 0.5));
  // How built-up it is round a building decides whether a home nobody measured is a house standing
  // apart, one of a street of town houses, or part of a city block. Footprints are counted in a
  // square round it, over only as much of the square as the map data covers (its data tile and
  // margin), so the answer does not dip at the edge of the data.
  const shift = CHUNK_Z - DATA_Z;
  const dataW = ((cx >> shift) - DATA_MARGIN) * (1 << shift), dataE = ((cx >> shift) + 1 + DATA_MARGIN) * (1 << shift);
  const dataN = ((cy >> shift) - DATA_MARGIN) * (1 << shift), dataS = ((cy >> shift) + 1 + DATA_MARGIN) * (1 << shift);
  const footprints: [number, number, number][] = []; // centre, and area in m2 (the largest count as 1500)
  for (const b of features.buildings) {
    let fx = 0, fy = 0, a2 = 0;
    for (let i = 0, j = b.ring.length - 1; i < b.ring.length; j = i++) {
      fx += b.ring[i][0];
      fy += b.ring[i][1];
      a2 += b.ring[j][0] * b.ring[i][1] - b.ring[i][0] * b.ring[j][1];
    }
    footprints.push([fx / b.ring.length, fy / b.ring.length, Math.min(1500, (Math.abs(a2) / 2) * S * S)]);
  }
  const cover = (wx: number, wy: number, halfM: number): { share: number; count: number } => {
    const r = halfM / S;
    const w = Math.max(wx - r, dataW), e = Math.min(wx + r, dataE), n = Math.max(wy - r, dataN), s = Math.min(wy + r, dataS);
    let area = 0, count = 0;
    for (const [fx, fy, fa] of footprints) {
      if (fx < w || fx > e || fy < n || fy > s) continue;
      area += fa;
      count++;
    }
    return { share: area / Math.max(1, (e - w) * (s - n) * S * S), count };
  };
  /** 0 standing apart, 1 in a built-up street, 2 in a city centre. */
  const crowding = (wx: number, wy: number): number => {
    const near = cover(wx, wy, 60);
    if (near.count < 5 || near.share < 0.26) return 0;
    return near.count >= 6 && near.share >= 0.42 && cover(wx, wy, 220).share >= 0.25 ? 2 : 1;
  };

  /** How many 3D pieces this chunk has drawn: a city centre mapped piece by piece is capped. */
  let partsDrawn = 0;
  // A chunk with a great many buildings of its own (the old middle of a city, mapped house by house) is drawn
  // more plainly: every house keeps its walls, roof and front door, and goes without what is small or beside
  // it (the door's step and knob, a porch, a chimney, a front garden). Otherwise such a chunk is four
  // megabytes to send, most of it those. (TRIAL: behind a setting until the game's owner has seen both.)
  const crowded = CROWDED > 0 && footprints.filter(([fx, fy]) => fx >= cx && fx < cx + 1 && fy >= cy && fy < cy + 1).length > CROWDED;
  /** A building's front: the wall facing the nearest road (failing any, its longest), as its middle, the way along it, the way out and its length. */
  const frontOf = (ring: XY[]): { x: number; y: number; t: XY; o: XY; len: number; from: XY } | null => {
    let front = -1;
    let frontScore = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const [ae, an] = ring[i];
      const [be, bn] = ring[(i + 1) % ring.length];
      const len = Math.hypot(be - ae, bn - an);
      if (len < 2.4) continue;
      const me = (ae + be) / 2, mn = (an + bn) / 2;
      const oe = (bn - an) / len, on = -(be - ae) / len;
      let score = 1000 - len;
      for (const [qe, qn] of roadPoints) {
        const de = qe - me, dn = qn - mn;
        if (de * oe + dn * on <= 1) continue;
        const dist = Math.hypot(de, dn);
        if (dist < 90 && dist < score) score = dist;
      }
      if (score < frontScore) { frontScore = score; front = i; }
    }
    if (front < 0) return null;
    const [ae, an] = ring[front];
    const [be, bn] = ring[(front + 1) % ring.length];
    const len = Math.hypot(be - ae, bn - an);
    return { x: (ae + be) / 2, y: (an + bn) / 2, t: [(be - ae) / len, (bn - an) / len], o: [(bn - an) / len, -(be - ae) / len], len, from: [ae, an] };
  };
  for (const b of features.buildings) {
    let mx = 0;
    let my = 0;
    for (const [x, y] of b.ring) { mx += x; my += y; }
    mx /= b.ring.length;
    my /= b.ring.length;
    if (mx < cx || mx >= cx + 1 || my < cy || my >= cy + 1) continue;

    let ring = b.ring.map(([x, y]) => [E(x), N(y)] as [number, number]);
    let area2 = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area2 += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    if (Math.abs(area2) < 4) continue; // under 2 m2: mapping noise
    if (area2 < 0) ring = ring.reverse(); // make counter-clockwise seen from above

    let lo = Infinity;
    let hi = -Infinity;
    for (const [x, y] of b.ring) {
      const g = ground(x, y);
      if (g < lo) lo = g;
      if (g > hi) hi = g;
    }
    const base = lo - 0.6; // sink slightly so no gap shows on slopes

    const h = hash32(b.id);
    const areaM2 = Math.abs(area2) / 2;
    if (b.parts?.length) {
      // Mapped in 3D: the building is its pieces, each from its own foot to its own top, and its
      // outline is not drawn. No door, porch or chimney: these are towers, halls and cathedrals.
      const mid = (lo + hi) / 2;
      for (const part of b.parts.slice(0, 240)) {
        if (partsDrawn >= 900) break;
        let outline = part.ring.map(([x, y]) => [E(x), N(y)] as XY);
        let part2 = 0;
        for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) part2 += outline[j][0] * outline[i][1] - outline[i][0] * outline[j][1];
        const partM2 = Math.abs(part2) / 2;
        if (partM2 < 0.3) continue;
        if (part2 < 0) outline = outline.reverse();
        partsDrawn++;
        const from = part.minHeight ?? 0;
        const tall = part.height - from;
        const width = Math.sqrt(partM2);
        // Somewhere with floors has windows; a mast, a spire, or anything that starts in mid-air does not.
        const plain = !part.storeys && (from > 0.5 || width < 7 || tall > 5 * width);
        const hex = part.colour ?? b.colour ?? style.big[(h >>> 4) % style.big.length];
        const brick = part.colour !== undefined ? part.brick : b.brick;
        const partWalls = sec(painted(plain ? MATERIALS.plain : brick ? MATERIALS.wall3 : h % 2 ? MATERIALS.wall1 : MATERIALS.wall2, hex));
        // A piece has the roof the map gives it, and a flat one otherwise.
        const partLook: RoofLook = { form: "pitched", maxPitched: 0, pitch: 1, eaves: 0.15 };
        const { minHeight: _from, colour: _colour, brick: _brick, storeys: _storeys, measured: _measured, roofOnly, ...roofed } = part;
        const rise = Math.min(tall, roofRise({ ...roofed, height: tall }, partM2, tall, partLook));
        // A height in metres is to the top of the roof; one counted in floors has the roof on top of it.
        const wallTop = mid + part.height - (part.measured ? rise : 0);
        const foot = from > 0.3 ? mid + from : base;
        if (wallTop - foot > 0.02 && !roofOnly) {
          for (let i = 0; i < outline.length; i++) {
            const [ae, an] = outline[i];
            const [be, bn] = outline[(i + 1) % outline.length];
            const len = Math.hypot(be - ae, bn - an);
            if (len < 0.01) continue;
            const ne = (bn - an) / len, nn = -(be - ae) / len;
            const v0 = partWalls.vert(ae, an, foot, ne, nn, 0);
            const v1 = partWalls.vert(be, bn, foot, ne, nn, 0);
            const v2 = partWalls.vert(be, bn, wallTop, ne, nn, 0);
            const v3 = partWalls.vert(ae, an, wallTop, ne, nn, 0);
            partWalls.tri(v0, v1, v2);
            partWalls.tri(v0, v2, v3);
          }
        }
        if (from > 0.3 && !roofOnly) {
          const tris = earcut(outline.flat());
          for (let i = 0; i < tris.length; i += 3) face(partWalls, [0, 1, 2].map((k) => [outline[tris[i + k]][0], outline[tris[i + k]][1], foot] as [number, number, number]), [0, 0, -1]);
        }
        const roofHex = part.roofColour ?? b.roofColour;
        const flatHex = roofHex ?? FLAT_ROOFS[(hash32(part.id) >>> 8) % FLAT_ROOFS.length];
        const pitchedSec = sec(roofIn(roofHex ?? hex));
        const flatSec = sec(roofHex !== undefined ? roofIn(flatHex) : painted(MATERIALS.roof0, flatHex));
        const marks = [pitchedSec, flatSec].map((s) => [s.count, s.idx.length]);
        // A roof and nothing else has no walls under it, not even those that would fill in below a slope:
        // they go to a section that is thrown away.
        addRoof(outline, wallTop, { ...roofed, height: tall, ...(rise > 0 ? { roofHeight: rise } : {}) }, partM2, Math.max(wallTop - foot, rise * 1.7, 0.1), partLook,
          roofOnly ? new Section(partWalls.mat) : partWalls, pitchedSec, flatSec, sec(MATERIALS.trim));
        if (roofOnly) {
          // Seen from below as well: the same surface again, turned over.
          [pitchedSec, flatSec].forEach((s, k) => {
            if (k === 1 && flatSec === pitchedSec) return;
            const [v0, i0] = marks[k];
            const v1 = s.count, i1 = s.idx.length;
            for (let v = v0; v < v1; v++) s.vert(s.pos[v * 3], s.pos[v * 3 + 1], s.pos[v * 3 + 2] - 0.05, -s.nrm[v * 3], -s.nrm[v * 3 + 1], -s.nrm[v * 3 + 2]);
            for (let i = i0; i < i1; i += 3) s.tri(s.idx[i] - v0 + v1, s.idx[i + 2] - v0 + v1, s.idx[i + 1] - v0 + v1);
          });
        }
      }
      // Its name goes on its front all the same, at the foot of the outline.
      const front = signs && b.name ? frontOf(ring) : null;
      if (front) signs!.push({ known: true, text: b.name!, x: front.x + front.o[0] * 0.1, y: front.y + front.o[1] * 0.1, z: ground(cx + front.x / S, cy - front.y / S) + 3.1, out: front.o, width: clamp(b.name!.length * 0.3 + 0.6, 1.6, Math.max(1.6, Math.min(front.len - 0.4, 9))) });
      continue;
    }
    const kind = b.kind ?? "";
    const barn = BARN_KINDS.test(kind);
    const plain = PLAIN_KINDS.test(kind);
    const dwelling = DWELLING_KINDS.test(kind);
    const homelyKind = areaM2 >= 35 && !barn && !plain;
    const tier = homelyKind ? crowding(mx, my) : 0;
    // A home nobody measured is not the tall default for any building. Standing apart it is one or
    // two storeys, and the smallest are bungalows. In a built-up street or a city centre it is as
    // tall as that part of the world builds them, though a narrow one stays lower. Each sits a
    // little differently so a street's eaves do not line up.
    let height = b.height;
    if (b.guessed && homelyKind) {
      const settle = ((h >>> 29) % 4) * 0.12;
      if (tier > 0 && dwelling) {
        const [fewest, most] = tier === 2 ? style.city : style.town;
        const storeys = Math.max(1, Math.min(2 + Math.floor(Math.sqrt(areaM2) / 3), fewest + ((h >>> 26) % (most - fewest + 1))));
        const tall = storeys <= 2 ? storeys * 3 - 0.15 + settle : storeys * 3.1 + 0.6 + settle;
        height = /^(apartments|hotel|dormitory)$/.test(kind) ? Math.max(b.height, tall) : tall;
      } else if (areaM2 < 400 && b.height < 13) {
        height = (areaM2 < 50 || (h >>> 26) % 5 < style.bungalows ? 1 : 2) * 3 - 0.15 + settle;
      }
    }
    const small = areaM2 < 400 && height < 13;
    const homely = small && homelyKind;
    /** Flats: somewhere people live that is too big or too tall to be a house. */
    const block = !homely && homelyKind && dwelling;
    const bricks = (h >>> 4) % 8 < (small ? style.brickShare : style.bigBrickShare) ? style.bricks : [];
    // The paint the map gives a building comes before any of ours.
    const wallHex = b.colour ?? (barn ? BARN_RED
      : bricks.length ? bricks[(h >>> 7) % bricks.length]
      : small ? style.paints[(h >>> 6) % style.paints.length]
      : style.big[(h >>> 4) % style.big.length]);
    const brick = b.colour !== undefined ? !!b.brick : bricks.length > 0 && !barn;
    const wallMat = painted(barn && b.colour === undefined ? MATERIALS.wall0 : brick ? MATERIALS.wall3 : small ? MATERIALS.wall0 : h % 2 ? MATERIALS.wall1 : MATERIALS.wall2, wallHex);
    const roofMat = b.roofColour !== undefined ? roofIn(b.roofColour) : barn ? painted(MATERIALS.roof0, BARN_ROOF) : roofIn(style.roofs[(h >>> 8) % style.roofs.length]);
    const flatMat = b.roofColour !== undefined ? roofIn(b.roofColour) : painted(MATERIALS.roof0, FLAT_ROOFS[(h >>> 8) % FLAT_ROOFS.length]);
    // Homes and flats take the roof their part of the world gives them; barns keep their gables, and
    // everything else (halls, schools, shops) is pitched when low and flat when not, unless roofs are flat here.
    const roofLook: RoofLook = barn ? { form: "pitched", maxPitched: 13, pitch: 1, eaves: 0.4 }
      : dwelling || small ? { form: tier === 2 ? style.cityRoof : tier === 1 ? style.townRoof : style.roof, maxPitched: tier > 0 ? 20 : 13, pitch: style.pitch, eaves: style.eaves }
      : { form: style.roof, maxPitched: 13, pitch: 1, eaves: style.eaves };
    // Courtyards, clockwise seen from above, so that their walls face into the yard.
    const holes: XY[][] = [];
    for (const yard of b.holes ?? []) {
      const hole = yard.map(([x, y]) => [E(x), N(y)] as XY);
      let yard2 = 0;
      for (let i = 0, j = hole.length - 1; i < hole.length; j = i++) yard2 += hole[j][0] * hole[i][1] - hole[i][0] * hole[j][1];
      if (Math.abs(yard2) < 8) continue; // under 4 m2
      holes.push(yard2 > 0 ? hole.reverse() : hole);
    }
    // A height mapped in metres is to the top of the roof: the walls stop short of it by what the roof rises.
    const rise = b.measured && !holes.length ? Math.min(height * 0.45, roofRise(b, areaM2, height, roofLook)) : 0;
    const wallHeight = height - rise;
    const roofed: Building = rise > 0 ? { ...b, roofHeight: rise } : b;
    const top = Math.max((lo + hi) / 2 + wallHeight, hi + 2.4);
    /** A building on legs, or bridging a street: it starts this far up. */
    const raised = b.minHeight !== undefined && (lo + hi) / 2 + b.minHeight < top - 1;
    const foot = raised ? (lo + hi) / 2 + b.minHeight! : base;
    const shell: Shell = { id: b.id, top, lo, hi, raised };
    shells?.push(shell);
    const walls = sec(wallMat);
    for (const outline of [ring, ...holes]) {
      for (let i = 0; i < outline.length; i++) {
        const [ae, an] = outline[i];
        const [be, bn] = outline[(i + 1) % outline.length];
        const de = be - ae;
        const dn = bn - an;
        const len = Math.hypot(de, dn);
        if (len < 0.01) continue;
        const ne = dn / len; // out of the building: outward on its counter-clockwise outline, into a clockwise yard
        const nn = -de / len;
        const v0 = walls.vert(ae, an, foot, ne, nn, 0);
        const v1 = walls.vert(be, bn, foot, ne, nn, 0);
        const v2 = walls.vert(be, bn, top, ne, nn, 0);
        const v3 = walls.vert(ae, an, top, ne, nn, 0);
        walls.tri(v0, v1, v2);
        walls.tri(v0, v2, v3);
      }
    }
    if (raised) {
      // Its underside, seen from the street below.
      const tris = earcut(ring.flat());
      for (let i = 0; i < tris.length; i += 3) face(walls, [0, 1, 2].map((k) => [ring[tris[i + k]][0], ring[tris[i + k]][1], foot] as [number, number, number]), [0, 0, -1]);
    }
    const ridge = addRoof(ring, top, roofed, areaM2, wallHeight, roofLook, walls, sec(roofMat), sec(flatMat), sec(MATERIALS.trim), holes);

    // A chimney astride the ridge of most houses, where houses have them, and on some city roofs.
    if (!crowded && ridge && (h >>> 16) % 5 < (homely ? style.chimneys : block && tier === 2 ? style.cityChimneys : 0)) {
      const across: XY = [-ridge.along[1], ridge.along[0]];
      box(sec(MATERIALS.chimney), ridge.x, ridge.y, ridge.along, across, -0.38, 0.38, -0.38, 0.38, ridge.z - 0.6, ridge.z + 1.0, true);
      box(sec(painted(MATERIALS.trim, 0x4f5560)), ridge.x, ridge.y, ridge.along, across, -0.46, 0.46, -0.46, 0.46, ridge.z + 1.0, ridge.z + 1.12, true, true);
    }

    // A front door on the wall that faces the street, with a step and, on some, a little porch.
    if (!raised && (homely || barn || (block && areaM2 < 700)) && top - lo > (barn ? 3.6 : 2.7)) {
      const wide = barn ? 1.7 : 0.72;
      let best = -1;
      let bestScore = Infinity;
      let bestGap = 0; // from the chosen wall to the edge of its road, when there is one
      for (let i = 0; i < ring.length; i++) {
        const [ae, an] = ring[i];
        const [be, bn] = ring[(i + 1) % ring.length];
        const len = Math.hypot(be - ae, bn - an);
        if (len < wide * 2 + 0.9) continue;
        const me = (ae + be) / 2, mn = (an + bn) / 2;
        const oe = (bn - an) / len, on = -(be - ae) / len;
        // The nearest road in front of this wall; failing any, the longest wall wins.
        let score = 1000 - len;
        let gap = 0;
        for (const [qe, qn, reach] of roadPoints) {
          const de = qe - me, dn = qn - mn;
          if (de * oe + dn * on <= 1) continue;
          const dist = Math.hypot(de, dn);
          if (dist < 90 && dist < score) { score = dist; gap = de * oe + dn * on - reach; }
        }
        if (score < bestScore) { bestScore = score; best = i; bestGap = gap; }
      }
      if (best >= 0) {
        const [ae, an] = ring[best];
        const [be, bn] = ring[(best + 1) % ring.length];
        const len = Math.hypot(be - ae, bn - an);
        const t: XY = [(be - ae) / len, (bn - an) / len];
        const o: XY = [(bn - an) / len, -(be - ae) / len];
        const at = clamp(len * (0.3 + ((h >>> 12) % 100) / 250), wide + 0.45, len - wide - 0.45);
        const x = ae + t[0] * at, y = an + t[1] * at;
        const g = ground(cx + x / S, cy - y / S);
        const trim = sec(MATERIALS.trim);
        if (barn) {
          // Barn doors: a wide white frame and two dark leaves.
          box(trim, x, y, t, o, -1.7, 1.7, 0, 0.1, g - 0.3, g + 3.2);
          const leaf = sec(painted(MATERIALS.door, 0x8f2a22));
          box(leaf, x, y, t, o, -1.5, -0.04, 0.1, 0.16, g + 0.02, g + 3.0);
          box(leaf, x, y, t, o, 0.04, 1.5, 0.1, 0.16, g + 0.02, g + 3.0);
        } else {
          const porch = !crowded && homely && (h >>> 21) % 2 === 0 && top - g > 3.4;
          shell.door = { x, y, along: t, out: o };
          // A house can be walked into. A plain four-square one gives the whole of itself to its
          // rooms; one of any other shape, or a very big one, the largest rectangle that fits
          // inside it behind the front door. The floor is level with the highest ground at its
          // walls, so no hillside comes up through it.
          if (homes && homely && !holes.length && hi - lo < HOME_SLOPE_M) {
            const outline = simplifyRing(ring);
            const side = (i: number): number => Math.hypot(outline[(i + 1) % 4][0] - outline[i][0], outline[(i + 1) % 4][1] - outline[i][1]);
            // (An outline that only looks like a rectangle once its small corners are smoothed off is not one.)
            const whole = isRectangle(outline) && Math.min(side(0), side(1)) >= HOME_MIN_M && Math.max(side(0), side(1)) <= HOME_MAX_M && liesInside(outline, ring);
            const corners = whole ? outline : roomInside(ring, x, y, t, o);
            // (A small shop, café, office or hotel opens like a house, but is not one inside: venues.ts.)
            const notHome = b.use === "shop" || b.use === "food" ? b.use : /^(office|government|civic|public)$/.test(kind) ? "office" : kind === "hotel" ? "hotel" : undefined;
            if (corners) homes.push({ id: b.id, corners, x, y, along: t, out: o, floor: hi + 0.06, height: top - hi, seed: h, wall: wallHex, porch, ...(notHome ? { use: notHome, ...(b.name ? { name: b.name } : {}) } : {}) });
          }
          box(trim, x, y, t, o, -0.72, 0.72, 0, 0.08, g - 0.3, g + 2.5);
          box(sec(painted(MATERIALS.door, style.doors[(h >>> 18) % style.doors.length])), x, y, t, o, -0.5, 0.5, 0.08, 0.14, g + 0.02, g + 2.12);
          if (!crowded) {
            box(sec(painted(MATERIALS.door, 0xe6c04a)), x, y, t, o, 0.3, 0.38, 0.14, 0.2, g + 1.0, g + 1.08, false, true);
            box(sec(painted(MATERIALS.trim, 0xcfc8b8)), x, y, t, o, -0.85, 0.85, 0, 0.55, g - 0.4, g + 0.12);
          }
          if (porch) {
            // A porch: a small roof over the door on two posts.
            box(sec(roofMat), x, y, t, o, -0.98, 0.98, 0, 1.0, g + 2.62, g + 2.76, false, true);
            box(trim, x, y, t, o, -0.9, -0.8, 0.82, 0.92, g - 0.4, g + 2.62, true);
            box(trim, x, y, t, o, 0.8, 0.9, 0.82, 0.92, g - 0.4, g + 2.62, true);
          }

          // A front garden: a path from the door to the street and, round most gardens, a hedge, a
          // white fence or a low wall (whichever the place favours) with a gap for the gate. Only
          // houses have one, and only where there is room before the road's edge.
          const depth = Math.min(bestGap - 0.4, 5.5);
          if (!crowded && homely && depth >= 2.2) {
            const at2 = (w: number, d: number): [number, number, number] => {
              const e = x + t[0] * w + o[0] * d, n = y + t[1] * w + o[1] * d;
              return [e, n, ground(cx + e / S, cy - n / S)];
            };
            const pathSec = sec(MATERIALS.path);
            const reach = Math.min(bestGap, depth + 1.5);
            let prev: number[] | null = null;
            for (let d = 0.55; d < reach + 0.01; d += Math.max(0.5, (reach - 0.55) / Math.ceil((reach - 0.55) / 2.5))) {
              const now: number[] = [];
              for (const w of [-0.5, 0.5]) {
                const [e, n, gz] = at2(w, d);
                const [ne, nn, nh] = groundNormal(cx + e / S, cy - n / S);
                now.push(pathSec.vert(e, n, gz + 0.07, ne, nn, nh));
              }
              if (prev) {
                pathSec.triUp(prev[0], prev[1], now[1]);
                pathSec.triUp(prev[0], now[1], now[0]);
              }
              prev = now;
            }

            const pick = (h >>> 23) % 8;
            const [hedges, fences, lowWalls] = style.garden;
            if (pick < hedges + fences + lowWalls) {
              const hedge = pick < hedges;
              const lowWall = pick >= hedges + fences;
              const part = sec(hedge ? MATERIALS.hedge : lowWall ? painted(MATERIALS.trim, wallHex) : MATERIALS.fence);
              const thick = hedge ? 0.28 : lowWall ? 0.11 : 0.04;
              const tall = hedge ? 1.05 : lowWall ? 0.9 : 0.95;
              const w0 = -at - 1.5, w1 = len - at + 1.5;
              // A piece stands only on open ground: not through a neighbour's house, not out in a road.
              const clear = (e: number, n: number): boolean => {
                for (const [qe, qn, r] of roadPoints) if (Math.hypot(qe - e, qn - n) < r + 0.3) return false;
                const wx = cx + e / S, wy = cy - n / S;
                for (const other of features.buildings) if (other !== b && pointInRing(wx, wy, other.ring)) return false;
                return true;
              };
              const run = (from: number, to: number, along: boolean, fixed: number): void => {
                const pieces = Math.max(1, Math.ceil(Math.abs(to - from) / 3));
                for (let k = 0; k < pieces; k++) {
                  const a = from + ((to - from) * k) / pieces, c = from + ((to - from) * (k + 1)) / pieces;
                  const [me, mn, gz] = along ? at2((a + c) / 2, fixed) : at2(fixed, (a + c) / 2);
                  if (!clear(me, mn)) continue;
                  if (along) box(part, x, y, t, o, a, c, fixed - thick, fixed + thick, gz - 0.4, gz + tall, true);
                  else box(part, x, y, t, o, fixed - thick, fixed + thick, a, c, gz - 0.4, gz + tall, true);
                }
              };
              run(w0, -0.8, true, depth);
              run(0.8, w1, true, depth);
              run(0.3, depth, false, w0);
              run(0.3, depth, false, w1);
            }
          }
        }
      }
    }

    // ---- what it is and what it is called, where the map says: a church has a tower, a shop a shopfront, and a name goes on a board
    if (!raised && (b.name || b.use) && areaM2 >= 12) {
      const front = frontOf(ring);
      if (front) {
        const { x, y, t, o, len, from: [ae, an] } = front;
        shell.front = { x, y, along: t, out: o };
        const g = ground(cx + x / S, cy - y / S);
        const room = top - g; // how much wall stands above the ground here
        let signZ = g + Math.min(3.1, room - 0.5);
        let signW = clamp((b.name?.length ?? 0) * 0.3 + 0.6, 1.6, Math.max(1.6, Math.min(len - 0.4, 9)));
        /** An eight-sided outline, counter-clockwise. */
        const round = (e: number, n: number, r: number): XY[] => Array.from({ length: 8 }, (_, k) => [e + r * Math.cos((k * Math.PI) / 4), n + r * Math.sin((k * Math.PI) / 4)] as XY);
        /** A turret or a tower: walls of the building's own paint from `from` up to `to`, and a roof of the given shape on top. */
        const turret = (outline: XY[], from: number, to: number, roof: string, rise: number): void => {
          for (let i = 0; i < outline.length; i++) {
            const [pe, pn] = outline[i];
            const [qe, qn] = outline[(i + 1) % outline.length];
            const side = Math.hypot(qe - pe, qn - pn) || 1;
            const ne = (qn - pn) / side, nn = -(qe - pe) / side;
            const v0 = walls.vert(pe, pn, from, ne, nn, 0);
            const v1 = walls.vert(qe, qn, from, ne, nn, 0);
            const v2 = walls.vert(qe, qn, to, ne, nn, 0);
            const v3 = walls.vert(pe, pn, to, ne, nn, 0);
            walls.tri(v0, v1, v2);
            walls.tri(v0, v2, v3);
          }
          let turret2 = 0;
          for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) turret2 += outline[j][0] * outline[i][1] - outline[i][0] * outline[j][1];
          addRoof(outline, to, { id: b.id, ring: b.ring, height: rise, roof, roofHeight: rise }, Math.abs(turret2) / 2, rise * 2, { form: "pitched", maxPitched: 0, pitch: 1, eaves: 0.2 }, walls, sec(roofMat), sec(roofMat), sec(MATERIALS.trim));
        };
        if ((b.use === "shop" || b.use === "food") && room > 3.7 && len >= 3.4) {
          // A shopfront: a big window, an awning over it, and room for the name on a board above.
          const span = Math.min(len - 0.6, 9);
          const awning = sec(painted(MATERIALS.trim, AWNINGS[(h >>> 9) % AWNINGS.length]));
          box(sec(painted(MATERIALS.door, 0x9fc3d6)), x, y, t, o, -span / 2 + 0.25, span / 2 - 0.25, 0, 0.07, g + 0.55, g + 2.3);
          box(awning, x, y, t, o, -span / 2, span / 2, 0, 1.15, g + 2.5, g + 2.62, false, true);
          box(awning, x, y, t, o, -span / 2, span / 2, 1.05, 1.15, g + 2.25, g + 2.5, true, true);
          signZ = g + 3.15;
          signW = Math.max(1.6, span - 0.6);
        } else if (b.use === "church" && areaM2 >= 60 && len >= 4.5) {
          // A square tower at the front, standing through the roof, with a spire.
          const side = clamp(Math.sqrt(areaM2) * 0.3, 3, Math.min(7, len - 1));
          const half = side / 2;
          const ce = x - o[0] * half, cn = y - o[1] * half;
          const corner = (a: number, c: number): XY => [ce + t[0] * a * half + o[0] * c * half, cn + t[1] * a * half + o[1] * c * half];
          turret([corner(-1, 1), corner(1, 1), corner(1, -1), corner(-1, -1)], base, top + Math.max(5, room * 0.7), "pyramidal", side * 1.7);
        } else if (b.use === "mosque" && areaM2 >= 60) {
          // A dome over the middle on a low drum, and a slim minaret at a front corner.
          const me = E(mx), mn = N(my);
          const r = clamp(Math.sqrt(areaM2) * 0.28, 2, 9);
          turret(round(me, mn, r), top - 0.3, top + 0.9, "dome", r * 0.95);
          if (len >= 5) turret(round(ae + t[0] * 1.3 - o[0] * 1.3, an + t[1] * 1.3 - o[1] * 1.3, 0.95), base, top + Math.max(7, room * 0.9), "cone", 2.6);
        } else if (b.use === "school" && len >= 4) {
          // A flagpole out in front.
          const pe = x + o[0] * 4, pn = y + o[1] * 4;
          const pg = ground(cx + pe / S, cy - pn / S);
          let clear = true;
          for (const [qe, qn, reach] of roadPoints) if (Math.hypot(qe - pe, qn - pn) < reach + 0.4) { clear = false; break; }
          if (clear) {
            box(sec(painted(MATERIALS.trim, 0xb9bec4)), x, y, t, o, -0.05, 0.05, 3.95, 4.05, pg - 0.3, pg + 7, true);
            box(sec(painted(MATERIALS.door, FLAGS[(h >>> 9) % FLAGS.length])), x, y, t, o, 0.05, 1.35, 3.98, 4.02, pg + 6.05, pg + 6.9, true, true);
          }
        } else if (b.use === "hospital" && room > 4.2 && len >= signW + 3.2) {
          // A white board with a red cross, beside the name.
          const at = -signW / 2 - 1.1;
          const cross = sec(painted(MATERIALS.door, 0xd0302a));
          box(sec(MATERIALS.trim), x, y, t, o, at - 0.6, at + 0.6, 0, 0.08, signZ - 0.6, signZ + 0.6);
          box(cross, x, y, t, o, at - 0.14, at + 0.14, 0.08, 0.12, signZ - 0.44, signZ + 0.44);
          box(cross, x, y, t, o, at - 0.44, at + 0.44, 0.08, 0.12, signZ - 0.14, signZ + 0.14);
        }
        if (signs && b.name && room > 2.6) signs.push({ text: b.name, x: x + o[0] * 0.1, y: y + o[1] * 0.1, z: signZ, out: o, width: signW, ...(b.use ? { known: true, use: b.use } : {}) });
      }
    }
  }

  // ---- trees: cones, for clients that ignore the labels route (both of ours plant their own trees from it)
  const trees = sec(MATERIALS.tree);
  for (const t of placeTrees(cx, cy, features, cls)) {
    const e = E(t.wx);
    const n = N(t.wy);
    const g = ground(t.wx, t.wy);
    const SIDES = 6;
    const slope = t.radius / t.height;
    const apex = trees.vert(e, n, g + t.height, 0, 0, 1);
    const first = trees.count;
    for (let k = 0; k < SIDES; k++) {
      const a = (k / SIDES) * Math.PI * 2;
      const len = Math.hypot(1, slope);
      trees.vert(e + Math.cos(a) * t.radius, n + Math.sin(a) * t.radius, g + 0.8, Math.cos(a) / len, Math.sin(a) / len, slope / len);
    }
    for (let k = 0; k < SIDES; k++) trees.tri(first + k, first + ((k + 1) % SIDES), apex);
  }

  if (signs && signs.length > SIGN_CAP) {
    const kept = [...signs.filter((s) => s.known), ...signs.filter((s) => !s.known)].slice(0, SIGN_CAP);
    signs.length = 0;
    signs.push(...kept);
  }
  return { sections: [...sections.values()].filter((s) => s.idx.length > 0).sort((a, b) => a.mat.id - b.mat.id || a.mat.color - b.mat.color), metersPerTile: S };
}

const homesMemo = new WeakMap<Features, Map<string, { homes: HomeDoor[]; signs: SignSpot[]; shells: Shell[] }>>();
/** What building a chunk's mesh finds out besides the mesh: its homes that can be walked into, and where its name signs go. Kept a while, since a chunk's labels and its houses' insides all ask. */
function foundIn(cx: number, cy: number, features: Features, elev: Elevation): { homes: HomeDoor[]; signs: SignSpot[]; shells: Shell[] } {
  let byChunk = homesMemo.get(features);
  if (!byChunk) homesMemo.set(features, (byChunk = new Map()));
  const key = `${cx}/${cy}`;
  let found = byChunk.get(key);
  if (!found) {
    found = { homes: [], signs: [], shells: [] };
    buildChunkMesh(cx, cy, features, elev, undefined, found.homes, found.signs, found.shells);
    byChunk.set(key, found);
    if (byChunk.size > 64) byChunk.delete(byChunk.keys().next().value!);
  }
  return found;
}
/** The homes of a chunk that can be walked into. */
export function homesOf(cx: number, cy: number, features: Features, elev: Elevation): HomeDoor[] {
  return foundIn(cx, cy, features, elev).homes;
}
/** What the mesh works out about each of a chunk's buildings (not those mapped in 3D). */
export function shellsOf(cx: number, cy: number, features: Features, elev: Elevation): Shell[] {
  return foundIn(cx, cy, features, elev).shells;
}
/** Where the name signs of a chunk's buildings go. */
export function signsOf(cx: number, cy: number, features: Features, elev: Elevation): SignSpot[] {
  return foundIn(cx, cy, features, elev).signs;
}

/** Serialises a chunk mesh to the EWC1 binary layout (docs/PROTOCOL.md). */
export function encodeChunk(cx: number, cy: number, mesh: ChunkMesh): Buffer {
  const S = mesh.metersPerTile;
  let size = 24;
  for (const s of mesh.sections) size += 20 + s.count * 24 + s.idx.length * 4;
  const buf = Buffer.alloc(size);
  let o = 0;
  const u32 = (v: number): void => { buf.writeUInt32LE(v >>> 0, o); o += 4; };
  const f32 = (v: number): void => { buf.writeFloatLE(v, o); o += 4; };
  u32(FORMAT_MAGIC);
  u32(FORMAT_VERSION);
  u32(cx);
  u32(cy);
  f32(S);
  u32(mesh.sections.length);
  for (const s of mesh.sections) {
    u32(s.mat.id);
    u32(s.mat.color);
    u32(s.mat.collision ? FLAG_COLLISION : 0);
    u32(s.count);
    u32(s.idx.length);
    for (let i = 0; i < s.pos.length; i += 3) {
      f32(s.pos[i] / S); // u: 0 at west edge, 1 at east edge
      f32(-s.pos[i + 1] / S); // v: 0 at north edge, 1 at south edge
      f32(s.pos[i + 2]); // metres above sea level
    }
    for (const v of s.nrm) f32(v); // east, north, up
    for (const v of s.idx) u32(v);
  }
  return buf;
}

/** Features for the data tile containing a chunk (data tiles are fetched with a margin, so border features are whole). */
/**
 * Given the heights of the ground as well (`elev`), the heights of the tile's bridges and tunnels are
 * worked out before it is handed back, which whatever builds a chunk's mesh from it needs (spans.ts).
 */
export async function featuresForChunk(cx: number, cy: number, load = loadFeatures, elev?: Elevation): Promise<Features> {
  const shift = CHUNK_Z - DATA_Z;
  const dx = cx >> shift;
  const dy = cy >> shift;
  const features = await load(dx, dy);
  if (elev) await prepareSpans(dx, dy, features, elev, load);
  return features;
}

export async function generateChunk(cx: number, cy: number, elev: Elevation, load = loadFeatures): Promise<Buffer> {
  const features = await featuresForChunk(cx, cy, load, elev);
  await elev.ensure(cx - 0.5, cy - 0.5, cx + 1.5, cy + 1.5);
  return encodeChunk(cx, cy, buildChunkMesh(cx, cy, features, elev));
}
