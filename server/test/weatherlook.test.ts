import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { FALL_BOX, FINE, MOST, TRY, parseWeather, weatherLook, weatherSaid } from "../public/js/weatherdata.js";
import { SKY } from "../public/js/lookdata.js";
import { kindOf } from "../src/weather.ts";

// What each kind of weather does to the picture and the sound, as numbers (weatherdata.js): the browser
// draws them, and the Windows game is to draw the same.

test("a fine day is the day the game always had", () => {
  const fine = weatherLook(FINE);
  assert.equal(fine.clouds, SKY.clouds, "white clouds in two places out of three");
  assert.deepEqual([fine.veil, fine.mist, fine.fogNear, fine.fogFar], [0, 0, 900, 2600]);
  assert.deepEqual([fine.rain.count, fine.snow.count, fine.leaves.count, fine.rainSound, fine.windSound, fine.thunder], [0, 0, 0, 0, 0, false]);
  assert.equal(fine.drift, 1, "the clouds cross the sky at the pace they always did");
  assert.ok(fine.sway > 0 && fine.sway < 0.1, "the trees barely stir");
});

test("each kind of weather to try out draws what it should", () => {
  for (const [name, report] of Object.entries(TRY)) {
    const look = weatherLook(report);
    assert.equal(look.rain.count > 0, ["rain", "storm", "drizzle"].includes(name), `${name}: rain`);
    assert.equal(look.snow.count > 0, name === "snow", `${name}: snow`);
    assert.equal(look.mist === 1, name === "fog", `${name}: fog`);
    assert.equal(look.thunder, name === "storm", `${name}: thunder`);
    assert.equal(look.rainSound > 0, look.rain.count > 0, `${name}: rain is heard when it falls`);
    assert.ok(look.rain.count <= MOST.rain && look.snow.count <= MOST.snow && look.leaves.count <= MOST.leaves);
    assert.ok(look.fogNear < look.fogFar);
    if (name !== "windy") assert.ok(look.veil >= 0.6, `${name}: a grey sky`);
    assert.equal(kindOf({ cloudy: 3, drizzle: 53, rain: 63, storm: 95, snow: 73, fog: 45, windy: 1 }[name]!, report.cloud), report.kind, `${name} is a kind the server sends`);
    assert.match(weatherSaid(report), /degrees/);
  }
  const windy = weatherLook(TRY.windy);
  assert.ok(windy.leaves.count > 100 && windy.windSound > 0.8 && windy.sway > 0.25 && windy.drift > 3, "a windy day: leaves in the air, the trees leaning, the clouds racing");
  assert.ok(weatherLook(TRY.storm).rain.count > weatherLook(TRY.rain).rain.count && weatherLook(TRY.rain).rain.count > weatherLook(TRY.drizzle).rain.count, "the harder it rains, the more of it");
  assert.ok(weatherLook(TRY.fog).fogFar <= 260, "in fog the end of the street is gone");
  assert.ok(weatherLook(TRY.snow).fogFar < weatherLook(TRY.rain).fogFar && weatherLook(TRY.rain).fogFar < 2600, "snow hides more than rain, and rain more than nothing");
  assert.deepEqual(FALL_BOX, [30, 20, 30]);
});

test("the wind carries things the way it blows", () => {
  // A westerly blows from the west, towards the east: east is +x in the scene, south is +z.
  const west = weatherLook({ kind: "fine", cloud: 0, wind: 10, windFrom: 270 });
  assert.ok(Math.abs(west.windX - 10) < 1e-9 && Math.abs(west.windZ) < 1e-9);
  const north = weatherLook({ kind: "fine", cloud: 0, wind: 10, windFrom: 0 });
  assert.ok(Math.abs(north.windZ - 10) < 1e-9 && Math.abs(north.windX) < 1e-9, "a northerly blows south");
  assert.match(weatherSaid({ ...FINE, wind: 10, windFrom: 225 }), /a strong wind from the south-west/);
  assert.match(weatherSaid({ ...FINE, cloud: 0.1 }), /a clear sky, 18 degrees, hardly any wind$/);
});

test("the sky clouds over by degrees, and odd reports do no harm", () => {
  let was = -1;
  for (let cloud = 0; cloud <= 1.0001; cloud += 0.1) {
    const look = weatherLook({ kind: cloud > 0.6 ? "cloudy" : "fine", cloud });
    assert.ok(look.clouds >= was && look.clouds <= 1);
    was = look.clouds;
  }
  assert.equal(weatherLook({ kind: "cloudy", cloud: 1 }).veil, 0.85);
  assert.equal(weatherLook({ kind: "fine", cloud: 0.5 }).veil, 0);
  const odd = weatherLook({ kind: "hail of frogs" });
  assert.deepEqual([odd.rain.count, odd.snow.count, odd.mist, odd.windSound], [0, 0, 0, 0]);
  assert.ok(Number.isFinite(odd.windX) && Number.isFinite(odd.sway));
  assert.ok(weatherLook({ kind: "rain", cloud: 1, rain: 500, wind: 900 }).rain.count <= MOST.rain);
});

test("\"/weather\" takes the two settings and the kinds to try out", () => {
  assert.equal(parseWeather("real"), "real");
  assert.equal(parseWeather(" Fine "), "fine");
  assert.equal(parseWeather("off"), "fine");
  for (const kind of Object.keys(TRY)) assert.equal(parseWeather(kind), kind);
  assert.equal(parseWeather("snowing"), "snow");
  assert.equal(parseWeather("thunder"), "storm");
  for (const not of ["", null, undefined, "frogs", "rain please"]) assert.equal(parseWeather(not), null);
});

test("the browser's own files for the sky and the weather are served as they are named", () => {
  // (The page loads them by these names; a renamed file would be a blank sky with no test failing.)
  for (const file of ["skymath.js", "daynight.js", "weather.js", "weatherdata.js", "sway.js"]) assert.ok(existsSync(new URL(`../public/js/${file}`, import.meta.url)), file);
  const main = readFileSync(new URL("../public/js/main.js", import.meta.url), "utf8");
  for (const name of ["./daynight.js", "./weather.js"]) assert.ok(main.includes(`from "${name}"`), `main.js loads ${name}`);
});
