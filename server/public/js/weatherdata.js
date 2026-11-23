// The weather as numbers: what each kind of weather does to the picture and the sound. The weather
// itself comes from the server (`GET /v1/weather`, docs/PROTOCOL.md); weather.js draws it, and the
// Windows game is to draw the same from the same numbers (see the hand-over note).
//
// No three.js and no page here: this file is also run by the server's tests.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * The fine day the game had before it knew the weather, and has again whenever there is none to be had:
 * blue sky with white clouds in two places out of three, a light breeze.
 */
export const FINE = Object.freeze({ kind: "fine", cloud: 0.6, rain: 0, snow: 0, wind: 2.4, gust: 4, windFrom: 270, temp: 18, visibility: null });

/** Weather to try out, whatever the sky is really doing ("/weather rain"): each a full report, as the server would send. */
export const TRY = Object.freeze({
  cloudy: { kind: "cloudy", cloud: 1, rain: 0, snow: 0, wind: 4, gust: 7, windFrom: 250, temp: 14, visibility: 20000 },
  drizzle: { kind: "drizzle", cloud: 0.95, rain: 0.4, snow: 0, wind: 3, gust: 5, windFrom: 250, temp: 12, visibility: 8000 },
  rain: { kind: "rain", cloud: 1, rain: 4, snow: 0, wind: 6, gust: 11, windFrom: 250, temp: 12, visibility: 6000 },
  storm: { kind: "storm", cloud: 1, rain: 9, snow: 0, wind: 12, gust: 20, windFrom: 250, temp: 16, visibility: 3000 },
  snow: { kind: "snow", cloud: 1, rain: 0, snow: 1.5, wind: 3, gust: 6, windFrom: 200, temp: -2, visibility: 1500 },
  fog: { kind: "fog", cloud: 1, rain: 0, snow: 0, wind: 1, gust: 2, windFrom: 200, temp: 8, visibility: 200 },
  windy: { kind: "fine", cloud: 0.45, rain: 0, snow: 0, wind: 14, gust: 22, windFrom: 250, temp: 15, visibility: 30000 },
});

/** "/weather ..." as typed: "real", "fine", or one of the kinds to try out. Null for anything else. */
export function parseWeather(text) {
  const word = String(text ?? "").trim().toLowerCase();
  const known = { real: "real", live: "real", on: "real", fine: "fine", off: "fine", sunny: "fine", clear: "fine", cloud: "cloudy", clouds: "cloudy", overcast: "cloudy", raining: "rain", snowing: "snow", snowy: "snow", foggy: "fog", mist: "fog", thunder: "storm", wind: "windy" };
  const name = known[word] ?? word;
  return name === "real" || name === "fine" || name in TRY ? name : null;
}

/** The box round the camera that rain, snow and blown leaves fall through, in metres: east-west, up-down, north-south. */
export const FALL_BOX = [30, 20, 30];
/** The most of each that is ever drawn. */
export const MOST = { rain: 4500, snow: 4500, leaves: 240 };

/**
 * What a report of the weather (the route's fields) does to the picture and the sound.
 *
 * clouds     how many of the sky's places for a cloud hold one, 0 to 1
 * veil       how grey and overcast the sky and the light are, 0 to 1 (skymath.js, skyLight)
 * mist       how lost in fog the sky is, 0 to 1
 * fogNear, fogFar   where the land begins to sink into the haze and where it is gone, in metres
 * rain       { count, speed (metres a second, down), length and width of a streak (metres) }
 * snow       { count, speed, size of a flake (metres), sway (metres it wanders side to side) }
 * leaves     { count } of leaves blown along on a windy day
 * windX, windZ   the wind as metres a second over the ground, east and south
 * drift      how fast the clouds cross the sky, as a multiple of a fine day's pace
 * sway       how far the tops of trees lean in a gust, in metres
 * rainSound, windSound   how loud, 0 to 1
 * thunder    true in a storm: lightning now and then, and its rumble
 */
export function weatherLook(w) {
  const kind = w.kind;
  const cloud = clamp(w.cloud ?? 0, 0, 1);
  const rate = Math.max(0, w.rain ?? 0), flakes = Math.max(0, w.snow ?? 0), wind = clamp(w.wind ?? 0, 0, 40);
  const wet = kind === "rain" || kind === "storm", drizzle = kind === "drizzle", snowing = kind === "snow", fog = kind === "fog";
  const from = ((w.windFrom ?? 270) * Math.PI) / 180;
  let veil = smooth(0.7, 1, cloud) * 0.85;
  if (kind === "storm") veil = 1;
  else if (wet) veil = Math.max(veil, 0.85);
  else if (snowing) veil = Math.max(veil, 0.75);
  else if (drizzle) veil = Math.max(veil, 0.7);
  else if (fog) veil = Math.max(veil, 0.6);
  let fogNear = 900, fogFar = 2600, mist = 0;
  if (fog) {
    fogNear = 4;
    fogFar = clamp((w.visibility ?? 300) * 0.5, 70, 260);
    mist = 1;
  } else if (snowing) {
    fogNear = 60;
    fogFar = clamp(900 - 150 * flakes, 350, 900);
    mist = 0.5;
  } else if (wet || drizzle) {
    fogNear = 200;
    fogFar = clamp(2200 - 220 * rate, 900, 2200);
    mist = clamp(0.2 + 0.03 * rate, 0.2, 0.45);
  }
  return {
    clouds: clamp((6 + cloud * 100) / 100, 0, 1), veil, mist, fogNear, fogFar,
    rain: wet ? { count: Math.round(clamp(900 + 500 * rate, 900, MOST.rain)), speed: kind === "storm" ? 13 : 11, length: 0.55, width: 0.016 }
      : drizzle ? { count: Math.round(clamp(500 + 400 * rate, 500, 1200)), speed: 6, length: 0.25, width: 0.011 }
        : { count: 0, speed: 11, length: 0.55, width: 0.016 },
    snow: { count: snowing ? Math.round(clamp(1200 + 1400 * flakes, 1200, MOST.snow)) : 0, speed: 1.5, size: 0.055, sway: 0.35 },
    leaves: { count: Math.round(clamp((wind - 8) * 30, 0, MOST.leaves)) },
    windX: -Math.sin(from) * wind, windZ: Math.cos(from) * wind,
    drift: 0.4 + wind / 4,
    sway: clamp(0.03 + 0.02 * wind, 0.03, 0.4),
    rainSound: wet ? clamp(0.35 + 0.08 * rate, 0, 1) : drizzle ? 0.2 : 0,
    windSound: clamp((wind - 2.5) / 12, 0, 1),
    thunder: kind === "storm",
  };
}

/** The weather in a few plain words, for the chat window. */
export function weatherSaid(w) {
  const sky = { fine: w.cloud < 0.3 ? "a clear sky" : "sunshine and some cloud", cloudy: "cloudy", fog: "fog", drizzle: "drizzle", rain: w.rain >= 6 ? "heavy rain" : "rain", snow: "snow", storm: "a thunderstorm" }[w.kind] ?? "fine";
  const breeze = w.wind >= 14 ? "a gale" : w.wind >= 9 ? "a strong wind" : w.wind >= 5 ? "a breeze" : "hardly any wind";
  const points = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  const from = points[Math.round((((w.windFrom ?? 0) % 360) + 360) % 360 / 45) % 8];
  return `${sky}, ${Math.round(w.temp ?? 0)} degrees, ${breeze}${w.wind >= 5 ? ` from the ${from}` : ""}`;
}
