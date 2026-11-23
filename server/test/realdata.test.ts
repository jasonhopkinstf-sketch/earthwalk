// The other sources of real data beside OpenStreetMap: Overture's buildings and places (overture.ts,
// read out of PMTiles archives: pmtiles.ts), and the ground cover and tree heights from satellite maps
// (cover.ts, read out of GeoTIFFs: geotiff.ts). Nothing here touches the network: the archives and the
// pictures are made up in memory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateSync, gzipSync } from "node:zlib";
import { groundClasses, groundClassId, placeTrees } from "../src/chunk.ts";
import { canopyFiles, COVER, COVER_N, coverFile, decodeCover, downloadCover, encodeCover, kindAt, smoothKinds, TALL_N, TALL_UNKNOWN, tallAt, type Cover } from "../src/cover.ts";
import { Elevation, GRID } from "../src/elevation.ts";
import { xToLon, yToLat } from "../src/geo.ts";
import { readTiffIndex, readWindow, unLzw } from "../src/geotiff.ts";
import { Late } from "../src/late.ts";
import { loadFeatures, type Building, type Features, type OsmJson, type Pt } from "../src/osm.ts";
import { addOverture, cutToBlock, downloadBlock, idOf, latestRelease, placeKind, placeName, trimBuildings, trimPlaces, UNITS, type OvertureBlock } from "../src/overture.ts";
import { decodeMvt, PmArchive, ringArea, tileId, type RangeReader } from "../src/pmtiles.ts";

const CX = 33185, CY = 22545; // a chunk in Paris
const BX = CX >> 2, BY = CY >> 2, DX = CX >> 1, DY = CY >> 1;
/** World coordinates to a block's own units, and a ring of them flattened as it is kept. */
const U = (wx: number, wy: number): [number, number] => [Math.round((wx - BX * 4) * 1024), Math.round((wy - BY * 4) * 1024)];
const flat = (ring: Pt[]): number[] => ring.flatMap(([x, y]) => U(x, y));
const square = (x: number, y: number, size: number): Pt[] => [[x, y], [x + size, y], [x + size, y + size], [x, y + size]];

// ---------------------------------------------------------------- making archives and tiles up

const varint = (n: number): number[] => { const out: number[] = []; while (n >= 128) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); return out; };
const bytes = (no: number, data: number[]): number[] => [...varint(no * 8 + 2), ...varint(data.length), ...data];
const str = (no: number, s: string): number[] => bytes(no, [...Buffer.from(s, "utf8")]);
const zz = (n: number): number => (n < 0 ? -2 * n - 1 : 2 * n);

interface Made { type: number; props: Record<string, string | number | boolean>; rings: [number, number][][] }
/** A Mapbox vector tile with the layers given. */
function mvt(layers: { name: string; features: Made[] }[]): Buffer {
  const out: number[] = [];
  for (const layer of layers) {
    const keys: string[] = [];
    const values: (string | number | boolean)[] = [];
    const body: number[] = [...str(1, layer.name)];
    for (const f of layer.features) {
      const tags: number[] = [];
      for (const [k, v] of Object.entries(f.props)) {
        if (!keys.includes(k)) keys.push(k);
        let at = values.findIndex((o) => o === v && typeof o === typeof v);
        if (at < 0) { values.push(v); at = values.length - 1; }
        tags.push(...varint(keys.indexOf(k)), ...varint(at));
      }
      const geometry: number[] = [];
      let x = 0, y = 0;
      for (const ring of f.rings) {
        geometry.push(...varint((1 << 3) | 1), ...varint(zz(ring[0][0] - x)), ...varint(zz(ring[0][1] - y)));
        [x, y] = ring[0];
        if (ring.length > 1) {
          geometry.push(...varint(((ring.length - 1) << 3) | 2));
          for (const p of ring.slice(1)) { geometry.push(...varint(zz(p[0] - x)), ...varint(zz(p[1] - y))); [x, y] = p; }
        }
        if (f.type === 3) geometry.push(...varint((1 << 3) | 7));
      }
      body.push(...bytes(2, [...bytes(2, tags), ...varint(3 * 8), f.type, ...bytes(4, geometry)]));
    }
    for (const k of keys) body.push(...str(3, k));
    for (const v of values) {
      const d = Buffer.alloc(8);
      if (typeof v === "number") d.writeDoubleLE(v);
      body.push(...bytes(4, typeof v === "string" ? str(1, v) : typeof v === "number" ? [3 * 8 + 1, ...d] : [7 * 8, v ? 1 : 0]));
    }
    body.push(...varint(5 * 8), ...varint(4096));
    out.push(...bytes(3, body));
  }
  return Buffer.from(out);
}

/** A PMTiles archive of version 3 holding the tiles given; with `leaf`, they are reached through a leaf directory. */
function pmtiles(tiles: { z: number; x: number; y: number; data: Buffer }[], leaf = false): Buffer {
  const sorted = tiles.map((t) => ({ id: tileId(t.z, t.x, t.y), packed: gzipSync(t.data) })).sort((a, b) => a.id - b.id);
  const directory = (entries: { id: number; run: number; length: number; offset: number }[]): Buffer => {
    const out: number[] = [...varint(entries.length)];
    let last = 0;
    for (const e of entries) { out.push(...varint(e.id - last)); last = e.id; }
    for (const e of entries) out.push(...varint(e.run));
    for (const e of entries) out.push(...varint(e.length));
    for (const e of entries) out.push(...varint(e.offset + 1));
    return gzipSync(Buffer.from(out));
  };
  let offset = 0;
  const entries = sorted.map((t) => { const e = { id: t.id, run: 1, length: t.packed.length, offset }; offset += t.packed.length; return e; });
  const leafDir = leaf ? directory(entries) : Buffer.alloc(0);
  const root = leaf ? directory([{ id: entries[0].id, run: 0, length: leafDir.length, offset: 0 }]) : directory(entries);
  const header = Buffer.alloc(127);
  header.write("PMTiles", 0, "latin1");
  header[7] = 3;
  const put = (at: number, v: number): void => { header.writeUInt32LE(v % 2 ** 32, at); header.writeUInt32LE(Math.floor(v / 2 ** 32), at + 4); };
  put(8, 127); put(16, root.length);
  put(24, 127 + root.length); put(32, 0);
  put(40, 127 + root.length); put(48, leafDir.length);
  put(56, 127 + root.length + leafDir.length); put(64, offset);
  header[96] = 1; header[97] = 2; header[98] = 2; header[99] = 1;
  header[100] = Math.min(...tiles.map((t) => t.z)); header[101] = Math.max(...tiles.map((t) => t.z));
  return Buffer.concat([header, root, leafDir, ...sorted.map((t) => t.packed)]);
}

