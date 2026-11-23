// A second source of buildings and of named places, beside OpenStreetMap: the Overture Maps Foundation's
// open map (overturemaps.org), which puts OpenStreetMap together with outlines and places given by others
// (Esri's community maps, Microsoft, Meta, Foursquare...). It is published every month as PMTiles archives
// of the whole world, which are read here one block at a time with range requests (pmtiles.ts).
//
// What is taken from it, and only this:
// - outlines of buildings OpenStreetMap does not have (OpenStreetMap wins wherever both have one);
// - heights, floors, roofs and colours for buildings whose own map says less;
// - named shops, places to eat, schools and the like, to put on the buildings they stand in.
// Everything is put into OpenStreetMap's own words (tags) and handed to the same code, so the world
// draws it in its own style and neither game needs to know where a building came from.
//
// Licences: the buildings are under the Open Database License, as OpenStreetMap is; the places under
// CDLA Permissive 2.0 and Apache 2.0. Credit: "© OpenStreetMap contributors, Overture Maps Foundation".

import { BLOCK_Z, buildingOf, DATA_MARGIN, DATA_Z, inRing, signName, useOf, type Building, type Features, type NamedPlace, type Pt } from "./osm.ts";
import { CHUNK_Z, metersPerTile } from "./geo.ts";
import { Late } from "./late.ts";
import { httpGet, Pool } from "./net.ts";
import { decodeMvt, httpRanges, PmArchive, ringArea } from "./pmtiles.ts";

/** A block's side in the units its outlines are kept in (about half a metre). */
export const UNITS = 4096;

/**
 * A building as kept. One that Overture made from OpenStreetMap has `osm` (the way or relation it came
 * from, as "w123" or "r45") and no outline: it only carries what Overture knows about it. Any other has
 * `r`, its outline as x, y, x, y... in UNITS across the block from its north-west corner, and `s`, whose
 * outline it is. `t` is what is known about it, in OpenStreetMap's tags.
 */
export interface OvertureBuilding { id?: number; osm?: string; s?: string; r?: number[]; holes?: number[][]; t: Record<string, string> }
/** A named place: where (in UNITS), its name, what it is as an OpenStreetMap tag ("amenity=cafe"), and how sure Overture is of it (0 to 100). */
export interface OverturePlace { id: number; x: number; y: number; n: string; k: string; c: number }
export interface OvertureBlock { v: 1; release: string; buildings: OvertureBuilding[]; places: OverturePlace[] }

const ON = process.env.EARTHWALK_OVERTURE !== "0";
const CATALOG_URL = process.env.EARTHWALK_OVERTURE_CATALOG ?? "https://stac.overturemaps.org/catalog.json";
const TILES_URL = (process.env.EARTHWALK_OVERTURE_TILES ?? "https://tiles.overturemaps.org").replace(/\/+$/, "");
/**
 * Whose outlines are left out, by Overture's name for them. "Google Open Buildings" is an open set
 * (CC BY 4.0 and ODbL) and nothing to do with Google's maps or 3D tiles, but the game's owner has said
 * nothing of Google's goes in without his word: so it is out until the setting says otherwise.
 */
export const LEFT_OUT = (process.env.EARTHWALK_OVERTURE_LEAVE_OUT ?? "Google Open Buildings").split(",").map((s) => s.trim()).filter(Boolean);
/** Places Overture is less sure of than this are left out: below it they are mostly pages somebody once made. */
export const MIN_CONFIDENCE = 0.6;
/** No contact address is sent to Overture's servers: only what the program is. */
const AGENT = "earthwalk-server/0.1";

// ---------------------------------------------------------------- reading a block's tiles

const TAGS: [string, string][] = [
  ["height", "height"], ["num_floors", "building:levels"], ["min_height", "min_height"], ["min_floor", "building:min_level"],
  ["roof_shape", "roof:shape"], ["roof_height", "roof:height"], ["roof_direction", "roof:direction"], ["roof_orientation", "roof:orientation"],
  ["roof_color", "roof:colour"], ["roof_material", "roof:material"], ["facade_color", "building:colour"], ["facade_material", "building:material"],
];

