// Reads a small window out of a big GeoTIFF that lies on somebody else's server, with HTTP range requests.
// Just enough of the format for the two maps the ground cover comes from (cover.ts): one image of 8 or 16
// bits a pixel in plain latitude and longitude, cut either into square tiles packed with deflate (ESA
// WorldCover) or into strips of one row each packed with LZW (Meta's canopy heights). A file is hundreds of
// megabytes; its index is one or three reads, kept in memory, and a window of it is then one read more.

import { inflateSync } from "node:zlib";
import type { RangeReader } from "./pmtiles.ts";

export interface TiffIndex {
  width: number; height: number;
  /** Bytes a pixel: 1 or 2. */
  bytes: number;
  /** 8 for deflate, 5 for LZW, 1 for none. */
  compression: number;
  /** Tiles across and down, or 0 when the image is in strips. */
  tileWidth: number; tileHeight: number; rowsPerStrip: number;
  offsets: Float64Array; counts: Float64Array;
  /** The west and north edges, and the size of a pixel, in degrees. */
  west: number; north: number; pixelLon: number; pixelLat: number;
}

const TYPE_BYTES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 11: 4, 12: 8, 16: 8 };
const FIRST = 65536;

/**
 * The index of a TIFF's first (full-size) image: its shape, and where each tile or strip is. Classic
 * TIFF, little-endian, which is what both maps are.
 */
export async function readTiffIndex(read: RangeReader, signal?: AbortSignal): Promise<TiffIndex> {
  const head = await read(0, FIRST, signal);
  if (head.length < 16 || head.toString("latin1", 0, 2) !== "II" || head.readUInt16LE(2) !== 42) throw new Error("not a TIFF this reads (classic, little-endian)");
  const ifd = head.readUInt32LE(4);
  if (ifd + 2 > head.length) throw new Error("the TIFF's index is not at its start");
  const n = head.readUInt16LE(ifd);
  if (ifd + 2 + n * 12 > head.length) throw new Error("the TIFF's index is cut short");
  /** A tag's values, read from the start of the file where they are there, and asked for where not. */
  const values = async (type: number, count: number, at: number): Promise<number[]> => {
    const size = TYPE_BYTES[type] ?? 1;
    const inline = size * count <= 4;
    const from = inline ? at : head.readUInt32LE(at);
    const buf = inline || from + size * count <= head.length ? head.subarray(from, from + size * count) : await read(from, size * count, signal);
    const out = new Array<number>(count);
    for (let i = 0; i < count; i++) out[i] = type === 3 ? buf.readUInt16LE(i * 2) : type === 4 ? buf.readUInt32LE(i * 4) : type === 12 ? buf.readDoubleLE(i * 8) : type === 16 ? Number(buf.readBigUInt64LE(i * 8)) : buf[i * size];
    return out;
  };
  const tags = new Map<number, number[]>();
  const WANTED = [256, 257, 258, 259, 273, 277, 278, 279, 317, 322, 323, 324, 325, 33550, 33922];
  const reads: Promise<void>[] = [];
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    const tag = head.readUInt16LE(e);
    // (All at once: a file in strips has two long lists past the start, and each is a read of its own.)
    if (WANTED.includes(tag)) reads.push(values(head.readUInt16LE(e + 2), head.readUInt32LE(e + 4), e + 8).then((v) => { tags.set(tag, v); }));
  }
  await Promise.all(reads);
  const one = (tag: number, otherwise?: number): number => {
    const v = tags.get(tag)?.[0] ?? otherwise;
    if (v === undefined) throw new Error(`a TIFF without tag ${tag}`);
    return v;
  };
  const scale = tags.get(33550), tie = tags.get(33922);
  if (!scale || !tie || tie.length < 6) throw new Error("a TIFF that does not say where on Earth it is");
  const tiled = tags.has(324);
  const index: TiffIndex = {
    width: one(256), height: one(257), bytes: one(258, 8) / 8, compression: one(259, 1),
    tileWidth: tiled ? one(322) : 0, tileHeight: tiled ? one(323) : 0, rowsPerStrip: tiled ? 0 : one(278),
    offsets: Float64Array.from(tags.get(tiled ? 324 : 273) ?? []), counts: Float64Array.from(tags.get(tiled ? 325 : 279) ?? []),
    west: tie[3] - tie[0] * scale[0], north: tie[4] + tie[1] * scale[1], pixelLon: scale[0], pixelLat: scale[1],
  };
  if (one(277, 1) !== 1 || (index.bytes !== 1 && index.bytes !== 2) || one(317, 1) !== 1 || ![1, 5, 8].includes(index.compression) || index.offsets.length === 0 || index.offsets.length !== index.counts.length) {
    throw new Error("a TIFF of a kind this does not read");
  }
  return index;
}

/**
 * Unpacks TIFF LZW: codes of 9 to 12 bits, most significant bit first, the width going up one code early.
 * Stops as soon as `need` bytes are out, since of a strip only its first part may be wanted.
 */
