// A floor plan of one's own. A house that is lived in (home.ts) can be given the plan of a real house: up
// to two floors of rooms, each a rectangle in metres, with doors between them, a staircase, and a front
// door. The inside of the house is then built from it at its true size (interior.ts), not from one of the
// thirty layouts.
//
// A plan arrives rough: read off a picture by an AI (planreader.ts), in the picture's own directions.
// `normalisePlan` makes it one the house can be built from, or says it cannot: rooms are tidied and kept
// from overlapping, the plan is turned so that its front door is at the origin with the house behind it,
// every room is given a way in, and the staircase is made to fit. Nothing here trusts what it is given.
//
// The frame of a finished plan is the house's own (interior.ts): `a` runs along the front wall, to the left
// as one comes out of the front door; `b` runs back into the house. The front door is at (0, 0).

/** What a room is: L living, K kitchen, B bedroom, T bathroom, H hall, D dining, S study, P playroom, U utility. */
export type PlanKind = "L" | "K" | "B" | "T" | "H" | "D" | "S" | "P" | "U";
export const PLAN_KINDS: PlanKind[] = ["L", "K", "B", "T", "H", "D", "S", "P", "U"];
export const KIND_NAMES: Record<PlanKind, string> = { L: "Living room", K: "Kitchen", B: "Bedroom", T: "Bathroom", H: "Hall", D: "Dining room", S: "Study", P: "Playroom", U: "Utility room" };

export interface PlanRoom { name: string; kind: PlanKind; a0: number; a1: number; b0: number; b1: number }
/** One floor: its rooms, and the pairs of rooms with a doorway between them. */
export interface PlanFloor { rooms: PlanRoom[]; doors: [number, number][] }
/** The staircase: the floor it takes up on the ground floor (and the hole above it), and the way one climbs: along `a` or `b`, towards more (1) or less (-1). */
export interface PlanStairs { a0: number; a1: number; b0: number; b1: number; along: "a" | "b"; dir: 1 | -1 }
export interface HousePlan {
  floors: PlanFloor[];
  /** The ground-floor room the front door opens into. The door is at (0, 0), in that room's front wall. */
  entrance: number;
  stairs: PlanStairs | null;
}

/** A plan as it is read off a picture: metres, `x` to the right and `y` down the page. */
export interface RawPlan {
  floors?: { rooms?: { name?: unknown; kind?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown }[] }[];
  /** Doorways: the floor, and the two rooms by their place in that floor's list. */
  doors?: { floor?: unknown; a?: unknown; b?: unknown }[];
  /** The front door: where it is on the ground floor, and which side of the house it is on (the way out). */
  front?: { x?: unknown; y?: unknown; side?: unknown };
  /** The staircase on the ground floor, and the way one walks going up. */
  stairs?: { x?: unknown; y?: unknown; w?: unknown; h?: unknown; up?: unknown } | null;
}

export const FLOORS_MAX = 2;
export const ROOMS_MAX = 14;
const ROOM_MIN_M = 1.4;
const ROOM_MAX_M = 16;
/** No plan is wider or deeper than this. */
export const PLAN_MAX_M = 36;
/** Two rooms need this much wall in common for a doorway. */
const SHARED_MIN_M = 1.0;
/** A staircase: how wide, and how long on the floor (fourteen steps of 0.26 m, each 0.2 m up). */
export const STAIR_W_M = 1.0;
export const STAIR_RUN_M = 3.64;
export const STAIR_STEPS = 14;
/** Floor to floor. */
export const STOREY_M = 2.8;
/** A house built from a plan stands this far above the real one: beyond the fog as seen from the ground, with nothing of the world in its way. */
export const PLAN_LIFT_M = 3000;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const snap = (v: number): number => Math.round(v * 20) / 20;

/** What a room is, from what it is called, when nobody has said. */
export function kindFromName(name: string): PlanKind {
  const n = name.toLowerCase();
  if (/bath|toilet|\bwc\b|shower|ensuite|en-suite|powder|lav/.test(n)) return "T";
  if (/kitchen|scullery/.test(n)) return "K";
  if (/dining|meals/.test(n)) return "D";
  if (/bed|master|nursery|guest/.test(n)) return "B";
  if (/hall|entry|entrance|corridor|landing|foyer|passage|lobby|porch|stair/.test(n)) return "H";
  if (/study|office|library|den/.test(n)) return "S";
  if (/play|games|rumpus|kids|toy/.test(n)) return "P";
  if (/laundry|utility|garage|stor|pantry|wardrobe|closet|robe|linen|cupboard|plant|boiler/.test(n)) return "U";
  return "L";
}

