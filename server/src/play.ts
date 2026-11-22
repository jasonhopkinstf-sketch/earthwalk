// Tag, and hide and seek: games players play with each other on a field round the spot where one
// of them set the game up. Like a race (race.ts) a game is set up by one player, joined by any in
// the room, and started by whoever set it up; unlike a race it needs at least two.
//
// Tag: one player is "it". Touching another makes them it instead (but nobody can be tagged
// straight back). After three minutes whoever was it for the least time has won. A player who
// leaves the field becomes it.
//
// Hide and seek: one player, picked by lot, is the seeker. For half a minute the seeker's game
// shows them nothing while the others hide; then the seeker has four minutes to find them, by
// coming close. A hider who leaves the field is found. If everyone is found the seeker has won;
// anyone still hidden at the end has won.
//
// The server judges, from the positions players already send: nothing a game says can tag or find
// anyone. This file holds the rules and the state of one game; rooms.ts feeds it positions.

export type PlayKind = "tag" | "hide";

export const FIELD_M: Record<PlayKind, number> = { tag: 90, hide: 140 };
export const COUNTDOWN_MS = 5000;
export const TAG_FOR_MS = 3 * 60_000;
export const HIDE_FOR_MS = 30_000;
export const SEEK_FOR_MS = 4 * 60_000;
/** How near counts as a touch, how long the last one tagged is safe from the new "it", and how long out of the field is allowed. */
export const TAG_REACH_M = 3;
export const FIND_REACH_M = 4.5;
export const SAFE_MS = 3000;
export const OUT_MS = 5000;
const OPEN_FOR_MS = 10 * 60_000;
const RESULTS_FOR_MS = 60_000;

export interface Contestant {
  id: string;
  name: string;
  /** Tag: how long they have been it, in milliseconds (settled each time "it" changes hands). */
  itMs: number;
  /** Hide and seek: when they were found (0 while still hidden; the seeker is never found). */
  found: number;
  /** When they were first seen outside the field this time (0 while inside). */
  out: number;
}
/** A game as the room keeps it and as everyone is told it. Times are in the server's clock. */
export interface Play {
  kind: PlayKind;
  by: string;
  byName: string;
  /** The middle of the field, and how far it reaches. */
  lat: number;
  lon: number;
  radius: number;
  state: "open" | "go" | "over";
  made: number;
  /** When play begins (after the countdown), when hiding ends (hide and seek), when it all ends, and when it did. */
  startAt: number;
  seekAt: number;
  endAt: number;
  ended: number;
  /** Tag: who is it, since when, and who cannot be tagged just now. Hide and seek: `it` is the seeker. */
  it: string | null;
  since: number;
  safe: { id: string; until: number } | null;
  players: Contestant[];
}
export interface Where { lat: number; lon: number; alt: number }

const metresBetween = (aLat: number, aLon: number, bLat: number, bLon: number): number =>
  Math.hypot((bLat - aLat) * 111_320, (bLon - aLon) * 111_320 * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180));

const contestant = (id: string, name: string): Contestant => ({ id, name, itMs: 0, found: 0, out: 0 });

export function newPlay(kind: PlayKind, by: string, byName: string, lat: number, lon: number, now: number): Play {
  return {
    kind, by, byName, lat: +lat.toFixed(7), lon: +lon.toFixed(7), radius: FIELD_M[kind], state: "open", made: now, startAt: 0, seekAt: 0, endAt: 0, ended: 0,
    it: null, since: 0, safe: null, players: [contestant(by, byName)],
  };
}

export function joinPlay(play: Play, id: string, name: string): boolean {
  if (play.state !== "open" || play.players.some((p) => p.id === id)) return false;
  play.players.push(contestant(id, name));
  return true;
}

/** Starts the game: someone is picked by lot to be it (or to seek), and the clocks are set. False with fewer than two players. */
export function beginPlay(play: Play, now: number, countdownMs = COUNTDOWN_MS, lot: () => number = Math.random): boolean {
  if (play.state !== "open" || play.players.length < 2) return false;
  play.state = "go";
  play.startAt = now + countdownMs;
  play.it = play.players[Math.min(play.players.length - 1, Math.floor(lot() * play.players.length))].id;
  play.since = play.startAt;
  if (play.kind === "tag") {
    play.seekAt = play.startAt;
    play.endAt = play.startAt + TAG_FOR_MS;
  } else {
    play.seekAt = play.startAt + HIDE_FOR_MS;
    play.endAt = play.seekAt + SEEK_FOR_MS;
  }
  return true;
}

function finish(play: Play, now: number): void {
  if (play.kind === "tag") {
    const it = play.players.find((p) => p.id === play.it);
    if (it) it.itMs += Math.max(0, Math.min(now, play.endAt) - play.since);
  }
  play.state = "over";
  play.ended = now;
}

