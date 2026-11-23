import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { Journals, type JournalView } from "../src/journal.ts";
import { GuestDirectory } from "../src/people.ts";
import { type JournalKeeper, Rooms } from "../src/rooms.ts";
import { judge, LEAD_MS, lesson, TRICK_COINS, TRICKS, tricksView } from "../src/tricks.ts";

type Msg = Record<string, any>;

test("a lesson: uneven beats, marked kindly, and no reward for hammering the key", () => {
  assert.equal(new Set(TRICKS.map((t) => t.id)).size, TRICKS.length);
  for (const [i, t] of TRICKS.entries()) {
    if (i) assert.ok(t.beats >= TRICKS[i - 1].beats && t.slackMs < TRICKS[i - 1].slackMs, `${t.id} is harder than the one before`);
    const beats = lesson(t, 12345 + i);
    assert.deepEqual(lesson(t, 12345 + i), beats);
    assert.equal(beats.length, t.beats);
    assert.equal(beats[0], LEAD_MS);
    for (let k = 1; k < beats.length; k++) assert.ok(beats[k] - beats[k - 1] >= 650 && beats[k] - beats[k - 1] <= 1250);
    assert.ok(beats.every((b, k) => k === 0 || b - beats[k - 1] > t.slackMs), "a press on one beat is never taken for the next");
    // On the beat, a little off it, one slip, two slips, a flurry, nothing at all.
    assert.deepEqual(judge(t, beats, beats), { hits: t.beats, of: t.beats, passed: true });
    assert.equal(judge(t, beats, beats.map((b, k) => b + (k % 2 ? 1 : -1) * (t.slackMs - 5))).passed, true);
    assert.deepEqual(judge(t, beats, beats.slice(1)), { hits: t.beats - 1, of: t.beats, passed: true });
    assert.equal(judge(t, beats, beats.slice(2)).passed, false);
    assert.equal(judge(t, beats, beats.map((b) => b + t.slackMs + 40)).passed, false);
    const flurry = Array.from({ length: 40 }, (_, k) => LEAD_MS - 300 + k * 200);
    assert.equal(judge(t, beats, flurry).passed, false);
    assert.deepEqual(judge(t, beats, []), { hits: 0, of: t.beats, passed: false });
  }
  assert.notDeepEqual(lesson(TRICKS[3], 1), lesson(TRICKS[3], 2));
  assert.deepEqual(tricksView(["sit"]).next, "spin");
  assert.deepEqual(tricksView(TRICKS.map((t) => t.id)).next, null);
});

test("the journal: tricks are taught in order to the companion at one's side, and each kind keeps its own", async () => {
  const journals = new Journals({});
  const told: string[] = [];
  journals.listen((_key, news) => { if (news.kind === "trick") told.push(`${news.title}. ${news.text}`); });
  await journals.joined("a", null, "family");
  let v = journals.view("a") as JournalView;
  assert.deepEqual([v.tricks.pet, v.tricks.next, v.tricks.all.length, v.tricks.coins], [null, "sit", TRICKS.length, TRICK_COINS]);
  assert.deepEqual([journals.lessonFor("a", "sit"), journals.lessonFor("a", "nonsense"), journals.learnTrick("a", "sit"), journals.knowsTrick("a", "sit")], ["nopet", "unknown", false, false]);
  // Two riddles answered: a cow and a squirrel to keep them company.
  journals.talked("a", 50, "cow", "Buttercup", "", "Moo.");
  journals.talked("a", 51, "tree", "Oakley", "", "Rustle.");
  assert.equal(journals.setPet("a", "cow"), true);
  assert.deepEqual([journals.lessonFor("a", "sit"), journals.lessonFor("a", "spin"), journals.learnTrick("a", "spin")], ["ok", "order", false]);
  const coins = (journals.view("a") as JournalView).coins;
  assert.deepEqual([journals.learnTrick("a", "sit"), journals.learnTrick("a", "sit"), journals.lessonFor("a", "sit"), journals.lessonFor("a", "spin"), journals.knowsTrick("a", "sit"), journals.knowsTrick("a", "spin")], [true, false, "known", "ok", true, false]);
  v = journals.view("a") as JournalView;
  assert.deepEqual([v.coins, v.tricks.pet, v.tricks.next, v.tricks.all.filter((t) => t.known).map((t) => t.id), v.stamps.find((s) => s.id === "tricks")!.have], [coins + TRICK_COINS, "cow", "spin", ["sit"], 1]);
  assert.deepEqual(told, [`Your cow has learnt: Sit up. ${TRICK_COINS} coins. It will do it whenever you ask (K). Next to teach: Spin`]);
  // Another companion starts from the beginning; the cow has not forgotten.
  assert.equal(journals.setPet("a", "squirrel"), true);
  assert.deepEqual([journals.knowsTrick("a", "sit"), journals.lessonFor("a", "sit"), (journals.view("a") as JournalView).tricks.next], [false, "ok", "sit"]);
  assert.equal(journals.setPet("a", "cow"), true);
  assert.equal(journals.knowsTrick("a", "sit"), true);
  await journals.close();
});

