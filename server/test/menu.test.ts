import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { ACTIONS, actionGroups, findAction, GUIDE_QUESTIONS, quickReplies, type Action } from "../public/js/actions.js";
import { HELLO_ASKS } from "../src/guide.ts";

// The menu of everything is one table in each game. The two are kept alike here: the same names for
// things, the same words, the same keys. What is allowed to differ is written down, with why.
const WINDOWS_TABLE = new URL("../../game/Source/EarthWalk/EarthMenu.cpp", import.meta.url);
const FIELDS = ["id", "group", "title", "about", "key", "command", "ask", "askHint", "strip"] as const;

/** Things in the Windows menu that the browser game has no use for, or does not have yet. */
const NOT_IN_BROWSER: Record<string, string> = {
  quit: "a browser tab is closed, not quit",
};
/**
 * Things in the browser's menu that are meant for both games, in the place they are to have in both, and that the
 * Windows game has not got yet. When its table gains the row (same id, words and key), this test says to take it off.
 */
const NOT_IN_WINDOWS_YET: Record<string, string> = {};
/** Fields that differ on purpose. */
const DIFFERENT: Record<string, Partial<Record<(typeof FIELDS)[number], string>>> = {
  house: { command: "\"/house\" is the house of your own in the browser, so finding a door is \"/houses\"" },
  login: { about: "the Windows words say \"Opens your browser\", which a browser need not be told" },
};

function windowsTable(): Action[] {
  const rows: Action[] = [];
  for (const line of readFileSync(WINDOWS_TABLE, "utf8").split("\n")) {
    if (!/^\s*\{ TEXT\("/.test(line)) continue;
    const texts = [...line.matchAll(/TEXT\("((?:[^"\\]|\\.)*)"\)/g)].map((m) => m[1].replace(/\\"/g, "\""));
    assert.equal(texts.length, FIELDS.length, `a row of ${FIELDS.length} texts: ${line.trim()}`);
    rows.push(Object.fromEntries(FIELDS.map((f, i) => [f, texts[i]])) as unknown as Action);
  }
  return rows;
}

test("every action has a name of its own, a group, a title and a line of what it does", () => {
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const a of ACTIONS) {
    assert.ok(/^[a-z]+$/.test(a.id), `a plain name: ${a.id}`);
    assert.ok(!ids.has(a.id), `${a.id} is there once`);
    ids.add(a.id);
    assert.ok(a.group && a.title && a.about, `${a.id} says what it is`);
    assert.ok(a.about.length <= 130, `${a.id}: one line, not a paragraph`);
    if (a.key) {
      assert.ok(!keys.has(a.key), `the ${a.key} key does one thing`);
      keys.add(a.key);
    }
    assert.equal(!!a.ask, !!a.askHint, `${a.id}: a question comes with an example of an answer`);
    if (a.ask) assert.ok(a.title.endsWith("..."), `${a.id}: a title ending in ... says it will ask something first`);
    assert.equal(findAction(a.id), a);
  }
  assert.equal(findAction("nothing"), null);
  // M and Z are the little map and the strip of buttons, and nothing else.
  assert.equal(findAction("map")?.key, "M");
  assert.equal(findAction("strip")?.key, "Z");
});

test("the groups come in one piece each, in the order the menu shows them", () => {
  const groups = actionGroups();
  assert.deepEqual(groups.map((g) => g.name), ["Go somewhere", "Ride and drive", "Talk", "Play", "Me", "The game"]);
  assert.equal(groups.reduce((n, g) => n + g.actions.length, 0), ACTIONS.length);
  // Within a group, what both games have comes first, and the browser's own things after it.
  for (const g of groups) {
    const firstOwn = g.actions.findIndex((a) => a.own);
    if (firstOwn >= 0) assert.ok(g.actions.slice(firstOwn).every((a) => a.own), `${g.name}: the browser's own actions come last`);
  }
});

