import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { foodById, FOODS, giftOf, GROUPS, HEALTHY_COINS, LARDER_MAX, menuFor, thanksFood } from "../src/food.ts";
import { Journals, type JournalView } from "../src/journal.ts";
import { GuestDirectory } from "../src/people.ts";
import { type JournalKeeper, Rooms } from "../src/rooms.ts";

type Msg = Record<string, any>;

test("the foods: five kinds of good food and treats, menus by country, and what things give", () => {
  assert.equal(new Set(FOODS.map((f) => f.id)).size, FOODS.length);
  const kinds = GROUPS.map((g) => g.id);
  for (const f of FOODS) assert.ok(f.name && f.price > 0 && f.groups.every((g) => kinds.includes(g)) && new Set(f.groups).size === f.groups.length, f.id);
  for (const g of kinds) assert.ok(FOODS.some((f) => f.groups.length === 1 && f.groups[0] === g), `plain food for ${g}`);
  assert.ok(FOODS.some((f) => f.groups.length === 0) && FOODS.some((f) => f.groups.length === 3), "treats, and meals that fill three hearts");

  // A grocer sells every kind between its shelves; a café sells its country's dishes first, and something everywhere.
  const grocer = menuFor("shop", "Netherlands", 52);
  for (const g of kinds) assert.ok(grocer.some((f) => f.groups.includes(g)), `a shop sells ${g}`);
  assert.deepEqual(menuFor("food", "Japan", 35).slice(0, 2).map((f) => f.id), ["sushi", "ramen"]);
  assert.deepEqual(menuFor("food", "New Zealand", -37).slice(0, 2).map((f) => f.id), ["meatpie", "pavlova"]);
  assert.ok(menuFor("food", null, 0).length >= 4 && menuFor("food", "Nowhere at all", 0).every((f) => foodById(f.id)));
  assert.ok(menuFor("shop", null, 5).some((f) => f.id === "banana") && menuFor("shop", null, 60).some((f) => f.id === "apple"));
  for (const country of ["Japan", "France", "Italy", "United Kingdom", "United States", "India", "China", "Mexico", "Brazil", "Türkiye", "Turkey"]) {
    assert.ok(menuFor("food", country, 30).length > menuFor("food", null, 30).length - 1 && menuFor("food", country, 30).every(Boolean), country);
  }

  // What things give: the same thing gives the same every time; about one tree in three bears fruit.
  assert.deepEqual([giftOf("cow", 7, 52), giftOf("chicken", 7, 52), giftOf("bee", 7, 52), giftOf("boat", 7, 52), giftOf("squirrel", 7, 52), giftOf("sheep", 7, 52), giftOf("car", 7, 52)], ["milk", "egg", "honey", "fish", "nuts", null, null]);
  let fruiting = 0;
  for (let thing = 1; thing <= 600; thing++) {
    const here = giftOf("tree", thing, 52);
    assert.equal(giftOf("tree", thing, 52), here);
    if (here) { fruiting++; assert.ok(["apple", "pear", "plum", "cherries"].includes(here)); }
    assert.equal(giftOf("tree", thing, 2) === null, here === null, "the same trees bear fruit everywhere");
    const hot = giftOf("tree", thing, 2);
    if (hot) assert.ok(["banana", "mango", "coconut", "orange"].includes(hot));
    for (const sp of ["tractor", "house", "rabbit"]) { const got = giftOf(sp, thing, 52); assert.ok(got === null || foodById(got), sp); }
    assert.ok(foodById(thanksFood(thing)));
  }
  assert.ok(fruiting > 150 && fruiting < 250, `about a third of trees (${fruiting} of 600)`);
});