test("in a room: a lesson is set, marked from the presses, and a trick that is known is shown to everybody", async () => {
  const known: string[] = [];
  const journal: JournalKeeper = {
    listen: () => {}, joined: async () => {}, left: () => {}, moved: () => {}, rode: () => {}, talked: () => {}, view: () => ({ tricks: known }),
    petOf: () => "cow",
    lessonFor: (_key, id) => (known.includes(id) ? "known" : id === "sit" || (id === "spin" && known.includes("sit")) ? "ok" : id === "dance" ? "order" : "unknown"),
    learnTrick: (_key, id) => (known.push(id), true),
    knowsTrick: (_key, id) => known.includes(id),
  };
  const rooms = new Rooms(new GuestDirectory(""), { journal, quickLessons: true });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => rooms.wss.handleUpgrade(req, socket, head, (ws) => rooms.wss.emit("connection", ws, req)));
  await new Promise<void>((r) => server.listen(0, r));
  const url = `ws://localhost:${(server.address() as AddressInfo).port}/v1/ws`;
  const join = async (name: string) => {
    const ws = new WebSocket(url);
    const inbox: Msg[] = [];
    ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ t: "hello", name, room: "family", avatar: "fox" }));
    const next = async (t: string, ok: (m: Msg) => boolean = () => true): Promise<Msg> => {
      for (let i = 0; i < 300; i++) {
        const at = inbox.findIndex((m) => m.t === t && ok(m));
        if (at >= 0) return inbox.splice(at, 1)[0];
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for "${t}"`);
    };
    const welcome = await next("welcome");
    return { ws, inbox, next, id: welcome.id as string, send: (m: Msg) => ws.send(JSON.stringify(m)) };
  };
  try {
    const sam = await join("Sam");
    const kim = await join("Kim");
    await sam.next("pet", (m) => m.id === sam.id); // the cow has come along
    sam.send({ t: "trick", do: "sit" });
    assert.equal((await sam.next("error")).text, "Your companion does not know that trick yet");
    sam.send({ t: "trick", learn: "dance" });
    assert.equal((await sam.next("error")).text, "It has an easier trick to learn first");
    // A lesson that does not come off: nothing learnt, nothing lost, and it can be had again.
    sam.send({ t: "trick", learn: "sit" });
    let set = await sam.next("lesson");
    assert.deepEqual([set.trick, set.name, set.beats.length, set.slack, set.done], ["sit", "Sit up", 3, 380, undefined]);
    sam.send({ t: "trick", presses: [100, 200] });
    assert.deepEqual(await sam.next("lesson"), { t: "lesson", trick: "sit", name: "Sit up", done: true, passed: false, hits: 0, of: 3 });
    assert.deepEqual(known, []);
    sam.send({ t: "trick", presses: set.beats });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(sam.inbox.some((m) => m.t === "lesson"), false, "presses without a lesson are nothing");
    // And one that does: it is learnt, and shown off to everybody at once.
    sam.send({ t: "trick", learn: "sit" });
    set = await sam.next("lesson");
    sam.send({ t: "trick", presses: set.beats.map((b: number) => b + 120) });
    assert.deepEqual([(await sam.next("lesson")).passed, (await sam.next("journal")).journal], [true, { tricks: ["sit"] }]);
    const shown = await kim.next("trick");
    assert.deepEqual([shown.id, shown.sp, shown.trick, typeof shown.thing], [sam.id, "cow", "sit", "number"]);
    sam.send({ t: "trick", learn: "sit" });
    assert.equal((await sam.next("error")).text, "It knows that one already");
    await new Promise((r) => setTimeout(r, 1300));
    sam.send({ t: "trick", do: "sit" });
    assert.equal((await kim.next("trick")).trick, "sit");
    sam.ws.close();
    kim.ws.close();
  } finally {
    for (const client of rooms.wss.clients) client.terminate(); // whatever happened above, nothing is left holding the test open
    server.close();
    rooms.wss.close();
  }
});

test("a real lesson cannot be handed in before its beats have had time to come", async () => {
  const known: string[] = [];
  const journal: JournalKeeper = {
    listen: () => {}, joined: async () => {}, left: () => {}, moved: () => {}, rode: () => {}, talked: () => {}, view: () => null,
    petOf: () => "cow", lessonFor: () => "ok", learnTrick: (_key, id) => (known.push(id), true), knowsTrick: () => false,
  };
  const rooms = new Rooms(new GuestDirectory(""), { journal });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => rooms.wss.handleUpgrade(req, socket, head, (ws) => rooms.wss.emit("connection", ws, req)));
  await new Promise<void>((r) => server.listen(0, r));
  const ws = new WebSocket(`ws://localhost:${(server.address() as AddressInfo).port}/v1/ws`);
  const inbox: Msg[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
  await new Promise<void>((r) => ws.on("open", () => r()));
  const next = async (t: string, ok: (m: Msg) => boolean = () => true): Promise<Msg> => {
    for (let i = 0; i < 300; i++) {
      const at = inbox.findIndex((m) => m.t === t && ok(m));
      if (at >= 0) return inbox.splice(at, 1)[0];
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for "${t}"`);
  };
  try {
    ws.send(JSON.stringify({ t: "hello", name: "Sam", room: "family", avatar: "fox" }));
    await next("welcome");
    await next("pet");
    ws.send(JSON.stringify({ t: "trick", learn: "sit" }));
    const set = await next("lesson");
    ws.send(JSON.stringify({ t: "trick", presses: set.beats }));
    assert.equal((await next("lesson", (m) => m.done)).passed, false, "too soon to have been played");
    assert.deepEqual(known, []);
    ws.close();
  } finally {
    for (const client of rooms.wss.clients) client.terminate(); // whatever happened above, nothing is left holding the test open
    server.close();
    rooms.wss.close();
  }
});