/** Reads ranges of a buffer as if it lay on a server, counting the reads. */
function ranges(file: Buffer): { read: RangeReader; reads: number[] } {
  const reads: number[] = [];
  return { reads, read: async (offset, length) => { reads.push(length); return file.subarray(offset, offset + length); } };
}

// ---------------------------------------------------------------- PMTiles and vector tiles

test("a tile's number in an archive follows the format's curve", () => {
  assert.equal(tileId(0, 0, 0), 0);
  assert.deepEqual([tileId(1, 0, 0), tileId(1, 0, 1), tileId(1, 1, 1), tileId(1, 1, 0)], [1, 2, 3, 4]);
  assert.equal(tileId(2, 0, 0), 5);
  assert.equal(tileId(14, 16145, 9997) > 4 ** 13, true);
});

test("one tile is read out of an archive with a few small reads, through a leaf directory too", async () => {
  const a = Buffer.from("the first tile"), b = Buffer.from("the second tile, a little longer");
  for (const leaf of [false, true]) {
    const { read, reads } = ranges(pmtiles([{ z: 14, x: 100, y: 200, data: a }, { z: 14, x: 9000, y: 3000, data: b }], leaf));
    const archive = new PmArchive(read);
    assert.equal(await archive.maxZoom(), 14);
    assert.deepEqual(await archive.tile(14, 9000, 3000), b);
    assert.deepEqual(await archive.tile(14, 100, 200), a);
    assert.equal(await archive.tile(14, 101, 200), null, "nothing there");
    assert.equal(await archive.tile(15, 200, 400), null, "deeper than the archive goes");
    // The start of the archive once, a leaf directory once at most, and each tile.
    assert.equal(reads.length, leaf ? 4 : 3);
    assert.equal(archive.spent.requests, reads.length);
  }
});

test("a vector tile's features are unpacked only as they are asked for", () => {
  const tile = mvt([
    { name: "building", features: [{ type: 3, props: { height: 12.5, class: "house", is_underground: false }, rings: [[[10, 10], [50, 10], [50, 40], [10, 40]], [[20, 20], [20, 30], [30, 30], [30, 20]]] }] },
    { name: "place", features: [{ type: 1, props: { "@name": "Café Été", confidence: 0.9 }, rings: [[[-5, 4100]]] }] },
  ]);
  const [buildings, places] = decodeMvt(tile);
  assert.equal(buildings.name, "building");
  const f = buildings.features[0];
  assert.equal(buildings.prop(f, "height"), 12.5);
  assert.equal(buildings.prop(f, "class"), "house");
  assert.equal(buildings.prop(f, "is_underground"), false);
  assert.equal(buildings.prop(f, "nothing"), undefined);
  const rings = buildings.rings(f);
  assert.deepEqual(rings[0], [[10, 10], [50, 10], [50, 40], [10, 40]]);
  assert.ok(ringArea(rings[0]) > 0 && ringArea(rings[1]) < 0, "an outline, then its hole");
  assert.deepEqual(places.props(places.features[0]), { "@name": "Café Été", confidence: 0.9 });
  assert.deepEqual(places.rings(places.features[0]), [[[-5, 4100]]]);
  assert.deepEqual(decodeMvt(tile, (name) => name === "place").map((l) => l.name), ["place"]);
});

// ---------------------------------------------------------------- Overture: what is kept of a block

const osmSource = (id: string): string => JSON.stringify([{ dataset: "OpenStreetMap", record_id: `${id}@3`, license: "ODbL-1.0" }]);

test("of Overture's buildings only what the map lacks is kept", () => {
  const tile = mvt([{ name: "building", features: [
    // From OpenStreetMap, and knowing nothing more: not kept.
    { type: 3, props: { id: "aaaa0000-0000", "@geometry_source": "OpenStreetMap", sources: osmSource("w11"), is_underground: false }, rings: [square(100, 100, 40) as [number, number][]] },
    // From OpenStreetMap, with a height: kept as a note on that way, without its outline.
    { type: 3, props: { id: "bbbb0000-0000", "@geometry_source": "OpenStreetMap", sources: osmSource("w12"), height: 28, roof_shape: "gabled", is_underground: false }, rings: [square(200, 100, 40) as [number, number][]] },
    // Somebody else's outline: kept whole, with what is known of it.
    { type: 3, props: { id: "0bf9d6b8-a4ac-4255", "@geometry_source": "Esri Community Maps", num_floors: 3, class: "apartments", "@name": "Harbour Flats", is_underground: false }, rings: [square(300, 100, 40) as [number, number][], [[310, 110], [310, 125], [325, 125], [325, 110]]] },
    // One that the tile's edge cut short (its border here is 80 wide): cut to the block itself.
    { type: 3, props: { id: "cccc0000-0000", "@geometry_source": "Microsoft ML Buildings", is_underground: false }, rings: [[[-80, 500], [60, 500], [60, 560], [-80, 560]]] },
    // One that only pokes over the edge: left whole (the block its middle is in draws it).
    { type: 3, props: { id: "dddd0000-0000", "@geometry_source": "Microsoft ML Buildings", is_underground: false }, rings: [[[-20, 700], [60, 700], [60, 760], [-20, 760]]] },
    // A set that is left out, and a cellar.
    { type: 3, props: { id: "eeee0000-0000", "@geometry_source": "Google Open Buildings", is_underground: false }, rings: [square(900, 900, 40) as [number, number][]] },
    { type: 3, props: { id: "ffff0000-0000", "@geometry_source": "Esri Community Maps", is_underground: true }, rings: [square(1200, 900, 40) as [number, number][]] },
  ] }]);
  const kept = trimBuildings(tile, ["Google Open Buildings"]);
  assert.equal(kept.length, 4);
  assert.deepEqual(kept[0], { osm: "w12", t: { height: "28", "roof:shape": "gabled" } });
  assert.equal(kept[1].s, "Esri Community Maps");
  assert.equal(kept[1].id, idOf("0bf9d6b8-a4ac-4255"));
  assert.deepEqual(kept[1].r, [300, 100, 340, 100, 340, 140, 300, 140]);
  assert.equal(kept[1].holes?.length, 1);
  assert.deepEqual(kept[1].t, { "building:levels": "3", building: "apartments", name: "Harbour Flats" });
  assert.deepEqual(kept[2].r, [0, 500, 60, 500, 60, 560, 0, 560], "cut along the block's edge");
  assert.deepEqual(kept[3].r, [-20, 700, 60, 700, 60, 760, -20, 760]);
  // With nothing left out, the other set is kept too.
  assert.equal(trimBuildings(tile, []).length, 5);
  // Ids are far above OpenStreetMap's, whole numbers, and the same each time.
  assert.ok(Number.isSafeInteger(kept[1].id) && kept[1].id! > 2 ** 44);
  assert.notEqual(idOf("0bf9d6b8-a4ac", 0), idOf("0bf9d6b8-a4ac", 1));
});

