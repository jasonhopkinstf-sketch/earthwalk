// Progress: what a journal's points are made of, what has just earned some, and the nearest next step.
//
// The journal (journal.ts) keeps the counts; this says what each is worth. A player's level rises with
// their points, and the game shows it as a bar that is always on screen (docs/PROTOCOL.md, "Progress").
// Getting about and making friends count, and so does looking after yourself and others: filling the
// five hearts, feeding hungry animals, cooking, and teaching a companion its tricks. Points are only
// ever added: nothing takes them away, and nobody is kept out of anything for want of them.

import { dayNumber } from "./daily.ts";
import { GROUPS } from "./food.ts";
import type { JournalDoc } from "./journal.ts";
import { aKind } from "./talk.ts";

/** A level, as the journal and the bar show it: `hint` is the nearest next step, in a few words. */
export interface LevelView { n: number; title: string; points: number; from: number; next: number; hint?: string }

/** What a player is told when their points rise, and once on coming in to say where they stand. */
export interface ProgressNews {
  level: LevelView;
  /** Points just earned (0 when this only says where the player stands) and, in a few words, what earned them. */
  gained: number;
  why: string | null;
  /** A new level reached with these points: its number and name, the coins it paid, and how many riddles it opened. */
  up?: { n: number; title: string; coins: number; riddles: number };
}

const NUMBERS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
/** A small number in words ("two"), a larger one in figures. */
export const inWords = (n: number): string => NUMBERS[n] ?? String(n);
const kindOf = (sp: string): string => aKind(sp).replace(/^an? /, "");
const lastKey = (o: Record<string, unknown>): string | undefined => { let last: string | undefined; for (const k in o) last = k; return last; };
const total = (o: Record<string, number> | undefined): number => Object.values(o ?? {}).reduce((a, b) => a + b, 0);

/** Today so far for a journal, without changing it (null when nothing has been done today). */
const todayOf = (d: JournalDoc, now: number): JournalDoc["daily"] => (d.daily && d.daily.day >= dayNumber(now, d.tz) ? d.daily : null);

/**
 * One thing that earns points: how many of it a journal has, what each is worth, and what to say when there
 * are more of it than a moment ago (`n` more). They are in the order of what is most worth saying: when
 * several rise at once (a new friend of a new kind, and a stamp for it), the first is the one named.
 */
interface Part { id: string; each: number; count: (d: JournalDoc) => number; say: (d: JournalDoc, n: number, now: number) => string }
export const PARTS: Part[] = [
  { id: "cared", each: 3, count: (d) => d.caredFor ?? 0, say: (d, _n, now) => ((sp) => (sp ? `fed a hungry ${kindOf(sp)}` : "fed a hungry animal"))((todayOf(d, now)?.cared ?? []).at(-1)?.split(":")[0]) },
  { id: "countries", each: 10, count: (d) => Object.keys(d.countries).length, say: (d) => `a new country: ${lastKey(d.countries) ?? "somewhere new"}` },
  { id: "continents", each: 15, count: (d) => Object.keys(d.continents).length, say: (d) => `a new continent: ${lastKey(d.continents) ?? "somewhere new"}` },
  { id: "solved", each: 6, count: (d) => Object.keys(d.solved).length, say: () => "solved a riddle" },
  { id: "hunts", each: 6, count: (d) => d.huntsDone ?? 0, say: () => "found the treasure" },
  { id: "expeditions", each: 8, count: (d) => Object.keys(d.expeditionsDone ?? {}).length, say: () => "finished an expedition" },
  { id: "favours", each: 4, count: (d) => d.favoursDone ?? 0, say: () => "did a favour" },
  { id: "racesWon", each: 4, count: (d) => d.racesWon ?? 0, say: () => "won a race" },
  { id: "races", each: 3, count: (d) => d.races ?? 0, say: () => "finished a race" },
  { id: "gamesWon", each: 3, count: (d) => d.gamesWon ?? 0, say: () => "won a game" },
  { id: "games", each: 3, count: (d) => d.games ?? 0, say: () => "played a game" },
  { id: "agility", each: 2, count: (d) => d.agilityRuns ?? 0, say: () => "ran an agility round" },
  { id: "healthy", each: 5, count: (d) => d.healthyDays ?? 0, say: () => "filled all five hearts" },
  { id: "hearts", each: 1, count: (d) => d.heartsFilled ?? 0, say: (_d, n) => (n === 1 ? "filled a heart" : `filled ${inWords(n)} hearts`) },
  { id: "cooked", each: 2, count: (d) => total(d.cooked), say: () => "cooked a meal" },
  { id: "tricks", each: 3, count: (d) => Object.values(d.tricks ?? {}).reduce((n, list) => n + list.length, 0), say: () => "taught a trick" },
  { id: "days", each: 5, count: (d) => d.days ?? 0, say: () => "did all three tasks" },
  { id: "kinds", each: 3, count: (d) => Object.keys(d.talked).length, say: (d) => ((sp) => (sp ? `met your first ${kindOf(sp)}` : "met a new kind of friend"))(lastKey(d.talked)) },
  { id: "friends", each: 1, count: (d) => d.friendCount, say: (d) => ((f) => (f ? `made friends with ${f.name}` : "made a new friend"))(d.friends[lastKey(d.friends) ?? ""]) },
  { id: "mounts", each: 3, count: (d) => Object.keys(d.ridden).length, say: (d) => ((sp) => (sp ? `first ride on ${aKind(sp)}` : "rode something new"))(lastKey(d.ridden)) },
  { id: "places", each: 2, count: (d) => d.placeCount, say: (d, n) => (n === 1 ? ((p) => (p ? `a new place: ${p.name}` : "found a new place"))(d.places[lastKey(d.places) ?? ""]) : `found ${inWords(n)} new places`) },
  { id: "walked", each: 1, count: (d) => Math.floor(d.metresOnFoot / 1000), say: (_d, n) => (n === 1 ? "walked a kilometre" : `walked ${inWords(n)} kilometres`) },
  { id: "ridden", each: 1, count: (d) => Math.floor(d.metresRidden / 2000), say: () => "rode two kilometres" },
  { id: "stamps", each: 2, count: (d) => Object.keys(d.earned).length, say: (_d, n) => (n === 1 ? "a new stamp" : `${inWords(n)} new stamps`) },
];

