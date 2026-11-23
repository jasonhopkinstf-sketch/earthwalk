// The inside of a home. A house that can be walked into (see `HomeDoor` in chunk.ts) gets rooms,
// doorways, windows and furniture, built here from the house's own numbers so that it is the same
// house inside for everyone and on every visit.
//
// The rooms come from thirty layouts of our own: each is a recipe for cutting a rectangle into rooms
// (`LAYOUTS`), stretched to the size of the real house. A house takes the first recipe, starting
// from one picked by its identity, whose rooms are all big enough to stand in and whose front room
// has the front door in it. The mesh comes out in the chunk's own format, with surface ids of its
// own (docs/PROTOCOL.md, "Inside houses").
//
// Everything is worked out in the house's own frame, in metres: `a` runs along the front wall from
// its left-hand corner as you face out of the door, `b` runs back into the house, `z` is up from
// the floor.

import { hash32, metersPerTile, xToLon, yToLat } from "./geo.ts";
import { CHUNK_Z } from "./geo.ts";
import { type ChunkMesh, encodeChunk, face, featuresForChunk, type HomeDoor, homesOf, type MaterialDef, painted, Section } from "./chunk.ts";
import type { Elevation } from "./elevation.ts";
import { loadFeatures, type Features } from "./osm.ts";
import type { Decor } from "./home.ts";

/** Bump when interiors change, so cached ones are rebuilt. */
export const INTERIOR_REV = 2;

export const INSIDE = {
  floor: { id: 40, color: 0, collision: true },
  wall: { id: 41, color: 0, collision: true },
  ceiling: { id: 42, color: 0, collision: false },
  furniture: { id: 43, color: 0, collision: true },
  glass: { id: 44, color: 0, collision: false },
  soft: { id: 45, color: 0, collision: false },
} satisfies Record<string, MaterialDef>;

const ROOM_MAX_M = 2.6; // floor to ceiling, where the house is tall enough
const ROOM_LOW_M = 2.3; // and the least it ever is
const DOOR_W = 0.9;
const DOOR_H = 2.05;
const WALL_T = 0.1;
/** No room may be narrower than this, or the layout is not for this house. */
const ROOM_MIN_M = 2.1;

/** What a room is: L living, K kitchen, B bedroom, T bathroom, H hall, D dining, S study, P playroom, U utility. */
type RoomKind = "L" | "K" | "B" | "T" | "H" | "D" | "S" | "P" | "U";
/** A recipe: a room, or a cut across the width (`a`) or the depth (`b`) at a share of it, with what goes each side (left then right; front then back). */
type Recipe = RoomKind | ["a" | "b", number, Recipe, Recipe];

/** Thirty ways to lay out a home, from one room to seven. */
export const LAYOUTS: Recipe[] = [
  "L",
  ["b", 0.6, "L", "K"],
  ["a", 0.6, "L", "K"],
  ["b", 0.55, "L", ["a", 0.55, "K", "T"]],
  ["b", 0.5, "L", ["a", 0.5, "K", "B"]],
  ["a", 0.58, "L", ["b", 0.5, "K", "B"]],
  ["a", 0.42, ["b", 0.5, "K", "T"], "L"],
  ["b", 0.45, ["a", 0.3, "H", "L"], ["a", 0.5, "K", "B"]],
  ["b", 0.5, ["a", 0.65, "L", "H"], ["a", 0.4, "B", "K"]],
  ["a", 0.5, ["b", 0.6, "L", "K"], ["b", 0.5, "B", "T"]],
  ["a", 0.5, ["b", 0.5, "B", "T"], ["b", 0.6, "L", "K"]],
  ["b", 0.4, "L", ["a", 0.34, "K", ["a", 0.5, "T", "B"]]],
  ["b", 0.42, ["a", 0.28, "H", "L"], ["a", 0.36, "K", ["a", 0.5, "T", "B"]]],
  ["a", 0.3, ["b", 0.34, "H", ["b", 0.5, "T", "U"]], ["b", 0.58, "L", "K"]],
  ["b", 0.56, ["a", 0.6, "L", "D"], ["a", 0.5, "K", "B"]],
  ["b", 0.5, ["a", 0.5, "L", "D"], ["a", 0.34, "K", ["a", 0.5, "T", "B"]]],
  ["a", 0.62, ["b", 0.58, "L", ["a", 0.5, "K", "D"]], ["b", 0.4, "S", ["b", 0.5, "T", "B"]]],
  ["a", 0.36, ["b", 0.4, "S", ["b", 0.5, "T", "B"]], ["b", 0.58, "L", ["a", 0.5, "D", "K"]]],
  ["b", 0.38, ["a", 0.5, "L", "P"], ["a", 0.5, "K", "B"]],
  ["b", 0.44, ["a", 0.22, "H", ["a", 0.6, "L", "S"]], ["a", 0.3, "K", ["a", 0.4, "T", "B"]]],
  ["a", 0.26, ["b", 0.3, "H", ["b", 0.5, "U", "T"]], ["b", 0.5, ["a", 0.55, "L", "D"], ["a", 0.5, "K", "B"]]],
  ["b", 0.34, ["a", 0.5, "L", "D"], ["b", 0.5, ["a", 0.5, "K", "P"], ["a", 0.5, "B", "T"]]],
  ["b", 0.6, "L", "B"],
  ["a", 0.5, "L", ["b", 0.5, "B", "T"]],
  ["b", 0.5, ["a", 0.5, "L", "K"], ["a", 0.5, "B", "S"]],
  ["b", 0.5, ["a", 0.4, "K", "L"], ["a", 0.6, "B", "T"]],
  ["a", 0.24, "H", ["b", 0.5, ["a", 0.6, "L", "K"], ["a", 0.5, "B", "P"]]],
  ["a", 0.76, ["b", 0.5, ["a", 0.5, "K", "L"], ["a", 0.5, "S", "B"]], "H"],
  ["b", 0.3, "H", ["a", 0.5, ["b", 0.55, "L", "K"], ["b", 0.5, "B", "T"]]],
  ["b", 0.46, ["a", 0.34, "S", "L"], ["a", 0.66, ["a", 0.5, "K", "D"], "B"]],
];

export interface Room { kind: RoomKind; a0: number; a1: number; b0: number; b1: number }
/** A way through between two rooms: which rooms, and where the gap is on the wall they share. */
interface Doorway { from: number; to: number; along: "a" | "b"; at: number; lo: number; hi: number }

function cut(recipe: Recipe, a0: number, a1: number, b0: number, b1: number, out: Room[]): void {
  if (typeof recipe === "string") return void out.push({ kind: recipe, a0, a1, b0, b1 });
  const [axis, share, first, second] = recipe;
  if (axis === "a") {
    const mid = a0 + (a1 - a0) * share;
    cut(first, a0, mid, b0, b1, out);
    cut(second, mid, a1, b0, b1, out);
  } else {
    const mid = b0 + (b1 - b0) * share;
    cut(first, a0, a1, b0, mid, out);
    cut(second, a0, a1, mid, b1, out);
  }
}

/** The wall two rooms share, if they share one long enough for a doorway. */
function shared(p: Room, q: Room): { along: "a" | "b"; at: number; lo: number; hi: number } | null {
  const near = (x: number, y: number): boolean => Math.abs(x - y) < 1e-6;
  for (const [along, lo0, hi0, lo1, hi1, edges] of [
    ["a", p.a0, p.a1, q.a0, q.a1, [[p.b1, q.b0], [p.b0, q.b1]]],
    ["b", p.b0, p.b1, q.b0, q.b1, [[p.a1, q.a0], [p.a0, q.a1]]],
  ] as ["a" | "b", number, number, number, number, [number, number][]][]) {
    for (const [mine, theirs] of edges) {
      if (!near(mine, theirs)) continue;
      const lo = Math.max(lo0, lo1), hi = Math.min(hi0, hi1);
      if (hi - lo > 1e-6) return { along, at: mine, lo, hi };
    }
  }
  return null;
}