const overlap = (p: PlanRoom, q: PlanRoom): [number, number] => [Math.min(p.a1, q.a1) - Math.max(p.a0, q.a0), Math.min(p.b1, q.b1) - Math.max(p.b0, q.b0)];

/** The wall two rooms have in common, if they have one: along which axis it runs, where it is, and from where to where. */
export function sharedWall(p: PlanRoom, q: PlanRoom): { along: "a" | "b"; at: number; lo: number; hi: number } | null {
  const touch = 0.3; // a plan read off a picture leaves small gaps between rooms: that is still one wall
  for (const [first, second] of [[p, q], [q, p]]) {
    if (Math.abs(first.a1 - second.a0) <= touch) {
      const lo = Math.max(first.b0, second.b0), hi = Math.min(first.b1, second.b1);
      if (hi - lo >= SHARED_MIN_M) return { along: "b", at: (first.a1 + second.a0) / 2, lo, hi };
    }
    if (Math.abs(first.b1 - second.b0) <= touch) {
      const lo = Math.max(first.a0, second.a0), hi = Math.min(first.a1, second.a1);
      if (hi - lo >= SHARED_MIN_M) return { along: "a", at: (first.b1 + second.b0) / 2, lo, hi };
    }
  }
  return null;
}

/** The rooms of one floor, tidied: sensible sizes, and none lying over another (a little overlap is trimmed away, a lot loses the later room). */
function tidy(rooms: PlanRoom[]): PlanRoom[] {
  const kept: PlanRoom[] = [];
  for (const raw of rooms) {
    const r = { ...raw };
    let ok = true;
    for (const k of kept) {
      const [oa, ob] = overlap(r, k);
      if (oa <= 0.02 || ob <= 0.02) continue;
      if (Math.min(oa, ob) > 0.6) { ok = false; break; }
      // Trim the newcomer back along the way it overlaps least.
      if (oa <= ob) { if (r.a0 < k.a0) r.a1 = k.a0; else r.a0 = k.a1; }
      else if (r.b0 < k.b0) r.b1 = k.b0; else r.b0 = k.b1;
    }
    if (ok && r.a1 - r.a0 >= ROOM_MIN_M && r.b1 - r.b0 >= ROOM_MIN_M) kept.push(r);
  }
  return kept;
}

/**
 * Doorways for a floor: those asked for, where the two rooms really share a wall, and then as many more as it
 * takes for every room to be reached from `from`. Rooms that cannot be reached at all (they touch nothing) go.
 */
function connect(rooms: PlanRoom[], wanted: [number, number][], from: number): PlanFloor {
  const doors: [number, number][] = [];
  const has = (i: number, j: number): boolean => doors.some(([p, q]) => (p === i && q === j) || (p === j && q === i));
  for (const [i, j] of wanted) if (i !== j && rooms[i] && rooms[j] && !has(i, j) && sharedWall(rooms[i], rooms[j])) doors.push([Math.min(i, j), Math.max(i, j)]);
  const reached = new Set<number>([from]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [i, j] of doors) {
      if (reached.has(i) !== reached.has(j)) { reached.add(i); reached.add(j); grew = true; }
    }
    if (grew) continue;
    // Nothing more by the doors there are: open one into the nearest room still shut off, by its longest shared wall.
    let best: { i: number; j: number; len: number } | null = null;
    for (const i of reached) {
      for (let j = 0; j < rooms.length; j++) {
        if (reached.has(j)) continue;
        const wall = sharedWall(rooms[i], rooms[j]);
        if (wall && (!best || wall.hi - wall.lo > best.len)) best = { i, j, len: wall.hi - wall.lo };
      }
    }
    if (best) { doors.push([Math.min(best.i, best.j), Math.max(best.i, best.j)]); grew = true; }
  }
  // Leave out what cannot be reached, and number the rest afresh.
  const order = [...reached].sort((p, q) => p - q);
  const place = new Map(order.map((old, now) => [old, now]));
  return {
    rooms: order.map((i) => rooms[i]),
    doors: doors.filter(([i, j]) => place.has(i) && place.has(j)).map(([i, j]) => [place.get(i)!, place.get(j)!] as [number, number]),
  };
}

