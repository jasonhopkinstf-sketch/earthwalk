// The way along the roads from one place to another nearby: for a car that has been asked to take
// its rider somewhere. The roads are the same map data the world is built from, so a route only
// reaches as far as a few data tiles; beyond that the caller does without one.

import { CHUNK_Z, latToY, lonToX, metersPerTile, xToLon, yToLat } from "./geo.ts";
import { DATA_Z, loadFeatures, type Features } from "./osm.ts";

/** As the crow flies, the furthest a route is looked for in one go; and the most data tiles it may need. */
export const ROUTE_MAX_M = 2500;
/**
 * A drive to somewhere farther off than that is made in legs, as far as this. A leg is the way by road
 * to the point nearest the place that the roads round the car reach: the map for the whole way is never
 * wanted at once, only what the world is about to show anyway. Beyond this nobody is driven.
 */
export const ROUTE_FAR_M = 10_000;
/** How far towards the place a leg looks for roads; and how much nearer the place it must end to be worth driving. */
const LEG_M = 2200;
const LEG_GAIN_M = 400;
/** A leg would sooner end on a main road than up a side street this much nearer the place. */
const MAIN_PULL_M = 250;
const isMain = (hw: string | undefined): boolean => /^(motorway|trunk|primary|secondary|tertiary)(_link)?$/.test(hw ?? "");
const TILE_CAP = 12;
/** A start or an end must be this near a road. */
const SNAP_M = 200;
const POINT_CAP = 500;
/**
 * Driveways, car park aisles and pedestrian streets are lanes: a car uses one when it must, but a
 * route starts and ends on a proper street when there is one this much farther off, and a metre of
 * lane counts as this many of street. A driveway ends beside a house, often under its carport, and a
 * car that starts there meets the wall.
 */
const LANE_SHY_M = 80;
const LANE_COST = 2.5;
const isLane = (hw: string | undefined): boolean => hw === "service" || hw === "pedestrian";

/**
 * `widths`: how wide the road is at each point of `path`, in metres (for keeping to a lane; not sent to anybody).
 * `more`: this is a leg of a long drive: it ends on the way to the place, not at it.
 */
export interface Route { path: [number, number][]; metres: number; widths?: number[]; more?: boolean }

/** A car keeps this far from the kerb at the least, and a lane is never wider than this from the middle of the road. */
const KERB_CLEAR_M = 0.95;
const LANE_MOST_M = 2.4;

/**
 * The way a car drives a route: not down the middle of the road, which is what a route is, but on its
 * own side of it, the left where the country drives on the left. Each point moves sideways by a quarter
 * of the road's width (less on a road too narrow for two cars to pass), eased where the width changes.
 */
export function laned(route: Route, left: boolean): [number, number][] {
  const n = route.path.length;
  if (n < 2) return route.path;
  const [lat0, lon0] = route.path[0];
  const mLat = 111_320, mLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const east = route.path.map(([, lon]) => (lon - lon0) * mLon), north = route.path.map(([lat]) => (lat - lat0) * mLat);
  const lane = (i: number): number => {
    const w = route.widths?.[i] ?? 6;
    return Math.max(0, Math.min(w / 4, w / 2 - KERB_CLEAR_M, LANE_MOST_M));
  };
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
    const de = east[b] - east[a], dn = north[b] - north[a];
    const len = Math.hypot(de, dn);
    if (len < 1e-6) { out.push(route.path[i]); continue; }
    let over = 0, count = 0;
    for (let k = Math.max(0, i - 3); k <= Math.min(n - 1, i + 3); k++) { over += lane(k); count++; }
    over = (over / count) * (left ? -1 : 1);
    // To the right of the way it is going: east of a car heading north.
    out.push([+(lat0 + (north[i] - (de / len) * over) / mLat).toFixed(6), +(lon0 + (east[i] + (dn / len) * over) / mLon).toFixed(6)]);
  }
  return out;
}

/** A small binary heap of [cost, node]. */
class Heap {
  private readonly a: [number, number][] = [];
  get size(): number { return this.a.length; }
  push(v: [number, number]): void {
    const a = this.a;
    a.push(v);
    for (let i = a.length - 1; i > 0; ) {
      const up = (i - 1) >> 1;
      if (a[up][0] <= a[i][0]) break;
      [a[up], a[i]] = [a[i], a[up]];
      i = up;
    }
  }
  pop(): [number, number] {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1, r = l + 1;
        let least = i;
        if (l < a.length && a[l][0] < a[least][0]) least = l;
        if (r < a.length && a[r][0] < a[least][0]) least = r;
        if (least === i) break;
        [a[least], a[i]] = [a[i], a[least]];
        i = least;
      }
    }
    return top;
  }
}