export interface Plan { rooms: Room[]; doorways: Doorway[]; entrance: number; layout: number; mirrored: boolean }

/**
 * The rooms of a house `width` metres along its front and `depth` metres back, with its front door
 * `door` metres along. Null only for a house too small for even one room.
 */
export function planHome(width: number, depth: number, door: number, seed: number): Plan | null {
  const first = hash32(seed, 0x4c41594f) % LAYOUTS.length;
  for (let n = 0; n < LAYOUTS.length * 2; n++) {
    const layout = (first + (n >> 1)) % LAYOUTS.length;
    const mirrored = ((hash32(seed, 0x4d495252) + n) & 1) === 1;
    const rooms: Room[] = [];
    cut(LAYOUTS[layout], 0, width, 0, depth, rooms);
    if (mirrored) for (const r of rooms) [r.a0, r.a1] = [width - r.a1, width - r.a0];
    if (rooms.some((r) => r.a1 - r.a0 < ROOM_MIN_M || r.b1 - r.b0 < ROOM_MIN_M)) continue;
    // The front door opens into a hall or a living room, clear of that room's corners. (A one-room home is all living room.)
    const entrance = rooms.findIndex((r) => r.b0 === 0 && door - DOOR_W / 2 >= r.a0 + 0.25 && door + DOOR_W / 2 <= r.a1 - 0.25);
    if (entrance < 0 || !"HL".includes(rooms[entrance].kind)) continue;
    // Every room is reached from the entrance, each by one doorway from a room already reached.
    const doorways: Doorway[] = [];
    const reached = new Set([entrance]);
    for (const queue = [entrance]; queue.length; ) {
      const from = queue.shift()!;
      rooms.forEach((room, to) => {
        if (reached.has(to)) return;
        const wall = shared(rooms[from], room);
        if (!wall || wall.hi - wall.lo < DOOR_W + 0.5) return;
        const mid = (wall.lo + wall.hi) / 2;
        doorways.push({ from, to, along: wall.along, at: wall.at, lo: mid - DOOR_W / 2, hi: mid + DOOR_W / 2 });
        reached.add(to);
        queue.push(to);
      });
    }
    if (reached.size === rooms.length) return { rooms, doorways, entrance, layout, mirrored };
  }
  return null;
}

const WOODS = [0xc9a36b, 0xb98c5a, 0xd9b98a, 0xa97c50];
const TILES = [0xd9e3e6, 0xe8dcc8, 0xcfe0d8];
const PAINTS = [0xf3ead7, 0xe6efe9, 0xf6e3d5, 0xe3ecf6, 0xf5f0c8, 0xefe2ee, 0xf2efe6];
const CLOTHS = [0xb5372e, 0x3f6fb0, 0x3f7f4f, 0xe0a82e, 0x7a4f9a, 0x2f8f8a, 0xd87a9a, 0xe8935a];
const TIMBER = [0x8a5a3a, 0x6f4a30, 0xa9744a, 0xc9a36b];
const WHITE = 0xf7f5ef;
const STEEL = 0xb9c0c6;
const LEAF = 0x3f9a45;

/** The paints a house's owner can choose for its walls (home.ts): the colour, and for some a pattern over it. */
const WALLS: Record<string, { hex: number; over?: number; kind?: "stripes" | "stars" }> = {
  sun: { hex: 0xf6dc7a }, sky: { hex: 0xa9d3ee }, mint: { hex: 0xb5e3c3 }, rose: { hex: 0xf2b8c6 }, lilac: { hex: 0xcdb8ea }, peach: { hex: 0xf7c6a0 },
  night: { hex: 0x2c3a6b, over: 0xf2e394, kind: "stars" },
  stripes: { hex: 0xf7f5ef, over: 0xd94a3a, kind: "stripes" },
};
/** And the floors: one colour, or two in squares (which go down in kitchens and bathrooms too). */
const FLOORS: Record<string, { hex: number; check?: number }> = {
  oak: { hex: 0xd9a75a }, walnut: { hex: 0x6b4630 }, white: { hex: 0xefeae0 }, check: { hex: 0x2b2b2f, check: 0xf2f0ea }, redcarpet: { hex: 0xb5372e }, lawn: { hex: 0x5fae4a },
};
const RAINBOW = [0xd9382e, 0xe8935a, 0xf2cc74, 0x3f9a45, 0x3f6fb0, 0x7a4f9a];
const GOLD = 0xe0b23c;
const BLACK = 0x26262b;
const RED = 0xd9382e;
/** Where prizes are stood, the likeliest rooms first; never the bathroom. */
const PRIZE_ROOMS: RoomKind[] = ["L", "D", "H", "P", "S", "B", "K", "U"];

/**
 * The inside of one home, in its chunk's coordinates. `decor` is what its owner has chosen (home.ts); without
 * it the house is as it was built.
 */
