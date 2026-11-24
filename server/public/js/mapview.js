// The sums of the world map (worldmap.js): where a place on Earth is on a map of the whole world at some
// zoom, which squares of the map's pictures cover the screen, and what zooming about a point does. No page
// and no three.js here: this file is also run by the server's tests, and the Windows game does the same
// sums in EarthWorldMap.cpp.
//
// The map is the usual one of the web: the whole world is a square of TILE_PX * 2^zoom pixels, x east from
// the date line and y south from about 85 degrees north (the Mercator map), cut into pictures of TILE_PX.

import { metresBetween } from "./flightplan.js";

export const TILE_PX = 256;
/** The furthest off and the closest the map goes. The pictures stop at zoom 17 (the server gives none closer); past that they are drawn larger. */
export const MIN_ZOOM = 2;
export const MAX_ZOOM = 18.5;
export const MAX_TILE_ZOOM = 17;
/** The map opens close enough to see the streets round the player. */
export const START_ZOOM = 15;

const clampLat = (lat) => Math.min(85.0511, Math.max(-85.0511, lat));

/** A place on Earth as a point of the whole world's map at a zoom, in pixels. */
export function pointOf(lat, lon, zoom) {
  const size = TILE_PX * 2 ** zoom;
  const r = (clampLat(lat) * Math.PI) / 180;
  return { x: ((lon + 180) / 360) * size, y: ((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2) * size };
}

/** The place on Earth at a point of the whole world's map at a zoom. East and west it goes round: 190 east is 170 west. */
export function geoOf(x, y, zoom) {
  const size = TILE_PX * 2 ** zoom;
  const lon = ((((x / size) * 360 - 180 + 180) % 360) + 360) % 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * Math.min(size, Math.max(0, y))) / size))) * 180) / Math.PI;
  return { lat, lon };
}

/**
 * The pictures that cover a screen `w` by `h` pixels whose middle is the point `mid` of the world's map at `zoom`:
 * for each, which picture it is (`z`, `x`, `y`; `x` goes round the world), where its top left corner is on the
 * world's map at `zoom` (`left`, `top`) and how wide it is drawn (`size`).
 */
export function tilesFor(mid, zoom, w, h) {
  const z = Math.min(MAX_TILE_ZOOM, Math.max(0, Math.round(zoom)));
  const size = TILE_PX * 2 ** (zoom - z);
  const n = 2 ** z;
  const out = [];
  const x0 = Math.floor((mid.x - w / 2) / size), x1 = Math.floor((mid.x + w / 2) / size);
  const y0 = Math.max(0, Math.floor((mid.y - h / 2) / size)), y1 = Math.min(n - 1, Math.floor((mid.y + h / 2) / size));
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) out.push({ z, x: ((tx % n) + n) % n, y: ty, left: tx * size, top: ty * size, size });
  return out;
}

/**
 * Zooming by `by` steps with the pointer `about` pixels from the middle of the screen (x right, y down): the new
 * zoom, and the new middle, such that the place under the pointer stays under it.
 */
export function zoomAbout(centre, zoom, by, about) {
  const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom + by));
  const mid = pointOf(centre.lat, centre.lon, zoom);
  const under = geoOf(mid.x + about.x, mid.y + about.y, zoom);
  const there = pointOf(under.lat, under.lon, next);
  return { zoom: next, centre: geoOf(there.x - about.x, there.y - about.y, next) };
}

const WINDS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
/** "2.4 km to the north-east of you", for the place chosen. */
export function awayWords(fromLat, fromLon, toLat, toLon) {
  const metres = metresBetween(fromLat, fromLon, toLat, toLon);
  if (metres < 30) return "Right where you are";
  let dLon = toLon - fromLon;
  if (dLon > 180) dLon -= 360; else if (dLon < -180) dLon += 360;
  const bearing = (Math.atan2(dLon * Math.cos((fromLat * Math.PI) / 180), toLat - fromLat) * 180) / Math.PI;
  const wind = WINDS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
  const far = metres < 950 ? `${Math.round(metres / 10) * 10} m` : metres < 100_000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres / 1000).toLocaleString("en-US")} km`;
  return `${far} to the ${wind} of you`;
}
