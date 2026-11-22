// Daily tasks, coins and hats: the first of the games that hang off the journal (journal.ts).
//
// Every day has three small tasks, the same three for everyone whose day it is, so a family can
// compare. Each is done by getting about in the world; the server notices from what it already
// hears (positions, `talk`, `ride`), and nothing a game says can finish one. A task pays coins,
// all three pay a few more, and coins buy hats. Some hats cannot be bought: they are prizes for
// days on which all three tasks were done. Nothing can be failed, and a day's tasks simply give
// way to the next day's.

import { hash32 } from "./geo.ts";

/** What a player has done today, as far as the tasks care. */
export interface Daily {
  day: number;
  walked: number;
  ridden: number;
  /** Places (about a kilometre across) stood in today. */
  places: string[];
  /** Things talked to today for the very first time. */
  friends: number;
  /** How many times each kind of thing was talked to, and each kind ridden, today. */
  talked: Record<string, number>;
  rode: Record<string, number>;
  /** Favours done today (favours.ts). Missing in days begun before there were favours. */
  favours?: number;
  /** Food (food.ts): the kinds of good food eaten today, how many things were eaten, who has given food today, and whether the full hearts have been paid for. */
  ate?: string[];
  eaten?: number;
  gifts?: string[];
  fed?: boolean;
  /** Tasks done, with when; and whether the prize for all three has been paid. */
  done: Record<string, number>;
  bonus: boolean;
}

export const emptyDaily = (day: number): Daily => ({ day, walked: 0, ridden: 0, places: [], friends: 0, talked: {}, rode: {}, done: {}, bonus: false });

/** The number of the day it is for someone whose clock is `tzMinutes` ahead of the server's (UTC). */
export const dayNumber = (now: number, tzMinutes = 0): number => Math.floor((now + tzMinutes * 60_000) / 86_400_000);

export const TASK_COINS = 10;
export const ALL_TASKS_COINS = 20;
export const RIDDLE_COINS = 15;

const BIRDS = ["duck", "pigeon", "bird", "chicken", "goose", "swan", "heron", "seagull", "sparrow", "flamingo", "penguin"];
const FARM = ["cow", "sheep", "horse", "chicken", "pig", "goat", "donkey", "goose"];
const SMALL = ["butterfly", "bee", "dragonfly", "ladybird", "ant", "grasshopper", "snail", "mouse", "hedgehog", "frog"];
const WHEELS = ["car", "taxi", "tractor", "train"];
const MACHINES = [...WHEELS, "boat", "sailboat"];

const any = (counts: Record<string, number>, kinds: string[]): number => (kinds.some((k) => counts[k]) ? 1 : 0);
const sum = (counts: Record<string, number>): number => Object.values(counts).reduce((a, b) => a + b, 0);

export interface Task { id: string; text: string; goal: number; unit: string; have: (t: Daily) => number }

/** Three shelves of tasks: somebody to talk to, somewhere to go, something to try. A day takes one from each. */
export const TASKS: Task[][] = [
  [
    { id: "bird", text: "Talk to a bird", goal: 1, unit: "", have: (t) => any(t.talked, BIRDS) },
    { id: "tree", text: "Talk to a tree", goal: 1, unit: "", have: (t) => any(t.talked, ["tree"]) },
    { id: "house", text: "Talk to a house", goal: 1, unit: "", have: (t) => any(t.talked, ["house"]) },
    { id: "wheels", text: "Talk to something with wheels", goal: 1, unit: "", have: (t) => any(t.talked, WHEELS) },
    { id: "pet", text: "Talk to a cat or a dog", goal: 1, unit: "", have: (t) => any(t.talked, ["cat", "dog"]) },
    { id: "farm", text: "Talk to a farm animal", goal: 1, unit: "", have: (t) => any(t.talked, FARM) },
    { id: "small", text: "Talk to something small: an insect, a snail, a mouse or a frog", goal: 1, unit: "", have: (t) => any(t.talked, SMALL) },
    { id: "kinds3", text: "Talk to three different kinds of thing", goal: 3, unit: "kinds", have: (t) => Object.keys(t.talked).length },
    { id: "friends2", text: "Make two new friends", goal: 2, unit: "friends", have: (t) => t.friends },
  ],
  [
    { id: "walk500", text: "Walk 500 metres on your own feet", goal: 500, unit: "m", have: (t) => Math.floor(t.walked) },
    { id: "walk1000", text: "Walk a kilometre on your own feet", goal: 1000, unit: "m", have: (t) => Math.floor(t.walked) },
    { id: "places2", text: "Visit two different places", goal: 2, unit: "places", have: (t) => t.places.length },
    { id: "places3", text: "Visit three different places", goal: 3, unit: "places", have: (t) => t.places.length },
    { id: "ride500", text: "Ride 500 metres on anything", goal: 500, unit: "m", have: (t) => Math.floor(t.ridden) },
    { id: "ride1000", text: "Ride a kilometre on anything", goal: 1000, unit: "m", have: (t) => Math.floor(t.ridden) },
  ],
  [
    { id: "rideAnimal", text: "Ride an animal", goal: 1, unit: "", have: (t) => (Object.keys(t.rode).some((k) => !MACHINES.includes(k)) ? 1 : 0) },
    { id: "rideWheels", text: "Ride something with wheels", goal: 1, unit: "", have: (t) => any(t.rode, WHEELS) },
    { id: "ride2", text: "Ride two different kinds of thing", goal: 2, unit: "kinds", have: (t) => Object.keys(t.rode).length },
    { id: "chats5", text: "Have five chats", goal: 5, unit: "chats", have: (t) => sum(t.talked) },
    { id: "chats3", text: "Have three chats", goal: 3, unit: "chats", have: (t) => sum(t.talked) },
    { id: "favour", text: "Do somebody a favour (ask anything you talk to: \"can I help?\")", goal: 1, unit: "", have: (t) => Math.min(1, t.favours ?? 0) },
    { id: "eat3", text: "Eat three kinds of good food (B opens your lunch box)", goal: 3, unit: "kinds", have: (t) => (t.ate ?? []).length },
    { id: "gift", text: "Be given something to eat (talk to a cow, a hen or a fruit tree)", goal: 1, unit: "", have: (t) => Math.min(1, (t.gifts ?? []).length) },
  ],
];

/** The three tasks of a day. */
export function tasksFor(day: number): Task[] {
  return TASKS.map((shelf, i) => shelf[hash32(day, 0x5441534b + i) % shelf.length]);
}

/** A hat: bought with coins (`price`), or won by doing all three tasks on that many days (`days`) or by finding that many treasures (`hunts`). */
export interface Hat { id: string; name: string; price?: number; days?: number; hunts?: number }
export const HATS: Hat[] = [
  { id: "cap", name: "Red cap", price: 30 },
  { id: "bobble", name: "Bobble hat", price: 30 },
  { id: "party", name: "Party hat", price: 40 },
  { id: "straw", name: "Straw hat", price: 40 },
  { id: "chef", name: "Chef's hat", price: 50 },
  { id: "cowboy", name: "Cowboy hat", price: 60 },
  { id: "top", name: "Top hat", price: 60 },
  { id: "flowers", name: "Flower crown", price: 60 },
  { id: "pirate", name: "Pirate hat", price: 80 },
  { id: "wizard", name: "Wizard's hat", price: 100 },
  { id: "explorer", name: "Explorer's hat", days: 1 },
  { id: "crown", name: "Golden crown", days: 7 },
  { id: "feather", name: "Feathered cap", hunts: 1 },
];
export const hatById = (id: string): Hat | undefined => HATS.find((h) => h.id === id);
