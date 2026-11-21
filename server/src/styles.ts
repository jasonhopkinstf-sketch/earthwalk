// How houses look in each part of the world: what their walls and roofs are made of and painted,
// how tall they stand, and what goes round the garden. `houseStyle` picks one from where a chunk is
// (and how high up), in the same rough-box way as `drivesLeft` and `localStars`, so places near a
// border will sometimes get their neighbour's houses. The chunk builder (chunk.ts) does the rest.
//
// Colours are 0xRRGGBB, bright and plain, to suit the cartoon look of both games.

/** The shape of a roof: sloping, flat behind a low parapet, or steep-sided with a flat top. */
export type RoofForm = "pitched" | "flat" | "mansard";

export interface HouseStyle {
  name: string;
  /** Painted, rendered or boarded house walls. */
  paints: number[];
  /** Brick or stone house walls, and how many houses in eight have them. */
  bricks: number[];
  brickShare: number;
  /** Blocks of flats, shops and offices: their paints, and how many in eight are brick or stone instead. */
  big: number[];
  bigBrickShare: number;
  roofs: number[];
  /** Roofs of homes standing apart, of homes in a built-up street, and of blocks in a city centre. */
  roof: RoofForm;
  townRoof: RoofForm;
  cityRoof: RoofForm;
  /** How steep a pitched roof is (1 is the usual), and how far it reaches past the walls, in metres. */
  pitch: number;
  eaves: number;
  /** Of five homes nobody measured, how many are bungalows; the rest have two storeys. */
  bungalows: number;
  /** Storeys of unmeasured buildings in a built-up street, and in a city centre: fewest and most. */
  town: [number, number];
  city: [number, number];
  /** Of five homes, how many have a chimney; and of five city blocks. */
  chimneys: number;
  cityChimneys: number;
  doors: number[];
  /** Of eight front gardens, how many have a hedge, a fence, a low wall. The rest are open. */
  garden: [number, number, number];
}

const DOORS = [0xb5372e, 0x3f6fb0, 0x3f7f4f, 0xe0a82e, 0x7a4f9a, 0x2f8f8a, 0x7a4a2e];
const BLUE_DOORS = [0x2f6fa8, 0x2f8f8a, 0x3f6fb0, 0x3f7f4f, 0x7a4a2e, 0x1f5f9a];

/** Where no style below applies: a bit of everything, as the game had everywhere before. */
export const TEMPERATE: HouseStyle = {
  name: "temperate",
  paints: [0xf6e8c6, 0xf2cc74, 0xbcd6e6, 0xa9d6a4, 0xf3b9a2, 0xefe9dc, 0xe3a857, 0x9dbbe0, 0xdf9a94],
  bricks: [0xc9503c, 0xb5553c, 0xd07a55],
  brickShare: 2,
  big: [0xbcd6e6, 0xd7dde3, 0xe9dfc9, 0xcdd8c4, 0xe6cdbb, 0xc9c4d8],
  bigBrickShare: 0,
  roofs: [0x5d6f8c, 0xc75f3f, 0x4f5560, 0x8a5a44, 0x6f8f5a, 0xb5483a],
  roof: "pitched", townRoof: "pitched", cityRoof: "pitched",
  pitch: 1, eaves: 0.4,
  bungalows: 2, town: [2, 3], city: [4, 5],
  chimneys: 4, cityChimneys: 0,
  doors: DOORS,
  garden: [3, 3, 0],
};

const style = (name: string, changes: Partial<HouseStyle>, from: HouseStyle = TEMPERATE): HouseStyle => ({ ...from, ...changes, name });

// ---- Europe

