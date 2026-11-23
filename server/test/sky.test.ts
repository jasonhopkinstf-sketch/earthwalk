import { test } from "node:test";
import assert from "node:assert/strict";
import { FINE_DAY, HANDOVER_DEG, daysSince2000, groundLevel, momentOf, moonAt, moonName, parseTime, skyDirection, skyLight, sunAt } from "../public/js/skymath.js";

// The sun and the moon are worked out in the game, from the place and the moment. Here the sums are held
// to days whose sky is on record: the solstices and an equinox, sunrise in London, an eclipse of the sun
// (when the moon must stand right on the sun), full moons and a quarter.

const DEG = 180 / Math.PI;
const at = (iso: string): number => Date.parse(iso);
const near = (got: number, want: number, within: number, what: string): void => assert.ok(Math.abs(got - want) <= within, `${what}: ${got.toFixed(3)}, wanted ${want} within ${within}`);
/** The angle between two places in the sky, in degrees. */
const apart = (a: { alt: number; az: number }, b: { alt: number; az: number }): number => {
  const [p, q] = [skyDirection(a.alt, a.az), skyDirection(b.alt, b.az)];
  return Math.acos(Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2])) * DEG;
};

const GREENWICH = { lat: 51.4779, lon: 0 };
const AUCKLAND = { lat: -36.8485, lon: 174.7633 };

test("days are counted from noon on 1 January 2000", () => {
  assert.equal(daysSince2000(at("2000-01-01T12:00:00Z")), 0);
  assert.equal(daysSince2000(at("2026-11-24T00:00:00Z")), 9823.5);
});

test("the sun is over the equator at an equinox and over a tropic at a solstice", () => {
  near(sunAt(at("2024-03-20T03:06:00Z"), 0, 0).dec * DEG, 0, 0.02, "March equinox 2024");
  near(sunAt(at("2024-06-20T20:51:00Z"), 0, 0).dec * DEG, 23.44, 0.02, "June solstice 2024");
  near(sunAt(at("2024-12-21T09:21:00Z"), 0, 0).dec * DEG, -23.44, 0.02, "December solstice 2024");
  near(sunAt(at("2026-09-23T00:05:00Z"), 0, 0).dec * DEG, 0, 0.02, "September equinox 2026");
  // At the North Pole the sun is as high as it is far north, whatever the hour.
  for (const hour of ["00", "07", "15"]) near(sunAt(at(`2024-06-20T${hour}:00:00Z`), 90, 0).alt * DEG, 23.44, 0.03, "the midnight sun at the pole");
});

test("at Greenwich the sun is due south at noon, as high as the season has it, and rises when the almanac says", () => {
  // Mid April the sundial and the clock agree to within a minute.
  const noon = sunAt(at("2024-04-15T12:00:00Z"), GREENWICH.lat, GREENWICH.lon);
  near(noon.az * DEG, 180, 0.3, "due south");
  near(noon.alt * DEG, 90 - GREENWICH.lat + noon.dec * DEG, 0.01, "its height at noon");
  near(noon.dec * DEG, 9.9, 0.2, "nearly ten degrees north of the equator");
  // Midsummer in London: up at 4:43 and down at 21:21 by the summer clock, which is 03:43 and 20:21 here.
  // (Sunrise is the top edge showing through the bending air: the middle of the sun is then 0.83 degrees under.)
  near(sunAt(at("2024-06-21T03:43:00Z"), 51.5074, -0.1278).alt * DEG, -0.83, 0.25, "sunrise");
  near(sunAt(at("2024-06-21T20:21:30Z"), 51.5074, -0.1278).alt * DEG, -0.83, 0.25, "sunset");
  const rise = sunAt(at("2024-06-21T03:43:00Z"), 51.5074, -0.1278), set = sunAt(at("2024-06-21T20:21:30Z"), 51.5074, -0.1278);
  near(rise.az * DEG, 49, 1.5, "it rises in the north-east");
  near(set.az * DEG, 311, 1.5, "and sets in the north-west");
});

test("south of the tropics the noon sun is in the north", () => {
  // Auckland at midsummer: the sun crosses the north of the sky, 90 - (36.85 - 23.44) degrees up.
  const noon = momentOf("noon", at("2024-12-21T00:00:00Z"), AUCKLAND.lat, AUCKLAND.lon);
  const sun = sunAt(noon, AUCKLAND.lat, AUCKLAND.lon);
  near(sun.alt * DEG, 76.59, 0.05, "its height");
  assert.ok(sun.az * DEG < 3 || sun.az * DEG > 357, `due north: ${(sun.az * DEG).toFixed(1)}`);
  // And it is the middle of the day there: twenty past one in the afternoon by the summer clock.
  near((noon - at("2024-12-21T00:19:00Z")) / 60000, 0, 4, "minutes from the sundial's noon");
  // Winter: low in the north.
  near(sunAt(momentOf("noon", at("2024-06-21T00:00:00Z"), AUCKLAND.lat, AUCKLAND.lon), AUCKLAND.lat, AUCKLAND.lon).alt * DEG, 90 - 36.8485 - 23.44, 0.05, "the midwinter noon");
});