const inside = (s: { a0: number; a1: number; b0: number; b1: number }, r: PlanRoom, margin = 0.05): boolean => s.a0 >= r.a0 + margin && s.a1 <= r.a1 - margin && s.b0 >= r.b0 + margin && s.b1 <= r.b1 - margin;

/** A staircase with the standing room it needs at its foot and at its head: the floor it takes up, and that much more at each end. */
export const STAIR_CLEAR_M = 0.9;
const withRoom = (s: PlanStairs): { a0: number; a1: number; b0: number; b1: number } =>
  (s.along === "a" ? { a0: s.a0 - STAIR_CLEAR_M, a1: s.a1 + STAIR_CLEAR_M, b0: s.b0, b1: s.b1 } : { a0: s.a0, a1: s.a1, b0: s.b0 - STAIR_CLEAR_M, b1: s.b1 + STAIR_CLEAR_M });

/** A staircase that fits: wholly in one ground-floor room and under one upper room, with room to step on and off, clear of the front door. Asked-for first, then anywhere it will go. */
function fitStairs(ground: PlanRoom[], upper: PlanRoom[], asked: PlanStairs | null): PlanStairs | null {
  const fits = (s: PlanStairs): boolean =>
    ground.some((r) => inside(withRoom(s), r, 0)) && upper.some((r) => inside(withRoom(s), r, 0)) && !(s.a0 < 0.9 && s.a1 > -0.9 && s.b0 < 1.6);
  if (asked && fits(asked)) return asked;
  const tries: PlanStairs[] = [];
  const add = (a0: number, b0: number, along: "a" | "b", dir: 1 | -1): void => {
    const [la, lb] = along === "a" ? [STAIR_RUN_M, STAIR_W_M] : [STAIR_W_M, STAIR_RUN_M];
    tries.push({ a0: snap(a0), a1: snap(a0) + la, b0: snap(b0), b1: snap(b0) + lb, along, dir });
  };
  if (asked) {
    // Near where it was asked for, either way round.
    const ca = (asked.a0 + asked.a1) / 2, cb = (asked.b0 + asked.b1) / 2;
    for (const along of ["b", "a"] as const) for (const dir of [1, -1] as const) {
      const [la, lb] = along === "a" ? [STAIR_RUN_M, STAIR_W_M] : [STAIR_W_M, STAIR_RUN_M];
      add(ca - la / 2, cb - lb / 2, along, dir);
    }
  }
  // Against a wall of a hall, then of any room that is not a bathroom: the biggest rooms first.
  const rank = (r: PlanRoom): number => (r.kind === "H" ? 0 : r.kind === "T" ? 9 : 1);
  for (const r of [...ground].sort((p, q) => rank(p) - rank(q) || (q.a1 - q.a0) * (q.b1 - q.b0) - (p.a1 - p.a0) * (p.b1 - p.b0))) {
    if (r.kind === "T") continue;
    const c = STAIR_CLEAR_M; // along a wall, with the standing room at each end inside the room
    add(r.a0 + 0.1, r.b1 - c - STAIR_RUN_M, "b", -1);
    add(r.a1 - 0.1 - STAIR_W_M, r.b1 - c - STAIR_RUN_M, "b", -1);
    add(r.a0 + 0.1, r.b0 + c, "b", 1);
    add(r.a1 - 0.1 - STAIR_W_M, r.b0 + c, "b", 1);
    add(r.a0 + c, r.b1 - 0.1 - STAIR_W_M, "a", 1);
    add(r.a1 - c - STAIR_RUN_M, r.b1 - 0.1 - STAIR_W_M, "a", -1);
    add(r.a0 + c, r.b0 + 0.1, "a", 1);
    add(r.a1 - c - STAIR_RUN_M, r.b0 + 0.1, "a", -1);
  }
  return tries.find(fits) ?? null;
}

/** The room of a floor that a point lies in, or -1. */
export const roomAt = (rooms: PlanRoom[], a: number, b: number): number => rooms.findIndex((r) => a >= r.a0 && a <= r.a1 && b >= r.b0 && b <= r.b1);

/** Where one steps off the top of a staircase, on the upper floor. */
export function stairTop(s: PlanStairs): { a: number; b: number } {
  const over = 0.5;
  return s.along === "a" ? { a: s.dir > 0 ? s.a1 + over : s.a0 - over, b: (s.b0 + s.b1) / 2 } : { a: (s.a0 + s.a1) / 2, b: s.dir > 0 ? s.b1 + over : s.b0 - over };
}

