// What each animal looks like and how it behaves near people. Tables only: life.js turns them into
// shapes on screen.
//
// A figure stands with its feet at y = 0, facing north (-z), sizes in metres, and is built from
// basic shapes like the players' animals. A part is [shape, colour, position, size, role, tilt].
// Size is the three radii of a sphere; radius, height, radius of a cylinder or cone; and the width,
// height and depth of a box. Colour "a" is the animal's coat and "b" its second colour.
//
// Roles move: "head" turns about `neck` (and sinks `drop` metres while grazing); "leg0".."leg3"
// swing from their tops; "tail" hangs from its top and "tailup" stands on its base; "wing0" (left)
// and "wing1" (right) flap from the shoulder.
//
// Behaviour: `alert` and `flee` are the distances in metres at which the animal looks up and steps
// aside (0: never). `voice` is its everyday call and `alarm` the one it makes when startled.
// `peck` pecks instead of grazing, `hop` is the height of its hop, `swim` floats (sunk by that much),
// `waddle` rocks from foot to foot, `takesOff` flies up out of reach, `curious` comes to see who
// it is, `fly` never lands, and `flock` gives the whole group one coat. A machine that `yields`
// stops for anyone that many metres in front of it, and a boat that `heel`s leans to its sail.
//
// Tractors and boats are here with the animals because they go round a home in the same way. Cars
// and vans are in VEHICLES at the end; traffic.js drives them.

const PINK = 0xe8b4a8;
const DARK = 0x26221f;
const CREAM = 0xf3ecd9;
const ORANGE = 0xe8a23a;
const RED = 0xd23a2e;
const AHEAD = -Math.PI / 2; // tilts a cone or cylinder to point forward
const GLASS = 0xbfe0ee;
const TYRE = 0x2a2b2e;
const WOOD = 0x8a5a34;
/** Paint for things with windows: [body, glass]. */
const PAINTS = [0xd94a3a, 0x3f7fd0, 0xf2c94c, 0x4caf6a, 0xf4f1ea, 0x8f9aa6, 0xf08a3c, 0x2f8f8a, 0x7a4f9a, 0x2f3b55].map((c) => [c, GLASS]);
/** Four wheels: tyres as fat discs. */
const wheels = (x, front, back, radius, y = radius) => [
  ...pair("sphere", TYRE, [x, y, -front], [0.14, radius, radius]),
  ...pair("sphere", TYRE, [x, y, back], [0.14, radius, radius]),
];

/** The same part on the left and on the right. `roles` names each side's role, if they move. */
const pair = (shape, colour, [x, y, z], size, roles = ["", ""], tilt = 0) => [
  [shape, colour, [-x, y, z], size, roles[0], tilt],
  [shape, colour, [x, y, z], size, roles[1], tilt],
];
/** Four legs: front left, front right, back left, back right. */
const legs = (colour, x, z, radius, height) => [
  ["cyl", colour, [-x, height / 2, -z], [radius, height, radius], "leg0"],
  ["cyl", colour, [x, height / 2, -z], [radius, height, radius], "leg1"],
  ["cyl", colour, [-x, height / 2, z], [radius, height, radius], "leg2"],
  ["cyl", colour, [x, height / 2, z], [radius, height, radius], "leg3"],
];
const HEAD = ["head", "head"];
const WINGS = ["wing0", "wing1"];

