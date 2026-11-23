// The weather where a player is, live, from Open-Meteo (https://open-meteo.com): free, no key.
//
// What the service asks of us, from its terms (read 2026-11-24): the free API is for non-commercial use
// (a family game with no adverts or subscriptions is), fewer than 10,000 calls a day, 5,000 an hour
// and 600 a minute, and its data are CC BY 4.0: wherever they are shown there is to be a link saying
// "Weather data by Open-Meteo.com". Both games show CREDIT beside the map's own.
//
// So that it is asked little: a place is rounded to a quarter of a degree (some 28 km: the weather of
// the district, and all that the service is ever told of where anybody is), an answer is kept a quarter of an
// hour, everybody in that area shares it, and there is a ceiling on the calls of a day far under the
// service's own. When the service does not answer, the last answer for the area is given for up to
// two hours; after that there is no weather to give (503), and a game then has its fine day.

import { httpGet } from "./net.ts";

/** What sort of weather it is, for a game to draw. */
export type WeatherKind = "fine" | "cloudy" | "fog" | "drizzle" | "rain" | "snow" | "storm";

export interface Weather {
  /** The middle of the area this is the weather of: a quarter of a degree each way. */
  lat: number;
  lon: number;
  /** When the service was asked, in milliseconds since 1970. */
  at: number;
  kind: WeatherKind;
  /** The service's own code for it (the World Meteorological Organization's table), as given. */
  code: number;
  /** How much of the sky is cloud, 0 to 1. */
  cloud: number;
  /** Rain and showers, in millimetres an hour. */
  rain: number;
  /** Snow, in centimetres an hour. */
  snow: number;
  /** Wind ten metres up, and its gusts, in metres a second; and where it blows from, in degrees (0 north, 90 east). */
  wind: number;
  gust: number;
  windFrom: number;
  /** The air's temperature, in degrees Celsius. */
  temp: number;
  /** How far one can see, in metres; null when the service did not say. */
  visibility: number | null;
  /** Is the sun up there? (The games work the sun out for themselves; this is the service's word.) */
  day: boolean;
  /** How far the clocks there are from Greenwich, in seconds. */
  utcOffset: number;
  /** The words and the link that go wherever this is shown. */
  credit: string;
  creditUrl: string;
}

export const CREDIT = "Weather data by Open-Meteo.com";
export const CREDIT_URL = "https://open-meteo.com/";
/** How big an area shares one answer, in degrees; how long an answer is kept; how long an old one will still do when the service is silent. */
export const AREA_DEG = 0.25;
export const KEEP_MS = 15 * 60_000;
export const STALE_MS = 2 * 3600_000;
/** After a failure the service is left alone this long for that area. */
export const RETRY_MS = 2 * 60_000;
/** The most calls in a day (the service allows 10,000). */
export const CALLS_A_DAY = 3000;

const WANTED = "temperature_2m,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility";

/** The middle of the area a position falls in. */
export function areaOf(lat: number, lon: number): { lat: number; lon: number } {
  const round = (v: number): number => Math.round(v / AREA_DEG) * AREA_DEG;
  let east = round(lon);
  if (east >= 180) east -= 360; // (the two edges of the map are one place)
  return { lat: Math.min(90, Math.max(-90, round(lat))), lon: east };
}

/** The sort of weather a code of the WMO table means (https://open-meteo.com/en/docs, "WMO Weather interpretation codes"). */
export function kindOf(code: number, cloud = 0): WeatherKind {
  if (code >= 95) return "storm"; // thunder, with or without hail
  if (code === 45 || code === 48) return "fog";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 51 && code <= 57) return "drizzle";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  // Overcast by the code; for "clear", "mainly clear" and "partly cloudy" the sky's own share of cloud has the last word.
  return code === 3 || cloud >= 0.6 ? "cloudy" : "fine";
}