/** Cuts a ring to the block's own square (Sutherland and Hodgman's way), for an outline the tile's edge cut short. */
export function cutToBlock(ring: [number, number][]): [number, number][] {
  let pts = ring;
  const sides: [(p: [number, number]) => boolean, (a: [number, number], b: [number, number]) => [number, number]][] = [
    [(p) => p[0] >= 0, (a, b) => [0, a[1] + ((b[1] - a[1]) * (0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= UNITS, (a, b) => [UNITS, a[1] + ((b[1] - a[1]) * (UNITS - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= 0, (a, b) => [a[0] + ((b[0] - a[0]) * (0 - a[1])) / (b[1] - a[1]), 0]],
    [(p) => p[1] <= UNITS, (a, b) => [a[0] + ((b[0] - a[0]) * (UNITS - a[1])) / (b[1] - a[1]), UNITS]],
  ];
  for (const [inside, cross] of sides) {
    const out: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if (inside(a)) out.push(a);
      if (inside(a) !== inside(b)) out.push(cross(a, b));
    }
    pts = out;
    if (pts.length < 3) return [];
  }
  return pts.map(([x, y]) => [Math.round(x), Math.round(y)]);
}

/** A number of our own for one of Overture's ids (a UUID): far above any of OpenStreetMap's, and the same every time. */
export function idOf(uuid: string, n = 0): number {
  const hex = uuid.replace(/[^0-9a-f]/gi, "").slice(0, 10);
  return 2 ** 44 + (parseInt(hex || "0", 16) % 2 ** 40) * 8 + (n % 8);
}

/**
 * What is kept of a block's buildings tile. `scale` and `ox`, `oy` place the tile's grid on the block's
 * (they are 1, 0, 0 when the tile is the block, which is the usual case).
 */
export function trimBuildings(tile: Buffer, leftOut: string[] = LEFT_OUT, scale = 1, ox = 0, oy = 0): OvertureBuilding[] {
  const layer = decodeMvt(tile, (name) => name === "building")[0];
  if (!layer) return [];
  const k = (UNITS / layer.extent) * scale;
  const out: OvertureBuilding[] = [];
  // Where the tile's edge cut things off: the furthest any outline reaches past the tile. A tile is made with a
  // border of a whole number of 256ths of its width, and what crosses that border is cut along it.
  const shapes = new Map<number, [number, number][][]>();
  let lo = 0, hi = layer.extent;
  const mine = layer.features.filter((f) => f.type === 3 && layer.prop(f, "is_underground") !== true);
  for (let i = 0; i < mine.length; i++) {
    if (layer.prop(mine[i], "@geometry_source") === "OpenStreetMap") continue;
    const rings = layer.rings(mine[i]);
    shapes.set(i, rings);
    for (const ring of rings) for (const [x, y] of ring) { if (x < lo) lo = x; if (y < lo) lo = y; if (x > hi) hi = x; if (y > hi) hi = y; }
  }
  const border = Math.max(-lo, hi - layer.extent);
  const cutAt = border > 0 && border % (layer.extent / 256) === 0 ? border : 0;
  const onEdge = (ring: [number, number][]): boolean => cutAt > 0 && ring.filter(([x, y]) => x === -cutAt || y === -cutAt || x === layer.extent + cutAt || y === layer.extent + cutAt).length >= 2;
  mine.forEach((f, i) => {
    const t: Record<string, string> = {};
    for (const [theirs, ours] of TAGS) {
      const v = layer.prop(f, theirs);
      if (v !== undefined && v !== "") t[ours] = String(v);
    }
    const source = String(layer.prop(f, "@geometry_source") ?? "");
    if (source === "OpenStreetMap") {
      if (Object.keys(t).length === 0) return; // it knows nothing the map it came from does not
      const from = /"record_id":"([wr])(\d+)@/.exec(String(layer.prop(f, "sources") ?? ""));
      if (from) out.push({ osm: from[1] + from[2], t });
      return;
    }
    if (leftOut.includes(source)) return;
    const cls = layer.prop(f, "class"), sub = layer.prop(f, "subtype"), name = layer.prop(f, "@name");
    t.building = typeof cls === "string" && cls ? cls : sub === "commercial" || sub === "industrial" ? sub : "yes";
    if (typeof name === "string" && name.trim()) t.name = name.trim();
    const uuid = String(layer.prop(f, "id") ?? f.id);
    const rings = shapes.get(i) ?? [];
    let n = 0;
    for (let r = 0; r < rings.length; r++) {
      if (ringArea(rings[r]) <= 0) continue; // a hole: taken with its outline, below
      const place = (ring: [number, number][]): [number, number][] => ring.map(([x, y]) => [Math.round(x * k - ox), Math.round(y * k - oy)]);
      let outline = place(rings[r]);
      // An outline the tile cut short is cut to the block itself, so that the block next door, which has the
      // rest of it, joins on cleanly; a whole one is left whole, and belongs to the block its middle is in.
      if (onEdge(rings[r])) outline = cutToBlock(outline);
      outline = outline.filter((p, j, all) => { const q = all[(j + all.length - 1) % all.length]; return p[0] !== q[0] || p[1] !== q[1]; });
      if (outline.length < 3 || Math.abs(ringArea(outline)) < 2 * 40) continue; // under about 10 m2
      const holes: number[][] = [];
      for (let h = r + 1; h < rings.length && ringArea(rings[h]) < 0 && holes.length < 8; h++) {
        const hole = place(rings[h]);
        if (hole.length >= 3 && Math.abs(ringArea(hole)) >= 2 * 40) holes.push(hole.flat());
      }
      out.push({ id: idOf(uuid, n++), s: source, r: outline.flat(), ...(holes.length ? { holes } : {}), t });
    }
  });
  return out;
}

/** Kinds of place a family game does not put a sign up for, wherever in Overture's words for a place they appear. */
const NOT_FOR_US = /adult|strip_club|cannabis|tobacco|vap(e|or)|hookah|casino|gambl|betting|firearm|\bgun|liquor|wine|beer|spirits|bottle_shop|nightlife|dance_club|lounge|brewery|distillery|\balcoholic|psychic|astrolog/;
/** Names that are not a sign: an address on the web, or a word the game does not write up. */
const NOT_A_NAME = /@|https?:|www\.|\.com\b|\b(sex|sexy|xxx|adult|adults|erotic|escort|escorts|strip|porn|nude|cannabis|hookah|shisha|vape|vapes|casino|gun|guns|firearms?)\b/i;

const EATING: Record<string, string> = {
  cafe: "cafe", coffee_shop: "cafe", smoothie_juice_bar: "cafe", non_alcoholic_beverage_venue: "cafe", tea_room: "cafe", bakery: "cafe",
  fast_food_restaurant: "fast_food", food_truck_stand: "fast_food", food_court: "food_court", bar: "bar", pub: "pub", ice_cream_shop: "ice_cream",
};
const OTHER: Record<string, string> = {
  gas_station: "amenity=fuel", hospital: "amenity=hospital", specialty_hospital: "amenity=hospital", emergency_or_urgent_care_facility: "amenity=hospital",
  bank_or_credit_union: "amenity=bank", post_office: "amenity=post_office", library: "amenity=library", museum: "tourism=museum", art_gallery: "tourism=gallery",
  theatre_venue: "amenity=theatre", performing_arts_venue: "amenity=theatre", movie_theater: "amenity=cinema", community_center: "amenity=community_centre",
  cultural_center: "amenity=community_centre", fire_station: "amenity=fire_station", police_station: "amenity=police", aquarium: "tourism=aquarium", zoo: "tourism=zoo",
  hotel: "tourism=hotel", lodging: "tourism=hotel", bed_and_breakfast: "tourism=guest_house", inn: "tourism=hotel", motel: "tourism=motel", hostel: "tourism=hostel", resort: "tourism=hotel",
};

/**
 * What a place is, as the OpenStreetMap tag for it ("amenity=cafe", "shop=bakery"), from Overture's words:
 * the path down its tree of kinds (`hierarchy`), the kind itself (`primary`) and its broad kind (`basic`).
 * Null for the kinds that get no sign: only places open to anybody who walks in are named (shops, places
 * to eat, schools, churches, hotels, museums...). Offices, agents and people who work from home are not:
 * most of those are somebody's name on somebody's house.
 */
export function placeKind(hierarchy: string[], primary: string, basic = ""): string | null {
  if (NOT_FOR_US.test([...hierarchy, primary, basic].join(" "))) return null;
  const top = hierarchy[0] ?? "";
  for (const word of [primary, basic]) {
    if (/place_of_worship$|^(church|cathedral|chapel|mosque|temple|synagogue|shrine)/.test(word)) {
      return /muslim|mosque/.test(word) ? "building=mosque" : /christian|church|cathedral|chapel|^place_of_worship$/.test(word) ? "amenity=place_of_worship" : "building=temple";
    }
  }
  for (const word of [primary, basic]) {
    if (/^(elementary|primary|middle|secondary|high)_school$|^school$/.test(word)) return "amenity=school";
    if (/^(preschool|kindergarten)$/.test(word)) return "amenity=kindergarten";
    if (OTHER[word]) return OTHER[word];
  }
  if (top === "food_and_drink") return `amenity=${EATING[primary] ?? EATING[basic] ?? "restaurant"}`;
  if (top === "shopping") {
    const what = primary && primary !== "shopping" ? primary : basic && basic !== "shopping" ? basic : "yes";
    return what === "shopping_mall" ? "shop=mall" : `shop=${what.replace(/_(store|shop)$/, "")}`;
  }
  return null;
}

/** A place's name, where it is one a sign can carry. */
export function placeName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const text = name.replace(/\s+/g, " ").trim();
  if (text.length < 2 || text.length > 60 || !/\p{L}/u.test(text) || NOT_A_NAME.test(text)) return null;
  return text;
}

/** What is kept of a block's places tile: the places in the block itself that get a sign. */
export function trimPlaces(tile: Buffer, scale = 1, ox = 0, oy = 0): OverturePlace[] {
  const layer = decodeMvt(tile, (name) => name === "place")[0];
  if (!layer) return [];
  const k = (UNITS / layer.extent) * scale;
  const out: OverturePlace[] = [];
  for (const f of layer.features) {
    if (f.type !== 1) continue;
    const confidence = Number(layer.prop(f, "confidence") ?? 0);
    if (!(confidence >= MIN_CONFIDENCE)) continue;
    const status = layer.prop(f, "operating_status");
    if (typeof status === "string" && status !== "open") continue;
    const name = placeName(layer.prop(f, "@name"));
    if (!name) continue;
    let hierarchy: string[] = [], primary = "";
    try {
      const taxonomy = JSON.parse(String(layer.prop(f, "taxonomy") ?? "{}")) as { primary?: unknown; hierarchy?: unknown };
      if (Array.isArray(taxonomy.hierarchy)) hierarchy = taxonomy.hierarchy.filter((h): h is string => typeof h === "string");
      if (typeof taxonomy.primary === "string") primary = taxonomy.primary;
    } catch { /* no kind: no sign */ }
    const kind = placeKind(hierarchy, primary, String(layer.prop(f, "basic_category") ?? ""));
    if (!kind) continue;
    const at = layer.rings(f)[0]?.[0];
    if (!at) continue;
    const x = Math.round(at[0] * k - ox), y = Math.round(at[1] * k - oy);
    if (x < 0 || x >= UNITS || y < 0 || y >= UNITS) continue; // in the next block: that block has it
    out.push({ id: idOf(String(layer.prop(f, "id") ?? f.id)), x, y, n: name, k: kind, c: Math.round(confidence * 100) });
  }
  return out;
}

// ---------------------------------------------------------------- fetching

/** Reads one tile of one of a release's archives ("buildings", "places"). */
export type TileReader = (release: string, theme: string, z: number, x: number, y: number) => Promise<{ tile: Buffer | null; maxZoom: number }>;

const archives = new Map<string, PmArchive>();
const readTile: TileReader = async (release, theme, z, x, y) => {
  const key = `${release}/${theme}`;
  let archive = archives.get(key);
  if (!archive) {
    // (Only the newest release's archives are kept open: an older one's are let go.)
    for (const old of archives.keys()) if (!old.startsWith(`${release}/`)) archives.delete(old);
    archives.set(key, archive = new PmArchive(httpRanges(`${TILES_URL}/${release}/${theme}.pmtiles`, AGENT)));
  }
  const maxZoom = await archive.maxZoom();
  const d = Math.max(0, z - maxZoom);
  return { tile: await archive.tile(z - d, x >> d, y >> d), maxZoom };
};

let release: { name: string; at: number } | null = null;
let releaseAsked: Promise<string> | null = null;
/**
 * The newest release's name ("2026-11-18.0"). Overture publishes one a month and takes each away after
 * sixty days, so it is looked up, and looked up again twice a day.
 */
export function latestRelease(now: () => number = Date.now, get: (url: string) => Promise<unknown> = async (url) => (await httpGet(url, 15_000, { headers: { "User-Agent": AGENT } })).json()): Promise<string> {
  if (release && now() - release.at < 12 * 3600_000) return Promise.resolve(release.name);
  return (releaseAsked ??= get(CATALOG_URL).then((json) => {
    const name = (json as { latest?: unknown }).latest;
    if (typeof name !== "string" || !/^[0-9][0-9A-Za-z.-]{5,30}$/.test(name)) throw new Error("Overture's catalogue names no latest release");
    release = { name, at: now() };
    return name;
  }).catch((err) => {
    if (release) return release.name; // the one known is tried for as long as it lasts
    throw err;
  }).finally(() => { releaseAsked = null; }));
}

/** Downloads a block's buildings and places, and keeps of them only what is used. */
export async function downloadBlock(bx: number, by: number, read: TileReader = readTile, newest: () => Promise<string> = latestRelease): Promise<OvertureBlock> {
  const name = await newest();
  const one = async <T>(theme: string, trim: (tile: Buffer, scale: number, ox: number, oy: number) => T[]): Promise<T[]> => {
    let got: { tile: Buffer | null; maxZoom: number };
    try {
      got = await read(name, theme, BLOCK_Z, bx, by);
    } catch (err) {
      // A release that has been taken away: the next block asked for looks the newest one up afresh.
      if (/HTTP 40[34]/.test(String(err))) release = null;
      throw err;
    }
    if (!got.tile) return [];
    // An archive that stops short of the block's zoom gives the tile the block is part of: its grid is laid over the block's.
    const d = Math.max(0, BLOCK_Z - got.maxZoom);
    return trim(got.tile, 2 ** d, (bx - ((bx >> d) << d)) * UNITS, (by - ((by >> d) << d)) * UNITS);
  };
  const [buildings, places] = await Promise.all([
    one("buildings", (tile, scale, ox, oy) => trimBuildings(tile, LEFT_OUT, scale, ox, oy)),
    one("places", trimPlaces),
  ]);
  return { v: 1, release: name, buildings, places };
}

/** A few blocks at a time, and those nobody is waiting for last. */
const pool = new Pool(3, 60);
const say = (line: string): void => { if (process.env.EARTHWALK_QUIET_MAP !== "1") console.log(line); };

const late = new Late<OvertureBlock>({
  name: "Overture buildings and places",
  rel: (bx, by) => `overture/v1/${BLOCK_Z}/${bx}/${by}.json`,
  owedRel: "overture/owed.json",
  fetch: (bx, by, quiet) => pool.add(() => downloadBlock(bx, by), quiet).promise,
  encode: (block) => JSON.stringify(block),
  decode: (kept) => {
    const block = JSON.parse(kept.toString("utf8")) as OvertureBlock;
    if (block.v !== 1 || !Array.isArray(block.buildings) || !Array.isArray(block.places)) throw new Error("not a block of Overture");
    return block;
  },
  waitMs: 4000,
  say,
});

/** True when Overture is one of the world's sources (it is, unless EARTHWALK_OVERTURE is 0). */
export const overtureOn = (): boolean => ON;

/**
 * What Overture has for the block a data tile is in. Null when it is not in the cache and does not come
 * within a few seconds: the block is then owed it, and what is built there is built again when it comes.
 */
export function fetchOverture(dx: number, dy: number): Promise<OvertureBlock | null> {
  const d = DATA_Z - BLOCK_Z;
  return late.get(dx >> d, dy >> d);
}
/** Asks to be told when a block's Overture data comes after something was built there without it. */
export function onOverture(listener: (bx: number, by: number) => void): void {
  late.onArrive(listener);
}
export function keepOvertureComing(everyMs?: number): void {
  late.keepComing(everyMs);
}

// ---------------------------------------------------------------- putting it into the map

interface Box { b: Building; x0: number; y0: number; x1: number; y1: number; size: number }
const boxOf = (b: Building): Box => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of b.ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { b, x0, y0, x1, y1, size: (x1 - x0) * (y1 - y0) };
};

/** How far a point is from a ring's nearest wall, and the point on that wall. */
function nearestOnRing(px: number, py: number, ring: Pt[]): { d: number; x: number; y: number } {
  let best = { d: Infinity, x: px, y: py };
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j], [bx, by] = ring[i];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const f = len2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const x = ax + dx * f, y = ay + dy * f;
    const d = Math.hypot(px - x, py - y);
    if (d < best.d) best = { d, x, y };
  }
  return best;
}

/** A name with everything but its letters and figures taken out, for telling two spellings of one place apart from two places. */
const plain = (name: string): string => name.toLowerCase().normalize("NFKD").replace(/&/g, " and ").replace(/\b(the|and|et|und|y|le|la)\b/g, " ").replace(/[^\p{L}\p{N}]+/gu, "");
const sameName = (a: string, b: string): boolean => a.length >= 3 && b.length >= 3 && (a === b || (Math.min(a.length, b.length) >= 5 && (a.startsWith(b) || b.startsWith(a))));

/** The share of an outline that already has a building on it, to count as the same building. */
const SAME_BUILDING = 0.25;
const ONE_OF_A_KIND = /^(fuel|school|hospital|church|mosque|temple)$/;
/** How far outside a building a place's point may be and still be that building's (metres): they are often put at the kerb. */
const PLACE_REACH_M = 8;

/**
 * Puts a block's Overture data into the features of one of its data tiles (`dx`, `dy`), which have
 * already been parsed from OpenStreetMap with their extras. OpenStreetMap wins everywhere: an Overture
 * outline is added only where it does not lie on a building already there, a height or a roof is taken
 * only by a building that has none mapped, and a place names a building only if it has no name.
 */
export function addOverture(out: Features, block: OvertureBlock, dx: number, dy: number): { added: number; improved: number; named: number } {
  const d = DATA_Z - BLOCK_Z, per = 2 ** (CHUNK_Z - BLOCK_Z), tile = 2 ** (CHUNK_Z - DATA_Z);
  const bx = dx >> d, by = dy >> d;
  const X = (u: number): number => (bx + u / UNITS) * per, Y = (u: number): number => (by + u / UNITS) * per;
  const m = DATA_MARGIN * tile;
  const w = dx * tile - m, e = (dx + 1) * tile + m, n = dy * tile - m, s = (dy + 1) * tile + m;
  const stats = { added: 0, improved: 0, named: 0 };

  // ---- what Overture knows about buildings the map already has
  const byId = new Map<number, Building>();
  for (const b of out.buildings) byId.set(b.id, b);
  const improve = (b: Building, t: Record<string, string>): void => {
    const known = buildingOf(b.id, { building: "yes", ...t }, b.ring);
    if (!known) return;
    let better = false;
    if (b.guessed && !known.guessed && !b.parts) {
      b.height = known.height;
      delete b.guessed;
      if (known.measured) b.measured = true;
      better = true;
    }
    if (!b.roof && known.roof) { b.roof = known.roof; if (known.roofHeight && !b.roofHeight) b.roofHeight = known.roofHeight; if (known.roofDirection !== undefined) b.roofDirection = known.roofDirection; if (known.roofAcross) b.roofAcross = true; better = true; }
    if (b.roofColour === undefined && known.roofColour !== undefined) { b.roofColour = known.roofColour; better = true; }
    if (b.colour === undefined && known.colour !== undefined) { b.colour = known.colour; if (known.brick) b.brick = true; better = true; }
    if (better) stats.improved++;
  };
  for (const o of block.buildings) {
    if (!o.osm) continue;
    const id = Number(o.osm.slice(1));
    if (o.osm[0] === "w") { const b = byId.get(id); if (b) improve(b, o.t); }
    else for (let k = 0; k < 8; k++) { const b = byId.get(-(id * 8 + k)); if (b) improve(b, o.t); }
  }

  // ---- outlines the map does not have
  const boxes = out.buildings.map(boxOf);
  const fresh: Building[] = [];
  for (const o of block.buildings) {
    if (!o.r || o.id === undefined) continue;
    const ring: Pt[] = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i + 1 < o.r.length; i += 2) {
      const x = X(o.r[i]), y = Y(o.r[i + 1]);
      ring.push([x, y]);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (ring.length < 3 || x1 < w || x0 > e || y1 < n || y0 > s) continue;
    // How much of it lies on buildings already there: a grid of points over it, each asked of every building near.
    const near = boxes.filter((q) => q.x1 >= x0 && q.x0 <= x1 && q.y1 >= y0 && q.y0 <= y1);
    if (near.length) {
      const hits = new Map<Building, number>();
      let inside = 0, covered = 0;
      const G = 6;
      for (let j = 0; j < G; j++) {
        for (let i = 0; i < G; i++) {
          const px = x0 + ((i + 0.5) / G) * (x1 - x0), py = y0 + ((j + 0.5) / G) * (y1 - y0);
          if (!inRing(px, py, ring)) continue;
          inside++;
          const on = near.find((q) => px >= q.x0 && px <= q.x1 && py >= q.y0 && py <= q.y1 && inRing(px, py, q.b.ring));
          if (on) { covered++; hits.set(on.b, (hits.get(on.b) ?? 0) + 1); }
        }
      }
      if (inside === 0) continue; // a sliver
      if (covered / inside >= SAME_BUILDING) {
        // The same building: the map's own outline stands, and takes from this one only what it has not got
        // (and nothing where this one lies across several of the map's: whose height would it be?).
        if (hits.size === 1) improve([...hits.keys()][0], o.t);
        continue;
      }
    }
    const holes = (o.holes ?? []).map((h) => { const pts: Pt[] = []; for (let i = 0; i + 1 < h.length; i += 2) pts.push([X(h[i]), Y(h[i + 1])]); return pts; });
    const b = buildingOf(o.id, o.t, ring, holes);
    if (b) fresh.push(b);
  }
  // (Two of Overture's own outlines do not lie on each other: it has seen to that itself.)
  for (const b of fresh) { out.buildings.push(b); boxes.push(boxOf(b)); }
  stats.added = fresh.length;

  // ---- named places
  if (block.places.length) {
    const S = metersPerTile(dy * tile, CHUNK_Z);
    const reach = PLACE_REACH_M / S;
    boxes.sort((p, q) => p.size - q.size);
    const places: NamedPlace[] = out.places ?? [];
    const known = places.map((p) => ({ at: p.at, name: plain(p.name) }));
    for (const q of boxes) if (q.b.name) known.push({ at: [(q.x0 + q.x1) / 2, (q.y0 + q.y1) / 2], name: plain(q.b.name) });
    // The places that say what a building is come first, and of those the surest.
    const order = block.places.filter((p) => { const x = X(p.x), y = Y(p.y); return x >= w && x <= e && y >= n && y <= s; })
      .map((p) => { const [key, value] = p.k.split("="); return { p, use: useOf({ [key]: value }) }; })
      .sort((a, b) => Number(!!b.use) - Number(!!a.use) || b.p.c - a.p.c || a.p.id - b.p.id);
    for (const { p, use } of order) {
      let px = X(p.x), py = Y(p.y);
      const name = plain(p.n);
      // The same place as one the map names already (within about 80 m): the map's stands.
      if (known.some((q) => Math.abs(q.at[0] - px) * S < 80 && Math.abs(q.at[1] - py) * S < 80 && sameName(q.name, name))) continue;
      let home = boxes.find((q) => px >= q.x0 && px <= q.x1 && py >= q.y0 && py <= q.y1 && inRing(px, py, q.b.ring));
      if (!home) {
        // Not in a building: the nearest one within reach, and the point is moved to just inside its wall.
        let best: { q: Box; d: number; x: number; y: number } | null = null;
        for (const q of boxes) {
          if (px < q.x0 - reach || px > q.x1 + reach || py < q.y0 - reach || py > q.y1 + reach) continue;
          const near = nearestOnRing(px, py, q.b.ring);
          if (near.d <= reach && (!best || near.d < best.d)) best = { q, ...near };
        }
        if (!best) continue;
        const cx = (best.q.x0 + best.q.x1) / 2, cy = (best.q.y0 + best.q.y1) / 2;
        const len = Math.hypot(cx - best.x, cy - best.y) || 1;
        const step = Math.min(1.5 / S, len / 2);
        px = best.x + ((cx - best.x) / len) * step;
        py = best.y + ((cy - best.y) / len) * step;
        if (!inRing(px, py, best.q.b.ring)) continue;
        home = best.q;
      }
      places.push({ id: p.id, at: [px, py], name: p.n, kind: p.k });
      known.push({ at: [px, py], name });
      if (home.b.name || home.size * S * S > 2500) continue;
      const sign = signName(p.n);
      if (!sign) continue;
      // A street has one petrol station, one school, one church where it has one: a second point for the same
      // one (its other name, or its office) is not a second one next door.
      if (use && ONE_OF_A_KIND.test(use)) {
        const hx = (home.x0 + home.x1) / 2, hy = (home.y0 + home.y1) / 2;
        if (boxes.some((q) => q !== home && q.b.use === use && Math.hypot((q.x0 + q.x1) / 2 - hx, (q.y0 + q.y1) / 2 - hy) * S < 90)) continue;
      }
      home.b.name = sign;
      if (!home.b.use && use) home.b.use = use;
      stats.named++;
    }
    if (places.length) out.places = places;
  }
  return stats;
}
