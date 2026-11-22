// The colours and materials people have mapped on buildings and roofs (building:colour, roof:colour,
// building:material, roof:material), turned into the paints the world is drawn in.
//
// A mapped colour can be anything ("#377a62", "lightgrey", "rainbow"). Every building keeps its own
// colour as its own section of a chunk's mesh, so free colours would mean a section per building;
// instead each is moved to the nearest of a fixed set of paints (PAINTS). The set is ours: the tones
// houses and roofs come in, so a building mapped plain "red" comes out brick red and not signal red.

/** The paints a mapped building or roof can come out in, 0xRRGGBB. */
export const PAINTS = [
  0xf2efe6, 0xdad6cc, 0xb9bec4, 0x8e939a, 0x60656c, 0x33363b, // white to charcoal
  0xe6d9b8, 0xf3e6b5, 0xc9a97a, 0xa1866a, 0x8b5a3c, 0x5e4334, // beige, cream, tan, taupe, browns
  0xb8372b, 0x8f3a2e, 0x7a2e2e, 0xc8785a, 0xe6a5a0, // red, brick, maroon, terracotta, pink
  0xe08a3c, 0xe8c84a, // orange, yellow
  0x377a62, 0x5f9a5b, 0x9db88a, 0x2f5d3a, // sea green, green, sage, dark green
  0x4a7fb5, 0x8fb3d1, 0x2e4a6e, 0x5fa5a8, // blue, pale blue (and glass), navy, teal (and old copper)
  0x8a6fa8, 0x9c4f7a, // purple, plum
];

/** Colour names as mappers write them: the web's names, and a few that are not the web's. */
const NAMES: Record<string, number> = {
  white: 0xffffff, offwhite: 0xf5f2e8, ivory: 0xfffff0, whitesmoke: 0xf5f5f5, gainsboro: 0xdcdcdc, cream: 0xf3e6b5,
  black: 0x000000, grey: 0x808080, gray: 0x808080, silver: 0xc0c0c0, lightgrey: 0xd3d3d3, lightgray: 0xd3d3d3,
  darkgrey: 0x606060, darkgray: 0x606060, dimgrey: 0x696969, dimgray: 0x696969, slategrey: 0x708090, slategray: 0x708090,
  lightslategrey: 0x778899, lightslategray: 0x778899, anthracite: 0x33363b, charcoal: 0x33363b,
  beige: 0xe6d9b8, tan: 0xd2b48c, khaki: 0xc3b091, wheat: 0xf5deb3, sand: 0xd9c7a0, burlywood: 0xdeb887,
  brown: 0x8b5a3c, saddlebrown: 0x8b4513, sienna: 0xa0522d, chocolate: 0x7b4a2a, peru: 0xcd853f, sandybrown: 0xf4a460,
  maroon: 0x800000, red: 0xd0302a, darkred: 0x8b0000, firebrick: 0xb22222, crimson: 0xdc143c, brick: 0xa9553f, terracotta: 0xc8785a,
  salmon: 0xfa8072, coral: 0xff7f50, pink: 0xf0b0b8, orange: 0xf09030, darkorange: 0xe07a1a,
  yellow: 0xf0d040, gold: 0xe8c040, lightyellow: 0xf7efb8, olive: 0x7a7a3a,
  green: 0x4f9a4f, darkgreen: 0x1f5a2f, lightgreen: 0x9ad09a, lime: 0x7fc94a, seagreen: 0x2e8b57, teal: 0x2f8a8a, turquoise: 0x40c0b0,
  blue: 0x3f78c0, navy: 0x1f3060, darkblue: 0x1f3080, lightblue: 0xa8cce0, skyblue: 0x87ceeb, steelblue: 0x4682b4, cyan: 0x50c0d0, aqua: 0x50c0d0,
  purple: 0x8a5fa8, violet: 0xa080c8, magenta: 0xc050a0,
};

