// Favours: small jobs that the things a player talks to ask of them, each to do with what the
// thing is. A horse wants a run, a cat a walk, a house has a parcel for another house, a tree that
// cannot move wants to hear what is down the road. The second of the games on the journal
// (journal.ts), after the daily tasks.
//
// The kinds are fixed and listed here; an AI, when there is one, only finds the thing's own words
// for the asking. What a thing asks is decided by who it is and what day it is, so friends who
// talk to the same cow on the same day are asked the same favour and can do it together. The server
// notices a favour done from what it already hears (`talk`, `ride`, `order`, positions). Nothing
// can be failed: a favour waits until it is done or dropped.

import { hash32 } from "./geo.ts";
import type { TalkNews } from "./journal.ts";

export type FavourKind = "ride" | "walk" | "greet" | "carry" | "look";

/** A favour somebody has been asked and has not yet done. */
export interface Favour {
  /** The giver, as kind and identity ("cow:918398760"). A thing has one favour out to a player at a time. */
  id: string;
  thing: number;
  sp: string;
  name: string;
  kind: FavourKind;
  /** For `greet` and `carry`: the kind of thing to talk to. */
  want: string | null;
  /** How far: to ride or walk, to carry the parcel, or to go before coming back. 0 for `greet`. */
  metres: number;
  coins: number;
  /** The favour in a line, for the passport ("Ride Daisy the cow for 300 metres"). */
  text: string;
  given: number;
  day: number;
  /** Where the player stood when it was asked, when that was known. */
  lat: number | null;
  lon: number | null;
  /** Metres ridden or walked so far; and, for `look`, whether they have been far enough away yet. */
  done: number;
  away: boolean;
}

/** How many favours a player may have open, and how long one is kept before it is quietly forgotten. */
export const FAVOURS_OPEN = 3;
export const FAVOUR_DAYS = 3;

const STEEDS = new Set(["horse", "cow", "sheep", "camel", "llama", "kangaroo", "deer", "donkey", "pig", "goat", "zebra", "elephant", "giraffe", "bison", "moose", "reindeer", "bear", "lion", "panda", "tortoise"]);
const WALKERS = new Set(["chicken", "duck", "pigeon", "cat", "dog", "rabbit", "squirrel", "penguin", "goose", "mouse", "hedgehog", "fox", "frog", "snail", "crab", "beaver", "otter", "swan", "heron", "seagull", "sparrow", "flamingo", "seal",
  "butterfly", "bee", "dragonfly", "ladybird", "ant", "grasshopper", "monkey", "koala", "capybara", "marmot"]);
const MOTORS = new Set(["car", "tractor"]);
/** Kinds that keep company with their own, so that another one is never far to find. */
const HERDS = new Set(["cow", "sheep", "horse", "chicken", "duck", "pig", "goat", "goose", "pigeon", "deer", "rabbit", "penguin", "kangaroo", "llama", "camel", "zebra", "elephant", "bison", "reindeer", "flamingo", "ant", "bee", "seagull", "sparrow"]);

const COINS: Record<FavourKind, number> = { ride: 20, walk: 20, greet: 15, carry: 25, look: 25 };

/** Whether what a player typed is an offer of help ("can I help?", "any jobs?"). */
export const offersHelp = (said: string): boolean =>
  /\b(help|favou?rs?|jobs?|missions?|quests?|errands?|chores?)\b|\b(any|some)thing (i|we) (can|could) do\b|\bneed anything\b|\bwhat can (i|we) do\b/i.test(said);

/** Whether a thing asks its favour of its own accord when greeted (about one in three does, a different third each day). */
export const asksUnprompted = (thing: number, day: number): boolean => hash32(thing, day * 31 + 0x464156) % 3 === 0;

/**
 * The favour a thing has to ask today, or null for one that has none (a taxi is at work already).
 * `name` and `a` are who it is ("Daisy", "a cow"); `aOf` gives the same for any kind. `placed` says
 * whether it is known where the player is, without which nothing can be measured from here.
 */
