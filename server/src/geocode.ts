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

/**
 * A place by name, looked for round a position first ("the beach" should be the nearest beach, not
 * the most famous), then anywhere.
 */
export async function geocodeNear(query: string, lat: number, lon: number): Promise<Place | null> {
  const q = query.trim().slice(0, 200);
  if (!q || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const key = `${q.toLowerCase()}@${lat.toFixed(1)},${lon.toFixed(1)}`;
  if (cache.has(key)) return cache.get(key)!;
  const box = 0.25; // degrees: about 25 km each way
  const near = await throttle.run(async () => {
    const res = await httpGet(`${NOMINATIM_URL}/search?format=jsonv2&limit=1&bounded=1&viewbox=${(lon - box).toFixed(3)},${(lat + box).toFixed(3)},${(lon + box).toFixed(3)},${(lat - box).toFixed(3)}&q=${encodeURIComponent(q)}`, 15000);
    if (!res.ok) throw new Error(`geocoder HTTP ${res.status}`);
    const rows = (await res.json()) as { display_name: string; lat: string; lon: string }[];
    return rows.length ? { name: rows[0].display_name, lat: parseFloat(rows[0].lat), lon: parseFloat(rows[0].lon) } : null;
  });
  const place = near ?? (await geocode(q));
  if (cache.size >= 500) cache.delete(cache.keys().next().value!);
  cache.set(key, place);
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