test("the journal: food is given once a day by each thing, eaten into five hearts, and a full day is paid for once", async () => {
  const clock = { now: Date.UTC(2026, 10, 23, 9) };
  const journals = new Journals({ now: () => clock.now, startCoins: 50, placeDetail: async () => ({ name: "Kyoto", country: "Japan" }) });
  const told: string[] = [];
  journals.listen((_key, news) => { if (news.kind === "food") told.push(news.title); });
  await journals.joined("a", null, "family");
  journals.moved("a", 35.01, 135.76);
  await new Promise((r) => setTimeout(r, 20));
  let v = journals.view("a") as JournalView;
  assert.deepEqual([v.food.hearts.map((h) => h.full), v.food.full, v.food.larder, v.food.room, v.food.coinsFull], [[false, false, false, false, false], false, [], LARDER_MAX, HEALTHY_COINS]);
  assert.deepEqual(v.food.hearts.map((h) => h.group), ["fruit", "veg", "grain", "protein", "dairy"]);

  // A cow gives milk once a day; another cow gives more; a sheep has nothing to give.
  journals.talked("a", 11, "cow", "Buttercup", "", "Moo.");
  journals.talked("a", 11, "cow", "Buttercup", "", "Moo.");
  journals.talked("a", 12, "cow", "Daisy", "", "Moo.");
  journals.talked("a", 13, "sheep", "Woolly", "", "Baa.");
  journals.talked("a", 14, "chicken", "Henrietta", "", "Cluck.");
  v = journals.view("a") as JournalView;
  assert.deepEqual(v.food.larder.map((f) => [f.id, f.n]), [["milk", 2], ["egg", 1]]);
  assert.deepEqual(told.splice(0), ["Buttercup gave you a glass of milk", "Daisy gave you a glass of milk", "Henrietta gave you an egg"]);

  // Eating: a heart for each kind, once; nothing to eat, nothing eaten.
  assert.deepEqual([journals.eat("a", "milk"), journals.eat("a", "milk"), journals.eat("a", "sushi"), journals.eat("a", "nonsense"), journals.eat("nobody", "milk")], ["ok", "ok", "none", "none", "none"]);
  v = journals.view("a") as JournalView;
  assert.deepEqual([v.food.hearts.filter((h) => h.full).map((h) => h.group), v.food.larder.map((f) => f.id), journals.pepOf("a")], [["dairy"], ["egg"], false]);
  assert.deepEqual(told.splice(0), ["You ate a glass of milk", "You ate a glass of milk"]);

  // In Japan a café sells sushi and ramen; a grocer does not. Buying costs coins once, and needs them.
  assert.deepEqual(journals.menuOf("a", "food").items.slice(0, 2).map((f) => f.id), ["sushi", "ramen"]);
  assert.equal(journals.menuOf("a", "food").country, "Japan");
  const coins = v.coins;
  assert.deepEqual([journals.buyFood("a", "shop", "sushi"), journals.buyFood("a", "food", "pizza"), journals.buyFood("a", "food", "ramen"), journals.buyFood("a", "shop", "orange")], ["unknown", "unknown", "ok", "ok"]);
  assert.equal((journals.view("a") as JournalView).coins, coins - 18 - 5);
  // Ramen fills three hearts, the orange a fourth, the egg none new: four of five.
  for (const id of ["ramen", "orange", "egg"]) assert.equal(journals.eat("a", id), "ok");
  v = journals.view("a") as JournalView;
  assert.deepEqual([v.food.hearts.map((h) => h.full), v.food.full, journals.pepOf("a")], [[true, true, true, true, true], true, true]);
  assert.ok(told.includes("All five hearts are full!"), told.join(" | "));
  assert.deepEqual([v.food.healthyDays, v.stamps.find((s) => s.id === "healthy")!.have], [1, 1]);
  const paid = v.coins;
  // More food the same day pays nothing more; a treat fills no heart.
  assert.equal(journals.buyFood("a", "food", "cake"), "ok");
  assert.equal(journals.eat("a", "cake"), "ok");
  assert.deepEqual([(journals.view("a") as JournalView).coins, (journals.view("a") as JournalView).food.healthyDays], [paid - 10, 1]);

  // Tomorrow the hearts are empty again, nothing is lost, and the cow gives milk again.
  clock.now += 24 * 3600 * 1000;
  journals.talked("a", 11, "cow", "Buttercup", "", "Moo.");
  v = journals.view("a") as JournalView;
  assert.deepEqual([v.food.hearts.some((h) => h.full), v.food.full, journals.pepOf("a"), v.food.healthyDays, v.food.larder.map((f) => [f.id, f.n])], [false, false, false, 1, [["milk", 1]]]);
  await journals.close();
});

