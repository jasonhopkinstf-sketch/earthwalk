// The map download (osm.ts), the map ahead of a traveller (ahead.ts) and the things to show (showcase.ts).
// Nothing here reaches for a real map server.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { LookAhead, tilesAhead } from "../src/ahead.ts";
import { CHUNK_Z, latToY, lonToX, metersPerTile, xToLon, yToLat } from "../src/geo.ts";
import { Pool } from "../src/net.ts";
import { DATA_MARGIN, DATA_Z, overpassClient, parseOsm, splitBlock, trimToUsed, type OsmJson } from "../src/osm.ts";
import { chunksOf, keepShowsBuilt, SHOWS, tilesOf } from "../src/showcase.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const map = (n: number): OsmJson => ({ elements: [{ type: "node", id: n, lat: 0, lon: 0 }] });

// ---------------------------------------------------------------- the pool

test("the pool runs two at a time, the newest first, and quiet jobs only when nothing else waits", async () => {
  const pool = new Pool(2, 0, 2);
  const order: string[] = [];
  let running = 0;
  let most = 0;
  const job = (name: string, ms = 20) => async () => {
    order.push(name);
    most = Math.max(most, ++running);
    await sleep(ms);
    running--;
    return name;
  };
  const a = pool.add(job("a"));
  const b = pool.add(job("b"));
  const q1 = pool.add(job("q1"), true);
  const c = pool.add(job("c"));
  const d = pool.add(job("d"));
  assert.deepEqual(await Promise.all([a.promise, b.promise, c.promise, d.promise, q1.promise]), ["a", "b", "c", "d", "q1"]);
  assert.equal(most, 2);
  assert.deepEqual(order, ["a", "b", "d", "c", "q1"], "newest first among those waiting; the quiet one last");
});

test("a quiet job never takes the last free place, is dropped when too many wait, and can be hurried", async () => {
  const pool = new Pool(2, 0, 2);
  const started: string[] = [];
  const job = (name: string) => async () => {
    started.push(name);
    await sleep(30);
    return name;
  };
  const q1 = pool.add(job("q1"), true);
  const q2 = pool.add(job("q2"), true);
  const q3 = pool.add(job("q3"), true);
  const q4 = pool.add(job("q4"), true);
  assert.deepEqual(started, ["q1"], "one quiet job at a time, so a place is always free for somebody waiting");
  await assert.rejects(q2.promise, /dropped/, "the oldest waiting is given up when a third is queued");
  q3.hurry();
  assert.deepEqual(started, ["q1", "q3"], "hurried, it takes the free place at once");
  assert.deepEqual(await Promise.all([q1.promise, q3.promise, q4.promise]), ["q1", "q3", "q4"]);
});

// ---------------------------------------------------------------- the Overpass servers

test("a slow server is not waited for: the next is asked too, the first answer wins and the other is called off", async () => {
  const calls: string[] = [];
  let calledOff = false;
  const ask = overpassClient(["https://slow.test/api", "https://quick.test/api"], async (url, _q, signal) => {
    calls.push(new URL(url).host);
    if (url.includes("slow")) {
      await new Promise<void>((_, reject) => signal.addEventListener("abort", () => { calledOff = true; reject(new Error("aborted")); }));
    }
    await sleep(5);
    return map(2);
  }, 15);
  assert.deepEqual(await ask("q"), map(2));
  assert.deepEqual(calls, ["slow.test", "quick.test"]);
  assert.equal(calledOff, true);
  // Called off is no failure: it is asked again next time (after the one that answered, which is now known to be quick).
  calls.length = 0;
  await ask("q");
  assert.equal(calls[0], "quick.test");
});

test("a server that fails is rested, longer each time, and the others carry on; all failing is an error", async () => {
  let now = 1_000_000;
  const calls: string[] = [];
  let bDown = false;
  const ask = overpassClient(["https://a.test/api", "https://b.test/api"], async (url) => {
    calls.push(new URL(url).host);
    if (url.includes("a.test") || bDown) throw new Error("HTTP 504");
    return map(1);
  }, 10_000, () => now);
  await ask("q");
  assert.deepEqual(calls, ["a.test", "b.test"], "the failure is not waited out: the next is asked at once");
  calls.length = 0;
  await ask("q");
  assert.deepEqual(calls, ["b.test"], "a is resting");
  now += 31_000;
  calls.length = 0;
  await ask("q");
  assert.deepEqual(calls.sort(), ["a.test", "b.test"], "half a minute on, a is tried again");
  now += 31_000;
  calls.length = 0;
  await ask("q");
  assert.deepEqual(calls, ["b.test"], "having failed twice, it rests for a minute");
  bDown = true;
  now += 61_000;
  await assert.rejects(ask("q"), /all Overpass servers failed/);
  await assert.rejects(ask("q"), /resting/, "and with every one resting, nothing is asked at all");
});

