// Bridges and tunnels: where a road, a path or a railway leaves the ground, and how high it is there.
//
// The map says which stretches are bridges and which are tunnels, and which of two that cross is on
// top (`layer`), but hardly ever how high anything is. So heights are worked out here:
//
// - A bridge starts and ends on the ground. Between its ends it runs straight from the one height to
//   the other, a little arched, and far more so over the sea, where ships pass. Where a road, a
//   railway, a path or a river goes under it, it is lifted to clear that, and climbs to there no
//   steeper than a road may. What is left over at an end is passed on to the roads that meet it there
//   (`ramps`): they rise to it on a ramp.
// - A tunnel starts at the ground at each mouth and runs straight between its mouths, or dives under
//   the ground where the ground is not far enough above it, no steeper than a road may.
//
// Everything is worked out for whole runs of bridge (or tunnel) joined end to end, however many pieces
// of the map they cross, so that every piece of the world draws the same bridge at the same height.

import { CHUNK_Z, metersPerTile } from "./geo.ts";
import type { Elevation } from "./elevation.ts";
import { DATA_MARGIN, DATA_Z, loadFeatures, type Features, type Pt, type Road, type RoadClass } from "./osm.ts";

/** One stretch of bridge or tunnel, as the map draws it. */
export interface SpanWay {
  id: number; kind: "bridge" | "tunnel"; cls: RoadClass; width: number; layer: number; hw?: string; form?: string; oneway?: boolean; name?: string;
  pts: Pt[];
}
/** Something that passes under a bridge without meeting it: what it is, the room it needs (`clear`) and half its width, in metres; `span` when it is itself a bridge. */
export interface Crossing { way: number; at: Pt; other: number; cls: RoadClass; span: boolean; clear: number; half: number }
/** What one piece of the map knows about the stretches that leave the ground in and round it. */
export interface SpanKit {
  ways: SpanWay[];
  crossings: Crossing[];
  /** The points ("x,y") where a way on the ground meets a stretch that leaves it. */
  ground: Set<string>;
}

/** How an end of a stretch finishes: on another stretch of the same run, on the ground (a tunnel's mouth), or nowhere (a wall). */
export type SpanEnd = "joined" | "ground" | "blind";
/** A stretch with its heights: a point every few metres, how far along each is in metres, and the height of the surface there. */
export interface Profile {
  way: SpanWay;
  pts: Pt[];
  d: number[];
  h: number[];
  /** The ground at each point. */
  g: number[];
  ends: [SpanEnd, SpanEnd];
  /** Bridges: how many metres of it are over the sea, and how long its whole run is from ground to ground. */
  sea: number; run: number;
  /** Which run it is part of: the least id of the stretches joined into it. */
  runOf: number;
  /** Bridges: true when the run is one line from ground to ground (no forks), which is what `along` needs. */
  simple: boolean;
  /** Bridges: how far each point is, in metres along the run, from the start of the run (the end nearer the west). */
  along: number[];
}
export interface Spans {
  profiles: Map<number, Profile>;
  crossings: Crossing[];
  /** Where a way on the ground meets a bridge that is above the ground there: the point ("x,y"), how high above, and how steep the ramp down may be. */
  lifts: Map<string, { lift: number; slope: number }>;
}

/** A point of a stretch every so many metres at most. */
export const SPAN_STEP_M = 8;
/** Room under a bridge, in metres: for a road, a railway, a path. */
const CLEAR: Record<RoadClass, number> = { road: 5.2, rail: 6, path: 3, stream: 1 };
/** The thickness of a bridge's deck. */
export const deckDepth = (way: Pick<SpanWay, "cls" | "width">): number => (way.cls === "path" ? 0.45 : way.cls === "rail" ? 1.1 : 0.7 + Math.min(0.5, way.width * 0.03));
/** The steepest a stretch climbs: metres up for each metre along. */
const slopeOf = (way: Pick<SpanWay, "cls">): number => (way.cls === "rail" ? 0.035 : way.cls === "path" ? 0.1 : 0.07);
/**
 * The steepest a tunnel dives from its mouth. Steeper than a road or a railway really is: the ground of
 * this world is smoother than the real ground, with none of the cuttings that real tunnels start in, and
 * a tunnel that took 200 m to get under it would lie on top of it for most of its length.
 */