/** England and Wales: brick, slate and clay tiles, a chimney on nearly every house. */
const ENGLAND = style("england", {
  paints: [0xf1ece0, 0xe8e2d0, 0xd8d2c2, 0xf3e6c4, 0xdfe6ea],
  bricks: [0xb5553c, 0xa8553a, 0xc9a26a, 0x8f4a3a, 0xc0603f],
  brickShare: 6,
  big: [0xf1ece0, 0xe6dfd0, 0xd7dde3, 0xe9dfc9],
  bigBrickShare: 5,
  roofs: [0x5a6170, 0x4f5560, 0x8a5a44, 0xa0543c, 0x6a7080],
  bungalows: 1, town: [2, 3], city: [4, 5],
  chimneys: 5, cityChimneys: 3,
  garden: [4, 2, 2],
});
/** Scotland: grey and honey stone, slate roofs. */
const SCOTLAND = style("scotland", {
  paints: [0xf1ece0, 0xe6e0d2, 0xd9d4c8, 0xf3ecd8],
  bricks: [0xb8b0a2, 0xc9bfae, 0xd9c7a8, 0xa8a39a, 0xc9a98a],
  brickShare: 6,
  big: [0xc9bfae, 0xd9c7a8, 0xb8b0a2, 0xe6e0d2],
  bigBrickShare: 6,
  roofs: [0x5a6170, 0x4f5560, 0x6a7080, 0x454a55],
  pitch: 1.1, town: [2, 4], city: [4, 5],
  garden: [3, 1, 3],
}, ENGLAND);
/** Ireland: rendered houses, white or brightly painted, under slate. */
const IRELAND = style("ireland", {
  paints: [0xf4f1e6, 0xf2cc74, 0xf3b9a2, 0x9dbbe0, 0xa9d6a4, 0xefe9dc, 0xe8a0a8, 0xf0dc9a],
  bricks: [0xb5553c, 0xb8b0a2],
  brickShare: 1,
  big: [0xf4f1e6, 0xf3ecd8, 0xd7dde3, 0xf2dc9a, 0xe6cdbb],
  bigBrickShare: 2,
  garden: [3, 1, 3],
}, ENGLAND);
/** The Netherlands, Flanders and the lower Rhine: dark brick, steep pantile roofs. */
const LOWLANDS = style("lowlands", {
  paints: [0xefe9dc, 0xf4f1e6, 0xe9dfc9, 0xdfe6ea],
  bricks: [0x9a4a35, 0xb5553c, 0x7d4a3a, 0xc98a5a, 0xa8553a, 0xc9603f],
  brickShare: 6,
  big: [0xefe9dc, 0xd7dde3, 0xe9dfc9, 0xcdd8c4],
  bigBrickShare: 5,
  roofs: [0xc75f3f, 0xb5483a, 0x3f444c, 0x4f5560, 0x8a5a44, 0xd0703f],
  pitch: 1.25,
  bungalows: 1, town: [2, 3], city: [3, 4],
  chimneys: 4, cityChimneys: 0,
  garden: [4, 2, 1],
});
/** Denmark: yellow and red brick, white render, red tiles. */
const DENMARK = style("denmark", {
  paints: [0xf4f1e6, 0xf2dc9a, 0xefe9dc, 0xe0b040],
  bricks: [0xd9b56a, 0xb5553c, 0xc9a25a, 0xa8553a],
  brickShare: 5,
  roofs: [0xb5483a, 0xc75f3f, 0x3a3d44, 0x4f5560],
}, LOWLANDS);
/** Northern and central France: pale stone and render, grey slate, mansards in the cities. */
const FRANCE = style("france", {
  paints: [0xefe6d2, 0xe6d9bf, 0xf3ecdd, 0xd9c9a8, 0xf0e2c4, 0xe9e2d6],
  bricks: [0xd9cdb4, 0xcfc3a8, 0xb5553c],
  brickShare: 2,
  big: [0xf0e6d0, 0xeadcc0, 0xf5ecd8, 0xe3d6ba],
  bigBrickShare: 0,
  roofs: [0x66778e, 0x73849c, 0x566070, 0x8a5a44, 0x8192a8],
  townRoof: "pitched", cityRoof: "mansard",
  pitch: 1.15,
  bungalows: 1, town: [2, 3], city: [4, 6],
  chimneys: 4, cityChimneys: 4,
  garden: [3, 1, 3],
});
/** Paris: cream stone, six storeys, grey zinc mansards crowded with chimneys. */
const PARIS = style("paris", {
  paints: [0xf2e6cc, 0xecdfc2, 0xf5ecd8, 0xe6d8b8, 0xf7f0e0, 0xe9dcc0],
  brickShare: 0,
  big: [0xf2e6cc, 0xecdfc2, 0xf5ecd8, 0xe6d8b8],
  roofs: [0x8192a8, 0x73849c, 0x8d9db0, 0x66778e],
  townRoof: "mansard",
  town: [3, 4], city: [5, 7],
}, FRANCE);
/** Germany, Switzerland, Austria and their neighbours: pastel render, steep red and grey tiles. */
const CENTRAL = style("central europe", {
  paints: [0xf3ecd8, 0xf2dc9a, 0xeec5b0, 0xcfe0c0, 0xf5f2ea, 0xdfe2e4, 0xe9c890, 0xc9d8e6],
  bricks: [0xa8553a, 0x9a4a35],
  brickShare: 1,
  big: [0xf3ecd8, 0xf2dc9a, 0xdfe2e4, 0xeec5b0, 0xcfe0c0, 0xe9dfc9],
  roofs: [0xa8472f, 0x8f3f2e, 0x7a4a3a, 0x4a4f57, 0xb5532f],
  pitch: 1.3,
  bungalows: 1, town: [2, 3], city: [4, 5],
  chimneys: 3,
  garden: [4, 3, 0],
});
/** High in the Alps: white render and dark timber under wide, low roofs. */
const ALPINE = style("alpine", {
  paints: [0xf3efe6, 0x8a5a3a, 0x6f4a30, 0xe9dfc9, 0x9a6a44, 0xf5f2ea],
  brickShare: 0,
  big: [0xf3efe6, 0xe9dfc9, 0x9a6a44],
  roofs: [0x5a4a40, 0x6e6a66, 0x4a4f57, 0x7a5a48],
  pitch: 0.75, eaves: 1.1,
  town: [2, 3], city: [3, 4],
  chimneys: 4,
  garden: [1, 4, 0],
}, CENTRAL);
/** Norway, Sweden, Finland, Iceland and the Baltic shore: painted timber, dark steep roofs. */
const NORDIC = style("nordic", {
  paints: [0xa63a2a, 0xe0b040, 0xf4f1e6, 0x9db4c4, 0x5f7f6a, 0xb5483a, 0xf2dc9a, 0x6f8fa8],
  bricks: [0xd9b56a, 0xb5553c],
  brickShare: 1,
  big: [0xf2dc9a, 0xeec5b0, 0xf4f1e6, 0xcfd8dc, 0xe0b890],
  roofs: [0x3a3d44, 0x4f5560, 0x9a3f30, 0x2f3238, 0x5a6170],
  pitch: 1.25, eaves: 0.5,
  bungalows: 2, town: [2, 3], city: [3, 5],
  chimneys: 4,
  garden: [2, 4, 0],
});
/** Italy: warm stucco in ochre, sienna and pink, under low terracotta roofs. */
const ITALY = style("italy", {
  paints: [0xe8c27a, 0xe3a07a, 0xf3e3c0, 0xd98e5a, 0xf2d98c, 0xf5efe0, 0xe6b08a, 0xd9a85a],
  bricks: [0xc98a5a, 0xb5653c],
  brickShare: 1,
  big: [0xe8c27a, 0xf3e3c0, 0xe3a07a, 0xf2d98c, 0xe6c8a0, 0xd9a85a],
  bigBrickShare: 0,
  roofs: [0xc8693c, 0xb9603a, 0xd07a4a, 0xa8563a],
  pitch: 0.6, eaves: 0.6,
  bungalows: 1, town: [2, 3], city: [3, 5],
  chimneys: 2, cityChimneys: 0,
  garden: [2, 1, 4],
});
/** Spain and Portugal: whitewash and ochre, terracotta roofs. */
const IBERIA = style("iberia", {
  paints: [0xf7f3e8, 0xf5efe0, 0xf1ead8, 0xf0c860, 0xe8c27a, 0xf3d9b0, 0xe6a88a, 0xf7f3e8],
  big: [0xf5efe0, 0xf0e2c0, 0xe8c27a, 0xf3d9b0, 0xe6dccc],
  doors: [0x2f6fa8, 0x3f7f4f, 0x7a4a2e, 0xb5372e, 0xe0a82e, 0x2f8f8a],
}, ITALY);
/** The south of France: cream and ochre render, Roman tiles. */
const MIDI = style("south of france", {
  paints: [0xf3e6c8, 0xf0dcae, 0xe8c890, 0xf5efe0, 0xe6b890, 0xf2d98c, 0xe9d8b8],
  big: [0xf3e6c8, 0xf0dcae, 0xe9d8b8, 0xe8c890],
  roofs: [0xc8693c, 0xd07a4a, 0xb9603a, 0xc97850],
  city: [3, 5],
}, ITALY);
/** Greece, the Balkans and Turkey: white and cream walls, red tiles, flat-topped blocks in town. */
const BALKAN = style("balkan", {
  paints: [0xf7f4ec, 0xf1ede2, 0xf3e6c8, 0xf2dc9a, 0xe9f0f4, 0xf0d0b0, 0xf5efe0],
  big: [0xf7f4ec, 0xf1ede2, 0xf3e6c8, 0xdfe6ea, 0xf0d8c0],
  roofs: [0xc8693c, 0xb9603a, 0xb5483a, 0xa8563a],
  cityRoof: "flat",
  town: [2, 3], city: [3, 5],
  chimneys: 3,
  garden: [2, 2, 3],
}, ITALY);
/** The islands of the Aegean: white cubes with blue doors. */
const AEGEAN = style("aegean", {
  paints: [0xf9f7f0, 0xf7f4ec, 0xf4f1e8, 0xf9f7f0, 0xeef3f6],
  brickShare: 0,
  big: [0xf9f7f0, 0xf4f1e8, 0xeef3f6],
  roofs: [0xf4f1e8, 0xe9e6dc, 0xf9f7f0, 0xece4d4],
  roof: "flat", townRoof: "flat", cityRoof: "flat",
  bungalows: 3, town: [2, 2], city: [2, 3],
  chimneys: 0,
  doors: BLUE_DOORS,
  garden: [0, 0, 5],
}, BALKAN);

