import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { BARNYARD, FLAT, FLAT_GROUND, INK_TINT, LOOKS, SKY, flatLevels, lookSaid, parseLines, parseLook, vivid } from "../public/js/lookdata.js";

const GAME = new URL("../../game/Source/", import.meta.url);
const windows = (file: string): string => readFileSync(new URL(file, GAME), "utf8");
const haveWindows = existsSync(new URL("EarthWalk/EarthLook.cpp", GAME));
const noWindows = !haveWindows && "the Windows game's files are not here";

test("\"/look\" takes a look by name, and for the flat one whether to leave the black line off", () => {
  assert.deepEqual(LOOKS, ["barnyard", "flat"]);
  assert.deepEqual(parseLook("flat"), { name: "flat", lines: undefined });
  assert.deepEqual(parseLook("  Barnyard "), { name: "barnyard", lines: undefined });
  assert.deepEqual(parseLook("flat nolines"), { name: "flat", lines: false });
  assert.deepEqual(parseLook("flat no-lines"), { name: "flat", lines: false });
  assert.deepEqual(parseLook("flat lines"), { name: "flat", lines: true });
  for (const not of ["", null, undefined, "shiny", "flat please", "flat nolines now", "nolines"]) assert.equal(parseLook(not), null, `not a look: ${String(not)}`);
  assert.match(lookSaid("flat", true), /bold black line/);
  assert.match(lookSaid("flat", false), /without its black line/);
  assert.match(lookSaid("barnyard", true), /barnyard.*soft ink line/);
  assert.match(lookSaid("barnyard", false), /without its ink line/);
  assert.deepEqual(parseLook("barnyard nolines"), { name: "barnyard", lines: false });
});

test("\"/lines\" turns the drawn line on or off, or over", () => {
  for (const on of ["on", " ON ", "yes", "lines"]) assert.equal(parseLines(on), true);
  for (const off of ["off", "no", "none", "nolines", "no-lines"]) assert.equal(parseLines(off), false);
  for (const over of ["", "  ", null, undefined]) assert.equal(parseLines(over), undefined);
  assert.equal(parseLines("thicker"), null);
});

test("the barnyard look's line is the Windows game's soft one", { skip: noWindows }, () => {
  const cpp = windows("EarthWalk/EarthLook.cpp");
  /** The barnyard column of a dial in EarthLook.cpp: { TEXT("InkWidth"), 1.3f, 2.3f }. */
  const dial = (name: string): number => {
    const m = new RegExp(`TEXT\\("${name}"\\), ([\\d.]+)f, ([\\d.]+)f`).exec(cpp);
    assert.ok(m, `the dial ${name}`);
    return Number(m[1]);
  };
  assert.equal(BARNYARD.inkWidth, dial("InkWidth"));
  assert.equal(BARNYARD.inkStrength, dial("InkStrength"));
  assert.equal(BARNYARD.inkFar, dial("InkFar"));
  assert.equal(BARNYARD.farWidth, dial("FarWidth"));
  assert.equal(BARNYARD.depthEdge, dial("DepthEdge"));
  assert.equal(BARNYARD.paintEdge, dial("PaintEdge"));
  assert.equal(BARNYARD.paintInk, dial("PaintInk"));
  assert.equal(BARNYARD.inkBlack, dial("InkBlack"));
  assert.equal(BARNYARD.fadeStart, dial("FadeStart") / 100);
  assert.equal(BARNYARD.fadeEnd, dial("FadeEnd") / 100);
  assert.equal(FLAT.inkBlack, 1);
  // What the soft line multiplies the colour under it by.
  const code = windows("EarthWalkEditor/EarthWalkAssetsCommandlet.cpp");
  const tint = /c \* float3\(([\d.]+), ([\d.]+), ([\d.]+)\) \* \(1\.0 - InkBlack\)/.exec(code);
  assert.ok(tint, "the line's tint in InkCode");
  assert.deepEqual(INK_TINT, tint.slice(1).map(Number));
});

test("vivid pushes a colour away from its own grey and leaves a grey alone", () => {
  assert.deepEqual(vivid([0.5, 0.5, 0.5]), [0.5, 0.5, 0.5]);
  const [r, g, b] = vivid([0.8, 0.4, 0.2]);
  const grey = 0.299 * 0.8 + 0.587 * 0.4 + 0.114 * 0.2;
  assert.ok(Math.abs(r - (grey + (0.8 - grey) * 1.15)) < 1e-12);
  assert.ok(r > 0.8 && b < 0.2, "the strong get stronger and the weak weaker");
  assert.ok(Math.abs(0.299 * r + 0.587 * g + 0.114 * b - grey) < 1e-12, "as bright as it was");
  assert.ok(vivid([1, 0, 0], 5).every((c) => c >= 0), "never less than nothing");
});

