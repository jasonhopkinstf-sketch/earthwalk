// The looks, as numbers. "barnyard" is the normal look. "flat" is the second one: bright even colours
// and a bold black line, like a television cartoon. The style is the game's own: no characters,
// places or designs from any show.
//
// The numbers are the Windows game's (game/Source/EarthWalk/EarthLook.cpp for the line and the light,
// EarthWorld.cpp `StyleFor` for the ground's colours); test/look.test.ts fails when they drift apart.
// The drawing is look.js.
//
// No three.js and no page here: this file is also run by the server's tests.

export const LOOKS = ["barnyard", "flat"];

/**
 * The flat look's own, brighter colour for each kind of ground, by the server's surface id
 * (docs/PROTOCOL.md). Buildings keep the colour the server sent, made a little more vivid.
 */
export const FLAT_GROUND = {
  0: 0x79d23c, // unclassified land: meadow
  1: 0x5cc832, // parks and grass
  2: 0x3f9f35, // forest floor
  3: 0xf0d660, // farmland
  4: 0xf9e79f, // sand
  5: 0x86d94a, // residential land: lawns
  6: 0xd9d4c8, // paved
  7: 0x3aa8f2, // water
  8: 0xaaa59c, // rock
  10: 0x8d919c, // roads
  11: 0xefcb8a, // paths
  12: 0x80593f, // railway
  13: 0x3aa8f2, // streams
  14: 0xe6e1d5, // pavements
  15: 0xffffff, // road markings
  32: 0x3bae42, // hedges
  33: 0xffffff, // picket fences
};

/**
 * The flat look's dials. The ink's are M_EarthInk's in its flat column, in the Windows names; distances
 * are in metres here (centimetres there).
 */
export const FLAT = {
  vivid: 0.15, // the colour brighter than it was sent
  // The light in three flat levels: shade, light, full sun. Close together, so a wall in shade is nearly the colour of a wall in sun.
  level0: 1.2,
  level1: 1.45,
  level2: 1.55,
  // Which level a surface gets, by how squarely it faces the sun (the cosine of the angle). The Windows game
  // sorts by the light that reaches the surface (Band1 0.9, Band2 2.2); with its sun and sky that is about these.
  band1: 0.1,
  band2: 0.53,
  inkWidth: 2.3, // pixels, on a screen 720 high
  inkStrength: 1,
  inkFar: 0.5, // how strong the line still is far away
  farWidth: 0.45, // and how wide, as a part of its width close by
  depthEdge: 0.02,
  paintEdge: 0.16,
  paintInk: 1,
  fadeStart: 50,
  fadeEnd: 400,
  cloudInk: 1.7,
};
/** The sky's dials that do not change with the look (M_EarthSky). */
export const SKY = { bright: 0.9, cloudBright: 1.5, clouds: 0.66, cloudInk: 1, drift: 0.0025, sunSize: 0.05, moonSize: 0.045 };

/**
 * What "/look ..." asked for: { name, lines } with `lines` false for "flat nolines" (the black line
 * is the costly part, so slow machines can leave it off) and undefined when nothing was said about them.
 * Null for anything that is not a look.
 */
export function parseLook(text) {
  const words = String(text ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!LOOKS.includes(words[0]) || words.length > 2) return null;
  const more = words[1];
  if (more !== undefined && !/^(no-?lines|lines)$/.test(more)) return null;
  return { name: words[0], lines: more === undefined ? undefined : more === "lines" };
}

/** What to tell the player about the look they are in. */
export function lookSaid(name, lines) {
  if (name === "flat") return lines
    ? "The flat look: bright even colours and a bold black line. /look barnyard goes back; /look flat nolines leaves the line off, for a slow computer."
    : "The flat look without its black line. /look flat lines puts the line back; /look barnyard goes back.";
  return "The barnyard look. /look flat is the other one: bright flat colours and bold black lines.";
}

/** A colour made more vivid: further from its own grey. `rgb` is [r, g, b] as amounts of light (linear), 0 to 1. */
export function vivid(rgb, amount = FLAT.vivid) {
  const grey = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
  return rgb.map((c) => Math.max(0, grey + (c - grey) * (1 + amount)));
}

/** The three levels of light as the browser draws them: full sun is the surface's own colour, the others darker by the same steps as in Windows. */
export const flatLevels = () => [FLAT.level0 / FLAT.level2, FLAT.level1 / FLAT.level2, 1];