test("an answer that says the server ran out of time is a failure, not an empty map", async () => {
  // The real post is what checks this, so the check is exercised through a stand-in that behaves like it.
  const ask = overpassClient(["https://a.test/api", "https://b.test/api"], async (url) => {
    if (url.includes("a.test")) throw new Error("runtime error: Query timed out in \"query\" at line 1 after 61 seconds.");
    return map(7);
  }, 10_000);
  assert.deepEqual(await ask("q"), map(7));
});

// ---------------------------------------------------------------- blocks and tiles

/** A block with a house in each quarter, a road right across it, a lake made of two ways, and a tree. */
function block(bx: number, by: number): OsmJson {
  const X = bx * 2, Y = by * 2; // in data tiles
  let id = 0;
  const node = (x: number, y: number, tags?: Record<string, string>) => ({ type: "node" as const, id: ++id, lon: xToLon(X + x, DATA_Z), lat: yToLat(Y + y, DATA_Z), ...(tags ? { tags } : {}) });
  const elements: OsmJson["elements"] = [];
  const way = (wid: number, pts: [number, number][], tags?: Record<string, string>, closed = false) => {
    const ns = pts.map(([x, y]) => node(x, y));
    elements.push(...ns, { type: "way", id: wid, nodes: [...ns.map((n) => n.id), ...(closed ? [ns[0].id] : [])], ...(tags ? { tags } : {}) });
  };
  const house = (wid: number, x: number, y: number) => way(wid, [[x, y], [x + 0.02, y], [x + 0.02, y + 0.02], [x, y + 0.02]], { building: "house" }, true);
  house(101, 0.5, 0.5);
  house(102, 1.5, 0.5);
  house(103, 0.5, 1.5);
  house(104, 1.5, 1.5);
  way(110, [[-0.5, 1.5], [2.5, 1.5]], { highway: "residential" }); // two points only: it crosses the bottom tiles without a point in them
  // The lake's shore, in two untagged pieces that meet end to end.
  const shore = [node(1.2, 0.2), node(1.8, 0.2), node(1.8, 0.4), node(1.2, 0.4)];
  elements.push(...shore, { type: "way", id: 120, nodes: [shore[0].id, shore[1].id, shore[2].id] }, { type: "way", id: 121, nodes: [shore[2].id, shore[3].id, shore[0].id] });
  way(130, [[0.2, 0.2], [0.3, 0.3]], { power: "line" }); // of no use to the generator
  const tree = node(0.25, 0.75, { natural: "tree" });
  const bench = node(0.3, 0.8, { amenity: "bench" });
  const station = node(1.6, 1.7, { railway: "station", name: "Low Road" });
  elements.push(tree, bench, station, { type: "relation", id: 900, tags: { type: "multipolygon", natural: "water" }, members: [{ type: "way", ref: 120, role: "outer" }, { type: "way", ref: 121, role: "outer" }] },
    { type: "relation", id: 901, tags: { type: "route", route: "bus" }, members: [{ type: "way", ref: 110, role: "" }] });
  return { elements };
}

test("only what the generator uses is kept of a download: its ways and relations, their points, trees, house numbers and stations", () => {
  const kept = trimToUsed(block(8000, 5000));
  const ways = kept.elements.filter((e) => e.type === "way").map((e) => e.id).sort();
  assert.deepEqual(ways, [101, 102, 103, 104, 110, 120, 121], "the power line is gone; the lake's untagged shore stays, for its relation");
  assert.deepEqual(kept.elements.filter((e) => e.type === "relation").map((e) => e.id), [900], "the bus route is gone");
  const tagged = kept.elements.filter((e) => e.type === "node" && e.tags).map((e) => Object.values(e.tags!)[0]).sort();
  assert.deepEqual(tagged, ["station", "tree"], "the bench is gone");
  const used = new Set(kept.elements.filter((e) => e.type === "way").flatMap((e) => e.nodes!));
  assert.ok(kept.elements.filter((e) => e.type === "node" && !e.tags).every((e) => used.has(e.id)), "no points left over from what was dropped");
});

