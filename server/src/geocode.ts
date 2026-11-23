// Place search ("take me to the Eiffel Tower") via OpenStreetMap's Nominatim.
// Their usage policy allows at most one request per second, so results are cached.

import { httpGet, Throttle } from "./net.ts";

export interface Place { name: string; lat: number; lon: number }

const NOMINATIM_URL = process.env.EARTHWALK_NOMINATIM_URL ?? "https://nominatim.openstreetmap.org";
const throttle = new Throttle(1100);
const cache = new Map<string, Place | null>();

export async function geocode(query: string): Promise<Place | null> {
  const q = query.trim().slice(0, 200);
  if (!q) return null;
  // "lat, lon" needs no lookup.
  const m = /^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/.exec(q);
  if (m) {
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (Math.abs(lat) <= 85 && Math.abs(lon) <= 180) return { name: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon };
  }
  const key = q.toLowerCase();
  if (cache.has(key)) return cache.get(key)!;
  const place = await throttle.run(async () => {
    const res = await httpGet(`${NOMINATIM_URL}/search?format=jsonv2&limit=1&q=${encodeURIComponent(q)}`, 15000);
    if (!res.ok) throw new Error(`geocoder HTTP ${res.status}`);
    const rows = (await res.json()) as { display_name: string; lat: string; lon: string }[];
    if (!rows.length) return null;
    return { name: rows[0].display_name, lat: parseFloat(rows[0].lat), lon: parseFloat(rows[0].lon) };
  });
  if (cache.size >= 500) cache.delete(cache.keys().next().value!);
  cache.set(key, place);
  return place;
}

/** Of several places, the one nearest a position; null of none. */
export function nearestOf(places: Place[], lat: number, lon: number): Place | null {
  const k = Math.cos((lat * Math.PI) / 180);
  let best: Place | null = null;
  let least = Infinity;
  for (const p of places) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
    const d = Math.hypot(p.lat - lat, (p.lon - lon) * k);
    if (d < least) { least = d; best = p; }
  }
  return best;
}

/** How far round a position a place is looked for by name, in degrees each way: about 4 km first, then about 25 km. */
export const NEAR_BOXES = [0.04, 0.25];

/**
 * A place by name, looked for round a position first ("the beach" should be the nearest beach, not
 * the most famous), then anywhere. The search lists what it finds best known first, and of many
 * that are all as little known as each other (the beaches of a city) it hands back some ten or
 * other, a different ten each time. So it is asked for what is close by first, and of what it
 * finds there the nearest is taken: from Devonport "the beach" is the one down the road, not a bay
 * on an island twenty kilometres off. Only when nothing is close is it asked for the wider region.
 */
