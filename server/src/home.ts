// A house of your own. Any house that opens (interior.ts) can be made a player's own: their name goes
// up over the door, friends can walk in, and its rooms are furnished the way they choose. One house a
// person; moving to another takes the furnishing along.
//
// Furnishing is by swapping: the rooms stay as the house's layout has them, and each sofa, bed and rug,
// the paint on the walls and the floors can be swapped for another from the catalogue here. Some pieces
// are bought with coins; prizes are won by doing things in the world (the journal counts them) and stand
// in the house for visitors to see.
//
// `Homes` is who lives where. The server builds the inside of an owned house from what is kept here, so
// it never has to read the map again for it.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HomeDoor } from "./chunk.ts";

/** What can be swapped: the paint on the walls, the floors, the sofa, the beds, the rugs; and prizes put on show. */
export type Slot = "walls" | "floor" | "sofa" | "bed" | "rug" | "prize";
export const SLOTS: Slot[] = ["walls", "floor", "sofa", "bed", "rug", "prize"];
/** What a prize is won for: one of the journal's counts, and how many. */
export type Feat = "hunts" | "races" | "wins" | "countries" | "days" | "favours" | "games" | "expeditions" | "riddles" | "friends";

export interface Piece {
  id: string;
  slot: Slot;
  name: string;
  /** Coins, for one that is bought. */
  price?: number;
  /** For one that is won: what for. */
  feat?: Feat;
  n?: number;
  /** Its main colours, for the catalogue to show. */
  hex: number[];
}

