// Draws the stretches that leave the ground (spans.ts) into a chunk: the decks of bridges with their
// piers and sides, the ramps that roads climb to them on, and what gives each kind of bridge its
// character: a great steel arch over the giants, stone arches under old city bridges, light
// footbridges with rails.
//
// A stretch is drawn into every chunk it passes through, clipped to the chunk and a little beyond, as
// roads are. Whatever stands at one spot (a pier, a post) belongs to the chunk that spot is in.

import type { MaterialDef, Section } from "./chunk.ts";
import { xToLon, yToLat } from "./geo.ts";
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
const TIMBER = 0x8a6a45, STONE = 0xcbbf9f, STEEL = 0x7d8790, RAIL_PAINT = 0xf4f1e6;
/** How far the top of a deck is above the height worked out for it: the same as a road is above the ground. */
const SURFACE_M = 0.2;
/** A bridge is one of the giants when its run from ground to ground is this long, with this much of it over the sea. */
const GIANT_RUN_M = 400, GIANT_SEA_M = 250;

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

/** Four corners as a face of their own. */
function panel(sec: Section, pts: [number, number, number][], n: [number, number, number]): void {
  const first = sec.count;
  for (const q of pts) sec.vert(q[0], q[1], q[2], n[0], n[1], n[2]);
  quad(sec, first, first + 1, first + 2, first + 3, n);
}

type Frame = Pick<Sample, "e" | "n" | "te" | "tn">;

/** An upright block: `along` and `across` are half its size each way, measured along and across the way the stretch runs. */
function block(sec: Section, s: Frame, off: number, along: number, across: number, z0: number, z1: number, top = false): void {
  const ce = s.e + s.tn * off, cn = s.n - s.te * off;
  const p = (a: number, c: number, z: number): [number, number, number] => [ce + s.te * a + s.tn * c, cn + s.tn * a - s.te * c, z];
  panel(sec, [p(along, -across, z0), p(along, across, z0), p(along, across, z1), p(along, -across, z1)], [s.te, s.tn, 0]);
  panel(sec, [p(-along, -across, z0), p(-along, across, z0), p(-along, across, z1), p(-along, -across, z1)], [-s.te, -s.tn, 0]);
  panel(sec, [p(-along, across, z0), p(along, across, z0), p(along, across, z1), p(-along, across, z1)], [s.tn, -s.te, 0]);
  panel(sec, [p(-along, -across, z0), p(along, -across, z0), p(along, -across, z1), p(-along, -across, z1)], [-s.tn, s.te, 0]);
  if (top) panel(sec, [p(-along, -across, z1), p(along, -across, z1), p(along, across, z1), p(-along, across, z1)], [0, 0, 1]);
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
  if (d < line[0].d - 1e-6 || d > line[line.length - 1].d + 1e-6) return null;
  for (let i = 1; i < line.length; i++) {
    if (line[i].d < d && i + 1 < line.length) continue;
    const a = line[i - 1], b = line[i];
    const f = b.d === a.d ? 0 : Math.min(1, Math.max(0, (d - a.d) / (b.d - a.d)));
    return { e: a.e + (b.e - a.e) * f, n: a.n + (b.n - a.n) * f, wx: a.wx + (b.wx - a.wx) * f, wy: a.wy + (b.wy - a.wy) * f, d, te: b.te, tn: b.tn, top: a.top + (b.top - a.top) * f };
  }
  return null;
}

const inChunk = (ctx: SpanCtx, s: { wx: number; wy: number }): boolean => s.wx >= ctx.cx && s.wx < ctx.cx + 1 && s.wy >= ctx.cy && s.wy < ctx.cy + 1;

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

/** Where old bridges are of stone: Europe, and round the Mediterranean. */
const stoneCountry = (lat: number, lon: number): boolean => lat > 30 && lat < 62 && lon > -11 && lon < 45;

/**
 * How a bridge is built: `foot` a light one for walkers, with rails; `stone` an old city bridge over
 * water, on arches; `plain` everything else, a deck on piers with solid sides.
 */
function lookOf(ctx: SpanCtx, profile: Profile, spans: Spans): "foot" | "stone" | "plain" {
  const { way } = profile;
  if (way.cls === "path") return "foot";
  if (way.cls !== "road" || way.form === "viaduct" || !profile.simple || profile.run < 25 || profile.run > 450) return "plain";
  if (!stoneCountry(yToLat(ctx.cy + 0.5), xToLon(ctx.cx + 0.5))) return "plain";
  // Over water: the sea, or a river anywhere along the run.
  const run = profile.runOf;
  const wet = profile.sea > 10 || spans.crossings.some((c) => c.cls === "stream" && c.half >= 3 && spans.profiles.get(c.way)?.runOf === run);
  return wet ? "stone" : "plain";
}