export async function geocodeNear(query: string, lat: number, lon: number): Promise<Place | null> {
  const q = query.trim().slice(0, 200);
  if (!q || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  // (Kept by about a kilometre: the nearest beach is not the same one from the far side of town.)
  const key = `${q.toLowerCase()}@${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (cache.has(key)) return cache.get(key)!;
  let near: Place | null = null;
  for (const box of NEAR_BOXES) {
    near = await throttle.run(async () => {
      const res = await httpGet(`${NOMINATIM_URL}/search?format=jsonv2&limit=10&bounded=1&viewbox=${(lon - box).toFixed(3)},${(lat + box).toFixed(3)},${(lon + box).toFixed(3)},${(lat - box).toFixed(3)}&q=${encodeURIComponent(q)}`, 15000);
      if (!res.ok) throw new Error(`geocoder HTTP ${res.status}`);
      const rows = (await res.json()) as { display_name: string; lat: string; lon: string }[];
      return nearestOf(rows.map((row) => ({ name: row.display_name, lat: parseFloat(row.lat), lon: parseFloat(row.lon) })), lat, lon);
    });
    if (near) break;
  }
  const place = near ?? (await geocode(q));
  if (cache.size >= 500) cache.delete(cache.keys().next().value!);
  cache.set(key, place);
  return place;
}

// ---------------------------------------------------------------- "Go to..." from where you stand

interface Found extends Place { importance: number; settlement: boolean }
const aroundCache = new Map<string, Place | null>();

/** One question to the search: everywhere, or only inside a box of so many degrees each way round a position. */
async function ask(q: string, limit: number, round?: { lat: number; lon: number; box: number }): Promise<Found[]> {
  const view = round ? `&bounded=1&viewbox=${(round.lon - round.box).toFixed(3)},${(round.lat + round.box).toFixed(3)},${(round.lon + round.box).toFixed(3)},${(round.lat - round.box).toFixed(3)}` : "";
  return throttle.run(async () => {
    const res = await httpGet(`${NOMINATIM_URL}/search?format=jsonv2&limit=${limit}${view}&q=${encodeURIComponent(q)}`, 15000);
    if (!res.ok) throw new Error(`geocoder HTTP ${res.status}`);
    const rows = (await res.json()) as { display_name: string; lat: string; lon: string; importance?: number; category?: string }[];
    return rows.map((row) => ({
      name: row.display_name, lat: parseFloat(row.lat), lon: parseFloat(row.lon),
      importance: Number.isFinite(row.importance) ? row.importance! : 0, settlement: row.category === "place" || row.category === "boundary",
    }));
  });
}

/** Known all over the world: Paris, Tokyo, the Eiffel Tower. Such a place is meant wherever it is asked for. */
export const FAMOUS = 0.6;
/** How far round a position a town is looked for by name before the whole world is: degrees each way, about 300 km. */
export const REGION_BOX = 3;
/** Everyday places, of which the one meant is the one close by: "beach" is not the town of Beach in North Dakota. */
const EVERYDAY = new Set(("beach park playground shop shops supermarket school library station zoo pool cafe café restaurant bakery hospital church museum lake river forest farm airport harbour harbor wharf marina mall "
  + "cinema bridge tunnel market playground garden gardens square pub hotel bank pharmacy chemist dairy stadium university college hill mountain island bay pier ferry castle cathedral temple mosque town city village centre center downtown").split(" "));

/**
 * A place by name for "Go to...", asked from somewhere. Typed alone, "the beach" is a district of Toronto
 * to the search and "beach" a town in North Dakota, which is where players were sent. So:
 * a place the whole world knows (FAMOUS) is that place; otherwise the nearest one close by (4 km, then
 * 25 km) when the words are an everyday place, have "the" before them, or are a name of several words, or
 * when what is close by is a town or suburb of that name; otherwise the best known within some 300 km
 * (the Hamilton down the road, not the one in Canada); and only then the best known in the world.
 */
export async function geocodeAround(query: string, lat: number, lon: number): Promise<Place | null> {
  const q = query.trim().slice(0, 200);
  if (!q) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || /^-?\d+(?:\.\d+)?\s*[, ]\s*-?\d+(?:\.\d+)?$/.test(q)) return geocode(q);
  const article = /^(?:the|a|an|my|our|nearest|closest|nearby|local)\s+/i.exec(q);
  const words = (article ? q.slice(article[0].length) : q).trim();
  if (!words) return null;
  const key = `${words.toLowerCase()}@${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (aroundCache.has(key)) return aroundCache.get(key)!;
  const plain = ({ name, lat: la, lon: lo }: Found): Place => ({ name, lat: la, lon: lo });
  const several = /\s/.test(words);
  const everyday = !!article || EVERYDAY.has(words.toLowerCase());
  const find = async (): Promise<Place | null> => {
    const world = (await ask(words, 1))[0] ?? null;
    if (world && world.importance >= FAMOUS && !EVERYDAY.has(words.toLowerCase())) return plain(world);
    for (const box of NEAR_BOXES) {
      const close = (await ask(words, 10, { lat, lon, box })).filter((p) => everyday || several || p.settlement);
      const nearest = nearestOf(close, lat, lon) as Found | null;
      if (nearest) return plain(nearest);
    }
    const region = (await ask(words, 5, { lat, lon, box: REGION_BOX }))[0] ?? null; // the search lists the best known first
    return region ? plain(region) : world ? plain(world) : null;
  };
  const place = await find();
  if (aroundCache.size >= 500) aroundCache.delete(aroundCache.keys().next().value!);
  aroundCache.set(key, place);
  return place;
}

// ---------------------------------------------------------------- place names

interface NominatimAddress { [k: string]: string | undefined }
/** Where a position is: a short name ("Montmartre, Paris") and the country, either of which may be unknown. */
export interface PlaceDetail { name: string | null; country: string | null }
const reverseCache = new Map<string, PlaceDetail>();

/** A short, human place name from a Nominatim address: "Montmartre, Paris" or "Paris, France". */
export function shortPlaceName(a: NominatimAddress | undefined): string | null {
  if (!a) return null;
  const local = a.neighbourhood ?? a.suburb ?? a.quarter ?? a.city_district ?? a.borough ?? a.hamlet ?? a.village ?? a.town ?? a.city;
  const area = [a.city, a.town, a.village, a.municipality, a.county, a.state, a.country].find((s) => s && s !== local);
  const parts = [local, area].filter((s): s is string => !!s);
  return parts.length ? parts.join(", ") : null;
}

/**
 * Where a position is, in words, for the people list. Positions are rounded to about a
 * kilometre so a group walking around one neighbourhood shares one lookup, and lookups go
 * through the same one-per-second throttle as place search.
 */
export async function placeName(lat: number, lon: number): Promise<string | null> {
  return (await placeDetail(lat, lon)).name;
}

/** The same lookup, with the country as well: for the header that tells a player where they are. */
export async function placeDetail(lat: number, lon: number): Promise<PlaceDetail> {
  const nowhere: PlaceDetail = { name: null, country: null };
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return nowhere;
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  if (reverseCache.has(key)) return reverseCache.get(key)!;
  const name = await throttle.run(async (): Promise<PlaceDetail> => {
    const res = await httpGet(`${NOMINATIM_URL}/reverse?format=jsonv2&zoom=14&accept-language=en&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}`, 15000);
    if (!res.ok) throw new Error(`reverse geocoder HTTP ${res.status}`);
    const row = (await res.json()) as { address?: NominatimAddress };
    return { name: shortPlaceName(row.address), country: row.address?.country ?? null };
  }).catch(() => nowhere);
  if (reverseCache.size >= 2000) reverseCache.delete(reverseCache.keys().next().value!);
  reverseCache.set(key, name);
  return name;
}