/** Everything there is. A slot left alone keeps what the house was built with. */
export const PIECES: Piece[] = [
  { id: "sun", slot: "walls", name: "Sunshine yellow", price: 20, hex: [0xf6dc7a] },
  { id: "sky", slot: "walls", name: "Sky blue", price: 20, hex: [0xa9d3ee] },
  { id: "mint", slot: "walls", name: "Mint green", price: 20, hex: [0xb5e3c3] },
  { id: "rose", slot: "walls", name: "Rose pink", price: 20, hex: [0xf2b8c6] },
  { id: "lilac", slot: "walls", name: "Lilac", price: 20, hex: [0xcdb8ea] },
  { id: "peach", slot: "walls", name: "Peach", price: 20, hex: [0xf7c6a0] },
  { id: "night", slot: "walls", name: "Night sky", price: 45, hex: [0x2c3a6b, 0xf2e394] },
  { id: "stripes", slot: "walls", name: "Circus stripes", price: 60, hex: [0xd94a3a, 0xf7f5ef] },

  { id: "oak", slot: "floor", name: "Golden oak boards", price: 25, hex: [0xd9a75a] },
  { id: "walnut", slot: "floor", name: "Dark walnut boards", price: 25, hex: [0x6b4630] },
  { id: "white", slot: "floor", name: "White boards", price: 25, hex: [0xefeae0] },
  { id: "check", slot: "floor", name: "Black and white tiles", price: 40, hex: [0x2b2b2f, 0xf2f0ea] },
  { id: "redcarpet", slot: "floor", name: "Red carpet", price: 35, hex: [0xb5372e] },
  { id: "lawn", slot: "floor", name: "Indoor lawn", price: 50, hex: [0x5fae4a] },

  { id: "royal", slot: "sofa", name: "Royal sofa", price: 60, hex: [0x6a3d9a, 0xe0b23c] },
  { id: "cloud", slot: "sofa", name: "Cloud sofa", price: 50, hex: [0xf4f6fa, 0xa9d3ee] },
  { id: "racer", slot: "sofa", name: "Racing sofa", price: 50, hex: [0xd9382e, 0x26262b] },
  { id: "bench", slot: "sofa", name: "Log bench", price: 30, hex: [0x8a5a3a, 0x5fae4a] },

  { id: "bunk", slot: "bed", name: "Bunk beds", price: 70, hex: [0xc9a36b, 0x3f6fb0] },
  { id: "poster", slot: "bed", name: "Four-poster bed", price: 90, hex: [0x6f4a30, 0xb5372e] },
  { id: "racecar", slot: "bed", name: "Racing car bed", price: 100, hex: [0xd9382e, 0x26262b] },
  { id: "boat", slot: "bed", name: "Boat bed", price: 100, hex: [0x3f6fb0, 0xf7f5ef] },

  { id: "rainbow", slot: "rug", name: "Rainbow rug", price: 30, hex: [0xd9382e, 0xe0a82e, 0x3f9a45, 0x3f6fb0] },
  { id: "chess", slot: "rug", name: "Chessboard rug", price: 30, hex: [0x2b2b2f, 0xf2f0ea] },
  { id: "target", slot: "rug", name: "Bullseye rug", price: 30, hex: [0xd9382e, 0xf7f5ef] },

  { id: "rocking", slot: "prize", name: "Rocking horse", price: 60, hex: [0xc9a36b, 0xd9382e] },
  { id: "fishtank", slot: "prize", name: "Fish tank", price: 90, hex: [0x7fc4e8, 0xe8935a] },
  { id: "piano", slot: "prize", name: "Piano", price: 150, hex: [0x26262b, 0xf7f5ef] },
  { id: "telescope", slot: "prize", name: "Telescope", price: 80, hex: [0xb98c5a, 0xe0b23c] },
  { id: "chest", slot: "prize", name: "Treasure chest", feat: "hunts", n: 1, hex: [0x8a5a3a, 0xe0b23c] },
  { id: "cup", slot: "prize", name: "Racing cup", feat: "races", n: 3, hex: [0xe0b23c] },
  { id: "goldcup", slot: "prize", name: "Winner's golden cup", feat: "wins", n: 1, hex: [0xf2c94c, 0x26262b] },
  { id: "globe", slot: "prize", name: "Globe", feat: "countries", n: 3, hex: [0x3f6fb0, 0x3f9a45] },
  { id: "clock", slot: "prize", name: "Grandfather clock", feat: "days", n: 3, hex: [0x6f4a30, 0xf2e394] },
  { id: "thanks", slot: "prize", name: "Thank-you tree", feat: "favours", n: 5, hex: [0x3f9a45, 0xe0b23c] },
  { id: "games", slot: "prize", name: "Games table", feat: "games", n: 3, hex: [0x3f7f4f, 0x8a5a3a] },
  { id: "map", slot: "prize", name: "Explorer's map table", feat: "expeditions", n: 1, hex: [0xe8dcc8, 0x8a5a3a] },
  { id: "owl", slot: "prize", name: "Wise owl statue", feat: "riddles", n: 5, hex: [0xb9c0c6, 0xe0b23c] },
  { id: "friends", slot: "prize", name: "Wall of friends", feat: "friends", n: 20, hex: [0xf7f5ef, 0xd87a9a, 0x3f6fb0] },
];
const BY_ID = new Map(PIECES.map((p) => [p.id, p]));
export const pieceById = (id: string): Piece | undefined => BY_ID.get(id);

/** How a prize is won, in words. */
export function howWon(p: Piece): string | null {
  const n = p.n ?? 1;
  switch (p.feat) {
    case "hunts": return n === 1 ? "Find the treasure at the end of a treasure hunt" : `Find ${n} treasures`;
    case "races": return `Finish ${n} races`;
    case "wins": return n === 1 ? "Win a race against somebody" : `Win ${n} races`;
    case "countries": return `Visit ${n} countries`;
    case "days": return `Do all three daily tasks on ${n} days`;
    case "favours": return `Do ${n} favours`;
    case "games": return `Play ${n} games with friends`;
    case "expeditions": return n === 1 ? "Finish an expedition" : `Finish ${n} expeditions`;
    case "riddles": return `Solve ${n} riddles`;
    case "friends": return `Make ${n} friends by talking to things`;
    default: return null;
  }
}

/** The choices that make a house somebody's own: a piece for each slot (or none), and the prizes on show, in order. */
export interface Decor { walls?: string; floor?: string; sofa?: string; bed?: string; rug?: string; prizes: string[] }
export const emptyDecor = (): Decor => ({ prizes: [] });
/** At most this many prizes stand in a house at once. */
export const PRIZES_SHOWN = 6;