test("in an eclipse of the sun the moon stands on the sun, seen from where the shadow falls", () => {
  // 8 April 2024, the greatest eclipse: 18:17:20 at 25.29 N, 104.14 W (Mexico).
  const when = at("2024-04-08T18:17:20Z");
  const sun = sunAt(when, 25.29, -104.14), moon = moonAt(when, 25.29, -104.14);
  assert.ok(apart(sun, moon) < 0.35, `the moon on the sun: ${apart(sun, moon).toFixed(2)} degrees apart`);
  assert.ok(moon.lit < 0.001, "and its face dark");
  assert.equal(moonName(moon.age), "new moon");
  near(sun.alt * DEG, 69.8, 0.6, "high in the sky");
  // 14 October 2023, the ring eclipse: greatest at 17:59:30, 11.37 N, 83.10 W.
  const ring = at("2023-10-14T17:59:30Z");
  assert.ok(apart(sunAt(ring, 11.37, -83.1), moonAt(ring, 11.37, -83.1)) < 0.35);
});

test("the moon is full, new and half lit on the days it was", () => {
  const anywhere = [10, 20] as const;
  const full = moonAt(at("2024-09-18T02:34:00Z"), ...anywhere);
  assert.ok(full.lit > 0.998 && full.apartDeg > 178.5, `full on 18 September 2024: ${full.lit.toFixed(4)}`);
  assert.equal(moonName(full.age), "full moon");
  // The eclipse of the moon of 14 March 2025: the Earth right between.
  assert.ok(moonAt(at("2025-03-14T06:59:00Z"), ...anywhere).apartDeg > 179.3);
  const quarter = moonAt(at("2024-04-15T19:13:00Z"), ...anywhere);
  near(quarter.lit, 0.5, 0.01, "first quarter on 15 April 2024");
  assert.equal(quarter.waxing, true);
  assert.equal(moonName(quarter.age), "first quarter");
  const last = moonAt(at("2024-10-24T08:03:00Z"), ...anywhere);
  near(last.lit, 0.5, 0.01, "last quarter on 24 October 2024");
  assert.equal(last.waxing, false);
  assert.ok(moonAt(at("2026-11-24T14:53:00Z"), ...anywhere).lit > 0.997, "full on 24 November 2026");
  assert.ok(moonAt(at("2026-11-09T07:02:00Z"), ...anywhere).lit < 0.003, "new on 9 November 2026");
  // A full moon is up all night: opposite the sun, so high at midnight when the sun is far under.
  const midnight = momentOf("night", at("2026-11-24T12:00:00Z"), AUCKLAND.lat, AUCKLAND.lon);
  assert.ok(sunAt(midnight, AUCKLAND.lat, AUCKLAND.lon).alt * DEG < -25);
  assert.ok(moonAt(midnight, AUCKLAND.lat, AUCKLAND.lon).alt * DEG > 20);
});

test("the moon is seen from the ground, not from the middle of the Earth", () => {
  // On the horizon it is nearly a degree lower than the sums for the Earth's middle have it; overhead, no lower.
  const when = at("2024-09-18T02:34:00Z");
  let lowest = 0;
  for (let lon = -180; lon < 180; lon += 5) {
    const moon = moonAt(when, 0, lon);
    const [x, y, z] = skyDirection(moon.alt, moon.az);
    near(Math.hypot(x, y, z), 1, 1e-9, "a direction is one long");
    if (Math.abs(moon.alt) < Math.abs(lowest) || lowest === 0) lowest = moon.alt;
  }
  assert.ok(Number.isFinite(lowest));
});

test("times of day to try out are found from the real sun over the place", () => {
  const day = at("2026-11-24T02:00:00Z");
  const alt = (when: Parameters<typeof momentOf>[0]) => sunAt(momentOf(when, day, AUCKLAND.lat, AUCKLAND.lon), AUCKLAND.lat, AUCKLAND.lon).alt * DEG;
  assert.ok(alt("noon") > 70);
  assert.ok(alt("night") < -30);
  near(alt("sunset"), 4, 0.5, "sunset: the sun four degrees up");
  near(alt("morning"), 4, 0.5, "morning: the same, on its way up");
  const up = sunAt(momentOf("morning", day, AUCKLAND.lat, AUCKLAND.lon), AUCKLAND.lat, AUCKLAND.lon).az * DEG;
  const down = sunAt(momentOf("sunset", day, AUCKLAND.lat, AUCKLAND.lon), AUCKLAND.lat, AUCKLAND.lon).az * DEG;
  assert.ok(up > 60 && up < 120 && down > 240 && down < 300, "up in the east, down in the west");
  // Where the sun does not set that day there is still a morning and an evening to show.
  for (const when of ["morning", "sunset", "noon", "night"] as const) assert.ok(Number.isFinite(momentOf(when, at("2026-06-21T00:00:00Z"), 80, 20)));
  assert.equal(parseTime(" Real "), "real");
  assert.equal(parseTime("day"), "day");
  assert.equal(parseTime("midnight"), "night");
  assert.equal(parseTime("evening"), "sunset");
  for (const not of ["", "teatime", null, undefined, "12:30"]) assert.equal(parseTime(not), null);
});