export function unLzw(src: Uint8Array, need: number): Buffer {
  const out = Buffer.alloc(need);
  const prefix = new Uint16Array(4096), last = new Uint8Array(4096), first = new Uint8Array(4096), size = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) { last[i] = i; first[i] = i; size[i] = 1; }
  let next = 258, width = 9, bit = 0, old = -1, o = 0;
  const bits = src.length * 8;
  while (o < need && bit + width <= bits) {
    const at = bit >> 3;
    const three = (src[at] << 16) | ((src[at + 1] ?? 0) << 8) | (src[at + 2] ?? 0);
    const code = (three >> (24 - (bit & 7) - width)) & ((1 << width) - 1);
    bit += width;
    if (code === 256) { next = 258; width = 9; old = -1; continue; }
    if (code === 257) break;
    if (old >= 0 && next < 4096) {
      prefix[next] = old;
      first[next] = first[old];
      last[next] = code < next ? first[code] : first[old];
      size[next] = size[old] + 1;
      next++;
    } else if (old < 0 && code > 255) throw new Error("LZW data that does not start with a plain byte");
    if (code >= next) throw new Error("LZW data with a code from nowhere");
    // The string for the code, written backwards from its end.
    let p = o + size[code] - 1;
    for (let c = code; ; c = prefix[c]) {
      if (p < need) out[p] = last[c];
      p--;
      if (size[c] === 1) break;
    }
    o += size[code];
    old = code;
    if (next >= (1 << width) - 1 && width < 12) width++;
  }
  return out;
}

export interface Window { width: number; height: number; data: Uint8Array | Uint16Array }

/**
 * The pixels of columns x0 to x1 and rows y0 to y1 (inclusive, clamped to the image). Pixels the file
 * has nothing for come out 0.
 */
export async function readWindow(read: RangeReader, t: TiffIndex, x0: number, y0: number, x1: number, y1: number, signal?: AbortSignal): Promise<Window> {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(t.width - 1, Math.floor(x1)); y1 = Math.min(t.height - 1, Math.floor(y1));
  const width = Math.max(0, x1 - x0 + 1), height = Math.max(0, y1 - y0 + 1);
  const data = t.bytes === 2 ? new Uint16Array(width * height) : new Uint8Array(width * height);
  if (!width || !height) return { width, height, data };
  const unpack = (buf: Buffer, need: number): Buffer => (t.compression === 8 ? inflateSync(buf) : t.compression === 5 ? unLzw(buf, need) : buf);
  const put = (px: Buffer, pxWidth: number, fromX: number, fromY: number, rows: number): void => {
    // `px` holds rows of `pxWidth` pixels whose first is image pixel (fromX, fromY).
    for (let y = Math.max(y0, fromY); y <= Math.min(y1, fromY + rows - 1); y++) {
      for (let x = Math.max(x0, fromX); x <= Math.min(x1, fromX + pxWidth - 1); x++) {
        const at = ((y - fromY) * pxWidth + (x - fromX)) * t.bytes;
        if (at + t.bytes > px.length) continue;
        data[(y - y0) * width + (x - x0)] = t.bytes === 2 ? px.readUInt16LE(at) : px[at];
      }
    }
  };
  if (t.tileWidth) {
    const across = Math.ceil(t.width / t.tileWidth);
    const jobs: Promise<void>[] = [];
    for (let ty = Math.floor(y0 / t.tileHeight); ty <= Math.floor(y1 / t.tileHeight); ty++) {
      for (let tx = Math.floor(x0 / t.tileWidth); tx <= Math.floor(x1 / t.tileWidth); tx++) {
        const i = ty * across + tx;
        if (!t.counts[i]) continue;
        jobs.push(read(t.offsets[i], t.counts[i], signal).then((buf) => put(unpack(buf, t.tileWidth * t.tileHeight * t.bytes), t.tileWidth, tx * t.tileWidth, ty * t.tileHeight, t.tileHeight)));
      }
    }
    await Promise.all(jobs);
    return { width, height, data };
  }
  // Strips: the ones wanted lie one after another in the file, so they are had in one read.
  const s0 = Math.floor(y0 / t.rowsPerStrip), s1 = Math.floor(y1 / t.rowsPerStrip);
  const from = t.offsets[s0], to = t.offsets[s1] + t.counts[s1];
  let sum = 0;
  for (let s = s0; s <= s1; s++) sum += t.counts[s];
  const together = to > from && to - from <= sum * 1.5 + 65536 ? await read(from, to - from, signal) : null;
  for (let s = s0; s <= s1; s++) {
    if (!t.counts[s]) continue;
    const buf = together ? together.subarray(t.offsets[s] - from, t.offsets[s] - from + t.counts[s]) : await read(t.offsets[s], t.counts[s], signal);
    // Of each strip only as far along as the last column wanted (rows of one strip: all of them, when it has several).
    const need = t.rowsPerStrip === 1 ? (x1 + 1) * t.bytes : t.width * t.rowsPerStrip * t.bytes;
    put(unpack(buf, need), t.width, 0, s * t.rowsPerStrip, t.rowsPerStrip);
  }
  return { width, height, data };
}