// ---- Africa and the Middle East

/** North Africa, Arabia and Persia: sand-coloured walls and flat roofs behind parapets. */
const DESERT = style("desert", {
  paints: [0xe6d3a8, 0xdcc391, 0xefe4c8, 0xf5efe0, 0xd9b98a, 0xe0b990, 0xcfae7c, 0xeadbb8],
  bricks: [0xcfae7c, 0xc9a26a],
  brickShare: 1,
  big: [0xefe4c8, 0xe6d3a8, 0xf5efe0, 0xdcc391, 0xcfdbe3],
  bigBrickShare: 0,
  roofs: [0xe9dcc0, 0xd8c9a8, 0xf0e8d6, 0xcbb994],
  roof: "flat", townRoof: "flat", cityRoof: "flat",
  bungalows: 3, town: [2, 3], city: [2, 4],
  chimneys: 0, cityChimneys: 0,
  doors: BLUE_DOORS,
  garden: [0, 0, 5],
});
/** Africa south of the Sahara: earth colours and bright paint under low tin roofs. */
const AFRICA = style("africa", {
  paints: [0xe9d9b8, 0xd9a86a, 0xc98a5a, 0xf2efe6, 0x8fc0d8, 0xa9d6a4, 0xf2cc74, 0xe8a08a],
  bricks: [0xb5653c, 0xa8553a],
  brickShare: 1,
  big: [0xe9d9b8, 0xf2efe6, 0xd7dde3, 0xe6cdbb, 0xcfe0d0],
  bigBrickShare: 0,
  roofs: [0x9aa0a6, 0x8a4a3a, 0xb5483a, 0x4f7f8a, 0x5a7a5f, 0x6e6a66],
  cityRoof: "flat",
  pitch: 0.6, eaves: 0.5,
  bungalows: 4, town: [1, 2], city: [2, 4],
  chimneys: 0,
  garden: [2, 2, 2],
});
/** South Africa: white and face-brick houses, tiled roofs, garden walls. */
const SOUTH_AFRICA = style("south africa", {
  paints: [0xf5f2ea, 0xf3ecd8, 0xefe6cc, 0xe6dccc, 0xf2dc9a],
  bricks: [0xb0603f, 0x9a5038, 0xc98a5a],
  brickShare: 3,
  roofs: [0xb5532f, 0x8a4a3a, 0x5a6170, 0x4a4f57, 0xa8563a],
  pitch: 0.8,
  chimneys: 2,
  garden: [2, 1, 4],
}, AFRICA);

