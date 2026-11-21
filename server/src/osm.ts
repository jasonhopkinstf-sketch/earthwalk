// Fetches raw OpenStreetMap data for an area and turns it into the features the
// world generator understands: buildings, roads and ground-cover areas.

import { CHUNK_Z, hash32, latToY, lonToX, xToLon, yToLat } from "./geo.ts";
import { cacheRead, cacheWrite, InFlight } from "./cache.ts";
import { httpGet, Throttle } from "./net.ts";

/** OSM data is fetched and cached in tiles at this zoom (2x2 chunks each). */
export const DATA_Z = 15;

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
}
/** `name` is set for highway ways only. */
export interface Road { id: number; cls: RoadClass; width: number; pts: Pt[]; name?: string }
/** A house number mapped as a standalone point rather than on a building. */
export interface AddressPoint { id: number; at: Pt; housenumber: string; street?: string }
/** Ground cover. A point is inside if it is within an odd number of rings, so inner rings are holes (islands in a lake). */
export interface Area { id: number; cls: GroundClass; rings: Pt[][] }
export interface TreePoint { id: number; at: Pt }
export interface Features {
  buildings: Building[];
  roads: Road[];
  areas: Area[];
  trees: TreePoint[];
  addresses: AddressPoint[];
  /** Coastline pieces. By OpenStreetMap convention, land is on the left of the direction of travel. */
  coast: Pt[][];
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
  "https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter")
  .split(",").map((s) => s.trim()).filter(Boolean);
const OSM_API_URL = process.env.EARTHWALK_OSM_API_URL ?? "https://api.openstreetmap.org/api/0.6";
/** "overpass,osmapi" tries Overpass mirrors first, then the main OSM API. */
const SOURCES = (process.env.EARTHWALK_OSM_SOURCES ?? "overpass,osmapi").split(",").map((s) => s.trim());

// Newest first: the map for where a player is now comes before places they have already left.
const throttle = new Throttle(1100, true);
const inflight = new InFlight<OsmJson>();
let overpassDownUntil = 0;

interface BBox { w: number; s: number; e: number; n: number }

function overpassQuery(b: BBox): string {
  const bb = `(${b.s},${b.w},${b.n},${b.e})`;
  return `[out:json][timeout:40];(` +
    `way["building"]${bb};way["highway"]${bb};way["railway"="rail"]${bb};way["waterway"]${bb};` +
    `way["natural"]${bb};way["landuse"]${bb};way["leisure"]${bb};way["amenity"="parking"]${bb};` +
    `node["natural"="tree"]${bb};node["addr:housenumber"]${bb};` +
    `relation["type"="multipolygon"]["building"]${bb};relation["type"="multipolygon"]["natural"]${bb};` +
    `relation["type"="multipolygon"]["landuse"]${bb};relation["type"="multipolygon"]["leisure"]${bb};` +
    `);out body;>;out skel qt;`;
}