test("cutting an outline to the block keeps what is inside it", () => {
  assert.deepEqual(cutToBlock([[-50, 10], [50, 10], [50, 60], [-50, 60]]), [[0, 10], [50, 10], [50, 60], [0, 60]]);
  assert.deepEqual(cutToBlock([[-50, -50], [-10, -50], [-10, -10], [-50, -10]]), []);
  assert.equal(cutToBlock([[UNITS - 10, 10], [UNITS + 70, 10], [UNITS + 70, 90], [UNITS - 10, 90]]).every(([x]) => x <= UNITS), true);
});

test("only places open to anybody get a sign, and nothing a family game would not write up", () => {
  assert.equal(placeKind(["food_and_drink", "casual_eatery", "cafe"], "cafe", "cafe"), "amenity=cafe");
  assert.equal(placeKind(["food_and_drink", "restaurant"], "thai_restaurant", "restaurant"), "amenity=restaurant");
  assert.equal(placeKind(["shopping", "food_and_beverage_store"], "bakery", "food_and_beverage_store"), "shop=bakery");
  assert.equal(placeKind(["shopping"], "book_store", "books_music_and_video_store"), "shop=book");
  assert.equal(placeKind(["cultural_and_historic"], "mosque", "muslim_place_of_worship"), "building=mosque");
  assert.equal(placeKind(["cultural_and_historic"], "church_cathedral", "christian_place_of_worship"), "amenity=place_of_worship");
  assert.equal(placeKind(["cultural_and_historic"], "buddhist_temple", "buddhist_place_of_worship"), "building=temple");
  assert.equal(placeKind(["education"], "elementary_school", "elementary_school"), "amenity=school");
  assert.equal(placeKind(["travel_and_transportation"], "gas_station", "gas_station"), "amenity=fuel");
  assert.equal(placeKind(["lodging"], "hotel", "hotel"), "tourism=hotel");
  // Offices, agents, and people who work from home: no sign.
  assert.equal(placeKind(["services_and_business"], "real_estate_agent", "real_estate_service"), null);
  assert.equal(placeKind(["health_care"], "dentist", "dental_clinic"), null);
  assert.equal(placeKind(["lodging"], "private_lodging", "private_lodging"), null);
  // Not for a family game.
  assert.equal(placeKind(["shopping", "specialty_store"], "adult_store", "specialty_store"), null);
  assert.equal(placeKind(["shopping"], "liquor_store", "food_and_beverage_store"), null);
  assert.equal(placeKind(["arts_and_entertainment"], "casino", "casino"), null);
  assert.equal(placeKind(["food_and_drink"], "juice_bar", "non_alcoholic_beverage_venue"), "amenity=cafe");
  assert.equal(placeName("  Bread &  Honey "), "Bread & Honey");
  assert.equal(placeName("www.cheapstuff.com"), null);
  assert.equal(placeName("XXX Adult Emporium"), null);
  assert.equal(placeName("12345"), null);
  assert.equal(placeName(undefined), null);
});

test("of Overture's places only the sure, open, named ones in the block are kept", () => {
  const taxonomy = (primary: string, ...hierarchy: string[]): string => JSON.stringify({ primary, hierarchy });
  const tile = mvt([{ name: "place", features: [
    { type: 1, props: { id: "11110000-0000", "@name": "Kettle & Crumb", confidence: 0.91, taxonomy: taxonomy("cafe", "food_and_drink", "casual_eatery", "cafe"), basic_category: "cafe" }, rings: [[[100, 200]]] },
    { type: 1, props: { id: "22220000-0000", "@name": "Maybe A Shop", confidence: 0.3, taxonomy: taxonomy("toy_store", "shopping"), basic_category: "toys_and_games_store" }, rings: [[[110, 200]]] },
    { type: 1, props: { id: "33330000-0000", "@name": "Shut Bakery", confidence: 0.9, operating_status: "permanently_closed", taxonomy: taxonomy("bakery", "shopping"), basic_category: "food_and_beverage_store" }, rings: [[[120, 200]]] },
    { type: 1, props: { id: "44440000-0000", "@name": "Jo Bloggs Realty", confidence: 0.95, taxonomy: taxonomy("real_estate_agent", "services_and_business"), basic_category: "real_estate_service" }, rings: [[[130, 200]]] },
    { type: 1, props: { id: "55550000-0000", "@name": "Next Door Toys", confidence: 0.95, taxonomy: taxonomy("toy_store", "shopping"), basic_category: "toys_and_games_store" }, rings: [[[-10, 200]]] },
  ] }]);
  const kept = trimPlaces(tile);
  assert.deepEqual(kept, [{ id: idOf("11110000-0000"), x: 100, y: 200, n: "Kettle & Crumb", k: "amenity=cafe", c: 91 }]);
});

