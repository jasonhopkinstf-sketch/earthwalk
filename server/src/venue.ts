// The inside of a building that is not a home: an office, a shop, a café, a mall (which, small, is
// an arcade or a row of shops), or the entrance hall of a block of flats or a hotel. Like a house's rooms (interior.ts), everything follows from the
// building's own numbers, so it is the same inside for everyone and on every visit; unlike a house,
// it has a way through, from the door on the street to a door on another side, and people in it.
//
// Everything is laid out in the building's own frame, in metres: `a` runs along the front wall, `b`
// back into the building from it, `z` up from the floor. The room is `width` by `depth`; the front
// door is on the wall b = 0. What comes out is a list of plain boxes and panels, the people (where
// each sits, stands or strolls), the lettering (a shop's name over its front) and the tills (where
// food is sold). venues.ts decides which buildings get which, and turns the boxes into a mesh.

import { hash32 } from "./geo.ts";
import type { MaterialDef } from "./chunk.ts";
import { INSIDE } from "./interior.ts";

export type VenueKind = "office" | "shop" | "cafe" | "mall" | "lobby";
/** A door of the room: which wall (0 front, 1 back, 2 the wall a = 0, 3 the wall a = width) and how far along it. `lo` and `hi`, when given, are how far it may be moved along its wall. */
export interface VenueDoor { side: 0 | 1 | 2 | 3; at: number; lo?: number; hi?: number }
/** A shop the map names inside a mall. */
export interface NamedShop { name: string; food?: boolean }
export interface VenueSpec {
  kind: VenueKind;
  width: number;
  depth: number;
  /** Floor to ceiling. */
  ceiling: number;
  /** The front door first; then, where there is one, the door on another side. */
  doors: VenueDoor[];
  seed: number;
  name?: string;
  /** What a shop sells, where the map says (bakery, books...). */
  trade?: string;
  /** A mall: the shops the map names inside it, which come first along its walk. */
  shops?: NamedShop[];
  /** An entrance hall: a hotel's, with a desk and luggage, and not a block of flats'. */
  hotel?: boolean;
}

export type Role = "worker" | "meeting" | "reception" | "keeper" | "barista" | "shopper" | "guest" | "caretaker" | "resident";
/**
 * Somebody inside. `fa`, `fb` is the way they face (a unit vector in the room's frame). Sitting, `seat` is
 * how high the seat is; strolling, `path` is where they walk, there and back, as a, b, a, b...
 */
export interface Person { n: number; role: Role; pose: "sit" | "stand" | "walk"; a: number; b: number; fa: number; fb: number; seat?: number; path?: number[] }
/** Lettering: its middle, the way it faces, and how wide it may be. */
export interface Lettering { text: string; a: number; b: number; z: number; fa: number; fb: number; w: number }
/** Somewhere food is sold: stand near it and the lunch box opens on what it sells. */
export interface Till { a: number; b: number; use: "shop" | "food"; text: string }

/** One piece of the inside: a box (four sides and a top; `under` gives it a bottom too), or a flat sheet. */
export interface Piece {
  form: "box" | "floor" | "ceiling" | "wallA" | "wallB";
  mat: MaterialDef;
  hex: number;
  a0: number; a1: number; b0: number; b1: number; z0: number; z1: number;
  /** A sheet on a wall: +1 or -1, the way it faces along its axis. */
  facing?: number;
  under?: boolean;
}
export interface Laid { spec: VenueSpec; doors: VenueDoor[]; pieces: Piece[]; people: Person[]; lettering: Lettering[]; tills: Till[] }

type Rect = [number, number, number, number]; // a0, a1, b0, b1
type Box = (mat: MaterialDef, hex: number, w0: number, w1: number, d0: number, d1: number, z0: number, z1: number, under?: boolean) => void;

const WOODS = [0xc9a36b, 0xb98c5a, 0xd9b98a, 0xa97c50];
const CARPETS = [0x5f7f9a, 0x6f8a6a, 0x8a7a9a, 0x9a8468, 0x56808a, 0x7d8794];
const TILES = [0xe9e4d8, 0xdfe6e8, 0xe8dcc8, 0xd9e3dc];
const PAINTS = [0xf3ead7, 0xe6efe9, 0xf6e3d5, 0xe3ecf6, 0xf5f0c8, 0xf2efe6];
const ACCENTS = [0xd9483a, 0x3f7fd0, 0x3f9a55, 0xe0a82e, 0x7a4f9a, 0x2f8f8a, 0xd87a9a, 0xe8935a];
const WHITE = 0xf7f5ef;
const STEEL = 0xb9c0c6;
const DARK = 0x3a3d44;
const LEAF = 0x3f9a45;
const POT = 0xb5653c;
const GLASS = 0xa9d4ee;
const TIMBER = 0x8a5a3a;

/** What a shop keeps on its shelves: the colours of its goods, and of its shelves. */
const TRADES: Record<string, { goods: number[]; shelf: number }> = {
  general: { goods: [0xd9483a, 0x3f7fd0, 0xe0a82e, 0x3f9a55, 0xf4f1ea, 0x7a4f9a], shelf: 0xe9e4d8 },
  bakery: { goods: [0xd9a55a, 0xc98a45, 0xe8c98a, 0xa9703a, 0xf2deb0], shelf: 0xa97c50 },
  books: { goods: [0x8a3a2e, 0x2f5a8a, 0x3f6a45, 0xc9a23a, 0x5a3a6a, 0xd9c9a8], shelf: 0x6f4a30 },
  greengrocer: { goods: [0xd9382e, 0xe8935a, 0xf2cc4a, 0x5fae4a, 0x7a3f8a, 0x9acb3c], shelf: 0xb98c5a },
  toys: { goods: [0xe8433a, 0x3f8fe0, 0xf2cc4a, 0x4fbf6a, 0xe86aa8, 0xf08a3c], shelf: 0xf4f1ea },
  clothes: { goods: [0xe8b8c8, 0xa9c8e8, 0xf2e3b0, 0xb8d8b8, 0xd8c0e8, 0x8a9ab0], shelf: 0xd9d4c8 },
  flowers: { goods: [0xe86aa8, 0xf2cc4a, 0xd9483a, 0x9a6ad8, 0xf4f1ea, 0x3f9a45], shelf: 0x7a9a6a },
  chemist: { goods: [0xf4f1ea, 0x3f9a8a, 0xa9d4ee, 0xe8f0e8, 0x5fae8a], shelf: 0xf4f1ea },
};
/** Shops of our own, for the fronts of a mall the map names no shops in: a name, what it sells, and whether that is food. */
const MADE_UP: [string, string, boolean][] = [
  ["The Button Box", "clothes", false], ["Bread & Honey", "bakery", true], ["Paper Kite Books", "books", false], ["Moss & Fern", "flowers", false],
  ["The Toy Cupboard", "toys", false], ["Kettle & Crumb", "bakery", true], ["Sunny Side Fruit", "greengrocer", true], ["Top Hat Hats", "clothes", false],
  ["Wool Gathering", "clothes", false], ["Bright Spark Lamps", "general", false], ["The Cheese Wheel", "greengrocer", true], ["Marble Run", "toys", false],
  ["Seaside Postcards", "books", false], ["Tick Tock Clocks", "general", false], ["Honeypot Sweets", "bakery", true], ["Puddle Boots", "clothes", false],
  ["The Map Room", "books", false], ["Daisy Chain", "flowers", false], ["Pots & Pans", "general", false], ["Second Breakfast", "bakery", true],
  ["Kite & Whistle", "toys", false], ["The Pear Tree", "greengrocer", true], ["Good Sport", "general", false], ["Ribbon & Thread", "clothes", false],
  ["Lantern Lane Gifts", "general", false], ["The Noodle Bowl", "bakery", true], ["Feather Pillow", "clothes", false], ["Jigsaw Corner", "toys", false],
  ["Mint Leaf Chemist", "chemist", false], ["Story Time", "books", false], ["The Soup Pot", "bakery", true], ["Brush & Easel", "general", false],
];

/** What a shop sells, from the map's word for it or from its name; by its own numbers when neither says. */
export function tradeOf(word: string | undefined, name: string | undefined, seed: number): string {
  const text = `${word ?? ""} ${name ?? ""}`.toLowerCase();
  if (/bak|bread|pastr|patisser|boulang|cake|confection|sweet|chocolat/.test(text)) return "bakery";
  if (/book|librair|news|stationer|paper/.test(text)) return "books";
  if (/green|fruit|veg|grocer|supermarket|convenience|market|deli|butcher|cheese|farm|food/.test(text)) return "greengrocer";
  if (/toy|game|hobby|kid|child/.test(text)) return "toys";
  if (/cloth|fashion|shoe|boutique|tailor|fabric|wool|hat|jewel/.test(text)) return "clothes";
  if (/flor|flower|garden|plant/.test(text)) return "flowers";
  if (/pharm|chemist|optic|health|beauty|hair|cosmetic/.test(text)) return "chemist";
  const any = ["general", "general", "books", "clothes", "toys", "flowers", "greengrocer"];
  return any[hash32(seed, 0x54524144) % any.length];
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
/** Halfway between two colours. */
const hexMix = (p: number, q: number): number => ((((p >> 16) & 255) + ((q >> 16) & 255)) >> 1 << 16) | ((((p >> 8) & 255) + ((q >> 8) & 255)) >> 1 << 8) | (((p & 255) + (q & 255)) >> 1);
/** The ways a thing can face: into the building from the front wall, towards the front, and the two sideways. */
const FACING: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];

