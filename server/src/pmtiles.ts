// Reads one map tile at a time out of a PMTiles archive (version 3) that lies on somebody else's server,
// with HTTP range requests, and decodes the vector tile inside it. An archive of the whole world is tens or
// hundreds of gigabytes; one tile of it is three small reads: the archive's root directory (once), the leaf
// directory that covers the place, and the tile itself.
//
// Nothing here knows what the tiles hold: overture.ts does.

import { gunzipSync } from "node:zlib";

/** Reads `length` bytes of the archive from `offset`. */
export type RangeReader = (offset: number, length: number, signal?: AbortSignal) => Promise<Buffer>;

interface Header {
  rootOffset: number; rootLength: number; leafOffset: number; dataOffset: number;
  internalCompression: number; tileCompression: number; minZoom: number; maxZoom: number;
}
/** A directory, as four columns: where each run of tiles starts, how many tiles it is, and where its bytes are. */
interface Directory { ids: Float64Array; runs: Uint32Array; lengths: Uint32Array; offsets: Float64Array }

const HEADER_BYTES = 127;
/** The header and the root directory are in the first 16 KB of every archive, by the format's own rule. */
const FIRST_BYTES = 16384;

/** A whole number of any size from a protobuf varint, as a double (exact up to 2^53). */
function varint(buf: Buffer, at: { pos: number }): number {
  let value = 0;
  let scale = 1;
  for (;;) {
    if (at.pos >= buf.length) throw new Error("a number runs off the end of the data");
    const byte = buf[at.pos++];
    value += (byte & 0x7f) * scale;
    if (byte < 0x80) return value;
    scale *= 128;
  }
}

function u64(buf: Buffer, pos: number): number {
  return buf.readUInt32LE(pos) + buf.readUInt32LE(pos + 4) * 2 ** 32;
}

function unpack(buf: Buffer, compression: number): Buffer {
  if (compression === 2) return gunzipSync(buf);
  if (compression === 1 || compression === 0) return buf;
  throw new Error(`packed in a way this does not read (${compression})`);
}

export function readHeader(buf: Buffer): Header {
  if (buf.length < HEADER_BYTES || buf.toString("latin1", 0, 7) !== "PMTiles" || buf[7] !== 3) throw new Error("not a PMTiles archive of version 3");
  return {
    rootOffset: u64(buf, 8), rootLength: u64(buf, 16), leafOffset: u64(buf, 40), dataOffset: u64(buf, 56),
    internalCompression: buf[97], tileCompression: buf[98], minZoom: buf[100], maxZoom: buf[101],
  };
}

export function readDirectory(buf: Buffer): Directory {
  const at = { pos: 0 };
  const n = varint(buf, at);
  if (n > 5_000_000) throw new Error("a directory too big to be one");
  const dir: Directory = { ids: new Float64Array(n), runs: new Uint32Array(n), lengths: new Uint32Array(n), offsets: new Float64Array(n) };
  let id = 0;
  for (let i = 0; i < n; i++) dir.ids[i] = id += varint(buf, at);
  for (let i = 0; i < n; i++) dir.runs[i] = varint(buf, at);
  for (let i = 0; i < n; i++) dir.lengths[i] = varint(buf, at);
  for (let i = 0; i < n; i++) {
    const v = varint(buf, at);
    dir.offsets[i] = v === 0 && i > 0 ? dir.offsets[i - 1] + dir.lengths[i - 1] : v - 1;
  }
  return dir;
}

/** A tile's number in the archive: every zoom after the one before, each along a Hilbert curve. */
export function tileId(z: number, x: number, y: number): number {
  let id = (4 ** z - 1) / 3;
  let tx = x, ty = y;
  for (let s = 2 ** z / 2; s >= 1; s /= 2) {
    const rx = (tx & s) > 0 ? 1 : 0;
    const ry = (ty & s) > 0 ? 1 : 0;
    id += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { tx = s - 1 - tx; ty = s - 1 - ty; }
      [tx, ty] = [ty, tx];
    }
  }
  return id;
}

/** The last entry of a directory that starts at or before a tile. */
function find(dir: Directory, id: number): number {
  let lo = 0, hi = dir.ids.length - 1, at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dir.ids[mid] <= id) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return at;
}

/**
 * One archive. The header and root directory are read once and kept (a few kilobytes); of the leaf
 * directories, which are 10 to 50 KB each decoded, only the last few used are kept. `spent` counts the
 * bytes asked for and the requests made, for whoever wants to know what a tile cost.
 */
export class PmArchive {
  private start: Promise<{ header: Header; root: Directory }> | null = null;
  private readonly leaves = new Map<string, Promise<Directory>>();
  private readonly read: RangeReader;
  private readonly keepLeaves: number;
  readonly spent = { bytes: 0, requests: 0 };

  constructor(read: RangeReader, keepLeaves = 4) {
    this.read = read;
    this.keepLeaves = keepLeaves;
  }