test("the newest release is looked up, kept half a day, and survives a catalogue that is down", async () => {
  let now = 1e12, asked = 0, answer: unknown = { latest: "2026-11-18.0" };
  const get = async (): Promise<unknown> => { asked++; if (answer instanceof Error) throw answer; return answer; };
  assert.equal(await latestRelease(() => now, get), "2026-11-18.0");
  assert.equal(await latestRelease(() => now, get), "2026-11-18.0");
  assert.equal(asked, 1);
  now += 13 * 3600_000;
  answer = new Error("down");
  assert.equal(await latestRelease(() => now, get), "2026-11-18.0", "the one known is used while the catalogue is down");
  answer = { latest: "2026-12-16.0" };
  assert.equal(await latestRelease(() => now, get), "2026-12-16.0");
});

test("a block is downloaded from the newest release, and from a shallower archive when that is all there is", async () => {
  const buildings = mvt([{ name: "building", features: [{ type: 3, props: { id: "0bf9d6b8-0000", "@geometry_source": "Esri Community Maps", is_underground: false }, rings: [square(1000, 1000, 40) as [number, number][]] }] }]);
  const asked: string[] = [];
  const block = await downloadBlock(BX, BY, async (release, theme, z, x, y) => { asked.push(`${release}/${theme}/${z}/${x}/${y}`); return { tile: theme === "buildings" ? buildings : null, maxZoom: 14 }; }, async () => "2026-11-18.0");
  assert.deepEqual(asked.sort(), [`2026-11-18.0/buildings/14/${BX}/${BY}`, `2026-11-18.0/places/14/${BX}/${BY}`]);
  assert.equal(block.release, "2026-11-18.0");
  assert.deepEqual(block.buildings[0].r, [1000, 1000, 1040, 1000, 1040, 1040, 1000, 1040]);
  assert.deepEqual(block.places, []);
  // An archive that stops at zoom 13: its tile covers four blocks, and ours is the south-east one when both its numbers are odd.
  const shallow = await downloadBlock(BX | 1, BY | 1, async () => ({ tile: mvt([{ name: "building", features: [{ type: 3, props: { id: "0bf9d6b8-0000", "@geometry_source": "Esri Community Maps", is_underground: false }, rings: [square(3000, 3000, 40) as [number, number][]] }] }]), maxZoom: 13 }), async () => "r");
  assert.deepEqual(shallow.buildings[0].r, [6000 - UNITS, 6000 - UNITS, 6080 - UNITS, 6000 - UNITS, 6080 - UNITS, 6080 - UNITS, 6000 - UNITS, 6080 - UNITS]);
});

// ---------------------------------------------------------------- Overture: putting it into the map

const building = (id: number, ring: Pt[], more: Partial<Building> = {}): Building => ({ id, ring, height: 7, guessed: true, ...more });
const features = (buildings: Building[]): Features => ({ buildings, roads: [], areas: [], trees: [], addresses: [], coast: [] });
const blockOf = (buildings: OvertureBlock["buildings"], places: OvertureBlock["places"] = []): OvertureBlock => ({ v: 1, release: "test", buildings, places });
const M = 0.0003; // about 15 cm of a chunk in Paris; a house is 0.02 or so across

test("OpenStreetMap wins where both have a building; Overture fills in where it has none", () => {
  const f = features([building(11, square(CX + 0.30, CY + 0.30, 0.03)), building(12, square(CX + 0.50, CY + 0.30, 0.03), { guessed: undefined, height: 20 })]);
  const stats = addOverture(f, blockOf([
    // Lies on building 11, a little askew, and knows its floors: the outline is not taken, the height is.
    { id: idOf("a"), s: "Microsoft ML Buildings", r: flat(square(CX + 0.305, CY + 0.302, 0.03)), t: { building: "yes", "building:levels": "4" } },
    // Lies on building 12, which has a height already: nothing is taken.
    { id: idOf("b"), s: "Microsoft ML Buildings", r: flat(square(CX + 0.50, CY + 0.30, 0.03)), t: { building: "yes", height: "55" } },
    // Stands where the map has nothing: added, as any building is, with what is known of it.
    { id: idOf("c"), s: "Esri Community Maps", r: flat(square(CX + 0.70, CY + 0.30, 0.03)), t: { building: "retail", name: "The Button Box", "roof:shape": "flat" } },
    // Only touches building 11's corner: a building of its own.
    { id: idOf("d"), s: "Esri Community Maps", r: flat(square(CX + 0.328, CY + 0.328, 0.03)), t: { building: "yes" } },
    // Far outside this data tile (in the block, but in another quarter of it): that tile takes it.
    { id: idOf("e"), s: "Esri Community Maps", r: flat(square(CX - 1.7, CY + 0.30, 0.03)), t: { building: "yes" } },
  ]), DX, DY);
  assert.deepEqual(stats, { added: 2, improved: 1, named: 0 });
  assert.equal(f.buildings.length, 4);
  assert.ok(Math.abs(f.buildings[0].height - (4 * 3.1 + 1.2)) < 1e-9);
  assert.equal(f.buildings[0].guessed, undefined);
  assert.equal(f.buildings[1].height, 20);
  const added = f.buildings.find((b) => b.id === idOf("c"))!;
  assert.equal(added.kind, "retail");
  assert.equal(added.name, "The Button Box");
  assert.equal(added.use, "shop");
  assert.equal(added.roof, "flat");
  assert.equal(added.guessed, true);
  assert.ok(Math.abs(added.ring[0][0] - (CX + 0.70)) < 1e-3, "back in world coordinates");
});

