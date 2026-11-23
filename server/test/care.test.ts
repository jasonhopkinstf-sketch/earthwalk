import { test } from "node:test";
import assert from "node:assert/strict";
import { dayNumber } from "../src/daily.ts";
import { foodById } from "../src/food.ts";
import { CARE_COINS, CARE_PETS, Journals, type JournalView } from "../src/journal.ts";
import { levelPrizes } from "../src/progress.ts";
import { dayOf, HUNGRY_ONE_IN, hungerOf, WANTS } from "../public/js/care.js";

test("hungry animals: about one in five each day, the same for everyone, and each wants a food there is", () => {
  for (const [sp, likes] of Object.entries(WANTS)) for (const id of likes) assert.ok(foodById(id), `${sp} wants ${id}`);
  const now = Date.UTC(2026, 10, 23, 9);
  assert.equal(dayOf(now, 780), dayNumber(now, 780), "the games count days as the server does");
  assert.equal(dayOf(now, -480), dayNumber(now, -480));
  const day = dayOf(now);
  let hungry = 0, again = 0;
  for (let thing = 1; thing <= 2000; thing++) {
    const want = hungerOf("horse", thing, day);
    assert.equal(hungerOf("horse", thing, day), want);
    if (want) { hungry++; assert.ok(WANTS.horse.includes(want)); if (hungerOf("horse", thing, day + 1)) again++; }
    assert.equal(hungerOf("car", thing, day), null);
    assert.equal(hungerOf("butterfly", thing, day), null);
  }
  assert.ok(Math.abs(hungry - 2000 / HUNGRY_ONE_IN) < 80, `about a fifth (${hungry} of 2000)`);
  assert.ok(again < hungry / 2, "different animals tomorrow");
});

test("the journal: a hungry animal says what it would like, is fed from the lunch box, and feeding wins companions", async () => {
  const clock = { now: Date.UTC(2026, 10, 23, 9) };
  const day = dayNumber(clock.now, 0);
  const journals = new Journals({ now: () => clock.now, startCoins: 500 });
  const told: string[] = [];
  journals.listen((_key, news) => { if (news.kind === "care") told.push(`${news.title}. ${news.text}`); });
  await journals.joined("a", null, "family");
  // Horses that are hungry today, with what each wants; and one that is not.
  const hungry: { thing: number; want: string }[] = [];
  let content = 0;
  for (let thing = 100; hungry.length < 4 || !content; thing++) {
    const want = hungerOf("horse", thing, day);
    if (want && hungry.length < 4) hungry.push({ thing, want });
    else if (!want && !content) content = thing;
  }
  let v = journals.view("a") as JournalView;
  assert.deepEqual(v.care, { fed: 0, today: [], coins: CARE_COINS, next: CARE_PETS[0] });

  // With nothing to give: it says what it would like, once; a horse that is not hungry says nothing of the kind.
  const first = hungry[0];
  journals.talked("a", first.thing, "horse", "Bramble", "", "Neigh.");
  journals.talked("a", first.thing, "horse", "Bramble", "", "Neigh.");
  journals.talked("a", content, "horse", "Conker", "", "Neigh.");
  assert.deepEqual(told.splice(0), [`Bramble is hungry. It would love ${foodById(first.want)!.name}. Bring one in your lunch box (B) and talk to it again`]);
  assert.deepEqual((journals.view("a") as JournalView).care.today, []);

  // With it in the lunch box: fed, paid, and not hungry again today.
  assert.equal(journals.buyFood("a", "shop", first.want), "ok");
  const { coins, level } = journals.view("a") as JournalView;
  journals.talked("a", first.thing, "horse", "Bramble", "", "Neigh.");
  v = journals.view("a") as JournalView;
  assert.deepEqual([v.coins, v.care.fed, v.care.today, v.food.larder, v.stamps.find((s) => s.id === "cared")!.have], [coins + CARE_COINS + levelPrizes(level.n, v.level.n), 1, [`horse:${first.thing}`], [], 1]); // and the prize of any level it reached
  assert.match(told.splice(0).join(" | "), /^You fed Bramble\. .* was just what it wanted: 12 coins$/);
  assert.equal(journals.buyFood("a", "shop", first.want), "ok");
  journals.talked("a", first.thing, "horse", "Bramble", "", "Neigh.");
  assert.deepEqual([(journals.view("a") as JournalView).care.fed, (journals.view("a") as JournalView).food.larder.length, told.splice(0)], [1, 1, []], "fed once a day");
  assert.equal(journals.eat("a", first.want), "ok");

  // Three fed: a hedgehog wants to come along.
  for (const [i, h] of hungry.slice(1, 3).entries()) {
    assert.equal(journals.buyFood("a", "shop", h.want), "ok");
    journals.talked("a", h.thing, "horse", `Horse ${i}`, "", "Neigh.");
  }
  v = journals.view("a") as JournalView;
  assert.deepEqual([v.care.fed, v.care.next, v.pets.includes("hedgehog")], [3, CARE_PETS[1], true]);
  assert.ok(told.some((t) => /^A hedgehog wants to keep you company/.test(t)), told.join(" | "));
  assert.equal(journals.setPet("a", "hedgehog"), true);

  // Tomorrow the count stands, today's list is empty, and other animals are hungry.
  clock.now += 24 * 3600 * 1000;
  v = journals.view("a") as JournalView;
  assert.deepEqual([v.care.fed, v.care.today], [3, []]);
  await journals.close();
});

test("whatever a hungry animal wants, a grocer somewhere sells it", async () => {
  const { menuFor } = await import("../src/food.ts");
  for (const lat of [0, 30, 52, -37]) {
    const sold = new Set(menuFor("shop", null, lat).map((f) => f.id));
    for (const [sp, likes] of Object.entries(WANTS)) assert.ok(likes.some((id) => sold.has(id)), sp + " can be fed from a shop at latitude " + lat);
  }
  const everywhere = new Set(menuFor("shop", null, 52).map((f) => f.id));
  for (const id of ["corn", "carrot", "bread", "fish", "nuts", "lettuce", "apple", "cheese", "egg"]) assert.ok(everywhere.has(id), id);
});
