import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { ALL_TASKS_COINS, dayNumber, emptyDaily, HATS, RIDDLE_COINS, TASK_COINS, TASKS, tasksFor } from "../src/daily.ts";
import { FileJournalStore, Journals, type JournalView, type StampNews } from "../src/journal.ts";
import { GuestDirectory } from "../src/people.ts";
import { Rooms } from "../src/rooms.ts";

type Msg = Record<string, any>;

function keeper(store: FileJournalStore | null = null) {
  const clock = { now: Date.UTC(2026, 10, 22, 9) };
  const news = new Map<string, StampNews[]>();
  const journals = new Journals({ store, now: () => clock.now, placeDetail: async (lat, lon) => ({ name: `Square ${lat.toFixed(2)} ${lon.toFixed(2)}`, country: "France" }) });
  journals.listen((key, n) => news.set(key, [...(news.get(key) ?? []), n]));
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
  return { journals, clock, news, settle };
}

/** Does enough in the world to finish any task there is: `n` makes the things met new ones each time. */
async function busyDay(k: ReturnType<typeof keeper>, key: string, n: number): Promise<void> {
  const { journals, clock, settle } = k;
  const lat0 = 48.0 + n * 0.3;
  for (const [i, sp] of ["pigeon", "tree", "house", "car", "cat", "cow", "snail"].entries()) journals.talked(key, n * 100 + i + 1, sp, `Friend ${n}-${i}`, "", "Hello.");
  for (let i = 0; i <= 60; i++) { clock.now += 1000; journals.moved(key, lat0 + i * 0.0002, 2.35); }
  await settle();
  journals.rode(key, "horse", 7);
  for (let i = 0; i <= 60; i++) { clock.now += 1000; journals.moved(key, lat0 + 0.012 + i * 0.0002, 2.35); }
  journals.rode(key, null);
  journals.rode(key, "car", 8);
  journals.rode(key, null);
  for (let j = 1; j <= 3; j++) { clock.now += 5000; journals.moved(key, lat0 + 0.03 + j * 0.02, 2.35); await settle(); }
  // And a favour: the flock overhead always wants a hello passed on, to a tree or to a house.
  for (const f of (journals.view(key) as JournalView).favours) journals.dropFavour(key, f.id);
  journals.beforeTalk(key, n * 100 + 50, "bird", "Skye", true);
  journals.beforeTalk(key, n * 100 + 51, "tree", "Old Barkley", false);
  journals.beforeTalk(key, n * 100 + 52, "house", "Number Nine", false);
}

test("a day has three tasks, one from each shelf, the same for everyone, and other days have others", () => {
  const today = tasksFor(20000);
  assert.equal(today.length, 3);
  today.forEach((t, i) => assert.ok(TASKS[i].includes(t), "one from each shelf"));
  assert.deepEqual(tasksFor(20000).map((t) => t.id), today.map((t) => t.id));
  const sets = new Set<string>();
  for (let day = 20000; day < 20030; day++) sets.add(tasksFor(day).map((t) => t.id).join());
  assert.ok(sets.size >= 10, `a month has many different days (${sets.size})`);
  // Nothing is done before anything is done, and every task has somewhere to get to.
  for (const t of TASKS.flat()) assert.ok(t.goal > 0 && t.have(emptyDaily(1)) === 0 && t.text.length > 5, t.id);
  assert.equal(new Set(TASKS.flat().map((t) => t.id)).size, TASKS.flat().length, "no two tasks share an id");
  // A day turns at the player's own midnight: one in the afternoon in Auckland is already tomorrow by UTC's reckoning.
  assert.equal(dayNumber(Date.UTC(2026, 10, 22, 12), 13 * 60), dayNumber(Date.UTC(2026, 10, 22, 12)) + 1);
  assert.equal(dayNumber(Date.UTC(2026, 10, 22, 3), -8 * 60), dayNumber(Date.UTC(2026, 10, 22, 3)) - 1);
});