test("what Overture knows about one of the map's own buildings goes on it only where the map says nothing", () => {
  const f = features([
    building(11, square(CX + 0.30, CY + 0.30, 0.03)),
    building(12, square(CX + 0.50, CY + 0.30, 0.03), { guessed: undefined, height: 20, roof: "hipped", colour: 0xb8372b }),
    building(-(77 * 8 + 0), square(CX + 0.70, CY + 0.30, 0.03)),
  ]);
  const stats = addOverture(f, blockOf([
    { osm: "w11", t: { height: "31", "roof:shape": "gabled", "roof:colour": "#8f3a2e", "building:colour": "white" } },
    { osm: "w12", t: { height: "99", "roof:shape": "flat", "building:colour": "white" } },
    { osm: "r77", t: { "building:levels": "2" } },
    { osm: "w404", t: { height: "9" } },
  ]), DX, DY);
  assert.equal(stats.improved, 2);
  const [a, b, c] = f.buildings;
  assert.equal(a.height, 31);
  assert.equal(a.measured, true);
  assert.equal(a.guessed, undefined);
  assert.equal(a.roof, "gabled");
  assert.equal(typeof a.roofColour, "number");
  assert.equal(typeof a.colour, "number");
  assert.deepEqual([b.height, b.roof, b.colour], [20, "hipped", 0xb8372b], "what the map says stands");
  assert.ok(Math.abs(c.height - (2 * 3.1 + 1.2)) < 1e-9, "a building mapped as a relation is found by its relation");
});

test("places name the buildings they stand in or at, and the map's own names stand", () => {
  const f = features([
    building(11, square(CX + 0.30, CY + 0.30, 0.03)),
    building(12, square(CX + 0.50, CY + 0.30, 0.03), { name: "Old Post Office" }),
    building(13, square(CX + 0.70, CY + 0.30, 0.03)),
    building(14, square(CX + 0.30, CY + 0.50, 0.5)), // a hall of 200 m by 200 m: too big to be named by one shop in it
    building(15, square(CX + 0.10, CY + 0.10, 0.03)),
  ]);
  f.places = [{ id: 1, at: [CX + 0.11, CY + 0.11], name: "Moss & Fern", kind: "shop=florist" }];
  const place = (id: string, wx: number, wy: number, n: string, k: string, c = 90): OvertureBlock["places"][number] => ({ id: idOf(id), x: U(wx, wy)[0], y: U(wx, wy)[1], n, k, c });
  const stats = addOverture(f, blockOf([], [
    place("1", CX + 0.31, CY + 0.31, "Lantern Lane Gifts", "tourism=museum", 95),
    place("2", CX + 0.315, CY + 0.315, "Kettle & Crumb", "amenity=cafe", 70), // the same building: it says what the building is, so it comes first
    place("3", CX + 0.51, CY + 0.31, "Paper Kite Books", "shop=book"), // in a building with a name of its own
    place("4", CX + 0.70 - 20 * M, CY + 0.31, "The Toy Cupboard", "shop=toy"), // 3 m outside building 13's wall: put at the kerb
    place("5", CX + 0.90, CY + 0.90, "Nowhere Bakery", "shop=bakery"), // no building near
    place("6", CX + 0.5, CY + 0.7, "Stall In The Hall", "shop=gift"), // in the big hall
    place("7", CX + 0.115, CY + 0.115, "Moss and Fern", "shop=florist"), // the map names this one already
  ]), DX, DY);
  assert.equal(stats.named, 2);
  const [a, b, c, d, e] = f.buildings;
  assert.deepEqual([a.name, a.use], ["Kettle & Crumb", "food"]);
  assert.equal(b.name, "Old Post Office");
  assert.equal(b.use, undefined);
  assert.deepEqual([c.name, c.use], ["The Toy Cupboard", "shop"]);
  assert.equal(d.name, undefined, "a hall is not named after one stall");
  assert.equal(e.name, undefined, "the map's own place was there first (it names the building where the extras are put in)");
  // The places are handed on for the insides of buildings: all that stand in one, and the map's own.
  const names = f.places.map((p) => p.name).sort();
  assert.deepEqual(names, ["Kettle & Crumb", "Lantern Lane Gifts", "Moss & Fern", "Paper Kite Books", "Stall In The Hall", "The Toy Cupboard"]);
  const moved = f.places.find((p) => p.name === "The Toy Cupboard")!;
  assert.ok(moved.at[0] > CX + 0.70, "moved to just inside the wall");
});

// ---------------------------------------------------------------- data that comes late

test("a block's data that comes late is owed, and told of when it comes", async () => {
  const kept = new Map<string, Buffer>();
  let release!: (value: string) => void;
  let fetches = 0;
  const told: string[] = [];
  const late = new Late<string>({
    name: "test data", rel: (bx, by) => `t/${bx}/${by}`, owedRel: "t/owed.json",
    fetch: () => { fetches++; return new Promise<string>((resolve) => { release = resolve; }); },
    encode: (v) => v, decode: (buf) => buf.toString("utf8"), waitMs: 20,
    read: async (rel) => kept.get(rel) ?? null, write: async (rel, data) => { kept.set(rel, Buffer.from(data)); },
  });
  late.onArrive((bx, by) => told.push(`${bx}/${by}`));
  assert.equal(await late.get(3, 4), null, "not waited for longer than a build can wait");
  assert.equal(late.owes(3, 4), true);
  assert.equal(await late.get(3, 4), null, "and not waited for again while it is owed");
  assert.equal(fetches, 1, "the one question carries on");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(JSON.parse(kept.get("t/owed.json")!.toString("utf8")), ["3/4"]);
  release("here it is");
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(told, ["3/4"]);
  assert.equal(late.owes(3, 4), false);
  assert.equal(await late.get(3, 4), "here it is");
  assert.equal(fetches, 1, "from the cache now");
});

test("data that comes in time is not owed, and a failure is left alone for a while", async () => {
  const kept = new Map<string, Buffer>();
  let fails = 0;
  const late = new Late<string>({
    name: "test data", rel: (bx, by) => `t/${bx}/${by}`, owedRel: "t/owed.json",
    fetch: async (bx) => { if (bx === 9) { fails++; throw new Error("down"); } return "quick"; },
    encode: (v) => v, decode: (buf) => buf.toString("utf8"), waitMs: 200,
    read: async (rel) => kept.get(rel) ?? null, write: async (rel, data) => { kept.set(rel, Buffer.from(data)); },
  });
  const told: string[] = [];
  late.onArrive((bx, by) => told.push(`${bx}/${by}`));
  assert.equal(await late.get(1, 1), "quick");
  assert.equal(late.owes(1, 1), false);
  assert.deepEqual(told, [], "nothing was built without it, so there is nothing to build again");
  assert.equal(await late.get(9, 9), null);
  assert.equal(await late.get(9, 9), null);
  assert.equal(fails, 1, "a source that failed is not asked again straight away");
  assert.equal(late.owes(9, 9), true);
});

