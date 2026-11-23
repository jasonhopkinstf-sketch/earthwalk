// What the ground is covered with, and how tall the trees stand, from two open maps of the whole Earth
// made from satellite pictures:
// - ESA WorldCover (2021, 10 m): each spot is one of eleven kinds: trees, shrubs, grass, crops, built-up,
//   bare, snow, water, wetland, mangroves, moss. © ESA WorldCover project 2021 / Contains modified
//   Copernicus Sentinel data (2021) processed by ESA WorldCover consortium. CC BY 4.0.
// - Meta and the World Resources Institute's canopy heights (2024), in their 28 m form: how tall the
//   tallest trees of each spot are. CC BY 4.0.
// Both lie on Amazon's open-data servers as GeoTIFFs of hundreds of megabytes; a block's worth is one or
// two reads of each (geotiff.ts). What is kept for a block is small: a grid of kinds at the size of the
// ground's own cells, and a coarser one of heights.
//
// The map still comes first: this only fills in where OpenStreetMap says nothing (chunk.ts).

import { deflateSync, inflateSync } from "node:zlib";
import { BLOCK_Z, DATA_Z } from "./osm.ts";
import { xToLon, yToLat } from "./geo.ts";
import { readTiffIndex, readWindow, type TiffIndex } from "./geotiff.ts";
import { Late } from "./late.ts";
import { Pool } from "./net.ts";
import { httpRanges, type RangeReader } from "./pmtiles.ts";

/** Cells across a block in the grid of kinds: the same as the ground's own cells (4 chunks of 64). */
export const COVER_N = 256;
/** Cells across a block in the grid of tree heights (about 30 m each, which is what the map has). */
export const TALL_N = 64;
/** A tree height that is not known. */
export const TALL_UNKNOWN = 255;

/** WorldCover's kinds, by its own numbers. 0 is "no data". */
export const COVER = { trees: 10, shrubs: 20, grass: 30, crops: 40, built: 50, bare: 60, snow: 70, water: 80, wetland: 90, mangroves: 95, moss: 100 } as const;

/**
 * A block's ground cover. `kinds` is COVER_N by COVER_N of WorldCover's numbers, west to east then north
 * to south; `tall` is TALL_N by TALL_N of tree heights in metres (TALL_UNKNOWN where the map has none).
 */
export interface Cover { bx: number; by: number; kinds: Uint8Array; tall: Uint8Array }

const ON = process.env.EARTHWALK_COVER !== "0";
const COVER_URL = (process.env.EARTHWALK_WORLDCOVER_URL ?? "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map").replace(/\/+$/, "");
const CANOPY_URL = (process.env.EARTHWALK_CANOPY_URL ?? "https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float_epsg4326_v3_10deg").replace(/\/+$/, "");
const AGENT = "earthwalk-server/0.1";

/** The kind at a cell of a block's grid, by the world coordinates of a point in it (at the block's own zoom). */
export function kindAt(cover: Cover, bxf: number, byf: number): number {
  const i = Math.floor((bxf - cover.bx) * COVER_N), j = Math.floor((byf - cover.by) * COVER_N);
  return i < 0 || j < 0 || i >= COVER_N || j >= COVER_N ? 0 : cover.kinds[j * COVER_N + i];
}
/** How tall the trees stand at a point (metres), or TALL_UNKNOWN. */
export function tallAt(cover: Cover, bxf: number, byf: number): number {
  const i = Math.floor((bxf - cover.bx) * TALL_N), j = Math.floor((byf - cover.by) * TALL_N);
  return i < 0 || j < 0 || i >= TALL_N || j >= TALL_N ? TALL_UNKNOWN : cover.tall[j * TALL_N + i];
}

/**
 * Takes the speckle out of a grid of kinds: a cell that none of its four neighbours agrees with takes the
 * kind most of them have. Satellites see single 10 m spots of this and that everywhere; the world is
 * drawn in patches.
 */