/**
 * A plan a house can be built from, out of whatever was read off a picture; null when there is no ground
 * floor to speak of. `notes` says, in words for the person whose plan it is, what had to be changed.
 */
export function normalisePlan(raw: unknown): { plan: HousePlan; notes: string[] } | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as RawPlan;
  const notes: string[] = [];
  const side = ["top", "bottom", "left", "right"].includes(r.front?.side as string) ? (r.front!.side as "top" | "bottom" | "left" | "right") : "bottom";
  const fx = num(r.front?.x), fy = num(r.front?.y);

  // ---- the rooms, in the picture's own directions, then turned so that the way out of the front door is towards less `b`
  const turn = (x: number, y: number): [number, number] => (side === "bottom" ? [x, -y] : side === "top" ? [-x, y] : side === "left" ? [y, x] : [-y, -x]);
  const floors: PlanRoom[][] = [];
  for (const f of (Array.isArray(r.floors) ? r.floors : []).slice(0, FLOORS_MAX)) {
    const rooms: PlanRoom[] = [];
    for (const room of (Array.isArray(f?.rooms) ? f.rooms : []).slice(0, ROOMS_MAX * 2)) {
      const x = num(room?.x), y = num(room?.y), w = num(room?.w), h = num(room?.h);
      if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) continue;
      const [p0, q0] = turn(x, y), [p1, q1] = turn(x + Math.min(w, ROOM_MAX_M), y + Math.min(h, ROOM_MAX_M));
      const name = (typeof room.name === "string" ? room.name : "").replace(/[^\p{L}\p{N} '&./-]/gu, "").trim().slice(0, 24);
      const kind = PLAN_KINDS.includes(room.kind as PlanKind) ? (room.kind as PlanKind) : kindFromName(name);
      rooms.push({ name: name || KIND_NAMES[kind], kind, a0: snap(Math.min(p0, p1)), a1: snap(Math.max(p0, p1)), b0: snap(Math.min(q0, q1)), b1: snap(Math.max(q0, q1)) });
    }
    floors.push(rooms);
  }
  if (!floors.length || !floors[0].length) return null;

  // ---- the front door at the origin: in the front wall of the ground-floor room it opens into
  let ground = tidy(floors[0]).slice(0, ROOMS_MAX);
  if (!ground.length) return null;
  const [da, db] = fx !== null && fy !== null ? turn(fx, fy) : [NaN, NaN];
  // The room the door is in is the one whose front wall is nearest it; with no door given, the front-most room.
  const frontOf = (room: PlanRoom): number => (Number.isFinite(da) ? Math.abs(room.b0 - db) + Math.max(0, room.a0 - da, da - room.a1) : room.b0);
  const first = ground.reduce((best, room) => (frontOf(room) < frontOf(best) ? room : best), ground[0]);
  if (!Number.isFinite(da) || frontOf(first) > 1.5) notes.push("The front door was not clear on the plan, so it has been put in the front of the " + first.name.toLowerCase() + ".");
  const doorA = Number.isFinite(da) ? Math.min(first.a1 - 0.7, Math.max(first.a0 + 0.7, da)) : (first.a0 + first.a1) / 2;
  const shift = (room: PlanRoom): PlanRoom => ({ ...room, a0: snap(room.a0 - doorA), a1: snap(room.a1 - doorA), b0: snap(room.b0 - first.b0), b1: snap(room.b1 - first.b0) });
  const originB = first.b0;
  ground = ground.map(shift);
  let entrance = ground.findIndex((room) => room.b0 === 0 && room.a0 <= -0.65 && room.a1 >= 0.65);
  if (entrance < 0) entrance = ground.findIndex((room) => room.b0 === 0 && room.a0 <= 0 && room.a1 >= 0);
  if (entrance < 0) return null;
  const tooBig = (rooms: PlanRoom[]): boolean => Math.max(...rooms.map((x) => x.a1)) - Math.min(...rooms.map((x) => x.a0)) > PLAN_MAX_M || Math.max(...rooms.map((x) => x.b1)) - Math.min(...rooms.map((x) => x.b0)) > PLAN_MAX_M;
  if (tooBig(ground)) return null;

  // ---- doorways on the ground floor (the picture's numbering is of the rooms as they were read, so doors are matched by where rooms are)
  const asked = (floor: number, before: PlanRoom[], after: PlanRoom[]): [number, number][] => {
    const out: [number, number][] = [];
    for (const d of Array.isArray(r.doors) ? r.doors : []) {
      const f = num(d?.floor) ?? 0, i = num(d?.a), j = num(d?.b);
      if (f !== floor || i === null || j === null || !before[i] || !before[j]) continue;
      const find = (room: PlanRoom): number => after.findIndex((x) => x.name === room.name && Math.abs((x.a0 + x.a1) / 2 - (room.a0 + room.a1) / 2 + doorA) < 0.8 && Math.abs((x.b0 + x.b1) / 2 - (room.b0 + room.b1) / 2 + originB) < 0.8);
      const p = find(before[i]), q = find(before[j]);
      if (p >= 0 && q >= 0) out.push([p, q]);
    }
    return out;
  };
  const entranceRoom = ground[entrance];
  const groundFloor = connect(ground, asked(0, floors[0], ground), entrance);
  if (groundFloor.rooms.length < ground.length) notes.push(`${ground.length - groundFloor.rooms.length === 1 ? "One room" : "Some rooms"} on the ground floor did not join on to the rest and ${ground.length - groundFloor.rooms.length === 1 ? "has" : "have"} been left out.`);
  const plan: HousePlan = { floors: [groundFloor], entrance: groundFloor.rooms.indexOf(entranceRoom), stairs: null };

  // ---- upstairs, if there is one and a staircase can be made to fit
  if (floors.length > 1 && floors[1].length) {
    const upper = tidy(floors[1]).slice(0, ROOMS_MAX).map(shift);
    let want: PlanStairs | null = null;
    const sx = num(r.stairs?.x), sy = num(r.stairs?.y), sw = num(r.stairs?.w), sh = num(r.stairs?.h);
    if (sx !== null && sy !== null && sw !== null && sh !== null) {
      const [p0, q0] = turn(sx, sy), [p1, q1] = turn(sx + sw, sy + sh);
      const ca = (p0 + p1) / 2 - doorA, cb = (q0 + q1) / 2 - originB;
      const along: "a" | "b" = Math.abs(p1 - p0) >= Math.abs(q1 - q0) ? "a" : "b";
      // The way up, in the picture's directions, turned with the plan.
      const up = ["up", "down", "left", "right"].includes(r.stairs?.up as string) ? (r.stairs!.up as string) : "";
      const [ua, ub] = up === "up" ? turn(0, -1) : up === "down" ? turn(0, 1) : up === "left" ? turn(-1, 0) : up === "right" ? turn(1, 0) : [0, 0];
      const dir: 1 | -1 = (along === "a" ? ua : ub) < 0 ? -1 : 1;
      const [la, lb] = along === "a" ? [STAIR_RUN_M, STAIR_W_M] : [STAIR_W_M, STAIR_RUN_M];
      want = { a0: snap(ca - la / 2), a1: snap(ca - la / 2) + la, b0: snap(cb - lb / 2), b1: snap(cb - lb / 2) + lb, along, dir };
    }
    const stairs = upper.length && !tooBig([...groundFloor.rooms, ...upper]) ? fitStairs(groundFloor.rooms, upper, want) : null;
    if (!stairs) notes.push("There was nowhere for a staircase to fit both floors, so the upstairs has been left out.");
    else {
      const top = stairTop(stairs);
      let landing = roomAt(upper, top.a, top.b);
      if (landing < 0) landing = upper.findIndex((room) => inside(stairs, room));
      const upperFloor = connect(upper, asked(1, floors[1], upper), landing);
      if (upperFloor.rooms.length < upper.length) notes.push(`${upper.length - upperFloor.rooms.length === 1 ? "One room" : "Some rooms"} upstairs did not join on to the rest and ${upper.length - upperFloor.rooms.length === 1 ? "has" : "have"} been left out.`);
      plan.floors.push(upperFloor);
      plan.stairs = stairs;
      if (!want || want.a0 !== stairs.a0 || want.b0 !== stairs.b0 || want.along !== stairs.along) notes.push("The staircase has been put where there was room for it on both floors.");
    }
  }
  return { plan, notes };
}