/**
 * The shortest way by road between two positions, as latitude and longitude points a few metres
 * apart, or null when they are too far apart, not near roads, or not joined by roads this server
 * can see. One-way streets are driven either way: nobody is hurt and the car gets there.
 *
 * `far`: a place farther off than ROUTE_MAX_M (and no farther than ROUTE_FAR_M) is not given up on:
 * the answer is then the first leg of the drive (`more`), and the next is asked for from where it ends.
 */
export async function planRoute(fromLat: number, fromLon: number, toLat: number, toLon: number, load: (dx: number, dy: number) => Promise<Features> = loadFeatures, far = false): Promise<Route | null> {
  const fx = lonToX(fromLon), fy = latToY(fromLat), tx = lonToX(toLon), ty = latToY(toLat);
  const S = metersPerTile((fy + ty) / 2, CHUNK_Z);
  const crow = Math.hypot(tx - fx, ty - fy) * S;
  const leg = crow > ROUTE_MAX_M;
  if (leg && (!far || crow > ROUTE_FAR_M)) return null;
  // A leg looks for roads only as far as a point on the way to the place.
  const ax = leg ? fx + ((tx - fx) * LEG_M) / crow : tx, ay = leg ? fy + ((ty - fy) * LEG_M) / crow : ty;
  const shift = CHUNK_Z - DATA_Z;
  const pad = 250 / S;
  const dx0 = Math.floor(Math.min(fx, ax) - pad) >> shift, dx1 = Math.floor(Math.max(fx, ax) + pad) >> shift;
  const dy0 = Math.floor(Math.min(fy, ay) - pad) >> shift, dy1 = Math.floor(Math.max(fy, ay) + pad) >> shift;
  if ((dx1 - dx0 + 1) * (dy1 - dy0 + 1) > TILE_CAP) return null;
  const tiles: Promise<Features>[] = [];
  for (let dy = dy0; dy <= dy1; dy++) for (let dx = dx0; dx <= dx1; dx++) tiles.push(load(dx, dy));

  // Roads meet where they share a point, and a road that crosses two tiles is in both: points are
  // told apart by where they are, so the pieces join up.
  const ids = new Map<string, number>();
  const xs: number[] = [], ys: number[] = [];
  const next: [number, number, number][][] = []; // node -> [neighbour, metres as the route counts them, the road's width]
  const street: boolean[] = []; // node -> a proper street runs through it
  const main: boolean[] = []; // node -> a main road does
  const node = (x: number, y: number): number => {
    const key = `${x},${y}`;
    let id = ids.get(key);
    if (id === undefined) { ids.set(key, (id = xs.length)); xs.push(x); ys.push(y); next.push([]); street.push(false); main.push(false); }
    return id;
  };
  const seen = new Set<number>();
  for (const f of await Promise.all(tiles)) {
    // (Tunnels are kept apart from the other roads, and are roads like any other to a car.)
    for (const road of [...f.roads, ...(f.tunnels ?? [])]) {
      // Every street counts, pedestrian ones too: an old town centre is otherwise cut off from the rest.
      if (road.cls !== "road" || seen.has(road.id)) continue;
      seen.add(road.id);
      const lane = isLane(road.hw);
      for (let i = 0; i + 1 < road.pts.length; i++) {
        const a = node(road.pts[i][0], road.pts[i][1]), b = node(road.pts[i + 1][0], road.pts[i + 1][1]);
        if (!lane) street[a] = street[b] = true;
        if (isMain(road.hw)) main[a] = main[b] = true;
        const m = Math.hypot(xs[b] - xs[a], ys[b] - ys[a]) * S * (lane ? LANE_COST : 1);
        if (a === b || m === 0) continue;
        next[a].push([b, m, road.width]);
        next[b].push([a, m, road.width]);
      }
    }
  }
  // Streets that join up form a network, and a map has many: the town's, a car park's, a bus bay's.
  // The route runs in whichever network comes nearest to both ends, not simply from the nearest
  // point to the nearest point, which are often on a scrap that leads nowhere.
  const network = new Int32Array(xs.length).fill(-1);
  let networks = 0;
  for (let i = 0; i < xs.length; i++) {
    if (network[i] >= 0) continue;
    const stack = [i];
    network[i] = networks;
    while (stack.length) {
      const n = stack.pop()!;
      for (const [m] of next[n]) if (network[m] < 0) { network[m] = networks; stack.push(m); }
    }
    networks++;
  }
  /**
   * For each network, its point nearest a position (and how far, in tile units), when within reach.
   * A point on a lane counts as farther off than it is, so that a street nearby is chosen first.
   */
  const nearestIn = (x: number, y: number): Map<number, [number, number]> => {
    const out = new Map<number, [number, number]>();
    for (let i = 0; i < xs.length; i++) {
      const near = Math.hypot(xs[i] - x, ys[i] - y);
      if (near > SNAP_M / S) continue;
      const d = near + (street[i] ? 0 : LANE_SHY_M / S);
      const had = out.get(network[i]);
      if (!had || d < had[1]) out.set(network[i], [i, d]);
    }
    return out;
  };
  const starts = nearestIn(fx, fy);
  const cost = new Float64Array(xs.length);
  const from = new Int32Array(xs.length);
  /** The cheapest way from a point to every other it reaches, or only as far as `end`. */
  const spread = (start: number, end: number): void => {
    cost.fill(Infinity);
    from.fill(-1);
    const heap = new Heap();
    cost[start] = 0;
    heap.push([0, start]);
    while (heap.size) {
      const [c, n] = heap.pop();
      if (c > cost[n]) continue;
      if (n === end) break;
      for (const [m, len] of next[n]) {
        if (c + len < cost[m]) { cost[m] = c + len; from[m] = n; heap.push([c + len, m]); }
      }
    }
  };
  let start = -1, end = -1;
  if (leg) {
    // Whichever of the networks beside the car gets nearest the place: the roads of a car park get nowhere.
    let best = Infinity;
    for (const [node0, d0] of [...starts.values()].sort((a, b) => a[1] - b[1]).slice(0, 4)) {
      spread(node0, -1);
      for (let i = 0; i < xs.length; i++) {
        if (!street[i] || !Number.isFinite(cost[i])) continue;
        const left = Math.hypot(tx - xs[i], ty - ys[i]) * S;
        const score = left - (main[i] ? MAIN_PULL_M : 0) + d0 * S;
        if (score < best && crow - left >= LEG_GAIN_M) { best = score; start = node0; end = i; }
      }
    }
    if (end < 0) return null;
    spread(start, end);
  } else {
    const ends = nearestIn(tx, ty);
    let least = Infinity;
    for (const [net, [node0, d0]] of starts) {
      const there = ends.get(net);
      if (there && d0 + there[1] < least) { least = d0 + there[1]; start = node0; end = there[0]; }
    }
    if (start < 0 || end < 0 || start === end) return null;
    spread(start, end);
  }
  if (!Number.isFinite(cost[end])) return null;
  const nodes: number[] = [];
  for (let n = end; n >= 0; n = from[n]) nodes.push(n);
  nodes.reverse();

  // A point every 8 m or so along the way, so a client can follow it without knowing the roads.
  const path: [number, number][] = [];
  const widths: number[] = [];
  /** The road between two neighbours on the way: the one the route counted, the cheapest. */
  const widthOf = (a: number, b: number): number => {
    let best = 6, least = Infinity;
    for (const [m, len, w] of next[a]) if (m === b && len < least) { least = len; best = w; }
    return best;
  };
  let wide = nodes.length > 1 ? widthOf(nodes[0], nodes[1]) : 6;
  const add = (x: number, y: number): void => { path.push([+yToLat(y).toFixed(6), +xToLon(x).toFixed(6)]); widths.push(wide); };
  add(xs[nodes[0]], ys[nodes[0]]);
  let metres = 0;
  for (let i = 1; i < nodes.length; i++) metres += Math.hypot(xs[nodes[i]] - xs[nodes[i - 1]], ys[nodes[i]] - ys[nodes[i - 1]]) * S;
  const spacing = Math.max(8, metres / POINT_CAP);
  for (let i = 1; i < nodes.length; i++) {
    const ax = xs[nodes[i - 1]], ay = ys[nodes[i - 1]], bx = xs[nodes[i]], by = ys[nodes[i]];
    const steps = Math.max(1, Math.round((Math.hypot(bx - ax, by - ay) * S) / spacing));
    wide = widthOf(nodes[i - 1], nodes[i]);
    for (let k = 1; k <= steps; k++) add(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps);
  }
  return { path, metres: Math.round(metres), widths, ...(leg ? { more: true } : {}) };
}