export function favourOf(thing: number, sp: string, name: string, a: string, day: number, now: number, at: { lat: number; lon: number } | null, aOf: (sp: string) => string): Favour | null {
  const kinds: FavourKind[] = STEEDS.has(sp) ? ["ride", "ride", "walk", ...(HERDS.has(sp) ? ["greet" as const] : [])]
    : WALKERS.has(sp) ? ["walk", "walk", "greet"]
    : MOTORS.has(sp) ? ["ride"]
    : sp === "train" || sp === "boat" || sp === "sailboat" ? ["ride"]
    : sp === "tree" || sp === "house" ? ["carry", "look", "greet"]
    : sp === "bird" ? ["greet"]
    : [];
  if (!kinds.length) return null;
  const pick = <T>(list: T[], salt: number): T => list[hash32(thing, day * 131 + salt) % list.length];
  let kind = pick(kinds, 1);
  if (!at && (kind === "carry" || kind === "look")) kind = "greet";
  const who = `${name} the ${a.replace(/^an? /, "")}`;
  let want: string | null = null;
  let metres = 0;
  let text: string;
  if (kind === "ride") {
    metres = MOTORS.has(sp) ? pick([400, 500, 600], 2) : sp === "train" ? pick([600, 800, 1000], 2) : sp === "boat" || sp === "sailboat" ? pick([200, 300], 2) : pick([200, 300, 400], 2);
    text = `${MOTORS.has(sp) ? "Drive" : "Ride"} ${who} for ${metres} metres`;
  } else if (kind === "walk") {
    metres = pick([150, 200, 300], 2);
    text = `Take ${who} for a walk of ${metres} metres (say "follow me")`;
  } else if (kind === "carry") {
    want = sp; // a parcel from house to house, a seed from tree to tree
    metres = pick([150, 250, 350], 2);
    text = sp === "house" ? `Take ${name}'s parcel to another house, at least ${metres} metres away` : `Carry one of ${name}'s seeds to another tree, at least ${metres} metres away`;
  } else if (kind === "look") {
    metres = pick([150, 200, 250], 2);
    text = `Go ${metres} metres from ${who}, then come back and say what you saw`;
  } else {
    want = HERDS.has(sp) && hash32(thing, day + 3) % 2 === 0 ? sp
      : sp === "tree" ? pick(["house", "tree"], 3)
      : sp === "house" ? pick(["tree", "car", "house"], 3)
      : pick(["tree", "house"], 3);
    text = want === sp ? `Say hello to another ${a.replace(/^an? /, "")} for ${name}` : `Say hello to ${aOf(want)} for ${who}`;
  }
  return { id: `${sp}:${thing}`, thing, sp, name, kind, want, metres, coins: COINS[kind], text, given: now, day, lat: at?.lat ?? null, lon: at?.lon ?? null, done: 0, away: false };
}

/** How a thing asks its favour, when it has to find the words itself. */
export function askLine(f: Favour, aOf: (sp: string) => string): string {
  const kindOf = (sp: string): string => aOf(sp).replace(/^an? /, "");
  switch (f.kind) {
    case "ride":
      return MOTORS.has(f.sp) ? `Would you do me a favour? I have been parked all day. Hop in (press E) and drive me ${f.metres} metres.`
        : f.sp === "train" ? `Would you do me a favour? Ride with me for ${f.metres} metres (press E). I like company on the line.`
        : f.sp === "boat" || f.sp === "sailboat" ? `Would you do me a favour? Take me out on the water for ${f.metres} metres (press E to come aboard).`
        : `Would you do me a favour? I am longing for a run. Hop on (press E) and ride me ${f.metres} metres.`;
    case "walk":
      return `Would you do me a favour? I would love a walk. Say "follow me" and take me ${f.metres} metres with you.`;
    case "carry":
      return f.sp === "house" ? `Would you do me a favour? I have a parcel for another house. Take it to one at least ${f.metres} metres from here, and just say hello to it.`
        : `Would you do me a favour? Carry one of my seeds to another tree, at least ${f.metres} metres from here, and say hello to it.`;
    case "look":
      return `Would you do me a favour? I cannot leave this spot. Walk ${f.metres} metres away, then come back and tell me what you saw.`;
    default:
      return f.want === f.sp ? `Would you do me a favour? Say hello to another ${kindOf(f.sp)} for me, and tell them ${f.name} sent you.`
        : `Would you do me a favour? Say hello to ${aOf(f.want ?? "tree")} for me, and tell them ${f.name} sent you.`;
  }
}