/** A decor with only pieces that exist, each in its own slot. */
export function cleanDecor(raw: unknown): Decor {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Decor = { prizes: [] };
  for (const slot of ["walls", "floor", "sofa", "bed", "rug"] as const) {
    const id = d[slot];
    if (typeof id === "string" && pieceById(id)?.slot === slot) out[slot] = id;
  }
  if (Array.isArray(d.prizes)) for (const id of d.prizes) if (typeof id === "string" && pieceById(id)?.slot === "prize" && !out.prizes.includes(id) && out.prizes.length < PRIZES_SHOWN) out.prizes.push(id);
  return out;
}

/**
 * The garden: young animals of one's own, kept before the front door. Each is bought small, is fed once a day
 * from the lunch box, and after so many meals is grown; a grown one gives something once a day. Nothing
 * happens to one that is not fed: it waits, the same size, however long its owner is away.
 */
export interface Young {
  sp: string;
  /** Meals it has had, the day it last had one, and the day it last gave something (days as the daily tasks count them). */
  fed: number;
  fedDay: number;
  gaveDay: number;
  born: number;
}
export interface Breed { sp: string; young: string; grown: string; price: number; meals: number; gives: { food?: string; coins?: number; what: string } }
export const BREEDS: Breed[] = [
  { sp: "chicken", young: "chick", grown: "hen", price: 20, meals: 3, gives: { food: "egg", what: "an egg" } },
  { sp: "sheep", young: "lamb", grown: "sheep", price: 35, meals: 4, gives: { coins: 8, what: "a bag of wool" } },
  { sp: "pig", young: "piglet", grown: "pig", price: 35, meals: 4, gives: { coins: 10, what: "a truffle it dug up" } },
  { sp: "cow", young: "calf", grown: "cow", price: 50, meals: 5, gives: { food: "milk", what: "a glass of milk" } },
];
export const breedOf = (sp: string): Breed | undefined => BREEDS.find((b) => b.sp === sp);
/** A garden holds this many. */
export const GARDEN_MAX = 4;
/** How big one is drawn, of its full size: small at first, full grown after its last meal. */
export const sizeOf = (y: Young): number => { const b = breedOf(y.sp); return b ? Math.min(1, 0.45 + 0.55 * (y.fed / b.meals)) : 1; };
export const isGrown = (y: Young): boolean => y.fed >= (breedOf(y.sp)?.meals ?? 0);
/** What its owner is told of each: what it is called now, how far along, and what can be done with it today. */
export function gardenView(garden: Young[], day: number): { sp: string; name: string; fed: number; meals: number; grown: boolean; hungry: boolean; ready: boolean; gives: string }[] {
  return garden.map((y) => {
    const b = breedOf(y.sp)!;
    const grown = isGrown(y);
    return { sp: y.sp, name: grown ? b.grown : b.young, fed: Math.min(y.fed, b.meals), meals: b.meals, grown, hungry: !grown && y.fedDay !== day, ready: grown && y.gaveDay !== day, gives: b.gives.what };
  });
}

/** A house somebody lives in. `home` is all the server needs to build its inside again. */
export interface Lived {
  /** The chunk it stands in and its number there. */
  x: number; y: number; id: number;
  /** Its front door, and the compass heading that leads out of it. */
  lat: number; lon: number; yaw: number;
  /** Who lives there: their person (or, for a guest, their connection), and the name on the door. */
  owner: string;
  name: string;
  /** False for a guest's: it is theirs only until they leave. */
  lasting: boolean;
  decor: Decor;
  /** Counts each change, so that games know when to fetch the inside again. */
  rev: number;
  since: number;
  home: HomeDoor;
  /** Which making of the world `home` was measured in (GENERATOR_REV): after another, it is measured again. */
  gen: number;
  /** The young animals in its garden. Missing in houses from before there were any. */
  garden?: Young[];
}
/** What everybody is told of a house that is lived in: `garden` is the animals before its door, each with what it is and how big (0.45 to 1). */
export interface LivedView { x: number; y: number; id: number; lat: number; lon: number; yaw: number; name: string; rev: number; garden?: { sp: string; size: number }[] }
export const viewOfLived = (l: Lived): LivedView => ({
  x: l.x, y: l.y, id: l.id, lat: l.lat, lon: l.lon, yaw: l.yaw, name: l.name, rev: l.rev,
  ...(l.garden?.length ? { garden: l.garden.map((y) => ({ sp: y.sp, size: Math.round(sizeOf(y) * 100) / 100 })) } : {}),
});

