// Types for mapview.js, so the server's tests can check the sums the browser's world map runs.
export const TILE_PX: number;
export const MIN_ZOOM: number;
export const MAX_ZOOM: number;
export const MAX_TILE_ZOOM: number;
export const START_ZOOM: number;
export function pointOf(lat: number, lon: number, zoom: number): { x: number; y: number };
export function geoOf(x: number, y: number, zoom: number): { lat: number; lon: number };
export function tilesFor(mid: { x: number; y: number }, zoom: number, w: number, h: number): { z: number; x: number; y: number; left: number; top: number; size: number }[];
export function zoomAbout(centre: { lat: number; lon: number }, zoom: number, by: number, about: { x: number; y: number }): { zoom: number; centre: { lat: number; lon: number } };
export function awayWords(fromLat: number, fromLon: number, toLat: number, toLon: number): string;
