// A journal for every player: where they have been, what they have ridden and talked to, and from
// that a passport of stamps and a sense of getting somewhere.
//
// Two things are kept for each signed-in person, beside the accounts on the server's disk:
// - a summary (`journal/<id>.json`): totals, the countries and places visited, the things met;
// - a log (`journal/<id>.log`, one JSON object a line, only ever added to): every arrival, a point
//   of the trail each hundred metres, every ride, and every conversation with what was said.
// A guest has no lasting identity, so a guest's journal lasts for the visit and is never written.
//
// A journal is its owner's. The server hands it to nobody else: `view` is only ever called for the
// member or the token that asked (docs/PROTOCOL.md, "Journal").

import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PlaceDetail } from "./geocode.ts";
import { ALL_TASKS_COINS, type Daily, dayNumber, emptyDaily, hatById, HATS, RIDDLE_COINS, TASK_COINS, tasksFor } from "./daily.ts";
import { asksUnprompted, type Favour, FAVOUR_DAYS, favourOf, FAVOURS_OPEN, progressOf, thanksLine } from "./favours.ts";
import { aKind } from "./talk.ts";
import { type HuntStop, huntCell, wayTo } from "./hunt.ts";
import { clock, ordinal } from "./race.ts";
import { bodyById, CAR_BODIES, CAR_PAINTS, emptyGarage, type Garage, lookOf, paintById } from "./garage.ts";
import { type Feat, howWon, pieceById, PIECES } from "./home.ts";
import { type Expedition, expeditionById, EXPEDITIONS, EXPEDITIONS_OPEN, itemsOf, needOf } from "./expeditions.ts";

interface PlaceSeen { name: string; country: string | null; lat: number; lon: number; first: number; last: number; times: number }
interface Friend { name: string; sp: string; first: number; last: number; times: number }

export interface JournalDoc {
  version: 1;
  personId: string | null;
  since: number;
  updated: number;
  /** Times they came into the world, and minutes spent there. */
  visits: number;
  minutes: number;
  metresOnFoot: number;
  metresRidden: number;
  /** The furthest north and south they have stood (degrees), or null before they have stood anywhere. */
  north: number | null;
  south: number | null;
  countries: Record<string, { first: number; last: number }>;
  continents: Record<string, number>;
  /** Places about a kilometre across, by where they are ("48.86,2.34"). The newest few thousand are kept; `placeCount` counts them all. */
  places: Record<string, PlaceSeen>;
  placeCount: number;
  /** Things talked to, by kind and identity ("cow:918398760"). `friendCount` counts them all. */
  friends: Record<string, Friend>;
  friendCount: number;
  /** How many times each kind of thing was talked to, and each kind ridden with how far. */
  talked: Record<string, number>;
  ridden: Record<string, { times: number; metres: number }>;
  /** Stamps earned ("countries:3"), with when. */
  earned: Record<string, number>;
  /** Riddles solved, with when; and the companion chosen from those they have won, if any. */
  solved: Record<string, number>;
  pet: string | null;
  /** Daily tasks, coins and hats (daily.ts): coins ever earned and spent, how far their clock is ahead of UTC, today so far, days on which all three tasks were done, hats owned and the one worn. */
  coins: number;
  spent: number;
  tz: number;
  daily: Daily | null;
  days: number;
  hats: string[];
  hat: string | null;
  /** Favours (favours.ts): those asked and not yet done, how many have been done, and who has asked one on which day. */
  favours: Favour[];
  favoursDone: number;
  favoured: Record<string, number>;
  /** The treasure hunt they are on (hunt.ts) with the clue they are at, how many they have finished, and the quickest in milliseconds. */
  hunt: { cell: number; day: number; stops: HuntStop[]; at: number; started: number } | null;
  huntsDone: number;
  huntBest: number | null;
  /** Expeditions (expeditions.ts): those they are on, with what has been ticked off, and those finished, with when. */
  expeditions: Record<string, { started: number; got: string[] }>;
  expeditionsDone: Record<string, number>;
  /** Companions won by other means than riddles: the animals taken home. */
  morePets: string[];
  /** Their car (garage.ts): the body and paint chosen, and those bought. */
  car: Garage;
  /** Races finished, and those won against somebody else (race.ts). */
  races: number;
  racesWon: number;
  /** Games of tag and of hide and seek played, and those won (play.ts). */
  games: number;
  gamesWon: number;
  /** Pieces for a house of their own (home.ts): those bought, and the prizes won. */
  pieces: string[];
}

/** A stamp in the passport: something counted, with the numbers at which it is stamped again. */
export interface StampView { id: string; title: string; have: number; steps: number[]; done: number; next: number | null; unit: string }
/** What a player is shown of their own journal. */
export interface JournalView {
  kept: boolean;
  since: number;
  level: { n: number; title: string; points: number; from: number; next: number };
  totals: { km: number; kmRidden: number; minutes: number; visits: number; countries: number; continents: number; places: number; friends: number };
  countries: { name: string; first: number }[];
  continents: string[];
  places: { name: string; country: string | null; last: number; times: number }[];
  friends: { name: string; sp: string; times: number; last: number }[];
  talkedKinds: string[];
  riddenKinds: string[];
  stamps: StampView[];
  /** The riddles unlocked so far (`answer` once solved), how many more there are and at what level they come, and the companions won. */
  riddles: { id: string; text: string; solved: boolean; answer: string | null }[];
  moreRiddles: { count: number; level: number } | null;
  pets: string[];
  pet: string | null;
  /** Coins in hand, today's three tasks, and the hats there are (`price` null for one that is only won, with `how`). */
  coins: number;
  today: { tasks: { id: string; text: string; have: number; goal: number; unit: string; done: boolean }[]; all: boolean; coinsEach: number; coinsAll: number; fullDays: number };
  hats: { id: string; name: string; price: number | null; how: string | null; owned: boolean }[];
  hat: string | null;
  /** Favours asked and not yet done, each with how far along it is and what to do next; and how many have been done. */
  favours: { id: string; name: string; sp: string; text: string; coins: number; have: number; goal: number; unit: string; next: string }[];
  favoursDone: number;
  /** The treasure hunt under way (the clue to solve now, and which way it lies from where they stand), and how hunts have gone. */
  hunt: { at: number; of: number; clue: string; way: string | null; minutes: number } | null;
  huntsDone: number;
  huntBestMinutes: number | null;
  /** Every expedition there is, with how far along they are on those they have begun. */
  expeditions: { id: string; sort: string; title: string; blurb: string; coins: number; state: "open" | "active" | "done"; have: number; need: number; items: { name: string; got: boolean }[] }[];
  /** The lost animal travelling with them, if they are taking one home. */
  passenger: string | null;
  /** Their car: what is chosen, and every paint and body there is with its price and whether it is theirs. */
  garage: { body: string; paint: string; paints: { id: string; name: string; hex: number; price: number; owned: boolean }[]; bodies: { id: string; name: string; price: number; owned: boolean }[] };
  /** Everything there is for a house of their own: `price` null for a prize, with `how` it is won. */
  house: { pieces: { id: string; slot: string; name: string; price: number | null; how: string | null; owned: boolean; hex: number[] }[] };
}
/** Something worth telling a player the moment it happens. */
export interface StampNews {
  title: string; text: string; kind: "country" | "stamp" | "level" | "riddle" | "task" | "prize" | "favour" | "hunt" | "expedition" | "race" | "play";
  /** For a treasure just found: where its finder stood, so that their game can show it there. */
  at?: { lat: number; lon: number };
  /** For a favour just done: the thing that asked it, and what it says in thanks. */
  thing?: number; sp?: string; say?: string;
}
/** What a player's talking to a thing has to do with favours: those it completes, and one newly asked. */
export interface TalkNews {
  /** Favours from elsewhere that reach this thing (a hello passed on, a parcel delivered). */
  arrived: Favour[];
  /** This thing's own favour, just completed by coming back to it. */
  back: Favour | null;
  /** A favour this thing asks now, or one it asked before that is still open. */
  offer: Favour | null;
  open: Favour | null;
  /** They offered to help, but have their hands full, or have helped this thing already today. */
  full: boolean;
  later: boolean;
}

/** Where journals are kept. */
export interface JournalStore {
  load(personId: string): Promise<JournalDoc | null>;
  save(doc: JournalDoc): Promise<void>;
  append(personId: string, lines: string[]): Promise<void>;
}

