// Draws the stretches that leave the ground (spans.ts) into a chunk: the decks of bridges with their
// piers and sides, and the ramps that roads climb to them on.
//
// A stretch is drawn into every chunk it passes through, clipped to the chunk and a little beyond, as
// roads are. Whatever stands at one spot (a pier, a post) belongs to the chunk that spot is in.

import type { MaterialDef, Section } from "./chunk.ts";
import type { Features, Pt, Road } from "./osm.ts";
import { deckDepth, type Profile, type Ramp, type Spans } from "./spans.ts";

export interface SpanCtx {
  cx: number; cy: number;
  /** Metres per chunk here. */
  S: number;
  sec: (m: MaterialDef) => Section;
  /** The height of the ground at world coordinates. */
  ground: (wx: number, wy: number) => number;
  /** The surfaces: `deck` is walked and driven on, `structure` holds it up, `railing` is thin, `marking` is paint. */
  mats: { deck: MaterialDef; structure: MaterialDef; railing: MaterialDef; marking: MaterialDef };
  /** A surface in a colour of its own. */
  painted: (m: MaterialDef, hex: number) => MaterialDef;
}

/** What a deck is made of, by what it carries: tarmac, a railway's ballast, a path's gravel, or boards. */
const ROAD_GREY = 0x4a4a4e, BALLAST = 0x5b4a3f, GRAVEL = 0xc9b28a, BOARDS = 0xa98558;
export const CONCRETE = 0xb9bec4;
const TIMBER = 0x8a6a45;
/** How far the top of a deck is above the height worked out for it: the same as a road is above the ground. */
const SURFACE_M = 0.2;

interface Sample {
  /** East and north in chunk metres; world coordinates; how far along the stretch in metres. */
  e: number; n: number; wx: number; wy: number; d: number;
  /** The way it runs (unit), and the height of its surface. */
  te: number; tn: number; top: number;
}

/**
 * Clips a line to a box. Each point of each piece says how far along the whole line it is, counted in
 * points: 2.5 is halfway from the third point to the fourth.
 */
export function clipLine(pts: Pt[], x0: number, y0: number, x1: number, y1: number): { x: number; y: number; t: number }[][] {
  const out: { x: number; y: number; t: number }[][] = [];
  let cur: { x: number; y: number; t: number }[] = [];
  const close = (): void => {
    if (cur.length >= 2) out.push(cur);
    cur = [];
  };
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const dx = bx - ax, dy = by - ay;
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } } else {
        const r = q / p;
        if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; } else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
      }
    }
    if (!ok) { close(); continue; }
    if (cur.length === 0 || t0 > 0) {
      close();
      cur = [{ x: ax + dx * t0, y: ay + dy * t0, t: i + t0 }];
    }
    cur.push({ x: ax + dx * t1, y: ay + dy * t1, t: i + t1 });
    if (t1 < 1) close();
  }
  close();
  return out;
}

const lerp = (values: number[], t: number): number => {
  const i = Math.min(values.length - 2, Math.floor(t));
  return values[i] + (values[i + 1] - values[i]) * (t - i);
};

/** A strip along a line of samples, between two points of its cross-section: `o` metres to the right of the middle, at height `z`. */
function strip(sec: Section, line: Sample[], o0: number, z0: (s: Sample) => number, o1: number, z1: (s: Sample) => number, across: number, up: number): void {
  let before = -1;
  for (const s of line) {
    // To the right of the way it runs is (tn, -te).
    const ne = s.tn * across, nn = -s.te * across;
    const a = sec.vert(s.e + s.tn * o0, s.n - s.te * o0, z0(s), ne, nn, up);
    sec.vert(s.e + s.tn * o1, s.n - s.te * o1, z1(s), ne, nn, up);
    if (before >= 0) quad(sec, before, before + 1, a + 1, a, [ne, nn, up]);
    before = a;
  }
}

/** Two triangles between four corners already in the section, wound to face the way `n` points. */
function quad(sec: Section, a: number, b: number, c: number, d: number, n: [number, number, number]): void {
  const p = sec.pos;
  const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[d * 3] - p[a * 3], vy = p[d * 3 + 1] - p[a * 3 + 1], vz = p[d * 3 + 2] - p[a * 3 + 2];
  const facing = (uy * vz - uz * vy) * n[0] + (uz * vx - ux * vz) * n[1] + (ux * vy - uy * vx) * n[2];
  if (facing >= 0) { sec.tri(a, b, c); sec.tri(a, c, d); } else { sec.tri(a, c, b); sec.tri(a, d, c); }
}