export function smoothKinds(kinds: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(kinds);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const own = kinds[j * n + i];
      const near = [i > 0 ? kinds[j * n + i - 1] : own, i < n - 1 ? kinds[j * n + i + 1] : own, j > 0 ? kinds[(j - 1) * n + i] : own, j < n - 1 ? kinds[(j + 1) * n + i] : own];
      if (near.includes(own)) continue;
      let best = own, most = 1;
      for (const k of near) {
        const count = near.filter((o) => o === k).length;
        if (count > most) { most = count; best = k; }
      }
      out[j * n + i] = best;
    }
  }
  return out;
}

const MAGIC = "EWCV1";
export function encodeCover(cover: Cover): Buffer {
  return Buffer.concat([Buffer.from(MAGIC, "latin1"), deflateSync(Buffer.concat([cover.kinds, cover.tall]))]);
}
export function decodeCover(kept: Buffer, bx: number, by: number): Cover {
  if (kept.toString("latin1", 0, MAGIC.length) !== MAGIC) throw new Error("not a block of ground cover");
  const raw = inflateSync(kept.subarray(MAGIC.length));
  if (raw.length !== COVER_N * COVER_N + TALL_N * TALL_N) throw new Error("a block of ground cover of the wrong size");
  return { bx, by, kinds: new Uint8Array(raw.subarray(0, COVER_N * COVER_N)), tall: new Uint8Array(raw.subarray(COVER_N * COVER_N)) };
}

// ---------------------------------------------------------------- the two maps' files

const pad = (v: number, digits: number): string => String(Math.abs(v)).padStart(digits, "0");
/** The WorldCover file a spot is in: they are 3 degrees square, named by their south-west corner. */
export function coverFile(lat: number, lon: number): string {
  const la = Math.floor(lat / 3) * 3, lo = Math.floor(lon / 3) * 3;
  return `ESA_WorldCover_10m_2021_v200_${la < 0 ? "S" : "N"}${pad(la, 2)}${lo < 0 ? "W" : "E"}${pad(lo, 3)}_Map.tif`;
}
/**
 * The canopy file a spot is in: 10 degrees square, named by their north-west corner. The names write
 * nought both as "0.0" and as "-0.0", so there are two to try for a file along the equator or Greenwich.
 */
export function canopyFiles(lat: number, lon: number): string[] {
  const la = Math.ceil(lat / 10) * 10, lo = Math.floor(lon / 10) * 10;
  const ways = (v: number): string[] => (v === 0 ? ["-0.0", "0.0"] : [v.toFixed(1)]);
  const out: string[] = [];
  for (const a of ways(la)) for (const o of ways(lo)) out.push(`meta_chm_lat=${a}_lon=${o}_p95.tif`);
  return out;
}

/** Opens a file of one of the maps: something that reads ranges of it. Null says there is no such file (open sea). */
export type Opener = (url: string) => RangeReader;
interface Open { read: RangeReader; index: TiffIndex | null }

/** The few files last used, with their indexes: a 3 degree file's is 20 KB, a 10 degree one's 640 KB. */
const files = new Map<string, Promise<Open>>();
const KEEP_FILES = 4;
function openFile(url: string, opener: Opener): Promise<Open> {
  let file = files.get(url);
  if (file) {
    files.delete(url);
    files.set(url, file);
    return file;
  }
  const read = opener(url);
  file = readTiffIndex(read).then((index) => ({ read, index }), (err) => {
    // No such file is an answer (there is no land there, or nobody measured it), and is remembered as one.
    if (/HTTP 40[34]/.test(String(err))) return { read, index: null };
    throw err;
  });
  file.catch(() => { if (files.get(url) === file) files.delete(url); });
  files.set(url, file);
  while (files.size > KEEP_FILES) files.delete(files.keys().next().value!);
  return file;
}

/**
 * Samples one map over a block into a grid of `n` cells a side: for each cell, the pixel under its
 * middle. A block lies in one file nearly always, and in two or four at the files' edges.
 */
