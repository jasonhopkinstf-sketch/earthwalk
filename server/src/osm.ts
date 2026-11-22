// Fetches raw OpenStreetMap data for an area and turns it into the features the
// world generator understands: buildings, roads and ground-cover areas.

import { roofPaint, wallPaint } from "./paint.ts";
import { CHUNK_Z, hash32, latToY, lonToX, metersPerTile, xToLon, yToLat } from "./geo.ts";
import { cacheHas, cacheRead, cacheWrite } from "./cache.ts";
import { httpGet, Pool, USER_AGENT } from "./net.ts";

/** OSM data is kept, and handed to the generator, in tiles at this zoom (2x2 chunks each). */
export const DATA_Z = 15;
/**
 * It is downloaded in blocks of 2x2 of those tiles. A public map server takes much the same time to
 * answer for a block as for a tile (the wait is mostly its queue), so this is four times the map for
 * one wait. Not bigger: a block of a city centre is already 10 to 20 MB of JSON.
 */
export const BLOCK_Z = 14;
/** How far past its own edges a data tile is fetched, as a share of its width. */
export const DATA_MARGIN = 0.08;

export type Pt = [number, number]; // world coordinates (CHUNK_Z tile units)

export type GroundClass = "urban" | "farm" | "grass" | "forest" | "sand" | "rock" | "paved" | "water";
export type RoadClass = "road" | "path" | "rail" | "stream";

export interface Building {
  id: number; ring: Pt[]; height: number; housenumber?: string; street?: string;
  /** OSM roof:shape and roof:height, when mapped. */
  roof?: string; roofHeight?: number;
  /** The OSM building value when it says more than "yes": house, barn, garage, retail... */
  kind?: string;
  /** True when nobody mapped a height or a number of floors, so `height` is only the usual one for its kind. */
  guessed?: boolean;
  /** True when `height` was mapped in metres: it is then the top of the roof, not of the walls. */
  measured?: boolean;
  /** Mapped paints (paint.ts), each one of PAINTS: the walls' and the roof's. `brick`: the walls are brick or stone. */
  colour?: number; roofColour?: number; brick?: boolean;
  /** Metres above the ground at which the building starts, when it stands on legs or bridges a street (min_height). */
  minHeight?: number;
  /** roof:direction as a compass heading in degrees: the way the roof's slope faces, looking downhill. */
  roofDirection?: number;
  /** roof:orientation=across: the ridge runs across the short way of the building. */
  roofAcross?: boolean;
  /** Courtyards: the inner rings of a building mapped with holes in it. */
  holes?: Pt[][];
  /** The pieces a building is mapped in, when somebody has mapped it in 3D. It is then drawn from these, not from its outline. */
  parts?: BuildingPart[];
  /** What it is called, where the map says (its own name, or that of the one named place standing in it). */
  name?: string;
  /** What it is, where the map says, as one of the kinds of place that are drawn as themselves. */
  use?: BuildingUse;
}
/** A church (or any place of worship that is not one of the next two), a mosque, a temple; a shop, somewhere to eat or drink, a school, a petrol station, a hospital. */
export type BuildingUse = "church" | "mosque" | "temple" | "shop" | "food" | "school" | "fuel" | "hospital";
/**
 * One piece of a building mapped in 3D (building:part): a tower's shaft, its pod, its mast. `height`
 * is how far its top is above the ground, and `minHeight` how far its foot is.
 */
export interface BuildingPart extends Pick<Building, "id" | "ring" | "height" | "minHeight" | "roof" | "roofHeight" | "roofColour" | "roofDirection" | "roofAcross" | "colour" | "brick"> {
  /** True when its floors are mapped, so it is somewhere with windows and not a mast, a spire or a drum. */
  storeys?: boolean;
  /** True when its height is mapped in metres (to the top of its roof). */
  measured?: boolean;
  /** True when it is a roof and nothing else (wall=no, building:part=roof): a canopy, a sloping leg of a lattice tower. */
  roofOnly?: boolean;
}
/** A named place mapped as a point: a café, a shop, a museum. `kind` is its tag, as "amenity=cafe". */
export interface NamedPlace { id: number; at: Pt; name: string; kind: string }
/** `name` is set for highway ways only. */
export interface Road {
  id: number; cls: RoadClass; width: number; pts: Pt[]; name?: string;
  /** Roads only: the map's kind of road (residential, primary...), and whether traffic may only go the way it is drawn. */
  hw?: string; oneway?: boolean;
}
/** A house number mapped as a standalone point rather than on a building. */
export interface AddressPoint { id: number; at: Pt; housenumber: string; street?: string }
/** Ground cover. A point is inside if it is within an odd number of rings, so inner rings are holes (islands in a lake). */
export interface Area { id: number; cls: GroundClass; rings: Pt[][]; /** Water that is part of the sea (a bay). */ salt?: boolean }
export interface TreePoint { id: number; at: Pt }
/** What a field is used for, where the map says more than its ground cover does. Used to decide where animals live. */
export type FieldKind = "meadow" | "paddock" | "farmyard" | "farmland";
export type Stock = "cow" | "sheep" | "horse" | "chicken" | "pig" | "goat" | "donkey" | "goose";
/** A field that may hold animals. `stock` is the animal the map names for it, if any. Rings as in Area. */
export interface Field { id: number; kind: FieldKind; rings: Pt[][]; stock?: Stock }
export interface Features {
  buildings: Building[];
  roads: Road[];
  areas: Area[];
  trees: TreePoint[];
  addresses: AddressPoint[];
  /** Coastline pieces. By OpenStreetMap convention, land is on the left of the direction of travel. */
  coast: Pt[][];
  /** Fields that may hold animals (labels route only; the meshes do not use them). */
  fields?: Field[];
  /** Named places mapped as points (extras). */
  places?: NamedPlace[];
  /** True when the extras (3D pieces, named places) could not be had just now; they are put in when they come. */
  partial?: boolean;
}

interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  nodes?: number[];
  members?: { type: string; ref: number; role: string }[];
  tags?: Record<string, string>;
}
export interface OsmJson { elements: OsmElement[] }

// ---------------------------------------------------------------- fetching

const OVERPASS_URLS = (process.env.EARTHWALK_OVERPASS_URLS ??
  "https://overpass-api.de/api/interpreter,https://maps.mail.ru/osm/tools/overpass/api/interpreter,https://overpass.private.coffee/api/interpreter")
  .split(",").map((s) => s.trim()).filter(Boolean);
const OSM_API_URL = process.env.EARTHWALK_OSM_API_URL ?? "https://api.openstreetmap.org/api/0.6";
/** "overpass,osmapi" tries the Overpass servers first, then the main OSM API. */
const SOURCES = (process.env.EARTHWALK_OSM_SOURCES ?? "overpass,osmapi").split(",").map((s) => s.trim());

interface BBox { w: number; s: number; e: number; n: number }

function overpassQuery(b: BBox): string {
  const bb = `(${b.s},${b.w},${b.n},${b.e})`;
  return `[out:json][timeout:60];(` +
    `way["building"]${bb};way["highway"]${bb};way["railway"="rail"]${bb};way["waterway"]${bb};` +
    `way["natural"]${bb};way["landuse"]${bb};way["leisure"]${bb};way["amenity"="parking"]${bb};` +
    `node["natural"="tree"]${bb};node["addr:housenumber"]${bb};node["railway"~"^(station|halt)$"]${bb};` +
    `relation["type"="multipolygon"]["building"]${bb};relation["type"="multipolygon"]["natural"]${bb};` +
    `relation["type"="multipolygon"]["landuse"]${bb};relation["type"="multipolygon"]["leisure"]${bb};` +
    `);out body;>;out skel qt;`;
}