test("a tile parsed before the other sources came is parsed again when they come, and not before", async () => {
  const osm: OsmJson = { elements: [] };
  let overture: OvertureBlock | null = null;
  let asked = 0, read = 0;
  const DX2 = 40_000 + Math.floor(Math.random() * 1000), DY2 = 20_000; // its own tile: the parsed tiles are kept between tests
  const fetcher = async (): Promise<OsmJson> => { read++; return osm; };
  const others = async (_dx: number, _dy: number, only?: { overture?: boolean; cover?: boolean }): Promise<{ overture: OvertureBlock | null }> => { asked++; assert.ok(!only || only.overture); return { overture }; };
  const first = await loadFeatures(DX2, DY2, fetcher, async () => ({ elements: [] }), others);
  assert.equal(first.partial, true);
  assert.equal(await loadFeatures(DX2, DY2, fetcher, async () => ({ elements: [] }), others), first, "still waiting: the same tile, not read again");
  assert.equal(read, 1);
  const bx = DX2 >> 1, by = DY2 >> 1;
  overture = blockOf([{ id: idOf("late"), s: "Esri Community Maps", r: [100, 100, 200, 100, 200, 200, 100, 200], t: { building: "yes" } }]);
  // (The outline is in the block's north-west corner, which is this data tile when both its numbers are even.)
  const second = await loadFeatures(bx * 2, by * 2, fetcher, async () => ({ elements: [] }), others);
  if (bx * 2 === DX2) {
    assert.notEqual(second, first);
    assert.equal(second.partial, undefined);
    assert.equal(second.buildings.length, 1);
    assert.equal(read, 2);
    assert.equal(await loadFeatures(DX2, DY2, fetcher, async () => ({ elements: [] }), others), second);
  }
  assert.ok(asked >= 3);
});

// ---------------------------------------------------------------- GeoTIFFs

/** Packs bytes as TIFF does with LZW: codes of 9 to 12 bits, the first bit first, widening one code early. */
function lzw(data: Uint8Array): Buffer {
  const out: number[] = [];
  let acc = 0, nbits = 0;
  const put = (code: number, width: number): void => {
    acc = acc * 2 ** width + code;
    nbits += width;
    while (nbits >= 8) { const top = Math.floor(acc / 2 ** (nbits - 8)); out.push(top & 255); acc -= top * 2 ** (nbits - 8); nbits -= 8; }
  };
  let table = new Map<string, number>(), next = 258, width = 9, cur = "";
  put(256, width);
  for (const byte of data) {
    const c = String.fromCharCode(byte);
    if (cur === "" || table.has(cur + c)) { cur += c; continue; }
    put(cur.length === 1 ? cur.charCodeAt(0) : table.get(cur)!, width);
    table.set(cur + c, next++);
    if (next === 2 ** width && width < 12) width++;
    if (next >= 4094) { put(256, width); table = new Map(); next = 258; width = 9; }
    cur = c;
  }
  if (cur) put(cur.length === 1 ? cur.charCodeAt(0) : table.get(cur)!, width);
  put(257, width);
  if (nbits) out.push((acc * 2 ** (8 - nbits)) & 255);
  return Buffer.from(out);
}

test("TIFF's LZW is unpacked, through the widening of its codes and the emptying of its table", () => {
  const some = (n: number, kinds: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => ((i * 2654435761) >>> 20) % kinds + (i % 7 === 0 ? 3 : 0));
  for (const data of [Uint8Array.from([7, 7, 7, 7, 7, 7, 7, 8]), some(3000, 5), some(60_000, 40), some(20_000, 250)]) {
    assert.deepEqual([...unLzw(lzw(data), data.length)], [...data]);
  }
  // Only as much as is wanted is unpacked.
  const long = some(60_000, 40);
  assert.deepEqual([...unLzw(lzw(long), 100)], [...long.subarray(0, 100)]);
});

/** A little-endian classic TIFF of one image, in deflated tiles or in LZW strips of one row, placed on the Earth. */
function tiff(o: { width: number; height: number; bytes: 1 | 2; tile?: number; west: number; north: number; pixel: number; at: (x: number, y: number) => number }): Buffer {
  const pieces: Buffer[] = [];
  const row = (y: number, x0: number, n: number): Buffer => {
    const b = Buffer.alloc(n * o.bytes);
    for (let i = 0; i < n; i++) { const v = x0 + i < o.width && y < o.height ? o.at(x0 + i, y) : 0; if (o.bytes === 2) b.writeUInt16LE(v, i * 2); else b[i] = v; }
    return b;
  };
  if (o.tile) {
    for (let ty = 0; ty < Math.ceil(o.height / o.tile); ty++) for (let tx = 0; tx < Math.ceil(o.width / o.tile); tx++) {
      pieces.push(deflateSync(Buffer.concat(Array.from({ length: o.tile }, (_, j) => row(ty * o.tile! + j, tx * o.tile!, o.tile!)))));
    }
  } else for (let y = 0; y < o.height; y++) pieces.push(lzw(row(y, 0, o.width)));
  const entries: [number, number, number[]][] = [
    [256, 4, [o.width]], [257, 4, [o.height]], [258, 3, [o.bytes * 8]], [259, 3, [o.tile ? 8 : 5]], [277, 3, [1]], [317, 3, [1]],
    ...(o.tile ? [[322, 3, [o.tile]], [323, 3, [o.tile]]] as [number, number, number[]][] : [[278, 3, [1]]] as [number, number, number[]][]),
    [o.tile ? 324 : 273, 4, []], [o.tile ? 325 : 279, 4, pieces.map((p) => p.length)], [33550, 12, [o.pixel, o.pixel, 0]], [33922, 12, [0, 0, 0, o.west, o.north, 0]],
  ];
  entries.sort((a, b) => a[0] - b[0]);
  const size = (type: number): number => (type === 3 ? 2 : type === 4 ? 4 : 8);
  const ifdAt = 8, ifdLen = 2 + entries.length * 12 + 4;
  let extra = ifdAt + ifdLen;
  const where = entries.map(([, type, values]) => { const n = values.length || pieces.length; const at = extra; if (size(type) * n > 4) extra += size(type) * n; return at; });
  const dataAt = extra;
  let at = dataAt;
  const offsets = pieces.map((p) => { const here = at; at += p.length; return here; });
  const head = Buffer.alloc(dataAt);
  head.write("II", 0, "latin1"); head.writeUInt16LE(42, 2); head.writeUInt32LE(ifdAt, 4);
  head.writeUInt16LE(entries.length, ifdAt);
  entries.forEach(([tag, type, given], i) => {
    const values = given.length ? given : offsets;
    const e = ifdAt + 2 + i * 12;
    head.writeUInt16LE(tag, e); head.writeUInt16LE(type, e + 2); head.writeUInt32LE(values.length, e + 4);
    const inline = size(type) * values.length <= 4;
    if (!inline) head.writeUInt32LE(where[i], e + 8);
    values.forEach((v, k) => { const p = (inline ? e + 8 : where[i]) + k * size(type); if (type === 3) head.writeUInt16LE(v, p); else if (type === 4) head.writeUInt32LE(v, p); else head.writeDoubleLE(v, p); });
  });
  return Buffer.concat([head, ...pieces]);
}