function bridge(ctx: SpanCtx, profile: Profile, spans: Spans): void {
  const { way } = profile;
  const half = way.width / 2;
  const depth = deckDepth(way);
  const pad = (half + 4) / ctx.S;
  const top = profile.h.map((h) => h + SURFACE_M);
  const look = lookOf(ctx, profile, spans);
  const boards = way.form === "boardwalk";
  const deck = ctx.sec(ctx.painted(ctx.mats.deck, surface(way)));
  const body = ctx.sec(ctx.painted(ctx.mats.structure, boards ? TIMBER : look === "stone" ? STONE : CONCRETE));
  const rail = look === "foot" ? ctx.sec(ctx.painted(ctx.mats.railing, boards ? TIMBER : RAIL_PAINT)) : null;
  // The side walls: solid and waist high beside a road or a railway.
  const wall = way.cls === "rail" ? 0.8 : 1.05, thick = look === "stone" ? 0.4 : 0.28;
  const length = profile.d[profile.d.length - 1];
  // What passes under it, and how far along it each is.
  const under = spans.crossings.filter((c) => c.way === way.id).map((c) => {
    let best = 0, near = Infinity;
    profile.pts.forEach((p, i) => { const d = Math.hypot(p[0] - c.at[0], p[1] - c.at[1]); if (d < near) { near = d; best = i; } });
    return { ...c, d: profile.d[best] };
  });

  for (const line of samplesOf(ctx, profile.pts, profile.d, top, pad)) {
    const t = (s: Sample): number => s.top, b = (s: Sample): number => s.top - depth, w = (s: Sample): number => s.top + wall;
    strip(deck, line, -half, t, half, t, 0, 1);
    strip(body, line, -half, b, half, b, 0, -1);
    for (const side of [1, -1]) {
      if (rail) {
        // Rails with the sky between them: a deep handrail and a lower rail, on posts.
        strip(body, line, side * half, b, side * half, t, side, 0);
        for (const [z0, z1] of [[0.78, 1.05], [0.46, 0.6]]) {
          strip(rail, line, side * half, (s) => s.top + z0, side * half, (s) => s.top + z1, side, 0);
          strip(rail, line, side * (half - 0.07), (s) => s.top + z0, side * (half - 0.07), (s) => s.top + z1, -side, 0);
        }
        strip(rail, line, side * (half - 0.07), (s) => s.top + 1.05, side * half, (s) => s.top + 1.05, 0, 1);
        for (let d = Math.ceil(line[0].d / 4) * 4; d <= line[line.length - 1].d; d += 4) {
          const s = sampleAt(line, d);
          if (s && inChunk(ctx, s)) block(rail, s, side * (half - 0.035), 0.05, 0.035, s.top, s.top + 1.05);
        }
      } else {
        strip(body, line, side * half, b, side * half, w, side, 0); // the outside, from under the deck to the top of the wall
        strip(body, line, side * (half - thick), w, side * half, w, 0, 1);
        strip(body, line, side * (half - thick), t, side * (half - thick), w, -side, 0);
      }
    }
    if (way.cls === "road" && way.width >= 6.5) dashes(ctx, line, 0.03);

    // ---- piers: evenly along the stretch, wherever the deck is clear of the ground, and never in the way of what passes under
    const gap = look === "foot" ? 12 : look === "stone" ? 22 : 26;
    const count = Math.max(look === "stone" && length > 12 ? 1 : 0, Math.round(length / gap));
    const alongHalf = look === "foot" ? 0.22 : look === "stone" ? 1 : 0.6;
    const acrossHalf = look === "foot" ? 0.22 : look === "stone" ? half : Math.max(0.6, half * 0.55);
    const at = (j: number): number => ((j + 0.5) * length) / count;
    const blocked = (s: Sample): boolean => under.some((c) => Math.hypot(c.at[0] - s.wx, c.at[1] - s.wy) * ctx.S < c.half + alongHalf + acrossHalf + 1.5);
    for (let j = 0; j < count; j++) {
      const s = sampleAt(line, at(j));
      if (!s || !inChunk(ctx, s)) continue;
      const foot = ctx.ground(s.wx, s.wy);
      if (s.top - depth - foot < 1 || blocked(s)) continue;
      const z0 = foot <= 0.05 ? -3 : foot - 1;
      if (look === "foot") for (const side of [1, -1]) block(body, s, side * (half - 0.3), alongHalf, acrossHalf, z0, s.top - depth);
      else block(body, s, 0, alongHalf, acrossHalf, z0, s.top - depth);
    }

    // ---- stone arches: from pier to pier the deck sits on an arch, filled in above it
    if (look === "stone" && count >= 1) {
      // Each opening: from `from` to `to` along the stretch, highest at `crown`.
      const bays: { from: number; to: number; crown: number }[] = [];
      for (let j = 0; j + 1 < count; j++) bays.push({ from: at(j), to: at(j + 1), crown: (at(j) + at(j + 1)) / 2 });
      // Where the bridge carries on as another stretch, the arch does too: each stretch builds its half, up to the join.
      if (profile.ends[0] === "joined") bays.push({ from: 0, to: at(0), crown: 0 });
      if (profile.ends[1] === "joined") bays.push({ from: at(count - 1), to: length, crown: length });
      for (const bay of bays) {
        if (under.some((c) => c.cls !== "stream" && c.d > bay.from - c.half - 1 && c.d < bay.to + c.half + 1)) continue; // a road goes through here: left open
        const reach = Math.max(bay.crown - bay.from, bay.to - bay.crown);
        const springs = [bay.from, bay.to].filter((d) => Math.abs(d - bay.crown) > 0.5).map((d) => sampleAt(line, d));
        const feet = springs.filter((s): s is Sample => !!s);
        if (feet.length === 0) continue;
        const room = Math.min(...feet.map((s) => s.top - depth - Math.max(0, ctx.ground(s.wx, s.wy))));
        const rise = Math.min(room * 0.75, reach * 0.95, 14);
        if (rise < 1.2) continue;
        const open = (s: Sample): number => s.top - depth - 0.5 - rise * (1 - Math.sqrt(Math.max(0, 1 - ((s.d - bay.crown) / reach) ** 2)));
        const steps = Math.max(2, Math.ceil((bay.to - bay.from) / 2.5));
        for (let k = 0; k < steps; k++) {
          const d0 = bay.from + ((bay.to - bay.from) * k) / steps, d1 = bay.from + ((bay.to - bay.from) * (k + 1)) / steps;
          const mid = sampleAt(line, (d0 + d1) / 2), a = sampleAt(line, d0), c = sampleAt(line, d1);
          if (!mid || !a || !c || !inChunk(ctx, mid)) continue;
          const corner = (s: Sample, o: number, z: number): [number, number, number] => [s.e + s.tn * o, s.n - s.te * o, z];
          for (const side of [1, -1]) {
            panel(body, [corner(a, side * half, open(a)), corner(c, side * half, open(c)), corner(c, side * half, c.top - depth), corner(a, side * half, a.top - depth)], [mid.tn * side, -mid.te * side, 0]);
          }
          panel(body, [corner(a, -half, open(a)), corner(a, half, open(a)), corner(c, half, open(c)), corner(c, -half, open(c))], [0, 0, -1]);
        }
      }
    }
  }
}