/** Puts one question to one Overpass server. `signal` calls it off. */
export type OverpassPost = (url: string, query: string, signal: AbortSignal) => Promise<OsmJson>;

const postOverpass: OverpassPost = async (url, query, signal) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
    body: `data=${encodeURIComponent(query)}`,
    signal: AbortSignal.any([signal, AbortSignal.timeout(75_000)]),
  });
  if (!res.ok) {
    void res.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP ${res.status}`);
  }
  const json = (await res.json()) as OsmJson & { remark?: unknown };
  if (!Array.isArray(json.elements)) throw new Error("an answer with no map in it");
  // A server that ran out of time or memory still answers "200 OK", with part of the map or none of it
  // and a remark saying so. Kept, that would be an empty place for good.
  if (typeof json.remark === "string" && /error|timed out|out of memory/i.test(json.remark)) throw new Error(json.remark.slice(0, 160));
  return json;
};

/**
 * Asks the public Overpass servers, which are free, shared, and some days slow or down.
 *
 * The one that has been answering fastest is asked first. If it has said nothing after `hedgeMs`, the
 * next is asked as well, and whichever answers first is used (the other is called off). A server that
 * fails is rested: half a minute, then longer each time it fails again, up to ten minutes.
 */
export function overpassClient(urls: string[], ask: OverpassPost = postOverpass, hedgeMs = 8000, now: () => number = Date.now, report: (line: string) => void = () => undefined): (query: string, signal?: AbortSignal) => Promise<OsmJson> {
  const servers = urls.map((url) => ({ url, busy: 0, restUntil: 0, fails: 0, pace: 0 }));
  return (query, signal) => new Promise<OsmJson>((resolve, reject) => {
    const ready = servers.filter((s) => s.restUntil <= now()).sort((x, y) => x.busy - y.busy || x.pace - y.pace);
    if (ready.length === 0) return reject(new Error("every Overpass server failed lately; resting them"));
    const stops: AbortController[] = [];
    let done = false;
    let asked = 0;
    let out = 0;
    let lastErr: unknown;
    let timer: NodeJS.Timeout | undefined;
    const more = (): void => {
      clearTimeout(timer);
      if (done || asked >= ready.length) return;
      const s = ready[asked++];
      const stop = new AbortController();
      stops.push(stop);
      const began = now();
      s.busy++;
      out++;
      ask(s.url, query, stop.signal).then((json) => {
        s.busy--;
        out--;
        s.fails = 0;
        s.pace = s.pace ? s.pace * 0.5 + (now() - began) * 0.5 : Math.max(1, now() - began);
        report(`map: ${new URL(s.url).host} answered in ${((now() - began) / 1000).toFixed(1)} s${done ? ", too late to be used" : ""}`);
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const other of stops) if (other !== stop) other.abort();
        resolve(json);
      }, (err) => {
        s.busy--;
        out--;
        if (stop.signal.aborted) return; // called off because another server answered first: no fault of this one
        s.fails++;
        s.restUntil = now() + Math.min(10 * 60_000, 30_000 * 2 ** (s.fails - 1));
        lastErr = err;
        report(`map: ${new URL(s.url).host} failed after ${((now() - began) / 1000).toFixed(1)} s (${err instanceof Error ? err.message : String(err)}); resting it for ${Math.round((s.restUntil - now()) / 1000)} s`);
        if (done) return;
        if (asked < ready.length) more();
        else if (out === 0) {
          done = true;
          reject(new Error(`all Overpass servers failed: ${String(lastErr)}`));
        }
      });
      if (asked < ready.length) {
        timer = setTimeout(more, hedgeMs);
        timer.unref();
      }
    };
    signal?.addEventListener("abort", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const stop of stops) stop.abort();
      reject(new Error("called off"));
    }, { once: true });
    more();
  });
}

// What the map servers did is written down, since "the world is slow today" is nearly always them.
const askServers = overpassClient(OVERPASS_URLS, postOverpass, 8000, Date.now, (line) => { if (process.env.EARTHWALK_QUIET_MAP !== "1") console.log(line); });
// Two questions at a time, between all the servers: the map for where a player is now comes before
// places they have already left, and before the map ahead of somebody who is travelling.
const pool = new Pool(2, 400);

async function fromOsmApi(b: BBox, signal?: AbortSignal, depth = 0): Promise<OsmJson> {
  const res = await httpGet(`${OSM_API_URL}/map.json?bbox=${b.w},${b.s},${b.e},${b.n}`, 60000, { signal });
  if (res.status === 400 && depth < 3) {
    void res.body?.cancel().catch(() => undefined);
    // Too many nodes in one request (the limit is 50,000): split into quadrants and merge.
    const mx = (b.w + b.e) / 2;
    const my = (b.s + b.n) / 2;
    const quads: BBox[] = [
      { w: b.w, s: my, e: mx, n: b.n }, { w: mx, s: my, e: b.e, n: b.n },
      { w: b.w, s: b.s, e: mx, n: my }, { w: mx, s: b.s, e: b.e, n: my },
    ];
    const seen = new Set<string>();
    const elements: OsmElement[] = [];
    // Two at a time: quicker than one after another, and still gentle.
    for (const pair of [quads.slice(0, 2), quads.slice(2)]) {
      for (const part of await Promise.all(pair.map((q) => fromOsmApi(q, signal, depth + 1)))) {
        for (const el of part.elements) {
          const key = el.type[0] + el.id;
          if (!seen.has(key)) { seen.add(key); elements.push(el); }
        }
      }
    }
    return { elements };
  }
  if (!res.ok) {
    void res.body?.cancel().catch(() => undefined);
    // "You have downloaded too much data": it allows so much an hour, and says when to come back.
    const wait = Number(res.headers.get("retry-after"));
    throw new Error(`OSM API HTTP ${res.status}${Number.isFinite(wait) && wait > 0 ? ` (retry after ${Math.ceil(wait)} s)` : ""}`);
  }
  const json = (await res.json()) as OsmJson;
  // Keep only what the generator uses, so the cache stays small.
  for (const el of json.elements) {
    for (const k of Object.keys(el)) {
      if (!["type", "id", "lat", "lon", "nodes", "members", "tags"].includes(k)) delete (el as unknown as Record<string, unknown>)[k];
    }
  }
  return json;
}

const isAreaRelation = (el: OsmElement): boolean =>
  el.type === "relation" && el.tags?.type === "multipolygon" && !!el.members &&
  ((!!el.tags.building && el.tags.building !== "no") || groundClassOf(el.tags) !== null);

/**
 * A big lake, harbour or forest is one relation made of many ways, and an area query only returns
 * the ways that pass through the area, so its outline cannot be closed. Fetch those relations whole.
 */
async function completeRelations(json: OsmJson): Promise<void> {
  const have = new Set<string>();
  for (const el of json.elements) have.add(el.type[0] + el.id);
  const partial = json.elements.filter((el) => isAreaRelation(el) && el.members!.some((m) => m.type === "way" && !have.has("w" + m.ref)));
  for (const rel of partial.slice(0, 8)) {
    try {
      const file = `osm/relation/${rel.id}.json`;
      let full: OsmJson;
      const cached = await cacheRead(file);
      if (cached) {
        full = JSON.parse(cached.toString("utf8")) as OsmJson;
      } else {
        const res = await httpGet(`${OSM_API_URL}/relation/${rel.id}/full.json`, 60000);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        full = (await res.json()) as OsmJson;
        // Only the outline is needed: drop tags of member ways so they are not drawn twice.
        full.elements = full.elements
          .filter((el) => el.type !== "relation")
          .map((el) => (el.type === "node" ? { type: el.type, id: el.id, lat: el.lat, lon: el.lon } : { type: el.type, id: el.id, nodes: el.nodes }));
        await cacheWrite(file, JSON.stringify(full));
      }
      for (const el of full.elements) {
        const key = el.type[0] + el.id;
        if (!have.has(key)) { have.add(key); json.elements.push(el); }
      }
    } catch (err) {
      console.warn(`could not complete relation ${rel.id}: ${String(err)}`);
    }
  }
}

/**
 * Cuts the map of one block into its four data tiles (west to east, then north to south), each with
 * the same margin, and the same things in it, as if it had been asked for on its own: every way that
 * touches the tile, every relation with such a way (and then all of that relation's ways, so its
 * outline closes), the points those are made of, and the trees and house numbers that stand in it.
 */
export function splitBlock(json: OsmJson, bx: number, by: number): OsmJson[] {
  const at = new Map<number, OsmElement>();
  const ways = new Map<number, OsmElement>();
  for (const el of json.elements) {
    if (el.type === "node" && el.lat !== undefined && el.lon !== undefined) at.set(el.id, el);
    else if (el.type === "way" && el.nodes) ways.set(el.id, el);
  }
  const m = DATA_MARGIN;
  return [0, 1, 2, 3].map((i) => {
    const dx = bx * 2 + (i & 1);
    const dy = by * 2 + (i >> 1);
    const w = xToLon(dx - m, DATA_Z), e = xToLon(dx + 1 + m, DATA_Z);
    const n = yToLat(dy - m, DATA_Z), s = yToLat(dy + 1 + m, DATA_Z);
    const touches = (way: OsmElement): boolean => {
      let before: OsmElement | undefined;
      for (const id of way.nodes!) {
        const p = at.get(id);
        if (!p) continue;
        const q = before ?? p;
        // The box round each stretch of the way against the tile: a little generous, never short.
        if (Math.max(p.lon!, q.lon!) >= w && Math.min(p.lon!, q.lon!) <= e && Math.max(p.lat!, q.lat!) >= s && Math.min(p.lat!, q.lat!) <= n) return true;
        before = p;
      }
      return false;
    };
    const keepWays = new Set<number>();
    for (const way of ways.values()) if (touches(way)) keepWays.add(way.id);
    const keepRels = new Set<number>();
    for (const el of json.elements) {
      if (el.type === "relation" && el.members?.some((mem) => mem.type === "way" && keepWays.has(mem.ref))) keepRels.add(el.id);
    }
    for (const el of json.elements) {
      if (el.type === "relation" && keepRels.has(el.id)) for (const mem of el.members!) if (mem.type === "way" && ways.has(mem.ref)) keepWays.add(mem.ref);
    }
    const keepNodes = new Set<number>();
    for (const id of keepWays) for (const node of ways.get(id)!.nodes!) keepNodes.add(node);
    return {
      elements: json.elements.filter((el) =>
        el.type === "node" ? keepNodes.has(el.id) || (!!el.tags && el.lon! >= w && el.lon! <= e && el.lat! >= s && el.lat! <= n)
          : el.type === "way" ? keepWays.has(el.id)
            : keepRels.has(el.id)),
    };
  });
}

/**
 * "v2": tiles cut from blocks, with the railway stations in them. Before, tiles were downloaded one
 * by one into osm/15, without the stations (which were asked for separately). Those are still good
 * map, and are read where there is no newer tile: everywhere people have already been stays built,
 * at the cost of trains there not stopping at stations (they still stop at the ends of their runs).
 */
const tileRel = (dx: number, dy: number): string => `osm/v2/${DATA_Z}/${dx}/${dy}.json`;
const oldTileRel = (dx: number, dy: number): string => `osm/${DATA_Z}/${dx}/${dy}.json`;
/** Folders of the cache that nothing reads any more; cleared away at start-up (prune.ts). */
export const RETIRED_CACHE = ["rail"];
const tileLoads = new Map<string, Promise<OsmJson>>();
const blockLoads = new Map<string, { promise: Promise<OsmJson[]>; hurry: () => void }>();
/** Blocks somebody is waiting for, whatever they were first asked for as. */
const wanted = new Set<string>();
/** Tiles known to be in the cache, so that looking ahead need not ask the disk each time. */
const onDisk = new Set<string>();
const noteOnDisk = (rel: string): void => {
  if (onDisk.size >= 20_000) onDisk.clear();
  onDisk.add(rel);
};

const usedWay = (t: Record<string, string>): boolean =>
  !!(t.building || t.highway || t.railway === "rail" || t.waterway || t.natural || t.landuse || t.leisure || t.amenity === "parking");
const usedRelation = (t: Record<string, string>): boolean => t.type === "multipolygon" && !!(t.building || t.natural || t.landuse || t.leisure);

/**
 * Keeps only what the generator uses: the same ways, relations and points an Overpass answer has.
 * The main OpenStreetMap service sends everything in the area (bus routes, power lines, every bench),
 * which would double what is kept on disk and read back each time.
 */
export function trimToUsed(json: OsmJson): OsmJson {
  const ofRelations = new Set<number>();
  for (const el of json.elements) {
    if (el.type === "relation" && el.tags && usedRelation(el.tags)) for (const mem of el.members ?? []) if (mem.type === "way") ofRelations.add(mem.ref);
  }
  const ofWays = new Set<number>();
  const kept = json.elements.filter((el) => {
    if (el.type === "relation") return !!el.tags && usedRelation(el.tags);
    if (el.type !== "way") return true;
    if (!(el.tags && usedWay(el.tags)) && !ofRelations.has(el.id)) return false;
    for (const id of el.nodes ?? []) ofWays.add(id);
    return true;
  });
  json.elements = kept.filter((el) => {
    if (el.type !== "node") return true;
    const stands = el.tags?.natural === "tree" || !!el.tags?.["addr:housenumber"]?.trim() || el.tags?.railway === "station" || el.tags?.railway === "halt";
    if (!stands) delete el.tags; // a crossing, a bench: only where it is matters, if that
    return stands || ofWays.has(el.id);
  });
  return json;
}

/** The main OpenStreetMap service is rested like the others when it fails, and for longer when it says we ask too much. */
const osmApi = { restUntil: 0, fails: 0 };
/** How many blocks running the main service answered before Overpass did, and how long Overpass is left alone for it. */
let apiWins = 0;
let overpassOffUntil = 0;
const say = (line: string): void => { if (process.env.EARTHWALK_QUIET_MAP !== "1") console.log(line); };

/**
 * The map of one area from whichever source answers first. Overpass is asked first, since it is the
 * service meant for this. If it has said nothing after a few seconds, the main OpenStreetMap service
 * is asked too (it is quick, but meant for people editing the map, so it is kept for slow days). When
 * the main service has been first three times running, Overpass is plainly having a bad day and is left
 * alone for five minutes, not asked and then called off each time.
 *
 * The main service allows each caller only so much an hour (a city block of the map is 5 to 15 MB of
 * it). So for map that nobody is waiting for (`quiet`: the ground ahead of a traveller, the places kept
 * ready to show), Overpass is always asked, and given half a minute before the main service is.
 */
function fromAnySource(b: BBox, quiet = false): Promise<OsmJson> {
  return new Promise<OsmJson>((resolve, reject) => {
    const overpass = SOURCES.includes("overpass") && (quiet || Date.now() >= overpassOffUntil);
    const api = SOURCES.includes("osmapi") && Date.now() >= osmApi.restUntil;
    const stop = new AbortController();
    let done = false;
    let left = 0;
    let apiAsked = false;
    let timer: NodeJS.Timeout | undefined;
    let lastErr: unknown = new Error("no map source is available just now");
    const finish = (name: "overpass" | "osmapi", json: OsmJson): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stop.abort();
      if (quiet) { /* says little about how the servers are doing for those in a hurry */ }
      else if (name === "osmapi" && overpass) {
        if (++apiWins >= 3) {
          apiWins = 0;
          overpassOffUntil = Date.now() + 5 * 60_000;
          say("map: the main OpenStreetMap service has been first three times running; leaving Overpass alone for five minutes");
        }
      } else if (name === "overpass") apiWins = 0;
      resolve(json);
    };
    const failed = (name: "overpass" | "osmapi", err: unknown): void => {
      if (done) return;
      lastErr = err;
      if (name === "overpass" && api && !apiAsked) askApi();
      else if (left === 0) {
        done = true;
        clearTimeout(timer);
        reject(lastErr);
      }
    };
    const askApi = (): void => {
      clearTimeout(timer);
      if (apiAsked || done) return;
      apiAsked = true;
      left++;
      const began = Date.now();
      fromOsmApi(b, stop.signal).then((json) => {
        left--;
        osmApi.fails = 0;
        say(`map: api.openstreetmap.org answered in ${((Date.now() - began) / 1000).toFixed(1)} s${done ? ", too late to be used" : ""}`);
        finish("osmapi", json);
      }, (err) => {
        left--;
        if (!stop.signal.aborted) {
          // Told how long to wait, wait that long and a little more; told nothing, a minute, then longer.
          const told = Number(/retry after (\d+) s/.exec(String(err))?.[1]);
          osmApi.fails++;
          osmApi.restUntil = Date.now() + (told > 0 ? Math.min(30 * 60_000, (told + 3) * 1000) : Math.min(10 * 60_000, 60_000 * 2 ** (osmApi.fails - 1)));
          say(`map: api.openstreetmap.org failed after ${((Date.now() - began) / 1000).toFixed(1)} s (${err instanceof Error ? err.message : String(err)}); resting it for ${Math.round((osmApi.restUntil - Date.now()) / 1000)} s`);
        }
        failed("osmapi", err);
      });
    };
    if (overpass) {
      left++;
      askServers(overpassQuery(b), stop.signal).then((json) => { left--; finish("overpass", json); }, (err) => { left--; failed("overpass", err); });
      if (api) {
        timer = setTimeout(askApi, quiet ? 30_000 : apiWins > 0 ? 1500 : 5000);
        timer.unref();
      }
    } else if (api) askApi();
    else reject(lastErr);
  });
}

async function downloadBlock(bx: number, by: number, quiet = false): Promise<OsmJson> {
  const m = DATA_MARGIN / 2; // the same width of margin as a data tile has
  const b: BBox = {
    w: xToLon(bx - m, BLOCK_Z), e: xToLon(bx + 1 + m, BLOCK_Z),
    n: yToLat(by - m, BLOCK_Z), s: yToLat(by + 1 + m, BLOCK_Z),
  };
  try {
    const json = trimToUsed(await fromAnySource(b, quiet));
    await completeRelations(json);
    return json;
  } catch (err) {
    throw new Error(`no OSM source answered for block ${bx}/${by}: ${String(err)}`);
  }
}

/** Downloads a block, cuts it into its four data tiles and keeps them. */
function loadBlock(bx: number, by: number, quiet: boolean): Promise<OsmJson[]> {
  const key = `${bx}/${by}`;
  let load = blockLoads.get(key);
  if (!load) {
    // Asked for quietly, it is fetched patiently, unless somebody has come along who wants it now.
    const job = pool.add(() => downloadBlock(bx, by, quiet && !wanted.has(key)), quiet && !wanted.has(key));
    const promise = job.promise.then(async (json) => {
      const tiles = splitBlock(json, bx, by);
      await Promise.all(tiles.map(async (tile, i) => {
        const rel = tileRel(bx * 2 + (i & 1), by * 2 + (i >> 1));
        await cacheWrite(rel, JSON.stringify(tile));
        noteOnDisk(rel);
      }));
      return tiles;
    }).finally(() => {
      blockLoads.delete(key);
      wanted.delete(key);
    });
    promise.catch(() => undefined); // whoever asked hears of a failure; nobody else need
    load = { promise, hurry: job.hurry };
    blockLoads.set(key, load);
  }
  return load.promise;
}

/**
 * Raw OSM data for one DATA_Z tile (with a small margin), cached on disk. A `quiet` request is for
 * map nobody is standing in yet: it waits behind everything else, and may be given up.
 */
export function fetchOsmTile(dx: number, dy: number, quiet = false): Promise<OsmJson> {
  const rel = tileRel(dx, dy);
  const block = `${dx >> 1}/${dy >> 1}`;
  if (!quiet) {
    wanted.add(block);
    blockLoads.get(block)?.hurry();
  }
  let load = tileLoads.get(rel);
  if (!load) {
    load = (async () => {
      const cached = (await cacheRead(rel)) ?? (await cacheRead(oldTileRel(dx, dy)));
      if (cached) {
        noteOnDisk(rel);
        return JSON.parse(cached.toString("utf8")) as OsmJson;
      }
      return (await loadBlock(dx >> 1, dy >> 1, quiet))[(dy & 1) * 2 + (dx & 1)];
    })().finally(() => {
      tileLoads.delete(rel);
      if (!blockLoads.has(block)) wanted.delete(block);
    });
    tileLoads.set(rel, load);
  }
  return load;
}

/**
 * Sees that a data tile is in the cache, downloading it quietly if it is not. Never fails, and reads
 * nothing. Says whether it was "there" already, was "fetched" just now, or "failed" (to be tried again).
 */
export async function warmOsmTile(dx: number, dy: number): Promise<"there" | "fetched" | "failed"> {
  const rel = tileRel(dx, dy);
  if (onDisk.has(rel)) return "there";
  if (!tileLoads.has(rel) && ((await cacheHas(rel)) || (await cacheHas(oldTileRel(dx, dy))))) {
    noteOnDisk(rel);
    return "there";
  }
  return fetchOsmTile(dx, dy, true).then(() => "fetched" as const, () => "failed" as const);
}

// ---------------------------------------------------------------- the extras

/**
 * The extras of a block: the pieces of buildings mapped in 3D (building:part) and the named places
 * mapped as points. They are asked for separately from the map itself, and only of Overpass: they
 * are small, they are not needed to stand on the ground, and this way the map already downloaded for
 * everywhere people have been stays good.
 */
const extraRel = (bx: number, by: number): string => `osm/extra/v1/${BLOCK_Z}/${bx}/${by}.json`;
const PLACE_KEYS = ["amenity", "shop", "tourism", "historic", "office"];

function extraQuery(b: BBox): string {
  const bb = `(${b.s},${b.w},${b.n},${b.e})`;
  return `[out:json][timeout:60];(way["building:part"]${bb};relation["building:part"]${bb};` +
    PLACE_KEYS.map((k) => `node["name"]["${k}"]${bb};`).join("") +
    `);out body;>;out skel qt;`;
}

/** Keeps of an answer only what is used: the pieces with their tags, the places with their name and kind, and bare points. */
export function trimExtras(json: OsmJson): OsmJson {
  for (const el of json.elements) {
    if (el.type !== "node" || !el.tags) continue;
    const key = PLACE_KEYS.find((k) => el.tags![k]);
    const name = el.tags.name?.trim();
    if (key && name) el.tags = { name, [key]: el.tags[key] };
    else delete el.tags;
  }
  return json;
}

const extraLoads = new Map<string, Promise<OsmJson | null>>();
/** Blocks whose extras could not be had, and when they may be asked for again. */
const extraRest = new Map<string, number>();
const EXTRA_WAIT_MS = 9000;

/**
 * Blocks ("x/y") that something was built in before their extras came. The list is kept on disk, and
 * the blocks on it are asked for again from time to time (keepExtrasComing). When one's extras do come,
 * whoever asked to be told (onExtras) forgets what was built there, so that it is built again with them.
 */
const OWED_REL = "osm/extra/owed.json";
const owed = new Set<string>();
let owedRead: Promise<void> | null = null;
const readOwed = (): Promise<void> => (owedRead ??= cacheRead(OWED_REL).then((buf) => {
  if (buf) for (const key of JSON.parse(buf.toString("utf8")) as string[]) owed.add(key);
}).catch(() => undefined));
const writeOwed = (): Promise<void> => cacheWrite(OWED_REL, JSON.stringify([...owed].slice(-4000)));
const arrived: ((bx: number, by: number) => void)[] = [];
/** Asks to be told when the extras of a block come after something was built there without them. */
export function onExtras(listener: (bx: number, by: number) => void): void {
  arrived.push(listener);
}

/**
 * The extras of the block a data tile is in. Null when they are not in the cache and do not come
 * within a few seconds (the block is then owed them: the question carries on, or is put again later),
 * or when Overpass is not among the sources.
 */
export async function fetchExtras(dx: number, dy: number, ask: (query: string) => Promise<OsmJson> = (query) => pool.add(() => askServers(query)).promise, waitMs = EXTRA_WAIT_MS): Promise<OsmJson | null> {
  const bx = dx >> 1, by = dy >> 1;
  const key = `${bx}/${by}`;
  const rel = extraRel(bx, by);
  const cached = await cacheRead(rel);
  if (cached) return JSON.parse(cached.toString("utf8")) as OsmJson;
  if (!SOURCES.includes("overpass")) return null;
  await readOwed();
  const owe = (): null => {
    if (!owed.has(key)) { owed.add(key); void writeOwed(); }
    return null;
  };
  let load = extraLoads.get(rel);
  if (!load) {
    if (Date.now() < (extraRest.get(rel) ?? 0)) return owe();
    const m = DATA_MARGIN / 2;
    const b: BBox = { w: xToLon(bx - m, BLOCK_Z), e: xToLon(bx + 1 + m, BLOCK_Z), n: yToLat(by - m, BLOCK_Z), s: yToLat(by + 1 + m, BLOCK_Z) };
    load = ask(extraQuery(b)).then(async (json) => {
      const trimmed = trimExtras(json);
      await cacheWrite(rel, JSON.stringify(trimmed));
      if (owed.delete(key)) {
        void writeOwed();
        for (const tell of arrived) tell(bx, by);
      }
      return trimmed;
    }, (err) => {
      if (extraRest.size > 2000) extraRest.clear();
      extraRest.set(rel, Date.now() + 10 * 60_000);
      say(`map: no 3D pieces for block ${key} this time (${err instanceof Error ? err.message : String(err)})`);
      return null;
    }).finally(() => { extraLoads.delete(rel); });
    extraLoads.set(rel, load);
  }
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
  try {
    return (await Promise.race([load, late])) ?? owe();
  } finally {
    clearTimeout(timer);
  }
}

/** Every few minutes, asks again for the extras of one block that is owed them. */
export function keepExtrasComing(everyMs = 4 * 60_000): void {
  const timer = setInterval(() => {
    void readOwed().then(() => {
      for (const key of owed) {
        const [bx, by] = key.split("/").map(Number);
        const rel = extraRel(bx, by);
        if (extraLoads.has(rel) || Date.now() < (extraRest.get(rel) ?? 0)) continue;
        void fetchExtras(bx * 2, by * 2, (query) => pool.add(() => askServers(query), true).promise);
        return;
      }
    });
  }, everyMs);
  timer.unref();
}

// ---------------------------------------------------------------- parsing

function num(s: string | undefined): number | null {
  if (!s) return null;
  const v = parseFloat(s.replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

const BUILDING_DEFAULT_HEIGHT: Record<string, number> = {
  house: 6.5, detached: 6.5, semidetached_house: 6.5, terrace: 7, residential: 9, bungalow: 4,
  garage: 3, garages: 3, shed: 2.6, hut: 2.6, cabin: 3, roof: 3.5, carport: 2.8, greenhouse: 3, kiosk: 3,
  apartments: 16, dormitory: 13, hotel: 18, office: 20, commercial: 10, retail: 6, supermarket: 6,
  industrial: 9, warehouse: 9, school: 9, university: 12, hospital: 16, civic: 10, public: 10,
  church: 16, cathedral: 30, chapel: 9, mosque: 14, temple: 12, barn: 7, farm_auxiliary: 5, stadium: 20,
};

export function buildingHeight(id: number, tags: Record<string, string>): number {
  const h = num(tags.height) ?? num(tags["building:height"]);
  if (h && h > 1 && h < 1000) return h;
  const levels = num(tags["building:levels"]);
  if (levels && levels > 0 && levels < 250) return levels * 3.1 + 1.2;
  const base = BUILDING_DEFAULT_HEIGHT[tags.building] ?? 7.5;
  return base * (0.85 + (hash32(id) % 100) / 333); // +-15% so untagged streets are not uniform
}

const ROAD_WIDTH: Record<string, number> = {
  motorway: 11, trunk: 10, primary: 9, secondary: 8, tertiary: 7, unclassified: 6, residential: 6,
  living_street: 5, service: 3.5, pedestrian: 5, road: 6, busway: 6,
  motorway_link: 6, trunk_link: 6, primary_link: 5.5, secondary_link: 5, tertiary_link: 5,
};
const PATH_WIDTH: Record<string, number> = {
  footway: 1.8, path: 1.5, cycleway: 2.2, steps: 2, track: 2.8, bridleway: 2, corridor: 1.8,
};

const named = (road: Road, name: string | undefined): Road => (name?.trim() ? { ...road, name: name.trim() } : road);

function roadOf(id: number, tags: Record<string, string>, pts: Pt[]): Road | null {
  if (tags.tunnel && tags.tunnel !== "no") return null;
  if ((num(tags.layer) ?? 0) < 0) return null;
  const hw = tags.highway;
  if (hw) {
    if (tags.area === "yes") return null;
    if (hw in ROAD_WIDTH) {
      const lanes = num(tags.lanes);
      const width = num(tags.width) ?? (lanes && lanes >= 1 && lanes <= 10 ? Math.max(lanes * 3.2, 3.5) : ROAD_WIDTH[hw]);
      const oneway = /^(yes|true|1|-1|reversible)$/.test(tags.oneway ?? "") || tags.junction === "roundabout" || hw === "motorway";
      return named({ id, cls: "road", width: Math.min(Math.max(width, 2.5), 40), pts, hw, ...(oneway ? { oneway } : {}) }, tags.name);
    }
    if (hw in PATH_WIDTH) return named({ id, cls: "path", width: PATH_WIDTH[hw], pts }, tags.name);
    return null;
  }
  if (tags.railway === "rail") return { id, cls: "rail", width: 3, pts };
  const ww = tags.waterway;
  if (ww === "river") return { id, cls: "stream", width: num(tags.width) ?? 14, pts };
  if (ww === "canal") return { id, cls: "stream", width: num(tags.width) ?? 9, pts };
  if (ww === "stream" || ww === "ditch" || ww === "drain") return { id, cls: "stream", width: 2, pts };
  return null;
}

export function groundClassOf(tags: Record<string, string>): GroundClass | null {
  const { natural, landuse, leisure } = tags;
  if (natural === "water" || natural === "bay" || tags.waterway === "riverbank" || tags.waterway === "dock" ||
      landuse === "reservoir" || landuse === "basin") return "water";
  if (natural === "wood" || landuse === "forest") return "forest";
  if (natural === "beach" || natural === "sand") return "sand";
  if (natural === "bare_rock" || natural === "scree" || landuse === "quarry") return "rock";
  if (tags.amenity === "parking") return "paved";
  if (leisure === "park" || leisure === "garden" || leisure === "pitch" || leisure === "golf_course" ||
      leisure === "playground" || leisure === "dog_park" || leisure === "common" ||
      landuse === "grass" || landuse === "meadow" || landuse === "village_green" || landuse === "recreation_ground" ||
      landuse === "cemetery" || landuse === "allotments" || landuse === "orchard" || landuse === "vineyard" ||
      natural === "grassland" || natural === "scrub" || natural === "heath" || natural === "wetland") return "grass";
  if (landuse === "farmland" || landuse === "farmyard") return "farm";
  if (landuse === "residential" || landuse === "commercial" || landuse === "industrial" || landuse === "retail" ||
      landuse === "construction" || landuse === "railway") return "urban";
  return null;
}

const STOCK: [RegExp, Stock][] = [
  [/donkey|mule/, "donkey"], [/horse|equine|pony/, "horse"], [/cattle|cow|dairy|beef/, "cow"], [/goat/, "goat"], [/sheep/, "sheep"],
  [/pig|swine|hog/, "pig"], [/goose|geese/, "goose"], [/chicken|poultry|hen|fowl/, "chicken"],
];

/** The kind of field an area is, when animals might be kept on it. */
export function fieldOf(tags: Record<string, string>): { kind: FieldKind; stock?: Stock } | null {
  const { landuse } = tags;
  const kind: FieldKind | null = landuse === "animal_keeping" ? "paddock" : landuse === "meadow" ? "meadow"
    : landuse === "farmyard" ? "farmyard" : landuse === "farmland" ? "farmland" : null;
  if (!kind) return null;
  const said = `${tags.animal_keeping ?? ""} ${tags.livestock ?? ""} ${tags.animal ?? ""}`.toLowerCase();
  const stock = STOCK.find(([re]) => re.test(said))?.[1];
  return stock ? { kind, stock } : { kind };
}

/** Joins way fragments end-to-end into closed rings (multipolygon outers). Unclosed leftovers are dropped. */
export function stitchRings(parts: number[][]): number[][] {
  const rings: number[][] = [];
  const open = parts.filter((p) => p.length >= 2).map((p) => p.slice());
  while (open.length) {
    let cur = open.pop()!;
    let grew = true;
    while (cur[0] !== cur[cur.length - 1] && grew) {
      grew = false;
      for (let i = 0; i < open.length; i++) {
        const p = open[i];
        const end = cur[cur.length - 1];
        if (p[0] === end) cur = cur.concat(p.slice(1));
        else if (p[p.length - 1] === end) cur = cur.concat(p.slice(0, -1).reverse());
        else continue;
        open.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (cur.length >= 4 && cur[0] === cur[cur.length - 1]) rings.push(cur);
  }
  return rings;
}

/** Address tags for the labels route; absent tags stay absent rather than becoming undefined fields. */
const street = (tags: Record<string, string>): { street?: string } => (tags["addr:street"]?.trim() ? { street: tags["addr:street"].trim() } : {});
const address = (tags: Record<string, string>): { housenumber?: string; street?: string } =>
  tags["addr:housenumber"]?.trim() ? { housenumber: tags["addr:housenumber"].trim(), ...street(tags) } : {};

/** What a building (or a named place) is, from its tags, where it is one of the kinds drawn as themselves. */
export function useOf(tags: Record<string, string>): BuildingUse | null {
  const { amenity = "", building = "", shop = "" } = tags;
  if (amenity === "place_of_worship" || /^(church|cathedral|chapel|mosque|temple|synagogue|shrine)$/.test(building)) {
    const faith = tags.religion ?? (building === "mosque" ? "muslim" : /^(temple|synagogue|shrine)$/.test(building) ? "other" : "christian");
    return faith === "muslim" ? "mosque" : faith === "christian" ? "church" : "temple";
  }
  if (amenity === "fuel") return "fuel";
  if (/^(hospital|clinic)$/.test(amenity) || building === "hospital") return "hospital";
  // (Not universities and colleges: a campus is dozens of buildings, and would be a forest of flagpoles.)
  if (/^(school|kindergarten)$/.test(amenity) || /^(school|kindergarten)$/.test(building)) return "school";
  if (/^(cafe|restaurant|pub|bar|fast_food|ice_cream|food_court|biergarten)$/.test(amenity)) return "food";
  if ((shop && shop !== "no" && shop !== "vacant") || /^(retail|supermarket|kiosk)$/.test(building) || /^(bank|pharmacy|post_office|marketplace)$/.test(amenity)) return "shop";
  return null;
}

/** A name fit for a sign: one line, not too long (cut at a word where it can be). */
export function signName(name: string | undefined): string | null {
  const text = (name ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length <= 30) return text;
  const cut = text.slice(0, 30);
  // (And not left hanging on an "and" or a comma: one word or one run of punctuation at a time, a few times over.)
  let name = cut.lastIndexOf(" ") > 14 ? cut.slice(0, cut.lastIndexOf(" ")) : cut;
  for (let i = 0; i < 4; i++) name = name.replace(/[\s,;:&/-]+$/, "").replace(/\s(and|of|the|et|de|und|y)$/i, "");
  return name.trim();
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

function roofOf(tags: Record<string, string>): Pick<Building, "roof" | "roofHeight" | "roofColour" | "roofDirection" | "roofAcross"> {
  const out: Pick<Building, "roof" | "roofHeight" | "roofColour" | "roofDirection" | "roofAcross"> = {};
  if (tags["roof:shape"]) out.roof = tags["roof:shape"];
  const h = num(tags["roof:height"]);
  if (h && h > 0 && h < 400) out.roofHeight = h; // a spire, or the leaning leg of a lattice tower, is all roof
  const paint = roofPaint(tags);
  if (paint !== null) out.roofColour = paint;
  const facing = tags["roof:direction"]?.trim().toUpperCase();
  if (facing) {
    const point = COMPASS.indexOf(facing);
    const degrees = point >= 0 ? point * 22.5 : /^-?[0-9.]+$/.test(facing) ? Number(facing) : NaN;
    if (Number.isFinite(degrees)) out.roofDirection = ((degrees % 360) + 360) % 360;
  }
  if (tags["roof:orientation"] === "across") out.roofAcross = true;
  return out;
}

/** What is mapped about a building's walls: their paint, and where they start when that is above the ground. */
function wallsOf(tags: Record<string, string>, height: number): Pick<Building, "colour" | "brick" | "minHeight"> {
  const out: Pick<Building, "colour" | "brick" | "minHeight"> = { ...(wallPaint(tags) ?? {}) };
  const levels = num(tags["building:min_level"]);
  const from = num(tags.min_height) ?? (levels && levels > 0 ? levels * 3.1 : null);
  if (from && from >= 1 && from < height - 0.5) out.minHeight = from;
  return out;
}

function inRing(x: number, y: number, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Puts the extras into what was parsed: each 3D piece on the building whose outline its middle is in
 * (the smallest, where outlines are nested), and the named places.
 */
export function addExtras(out: Features, extra: OsmJson): void {
  const nodes = new Map<number, Pt>();
  const ways = new Map<number, OsmElement>();
  const places: NamedPlace[] = [];
  for (const el of extra.elements) {
    if (el.type === "node" && el.lat !== undefined && el.lon !== undefined) {
      const at: Pt = [lonToX(el.lon, CHUNK_Z), latToY(el.lat, CHUNK_Z)];
      nodes.set(el.id, at);
      const key = el.tags ? PLACE_KEYS.find((k) => el.tags![k]) : undefined;
      if (key && el.tags!.name) places.push({ id: el.id, at, name: el.tags!.name, kind: `${key}=${el.tags![key]}` });
    } else if (el.type === "way" && el.nodes) ways.set(el.id, el);
  }
  if (places.length) out.places = places;
  const ringOf = (ids: number[] | undefined): Pt[] | null => {
    if (!ids || ids.length < 4 || ids[0] !== ids[ids.length - 1]) return null;
    const pts: Pt[] = [];
    for (const id of ids.slice(0, -1)) { const p = nodes.get(id); if (p) pts.push(p); }
    return pts.length >= 3 && pts.length === ids.length - 1 ? pts : null;
  };
  const isPart = (tags: Record<string, string> | undefined): tags is Record<string, string> => !!tags?.["building:part"] && tags["building:part"] !== "no";
  const pieces: { id: number; tags: Record<string, string>; ring: Pt[] }[] = [];
  for (const el of extra.elements) {
    if (el.type === "way" && isPart(el.tags)) {
      const ring = ringOf(el.nodes);
      if (ring) pieces.push({ id: el.id, tags: el.tags, ring });
    } else if (el.type === "relation" && isPart(el.tags) && el.members) {
      // A piece with a hole in it: its outer outlines, each a closed way.
      el.members.forEach((m, n) => {
        const ring = m.type === "way" && m.role !== "inner" ? ringOf(ways.get(m.ref)?.nodes) : null;
        if (ring) pieces.push({ id: -(el.id * 8 + (n % 8)), tags: el.tags!, ring });
      });
    }
  }
  if (!pieces.length && !places.length) return;
  const boxes = out.buildings.map((b) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of b.ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return { b, x0, y0, x1, y1, size: (x1 - x0) * (y1 - y0) };
  }).sort((p, q) => p.size - q.size);
  for (const piece of pieces) {
    let mx = 0, my = 0;
    for (const [x, y] of piece.ring) { mx += x / piece.ring.length; my += y / piece.ring.length; }
    const home = boxes.find((o) => mx >= o.x0 && mx <= o.x1 && my >= o.y0 && my <= o.y1 && inRing(mx, my, o.b.ring))?.b;
    const t = piece.tags;
    const metres = num(t.height) ?? num(t["building:height"]);
    const levels = num(t["building:levels"]);
    const from = num(t.min_height) ?? (num(t["building:min_level"]) ?? 0) * 3.1;
    const height = metres && metres > 0.5 && metres < 1000 ? metres : levels && levels > 0 && levels < 250 ? from + levels * 3.1 + (from > 0 ? 0 : 1.2) : home?.height ?? from + 8;
    if (height - from < 0.3) continue;
    const part: BuildingPart = {
      id: piece.id, ring: piece.ring, height, ...roofOf(t), ...(wallPaint(t) ?? {}),
      ...(from >= 0.3 ? { minHeight: from } : {}), ...(levels && levels > 0 ? { storeys: true } : {}), ...(metres ? { measured: true } : {}),
      ...(t.wall === "no" || t["building:part"] === "roof" ? { roofOnly: true } : {}),
    };
    if (home) (home.parts ??= []).push(part);
    // A piece standing in no building (a tower mapped as a tower and not as a building, a canopy that
    // overhangs its outline) is drawn all the same, as a building of that one piece.
    else out.buildings.push({ id: piece.id > 0 ? -(piece.id * 8 + 7) : piece.id * 8 - 7, ring: piece.ring, height, parts: [part] });
  }
  // A named place standing in a building that has no name of its own gives it its name and what it is:
  // the café on the corner. Only the first for each building, and not for the biggest buildings, where one
  // shop among fifty would name the lot.
  const S = metersPerTile(out.buildings[0]?.ring[0][1] ?? 0);
  for (const place of places) {
    const [px, py] = place.at;
    const home = boxes.find((o) => px >= o.x0 && px <= o.x1 && py >= o.y0 && py <= o.y1 && inRing(px, py, o.b.ring));
    if (!home || home.b.name || home.size * S * S > 2500) continue;
    const name = signName(place.name);
    if (!name) continue;
    home.b.name = name;
    const [key, value] = place.kind.split("=");
    const use = home.b.use ?? useOf({ [key]: value });
    if (use) home.b.use = use;
  }
  // One piece that only repeats the outline is no 3D model; the building is drawn as any other.
  // Among several, the outline over again would only wrap the others up.
  for (const b of out.buildings) {
    if (b.parts?.length === 1 && b.parts[0].id === b.id) delete b.parts;
    else if (b.parts && b.parts.length > 1) b.parts = b.parts.filter((p) => p.id !== b.id);
  }
}

export function parseOsm(json: OsmJson, extra?: OsmJson | null): Features {
  const nodes = new Map<number, Pt>();
  const ways = new Map<number, OsmElement>();
  const fields: Field[] = [];
  const out: Features = { buildings: [], roads: [], areas: [], trees: [], addresses: [], coast: [], fields };

  for (const el of json.elements) {
    if (el.type === "node" && el.lat !== undefined && el.lon !== undefined) {
      const at: Pt = [lonToX(el.lon, CHUNK_Z), latToY(el.lat, CHUNK_Z)];
      nodes.set(el.id, at);
      if (el.tags?.natural === "tree") out.trees.push({ id: el.id, at });
      if (el.tags?.["addr:housenumber"]?.trim()) out.addresses.push({ id: el.id, at, housenumber: el.tags["addr:housenumber"].trim(), ...street(el.tags) });
    } else if (el.type === "way" && el.nodes) {
      ways.set(el.id, el);
    }
  }

  const coords = (ids: number[]): Pt[] => {
    const pts: Pt[] = [];
    for (const id of ids) {
      const p = nodes.get(id);
      if (p) pts.push(p);
    }
    return pts;
  };
  /** Closed node-id ring -> points without the repeated last vertex. */
  const ringOf = (ids: number[]): Pt[] | null => {
    if (ids.length < 4 || ids[0] !== ids[ids.length - 1]) return null;
    const pts = coords(ids.slice(0, -1));
    return pts.length >= 3 && pts.length === ids.length - 1 ? pts : null;
  };

  const isBuilding = (tags: Record<string, string>): boolean => !!tags.building && tags.building !== "no";
  const addBuilding = (id: number, tags: Record<string, string>, ring: Pt[], holes: Pt[][] = []): void => {
    if (tags.location === "underground" || (num(tags.layer) ?? 0) < 0) return;
    const kind = tags.building !== "yes" ? { kind: tags.building } : {};
    const metres = num(tags.height) ?? num(tags["building:height"]);
    const measured = metres && metres > 1 && metres < 1000 ? { measured: true } : {};
    const guessed = metres || num(tags["building:levels"]) ? {} : { guessed: true };
    const height = buildingHeight(id, tags);
    const name = signName(tags.name);
    const use = useOf(tags);
    out.buildings.push({
      id, ring, height, ...address(tags), ...roofOf(tags), ...wallsOf(tags, height), ...kind, ...guessed, ...measured, ...(holes.length ? { holes } : {}),
      ...(name ? { name } : {}), ...(use ? { use } : {}),
    });
  };

  const usedAsOuter = new Set<number>();
  /** Outlines already drawn as part of a building mapped with holes: the outline's own way is not a second building. */
  const drawnAsOuter = new Set<number>();
  for (const el of json.elements) {
    if (el.type !== "relation" || el.tags?.type !== "multipolygon" || !el.members) continue;
    const tags = el.tags;
    const cls = groundClassOf(tags);
    const field = isBuilding(tags) ? null : fieldOf(tags);
    if (!isBuilding(tags) && !cls && !field) continue;
    // Ground cover keeps inner rings as holes among its rings; a building's are its courtyards.
    const parts: number[][] = [];
    const inner: number[][] = [];
    /** A building's outlines that are one closed way each, with what that way says about itself. */
    const whole: { ring: Pt[]; tags: Record<string, string> }[] = [];
    for (const m of el.members) {
      if (m.type !== "way") continue;
      const w = ways.get(m.ref);
      if (!w?.nodes) continue;
      if (m.role !== "inner") usedAsOuter.add(m.ref);
      if (!isBuilding(tags)) parts.push(w.nodes);
      else if (m.role === "inner") inner.push(w.nodes);
      else {
        const ring = ringOf(w.nodes);
        if (ring) {
          // The way may carry the details (its height, its colour); what the relation says comes first.
          whole.push({ ring, tags: w.tags && isBuilding(w.tags) ? { ...w.tags, ...tags } : tags });
          drawnAsOuter.add(m.ref);
        } else parts.push(w.nodes);
      }
    }
    const rings = stitchRings(parts).map(ringOf).filter((r): r is Pt[] => r !== null);
    if (isBuilding(tags)) {
      const outlines = [...whole, ...rings.map((ring) => ({ ring, tags }))];
      const yards = stitchRings(inner).map(ringOf).filter((r): r is Pt[] => r !== null);
      // Negative, distinct ids keep relation pieces from colliding with way ids.
      outlines.forEach((o, n) => addBuilding(-(el.id * 8 + (n % 8)), o.tags, o.ring, yards.filter((y) => inRing(y[0][0], y[0][1], o.ring)).slice(0, 8)));
    } else if (rings.length) {
      if (cls) out.areas.push({ id: -el.id, cls, rings, ...(tags.natural === "bay" ? { salt: true } : {}) });
      if (field) fields.push({ id: -el.id, ...field, rings });
    }
  }

  for (const w of ways.values()) {
    const tags = w.tags;
    if (!tags || !w.nodes) continue;
    if (tags.natural === "coastline") {
      const pts = coords(w.nodes);
      if (pts.length >= 2) out.coast.push(pts);
      continue;
    }
    const closed = w.nodes.length >= 4 && w.nodes[0] === w.nodes[w.nodes.length - 1];
    const line = tags.highway || tags.railway || (tags.waterway && tags.waterway !== "riverbank" && tags.waterway !== "dock");
    if (line && !(closed && tags.area === "yes")) {
      const pts = coords(w.nodes);
      if (pts.length >= 2) {
        const road = roadOf(w.id, tags, pts);
        if (road) out.roads.push(road);
      }
      continue;
    }
    if (!closed) continue;
    const field = isBuilding(tags) ? null : fieldOf(tags);
    if (usedAsOuter.has(w.id) && !tags.building && !groundClassOf(tags) && !field) continue;
    const ring = ringOf(w.nodes);
    if (!ring) continue;
    const cls = groundClassOf(tags);
    if (isBuilding(tags)) { if (!drawnAsOuter.has(w.id)) addBuilding(w.id, tags, ring); }
    else if (cls) out.areas.push({ id: w.id, cls, rings: [ring], ...(tags.natural === "bay" ? { salt: true } : {}) });
    if (field) fields.push({ id: w.id, ...field, rings: [ring] });
  }
  if (extra) addExtras(out, extra);
  return out;
}

const parsed = new Map<string, Features>();

/** Parsed features for one DATA_Z tile, with a small in-memory cache. */
export async function loadFeatures(dx: number, dy: number, fetcher = fetchOsmTile, extras: (dx: number, dy: number) => Promise<OsmJson | null> = fetcher === fetchOsmTile ? fetchExtras : async () => ({ elements: [] })): Promise<Features> {
  const key = `${dx}/${dy}`;
  let f = parsed.get(key);
  // Parsed without its extras, it is parsed again as soon as they can be had (afresh, since what was
  // worked out from it, such as which houses have a front door, is remembered against the old one).
  if (!f || f.partial) {
    const [json, extra] = await Promise.all([fetcher(dx, dy), extras(dx, dy)]);
    if (f?.partial && !extra) return f;
    f = parseOsm(json, extra);
    if (!extra) f.partial = true;
    // (Sixteen tiles, where it was sixty-four: a parsed tile of a city centre is tens of megabytes, and the live server has few to spare.)
    if (parsed.size >= 16) parsed.delete(parsed.keys().next().value!);
    parsed.set(key, f);
  }
  return f;
}
