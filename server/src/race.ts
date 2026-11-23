// Races: the first of the games players play with each other. One player sets a race up where
// they stand; the course runs along real roads, with a gate every hundred metres or so; anyone in
// the room may join; the one who set it up says go. Runners go by any means they like (on foot,
// on a horse, in a car), each gate must be passed in turn, and the room is told how everyone is
// getting on. Nothing can be failed: a race that nobody finishes simply ends.
//
// This file makes the course and keeps the state of one race. Who is where is the room's affair
// (rooms.ts), which calls `passed` with each runner's position.

import type { Route } from "./route.ts";

export const GATE_EVERY_M = 120;
/** A course is this long, by road. */
const COURSE_MIN_M = 350;
const COURSE_MAX_M = 1600;
/** How near a gate counts as through it. Wide enough for a car at speed between two position reports. */
export const GATE_REACH_M = 22;
export const COUNTDOWN_MS = 5000;
/** A race nobody starts, and one nobody finishes, are cleared away after this long; results stay up this long. */
export const OPEN_FOR_MS = 10 * 60_000;
export const RUN_FOR_MS = 20 * 60_000;
export const RESULTS_FOR_MS = 60_000;

const metresBetween = (aLat: number, aLon: number, bLat: number, bLon: number): number =>
  Math.hypot((bLat - aLat) * 111_320, (bLon - aLon) * 111_320 * Math.cos((((aLat + bLat) / 2) * Math.PI) / 180));

