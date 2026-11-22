// Trains. A railway runs for many kilometres, far beyond the piece of map a chunk is built from, so
// the tracks are taken for a wider square of the world (a zoom-14 tile, 4 by 4 chunks) and joined into
// runs there. Every chunk in the square gets its trains from the same tracks, which is what lets every
// player see the same train.
//
// The square is one block of the map download (osm.ts), so the tracks come with the map the chunk is
// built from anyway. They used to be asked for separately, from the Overpass servers alone, and on
// those servers' bad days there were simply no trains.
//
// A train shuttles along its run: out, a wait, and back, pausing at stations. As with cars
// (traffic.ts), the server works out where the train is at each second of the trip and clients
// replay it from the shared clock (docs/PROTOCOL.md, "Trains").

import { CHUNK_Z, hash32, latToY, lonToX, metersPerTile } from "./geo.ts";
import { clipPolyline } from "./chunk.ts";
import { BLOCK_Z, DATA_Z, fetchOsmTile, type OsmJson, type Pt } from "./osm.ts";

export const RAIL_Z = BLOCK_Z;
/** Chunks along one side of a rail square. */
export const RAIL_SPAN = 2 ** (CHUNK_Z - RAIL_Z);
export const TRAINS_PER_SQUARE = 6;

export interface RailData { lines: { id: number; pts: Pt[] }[]; stations: Pt[] }
/** A train and its trip: `path` is [x, y, seconds since setting off], a point every 12 m; it waits `wa` and `wb` seconds at the ends. */
export interface Train { id: number; wa: number; wb: number; path: [number, number, number][] }

const MIN_RUN_M = 400;
const STEP_M = 12;
const PACE = 14; // metres a second: a slow, friendly train
const ACCEL = 0.5;
const CRAWL = 0.6; // pace when setting off and when drawing in
const STATION_NEAR_M = 80;
const STATION_STOP_S = 14;

// ---------------------------------------------------------------- the tracks of a square

/** The railway tracks and stations of one rail square, out of the map of its four data tiles. */
export async function fetchRail(rx: number, ry: number): Promise<OsmJson> {
  const per = 2 ** (DATA_Z - RAIL_Z);
  const tiles: Promise<OsmJson>[] = [];
  for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) tiles.push(fetchOsmTile(rx * per + i, ry * per + j));
  const seen = new Set<number>();
  const elements: OsmJson["elements"] = [];
  for (const tile of await Promise.all(tiles)) {
    for (const el of tile.elements) {
      // A track that crosses from one tile into the next is in both, whole: once is enough.
      if (el.type === "node") elements.push(el);
      else if (el.type === "way" && el.tags?.railway === "rail" && !seen.has(el.id)) {
        seen.add(el.id);
        elements.push(el);
      }
    }
  }
  return { elements };
}

/** Main-line tracks that are drawn (not in tunnels, not sidings) and the stations, in world coordinates. */
export function parseRail(json: OsmJson): RailData {
  const nodes = new Map<number, Pt>();
  const stations: Pt[] = [];
  for (const el of json.elements) {
    if (el.type !== "node" || el.lat === undefined || el.lon === undefined) continue;
    const at: Pt = [lonToX(el.lon, CHUNK_Z), latToY(el.lat, CHUNK_Z)];
    nodes.set(el.id, at);
    if (el.tags?.railway === "station" || el.tags?.railway === "halt") stations.push(at);
  }
  const lines: RailData["lines"] = [];
  for (const el of json.elements) {
    const tags = el.tags;
    if (el.type !== "way" || !el.nodes || tags?.railway !== "rail" || tags.service) continue;
    if ((tags.tunnel && tags.tunnel !== "no") || parseFloat(tags.layer ?? "0") < 0) continue;
    const pts = el.nodes.map((id) => nodes.get(id)).filter((p): p is Pt => !!p);
    if (pts.length >= 2) lines.push({ id: el.id, pts });
  }
  lines.sort((a, b) => a.id - b.id);
  return { lines, stations };
}

// ---------------------------------------------------------------- runs and timetables

const key = (p: Pt): string => `${p[0]},${p[1]}`;

/**
 * The trains of one rail square. Tracks are cut at the edge of the square and joined end to end,
 * keeping straight on at points; each run of 400 m or more gets one train, the six longest at most.
 */
