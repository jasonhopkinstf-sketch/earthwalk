import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, type AppOptions } from "../src/app.ts";

async function start(options: AppOptions) {
  let builds = 0;
  const app = createApp({
    buildChunk: async () => { builds++; return Buffer.from("chunk"); },
    readCache: async () => null,
    writeCache: async () => undefined,
    findPlace: async (q) => (q === "nowhere" ? null : { name: q, lat: 1, lon: 2 }),
    ...options,
  });
  await new Promise<void>((r) => app.server.listen(0, r));
  const base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  return { base, app, builds: () => builds };
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
    assert.equal((await (await fetch(`${s.base}/health`)).json()).codeRequired, false);
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
    assert.equal(s.builds(), 0, "nothing is built for callers without the code");
    assert.equal((await fetch(`${s.base}/v1/chunk/16/1/2?code=otter-42`)).status, 200);
    assert.equal((await fetch(`${s.base}/v1/chunk/16/1/3`, { headers: { Authorization: "Bearer otter-42" } })).status, 200);
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