/** Gates along a path: one at the start, one about every `every` metres, and one at the finish. */
export function gatesAlong(path: [number, number][], every = GATE_EVERY_M): [number, number][] {
  if (path.length < 2) return [];
  let total = 0;
  for (let i = 1; i < path.length; i++) total += metresBetween(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
  const count = Math.max(1, Math.round(total / every)); // gaps, so count + 1 gates
  const gap = total / count;
  const gates: [number, number][] = [[+path[0][0].toFixed(7), +path[0][1].toFixed(7)]];
  let walked = 0;
  let next = gap;
  for (let i = 1; i < path.length && gates.length < count; i++) {
    const [aLat, aLon] = path[i - 1], [bLat, bLon] = path[i];
    const leg = metresBetween(aLat, aLon, bLat, bLon);
    while (leg > 0 && next <= walked + leg && gates.length < count) {
      const u = (next - walked) / leg;
      gates.push([+(aLat + (bLat - aLat) * u).toFixed(7), +(aLon + (bLon - aLon) * u).toFixed(7)]);
      next += gap;
    }
    walked += leg;
  }
  const last = path[path.length - 1];
  gates.push([+last[0].toFixed(7), +last[1].toFixed(7)]);
  return gates;
}

export interface Course { gates: [number, number][]; metres: number; kind?: "agility"; reach?: number; obstacles?: Obstacle[] }

/**
 * An agility course: a ring of obstacles on open ground, for a player to run with their companion at their
 * heels. It is a race of another kind: its "gates" are the obstacles, close together, each passed by coming
 * within a few steps of it, in order.
 */
export type Obstacle = "start" | "jump" | "hoop" | "weave" | "tunnel" | "table" | "finish";
export const AGILITY_REACH_M = 3.2;
/** Where the obstacles stand, in metres ahead of and to the right of whoever sets the course up. */
const RING: [number, number][] = [[5, 0], [11, 3], [16, 9], [17, 16], [12, 21], [5, 20], [0, 15], [-1, 8], [3, 3]];
const BETWEEN: Obstacle[] = ["jump", "hoop", "weave", "jump", "tunnel", "table", "jump"];

/** The course set up by somebody standing at a place and facing `yawDeg` (a compass heading). `seed` chooses the order of the obstacles. */
export function agilityCourse(lat: number, lon: number, yawDeg: number, seed: number): Course {
  const yaw = (yawDeg * Math.PI) / 180;
  const gates: [number, number][] = RING.map(([ahead, right]) => {
    const north = Math.cos(yaw) * ahead - Math.sin(yaw) * right, east = Math.sin(yaw) * ahead + Math.cos(yaw) * right;
    return [+(lat + north / 111_320).toFixed(7), +(lon + east / (111_320 * Math.cos((lat * Math.PI) / 180))).toFixed(7)];
  });
  let metres = 0;
  for (let i = 1; i < RING.length; i++) metres += Math.hypot(RING[i][0] - RING[i - 1][0], RING[i][1] - RING[i - 1][1]);
  const turn = (seed >>> 0) % BETWEEN.length;
  const obstacles: Obstacle[] = ["start", ...BETWEEN.map((_, i) => BETWEEN[(i + turn) % BETWEEN.length]), "finish"];
  return { gates, metres: Math.round(metres), kind: "agility", reach: AGILITY_REACH_M, obstacles };
}

/**
 * A course for a race beginning near a position: a way by road to somewhere a few streets off. Eight
 * directions are tried, in an order of the race's own (`seed`), until one gives a course of a good
 * length or `patienceMs` runs out. Null where there are no roads to race along.
 */
export async function planCourse(lat: number, lon: number, seed: number, route: (aLat: number, aLon: number, bLat: number, bLon: number) => Promise<Route | null>, patienceMs = 9000): Promise<Course | null> {
  const gaveUp = Date.now() + patienceMs;
  let fallback: Route | null = null;
  for (let n = 0; n < 8; n++) {
    if (Date.now() > gaveUp) break;
    const k = ((seed >>> 0) + n * 3) % 8;
    const far = n < 4 ? 650 : 420; // if nothing a good way off will do, somewhere nearer may
    const to: [number, number] = [lat + (far / 111_320) * Math.cos((k * Math.PI) / 4), lon + (far / (111_320 * Math.cos((lat * Math.PI) / 180))) * Math.sin((k * Math.PI) / 4)];
    const way = await route(lat, lon, to[0], to[1]).catch(() => null);
    if (!way || way.path.length < 2) continue;
    if (way.metres >= COURSE_MIN_M && way.metres <= COURSE_MAX_M) return { gates: gatesAlong(way.path), metres: Math.round(way.metres) };
    if (way.metres >= 150 && way.metres <= COURSE_MAX_M && (!fallback || way.metres > fallback.metres)) fallback = way;
  }
  return fallback ? { gates: gatesAlong(fallback.path), metres: Math.round(fallback.metres) } : null;
}

export interface Runner { id: string; name: string; gate: number; time: number | null }
/** A race as the room keeps it and as everyone is told it. `startAt` is in the server's time (0 until somebody says go). */
export interface Race {
  by: string;
  byName: string;
  gates: [number, number][];
  metres: number;
  state: "open" | "go" | "over";
  startAt: number;
  made: number;
  ended: number;
  runners: Runner[];
  /** For an agility course: that it is one, how near an obstacle counts as passing it, and what each obstacle is. */
  kind?: "agility";
  reach?: number;
  obstacles?: Obstacle[];
}

export function newRace(by: string, byName: string, course: Course, now: number): Race {
  return {
    by, byName, gates: course.gates, metres: course.metres, state: "open", startAt: 0, made: now, ended: 0, runners: [{ id: by, name: byName, gate: 0, time: null }],
    ...(course.kind ? { kind: course.kind, reach: course.reach, obstacles: course.obstacles } : {}),
  };
}

/** Where a runner came in among those who have finished: 1 for the winner. 0 if they have not finished. */
export function placeOf(race: Race, id: string): number {
  const me = race.runners.find((r) => r.id === id);
  if (!me || me.time === null) return 0;
  return 1 + race.runners.filter((r) => r.time !== null && r.time < me.time!).length;
}

/**
 * A runner is at a position at time `now`. Returns "gate" when that takes them through their next gate,
 * "finish" when it was the last, and null when nothing changed. Gates count only in turn and only once
 * the race has begun, so everyone must come to the start line whatever they were doing before.
 */
export function passed(race: Race, id: string, lat: number, lon: number, now: number): "gate" | "finish" | null {
  if (race.state !== "go" || now < race.startAt) return null;
  const runner = race.runners.find((r) => r.id === id);
  if (!runner || runner.time !== null) return null;
  const gate = race.gates[runner.gate];
  if (!gate || metresBetween(gate[0], gate[1], lat, lon) > (race.reach ?? GATE_REACH_M)) return null;
  runner.gate++;
  if (runner.gate < race.gates.length) return "gate";
  runner.time = now - race.startAt;
  if (race.runners.every((r) => r.time !== null)) { race.state = "over"; race.ended = now; }
  return "finish";
}

/** Whether a race has run its time and should be cleared away. */
export function stale(race: Race, now: number): boolean {
  return race.state === "open" ? now - race.made > OPEN_FOR_MS : race.state === "go" ? now - race.startAt > RUN_FOR_MS : now - race.ended > RESULTS_FOR_MS;
}

export const ordinal = (n: number): string => (n === 1 ? "first" : n === 2 ? "second" : n === 3 ? "third" : `${n}th`);
export function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 100) / 10);
  return s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${s.toFixed(1)} s`;
}