const diveOf = (way: Pick<SpanWay, "cls">): number => (way.cls === "rail" ? 0.07 : way.cls === "path" ? 0.12 : 0.1);
/** The room inside a tunnel, floor to ceiling. */
export const tubeHeight = (way: Pick<SpanWay, "cls">): number => (way.cls === "rail" ? 5.6 : way.cls === "path" ? 3.1 : 5);
/** How far under the ground a tunnel's floor goes, when the ground is not already far above it. */
const tubeDepth = (way: Pick<SpanWay, "cls" | "layer">): number => tubeHeight(way) + 2.2 + 7.5 * Math.min(2, Math.max(0, -way.layer - 1));
/** The least a bridge stands above the ground under it. */
const MIN_ABOVE_M = 0.35;
/** A ramp up to a bridge is never longer than this (it has to end inside the margin of the map piece it starts in). */
const RAMP_MAX_M = 70;

const key = (p: Pt): string => `${p[0]},${p[1]}`;

// ---------------------------------------------------------------- what one piece of the map knows

const kitMemo = new WeakMap<Features, SpanKit>();

const asWay = (r: Road, kind: "bridge" | "tunnel"): SpanWay => ({
  id: r.id, kind, cls: r.cls, width: r.width, layer: r.layer ?? (kind === "bridge" ? 1 : -1), pts: r.pts,
  ...(r.hw ? { hw: r.hw } : {}), ...(r.form ? { form: r.form } : {}), ...(r.oneway ? { oneway: true } : {}), ...(r.name ? { name: r.name } : {}),
});

function box(pts: Pt[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}

/** Where two stretches of line cross, as how far along the first (0 to 1), or -1. Meeting at an end of either is not crossing. */
function crossAt(a: Pt, b: Pt, c: Pt, d: Pt): number {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (den === 0) return -1;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9 ? t : -1;
}

/** The stretches of one piece of the map that leave the ground, what passes under its bridges, and where the ground meets them. */
export function kitOf(features: Features): SpanKit {
  const had = kitMemo.get(features);
  if (had) return had;
  const ways: SpanWay[] = [];
  for (const r of features.roads) if (r.bridge && r.cls !== "stream" && r.pts.length >= 2) ways.push(asWay(r, "bridge"));
  for (const r of features.tunnels ?? []) if (r.pts.length >= 2) ways.push(asWay(r, "tunnel"));
  const kit: SpanKit = { ways, crossings: [], ground: new Set() };
  kitMemo.set(features, kit);
  if (ways.length === 0) return kit;

  const mine = new Set<string>();
  for (const w of ways) for (const p of w.pts) mine.add(key(p));
  const bridges = ways.filter((w) => w.kind === "bridge").map((w) => ({ w, b: box(w.pts) }));
  for (const r of features.roads) {
    if (r.pts.length < 2) continue;
    const span = !!r.bridge && r.cls !== "stream";
    // The ground meets a stretch where a way that stays on it shares a point with one.
    if (!span && r.cls !== "stream") for (const p of r.pts) { const k = key(p); if (mine.has(k)) kit.ground.add(k); }
    if (r.cls === "stream" && r.width < 4) continue; // a ditch needs no room
    const rb = box(r.pts);
    for (const { w, b } of bridges) {
      if (w.id === r.id || rb[2] < b[0] || rb[0] > b[2] || rb[3] < b[1] || rb[1] > b[3]) continue;
      // Of two bridges, the one the map puts lower passes under. Anything on the ground passes under every bridge.
      if (span && (r.layer ?? 1) >= w.layer) continue;
      const clear = r.cls === "stream" ? Math.min(4, Math.max(1, r.width * 0.15)) : CLEAR[r.cls];
      for (let i = 0; i + 1 < w.pts.length; i++) {
        for (let j = 0; j + 1 < r.pts.length; j++) {
          const t = crossAt(w.pts[i], w.pts[i + 1], r.pts[j], r.pts[j + 1]);
          if (t < 0) continue;
          const at: Pt = [w.pts[i][0] + (w.pts[i + 1][0] - w.pts[i][0]) * t, w.pts[i][1] + (w.pts[i + 1][1] - w.pts[i][1]) * t];
          kit.crossings.push({ way: w.id, at, other: r.id, cls: r.cls, span, clear, half: r.width / 2 });
        }
      }
    }
  }
  return kit;
}

// ---------------------------------------------------------------- heights

interface Node { x: number; y: number; g: number; k: string; next: [number, number][]; way: SpanWay }

/** The shortest way along the stretches from some points to every point: metres, and which of the points is nearest. */
function distances(nodes: Node[], from: number[]): Float64Array {
  const dist = new Float64Array(nodes.length).fill(Infinity);
  // The runs are short (a few hundred points), so a plain queue kept in order is enough.
  const queue: [number, number][] = from.map((n) => [0, n]);
  for (const n of from) dist[n] = 0;
  while (queue.length) {
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i][0] < queue[best][0]) best = i;
    const [d, n] = queue.splice(best, 1)[0];
    if (d > dist[n]) continue;
    for (const [m, len] of nodes[n].next) {
      if (d + len < dist[m]) { dist[m] = d + len; queue.push([d + len, m]); }
    }
  }
  return dist;
}