test("the flat light has three levels close together, the brightest the surface's own colour", () => {
  const [shade, light, sun] = flatLevels();
  assert.equal(sun, 1);
  assert.ok(shade < light && light < sun);
  assert.ok(shade > 0.7, "a wall in shade is nearly the colour of a wall in sun");
  assert.ok(FLAT.band1 < FLAT.band2 && FLAT.band1 > 0 && FLAT.band2 < 1);
  assert.ok(FLAT.fadeStart < FLAT.fadeEnd);
});

test("the flat look's line and light are the Windows game's numbers", { skip: noWindows }, () => {
  const cpp = windows("EarthWalk/EarthLook.cpp");
  /** The flat column of a dial in EarthLook.cpp: { TEXT("InkWidth"), 1.3f, 2.3f }. */
  const dial = (name: string): number => {
    const m = new RegExp(`TEXT\\("${name}"\\), ([\\d.]+)f, ([\\d.]+)f`).exec(cpp);
    assert.ok(m, `the dial ${name}`);
    return Number(m[2]);
  };
  assert.equal(FLAT.vivid, dial("Vivid"));
  assert.equal(FLAT.inkWidth, dial("InkWidth"));
  assert.equal(FLAT.inkStrength, dial("InkStrength"));
  assert.equal(FLAT.inkFar, dial("InkFar"));
  assert.equal(FLAT.farWidth, dial("FarWidth"));
  assert.equal(FLAT.depthEdge, dial("DepthEdge"));
  assert.equal(FLAT.paintEdge, dial("PaintEdge"));
  assert.equal(FLAT.paintInk, dial("PaintInk"));
  assert.equal(FLAT.level0, dial("Level0"));
  assert.equal(FLAT.level1, dial("Level1"));
  assert.equal(FLAT.level2, dial("Level2"));
  assert.equal(FLAT.cloudInk, dial("CloudInk"));
  // Distances are in centimetres there and metres here.
  assert.equal(FLAT.fadeStart, dial("FadeStart") / 100);
  assert.equal(FLAT.fadeEnd, dial("FadeEnd") / 100);
  assert.equal(dial("InkBlack"), 1, "a plain black line, which is what the browser draws");
  assert.equal(dial("Plain"), 1, "the surface's own colour under the light, which is what the browser draws");
});

test("the flat look's ground is painted in the Windows game's colours", { skip: noWindows }, () => {
  const cpp = windows("EarthWalk/EarthWorld.cpp");
  // { 0, { TEXT("M_EarthTop"), 0x7fc04f, 4.f, 0.f, 0.f, 0.f, 0x79d23c } }: the last number is the flat look's colour.
  const rows = [...cpp.matchAll(/\{ (\d+), \{ TEXT\("M_Earth\w+"\), 0x[0-9a-f]+, [\d.]+f, [\d.]+f, [\d.]+f, [\d.]+f, 0x([0-9a-f]{6}) \} \}/g)];
  assert.ok(rows.length >= 15, `the Windows palette was read: ${rows.length} rows`);
  const theirs = Object.fromEntries(rows.map((m) => [Number(m[1]), parseInt(m[2], 16)]));
  assert.deepEqual(FLAT_GROUND, theirs);
});

test("the sky is painted with the Windows game's settings", { skip: noWindows }, () => {
  const cpp = windows("EarthWalkEditor/EarthWalkAssetsCommandlet.cpp");
  const set = (name: string): number => {
    const m = new RegExp(`TEXT\\("${name}"\\), ([\\d.]+)f \\}`).exec(cpp.slice(cpp.indexOf('TEXT("Bright")')));
    assert.ok(m, `the sky's ${name}`);
    return Number(m[1]);
  };
  assert.equal(SKY.bright, set("Bright"));
  assert.equal(SKY.cloudBright, set("CloudBright"));
  assert.equal(SKY.clouds, set("Clouds"));
  assert.equal(SKY.cloudInk, set("CloudInk"));
  assert.equal(SKY.drift, set("Drift"));
  assert.equal(SKY.sunSize, set("SunSize"));
});