/** Journals as files in one folder. */
export class FileJournalStore implements JournalStore {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  private file(personId: string, ext: string): string {
    if (!/^[a-z0-9-]{1,40}$/i.test(personId)) throw new Error("bad person id");
    return path.join(this.dir, `${personId}.${ext}`);
  }
  async load(personId: string): Promise<JournalDoc | null> {
    try {
      return JSON.parse(await readFile(this.file(personId, "json"), "utf8")) as JournalDoc;
    } catch {
      return null;
    }
  }
  async save(doc: JournalDoc): Promise<void> {
    if (!doc.personId) return;
    const file = this.file(doc.personId, "json");
    await mkdir(this.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(doc));
    await rename(tmp, file);
  }
  async append(personId: string, lines: string[]): Promise<void> {
    if (!lines.length) return;
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file(personId, "log"), lines.map((l) => `${l}\n`).join(""));
  }
}

const PLACE_CAP = 3000;
const FRIEND_CAP = 1500;
/** A step longer than this between two positions is a journey by `/goto`, not a walk, and adds no distance. */
const JUMP_M = 400;
/** Distance is counted in steps of at least this, and a point of the trail is logged this often. */
const STEP_M = 15;
const TRAIL_M = 100;
/** A player's place is looked up no more often than this, so flying over a country does not flood the name service. */
const NAME_EVERY_MS = 4000;
const SAVE_EVERY_MS = 30_000;

const metresBetween = (aLat: number, aLon: number, bLat: number, bLon: number): number =>
  Math.hypot((bLat - aLat) * 111_320, (bLon - aLon) * 111_320 * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180));

/** Which continent a position is on, by rough boxes: good enough to count them, wrong near some edges. */
export function continentOf(lat: number, lon: number): string {
  if (lat < -60) return "Antarctica";
  if ((lat < -10 && lon > 110) || (lat < 0 && lon >= 141) || (lat < 25 && (lon > 155 || lon < -130))) return "Oceania";
  if (lon < -30) return lat < 12.5 && lon > -93 && !(lat > 7.2 && lon < -77) ? "South America" : "North America";
  // East of the Red Sea and of Suez is Asia; the north shore of the Mediterranean is Europe.
  const arabia = lat > 30 ? lon > 34.2 : lat > 12.5 && lon > 32.5 + (30 - lat) * 0.63;
  const southEurope = (lat > 35.9 && lon > -9.6 && lon < 4.4 && !(lon > -1.5 && lat < 37.4)) || (lat > 36.5 && lon >= 11.5) || (lat > 34.7 && lon > 19) || (lat > 35.7 && lon > 14 && lon < 15);
  if (lat <= 37.5 && lat >= -36 && lon >= -26 && lon <= 52 && !arabia && !southEurope) return "Africa";
  if (lon < 29.5 || (lat > 42 && lon < 45) || (lat > 45 && lon < 60)) return "Europe";
  return "Asia";
}

/**
 * A riddle. It is unlocked at a level, and solved by finding its answer in the world: talking to
 * one (`talk`), riding one (`ride`), or having set foot on enough continents. Only what is done after
 * it is unlocked counts. The `gift` is an animal that will then follow the player about if they like.
 */
export interface Riddle { id: string; level: number; text: string; answer: string; talk?: string; ride?: string; continents?: number; gift: string }
export const RIDDLES: Riddle[] = [
  { id: "cow", level: 1, talk: "cow", gift: "cow", answer: "a cow", text: "I wear a patchwork coat in the field, I chew all day, and my favourite word has two o's in it. Find me and say hello." },
  { id: "tree", level: 1, talk: "tree", gift: "squirrel", answer: "a tree", text: "I have a trunk but no suitcase, a crown but no kingdom, and rings that nobody can see. Who am I?" },
  { id: "house", level: 1, talk: "house", gift: "cat", answer: "a house", text: "My eyes are windows, my mouth is a door, and I wear a hat of tiles. Come and talk to me." },
  { id: "car", level: 1, talk: "car", gift: "dog", answer: "a car", text: "I have four round feet and never walk. I sleep by the kerb and say toot. What am I?" },
  { id: "snail", level: 2, talk: "snail", gift: "snail", answer: "a snail", text: "I carry my house on my back and leave a silver road behind me. I am never in a hurry." },
  { id: "frog", level: 2, talk: "frog", gift: "frog", answer: "a frog", text: "I began as a wriggling dot with a tail. Now I have legs like springs and live beside the pond." },
  { id: "bee", level: 2, talk: "bee", gift: "bee", answer: "a bee", text: "I wear stripes, I hum while I work, and I turn flowers into something sweet for your toast." },
  { id: "butterfly", level: 2, talk: "butterfly", gift: "butterfly", answer: "a butterfly", text: "I used to crawl and munch leaves. Then I slept in a sleeping bag I made myself, and woke up with painted wings." },
  { id: "mouse", level: 2, talk: "mouse", gift: "mouse", answer: "a mouse", text: "I am small and quick with a tail like a bootlace, and stories say I am fond of cheese. Look beside the houses." },
  { id: "hedgehog", level: 2, talk: "hedgehog", gift: "hedgehog", answer: "a hedgehog", text: "I wear a coat of a thousand pins, yet I am no pincushion. I snuffle about in gardens." },
  { id: "train", level: 3, ride: "train", gift: "pigeon", answer: "a train", text: "I am long, I run on two iron ribbons, and I whistle when I set off. Do not just find me: take a ride." },
  { id: "taxi", level: 3, ride: "taxi", gift: "sparrow", answer: "a taxi", text: "I am yellow, I come when I am called, and I never stop talking. Ride with me somewhere." },
  { id: "crab", level: 3, talk: "crab", gift: "crab", answer: "a crab", text: "I walk sideways along the sand with my lunch boxes held up in the air." },
  { id: "donkey", level: 3, talk: "donkey", gift: "donkey", answer: "a donkey", text: "I look like a small grey horse who has borrowed a rabbit's ears, and I sing hee-haw." },
  { id: "goose", level: 3, talk: "goose", gift: "goose", answer: "a goose", text: "I honk, but I am not a car. I waddle, but I am not a duck. I guard the farmyard." },
  { id: "fox", level: 3, talk: "fox", gift: "fox", answer: "a fox", text: "I wear a red coat and a white-tipped brush, and in stories I am always the clever one. Look where the wood meets the field." },
  { id: "beaver", level: 4, talk: "beaver", gift: "beaver", answer: "a beaver", text: "I am a builder with orange teeth and a tail like a paddle. My house has a moat." },
  { id: "tortoise", level: 4, talk: "tortoise", gift: "tortoise", answer: "a tortoise", text: "Slow and steady, I once won a race against a hare. My roof goes everywhere with me." },
  { id: "ladybird", level: 4, talk: "ladybird", gift: "ladybird", answer: "a ladybird", text: "I am a little red dome with black dots, and people say I bring good luck." },
  { id: "flamingo", level: 4, talk: "flamingo", gift: "flamingo", answer: "a flamingo", text: "I am pink from my dinner and I like to stand on one leg. Look for me on a warm shore." },
  { id: "penguin", level: 4, talk: "penguin", gift: "penguin", answer: "a penguin", text: "I am a bird in a dinner suit. I cannot fly, but I swim like a fish. Go a long way south." },
  { id: "sailboat", level: 4, ride: "sailboat", gift: "duck", answer: "a sailing boat", text: "I have a white wing but I am no bird, and the wind is my engine. Come aboard." },
  { id: "zebra", level: 5, talk: "zebra", gift: "zebra", answer: "a zebra", text: "I am a horse who never takes off its striped pyjamas. I live on the great plains of Africa." },
  { id: "giraffe", level: 5, talk: "giraffe", gift: "giraffe", answer: "a giraffe", text: "I can look into an upstairs window without standing on tiptoe, and I eat from the tops of trees." },
  { id: "elephant", level: 5, talk: "elephant", gift: "elephant", answer: "an elephant", text: "I have a trunk but it is no tree's, ears like sails, and I never forget." },
  { id: "lion", level: 5, talk: "lion", gift: "lion", answer: "a lion", text: "I wear a golden scarf of hair and they call me a king, though mostly I nap." },
  { id: "kangaroo", level: 5, talk: "kangaroo", gift: "kangaroo", answer: "a kangaroo", text: "I go everywhere in jumps and carry my baby in a pocket. Look for me down under." },
  { id: "camel", level: 5, talk: "camel", gift: "camel", answer: "a camel", text: "They call me the ship of the desert, though I have never seen the sea. I carry a hill on my back." },
  { id: "panda", level: 6, talk: "panda", gift: "panda", answer: "a panda", text: "I am black and white, round all over, and I eat bamboo for breakfast, lunch and tea." },
  { id: "koala", level: 6, talk: "koala", gift: "koala", answer: "a koala", text: "I look like a teddy bear, I sleep nearly all day, and my larder is a gum tree." },
  { id: "reindeer", level: 6, talk: "reindeer", gift: "reindeer", answer: "a reindeer", text: "I wear a branching crown in the far north, and stories say my cousins pull a sleigh." },
  { id: "llama", level: 6, talk: "llama", gift: "llama", answer: "a llama", text: "I am a woolly cousin of the camel with no hump, high in the mountains of South America." },
  { id: "capybara", level: 6, talk: "capybara", gift: "capybara", answer: "a capybara", text: "I am the biggest of all the mice's cousins, calm as a cushion, and I love a bath." },
  { id: "continents", level: 6, continents: 3, gift: "bird", answer: "three continents", text: "I am not a thing but a journey: set foot on three of the world's great lands." },
];
/** The riddle's answer, as a thing to keep you company: flying birds are not offered. */
const giftOf = (r: Riddle): string | null => (r.gift === "bird" ? null : r.gift);

