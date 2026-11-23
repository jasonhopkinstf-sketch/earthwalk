// "Go to..." from where a player stands: the beach down the road, not a town called Beach abroad.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// The place search is a public service: here a stand-in answers for it, so nothing leaves this computer.
// (It has to be up before geocode.ts is loaded, which reads its address once.)
test("Go to: the place close by is meant, unless the whole world knows another of that name", async () => {
  const asked: { q: string; box: number | null }[] = [];
  const HERE = { lat: -36.8312, lon: 174.7965 }; // Devonport, Auckland
  const row = (display_name: string, lat: number, lon: number, importance: number, category = "place") => ({ display_name, lat: String(lat), lon: String(lon), importance, category });
  const search = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const q = url.searchParams.get("q") ?? "";
    const view = url.searchParams.get("viewbox")?.split(",").map(Number);
    const box = view ? Math.round(((view[2] - view[0]) / 2) * 100) / 100 : null;
    asked.push({ q, box });
    let rows: unknown[] = [];
    // What the real search answers to these words alone (looked up on 2026-11-23).
    if (q === "beach" && box === null) rows = [row("Beach, Golden Valley County, North Dakota, United States", 46.918, -104.004, 0.45, "boundary")];
    if (q === "beach" && box === 0.04) rows = [row("Narrow Neck Beach, Devonport", -36.8140, 174.8040, 0.1, "natural"), row("Duders Beach, Devonport", -36.8330, 174.8075, 0.1, "natural")];
    if (q === "Paris" && box === null) rows = [row("Paris, Île-de-France, France", 48.8589, 2.32, 0.9, "boundary")];
    if (q === "Eiffel Tower" && box === null) rows = [row("Tour Eiffel, Paris, France", 48.8583, 2.2945, 0.62, "man_made")];
    if (q === "Devonport" && box === null) rows = [row("Devonport, Tasmania, Australia", -41.18, 146.35, 0.48, "boundary")];
    if (q === "Devonport" && box === 0.04) rows = [row("Devonport, Devonport-Takapuna, Auckland", -36.8315, 174.7960, 0.4, "place"), row("Devonport Road", -36.82, 174.79, 0.1, "highway")];
    if (q === "Hamilton" && box === null) rows = [row("Hamilton, Ontario, Canada", 43.2557, -79.8711, 0.58, "boundary")];
    if (q === "Hamilton" && (box === 0.04 || box === 0.25)) rows = [row("Hamilton Road, Herne Bay, Auckland", -36.845, 174.735, 0.1, "highway")];
    if (q === "Hamilton" && box === 3) rows = [row("Hamilton, Waikato, New Zealand", -37.7879, 175.2815, 0.5, "boundary"), row("Hamilton Road, Herne Bay, Auckland", -36.845, 174.735, 0.1, "highway")];
    if (q === "Sky Tower" && box === null) rows = [row("Sky Tower, Wrocław, Poland", 51.094, 17.019, 0.35, "landuse")];
    if (q === "Sky Tower" && box === 0.25) rows = [row("Sky Tower, Victoria Street West, Auckland", -36.8485, 174.7622, 0.43, "man_made")];
    if (q === "Timbuktu" && box === null) rows = [row("Tombouctou, Mali", 16.7719, -3.0087, 0.5, "place")];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(rows));
  });
  await new Promise<void>((r) => search.listen(0, r));
  process.env.EARTHWALK_NOMINATIM_URL = `http://localhost:${(search.address() as AddressInfo).port}`;
  try {
    const { geocodeAround } = await import("../src/geocode.ts");
    const go = async (words: string) => { asked.length = 0; return geocodeAround(words, HERE.lat, HERE.lon); };

    // "the beach": the nearest beach, a few hundred metres off, and not the town in North Dakota.
    assert.equal((await go("the beach"))?.name, "Duders Beach, Devonport");
    assert.deepEqual(asked, [{ q: "beach", box: null }, { q: "beach", box: 0.04 }], "asked without its \"the\": the world, then close by");
    assert.equal((await go("Beach"))?.name, "Duders Beach, Devonport");
    assert.equal(asked.length, 0, "and the search is not troubled twice from the same spot");

    // Known the world over: that place, wherever it is asked for, in one question.
    assert.equal((await go("Paris"))?.lat, 48.8589);
    assert.equal((await go("the Eiffel Tower"))?.lat, 48.8583);
    assert.deepEqual(asked, [{ q: "Eiffel Tower", box: null }]);

    // A suburb here beats a better known town of the same name abroad.
    assert.equal((await go("Devonport"))?.name, "Devonport, Devonport-Takapuna, Auckland");
    // A name of several words that is close by (within 25 km), not its namesake in Poland.
    assert.equal((await go("Sky Tower"))?.name, "Sky Tower, Victoria Street West, Auckland");
    // A town's name that only a street shares close by: the town down the road, not the street, and not the one in Canada.
    assert.equal((await go("Hamilton"))?.name, "Hamilton, Waikato, New Zealand");
    assert.deepEqual(asked.map((a) => a.box), [null, 0.04, 0.25, 3]);
    // Nothing of the name within reach: the world's.
    assert.equal((await go("Timbuktu"))?.name, "Tombouctou, Mali");
    // Nothing anywhere, nothing asked, and a position typed in.
    assert.equal(await go("Atlantis"), null);
    assert.equal(await go("   "), null);
    assert.deepEqual(await go("48.8583, 2.2945"), { name: "48.85830, 2.29450", lat: 48.8583, lon: 2.2945 });
    assert.equal(asked.length, 0);
  } finally {
    search.close();
  }
});

test("the place search route looks round the asker when told where they are", async () => {
  const calls: string[] = [];
  const { createApp } = await import("../src/app.ts"); // (not at the top: geocode.ts must not be loaded before the stand-in above is up)
  const app = createApp({
    readCache: async () => null,
    writeCache: async () => undefined,
    findPlace: async (q) => { calls.push(`anywhere:${q}`); return { name: "far", lat: 1, lon: 2 }; },
    findAround: async (q, lat, lon) => { calls.push(`around:${q}@${lat},${lon}`); return q === "nowhere" ? null : { name: "near", lat: 3, lon: 4 }; },
  });
  await new Promise<void>((r) => app.server.listen(0, r));
  const base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/v1/geocode?q=the%20beach&lat=-36.83&lon=174.79`)).json(), { name: "near", lat: 3, lon: 4 });
    assert.deepEqual(await (await fetch(`${base}/v1/geocode?q=the%20beach`)).json(), { name: "far", lat: 1, lon: 2 }, "an older game, which does not say where it is, is answered as before");
    assert.equal((await fetch(`${base}/v1/geocode?q=nowhere&lat=1&lon=2`)).status, 404);
    assert.deepEqual(await (await fetch(`${base}/v1/geocode?q=x&lat=91&lon=0`)).json(), { name: "far", lat: 1, lon: 2 }, "a position that is nowhere on Earth is not used");
    assert.deepEqual(calls, ["around:the beach@-36.83,174.79", "anywhere:the beach", "around:nowhere@1,2", "anywhere:x"]);
  } finally {
    app.server.close();
  }
});
