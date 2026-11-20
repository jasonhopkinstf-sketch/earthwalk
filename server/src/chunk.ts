// Builds one world chunk (a zoom-16 map tile, roughly 400-600 m across) into
// ready-to-render triangle meshes. The game client only uploads these buffers,
// so all world-generation logic lives (and is tested) here.
//
// Geometry is built in chunk-local metres: e = east, n = north, h = height above
// sea level, origin at the chunk's north-west corner. See docs/PROTOCOL.md for
// the binary layout and the coordinate conventions.

import earcut from "earcut";
import { CHUNK_Z, hash32, metersPerTile } from "./geo.ts";
import { Elevation, GRID } from "./elevation.ts";
import { type Building, DATA_Z, loadFeatures, type Features, type GroundClass, type Pt, type Road } from "./osm.ts";

export const FORMAT_MAGIC = 0x31435745; // "EWC1" little-endian
export const FORMAT_VERSION = 1;
/** Bump when generated geometry changes, so cached chunks are rebuilt. */
export const GENERATOR_REV = 6;
export const FLAG_COLLISION = 1;

interface MaterialDef { id: number; color: number; collision: boolean }
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
  road: { id: 10, color: rgb(0x4a4a4e), collision: false },
  path: { id: 11, color: rgb(0xc9b28a), collision: false },
  rail: { id: 12, color: rgb(0x5b4a3f), collision: false },
  stream: { id: 13, color: rgb(0x3f7fb5), collision: false },
  wall0: { id: 20, color: rgb(0xd9cdb8), collision: true },
  wall1: { id: 21, color: rgb(0xc4a48a), collision: true },
  wall2: { id: 22, color: rgb(0xb9bec4), collision: true },
  wall3: { id: 23, color: rgb(0xa9553f), collision: true },
  roof0: { id: 24, color: rgb(0x6e6a66), collision: true },
  roof1: { id: 25, color: rgb(0x8f4a3a), collision: true },
  tree: { id: 30, color: rgb(0x2f6b2f), collision: false },
} satisfies Record<string, MaterialDef>;

const GROUND_ORDER: GroundClass[] = ["urban", "farm", "grass", "forest", "sand", "rock", "paved", "water"]; // later wins
const WALLS = [MATERIALS.wall0, MATERIALS.wall1, MATERIALS.wall2, MATERIALS.wall3];
const ROOFS = [MATERIALS.roof0, MATERIALS.roof1];

class Section {
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

/** Where trees stand: mapped single trees, plus scattered ones in forests and (sparsely) on grass. */
export function placeTrees(cx: number, cy: number, features: Features, cls: Uint8Array): TreeSpot[] {
  const out: TreeSpot[] = [];
  const footprintBoxes = features.buildings.map((b) => ({ b, box: inBox(b.ring, cx, cy) })).filter((x) => x.box);
  const insideBuilding = (wx: number, wy: number): boolean =>
    footprintBoxes.some(({ b, box }) => wx >= box![0] && wx <= box![2] && wy >= box![1] && wy <= box![3] && pointInRing(wx, wy, b.ring));
  const add = (wx: number, wy: number, seed: number, conifer: boolean): void => {
    out.push({ wx, wy, seed, height: 6 + (seed % 700) / 100, radius: 1.6 + ((seed >>> 10) % 160) / 100, conifer });
  };
  for (const t of features.trees) {
    if (t.at[0] >= cx && t.at[0] < cx + 1 && t.at[1] >= cy && t.at[1] < cy + 1) add(t.at[0], t.at[1], hash32(t.id), false);
  }
  const forestCls = GROUND_ORDER.indexOf("forest") + 1;
  const grassCls = GROUND_ORDER.indexOf("grass") + 1;
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const c = cls[j * GRID + i];
      if (c !== forestCls && c !== grassCls) continue;
      const seed = hash32(cx * GRID + i, cy * GRID + j);
      if (c === grassCls && seed % 9 !== 0) continue;
      const wx = cx + (i + 0.15 + ((seed >>> 4) % 70) / 100) / GRID;
      const wy = cy + (j + 0.15 + ((seed >>> 12) % 70) / 100) / GRID;
      if (!insideBuilding(wx, wy)) add(wx, wy, seed >>> 3, c === forestCls && (seed >>> 20) % 5 < 2);
    }
  }
  return out;
}

type XY = [number, number];
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

/**
 * Roofs: a gable on rectangular houses, a hip on other small convex ones, and on L-shaped and other
 * mid-sized low buildings a hip that follows the outline (sloping in from every wall to a flat strip
 * along the middle). Flat on everything else and whenever OSM says flat: big or tall buildings stay
 * flat unless OSM says otherwise.
 */
