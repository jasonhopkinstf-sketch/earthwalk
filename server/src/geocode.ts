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