export function buildInterior(home: HomeDoor, S: number, decor: Decor | null = null): ChunkMesh {
  const sections = new Map<string, Section>();
  const sec = (m: MaterialDef, hex: number): Section => {
    const mat = painted(m, hex);
    const key = `${mat.id}:${mat.color}`;
    let s = sections.get(key);
    if (!s) sections.set(key, (s = new Section(mat)));
    return s;
  };

  // The house's own frame. The front wall is the side of the outline the door is on.
  const c = home.corners;
  let front = 0;
  let nearest = Infinity;
  for (let i = 0; i < 4; i++) {
    const p = c[i], q = c[(i + 1) % 4];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const off = Math.abs(((home.x - p[0]) * (q[1] - p[1]) - (home.y - p[1]) * (q[0] - p[0])) / len);
    if (off < nearest) { nearest = off; front = i; }
  }
  const A = c[front], B = c[(front + 1) % 4], C = c[(front + 2) % 4];
  const width = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const depth = Math.hypot(C[0] - B[0], C[1] - B[1]);
  const ta: [number, number] = [(B[0] - A[0]) / width, (B[1] - A[1]) / width];
  const tb: [number, number] = [(C[0] - B[0]) / depth, (C[1] - B[1]) / depth];
  const door = Math.min(width - 0.8, Math.max(0.8, (home.x - A[0]) * ta[0] + (home.y - A[1]) * ta[1]));
  const at = (a: number, b: number, z: number): [number, number, number] => [A[0] + ta[0] * a + tb[0] * b, A[1] + ta[1] * a + tb[1] * b, home.floor + z];
  const dir = (da: number, db: number, dz: number): [number, number, number] => [ta[0] * da + tb[0] * db, ta[1] * da + tb[1] * db, dz];
  /** A flat panel facing along `a` (+1 or -1) at a given `a`, or along `b` at a given `b`. */
  const panelA = (s: Section, a: number, b0: number, b1: number, z0: number, z1: number, facing: number): void =>
    face(s, [at(a, b0, z0), at(a, b1, z0), at(a, b1, z1), at(a, b0, z1)], dir(facing, 0, 0));
  const panelB = (s: Section, b: number, a0: number, a1: number, z0: number, z1: number, facing: number): void =>
    face(s, [at(a0, b, z0), at(a1, b, z0), at(a1, b, z1), at(a0, b, z1)], dir(0, facing, 0));
  const top = (s: Section, a0: number, a1: number, b0: number, b1: number, z: number, facing = 1): void =>
    face(s, [at(a0, b0, z), at(a1, b0, z), at(a1, b1, z), at(a0, b1, z)], dir(0, 0, facing));
  /** A box standing on (or hanging at) `z0`: four sides and a top. */
  const block = (s: Section, a0: number, a1: number, b0: number, b1: number, z0: number, z1: number): void => {
    panelA(s, a0, b0, b1, z0, z1, -1);
    panelA(s, a1, b0, b1, z0, z1, 1);
    panelB(s, b0, a0, a1, z0, z1, -1);
    panelB(s, b1, a0, a1, z0, z1, 1);
    top(s, a0, a1, b0, b1, z1);
  };

  // The ceiling keeps under the top of the walls, which on a hillside is not far above the floor.
  const ROOM_M = Math.min(ROOM_MAX_M, Math.max(ROOM_LOW_M, home.height - 0.1));
  const inset = 0.05; // the lining stands this far inside the real walls
  const plan = planHome(width - inset * 2, depth - inset * 2, door - inset, home.seed)
    ?? { rooms: [{ kind: "L" as RoomKind, a0: 0, a1: width - inset * 2, b0: 0, b1: depth - inset * 2 }], doorways: [], entrance: 0, layout: 0, mirrored: false };
  for (const r of plan.rooms) { r.a0 += inset; r.a1 += inset; r.b0 += inset; r.b1 += inset; }
  for (const d of plan.doorways) { d.at += inset; d.lo += inset; d.hi += inset; }
  const pick = <T>(list: T[], salt: number): T => list[hash32(home.seed, salt) % list.length];

  top(sec(INSIDE.ceiling, 0xfbf9f3), inset, width - inset, inset, depth - inset, ROOM_M, -1);
  // What the owner has chosen for the walls and the floors, if anything.
  const walls = decor?.walls ? WALLS[decor.walls] : undefined;
  const laid = decor?.floor ? FLOORS[decor.floor] : undefined;
  const partition = sec(INSIDE.wall, walls?.hex ?? 0xf7f3ea);
  const frame = sec(INSIDE.glass, WHITE);
  const glass = sec(INSIDE.glass, 0xa9d4ee);
  type Put = (c0: number, c1: number, z0: number, z1: number, proud: number, s: Section) => void;

  plan.rooms.forEach((r, i) => {
    const wet = r.kind === "K" || r.kind === "T" || r.kind === "U";
    if (laid?.check !== undefined) {
      // Squares of two colours, on one grid for the whole house so that they meet in the doorways.
      const T = 0.6;
      for (let ia = Math.floor(r.a0 / T); ia * T < r.a1; ia++) {
        for (let ib = Math.floor(r.b0 / T); ib * T < r.b1; ib++) {
          top(sec(INSIDE.floor, (ia + ib) & 1 ? laid.hex : laid.check), Math.max(r.a0, ia * T), Math.min(r.a1, (ia + 1) * T), Math.max(r.b0, ib * T), Math.min(r.b1, (ib + 1) * T), 0);
        }
      }
    } else if (laid && !wet) {
      top(sec(INSIDE.floor, laid.hex), r.a0, r.a1, r.b0, r.b1, 0);
    } else {
      top(sec(INSIDE.floor, wet ? pick(TILES, 0x464c + i) : pick(WOODS, 0x464c + (r.kind === "H" ? 99 : i))), r.a0, r.a1, r.b0, r.b1, 0);
    }
    // The lining of the outside walls, in this room's own paint, with a window in each long enough stretch.
    const paint = sec(INSIDE.wall, walls?.hex ?? PAINTS[hash32(home.seed, 0x5041494e + i) % PAINTS.length]);
    let wallNo = 0;
    const window = (lo: number, hi: number, put: Put, clear: [number, number] | null): void => {
      // A pattern over the paint goes on first, and the window over that.
      wallNo++;
      if (walls?.kind === "stripes") {
        const over = sec(INSIDE.glass, walls.over!);
        for (let c0 = Math.ceil(lo / 0.8) * 0.8; c0 + 0.4 <= hi; c0 += 0.8) put(c0, c0 + 0.4, 0, ROOM_M, 0.005, over);
      } else if (walls?.kind === "stars") {
        const over = sec(INSIDE.glass, walls.over!);
        for (let k = 0; k < Math.floor((hi - lo) * 1.3); k++) {
          const h = hash32(home.seed, 0x53544152 + i * 977 + k * 31 + wallNo * 7919);
          const c0 = lo + 0.2 + ((h % 1000) / 1000) * Math.max(0, hi - lo - 0.5);
          const z0 = 1.0 + (((h >>> 10) % 1000) / 1000) * (ROOM_M - 1.3);
          const size = 0.06 + ((h >>> 20) % 3) * 0.03;
          put(c0, c0 + size, z0, z0 + size, 0.005, over);
        }
      }
      if (hi - lo < 2.4) return;
      const mid = (lo + hi) / 2;
      if (clear && mid + 0.9 > clear[0] && mid - 0.9 < clear[1]) return; // the front door is here
      put(mid - 0.68, mid + 0.68, 0.86, 2.14, 0.01, frame);
      put(mid - 0.56, mid + 0.56, 0.98, 2.02, 0.02, glass);
    };
    const onFront = r.b0 <= inset + 1e-6, onBack = r.b1 >= depth - inset - 1e-6, onLeft = r.a0 <= inset + 1e-6, onRight = r.a1 >= width - inset - 1e-6;
    if (onFront) {
      panelB(paint, r.b0, r.a0, r.a1, 0, ROOM_M, 1);
      window(r.a0, r.a1, (c0, c1, z0, z1, proud, s) => panelB(s, r.b0 + proud, c0, c1, z0, z1, 1), i === plan.entrance ? [door - 0.7, door + 0.7] : null);
    }
    if (onBack) {
      panelB(paint, r.b1, r.a0, r.a1, 0, ROOM_M, -1);
      window(r.a0, r.a1, (c0, c1, z0, z1, proud, s) => panelB(s, r.b1 - proud, c0, c1, z0, z1, -1), null);
    }
    if (onLeft) {
      panelA(paint, r.a0, r.b0, r.b1, 0, ROOM_M, 1);
      window(r.b0, r.b1, (c0, c1, z0, z1, proud, s) => panelA(s, r.a0 + proud, c0, c1, z0, z1, 1), null);
    }
    if (onRight) {
      panelA(paint, r.a1, r.b0, r.b1, 0, ROOM_M, -1);
      window(r.b0, r.b1, (c0, c1, z0, z1, proud, s) => panelA(s, r.a1 - proud, c0, c1, z0, z1, -1), null);
    }
  });

  // The front door, seen from inside, and a mat before it.
  panelB(sec(INSIDE.glass, WHITE), inset + 0.01, door - 0.6, door + 0.6, 0, 2.2, 1);
  panelB(sec(INSIDE.glass, pick(CLOTHS, 0x444f4f52)), inset + 0.02, door - 0.48, door + 0.48, 0, 2.08, 1);
  top(sec(INSIDE.soft, 0x8a6a4a), door - 0.5, door + 0.5, inset + 0.15, inset + 0.75, 0.02);

  // The walls between rooms, each with its doorway if it has one.
  const walled = new Set<string>();
  for (let i = 0; i < plan.rooms.length; i++) {
    for (let j = i + 1; j < plan.rooms.length; j++) {
      const wall = shared(plan.rooms[i], plan.rooms[j]);
      if (!wall) continue;
      const key = `${wall.along}${wall.at.toFixed(3)}:${wall.lo.toFixed(3)}`;
      if (walled.has(key)) continue;
      walled.add(key);
      const gap = plan.doorways.find((d) => (d.from === i && d.to === j) || (d.from === j && d.to === i));
      const piece = (lo: number, hi: number, z0: number, z1: number): void => {
        if (hi - lo < 0.01) return;
        if (wall.along === "a") block(partition, lo, hi, wall.at - WALL_T / 2, wall.at + WALL_T / 2, z0, z1);
        else block(partition, wall.at - WALL_T / 2, wall.at + WALL_T / 2, lo, hi, z0, z1);
      };
      if (!gap) piece(wall.lo, wall.hi, 0, ROOM_M);
      else {
        piece(wall.lo, gap.lo, 0, ROOM_M);
        piece(gap.hi, wall.hi, 0, ROOM_M);
        piece(gap.lo, gap.hi, DOOR_H, ROOM_M);
      }
    }
  }

  // ---- furniture. Each piece stands against a wall of its room, clear of every doorway.
  type Box = (s: Section, w0: number, w1: number, d0: number, d1: number, z0: number, z1: number) => void;
  const col = (hex: number): Section => sec(INSIDE.furniture, hex);
  const standers: { kind: RoomKind; against: (w: number, d: number, salt: number, make: (box: Box) => void) => boolean }[] = [];
  plan.rooms.forEach((r, i) => {
    /** Points to keep clear: the doorways of this room, and the front door. */
    const ways: [number, number][] = [];
    for (const d of plan.doorways) {
      if (d.from !== i && d.to !== i) continue;
      ways.push(d.along === "a" ? [(d.lo + d.hi) / 2, d.at] : [d.at, (d.lo + d.hi) / 2]);
    }
    if (i === plan.entrance) ways.push([door, r.b0]);
    const placed: [number, number, number, number][] = [];
    const free = (a0: number, a1: number, b0: number, b1: number): boolean => {
      if (a0 < r.a0 + 0.06 || a1 > r.a1 - 0.06 || b0 < r.b0 + 0.06 || b1 > r.b1 - 0.06) return false;
      for (const [wa, wb] of ways) if (wa > a0 - 0.85 && wa < a1 + 0.85 && wb > b0 - 0.85 && wb < b1 + 0.85) return false;
      for (const [p0, p1, q0, q1] of placed) if (a0 < p1 + 0.12 && a1 > p0 - 0.12 && b0 < q1 + 0.12 && b1 > q0 - 0.12) return false;
      return true;
    };
    /**
     * Stands a piece `w` wide and `d` deep against a wall, trying the corners and middles of all four walls in an
     * order of this room's own. `make` is given a way to place boxes in the piece's own frame: across its width,
     * out from the wall, and up.
     */
    const against = (w: number, d: number, salt: number, make: (box: Box) => void): boolean => {
      const start = hash32(home.seed, salt + i * 131) % 12;
      for (let n = 0; n < 12; n++) {
        const k = (start + n) % 12;
        const wallSide = k % 4; // 0 front, 1 back, 2 left, 3 right
        const where = Math.floor(k / 4); // 0 start, 1 end, 2 middle
        const run = wallSide < 2 ? r.a1 - r.a0 : r.b1 - r.b0;
        if (w > run - 0.2) continue;
        const from = where === 0 ? 0.1 : where === 1 ? run - w - 0.1 : (run - w) / 2;
        let rect: [number, number, number, number];
        if (wallSide === 0) rect = [r.a0 + from, r.a0 + from + w, r.b0 + 0.08, r.b0 + 0.08 + d];
        else if (wallSide === 1) rect = [r.a0 + from, r.a0 + from + w, r.b1 - 0.08 - d, r.b1 - 0.08];
        else if (wallSide === 2) rect = [r.a0 + 0.08, r.a0 + 0.08 + d, r.b0 + from, r.b0 + from + w];
        else rect = [r.a1 - 0.08 - d, r.a1 - 0.08, r.b0 + from, r.b0 + from + w];
        if (!free(...rect)) continue;
        placed.push(rect);
        make((s, w0, w1, d0, d1, z0, z1) => {
          if (wallSide === 0) block(s, rect[0] + w0, rect[0] + w1, rect[2] + d0, rect[2] + d1, z0, z1);
          else if (wallSide === 1) block(s, rect[0] + w0, rect[0] + w1, rect[3] - d1, rect[3] - d0, z0, z1);
          else if (wallSide === 2) block(s, rect[0] + d0, rect[0] + d1, rect[2] + w0, rect[2] + w1, z0, z1);
          else block(s, rect[1] - d1, rect[1] - d0, rect[2] + w0, rect[2] + w1, z0, z1);
        });
        return true;
      }
      return false;
    };
    /** Stands a piece in the middle of the room, if there is room. */
    const middle = (w: number, d: number, make: (a0: number, b0: number) => void): boolean => {
      const a0 = (r.a0 + r.a1 - w) / 2, b0 = (r.b0 + r.b1 - d) / 2;
      if (!free(a0, a0 + w, b0, b0 + d)) return false;
      placed.push([a0, a0 + w, b0, b0 + d]);
      make(a0, b0);
      return true;
    };
    const wood = sec(INSIDE.furniture, pick(TIMBER, 0x574f4f44 + i));
    const cloth = sec(INSIDE.furniture, pick(CLOTHS, 0x434c4f54 + i));
    const white = sec(INSIDE.furniture, WHITE);
    standers.push({ kind: r.kind, against });
    const rug = (w: number, d: number, salt: number): void => {
      const a0 = (r.a0 + r.a1 - w) / 2, b0 = (r.b0 + r.b1 - d) / 2;
      if (!(a0 > r.a0 + 0.3 && b0 > r.b0 + 0.3)) return;
      const soft = (hex: number): Section => sec(INSIDE.soft, hex);
      if (decor?.rug === "rainbow") {
        RAINBOW.forEach((hex, k) => top(soft(hex), a0, a0 + w, b0 + (d * k) / 6, b0 + (d * (k + 1)) / 6, 0.015));
      } else if (decor?.rug === "chess") {
        const n = Math.max(2, Math.round(w / 0.3)), m = Math.max(2, Math.round(d / 0.3));
        for (let p = 0; p < n; p++) for (let q = 0; q < m; q++) top(soft((p + q) & 1 ? 0x2b2b2f : 0xf2f0ea), a0 + (w * p) / n, a0 + (w * (p + 1)) / n, b0 + (d * q) / m, b0 + (d * (q + 1)) / m, 0.015);
      } else if (decor?.rug === "target") {
        for (let k = 0; k < 4; k++) {
          const in_ = (k * Math.min(w, d)) / 8;
          top(soft(k % 2 ? WHITE : RED), a0 + in_, a0 + w - in_, b0 + in_, b0 + d - in_, 0.015 + k * 0.004);
        }
      } else top(soft(pick(CLOTHS, salt + i)), a0, a0 + w, b0, b0 + d, 0.015);
    };
    /** The sofa: the one the house came with, or the one its owner chose. */
    const sofa = (): boolean => against(2.0, 0.9, 0x534f4641, (box) => {
      if (decor?.sofa === "royal") {
        const purple = col(0x6a3d9a), gold = col(GOLD);
        box(gold, 0.1, 1.9, 0.18, 0.9, 0, 0.12);
        box(purple, 0.1, 1.9, 0.18, 0.9, 0.12, 0.48);
        box(purple, 0.1, 1.9, 0, 0.22, 0.12, 1.15);
        box(gold, 0.6, 1.4, 0, 0.22, 1.15, 1.3);
        box(gold, 0, 0.2, 0.1, 0.9, 0, 0.7);
        box(gold, 1.8, 2.0, 0.1, 0.9, 0, 0.7);
        box(col(0xb5372e), 0.3, 0.9, 0.3, 0.85, 0.48, 0.56);
        box(col(0xb5372e), 1.1, 1.7, 0.3, 0.85, 0.48, 0.56);
      } else if (decor?.sofa === "cloud") {
        const puff = col(0xf4f6fa), blue = col(0xa9d3ee);
        box(puff, 0, 2.0, 0.15, 0.9, 0, 0.42);
        box(puff, 0, 0.7, 0, 0.3, 0, 0.95);
        box(puff, 0.65, 1.35, 0, 0.32, 0, 1.1);
        box(puff, 1.3, 2.0, 0, 0.3, 0, 0.95);
        box(puff, 0, 0.25, 0.25, 0.9, 0.42, 0.68);
        box(puff, 1.75, 2.0, 0.25, 0.9, 0.42, 0.68);
        box(blue, 0.35, 0.95, 0.35, 0.8, 0.42, 0.5);
        box(blue, 1.05, 1.65, 0.35, 0.8, 0.42, 0.5);
      } else if (decor?.sofa === "racer") {
        const red = col(RED), black = col(BLACK);
        box(black, 0, 2.0, 0.15, 0.9, 0, 0.2);
        box(red, 0.08, 1.92, 0.18, 0.9, 0.2, 0.46);
        box(red, 0.08, 1.92, 0, 0.2, 0.2, 1.0);
        box(white, 0.9, 1.1, 0.18, 0.9, 0.46, 0.47);
        box(white, 0.9, 1.1, 0.2, 0.215, 0.47, 1.0);
        box(black, 0, 0.16, 0.2, 0.9, 0.2, 0.72);
        box(black, 1.84, 2.0, 0.2, 0.9, 0.2, 0.72);
      } else if (decor?.sofa === "bench") {
        const log = col(0x8a5a3a), dark = col(0x6f4a30);
        box(dark, 0.1, 0.35, 0.15, 0.8, 0, 0.38);
        box(dark, 1.65, 1.9, 0.15, 0.8, 0, 0.38);
        box(log, 0, 2.0, 0.1, 0.85, 0.38, 0.48);
        box(dark, 0.05, 0.15, 0, 0.1, 0, 1.0);
        box(dark, 1.85, 1.95, 0, 0.1, 0, 1.0);
        box(log, 0, 2.0, 0, 0.1, 0.6, 0.75);
        box(log, 0, 2.0, 0, 0.1, 0.85, 1.0);
        box(col(0x5fae4a), 0.2, 1.8, 0.2, 0.8, 0.48, 0.54);
      } else {
        box(cloth, 0, 2.0, 0.18, 0.9, 0, 0.45);
        box(cloth, 0, 2.0, 0, 0.2, 0, 0.92);
        box(cloth, 0, 0.18, 0.18, 0.9, 0.45, 0.66);
        box(cloth, 1.82, 2.0, 0.18, 0.9, 0.45, 0.66);
      }
    });
    /** And the bed. Its head is at the wall. */
    const bed = (): boolean => {
      if (decor?.bed === "bunk") {
        return against(1.5, 2.05, 0x424544, (box) => {
          const blue = col(0x3f6fb0);
          for (const [w0, d0] of [[0, 0], [1.42, 0], [0, 1.97], [1.42, 1.97]]) box(wood, w0, w0 + 0.08, d0, d0 + 0.08, 0, 1.8);
          for (const z of [0.22, 1.12]) {
            box(wood, 0, 1.5, 0, 2.05, z, z + 0.1);
            box(white, 0.06, 1.44, 0.08, 1.99, z + 0.1, z + 0.24);
            box(blue, 0.04, 1.46, 0.7, 2.0, z + 0.1, z + 0.26);
            box(white, 0.4, 1.1, 0.14, 0.5, z + 0.24, z + 0.34);
          }
          box(wood, 0, 1.5, 1.99, 2.05, 1.36, 1.62);
          box(wood, 0, 0.06, 0.5, 2.05, 1.36, 1.62);
          for (const z of [0.5, 0.8, 1.1]) box(wood, 1.42, 1.5, 1.3, 1.75, z, z + 0.06);
        });
      }
      if (decor?.bed === "poster") {
        return against(1.5, 2.05, 0x424544, (box) => {
          const dark = col(0x6f4a30), red = col(0xb5372e);
          box(dark, 0, 1.5, 0, 2.05, 0, 0.32);
          box(white, 0.04, 1.46, 0.08, 2.0, 0.32, 0.52);
          box(red, 0.02, 1.48, 0.7, 2.03, 0.32, 0.55);
          box(white, 0.2, 0.7, 0.14, 0.5, 0.52, 0.64);
          box(white, 0.8, 1.3, 0.14, 0.5, 0.52, 0.64);
          box(dark, 0, 1.5, 0, 0.1, 0.32, 1.2);
          for (const [w0, d0] of [[0, 0], [1.42, 0], [0, 1.97], [1.42, 1.97]]) box(dark, w0, w0 + 0.08, d0, d0 + 0.08, 0.32, 2.02);
          box(red, 0, 1.5, 0, 2.05, 2.02, 2.1);
          box(col(GOLD), 0, 1.5, 2.0, 2.06, 1.88, 2.02);
        });
      }
      if (decor?.bed === "racecar") {
        return against(1.7, 2.05, 0x424544, (box) => {
          const red = col(RED), black = col(BLACK);
          box(red, 0.1, 0.22, 0, 2.05, 0, 0.5);
          box(red, 1.48, 1.6, 0, 2.05, 0, 0.5);
          box(red, 0.1, 1.6, 1.85, 2.05, 0, 0.42);
          box(red, 0.1, 1.6, 0, 0.12, 0, 0.7);
          box(black, 0.18, 0.26, 0.03, 0.11, 0.7, 0.86);
          box(black, 1.44, 1.52, 0.03, 0.11, 0.7, 0.86);
          box(black, 0.1, 1.6, 0, 0.16, 0.86, 0.93);
          box(white, 0.22, 1.48, 0.12, 1.85, 0.2, 0.4);
          box(white, 0.22, 1.48, 0.8, 1.85, 0.4, 0.43);
          box(red, 0.75, 0.95, 0.8, 1.85, 0.43, 0.44);
          box(white, 0.5, 1.2, 0.2, 0.6, 0.4, 0.5);
          for (const d0 of [0.25, 1.35]) { box(black, 0, 0.1, d0, d0 + 0.45, 0, 0.45); box(black, 1.6, 1.7, d0, d0 + 0.45, 0, 0.45); }
          box(col(0xf2cc74), 0.25, 0.5, 2.05, 2.06, 0.2, 0.34);
          box(col(0xf2cc74), 1.2, 1.45, 2.05, 2.06, 0.2, 0.34);
        });
      }
      if (decor?.bed === "boat") {
        return against(1.5, 2.05, 0x424544, (box) => {
          const blue = col(0x3f6fb0);
          box(blue, 0, 0.12, 0.3, 1.75, 0, 0.55);
          box(blue, 1.38, 1.5, 0.3, 1.75, 0, 0.55);
          box(white, 0, 0.12, 0.3, 1.75, 0.55, 0.6);
          box(white, 1.38, 1.5, 0.3, 1.75, 0.55, 0.6);
          box(blue, 0, 1.5, 0, 0.3, 0, 0.7);
          box(blue, 0.2, 1.3, 1.75, 1.92, 0, 0.6);
          box(blue, 0.45, 1.05, 1.92, 2.05, 0, 0.66);
          box(white, 0.12, 1.38, 0.3, 1.75, 0.2, 0.4);
          box(col(RED), 0.12, 1.38, 0.9, 1.75, 0.4, 0.43);
          box(white, 0.4, 1.1, 0.36, 0.72, 0.4, 0.5);
          box(wood, 0.71, 0.79, 0.08, 0.16, 0.7, 2.0);
          box(white, 0.2, 1.3, 0.11, 0.13, 1.0, 1.9);
        });
      }
      return against(1.5, 2.05, 0x424544, (box) => {
        box(wood, 0, 1.5, 0, 2.05, 0, 0.3);
        box(white, 0.04, 1.46, 0.08, 2.0, 0.3, 0.5);
        box(cloth, 0.02, 1.48, 0.7, 2.03, 0.3, 0.53);
        box(white, 0.2, 0.7, 0.14, 0.5, 0.5, 0.62);
        box(white, 0.8, 1.3, 0.14, 0.5, 0.5, 0.62);
        box(wood, 0, 1.5, 0, 0.08, 0.3, 1.0);
      });
    };
    const shelves = (salt: number): boolean => against(1.2, 0.34, salt, (box) => {
      box(wood, 0, 1.2, 0, 0.34, 0, 1.85);
      for (let k = 0; k < 4; k++) box(sec(INSIDE.furniture, CLOTHS[(hash32(home.seed, salt + k) + i) % CLOTHS.length]), 0.1 + k * 0.27, 0.3 + k * 0.27, 0.3, 0.36, 0.5 + (k % 2) * 0.55, 0.85 + (k % 2) * 0.55);
    });
    const plant = (salt: number): boolean => against(0.42, 0.42, salt, (box) => {
      box(sec(INSIDE.furniture, 0xb5653c), 0.06, 0.36, 0.06, 0.36, 0, 0.36);
      box(sec(INSIDE.furniture, LEAF), 0, 0.42, 0, 0.42, 0.36, 1.15);
    });
    const tableAndChairs = (w: number, d: number): boolean => middle(w, d, (a0, b0) => {
      block(wood, a0, a0 + w, b0, b0 + d, 0.68, 0.75);
      for (const [la, lb] of [[0.06, 0.06], [w - 0.14, 0.06], [0.06, d - 0.14], [w - 0.14, d - 0.14]]) block(wood, a0 + la, a0 + la + 0.08, b0 + lb, b0 + lb + 0.08, 0, 0.68);
      for (const side of [-1, 1]) {
        const cb = side < 0 ? b0 - 0.5 : b0 + d + 0.08;
        if (cb < r.b0 + 0.1 || cb + 0.42 > r.b1 - 0.1) continue;
        for (let k = 0; k < Math.max(1, Math.floor(w / 0.75)); k++) {
          const ca = a0 + 0.15 + k * 0.75;
          block(cloth, ca, ca + 0.42, cb, cb + 0.42, 0, 0.45);
        }
      }
    });

    if (r.kind === "L") {
      sofa();
      rug(Math.min(2.4, r.a1 - r.a0 - 1.2), Math.min(1.6, r.b1 - r.b0 - 1.2), 0x525547);
      middle(1.0, 0.6, (a0, b0) => block(wood, a0, a0 + 1.0, b0, b0 + 0.6, 0, 0.4));
      shelves(0x424f4f4b);
      against(0.9, 0.85, 0x41524d, (box) => { box(cloth, 0, 0.9, 0.16, 0.85, 0, 0.44); box(cloth, 0, 0.9, 0, 0.18, 0, 0.9); });
      plant(0x504c4e54);
    } else if (r.kind === "K") {
      const run = Math.min(2.6, Math.max(1.4, Math.max(r.a1 - r.a0, r.b1 - r.b0) - 1.2));
      against(run, 0.62, 0x434f554e, (box) => {
        box(wood, 0, run, 0, 0.62, 0, 0.86);
        box(sec(INSIDE.furniture, 0xe9e4d8), 0, run, 0, 0.64, 0.86, 0.9);
        box(sec(INSIDE.furniture, 0x3a3d44), 0.15, 0.75, 0.08, 0.56, 0.9, 0.92); // the hob
        box(sec(INSIDE.furniture, STEEL), run - 0.75, run - 0.15, 0.1, 0.54, 0.9, 0.93); // the sink
      });
      against(0.7, 0.7, 0x46524944, (box) => box(white, 0, 0.7, 0, 0.7, 0, 1.8));
      tableAndChairs(1.1, 0.8);
    } else if (r.kind === "B") {
      bed();
      against(1.2, 0.6, 0x57415244, (box) => box(wood, 0, 1.2, 0, 0.6, 0, 1.95));
      against(0.45, 0.45, 0x53494445, (box) => { box(wood, 0, 0.45, 0, 0.45, 0, 0.5); box(sec(INSIDE.furniture, 0xf2cc74), 0.12, 0.33, 0.12, 0.33, 0.5, 0.85); });
      rug(1.4, 0.9, 0x525532);
    } else if (r.kind === "T") {
      against(1.7, 0.75, 0x42415448, (box) => { box(white, 0, 1.7, 0, 0.75, 0, 0.55); box(sec(INSIDE.furniture, 0xa9d4ee), 0.08, 1.62, 0.08, 0.67, 0.55, 0.56); });
      against(0.45, 0.66, 0x4c4f4f, (box) => { box(white, 0.02, 0.43, 0.2, 0.66, 0, 0.42); box(white, 0, 0.45, 0, 0.2, 0, 0.85); });
      against(0.55, 0.42, 0x42534e, (box) => { box(white, 0.18, 0.37, 0.1, 0.3, 0, 0.78); box(white, 0, 0.55, 0, 0.42, 0.78, 0.9); });
    } else if (r.kind === "H") {
      against(0.9, 0.36, 0x42454e43, (box) => box(wood, 0, 0.9, 0, 0.36, 0, 0.45));
      against(0.3, 0.3, 0x434f4154, (box) => { box(wood, 0.11, 0.19, 0.11, 0.19, 0, 1.7); box(cloth, 0, 0.3, 0, 0.3, 1.15, 1.6); });
      plant(0x504c4e32);
    } else if (r.kind === "D") {
      tableAndChairs(Math.min(1.7, r.a1 - r.a0 - 1.6), 0.9);
      against(1.4, 0.45, 0x53494442, (box) => box(wood, 0, 1.4, 0, 0.45, 0, 0.9));
      plant(0x504c4e33);
    } else if (r.kind === "S") {
      against(1.3, 0.62, 0x4445534b, (box) => {
        box(wood, 0, 1.3, 0, 0.62, 0.7, 0.76);
        box(wood, 0.04, 0.12, 0.04, 0.58, 0, 0.7);
        box(wood, 1.18, 1.26, 0.04, 0.58, 0, 0.7);
        box(sec(INSIDE.furniture, 0x3a3d44), 0.4, 0.9, 0.08, 0.12, 0.76, 1.12); // a screen
        box(cloth, 0.44, 0.86, 0.72, 1.14, 0, 0.45); // and a chair pulled up to it
      });
      shelves(0x424b32);
      shelves(0x424b33);
      rug(1.3, 0.9, 0x525533);
    } else if (r.kind === "P") {
      rug(Math.min(2.0, r.a1 - r.a0 - 0.8), Math.min(1.5, r.b1 - r.b0 - 0.8), 0x504c4159);
      for (let k = 0; k < 6; k++) {
        const size = 0.22 + (hash32(home.seed, 0x544f59 + k) % 3) * 0.06;
        against(size, size, 0x544f5900 + k, (box) => box(sec(INSIDE.furniture, CLOTHS[(k * 3 + i) % CLOTHS.length]), 0, size, 0, size, 0, size));
      }
      middle(0.8, 0.6, (a0, b0) => { block(wood, a0, a0 + 0.8, b0, b0 + 0.6, 0.4, 0.46); block(wood, a0 + 0.3, a0 + 0.5, b0 + 0.2, b0 + 0.4, 0, 0.4); });
      shelves(0x424b34);
    } else {
      against(0.6, 0.6, 0x57415348, (box) => { box(white, 0, 0.6, 0, 0.6, 0, 0.85); box(sec(INSIDE.furniture, 0x3a3d44), 0.14, 0.46, 0.58, 0.61, 0.25, 0.6); });
      against(1.0, 0.4, 0x53484c46, (box) => { box(wood, 0, 1.0, 0, 0.4, 0.9, 0.94); box(wood, 0, 1.0, 0, 0.4, 1.4, 1.44); box(cloth, 0.1, 0.4, 0.05, 0.35, 0.94, 1.2); });
    }
  });

  // ---- prizes on show: each stands against a wall where there is room, the living room first.
  const PRIZES: Record<string, { w: number; d: number; make: (box: Box) => void }> = {
    chest: { w: 0.9, d: 0.55, make: (box) => {
      box(col(0x8a5a3a), 0, 0.9, 0, 0.55, 0, 0.42);
      box(col(0x5a3a24), 0, 0.9, 0, 0.55, 0.42, 0.58);
      for (const w0 of [0.12, 0.7]) box(col(GOLD), w0, w0 + 0.08, 0, 0.56, 0, 0.585);
      box(col(GOLD), 0.4, 0.5, 0.55, 0.58, 0.3, 0.44);
    } },
    cup: { w: 0.5, d: 0.5, make: (box) => {
      const gold = col(GOLD);
      box(col(0x6f4a30), 0.05, 0.45, 0.05, 0.45, 0, 0.85);
      box(gold, 0.17, 0.33, 0.17, 0.33, 0.85, 0.9);
      box(gold, 0.22, 0.28, 0.22, 0.28, 0.9, 1.02);
      box(gold, 0.13, 0.37, 0.13, 0.37, 1.02, 1.26);
      box(gold, 0.07, 0.13, 0.22, 0.28, 1.08, 1.2);
      box(gold, 0.37, 0.43, 0.22, 0.28, 1.08, 1.2);
    } },
    goldcup: { w: 0.6, d: 0.6, make: (box) => {
      const gold = col(0xf2c94c);
      box(col(BLACK), 0.05, 0.55, 0.05, 0.55, 0, 0.8);
      box(gold, 0.2, 0.4, 0.2, 0.4, 0.8, 0.86);
      box(gold, 0.26, 0.34, 0.26, 0.34, 0.86, 1.02);
      box(gold, 0.14, 0.46, 0.14, 0.46, 1.02, 1.36);
      box(gold, 0.11, 0.49, 0.11, 0.49, 1.36, 1.4);
      box(gold, 0.05, 0.14, 0.26, 0.34, 1.1, 1.3);
      box(gold, 0.46, 0.55, 0.26, 0.34, 1.1, 1.3);
    } },
    globe: { w: 0.55, d: 0.55, make: (box) => {
      const sea = col(0x3f6fb0), land = col(0x3f9a45), stand = col(0x6f4a30);
      box(stand, 0.12, 0.43, 0.12, 0.43, 0, 0.08);
      box(stand, 0.25, 0.3, 0.25, 0.3, 0.08, 0.75);
      box(sea, 0.14, 0.41, 0.14, 0.41, 0.75, 0.83);
      box(sea, 0.07, 0.48, 0.07, 0.48, 0.83, 1.12);
      box(sea, 0.14, 0.41, 0.14, 0.41, 1.12, 1.2);
      box(land, 0.2, 0.4, 0.47, 0.495, 0.88, 1.05);
      box(land, 0.47, 0.495, 0.15, 0.35, 0.9, 1.08);
      box(land, 0.055, 0.08, 0.2, 0.38, 0.86, 1.0);
      box(land, 0.2, 0.35, 0.2, 0.35, 1.2, 1.21);
    } },
    clock: { w: 0.6, d: 0.4, make: (box) => {
      const timber = col(0x6f4a30), gold = col(GOLD);
      box(timber, 0.06, 0.54, 0, 0.36, 0, 1.55);
      box(timber, 0, 0.6, 0, 0.4, 1.55, 2.05);
      box(col(0xf2e9c8), 0.14, 0.46, 0.4, 0.41, 1.65, 1.97);
      box(col(BLACK), 0.285, 0.315, 0.41, 0.415, 1.8, 1.93);
      box(col(BLACK), 0.3, 0.4, 0.41, 0.415, 1.79, 1.82);
      box(col(BLACK), 0.2, 0.4, 0.36, 0.37, 0.5, 1.4);
      box(gold, 0.27, 0.33, 0.37, 0.38, 0.7, 1.3);
      box(gold, 0.23, 0.37, 0.37, 0.385, 0.56, 0.7);
    } },
    thanks: { w: 0.6, d: 0.6, make: (box) => {
      const leaf = col(LEAF), red = col(RED);
      box(col(GOLD), 0.15, 0.45, 0.15, 0.45, 0, 0.4);
      box(col(0x8a5a3a), 0.27, 0.33, 0.27, 0.33, 0.4, 1.0);
      box(leaf, 0.05, 0.55, 0.05, 0.55, 1.0, 1.35);
      box(leaf, 0.12, 0.48, 0.12, 0.48, 1.35, 1.65);
      box(leaf, 0.2, 0.4, 0.2, 0.4, 1.65, 1.85);
      box(red, 0.1, 0.18, 0.55, 0.57, 1.1, 1.18);
      box(red, 0.4, 0.48, 0.55, 0.57, 1.2, 1.28);
      box(red, 0.55, 0.57, 0.2, 0.28, 1.15, 1.23);
      box(red, 0.03, 0.05, 0.3, 0.38, 1.08, 1.16);
    } },
    games: { w: 1.0, d: 0.7, make: (box) => {
      const leg = col(0x8a5a3a);
      for (const [w0, d0] of [[0.05, 0.05], [0.87, 0.05], [0.05, 0.57], [0.87, 0.57]]) box(leg, w0, w0 + 0.08, d0, d0 + 0.08, 0, 0.7);
      box(col(0x3f7f4f), 0, 1.0, 0, 0.7, 0.7, 0.76);
      box(col(0xf2e9c8), 0.3, 0.7, 0.15, 0.55, 0.76, 0.775);
      box(col(RED), 0.35, 0.41, 0.2, 0.26, 0.775, 0.85);
      box(col(BLACK), 0.55, 0.61, 0.4, 0.46, 0.775, 0.85);
      box(col(0x3f6fb0), 0.45, 0.51, 0.3, 0.36, 0.775, 0.85);
      box(col(0xf2cc74), 0.8, 0.88, 0.1, 0.18, 0.76, 0.84);
    } },
    map: { w: 1.2, d: 0.8, make: (box) => {
      const leg = col(0x8a5a3a), land = col(0x7fb069);
      for (const [w0, d0] of [[0.05, 0.05], [1.07, 0.05], [0.05, 0.67], [1.07, 0.67]]) box(leg, w0, w0 + 0.08, d0, d0 + 0.08, 0, 0.7);
      box(leg, 0, 1.2, 0, 0.8, 0.7, 0.76);
      box(col(0xe8dcc8), 0.08, 1.12, 0.08, 0.72, 0.76, 0.77);
      box(land, 0.2, 0.5, 0.2, 0.45, 0.77, 0.775);
      box(land, 0.65, 1.0, 0.3, 0.6, 0.77, 0.775);
      box(land, 0.3, 0.45, 0.5, 0.65, 0.77, 0.775);
      box(col(RED), 0.3, 0.33, 0.3, 0.33, 0.775, 0.86);
      box(col(0x3f6fb0), 0.8, 0.83, 0.42, 0.45, 0.775, 0.86);
      box(col(GOLD), 0.95, 1.05, 0.1, 0.2, 0.77, 0.79);
    } },
    owl: { w: 0.5, d: 0.5, make: (box) => {
      const grey = col(STEEL), gold = col(GOLD);
      box(col(0x8d949a), 0.08, 0.42, 0.08, 0.42, 0, 0.7);
      box(grey, 0.14, 0.36, 0.16, 0.36, 0.7, 1.05);
      box(grey, 0.12, 0.38, 0.14, 0.38, 1.05, 1.3);
      box(grey, 0.12, 0.18, 0.2, 0.3, 1.3, 1.38);
      box(grey, 0.32, 0.38, 0.2, 0.3, 1.3, 1.38);
      box(gold, 0.17, 0.24, 0.38, 0.39, 1.14, 1.22);
      box(gold, 0.26, 0.33, 0.38, 0.39, 1.14, 1.22);
      box(gold, 0.235, 0.265, 0.38, 0.4, 1.08, 1.14);
    } },
    friends: { w: 1.6, d: 0.1, make: (box) => {
      box(col(WHITE), 0, 1.6, 0, 0.05, 1.0, 1.9);
      for (let k = 0; k < 10; k++) {
        const w0 = 0.1 + (k % 5) * 0.3, z0 = 1.08 + Math.floor(k / 5) * 0.42;
        box(col(CLOTHS[(k * 3 + 1) % CLOTHS.length]), w0, w0 + 0.2, 0.05, 0.06, z0, z0 + 0.3);
      }
    } },
    rocking: { w: 1.2, d: 0.45, make: (box) => {
      const pale = col(0xd9b98a), runner = col(0x8a5a3a);
      box(runner, 0, 1.2, 0.05, 0.12, 0, 0.08);
      box(runner, 0, 1.2, 0.33, 0.4, 0, 0.08);
      box(pale, 0.25, 0.33, 0.1, 0.35, 0.08, 0.5);
      box(pale, 0.87, 0.95, 0.1, 0.35, 0.08, 0.5);
      box(pale, 0.2, 1.0, 0.1, 0.35, 0.5, 0.8);
      box(pale, 0.85, 1.0, 0.14, 0.31, 0.8, 1.1);
      box(pale, 0.9, 1.2, 0.14, 0.31, 1.05, 1.25);
      box(col(RED), 0.45, 0.75, 0.08, 0.37, 0.8, 0.86);
      box(col(0x5a3a24), 0.14, 0.2, 0.18, 0.27, 0.5, 0.85);
    } },
    fishtank: { w: 1.0, d: 0.42, make: (box) => {
      box(col(0x8a5a3a), 0, 1.0, 0, 0.42, 0, 0.7);
      box(col(0x7fc4e8), 0.03, 0.97, 0.03, 0.39, 0.7, 1.25);
      box(col(BLACK), 0, 1.0, 0, 0.42, 1.25, 1.3);
      box(col(0xe8dcc8), 0.03, 0.97, 0.39, 0.395, 0.7, 0.78);
      box(col(0xe8935a), 0.2, 0.34, 0.39, 0.4, 0.95, 1.03);
      box(col(0xe8935a), 0.6, 0.72, 0.39, 0.4, 1.05, 1.12);
      box(col(0xf2cc74), 0.42, 0.5, 0.39, 0.4, 0.85, 0.9);
      box(col(LEAF), 0.8, 0.84, 0.39, 0.4, 0.78, 1.1);
      box(col(LEAF), 0.12, 0.15, 0.39, 0.4, 0.78, 0.98);
    } },
    piano: { w: 1.5, d: 0.62, make: (box) => {
      const black = col(BLACK);
      box(black, 0, 1.5, 0, 0.34, 0, 1.25);
      box(black, 0, 1.5, 0.34, 0.6, 0.62, 0.72);
      box(col(WHITE), 0.05, 1.45, 0.36, 0.6, 0.72, 0.74);
      for (let k = 0; k < 10; k++) box(black, 0.12 + k * 0.135, 0.18 + k * 0.135, 0.36, 0.5, 0.74, 0.76);
      box(black, 0.03, 0.11, 0.5, 0.6, 0, 0.62);
      box(black, 1.39, 1.47, 0.5, 0.6, 0, 0.62);
      box(col(0xf2e9c8), 0.5, 1.0, 0.34, 0.35, 0.85, 1.15);
    } },
    telescope: { w: 0.6, d: 0.62, make: (box) => {
      const leg = col(0x8a5a3a), tube = col(0xb98c5a);
      box(leg, 0.05, 0.11, 0.05, 0.11, 0, 0.9);
      box(leg, 0.49, 0.55, 0.05, 0.11, 0, 0.9);
      box(leg, 0.27, 0.33, 0.49, 0.55, 0, 0.9);
      box(leg, 0.2, 0.4, 0.2, 0.4, 0.9, 1.0);
      box(tube, 0.24, 0.36, 0.05, 0.3, 1.0, 1.12);
      box(tube, 0.24, 0.36, 0.25, 0.5, 1.1, 1.22);
      box(col(GOLD), 0.22, 0.38, 0.45, 0.62, 1.2, 1.36);
    } },
  };
  for (const [n, id] of (decor?.prizes ?? []).entries()) {
    const prize = PRIZES[id];
    if (!prize) continue;
    const order = [...standers].sort((p, q) => PRIZE_ROOMS.indexOf(p.kind) - PRIZE_ROOMS.indexOf(q.kind));
    for (const room of order) {
      if (room.kind === "T") continue;
      if (room.against(prize.w, prize.d, 0x5052495a + n * 17, prize.make)) break;
    }
  }

  return { sections: [...sections.values()].filter((s) => s.idx.length > 0).sort((p, q) => p.mat.id - q.mat.id || p.mat.color - q.mat.color), metersPerTile: S };
}