test("the browser's menu says the same things as the Windows game's", { skip: !existsSync(WINDOWS_TABLE) && "the Windows game's files are not here" }, () => {
  const windows = windowsTable();
  assert.ok(windows.length >= 25, `the Windows table was read: ${windows.length} rows`);
  const shared: string[] = [];
  for (const w of windows) {
    const b = findAction(w.id);
    if (w.id in NOT_IN_BROWSER) {
      assert.equal(b, null, `${w.id} is listed as not in the browser (${NOT_IN_BROWSER[w.id]}), but is there: take it off the list`);
      continue;
    }
    assert.ok(b, `the Windows menu has "${w.title}" (${w.id}) and the browser's has not`);
    assert.ok(!b.own, `${w.id} is in both games, so it is not the browser's own`);
    shared.push(w.id);
    for (const f of FIELDS) {
      if (DIFFERENT[w.id]?.[f]) assert.notEqual(b[f], w[f], `${w.id}.${f} is listed as different, but is the same: take it off the list`);
      else assert.equal(b[f], w[f], `${w.id}: ${f}`);
    }
  }
  // The same order, so that somebody who knows one game finds things in the other.
  assert.deepEqual(ACTIONS.filter((a) => !a.own && !(a.id in NOT_IN_WINDOWS_YET)).map((a) => a.id), shared);
  for (const [id, why] of Object.entries(NOT_IN_WINDOWS_YET)) {
    assert.ok(findAction(id), `${id} is listed as not in the Windows game yet, and is not in the browser's menu either`);
    assert.ok(!windows.some((w) => w.id === id), `${id} is in the Windows game now: take it off the list of what it has not got yet (${why})`);
  }
  for (const a of ACTIONS.filter((x) => x.own)) assert.ok(!windows.some((w) => w.id === a.id), `${a.id} is in the Windows game now: it is no longer the browser's own`);
});

test("the strip of buttons has the few things done most", () => {
  assert.deepEqual(ACTIONS.filter((a) => a.strip).map((a) => a.strip), ["Go to...", "Show me", "Ride", "My car", "Taxi...", "Talk", "Passport"]);
});

test("the guide is one row of the menu, on a key of its own, with questions ready to click", () => {
  const guide = findAction("guide")!;
  assert.deepEqual([guide.group, guide.title, guide.key, guide.command, guide.ask, guide.askHint, guide.strip], ["Talk", "Ask the guide...", "Q", "guide", "What would you like to know?", "where is the nearest station?", ""]);
  // The questions in the box are the ones the server's guide offers when it is said hello to.
  assert.deepEqual(GUIDE_QUESTIONS, HELLO_ASKS);
  // Q is free in the Windows game too: none of its rows has it, and none of the keys its code binds.
  const used = "W A S D C E F G H K M P R T V Z B".split(" ");
  assert.ok(!used.includes(guide.key));
  if (existsSync(WINDOWS_TABLE)) assert.ok(!windowsTable().some((w) => w.key === guide.key && w.id !== "guide"), "no other row of the Windows menu has the Q key");
});

test("things to say in one click fit what is spoken to", () => {
  const labels = (sp: string, riding = false) => quickReplies(sp, riding).map(([label]) => label);
  assert.deepEqual(labels("cow"), ["Follow me", "Come here", "Stay", "Go home", "Do a trick", "Can I help?", "Tell me about here"]);
  assert.deepEqual(labels("horse", true)[0], "Take me to...");
  assert.deepEqual(labels("taxi"), ["Take me to...", "Stay here", "Go home", "Toot!", "Can I help?", "Tell me about here"]);
  assert.deepEqual(labels("tree"), ["Can I help?", "Tell me about here"]);
  assert.deepEqual(labels("house"), ["Can I help?", "Tell me about here"]);
  // "..." is not said: it means the place is asked for first.
  assert.equal(quickReplies("car").find(([label]) => label === "Take me to...")?.[1], "...");
  for (const sp of ["cow", "car", "train", "boat"]) for (const [label, words] of quickReplies(sp)) assert.ok(label && words);
});
