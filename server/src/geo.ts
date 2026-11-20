// Web Mercator tile math. "World coordinates" throughout the server are
// fractional tile coordinates at CHUNK_Z: x grows east, y grows south.

export const CHUNK_Z = 16;
export const EARTH_CIRCUMFERENCE = 40075016.686;

export function lonToX(lon: number, z = CHUNK_Z): number {
  return ((lon + 180) / 360) * 2 ** z;
}

export function latToY(lat: number, z = CHUNK_Z): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * 2 ** z;
}

export function xToLon(x: number, z = CHUNK_Z): number {
  return (x / 2 ** z) * 360 - 180;
}

export function yToLat(y: number, z = CHUNK_Z): number {
  const n = Math.PI * (1 - (2 * y) / 2 ** z);
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

/** Ground size in metres of one tile at zoom z, at the latitude of tile row y. */
export function metersPerTile(y: number, z = CHUNK_Z): number {
  const lat = yToLat(y, z);
  return (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

/** Deterministic 32-bit hash for per-feature variation (heights, colours, trees). */
export function hash32(a: number, b = 0): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d) >>> 0;
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}
