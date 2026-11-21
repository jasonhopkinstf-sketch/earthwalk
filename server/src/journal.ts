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
}
/** Something worth telling a player the moment it happens. */
export interface StampNews { title: string; text: string; kind: "country" | "stamp" | "level" }

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
  { id: "kinds", title: "Kinds of friend", unit: "kinds", steps: [3, 8, 15, 23], count: (d) => Object.keys(d.talked).length, say: (n) => `You have talked to ${n} different kinds of thing` },
  { id: "mounts", title: "Things ridden", unit: "kinds", steps: [1, 4, 8, 12], count: (d) => Object.keys(d.ridden).length, say: (n) => `You have ridden ${one(n, "kind of thing", "kinds of thing")}` },
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
    + Math.floor(d.metresRidden / 2000) + d.friendCount + Object.keys(d.talked).length * 3 + Object.keys(d.ridden).length * 3 + Object.keys(d.earned).length * 2;
}
export function levelOf(points: number): { n: number; title: string; points: number; from: number; next: number } {
  let n = 1;
  while (points >= pointsFor(n + 1)) n++;
  return { n, title: LEVELS[Math.min(n, LEVELS.length) - 1], points, from: pointsFor(n), next: pointsFor(n + 1) };
}

export function emptyJournal(personId: string | null, now: number): JournalDoc {
  return {
    version: 1, personId, since: now, updated: now, visits: 0, minutes: 0, metresOnFoot: 0, metresRidden: 0, north: null, south: null,
    countries: {}, continents: {}, places: {}, placeCount: 0, friends: {}, friendCount: 0, talked: {}, ridden: {}, earned: {},
  };
}

/** A player's own journal, as they are shown it. */
export function viewOf(d: JournalDoc): JournalView {
  const newest = <T extends { last: number }>(o: Record<string, T>, n: number): T[] => Object.values(o).sort((a, b) => b.last - a.last).slice(0, n);
  return {
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
}

export interface JournalsOptions {
  /** Where journals are kept. Without one nothing is written (tests, and servers without a disk). */
  store?: JournalStore | null;
  placeDetail?: (lat: number, lon: number) => Promise<PlaceDetail>;
  now?: () => number;
}

export class Journals {
  private readonly store: JournalStore | null;
  private readonly placeDetail: ((lat: number, lon: number) => Promise<PlaceDetail>) | null;
  private readonly now: () => number;
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
    const level = levelOf(pointsOf(d));
    if (level.n > levelBefore) this.tell(key, { kind: "level", title: `Level ${level.n}: ${level.title}`, text: `You are now ${/^[AEIOU]/.test(level.title) ? "an" : "a"} ${level.title}` });
  }

  private change(key: string, w: Walker, edit: (d: JournalDoc) => void): void {
    const before = levelOf(pointsOf(w.open.doc)).n;
    edit(w.open.doc);
    w.open.doc.updated = this.now();
    w.open.dirty = true;
    this.check(key, w.open, before);
  }

  /** Someone came into the world. A signed-in person's journal is read from where it is kept. */
  async joined(key: string, personId: string | null, room: string): Promise<void> {
    const now = this.now();
    let open = personId ? this.byPerson.get(personId) : undefined;
    if (!open) {
      const kept = personId && this.store ? await this.store.load(personId).catch(() => null) : null;
      open = (personId ? this.byPerson.get(personId) : undefined) // another window may have opened it while we read
        ?? { doc: kept ? { ...emptyJournal(personId, now), ...kept } : emptyJournal(personId, now), dirty: false, log: [], keys: new Set(), busy: Promise.resolve() };
      if (personId) this.byPerson.set(personId, open);
    }
    open.keys.add(key);
    const w: Walker = { open, joined: now, at: null, trail: null, placeKey: "", namedAt: 0, riding: null };
    this.walkers.set(key, w);
    this.note(open, "join", { room });
    this.change(key, w, (d) => { d.visits++; });
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
        if (riding) {
          d.metresRidden += step;
          if (d.ridden[riding]) d.ridden[riding].metres += step;
        } else d.metresOnFoot += step;
      });
      if (metresBetween(w.trail!.lat, w.trail!.lon, lat, lon) >= TRAIL_M) {
        w.trail = { lat, lon };
        this.note(w.open, "at", { lat: +lat.toFixed(5), lon: +lon.toFixed(5), ...(riding ? { on: riding } : {}) });
      }
    }
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
    };
    if (!this.placeDetail) return record({ name: null, country: null });
    this.placeDetail(lat, lon).then(record, () => record({ name: null, country: null }));
  }

  /** Got on something (`sp`), or off it (null). */
  rode(key: string, sp: string | null, thing = 0): void {
    const w = this.walkers.get(key);
    if (!w || w.riding === sp) return;
    w.riding = sp;
    if (!sp) return void this.note(w.open, "off", {});
    this.note(w.open, "ride", { sp, thing });
    this.change(key, w, (d) => {
      d.ridden[sp] = d.ridden[sp] ?? { times: 0, metres: 0 };
      d.ridden[sp].times++;
    });
  }

  /** Talked to something. `said` is what the player typed (nothing for a hello) and `reply` what it answered. */
  talked(key: string, thing: number, sp: string, name: string, said: string, reply: string): void {
    const w = this.walkers.get(key);
    if (!w) return;
    const now = this.now();
    this.note(w.open, "talk", { sp, thing, name, ...(said ? { said } : {}), reply });
    this.change(key, w, (d) => {
      d.talked[sp] = (d.talked[sp] ?? 0) + 1;
      const id = `${sp}:${thing}`;
      const friend = d.friends[id];
      if (friend) { friend.last = now; friend.times++; friend.name = name; }
      else {
        d.friends[id] = { name, sp, first: now, last: now, times: 1 };
        d.friendCount++;
        const keys = Object.keys(d.friends);
        if (keys.length > FRIEND_CAP) delete d.friends[keys.reduce((a, b) => (d.friends[a].last <= d.friends[b].last ? a : b))];
      }
    });
  }

  /** The journal of a member who is in the world now. */
  view(key: string): JournalView | null {
    const w = this.walkers.get(key);
    if (!w) return null;
    return viewOf({ ...w.open.doc, minutes: w.open.doc.minutes + (this.now() - w.joined) / 60_000 });
  }

  /** The journal of a signed-in person, whether or not they are in the world now. */
  async viewPerson(personId: string): Promise<JournalView> {
    const open = this.byPerson.get(personId);
    if (open) return viewOf(open.doc);
    const kept = this.store ? await this.store.load(personId).catch(() => null) : null;
    return viewOf(kept ? { ...emptyJournal(personId, this.now()), ...kept } : emptyJournal(personId, this.now()));
  }
}
