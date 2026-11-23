import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { compareVersions, NEWS, newsSince } from "../src/news.ts";

test("what is new: notes for every release, in order, short enough to read on a card", () => {
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
  assert.ok(compareVersions(NEWS[0].version, version) >= 0, `the release notes stop at ${NEWS[0].version}: write what is new in ${version} at the top of src/news.ts`);
  for (let i = 0; i < NEWS.length; i++) {
    const entry = NEWS[i];
    assert.match(entry.version, /^\d+\.\d+\.\d+$/);
    assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(entry.title.length > 5 && entry.title.length <= 60, entry.title);
    assert.ok(entry.items.length >= 1 && entry.items.length <= 8, `${entry.version}: a handful of things, not a list of everything`);
    for (const item of entry.items) assert.ok(item.text.length > 10 && item.text.length <= 160, item.text);
    if (i > 0) assert.ok(compareVersions(NEWS[i - 1].version, entry.version) > 0, "newest first");
  }
});

test("what is new: only what came after the version last seen", () => {
  assert.ok(compareVersions("0.2.9", "0.2.10") < 0 && compareVersions("0.3.0", "0.2.99") > 0 && compareVersions("0.2.4", "0.2.4") === 0);
  const all = [
    { version: "0.3.1", date: "2026-01-03", title: "Third thing", items: [{ text: "Something new again" }] },
    { version: "0.3.0", date: "2026-01-02", title: "Second thing", items: [{ text: "Something new" }] },
    { version: "0.2.9", date: "2026-01-01", title: "First thing", items: [{ text: "Something to begin with" }] },
  ];
  assert.deepEqual(newsSince("0.2.9", 3, all).news.map((e) => e.version), ["0.3.1", "0.3.0"]);
  assert.deepEqual(newsSince("0.3.1", 3, all), { latest: "0.3.1", news: [] }, "nothing new: nothing to show");
  assert.deepEqual(newsSince("0.1.0", 2, all).news.map((e) => e.version), ["0.3.1", "0.3.0"], "at most so many, the newest");
  assert.deepEqual(newsSince(null, 2, all).news.map((e) => e.version), ["0.3.1", "0.3.0"], "asked for with no version: the newest");
  assert.deepEqual(newsSince("nonsense", 1, all).news.map((e) => e.version), ["0.3.1"], "a version that is not one counts as none");
});

test("what is new: the server hands the notes out to those with the code", async () => {
  const app = createApp({ accessCode: "sesame" });
  await new Promise<void>((r) => app.server.listen(0, r));
  try {
    const base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${base}/v1/news`)).status, 401);
    const got = await (await fetch(`${base}/v1/news?since=${NEWS[1].version}`, { headers: { Authorization: "Bearer sesame" } })).json() as { latest: string; news: { version: string }[] };
    assert.equal(got.latest, NEWS[0].version);
    assert.deepEqual(got.news.map((e) => e.version), [NEWS[0].version]);
  } finally {
    app.close();
  }
});