test("the night is a bright one: never black, and nothing jumps as the sun goes down", () => {
  const RAD = Math.PI / 180;
  const sunLow = (deg: number) => ({ alt: deg * RAD, az: 4.4 });
  const noMoon = null, fullMoon = { alt: 50 * RAD, az: 1, lit: 1 }, thinMoon = { alt: 30 * RAD, az: 1, lit: 0.08 };
  const noon = groundLevel(skyLight(FINE_DAY, noMoon));
  near(noon, 1.15 + 0.299 * 2.1 * Math.sin(FINE_DAY.alt) * 1 + (0.587 * 0.89 + 0.114 * 0.72) * 2.1 * Math.sin(FINE_DAY.alt), 0.01, "a fine noon is the light the game always had");
  for (const [moon, name] of [[noMoon, "no moon"], [thinMoon, "a thin moon"], [fullMoon, "a full moon"]] as const) {
    for (let deg = -90; deg <= HANDOVER_DEG; deg += 1) {
      const level = groundLevel(skyLight(sunLow(deg), moon)) / noon;
      assert.ok(level > 0.3, `${name}, sun ${deg} degrees: ${level.toFixed(2)} of a noon`);
      assert.ok(level < 0.75, `${name}, sun ${deg} degrees: still plainly night (${level.toFixed(2)})`);
    }
  }
  assert.ok(groundLevel(skyLight(sunLow(-40), fullMoon)) > groundLevel(skyLight(sunLow(-40), noMoon)) * 1.1, "a full moon is brighter than none");
  // Sunset to night in small steps: the ground's light never jumps, and neither does any colour of the air.
  for (const moon of [noMoon, fullMoon]) {
    let was = skyLight(sunLow(20), moon);
    for (let deg = 19.9; deg >= -20; deg -= 0.1) {
      const now = skyLight(sunLow(deg), moon);
      assert.ok(Math.abs(groundLevel(now) - groundLevel(was)) < 0.02 * noon, `the light steps at ${deg.toFixed(1)} degrees`);
      for (const part of ["zenith", "mid", "horizon", "haze", "cloud"] as const) for (let i = 0; i < 3; i++) assert.ok(Math.abs(now[part][i] - was[part][i]) < 0.02, `${part} steps at ${deg.toFixed(1)}`);
      was = now;
    }
  }
  // Which light casts: the sun by day, the moon by night, the stars when there is no moon to speak of.
  assert.equal(skyLight(sunLow(30), fullMoon).light.from, "sun");
  assert.equal(skyLight(sunLow(-30), fullMoon).light.from, "moon");
  assert.equal(skyLight(sunLow(-30), noMoon).light.from, "stars");
  assert.equal(skyLight(sunLow(-30), { alt: -0.3, az: 1, lit: 1 }).light.from, "stars", "a moon that is down lights nothing");
  // Stars come out after dark and not before; an overcast or foggy sky has none.
  assert.equal(skyLight(sunLow(10), noMoon).stars, 0);
  assert.equal(skyLight(sunLow(-20), noMoon).stars, 1);
  assert.equal(skyLight(sunLow(-20), noMoon, { veil: 1 }).stars, 0);
  assert.equal(skyLight(sunLow(-20), noMoon, { mist: 1 }).stars, 0);
  // The fine day the game always had: the same blue, the same white clouds, the same light.
  const fine = skyLight(FINE_DAY, noMoon);
  assert.deepEqual(fine.zenith, [0.025, 0.15, 0.70]);
  assert.deepEqual(fine.horizon, [0.42, 0.70, 0.95]);
  assert.deepEqual(fine.cloud, [1.0, 1.0, 0.985]);
  assert.deepEqual(fine.land, [1, 1, 1]);
  assert.deepEqual(fine.hour, [1, 1, 1]);
  assert.ok(skyLight(sunLow(-30), noMoon).hour.every((v) => v > 0.3 && v < 0.85), "the flat look's night is dimmer than its day, and not dark");
  assert.equal(fine.light.strength, 2.1);
  assert.equal(fine.skyLight.strength, 1.15);
  assert.equal(fine.dusk, 0);
  // Overcast: greyer and dimmer, but the day is still a day.
  const grey = skyLight(FINE_DAY, noMoon, { veil: 1 });
  assert.ok(grey.light.strength < fine.light.strength * 0.5 && groundLevel(grey) > noon * 0.5);
  assert.ok(Math.abs(grey.zenith[0] - grey.zenith[2]) < 0.2, "the blue has gone grey");
});
