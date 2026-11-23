// Where the sun and the moon really stand, and what light the world is drawn in because of it.
//
// The sums are worked out here, in the game, from the place and the moment: no service is asked.
// They are the short ones of the Astronomical Almanac ("low precision" formulae): the sun to about a
// hundredth of a degree and the moon to about a third of one, which is far finer than a drawn sky
// needs. The Windows game does the same sums (see the hand-over note), and test/sky.test.ts holds them
// to known days: the solstices, an eclipse of the sun, full moons.
//
// No three.js and no page here: this file is also run by the server's tests.
//
// Angles are radians unless a name ends in Deg. A direction in the sky is `alt` (above the horizon)
// and `az` (round from north through east: 0 north, pi/2 east).

const RAD = Math.PI / 180;
const TAU = Math.PI * 2;
const turn = (deg) => ((deg % 360) + 360) % 360;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/** 0 below `a`, 1 above `b`, and a smooth slope between. */
export const smooth = (a, b, v) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const mix = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];

/** Days since noon on 1 January 2000 (the astronomers' J2000), from a moment in milliseconds since 1970. */
export const daysSince2000 = (ms) => ms / 86400000 - 10957.5;

/** Which way the Earth is turned: the sidereal time at Greenwich, in degrees. */
const siderealDeg = (n) => turn(280.46061837 + 360.98564736629 * n);

/** From a place among the stars (right ascension and declination, radians) to a place in the sky over a spot on Earth. */
function overhead(n, ra, dec, lat, lon) {
  const hour = (siderealDeg(n) + lon) * RAD - ra; // how far past the meridian it is
  const phi = lat * RAD;
  const alt = Math.asin(clamp(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hour), -1, 1));
  const az = Math.atan2(-Math.sin(hour) * Math.cos(dec), Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.cos(hour) * Math.sin(phi));
  return { alt, az: (az + TAU) % TAU };
}

/** From the ecliptic (the sun's road: longitude and latitude, degrees) to right ascension and declination, radians. */
function fromEcliptic(n, lambdaDeg, betaDeg) {
  const tilt = (23.439 - 0.0000004 * n) * RAD;
  const l = lambdaDeg * RAD, b = betaDeg * RAD;
  return {
    ra: Math.atan2(Math.sin(l) * Math.cos(tilt) - Math.tan(b) * Math.sin(tilt), Math.cos(l)),
    dec: Math.asin(clamp(Math.sin(b) * Math.cos(tilt) + Math.cos(b) * Math.sin(tilt) * Math.sin(l), -1, 1)),
  };
}

/** The sun's place on its road, in degrees, at `n` days since 2000. */
function sunLongitudeDeg(n) {
  const mean = turn(280.460 + 0.9856474 * n);
  const g = turn(357.528 + 0.9856003 * n) * RAD;
  return turn(mean + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g));
}

/**
 * The sun over a place at a moment.
 * @param {number} ms   the moment, milliseconds since 1970 (Date.now())
 * @param {number} lat  degrees north
 * @param {number} lon  degrees east
 * @returns {{ alt: number, az: number, dec: number, ra: number, lambdaDeg: number }}
 */
export function sunAt(ms, lat, lon) {
  const n = daysSince2000(ms);
  const lambdaDeg = sunLongitudeDeg(n);
  const { ra, dec } = fromEcliptic(n, lambdaDeg, 0);
  return { ...overhead(n, ra, dec, lat, lon), dec, ra, lambdaDeg };
}

/**
 * The moon over a place at a moment, and how much of its face is lit.
 * `lit` is the part of the disc in sunshine, 0 (new) to 1 (full); `waxing` is true while it grows;
 * `age` is where it is in its month, 0 to 1 (0 new, 0.25 first quarter, 0.5 full, 0.75 last quarter).
 * The moon is near enough for where you stand to matter: `alt` is as seen from the ground, not from the
 * middle of the Earth (up to a degree lower).
 * @returns {{ alt: number, az: number, dec: number, ra: number, lit: number, waxing: boolean, age: number, apartDeg: number }}
 */