// ---- Asia and the Pacific

/** India and its neighbours: flat concrete roofs and every colour of paint. */
const SOUTH_ASIA = style("south asia", {
  paints: [0xf5efe0, 0xf2d98c, 0xf3b9a2, 0x9fd3d0, 0xa9c8e8, 0xc8e0a8, 0xe8c8e0, 0xe9dcc0],
  bricks: [0xb5553c, 0xa64a35],
  brickShare: 1,
  big: [0xf5efe0, 0xe9dcc0, 0xf2d98c, 0xa9c8e8, 0xf3c8b0, 0xd7dde3],
  bigBrickShare: 0,
  roofs: [0xd9d4c8, 0xc9c2b4, 0xe6e0d2, 0xb9b3a6],
  roof: "flat", townRoof: "flat", cityRoof: "flat",
  bungalows: 2, town: [2, 3], city: [3, 5],
  chimneys: 0, cityChimneys: 0,
  garden: [0, 0, 5],
});
/** The far south of India and Sri Lanka: the same paint under red tiled roofs. */
const SOUTH_INDIA = style("south india", {
  roofs: [0xb5532f, 0xa64a30, 0xc9643c, 0x8a4a3a],
  roof: "pitched", townRoof: "pitched",
  pitch: 0.8, eaves: 0.7,
}, SOUTH_ASIA);
/** High in the Himalaya: whitewashed stone, flat roofs, red doors. */
const HIMALAYA = style("himalaya", {
  paints: [0xf2efe6, 0xe9e2d0, 0xd9c8a0, 0xf2efe6, 0xb85a3a],
  bricks: [0xa8a39a, 0x98938a],
  brickShare: 2,
  roofs: [0xc9bfa8, 0xb9ae98, 0xd9d0bc],
  town: [2, 3], city: [3, 4],
  doors: [0x8f2a22, 0xb5372e, 0xe0a82e, 0x2f6fa8],
}, SOUTH_ASIA);
/** China: white and grey walls, grey tiles, tall blocks of flats. */
const CHINA = style("china", {
  paints: [0xf2efe8, 0xe9e2d0, 0xd8dcd8, 0xe6cfc0, 0xf0e6c8],
  bricks: [0x8a8f92, 0x9a9790, 0xa8553a],
  brickShare: 3,
  big: [0xe6e2d8, 0xd8dde0, 0xe6cfc0, 0xf2efe8, 0xcfd8dc],
  bigBrickShare: 0,
  roofs: [0x4f555c, 0x5f666e, 0x3f444a, 0x6a5a50, 0xb5483a],
  cityRoof: "flat",
  pitch: 0.9, eaves: 0.6,
  bungalows: 2, town: [2, 3], city: [4, 7],
  chimneys: 0, cityChimneys: 0,
  garden: [0, 0, 5],
});
/** Japan: pale walls and dark timber, deep eaves, dark glazed tiles. */
const JAPAN = style("japan", {
  paints: [0xf2efe8, 0xe9e2d0, 0xd8cfc0, 0xcfd2d0, 0xb9a890, 0x8a6a50, 0xe6dcc8],
  brickShare: 0,
  big: [0xf2efe8, 0xe6e2d8, 0xd8dde0, 0xd8cfc0, 0xc9cfd4],
  roofs: [0x3f4650, 0x4a5058, 0x2f3540, 0x3f5f8a, 0x6a4a3a, 0x5a6a5a],
  pitch: 0.8, eaves: 0.65,
  bungalows: 1, town: [2, 2], city: [2, 4],
  garden: [3, 1, 3],
}, CHINA);
/** Korea: as Japan, with roofs in blue, orange and green. */
const KOREA = style("korea", {
  roofs: [0x3f6fa0, 0xc7663f, 0x4f8a6a, 0x4a5058, 0x3f4650],
}, JAPAN);
/** South-east Asia: pale and pastel walls under steep red roofs with deep eaves. */
const SOUTH_EAST_ASIA = style("south-east asia", {
  paints: [0xf5f0e2, 0xf0e2b8, 0xf2d98c, 0xa9d6c8, 0x9dc8e0, 0xf3c0a8, 0xe8c8d8],
  brickShare: 0,
  big: [0xf5f0e2, 0xf0e2b8, 0xd7dde3, 0xa9d6c8, 0xf3c0a8],
  roofs: [0xb5532f, 0x9a4a30, 0xc9643c, 0x7a4a3a, 0x4f7f9a, 0x5a8a6a],
  pitch: 1.25, eaves: 0.7,
  bungalows: 3, town: [2, 3], city: [3, 5],
  garden: [2, 1, 3],
}, CHINA);
/** Australia: brick and weatherboard bungalows, tiled and tin roofs, picket fences. */
const AUSTRALIA = style("australia", {
  paints: [0xf4f1e6, 0xefe6cc, 0xcfdde6, 0xcfe0c8, 0xf0e0a8, 0xd9d4cc, 0xe6cdbb],
  bricks: [0xa8553c, 0xd9c090, 0x8f5a44, 0xc07050],
  brickShare: 4,
  big: [0xefe6cc, 0xd7dde3, 0xe6cdbb, 0xd9d4cc, 0xcfe0c8],
  bigBrickShare: 3,
  roofs: [0xb5532f, 0x7f868c, 0x4a4f57, 0x5a7a5f, 0x9a3f30, 0xa8b0b4],
  cityRoof: "flat",
  pitch: 0.7, eaves: 0.6,
  bungalows: 4, town: [1, 2], city: [2, 4],
  chimneys: 2, cityChimneys: 0,
  garden: [2, 4, 1],
});
/** New Zealand: the same, mostly weatherboard. */
const NEW_ZEALAND = style("new zealand", { brickShare: 1, bigBrickShare: 1 }, AUSTRALIA);