// ---------------------------------------------------------------- the giants

interface RunLine { id: number; pts: Pt[]; along: number[]; h: number[]; width: number; run: number }

/** The point of a run so many metres along it from its western end, and the height of the deck there. */
function onRun(run: RunLine, a: number): { wx: number; wy: number; h: number } {
  const n = run.along.length;
  let i = 1;
  while (i < n - 1 && run.along[i] < a) i++;
  const f = run.along[i] === run.along[i - 1] ? 0 : Math.min(1, Math.max(0, (a - run.along[i - 1]) / (run.along[i] - run.along[i - 1])));
  return {
    wx: run.pts[i - 1][0] + (run.pts[i][0] - run.pts[i - 1][0]) * f, wy: run.pts[i - 1][1] + (run.pts[i][1] - run.pts[i - 1][1]) * f,
    h: run.h[i - 1] + (run.h[i] - run.h[i - 1]) * f,
  };
}

/**
 * A great steel arch over the middle of each giant: two ribs rising over the deck, hangers down to
 * it, braces between, a stone tower at each foot. Carriageways side by side share one arch.
 */
function arches(ctx: SpanCtx, spans: Spans): void {
  const runs = new Map<number, { id: number; parts: Profile[] }>();
  for (const p of spans.profiles.values()) {
    if (p.way.kind !== "bridge" || !p.simple || p.way.cls === "path" || p.run < GIANT_RUN_M || p.sea < GIANT_SEA_M) continue;
    const had = runs.get(p.runOf);
    if (had) had.parts.push(p); else runs.set(p.runOf, { id: p.runOf, parts: [p] });
  }
  if (runs.size === 0) return;
  const lines: RunLine[] = [...runs.values()].sort((a, b) => a.id - b.id).map(({ id, parts }) => {
    const all = parts.flatMap((p) => p.pts.map((pt, i) => ({ pt, along: p.along[i], h: p.h[i] }))).sort((a, b) => a.along - b.along);
    const kept = all.filter((q, i) => i === 0 || q.along - all[i - 1].along > 0.01);
    return { id, pts: kept.map((q) => q.pt), along: kept.map((q) => q.along), h: kept.map((q) => q.h), width: Math.max(...parts.map((p) => p.way.width)), run: parts[0].run };
  }).filter((l) => l.along.length >= 2 && l.along[l.along.length - 1] > l.run * 0.9); // (the whole run is known)
  const S = ctx.S;
  // Carriageways whose middles are close together are one bridge.
  const groups: RunLine[][] = [];
  for (const line of lines) {
    const m = onRun(line, line.run / 2);
    const home = groups.find((g) => { const o = onRun(g[0], g[0].run / 2); return Math.hypot(o.wx - m.wx, o.wy - m.wy) * S < 90; });
    if (home) home.push(line); else groups.push([line]);
  }
  const steel = ctx.sec(ctx.painted(ctx.mats.structure, STEEL));
  const stone = ctx.sec(ctx.painted(ctx.mats.structure, STONE));
  const cable = ctx.sec(ctx.painted(ctx.mats.railing, STEEL));
  for (const group of groups) {
    const own = group[0];
    const mid = own.run / 2;
    const m = onRun(own, mid), a = onRun(own, mid - 25), b = onRun(own, mid + 25);
    let de = (b.wx - a.wx) * S, dn = -(b.wy - a.wy) * S;
    const dl = Math.hypot(de, dn) || 1;
    de /= dl;
    dn /= dl;
    // Across the bridge: how far the outermost carriageways reach each side of the first one's middle.
    let lo = -own.width / 2, hi = own.width / 2;
    for (const line of group) {
      const o = onRun(line, line.run / 2);
      const off = (o.wx - m.wx) * S * dn + -(o.wy - m.wy) * S * -de; // to the right of the way it runs is (dn, -de)
      lo = Math.min(lo, off - line.width / 2);
      hi = Math.max(hi, off + line.width / 2);
    }
    lo -= 1.6;
    hi += 1.6;
    const span = Math.min(320, Math.max(140, Math.round((0.28 * own.run) / 16) * 16));
    const rise = span * 0.18;
    const deckAt = (s: number): number => onRun(own, mid + s).h + SURFACE_M;
    const ribAt = (s: number): number => deckAt(s) - 3 + (rise + 3) * (1 - ((2 * s) / span) ** 2);
    const world = (s: number, o: number): Pt => [m.wx + (de * s + dn * o) / S, m.wy - (dn * s - de * o) / S];
    const frame = (s: number, o: number): Frame & { wx: number; wy: number } => {
      const [wx, wy] = world(s, o);
      return { e: (wx - ctx.cx) * S, n: -(wy - ctx.cy) * S, te: de, tn: dn, wx, wy };
    };
    for (const o of [lo, hi]) {
      const pts: Pt[] = [], d: number[] = [], z: number[] = [];
      for (let s = -span / 2; s <= span / 2 + 0.01; s += 8) { pts.push(world(s, o)); d.push(s + span / 2); z.push(ribAt(s)); }
      for (const line of samplesOf(ctx, pts, d, z, 3 / S)) {
        strip(steel, line, -0.8, (q) => q.top + 0.9, 0.8, (q) => q.top + 0.9, 0, 1);
        strip(steel, line, -0.8, (q) => q.top - 0.9, 0.8, (q) => q.top - 0.9, 0, -1);
        for (const side of [1, -1]) strip(steel, line, side * 0.8, (q) => q.top - 0.9, side * 0.8, (q) => q.top + 0.9, side, 0);
      }
      for (let s = -span / 2 + 16; s < span / 2 - 1; s += 16) {
        const f = frame(s, o);
        if (inChunk(ctx, f) && ribAt(s) - 0.9 - deckAt(s) > 3) block(cable, f, 0, 0.14, 0.14, deckAt(s), ribAt(s) - 0.9);
      }
      // The towers the arch springs from.
      for (const s of [-span / 2, span / 2]) {
        const f = frame(s, o + (o === lo ? -2.4 : 2.4));
        if (!inChunk(ctx, f)) continue;
        const foot = ctx.ground(f.wx, f.wy);
        block(stone, f, 0, 3.2, 2.4, foot <= 0.05 ? -4 : foot - 1, deckAt(s) + 9, true);
      }
    }
    for (let s = -span / 2 + 32; s < span / 2 - 1; s += 32) {
      const f = frame(s, (lo + hi) / 2);
      if (inChunk(ctx, f) && ribAt(s) - deckAt(s) > 8) block(steel, f, 0, 0.35, (hi - lo) / 2 + 0.8, ribAt(s) - 0.3, ribAt(s) + 0.5, true);
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
  arches(ctx, spans);
  if (ramps.size) for (const road of features.roads) {
    const r = ramps.get(road.id);
    if (r) ramp(ctx, road, r);
  }
}