/** The home `id` of a chunk, with where its front door is on Earth and the heading that leads out of it; null when there is none to walk into. */
export async function findHome(cx: number, cy: number, id: number, elev: Elevation, load: (dx: number, dy: number) => Promise<Features> = loadFeatures): Promise<{ home: HomeDoor; lat: number; lon: number; yaw: number } | null> {
  const features = await featuresForChunk(cx, cy, load, elev);
  await elev.ensure(cx - 0.5, cy - 0.5, cx + 1.5, cy + 1.5);
  const home = homesOf(cx, cy, features, elev).find((h) => h.id === id);
  if (!home) return null;
  const S = metersPerTile(cy + 0.5, CHUNK_Z);
  return {
    home, lat: +yToLat(cy - home.y / S).toFixed(7), lon: +xToLon(cx + home.x / S).toFixed(7),
    yaw: Math.round((((Math.atan2(home.out[0], home.out[1]) * 180) / Math.PI + 360) % 360) * 10) / 10,
  };
}

/** The inside of a home somebody lives in, furnished their way, in the chunk format. Nothing is read from the map. */
export function furnishedInterior(cx: number, cy: number, home: HomeDoor, decor: Decor): Buffer {
  return encodeChunk(cx, cy, buildInterior(home, metersPerTile(cy + 0.5, CHUNK_Z), decor));
}

/** The inside of home `id` of a chunk, in the chunk format; null when that chunk has no such home to walk into. */
export async function generateInterior(cx: number, cy: number, id: number, elev: Elevation, load: (dx: number, dy: number) => Promise<Features> = loadFeatures): Promise<Buffer | null> {
  const features = await featuresForChunk(cx, cy, load, elev);
  await elev.ensure(cx - 0.5, cy - 0.5, cx + 1.5, cy + 1.5);
  const home = homesOf(cx, cy, features, elev).find((h) => h.id === id);
  if (!home) return null;
  return encodeChunk(cx, cy, buildInterior(home, metersPerTile(cy + 0.5, CHUNK_Z)));
}
