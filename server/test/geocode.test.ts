import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// The place search is a public service: here a stand-in answers for it, so nothing leaves this computer.
// (It has to be up before geocode.ts is loaded, which reads its address once.)
test("a place by name is looked for close by first, and of what is found there the nearest is taken", async () => {
  const asked: { q: string; box: number | null }[] = [];
  const HERE = { lat: -36.8312, lon: 174.7965 };
  const row = (display_name: string, lat: number, lon: number) => ({ display_name, lat: String(lat), lon: String(lon) });
  const search = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const q = url.searchParams.get("q") ?? "";
    const view = url.searchParams.get("viewbox")?.split(",").map(Number);
    const box = view ? Math.round(((view[2] - view[0]) / 2) * 100) / 100 : null;
    asked.push({ q, box });
    let rows: unknown[] = [];
    if (q === "beach" && box === 0.04) rows = [row("Narrow Neck Beach, Devonport", -36.8140, 174.8040), row("Cheltenham Beach, Devonport", -36.8247, 174.8105), row("Duders Beach, Devonport", -36.8330, 174.8075)];
    // (Asked for the whole region, the search hands back whichever beaches it likes, none of them close.)
    if (q === "beach" && box === 0.25) rows = [row("O'Neills Beach, Takapuna", -36.7800, 174.7790), row("Palm Beach, Waiheke", -36.7800, 175.0400)];
    if (q === "Sky Tower" && box === 0.25) rows = [row("Sky Tower, Victoria Street West, Auckland", -36.8485, 174.7622)];
    if (q === "Eiffel Tower" && box === null) rows = [row("Tour Eiffel, Paris, France", 48.8583, 2.2945)];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(rows));
  });
  await new Promise<void>((r) => search.listen(0, r));
  process.env.EARTHWALK_NOMINATIM_URL = `http://localhost:${(search.address() as AddressInfo).port}`;
  try {
    const { geocodeNear, NEAR_BOXES } = await import("../src/geocode.ts");
    assert.deepEqual(NEAR_BOXES, [0.04, 0.25]);

    // The beach down the road: found in the first, small search, and the nearest of the three there.
    assert.equal((await geocodeNear("beach", HERE.lat, HERE.lon))?.name, "Duders Beach, Devonport");
    assert.deepEqual(asked, [{ q: "beach", box: 0.04 }], "one question, about four kilometres each way");
    // Asked again from the same spot, the search is not troubled again.
    assert.equal((await geocodeNear("beach", HERE.lat + 0.001, HERE.lon))?.name, "Duders Beach, Devonport");
    assert.equal(asked.length, 1);

    // Something that is not close by: the region is asked next.
    asked.length = 0;
    assert.equal((await geocodeNear("Sky Tower", HERE.lat, HERE.lon))?.name, "Sky Tower, Victoria Street West, Auckland");
    assert.deepEqual(asked.map((a) => a.box), [0.04, 0.25]);

    // Something on the far side of the world: anywhere, last of all. And nothing at all is null.
    asked.length = 0;
    assert.equal((await geocodeNear("Eiffel Tower", HERE.lat, HERE.lon))?.lat, 48.8583);
    assert.deepEqual(asked.map((a) => a.box), [0.04, 0.25, null]);
    assert.equal(await geocodeNear("Atlantis", HERE.lat, HERE.lon), null);
    assert.equal(await geocodeNear("  ", HERE.lat, HERE.lon), null);
  } finally {
    search.close();
  }
});