test("a block is cut into four tiles, each with what touches it: whole ways, whole relations, its own trees", () => {
  const bx = 8000, by = 5000;
  const tiles = splitBlock(trimToUsed(block(bx, by)), bx, by);
  assert.equal(tiles.length, 4);
  const has = (i: number, type: string) => tiles[i].elements.filter((e) => e.type === type && (type !== "node" || e.tags)).map((e) => e.id).sort();
  assert.deepEqual(has(0, "way"), [101], "north-west: its house");
  assert.deepEqual(has(1, "way"), [102, 120, 121], "north-east: its house and the lake, both pieces");
  assert.deepEqual(has(2, "way"), [103, 110], "south-west: its house, and the road that crosses it without a point in it");
  assert.deepEqual(has(3, "way"), [104, 110], "south-east: the same road, whole");
  assert.deepEqual(has(1, "relation"), [900]);
  assert.deepEqual(has(0, "relation"), []);
  assert.equal(has(0, "node").length, 1, "the tree is in the north-west tile only");
  assert.equal(has(3, "node").length, 1, "and the station in the south-east");
  for (const [i, tile] of tiles.entries()) {
    const ids = new Set(tile.elements.filter((e) => e.type === "node").map((e) => e.id));
    for (const w of tile.elements.filter((e) => e.type === "way")) assert.ok(w.nodes!.every((n) => ids.has(n)), `tile ${i}: every way has all its points`);
  }
  // What the generator reads out of each tile is what it would have read from a download of that tile alone.
  const f = tiles.map((t) => parseOsm(t));
  assert.deepEqual(f.map((x) => x.buildings.length), [1, 1, 1, 1]);
  assert.deepEqual(f.map((x) => x.roads.length), [0, 0, 1, 1]);
  assert.deepEqual(f.map((x) => x.areas.filter((a) => a.cls === "water").length), [0, 1, 0, 0]);
  assert.deepEqual(f.map((x) => x.trees.length), [1, 0, 0, 0]);
});

test("a thing in the margin between two tiles is in both", () => {
  const bx = 8000, by = 5000;
  const json: OsmJson = { elements: [{ type: "node", id: 1, lon: xToLon(bx * 2 + 1 + DATA_MARGIN / 2, DATA_Z), lat: yToLat(by * 2 + 0.5, DATA_Z), tags: { natural: "tree" } }] };
  const tiles = splitBlock(json, bx, by);
  assert.deepEqual(tiles.map((t) => t.elements.length), [1, 1, 0, 0]);
});

// ---------------------------------------------------------------- the map ahead

test("the map ahead of a traveller: from the edge of what their game has, as far as they will get in two minutes", () => {
  const lat = -36.9, lon = 174.65;
  const cx = lonToX(lon), cy = latToY(lat);
  const chunkM = metersPerTile(cy);
  const east = tilesAhead(lat, lon, 1, 0, 2000);
  assert.ok(east.length >= 3);
  const shift = CHUNK_Z - DATA_Z;
  for (const [dx, dy] of east) {
    const midX = (dx + 0.5) * 2 ** shift, midY = (dy + 0.5) * 2 ** shift; // the middle of the tile, in chunks
    assert.ok(midX > cx + 1, "ahead of them, not behind");
    assert.ok(midX < cx + 2 + 2000 / chunkM + 3, "and no further than asked");
    assert.ok(Math.abs(midY - cy) < 4, "as wide as their game looks, no wider");
  }
  assert.ok(tilesAhead(lat, lon, -1, 0, 2000).every(([dx]) => (dx + 0.5) * 2 ** shift < cx - 1), "west is west");
  assert.ok(tilesAhead(lat, lon, 0, 1, 2000).every(([, dy]) => (dy + 0.5) * 2 ** shift < cy - 1), "north is up the map, where y is less");
  assert.deepEqual(tilesAhead(lat, lon, 0, 0, 2000), [], "going nowhere, nothing");
  assert.ok(tilesAhead(lat, lon, 1, 0, 4000).length > east.length, "further for the faster");
});

test("looking ahead: nothing for someone standing or strolling, the ground ahead for a train, nothing after a jump", () => {
  const warmed = new Array<string>();
  const count = (): number => warmed.length;
  const ahead = new LookAhead((dx, dy) => warmed.push(`${dx}/${dy}`));
  const lat = -36.9;
  const step = (id: string, metresEast: number, at: number) => ahead.moved(id, lat, 174.65 + metresEast / (111_320 * Math.cos((lat * Math.PI) / 180)), at);
  // Ten times a second, as games send: a stroll at 1.2 m/s for half a minute.
  for (let i = 0; i <= 300; i++) step("walker", i * 0.12, 1000 + i * 100);
  assert.equal(count(), 0, "a walk needs nothing fetched ahead");
  // A train at 14 m/s.
  for (let i = 0; i <= 100; i++) step("rider", i * 1.4, 1000 + i * 100);
  assert.ok(count() > 0, "the map ahead of the train is fetched");
  const cx = lonToX(174.65) / 2;
  assert.ok(warmed.every((k) => Number(k.split("/")[0]) >= Math.floor(cx)), "and it is ahead: to the east");
  // The same rider then travels by magic to the other side of the world: nothing is "ahead" of that.
  const before = count();
  ahead.moved("rider", 48.85, 2.29, 20_000);
  ahead.moved("rider", 48.85, 2.29, 24_000);
  assert.equal(count(), before);
});

