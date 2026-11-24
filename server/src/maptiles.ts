// The street map behind the world map: square pictures of the map of the whole world, from OpenStreetMap's own
// tile server, kept here and passed on to the games.
//
// The games draw only the world near the player, so a map to look round the whole Earth on needs pictures from
// somewhere. They come through this server and not straight to each player, so that OpenStreetMap's servers
// see this server and never a player: which player looked at which street is nobody's business but theirs.
//
// OpenStreetMap's tile usage policy (operations.osmfoundation.org/policies/tiles) is kept to: a User-Agent that
// names this server (with EARTHWALK_CONTACT, where the host has set one), each picture kept for a fortnight (the
// policy asks seven days at least), nothing fetched ahead or in bulk (a caller gets so many in five minutes,
// and nothing closer in than zoom 17), and the credit shown on the map itself in both games.
//
// EARTHWALK_MAP_TILES=0 turns the map off; EARTHWALK_MAP_TILES_URL names another server of such pictures, with
// {z}, {x} and {y} in it.

import { promises as fs } from "node:fs";
import path from "node:path";
import { CACHE_DIR, InFlight } from "./cache.ts";
import { httpGet } from "./net.ts";

/** No closer in than this: streets and house outlines are plain at 17, and the policy is firmest about anything nearer. */
export const MAP_TILE_MAX_Z = 17;
/** A picture is kept this long before it is fetched afresh. */
export const MAP_TILE_KEEP_MS = 14 * 24 * 3600 * 1000;
/** One caller may have this many pictures in five minutes: a screen is about twenty, so this is a long look round. */
export const MAP_TILES_PER_CALLER = 900;
const WINDOW_MS = 5 * 60_000;
const DEFAULT_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

export interface MapTileOptions {
  /** Where the pictures are kept: a folder of z/x/y.png. */
  dir?: string;
  /** Fetches one picture from the map's own server; null when it has none. Throws when it cannot be reached. */
  fetchTile?: (z: number, x: number, y: number) => Promise<Buffer | null>;
  now?: () => number;
  perCaller?: number;
}

/** Is this a square of the map there can be a picture of? */
export function validTile(z: number, x: number, y: number): boolean {
  return Number.isInteger(z) && Number.isInteger(x) && Number.isInteger(y) && z >= 0 && z <= MAP_TILE_MAX_Z && x >= 0 && y >= 0 && x < 2 ** z && y < 2 ** z;
}

export class MapTiles {
  private readonly dir: string;
  private readonly fetchTile: (z: number, x: number, y: number) => Promise<Buffer | null>;
  private readonly now: () => number;
  private readonly perCaller: number;
  private readonly asking = new InFlight<Buffer | null>();
  private readonly asks = new Map<string, number[]>(); // caller -> when they were given pictures lately
  private waiting: (() => void)[] = [];
  private out = 0;
  /** How many pictures were fetched from the map's own server, and how many handed out from here, since the server started. */
  fetched = 0;
  served = 0;

  constructor(options: MapTileOptions = {}) {
    this.dir = options.dir ?? path.join(CACHE_DIR, "maptiles");
    const url = process.env.EARTHWALK_MAP_TILES_URL || DEFAULT_URL;
    this.fetchTile = options.fetchTile ?? (async (z, x, y) => {
      const res = await httpGet(url.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y)), 15000);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`map tiles HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      return body.length > 8 && body.subarray(0, 4).equals(PNG) ? body : null;
    });
    this.now = options.now ?? Date.now;
    this.perCaller = options.perCaller ?? MAP_TILES_PER_CALLER;
  }

  /** May this caller have another picture just now? Counts it when they may. */
  allow(caller: string): boolean {
    const now = this.now();
    const recent = (this.asks.get(caller) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= this.perCaller) {
      this.asks.set(caller, recent);
      return false;
    }
    recent.push(now);
    this.asks.set(caller, recent);
    if (this.asks.size > 2000) this.asks.delete(this.asks.keys().next().value!);
    return true;
  }

  /** At most four askings of the map's server at a time: the rest wait their turn. */
  private async turn<T>(work: () => Promise<T>): Promise<T> {
    if (this.out >= 4) await new Promise<void>((go) => this.waiting.push(go));
    this.out++;
    try {
      return await work();
    } finally {
      this.out--;
      this.waiting.shift()?.();
    }
  }

  /**
   * The picture of one square of the map, as a PNG: from what is kept when that is fresh enough, else fetched and
   * kept. Null when there is none to be had (and what is kept, however old, is given sooner than nothing).
   */
  async get(z: number, x: number, y: number): Promise<Buffer | null> {
    if (!validTile(z, x, y)) return null;
    const file = path.join(this.dir, String(z), String(x), `${y}.png`);
    let kept: Buffer | null = null;
    try {
      const [stat, body] = await Promise.all([fs.stat(file), fs.readFile(file)]);
      kept = body;
      if (this.now() - stat.mtimeMs < MAP_TILE_KEEP_MS) {
        this.served++;
        return body;
      }
    } catch { /* not kept yet */ }
    const fresh = await this.asking.get(`${z}/${x}/${y}`, () => this.turn(async () => {
      try {
        const body = await this.fetchTile(z, x, y);
        this.fetched++;
        if (body) {
          // (Never fatal: a picture that cannot be kept is fetched again next time.)
          await fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.writeFile(file, body)).catch(() => undefined);
        }
        return body;
      } catch (err) {
        console.warn(`map tile ${z}/${x}/${y}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    }));
    const out = fresh ?? kept;
    if (out) this.served++;
    return out;
  }
}