/** What walls of a material look like, where no colour is mapped. `brick` ones are drawn as brick or stone. */
const WALL_MATERIALS: Record<string, { hex: number; brick?: boolean }> = {
  brick: { hex: 0xa9553f, brick: true }, bricks: { hex: 0xa9553f, brick: true }, clay: { hex: 0xc8785a, brick: true },
  stone: { hex: 0xb5ab98, brick: true }, sandstone: { hex: 0xd2b98b, brick: true }, limestone: { hex: 0xd9d2bd, brick: true },
  granite: { hex: 0x8e8a86, brick: true }, cement_block: { hex: 0xa9a79c, brick: true }, marble: { hex: 0xe9e6df },
  concrete: { hex: 0xb5b2aa }, plaster: { hex: 0xe6dfd0 }, timber_framing: { hex: 0xe6dfd0 }, wood: { hex: 0x9a6b4a },
  glass: { hex: 0x8fb3d1 }, mirror: { hex: 0x8fb3d1 }, metal: { hex: 0x9aa3ab }, steel: { hex: 0x9aa3ab }, metal_plates: { hex: 0x9aa3ab },
  vinyl: { hex: 0xdad6cc }, adobe: { hex: 0xc9a97a }, mud: { hex: 0xc9a97a },
};

const ROOF_MATERIALS: Record<string, number> = {
  roof_tiles: 0xa5523a, tile: 0xa5523a, tiles: 0xa5523a, clay: 0xa5523a, brick: 0xa5523a,
  slate: 0x4f5560, thatch: 0xb99a5b, copper: 0x5fa5a8, metal: 0x8e939a, zinc: 0x8e939a, tin: 0x8e939a, metal_sheet: 0x8e939a,
  concrete: 0xb5b2aa, eternit: 0xa9a79c, tar_paper: 0x4a4a4e, bitumen: 0x4a4a4e, asphalt: 0x4a4a4e, asphalt_shingle: 0x4a4a4e,
  gravel: 0x9a958c, grass: 0x5f9a5b, glass: 0x8fb3d1, acrylic_glass: 0x8fb3d1, wood: 0x8b5a3c, wood_shingles: 0x8b5a3c, stone: 0x8e8a86,
  textile: 0xf2efe6, plastic: 0xdad6cc,
};

/** A mapped colour as 0xRRGGBB: "#rgb", "#rrggbb" or a name. Null for anything else ("rainbow", "yes"). */
export function colourOf(text: string | undefined): number | null {
  if (!text) return null;
  const t = text.trim().toLowerCase().replace(/[\s_-]+/g, "");
  let m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(t);
  if (m && t.startsWith("#")) return parseInt(m[1] + m[1] + m[2] + m[2] + m[3] + m[3], 16);
  m = /^#([0-9a-f]{6})$/.exec(t);
  if (m) return parseInt(m[1], 16);
  return NAMES[t] ?? null;
}

/** The paint nearest a colour, as the eye sees it (red and green count for more where they are strong). */
export function snapPaint(hex: number): number {
  const r = hex >>> 16, g = (hex >>> 8) & 0xff, b = hex & 0xff;
  let best = PAINTS[0];
  let bestD = Infinity;
  for (const p of PAINTS) {
    const pr = p >>> 16, pg = (p >>> 8) & 0xff, pb = p & 0xff;
    const mean = (r + pr) / 2;
    const d = (2 + mean / 256) * (r - pr) ** 2 + 4 * (g - pg) ** 2 + (2 + (255 - mean) / 256) * (b - pb) ** 2;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

const material = (text: string | undefined): string => (text ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_").replace(/^mirrored_glass$/, "mirror");

/** The paint of a building's walls, when its colour or what it is built of is mapped. */
export function wallPaint(tags: Record<string, string>): { colour: number; brick?: boolean } | null {
  const made = WALL_MATERIALS[material(tags["building:material"] ?? tags["building:facade:material"])];
  const hex = colourOf(tags["building:colour"] ?? tags["building:color"] ?? tags["building:facade:colour"]) ?? made?.hex ?? null;
  if (hex === null) return null;
  return { colour: snapPaint(hex), ...(made?.brick ? { brick: true } : {}) };
}

/** The paint of a building's roof, when its colour or what it is covered with is mapped. */
export function roofPaint(tags: Record<string, string>): number | null {
  const hex = colourOf(tags["roof:colour"] ?? tags["roof:color"]) ?? ROOF_MATERIALS[material(tags["roof:material"])] ?? null;
  return hex === null ? null : snapPaint(hex);
}
