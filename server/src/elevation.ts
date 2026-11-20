// Terrain heights from the open "Terrarium" elevation tiles (Mapzen/AWS open data).
// Height in metres = R*256 + G + B/256 - 32768.

import { PNG } from "pngjs";
import { CHUNK_Z } from "./geo.ts";
import { cacheRead, cacheWrite, InFlight } from "./cache.ts";
import { httpGet } from "./net.ts";

export const ELEV_Z = 13;
const TILE_PX = 256;
const ELEV_URL = process.env.EARTHWALK_ELEVATION_URL ?? "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
/** Terrain mesh cells per chunk side. Grid vertices sit on a global lattice so chunk edges match exactly. */
export const GRID = 64;

export type ElevationFetcher = (z: number, x: number, y: number) => Promise<Float32Array | null>;

export function decodeTerrarium(png: Buffer): Float32Array {
  const img = PNG.sync.read(png);
  const out = new Float32Array(img.width * img.height);
  for (let i = 0; i < out.length; i++) {
    out[i] = img.data[i * 4] * 256 + img.data[i * 4 + 1] + img.data[i * 4 + 2] / 256 - 32768;
  }
  return out;
}

async function fetchTile(z: number, x: number, y: number): Promise<Float32Array | null> {
  const rel = `elevation/${z}/${x}/${y}.png`;
  let png = await cacheRead(rel);
  if (!png) {
    const res = await httpGet(`${ELEV_URL}/${z}/${x}/${y}.png`);
    if (res.status === 404 || res.status === 403) return null; // no data: treated as sea level
    if (!res.ok) throw new Error(`elevation tile ${z}/${x}/${y}: HTTP ${res.status}`);
    png = Buffer.from(await res.arrayBuffer());
    await cacheWrite(rel, png);
  }
  return decodeTerrarium(png);
}

export class Elevation {
  private readonly tiles = new Map<string, Float32Array | null>();
  private readonly inflight = new InFlight<Float32Array | null>();
  private readonly fetcher: ElevationFetcher;
  private readonly maxTiles: number;

  constructor(fetcher: ElevationFetcher = fetchTile, maxTiles = 256) {
    this.fetcher = fetcher;
    this.maxTiles = maxTiles;
  }

  /** Loads every elevation tile needed to sample the given world-coordinate box (CHUNK_Z tile units). */
  async ensure(x0: number, y0: number, x1: number, y1: number): Promise<void> {
    const s = 2 ** (CHUNK_Z - ELEV_Z);
    const pad = 2 / TILE_PX; // bilinear sampling reads one pixel past the box
    const max = 2 ** ELEV_Z - 1;
    const jobs: Promise<unknown>[] = [];
    for (let ty = Math.floor(y0 / s - pad); ty <= Math.floor(y1 / s + pad); ty++) {
      for (let tx = Math.floor(x0 / s - pad); tx <= Math.floor(x1 / s + pad); tx++) {
        if (ty < 0 || ty > max) continue;
        const wx = ((tx % (max + 1)) + max + 1) % (max + 1);
        const key = `${wx}/${ty}`;
        if (this.tiles.has(key)) continue;
        jobs.push(
          this.inflight
            .get(key, () => this.fetcher(ELEV_Z, wx, ty))
            .then((t) => {
              if (this.tiles.size >= this.maxTiles) {
                const oldest = this.tiles.keys().next().value;
                if (oldest !== undefined) this.tiles.delete(oldest);
              }
              this.tiles.set(key, t);
            }),
        );
      }
    }
    await Promise.all(jobs);
  }

  private pixel(px: number, py: number): number {
    const n = TILE_PX * 2 ** ELEV_Z;
    py = Math.min(n - 1, Math.max(0, py));
    px = ((px % n) + n) % n;
    const tile = this.tiles.get(`${Math.floor(px / TILE_PX)}/${Math.floor(py / TILE_PX)}`);
    if (!tile) return 0;
    return tile[(py % TILE_PX) * TILE_PX + (px % TILE_PX)];
  }

  /** Bilinear raw height in metres at world coordinates. Call ensure() for the area first. */
  rawHeight(wx: number, wy: number): number {
    const k = TILE_PX / 2 ** (CHUNK_Z - ELEV_Z);
    const fx = wx * k - 0.5;
    const fy = wy * k - 0.5;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const a = this.pixel(ix, iy);
    const b = this.pixel(ix + 1, iy);
    const c = this.pixel(ix, iy + 1);
    const d = this.pixel(ix + 1, iy + 1);
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  }

  /** Height of terrain-grid vertex (gx, gy) on the global lattice of GRID cells per chunk. Sea floor is clamped to 0. */
  gridHeight(gx: number, gy: number): number {
    return Math.max(0, this.rawHeight(gx / GRID, gy / GRID));
  }

  /**
   * Height of the terrain *mesh* at world coordinates: the same piecewise-planar surface the
   * terrain triangles form, so things placed with it (roads, buildings, trees) sit on the mesh.
   */
  surfaceHeight(wx: number, wy: number): number {
    const gx = wx * GRID;
    const gy = wy * GRID;
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    const fu = gx - i;
    const fv = gy - j;
    const h00 = this.gridHeight(i, j);
    const h11 = this.gridHeight(i + 1, j + 1);
    if (fu >= fv) {
      const h10 = this.gridHeight(i + 1, j);
      return h00 + fu * (h10 - h00) + fv * (h11 - h10);
    }
    const h01 = this.gridHeight(i, j + 1);
    return h00 + fv * (h01 - h00) + fu * (h11 - h01);
  }
}