/**
 * Looks at where everyone is at time `now` and applies the rules. Returns true when anything about
 * the game changed (someone tagged, found or out of the field, or the game over), so that the room
 * knows to tell everyone. Safe to call as often as positions arrive, and now and then besides.
 */
export function stepPlay(play: Play, where: (id: string) => Where | null, now: number): boolean {
  if (play.state !== "go" || now < play.startAt) return false;
  if (now >= play.endAt) { finish(play, now); return true; }
  const it = play.players.find((p) => p.id === play.it);
  const itAt = it ? where(it.id) : null;
  let changed = false;
  /** Whether a player has been outside the field long enough to count as out of it. */
  const strayed = (p: Contestant, at: Where): boolean => {
    if (metresBetween(play.lat, play.lon, at.lat, at.lon) <= play.radius + 5) { p.out = 0; return false; }
    if (!p.out) p.out = now;
    return now - p.out >= OUT_MS;
  };

  if (play.kind === "tag") {
    if (!it) return false;
    const becomes = (p: Contestant): void => {
      it.itMs += Math.max(0, now - play.since);
      play.safe = { id: it.id, until: now + SAFE_MS };
      play.it = p.id;
      play.since = now;
      p.out = 0;
      changed = true;
    };
    if (play.safe && now >= play.safe.until) play.safe = null;
    for (const p of play.players) {
      if (p === it) continue;
      const at = where(p.id);
      if (!at) continue;
      if (strayed(p, at)) return becomes(p), true; // ran off the field: now they are it
      if (!itAt || play.safe?.id === p.id) continue;
      if (metresBetween(itAt.lat, itAt.lon, at.lat, at.lon) <= TAG_REACH_M && Math.abs(itAt.alt - at.alt) <= 3) return becomes(p), true;
    }
    return changed;
  }

  // Hide and seek. While the hiders hide, nothing can happen to them.
  if (now < play.seekAt) return false;
  for (const p of play.players) {
    if (p === it || p.found) continue;
    const at = where(p.id);
    if (!at) continue;
    const seen = !!itAt && metresBetween(itAt.lat, itAt.lon, at.lat, at.lon) <= FIND_REACH_M && Math.abs(itAt.alt - at.alt) <= 4;
    if (seen || strayed(p, at)) { p.found = now; changed = true; }
  }
  if (play.players.every((p) => p === it || p.found)) { finish(play, now); return true; }
  return changed;
}

/** Someone leaves the game (or the room). The game ends when its maker goes, or when too few are left to play. */
export function leavePlay(play: Play, id: string, now: number): "gone" | "ended" | "on" {
  if (!play.players.some((p) => p.id === id)) return "on";
  if (play.state === "go" && play.kind === "tag" && play.it === id) {
    // "It" has gone: the one who has been it least takes over.
    const rest = play.players.filter((p) => p.id !== id);
    if (rest.length) { play.it = [...rest].sort((a, b) => a.itMs - b.itMs)[0].id; play.since = now; play.safe = null; }
  }
  play.players = play.players.filter((p) => p.id !== id);
  if (play.by === id || play.players.length === 0 || (play.state === "go" && (play.players.length < 2 || play.it === id))) return "ended";
  return "gone";
}

export interface Outcome { id: string; won: boolean; coins: number; title: string; text: string }
const span = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
};

/** How a finished game came out for each player: who won, what it paid, and a line to tell them. */
export function outcomes(play: Play): Outcome[] {
  if (play.kind === "tag") {
    const least = Math.min(...play.players.map((p) => p.itMs));
    return play.players.map((p) => {
      const won = p.itMs === least;
      return { id: p.id, won, coins: 10 + (won ? 10 : 0), title: won ? "You won at tag!" : "Tag is over", text: `You were it for ${span(p.itMs)}` };
    });
  }
  const hiders = play.players.filter((p) => p.id !== play.it);
  const found = hiders.filter((p) => p.found).length;
  return play.players.map((p) => {
    if (p.id === play.it) {
      const won = found === hiders.length;
      return { id: p.id, won, coins: 10 + 5 * found, title: won ? "You found everyone!" : "Hide and seek is over", text: `You found ${found} of ${hiders.length}` };
    }
    const won = !p.found;
    return { id: p.id, won, coins: 10 + (won ? 10 : 0), title: won ? "You were never found!" : "You were found", text: won ? "The best hiding place of all" : `After ${span(p.found - play.seekAt)} of seeking` };
  });
}

/** Whether a game has run its time and should be cleared away. */
export function stalePlay(play: Play, now: number): boolean {
  return play.state === "open" ? now - play.made > OPEN_FOR_MS : play.state === "over" ? now - play.ended > RESULTS_FOR_MS : false;
}