async function fromOverpass(b: BBox): Promise<OsmJson> {
  if (Date.now() < overpassDownUntil) throw new Error("overpass recently failed; skipping");
  let lastErr: unknown;
  for (const url of OVERPASS_URLS) {
    try {
      const res = await httpGet(url, 45000, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(overpassQuery(b))}`,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as OsmJson;
    } catch (err) {
      lastErr = err;
    }
  }
  overpassDownUntil = Date.now() + 10 * 60 * 1000;
  throw new Error(`all Overpass endpoints failed: ${String(lastErr)}`);
}

async function fromOsmApi(b: BBox, depth = 0): Promise<OsmJson> {
  const res = await httpGet(`${OSM_API_URL}/map.json?bbox=${b.w},${b.s},${b.e},${b.n}`, 60000);
  if (res.status === 400 && depth < 3) {
    // Too many nodes in one request: split into quadrants and merge.
    const mx = (b.w + b.e) / 2;
    const my = (b.s + b.n) / 2;
    const quads: BBox[] = [
      { w: b.w, s: my, e: mx, n: b.n }, { w: mx, s: my, e: b.e, n: b.n },
      { w: b.w, s: b.s, e: mx, n: my }, { w: mx, s: b.s, e: b.e, n: my },
    ];
    const seen = new Set<string>();
    const elements: OsmElement[] = [];
    for (const q of quads) {
      for (const el of (await fromOsmApi(q, depth + 1)).elements) {
        const key = el.type[0] + el.id;
        if (!seen.has(key)) { seen.add(key); elements.push(el); }
      }
    }
    return { elements };
  }
  if (!res.ok) throw new Error(`OSM API HTTP ${res.status}`);
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

/** Raw OSM data for one DATA_Z tile (with a small margin), cached on disk. */
export function fetchOsmTile(dx: number, dy: number): Promise<OsmJson> {
  const rel = `osm/${DATA_Z}/${dx}/${dy}.json`;
  return inflight.get(rel, async () => {
    const cached = await cacheRead(rel);
    if (cached) return JSON.parse(cached.toString("utf8")) as OsmJson;
    const m = 0.08;
    const b: BBox = {
      w: xToLon(dx - m, DATA_Z), e: xToLon(dx + 1 + m, DATA_Z),
      n: yToLat(dy - m, DATA_Z), s: yToLat(dy + 1 + m, DATA_Z),
    };
    const json = await throttle.run(async () => {
      let lastErr: unknown;
      for (const src of SOURCES) {
        try {
          return src === "overpass" ? await fromOverpass(b) : await fromOsmApi(b);
        } catch (err) {
          lastErr = err;
        }
      }
      throw new Error(`no OSM source answered for tile ${dx}/${dy}: ${String(lastErr)}`);
    });
    await throttle.run(() => completeRelations(json));
    await cacheWrite(rel, JSON.stringify(json));
    return json;
  });
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
      return named({ id, cls: "road", width: Math.min(Math.max(width, 2.5), 40), pts }, tags.name);
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

function roofOf(tags: Record<string, string>): { roof?: string; roofHeight?: number } {
  const out: { roof?: string; roofHeight?: number } = {};
  if (tags["roof:shape"]) out.roof = tags["roof:shape"];
  const h = num(tags["roof:height"]);
  if (h && h > 0 && h < 50) out.roofHeight = h;
  return out;
}

export function parseOsm(json: OsmJson): Features {
  const nodes = new Map<number, Pt>();
  const ways = new Map<number, OsmElement>();
  const out: Features = { buildings: [], roads: [], areas: [], trees: [], addresses: [], coast: [] };

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
  const addBuilding = (id: number, tags: Record<string, string>, ring: Pt[]): void => {
    if (tags.location === "underground" || (num(tags.layer) ?? 0) < 0) return;
    const kind = tags.building !== "yes" ? { kind: tags.building } : {};
    const guessed = num(tags.height) || num(tags["building:height"]) || num(tags["building:levels"]) ? {} : { guessed: true };
    out.buildings.push({ id, ring, height: buildingHeight(id, tags), ...address(tags), ...roofOf(tags), ...kind, ...guessed });
  };

  const usedAsOuter = new Set<number>();
  for (const el of json.elements) {
    if (el.type !== "relation" || el.tags?.type !== "multipolygon" || !el.members) continue;
    const tags = el.tags;
    const cls = groundClassOf(tags);
    if (!isBuilding(tags) && !cls) continue;
    // Buildings use their outer outlines only; ground cover keeps inner rings as holes.
    const parts: number[][] = [];
    for (const m of el.members) {
      if (m.type !== "way" || (isBuilding(tags) && m.role === "inner")) continue;
      const w = ways.get(m.ref);
      if (w?.nodes) { parts.push(w.nodes); if (m.role !== "inner") usedAsOuter.add(m.ref); }
    }
    const rings = stitchRings(parts).map(ringOf).filter((r): r is Pt[] => r !== null);
    if (isBuilding(tags)) {
      // Negative, distinct ids keep relation pieces from colliding with way ids.
      rings.forEach((ring, n) => addBuilding(-(el.id * 8 + (n % 8)), tags, ring));
    } else if (cls && rings.length) {
      out.areas.push({ id: -el.id, cls, rings });
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
    if (usedAsOuter.has(w.id) && !tags.building && !groundClassOf(tags)) continue;
    const ring = ringOf(w.nodes);
    if (!ring) continue;
    const cls = groundClassOf(tags);
    if (isBuilding(tags)) addBuilding(w.id, tags, ring);
    else if (cls) out.areas.push({ id: w.id, cls, rings: [ring] });
  }
  return out;
}

const parsed = new Map<string, Features>();

/** Parsed features for one DATA_Z tile, with a small in-memory cache. */
export async function loadFeatures(dx: number, dy: number, fetcher = fetchOsmTile): Promise<Features> {
  const key = `${dx}/${dy}`;
  let f = parsed.get(key);
  if (!f) {
    f = parseOsm(await fetcher(dx, dy));
    if (parsed.size >= 64) parsed.delete(parsed.keys().next().value!);
    parsed.set(key, f);
  }
  return f;
}