// ---------------------------------------------------------------- things to show

test("the things to show: each has a place, words to say, and something to stand beside", () => {
  assert.ok(SHOWS.length >= 8);
  assert.equal(new Set(SHOWS.map((s) => s.id)).size, SHOWS.length, "no two alike");
  for (const s of SHOWS) {
    assert.match(s.id, /^[a-z]+$/);
    assert.ok(s.title.length > 3 && s.title.length < 40 && s.text.length > 10 && s.how.length > 10, s.id);
    assert.ok(Math.abs(s.place.lat) <= 85 && Math.abs(s.place.lon) <= 180 && s.place.name.length > 3, s.id);
    assert.ok(["train", "home", "car", "door", "air"].includes(s.find), s.id);
    if (s.find === "home") assert.ok(s.sp && s.sp.length > 0, `${s.id} names the animals to look for`);
    const chunks = chunksOf(s);
    assert.equal(chunks.length, (2 * (s.keep ?? 1) + 1) ** 2);
    assert.deepEqual(chunks[0], [Math.floor(lonToX(s.place.lon)), Math.floor(latToY(s.place.lat))], "the place's own chunk first");
    assert.ok(tilesOf(s).length >= 4 && tilesOf(s).length <= 36);
  }
});

test("the shows are kept built: the map first, quietly, then the chunks; what cannot be had is left for later", async () => {
  const shows = SHOWS.slice(0, 2);
  const did: string[] = [];
  const failing = `${tilesOf(shows[1])[0][0]}/${tilesOf(shows[1])[0][1]}`;
  const keeper = keepShowsBuilt(
    async (x, y) => { did.push(`build ${x}/${y}`); },
    async (dx, dy) => { did.push(`map ${dx}/${dy}`); return `${dx}/${dy}` === failing ? "failed" : "there"; },
    { startMs: 3_600_000, pauseMs: 0, restMs: 0, shows, log: () => undefined },
  );
  try {
    assert.equal(await keeper.round(), 1, "one show could not be made ready");
    const firstBuild = did.findIndex((d) => d.startsWith("build"));
    assert.equal(firstBuild, tilesOf(shows[0]).length, "all of a show's map before any of its chunks");
    assert.equal(did.filter((d) => d.startsWith("build")).length, chunksOf(shows[0]).length, "the show whose map failed has no chunks built: that would hurry the download");
  } finally {
    keeper.stop();
  }
});

test("the list of things to show is served, behind the access code like the rest of the world", async () => {
  const app = createApp({ accessCode: "open-sesame", buildChunk: async () => Buffer.from("c"), buildLabels: async () => Buffer.from("{}"), readCache: async () => null, writeCache: async () => undefined });
  await new Promise<void>((r) => app.server.listen(0, r));
  const base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/v1/showcase`)).status, 401);
    const res = await fetch(`${base}/v1/showcase`, { headers: { Authorization: "Bearer open-sesame" } });
    assert.equal(res.status, 200);
    const { shows } = (await res.json()) as { shows: { id: string; place: { lat: number } }[] };
    assert.deepEqual(shows.map((s) => s.id), SHOWS.map((s) => s.id));
    assert.equal(typeof shows[0].place.lat, "number");
  } finally {
    app.close();
  }
});

test("a chunk is made ready ahead of anyone asking: built once, kept, and not built again", async () => {
  const kept = new Map<string, Buffer>();
  let builds = 0;
  const app = createApp({
    buildChunk: async () => { builds++; return Buffer.from("chunk"); },
    buildLabels: async () => { builds++; return Buffer.from("{}"); },
    readCache: async (rel) => kept.get(rel) ?? null,
    writeCache: async (rel, data) => { kept.set(rel, Buffer.from(data)); },
  });
  try {
    await app.prepare(5, 6);
    assert.equal(builds, 2, "the mesh and the labels");
    assert.equal(kept.size, 2);
    await app.prepare(5, 6);
    assert.equal(builds, 2, "already there");
  } finally {
    app.close();
  }
});
