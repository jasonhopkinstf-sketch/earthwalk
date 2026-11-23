// Types for weatherdata.js, so the server's tests can check what each kind of weather does.
export interface Report { kind: string; cloud: number; rain: number; snow: number; wind: number; gust: number; windFrom: number; temp: number; visibility: number | null }
export interface WeatherLook {
  clouds: number; veil: number; mist: number; fogNear: number; fogFar: number;
  rain: { count: number; speed: number; length: number; width: number };
  snow: { count: number; speed: number; size: number; sway: number };
  leaves: { count: number };
  windX: number; windZ: number; drift: number; sway: number; rainSound: number; windSound: number; thunder: boolean;
}
export const FINE: Readonly<Report>;
export const TRY: Readonly<Record<"cloudy" | "drizzle" | "rain" | "storm" | "snow" | "fog" | "windy", Report>>;
export function parseWeather(text: unknown): string | null;
export const FALL_BOX: number[];
export const MOST: Record<"rain" | "snow" | "leaves", number>;
export function weatherLook(w: Partial<Report> & { kind: string }): WeatherLook;
export function weatherSaid(w: Report): string;
