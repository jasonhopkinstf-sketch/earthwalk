// Hungry animals. On any day about one animal in five is hungry, and knows what it would like to eat.
// Which ones, and what, follows from who each animal is and what day it is, so every player sees the same
// hungry animals; the server uses this very file to judge a feeding (journal.ts), and each game uses it to
// hang a thought bubble over the animals that are hungry (carebubbles.js). A day is the player's own, as
// for the daily tasks.

import { hash32 } from "./lifemotion.js";

/** What each kind of animal likes to be given: foods from food.ts. A kind not listed here is never hungry. */
export const WANTS = {
  duck: ["bread", "corn"], goose: ["bread", "lettuce"], swan: ["bread", "lettuce"], chicken: ["corn", "bread"], pigeon: ["bread"], sparrow: ["bread"],
  seagull: ["fish"], heron: ["fish"], penguin: ["fish"], seal: ["fish"], otter: ["fish"],
  horse: ["apple", "carrot"], donkey: ["carrot", "apple"], zebra: ["apple", "carrot"], cow: ["apple", "corn"], sheep: ["lettuce", "carrot"], goat: ["lettuce", "apple"],
  pig: ["potato", "apple", "pumpkin"], rabbit: ["carrot", "lettuce"], squirrel: ["nuts"], mouse: ["cheese"], hedgehog: ["apple", "egg"],
  cat: ["fish", "milk"], dog: ["cheese", "egg"], fox: ["egg", "berries"], deer: ["apple", "carrot"], tortoise: ["lettuce", "tomato"],
  monkey: ["banana"], bear: ["honey", "berries", "fish"], capybara: ["pumpkin", "corn"], marmot: ["lettuce", "nuts"], beaver: ["carrot", "apple"],
  kangaroo: ["carrot", "lettuce"], llama: ["carrot", "apple"], camel: ["fig", "carrot"], elephant: ["banana", "pumpkin", "apple"], giraffe: ["lettuce", "apple"],
  bison: ["corn"], moose: ["apple"], reindeer: ["carrot"], lion: ["fish"],
};

/** One animal in this many is hungry on a given day. */
export const HUNGRY_ONE_IN = 5;

/** The day a moment falls on, for somebody whose clock is `tzMinutes` ahead of UTC. */
export function dayOf(nowMs, tzMinutes = 0) {
  return Math.floor((nowMs + tzMinutes * 60000) / 86400000);
}

/** The food this animal is hungry for on this day, or null when it is not hungry (or is not of a kind that ever is). */
export function hungerOf(sp, thing, day) {
  const likes = WANTS[sp];
  if (!likes) return null;
  const h = hash32(thing, day * 131 + 0x48554e47);
  if (h % HUNGRY_ONE_IN !== 0) return null;
  return likes[(h >>> 8) % likes.length];
}