  private async range(offset: number, length: number, signal?: AbortSignal): Promise<Buffer> {
    const buf = await this.read(offset, length, signal);
    this.spent.bytes += buf.length;
    this.spent.requests++;
    return buf;
  }

  private open(signal?: AbortSignal): Promise<{ header: Header; root: Directory }> {
    if (!this.start) {
      const start = this.range(0, FIRST_BYTES, signal).then(async (first) => {
        const header = readHeader(first);
        const end = header.rootOffset + header.rootLength;
        const packed = end <= first.length ? first.subarray(header.rootOffset, end) : await this.range(header.rootOffset, header.rootLength, signal);
        return { header, root: readDirectory(unpack(packed, header.internalCompression)) };
      });
      // A failed start is not kept: the next tile asked for tries again.
      start.catch(() => { if (this.start === start) this.start = null; });
      this.start = start;
    }
    return this.start;
  }

  private leaf(header: Header, offset: number, length: number, signal?: AbortSignal): Promise<Directory> {
    const key = `${offset}/${length}`;
    let dir = this.leaves.get(key);
    if (dir) {
      this.leaves.delete(key); // so that it counts as the newest
      this.leaves.set(key, dir);
      return dir;
    }
    dir = this.range(header.leafOffset + offset, length, signal).then((packed) => readDirectory(unpack(packed, header.internalCompression)));
    dir.catch(() => { if (this.leaves.get(key) === dir) this.leaves.delete(key); });
    this.leaves.set(key, dir);
    while (this.leaves.size > this.keepLeaves) this.leaves.delete(this.leaves.keys().next().value!);
    return dir;
  }

  /** The deepest zoom the archive has tiles at. */
  async maxZoom(signal?: AbortSignal): Promise<number> {
    return (await this.open(signal)).header.maxZoom;
  }

  /** One tile, unpacked; null where the archive has nothing there (open sea, or a zoom it does not go to). */
  async tile(z: number, x: number, y: number, signal?: AbortSignal): Promise<Buffer | null> {
    const { header, root } = await this.open(signal);
    if (z < header.minZoom || z > header.maxZoom) return null;
    const id = tileId(z, x, y);
    let dir = root;
    for (let depth = 0; depth < 4; depth++) {
      const at = find(dir, id);
      if (at < 0) return null;
      if (dir.runs[at] === 0) {
        dir = await this.leaf(header, dir.offsets[at], dir.lengths[at], signal);
        continue;
      }
      if (id - dir.ids[at] >= dir.runs[at]) return null;
      return unpack(await this.range(header.dataOffset + dir.offsets[at], dir.lengths[at], signal), header.tileCompression);
    }
    throw new Error("directories nested too deep");
  }
}

// ---------------------------------------------------------------- vector tiles

export type MvtValue = string | number | boolean;
/** One thing in a vector tile, not yet unpacked. `type` is 1 for points, 2 for lines, 3 for areas. */
export interface MvtFeature { id: number; type: number; tags: number[]; g0: number; g1: number }

/** Twice the signed area of a ring in tile units: positive for an outline, negative for a hole. */
export function ringArea(ring: [number, number][]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += (ring[j][0] - ring[i][0]) * (ring[i][1] + ring[j][1]);
  return sum;
}

/** Walks the fields of a protobuf message. Calls back with each field's number, wire type, and where its value is. */
function fields(buf: Buffer, start: number, end: number, each: (field: number, wire: number, from: number, to: number, value: number) => void): void {
  const at = { pos: start };
  while (at.pos < end) {
    const key = varint(buf, at);
    const field = Math.floor(key / 8), wire = key & 7;
    if (wire === 0) { const from = at.pos; const value = varint(buf, at); each(field, wire, from, at.pos, value); }
    else if (wire === 2) { const len = varint(buf, at); each(field, wire, at.pos, at.pos + len, len); at.pos += len; }
    else if (wire === 5) { each(field, wire, at.pos, at.pos + 4, 0); at.pos += 4; }
    else if (wire === 1) { each(field, wire, at.pos, at.pos + 8, 0); at.pos += 8; }
    else throw new Error("a vector tile with something in it that cannot be read");
    if (at.pos > end) throw new Error("a vector tile cut short");
  }
}

const zigzag = (n: number): number => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

/**
 * One layer of a vector tile. A city tile carries a dozen properties a feature, some of them long (where
 * each came from, as JSON), and most callers want three; so nothing of a feature is unpacked until it is
 * asked for: `prop` for one property, `rings` for its shape.
 */
export class MvtLayer {
  readonly name: string;
  readonly extent: number;
  readonly features: MvtFeature[] = [];
  private readonly buf: Buffer;
  private readonly keys: string[];
  private readonly spans: number[];
  private readonly unpacked: (MvtValue | undefined)[];

  constructor(buf: Buffer, name: string, extent: number, keys: string[], valueSpans: number[]) {
    this.buf = buf;
    this.name = name;
    this.extent = extent;
    this.keys = keys;
    this.spans = valueSpans;
    this.unpacked = new Array<MvtValue | undefined>(valueSpans.length / 2);
  }