/** How many of each thing that earns points a journal has, in the order of `PARTS`. */
export const countsOf = (d: JournalDoc): number[] => PARTS.map((p) => p.count(d));
/** What those counts add up to. */
export const pointsFrom = (counts: number[]): number => counts.reduce((sum, n, i) => sum + n * PARTS[i].each, 0);
/** In a few words, what a journal has more of than it had at `before` (null when nothing has risen). */
export function whyOf(d: JournalDoc, before: number[], after: number[], now: number): string | null {
  const i = PARTS.findIndex((_p, k) => after[k] > before[k]);
  return i < 0 ? null : PARTS[i].say(d, after[i] - before[i], now);
}

/** The coins a new level pays: a little more each time. */
export const levelCoins = (n: number): number => 10 * n;
/** The coins paid in all for rising from one level to another. */
export const levelPrizes = (from: number, to: number): number => { let coins = 0; for (let n = from + 1; n <= to; n++) coins += levelCoins(n); return coins; };

/**
 * The nearest next step to the level after this one, in a few words: "Two new places to level 4". It names
 * the least trouble that would do it: a new friend is a point, a new place two, a riddle six, a new country
 * ten, and a day's five hearts ten between them. It promises nothing it cannot keep: stamps and the like
 * come on top, so the step named is always enough. `riddlesOpen` is how many riddles wait to be solved.
 */
export function hintOf(d: JournalDoc, level: LevelView, now: number, riddlesOpen: number): string {
  const need = Math.max(1, level.next - level.points);
  const to = `level ${level.n + 1}`;
  const today = todayOf(d, now);
  const empty = GROUPS.length - (today?.ate ?? []).length;
  const ways: { trouble: number; text: string }[] = [];
  // Filling the hearts that are still empty today: a point each, and five more for the full set.
  if (empty > 0 && !today?.fed && need <= empty + 5) {
    ways.push({ trouble: empty * 0.9, text: `Fill your ${empty === GROUPS.length ? "five hearts" : empty === 1 ? "last heart" : `last ${inWords(empty)} hearts`} for ${to}` });
  }
  const riddles = Math.ceil(need / 6);
  if (riddles <= riddlesOpen) ways.push({ trouble: riddles * 3, text: `Solve ${inWords(riddles)} ${riddles === 1 ? "riddle" : "riddles"} for ${to}` });
  const countries = Math.ceil(need / 10);
  ways.push({ trouble: countries * 3.5, text: `${inWords(countries)} new ${countries === 1 ? "country" : "countries"} to ${to}` });
  const places = Math.ceil(need / 2);
  ways.push({ trouble: places, text: `${inWords(places)} new ${places === 1 ? "place" : "places"} to ${to}` });
  ways.push({ trouble: need * 0.6, text: `${inWords(need)} new ${need === 1 ? "friend" : "friends"} to ${to}` });
  const best = ways.reduce((a, b) => (b.trouble < a.trouble ? b : a));
  return best.text[0].toUpperCase() + best.text.slice(1);
}