test("the lunch box holds so much and no more", async () => {
  // (A day on which neither cow is hungry: a hungry animal gives nothing.)
  const journals = new Journals({ startCoins: 1000, now: () => Date.UTC(2026, 10, 23, 9) });
  await journals.joined("a", null, "family");
  for (let i = 0; i < LARDER_MAX; i++) assert.equal(journals.buyFood("a", "shop", "bread"), "ok");
  journals.talked("a", 11, "cow", "Buttercup", "", "Moo."); // (a riddle answered, too: coins before the next line)
  const coins = (journals.view("a") as JournalView).coins;
  assert.equal(journals.buyFood("a", "shop", "bread"), "full");
  const v = journals.view("a") as JournalView;
  assert.deepEqual([v.coins, v.food.room, v.food.larder.map((f) => [f.id, f.n])], [coins, 0, [["bread", LARDER_MAX]]], "nothing paid for, and nothing given, that does not fit");
  assert.equal(journals.buyFood("a", "shop", "bread"), "full");
  assert.equal(journals.eat("a", "bread"), "ok");
  journals.talked("a", 12, "cow", "Daisy", "", "Moo.");
  assert.deepEqual((journals.view("a") as JournalView).food.larder.map((f) => f.id), ["bread", "milk"]);
  await journals.close();
});