export const RIGS = {
  cow: {
    voice: "moo", alarm: "moo", alert: 7, flee: 2.4, stride: 1.5, graze: 1.1, drop: 0.35, neck: [0, 1.05, -0.7],
    coats: [[0xf4efe6, 0x2b2623], [0x8a4f2d, 0xf4efe6], [0x2b2623, 0xf4efe6], [0xc79a62, 0xf4efe6], [0xf4efe6, 0x8a4f2d]],
    parts: [
      ["sphere", "a", [0, 0.95, 0], [0.42, 0.42, 0.85]],
      ["sphere", "b", [0.2, 1.1, 0.25], [0.3, 0.26, 0.36]],
      ["sphere", "b", [-0.22, 0.98, -0.3], [0.27, 0.3, 0.3]],
      ["sphere", PINK, [0, 0.56, 0.4], [0.15, 0.11, 0.17]],
      ["sphere", "a", [0, 1.2, -1.0], [0.24, 0.26, 0.32], "head"],
      ["sphere", PINK, [0, 1.1, -1.27], [0.19, 0.15, 0.16], "head"],
      ...pair("sphere", DARK, [0.13, 1.28, -1.25], [0.035, 0.045, 0.03], HEAD),
      ...pair("sphere", "b", [0.3, 1.3, -0.9], [0.12, 0.05, 0.07], HEAD),
      ...pair("cone", CREAM, [0.17, 1.5, -0.92], [0.04, 0.16, 0.04], HEAD),
      ...legs("a", 0.24, 0.55, 0.085, 0.86),
      ["cyl", "b", [0, 0.82, 0.86], [0.025, 0.5, 0.025], "tail"],
    ],
  },
  sheep: {
    voice: "baa", alarm: "baa", alert: 9, flee: 4, stride: 0.8, graze: 0.9, drop: 0.3, neck: [0, 0.7, -0.4],
    coats: [[0xf1ead8, 0x3a3430], [0xe9e2cf, 0x3a3430], [0xf4f0e4, 0xe6dcc6], [0xdcd3bd, 0x4a403a], [0xf1ead8, 0x3a3430], [0xe9e2cf, 0x4a403a], [0xf4f0e4, 0x3a3430], [0xf1ead8, 0xe6dcc6], [0xe9e2cf, 0x3a3430], [0x3d3632, 0x2a2522]],
    parts: [
      ["sphere", "a", [0, 0.62, 0], [0.36, 0.34, 0.5]],
      ["sphere", "a", [0.12, 0.82, 0.2], [0.26, 0.24, 0.26]],
      ["sphere", "a", [-0.14, 0.8, -0.15], [0.26, 0.24, 0.27]],
      ["sphere", "a", [0, 0.7, 0.42], [0.27, 0.26, 0.2]],
      ["sphere", "b", [0, 0.78, -0.6], [0.14, 0.16, 0.2], "head"],
      ["sphere", "a", [0, 0.92, -0.5], [0.14, 0.09, 0.13], "head"],
      ...pair("sphere", "b", [0.17, 0.84, -0.55], [0.09, 0.035, 0.05], HEAD),
      ...legs("b", 0.16, 0.3, 0.045, 0.48),
      ["sphere", "a", [0, 0.66, 0.56], [0.07, 0.07, 0.07], "tail"],
    ],
  },
  horse: {
    voice: "neigh", alarm: "neigh", alert: 8, flee: 3, stride: 2.1, graze: 1.5, drop: 0.5, neck: [0, 1.45, -0.68],
    coats: [[0x8a4b2a, 0x2b211c], [0x5e3a22, 0x1f1a17], [0xb8b4ac, 0x6d6a66], [0x2e2a28, 0x191615], [0xd9b06a, 0xf1e6cc], [0x8a4b2a, 0xf1e6cc]],
    parts: [
      ["sphere", "a", [0, 1.25, 0], [0.38, 0.42, 0.9]],
      ["cyl", "a", [0, 1.62, -0.92], [0.2, 0.62, 0.22], "head", -0.95],
      ["sphere", "a", [0, 1.82, -1.42], [0.16, 0.19, 0.36], "head", -0.75],
      ["box", "b", [0, 1.74, -0.8], [0.06, 0.62, 0.14], "head", -0.95],
      ...pair("sphere", DARK, [0.13, 1.92, -1.38], [0.03, 0.04, 0.03], HEAD),
      ...pair("cone", "a", [0.09, 2.06, -1.2], [0.045, 0.14, 0.045], HEAD),
      ...legs("a", 0.21, 0.6, 0.08, 1.1),
      ["cyl", "b", [0, 1.05, 0.98], [0.07, 0.75, 0.07], "tail", 0.3],
    ],
  },
  chicken: {
    voice: "cluck", alarm: "squawk", alert: 5, flee: 3, stride: 0.22, graze: 1.1, drop: 0.15, neck: [0, 0.3, -0.08], peck: true,
    coats: [[0xf6f1e4, 0xf6f1e4], [0xb5622e, 0x7a3d1c], [0x2b2b2b, 0x1c1c1c], [0xcfc8ba, 0x8f8a80], [0xb5622e, 0x2b2b2b]],
    parts: [
      ["sphere", "a", [0, 0.24, 0], [0.13, 0.13, 0.17]],
      ["cone", "b", [0, 0.36, 0.17], [0.07, 0.17, 0.07], "tail", 0.7],
      ["sphere", "a", [0, 0.42, -0.13], [0.07, 0.075, 0.07], "head"],
      ["sphere", RED, [0, 0.5, -0.13], [0.02, 0.04, 0.05], "head"],
      ["sphere", RED, [0, 0.36, -0.18], [0.02, 0.03, 0.02], "head"],
      ["cone", ORANGE, [0, 0.42, -0.22], [0.025, 0.07, 0.025], "head", AHEAD],
      ...pair("sphere", DARK, [0.05, 0.44, -0.17], [0.012, 0.014, 0.012], HEAD),
      ...pair("cyl", ORANGE, [0.05, 0.07, 0], [0.012, 0.14, 0.012], ["leg0", "leg1"]),
    ],
  },

  // ---- on the water
  duck: {
    voice: "quack", alarm: "quack", alert: 6, flee: 3.5, stride: 0.3, graze: 0.9, drop: 0.08, neck: [0, 0.13, -0.1],
    swim: 0.02, wing: { air: [0, 0], walk: [0, 0], startled: [0.5, 0.35], rate: 22 },
    coats: [[0xb9b3a8, 0x1f6b45], [0x8a6a45, 0x7a5a38], [0xf4f1e8, 0xf4f1e8], [0x9a958c, 0x1f6b45], [0x8f7150, 0x6f5234]],
    parts: [
      ["sphere", "a", [0, 0.08, 0], [0.12, 0.09, 0.19]],
      ["cone", "a", [0, 0.14, 0.2], [0.06, 0.12, 0.06], "", 1.0],
      ["cyl", "b", [0, 0.2, -0.13], [0.04, 0.14, 0.04], "head"],
      ["sphere", "b", [0, 0.29, -0.15], [0.065, 0.06, 0.075], "head"],
      ["cone", ORANGE, [0, 0.28, -0.25], [0.035, 0.09, 0.018], "head", AHEAD],
      ...pair("sphere", DARK, [0.05, 0.31, -0.19], [0.012, 0.014, 0.012], HEAD),
      ...pair("sphere", "a", [0.11, 0.11, 0.02], [0.03, 0.065, 0.15], WINGS),
    ],
  },

  // ---- in town and overhead
  pigeon: {
    voice: "coo", alarm: null, alert: 5, flee: 3.5, stride: 0.12, graze: 1.0, drop: 0.07, neck: [0, 0.17, -0.05], peck: true,
    takesOff: 4.5, wing: { air: [1.3, 0.5], walk: [0, 0], rate: 30 },
    coats: [[0x8d949e, 0x5d6470], [0xb0b4ba, 0x7a808a], [0xe8e6e0, 0xcfccc4], [0x6b5a4e, 0x4a3d35], [0x8d949e, 0x4f6a5c]],
    parts: [
      ["sphere", "a", [0, 0.13, 0], [0.075, 0.07, 0.12]],
      ["cone", "b", [0, 0.13, 0.15], [0.04, 0.12, 0.02], "", 1.4],
      ["sphere", "b", [0, 0.23, -0.08], [0.045, 0.045, 0.045], "head"],
      ["cone", DARK, [0, 0.225, -0.135], [0.012, 0.04, 0.012], "head", AHEAD],
      ...pair("sphere", 0xe07a2a, [0.03, 0.24, -0.1], [0.01, 0.01, 0.01], HEAD),
      ...pair("sphere", "b", [0.075, 0.15, 0.02], [0.02, 0.05, 0.11], WINGS),
      ...pair("cyl", 0xd98a8a, [0.03, 0.04, 0], [0.008, 0.08, 0.008], ["leg0", "leg1"]),
    ],
  },
  bird: {
    voice: "caw", alarm: null, alert: 0, flee: 0, stride: 1, graze: 0, drop: 0, neck: [0, 0, 0],
    fly: true, flock: true, wing: { air: [0.05, 0.55], walk: [0, 0], rate: 7 },
    coats: [[0xf2f2ee, 0xaab0b8], [0x2a2a2e, 0x1c1c20], [0xe8e4da, 0x6f7680], [0x7a5f48, 0x4f3d2e], [0xf2f2ee, 0x8f969e]],
    parts: [
      ["sphere", "a", [0, 0, 0], [0.11, 0.09, 0.3]],
      ["sphere", "a", [0, 0.03, -0.3], [0.07, 0.065, 0.08]],
      ["cone", ORANGE, [0, 0.02, -0.4], [0.02, 0.08, 0.02], "", AHEAD],
      ["cone", "b", [0, 0, 0.34], [0.07, 0.2, 0.02], "", -AHEAD],
      ...pair("sphere", "b", [0.4, 0.02, 0], [0.38, 0.02, 0.11], WINGS),
    ],
  },

  // ---- pets
  cat: {
    voice: "meow", alarm: null, alert: 6, flee: 1.8, stride: 0.35, graze: 0.5, drop: 0.05, neck: [0, 0.27, -0.18],
    coats: [[0xd98a3a, 0xf4e9d8], [0x26221f, 0x26221f], [0x8a8a86, 0xd8d6d0], [0xf4f1ea, 0xf4f1ea], [0x2b2826, 0xf4f1ea], [0x8a6a48, 0xe6d8c2]],
    parts: [
      ["sphere", "a", [0, 0.22, 0], [0.09, 0.09, 0.22]],
      ["sphere", "b", [0, 0.19, -0.1], [0.07, 0.07, 0.1]],
      ["sphere", "a", [0, 0.32, -0.25], [0.085, 0.08, 0.08], "head"],
      ["sphere", "b", [0, 0.3, -0.31], [0.04, 0.03, 0.03], "head"],
      ...pair("cone", "a", [0.05, 0.41, -0.24], [0.03, 0.06, 0.02], HEAD),
      ...pair("sphere", 0x9fc23a, [0.035, 0.335, -0.32], [0.014, 0.016, 0.01], HEAD),
      ...legs("a", 0.05, 0.14, 0.022, 0.2),
      ["cyl", "a", [0, 0.4, 0.26], [0.018, 0.3, 0.018], "tailup", 0.35],
    ],
  },
  dog: {
    voice: "woof", alarm: "woof", alert: 9, flee: 0, stride: 0.6, graze: 0.7, drop: 0.15, neck: [0, 0.5, -0.26], curious: 1.5,
    coats: [[0xd9a658, 0xf1dfc0], [0x7a5234, 0x5a3a24], [0x2b2826, 0xf4f1ea], [0xf4f1ea, 0x8a5a34], [0x8f8f8c, 0xd6d4cf], [0xc98a4a, 0xf4f1ea]],
    parts: [
      ["sphere", "a", [0, 0.42, 0], [0.14, 0.15, 0.32]],
      ["sphere", "b", [0.06, 0.5, 0.1], [0.1, 0.09, 0.15]],
      ["sphere", "a", [0, 0.62, -0.36], [0.12, 0.115, 0.12], "head"],
      ["sphere", "b", [0, 0.58, -0.48], [0.06, 0.05, 0.08], "head"],
      ["sphere", DARK, [0, 0.6, -0.56], [0.022, 0.02, 0.02], "head"],
      ...pair("sphere", DARK, [0.05, 0.66, -0.45], [0.016, 0.018, 0.012], HEAD),
      ...pair("sphere", "b", [0.11, 0.62, -0.33], [0.035, 0.08, 0.05], HEAD),
      ...legs("a", 0.08, 0.2, 0.035, 0.38),
      ["cyl", "b", [0, 0.64, 0.36], [0.025, 0.26, 0.025], "tailup", 0.6],
    ],
  },

  // ---- wild
  rabbit: {
    voice: null, alarm: null, alert: 10, flee: 5, stride: 0.5, graze: 0.7, drop: 0.05, neck: [0, 0.16, -0.08], hop: 0.12,
    coats: [[0x9a8468, 0xf2ede2], [0x8a8a84, 0xf2f2ee], [0xb89a78, 0xf2ede2], [0xf2efe8, 0xf2efe8], [0x6f5f4c, 0xe6dccb]],
    parts: [
      ["sphere", "a", [0, 0.12, 0.02], [0.085, 0.09, 0.13]],
      ["sphere", "a", [0, 0.21, -0.12], [0.06, 0.06, 0.065], "head"],
      ...pair("sphere", "a", [0.028, 0.32, -0.1], [0.016, 0.075, 0.022], HEAD),
      ["sphere", PINK, [0, 0.2, -0.18], [0.012, 0.01, 0.01], "head"],
      ...pair("sphere", DARK, [0.04, 0.225, -0.15], [0.01, 0.012, 0.01], HEAD),
      ["sphere", "b", [0, 0.13, 0.15], [0.035, 0.035, 0.035]],
      ...pair("cyl", "a", [0.04, 0.045, -0.07], [0.015, 0.09, 0.015], ["leg0", "leg0"]),
      ...pair("sphere", "a", [0.06, 0.03, 0.08], [0.03, 0.03, 0.07], ["leg0", "leg0"]),
    ],
  },
  deer: {
    voice: null, alarm: null, alert: 16, flee: 7, stride: 1.2, graze: 1.4, drop: 0.35, neck: [0, 1.02, -0.38],
    coats: [[0xa9773f, 0xf0e6d2], [0x8f6238, 0xe9dcc4], [0xb88a55, 0xf0e6d2]],
    parts: [
      ["sphere", "a", [0, 0.88, 0], [0.2, 0.22, 0.5]],
      ["sphere", "b", [0, 0.8, 0.05], [0.16, 0.16, 0.4]],
      ["cyl", "a", [0, 1.2, -0.5], [0.085, 0.55, 0.09], "head", -0.5],
      ["sphere", "a", [0, 1.48, -0.72], [0.085, 0.095, 0.16], "head", -0.4],
      ["sphere", DARK, [0, 1.42, -0.87], [0.025, 0.022, 0.02], "head"],
      ...pair("sphere", DARK, [0.07, 1.52, -0.76], [0.016, 0.02, 0.014], HEAD),
      ...pair("sphere", "a", [0.12, 1.56, -0.62], [0.07, 0.03, 0.04], HEAD),
      ...pair("cone", CREAM, [0.05, 1.68, -0.62], [0.018, 0.2, 0.018], HEAD),
      ...legs("a", 0.11, 0.33, 0.035, 0.8),
      ["sphere", "b", [0, 0.95, 0.5], [0.05, 0.06, 0.04], "tail"],
    ],
  },
  squirrel: {
    voice: null, alarm: null, alert: 6, flee: 4, stride: 0.2, graze: 0.6, drop: 0.02, neck: [0, 0.09, -0.04], hop: 0.04,
    coats: [[0xb5562a, 0xf0e2cc], [0x8a8a88, 0xe8e8e4], [0xa04a26, 0xf0e2cc]],
    parts: [
      ["sphere", "a", [0, 0.07, 0], [0.04, 0.045, 0.075]],
      ["sphere", "b", [0, 0.06, -0.02], [0.03, 0.035, 0.05]],
      ["sphere", "a", [0, 0.12, -0.075], [0.035, 0.033, 0.04], "head"],
      ...pair("cone", "a", [0.02, 0.16, -0.07], [0.01, 0.03, 0.01], HEAD),
      ...pair("sphere", DARK, [0.022, 0.125, -0.1], [0.007, 0.008, 0.007], HEAD),
      ["sphere", "a", [0, 0.16, 0.09], [0.04, 0.1, 0.045], "tail"],
      ...pair("cyl", "a", [0.025, 0.025, -0.04], [0.01, 0.05, 0.01], ["leg0", "leg0"]),
      ...pair("cyl", "a", [0.025, 0.025, 0.04], [0.01, 0.05, 0.01], ["leg0", "leg0"]),
    ],
  },

  // ---- local stars
  kangaroo: {
    voice: null, alarm: null, alert: 14, flee: 6, stride: 2.4, graze: 1.2, drop: 0.45, neck: [0, 1.0, -0.18], hop: 0.35,
    coats: [[0xa98562, 0xe6d6bd], [0xb5653a, 0xecd9c0], [0x8f8a84, 0xdedad2]],
    parts: [
      ["sphere", "a", [0, 0.72, 0.08], [0.19, 0.33, 0.24], "", -0.45],
      ["sphere", "b", [0, 0.66, -0.02], [0.14, 0.26, 0.16], "", -0.45],
      ["sphere", "a", [0, 1.22, -0.3], [0.085, 0.1, 0.14], "head", -0.3],
      ["sphere", DARK, [0, 1.19, -0.43], [0.025, 0.022, 0.02], "head"],
      ...pair("sphere", DARK, [0.06, 1.26, -0.36], [0.014, 0.018, 0.012], HEAD),
      ...pair("sphere", "a", [0.06, 1.37, -0.24], [0.028, 0.09, 0.035], HEAD),
      ...pair("cyl", "a", [0.12, 0.86, -0.2], [0.025, 0.24, 0.025], ["", ""], 0.5),
      ...pair("sphere", "a", [0.17, 0.42, 0.12], [0.085, 0.2, 0.15]),
      ...pair("sphere", "a", [0.17, 0.04, -0.02], [0.05, 0.04, 0.2], ["leg0", "leg0"]),
      ["cyl", "a", [0, 0.3, 0.62], [0.07, 0.8, 0.06], "", 1.9],
    ],
  },
  llama: {
    voice: null, alarm: null, alert: 8, flee: 2.5, stride: 1.3, graze: 1.5, drop: 0.4, neck: [0, 1.15, -0.36],
    coats: [[0xf1ebdd, 0xe2d8c4], [0x8a5f3c, 0x6a452a], [0xd9c3a0, 0x8a5f3c], [0x3a322c, 0x2a2420], [0xf1ebdd, 0x8a5f3c]],
    parts: [
      ["sphere", "a", [0, 0.98, 0], [0.25, 0.27, 0.5]],
      ["sphere", "a", [0, 1.12, 0.1], [0.22, 0.2, 0.36]],
      ["cyl", "a", [0, 1.5, -0.42], [0.1, 0.75, 0.11], "head", -0.15],
      ["sphere", "a", [0, 1.9, -0.56], [0.09, 0.1, 0.16], "head", -0.15],
      ["sphere", "b", [0, 1.87, -0.69], [0.055, 0.05, 0.06], "head"],
      ...pair("sphere", DARK, [0.07, 1.94, -0.6], [0.016, 0.02, 0.014], HEAD),
      ...pair("cone", "a", [0.06, 2.04, -0.5], [0.025, 0.11, 0.025], HEAD),
      ...legs("b", 0.13, 0.32, 0.05, 0.84),
      ["sphere", "a", [0, 1.05, 0.5], [0.06, 0.09, 0.05], "tail"],
    ],
  },
  camel: {
    voice: null, alarm: null, alert: 8, flee: 2.5, stride: 2.0, graze: 1.6, drop: 0.7, neck: [0, 1.55, -0.6],
    coats: [[0xc9a56c, 0xa9844f], [0xd9b987, 0xb8935c], [0xb38f5a, 0x8f6f42]],
    parts: [
      ["sphere", "a", [0, 1.5, 0], [0.32, 0.34, 0.72]],
      ["sphere", "a", [0, 1.88, 0.08], [0.22, 0.26, 0.3]],
      ["cyl", "a", [0, 1.85, -0.9], [0.11, 0.85, 0.13], "head", -0.7],
      ["sphere", "a", [0, 2.22, -1.3], [0.11, 0.12, 0.24], "head", -0.25],
      ["sphere", "b", [0, 2.16, -1.5], [0.07, 0.065, 0.07], "head"],
      ...pair("sphere", DARK, [0.09, 2.28, -1.3], [0.018, 0.022, 0.016], HEAD),
      ...pair("sphere", "b", [0.1, 2.34, -1.14], [0.03, 0.04, 0.03], HEAD),
      ...legs("a", 0.18, 0.48, 0.065, 1.3),
      ["cyl", "b", [0, 1.3, 0.75], [0.03, 0.5, 0.03], "tail"],
    ],
  },
  penguin: {
    voice: "bray", alarm: "bray", alert: 5, flee: 2, stride: 0.25, graze: 0.3, drop: 0, neck: [0, 0.42, 0], waddle: 0.14,
    wing: { air: [0, 0], walk: [0.2, 0.15], rate: 0 },
    coats: [[0x25282e, 0xf4f1ea]],
    parts: [
      ["sphere", "a", [0, 0.25, 0], [0.13, 0.22, 0.12]],
      ["sphere", "b", [0, 0.24, -0.04], [0.105, 0.19, 0.09]],
      ["sphere", "a", [0, 0.5, -0.01], [0.085, 0.08, 0.085], "head"],
      ["cone", ORANGE, [0, 0.49, -0.11], [0.022, 0.07, 0.022], "head", AHEAD],
      ...pair("sphere", 0xf4f1ea, [0.04, 0.52, -0.07], [0.014, 0.016, 0.01], HEAD),
      ...pair("sphere", "a", [0.14, 0.27, 0], [0.02, 0.14, 0.05], WINGS),
      ...pair("sphere", ORANGE, [0.05, 0.015, -0.03], [0.04, 0.015, 0.06], ["leg0", "leg1"]),
    ],
  },

  // ---- machines that go round a home of their own
  tractor: {
    voice: "chug", alarm: "toot", alert: 0, flee: 0, stride: 1, graze: 0, drop: 0, neck: [0, 0, 0], yields: 7,
    coats: [[0x3f9a45, GLASS], [0xd94a3a, GLASS], [0x3f7fd0, GLASS], [0xf2c94c, GLASS]],
    parts: [
      ["box", "a", [0, 1.0, -0.55], [0.8, 0.6, 1.5]],
      ["box", "a", [0, 1.5, 0.55], [1.0, 1.2, 1.0]],
      ["box", "b", [0, 1.72, 0.55], [1.04, 0.6, 0.84]],
      ["box", "b", [0, 1.72, 0.55], [0.86, 0.6, 1.04]],
      ["box", TYRE, [0, 2.14, 0.55], [1.1, 0.08, 1.1]],
      ...pair("sphere", TYRE, [0.72, 0.75, 0.6], [0.2, 0.75, 0.75]),
      ...pair("sphere", "a", [0.78, 0.75, 0.6], [0.16, 0.34, 0.34]),
      ...pair("sphere", TYRE, [0.56, 0.4, -1.0], [0.13, 0.4, 0.4]),
      ["cyl", TYRE, [0.25, 1.65, -0.95], [0.05, 0.7, 0.05]],
      ...pair("sphere", CREAM, [0.25, 1.1, -1.31], [0.1, 0.1, 0.04]),
    ],
  },
  boat: {
    voice: null, alarm: null, alert: 0, flee: 0, stride: 1, graze: 0, drop: 0, neck: [0, 0, 0], swim: 0.06,
    coats: [[WOOD, 0x5e3a22], [0x3f7fd0, 0xf4f1ea], [0xd94a3a, 0xf4f1ea], [0xf4f1ea, WOOD], [0x4caf6a, 0xf4f1ea]],
    parts: [
      ["sphere", "a", [0, 0.12, 0], [0.65, 0.32, 1.7]],
      ["sphere", "b", [0, 0.27, 0], [0.52, 0.2, 1.45]],
      ["box", "a", [0, 0.36, 0.1], [1.05, 0.06, 0.26]],
      ["box", "a", [0, 0.36, -0.75], [0.8, 0.06, 0.22]],
      ["box", CREAM, [0, 0.46, 0.2], [3.0, 0.05, 0.09]],
      ...pair("box", CREAM, [1.55, 0.44, 0.2], [0.3, 0.03, 0.2]),
    ],
  },
  sailboat: {
    voice: null, alarm: null, alert: 0, flee: 0, stride: 1, graze: 0, drop: 0, neck: [0, 0, 0], swim: 0.1, heel: 0.1,
    coats: [[0xf4f1ea, 0xf7f3e6], [0x3f7fd0, 0xf7f3e6], [0xd94a3a, 0xf7f3e6], [0x2f3b55, 0xf2c94c], [0xf4f1ea, 0xd94a3a], [0x2f8f8a, 0xf7f3e6]],
    parts: [
      ["sphere", "a", [0, 0.2, 0], [0.95, 0.5, 2.8]],
      ["box", CREAM, [0, 0.58, 0], [1.2, 0.08, 3.6]],
      ["box", "a", [0, 0.82, 0.5], [0.9, 0.4, 1.4]],
      ["cyl", WOOD, [0, 3.4, -0.3], [0.05, 5.6, 0.05]],
      ["cone", "b", [0, 3.4, 0.7], [0.04, 4.8, 0.95]],
      ["cone", "b", [0, 2.9, -1.35], [0.03, 3.8, 0.75]],
      ["box", WOOD, [0, 1.05, 0.7], [0.06, 0.06, 1.9]],
    ],
  },
};