async function sample(bx: number, by: number, n: number, urlsFor: (lat: number, lon: number) => string[], opener: Opener, fill: number, each: (value: number) => number): Promise<Uint8Array> {
  const out = new Uint8Array(n * n).fill(fill);
  const lons = Array.from({ length: n }, (_, i) => xToLon(bx + (i + 0.5) / n, BLOCK_Z));
  const lats = Array.from({ length: n }, (_, j) => yToLat(by + (j + 0.5) / n, BLOCK_Z));
  // Which file each cell is in, by the first of its names.
  const groups = new Map<string, { urls: string[]; cells: number[] }>();
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const urls = urlsFor(lats[j], lons[i]);
      let g = groups.get(urls[0]);
      if (!g) groups.set(urls[0], g = { urls, cells: [] });
      g.cells.push(j * n + i);
    }
  }
  for (const g of groups.values()) {
    let open: Open | null = null;
    for (const url of g.urls) {
      open = await openFile(url, opener);
      if (open.index) break;
    }
    const t = open?.index;
    if (!open || !t) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const at = g.cells.map((c) => {
      const px = Math.floor((lons[c % n] - t.west) / t.pixelLon), py = Math.floor((t.north - lats[Math.floor(c / n)]) / t.pixelLat);
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      return [px, py];
    });
    x0 = Math.max(0, x0); y0 = Math.max(0, y0);
    const win = await readWindow(open.read, t, x0, y0, x1, y1);
    g.cells.forEach((c, k) => {
      const px = at[k][0] - x0, py = at[k][1] - y0;
      if (px >= 0 && py >= 0 && px < win.width && py < win.height) out[c] = each(win.data[py * win.width + px]);
    });
  }
  return out;
}

/** Downloads a block's ground cover and tree heights. */
export async function downloadCover(bx: number, by: number, opener: Opener = (url) => httpRanges(url, AGENT, 30_000)): Promise<Cover> {
  const [kinds, tall] = await Promise.all([
    sample(bx, by, COVER_N, (lat, lon) => [`${COVER_URL}/${coverFile(lat, lon)}`], opener, 0, (v) => v),
    // Centimetres in the file (65535 where nothing was measured); whole metres here, 60 at most.
    sample(bx, by, TALL_N, (lat, lon) => canopyFiles(lat, lon).map((name) => `${CANOPY_URL}/${name}`), opener, TALL_UNKNOWN, (v) => (v === 65535 ? TALL_UNKNOWN : Math.min(60, Math.round(v / 100)))),
  ]);
  return { bx, by, kinds: smoothKinds(kinds, COVER_N), tall };
}

const pool = new Pool(2, 60);
const say = (line: string): void => { if (process.env.EARTHWALK_QUIET_MAP !== "1") console.log(line); };
/** Which block each kept file is being read for: a file does not say where it is from. */
const late = new Late<Cover>({
  name: "ground cover",
  rel: (bx, by) => `cover/v1/${BLOCK_Z}/${bx}/${by}.bin`,
  owedRel: "cover/owed.json",
  fetch: (bx, by, quiet) => pool.add(() => downloadCover(bx, by), quiet).promise,
  encode: encodeCover,
  decode: (kept) => decodeCover(kept, 0, 0),
  waitMs: 4000,
  say,
});

export const coverOn = (): boolean => ON;

/** The few blocks last read, so that the four data tiles of a block share one. */
const recent = new Map<string, Cover>();

/**
 * The ground cover of the block a data tile is in. Null when it is not in the cache and does not come
 * within a few seconds: the block is then owed it, and what is built there is built again when it comes.
 */
export async function fetchCover(dx: number, dy: number): Promise<Cover | null> {
  const d = DATA_Z - BLOCK_Z;
  const bx = dx >> d, by = dy >> d;
  const key = `${bx}/${by}`;
  const had = recent.get(key);
  if (had) return had;
  const got = await late.get(bx, by);
  if (!got) return null;
  const cover: Cover = { ...got, bx, by };
  recent.set(key, cover);
  while (recent.size > 12) recent.delete(recent.keys().next().value!);
  return cover;
}
export function onCover(listener: (bx: number, by: number) => void): void {
  late.onArrive(listener);
}
/** How many blocks are waiting for their ground cover (for the admin screen). */
export const coverOwed = (): number => late.owedCount;
export function keepCoverComing(everyMs?: number): void {
  late.keepComing(everyMs);
}