test("tasks are done by getting about, pay coins, and all three win a hat; tomorrow starts afresh", async () => {
  const k = keeper();
  const { journals, clock, news } = k;
  await journals.joined("a", null, "family");
  let v = journals.view("a") as JournalView;
  assert.deepEqual([v.coins, v.today.all, v.today.fullDays, v.hat], [0, false, 0, null]);
  assert.deepEqual(v.today.tasks.map((t) => [t.done, t.have]), [[false, 0], [false, 0], [false, 0]]);
  assert.deepEqual(v.today.tasks.map((t) => t.text), tasksFor(dayNumber(clock.now)).map((t) => t.text));
  const first = news.get("a")!.find((n) => n.kind === "task")!;
  assert.equal(first.title, "Three tasks for today");
  for (const t of v.today.tasks) assert.ok(first.text.includes(t.text), "the newcomer is told what they are");
  assert.ok(v.hats.length === HATS.length && v.hats.every((h) => !h.owned) && v.hats.find((h) => h.id === "crown")!.price === null);

  await busyDay(k, "a", 1);
  v = journals.view("a") as JournalView;
  assert.deepEqual(v.today.tasks.map((t) => [t.done, t.have === t.goal]), [[true, true], [true, true], [true, true]]);
  assert.deepEqual([v.today.all, v.today.fullDays], [true, 1]);
  const solved = v.riddles.filter((r) => r.solved).length;
  assert.ok(solved >= 4, "talking to a cow, a tree, a house and a car answered four riddles on the way");
  assert.equal(v.favoursDone, 1);
  assert.equal(v.coins, 3 * TASK_COINS + ALL_TASKS_COINS + solved * RIDDLE_COINS + 15, "three tasks, the day, the riddles, and one hello passed on");
  const told = news.get("a")!;
  assert.equal(told.filter((n) => n.kind === "task" && n.title === "Task done").length, 3, "each task is announced once");
  assert.ok(told.some((n) => n.title === "All three tasks done!") && told.some((n) => n.kind === "prize" && /Explorer's hat/.test(n.title)));
  assert.ok(v.hats.find((h) => h.id === "explorer")!.owned, "the first full day wins the explorer's hat");

  // Hats: bought with coins and worn at once; prizes cannot be bought; nobody wears what they do not own.
  const before = v.coins;
  assert.deepEqual([journals.buyHat("a", "cap"), journals.hatOf("a")], ["ok", "cap"]);
  assert.deepEqual([journals.buyHat("a", "crown"), journals.buyHat("a", "sombrero"), journals.wearHat("a", "wizard")], ["prize", "unknown", false]);
  assert.deepEqual([journals.wearHat("a", "explorer"), journals.hatOf("a"), journals.wearHat("a", null), journals.hatOf("a")], [true, "explorer", true, null]);
  assert.deepEqual([journals.buyHat("a", "cap"), (journals.view("a") as JournalView).coins], ["ok", before - 30], "a hat is paid for once");
  // Buying the cheaper ones for as long as the coins last leaves too little for the dearest.
  for (const id of ["bobble", "party", "straw", "chef", "cowboy", "top", "flowers", "pirate"]) journals.buyHat("a", id);
  assert.equal(journals.buyHat("a", "wizard"), "poor", "this player cannot afford everything");
  journals.wearHat("a", "cap");
  assert.ok((journals.view("a") as JournalView).coins >= 0, "coins never go below nothing");

  // More of the same today earns nothing more.
  const coins = (journals.view("a") as JournalView).coins;
  journals.talked("a", 999, "pigeon", "Late", "", "Coo.");
  assert.equal((journals.view("a") as JournalView).coins, coins);

  // Tomorrow: three tasks again, nothing carried over, and the full day still counted.
  clock.now += 24 * 3600_000;
  v = journals.view("a") as JournalView;
  assert.deepEqual(v.today.tasks.map((t) => [t.done, t.have]), [[false, 0], [false, 0], [false, 0]]);
  assert.deepEqual([v.today.all, v.today.fullDays, v.hat], [false, 1, "cap"]);
  // A week of full days wins the crown.
  for (let day = 2; day <= 7; day++) {
    if (day > 2) clock.now += 24 * 3600_000;
    await busyDay(k, "a", day);
    assert.equal((journals.view("a") as JournalView).today.fullDays, day);
    assert.equal((journals.view("a") as JournalView).hats.find((h) => h.id === "crown")!.owned, day >= 7);
  }
  await journals.close();
});

test("coins and hats are kept with the journal, and the day turns at the player's own midnight", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-daily-"));
  try {
    const first = keeper(new FileJournalStore(dir));
    await first.journals.joined("m1", "abc123", "family", 13 * 60);
    await busyDay(first, "m1", 1);
    assert.equal(first.journals.buyHat("m1", "party"), "ok");
    const had = (first.journals.view("m1") as JournalView).coins;
    first.journals.left("m1");
    await first.journals.close();

    const second = keeper(new FileJournalStore(dir));
    const offline = await second.journals.viewPerson("abc123");
    assert.deepEqual([offline.coins, offline.hat, offline.today.fullDays], [had, "party", 1]);
    // 09:00 UTC is 22:00 in Auckland: the same day there, so its tasks are still done.
    assert.equal(offline.today.all, true);
    // Three hours on it is past midnight there, though not by the server's clock.
    second.clock.now += 3 * 3600_000;
    await second.journals.joined("m2", "abc123", "family", 13 * 60);
    assert.equal(second.journals.hatOf("m2"), "party");
    const next = second.journals.view("m2") as JournalView;
    assert.deepEqual([next.today.all, next.today.tasks.some((t) => t.done), next.coins], [false, false, had]);
    assert.ok(second.news.get("m2")!.some((n) => n.title === "Three tasks for today"));
    await second.journals.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("in a room: a hat bought is seen by everyone, and by those who come later", async () => {
  const { journals } = keeper();
  const rooms = new Rooms(new GuestDirectory(""), { journal: journals });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => rooms.wss.handleUpgrade(req, socket, head, (ws) => rooms.wss.emit("connection", ws, req)));
  await new Promise<void>((r) => server.listen(0, r));
  const url = `ws://localhost:${(server.address() as AddressInfo).port}/v1/ws`;
  const join = async (name: string) => {
    const ws = new WebSocket(url);
    const inbox: Msg[] = [];
    ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ t: "hello", name, room: "family", avatar: "fox", tz: 60 }));
    const next = async (t: string): Promise<Msg> => {
      for (let i = 0; i < 300; i++) {
        const at = inbox.findIndex((m) => m.t === t);
        if (at >= 0) return inbox.splice(at, 1)[0];
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for "${t}"`);
    };
    const welcome = await next("welcome");
    return { ws, inbox, next, welcome, id: welcome.id as string };
  };
  try {
    const mum = await join("Mum");
    const kid = await join("Kid");
    await new Promise((r) => setTimeout(r, 50));
    mum.ws.send(JSON.stringify({ t: "hat", buy: "cap" }));
    assert.equal((await mum.next("error")).code, "poor", "no coins yet");
    // Two riddles answered pay for a cap.
    mum.ws.send(JSON.stringify({ t: "talk", thing: 42, sp: "cow" }));
    await mum.next("say");
    await new Promise((r) => setTimeout(r, 1300)); // nobody talks faster than this
    mum.ws.send(JSON.stringify({ t: "talk", thing: 43, sp: "tree" }));
    await mum.next("say");
    mum.ws.send(JSON.stringify({ t: "hat", buy: "cap" }));
    assert.deepEqual(await kid.next("hat"), { t: "hat", id: mum.id, hat: "cap" });
    assert.deepEqual(await mum.next("hat"), { t: "hat", id: mum.id, hat: "cap" });
    mum.ws.send(JSON.stringify({ t: "hat", buy: "crown" }));
    assert.equal((await mum.next("error")).code, "locked");
    mum.ws.send(JSON.stringify({ t: "hat", wear: "wizard" }));
    assert.equal((await mum.next("error")).code, "locked");
    kid.ws.send(JSON.stringify({ t: "hat", wear: "cap" }));
    assert.equal((await kid.next("error")).code, "locked", "the hat is its buyer's alone");

    const late = await join("Gran");
    assert.equal(late.welcome.peers.find((p: Msg) => p.id === mum.id).hat, "cap", "a newcomer sees it too");
    assert.equal(late.welcome.peers.find((p: Msg) => p.id === kid.id).hat, undefined);
    mum.ws.send(JSON.stringify({ t: "hat" }));
    assert.deepEqual(await late.next("hat"), { t: "hat", id: mum.id }, "and sees it taken off");
    mum.ws.send(JSON.stringify({ t: "journal" }));
    const mine = (await mum.next("journal")).journal as JournalView;
    // Two riddles paid for the cap; what is left is whatever today's tasks paid for those two chats.
    assert.deepEqual([mine.coins, mine.hat, mine.hats.find((h) => h.id === "cap")!.owned], [mine.today.tasks.filter((t) => t.done).length * TASK_COINS, null, true]);
    for (const p of [mum, kid, late]) p.ws.close();
  } finally {
    rooms.close();
    server.close();
    await journals.close();
  }
});