const LEVELS = ["Newcomer", "Rambler", "Wanderer", "Explorer", "Adventurer", "Voyager", "Globetrotter", "Pathfinder", "World walker"];
/** Points needed to reach level `n` (1 is where everyone starts). */
const pointsFor = (n: number): number => 10 * (n - 1) * (n - 1);

interface StampRule { id: string; title: string; unit: string; steps: number[]; count: (d: JournalDoc) => number; say: (n: number) => string }
const one = (n: number, thing: string, things = `${thing}s`): string => (n === 1 ? `1 ${thing}` : `${n} ${things}`);
const STAMPS: StampRule[] = [
  { id: "countries", title: "Countries", unit: "countries", steps: [1, 3, 5, 10, 20, 50], count: (d) => Object.keys(d.countries).length, say: (n) => `You have visited ${one(n, "country", "countries")}` },
  { id: "continents", title: "Continents", unit: "continents", steps: [2, 4, 6, 7], count: (d) => Object.keys(d.continents).length, say: (n) => `You have set foot on ${n} continents` },
  { id: "places", title: "Places", unit: "places", steps: [5, 25, 100, 500], count: (d) => d.placeCount, say: (n) => `You have been to ${n} places` },
  { id: "walked", title: "On foot", unit: "km", steps: [1, 5, 21, 42, 100, 500], count: (d) => Math.floor(d.metresOnFoot / 1000), say: (n) => `You have gone ${n} km on your own feet` },
  { id: "ridden", title: "Riding", unit: "km", steps: [1, 10, 50], count: (d) => Math.floor(d.metresRidden / 1000), say: (n) => `You have ridden ${n} km` },
  { id: "friends", title: "Friends made", unit: "friends", steps: [1, 10, 50, 200], count: (d) => d.friendCount, say: (n) => `You have talked to ${one(n, "new friend")}` },
  { id: "kinds", title: "Kinds of friend", unit: "kinds", steps: [3, 8, 15, 25, 40, 55], count: (d) => Object.keys(d.talked).length, say: (n) => `You have talked to ${n} different kinds of thing` },
  { id: "mounts", title: "Things ridden", unit: "kinds", steps: [1, 4, 8, 12, 20], count: (d) => Object.keys(d.ridden).length, say: (n) => `You have ridden ${one(n, "kind of thing", "kinds of thing")}` },
  { id: "riddles", title: "Riddles solved", unit: "riddles", steps: [1, 5, 10, 20, 30], count: (d) => Object.keys(d.solved).length, say: (n) => `You have solved ${one(n, "riddle")}` },
  { id: "favours", title: "Favours done", unit: "favours", steps: [1, 5, 20, 50, 100], count: (d) => d.favoursDone ?? 0, say: (n) => `You have done ${one(n, "favour")}` },
  { id: "hunts", title: "Treasures found", unit: "treasures", steps: [1, 5, 20, 50], count: (d) => d.huntsDone ?? 0, say: (n) => `You have found ${one(n, "treasure")}` },
  { id: "races", title: "Races run", unit: "races", steps: [1, 5, 20, 50], count: (d) => d.races ?? 0, say: (n) => `You have finished ${one(n, "race")}` },
  { id: "wins", title: "Races won", unit: "races", steps: [1, 5, 20], count: (d) => d.racesWon ?? 0, say: (n) => `You have won ${one(n, "race")}` },
  { id: "games", title: "Games played", unit: "games", steps: [1, 5, 20, 50], count: (d) => d.games ?? 0, say: (n) => `You have played ${one(n, "game")} of tag or hide and seek` },
  { id: "expeditions", title: "Expeditions", unit: "expeditions", steps: [1, 3, 6, 10, 15], count: (d) => Object.keys(d.expeditionsDone ?? {}).length, say: (n) => `You have finished ${one(n, "expedition")}` },
  { id: "tree", title: "Tree talker", unit: "", steps: [1], count: (d) => (d.talked.tree ? 1 : 0), say: () => "You have talked to a tree" },
  { id: "train", title: "All aboard", unit: "", steps: [1], count: (d) => (d.ridden.train ? 1 : 0), say: () => "You have ridden a train" },
  { id: "sea", title: "Sailor", unit: "", steps: [1], count: (d) => (d.ridden.boat || d.ridden.sailboat ? 1 : 0), say: () => "You have been out in a boat" },
  { id: "halves", title: "Both halves", unit: "", steps: [1], count: (d) => (d.north !== null && d.south !== null && d.north > 0 && d.south < 0 ? 1 : 0), say: () => "You have stood on both halves of the world" },
  { id: "north", title: "Far north", unit: "", steps: [1], count: (d) => (d.north !== null && d.north > 66.5 ? 1 : 0), say: () => "You have been north of the Arctic Circle" },
  { id: "south", title: "Far south", unit: "", steps: [1], count: (d) => (d.south !== null && d.south < -40 ? 1 : 0), say: () => "You have been to the far south" },
];

/** What a journal adds up to. Countries and new friends count most. */
export function pointsOf(d: JournalDoc): number {
  return Object.keys(d.countries).length * 10 + Object.keys(d.continents).length * 15 + d.placeCount * 2 + Math.floor(d.metresOnFoot / 1000)
    + Math.floor(d.metresRidden / 2000) + d.friendCount + Object.keys(d.talked).length * 3 + Object.keys(d.ridden).length * 3 + Object.keys(d.earned).length * 2 + Object.keys(d.solved).length * 6
    + (d.days ?? 0) * 5 + (d.favoursDone ?? 0) * 4 + (d.huntsDone ?? 0) * 6 + Object.keys(d.expeditionsDone ?? {}).length * 8
    + (d.races ?? 0) * 3 + (d.racesWon ?? 0) * 4 + (d.games ?? 0) * 3 + (d.gamesWon ?? 0) * 3;
}
export function levelOf(points: number): { n: number; title: string; points: number; from: number; next: number } {
  let n = 1;
  while (points >= pointsFor(n + 1)) n++;
  return { n, title: LEVELS[Math.min(n, LEVELS.length) - 1], points, from: pointsFor(n), next: pointsFor(n + 1) };
}

export function emptyJournal(personId: string | null, now: number): JournalDoc {
  return {
    version: 1, personId, since: now, updated: now, visits: 0, minutes: 0, metresOnFoot: 0, metresRidden: 0, north: null, south: null,
    countries: {}, continents: {}, places: {}, placeCount: 0, friends: {}, friendCount: 0, talked: {}, ridden: {}, earned: {}, solved: {}, pet: null,
    coins: 0, spent: 0, tz: 0, daily: null, days: 0, hats: [], hat: null, favours: [], favoursDone: 0, favoured: {},
    hunt: null, huntsDone: 0, huntBest: null, expeditions: {}, expeditionsDone: {}, morePets: [], car: emptyGarage(), races: 0, racesWon: 0, games: 0, gamesWon: 0, pieces: [],
  };
}