// ---- The Americas

/** The United States and Canada: boarded houses in soft colours, shingle roofs, open lawns. */
const NORTH_AMERICA = style("north america", {
  paints: [0xf2efe6, 0xe9dfc0, 0xc9cfd4, 0xa9c4d8, 0xa9bf9c, 0xf0dc9a, 0xcdb38a, 0x8fa8b8, 0xb0503f],
  bricks: [0xa8503c, 0x8f4a3a, 0xb5653c],
  brickShare: 2,
  big: [0xd9d2c0, 0xc9cfd4, 0xe6dcc8, 0xb9c4cc, 0xe9dfc9],
  bigBrickShare: 4,
  roofs: [0x5a5e66, 0x4a4d54, 0x6e5a4c, 0x7a7f86, 0x5c4a40, 0x4f5a55],
  cityRoof: "flat",
  pitch: 0.85, eaves: 0.5,
  bungalows: 2, town: [2, 3], city: [3, 5],
  chimneys: 2, cityChimneys: 0,
  garden: [1, 2, 0],
});
/** The desert south-west of the United States: adobe, flat roofs, turquoise doors. */
const PUEBLO = style("pueblo", {
  paints: [0xd9b48a, 0xcfa678, 0xe3c8a0, 0xc9966a, 0xe8d8b8, 0xd8a890],
  brickShare: 0,
  big: [0xe3c8a0, 0xd9b48a, 0xe8d8b8, 0xcfa678],
  bigBrickShare: 0,
  roofs: [0xd9c8a8, 0xc9b890, 0xe3d6ba],
  roof: "flat", townRoof: "flat", cityRoof: "flat",
  bungalows: 4, town: [1, 2], city: [2, 3],
  chimneys: 0,
  doors: BLUE_DOORS,
  garden: [0, 0, 4],
}, NORTH_AMERICA);
/** Southern California and Florida: pale stucco under low red tiles. */
const SUNBELT = style("sunbelt", {
  paints: [0xf5efe0, 0xf0e2c0, 0xf3d9b0, 0xe8c8a0, 0xf2cc9a, 0xcfe6e0, 0xf5efe0],
  brickShare: 0,
  bigBrickShare: 0,
  roofs: [0xc8693c, 0xb9603a, 0xd07a4a, 0x7a7f86],
  pitch: 0.6, eaves: 0.6,
  bungalows: 4,
  chimneys: 1,
  garden: [2, 1, 2],
}, NORTH_AMERICA);
/** Mexico and Central America: flat roofs and the brightest paint there is. */
const MEXICO = style("mexico", {
  paints: [0xf2c84a, 0xe98a7a, 0x5fb8b0, 0xe8935a, 0x7aa8d8, 0xf5efe0, 0xd87a9a, 0xa8d08a, 0xc9704a],
  bricks: [0xb5653c],
  brickShare: 0,
  big: [0xf5efe0, 0xf2d98c, 0xe8b090, 0xa9d6c8, 0xd7dde3],
  bigBrickShare: 0,
  roofs: [0xd9d0bc, 0xc9bfa8, 0xe6dfcc, 0xb9ae98],
  roof: "flat", townRoof: "flat", cityRoof: "flat",
  bungalows: 3, town: [1, 2], city: [2, 4],
  chimneys: 0, cityChimneys: 0,
  garden: [0, 0, 5],
});
/** The Caribbean: boarded houses in sweet-shop colours under tin roofs. */
const CARIBBEAN = style("caribbean", {
  paints: [0x6fc8c0, 0xf2a0b0, 0xf5d860, 0xa8e08a, 0x8ab8f0, 0xf5a070, 0xf5f2ea, 0xc8a0e0],
  big: [0xf5f2ea, 0xf5e6a0, 0xa9d6c8, 0xf3c0b0, 0xcfdde6],
  roofs: [0xb5483a, 0xa8b0b4, 0x4f8a7a, 0x8a4a3a, 0x4f6f9a],
  roof: "pitched", townRoof: "pitched", cityRoof: "flat",
  pitch: 0.9, eaves: 0.6,
  bungalows: 4, city: [2, 4],
  garden: [1, 4, 1],
}, MEXICO);
/** Brazil and the tropics of South America: white and bright walls, terracotta, garden walls. */
const TROPICAL_AMERICA = style("tropical america", {
  paints: [0xf5f0e2, 0xf7f3e8, 0xf2d060, 0x8ac0e8, 0xf0a090, 0xa8dca0, 0xf2b870, 0xe6a8c8],
  bricks: [0xb5653c],
  brickShare: 1,
  roofs: [0xc0633c, 0xa8563a, 0xcf7a4a, 0x9aa0a6],
  roof: "pitched", townRoof: "pitched", cityRoof: "flat",
  pitch: 0.7, eaves: 0.6,
  bungalows: 4, town: [1, 2], city: [3, 6],
  garden: [0, 1, 5],
}, MEXICO);
/** High in the Andes: adobe and bare brick, tiles and tin. */
const ANDES = style("andes", {
  paints: [0xb8906a, 0xa67f5a, 0xc9a67c, 0xe6d8c0, 0xd9b88a, 0xf2efe6],
  bricks: [0xb5653c, 0xa8553a],
  brickShare: 3,
  big: [0xe6d8c0, 0xd9b88a, 0xf2efe6, 0xc9a67c],
  bigBrickShare: 3,
  roofs: [0xb5532f, 0x9a4a30, 0x9aa0a6, 0x8a4a3a],
  bungalows: 3, city: [3, 5],
  garden: [0, 0, 4],
}, TROPICAL_AMERICA);
/** Argentina, Uruguay and Chile: pale render, some brick, tiles and zinc, tall city blocks. */
const SOUTHERN_CONE = style("southern cone", {
  paints: [0xf5f0e2, 0xf3ecd8, 0xf2dc9a, 0xeec5b0, 0xdfe2e4, 0xe9dfc9, 0xcfe0d0],
  bricks: [0xb5653c, 0xa8553a],
  brickShare: 2,
  big: [0xf3ecd8, 0xe9dfc9, 0xdfe2e4, 0xeec5b0],
  roofs: [0xc0633c, 0xa8563a, 0x7f868c, 0x5a6170],
  pitch: 0.8,
  bungalows: 3, town: [1, 3], city: [4, 7],
  chimneys: 2,
  garden: [2, 2, 3],
}, TROPICAL_AMERICA);

