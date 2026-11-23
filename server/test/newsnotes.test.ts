import { test } from "node:test";
import assert from "node:assert/strict";
import { ELSEWHERE, newsCard } from "../public/js/newsnotes.js";
import { NEWS } from "../src/news.ts";

const SAMPLE = [
  { version: "0.3.1", date: "2026-12-01", title: "Mixed", items: [{ text: "Both games have this." }, { text: "Windows only.", in: "windows" }, { text: "Browser only.", in: "browser" }] },
  { version: "0.3.0", date: "2026-11-30", title: "All in the other game", items: [{ text: "One.", in: "windows" }, { text: "Two.", in: "windows" }] },
  { version: "0.2.9", date: "2026-11-29", title: "All in this game", items: [{ text: "Three.", in: "browser" }] },
];

test("the browser's card says which things only the Windows game has so far, and nothing beside its own", () => {
  const [mixed, other, own] = newsCard(SAMPLE, "browser");
  assert.deepEqual(mixed.items, [
    { text: "Both games have this.", note: "" },
    { text: "Windows only.", note: "In the Windows game so far; coming to this one." },
    { text: "Browser only.", note: "" },
  ]);
  assert.equal(mixed.note, "");
  // A release that is all in the other game says so once, under its title, not on every line.
  assert.equal(other.note, ELSEWHERE.windows);
  assert.ok(other.items.every((item) => item.note === ""));
  assert.equal(own.note, "");
  assert.deepEqual(own.items, [{ text: "Three.", note: "" }]);
});

test("the same notes read the other way round in the Windows game", () => {
  const [mixed, other] = newsCard(SAMPLE, "windows");
  assert.deepEqual(mixed.items.map((item) => item.note), ["", "", ELSEWHERE.browser]);
  assert.equal(other.note, "");
});

test("somebody new is told of the newest things only; an answer that is not notes is nothing to tell", () => {
  assert.deepEqual(newsCard(SAMPLE, "browser", true).map((e) => e.version), ["0.3.1"]);
  assert.deepEqual(newsCard(SAMPLE).map((e) => e.version), ["0.3.1", "0.3.0", "0.2.9"]);
  assert.deepEqual(newsCard(null), []);
  assert.deepEqual(newsCard([{ version: "1" }, null, { version: "2", title: "t", items: [null, { text: 3 }, { text: "kept" }] }]), [{ version: "2", title: "t", note: "", items: [{ text: "kept", note: "" }] }]);
});

test("the notes the server really has make a card", () => {
  const card = newsCard(NEWS.slice(0, 3));
  assert.equal(card.length, Math.min(3, NEWS.length));
  for (const entry of card) {
    assert.ok(entry.title && entry.version && entry.items.length > 0);
    for (const item of entry.items) assert.ok(item.note === "" || item.note === ELSEWHERE.windows);
  }
});