/** Cars, vans and railway carriages, driven by traffic.js. Colour "a" is the paint and "b" the glass. */
// ---------------------------------------------------------------- many more animals
// These are drawn from a few measurements each, by three builders: `beast` for anything on four
// legs, `fowl` for birds that walk or swim, and the rest by hand. `hover` gives the height in
// metres at which an insect flutters, in place of standing on the ground.

/**
 * A four-legged animal. `body` is half its width, height and length; `leg` the length and radius of
 * a leg; `head` half the head's width, height and length; `rise` and `reach` how far the head is
 * above the back and ahead of the chest (a long `rise` grows a neck). `snout` is [colour, width] of
 * a muzzle, `ears` [width, height, colour], `tail` [length, colour, role]. `extra` adds the parts
 * that make it itself, and is told where the body and head came out.
 */
function beast({ body: [bw, bh, bl], leg: [lh, lr], head: [hw, hh, hl], rise = 0, reach = 0, snout = null, ears = [0.5, 0.5, "a"], tail = [0.3, "b", "tail"], eye = 0.14, shins = "a", extra = () => [] }) {
  const cy = lh + bh * 0.25;
  const hy = cy + bh * 0.45 + rise;
  const hz = -(bl * 0.85 + hl * 0.6 + reach);
  const parts = [["sphere", "a", [0, cy, 0], [bw, bh, bl]]];
  if (rise > bh * 1.2) {
    const y0 = cy + bh * 0.5, z0 = -bl * 0.75;
    const dy = hy - y0, dz = hz + hl * 0.3 - z0;
    const thick = Math.min(bw, hw) * 0.8;
    parts.push(["cyl", "a", [0, y0 + dy / 2, z0 + dz / 2], [thick, Math.hypot(dy, dz) * 1.05, thick], "head", Math.atan2(dz, dy)]);
  }
  parts.push(["sphere", "a", [0, hy, hz], [hw, hh, hl], "head"]);
  if (snout) parts.push(["sphere", snout[0], [0, hy - hh * 0.25, hz - hl * 0.8], [hw * snout[1], hh * 0.6, hl * 0.55], "head"]);
  const e = Math.max(0.008, hw * eye);
  parts.push(...pair("sphere", DARK, [hw * 0.62, hy + hh * 0.3, hz - hl * 0.55], [e, e * 1.2, e * 0.8], HEAD));
  if (ears) parts.push(...pair("sphere", ears[2], [hw * 0.95, hy + hh * 0.75, hz + hl * 0.25], [hw * ears[0] * 0.5, hh * ears[1], hl * 0.3], HEAD));
  parts.push(...legs(shins, bw * 0.6, bl * 0.62, lr, lh));
  if (tail) {
    const [len, colour, role] = tail;
    if (role === "tailup") parts.push(["cyl", colour, [0, cy + bh * 0.5 + len * 0.35, bl * 0.95 + len * 0.2], [lr * 0.6, len, lr * 0.6], "tailup", 0.6]);
    else parts.push(["cyl", colour, [0, cy + bh * 0.4 - len / 2, bl * 0.95], [lr * 0.5, len, lr * 0.5], "tail"]);
  }
  return { neck: [0, cy + bh * 0.4, -bl * 0.8], parts: [...parts, ...extra({ cy, hy, hz, bw, bh, bl, hw, hh, hl, lh })] };
}