function addRoof(ring: XY[], top: number, b: Building, areaM2: number, walls: Section, roof: Section): void {
  const shape = b.roof ?? "";
  const pitched = !/^(flat|skillion)$/.test(shape) &&
    (/gabled|hipped|pyramidal|gambrel|mansard|round|half-hipped/.test(shape) || (areaM2 < 1500 && b.height < 13));
  const simple = pitched ? simplifyRing(ring) : [];
  if (areaM2 < 400 && simple.length >= 3 && simple.length <= 8 && isConvex(simple)) {
    const rise = Math.min(b.height * 0.8, b.roofHeight ?? clamp(0.35 * Math.sqrt(areaM2), 1.8, 5));
    if (isRectangle(simple)) {
      // Ridge along the longer sides.
      const [p0, p1, p2, p3] = simple;
      const long = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) >= Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      const [a, b2, c, d] = long ? [p0, p1, p2, p3] : [p1, p2, p3, p0];
      const r0: [number, number, number] = [(d[0] + a[0]) / 2, (d[1] + a[1]) / 2, top + rise];
      const r1: [number, number, number] = [(b2[0] + c[0]) / 2, (b2[1] + c[1]) / 2, top + rise];
      slopeFace(roof, [[a[0], a[1], top], [b2[0], b2[1], top], r1, r0]);
      slopeFace(roof, [[c[0], c[1], top], [d[0], d[1], top], r0, r1]);
      gableEnd(walls, b2, c, top, r1);
      gableEnd(walls, d, a, top, r0);
      return;
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
    return;
  }
  if (simple.length >= 4 && simple.length <= 24) {
    // Any other outline: slope in from every wall as far as the shape allows, leaving a flat strip on top.
    for (const d of [4.5, 3.5, 2.6, 1.8]) {
      const inner = insetRing(simple, d);
      if (!inner) continue;
      const rise = Math.min(b.height * 0.8, b.roofHeight ?? d * 0.7);
      for (let i = 0; i < simple.length; i++) {
        const j = (i + 1) % simple.length;
        slopeFace(roof, [[simple[i][0], simple[i][1], top], [simple[j][0], simple[j][1], top], [inner[j][0], inner[j][1], top + rise], [inner[i][0], inner[i][1], top + rise]]);
      }
      const first = roof.count;
      for (const [e, n] of inner) roof.vert(e, n, top + rise, 0, 0, 1);
      const tris = earcut(inner.flat());
      for (let i = 0; i < tris.length; i += 3) roof.triUp(first + tris[i], first + tris[i + 1], first + tris[i + 2]);
      return;
    }
  }
  const first = roof.count;
  for (const [e, n] of ring) roof.vert(e, n, top, 0, 0, 1);
  const tris = earcut(ring.flat());
  for (let i = 0; i < tris.length; i += 3) roof.triUp(first + tris[i], first + tris[i + 1], first + tris[i + 2]);
}

export function buildChunkMesh(cx: number, cy: number, features: Features, elev: Elevation): ChunkMesh {
  const S = metersPerTile(cy + 0.5, CHUNK_Z);
  const sections = new Map<number, Section>();
  const sec = (m: MaterialDef): Section => {
    let s = sections.get(m.id);
    if (!s) sections.set(m.id, (s = new Section(m)));
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
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const c = cls[j * GRID + i];
      const s = sec(c === 0 ? MATERIALS.ground : MATERIALS[GROUND_ORDER[c - 1]]);
      const a = terrainVert(s, i, j);
      const b = terrainVert(s, i + 1, j);
      const d = terrainVert(s, i, j + 1);
      const e = terrainVert(s, i + 1, j + 1);
      // Diagonal a-e; must match Elevation.surfaceHeight.
      s.triUp(a, e, b);
      s.triUp(a, d, e);
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
      }
    }
  };
  for (const road of features.roads) ribbon(road);

  // ---- buildings: extruded footprints, owned by the chunk containing their centroid
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
    const top = Math.max((lo + hi) / 2 + b.height, hi + 2.4);

    const h = hash32(b.id);
    const walls = sec(WALLS[h % WALLS.length]);
    for (let i = 0; i < ring.length; i++) {
      const [ae, an] = ring[i];
      const [be, bn] = ring[(i + 1) % ring.length];
      const de = be - ae;
      const dn = bn - an;
      const len = Math.hypot(de, dn);
      if (len < 0.01) continue;
      const ne = dn / len; // outward normal of a counter-clockwise ring
      const nn = -de / len;
      const v0 = walls.vert(ae, an, base, ne, nn, 0);
      const v1 = walls.vert(be, bn, base, ne, nn, 0);
      const v2 = walls.vert(be, bn, top, ne, nn, 0);
      const v3 = walls.vert(ae, an, top, ne, nn, 0);
      walls.tri(v0, v1, v2);
      walls.tri(v0, v2, v3);
    }
    addRoof(ring, top, b, Math.abs(area2) / 2, walls, sec(ROOFS[(h >>> 8) % ROOFS.length]));
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

  return { sections: [...sections.values()].filter((s) => s.idx.length > 0).sort((a, b) => a.mat.id - b.mat.id), metersPerTile: S };
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
export async function featuresForChunk(cx: number, cy: number, load = loadFeatures): Promise<Features> {
  const shift = CHUNK_Z - DATA_Z;
  const dx = cx >> shift;
  const dy = cy >> shift;
  return load(dx, dy);
}

export async function generateChunk(cx: number, cy: number, elev: Elevation, load = loadFeatures): Promise<Buffer> {
  const features = await featuresForChunk(cx, cy, load);
  await elev.ensure(cx - 0.5, cy - 0.5, cx + 1.5, cy + 1.5);
  return encodeChunk(cx, cy, buildChunkMesh(cx, cy, features, elev));
}
