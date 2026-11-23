// Types for skymath.js, so the server's tests can hold the sun and moon sums to known days.
export type Rgb = number[];
export interface SunPlace { alt: number; az: number; dec: number; ra: number; lambdaDeg: number }
export interface MoonPlace { alt: number; az: number; dec: number; ra: number; lit: number; waxing: boolean; age: number; apartDeg: number }
export interface SkyLook {
  day: number; dusk: number; night: number;
  zenith: Rgb; mid: Rgb; horizon: Rgb; flatSky: Rgb; glow: Rgb; duskGlow: Rgb; sunDisc: Rgb;
  land: Rgb; haze: Rgb; fogColor: Rgb; cloud: Rgb; cloudShade: Rgb;
  stars: number; moonShow: number; moonGlow: number; veil: number; mist: number;
  light: { from: "sun" | "moon" | "stars"; alt: number; az: number; color: Rgb; strength: number };
  skyLight: { color: Rgb; ground: Rgb; strength: number };
}
export function smooth(a: number, b: number, v: number): number;
export function daysSince2000(ms: number): number;
export function sunAt(ms: number, lat: number, lon: number): SunPlace;
export function moonAt(ms: number, lat: number, lon: number): MoonPlace;
export function skyDirection(alt: number, az: number): number[];
export function moonName(age: number): string;
export function momentOf(when: "noon" | "night" | "morning" | "sunset", ms: number, lat: number, lon: number): number;
export const FINE_DAY: { alt: number; az: number };
export const STRENGTH: Record<"sun" | "sky" | "moon" | "starlight" | "nightSky", number>;
export const HANDOVER_DEG: number;
export function skyLight(sun: { alt: number; az: number }, moon: { alt: number; az: number; lit: number } | null, air?: { veil?: number; mist?: number }): SkyLook;
export function groundLevel(look: SkyLook): number;
export const TIMES: string[];
export function parseTime(text: unknown): string | null;