/** Today so far for a journal, without changing it: yesterday's doings do not count. */
const todayOf = (d: JournalDoc, now: number): Daily => {
  const day = dayNumber(now, d.tz);
  return d.daily && d.daily.day >= day ? d.daily : emptyDaily(day);
};
const hatHow = (h: { days?: number; hunts?: number }): string | null =>
  h.days ? (h.days === 1 ? "Do all three tasks in one day" : `Do all three tasks on ${h.days} days`) : h.hunts ? (h.hunts === 1 ? "Find the treasure at the end of a treasure hunt" : `Find ${h.hunts} treasures`) : null;
/** How much of something a player has done, for the prizes that are won by it (home.ts). */
export function featOf(d: JournalDoc, feat: Feat): number {
  switch (feat) {
    case "hunts": return d.huntsDone ?? 0;
    case "races": return d.races ?? 0;
    case "wins": return d.racesWon ?? 0;
    case "countries": return Object.keys(d.countries).length;
    case "days": return d.days ?? 0;
    case "favours": return d.favoursDone ?? 0;
    case "games": return d.games ?? 0;
    case "expeditions": return Object.keys(d.expeditionsDone ?? {}).length;
    case "riddles": return Object.keys(d.solved).length;
    case "friends": return d.friendCount;
  }
}
/** The lost animal a player is taking home, if any. */
const passengerOf = (d: JournalDoc): string | null => {
  for (const id of Object.keys(d.expeditions)) { const e = expeditionById(id); if (e?.sort === "home") return e.passenger; }
  return null;
};

/** A player's own journal, as they are shown it. */
/** The companions a player has won: the answers of the riddles they have solved. */
export function petsOf(d: JournalDoc): string[] {
  return [...new Set([...RIDDLES.filter((r) => d.solved[r.id] && giftOf(r)).map((r) => r.gift), ...(d.morePets ?? [])])];
}

export function viewOf(d: JournalDoc, now = Date.now(), at: { lat: number; lon: number } | null = null): JournalView {
  const newest = <T extends { last: number }>(o: Record<string, T>, n: number): T[] => Object.values(o).sort((a, b) => b.last - a.last).slice(0, n);
  const today = todayOf(d, now);
  return {
    coins: d.coins - d.spent,
    today: {
      tasks: tasksFor(today.day).map((t) => ({ id: t.id, text: t.text, have: Math.min(t.goal, t.have(today)), goal: t.goal, unit: t.unit, done: !!today.done[t.id] })),
      all: today.bonus, coinsEach: TASK_COINS, coinsAll: ALL_TASKS_COINS, fullDays: d.days,
    },
    hats: HATS.map((h) => ({ id: h.id, name: h.name, price: h.price ?? null, how: hatHow(h), owned: d.hats.includes(h.id) })),
    hat: d.hat && d.hats.includes(d.hat) ? d.hat : null,
    favours: d.favours.map((f) => ({ id: f.id, name: f.name, sp: f.sp, text: f.text, coins: f.coins, ...progressOf(f) })),
    favoursDone: d.favoursDone,
    hunt: d.hunt ? ((stop) => ({ at: d.hunt!.at, of: d.hunt!.stops.length, clue: stop.riddle, way: at ? wayTo(at.lat, at.lon, stop.lat, stop.lon) : null, minutes: Math.round((now - d.hunt!.started) / 60_000) }))(d.hunt.stops[d.hunt.at]) : null,
    huntsDone: d.huntsDone,
    huntBestMinutes: d.huntBest === null ? null : Math.max(1, Math.round(d.huntBest / 60_000)),
    expeditions: EXPEDITIONS.map((e) => {
      const on = d.expeditions[e.id];
      const done = !!d.expeditionsDone[e.id];
      const items = itemsOf(e).map((name) => ({ name: e.sort === "album" ? aKind(name).replace(/^an? /, "") : name, got: done || !!on?.got.includes(name) }));
      return { id: e.id, sort: e.sort, title: e.title, blurb: e.blurb, coins: e.coins, state: done ? "done" as const : on ? "active" as const : "open" as const, have: done ? needOf(e) : on?.got.length ?? 0, need: needOf(e), items };
    }),
    passenger: passengerOf(d),
    garage: ((g) => ({
      body: g.body, paint: g.paint,
      paints: CAR_PAINTS.map((p) => ({ ...p, owned: p.price === 0 || g.paints.includes(p.id) })),
      bodies: CAR_BODIES.map((b) => ({ ...b, owned: b.price === 0 || g.bodies.includes(b.id) })),
    }))(d.car ?? emptyGarage()),
    house: { pieces: PIECES.map((p) => ({ id: p.id, slot: p.slot, name: p.name, price: p.price ?? null, how: howWon(p), owned: (d.pieces ?? []).includes(p.id), hex: p.hex })) },
    kept: d.personId !== null,
    since: d.since,
    level: levelOf(pointsOf(d)),
    totals: {
      km: +(d.metresOnFoot / 1000).toFixed(1), kmRidden: +(d.metresRidden / 1000).toFixed(1), minutes: Math.round(d.minutes), visits: d.visits,
      countries: Object.keys(d.countries).length, continents: Object.keys(d.continents).length, places: d.placeCount, friends: d.friendCount,
    },
    countries: Object.entries(d.countries).map(([name, c]) => ({ name, first: c.first })).sort((a, b) => a.first - b.first),
    continents: Object.keys(d.continents),
    // Neighbouring squares often share a name: each name is listed once, at its latest visit.
    places: newest(d.places, 60).filter((p, i, all) => all.findIndex((q) => q.name === p.name && q.country === p.country) === i).slice(0, 12)
      .map((p) => ({ name: p.name, country: p.country, last: p.last, times: p.times })),
    friends: newest(d.friends, 12).map((f) => ({ name: f.name, sp: f.sp, times: f.times, last: f.last })),
    talkedKinds: Object.keys(d.talked),
    riddenKinds: Object.keys(d.ridden),
    riddles: RIDDLES.filter((r) => r.level <= levelOf(pointsOf(d)).n).map((r) => ({ id: r.id, text: r.text, solved: !!d.solved[r.id], answer: d.solved[r.id] ? r.answer : null })),
    moreRiddles: ((later) => (later.length ? { count: later.filter((r) => r.level === later[0].level).length, level: later[0].level } : null))(RIDDLES.filter((r) => r.level > levelOf(pointsOf(d)).n)),
    pets: petsOf(d),
    pet: d.pet && petsOf(d).includes(d.pet) ? d.pet : null,
    stamps: STAMPS.map((s) => {
      const have = s.count(d);
      const done = s.steps.filter((n) => have >= n).length;
      return { id: s.id, title: s.title, have, steps: s.steps, done, next: s.steps[done] ?? null, unit: s.unit };
    }),
  };
}

/** One player who is in the world now. Two windows of one signed-in person share a journal. */
interface Open {
  doc: JournalDoc;
  dirty: boolean;
  log: string[];
  /** Members (connections) writing in this journal. */
  keys: Set<string>;
  /** The write in progress, if any: writes of one journal go one after another. */
  busy: Promise<void>;
}
interface Walker {
  open: Open;
  joined: number;
  /** The last position distance was counted from, and the last one put in the trail. */
  at: { lat: number; lon: number } | null;
  trail: { lat: number; lon: number } | null;
  placeKey: string;
  namedAt: number;
  riding: string | null;
  /** The very thing being ridden (0 for none), and the things that are following this player about. */
  ridingThing: number;
  following: Set<number>;
}

export interface JournalsOptions {
  /** Where journals are kept. Without one nothing is written (tests, and servers without a disk). */
  store?: JournalStore | null;
  placeDetail?: (lat: number, lon: number) => Promise<PlaceDetail>;
  now?: () => number;
  /** Makes the treasure hunt of a neighbourhood on a day (hunt.ts). Without it there are no hunts. */
  planHunt?: (lat: number, lon: number, day: number) => Promise<HuntStop[] | null>;
  /** A test aid: coins a brand-new journal starts with, so that things to buy can be tried without earning them. */
  startCoins?: number;
}