test("in a room: eating, the menu of where I am, and buying", async () => {
  const done: string[] = [];
  const journal: JournalKeeper = {
    listen: () => {}, joined: async () => {}, left: () => {}, moved: () => {}, rode: () => {}, talked: () => {}, view: () => ({ coins: 3 }),
    eat: (_key, id) => (id === "milk" ? (done.push(`eat ${id}`), "ok") : "none"),
    pepOf: () => done.length >= 2,
    menuOf: (_key, use) => ({ country: "Japan", items: use === "food" ? [{ id: "sushi", name: "a plate of sushi", groups: ["grain", "protein"], price: 16 }] : [{ id: "bread", name: "a loaf of bread", groups: ["grain"], price: 6 }] }),
    buyFood: (_key, use, id) => (id === "sushi" && use === "food" ? (done.push("buy sushi"), "ok") : id === "bread" ? "poor" : id === "cake" ? "full" : "unknown"),
  };
  const rooms = new Rooms(new GuestDirectory(""), { journal });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => rooms.wss.handleUpgrade(req, socket, head, (ws) => rooms.wss.emit("connection", ws, req)));
  await new Promise<void>((r) => server.listen(0, r));
  const ws = new WebSocket(`ws://localhost:${(server.address() as AddressInfo).port}/v1/ws`);
  const inbox: Msg[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
  await new Promise<void>((r) => ws.on("open", () => r()));
  const send = (m: Msg): void => ws.send(JSON.stringify(m));
  const next = async (t: string): Promise<Msg> => {
    for (let i = 0; i < 300; i++) {
      const at = inbox.findIndex((m) => m.t === t);
      if (at >= 0) return inbox.splice(at, 1)[0];
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for "${t}"`);
  };
  try {
    send({ t: "hello", name: "Sam", room: "family", avatar: "fox" });
    await next("welcome");
    send({ t: "food", eat: "pear" });
    assert.equal((await next("error")).text, "There is none of that in your lunch box");
    send({ t: "food", eat: "milk" });
    assert.deepEqual([(await next("pep")).on, (await next("journal")).journal], [false, { coins: 3 }]);
    send({ t: "food", menu: "food" });
    assert.deepEqual(await next("menu"), { t: "menu", use: "food", country: "Japan", items: [{ id: "sushi", name: "a plate of sushi", groups: ["grain", "protein"], price: 16 }] });
    send({ t: "food", menu: "shop" });
    assert.deepEqual((await next("menu")).items.map((x: Msg) => x.id), ["bread"]);
    send({ t: "food", buy: "sushi", at: "food" });
    assert.deepEqual((await next("journal")).journal, { coins: 3 });
    send({ t: "food", buy: "sushi", at: "shop" });
    assert.equal((await next("error")).text, "That is not sold here");
    send({ t: "food", buy: "bread", at: "shop" });
    assert.equal((await next("error")).code, "poor");
    send({ t: "food", buy: "cake", at: "food" });
    assert.equal((await next("error")).text, "Your lunch box is full: eat something first");
    send({ t: "food", eat: "milk" });
    assert.equal((await next("pep")).on, true, "all five hearts full: quicker on their feet");
    assert.deepEqual(done, ["eat milk", "buy sushi", "eat milk"]);
    ws.close();
  } finally {
    for (const client of rooms.wss.clients) client.terminate(); // whatever happened above, nothing is left holding the test open
    server.close();
    rooms.wss.close();
  }
});

test("cooking: a recipe takes what it needs from the lunch box and makes two helpings; each new one teaches the next", async () => {
  const { RECIPES, ingredients, recipesKnown, needName, HELPINGS } = await import("../src/food.ts");
  for (const r of RECIPES) {
    assert.ok(foodById(r.makes), r.id);
    for (const need of r.needs) assert.ok(need.startsWith("any:") ? GROUPS.some((g) => g.id === need.slice(4)) : need.split("|").every((id) => foodById(id)), `${r.id}: ${need}`);
  }
  assert.equal(new Set(RECIPES.map((r) => r.id)).size, RECIPES.length);
  assert.deepEqual([recipesKnown({}), recipesKnown({ sandwich: 2 }), recipesKnown(Object.fromEntries(RECIPES.map((r) => [r.id, 1])))], [3, 4, RECIPES.length]);
  assert.deepEqual([needName("bread"), needName("any:fruit"), needName("honey|chocolate")], ["a loaf of bread", "any fruit", "a pot of honey or a bar of chocolate"]);
  // The milk a recipe names is not used up as "any dairy"; a meal is never cooked into another.
  const breakfast = RECIPES.find((r) => r.id === "breakfast")!, sandwich = RECIPES.find((r) => r.id === "sandwich")!;
  assert.deepEqual(ingredients(breakfast, { rice: 1, milk: 1, apple: 1 }), ["rice", "milk", "apple"]);
  assert.deepEqual(ingredients(sandwich, { bread: 1, milk: 1 }), ["bread", "milk"]);
  assert.deepEqual(ingredients(sandwich, { bread: 1, omelette: 3 }), ["bread", null]);
  assert.deepEqual(ingredients(RECIPES.find((r) => r.id === "heartysoup")!, { carrot: 1, egg: 1 }), ["carrot", null, "egg"]);

  const journals = new Journals({ startCoins: 1000 });
  const told: string[] = [];
  journals.listen((_key, news) => { if (news.kind === "food") told.push(`${news.title}. ${news.text}`); });
  await journals.joined("a", null, "family");
  let v = journals.view("a") as JournalView;
  assert.deepEqual(v.food.recipes.map((r) => [r.id, r.known, r.can]).slice(0, 4), [["sandwich", true, false], ["omelette", true, false], ["fruitbowl", true, false], ["heartysoup", false, false]]);
  assert.deepEqual([journals.cook("a", "sandwich"), journals.cook("a", "heartysoup"), journals.cook("a", "nonsense")], ["missing", "locked", "unknown"]);
  for (const id of ["bread", "cheese", "egg", "milk"]) assert.equal(journals.buyFood("a", "shop", id), "ok");
  v = journals.view("a") as JournalView;
  assert.deepEqual(v.food.recipes[0], { id: "sandwich", name: "a cheese sandwich", groups: ["grain", "dairy"], makes: HELPINGS, needs: [{ name: "a loaf of bread", have: true }, { name: "any dairy", have: true }], known: true, can: true, times: 0 });
  assert.equal(journals.cook("a", "sandwich"), "ok");
  v = journals.view("a") as JournalView;
  // (The first dairy on the shelf is the milk; the cheese is still there for the omelette.)
  assert.deepEqual(v.food.larder.map((f) => [f.id, f.n]).sort(), [["cheese", 1], ["egg", 1], ["sandwich", 2]]);
  assert.ok(told.some((t) => /You cooked a cheese sandwich/.test(t) && /new recipe: a pot of hearty soup/.test(t)), told.join(" | "));
  assert.deepEqual([v.food.recipes[3].known, v.food.recipes[4].known, v.stamps.find((s) => s.id === "cooked")!.have], [true, false, 1]);
  told.length = 0;
  for (const id of ["bread", "milk"]) journals.buyFood("a", "shop", id);
  assert.equal(journals.cook("a", "sandwich"), "ok");
  assert.ok(told.every((t) => !/new recipe/.test(t)), "cooked before: nothing new learnt");
  assert.equal(journals.cook("a", "omelette"), "ok");
  assert.equal((journals.view("a") as JournalView).food.recipes[4].known, true);

  // Giving: one thing from my lunch box to a friend's, and both are told.
  await journals.joined("b", null, "family");
  told.length = 0;
  assert.deepEqual([journals.giveFood("a", "b", "sandwich", "Sam", "Kim"), journals.giveFood("a", "b", "pizza", "Sam", "Kim"), journals.giveFood("a", "a", "sandwich", "Sam", "Sam"), journals.giveFood("a", "nobody", "sandwich", "Sam", "?")], ["ok", "none", "none", "none"]);
  assert.deepEqual([(journals.view("b") as JournalView).food.larder.map((f) => [f.id, f.n]), (journals.view("a") as JournalView).food.larder.find((f) => f.id === "sandwich")!.n], [[["sandwich", 1]], 3]);
  assert.deepEqual(told, ["You gave Kim a cheese sandwich. That was kind", "Sam gave you a cheese sandwich. It is in your lunch box (B)"]);
  await journals.close();
});

test("in a room: cooking wants a kitchen of one's own, and food is given to a friend standing by", async () => {
  const { Homes } = await import("../src/home.ts");
  const homes = new Homes(null, () => 0);
  const done: string[] = [];
  const journal: JournalKeeper = {
    listen: () => {}, joined: async () => {}, left: () => {}, moved: () => {}, rode: () => {}, talked: () => {}, view: (key) => ({ of: key.length > 0 }),
    cook: (_key, id) => (id === "sandwich" ? (done.push("cook"), "ok") : id === "pizza" ? "locked" : "missing"),
    giveFood: (_from, _to, id, fromName, toName) => (id === "sandwich" ? (done.push(`${fromName} to ${toName}`), "ok") : "full"),
  };
  const rooms = new Rooms(new GuestDirectory(""), {
    journal, homes, findHome: async (_x, _y, id) => ({ home: { id, corners: [[0, 0], [0, -7], [10, -7], [10, 0]], x: 5, y: 0, along: [-1, 0], out: [0, 1], floor: 1, height: 5, seed: 1, wall: 0, porch: false }, lat: 52.01, lon: 4.71, yaw: 0 }),
  });
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
    const next = async (t: string): Promise<Msg> => {
      for (let i = 0; i < 300; i++) {
        const at = inbox.findIndex((m) => m.t === t);
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
    sam.send({ t: "pos", lat: 52.01, lon: 4.71, alt: 0, yaw: 0 });
    kim.send({ t: "pos", lat: 52.0101, lon: 4.71, alt: 0, yaw: 0 });
    await new Promise((r) => setTimeout(r, 50));
    sam.send({ t: "food", cook: "sandwich" });
    assert.match((await sam.next("error")).text, /kitchen of your own/);
    await new Promise((r) => setTimeout(r, 2100));
    sam.send({ t: "house", claim: { x: 1, y: 2, id: 77 } });
    await sam.next("house");
    sam.send({ t: "food", cook: "sandwich" });
    await sam.next("journal");
    sam.send({ t: "food", cook: "pizza" });
    assert.equal((await sam.next("error")).text, "You have not learnt that recipe yet");
    sam.send({ t: "food", cook: "feast" });
    assert.equal((await sam.next("error")).text, "Something that recipe needs is not in your lunch box");
    // Away from home there is no cooking.
    sam.send({ t: "pos", lat: 52.02, lon: 4.71, alt: 0, yaw: 0 });
    await new Promise((r) => setTimeout(r, 50));
    sam.send({ t: "food", cook: "sandwich" });
    assert.match((await sam.next("error")).text, /H takes you home/);
    // Giving: to a friend close by, not to one a kilometre off.
    sam.send({ t: "food", give: "sandwich", to: kim.id });
    assert.equal((await sam.next("error")).code, "far");
    sam.send({ t: "pos", lat: 52.01011, lon: 4.71, alt: 0, yaw: 0 });
    await new Promise((r) => setTimeout(r, 50));
    sam.send({ t: "food", give: "sandwich", to: kim.id });
    await Promise.all([sam.next("journal"), kim.next("journal")]);
    sam.send({ t: "food", give: "cake", to: kim.id });
    assert.equal((await sam.next("error")).text, "Kim's lunch box is full");
    sam.send({ t: "food", give: "sandwich", to: sam.id });
    assert.equal((await sam.next("error")).code, "far");
    assert.deepEqual(done, ["cook", "Sam to Kim"]);
    sam.ws.close();
    kim.ws.close();
  } finally {
    for (const client of rooms.wss.clients) client.terminate(); // whatever happened above, nothing is left holding the test open
    server.close();
    rooms.wss.close();
  }
});