  private value(i: number): MvtValue | undefined {
    if (i < 0 || i >= this.unpacked.length) return undefined;
    let value = this.unpacked[i];
    if (value === undefined) {
      const buf = this.buf;
      value = "";
      fields(buf, this.spans[i * 2], this.spans[i * 2 + 1], (f, w, a, b, v) => {
        if (f === 1 && w === 2) value = buf.toString("utf8", a, b);
        else if (f === 2 && w === 5) value = buf.readFloatLE(a);
        else if (f === 3 && w === 1) value = buf.readDoubleLE(a);
        else if ((f === 4 || f === 5) && w === 0) value = v;
        else if (f === 6 && w === 0) value = zigzag(v);
        else if (f === 7 && w === 0) value = v !== 0;
      });
      this.unpacked[i] = value;
    }
    return value;
  }

  /** One property of a feature; undefined where it has none of that name. */
  prop(f: MvtFeature, key: string): MvtValue | undefined {
    const k = this.keys.indexOf(key);
    if (k < 0) return undefined;
    for (let i = 0; i + 1 < f.tags.length; i += 2) if (f.tags[i] === k) return this.value(f.tags[i + 1]);
    return undefined;
  }

  /** Every property of a feature. */
  props(f: MvtFeature): Record<string, MvtValue> {
    const out: Record<string, MvtValue> = {};
    for (let i = 0; i + 1 < f.tags.length; i += 2) {
      const key = this.keys[f.tags[i]], value = this.value(f.tags[i + 1]);
      if (key !== undefined && value !== undefined) out[key] = value;
    }
    return out;
  }

  /**
   * A feature's points (one ring of one point each, for points), in the tile's own grid: 0 to `extent`
   * across, x east, y south. An area's outlines have a positive `ringArea`, its holes a negative one, each
   * hole after its outline. A ring's first point is not repeated at its end.
   */
  rings(f: MvtFeature): [number, number][][] {
    const buf = this.buf;
    const rings: [number, number][][] = [];
    const at = { pos: f.g0 };
    let x = 0, y = 0;
    let ring: [number, number][] | null = null;
    while (at.pos < f.g1) {
      const command = varint(buf, at);
      const op = command & 7;
      let count = Math.floor(command / 8);
      if (op === 7) continue;
      if (op !== 1 && op !== 2) throw new Error("a vector tile with a shape that cannot be read");
      while (count-- > 0) {
        x += zigzag(varint(buf, at));
        y += zigzag(varint(buf, at));
        if (op === 1) rings.push(ring = []);
        ring?.push([x, y]);
      }
    }
    return rings;
  }
}

/** The layers of a Mapbox vector tile; only those `want` chooses, when it is given. */
export function decodeMvt(buf: Buffer, want?: (layer: string) => boolean): MvtLayer[] {
  const layers: MvtLayer[] = [];
  fields(buf, 0, buf.length, (field, wire, from, to) => {
    if (field !== 3 || wire !== 2) return;
    let name = "";
    let extent = 4096;
    const keys: string[] = [];
    const values: number[] = [];
    const spans: number[] = [];
    fields(buf, from, to, (f, w, a, b, v) => {
      if (f === 1 && w === 2) name = buf.toString("utf8", a, b);
      else if (f === 2 && w === 2) spans.push(a, b);
      else if (f === 3 && w === 2) keys.push(buf.toString("utf8", a, b));
      else if (f === 4 && w === 2) values.push(a, b);
      else if (f === 5 && w === 0) extent = v;
    });
    if (want && !want(name)) return;
    const layer = new MvtLayer(buf, name, extent, keys, values);
    for (let s = 0; s < spans.length; s += 2) {
      const feature: MvtFeature = { id: 0, type: 0, tags: [], g0: 0, g1: 0 };
      fields(buf, spans[s], spans[s + 1], (f, w, a, b, v) => {
        if (f === 1 && w === 0) feature.id = v;
        else if (f === 3 && w === 0) feature.type = v;
        else if (f === 4 && w === 2) { feature.g0 = a; feature.g1 = b; }
        else if (f === 2 && w === 2) {
          const at = { pos: a };
          while (at.pos < b) feature.tags.push(varint(buf, at));
        }
      });
      layer.features.push(feature);
    }
    layers.push(layer);
  });
  return layers;
}

/** A reader of ranges of one address on the web. */
export function httpRanges(url: string, userAgent: string, timeoutMs = 20_000): RangeReader {
  return async (offset, length, signal) => {
    const res = await fetch(url, {
      headers: { "User-Agent": userAgent, Range: `bytes=${offset}-${offset + length - 1}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
    if (res.status !== 206 && res.status !== 200) {
      void res.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${res.status}`);
    }
    // A server that ignores the range sends the whole file: never read 180 GB to find that out.
    if (res.status === 200 && !(Number(res.headers.get("content-length")) <= offset + length)) {
      void res.body?.cancel().catch(() => undefined);
      throw new Error("the server does not answer for a part of the file");
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return res.status === 200 ? buf.subarray(offset, offset + length) : buf;
  };
}