export const houseKey = (x: number, y: number, id: number): string => `${x}/${y}/${id}`;
/** No more houses than this are kept: a family and their friends need a few dozen. */
export const HOMES_MAX = 2000;

export interface HomesStore { load(): Promise<Lived[]>; save(all: Lived[]): Promise<void> }

/** Who lives where. */
export class Homes {
  private readonly byKey = new Map<string, Lived>();
  private readonly byOwner = new Map<string, Lived>();
  private readonly store: HomesStore | null;
  private readonly now: () => number;
  private saving: Promise<void> = Promise.resolve();
  /** The last change number given out. They never repeat, not between owners of one house and not after a restart: games and the server tell furnishings apart by them. */
  private counter: number;

  constructor(store: HomesStore | null = null, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
    this.counter = Math.floor(now() / 1000);
  }

  private tick(): number {
    return ++this.counter;
  }

  /** Reads the houses kept from before. A file that cannot be read is an empty street, never a failure. */
  async open(): Promise<void> {
    let kept: Lived[] = [];
    try { kept = (await this.store?.load()) ?? []; } catch (err) { console.error("homes: could not be read", err); }
    for (const l of kept) {
      if (!l || typeof l.owner !== "string" || !l.home || this.byOwner.has(l.owner)) continue;
      const lived: Lived = { ...l, lasting: true, decor: cleanDecor(l.decor), rev: l.rev | 0 };
      this.byKey.set(houseKey(l.x, l.y, l.id), lived);
      this.byOwner.set(l.owner, lived);
    }
  }

  at(x: number, y: number, id: number): Lived | null {
    return this.byKey.get(houseKey(x, y, id)) ?? null;
  }
  of(owner: string): Lived | null {
    return this.byOwner.get(owner) ?? null;
  }
  list(): LivedView[] {
    return [...this.byKey.values()].map(viewOfLived);
  }

  /**
   * Makes a house `owner`'s own. "taken" when somebody else lives there, "full" when no more can be kept.
   * A house they had before is given up, and its furnishing comes along.
   */
  claim(owner: string, name: string, lasting: boolean, where: { x: number; y: number; id: number; lat: number; lon: number; yaw: number; home: HomeDoor; gen: number }): { got: "ok" | "taken" | "full" | "same"; left: Lived | null } {
    const key = houseKey(where.x, where.y, where.id);
    const there = this.byKey.get(key);
    if (there) return { got: there.owner === owner ? "same" : "taken", left: null };
    const before = this.byOwner.get(owner) ?? null;
    if (!before && this.byKey.size >= HOMES_MAX) return { got: "full", left: null };
    if (before) this.byKey.delete(houseKey(before.x, before.y, before.id));
    const lived: Lived = { ...where, owner, name, lasting, decor: before?.decor ?? emptyDecor(), rev: this.tick(), since: this.now(), ...(before?.garden?.length ? { garden: before.garden } : {}) }; // the animals move house too
    this.byKey.set(key, lived);
    this.byOwner.set(owner, lived);
    this.keep();
    return { got: "ok", left: before };
  }

  /** Gives a house up. Returns the house that was theirs. */
  leave(owner: string): Lived | null {
    const lived = this.byOwner.get(owner);
    if (!lived) return null;
    this.byOwner.delete(owner);
    this.byKey.delete(houseKey(lived.x, lived.y, lived.id));
    if (lived.lasting) this.keep();
    return lived;
  }