/** An upright block: `along` and `across` are half its size each way, measured along and across the way the stretch runs. */
function block(sec: Section, s: Pick<Sample, "e" | "n" | "te" | "tn">, off: number, along: number, across: number, z0: number, z1: number, top = false): void {
  const ce = s.e + s.tn * off, cn = s.n - s.te * off;
  const p = (a: number, c: number, z: number): [number, number, number] => [ce + s.te * a + s.tn * c, cn + s.tn * a - s.te * c, z];
  const side = (pts: [number, number, number][], n: [number, number, number]): void => {
    const first = sec.count;
    for (const q of pts) sec.vert(q[0], q[1], q[2], n[0], n[1], n[2]);
    quad(sec, first, first + 1, first + 2, first + 3, n);
  };
  side([p(along, -across, z0), p(along, across, z0), p(along, across, z1), p(along, -across, z1)], [s.te, s.tn, 0]);
  side([p(-along, -across, z0), p(-along, across, z0), p(-along, across, z1), p(-along, -across, z1)], [-s.te, -s.tn, 0]);
  side([p(-along, across, z0), p(along, across, z0), p(along, across, z1), p(-along, across, z1)], [s.tn, -s.te, 0]);
  side([p(-along, -across, z0), p(along, -across, z0), p(along, -across, z1), p(-along, -across, z1)], [-s.tn, s.te, 0]);
  if (top) side([p(-along, -across, z1), p(along, -across, z1), p(along, across, z1), p(-along, across, z1)], [0, 0, 1]);
}

/** The samples of a line inside the chunk and a little beyond: one for each of its points, and one where it is cut. */
function samplesOf(ctx: SpanCtx, pts: Pt[], d: number[], top: number[], pad: number): Sample[][] {
  const { cx, cy, S } = ctx;
  return clipLine(pts, cx - pad, cy - pad, cx + 1 + pad, cy + 1 + pad).map((piece) => {
    const line: Sample[] = piece.map((p) => ({ e: (p.x - cx) * S, n: -(p.y - cy) * S, wx: p.x, wy: p.y, d: lerp(d, p.t), te: 0, tn: 0, top: lerp(top, p.t) }));
    for (let i = 0; i < line.length; i++) {
      const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
      const len = Math.hypot(b.e - a.e, b.n - a.n) || 1;
      line[i].te = (b.e - a.e) / len;
      line[i].tn = (b.n - a.n) / len;
    }
    return line.filter((s, i) => i === 0 || Math.hypot(s.e - line[i - 1].e, s.n - line[i - 1].n) > 0.02);
  }).filter((line) => line.length >= 2);
}

/** The sample of a line at so many metres along it. */
function sampleAt(line: Sample[], d: number): Sample | null {
  if (d < line[0].d || d > line[line.length - 1].d) return null;
  for (let i = 1; i < line.length; i++) {
    if (line[i].d < d) continue;
    const a = line[i - 1], b = line[i];
    const f = b.d === a.d ? 0 : (d - a.d) / (b.d - a.d);
    return { e: a.e + (b.e - a.e) * f, n: a.n + (b.n - a.n) * f, wx: a.wx + (b.wx - a.wx) * f, wy: a.wy + (b.wy - a.wy) * f, d, te: b.te, tn: b.tn, top: a.top + (b.top - a.top) * f };
  }
  return null;
}

const inChunk = (ctx: SpanCtx, s: Sample): boolean => s.wx >= ctx.cx && s.wx < ctx.cx + 1 && s.wy >= ctx.cy && s.wy < ctx.cy + 1;

/** The colour of what a stretch carries. */
function surface(way: Profile["way"]): number {
  return way.cls === "rail" ? BALLAST : way.cls === "road" ? ROAD_GREY : way.form === "boardwalk" ? BOARDS : GRAVEL;
}

/** Dashes down the middle of a wide road, placed by how far along the stretch they are, so that every chunk paints the same ones. */
function dashes(ctx: SpanCtx, line: Sample[], lift: number): void {
  const marks = ctx.sec(ctx.mats.marking);
  for (let d = Math.ceil((line[0].d - 3) / 8) * 8 + 2; d + 3 < line[line.length - 1].d; d += 8) {
    const a = sampleAt(line, Math.max(d, line[0].d)), b = sampleAt(line, d + 3);
    if (!a || !b) continue;
    strip(marks, [a, b], -0.09, (s) => s.top + lift, 0.09, (s) => s.top + lift, 0, 1);
  }
}

