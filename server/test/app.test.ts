import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, type AppOptions } from "../src/app.ts";

async function start(options: AppOptions) {
  let builds = 0;
  let labelBuilds = 0;
  const app = createApp({
    buildChunk: async () => { builds++; return Buffer.from("chunk"); },
    buildLabels: async (x, y) => { labelBuilds++; return Buffer.from(JSON.stringify({ x, y, rev: 1, items: [] })); },
    readCache: async () => null,
    writeCache: async () => undefined,
    findPlace: async (q) => (q === "nowhere" ? null : { name: q, lat: 1, lon: 2 }),
    ...options,
  });
  await new Promise<void>((r) => app.server.listen(0, r));
  const base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  return { base, app, builds: () => builds, labelBuilds: () => labelBuilds };
}

test("without an access code the world is open", async () => {
  const s = await start({});
  try {
    const res = await fetch(`${s.base}/v1/chunk/16/1/2`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "chunk");
    assert.equal((await fetch(`${s.base}/v1/geocode?q=Paris`)).status, 200);
    assert.equal((await fetch(`${s.base}/v1/geocode?q=nowhere`)).status, 404);
    assert.equal((await fetch(`${s.base}/v1/chunk/15/1/2`)).status, 400);
    const labels = await fetch(`${s.base}/v1/labels/16/1/2`);
    assert.equal(labels.status, 200);
    assert.ok(labels.headers.get("content-type")?.startsWith("application/json"));
    assert.deepEqual(await labels.json(), { x: 1, y: 2, rev: 1, items: [] });
    assert.equal((await fetch(`${s.base}/v1/labels/15/1/2`)).status, 400);
    assert.equal(s.labelBuilds(), 1);
    assert.equal((await (await fetch(`${s.base}/health`)).json()).codeRequired, false);
  } finally {
    s.app.close();
  }
});

test("a player can ask where they are, to about a kilometre", async () => {
  const asked: [number, number][] = [];
  const s = await start({ accessCode: "otter-42", placeDetail: async (lat, lon) => { asked.push([lat, lon]); return { name: "Montmartre, Paris", country: "France" }; } });
  try {
    assert.equal((await fetch(`${s.base}/v1/place?lat=48.88671&lon=2.34312`)).status, 401);
    const res = await fetch(`${s.base}/v1/place?lat=48.88671&lon=2.34312`, { headers: { Authorization: "Bearer otter-42" } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { name: "Montmartre, Paris", country: "France" });
    assert.deepEqual(asked, [[48.89, 2.34]], "only the rounded position is looked up");
    assert.equal((await fetch(`${s.base}/v1/place?lat=abc&lon=2`, { headers: { Authorization: "Bearer otter-42" } })).status, 400);
  } finally {
    s.app.close();
  }
});

test("with an access code, world data needs it too", async () => {
  const s = await start({ accessCode: "otter-42" });
  try {
    assert.equal((await fetch(`${s.base}/v1/chunk/16/1/2`)).status, 401);
    assert.equal((await fetch(`${s.base}/v1/chunk/16/1/2?code=wrong`)).status, 401);
    assert.equal((await fetch(`${s.base}/v1/geocode?q=Paris`)).status, 401);
    assert.equal((await fetch(`${s.base}/v1/labels/16/1/2`)).status, 401);
    assert.equal(s.builds(), 0, "nothing is built for callers without the code");
    assert.equal(s.labelBuilds(), 0, "no labels are built for callers without the code");
    assert.equal((await fetch(`${s.base}/v1/chunk/16/1/2?code=otter-42`)).status, 200);
    assert.equal((await fetch(`${s.base}/v1/chunk/16/1/3`, { headers: { Authorization: "Bearer otter-42" } })).status, 200);
    assert.equal((await fetch(`${s.base}/v1/labels/16/1/2`, { headers: { Authorization: "Bearer otter-42" } })).status, 200);
    assert.equal(s.labelBuilds(), 1);
    assert.equal((await fetch(`${s.base}/v1/geocode?q=Paris`, { headers: { Authorization: "Bearer otter-42" } })).status, 200);
    // The page itself and the health check stay public.
    assert.equal((await fetch(`${s.base}/health`)).status, 200);
    assert.equal((await fetch(`${s.base}/viewer.html`)).status, 200);
  } finally {
    s.app.close();
  }
});

test("one caller cannot make the server build without limit", async () => {
  const s = await start({ coldBuildLimit: 3 });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await fetch(`${s.base}/v1/chunk/16/5/${i}`)).status, 200);
    const refused = await fetch(`${s.base}/v1/chunk/16/5/9`);
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get("retry-after"), "30");
    assert.equal(s.builds(), 3);
  } finally {
    s.app.close();
  }
});

test("chunks and labels share one cold-build allowance", async () => {
  const s = await start({ coldBuildLimit: 3 });
  try {
    assert.equal((await fetch(`${s.base}/v1/chunk/16/5/0`)).status, 200);
    assert.equal((await fetch(`${s.base}/v1/chunk/16/5/1`)).status, 200);
    assert.equal((await fetch(`${s.base}/v1/labels/16/5/0`)).status, 200);
    const refused = await fetch(`${s.base}/v1/labels/16/5/1`);
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get("retry-after"), "30");
    assert.equal(s.builds(), 2);
    assert.equal(s.labelBuilds(), 1);
  } finally {
    s.app.close();
  }
});

test("files outside the public folder are not served", async () => {
  const s = await start({});
  try {
    assert.notEqual((await fetch(`${s.base}/..%2Fpackage.json`)).status, 200);
    assert.notEqual((await fetch(`${s.base}/vendor/three/..%2F..%2Fpackage.json`)).status, 200);
    assert.notEqual((await fetch(`${s.base}/%2e%2e/package.json`)).status, 200);
    assert.equal((await fetch(`${s.base}/vendor/three/build/three.module.js`)).status, 200);
  } finally {
    s.app.close();
  }
});