test("a window is read out of a GeoTIFF in tiles, and out of one in strips, with few reads", async () => {
  const value = (x: number, y: number): number => (x * 7 + y * 13) % 251;
  for (const tile of [16, undefined]) {
    const bytes = tile ? 1 : 2;
    const { read, reads } = ranges(tiff({ width: 100, height: 60, bytes, tile, west: 174, north: -36, pixel: 0.01, at: (x, y) => value(x, y) + (bytes === 2 ? 1000 : 0) }));
    const index = await readTiffIndex(read);
    assert.deepEqual([index.width, index.height, index.bytes, index.west, index.north, index.pixelLon], [100, 60, bytes, 174, -36, 0.01]);
    const before = reads.length;
    const win = await readWindow(read, index, 30, 20, 49, 34);
    assert.deepEqual([win.width, win.height], [20, 15]);
    for (const [x, y] of [[0, 0], [19, 14], [7, 3], [2, 12]]) assert.equal(win.data[y * 20 + x], value(30 + x, 20 + y) + (bytes === 2 ? 1000 : 0));
    // Tiles: the six the window touches. Strips: the rows wanted, in one read.
    assert.equal(reads.length - before, tile ? 6 : 1);
    // Past the edge of the picture there is nothing, and that is no error.
    assert.deepEqual([...(await readWindow(read, index, 95, 55, 120, 80)).data].length, 5 * 5);
  }
});

// ---------------------------------------------------------------- ground cover

test("the two maps' files are found by where a place is", () => {
  assert.equal(coverFile(-36.84, 174.77), "ESA_WorldCover_10m_2021_v200_S39E174_Map.tif");
  assert.equal(coverFile(48.86, 2.29), "ESA_WorldCover_10m_2021_v200_N48E000_Map.tif");
  assert.equal(coverFile(40.7, -74.0), "ESA_WorldCover_10m_2021_v200_N39W075_Map.tif");
  assert.deepEqual(canopyFiles(-36.84, 174.77), ["meta_chm_lat=-30.0_lon=170.0_p95.tif"]);
  assert.deepEqual(canopyFiles(48.86, 2.29), ["meta_chm_lat=50.0_lon=-0.0_p95.tif", "meta_chm_lat=50.0_lon=0.0_p95.tif"]);
  assert.deepEqual(canopyFiles(-3.2, -60.1), ["meta_chm_lat=-0.0_lon=-70.0_p95.tif", "meta_chm_lat=0.0_lon=-70.0_p95.tif"]);
});

test("single spots are smoothed out of the ground cover, and patches kept", () => {
  const n = 6;
  const g = new Uint8Array(n * n).fill(COVER.grass);
  g[2 * n + 2] = COVER.trees; // one spot of trees in the grass
  for (const at of [4 * n + 3, 4 * n + 4, 5 * n + 3, 5 * n + 4]) g[at] = COVER.crops; // a field
  const out = smoothKinds(g, n);
  assert.equal(out[2 * n + 2], COVER.grass);
  assert.equal(out[4 * n + 3], COVER.crops);
  assert.equal(out[5 * n + 4], COVER.crops);
});

test("a block's ground cover is sampled from the two maps and kept small", async () => {
  // Made-up maps of the block's corner of the world: trees in the west half, crops in the east; trees 20 m tall in the north half.
  const w = xToLon(BX, 14), e = xToLon(BX + 1, 14), n = yToLat(BY, 14), s = yToLat(BY + 1, 14);
  const pixel = (e - w) / 100;
  const west = w - 10 * pixel, north = n + 10 * pixel;
  const kinds = tiff({ width: 130, height: 130, bytes: 1, tile: 64, west, north, pixel, at: (x) => (west + (x + 0.5) * pixel < (w + e) / 2 ? COVER.trees : COVER.crops) });
  const heights = tiff({ width: 130, height: 130, bytes: 2, west, north, pixel, at: (_x, y) => (north - (y + 0.5) * pixel > (n + s) / 2 ? 2040 : 65535) });
  const opened: string[] = [];
  const cover = await downloadCover(BX, BY, (url) => {
    opened.push(url.split("/").pop()!);
    if (url.includes("WorldCover")) return ranges(kinds).read;
    if (url.includes("lon=0.0")) return ranges(heights).read;
    return async () => { throw new Error("HTTP 404"); }; // the name with "-0.0" is not there: the other is tried
  });
  assert.deepEqual(opened, ["ESA_WorldCover_10m_2021_v200_N48E000_Map.tif", "meta_chm_lat=50.0_lon=-0.0_p95.tif", "meta_chm_lat=50.0_lon=0.0_p95.tif"]);
  assert.equal(kindAt(cover, BX + 0.25, BY + 0.5), COVER.trees);
  assert.equal(kindAt(cover, BX + 0.75, BY + 0.5), COVER.crops);
  assert.equal(kindAt(cover, BX + 1.5, BY + 0.5), 0, "outside the block");
  assert.equal(tallAt(cover, BX + 0.5, BY + 0.25), 20);
  assert.equal(tallAt(cover, BX + 0.5, BY + 0.75), TALL_UNKNOWN);
  const kept = encodeCover(cover);
  assert.ok(kept.length < 2000, `kept in ${kept.length} bytes`);
  const back = decodeCover(kept, BX, BY);
  assert.deepEqual(back.kinds, cover.kinds);
  assert.deepEqual(back.tall, cover.tall);
  assert.throws(() => decodeCover(Buffer.from("nonsense"), BX, BY));
});