function bridge(ctx: SpanCtx, profile: Profile, spans: Spans): void {
  const { way } = profile;
  const half = way.width / 2;
  const depth = deckDepth(way);
  const pad = (half + 2) / ctx.S;
  const top = profile.h.map((h) => h + SURFACE_M);
  const walk = way.cls === "path";
  const boards = way.form === "boardwalk";
  const deck = ctx.sec(ctx.painted(ctx.mats.deck, surface(way)));
  const body = ctx.sec(ctx.painted(ctx.mats.structure, boards ? TIMBER : CONCRETE));
  // The side walls: solid and waist high beside a road or a railway, slighter beside a path.
  const wall = walk ? 1 : way.cls === "rail" ? 0.8 : 1.05, thick = walk ? 0.12 : 0.28;
  const under = spans.crossings.filter((c) => c.way === way.id);
  const length = profile.d[profile.d.length - 1];

  for (const line of samplesOf(ctx, profile.pts, profile.d, top, pad)) {
    const t = (s: Sample): number => s.top, b = (s: Sample): number => s.top - depth, w = (s: Sample): number => s.top + wall;
    strip(deck, line, -half, t, half, t, 0, 1);
    strip(body, line, -half, b, half, b, 0, -1);
    for (const side of [1, -1]) {
      strip(body, line, side * half, b, side * half, w, side, 0); // the outside, from under the deck to the top of the wall
      strip(body, line, side * (half - thick), w, side * half, w, 0, 1);
      strip(body, line, side * (half - thick), t, side * (half - thick), w, -side, 0);
    }
    if (way.cls === "road" && way.width >= 6.5) dashes(ctx, line, 0.03);

    // ---- piers: evenly along the stretch, wherever the deck is clear of the ground, and never in the way of what passes under
    const gap = walk ? 12 : 26;
    const count = Math.round(length / gap);
    for (let j = 0; j < count; j++) {
      const s = sampleAt(line, ((j + 0.5) * length) / count);
      if (!s || !inChunk(ctx, s)) continue;
      const foot = ctx.ground(s.wx, s.wy);
      if (s.top - depth - foot < 1) continue;
      const alongHalf = walk ? 0.22 : 0.6, acrossHalf = walk ? 0.22 : Math.max(0.6, half * 0.55);
      if (under.some((c) => Math.hypot(c.at[0] - s.wx, c.at[1] - s.wy) * ctx.S < c.half + alongHalf + acrossHalf + 1.5)) continue;
      const z0 = foot <= 0.05 ? -3 : foot - 1;
      if (walk) for (const side of [1, -1]) block(body, s, side * (half - 0.3), alongHalf, acrossHalf, z0, s.top - depth);
      else block(body, s, 0, alongHalf, acrossHalf, z0, s.top - depth);
    }
  }
}

/**
 * A ramp: where a road on the ground climbs to a bridge that is above the ground where they meet. Its
 * top is put over the road as it lies on the ground, with a wall each side down to the ground.
 */
function ramp(ctx: SpanCtx, road: Road, r: Ramp): void {
  const half = road.width / 2;
  const pad = (half + 2) / ctx.S;
  const S0 = ctx.S;
  const d: number[] = [0];
  for (let i = 1; i < r.pts.length; i++) d.push(d[i - 1] + Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]) * S0);
  const deck = ctx.sec(ctx.painted(ctx.mats.deck, road.cls === "rail" ? BALLAST : road.cls === "road" ? ROAD_GREY : GRAVEL));
  const body = ctx.sec(ctx.painted(ctx.mats.structure, CONCRETE));
  for (const whole of samplesOf(ctx, r.pts, d, r.lift, pad)) {
    // (Here a sample's `top` is how far above the ground it is; the pieces that are above it at all are drawn.)
    let run: Sample[] = [];
    const flush = (): void => {
      if (run.length >= 2) {
        const lift = new Map(run.map((s) => [s, s.top]));
        const edge = (s: Sample, side: number): number => {
          const mid = ctx.ground(s.wx, s.wy) + lift.get(s)!;
          return Math.max(mid, ctx.ground(s.wx + (s.tn * side * half) / S0, s.wy + (s.te * side * half) / S0)) + SURFACE_M + 0.02;
        };
        const foot = (s: Sample, side: number): number => ctx.ground(s.wx + (s.tn * side * half) / S0, s.wy + (s.te * side * half) / S0) - 0.4;
        const wall = (s: Sample, side: number): number => edge(s, side) + (lift.get(s)! > 1.2 ? 1.05 : 0);
        strip(deck, run, -half, (s) => edge(s, -1), half, (s) => edge(s, 1), 0, 1);
        for (const side of [1, -1]) {
          strip(body, run, side * half, (s) => foot(s, side), side * half, (s) => wall(s, side), side, 0);
          strip(body, run, side * (half - 0.28), (s) => wall(s, side), side * half, (s) => wall(s, side), 0, 1);
          strip(body, run, side * (half - 0.28), (s) => edge(s, side), side * (half - 0.28), (s) => wall(s, side), -side, 0);
        }
      }
      run = [];
    };
    whole.forEach((s, i) => {
      const lifted = s.top > 0.03 || (whole[i - 1]?.top ?? 0) > 0.03 || (whole[i + 1]?.top ?? 0) > 0.03;
      if (lifted) run.push(s); else flush();
    });
    flush();
  }
}

/** Draws every bridge and ramp that passes through a chunk. */
export function drawSpans(ctx: SpanCtx, features: Features, spans: Spans, ramps: Map<number, Ramp>): void {
  for (const profile of spans.profiles.values()) {
    if (profile.way.kind === "bridge") bridge(ctx, profile, spans);
  }
  if (ramps.size) for (const road of features.roads) {
    const r = ramps.get(road.id);
    if (r) ramp(ctx, road, r);
  }
}