export function buildTrains(rx: number, ry: number, data: RailData): Train[] {
  const X0 = rx * RAIL_SPAN;
  const Y0 = ry * RAIL_SPAN;
  const S = metersPerTile(Y0 + RAIL_SPAN / 2, CHUNK_Z);
  const metres = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]) * S;
  const pieces = data.lines.flatMap((l) => clipPolyline(l.pts, X0, Y0, X0 + RAIL_SPAN, Y0 + RAIL_SPAN).map((pts) => ({ id: l.id, pts })));
  const ends = new Map<string, { n: number; end: 0 | 1 }[]>();
  pieces.forEach((piece, n) => {
    for (const end of [0, 1] as const) {
      const k = key(end ? piece.pts[piece.pts.length - 1] : piece.pts[0]);
      ends.set(k, [...(ends.get(k) ?? []), { n, end }]);
    }
  });
  const used = new Array<boolean>(pieces.length).fill(false);

  /** Follows the track on from the end of `run`, taking the straightest unused piece at each join. */
  const extend = (run: Pt[]): void => {
    for (;;) {
      const p = run[run.length - 1];
      const before = run[run.length - 2];
      let best: { pts: Pt[]; n: number; turn: number } | null = null;
      for (const { n, end } of ends.get(key(p)) ?? []) {
        if (used[n]) continue;
        const pts = end ? [...pieces[n].pts].reverse() : pieces[n].pts;
        const a: [number, number] = [p[0] - before[0], p[1] - before[1]];
        const b: [number, number] = [pts[1][0] - p[0], pts[1][1] - p[1]];
        const turn = Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]));
        if (turn < 1 && (!best || turn < best.turn)) best = { pts, n, turn };
      }
      if (!best) return;
      used[best.n] = true;
      run.push(...best.pts.slice(1));
    }
  };

  const runs: { first: number; pts: Pt[]; length: number }[] = [];
  pieces.forEach((piece, n) => {
    if (used[n]) return;
    used[n] = true;
    const run = [...piece.pts];
    extend(run);
    run.reverse();
    extend(run);
    let length = 0;
    for (let i = 1; i < run.length; i++) length += metres(run[i - 1], run[i]);
    // Whichever end we started from, the run reads the same way: from its western (or northern) end.
    const [a, b] = [run[0], run[run.length - 1]];
    if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) run.reverse();
    if (length >= MIN_RUN_M) runs.push({ first: piece.id, pts: run, length });
  });
  runs.sort((a, b) => b.length - a.length || a.first - b.first);

  return runs.slice(0, TRAINS_PER_SQUARE).map((run) => timetable(run.pts, run.length, hash32(hash32(run.first, Math.round(run.length)), hash32(rx, ry) ^ 0x7241494c) || 1));

  function timetable(line: Pt[], total: number, id: number): Train {
    // ---- a point every 12 m
    const dist: number[] = [0];
    for (let i = 1; i < line.length; i++) dist.push(dist[i - 1] + metres(line[i - 1], line[i]));
    const count = Math.max(2, Math.round(total / STEP_M));
    const ds = total / count;
    const pts: Pt[] = [];
    for (let n = 0, s = 0; n <= count; n++) {
      const want = n * ds;
      while (s + 2 < line.length && dist[s + 1] < want) s++;
      const f = dist[s + 1] === dist[s] ? 0 : Math.min(1, (want - dist[s]) / (dist[s + 1] - dist[s]));
      pts.push([line[s][0] + (line[s + 1][0] - line[s][0]) * f, line[s][1] + (line[s + 1][1] - line[s][1]) * f]);
    }
    // ---- where it stops: at the points nearest each station, not too close to an end or to each other
    const stops: number[] = [];
    for (const st of data.stations) {
      let best = -1;
      let bestD = STATION_NEAR_M;
      for (let n = 0; n <= count; n++) {
        const d = metres(st, pts[n]);
        if (d < bestD) { bestD = d; best = n; }
      }
      if (best > 6 && best < count - 6 && !stops.some((n) => Math.abs(n - best) * ds < 250)) stops.push(best);
    }
    // ---- the fastest it may go at each point, then no faster than it can speed up to or slow down from
    const cap = pts.map((_, n) => {
      if (n === 0 || n === count || stops.includes(n)) return CRAWL;
      const a: [number, number] = [pts[n][0] - pts[n - 1][0], pts[n][1] - pts[n - 1][1]];
      const b: [number, number] = [pts[n + 1][0] - pts[n][0], pts[n + 1][1] - pts[n][1]];
      const bend = Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]));
      return PACE * Math.min(1, Math.max(0.4, 1 - bend / 0.6));
    });
    for (let n = 1; n <= count; n++) cap[n] = Math.min(cap[n], Math.sqrt(cap[n - 1] ** 2 + 2 * ACCEL * ds));
    for (let n = count - 1; n >= 0; n--) cap[n] = Math.min(cap[n], Math.sqrt(cap[n + 1] ** 2 + 2 * ACCEL * ds));
    const path: Train["path"] = [[pts[0][0], pts[0][1], 0]];
    for (let n = 1, t = 0; n <= count; n++) {
      t += ds / ((cap[n - 1] + cap[n]) / 2);
      path.push([pts[n][0], pts[n][1], Math.round(t * 100) / 100]);
      if (stops.includes(n)) {
        t += STATION_STOP_S; // standing at the platform: the same place, a little later
        path.push([pts[n][0], pts[n][1], Math.round(t * 100) / 100]);
      }
    }
    return { id, wa: 20 + (id % 20), wb: 20 + ((id >>> 8) % 20), path };
  }
}

const built = new Map<string, Train[]>();

/** The trains whose run passes through a chunk. Throws when the tracks cannot be fetched. */
export async function trainsFor(cx: number, cy: number, load = fetchRail): Promise<Train[]> {
  const rx = cx >> (CHUNK_Z - RAIL_Z);
  const ry = cy >> (CHUNK_Z - RAIL_Z);
  const k = `${rx}/${ry}`;
  let trains = built.get(k);
  if (!trains) {
    trains = buildTrains(rx, ry, parseRail(await load(rx, ry)));
    if (built.size >= 32) built.delete(built.keys().next().value!);
    built.set(k, trains);
  }
  const m = 0.05;
  return trains.filter((t) => t.path.some(([x, y]) => x >= cx - m && x <= cx + 1 + m && y >= cy - m && y <= cy + 1 + m));
}
