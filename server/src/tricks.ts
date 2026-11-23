// Tricks: what a companion (the animal that follows its player about) can be taught. Each trick is learnt in
// a small game of timing: the server sets a row of beats, the player presses in time with them, and the
// server marks the presses. One slip is forgiven, and a lesson that does not come off costs nothing: it is
// simply had again. A trick once learnt is that animal's for good, and it does it when asked, for everyone
// nearby to see.
//
// The tricks are taught in order, each a little quicker and longer than the last.

import { hash32 } from "./geo.ts";

export interface Trick {
  id: string;
  name: string;
  /** How many beats its lesson has, and how near a beat a press must fall (milliseconds either side). */
  beats: number;
  slackMs: number;
}
export const TRICKS: Trick[] = [
  { id: "sit", name: "Sit up", beats: 3, slackMs: 380 },
  { id: "spin", name: "Spin", beats: 4, slackMs: 330 },
  { id: "jump", name: "Jump", beats: 4, slackMs: 290 },
  { id: "bow", name: "Take a bow", beats: 5, slackMs: 260 },
  { id: "fetch", name: "Fetch", beats: 5, slackMs: 230 },
  { id: "hoop", name: "Jump through a hoop", beats: 6, slackMs: 210 },
  { id: "dance", name: "Dance", beats: 7, slackMs: 190 },
];
export const trickById = (id: string): Trick | undefined => TRICKS.find((t) => t.id === id);
/** Coins for each trick taught. */
export const TRICK_COINS = 10;
/** The first beat comes this long after the lesson begins, to get ready in. */
export const LEAD_MS = 1800;

/** The beats of a lesson, in milliseconds from its start: unevenly spaced, so that they have to be watched. */
export function lesson(trick: Trick, seed: number): number[] {
  const beats: number[] = [];
  let at = LEAD_MS;
  for (let i = 0; i < trick.beats; i++) {
    beats.push(at);
    at += 650 + (hash32(seed, 0x42454154 + i) % 5) * 150; // 650 to 1250 ms on
  }
  return beats;
}

/**
 * Marks a lesson: each beat is met by at most one press within the trick's slack of it, and each press meets
 * at most one beat. It comes off when all the beats but one are met, without a flurry of presses in the hope
 * of hitting something.
 */
export function judge(trick: Trick, beats: number[], presses: number[]): { hits: number; of: number; passed: boolean } {
  const left = presses.filter((p) => Number.isFinite(p)).slice(0, 40).sort((a, b) => a - b);
  let hits = 0;
  for (const beat of beats) {
    const at = left.findIndex((p) => Math.abs(p - beat) <= trick.slackMs);
    if (at < 0) continue;
    left.splice(at, 1);
    hits++;
  }
  return { hits, of: beats.length, passed: hits >= beats.length - 1 && presses.length <= beats.length + 2 };
}

/** What a companion knows, and what it could learn next: the tricks in order, each known or not. */
export function tricksView(known: string[]): { all: { id: string; name: string; known: boolean }[]; next: string | null } {
  const all = TRICKS.map((t) => ({ id: t.id, name: t.name, known: known.includes(t.id) }));
  return { all, next: all.find((t) => !t.known)?.id ?? null };
}