/**
 * The gentlest shape that is nowhere under `least` and climbs no steeper than each stretch may
 * (`sign` 1), or nowhere over `most` and drops no steeper (`sign` -1).
 */
function eased(nodes: Node[], values: Float64Array, sign: 1 | -1, slope: (way: SpanWay) => number = slopeOf): Float64Array {
  const out = Float64Array.from(values);
  for (let pass = 0; pass < 60; pass++) {
    let changed = false;
    for (let n = 0; n < nodes.length; n++) {
      for (const [m, len] of nodes[n].next) {
        const reach = out[n] - sign * Math.max(slope(nodes[n].way), slope(nodes[m].way)) * len;
        if (sign > 0 ? reach > out[m] + 1e-6 : reach < out[m] - 1e-6) { out[m] = reach; changed = true; }
      }
    }
    if (!changed) break;
  }
  return out;
}

/**
 * The same heights with every hollow filled to its brim: from any point there is then a way to one
 * of `outlets` that never climbs. (What water would do, if the heights were ground and the outlets drains.)
 */
function brimmed(nodes: Node[], heights: Float64Array, outlets: number[]): Float64Array {
  if (outlets.length === 0) return heights;
  const out = Float64Array.from(heights);
  const done = new Uint8Array(nodes.length);
  const queue: number[] = [...outlets];
  for (const n of outlets) done[n] = 1;
  while (queue.length) {
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (out[queue[i]] < out[queue[best]]) best = i;
    const n = queue.splice(best, 1)[0];
    for (const [m] of nodes[n].next) {
      if (done[m]) continue;
      done[m] = 1;
      if (out[m] < out[n]) out[m] = out[n];
      queue.push(m);
    }
  }
  return out;
}

/**
 * Works out the heights of every stretch in a kit. Call `elev.ensure` first for everywhere the
 * stretches go (`extentOf`).
 */