const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const within = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** What the service sent, as the games are given it; null when it is not an answer at all. */
export function readWeather(body: unknown, area: { lat: number; lon: number }, at: number): Weather | null {
  const b = body as { current?: Record<string, unknown>; utc_offset_seconds?: unknown } | null;
  const c = b?.current;
  if (!c || typeof c !== "object" || typeof c.weather_code !== "number") return null;
  // Rain and snow come as what fell in the last so many seconds: here they are by the hour.
  const hourly = 3600 / within(num(c.interval, 900), 60, 3600);
  const cloud = within(num(c.cloud_cover) / 100, 0, 1);
  const code = Math.round(num(c.weather_code));
  const tenth = (v: number): number => Math.round(v * 10) / 10;
  return {
    lat: area.lat, lon: area.lon, at,
    kind: kindOf(code, cloud), code,
    cloud: Math.round(cloud * 100) / 100,
    rain: tenth(within((num(c.rain) + num(c.showers)) * hourly, 0, 200)),
    snow: tenth(within(num(c.snowfall) * hourly, 0, 100)),
    wind: tenth(within(num(c.wind_speed_10m), 0, 100)),
    gust: tenth(within(num(c.wind_gusts_10m, num(c.wind_speed_10m)), 0, 150)),
    windFrom: ((Math.round(num(c.wind_direction_10m)) % 360) + 360) % 360,
    temp: tenth(within(num(c.temperature_2m, 15), -90, 60)),
    visibility: typeof c.visibility === "number" && Number.isFinite(c.visibility) ? Math.round(within(c.visibility, 0, 100_000)) : null,
    day: num(c.is_day, 1) !== 0,
    utcOffset: Math.round(num(b?.utc_offset_seconds)),
    credit: CREDIT, creditUrl: CREDIT_URL,
  };
}

export interface WeatherOptions {
  /** Where the service is. EARTHWALK_WEATHER_URL overrides the real one; tests give a stand-in. */
  url?: string;
  /** The clock, for tests. */
  now?: () => number;
  timeoutMs?: number;
}

/** Asks the weather service, as seldom as will do (see the top of this file). */
export class WeatherService {
  private readonly url: string;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly kept = new Map<string, { weather: Weather | null; asked: number }>();
  private readonly asking = new Map<string, Promise<Weather | null>>();
  private day = "";
  /** How many times the service has been asked today, for /health and the tests. */
  calls = 0;

  constructor(options: WeatherOptions = {}) {
    this.url = (options.url ?? process.env.EARTHWALK_WEATHER_URL ?? "https://api.open-meteo.com/v1/forecast").replace(/\/+$/, "");
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** Would asking about this position trouble the service? (Not if its area was asked about lately.) */
  wouldAsk(lat: number, lon: number): boolean {
    const area = areaOf(lat, lon);
    const have = this.kept.get(`${area.lat},${area.lon}`);
    return !have || this.now() - have.asked >= (have.weather && have.weather.at === have.asked ? KEEP_MS : RETRY_MS);
  }

  /** The weather of the area round a position; null when there is none to give just now. Never throws. */
  async at(lat: number, lon: number): Promise<Weather | null> {
    const area = areaOf(lat, lon);
    const key = `${area.lat},${area.lon}`;
    const now = this.now();
    const have = this.kept.get(key);
    const fresh = (w: Weather | null): Weather | null => (w && now - w.at < STALE_MS ? w : null);
    if (have && now - have.asked < (have.weather && have.weather.at === have.asked ? KEEP_MS : RETRY_MS)) return fresh(have.weather);
    const going = this.asking.get(key);
    if (going) return going;
    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.calls = 0; }
    if (this.calls >= CALLS_A_DAY) return fresh(have?.weather ?? null);
    this.calls++;
    const ask = (async (): Promise<Weather | null> => {
      let got: Weather | null = null;
      try {
        // All that is sent: the middle of the area, and what is wanted. (Not the contact address the map services are
        // given either: this service does not ask for one.)
        const res = await httpGet(`${this.url}?latitude=${area.lat}&longitude=${area.lon}&current=${WANTED}&wind_speed_unit=ms&timezone=auto`, this.timeoutMs, { headers: { "User-Agent": "earthwalk-server" } });
        if (res.ok) got = readWeather(await res.json(), area, now);
        else console.error(`weather: the service answered ${res.status}`);
      } catch (err) {
        console.error(`weather: ${err instanceof Error ? err.message : String(err)}`);
      }
      // A failure keeps the last answer (it will do for a while) and is not tried again at once.
      this.kept.delete(key);
      this.kept.set(key, { weather: got ?? have?.weather ?? null, asked: now });
      if (this.kept.size > 600) this.kept.delete(this.kept.keys().next().value!);
      return fresh(got ?? have?.weather ?? null);
    })().finally(() => this.asking.delete(key));
    this.asking.set(key, ask);
    return ask;
  }
}