export function moonAt(ms, lat, lon) {
  const n = daysSince2000(ms);
  const T = n / 36525;
  const s = (a, b) => Math.sin((a + b * T) * RAD);
  const lambdaDeg = turn(218.32 + 481267.881 * T
    + 6.29 * s(135.0, 477198.87) - 1.27 * s(259.3, -413335.36) + 0.66 * s(235.7, 890534.22)
    + 0.21 * s(269.9, 954397.74) - 0.19 * s(357.5, 35999.05) - 0.11 * s(186.5, 966404.03));
  const betaDeg = 5.13 * s(93.3, 483202.02) + 0.28 * s(228.2, 960400.89) - 0.28 * s(318.3, 6003.15) - 0.17 * s(217.6, -407332.21);
  const c = (a, b) => Math.cos((a + b * T) * RAD);
  // How big the Earth looks from the moon (its parallax), which says how far off it is.
  const parallaxDeg = 0.9508 + 0.0518 * c(135.0, 477198.87) + 0.0095 * c(259.3, -413335.36) + 0.0078 * c(235.7, 890534.22) + 0.0028 * c(269.9, 954397.74);
  const { ra, dec } = fromEcliptic(n, lambdaDeg, betaDeg);
  const seen = overhead(n, ra, dec, lat, lon);
  const alt = seen.alt - Math.asin(Math.sin(parallaxDeg * RAD) * Math.cos(seen.alt));
  // How far round from the sun it is: that is its phase.
  const ahead = turn(lambdaDeg - sunLongitudeDeg(n));
  const apart = Math.acos(clamp(Math.cos(betaDeg * RAD) * Math.cos(ahead * RAD), -1, 1));
  return { alt, az: seen.az, dec, ra, lit: (1 - Math.cos(apart)) / 2, waxing: ahead < 180, age: ahead / 360, apartDeg: apart / RAD };
}

/** A direction in the sky as a step of one metre in the game's scene: x east, y up, z south. */
export const skyDirection = (alt, az) => [Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt)];

/** What the moon is called at an age (0 to 1 through its month). */
export function moonName(age) {
  const names = ["new moon", "waxing crescent", "first quarter", "waxing gibbous", "full moon", "waning gibbous", "last quarter", "waning crescent"];
  return names[Math.round(turn(age * 360) / 45) % 8];
}

/**
 * A time of day to try out, whatever the clock says: the moment within the day round `ms` when the
 * sun over the place is highest ("noon"), lowest ("night"), or just above the horizon on its way up
 * ("morning") or down ("sunset"). Near the poles, where the sun does not cross the horizon that day,
 * morning and sunset are the moments it is half way between its highest and lowest.
 * @param {"noon" | "night" | "morning" | "sunset"} when
 * @returns {number} milliseconds since 1970
 */
export function momentOf(when, ms, lat, lon) {
  const STEP = 120000; // two minutes
  const from = ms - 12 * 3600000;
  let top = from, bottom = from, most = -9, least = 9;
  const alts = [];
  for (let t = from, i = 0; i <= 720; t += STEP, i++) {
    const alt = sunAt(t, lat, lon).alt;
    alts.push(alt);
    if (alt > most) { most = alt; top = t; }
    if (alt < least) { least = alt; bottom = t; }
  }
  if (when === "noon") return top;
  if (when === "night") return bottom;
  // Low in the sky, with the day's colours at their warmest: four degrees up, or half way where it never gets there.
  const low = most > 4 * RAD && least < 4 * RAD ? 4 * RAD : (most + least) / 2;
  for (let i = 1; i < alts.length; i++) {
    const rising = alts[i - 1] < low && alts[i] >= low, setting = alts[i - 1] > low && alts[i] <= low;
    if ((when === "morning" && rising) || (when === "sunset" && setting)) return from + i * STEP;
  }
  return top;
}

// ---------------------------------------------------------------- the light
// (Colours are amounts of light, red green blue, not screen colours: they look darker written down than
// they come out. The day's are the ones the sky was first painted in.)

/** The fine day the game had before it knew the time: the sun high in the south-west. `/time day` is this. */
export const FINE_DAY = { alt: Math.asin(1 / Math.hypot(0.5, 1, 0.35)), az: Math.atan2(-0.5, -0.35) + TAU };