/** Flat ground a little above the sea. */
function flatLand(): Elevation {
  return new Elevation(async () => new Float32Array(256 * 256).fill(30));
}
/** A block's cover with one kind everywhere, and trees of one height. */
function coverOf(kind: (i: number, j: number) => number, tall = TALL_UNKNOWN): Cover {
  const kinds = new Uint8Array(COVER_N * COVER_N);
  for (let j = 0; j < COVER_N; j++) for (let i = 0; i < COVER_N; i++) kinds[j * COVER_N + i] = kind(i, j);
  return { bx: BX, by: BY, kinds, tall: new Uint8Array(TALL_N * TALL_N).fill(tall) };
}

test("the ground cover fills in only where the map says nothing", async () => {
  const elev = flatLand();
  await elev.ensure(CX - 0.5, CY - 0.5, CX + 1.5, CY + 1.5);
  // The map: a park in the chunk's north-west quarter, a housing area in its south-west quarter, nothing in its east half.
  const f = features([]);
  f.areas = [
    { id: 1, cls: "grass", rings: [square(CX, CY, 0.5)] },
    { id: 2, cls: "urban", rings: [square(CX, CY + 0.5, 0.5)] },
  ];
  f.roads = [{ id: 9, cls: "road", width: 6, pts: [[CX - 1, CY + 0.3], [CX + 2, CY + 0.3]] }]; // so that low ground is not taken for sea
  const at = (cls: Uint8Array, u: number, v: number): number => cls[Math.floor(v * GRID) * GRID + Math.floor(u * GRID)];
  const plain = groundClasses(CX, CY, f, elev);
  assert.deepEqual([at(plain, 0.25, 0.25), at(plain, 0.25, 0.75), at(plain, 0.75, 0.25)], [groundClassId("grass"), groundClassId("urban"), 0]);

  // The chunk's own cells in the block's grid start at (CX - BX * 4) * 64.
  const i0 = (CX - BX * 4) * GRID, j0 = (CY - BY * 4) * GRID;
  const local = (i: number, j: number): [number, number] => [(i - i0) / GRID, (j - j0) / GRID];
  f.cover = coverOf((i, j) => { const [u, v] = local(i, j); return u < 0.5 ? COVER.trees : v < 0.25 ? COVER.trees : v < 0.5 ? COVER.crops : v < 0.75 ? COVER.bare : COVER.water; });
  const cls = groundClasses(CX, CY, f, elev);
  assert.equal(at(cls, 0.25, 0.25), groundClassId("grass"), "the map's park stays a park");
  assert.equal(at(cls, 0.25, 0.75), groundClassId("grass"), "trees in a housing area: a garden's grass (the trees are planted on it)");
  assert.equal(at(cls, 0.75, 0.1), groundClassId("forest"));
  assert.equal(at(cls, 0.75, 0.4), groundClassId("farm"));
  assert.equal(at(cls, 0.75, 0.6), groundClassId("sand"), "bare and flat");
  assert.equal(at(cls, 0.75, 0.9), 0, "water is the map's to say");
});

test("trees stand where satellites saw them, as tall as they are there, and off the roads", async () => {
  const elev = flatLand();
  await elev.ensure(CX - 0.5, CY - 0.5, CX + 1.5, CY + 1.5);
  const f = features([]);
  f.areas = [{ id: 1, cls: "forest", rings: [square(CX, CY, 1)] }];
  f.roads = [{ id: 9, cls: "road", width: 8, pts: [[CX - 1, CY + 0.5], [CX + 2, CY + 0.5]] }];
  const S = 40075016.686 * Math.cos((yToLat(CY + 0.5) * Math.PI) / 180) / 2 ** 16;
  const usual = placeTrees(CX, CY, f, groundClasses(CX, CY, f, elev));
  assert.ok(usual.length > 3000, "a wood has a tree in nearly every cell");
  assert.ok(usual.every((t) => Math.abs(t.wy - (CY + 0.5)) * S > 4 + 1.2), "none on the road, nor at its very edge");
  assert.ok(usual.every((t) => t.height >= 6 && t.height <= 13), "the usual heights where nothing is known");

  f.cover = coverOf(() => COVER.trees, 30);
  const tall = placeTrees(CX, CY, f, groundClasses(CX, CY, f, elev));
  assert.equal(tall.length, usual.length);
  assert.ok(tall.every((t) => t.height >= 30 * 0.66 - 0.01 && t.height <= 30.3 + 0.01), "between two thirds of the tallest and all of it");
  assert.ok(tall.every((t) => t.radius > 3 && t.radius <= 7), "and as broad as trees that tall are");

  f.cover = coverOf(() => COVER.trees, 1);
  const young = placeTrees(CX, CY, f, groundClasses(CX, CY, f, elev));
  assert.ok(young.every((t) => t.height >= 3 && t.height <= 5), "a wood where nothing stands tall is a young one");

  // Grass, where the map says nothing at all: bushes on scrub, trees where trees were seen, and one cell in nine besides.
  f.areas = [];
  f.cover = coverOf((i) => (i < (CX - BX * 4) * GRID + GRID / 2 ? COVER.shrubs : COVER.grass), 12);
  const scrub = placeTrees(CX, CY, f, groundClasses(CX, CY, f, elev));
  const west = scrub.filter((t) => t.wx < CX + 0.5), east = scrub.filter((t) => t.wx >= CX + 0.5);
  assert.ok(west.filter((t) => t.height < 3.1).length > 700, "bushes in about every other cell of scrub");
  assert.ok(east.length > 120 && east.length < 400, "a tree here and there on grass");
  assert.ok(east.every((t) => t.height >= 12 * 0.66 - 0.01), "as tall as trees there are");
});