/**
 * A bird that walks or swims. `body` is half its width, height and length; `legs` [length, radius,
 * colour]; `neck` [length, radius]; `head` the head's radius; `beak` [length, radius, colour].
 */
function fowl({ body: [w, h, l], legs: [ll, lr, lc], neck: [nl, nr], head: hr, beak: [bl, br, bc], neckColour = "a", extra = () => [] }) {
  const cy = ll + h * 0.9;
  const ny = cy + h * 0.5;
  const nz = -l * 0.6;
  const hy = ny + nl + hr * 0.6;
  const hz = nz - hr * 0.2;
  return {
    neck: [0, ny, nz],
    parts: [
      ["sphere", "a", [0, cy, 0], [w, h, l]],
      ["cone", "a", [0, cy + h * 0.3, l * 0.95], [w * 0.5, l * 0.6, h * 0.3], "", 1.0],
      ["cyl", neckColour, [0, ny + nl / 2, nz], [nr, nl * 1.1, nr], "head"],
      ["sphere", neckColour, [0, hy, hz], [hr, hr, hr * 1.1], "head"],
      ["cone", bc, [0, hy - hr * 0.1, hz - hr - bl / 2], [br, bl, br * 0.6], "head", AHEAD],
      ...pair("sphere", DARK, [hr * 0.7, hy + hr * 0.25, hz - hr * 0.55], [hr * 0.18, hr * 0.2, hr * 0.16], HEAD),
      ...pair("sphere", "b", [w * 0.92, cy + h * 0.2, l * 0.1], [w * 0.25, h * 0.6, l * 0.75], WINGS),
      ...pair("cyl", lc, [w * 0.4, ll / 2, 0], [lr, ll, lr], ["leg0", "leg1"]),
      ...extra({ cy, hy, hz }),
    ],
  };
}

const QUIET = { voice: null, alarm: null };
const GREY = 0x8f949a;
const BROWN = 0x7a5234;
const GREEN = 0x4f9a4a;
const BUFF = 0xe9dcc0;
const BLACK = 0x2a2826;
const WHITE = 0xf4f1ea;
const YELLOW = 0xf2c230;