const AIR = {
  //         overhead               half way up            by the horizon
  day: { zenith: [0.025, 0.15, 0.70], mid: [0.10, 0.36, 0.86], horizon: [0.42, 0.70, 0.95] },
  dusk: { zenith: [0.10, 0.13, 0.46], mid: [0.42, 0.27, 0.50], horizon: [1.0, 0.50, 0.20] },
  night: { zenith: [0.016, 0.03, 0.15], mid: [0.03, 0.065, 0.25], horizon: [0.07, 0.14, 0.36] },
};
const LIGHT = {
  day: { sun: [1.0, 0.89, 0.72], sky: [1, 1, 1], ground: [0.102, 0.144, 0.091], land: [1, 1, 1], cloud: [1.0, 1.0, 0.985], cloudShade: [0.56, 0.69, 0.93], flat: [0.09, 0.40, 1.0] },
  dusk: { sun: [1.0, 0.55, 0.28], sky: [1.0, 0.80, 0.70], ground: [0.16, 0.12, 0.12], land: [0.95, 0.68, 0.56], cloud: [1.0, 0.78, 0.58], cloudShade: [0.60, 0.34, 0.50], flat: [0.80, 0.36, 0.30] },
  night: { sun: [0.62, 0.74, 1.0], sky: [0.55, 0.68, 1.0], ground: [0.12, 0.16, 0.30], land: [0.20, 0.29, 0.52], cloud: [0.30, 0.37, 0.60], cloudShade: [0.13, 0.17, 0.34], flat: [0.03, 0.07, 0.34] },
};
/** How strong the lights are. The night's are high on purpose: a bright cartoon night that a family can play in, never black. */
export const STRENGTH = { sun: 2.1, sky: 1.15, moon: 0.95, starlight: 0.45, nightSky: 1.3 };
/** Below this the directional light is the moon's (or starlight's), above it the sun's: both are at nothing here, so nothing jumps. */
export const HANDOVER_DEG = -5;

/**
 * The light the world is drawn in.
 *
 * @param {{ alt: number, az: number }} sun    where the sun stands
 * @param {{ alt: number, az: number, lit: number } | null} moon  where the moon stands and how full it is; null for none
 * @param {{ veil?: number, mist?: number }} [air]  the weather's part (weatherdata.js): `veil` 0 to 1 is how grey and
 *   overcast, `mist` 0 to 1 how lost in fog the sky is
 * @returns what daynight.js hands to the lights and the sky:
 *   day (0 night to 1 day), dusk (0 to 1: the warm light of a low sun), night (1 - day),
 *   zenith, mid, horizon: the air's colours; flatSky: the one colour of the flat look's sky;
 *   glow: added round the sun; duskGlow: added along the horizon under the sun at dusk;
 *   sunDisc: what the drawn sun's colours are multiplied by;
 *   land: what far country under the horizon is multiplied by; haze: the colour far land sinks into (the fog's);
 *   cloud, cloudShade: the clouds' sunlit and shaded colours;
 *   stars (0 to 1); moonShow (0 to 1: how strongly the moon is drawn); moonGlow;
 *   light: { from: "sun" | "moon" | "stars", alt, az, color, strength } the one light that casts;
 *   skyLight: { color, ground, strength } the light from all round.
 */