/** What a favour looks like part-way: how far along, out of what, and what to do next. */
export function progressOf(f: Favour): { have: number; goal: number; unit: string; next: string } {
  if (f.kind === "ride" || f.kind === "walk") return { have: Math.min(f.metres, Math.floor(f.done)), goal: f.metres, unit: "m", next: f.kind === "ride" ? "Press E beside them to get on." : "Say \"follow me\" to them, then walk." };
  if (f.kind === "look") return { have: f.away ? 1 : 0, goal: 2, unit: "", next: f.away ? `Far enough. Now go back and talk to ${f.name}.` : `Walk ${f.metres} metres away first.` };
  return { have: 0, goal: 1, unit: "", next: f.kind === "carry" ? "Talk to one that is far enough away." : "Talk to one (press T beside it)." };
}

/** What the thing at the other end says when a hello or a parcel reaches it, and what a giver says in thanks. */
export function arrivalLine(f: Favour): string {
  return f.kind === "carry" ? (f.sp === "house" ? `A parcel from ${f.name}? How kind of you to bring it all this way!` : `A seed from ${f.name}? I shall find it a good spot. Thank you!`)
    : `A hello from ${f.name}? How lovely. Say hello back from me!`;
}
/**
 * What a thing says when favours come into a chat and it has to find the words itself: `line` is what it
 * would have said anyway. `asked` is whether the player offered to help.
 */
export function favourWords(line: string, news: TalkNews, asked: boolean, aOf: (sp: string) => string): string {
  const parts: string[] = [];
  if (news.arrived.length) parts.push(arrivalLine(news.arrived[0]));
  if (news.back) parts.push(thanksLine(news.back, news.back.given));
  if (!parts.length && !(asked && (news.offer || news.open || news.full || news.later))) parts.push(line);
  if (news.offer) parts.push(askLine(news.offer, aOf));
  else if (news.open && asked) parts.push(`You are doing me a favour already, remember? ${askLine(news.open, aOf).replace("Would you do me a favour? ", "")}`);
  else if (news.full) parts.push("I would ask you a favour, but your hands are full. Finish one first: your passport (P) lists them.");
  else if (news.later) parts.push("You have helped me once today already, and I am grateful. Come back tomorrow!");
  return parts.join(" ").slice(0, 400);
}

/** The same, as notes for an AI that will find the thing's own words (talk.ts). */
export function favourNotes(news: TalkNews, aOf: (sp: string) => string): string[] {
  const notes: string[] = [];
  const kindOf = (sp: string): string => aOf(sp).replace(/^an? /, "");
  for (const f of news.arrived) notes.push(`This visitor has just brought you ${f.kind === "carry" ? (f.sp === "house" ? "a parcel" : "a seed") : "a hello"} from ${f.name} the ${kindOf(f.sp)}, as a favour to ${f.name}. Be pleased about it, and say so.`);
  if (news.back) notes.push(`This visitor has just come back from walking ${news.back.metres} metres away to look around for you, as you asked them to. Thank them warmly: you are delighted with whatever they say they saw.`);
  if (news.offer) notes.push(`You have a favour to ask this visitor, and you ask it now, at the end of your answer, in your own voice. What you want is this: "${askLine(news.offer, aOf)}" Keep the distance, and the key to press, as they are.`);
  else if (news.open) notes.push(`You asked this visitor a favour earlier and it is not done yet: ${news.open.text}. If they ask about it, remind them kindly.`);
  else if (news.full) notes.push("They offered to help you, but they already have three favours on the go. Tell them kindly to finish one first; their passport (the P key) lists them.");
  else if (news.later) notes.push("They have already done you a favour today. Thank them again, and say there will be something else tomorrow.");
  return notes;
}

export function thanksLine(f: Favour, n: number): string {
  const lines = f.kind === "look" ? ["You came back! Thank you. Now I know what is out there.", "Thank you for being my eyes. That was a real favour."]
    : f.kind === "ride" ? ["That was wonderful. Thank you for the run!", "Just what I needed. Thank you!"]
    : ["What a lovely walk. Thank you!", "Thank you! My legs needed that."];
  return lines[n % lines.length];
}