export class Journals {
  private readonly store: JournalStore | null;
  private readonly placeDetail: ((lat: number, lon: number) => Promise<PlaceDetail>) | null;
  private readonly now: () => number;
  private readonly planHunt: JournalsOptions["planHunt"] | null;
  private readonly startCoins: number;
  private readonly walkers = new Map<string, Walker>(); // member id -> their journal
  private readonly byPerson = new Map<string, Open>();
  private tell: (key: string, news: StampNews) => void = () => {};
  private readonly timer: NodeJS.Timeout;
  /** Writes not yet finished, including those of players who have just left. */
  private readonly writing = new Set<Promise<void>>();

  constructor(options: JournalsOptions = {}) {
    this.store = options.store ?? null;
    this.placeDetail = options.placeDetail ?? null;
    this.now = options.now ?? Date.now;
    this.planHunt = options.planHunt ?? null;
    this.startCoins = Math.max(0, Math.floor(options.startCoins ?? 0)) || 0;
    this.timer = setInterval(() => void this.flush(), SAVE_EVERY_MS);
    this.timer.unref();
  }

  /** Who to tell when a player earns something: the rooms, which pass it to that player alone. */
  listen(tell: (key: string, news: StampNews) => void): void {
    this.tell = tell;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }

  /** Writes every journal that has changed, and what has been logged since the last time. */
  async flush(): Promise<void> {
    const store = this.store;
    if (!store) return;
    const seen = new Set<Open>();
    for (const w of this.walkers.values()) seen.add(w.open);
    for (const open of seen) void this.write(open);
    await Promise.all([...this.writing]);
  }

  private write(open: Open): Promise<void> {
    const job = (open.busy = open.busy.then(() => this.writeNow(open)));
    this.writing.add(job);
    void job.finally(() => this.writing.delete(job));
    return job;
  }

  private async writeNow(open: Open): Promise<void> {
    const store = this.store;
    const id = open.doc.personId;
    if (!store || !id) { open.log.length = 0; open.dirty = false; return; }
    const lines = open.log.splice(0);
    const dirty = open.dirty;
    open.dirty = false;
    try {
      if (lines.length) await store.append(id, lines);
      if (dirty) await store.save(open.doc);
    } catch (err) {
      console.error(`journal ${id}: ${err instanceof Error ? err.message : String(err)}`);
      open.dirty = open.dirty || dirty; // try again at the next flush; the lines are lost if the disk refused them
    }
  }

  private note(open: Open, kind: string, more: Record<string, unknown>): void {
    if (!open.doc.personId || !this.store) return;
    open.log.push(JSON.stringify({ at: this.now(), k: kind, ...more }));
  }