Object.assign(RIGS, {
  // ---- on the farm
  pig: {
    voice: "oink", alarm: "oink", alert: 6, flee: 2, stride: 0.6, graze: 0.8, drop: 0.12, curious: 0,
    coats: [[0xf0b3a8, 0xe59a90], [0xe9a79c, 0x3a3432], [0xd9a08a, 0xc98a78], [0x4a403c, 0xf0b3a8]],
    ...beast({ body: [0.26, 0.26, 0.5], leg: [0.3, 0.06], head: [0.17, 0.17, 0.2], reach: 0.02, snout: ["b", 0.6], ears: [0.7, 0.45, "b"], tail: [0.14, "b", "tailup"] }),
  },
  goat: {
    voice: "baa", alarm: "baa", alert: 8, flee: 2.5, stride: 0.8, graze: 1.0, drop: 0.25,
    coats: [[0xf1ece0, 0xcfc6b4], [0x8a6a4a, 0xf1ece0], [0x3a3432, 0xd9d2c4], [0xc9a777, 0x6f5234]],
    ...beast({ body: [0.17, 0.2, 0.4], leg: [0.42, 0.035], head: [0.09, 0.1, 0.15], rise: 0.14, reach: 0.04, snout: ["b", 0.75], ears: [1.2, 0.3, "a"], tail: [0.12, "a", "tailup"],
      extra: ({ hy, hz, hh, hl }) => [...pair("cone", BUFF, [0.04, hy + hh * 1.5, hz + hl * 0.3], [0.018, 0.18, 0.018], HEAD, 0.4), ["cone", "b", [0, hy - hh * 1.2, hz - hl * 0.5], [0.03, 0.12, 0.02], "head", Math.PI]] }),
  },
  donkey: {
    voice: "bray", alarm: "bray", alert: 9, flee: 2.6, stride: 1.2, graze: 1.2, drop: 0.3,
    coats: [[0x9a9088, 0xe9e2d6], [0x7a6a5a, 0xe9e2d6], [0x5a4f48, 0xd9d0c2]],
    ...beast({ body: [0.26, 0.3, 0.62], leg: [0.66, 0.05], head: [0.12, 0.14, 0.24], rise: 0.42, reach: 0.12, snout: ["b", 0.85], ears: [0.7, 1.9, "a"], tail: [0.45, "a", "tail"] }),
  },
  goose: {
    voice: "honk", alarm: "honk", alert: 8, flee: 0, stride: 0.35, graze: 0.9, drop: 0.2, waddle: 0.12, curious: 1.2,
    wing: { air: [0, 0], walk: [0, 0], startled: [0.6, 0.4], rate: 16 },
    coats: [[0xf4f1ea, 0xe9e4d8], [0xb9b0a2, 0x8a8278], [0xf4f1ea, 0xcfc8ba]],
    ...fowl({ body: [0.15, 0.13, 0.25], legs: [0.16, 0.014, ORANGE], neck: [0.22, 0.035], head: 0.06, beak: [0.09, 0.03, ORANGE] }),
  },

  // ---- small things in gardens, hedges and barns
  mouse: {
    voice: "squeak", alarm: "squeak", alert: 5, flee: 3, stride: 0.1, graze: 0.5, drop: 0.01, hop: 0.01,
    coats: [[0x9a8c7c, PINK], [0xb8a48a, PINK], [0x6f6860, PINK], [0xe9e2d6, PINK]],
    ...beast({ body: [0.035, 0.035, 0.06], leg: [0.02, 0.008], head: [0.028, 0.028, 0.035], snout: [PINK, 0.4], ears: [1.5, 0.9, "b"], tail: [0.1, "b", "tailup"], eye: 0.2 }),
  },
  hedgehog: {
    ...QUIET, alert: 4, flee: 0, stride: 0.15, graze: 0.5, drop: 0.02,
    coats: [[0x6f5a48, BUFF], [0x5a4a3c, 0xd9c7a8], [0x857058, BUFF]],
    ...beast({ body: [0.09, 0.085, 0.13], leg: [0.03, 0.014], head: [0.045, 0.04, 0.06], reach: -0.03, snout: [DARK, 0.3], ears: [0.6, 0.4, "b"], tail: null, shins: "b",
      extra: ({ cy, bw, bh, bl }) => [-0.6, -0.2, 0.2, 0.6].flatMap((z) => [[-0.5, 0.8], [0, 1], [0.5, 0.8]].map(([x, up]) => ["cone", "a", [x * bw, cy + bh * up, z * bl], [0.018, 0.07, 0.018]])) }),
  },
  fox: {
    ...QUIET, alert: 18, flee: 8, stride: 0.7, graze: 0.7, drop: 0.14,
    coats: [[0xd9702a, WHITE], [0xc9622a, 0xf1e6d2], [0xb86a3a, WHITE]],
    ...beast({ body: [0.13, 0.14, 0.34], leg: [0.32, 0.03], head: [0.1, 0.095, 0.12], rise: 0.06, snout: ["b", 0.55], ears: null, tail: null, shins: BLACK,
      extra: ({ cy, hy, hz, bl, hw, hh }) => [...pair("cone", "a", [hw * 0.6, hy + hh * 1.3, hz + 0.03], [0.035, 0.11, 0.03], HEAD), ["sphere", "a", [0, cy + 0.05, bl + 0.2], [0.075, 0.075, 0.2], "tail"], ["sphere", "b", [0, cy + 0.05, bl + 0.38], [0.055, 0.055, 0.08], "tail"]] }),
  },
  frog: {
    voice: "ribbit", alarm: null, alert: 5, flee: 2.5, stride: 0.4, graze: 0, drop: 0, neck: [0, 0.05, -0.04], hop: 0.18,
    coats: [[0x5aa84a, 0xe6e2a8], [0x7ab05a, 0xf0ecc0], [0x4a8a52, 0xd9d8a0], [0x8a9a4a, 0xe6e2a8]],
    parts: [
      ["sphere", "a", [0, 0.055, 0.01], [0.07, 0.05, 0.085]],
      ["sphere", "b", [0, 0.04, -0.01], [0.055, 0.035, 0.07]],
      ["sphere", "a", [0, 0.075, -0.07], [0.055, 0.04, 0.05], "head"],
      ...pair("sphere", "a", [0.035, 0.115, -0.07], [0.022, 0.022, 0.022], HEAD),
      ...pair("sphere", DARK, [0.04, 0.125, -0.085], [0.01, 0.011, 0.01], HEAD),
      ...pair("sphere", "a", [0.075, 0.03, 0.06], [0.03, 0.03, 0.07], ["leg0", "leg0"]),
      ...pair("cyl", "a", [0.05, 0.025, -0.05], [0.012, 0.05, 0.012], ["leg0", "leg0"]),
    ],
  },
  snail: {
    ...QUIET, alert: 0, flee: 0, stride: 0.2, graze: 0, drop: 0, neck: [0, 0.03, -0.06],
    coats: [[0xc98a4a, 0xe9dcc0], [0xa86a3a, 0xe6d2a8], [0xd9b06a, 0xf0e6cc], [0x8a5a34, 0xd9c7a8]],
    parts: [
      ["sphere", "b", [0, 0.022, -0.01], [0.03, 0.022, 0.1]],
      ["sphere", "a", [0, 0.075, 0.025], [0.045, 0.06, 0.06]],
      ["sphere", BROWN, [0.047, 0.075, 0.025], [0.004, 0.032, 0.032]],
      ["sphere", BROWN, [-0.047, 0.075, 0.025], [0.004, 0.032, 0.032]],
      ...pair("cyl", "b", [0.014, 0.065, -0.095], [0.004, 0.05, 0.004], HEAD),
      ...pair("sphere", DARK, [0.014, 0.093, -0.095], [0.007, 0.007, 0.007], HEAD),
    ],
  },
  tortoise: {
    ...QUIET, alert: 4, flee: 0, stride: 0.15, graze: 0.5, drop: 0.03,
    coats: [[0x6f7a44, 0x9a9a62], [0x7a6a44, 0xa89a6a], [0x5f6f4a, 0x8a9a6a]],
    ...beast({ body: [0.17, 0.12, 0.2], leg: [0.07, 0.03], head: [0.045, 0.04, 0.06], rise: -0.07, reach: 0.02, ears: null, tail: null, shins: "b",
      extra: ({ cy, bw, bh, bl }) => [["sphere", "b", [0, cy - bh * 0.5, 0], [bw * 1.05, bh * 0.4, bl * 1.05]], ...[-0.45, 0, 0.45].flatMap((z) => [-0.4, 0.4].map((x) => ["sphere", "b", [x * bw, cy + bh * 0.72, z * bl], [0.05, 0.03, 0.05]]))] }),
  },
  crab: {
    ...QUIET, alert: 5, flee: 2.5, stride: 0.12, graze: 0, drop: 0, neck: [0, 0.05, -0.05],
    coats: [[0xd9502e, 0xf0a070], [0xc9643c, 0xf0c8a0], [0xe07a3a, 0xf4d8b0]],
    parts: [
      ["sphere", "a", [0, 0.06, 0], [0.1, 0.045, 0.075]],
      ...pair("sphere", "a", [0.13, 0.07, -0.08], [0.045, 0.03, 0.035], WINGS),
      ...pair("cyl", "a", [0.035, 0.115, -0.05], [0.006, 0.05, 0.006], HEAD),
      ...pair("sphere", DARK, [0.035, 0.145, -0.05], [0.012, 0.012, 0.012], HEAD),
      ...pair("cyl", "b", [0.1, 0.025, 0.0], [0.008, 0.06, 0.008], ["leg0", "leg1"], 0.5),
      ...pair("cyl", "b", [0.1, 0.025, 0.05], [0.008, 0.06, 0.008], ["leg1", "leg0"], 0.5),
    ],
  },

  // ---- by the water
  beaver: {
    ...QUIET, alert: 8, flee: 3, stride: 0.3, graze: 0.6, drop: 0.05,
    coats: [[0x7a5234, 0x4a3628], [0x6a482e, 0x3f2e22], [0x8a6240, 0x55402e]],
    ...beast({ body: [0.14, 0.14, 0.24], leg: [0.07, 0.03], head: [0.085, 0.08, 0.1], reach: -0.02, snout: [BUFF, 0.5], ears: [0.5, 0.4, "b"], tail: null,
      extra: ({ cy, bl }) => [["box", "b", [0, cy - 0.08, bl + 0.14], [0.14, 0.025, 0.3], "tail"]] }),
  },
  otter: {
    ...QUIET, alert: 7, flee: 3, stride: 0.3, graze: 0, drop: 0, swim: 0.05,
    coats: [[0x6a4a34, 0xd9c7a8], [0x5a4030, 0xcfbc9c]],
    ...beast({ body: [0.09, 0.08, 0.3], leg: [0.03, 0.02], head: [0.065, 0.06, 0.08], rise: 0.05, snout: ["b", 0.7], ears: [0.45, 0.35, "a"], tail: null,
      extra: ({ cy, bl }) => [["sphere", "a", [0, cy, bl + 0.16], [0.045, 0.04, 0.2], "tail"]] }),
  },
  swan: {
    ...QUIET, alert: 7, flee: 2.5, stride: 0.4, graze: 0.9, drop: 0.3, swim: 0.03,
    wing: { air: [0, 0], walk: [0, 0], startled: [0.5, 0.3], rate: 12 },
    coats: [[0xf7f5ef, 0xf1eee6], [0xf7f5ef, 0xe9e6dc], [0x2a2826, 0x3a3836]],
    ...fowl({ body: [0.2, 0.15, 0.36], legs: [0.02, 0.012, DARK], neck: [0.4, 0.04], head: 0.065, beak: [0.1, 0.03, ORANGE] }),
  },
  heron: {
    ...QUIET, alert: 14, flee: 6, stride: 0.6, graze: 1.2, drop: 0.4,
    wing: { air: [0, 0], walk: [0, 0], startled: [0.6, 0.4], rate: 10 },
    coats: [[0xa9b2ba, 0x5f6a78], [0xb9c0c6, 0x6f7a88], [0xf1eee6, 0xcfd4d8]],
    ...fowl({ body: [0.12, 0.13, 0.26], legs: [0.5, 0.012, 0x8a8a5a], neck: [0.42, 0.028], head: 0.055, beak: [0.2, 0.022, YELLOW] }),
  },
  seagull: {
    voice: "squawk", alarm: "squawk", alert: 8, flee: 4, stride: 0.25, graze: 0.9, drop: 0.08, peck: true, takesOff: 5,
    wing: { air: [0.4, 0.6], walk: [0, 0], rate: 12 },
    coats: [[0xf4f1ea, 0x9aa2aa], [0xf4f1ea, 0x7f8890], [0xe9e6dc, 0x5f666e]],
    ...fowl({ body: [0.09, 0.085, 0.17], legs: [0.1, 0.008, YELLOW], neck: [0.05, 0.035], head: 0.05, beak: [0.07, 0.018, YELLOW] }),
  },
  sparrow: {
    voice: "cheep", alarm: null, alert: 5, flee: 3.5, stride: 0.12, graze: 0.9, drop: 0.03, peck: true, hop: 0.03, takesOff: 3.5,
    wing: { air: [1.2, 0.5], walk: [0, 0], rate: 34 },
    coats: [[0x9a7a58, 0x6a5038], [0xa8865e, 0x5a4634], [0x8a7a68, 0x4a4038], [0xc9643c, 0x6a5038]],
    ...fowl({ body: [0.04, 0.04, 0.06], legs: [0.035, 0.004, 0x8a6a5a], neck: [0.01, 0.022], head: 0.03, beak: [0.025, 0.01, 0x4a4038] }),
  },
  flamingo: {
    ...QUIET, alert: 10, flee: 4, stride: 0.7, graze: 1.3, drop: 0.5,
    wing: { air: [0, 0], walk: [0, 0], startled: [0.5, 0.3], rate: 10 },
    coats: [[0xf08aa0, 0xe86a88], [0xf4a0b0, 0xf07a94], [0xf7b8c4, 0xf08aa0]],
    ...fowl({ body: [0.11, 0.12, 0.22], legs: [0.6, 0.01, 0xf07a94], neck: [0.46, 0.024], head: 0.05, beak: [0.09, 0.028, BLACK] }),
  },
  seal: {
    ...QUIET, alert: 9, flee: 0, stride: 0.5, graze: 0, drop: 0, neck: [0, 0.3, -0.42], curious: 0.6,
    coats: [[0x8a8f94, 0xb9bcc0], [0x6f7478, 0xa9acb0], [0x9a8c7c, 0xcfc4b4]],
    parts: [
      ["sphere", "a", [0, 0.24, 0.1], [0.27, 0.23, 0.62]],
      ["sphere", "b", [0, 0.19, 0], [0.22, 0.18, 0.5]],
      ["sphere", "a", [0, 0.48, -0.58], [0.16, 0.16, 0.19], "head"],
      ["sphere", "b", [0, 0.43, -0.74], [0.09, 0.07, 0.07], "head"],
      ["sphere", DARK, [0, 0.46, -0.81], [0.025, 0.02, 0.02], "head"],
      ...pair("sphere", DARK, [0.09, 0.54, -0.7], [0.022, 0.026, 0.02], HEAD),
      ...pair("sphere", "a", [0.27, 0.12, -0.2], [0.16, 0.035, 0.1], WINGS),
      ...pair("sphere", "a", [0.1, 0.1, 0.76], [0.08, 0.03, 0.16], ["tail", "tail"]),
    ],
  },

  // ---- insects, drawn large enough to see
  butterfly: {
    ...QUIET, alert: 0, flee: 1.5, stride: 1, graze: 0, drop: 0, neck: [0, 0, 0], hover: [0.5, 1.5],
    wing: { air: [0.2, 0.9], walk: [0.2, 0.9], rate: 14 },
    coats: [[0xf0a030, DARK], [0x5a8fd8, WHITE], [0xf4f1ea, YELLOW], [0xe86a88, 0x7a4f9a], [0xf2c230, 0xd9502e], [0x7ac0e8, DARK]],
    parts: [
      ["cyl", DARK, [0, 0, 0], [0.012, 0.14, 0.012], "", AHEAD],
      ["sphere", DARK, [0, 0, -0.08], [0.018, 0.018, 0.018]],
      ...pair("sphere", "a", [0.09, 0, -0.03], [0.085, 0.004, 0.07], WINGS),
      ...pair("sphere", "a", [0.07, 0, 0.05], [0.065, 0.004, 0.055], WINGS),
      ...pair("sphere", "b", [0.1, 0.004, -0.03], [0.035, 0.004, 0.03], WINGS),
    ],
  },
  bee: {
    voice: "buzz", alarm: null, alert: 0, flee: 1.2, stride: 1, graze: 0, drop: 0, neck: [0, 0, 0], hover: [0.4, 1.1],
    wing: { air: [0.1, 0.5], walk: [0.1, 0.5], rate: 60 },
    coats: [[YELLOW, DARK]],
    parts: [
      ["sphere", "a", [0, 0, 0.02], [0.04, 0.038, 0.06]],
      ["sphere", "b", [0, 0, 0.0], [0.041, 0.039, 0.012]],
      ["sphere", "b", [0, 0, 0.045], [0.036, 0.034, 0.012]],
      ["sphere", "b", [0, 0.005, -0.06], [0.03, 0.03, 0.03]],
      ...pair("sphere", GLASS, [0.045, 0.035, 0.0], [0.045, 0.004, 0.025], WINGS),
      ["cone", "b", [0, 0, 0.09], [0.008, 0.03, 0.008], "", -AHEAD],
    ],
  },
  dragonfly: {
    ...QUIET, alert: 0, flee: 2, stride: 1, graze: 0, drop: 0, neck: [0, 0, 0], hover: [0.5, 1.6],
    wing: { air: [0, 0.35], walk: [0, 0.35], rate: 50 },
    coats: [[0x3f8fd0, GLASS], [0x4caf6a, GLASS], [0xd9502e, GLASS], [0x2f8f8a, GLASS]],
    parts: [
      ["cyl", "a", [0, 0, 0.1], [0.012, 0.3, 0.012], "", AHEAD],
      ["sphere", "a", [0, 0, -0.06], [0.03, 0.028, 0.045]],
      ...pair("sphere", DARK, [0.02, 0.01, -0.1], [0.018, 0.018, 0.018]),
      ...pair("sphere", "b", [0.13, 0.01, -0.05], [0.12, 0.003, 0.03], WINGS),
      ...pair("sphere", "b", [0.12, 0.01, 0.02], [0.11, 0.003, 0.03], WINGS),
    ],
  },
  ladybird: {
    ...QUIET, alert: 0, flee: 0, stride: 0.08, graze: 0, drop: 0, neck: [0, 0.03, -0.04],
    coats: [[0xd9302a, DARK], [0xe8502e, DARK], [YELLOW, DARK]],
    parts: [
      ["sphere", "a", [0, 0.035, 0.01], [0.05, 0.035, 0.06]],
      ["sphere", "b", [0, 0.03, -0.05], [0.03, 0.025, 0.025], "head"],
      ["box", "b", [0, 0.07, 0.01], [0.004, 0.004, 0.11]],
      ...pair("sphere", "b", [0.025, 0.06, -0.01], [0.012, 0.008, 0.012]),
      ...pair("sphere", "b", [0.028, 0.055, 0.035], [0.011, 0.008, 0.011]),
      ...pair("sphere", WHITE, [0.015, 0.04, -0.07], [0.006, 0.006, 0.004], HEAD),
    ],
  },
  ant: {
    ...QUIET, alert: 0, flee: 0, stride: 0.05, graze: 0, drop: 0, neck: [0, 0.03, -0.04],
    coats: [[0x2a2826, 0x3a3432], [0x7a3a2a, 0x5a2a20]],
    parts: [
      ["sphere", "a", [0, 0.03, 0.05], [0.025, 0.022, 0.035]],
      ["sphere", "a", [0, 0.03, 0.0], [0.016, 0.016, 0.022]],
      ["sphere", "a", [0, 0.035, -0.04], [0.02, 0.018, 0.022], "head"],
      ...pair("cyl", "b", [0.012, 0.06, -0.06], [0.003, 0.04, 0.003], HEAD, -0.6),
      ...pair("cyl", "b", [0.025, 0.015, 0.0], [0.003, 0.035, 0.003], ["leg0", "leg1"], 0.4),
      ...pair("cyl", "b", [0.025, 0.015, 0.03], [0.003, 0.035, 0.003], ["leg1", "leg0"], 0.4),
    ],
  },
  grasshopper: {
    ...QUIET, alert: 4, flee: 2, stride: 0.5, graze: 0, drop: 0, neck: [0, 0.04, -0.06], hop: 0.25,
    coats: [[0x6fae4a, 0x4f8a3a], [0x8ab85a, 0x5f9a44], [0xa89a5a, 0x7a6f44]],
    parts: [
      ["sphere", "a", [0, 0.045, 0.02], [0.022, 0.022, 0.08]],
      ["sphere", "a", [0, 0.055, -0.07], [0.02, 0.024, 0.022], "head"],
      ...pair("sphere", DARK, [0.016, 0.065, -0.08], [0.007, 0.008, 0.007], HEAD),
      ...pair("cyl", "b", [0.01, 0.09, -0.09], [0.002, 0.07, 0.002], HEAD, -0.7),
      ...pair("cyl", "b", [0.035, 0.05, 0.05], [0.006, 0.11, 0.006], ["leg0", "leg0"], 0.9),
      ...pair("cyl", "b", [0.025, 0.02, -0.02], [0.003, 0.04, 0.003], ["leg0", "leg1"]),
    ],
  },

  // ---- big animals that belong to one part of the world
  elephant: {
    voice: "trumpet", alarm: "trumpet", alert: 14, flee: 0, stride: 2.2, graze: 0.3, drop: 0.1,
    coats: [[0x8f8a86, 0xa9a39c], [0x7f7a76, 0x9a948e], [0x9a938a, 0xb9b2a8]],
    ...beast({ body: [0.75, 0.75, 1.15], leg: [1.2, 0.2], head: [0.5, 0.55, 0.5], rise: 0.25, reach: 0.05, ears: null, tail: [0.9, "a", "tail"], eye: 0.07,
      extra: ({ hy, hz, hw, hh, hl }) => [
        ...pair("sphere", "b", [hw * 1.25, hy + hh * 0.05, hz + hl * 0.5], [0.34, 0.5, 0.08], HEAD),
        ["cyl", "a", [0, hy - hh * 1.25, hz - hl * 0.9], [0.13, 1.2, 0.13], "head"],
        ["cyl", "a", [0, hy - hh * 2.4, hz - hl * 0.9], [0.09, 0.35, 0.09], "head"],
        ...pair("cone", BUFF, [hw * 0.45, hy - hh * 0.75, hz - hl * 1.0], [0.05, 0.5, 0.05], HEAD, -1.9),
      ] }),
  },
  giraffe: {
    ...QUIET, alert: 18, flee: 5, stride: 2.0, graze: 0.5, drop: 0.3,
    coats: [[0xe9c27a, 0x9a5a2a], [0xf0cc8a, 0x8a4f26], [0xe3b96a, 0xa8642e]],
    ...beast({ body: [0.36, 0.42, 0.75], leg: [1.75, 0.075], head: [0.14, 0.16, 0.3], rise: 2.1, reach: 0.55, snout: ["a", 0.85], ears: [0.8, 0.4, "a"], tail: [0.8, "b", "tail"], eye: 0.16,
      extra: ({ cy, hy, hz, bw, bh, bl, hh }) => [
        ...pair("cyl", "b", [0.06, hy + hh * 1.4, hz + 0.1], [0.02, 0.16, 0.02], HEAD),
        ...[[-0.6, 0.5, -0.5], [0.7, 0.3, -0.1], [-0.5, 0.2, 0.3], [0.5, 0.6, 0.5], [-0.2, 0.85, 0], [0.3, 0.8, -0.55], [-0.7, 0.3, -0.05], [0.1, 0.9, 0.5]]
          .map(([x, y, z]) => ["sphere", "b", [x * bw * 0.85, cy + bh * y * 0.75, z * bl], [0.12, 0.12, 0.14]]),
      ] }),
  },
  zebra: {
    ...QUIET, alert: 16, flee: 5, stride: 1.5, graze: 1.2, drop: 0.35,
    coats: [[0xf4f1ea, 0x26221f]],
    ...beast({ body: [0.3, 0.34, 0.68], leg: [0.75, 0.055], head: [0.14, 0.16, 0.27], rise: 0.5, reach: 0.15, snout: ["b", 0.85], ears: [0.6, 1.1, "a"], tail: [0.5, "b", "tail"],
      extra: ({ cy, hy, hz, bw, bh, bl, hw, hh, hl }) => [
        ...[-0.7, -0.4, -0.1, 0.2, 0.5, 0.78].map((z) => ["sphere", "b", [0, cy, z * bl], [bw * Math.sqrt(1 - z * z) * 1.03, bh * Math.sqrt(1 - z * z) * 1.03, 0.045]]),
        ["sphere", "b", [0, hy + hh * 0.2, hz + hl * 0.1], [hw * 1.04, hh * 1.0, 0.03], "head"],
        ["box", "b", [0, hy + 0.02, hz + hl + 0.2], [0.05, 0.14, 0.5], "head", 0.9],
      ] }),
  },
  lion: {
    ...QUIET, alert: 16, flee: 0, stride: 1.2, graze: 0.3, drop: 0.1,
    coats: [[0xd9aa5a, 0x8a5a2a], [0xcf9f52, 0x7a4f26], [0xe3b96a, 0xe3b96a]],
    ...beast({ body: [0.3, 0.32, 0.7], leg: [0.55, 0.075], head: [0.2, 0.2, 0.22], rise: 0.22, reach: 0.04, snout: [BUFF, 0.6], ears: [0.5, 0.5, "a"], tail: [0.6, "a", "tail"],
      extra: ({ hy, hz, hl }) => [["sphere", "b", [0, hy - 0.02, hz + hl * 0.75], [0.33, 0.36, 0.26], "head"], ["sphere", DARK, [0, hy - 0.05, hz - hl * 1.3], [0.04, 0.03, 0.03], "head"]] }),
  },
  monkey: {
    ...QUIET, alert: 9, flee: 0, stride: 0.5, graze: 0.4, drop: 0.05, curious: 1.2,
    coats: [[0x8a5a34, BUFF], [0x6a4a34, 0xe3cfa8], [0x9a8c7c, BUFF], [0x4a3a30, 0xd9c7a8]],
    ...beast({ body: [0.13, 0.15, 0.24], leg: [0.3, 0.03], head: [0.12, 0.12, 0.12], rise: 0.12, snout: ["b", 0.7], ears: [0.9, 0.5, "b"], tail: [0.6, "a", "tailup"] }),
  },
  panda: {
    ...QUIET, alert: 9, flee: 0, stride: 0.9, graze: 0.5, drop: 0.12,
    coats: [[0xf4f1ea, 0x26221f]],
    ...beast({ body: [0.38, 0.38, 0.55], leg: [0.4, 0.11], head: [0.26, 0.24, 0.24], rise: 0.05, snout: ["a", 0.5], ears: [0.7, 0.45, "b"], tail: null, shins: "b", eye: 0.08,
      extra: ({ cy, hy, hz, bw, bh, bl, hw, hh, hl }) => [
        ...pair("sphere", "b", [hw * 0.5, hy + hh * 0.2, hz - hl * 0.55], [0.07, 0.085, 0.05], HEAD),
        ["sphere", "b", [0, cy + bh * 0.1, -bl * 0.55], [bw * 1.02, bh * 1.0, 0.16]],
        ["sphere", DARK, [0, hy - hh * 0.2, hz - hl * 1.15], [0.04, 0.03, 0.03], "head"],
      ] }),
  },
  koala: {
    ...QUIET, alert: 5, flee: 0, stride: 0.4, graze: 0.3, drop: 0.03,
    coats: [[0x9a9aa0, 0xf1eee6], [0x8a8a90, 0xe9e6dc]],
    ...beast({ body: [0.16, 0.18, 0.2], leg: [0.14, 0.05], head: [0.14, 0.13, 0.13], rise: 0.05, reach: -0.02, snout: [DARK, 0.3], ears: [1.5, 0.75, "b"], tail: null }),
  },
  bear: {
    ...QUIET, alert: 16, flee: 0, stride: 1.2, graze: 0.6, drop: 0.2,
    coats: [[0x6a4a34, 0x8a6a4a], [0x4a3a30, 0x6a5a4a], [0x8a6240, 0xb08a62], [0x2f2a28, 0x7a5a40]],
    ...beast({ body: [0.42, 0.42, 0.75], leg: [0.55, 0.12], head: [0.24, 0.22, 0.24], rise: 0.05, reach: 0.05, snout: ["b", 0.55], ears: [0.5, 0.4, "a"], tail: null, eye: 0.09,
      extra: ({ hy, hz, hh, hl }) => [["sphere", DARK, [0, hy - hh * 0.2, hz - hl * 1.25], [0.045, 0.035, 0.035], "head"]] }),
  },
  moose: {
    ...QUIET, alert: 18, flee: 5, stride: 1.8, graze: 1.2, drop: 0.4,
    coats: [[0x5a4030, 0x8a6a4a], [0x4a3628, 0x7a5a40]],
    ...beast({ body: [0.38, 0.42, 0.8], leg: [1.15, 0.07], head: [0.17, 0.19, 0.34], rise: 0.25, reach: 0.15, snout: ["b", 1.0], ears: [0.6, 0.6, "a"], tail: [0.15, "a", "tail"], shins: "b",
      extra: ({ hy, hz, hh, hl }) => [...pair("box", BUFF, [0.36, hy + hh * 1.15, hz + hl * 0.4], [0.5, 0.05, 0.28], HEAD), ...pair("cyl", BUFF, [0.12, hy + hh * 0.95, hz + hl * 0.4], [0.03, 0.14, 0.03], HEAD)] }),
  },
  bison: {
    ...QUIET, alert: 14, flee: 3, stride: 1.5, graze: 1.0, drop: 0.3,
    coats: [[0x5a4030, 0x3a2a22], [0x6a4a34, 0x40302a]],
    ...beast({ body: [0.42, 0.45, 0.85], leg: [0.75, 0.085], head: [0.24, 0.26, 0.28], rise: -0.12, reach: 0.02, snout: ["b", 0.75], ears: [0.5, 0.3, "b"], tail: [0.5, "b", "tail"],
      extra: ({ cy, hy, hz, bh, bl, hh, hl }) => [["sphere", "b", [0, cy + bh * 0.55, -bl * 0.45], [0.4, 0.42, 0.5]], ...pair("cone", BUFF, [0.24, hy + hh * 0.75, hz + hl * 0.2], [0.04, 0.2, 0.04], HEAD, 0.5)] }),
  },
  reindeer: {
    ...QUIET, alert: 16, flee: 6, stride: 1.2, graze: 1.3, drop: 0.35,
    coats: [[0x8a7a6a, 0xf1eee6], [0x9a8c7c, 0xf1eee6], [0x6f6258, 0xe9e2d6]],
    ...beast({ body: [0.24, 0.27, 0.55], leg: [0.75, 0.04], head: [0.1, 0.11, 0.2], rise: 0.4, reach: 0.12, snout: ["b", 0.8], ears: [0.6, 0.5, "a"], tail: [0.1, "b", "tail"],
      extra: ({ hy, hz, hh, hl }) => [
        ...pair("cyl", BUFF, [0.1, hy + hh * 2.6, hz + hl * 0.5], [0.02, 0.45, 0.02], HEAD, 0.3),
        ...pair("cyl", BUFF, [0.2, hy + hh * 3.6, hz + hl * 0.2], [0.018, 0.3, 0.018], HEAD, -0.6),
        ...pair("cyl", BUFF, [0.16, hy + hh * 2.4, hz - hl * 0.2], [0.016, 0.22, 0.016], HEAD, -0.9),
      ] }),
  },
  capybara: {
    ...QUIET, alert: 6, flee: 0, stride: 0.6, graze: 0.7, drop: 0.12,
    coats: [[0x9a6a40, 0x7a5234], [0x8a6240, 0x6a482e], [0xa87a4a, 0x8a6240]],
    ...beast({ body: [0.22, 0.23, 0.42], leg: [0.2, 0.05], head: [0.14, 0.14, 0.2], reach: 0.02, snout: ["b", 0.9], ears: [0.35, 0.3, "b"], tail: null }),
  },
  marmot: {
    ...QUIET, alert: 12, flee: 5, stride: 0.3, graze: 0.6, drop: 0.05,
    coats: [[0x9a7a50, 0xd9c7a8], [0x8a6a44, 0xcfb890], [0x7a6a58, 0xcfc4b4]],
    ...beast({ body: [0.11, 0.12, 0.18], leg: [0.06, 0.03], head: [0.075, 0.07, 0.085], rise: 0.03, snout: ["b", 0.6], ears: [0.45, 0.35, "a"], tail: [0.12, "a", "tailup"] }),
  },
});

