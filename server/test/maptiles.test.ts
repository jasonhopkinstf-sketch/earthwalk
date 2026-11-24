import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { MAP_TILE_KEEP_MS, MAP_TILE_MAX_Z, MapTiles, validTile } from "../src/maptiles.ts";

// The street map behind the world map (src/maptiles.ts). The map's own server is stood in for: nothing leaves this computer.
const PNG = (n: number): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, n)]);

test("a square of the map is fetched once, kept a fortnight, and given sooner than nothing when the map's server is down", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "earthwalk-tiles-"));
  const asked: string[] = [];
  let now = Date.UTC(2026, 10, 24);
  let down = false;
  let version = 1;
  const tiles = new MapTiles({
    dir, now: () => now,
    fetchTile: async (z, x, y) => {
      asked.push(`${z}/${x}/${y}`);
      if (down) throw new Error("the map's server is down");
      return z === 5 && x === 0 ? null : PNG(version);
    },
  });
  try {
    assert.deepEqual([validTile(0, 0, 0), validTile(3, 7, 7), validTile(3, 8, 0), validTile(2, 0, -1), validTile(MAP_TILE_MAX_Z + 1, 0, 0), validTile(2.5, 0, 0)], [true, true, false, false, false, false]);
    assert.equal(await tiles.get(3, 8, 0), null, "no such square");
    assert.equal(await tiles.get(MAP_TILE_MAX_Z + 1, 1, 1), null, "nothing closer in than the limit");
    assert.deepEqual(asked, [], "and the map's server is not troubled for either");

    // Asked for by several at once: one fetch. Then it is kept.
    const [a, b] = await Promise.all([tiles.get(12, 4038, 2501), tiles.get(12, 4038, 2501)]);
    assert.deepEqual([a?.equals(PNG(1)), b?.equals(PNG(1))], [true, true]);
    assert.deepEqual(asked, ["12/4038/2501"]);
    assert.ok((await tiles.get(12, 4038, 2501))?.equals(PNG(1)));
    assert.equal(asked.length, 1);
    assert.ok((await fs.readFile(path.join(dir, "12", "4038", "2501.png"))).equals(PNG(1)));
    assert.equal(await tiles.get(5, 0, 3), null, "a square the map has no picture of");

    // A fortnight on it is fetched afresh. (The clock here is the test's own; the file's date is the computer's.)
    version = 2;
    now = Date.now() + MAP_TILE_KEEP_MS + 60_000;
    assert.ok((await tiles.get(12, 4038, 2501))?.equals(PNG(2)));
    // And with the map's server down, the old picture is better than none.
    down = true;
    now += MAP_TILE_KEEP_MS + 60_000;
    assert.ok((await tiles.get(12, 4038, 2501))?.equals(PNG(2)));
    assert.equal(await tiles.get(12, 1, 1), null);
    assert.equal(tiles.fetched, 3);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("GET /v1/maptile: a PNG for whoever may play, so many to a caller, and none where the map is off", async () => {
  const { createApp } = await import("../src/app.ts");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "earthwalk-tiles-"));
  const tiles = new MapTiles({ dir, perCaller: 3, fetchTile: async () => PNG(7) });
  const app = createApp({ accessCode: "open sesame", mapTiles: tiles });
  const off = createApp({ mapTiles: null });
  await Promise.all([app, off].map((a) => new Promise<void>((r) => a.server.listen(0, r))));
  const at = (a: typeof app): string => `http://localhost:${(a.server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${at(app)}/v1/maptile/3/1/2.png`)).status, 401, "the access code is wanted");
    const headers = { Authorization: "Bearer open sesame" };
    const ok = await fetch(`${at(app)}/v1/maptile/3/1/2.png`, { headers });
    assert.deepEqual([ok.status, ok.headers.get("content-type"), /max-age=604800/.test(ok.headers.get("cache-control") ?? "")], [200, "image/png", true]);
    assert.ok(Buffer.from(await ok.arrayBuffer()).equals(PNG(7)));
    assert.equal((await fetch(`${at(app)}/v1/maptile/3/9/2.png`, { headers })).status, 404, "no such square");
    assert.equal((await fetch(`${at(app)}/v1/maptile/3/1/3.png`, { headers })).status, 200);
    assert.equal((await fetch(`${at(app)}/v1/maptile/3/1/4.png`, { headers })).status, 429, "three to a caller here, and that was the fourth");
    assert.equal((await fetch(`${at(off)}/v1/maptile/3/1/2.png`)).status, 503);
  } finally {
    app.close();
    off.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the sums of the world map: places to points and back, the pictures that cover a screen, and zooming about the pointer", async () => {
  const { MAX_ZOOM, MIN_ZOOM, TILE_PX, awayWords, geoOf, pointOf, tilesFor, zoomAbout } = await import("../public/js/mapview.js");
  // The whole world is one picture at zoom 0, with the equator and Greenwich in its middle.
  assert.deepEqual(pointOf(0, 0, 0), { x: 128, y: 128 });
  assert.ok(Math.abs(pointOf(0, 180, 3).x - TILE_PX * 8) < 1e-9);
  for (const [lat, lon] of [[-36.8312, 174.7965], [48.8583, 2.2945], [0, 0], [71.2, -156.8]]) {
    const at = pointOf(lat, lon, 15);
    const back = geoOf(at.x, at.y, 15);
    assert.ok(Math.abs(back.lat - lat) < 1e-9 && Math.abs(back.lon - lon) < 1e-9, "there and back");
  }
  // East and west it goes round.
  assert.ok(Math.abs(geoOf(TILE_PX * 4 * 1.25, 100, 2).lon - -90) < 1e-9);

  // A screen of 1280 by 720 at zoom 15 round Devonport: the pictures that touch it, each once, at the right place.
  const mid = pointOf(-36.8312, 174.7965, 15);
  const tiles = tilesFor(mid, 15, 1280, 720);
  assert.ok(tiles.length >= 15 && tiles.length <= 24, `about twenty pictures, not ${tiles.length}`);
  assert.equal(new Set(tiles.map((t) => `${t.x}/${t.y}`)).size, tiles.length);
  assert.ok(tiles.every((t) => t.z === 15 && t.size === TILE_PX && t.left + t.size > mid.x - 640 && t.left < mid.x + 640 && t.top + t.size > mid.y - 360 && t.top < mid.y + 360));
  assert.ok(tiles.some((t) => t.x === Math.floor(mid.x / TILE_PX) && t.y === Math.floor(mid.y / TILE_PX)), "the one Devonport is in");
  assert.deepEqual([Math.floor(mid.x / TILE_PX) >> 1 === Math.floor(pointOf(-36.8312, 174.7965, 14).x / TILE_PX), Math.floor(mid.y / TILE_PX) > 2 ** 14], [true, true], "and it is south of the equator");
  // Half way between two zooms the nearer zoom's pictures are drawn larger or smaller; past 17 there are none closer.
  assert.deepEqual([tilesFor(mid, 15.4, 800, 600)[0].z, tilesFor(pointOf(-36.8312, 174.7965, 18.5), 18.5, 800, 600)[0].z], [15, 17]);
  assert.ok(Math.abs(tilesFor(pointOf(-36.8312, 174.7965, 18.5), 18.5, 800, 600)[0].size - TILE_PX * 2 ** 1.5) < 1e-9);
  // Across the date line the pictures go round the world.
  assert.ok(tilesFor(pointOf(0, 179.99, 4), 4, 1200, 300).some((t) => t.x === 0) && tilesFor(pointOf(0, 179.99, 4), 4, 1200, 300).some((t) => t.x === 15));

  // Zooming with the pointer off to one side keeps what is under the pointer under it.
  const centre = { lat: -36.8312, lon: 174.7965 };
  const about = { x: 300, y: -120 };
  const before = pointOf(centre.lat, centre.lon, 15);
  const under = geoOf(before.x + about.x, before.y + about.y, 15);
  const next = zoomAbout(centre, 15, 1, about);
  const after = pointOf(next.centre.lat, next.centre.lon, next.zoom);
  const still = pointOf(under.lat, under.lon, next.zoom);
  assert.equal(next.zoom, 16);
  assert.ok(Math.abs(still.x - after.x - about.x) < 1e-6 && Math.abs(still.y - after.y - about.y) < 1e-6);
  assert.deepEqual([zoomAbout(centre, MAX_ZOOM, 3, { x: 0, y: 0 }).zoom, zoomAbout(centre, MIN_ZOOM, -3, { x: 0, y: 0 }).zoom], [MAX_ZOOM, MIN_ZOOM]);

  assert.equal(awayWords(-36.8312, 174.7965, -36.8312, 174.7966), "Right where you are");
  assert.equal(awayWords(-36.8312, 174.7965, -36.8222, 174.7965), "1.0 km to the north of you");
  assert.equal(awayWords(-36.8312, 174.7965, -36.8352, 174.7915), "630 m to the south-west of you");
  assert.match(awayWords(-36.8312, 174.7965, 48.8583, 2.2945), /^18,\d{3} km to the /);
});