export function skyLight(sun, moon, air = {}) {
  const veil = clamp(air.veil ?? 0, 0, 1), mist = clamp(air.mist ?? 0, 0, 1);
  const altDeg = sun.alt / RAD;
  const day = smooth(-7, 5, altDeg);
  const night = 1 - day;
  // Warmest with the sun a degree or two up; gone by twelve degrees up and by nine degrees under.
  const dusk = altDeg > 1.5 ? 1 - smooth(1.5, 14, altDeg) : smooth(-9, 1.5, altDeg);
  const blend = (name) => mix3(mix3(LIGHT.night[name], LIGHT.day[name], day), LIGHT.dusk[name], dusk * 0.85);
  const airAt = (name) => mix3(mix3(AIR.night[name], AIR.day[name], day), AIR.dusk[name], dusk * (name === "zenith" ? 0.45 : 0.8));
  // Overcast: the blue goes grey, as bright as the hour allows.
  const grey = mix3([0.10, 0.13, 0.22], [0.50, 0.56, 0.64], day);
  const greyed = (c, much) => mix3(c, grey, veil * much);

  const moonUp = moon ? smooth(-1, 6, moon.alt / RAD) : 0;
  const moonShine = moon ? moonUp * (0.4 + 0.6 * moon.lit) : 0;
  // The one light that casts: the sun down to a little under the horizon, then the moon, or the stars when there is none.
  const sunStrength = STRENGTH.sun * smooth(HANDOVER_DEG, 6, altDeg) * (1 - 0.55 * veil);
  const after = 1 - smooth(HANDOVER_DEG - 5, HANDOVER_DEG, altDeg); // 0 at the hand-over, 1 well into the night
  let light;
  if (altDeg > HANDOVER_DEG) {
    // Never from flatter than twelve degrees: a setting sun would leave the ground unlit, and this is a cartoon.
    light = { from: "sun", alt: Math.max(sun.alt, 12 * RAD), az: sun.az, color: blend("sun"), strength: sunStrength };
  } else if (moon && moonShine > 0.12) {
    light = { from: "moon", alt: Math.max(moon.alt, 20 * RAD), az: moon.az, color: LIGHT.night.sun, strength: after * mix(STRENGTH.starlight, STRENGTH.moon, moonShine) * (1 - 0.3 * veil) };
  } else {
    light = { from: "stars", alt: 62 * RAD, az: sun.az + Math.PI, color: LIGHT.night.sun, strength: after * STRENGTH.starlight * (1 - 0.3 * veil) };
  }
  const land = greyed(blend("land"), 0.35).map((v) => v * (1 - 0.18 * veil));
  const hazeBase = [0.40 * 0.9, 0.66 * 0.9, 0.66 * 0.9]; // what the sky paints just under its horizon
  const fogColor = mix3([0.16, 0.20, 0.30], [0.74, 0.78, 0.80], day); // the white of a fog, by the hour
  const haze = mix3([hazeBase[0] * land[0], hazeBase[1] * land[1], hazeBase[2] * land[2]], fogColor, mist);
  return {
    day, dusk, night,
    zenith: greyed(airAt("zenith"), 0.9), mid: greyed(airAt("mid"), 0.9), horizon: greyed(airAt("horizon"), 0.8),
    flatSky: greyed(blend("flat"), 0.7),
    glow: [0.10, 0.08, 0.02].map((v) => v * day * (1 - veil)),
    duskGlow: [0.55, 0.20, 0.04].map((v) => v * dusk * (1 - 0.8 * veil)),
    sunDisc: mix3([1, 1, 1], [1.0, 0.62, 0.42], smooth(14, 0, altDeg)).map((v) => v * (1 - 0.85 * veil)),
    land, haze, fogColor,
    cloud: greyed(blend("cloud"), 0.55).map((v) => v * (1 - 0.25 * veil)), cloudShade: greyed(blend("cloudShade"), 0.5).map((v) => v * (1 - 0.3 * veil)),
    stars: smooth(-3, -10, altDeg) * (1 - veil) * (1 - mist),
    moonShow: moon ? smooth(-2, 1, moon.alt / RAD) * mix(1, 0.55, day) * (1 - 0.8 * veil) * (1 - mist) : 0,
    moonGlow: moonShine * night * (1 - veil),
    veil, mist,
    light,
    skyLight: {
      color: greyed(blend("sky"), 0.3), ground: blend("ground"),
      strength: mix(STRENGTH.nightSky, STRENGTH.sky, day) * (1 - 0.1 * veil),
    },
  };
}

/**
 * How brightly a level patch of ground in the open is lit, against a fine noon: for the tests, which hold
 * the night to "never black". (The light from all round, plus the one that casts by how squarely it falls.)
 */
export function groundLevel(look) {
  const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  return lum(look.skyLight.color) * look.skyLight.strength + lum(look.light.color) * look.light.strength * Math.sin(look.light.alt);
}

/** "/time ..." as typed: the two settings, and the times of day to try out. Null for anything else. */
export const TIMES = ["real", "day", "morning", "noon", "sunset", "night"];
export function parseTime(text) {
  const word = String(text ?? "").trim().toLowerCase();
  const known = { real: "real", live: "real", now: "real", day: "day", daytime: "day", always: "day", fine: "day", morning: "morning", sunrise: "morning", dawn: "morning", noon: "noon", midday: "noon", sunset: "sunset", evening: "sunset", dusk: "sunset", night: "night", midnight: "night" };
  return known[word] ?? null;
}