/** A plan that was normalised before (kept with a house, or sent back by the game that was shown it), checked again: the same plan, or null. */
export function checkedPlan(v: unknown): HousePlan | null {
  const p = v as HousePlan | null;
  if (!p || typeof p !== "object" || !Array.isArray(p.floors) || p.floors.length < 1 || p.floors.length > FLOORS_MAX) return null;
  const okRoom = (r: PlanRoom): boolean => !!r && typeof r.name === "string" && r.name.length <= 24 && PLAN_KINDS.includes(r.kind)
    && [r.a0, r.a1, r.b0, r.b1].every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= PLAN_MAX_M)
    && r.a1 - r.a0 >= ROOM_MIN_M - 0.01 && r.b1 - r.b0 >= ROOM_MIN_M - 0.01 && r.a1 - r.a0 <= ROOM_MAX_M + 0.01 && r.b1 - r.b0 <= ROOM_MAX_M + 0.01;
  const floors: PlanFloor[] = [];
  for (const f of p.floors) {
    if (!f || !Array.isArray(f.rooms) || f.rooms.length < 1 || f.rooms.length > ROOMS_MAX || !f.rooms.every(okRoom)) return null;
    for (let i = 0; i < f.rooms.length; i++) for (let j = i + 1; j < f.rooms.length; j++) { const [oa, ob] = overlap(f.rooms[i], f.rooms[j]); if (oa > 0.05 && ob > 0.05) return null; }
    const doors = (Array.isArray(f.doors) ? f.doors : []).filter((d) => Array.isArray(d) && Number.isInteger(d[0]) && Number.isInteger(d[1]) && d[0] !== d[1] && f.rooms[d[0]] && f.rooms[d[1]] && sharedWall(f.rooms[d[0]], f.rooms[d[1]])).slice(0, 60).map((d) => [d[0], d[1]] as [number, number]);
    floors.push({ rooms: f.rooms.map((r) => ({ name: r.name.replace(/[^\p{L}\p{N} '&./-]/gu, "").trim() || KIND_NAMES[r.kind], kind: r.kind, a0: r.a0, a1: r.a1, b0: r.b0, b1: r.b1 })), doors });
  }
  const entrance = floors[0].rooms[p.entrance];
  if (!Number.isInteger(p.entrance) || !entrance || Math.abs(entrance.b0) > 0.01 || entrance.a0 > 0 || entrance.a1 < 0) return null;
  // Every room must be reachable, or somebody could be built a room with no way out.
  const reach = (f: PlanFloor, from: number): boolean => {
    const seen = new Set([from]);
    for (let grew = true; grew; ) { grew = false; for (const [i, j] of f.doors) if (seen.has(i) !== seen.has(j)) { seen.add(i); seen.add(j); grew = true; } }
    return seen.size === f.rooms.length;
  };
  if (!reach(floors[0], p.entrance)) return null;
  let stairs: PlanStairs | null = null;
  if (floors.length > 1) {
    const s = p.stairs;
    if (!s || ![s.a0, s.a1, s.b0, s.b1].every((n) => typeof n === "number" && Number.isFinite(n)) || (s.along !== "a" && s.along !== "b") || (s.dir !== 1 && s.dir !== -1)) return null;
    const [la, lb] = s.along === "a" ? [STAIR_RUN_M, STAIR_W_M] : [STAIR_W_M, STAIR_RUN_M];
    if (Math.abs(s.a1 - s.a0 - la) > 0.02 || Math.abs(s.b1 - s.b0 - lb) > 0.02) return null;
    if (!floors[0].rooms.some((r) => inside(withRoom(s as PlanStairs), r, 0)) || !floors[1].rooms.some((r) => inside(withRoom(s as PlanStairs), r, 0))) return null;
    stairs = { a0: s.a0, a1: s.a1, b0: s.b0, b1: s.b1, along: s.along, dir: s.dir };
    const top = stairTop(stairs);
    let landing = roomAt(floors[1].rooms, top.a, top.b);
    if (landing < 0) landing = floors[1].rooms.findIndex((r) => inside(stairs!, r));
    if (landing < 0 || !reach(floors[1], landing)) return null;
  }
  return { floors, entrance: p.entrance, stairs };
}

/** A plan in a line or two, for the person it belongs to: "Ground floor: living room 5.2 by 4.0 m, kitchen ...". */
export function describePlan(plan: HousePlan): string[] {
  return plan.floors.map((f, i) => `${plan.floors.length === 1 ? "Rooms" : i === 0 ? "Ground floor" : "Upstairs"}: ${f.rooms.map((r) => `${r.name} ${(r.a1 - r.a0).toFixed(1)} by ${(r.b1 - r.b0).toFixed(1)} m`).join(", ")}`);
}
