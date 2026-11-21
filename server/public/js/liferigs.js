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

/** Cars and vans, driven by traffic.js. Colour "a" is the paint and "b" the glass. */
export const VEHICLES = {
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