export function solveSpans(kit: SpanKit, elev: Elevation): Spans {
  const profiles = new Map<number, Profile>();
  const lifts: Spans["lifts"] = new Map();
  const bridgePoints = new Set<string>();
  for (const w of kit.ways) if (w.kind === "bridge") for (const p of w.pts) bridgePoints.add(key(p));

  for (const kind of ["bridge", "tunnel"] as const) {
    // ---- a point every few metres along every stretch; stretches join where they share a point of the map
    const nodes: Node[] = [];
    const at = new Map<string, number>();
    const ofWay = new Map<number, number[]>();
    const ways = kit.ways.filter((w) => w.kind === kind);
    for (const w of ways) {
      const S = metersPerTile(w.pts[0][1]);
      const line: number[] = [];
      const node = (p: Pt, shared: boolean): number => {
        const k = key(p);
        let n = shared ? at.get(k) : undefined;
        if (n === undefined) {
          n = nodes.length;
          nodes.push({ x: p[0], y: p[1], g: elev.surfaceHeight(p[0], p[1]), k, next: [], way: w });
          if (shared) at.set(k, n);
        }
        return n;
      };
      for (let i = 0; i < w.pts.length; i++) {
        if (i > 0) {
          const a = w.pts[i - 1], b = w.pts[i];
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]) * S;
          const steps = Math.max(1, Math.ceil(len / SPAN_STEP_M));
          let before = line[line.length - 1];
          for (let s = 1; s <= steps; s++) {
            const n = s === steps ? node(b, true) : node([a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps], false);
            if (n !== before && len > 0) {
              nodes[before].next.push([n, len / steps]);
              nodes[n].next.push([before, len / steps]);
            }
            line.push(n);
            before = n;
          }
        } else line.push(node(w.pts[0], true));
      }
      ofWay.set(w.id, line);
    }
    if (nodes.length === 0) continue;

    // ---- the runs: stretches joined end to end, or side to side
    const run = new Int32Array(nodes.length).fill(-1);
    const runs: number[][] = [];
    for (let i = 0; i < nodes.length; i++) {
      if (run[i] >= 0) continue;
      const members = [i];
      run[i] = runs.length;
      for (let head = 0; head < members.length; head++) {
        for (const [m] of nodes[members[head]].next) if (run[m] < 0) { run[m] = runs.length; members.push(m); }
      }
      runs.push(members);
    }
    // An end of a stretch that no other stretch carries on from is where the run comes to the ground.
    const loose = (n: number): boolean => nodes[n].next.length <= 1;
    const meetsGround = (n: number): boolean => kit.ground.has(nodes[n].k) || (kind === "tunnel" && bridgePoints.has(nodes[n].k));

    const height = new Float64Array(nodes.length);
    const dropped = new Set<number>(); // runs that are not built
    const along = new Float64Array(nodes.length);
    const runSea = new Float64Array(runs.length);
    const runLength = new Float64Array(runs.length);
    const runSimple = new Uint8Array(runs.length);
    const runId = runs.map((members) => members.reduce((least, n) => Math.min(least, nodes[n].way.id), Infinity));
    const passes = kind === "bridge" ? 3 : 1;
    for (let pass = 0; pass < passes; pass++) {
      /** How high whatever passes under a bridge is, there. */
      const under = (c: Crossing): number => {
        const g = elev.surfaceHeight(c.at[0], c.at[1]);
        if (!c.span || pass === 0) return g;
        const line = ofWay.get(c.other);
        if (!line) return g;
        let best = g, near = Infinity;
        for (const n of line) {
          const d = Math.hypot(nodes[n].x - c.at[0], nodes[n].y - c.at[1]);
          if (d < near) { near = d; best = height[n]; }
        }
        return best;
      };
      const before = pass > 0 ? Float64Array.from(height) : null;
      runs.forEach((members, r) => {
        const local = new Map<number, number>();
        members.forEach((n, i) => local.set(n, i));
        const sub: Node[] = members.map((n) => ({ ...nodes[n], next: nodes[n].next.map(([m, len]) => [local.get(m)!, len] as [number, number]) }));
        const ends = members.filter(loose);
        const anchors = kind === "bridge" ? ends : ends.filter(meetsGround);
        if (kind === "tunnel" && anchors.length === 0 && members.every((n) => nodes[n].way.cls === "path")) {
          dropped.add(r); // the corridors of a station, with no way in from the street
          return;
        }
        const from = anchors.map((n) => distances(sub, [local.get(n)!]));
        const nearest = (i: number): [number, number] => {
          let d1 = Infinity, d2 = Infinity;
          for (const d of from) { if (d[i] < d1) { d2 = d1; d1 = d[i]; } else if (d[i] < d2) d2 = d[i]; }
          return [d1, d2];
        };
        // Straight from end to end: each end counts for more the nearer it is.
        const straight = (i: number): number => {
          let sum = 0, weight = 0;
          for (let a = 0; a < anchors.length; a++) {
            const d = from[a][i];
            if (d < 1e-6) return nodes[anchors[a]].g;
            sum += nodes[anchors[a]].g / d;
            weight += 1 / d;
          }
          return weight > 0 ? sum / weight : NaN;
        };
        if (kind === "bridge") {
          const least = new Float64Array(sub.length).fill(-Infinity);
          for (const c of kit.crossings) {
            const line = ofWay.get(c.way);
            if (!line || run[line[0]] !== r) continue;
            let best = -1, near = Infinity;
            for (const n of line) {
              const d = Math.hypot(nodes[n].x - c.at[0], nodes[n].y - c.at[1]);
              if (d < near) { near = d; best = n; }
            }
            const need = under(c) + c.clear + deckDepth(nodes[best].way);
            const i = local.get(best)!;
            if (need > least[i]) least[i] = need;
          }
          const tents = eased(sub, least, 1);
          // An arch: slight on every bridge, and high over the sea. Only where the run is one line from ground to ground.
          const simple = anchors.length === 2 && sub.every((n) => n.next.length <= 2);
          let sea = 0, length = 0;
          for (const n of sub) for (const [m, len] of n.next) { length += len / 2; if (n.g <= 0.05 && sub[m].g <= 0.05) sea += len / 2; }
          const span = simple ? from[0][local.get(anchors[1])!] : 0;
          const rise = simple ? Math.min(Math.max(0.012 * span, 0.055 * sea), 32, (0.075 * span) / Math.PI) : 0;
          runSea[r] = sea;
          runLength[r] = simple ? span : length;
          runSimple[r] = simple ? 1 : 0;
          // The run is measured from its western end, so that every stretch of it counts the same way.
          const west = simple && (nodes[anchors[0]].x < nodes[anchors[1]].x || (nodes[anchors[0]].x === nodes[anchors[1]].x && nodes[anchors[0]].y < nodes[anchors[1]].y)) ? 0 : 1;
          const raw = new Float64Array(sub.length);
          sub.forEach((n, i) => {
            const base = straight(i);
            const [d1, d2] = nearest(i);
            const arch = simple && d1 + d2 > 0 ? rise * Math.sin((Math.PI * d1) / (d1 + d2)) ** 2 : 0;
            raw[i] = Math.max((Number.isNaN(base) ? n.g : base) + arch, tents[i], n.g + MIN_ABOVE_M * Math.min(1, d1 / 4));
            along[members[i]] = simple ? from[west][i] : 0;
          });
          // A bridge does not sag: where it would dip between two higher places, it runs level between them.
          const level = brimmed(sub, raw, anchors.map((n) => local.get(n)!));
          level.forEach((h, i) => { height[members[i]] = h; });
        } else {
          const portal = anchors.length ? distances(sub, anchors.map((n) => local.get(n)!)) : null;
          const most = new Float64Array(sub.length);
          sub.forEach((n, i) => { most[i] = n.g - Math.min(tubeDepth(n.way), portal ? diveOf(n.way) * portal[i] : Infinity); });
          const roof = eased(sub, most, -1, diveOf);
          sub.forEach((n, i) => {
            const base = straight(i);
            let h = Number.isNaN(base) ? roof[i] : Math.min(base, roof[i]);
            // Never dropping away from a mouth faster than the way may slope.
            for (let a = 0; a < anchors.length; a++) h = Math.max(h, nodes[anchors[a]].g - diveOf(n.way) * from[a][i]);
            height[members[i]] = h;
          });
        }
      });
      if (before && before.every((v, i) => Math.abs(v - height[i]) < 0.01)) break;
    }

    // ---- what is handed on
    for (const w of ways) {
      const line = ofWay.get(w.id)!;
      if (dropped.has(run[line[0]])) continue;
      const S = metersPerTile(w.pts[0][1]);
      const d: number[] = [0];
      for (let i = 1; i < line.length; i++) d.push(d[i - 1] + Math.hypot(nodes[line[i]].x - nodes[line[i - 1]].x, nodes[line[i]].y - nodes[line[i - 1]].y) * S);
      const end = (n: number): SpanEnd => (!loose(n) ? "joined" : kind === "bridge" || meetsGround(n) ? "ground" : "blind");
      profiles.set(w.id, {
        way: w, pts: line.map((n) => [nodes[n].x, nodes[n].y] as Pt), d, h: line.map((n) => height[n]), g: line.map((n) => nodes[n].g),
        ends: [end(line[0]), end(line[line.length - 1])],
        sea: runSea[run[line[0]]] ?? 0, run: runLength[run[line[0]]] ?? 0, along: line.map((n) => along[n]),
        runOf: runId[run[line[0]]], simple: runSimple[run[line[0]]] === 1,
      });
    }
    if (kind === "bridge") {
      for (const [k, n] of at) {
        if (!kit.ground.has(k)) continue;
        const lift = height[n] - nodes[n].g;
        if (lift < 0.25) continue;
        const slope = Math.max(slopeOf(nodes[n].way), lift / RAMP_MAX_M);
        const had = lifts.get(k);
        if (!had || lift > had.lift) lifts.set(k, { lift, slope });
      }
    }
  }
  return { profiles, crossings: kit.crossings, lifts };
}