export const VEHICLES = {
  // One carriage of a train, the same at both ends. A train is four of them in one colour.
  railcar: {
    coats: [0xc0392b, 0x2e7d4f, 0x2f5fa8, 0xe2a52b, 0xe07a2a, 0x6a4c93].map((c) => [c, GLASS]),
    parts: [
      ["box", "a", [0, 2.0, 0], [2.8, 2.5, 13.6]],
      ["box", CREAM, [0, 1.45, 0], [2.84, 0.35, 13.64]],
      ["box", "b", [0, 2.55, 0], [2.86, 0.75, 12.2]],
      ["box", "b", [0, 2.55, 0], [2.2, 0.75, 13.66]],
      ["box", 0x55595e, [0, 3.36, 0], [2.5, 0.25, 13.0]],
      ["box", TYRE, [0, 0.45, -4.6], [2.3, 0.7, 2.8]],
      ["box", TYRE, [0, 0.45, 4.6], [2.3, 0.7, 2.8]],
      ...pair("sphere", CREAM, [0.9, 1.1, -6.82], [0.18, 0.14, 0.05]),
      ...pair("sphere", CREAM, [0.9, 1.1, 6.82], [0.18, 0.14, 0.05]),
    ],
  },
  car: {
    coats: PAINTS,
    parts: [
      ["box", "a", [0, 0.52, 0], [1.7, 0.5, 3.9]],
      ["box", "a", [0, 0.98, 0.25], [1.5, 0.46, 2.0]],
      ["box", "b", [0, 1.0, 0.25], [1.54, 0.3, 1.7]],
      ["box", "b", [0, 1.0, 0.25], [1.3, 0.3, 2.04]],
      ...wheels(0.82, 1.2, 1.2, 0.33),
      ...pair("sphere", CREAM, [0.6, 0.6, -1.95], [0.14, 0.1, 0.05]),
      ...pair("sphere", RED, [0.6, 0.6, 1.95], [0.14, 0.08, 0.05]),
      ["box", 0x55595e, [0, 0.32, -1.97], [1.6, 0.12, 0.08]],
      ["box", 0x55595e, [0, 0.32, 1.97], [1.6, 0.12, 0.08]],
    ],
  },
  van: {
    coats: PAINTS,
    parts: [
      ["box", "a", [0, 1.15, 0.45], [1.85, 1.6, 3.4]],
      ["box", "a", [0, 0.8, -1.75], [1.85, 0.9, 1.0]],
      ["box", "b", [0, 1.45, -1.3], [1.7, 0.55, 0.14]],
      ["box", "b", [0, 1.45, -0.95], [1.89, 0.5, 0.7]],
      ...wheels(0.9, 1.5, 1.4, 0.36),
      ...pair("sphere", CREAM, [0.65, 0.75, -2.25], [0.15, 0.11, 0.05]),
      ...pair("sphere", RED, [0.7, 0.8, 2.15], [0.12, 0.14, 0.05]),
      ["box", 0x55595e, [0, 0.38, -2.27], [1.75, 0.14, 0.08]],
    ],
  },
};
// A taxi is a car in taxi yellow, with a dark band along its doors and a lit sign on its roof.
VEHICLES.taxi = {
  coats: [[0xf5c518, GLASS]],
  parts: [
    ...VEHICLES.car.parts,
    ["box", 0x26221f, [0, 0.6, 0], [1.72, 0.13, 2.7]],
    ["box", CREAM, [0, 1.33, 0.25], [0.62, 0.2, 0.26]],
  ],
};