  /** Stamps and levels reached since the last look, told to the player once each. */
  private check(key: string, open: Open, levelBefore: number): void {
    const d = open.doc;
    for (const s of STAMPS) {
      const have = s.count(d);
      for (const step of s.steps) {
        const id = `${s.id}:${step}`;
        if (have < step || d.earned[id]) continue;
        d.earned[id] = this.now();
        open.dirty = true;
        this.note(open, "stamp", { id });
        this.tell(key, { kind: "stamp", title: s.steps.length > 1 ? `${s.title}: ${step}` : s.title, text: s.say(step) });
      }
    }
    // Today's tasks: each pays once; all three pay a little more, count as a full day, and may win a hat.
    const t = this.today(d);
    const tasks = tasksFor(t.day);
    for (const task of tasks) {
      if (t.done[task.id] || task.have(t) < task.goal) continue;
      t.done[task.id] = this.now();
      d.coins += TASK_COINS;
      open.dirty = true;
      this.note(open, "task", { id: task.id });
      this.tell(key, { kind: "task", title: "Task done", text: `${task.text}: ${TASK_COINS} coins` });
    }
    if (!t.bonus && tasks.every((task) => t.done[task.id])) {
      t.bonus = true;
      d.coins += ALL_TASKS_COINS;
      d.days++;
      open.dirty = true;
      this.note(open, "day", { day: t.day });
      this.tell(key, { kind: "task", title: "All three tasks done!", text: `${ALL_TASKS_COINS} more coins. There will be three new tasks tomorrow.` });
    }
    // Hats that are won, not bought: for full days, and for treasures found.
    for (const h of HATS) {
      if (d.hats.includes(h.id) || !((h.days && d.days >= h.days) || (h.hunts && d.huntsDone >= h.hunts))) continue;
      d.hats.push(h.id);
      open.dirty = true;
      this.tell(key, { kind: "prize", title: `You have won the ${h.name}`, text: "Put it on in your passport (P)" });
    }
    // Prizes for a house of their own, won by what has been done (home.ts). Several at once are told as one.
    const pieces = (d.pieces ??= []);
    const won = PIECES.filter((p) => p.feat && !pieces.includes(p.id) && featOf(d, p.feat) >= (p.n ?? 1));
    if (won.length) {
      for (const p of won) pieces.push(p.id);
      open.dirty = true;
      const names = won.map((p) => `the ${p.name}`);
      this.tell(key, {
        kind: "prize", title: won.length === 1 ? `For your house: ${names[0]}` : `${won.length} prizes for your house`,
        text: won.length === 1 ? "A prize to stand in a house of your own (H)" : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}, to stand in a house of your own (H)`,
      });
    }
    const level = levelOf(pointsOf(d));
    if (level.n > levelBefore) {
      this.tell(key, { kind: "level", title: `Level ${level.n}: ${level.title}`, text: `You are now ${/^[AEIOU]/.test(level.title) ? "an" : "a"} ${level.title}` });
      const fresh = RIDDLES.filter((r) => r.level > levelBefore && r.level <= level.n).length;
      if (fresh) this.tell(key, { kind: "riddle", title: fresh === 1 ? "A new riddle" : `${fresh} new riddles`, text: "Open your passport (P) to read them" });
    }
  }

  /**
   * Something the player has just done may be the answer to a riddle they have unlocked: talking to a
   * kind of thing, riding one, or (with neither) simply having got about.
   */
  private attempt(key: string, w: Walker, did: { talk?: string; ride?: string }): void {
    const level = levelOf(pointsOf(w.open.doc)).n;
    for (const r of RIDDLES) {
      const d = w.open.doc;
      if (r.level > level || d.solved[r.id]) continue;
      const hit = (r.talk !== undefined && r.talk === did.talk) || (r.ride !== undefined && r.ride === did.ride)
        || (r.continents !== undefined && Object.keys(d.continents).length >= r.continents);
      if (!hit) continue;
      this.note(w.open, "riddle", { id: r.id });
      this.change(key, w, (doc) => { doc.solved[r.id] = this.now(); doc.coins += RIDDLE_COINS; });
      const gift = giftOf(r);
      this.tell(key, { kind: "riddle", title: "Riddle solved!", text: `It was ${r.answer}: ${RIDDLE_COINS} coins.${gift ? ` Now ${/^[aeiou]/.test(gift) ? "an" : "a"} ${gift} will keep you company if you like: see your passport (P).` : ""}` });
    }
  }

  /** Chooses a companion from those the player has won (null for none). False when it is not theirs to choose. */
  setPet(key: string, sp: string | null): boolean {
    const w = this.walkers.get(key);
    if (!w || (sp !== null && !petsOf(w.open.doc).includes(sp))) return false;
    w.open.doc.pet = sp;
    w.open.doc.updated = this.now();
    w.open.dirty = true;
    return true;
  }

  /** The companion a player has chosen, if they still have it. */
  petOf(key: string): string | null {
    const d = this.walkers.get(key)?.open.doc;
    if (!d) return null;
    // A lost animal being taken home walks with the player, in place of the companion they chose.
    return passengerOf(d) ?? (d.pet && petsOf(d).includes(d.pet) ? d.pet : null);
  }

  /** Today's doings, started afresh when the player's day has turned. */
  private today(d: JournalDoc): Daily {
    const day = dayNumber(this.now(), d.tz);
    if (!d.daily || d.daily.day < day) d.daily = emptyDaily(day);
    return d.daily;
  }

  /**
   * Buys a hat with coins and puts it on. "poor" when there are not enough coins, "prize" when it can only
   * be won, "unknown" when there is no such hat. Buying one already owned just puts it on.
   */
  buyHat(key: string, id: string): "ok" | "poor" | "prize" | "unknown" {
    const w = this.walkers.get(key);
    const hat = hatById(id);
    if (!w || !hat) return "unknown";
    const d = w.open.doc;
    if (!d.hats.includes(id)) {
      if (hat.price === undefined) return "prize";
      if (d.coins - d.spent < hat.price) return "poor";
      d.spent += hat.price;
      d.hats.push(id);
      this.note(w.open, "hat", { id, price: hat.price });
    }
    d.hat = id;
    d.updated = this.now();
    w.open.dirty = true;
    return "ok";
  }

  /**
   * Takes a piece for the player's house, buying it first if it is not theirs yet. "poor" when there are not
   * enough coins, "prize" when it can only be won, "unknown" when there is no such piece.
   */
  takePiece(key: string, id: string): "ok" | "poor" | "prize" | "unknown" {
    const w = this.walkers.get(key);
    const piece = pieceById(id);
    if (!w || !piece) return "unknown";
    const d = w.open.doc;
    const pieces = (d.pieces ??= []);
    if (pieces.includes(id)) return "ok";
    if (piece.price === undefined) return "prize";
    if (d.coins - d.spent < piece.price) return "poor";
    d.spent += piece.price;
    pieces.push(id);
    this.note(w.open, "piece", { id, price: piece.price });
    d.updated = this.now();
    w.open.dirty = true;
    return "ok";
  }

  /** Puts on a hat the player owns, or (null) takes it off. False when it is not theirs. */
  wearHat(key: string, id: string | null): boolean {
    const w = this.walkers.get(key);
    if (!w || (id !== null && !w.open.doc.hats.includes(id))) return false;
    w.open.doc.hat = id;
    w.open.doc.updated = this.now();
    w.open.dirty = true;
    return true;
  }

  /**
   * Chooses the paint or the body of the player's car, buying it first if it is not theirs yet.
   * "poor" when there are not enough coins, "unknown" when there is no such paint or body.
   */
  setCar(key: string, choice: { paint?: string; body?: string }): "ok" | "poor" | "unknown" {
    const w = this.walkers.get(key);
    if (!w) return "unknown";
    const d = w.open.doc;
    const g = (d.car ??= emptyGarage());
    const item = choice.paint !== undefined ? paintById(choice.paint) : choice.body !== undefined ? bodyById(choice.body) : undefined;
    if (!item) return "unknown";
    const owned = choice.paint !== undefined ? g.paints : g.bodies;
    if (item.price > 0 && !owned.includes(item.id)) {
      if (d.coins - d.spent < item.price) return "poor";
      d.spent += item.price;
      owned.push(item.id);
      this.note(w.open, "garage", { bought: item.id, price: item.price });
    }
    if (choice.paint !== undefined) g.paint = item.id;
    else g.body = item.id;
    d.updated = this.now();
    w.open.dirty = true;
    return "ok";
  }

  /**
   * A player has finished a race: where they came (1 for first) among how many runners, and their time. Finishing
   * pays coins, and beating somebody pays more; a race run alone is against the clock only.
   */
  raced(key: string, place: number, of: number, ms: number): void {
    const w = this.walkers.get(key);
    if (!w) return;
    const won = place === 1 && of > 1;
    const coins = 15 + (won ? 15 : 0);
    this.note(w.open, "race", { place, of, ms });
    this.tell(key, { kind: "race", title: won ? "You won the race!" : of > 1 ? `You came ${ordinal(place)} of ${of}` : "Race finished", text: `${clock(ms)}: ${coins} coins` });
    this.change(key, w, (d) => {
      d.races = (d.races ?? 0) + 1;
      if (won) d.racesWon = (d.racesWon ?? 0) + 1;
      d.coins += coins;
    });
  }

  /** A game of tag or of hide and seek is over: whether this player won, what it paid, and the words to tell them. */
  played(key: string, kind: string, o: { won: boolean; coins: number; title: string; text: string }): void {
    const w = this.walkers.get(key);
    if (!w) return;
    this.note(w.open, "play", { kind, won: o.won });
    this.tell(key, { kind: "play", title: o.title, text: `${o.text}: ${o.coins} coins` });
    this.change(key, w, (d) => {
      d.games = (d.games ?? 0) + 1;
      if (o.won) d.gamesWon = (d.gamesWon ?? 0) + 1;
      d.coins += o.coins;
    });
  }

  /** How a player's car looks: its body, and its paint as a colour. */
  carOf(key: string): { body: string; paint: number } {
    return lookOf(this.walkers.get(key)?.open.doc.car ?? emptyGarage());
  }

  /** The hat a player is wearing, if any. */
  hatOf(key: string): string | null {
    const d = this.walkers.get(key)?.open.doc;
    return d?.hat && d.hats.includes(d.hat) ? d.hat : null;
  }

  private change(key: string, w: Walker, edit: (d: JournalDoc) => void): void {
    const before = levelOf(pointsOf(w.open.doc)).n;
    edit(w.open.doc);
    w.open.doc.updated = this.now();
    w.open.dirty = true;
    this.check(key, w.open, before);
  }

  /**
   * Someone came into the world. A signed-in person's journal is read from where it is kept.
   * `tzMinutes` is how far their clock is ahead of UTC, which decides when their day turns.
   */
  async joined(key: string, personId: string | null, room: string, tzMinutes?: number): Promise<void> {
    const now = this.now();
    let open = personId ? this.byPerson.get(personId) : undefined;
    if (!open) {
      const kept = personId && this.store ? await this.store.load(personId).catch(() => null) : null;
      open = (personId ? this.byPerson.get(personId) : undefined) // another window may have opened it while we read
        ?? { doc: kept ? { ...emptyJournal(personId, now), ...kept } : { ...emptyJournal(personId, now), coins: this.startCoins }, dirty: false, log: [], keys: new Set(), busy: Promise.resolve() };
      if (personId) this.byPerson.set(personId, open);
    }
    open.keys.add(key);
    const w: Walker = { open, joined: now, at: null, trail: null, placeKey: "", namedAt: 0, riding: null, ridingThing: 0, following: new Set() };
    this.walkers.set(key, w);
    this.note(open, "join", { room });
    this.change(key, w, (d) => {
      d.visits++;
      if (tzMinutes !== undefined && Number.isFinite(tzMinutes)) d.tz = Math.max(-720, Math.min(840, Math.round(tzMinutes)));
    });
    const t = todayOf(open.doc, this.now());
    const left = tasksFor(t.day).filter((task) => !t.done[task.id]);
    if (left.length) this.tell(key, { kind: "task", title: left.length === 3 ? "Three tasks for today" : left.length === 1 ? "One task left today" : "Two tasks left today", text: left.map((task) => task.text).join(" · ") });
  }

  /** Someone left: their time is added up and their journal written. */
  left(key: string): void {
    const w = this.walkers.get(key);
    if (!w) return;
    this.walkers.delete(key);
    const now = this.now();
    w.open.doc.minutes += (now - w.joined) / 60_000;
    w.open.doc.updated = now;
    w.open.dirty = true;
    this.note(w.open, "leave", {});
    w.open.keys.delete(key);
    if (w.open.keys.size === 0 && w.open.doc.personId) this.byPerson.delete(w.open.doc.personId);
    void this.write(w.open);
  }

  /** Called with every position a player reports (ten a second), so most calls must do almost nothing. */
  moved(key: string, lat: number, lon: number): void {
    const w = this.walkers.get(key);
    if (!w) return;
    if (!w.at) {
      w.at = { lat, lon };
      w.trail = { lat, lon };
      this.note(w.open, "go", { lat: +lat.toFixed(5), lon: +lon.toFixed(5) });
      this.whereabouts(key, w, lat, lon);
      this.arrive(key, w, lat, lon);
      return;
    }
    const step = metresBetween(w.at.lat, w.at.lon, lat, lon);
    if (step < STEP_M) return;
    const jumped = step > JUMP_M;
    w.at = { lat, lon };
    if (jumped) {
      w.trail = { lat, lon };
      this.note(w.open, "go", { lat: +lat.toFixed(5), lon: +lon.toFixed(5) });
    } else {
      const riding = w.riding;
      this.change(key, w, (d) => {
        const t = this.today(d);
        if (riding) {
          d.metresRidden += step;
          t.ridden += step;
          if (d.ridden[riding]) d.ridden[riding].metres += step;
        } else {
          d.metresOnFoot += step;
          t.walked += step;
        }
      });
      this.favourSteps(key, w, step);
      if (metresBetween(w.trail!.lat, w.trail!.lon, lat, lon) >= TRAIL_M) {
        w.trail = { lat, lon };
        this.note(w.open, "at", { lat: +lat.toFixed(5), lon: +lon.toFixed(5), ...(riding ? { on: riding } : {}) });
      }
    }
    // Somebody asked to be told what is down the road: far enough now, and time to go back.
    for (const f of w.open.doc.favours) {
      if (f.kind !== "look" || f.away || f.lat === null || f.lon === null || metresBetween(f.lat, f.lon, lat, lon) < f.metres) continue;
      f.away = true;
      w.open.dirty = true;
      this.tell(key, { kind: "favour", title: "Far enough", text: `Now go back and tell ${f.name} what you saw` });
    }
    this.whereabouts(key, w, lat, lon);
    this.arrive(key, w, lat, lon);
  }

  /** Notes the place (about a kilometre across) a player is in, when it is a new one for this visit. */
  private arrive(key: string, w: Walker, lat: number, lon: number): void {
    const placeKey = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const now = this.now();
    if (placeKey === w.placeKey || now - w.namedAt < NAME_EVERY_MS) return;
    w.placeKey = placeKey;
    w.namedAt = now;
    const record = (detail: PlaceDetail): void => {
      if (this.walkers.get(key) !== w) return; // left while the name was being looked up
      const name = detail.name ?? `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
      const continent = continentOf(lat, lon);
      const d0 = w.open.doc;
      const newCountry = detail.country !== null && !d0.countries[detail.country];
      this.note(w.open, "place", { name, country: detail.country, lat: +lat.toFixed(2), lon: +lon.toFixed(2) });
      this.change(key, w, (d) => {
        d.north = d.north === null ? lat : Math.max(d.north, lat);
        d.south = d.south === null ? lat : Math.min(d.south, lat);
        d.continents[continent] = d.continents[continent] ?? now;
        const t = this.today(d);
        if (!t.places.includes(placeKey) && t.places.length < 60) t.places.push(placeKey);
        if (detail.country) d.countries[detail.country] = { first: d.countries[detail.country]?.first ?? now, last: now };
        const seen = d.places[placeKey];
        if (seen) { seen.last = now; seen.times++; seen.name = name; }
        else {
          d.places[placeKey] = { name, country: detail.country, lat: +lat.toFixed(2), lon: +lon.toFixed(2), first: now, last: now, times: 1 };
          d.placeCount++;
          const keys = Object.keys(d.places);
          if (keys.length > PLACE_CAP) delete d.places[keys.reduce((a, b) => (d.places[a].last <= d.places[b].last ? a : b))];
        }
      });
      if (newCountry) this.tell(key, { kind: "country", title: detail.country!, text: "A new country for your passport" });
      this.attempt(key, w, {});
    };
    if (!this.placeDetail) return record({ name: null, country: null });
    this.placeDetail(lat, lon).then(record, () => record({ name: null, country: null }));
  }

  /** Got on something (`sp`), or off it (null). */
  rode(key: string, sp: string | null, thing = 0): void {
    const w = this.walkers.get(key);
    if (!w) return;
    w.ridingThing = sp ? thing : 0;
    if (w.riding === sp) return;
    w.riding = sp;
    if (!sp) return void this.note(w.open, "off", {});
    this.note(w.open, "ride", { sp, thing });
    this.change(key, w, (d) => {
      d.ridden[sp] = d.ridden[sp] ?? { times: 0, metres: 0 };
      d.ridden[sp].times++;
      const t = this.today(d);
      t.rode[sp] = (t.rode[sp] ?? 0) + 1;
    });
    this.attempt(key, w, { ride: sp });
  }

  /** Talked to something. `said` is what the player typed (nothing for a hello) and `reply` what it answered. */
  talked(key: string, thing: number, sp: string, name: string, said: string, reply: string): void {
    const w = this.walkers.get(key);
    if (!w) return;
    const now = this.now();
    this.note(w.open, "talk", { sp, thing, name, ...(said ? { said } : {}), reply });
    this.change(key, w, (d) => {
      d.talked[sp] = (d.talked[sp] ?? 0) + 1;
      const t = this.today(d);
      t.talked[sp] = (t.talked[sp] ?? 0) + 1;
      const id = `${sp}:${thing}`;
      const friend = d.friends[id];
      if (friend) { friend.last = now; friend.times++; friend.name = name; }
      else {
        d.friends[id] = { name, sp, first: now, last: now, times: 1 };
        d.friendCount++;
        t.friends++;
        const keys = Object.keys(d.friends);
        if (keys.length > FRIEND_CAP) delete d.friends[keys.reduce((a, b) => (d.friends[a].last <= d.friends[b].last ? a : b))];
      }
    });
    this.attempt(key, w, { talk: sp });
    // An album being filled: this may be a new kind for it.
    for (const [id, on] of Object.entries(w.open.doc.expeditions)) {
      const e = expeditionById(id);
      if (e?.sort === "album" && e.kinds.includes(sp) && !on.got.includes(sp)) this.tick(key, w, e, sp, `You have met ${aKind(sp)}`);
    }
  }

  // ---- favours (favours.ts)

  /**
   * A player is about to talk to a thing. Favours that this completes are completed (a hello passed on, a
   * parcel brought far enough, a return to the thing that sent them to look), and the thing may ask a favour of
   * its own: when the player offered help (`asked`), or of its own accord if it is one of those that do today.
   */
  beforeTalk(key: string, thing: number, sp: string, name: string, asked: boolean): TalkNews {
    const news: TalkNews = { arrived: [], back: null, offer: null, open: null, full: false, later: false };
    const w = this.walkers.get(key);
    if (!w) return news;
    const d = w.open.doc;
    const now = this.now();
    const day = dayNumber(now, d.tz);
    if (d.favours.some((f) => day - f.day > FAVOUR_DAYS)) { d.favours = d.favours.filter((f) => day - f.day <= FAVOUR_DAYS); w.open.dirty = true; }
    for (const f of [...d.favours]) {
      if ((f.kind === "greet" || f.kind === "carry") && f.want === sp && f.thing !== thing) {
        if (f.kind === "carry" && !(w.at && f.lat !== null && f.lon !== null && metresBetween(f.lat, f.lon, w.at.lat, w.at.lon) >= f.metres)) continue;
        this.finish(key, w, f, false);
        news.arrived.push(f);
      } else if (f.kind === "look" && f.thing === thing && f.sp === sp && f.away) {
        this.finish(key, w, f, false);
        news.back = f;
      }
    }
    const id = `${sp}:${thing}`;
    news.open = d.favours.find((f) => f.id === id) ?? null;
    if (news.open || news.back) return news;
    if (!asked && !asksUnprompted(thing, day)) return news;
    if (d.favoured[id] === day) { news.later = asked; return news; }
    if (d.favours.length >= FAVOURS_OPEN) { news.full = asked; return news; }
    const f = favourOf(thing, sp, name, aKind(sp), day, now, w.at, aKind);
    if (!f) return news;
    d.favours.push(f);
    for (const old of Object.keys(d.favoured)) if (d.favoured[old] < day) delete d.favoured[old];
    d.favoured[id] = day;
    d.updated = now;
    w.open.dirty = true;
    this.note(w.open, "asked", { id, kind: f.kind, text: f.text });
    this.tell(key, { kind: "favour", title: `A favour for ${name}`, text: f.text });
    news.offer = f;
    return news;
  }

  /** A favour is done: it is paid for and counted, and (when the thing itself is at hand) it says thank you. */
  private finish(key: string, w: Walker, f: Favour, thank: boolean): void {
    this.note(w.open, "favour", { id: f.id, kind: f.kind });
    this.tell(key, { kind: "favour", title: "Favour done", text: `${f.text}: ${f.coins} coins`, ...(thank ? { thing: f.thing, sp: f.sp, say: thanksLine(f, f.given) } : {}) });
    this.change(key, w, (d) => {
      d.favours = d.favours.filter((x) => x !== f);
      d.favoursDone++;
      d.coins += f.coins;
      const t = this.today(d);
      t.favours = (t.favours ?? 0) + 1;
    });
  }

  /** A step taken: it counts towards a ride on the thing that asked for one, and a walk with one that is following. */
  private favourSteps(key: string, w: Walker, step: number): void {
    for (const f of [...w.open.doc.favours]) {
      const counts = f.kind === "ride" ? w.riding === f.sp && w.ridingThing === f.thing : f.kind === "walk" ? !w.riding && w.following.has(f.thing) : false;
      if (!counts) continue;
      f.done += step;
      w.open.dirty = true;
      if (f.done >= f.metres) this.finish(key, w, f, true);
    }
  }

  /** A thing has been told to follow this player (or has stopped following). */
  following(key: string, thing: number, on: boolean): void {
    const w = this.walkers.get(key);
    if (!w) return;
    if (on) w.following.add(thing);
    else w.following.delete(thing);
  }

  /** Gives a favour up. It was nobody's fault. */
  dropFavour(key: string, id: string): boolean {
    const w = this.walkers.get(key);
    if (!w || !w.open.doc.favours.some((f) => f.id === id)) return false;
    w.open.doc.favours = w.open.doc.favours.filter((f) => f.id !== id);
    w.open.doc.updated = this.now();
    w.open.dirty = true;
    this.note(w.open, "dropped", { id });
    return true;
  }

  // ---- treasure hunts (hunt.ts) and expeditions (expeditions.ts)

  /**
   * Begins the treasure hunt of where the player stands. "nowhere" when that is not known yet, "none" where the
   * map has too little for a hunt (or hunts are not offered), "busy" when they are on one already.
   */
  async startHunt(key: string): Promise<"ok" | "nowhere" | "none" | "busy"> {
    const w = this.walkers.get(key);
    if (!w?.at) return "nowhere";
    if (w.open.doc.hunt) return "busy";
    if (!this.planHunt) return "none";
    const from = w.at;
    const day = dayNumber(this.now(), w.open.doc.tz);
    const stops = await this.planHunt(from.lat, from.lon, day).catch(() => null);
    if (this.walkers.get(key) !== w) return "nowhere"; // left while the map was being read
    if (w.open.doc.hunt) return "busy";
    if (!stops?.length) return "none";
    const now = this.now();
    w.open.doc.hunt = { cell: huntCell(from.lat, from.lon).id, day, stops, at: 0, started: now };
    w.open.doc.updated = now;
    w.open.dirty = true;
    this.note(w.open, "hunt", { stops: stops.map((s) => s.what) });
    const here = w.at ?? from;
    this.tell(key, { kind: "hunt", title: "A treasure hunt!", text: `Clue 1 of ${stops.length}: ${stops[0].riddle} It is ${wayTo(here.lat, here.lon, stops[0].lat, stops[0].lon)}.` });
    this.whereabouts(key, w, here.lat, here.lon);
    return "ok";
  }

  /** Gives the treasure hunt up. Another can be begun at once. */
  dropHunt(key: string): boolean {
    const w = this.walkers.get(key);
    if (!w?.open.doc.hunt) return false;
    w.open.doc.hunt = null;
    w.open.dirty = true;
    this.note(w.open, "hunt-dropped", {});
    return true;
  }

  /**
   * Sets out on an expedition. "done" for one already finished, "full" with three under way, "busy" when a
   * second lost animal is asked for while the first is still on its way home.
   */
  startExpedition(key: string, id: string): "ok" | "unknown" | "done" | "full" | "busy" {
    const w = this.walkers.get(key);
    const e = expeditionById(id);
    if (!w || !e) return "unknown";
    const d = w.open.doc;
    if (d.expeditionsDone[id]) return "done";
    if (d.expeditions[id]) return "ok";
    if (e.sort === "home" && passengerOf(d)) return "busy";
    if (Object.keys(d.expeditions).length >= EXPEDITIONS_OPEN) return "full";
    d.expeditions[id] = { started: this.now(), got: [] };
    d.updated = this.now();
    w.open.dirty = true;
    this.note(w.open, "expedition", { id });
    this.tell(key, { kind: "expedition", title: `Setting out: ${e.title}`, text: e.blurb });
    if (w.at) this.whereabouts(key, w, w.at.lat, w.at.lon);
    return "ok";
  }

  /** Gives an expedition up. It can be begun again, from the beginning. */
  dropExpedition(key: string, id: string): boolean {
    const w = this.walkers.get(key);
    if (!w?.open.doc.expeditions[id]) return false;
    delete w.open.doc.expeditions[id];
    w.open.dirty = true;
    this.note(w.open, "expedition-dropped", { id });
    return true;
  }

  /** Something for an expedition has been met or reached: it is ticked off, and that may be the last of it. */
  private tick(key: string, w: Walker, e: Expedition, item: string, text: string): void {
    const d = w.open.doc;
    const on = d.expeditions[e.id];
    if (!on) return;
    on.got.push(item);
    w.open.dirty = true;
    const need = needOf(e);
    if (on.got.length < need) return void this.tell(key, { kind: "expedition", title: `${e.title}: ${on.got.length} of ${need}`, text });
    this.note(w.open, "expedition-done", { id: e.id });
    delete d.expeditions[e.id]; // over before it is announced, so that a lost animal has left the player's side by then
    this.tell(key, {
      kind: "expedition", title: `Expedition done: ${e.title}`,
      text: `${text}. ${e.coins} coins.${e.sort === "home" ? ` ${/^[aeiou]/.test(e.passenger) ? "An" : "A"} ${e.passenger} will keep you company whenever you like: see your passport (P).` : ""}`,
    });
    this.change(key, w, (doc) => {
      delete doc.expeditions[e.id];
      doc.expeditionsDone[e.id] = this.now();
      doc.coins += e.coins;
      if (e.sort === "home" && !doc.morePets.includes(e.passenger)) doc.morePets.push(e.passenger);
    });
  }

  /** Where a player now stands may be the next clue of their hunt, a place on a tour, or a lost animal's home. */
  private whereabouts(key: string, w: Walker, lat: number, lon: number): void {
    const d = w.open.doc;
    const h = d.hunt;
    if (h) {
      const stop = h.stops[h.at];
      if (metresBetween(stop.lat, stop.lon, lat, lon) <= stop.reach) {
        h.at++;
        w.open.dirty = true;
        const next = h.stops[h.at];
        if (next) this.tell(key, { kind: "hunt", title: `Found it: ${stop.what}`, text: `Clue ${h.at + 1} of ${h.stops.length}: ${next.riddle} It is ${wayTo(lat, lon, next.lat, next.lon)}.` });
        else {
          const took = this.now() - h.started;
          const coins = 20 + 10 * h.stops.length;
          const quickest = d.huntBest === null || took < d.huntBest;
          const minutes = Math.max(1, Math.round(took / 60_000));
          this.note(w.open, "treasure", { stops: h.stops.length, ms: took });
          this.tell(key, {
            kind: "hunt", title: "Treasure found!", at: { lat: +lat.toFixed(6), lon: +lon.toFixed(6) }, // where the finder stands: the place itself may be the middle of a house
            text: `It was at ${stop.what}. ${h.stops.length} clues in ${minutes === 1 ? "a minute" : `${minutes} minutes`}${quickest && d.huntsDone > 0 ? ", your quickest hunt yet" : ""}: ${coins} coins.`,
          });
          this.change(key, w, (doc) => {
            doc.hunt = null;
            doc.huntsDone++;
            doc.coins += coins;
            if (quickest) doc.huntBest = took;
          });
        }
      }
    }
    for (const [id, on] of Object.entries(d.expeditions)) {
      const e = expeditionById(id);
      if (e?.sort === "tour") {
        for (const p of e.places) {
          if (on.got.includes(p.name) || metresBetween(p.lat, p.lon, lat, lon) > e.reachKm * 1000) continue;
          this.tick(key, w, e, p.name, `You have reached ${p.name}`);
          if (!d.expeditions[id]) break; // that was the last of it
        }
      } else if (e?.sort === "home" && e.home(lat, lon)) this.tick(key, w, e, e.where, `The ${e.passenger} is home, in ${e.where}`);
    }
  }

  /** The journal of a member who is in the world now. */
  view(key: string): JournalView | null {
    const w = this.walkers.get(key);
    if (!w) return null;
    return viewOf({ ...w.open.doc, minutes: w.open.doc.minutes + (this.now() - w.joined) / 60_000 }, this.now(), w.at);
  }

  /** The journal of a signed-in person, whether or not they are in the world now. */
  async viewPerson(personId: string): Promise<JournalView> {
    const open = this.byPerson.get(personId);
    if (open) return viewOf(open.doc, this.now());
    const kept = this.store ? await this.store.load(personId).catch(() => null) : null;
    return viewOf(kept ? { ...emptyJournal(personId, this.now()), ...kept } : emptyJournal(personId, this.now()), this.now());
  }
}