/** Every style there is. */
export const STYLES: HouseStyle[] = [
  TEMPERATE, ENGLAND, SCOTLAND, IRELAND, LOWLANDS, DENMARK, FRANCE, PARIS, CENTRAL, ALPINE, NORDIC, ITALY, IBERIA, MIDI, BALKAN, AEGEAN,
  DESERT, AFRICA, SOUTH_AFRICA, SOUTH_ASIA, SOUTH_INDIA, HIMALAYA, CHINA, JAPAN, KOREA, SOUTH_EAST_ASIA, AUSTRALIA, NEW_ZEALAND,
  NORTH_AMERICA, PUEBLO, SUNBELT, MEXICO, CARIBBEAN, TROPICAL_AMERICA, ANDES, SOUTHERN_CONE,
];

/**
 * The style of houses at a place. `alt` is the height of the ground there in metres, for the
 * mountain styles. Earlier checks win where boxes overlap.
 */
export function houseStyle(lat: number, lon: number, alt = 0): HouseStyle {
  const box = (s: number, w: number, n: number, e: number): boolean => lat >= s && lat <= n && lon >= w && lon <= e;

  // Europe, smallest places first.
  if (box(48.76, 2.2, 48.95, 2.48)) return PARIS;
  if (box(43.9, 5.5, 47.9, 15.5) && alt > 900) return ALPINE;
  if (box(35.8, 24.3, 38.0, 27.3)) return AEGEAN;
  if (box(51.3, -10.7, 55.5, -5.3)) return IRELAND;
  if (box(55.0, -8, 61, -0.7)) return SCOTLAND;
  if (box(49.9, -5.8, 55.0, 1.8) && !(lat < 51.2 && lon > 1.45)) return ENGLAND;
  if (box(54.5, 8, 57.8, 12.8)) return DENMARK;
  if (box(55.1, 4.5, 71.5, 30) || box(63, -25, 67, -13)) return NORDIC;
  if (box(50.3, 2.5, 53.7, 7.25)) return LOWLANDS;
  if (box(35.9, -9.6, 43.9, -1.7) || (box(35.9, -1.7, 42.5, 4.4) && !(lon > -1.5 && lat < 37.4))) return IBERIA;
  if (box(42.3, -1.8, 44.6, 7.7)) return MIDI;
  if ((box(36.5, 6.6, 44.6, 18.6) && !box(36.5, 6.6, 37.6, 11.5)) || box(44.6, 6.6, 46.0, 13.8)) return ITALY;
  if (box(44.6, -4.9, 51.1, 7.0)) return FRANCE;
  if (box(34.5, 18.6, 45.8, 28.5) || box(34.5, 32.2, 35.8, 34.7) || box(36.0, 28.5, 42, 36) || box(37.0, 36, 42, 44.8)) return BALKAN;
  if (box(45.8, 7.0, 55.1, 24.2)) return CENTRAL;

  // The dry belt from Morocco to Afghanistan.
  if (box(12, -17.5, 37.6, 63.5) || box(35.9, 44.8, 39.8, 63.5) || box(29.5, 60, 38.5, 70)) return DESERT;
  if (box(-35, 16, -22, 33)) return SOUTH_AFRICA;
  if (box(-35, -18, 12, 52)) return AFRICA;

  // Asia and the Pacific.
  if (box(26.5, 73, 40, 104) && alt > 2600) return HIMALAYA;
  if (box(5.5, 63.5, 35.5, 92.5)) return lat < 13 ? SOUTH_INDIA : SOUTH_ASIA;
  if (box(33, 124.5, 38.8, 129.6)) return KOREA;
  if (box(30, 129, 46, 146) || box(24, 123, 30, 132)) return JAPAN;
  if (box(-11, 92.5, 22.5, 108) || box(-11, 108, 20, 156)) return SOUTH_EAST_ASIA;
  if (box(18, 73, 42, 135) || box(42, 115, 53.5, 131)) return CHINA;
  if (box(-47.5, 166, -34, 179.9)) return NEW_ZEALAND;
  if (box(-44, 112, -10, 154)) return AUSTRALIA;

  // The Americas.
  if (box(10, -85, 27.5, -59) && !(lat > 24.3 && lon < -79.8)) return CARIBBEAN;
  const mexicanSide = lon < -114.7 ? lat < 32.55 : lon < -106.5 ? lat < 31.6 : lon < -97.3 ? lat < 31.8 - (lon + 106.5) * 0.65 : lat < 25.9;
  if ((box(14, -118, 32.72, -86.5) && mexicanSide) || box(7, -93, 18.5, -77)) return MEXICO;
  if (box(31.2, -115, 37.2, -103)) return PUEBLO;
  if (box(32.5, -121, 35.2, -115) || box(24.3, -83, 28.5, -79.8)) return SUNBELT;
  if (box(24.3, -168, 72, -52) || box(18.5, -161, 22.5, -154)) return NORTH_AMERICA;
  if (box(-56, -82, 13, -34)) return alt > 2400 ? ANDES : lat < -30 ? SOUTHERN_CONE : TROPICAL_AMERICA;

  return TEMPERATE;
}