  /** Changes how a house is furnished, or the name on its door. Returns it, or null when they have none. */
  change(owner: string, edit: { decor?: Decor; name?: string }): Lived | null {
    const lived = this.byOwner.get(owner);
    if (!lived) return null;
    if (edit.decor) lived.decor = cleanDecor(edit.decor);
    if (edit.name && edit.name !== lived.name) lived.name = edit.name;
    lived.rev = this.tick();
    this.keep();
    return lived;
  }

  // ---- the garden. None of these changes the inside of the house, so `rev` stays as it is.

  /** A young animal comes to live in the garden. "full" when it holds as many as it can, "nohome" without a house. */
  adopt(owner: string, sp: string): "ok" | "full" | "nohome" | "unknown" {
    const lived = this.byOwner.get(owner);
    if (!breedOf(sp)) return "unknown";
    if (!lived) return "nohome";
    const garden = (lived.garden ??= []);
    if (garden.length >= GARDEN_MAX) return "full";
    garden.push({ sp, fed: 0, fedDay: -1, gaveDay: -1, born: this.now() });
    if (lived.lasting) this.keep();
    return "ok";
  }

  /** Can this one be fed today? "grown" when it needs no more feeding, "today" when it has eaten already. */
  hungry(owner: string, i: number, day: number): "ok" | "grown" | "today" | "none" {
    const y = this.byOwner.get(owner)?.garden?.[i];
    return !y ? "none" : isGrown(y) ? "grown" : y.fedDay === day ? "today" : "ok";
  }

  /** It has been fed: one meal nearer to grown. Returns it. */
  fed(owner: string, i: number, day: number): Young | null {
    const lived = this.byOwner.get(owner);
    const y = lived?.garden?.[i];
    if (!lived || !y || this.hungry(owner, i, day) !== "ok") return null;
    y.fed++;
    y.fedDay = day;
    if (lived.lasting) this.keep();
    return y;
  }

  /** What a grown one gives today, once: its breed, or null when it is not grown or has given already. */
  gather(owner: string, i: number, day: number): Breed | null {
    const lived = this.byOwner.get(owner);
    const y = lived?.garden?.[i];
    if (!lived || !y || !isGrown(y) || y.gaveDay === day) return null;
    y.gaveDay = day;
    if (lived.lasting) this.keep();
    return breedOf(y.sp) ?? null;
  }

  /** One goes to live on a farm, to make room. */
  release(owner: string, i: number): boolean {
    const lived = this.byOwner.get(owner);
    if (!lived?.garden?.[i]) return false;
    lived.garden.splice(i, 1);
    if (lived.lasting) this.keep();
    return true;
  }

  /** The house as the world now has it, after the world was made again: its walls and floor may have moved a little. */
  measured(lived: Lived, found: { lat: number; lon: number; yaw: number; home: HomeDoor } | null, gen: number): void {
    if (found) Object.assign(lived, { lat: found.lat, lon: found.lon, yaw: found.yaw, home: found.home });
    lived.gen = gen;
    lived.rev = this.tick();
    if (lived.lasting) this.keep();
  }

  /** Writes the lasting houses, one write after another; a failed write is logged and forgotten. */
  private keep(): void {
    const store = this.store;
    if (!store) return;
    this.saving = this.saving.then(() => store.save([...this.byKey.values()].filter((l) => l.lasting))).catch((err) => console.error("homes: could not be kept", err));
  }
  /** Resolves when everything changed so far has been written. */
  settled(): Promise<void> {
    return this.saving;
  }
}

/** The houses as one file, written whole each time (there are few). */
export class FileHomesStore implements HomesStore {
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }
  async load(): Promise<Lived[]> {
    try {
      const kept: unknown = JSON.parse(await readFile(this.file, "utf8"));
      return Array.isArray(kept) ? (kept as Lived[]) : [];
    } catch {
      return [];
    }
  }
  async save(all: Lived[]): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(all));
    await rename(tmp, this.file);
  }
}
