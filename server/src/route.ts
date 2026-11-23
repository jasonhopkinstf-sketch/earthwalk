// The way along the roads from one place to another nearby: for a car that has been asked to take
// its rider somewhere. The roads are the same map data the world is built from, so a route only
// reaches as far as a few data tiles; beyond that the caller does without one.

import { CHUNK_Z, latToY, lonToX, metersPerTile, xToLon, yToLat } from "./geo.ts";
import { DATA_Z, loadFeatures, type Features } from "./osm.ts";

/** As the crow flies, the furthest a route is looked for; and the most data tiles it may need. */
export const ROUTE_MAX_M = 2500;
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

export interface Route { path: [number, number][]; metres: number }

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
 */
export async function planRoute(fromLat: number, fromLon: number, toLat: number, toLon: number, load: (dx: number, dy: number) => Promise<Features> = loadFeatures): Promise<Route | null> {
  const fx = lonToX(fromLon), fy = latToY(fromLat), tx = lonToX(toLon), ty = latToY(toLat);
  const S = metersPerTile((fy + ty) / 2, CHUNK_Z);
  if (Math.hypot(tx - fx, ty - fy) * S > ROUTE_MAX_M) return null;
  const shift = CHUNK_Z - DATA_Z;
  const pad = 250 / S;
  const dx0 = Math.floor(Math.min(fx, tx) - pad) >> shift, dx1 = Math.floor(Math.max(fx, tx) + pad) >> shift;
  const dy0 = Math.floor(Math.min(fy, ty) - pad) >> shift, dy1 = Math.floor(Math.max(fy, ty) + pad) >> shift;
  if ((dx1 - dx0 + 1) * (dy1 - dy0 + 1) > TILE_CAP) return null;
  const tiles: Promise<Features>[] = [];
  for (let dy = dy0; dy <= dy1; dy++) for (let dx = dx0; dx <= dx1; dx++) tiles.push(load(dx, dy));

  // Roads meet where they share a point, and a road that crosses two tiles is in both: points are
  // told apart by where they are, so the pieces join up.
  const ids = new Map<string, number>();
  const xs: number[] = [], ys: number[] = [];
  const next: [number, number][][] = []; // node -> [neighbour, metres as the route counts them]
  const street: boolean[] = []; // node -> a proper street runs through it
  const node = (x: number, y: number): number => {
    const key = `${x},${y}`;
    let id = ids.get(key);
    if (id === undefined) { ids.set(key, (id = xs.length)); xs.push(x); ys.push(y); next.push([]); street.push(false); }
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
        const m = Math.hypot(xs[b] - xs[a], ys[b] - ys[a]) * S * (lane ? LANE_COST : 1);
        if (a === b || m === 0) continue;
        next[a].push([b, m]);
        next[b].push([a, m]);
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
  const starts = nearestIn(fx, fy), ends = nearestIn(tx, ty);
  let start = -1, end = -1, least = Infinity;
  for (const [net, [node0, d0]] of starts) {
    const there = ends.get(net);
    if (there && d0 + there[1] < least) { least = d0 + there[1]; start = node0; end = there[0]; }
  }
  if (start < 0 || end < 0 || start === end) return null;

  const cost = new Float64Array(xs.length).fill(Infinity);
  const from = new Int32Array(xs.length).fill(-1);
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
  if (!Number.isFinite(cost[end])) return null;
  const nodes: number[] = [];
  for (let n = end; n >= 0; n = from[n]) nodes.push(n);
  nodes.reverse();

  // A point every 8 m or so along the way, so a client can follow it without knowing the roads.
  const path: [number, number][] = [];
  const add = (x: number, y: number): void => { path.push([+yToLat(y).toFixed(6), +xToLon(x).toFixed(6)]); };
  add(xs[nodes[0]], ys[nodes[0]]);
  let metres = 0;
  for (let i = 1; i < nodes.length; i++) metres += Math.hypot(xs[nodes[i]] - xs[nodes[i - 1]], ys[nodes[i]] - ys[nodes[i - 1]]) * S;
  const spacing = Math.max(8, metres / POINT_CAP);
  for (let i = 1; i < nodes.length; i++) {
    const ax = xs[nodes[i - 1]], ay = ys[nodes[i - 1]], bx = xs[nodes[i]], by = ys[nodes[i]];
    const steps = Math.max(1, Math.round((Math.hypot(bx - ax, by - ay) * S) / spacing));
    for (let k = 1; k <= steps; k++) add(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps);
  }
  return { path, metres: Math.round(metres) };
}