/** The height of a stretch's surface at the point of it nearest to `p`, and how far from `p` that is (in world units). */
export function heightOn(profile: Profile, p: Pt): { h: number; off: number } {
  let h = profile.h[0], off = Infinity;
  for (let i = 0; i + 1 < profile.pts.length; i++) {
    const a = profile.pts[i], b = profile.pts[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const f = Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(p[0] - a[0] - dx * f, p[1] - a[1] - dy * f);
    if (d < off) { off = d; h = profile.h[i] + (profile.h[i + 1] - profile.h[i]) * f; }
  }
  return { h, off };
}

/** How far the top of a deck, a ramp or a tunnel's floor is above the height worked out for it: as a road is above the ground. */
export const SURFACE_M = 0.2;

/** How far above the ground (or below it, in a tunnel) a way's surface is at a point of it: 0 for a way on the ground. */
export function liftAt(spans: Spans, ramps: Map<number, Ramp>, elev: Elevation, way: number, p: Pt): number {
  const profile = spans.profiles.get(way);
  if (profile) return heightOn(profile, p).h + SURFACE_M - elev.surfaceHeight(p[0], p[1]);
  const ramp = ramps.get(way);
  if (!ramp) return 0;
  let lift = 0, near = Infinity;
  for (let i = 0; i + 1 < ramp.pts.length; i++) {
    const a = ramp.pts[i], b = ramp.pts[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const f = Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(p[0] - a[0] - dx * f, p[1] - a[1] - dy * f);
    if (d < near) { near = d; lift = ramp.lift[i] + (ramp.lift[i + 1] - ramp.lift[i]) * f; }
  }
  return lift > 0.03 ? lift + SURFACE_M : 0;
}

// ---------------------------------------------------------------- ramps

/** A way on the ground that rises to meet a bridge: its line with a point every few metres, and how far above the ground each is. */
export interface Ramp { pts: Pt[]; lift: number[] }

const rampMemo = new WeakMap<Spans, WeakMap<Features, Map<number, Ramp>>>();

/**
 * The ramps of one piece of the map: where a bridge is above the ground at a point a road on the
 * ground meets it, that road (and any that fork from it) climbs to it.
 */
export function rampsOf(features: Features, spans: Spans): Map<number, Ramp> {
  let byFeatures = rampMemo.get(spans);
  if (!byFeatures) rampMemo.set(spans, (byFeatures = new WeakMap()));
  const had = byFeatures.get(features);
  if (had) return had;
  const out = new Map<number, Ramp>();
  byFeatures.set(features, out);
  if (spans.lifts.size === 0) return out;

  const roads = features.roads.filter((r) => !r.bridge && r.cls !== "stream" && r.pts.length >= 2);
  const through = new Map<string, { r: number; i: number }[]>();
  roads.forEach((road, r) => road.pts.forEach((p, i) => {
    const k = key(p);
    const list = through.get(k);
    if (list) list.push({ r, i }); else through.set(k, [{ r, i }]);
  }));
  // How high above the ground each point of the map is, on some ramp: spreading out from where the bridges are met.
  const lift = new Map<string, { lift: number; slope: number }>();
  const queue: { k: string; lift: number; slope: number }[] = [];
  for (const [k, l] of spans.lifts) if (through.has(k)) queue.push({ k, ...l });
  while (queue.length) {
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].lift > queue[best].lift) best = i;
    const here = queue.splice(best, 1)[0];
    if ((lift.get(here.k)?.lift ?? 0) >= here.lift) continue;
    lift.set(here.k, { lift: here.lift, slope: here.slope });
    for (const { r, i } of through.get(here.k) ?? []) {
      const S = metersPerTile(roads[r].pts[i][1]);
      for (const j of [i - 1, i + 1]) {
        const q = roads[r].pts[j];
        if (!q) continue;
        const left = here.lift - here.slope * Math.hypot(q[0] - roads[r].pts[i][0], q[1] - roads[r].pts[i][1]) * S;
        if (left > 0.05 && left > (lift.get(key(q))?.lift ?? 0)) queue.push({ k: key(q), lift: left, slope: here.slope });
      }
    }
  }
  if (lift.size === 0) return out;
  const flat = { lift: 0, slope: 1 };
  roads.forEach((road) => {
    const at = road.pts.map((p) => lift.get(key(p)) ?? flat);
    if (at.every((v) => v.lift === 0)) return;
    const S = metersPerTile(road.pts[0][1]);
    const pts: Pt[] = [road.pts[0]];
    const lifts: number[] = [at[0].lift];
    for (let i = 1; i < road.pts.length; i++) {
      const a = road.pts[i - 1], b = road.pts[i];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) * S;
      const steps = at[i - 1].lift > 0 || at[i].lift > 0 ? Math.max(1, Math.ceil(len / SPAN_STEP_M)) : 1;
      for (let s = 1; s <= steps; s++) {
        const f = s / steps;
        // Between two points of the map the ramp comes down from whichever is higher, at its own slope.
        const fromA = at[i - 1].lift - at[i - 1].slope * len * f, fromB = at[i].lift - at[i].slope * len * (1 - f);
        pts.push(s === steps ? b : [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
        lifts.push(s === steps ? at[i].lift : Math.max(0, fromA, fromB));
      }
    }
    out.set(road.id, { pts, lift: lifts });
  });
  return out;
}

// ---------------------------------------------------------------- across the pieces of the map

const SHIFT = CHUNK_Z - DATA_Z;
/** The kits of pieces of the map lately read, by "dx/dy": small, and kept so that a neighbour need not be read again for them. */
const kits = new Map<string, SpanKit>();
const KITS_KEPT = 64;
/** The most neighbouring pieces a run is followed into. */
const FOLLOW_TILES = 6;

const solved = new WeakMap<Features, Spans>();
const solving = new WeakMap<Features, Promise<Spans>>();

function keepKit(k: string, kit: SpanKit): void {
  kits.delete(k);
  kits.set(k, kit);
  if (kits.size > KITS_KEPT) kits.delete(kits.keys().next().value!);
}

/** The piece of the map (DATA_Z tile) a point is in. */
const tileOf = (p: Pt): [number, number] => [Math.floor(p[0]) >> SHIFT, Math.floor(p[1]) >> SHIFT];

/**
 * The heights of the bridges and tunnels of one piece of the map, with every run followed into the
 * neighbouring pieces it carries on in, so that both pieces give it the same heights. Loads the
 * heights of the ground it needs.
 */
export function prepareSpans(dx: number, dy: number, features: Features, elev: Elevation, load: (dx: number, dy: number) => Promise<Features> = loadFeatures): Promise<Spans> {
  const done = solved.get(features);
  if (done) return Promise.resolve(done);
  let job = solving.get(features);
  if (!job) {
    job = (async () => {
      const own = kitOf(features);
      keepKit(`${dx}/${dy}`, own);
      const ways = new Map<number, SpanWay>();
      for (const w of own.ways) ways.set(w.id, w);
      const crossings = [...own.crossings];
      const ground = new Set(own.ground);
      const seen = new Set<string>(crossings.map((c) => `${c.way}:${c.other}:${c.at[0].toFixed(6)},${c.at[1].toFixed(6)}`));
      if (ways.size > 0) {
        // What this piece is sure of: everything that touches it and its margin is in it, whole.
        const m = DATA_MARGIN * (1 << SHIFT);
        const x0 = (dx << SHIFT) - m, y0 = (dy << SHIFT) - m, x1 = ((dx + 1) << SHIFT) + m, y1 = ((dy + 1) << SHIFT) + m;
        const inside = (p: Pt): boolean => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
        const read = new Set<string>([`${dx}/${dy}`]);
        const failed = new Set<string>();
        for (let more = 0; more < FOLLOW_TILES; more++) {
          // The nearest piece that some stretch runs on into, beyond what is sure.
          let want: [number, number] | null = null, near = Infinity;
          for (const w of ways.values()) {
            const S = metersPerTile(w.pts[0][1]);
            for (let i = 0; i < w.pts.length; i++) {
              const steps = i === 0 ? 1 : Math.max(1, Math.ceil((Math.hypot(w.pts[i][0] - w.pts[i - 1][0], w.pts[i][1] - w.pts[i - 1][1]) * S) / 40));
              for (let s = 1; s <= steps; s++) {
                const p: Pt = i === 0 ? w.pts[0] : [w.pts[i - 1][0] + ((w.pts[i][0] - w.pts[i - 1][0]) * s) / steps, w.pts[i - 1][1] + ((w.pts[i][1] - w.pts[i - 1][1]) * s) / steps];
                if (inside(p)) continue;
                const [tx, ty] = tileOf(p);
                const k = `${tx}/${ty}`;
                if (read.has(k) || failed.has(k)) continue;
                const d = Math.hypot(tx + 0.5 - (dx + 0.5), ty + 0.5 - (dy + 0.5));
                if (d < near) { near = d; want = [tx, ty]; }
              }
            }
          }
          if (!want) break;
          const k = `${want[0]}/${want[1]}`;
          let kit = kits.get(k);
          if (!kit) {
            try {
              kit = kitOf(await load(want[0], want[1]));
              keepKit(k, kit);
            } catch {
              failed.add(k); // the map of the piece next door cannot be had just now: the run ends where this piece's knowledge does
              continue;
            }
          }
          read.add(k);
          // Of the neighbour's stretches, those that carry on from ours (and those that carry on from them).
          const points = new Set<string>();
          for (const w of ways.values()) for (const p of w.pts) points.add(`${w.kind}:${key(p)}`);
          for (let grew = true; grew; ) {
            grew = false;
            for (const w of kit.ways) {
              if (ways.has(w.id) || !w.pts.some((p) => points.has(`${w.kind}:${key(p)}`))) continue;
              ways.set(w.id, w);
              for (const p of w.pts) points.add(`${w.kind}:${key(p)}`);
              grew = true;
            }
          }
          for (const c of kit.crossings) {
            if (!ways.has(c.way)) continue;
            const id = `${c.way}:${c.other}:${c.at[0].toFixed(6)},${c.at[1].toFixed(6)}`;
            if (seen.has(id)) continue;
            seen.add(id);
            crossings.push(c);
            // A bridge that passes under one of ours has to be known too, for its height there.
            const lower = c.span ? kit.ways.find((w) => w.id === c.other) : undefined;
            if (lower && !ways.has(lower.id)) ways.set(lower.id, lower);
          }
          for (const g of kit.ground) ground.add(g);
        }
        const merged = [...ways.values()].sort((a, b) => a.id - b.id);
        for (const w of merged) {
          const [bx0, by0, bx1, by1] = box(w.pts);
          await elev.ensure(bx0 - 0.02, by0 - 0.02, bx1 + 0.02, by1 + 0.02);
        }
        crossings.sort((a, b) => a.way - b.way || a.other - b.other || a.at[0] - b.at[0] || a.at[1] - b.at[1]);
        const spans = solveSpans({ ways: merged, crossings, ground }, elev);
        solved.set(features, spans);
        return spans;
      }
      const none: Spans = { profiles: new Map(), crossings: [], lifts: new Map() };
      solved.set(features, none);
      return none;
    })();
    solving.set(features, job);
  }
  return job;
}

/**
 * The heights for a piece of the map: those `prepareSpans` worked out or, where it was not called
 * (the tests build a chunk straight from features), worked out now from that piece alone.
 */
export function spansOf(features: Features, elev: Elevation): Spans {
  let spans = solved.get(features);
  if (!spans) solved.set(features, (spans = solveSpans(kitOf(features), elev)));
  return spans;
}
