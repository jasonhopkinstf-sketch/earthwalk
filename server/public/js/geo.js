// Web Mercator tile maths, matching server/src/geo.ts.
export const CHUNK_Z = 16;
export const TILES = 2 ** CHUNK_Z;
export const EARTH_CIRCUMFERENCE = 40075016.686;

export const lonToX = (lon) => ((lon + 180) / 360) * TILES;
export const latToY = (lat) => ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * TILES;
export const xToLon = (x) => (x / TILES) * 360 - 180;
export const yToLat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / TILES))) * 180) / Math.PI;
/** Ground size in metres of one chunk at a latitude. */
export const metersPerTile = (lat) => (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / TILES;