/**
 * Lays out the inside of one building. Always something: a building too small for what it is asked to
 * be gets less of it.
 */
export function layVenue(spec: VenueSpec): Laid {
  const W = spec.width, D = spec.depth, H = spec.ceiling;
  const pieces: Piece[] = [];
  const people: Person[] = [];
  const lettering: Lettering[] = [];
  const tills: Till[] = [];
  const unit = (salt: number): number => hash32(spec.seed, salt) / 2 ** 32;
  const pick = <T>(list: T[], salt: number): T => list[hash32(spec.seed, salt) % list.length];

  // ---- the doors. The door on another side comes round to face the front door when its wall lets it.
  const front: VenueDoor = { side: 0, at: clamp(spec.doors[0]?.at ?? W / 2, 1, W - 1) };
  const doors: VenueDoor[] = [front];
  const given = spec.doors[1];
  /** How wide a mall's walk is, and where its middle is: straight back from the front door. */
  const mallWalk = W >= 26 ? 6 : W >= 16 ? 4.5 : 3.2;
  const mallMid = clamp(front.at, mallWalk / 2, W - mallWalk / 2);
  if (given) {
    const len = given.side === 1 ? W : D;
    let lo = Math.max(1.2, given.lo ?? given.at), hi = Math.min(len - 1.2, given.hi ?? given.at);
    let want = given.side === 1 ? front.at : D * (0.45 + unit(0x444f4f52) * 0.2);
    // A mall's back door is at the end of its walk, wherever the wall outside is free (the door outside is then a few steps along).
    if (spec.kind === "mall" && given.side === 1) { lo = 1.2; hi = len - 1.2; want = mallMid; }
    if (spec.kind === "mall" && given.side !== 1) { lo = Math.max(lo, 3); hi = Math.min(hi, len - 3); }
    if (hi >= lo) doors.push({ side: given.side, at: clamp(want, lo, hi) });
  }
  const second = doors[1] as VenueDoor | undefined;

  // ---- putting things down
  const put = (form: Piece["form"], mat: MaterialDef, hex: number, a0: number, a1: number, b0: number, b1: number, z0: number, z1: number, more: Partial<Piece> = {}): void => {
    if (a1 - a0 < -1e-9 || b1 - b0 < -1e-9) return;
    pieces.push({ form, mat, hex, a0, a1, b0, b1, z0, z1, ...more });
  };
  const block = (mat: MaterialDef, hex: number, a0: number, a1: number, b0: number, b1: number, z0: number, z1: number, under = false): void =>
    put("box", mat, hex, a0, a1, b0, b1, z0, z1, under ? { under } : {});
  const floor = (hex: number, r: Rect, z = 0, mat: MaterialDef = INSIDE.floor): void => put("floor", mat, hex, r[0], r[1], r[2], r[3], z, z);
  /** A sheet on a wall across the building (at depth `b`), facing +b or -b; and one on a wall running back (at `a`). */
  const sheetB = (mat: MaterialDef, hex: number, b: number, a0: number, a1: number, z0: number, z1: number, facing: number): void => put("wallB", mat, hex, a0, a1, b, b, z0, z1, { facing });
  const sheetA = (mat: MaterialDef, hex: number, a: number, b0: number, b1: number, z0: number, z1: number, facing: number): void => put("wallA", mat, hex, a, a, b0, b1, z0, z1, { facing });
  /** A way to place boxes in a thing's own frame (across it, from its back to its front, up), for a thing standing on `rect` and facing `k`. */
  const boxIn = (rect: Rect, k: number): Box => (mat, hex, w0, w1, d0, d1, z0, z1, under) => {
    if (k === 0) block(mat, hex, rect[0] + w0, rect[0] + w1, rect[2] + d0, rect[2] + d1, z0, z1, under);
    else if (k === 1) block(mat, hex, rect[0] + w0, rect[0] + w1, rect[3] - d1, rect[3] - d0, z0, z1, under);
    else if (k === 2) block(mat, hex, rect[0] + d0, rect[0] + d1, rect[2] + w0, rect[2] + w1, z0, z1, under);
    else block(mat, hex, rect[1] - d1, rect[1] - d0, rect[2] + w0, rect[2] + w1, z0, z1, under);
  };
  /** The same for a point: where (w, d) of a thing's own frame is on the floor. */
  const pointIn = (rect: Rect, k: number, w: number, d: number): [number, number] =>
    k === 0 ? [rect[0] + w, rect[2] + d] : k === 1 ? [rect[0] + w, rect[3] - d] : k === 2 ? [rect[0] + d, rect[2] + w] : [rect[1] - d, rect[2] + w];
  /** A rectangle `w` across and `d` deep whose back is `off` from a wall of `within`, starting `from` along it. `k` says which wall (and so which way the thing faces). */
  const against = (within: Rect, k: number, from: number, w: number, d: number, off = 0.06): Rect =>
    k === 0 ? [within[0] + from, within[0] + from + w, within[2] + off, within[2] + off + d]
      : k === 1 ? [within[0] + from, within[0] + from + w, within[3] - off - d, within[3] - off]
        : k === 2 ? [within[0] + off, within[0] + off + d, within[2] + from, within[2] + from + w]
          : [within[1] - off - d, within[1] - off, within[2] + from, within[2] + from + w];
  const F = INSIDE.furniture;
  let nobody = 0;
  /** No more than this many in one place: whoever is thought of first is in (the people who work there, before those passing through). */
  const MOST = { office: 20, shop: 4, cafe: 10, mall: 25, lobby: 4 }[spec.kind];
  const person = (role: Role, pose: Person["pose"], at: [number, number], k: number, more: Partial<Person> = {}): void => {
    if (people.length >= MOST) return;
    people.push({ n: nobody++, role, pose, a: Math.round(at[0] * 100) / 100, b: Math.round(at[1] * 100) / 100, fa: FACING[k][0], fb: FACING[k][1], ...more });
  };

  // ---- what must stay clear, and what is taken
  const clear: Rect[] = [];
  const taken: Rect[] = [];
  const hits = (p: Rect, q: Rect, gap: number): boolean => p[0] < q[1] + gap && p[1] > q[0] - gap && p[2] < q[3] + gap && p[3] > q[2] - gap;
  const fits = (r: Rect, within: Rect = [0, W, 0, D], gap = 0.12): boolean => {
    if (r[0] < within[0] + 0.04 || r[1] > within[1] - 0.04 || r[2] < within[2] + 0.04 || r[3] > within[3] - 0.04) return false;
    for (const c of clear) if (hits(r, c, 0)) return false;
    for (const t of taken) if (hits(r, t, gap)) return false;
    return true;
  };
  /** Takes the floor for a thing if it is free. */
  const take = (r: Rect, within?: Rect, gap?: number): boolean => {
    if (!fits(r, within, gap)) return false;
    taken.push(r);
    return true;
  };
  /** Where a door is on the floor, and the way in from it. */
  const doorAt = (d: VenueDoor): { a: number; b: number; k: number } =>
    d.side === 0 ? { a: d.at, b: 0, k: 0 } : d.side === 1 ? { a: d.at, b: D, k: 1 } : d.side === 2 ? { a: 0, b: d.at, k: 2 } : { a: W, b: d.at, k: 3 };
  /** The walk from the front door to the other one, `w` wide: the strips of floor it takes. */
  const walkOf = (w: number): Rect[] => {
    const f = front.at;
    if (!second) return [[f - w / 2, f + w / 2, 0, Math.min(D, Math.max(3, D * 0.55))]];
    if (second.side === 1) {
      if (Math.abs(second.at - f) < 0.3) return [[f - w / 2, f + w / 2, 0, D]];
      const m = D / 2;
      return [[f - w / 2, f + w / 2, 0, m + w / 2], [Math.min(f, second.at) - w / 2, Math.max(f, second.at) + w / 2, m - w / 2, m + w / 2], [second.at - w / 2, second.at + w / 2, m - w / 2, D]];
    }
    const b = second.at;
    return [[f - w / 2, f + w / 2, 0, b + w / 2], second.side === 2 ? [0, f + w / 2, b - w / 2, b + w / 2] : [f - w / 2, W, b - w / 2, b + w / 2]];
  };

  // ---- pieces of furniture that several kinds of place share
  const plant = (r: Rect, tall = 1.15): void => {
    block(F, POT, r[0] + 0.06, r[1] - 0.06, r[2] + 0.06, r[3] - 0.06, 0, 0.36);
    block(F, LEAF, r[0], r[1], r[2], r[3], 0.36, tall);
  };
  /** A plant in any corner of `within` that is free. */
  const plants = (within: Rect, most: number, salt: number): void => {
    const s = 0.44;
    const spots: Rect[] = [[within[0] + 0.1, within[0] + 0.1 + s, within[2] + 0.1, within[2] + 0.1 + s], [within[1] - 0.1 - s, within[1] - 0.1, within[2] + 0.1, within[2] + 0.1 + s],
      [within[0] + 0.1, within[0] + 0.1 + s, within[3] - 0.1 - s, within[3] - 0.1], [within[1] - 0.1 - s, within[1] - 0.1, within[3] - 0.1 - s, within[3] - 0.1]];
    let n = 0;
    for (let i = 0; i < 4 && n < most; i++) {
      const r = spots[(i + hash32(spec.seed, salt)) % 4];
      if (take(r, within, 0.05)) { plant(r); n++; }
    }
  };
  /**
   * A set of shelves with goods on it: `w` across, 0.4 deep. Each shelf's goods are a block or two (few
   * boxes: a mall has a hundred of these), in the colours of what the shop sells.
   */
  const shelves = (box: Box, w: number, trade: string, salt: number, tall = 1.8, plain = false): void => {
    const t = TRADES[trade] ?? TRADES.general;
    box(F, t.shelf, 0, w, 0, 0.12, 0, tall);
    const rows = tall > 1.5 ? 3 : 2;
    const n = plain ? 1 : w > 1.6 ? 3 : 2;
    for (let row = 0; row < rows; row++) {
      const z = 0.22 + row * 0.52;
      for (let k = 0; k < n; k++) {
        const hex = t.goods[hash32(spec.seed, salt + row * 17 + k * 5) % t.goods.length];
        const w0 = 0.04 + (k * (w - 0.08)) / n;
        box(F, hex, w0, w0 + (w - 0.08) / n - 0.05, 0.12, 0.4 - (hash32(spec.seed, salt + row * 3 + k) % 2) * 0.06, z - 0.08, z + 0.26 + (hash32(spec.seed, salt + row + k * 3) % 3) * 0.05);
      }
    }
  };
  /** A shop counter with a till on it, `w` across and 0.65 deep; whoever serves stands behind it. */
  const counter = (box: Box, w: number, hex: number): void => {
    box(F, hex, 0, w, 0, 0.65, 0, 0.9);
    box(F, 0xe9e4d8, -0.03, w + 0.03, -0.03, 0.68, 0.9, 0.94);
    box(F, DARK, w - 0.55, w - 0.2, 0.15, 0.5, 0.94, 1.14); // the till
  };
  /** A table with a chair at each of the sides that are asked for; who sits where comes back. */
  const tableAndChairs = (r: Rect, sides: number[], wood: number, cloth: number): { at: [number, number]; k: number }[] => {
    const seats: { at: [number, number]; k: number }[] = [];
    block(F, wood, r[0], r[1], r[2], r[3], 0.68, 0.74, true);
    block(F, wood, (r[0] + r[1]) / 2 - 0.07, (r[0] + r[1]) / 2 + 0.07, (r[2] + r[3]) / 2 - 0.07, (r[2] + r[3]) / 2 + 0.07, 0, 0.68);
    for (const k of sides) {
      // (k is the way the sitter faces: the chair is on the other side of the table from that.)
      const along = k < 2 ? r[1] - r[0] : r[3] - r[2];
      const n = Math.max(1, Math.floor(along / 0.8));
      for (let i = 0; i < n; i++) {
        const c = (k < 2 ? r[0] : r[2]) + (along * (i + 0.5)) / n;
        const seat: Rect = k === 0 ? [c - 0.21, c + 0.21, r[2] - 0.5, r[2] - 0.08] : k === 1 ? [c - 0.21, c + 0.21, r[3] + 0.08, r[3] + 0.5]
          : k === 2 ? [r[0] - 0.5, r[0] - 0.08, c - 0.21, c + 0.21] : [r[1] + 0.08, r[1] + 0.5, c - 0.21, c + 0.21];
        block(F, cloth, seat[0], seat[1], seat[2], seat[3], 0, 0.45);
        seats.push({ at: [(seat[0] + seat[1]) / 2, (seat[2] + seat[3]) / 2], k });
      }
    }
    return seats;
  };
  /** A bench, 1.6 across and 0.5 deep, with a back. */
  const bench = (box: Box): void => {
    box(F, TIMBER, 0, 1.6, 0.1, 0.5, 0.36, 0.45, true);
    box(F, TIMBER, 0, 1.6, 0, 0.1, 0.36, 0.9, true);
    box(F, DARK, 0.1, 0.2, 0.05, 0.45, 0, 0.36);
    box(F, DARK, 1.4, 1.5, 0.05, 0.45, 0, 0.36);
  };

  // ---- the shell: the lining of the four outside walls, with the doors seen from inside
  const paint = pick(PAINTS, 0x5041494e);
  const doorway = (d: VenueDoor): void => {
    const { a, b, k } = doorAt(d);
    const frame: Rect = k < 2 ? [a - 0.85, a + 0.85, b, b] : [a, a, b - 0.85, b + 0.85];
    const leaf: Rect = k < 2 ? [a - 0.72, a + 0.72, b, b] : [a, a, b - 0.72, b + 0.72];
    const sign = FACING[k][k < 2 ? 1 : 0];
    if (k < 2) {
      sheetB(INSIDE.glass, WHITE, b + sign * 0.01, frame[0], frame[1], 0, 2.25, sign);
      sheetB(INSIDE.glass, GLASS, b + sign * 0.02, leaf[0], leaf[1], 0.05, 2.15, sign);
      sheetB(INSIDE.glass, WHITE, b + sign * 0.03, a - 0.03, a + 0.03, 0.05, 2.15, sign);
      floor(0x6f6a62, [a - 0.7, a + 0.7, b + sign * 0.15 - (sign < 0 ? 0.7 : 0), b + sign * 0.15 + (sign > 0 ? 0.7 : 0)], 0.02, INSIDE.soft);
    } else {
      sheetA(INSIDE.glass, WHITE, a + sign * 0.01, frame[2], frame[3], 0, 2.25, sign);
      sheetA(INSIDE.glass, GLASS, a + sign * 0.02, leaf[2], leaf[3], 0.05, 2.15, sign);
      sheetA(INSIDE.glass, WHITE, a + sign * 0.03, b - 0.03, b + 0.03, 0.05, 2.15, sign);
      floor(0x6f6a62, [a + sign * 0.15 - (sign < 0 ? 0.7 : 0), a + sign * 0.15 + (sign > 0 ? 0.7 : 0), b - 0.7, b + 0.7], 0.02, INSIDE.soft);
    }
    // Nothing is stood within a stride of a door.
    clear.push(k === 0 ? [a - 0.95, a + 0.95, 0, 1.5] : k === 1 ? [a - 0.95, a + 0.95, D - 1.5, D] : k === 2 ? [0, 1.5, b - 0.95, b + 0.95] : [W - 1.5, W, b - 0.95, b + 0.95]);
  };
  /** Windows along a stretch of outside wall, a pane every 3.2 m, none where a door is. `tall` panes are a shop's. */
  const windows = (side: number, lo: number, hi: number, tall: boolean): void => {
    const z0 = tall ? 0.45 : 0.9, z1 = Math.min(H - 0.35, tall ? 2.3 : 2.15);
    const n = Math.floor((hi - lo) / 3.2);
    for (let i = 0; i < n; i++) {
      const c = lo + ((hi - lo) * (i + 0.5)) / n;
      if (doors.some((d) => d.side === side && Math.abs(d.at - c) < 2.2)) continue;
      const half = tall ? 1.1 : 0.7;
      if (side === 0 || side === 1) {
        const b = side === 0 ? 0 : D, s = side === 0 ? 1 : -1;
        sheetB(INSIDE.glass, WHITE, b + s * 0.01, c - half - 0.1, c + half + 0.1, z0 - 0.1, z1 + 0.1, s);
        sheetB(INSIDE.glass, GLASS, b + s * 0.02, c - half, c + half, z0, z1, s);
      } else {
        const a = side === 2 ? 0 : W, s = side === 2 ? 1 : -1;
        sheetA(INSIDE.glass, WHITE, a + s * 0.01, c - half - 0.1, c + half + 0.1, z0 - 0.1, z1 + 0.1, s);
        sheetA(INSIDE.glass, GLASS, a + s * 0.02, c - half, c + half, z0, z1, s);
      }
    }
  };
  const lining = (hex: number): void => {
    sheetB(INSIDE.wall, hex, 0, 0, W, 0, H, 1);
    sheetB(INSIDE.wall, hex, D, 0, W, 0, H, -1);
    sheetA(INSIDE.wall, hex, 0, 0, D, 0, H, 1);
    sheetA(INSIDE.wall, hex, W, 0, D, 0, H, -1);
  };
  /** Flat lights under the ceiling, one to every 20 m2 or so of a stretch of floor. */
  const lights = (r: Rect): void => {
    const na = Math.max(1, Math.round((r[1] - r[0]) / 4.5)), nb = Math.max(1, Math.round((r[3] - r[2]) / 4.5));
    for (let i = 0; i < na; i++) for (let j = 0; j < nb; j++) {
      const ca = r[0] + ((r[1] - r[0]) * (i + 0.5)) / na, cb = r[2] + ((r[3] - r[2]) * (j + 0.5)) / nb;
      put("ceiling", INSIDE.ceiling, 0xfffbe6, ca - 0.6, ca + 0.6, cb - 0.3, cb + 0.3, H - 0.03, H - 0.03);
    }
  };
  put("ceiling", INSIDE.ceiling, 0xfbf9f3, 0, W, 0, D, H, H);

  const accent = pick(ACCENTS, 0x41434345);
  const wood = pick(WOODS, 0x574f4f44);

  // =============================================================== an office
  const office = (): void => {
    lining(paint);
    floor(pick(CARPETS, 0x464c4f52), [0, W, 0, D]);
    doors.forEach(doorway);
    for (const side of [0, 1, 2, 3]) windows(side, 0.6, (side < 2 ? W : D) - 0.6, false);
    lights([0, W, 0, D]);
    const walk = walkOf(Math.min(2, Math.max(1.4, W / 5)));
    clear.push(...walk);
    for (const r of walk) floor(0xd9d2c4, r, 0.006);

    // Reception: a desk beside the walk, a few steps in from the front door, facing it.
    const right = front.at < W / 2; // on the side with more room
    const desk: Rect = right ? [front.at + 1.3, front.at + 3.1, 2.0, 2.7] : [front.at - 3.1, front.at - 1.3, 2.0, 2.7];
    if (D >= 6 && take(desk, undefined, 0.3)) {
      const box = boxIn(desk, 1);
      box(F, wood, 0, 1.8, 0, 0.7, 0, 1.05);
      box(F, accent, 0, 1.8, 0.7, 0.74, 0.2, 1.05);
      box(F, DARK, 0.2, 0.7, 0.1, 0.16, 1.05, 1.4);
      const seat: Rect = [desk[0] + 0.69, desk[0] + 1.11, desk[3] + 0.12, desk[3] + 0.54];
      if (take(seat, undefined, 0)) { block(F, accent, seat[0], seat[1], seat[2], seat[3], 0, 0.45); person("reception", "sit", [(seat[0] + seat[1]) / 2, (seat[2] + seat[3]) / 2], 1, { seat: 0.45 }); }
      if (spec.name) lettering.push({ text: spec.name, a: (desk[0] + desk[1]) / 2, b: desk[2] - 0.05, z: 0.62, fa: 0, fb: -1, w: 1.6 });
    }

    // Rooms in the corners: meeting rooms, each with a table and a window on to the floor, and a kitchen.
    const area = W * D;
    const rooms: ("meet" | "kitchen")[] = area < 55 ? [] : area < 110 ? ["kitchen"] : area < 220 ? ["meet", "kitchen"] : area < 420 ? ["meet", "kitchen", "meet"] : ["meet", "kitchen", "meet", "meet"];
    const corners = [[1, 1], [0, 1], [1, 0], [0, 0]].map((c, i, all) => all[(i + (hash32(spec.seed, 0x434f524e) % 2) * 1) % 4]); // back corners first
    let corner = 0;
    let met = 0;
    for (const what of rooms) {
      for (; corner < 4; corner++) {
        const [ca, cb] = corners[corner];
        const long = what === "meet" ? 4.4 : 3.6, short = what === "meet" ? 3.4 : 2.8;
        const turned = (hash32(spec.seed, 0x5455524e + corner) & 1) === 1;
        let done = false;
        for (const [w, d] of turned ? [[short, long], [long, short]] : [[long, short], [short, long]]) {
          if (w > W * 0.45 || d > D * 0.5) continue;
          const r: Rect = [ca ? W - w : 0, ca ? W : w, cb ? D - d : 0, cb ? D : d];
          // (Kept clear of the walk and the doors, but hard against its two walls.)
          if (clear.some((c) => hits(r, c, 0.2)) || taken.some((t) => hits(r, t, 0.4))) continue;
          taken.push(r);
          const inA = ca ? r[0] : r[1], inB = cb ? r[2] : r[3]; // its two walls that are inside the office
          if (what === "kitchen") {
            floor(pick(TILES, 0x4b495443), r, 0.008);
            // A run of cupboards along the back of it, with a sink and a fridge, and a high table to stand at.
            const run = boxIn(against(r, cb ? 1 : 0, 0.1, r[1] - r[0] - 0.2, 0.62), cb ? 1 : 0);
            const len = r[1] - r[0] - 0.2;
            run(F, wood, 0, len - 0.75, 0, 0.62, 0, 0.88);
            run(F, 0xe9e4d8, 0, len - 0.75, 0, 0.64, 0.88, 0.92);
            run(F, STEEL, 0.3, 0.9, 0.1, 0.54, 0.92, 0.95);
            run(F, DARK, 1.2, 1.55, 0.12, 0.45, 0.92, 1.22); // the coffee machine
            run(F, WHITE, len - 0.7, len, 0, 0.66, 0, 1.8);
            const tb = cb ? r[2] + 0.7 : r[3] - 1.3;
            const table: Rect = [(r[0] + r[1]) / 2 - 0.5, (r[0] + r[1]) / 2 + 0.5, tb, tb + 0.6];
            block(F, wood, table[0], table[1], table[2], table[3], 1.0, 1.05, true);
            block(F, DARK, table[0] + 0.44, table[0] + 0.56, table[2] + 0.24, table[2] + 0.36, 0, 1.0);
            block(F, accent, table[0] + 0.2, table[0] + 0.3, table[2] + 0.2, table[2] + 0.3, 1.05, 1.16); // a mug
            person("worker", "stand", [table[0] - 0.35, (table[2] + table[3]) / 2], 2);
            if (unit(0x4b324e44) < 0.6) person("worker", "stand", [table[1] + 0.35, (table[2] + table[3]) / 2], 3);
            lettering.push({ text: "KITCHEN", a: (r[0] + r[1]) / 2, b: cb ? D - 0.04 : 0.04, z: Math.min(H - 0.3, 2.3), fa: 0, fb: cb ? -1 : 1, w: 1.4 });
          } else {
            // Two walls with a doorway in the longer one and a window in the other.
            const T = 0.1;
            const doorOnA = d >= w; // the wall running back is the longer
            const mid = doorOnA ? (r[2] + r[3]) / 2 : (r[0] + r[1]) / 2;
            const wallHex = WHITE;
            if (doorOnA) {
              block(INSIDE.wall, wallHex, inA - T / 2, inA + T / 2, r[2], mid - 0.5, 0, H);
              block(INSIDE.wall, wallHex, inA - T / 2, inA + T / 2, mid + 0.5, r[3], 0, H);
              block(INSIDE.wall, wallHex, inA - T / 2, inA + T / 2, mid - 0.5, mid + 0.5, 2.05, H, true);
              block(INSIDE.wall, wallHex, r[0], r[1], inB - T / 2, inB + T / 2, 0, H);
              for (const s of [-1, 1]) sheetB(INSIDE.glass, GLASS, inB + s * (T / 2 + 0.01), r[0] + 0.5, r[1] - 0.5, 0.9, 2.1, s);
              clear.push(ca ? [inA - 1.2, inA, mid - 0.6, mid + 0.6] : [inA, inA + 1.2, mid - 0.6, mid + 0.6]);
            } else {
              block(INSIDE.wall, wallHex, r[0], mid - 0.5, inB - T / 2, inB + T / 2, 0, H);
              block(INSIDE.wall, wallHex, mid + 0.5, r[1], inB - T / 2, inB + T / 2, 0, H);
              block(INSIDE.wall, wallHex, mid - 0.5, mid + 0.5, inB - T / 2, inB + T / 2, 2.05, H, true);
              block(INSIDE.wall, wallHex, inA - T / 2, inA + T / 2, r[2], r[3], 0, H);
              for (const s of [-1, 1]) sheetA(INSIDE.glass, GLASS, inA + s * (T / 2 + 0.01), r[2] + 0.5, r[3] - 0.5, 0.9, 2.1, s);
              clear.push(cb ? [mid - 0.6, mid + 0.6, inB - 1.2, inB] : [mid - 0.6, mid + 0.6, inB, inB + 1.2]);
            }
            floor(pick(CARPETS, 0x4d454554 + corner), r, 0.008);
            const alongA = w >= d;
            const table: Rect = alongA ? [r[0] + 1.0, r[1] - 1.0, (r[2] + r[3]) / 2 - 0.5, (r[2] + r[3]) / 2 + 0.5] : [(r[0] + r[1]) / 2 - 0.5, (r[0] + r[1]) / 2 + 0.5, r[2] + 1.0, r[3] - 1.0];
            const seats = tableAndChairs(table, alongA ? [0, 1] : [2, 3], wood, accent);
            seats.forEach((s, i) => { if (hash32(spec.seed, 0x53454154 + corner * 31 + i) % 10 < 5) person("meeting", "sit", s.at, s.k, { seat: 0.45 }); });
            // A whiteboard on the outside wall at the end of the table.
            const wb = Math.min(1.6, (alongA ? d : w) - 1);
            if (alongA) sheetA(INSIDE.glass, WHITE, ca ? W - 0.03 : 0.03, (r[2] + r[3]) / 2 - wb / 2, (r[2] + r[3]) / 2 + wb / 2, 1.0, 2.0, ca ? -1 : 1);
            else sheetB(INSIDE.glass, WHITE, cb ? D - 0.03 : 0.03, (r[0] + r[1]) / 2 - wb / 2, (r[0] + r[1]) / 2 + wb / 2, 1.0, 2.0, cb ? -1 : 1);
            lettering.push({ text: `ROOM ${++met}`, a: doorOnA ? inA + (ca ? -1 : 1) * (T / 2 + 0.02) : mid + 1.1, b: doorOnA ? mid + 1.1 : inB + (cb ? -1 : 1) * (T / 2 + 0.02), z: 1.6, fa: doorOnA ? (ca ? -1 : 1) : 0, fb: doorOnA ? 0 : cb ? -1 : 1, w: 0.9 });
          }
          done = true;
          break;
        }
        if (done) { corner++; break; }
      }
    }

    // Desks, in pairs face to face with a screen between them, in rows across the rest of the floor.
    const alongB = (hash32(spec.seed, 0x524f5753) & 1) === 1 && D > 8;
    const cw = 1.5, cd = 2.9; // a pair of desks with their chairs: across, and from chair to chair
    const GAP = 1.5; // between one row's chairs and the next's
    const [stepU, stepV] = [cw + 0.1, cd + GAP];
    let desks = 0, working = 0, pairs = 0;
    const most = Math.min(9, Math.round(area / 22));
    const lenU = alongB ? D : W, lenV = alongB ? W : D;
    const nu = Math.floor((lenU - 2.0) / stepU), nv = Math.floor((lenV - 1.6 + GAP) / stepV);
    const offU = (lenU - nu * stepU + 0.1) / 2, offV = (lenV - (nv * stepV - GAP)) / 2;
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
      const u = offU + i * stepU, v = offV + j * stepV;
      const r: Rect = alongB ? [v, v + cd, u, u + cw] : [u, u + cw, v, v + cd];
      if (pairs >= 14 || !take(r, undefined, 0.02)) continue;
      pairs++;
      const k = alongB ? 2 : 0;
      const box = boxIn(r, k);
      for (const side of [0, 1]) {
        const d0 = side === 0 ? 0.75 : 1.45; // the desk's own strip, back to front
        box(F, wood, 0, cw, d0, d0 + 0.7, 0.7, 0.74, true);
        const sd = side === 0 ? 1.22 : 1.62; // the screen, near the middle
        box(F, DARK, 0.45, 1.05, sd, sd + 0.05, 0.8, 1.22);
        const c0 = side === 0 ? 0.2 : 2.28;
        box(F, accent, 0.54, 0.96, c0, c0 + 0.42, 0, 0.45);
        box(F, accent, 0.54, 0.96, side === 0 ? c0 - 0.06 : c0 + 0.42, side === 0 ? c0 : c0 + 0.48, 0.45, 0.9);
        desks++;
        if (working < most && hash32(spec.seed, 0x574f524b + desks * 7) % 10 < 6) {
          working++;
          person("worker", "sit", pointIn(r, k, 0.75, c0 + 0.21), alongB ? (side === 0 ? 2 : 3) : side === 0 ? 0 : 1, { seat: 0.45 });
        }
      }
      box(F, STEEL, 0, cw, 1.42, 1.48, 0, 1.2); // the screen between the two, which they both stand on
    }

    // Along the walls where there is room: cupboards, a printer, plants.
    const bits: [number, number, (box: Box) => void][] = [
      [1.2, 0.45, (box) => { box(F, 0xd9d4c8, 0, 1.2, 0, 0.45, 0, 1.3); box(F, accent, 0.1, 0.5, 0.45, 0.46, 0.5, 0.9); box(F, accent, 0.7, 1.1, 0.45, 0.46, 0.5, 0.9); }],
      [0.7, 0.6, (box) => { box(F, 0xe9e4d8, 0, 0.7, 0, 0.6, 0, 0.95); box(F, DARK, 0.05, 0.65, 0.05, 0.55, 0.95, 1.1); }],
      [0.4, 0.4, (box) => { box(F, 0xa9d4ee, 0.05, 0.35, 0.05, 0.35, 0.9, 1.35); box(F, WHITE, 0, 0.4, 0, 0.4, 0, 0.9); }],
    ];
    bits.forEach(([w, d, make], n) => {
      for (let tries = 0; tries < 8; tries++) {
        const k = (hash32(spec.seed, 0x42495453 + n * 11 + tries) % 4);
        const run = k < 2 ? W : D;
        const from = 0.3 + (hash32(spec.seed, 0x46524f4d + n * 13 + tries * 7) / 2 ** 32) * Math.max(0, run - w - 0.6);
        const r = against([0, W, 0, D], k, from, w, d);
        if (take(r)) { make(boxIn(r, k)); break; }
      }
    });
    plants([0, W, 0, D], 3, 0x504c4e54);
    // And somebody on their way across the floor with papers.
    if (second && area >= 80) stroller("worker", walk, 0.5);
  };

  /** Somebody who strolls the walk from one end to the other and back, `off` of the way across it. */
  const stroller = (role: Role, walk: Rect[], off: number): void => {
    const path: number[] = [];
    const mid = (r: Rect, across: number): [number, number] => {
      const lengthways = r[3] - r[2] >= r[1] - r[0];
      return lengthways ? [r[0] + (r[1] - r[0]) * across, 0] : [0, r[2] + (r[3] - r[2]) * across];
    };
    const f = doorAt(front);
    const a0 = mid(walk[0], off)[0] || f.a;
    path.push(a0, 1.2);
    if (walk.length === 1) path.push(a0, walk[0][3] - 1.2);
    else if (walk.length === 2) {
      const b1 = mid(walk[1], off)[1];
      path.push(a0, b1, second!.side === 2 ? 1.2 : W - 1.2, b1);
    } else {
      const b1 = mid(walk[1], off)[1], a2 = mid(walk[2], off)[0];
      path.push(a0, b1, a2, b1, a2, D - 1.2);
    }
    const r = (v: number): number => Math.round(v * 100) / 100;
    if (people.length < MOST) people.push({ n: nobody++, role, pose: "walk", a: r(path[0]), b: r(path[1]), fa: 0, fb: 1, path: path.map(r) });
  };

  // =============================================================== a shop
  const shop = (): void => {
    const trade = spec.trade ?? tradeOf(undefined, spec.name, spec.seed);
    lining(paint);
    floor(pick(WOODS, 0x464c4f52), [0, W, 0, D]);
    doors.forEach(doorway);
    windows(0, 0.4, W - 0.4, true);
    lights([0, W, 0, D]);
    const walk = walkOf(1.5);
    clear.push(...walk);
    // The counter, along a side wall a little way in, with the shopkeeper behind it.
    const side = front.at < W / 2 ? 3 : 2; // on the side with more room
    const cw = Math.min(2.4, D - 3);
    if (cw >= 1.4) {
      const r = against([0, W, 0, D], side, 1.3, cw, 0.65, 0.95);
      const behind: Rect = side === 2 ? [0.1, 0.9, r[2], r[3]] : [W - 0.9, W - 0.1, r[2], r[3]];
      if (take(r, undefined, 0.05) && take(behind, undefined, 0)) {
        counter(boxIn(r, side), cw, accent);
        person("keeper", "stand", [(behind[0] + behind[1]) / 2, (r[2] + r[3]) / 2], side);
        tills.push({ a: (r[0] + r[1]) / 2, b: (r[2] + r[3]) / 2, use: "shop", text: spec.name ?? "the shop" });
      }
    }
    // Shelves round the walls, and in rows down the middle where the shop is wide enough.
    // (A big shop has longer shelves with wider aisles between them, like a supermarket's: fewer pieces to send.)
    let n = 0;
    const large = W * D > 110;
    const sw = large ? 2.4 : 1.2;
    for (const k of [2, 3, 1]) {
      const run = k < 2 ? W : D;
      for (let from = 0.3; from + sw <= run - 0.3; from += sw + 0.1) {
        const r = against([0, W, 0, D], k, from, sw, 0.4);
        if (take(r, undefined, 0.02)) shelves(boxIn(r, k), sw, trade, 0x5348454c + n++ * 29);
      }
    }
    for (let a = 1.7; a + 0.9 <= W - 1.7; a += large ? 3.3 : 2.5) {
      for (let b = 2.4; b + sw <= D - 1.9; b += sw + (large ? 1.4 : 0.1)) {
        const r: Rect = [a, a + 0.9, b, b + sw];
        if (!take(r, undefined, 0.02)) continue;
        shelves(boxIn([a, a + 0.45, b, b + sw], 3), sw, trade, 0x474f4e44 + n++ * 29, 1.4, large);
        shelves(boxIn([a + 0.45, a + 0.9, b, b + sw], 2), sw, trade, 0x474f4e44 + n++ * 29, 1.4, large);
      }
    }
    plants([0, W, 0, D], 1, 0x504c4e54);
    if (spec.name) lettering.push({ text: spec.name, a: side === 2 ? 0.04 : W - 0.04, b: 1.3 + cw / 2, z: Math.min(H - 0.35, 2.3), fa: side === 2 ? 1 : -1, fb: 0, w: Math.min(3, cw + 0.6) });
    // Somebody looking along the shelves.
    if (W * D >= 40) stroller("shopper", walk, 0.5);
    const by: [number, number] = [front.at + (side === 2 ? 1.2 : -1.2), Math.min(D - 1.6, 3.2)];
    if (W * D >= 90 && by[0] > 0.6 && by[0] < W - 0.6 && !taken.some((t) => hits([by[0] - 0.3, by[0] + 0.3, by[1] - 0.3, by[1] + 0.3], t, 0.05))) person("shopper", "stand", by, side === 2 ? 3 : 2);
  };

  // =============================================================== a café
  const cafe = (): void => {
    lining(paint);
    floor(pick(WOODS, 0x464c4f52), [0, W, 0, D]);
    doors.forEach(doorway);
    windows(0, 0.4, W - 0.4, true);
    lights([0, W, 0, D]);
    const walk = walkOf(1.5);
    clear.push(...walk);
    // The counter, along a side wall, with the coffee machine and the cakes; the menu on the wall behind.
    const side = front.at < W / 2 ? 3 : 2;
    const cw = Math.min(3.4, D - 2.6);
    if (cw >= 1.6) {
      const from = Math.max(1.0, D - cw - 1.6);
      const r = against([0, W, 0, D], side, from, cw, 0.65, 0.95);
      const behind: Rect = side === 2 ? [0.1, 0.9, r[2], r[3]] : [W - 0.9, W - 0.1, r[2], r[3]];
      if (take(r, undefined, 0.05) && take(behind, undefined, 0)) {
        const box = boxIn(r, side);
        counter(box, cw, wood);
        box(F, DARK, 0.15, 0.75, 0.1, 0.5, 0.94, 1.34); // the coffee machine
        box(F, GLASS, 0.95, cw - 0.7, 0.08, 0.57, 0.94, 1.3); // the cakes, under glass
        box(F, 0xe8b8c8, 1.05, 1.35, 0.15, 0.5, 0.94, 1.06);
        box(F, 0xd9a55a, 1.45, Math.min(1.8, cw - 0.75), 0.15, 0.5, 0.94, 1.1);
        person("barista", "stand", [(behind[0] + behind[1]) / 2, (r[2] + r[3]) / 2], side);
        tills.push({ a: (r[0] + r[1]) / 2, b: (r[2] + r[3]) / 2, use: "food", text: spec.name ?? "the café" });
        lettering.push({ text: "MENU", a: side === 2 ? 0.04 : W - 0.04, b: (r[2] + r[3]) / 2, z: Math.min(H - 0.35, 2.2), fa: side === 2 ? 1 : -1, fb: 0, w: 1.6 });
      }
    }
    // Tables for two and for four across the floor, and people at some of them.
    let sat = 0, tables = 0;
    for (let b = 1.3; b + 0.8 <= D - 1.2 && tables < 14; b += 0.5) {
      for (let a = 0.7; a + 0.8 <= W - 0.7 && tables < 14; a += 0.35) {
        const four = hash32(spec.seed, 0x464f5552 + tables) % 3 === 0;
        const t: Rect = [a, a + (four ? 1.3 : 0.8), b, b + 0.8];
        const all: Rect = [t[0], t[1], t[2] - 0.55, t[3] + 0.55];
        if (!take(all, undefined, 0.55)) continue;
        tables++;
        const seats = tableAndChairs(t, [0, 1], wood, accent);
        block(F, WHITE, (t[0] + t[1]) / 2 - 0.06, (t[0] + t[1]) / 2 + 0.06, (t[2] + t[3]) / 2 - 0.06, (t[2] + t[3]) / 2 + 0.06, 0.74, 0.84); // a cup
        const busy = hash32(spec.seed, 0x42555359 + tables * 13) % 10 < 6;
        if (busy) seats.forEach((s, i) => { if (sat < 8 && (i === 0 || hash32(spec.seed, 0x47554553 + tables * 7 + i) % 10 < 6)) { sat++; person("guest", "sit", s.at, s.k, { seat: 0.45 }); } });
      }
    }
    plants([0, W, 0, D], 3, 0x504c4e54);
  };

  // =============================================================== the entrance hall of flats or a hotel
  const lobby = (): void => {
    lining(paint);
    floor(pick(TILES, 0x464c4f52), [0, W, 0, D]);
    doors.forEach(doorway);
    windows(0, 0.4, W - 0.4, false);
    lights([0, W, 0, D]);
    const walk = walkOf(1.6);
    clear.push(...walk);
    for (const r of walk) floor(hexMix(accent, 0x8a8478), r, 0.006, INSIDE.soft); // a runner from door to door
    /** Stands a thing `w` across and `d` deep against a wall, wherever along the walls (in the order given) there is room; says where. */
    const stand = (w: number, d: number, salt: number, walls: number[], make: (box: Box, rect: Rect, k: number) => void): { rect: Rect; k: number } | null => {
      for (const k of walls) {
        const run = k < 2 ? W : D;
        if (w > run - 0.6) continue;
        const first = hash32(spec.seed, salt + k) % 3;
        for (let n = 0; n < 3; n++) {
          const where = (first + n) % 3;
          const from = where === 0 ? (run - w) / 2 : where === 1 ? 0.3 : run - w - 0.3;
          const rect = against([0, W, 0, D], k, from, w, d);
          if (!take(rect)) continue;
          make(boxIn(rect, k), rect, k);
          return { rect, k };
        }
      }
      return null;
    };
    const letter = (text: string, at: { rect: Rect; k: number }, w: number, z: number): void => {
      const p = pointIn(at.rect, at.k, (at.k < 2 ? at.rect[1] - at.rect[0] : at.rect[3] - at.rect[2]) / 2, 0.02);
      lettering.push({ text, a: p[0], b: p[1], z: Math.min(H - 0.2, z), fa: FACING[at.k][0], fb: FACING[at.k][1], w });
    };
    const backFirst = [1, 2, 3, 0], sidesFirst = front.at < W / 2 ? [3, 2, 1, 0] : [2, 3, 1, 0];
    // The lift: two steel doors in a frame, with a button beside them.
    const lift = stand(2.3, 0.12, 0x4c494654, backFirst, (box) => {
      box(F, 0x8d949a, 0, 2.3, 0, 0.08, 0, 2.3);
      box(F, STEEL, 0.18, 1.13, 0.08, 0.11, 0, 2.12);
      box(F, STEEL, 1.17, 2.12, 0.08, 0.11, 0, 2.12);
      box(F, accent, 2.16, 2.24, 0.08, 0.12, 1.0, 1.14);
    });
    if (lift) letter("LIFT", lift, 1.0, 2.5);
    if (spec.hotel) {
      // The desk, with whoever is on duty behind it and the keys on the wall; luggage on a trolley; somewhere to wait.
      const side = sidesFirst[0];
      const cw = Math.min(2.6, D - 3.2);
      if (cw >= 1.6) {
        const r = against([0, W, 0, D], side, Math.max(1.4, (D - cw) / 2), cw, 0.65, 0.95);
        const behind: Rect = side === 2 ? [0.1, 0.9, r[2], r[3]] : [W - 0.9, W - 0.1, r[2], r[3]];
        if (take(r, undefined, 0.05) && take(behind, undefined, 0)) {
          const box = boxIn(r, side);
          box(F, wood, 0, cw, 0, 0.65, 0, 1.05);
          box(F, 0xe9e4d8, -0.03, cw + 0.03, -0.03, 0.68, 1.05, 1.09);
          box(F, 0xe0b23c, 0.3, 0.42, 0.25, 0.37, 1.09, 1.17); // the bell
          person("reception", "stand", [(behind[0] + behind[1]) / 2, (r[2] + r[3]) / 2], side);
          const wall = side === 2 ? 0.03 : W - 0.03, s = side === 2 ? 1 : -1;
          sheetA(INSIDE.glass, TIMBER, wall, r[2] + 0.3, r[3] - 0.3, 1.3, 2.0, s);
          for (let k = 0; k < 5; k++) sheetA(INSIDE.glass, 0xe0b23c, wall + s * 0.01, r[2] + 0.45 + k * ((cw - 1.0) / 4), r[2] + 0.55 + k * ((cw - 1.0) / 4), 1.45 + (k % 2) * 0.25, 1.6 + (k % 2) * 0.25, s);
          lettering.push({ text: spec.name ?? "HOTEL", a: side === 2 ? r[1] + 0.02 : r[0] - 0.02, b: (r[2] + r[3]) / 2, z: 0.6, fa: side === 2 ? 1 : -1, fb: 0, w: Math.min(2.2, cw - 0.3) });
        }
      }
      stand(1.0, 0.6, 0x4c554747, sidesFirst.slice(1), (box) => {
        box(F, 0xe0b23c, 0, 1.0, 0, 0.6, 0.12, 0.2, true);
        box(F, 0xe0b23c, 0, 0.06, 0, 0.06, 0.2, 1.5);
        box(F, 0xe0b23c, 0.94, 1.0, 0, 0.06, 0.2, 1.5);
        box(F, 0x8a3a2e, 0.1, 0.55, 0.1, 0.5, 0.2, 0.75);
        box(F, 0x2f5a8a, 0.6, 0.92, 0.12, 0.45, 0.2, 0.6);
      });
    } else {
      // Letterboxes in rows, a noticeboard, and the caretaker.
      const post = stand(2.0, 0.25, 0x504f5354, sidesFirst, (box) => {
        box(F, wood, 0, 2.0, 0, 0.22, 0.75, 1.75, true);
        for (let row = 0; row < 3; row++) for (let k = 0; k < 4; k++) box(F, hash32(spec.seed, 0x424f58 + row * 5 + k) % 4 === 0 ? accent : STEEL, 0.06 + k * 0.485, 0.5 + k * 0.485, 0.22, 0.25, 0.8 + row * 0.32, 1.07 + row * 0.32, true);
      });
      if (post) {
        letter("LETTERS", post, 1.2, 2.0);
        const p = pointIn(post.rect, post.k, 1.0, 1.0);
        if (fits([p[0] - 0.3, p[0] + 0.3, p[1] - 0.3, p[1] + 0.3])) person("caretaker", "stand", p, post.k < 2 ? 1 - post.k : 5 - post.k);
      }
      const board = stand(1.4, 0.05, 0x4e4f5445, backFirst, (box) => {
        box(F, TIMBER, 0, 1.4, 0, 0.03, 1.1, 2.0, true);
        box(F, 0xc9a36b, 0.06, 1.34, 0.03, 0.04, 1.16, 1.94, true);
        for (let k = 0; k < 5; k++) box(F, [WHITE, 0xf2cc74, 0xa9d4ee, 0xf2b8c6, WHITE][k], 0.14 + (k % 3) * 0.4, 0.42 + (k % 3) * 0.4, 0.04, 0.045, 1.25 + Math.floor(k / 3) * 0.36, 1.53 + Math.floor(k / 3) * 0.36, true);
      });
      if (board && spec.name) letter(spec.name, board, 1.4, 2.25);
    }
    // Somewhere to sit and wait, with a low table, and plants.
    const sofa = stand(2.0, 0.9, 0x534f4641, [...sidesFirst.slice(1), sidesFirst[0]], (box) => {
      box(F, accent, 0, 2.0, 0.18, 0.9, 0, 0.45);
      box(F, accent, 0, 2.0, 0, 0.2, 0, 0.92);
      box(F, accent, 0, 0.18, 0.18, 0.9, 0.45, 0.66);
      box(F, accent, 1.82, 2.0, 0.18, 0.9, 0.45, 0.66);
    });
    if (sofa) {
      const facing = sofa.k;
      if (unit(0x53495431) < 0.75) person(spec.hotel ? "guest" : "resident", "sit", pointIn(sofa.rect, sofa.k, 0.6, 0.55), facing, { seat: 0.45 });
      if (spec.hotel && unit(0x53495432) < 0.5) person("guest", "sit", pointIn(sofa.rect, sofa.k, 1.4, 0.55), facing, { seat: 0.45 });
      const t = pointIn(sofa.rect, sofa.k, 1.0, 1.6);
      const table: Rect = [t[0] - 0.45, t[0] + 0.45, t[1] - 0.3, t[1] + 0.3];
      if (take(table)) block(F, wood, table[0], table[1], table[2], table[3], 0, 0.4);
    }
    plants([0, W, 0, D], 3, 0x504c4e54);
    if (second) stroller(spec.hotel ? "guest" : "resident", walk, 0.5);
  };

  // =============================================================== a mall, an arcade, a row of shops
  const mall = (): void => {
    // The walk runs straight back from the front door; shops line it where there is room for them.
    const cw = mallWalk, ca = mallMid;
    let c0 = ca - cw / 2, c1 = ca + cw / 2;
    if (c0 < 3.4) c0 = 0; // too little room for shops on that side: the walk takes it
    if (W - c1 < 3.4) c1 = W;
    // A door on a side wall has a walk of its own across to the main one.
    const cross: Rect | null = second && second.side >= 2 ? (second.side === 2 ? [0, c0, second.at - 1.8, second.at + 1.8] : [c1, W, second.at - 1.8, second.at + 1.8]) : null;
    const concourse: Rect = [c0, c1, 0, D];
    const tile = pick(TILES, 0x464c4f52);
    floor(tile, concourse);
    floor(0xcfc6b4, [ca - cw / 2 + 0.5, ca - cw / 2 + 0.8, 0, D], 0.006);
    floor(0xcfc6b4, [ca + cw / 2 - 0.8, ca + cw / 2 - 0.5, 0, D], 0.006);
    if (cross && cross[1] - cross[0] > 0.1) floor(tile, cross);
    sheetB(INSIDE.wall, paint, 0, c0, c1, 0, H, 1);
    sheetB(INSIDE.wall, paint, D, c0, c1, 0, H, -1);
    if (c0 === 0) sheetA(INSIDE.wall, paint, 0, 0, D, 0, H, 1);
    if (c1 === W) sheetA(INSIDE.wall, paint, W, 0, D, 0, H, -1);
    doors.forEach(doorway);
    lights(concourse);
    clear.push([ca - cw / 2, ca - cw / 2 + 1.5, 0, D], [ca + cw / 2 - 1.5, ca + cw / 2, 0, D]); // a lane along each row of fronts

    // The shops: the ones the map names first, then ours.
    const names: { name: string; trade: string; food: boolean }[] = (spec.shops ?? []).map((s, i) => ({ name: s.name, trade: s.food ? "bakery" : tradeOf(undefined, s.name, spec.seed + i), food: !!s.food }));
    const first = hash32(spec.seed, 0x4e414d45) % MADE_UP.length;
    for (let i = 0; i < MADE_UP.length; i++) {
      const [name, trade, food] = MADE_UP[(first + i * 7) % MADE_UP.length];
      names.push({ name, trade, food });
    }
    let shopNo = 0;
    let keepers = 0;
    const big = W * D > 500; // a big mall's shops have plainer shelves, or it would be a megabyte

    for (const left of [true, false]) {
      const strip = left ? c0 : W - c1;
      if (strip < 3.4) continue;
      const deep = Math.min(strip, 9);
      const k = left ? 3 : 2; // the way out of a shop on this side, towards the walk
      // (Its back wall, where the building goes on behind it.)
      const spans: [number, number][] = cross && (left ? second!.side === 2 : second!.side === 3) ? [[0, cross[2]], [cross[3], D]] : [[0, D]];
      for (const [p, q] of spans) {
        if (q - p < 3.5) {
          if (q - p > 0.05) sheetA(INSIDE.wall, paint, left ? c0 : c1, p, q, 0, H, left ? 1 : -1);
          continue;
        }
        const count = Math.max(1, Math.round((q - p) / 6.5));
        for (let i = 0; i < count; i++) {
          const b0 = p + ((q - p) * i) / count, b1 = p + ((q - p) * (i + 1)) / count;
          const r: Rect = left ? [c0 - deep, c0, b0, b1] : [c1, c1 + deep, b0, b1];
          const shopNow = names[shopNo++ % names.length];
          const colour = ACCENTS[(hash32(spec.seed, 0x53484f50 + shopNo * 3)) % ACCENTS.length];
          const fw = b1 - b0;
          const edge = left ? c0 : c1, back = left ? c0 - deep : c1 + deep, s = left ? 1 : -1; // `s`: from the shop out to the walk
          floor(pick(WOODS, 0x53464c52 + shopNo), r, 0.004);
          // Its back and side walls, from inside.
          sheetA(INSIDE.wall, WHITE, back, b0, b1, 0, H, s);
          block(INSIDE.wall, WHITE, Math.min(edge, back), Math.max(edge, back), Math.max(0, b0 - 0.05), b0 + 0.05, 0, H);
          if (i === count - 1) block(INSIDE.wall, WHITE, Math.min(edge, back), Math.max(edge, back), b1 - 0.05, Math.min(D, b1 + 0.05), 0, H);
          // Its front: an opening in the middle, windows either side, and its name over the opening.
          const open = Math.min(2.6, fw - 1.4), m = (b0 + b1) / 2;
          const T = 0.12;
          block(INSIDE.wall, WHITE, edge - T / 2, edge + T / 2, b0, m - open / 2, 0, H);
          block(INSIDE.wall, WHITE, edge - T / 2, edge + T / 2, m + open / 2, b1, 0, H);
          const head = Math.min(2.3, H - 0.6);
          block(INSIDE.wall, WHITE, edge - T / 2, edge + T / 2, m - open / 2, m + open / 2, head, H, true);
          for (const [w0, w1] of [[b0 + 0.25, m - open / 2 - 0.2], [m + open / 2 + 0.2, b1 - 0.25]]) {
            if (w1 - w0 < 0.6) continue;
            for (const f of [-1, 1]) sheetA(INSIDE.glass, GLASS, edge + f * (T / 2 + 0.01), w0, w1, 0.5, Math.min(2.1, head), f);
          }
          const band = Math.min(fw - 0.4, open + 1.6);
          block(INSIDE.furniture, colour, edge + s * (T / 2), edge + s * (T / 2 + 0.07), m - band / 2, m + band / 2, head + 0.02, Math.min(H - 0.05, head + 0.55), true);
          lettering.push({ text: shopNow.name, a: edge + s * (T / 2 + 0.08), b: m, z: head + 0.02 + Math.min(H - 0.05 - head - 0.02, 0.53) / 2, fa: s, fb: 0, w: band - 0.3 });
          clear.push(left ? [edge - 1.4, edge, m - open / 2, m + open / 2] : [edge, edge + 1.4, m - open / 2, m + open / 2]);
          // Inside: shelves down both sides and across the back, and a counter with its keeper.
          const inside = boxIn(r, k === 3 ? 2 : 3); // its own frame: back wall first, the walk in front
          const kk = k === 3 ? 2 : 3;
          const piece = (w0: number, w1: number, d0: number, d1: number): Rect => (kk === 2 ? [r[0] + d0, r[0] + d1, r[2] + w0, r[2] + w1] : [r[1] - d1, r[1] - d0, r[2] + w0, r[2] + w1]);
          let n = 0;
          if (shopNow.food) {
            // Somewhere to eat: the counter across the back, tables in front of it.
            const cl = Math.min(2.6, fw - 1.2);
            counter((mat, hex, w0, w1, d0, d1, z0, z1, under) => inside(mat, hex, (fw - cl) / 2 + w0, (fw - cl) / 2 + w1, 1.0 + d0, 1.0 + d1, z0, z1, under), cl, colour);
            inside(F, GLASS, (fw - cl) / 2 + 0.2, (fw - cl) / 2 + cl - 0.8, 1.08, 1.55, 0.94, 1.28);
            if (keepers++ < 10) person("barista", "stand", pointIn(r, kk, fw / 2, 0.55), k === 3 ? 2 : 3);
            const at = pointIn(r, kk, fw / 2, 1.3);
            tills.push({ a: at[0], b: at[1], use: "food", text: shopNow.name });
            for (let w0 = 0.7; w0 + 0.8 <= fw - 0.7 && deep >= 5; w0 += 1.9) {
              const t = piece(w0, w0 + 0.8, 3.0, 3.8);
              const seats = tableAndChairs(t, [0, 1], wood, colour);
              if (hash32(spec.seed, 0x45415453 + shopNo * 5 + n++) % 10 < 5) person("guest", "sit", seats[0].at, seats[0].k, { seat: 0.45 });
            }
          } else {
            const across = Math.max(1, Math.round((fw - 0.4) / 2.2)), sw = (fw - 0.4) / across - 0.06;
            for (let i2 = 0; i2 < across; i2++) {
              const w0 = 0.2 + (i2 * (fw - 0.4)) / across;
              shelves((mat, hex, a, b, c, d, e, f, g) => inside(mat, hex, w0 + a, w0 + b, 0.05 + c, 0.05 + d, e, f, g), sw, shopNow.trade, 0x4d53484c + shopNo * 101 + n++ * 7, 1.8, big);
            }
            const run = deep - 2.2, rows = Math.max(1, Math.round(run / 2.2)), sl = run / rows - 0.06;
            for (let i2 = 0; i2 < rows && run >= 1.2; i2++) {
              for (const sideW of [0, 1]) {
                const d0 = 0.7 + (i2 * run) / rows;
                const rect = piece(sideW ? fw - 0.5 : 0.1, sideW ? fw - 0.1 : 0.5, d0, d0 + sl);
                shelves(boxIn(rect, sideW ? 1 : 0), sl, shopNow.trade, 0x4d53484c + shopNo * 101 + n++ * 7, 1.8, big);
              }
            }
            if (deep >= 4.2 && fw >= 3.6) {
              const cl = Math.min(1.8, fw - 2);
              counter((mat, hex, w0, w1, d0, d1, z0, z1, under) => inside(mat, hex, (fw - cl) / 2 + w0, (fw - cl) / 2 + w1, 1.5 + d0, 1.5 + d1, z0, z1, under), cl, colour);
              if (keepers++ < 10) person("keeper", "stand", pointIn(r, kk, fw / 2, 1.05), k === 3 ? 2 : 3);
              // (Only what is food is sold from the lunch box: a fruit shop, not a bookshop.)
              if (shopNow.trade === "greengrocer") { const at = pointIn(r, kk, fw / 2, 1.8); tills.push({ a: at[0], b: at[1], use: "shop", text: shopNow.name }); }
            }
          }
        }
      }
    }

    // Down the middle of the walk: a tree in a planter under a skylight, benches, more planters.
    const room = cw - 3.2; // what the two lanes leave
    if (room >= 1.2) {
      const mid = cross ? (cross[2] + cross[3]) / 2 : D / 2;
      const pw = Math.min(2.2, room);
      if (D >= 14) {
        const p: Rect = [ca - pw / 2, ca + pw / 2, mid - 1.1, mid + 1.1];
        taken.push(p);
        block(F, 0xd9d2c4, p[0], p[1], p[2], p[3], 0, 0.5);
        block(F, 0x5a4632, p[0] + 0.1, p[1] - 0.1, p[2] + 0.1, p[3] - 0.1, 0.5, 0.54);
        const top = Math.min(H - 0.3, 3.6);
        block(F, TIMBER, ca - 0.1, ca + 0.1, mid - 0.1, mid + 0.1, 0.54, top - 1.2);
        block(F, LEAF, ca - pw * 0.42, ca + pw * 0.42, mid - 0.95, mid + 0.95, top - 1.5, top - 0.5, true);
        block(F, 0x4fae55, ca - pw * 0.28, ca + pw * 0.28, mid - 0.6, mid + 0.6, top - 0.5, top, true);
        put("ceiling", INSIDE.glass, 0xcfe8f7, ca - cw / 2 + 0.6, ca + cw / 2 - 0.6, mid - 2.6, mid + 2.6, H - 0.02, H - 0.02);
        for (const end of [-1, 1]) {
          const r: Rect = [ca - 0.8, ca + 0.8, end < 0 ? mid - 1.85 : mid + 1.35, end < 0 ? mid - 1.35 : mid + 1.85];
          taken.push(r);
          bench(boxIn(r, end < 0 ? 1 : 0));
          if (hash32(spec.seed, 0x42454e43 + end) % 10 < 6) person("shopper", "sit", [ca - 0.3, end < 0 ? mid - 1.63 : mid + 1.63], end < 0 ? 1 : 0, { seat: 0.45 });
        }
      }
      let n = 0;
      for (let b = 4.5; b <= D - 4.5; b += 5.5) {
        if (Math.abs(b - mid) < 5 && D >= 14) continue;
        const r: Rect = n++ % 2 ? [ca - 0.45, ca + 0.45, b - 0.45, b + 0.45] : [ca - 0.25, ca + 0.25, b - 0.8, b + 0.8];
        if (!take(r, undefined, 0.3)) continue;
        if (n % 2 === 0) { block(F, 0xd9d2c4, r[0], r[1], r[2], r[3], 0, 0.45); block(F, LEAF, r[0] + 0.08, r[1] - 0.08, r[2] + 0.08, r[3] - 0.08, 0.45, 1.3); }
        else {
          bench(boxIn([r[0], r[1], r[2], r[3]], 2));
          if (hash32(spec.seed, 0x53495453 + n) % 10 < 5) person("shopper", "sit", [ca + 0.05, b], 2, { seat: 0.45 });
        }
      }
    }
    // People strolling up one side of the walk and down the other, and some looking in at a window.
    const lanes = cw >= 4.5 ? [0.13, 0.87] : [0.25, 0.75];
    const strollers = Math.min(8, Math.max(1, Math.round(D / 7)));
    for (let i = 0; i < strollers; i++) {
      const a = ca - cw / 2 + cw * lanes[i % 2];
      const lo = 1.2 + ((D - 2.4) * (hash32(spec.seed, 0x5354524f + i) % 30)) / 100, hi = D - 1.2 - ((D - 2.4) * (hash32(spec.seed, 0x5354524f + i * 3 + 1) % 30)) / 100;
      const r = (v: number): number => Math.round(v * 100) / 100;
      if (people.length < MOST) people.push({ n: nobody++, role: "shopper", pose: "walk", a: r(a), b: r(lo), fa: 0, fb: 1, path: [r(a), r(lo), r(a), r(hi)] });
    }
    if (spec.name) lettering.push({ text: spec.name, a: ca, b: D - 0.04, z: Math.min(H - 0.4, 3.0), fa: 0, fb: -1, w: Math.min(cw - 0.6, 5) });
  };

  if (spec.kind === "office") office();
  else if (spec.kind === "shop") shop();
  else if (spec.kind === "cafe") cafe();
  else if (spec.kind === "lobby") lobby();
  else mall();
  return { spec, doors, pieces, people, lettering, tills };
}
