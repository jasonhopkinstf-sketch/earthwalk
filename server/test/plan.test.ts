import { test } from "node:test";
import assert from "node:assert/strict";
import { checkedPlan, describePlan, type HousePlan, kindFromName, normalisePlan, type PlanRoom, type RawPlan, roomAt, sharedWall, STAIR_RUN_M, STAIR_W_M, stairTop } from "../src/plan.ts";

/** A house of two floors as it might be read off a picture: metres, x to the right, y down the page, the front door at the bottom. */
const HOUSE: RawPlan = {
  floors: [
    { rooms: [
      { name: "Hall", x: 4, y: 4, w: 3, h: 6 },
      { name: "Living Room", x: 0, y: 4, w: 4, h: 6 },
      { name: "Kitchen", x: 7, y: 4, w: 4, h: 6 },
      { name: "Dining", x: 0, y: 0, w: 5.5, h: 4 },
      { name: "Family room", x: 5.5, y: 0, w: 5.5, h: 4 },
    ] },
    { rooms: [
      { name: "Landing", x: 4, y: 4, w: 3, h: 6 },
      { name: "Bedroom 1", x: 0, y: 4, w: 4, h: 6 },
      { name: "Bedroom 2", x: 7, y: 4, w: 4, h: 6 },
      { name: "Bathroom", x: 0, y: 0, w: 5.5, h: 4 },
      { name: "Bedroom 3", x: 5.5, y: 0, w: 5.5, h: 4 },
    ] },
  ],
  doors: [{ floor: 0, a: 0, b: 1 }, { floor: 0, a: 0, b: 2 }, { floor: 0, a: 1, b: 2 }],
  front: { x: 4.8, y: 10, side: "bottom" },
  stairs: { x: 5.9, y: 4.95, w: 1, h: 3.64, up: "up" },
};
const size = (r: PlanRoom): string => `${r.name} ${(r.a1 - r.a0).toFixed(1)}x${(r.b1 - r.b0).toFixed(1)}`;
const reachable = (plan: HousePlan, floor: number, from: number): number => {
  const seen = new Set([from]);
  for (let grew = true; grew; ) { grew = false; for (const [i, j] of plan.floors[floor].doors) if (seen.has(i) !== seen.has(j)) { seen.add(i); seen.add(j); grew = true; } }
  return seen.size;
};

test("what a room is, from what it is called", () => {
  assert.deepEqual(["Master Bedroom", "WC", "Kitchen / Dining", "Lounge", "Entry", "Home office", "Rumpus", "Laundry", "Ensuite", "Garage", "Something"].map(kindFromName),
    ["B", "T", "K", "L", "H", "S", "P", "U", "T", "U", "L"]);
});

test("a plan read off a picture becomes one a house can be built from", () => {
  const got = normalisePlan(HOUSE)!;
  const { plan, notes } = got;
  assert.deepEqual([plan.floors.length, plan.floors[0].rooms.length, plan.floors[1].rooms.length], [2, 5, 5]);
  // The front door is at the origin, in the front wall of the hall, and the house lies behind it.
  const hall = plan.floors[0].rooms[plan.entrance];
  assert.deepEqual([hall.name, hall.kind, hall.b0, hall.a0 < 0 && hall.a1 > 0], ["Hall", "H", 0, true]);
  assert.ok(plan.floors.every((f) => f.rooms.every((r) => r.b0 >= 0 && r.b1 <= 10.01)), "nothing in front of the front door");
  assert.deepEqual(plan.floors[0].rooms.map(size).sort(), ["Dining 5.5x4.0", "Family room 5.5x4.0", "Hall 3.0x6.0", "Kitchen 4.0x6.0", "Living Room 4.0x6.0"]);
  assert.deepEqual(plan.floors[0].rooms.map((r) => r.kind).sort(), ["D", "H", "K", "L", "L"]);
  // Doors: only between rooms with a wall in common (the living room and the kitchen have none), and every room has a way in.
  for (const f of plan.floors) for (const [i, j] of f.doors) assert.ok(sharedWall(f.rooms[i], f.rooms[j]), `${f.rooms[i].name} and ${f.rooms[j].name} share a wall`);
  const names = (f: number): string[] => plan.floors[f].doors.map(([i, j]) => [plan.floors[f].rooms[i].name, plan.floors[f].rooms[j].name].sort().join("+")).sort();
  assert.ok(names(0).includes("Hall+Living Room") && names(0).includes("Hall+Kitchen") && !names(0).includes("Kitchen+Living Room"));
  assert.equal(reachable(plan, 0, plan.entrance), 5);
  // The staircase is where it was drawn: in the hall, under the landing, clear of the front door, climbing into the house.
  const s = plan.stairs!;
  assert.deepEqual([s.along, s.dir, +(s.a1 - s.a0).toFixed(2), +(s.b1 - s.b0).toFixed(2)], ["b", 1, STAIR_W_M, STAIR_RUN_M]);
  assert.ok(s.a0 >= hall.a0 && s.a1 <= hall.a1 && s.b0 >= 1 && s.b1 <= hall.b1, JSON.stringify(s));
  const top = stairTop(s);
  const landing = roomAt(plan.floors[1].rooms, top.a, top.b);
  assert.equal(plan.floors[1].rooms[landing].name, "Landing");
  assert.equal(reachable(plan, 1, landing), 5, "every room upstairs can be reached from the top of the stairs");
  assert.deepEqual(notes, []);
  assert.deepEqual(describePlan(plan)[0].slice(0, 30), "Ground floor: Hall 3.0 by 6.0 ");
  // Checked again (as when it comes back from the game that was shown it) it is the same plan.
  assert.deepEqual(checkedPlan(JSON.parse(JSON.stringify(plan))), plan);
});

test("whichever side of the page the front door is on, the house comes out the same", () => {
  const base = normalisePlan(HOUSE)!.plan;
  const turned = (side: "top" | "left" | "right"): RawPlan => {
    // The same house drawn the other way up, or on its side: every point of the page is turned about the page.
    const point = (x: number, y: number): [number, number] => (side === "top" ? [11 - x, 10 - y] : side === "left" ? [10 - y, x] : [y, 11 - x]);
    const rect = (r: { x?: unknown; y?: unknown; w?: unknown; h?: unknown }): { x: number; y: number; w: number; h: number } => {
      const [x0, y0] = point(r.x as number, r.y as number), [x1, y1] = point((r.x as number) + (r.w as number), (r.y as number) + (r.h as number));
      return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    };
    const [fx, fy] = point(4.8, 10);
    const up = side === "top" ? "down" : side === "left" ? "right" : "left";
    return { ...HOUSE, floors: HOUSE.floors!.map((f) => ({ rooms: f.rooms!.map((r) => ({ name: r.name, ...rect(r) })) })), front: { x: fx, y: fy, side }, stairs: { ...rect(HOUSE.stairs!), up } };
  };
  for (const side of ["top", "left", "right"] as const) {
    const plan = normalisePlan(turned(side))!.plan;
    assert.deepEqual(plan.floors.map((f) => f.rooms.map((r) => [r.name, r.a0, r.a1, r.b0, r.b1])), base.floors.map((f) => f.rooms.map((r) => [r.name, r.a0, r.a1, r.b0, r.b1])), `door on the ${side}`);
    assert.deepEqual([plan.stairs, plan.entrance], [base.stairs, base.entrance], `stairs with the door on the ${side}`);
  }
});

test("a rough plan is tidied, and what cannot be built is left out or refused", () => {
  // Rooms that overlap a little are trimmed, one that lies right over another goes, and one that touches nothing is left out.
  const rough = normalisePlan({
    floors: [{ rooms: [
      { name: "Lounge", x: 0, y: 0, w: 5.2, h: 4 }, { name: "Kitchen", x: 5, y: 0, w: 4, h: 4 }, { name: "Ghost", x: 1, y: 1, w: 3, h: 2 },
      { name: "Shed", x: 30, y: 30, w: 3, h: 3 }, { name: "Cupboard", x: 0, y: 4, w: 0.4, h: 0.4 }, { name: "Bad", x: "left", y: 0, w: 2, h: 2 },
    ] }],
    front: { x: 2, y: 4, side: "bottom" },
  })!;
  assert.deepEqual(rough.plan.floors[0].rooms.map(size), ["Lounge 5.2x4.0", "Kitchen 3.8x4.0"]);
  assert.deepEqual([rough.plan.floors[0].doors, rough.plan.stairs, rough.plan.entrance], [[[0, 1]], null, 0]);
  assert.ok(rough.notes.some((n) => /did not join on/.test(n)), rough.notes.join(" | "));
  // No front door given: it goes in the front-most room, and the plan says so.
  const noDoor = normalisePlan({ floors: [{ rooms: [{ name: "Studio", x: 0, y: 0, w: 6, h: 5 }] }] })!;
  assert.deepEqual([noDoor.plan.floors[0].rooms[0].a0, noDoor.plan.floors[0].rooms[0].a1, noDoor.plan.floors[0].rooms[0].b0], [-3, 3, 0]);
  assert.ok(noDoor.notes.some((n) => /front door was not clear/.test(n)));
  // An upstairs with nowhere for a staircase is left out, with a note; the ground floor stands.
  const cramped = normalisePlan({
    floors: [{ rooms: [{ name: "Bathroom", x: 0, y: 0, w: 2.5, h: 2.5 }, { name: "Hall", x: 2.5, y: 0, w: 1.6, h: 2.5 }] }, { rooms: [{ name: "Attic", x: 0, y: 0, w: 4, h: 2.5 }] }],
    front: { x: 3.3, y: 2.5, side: "bottom" },
  })!;
  assert.deepEqual([cramped.plan.floors.length, cramped.plan.stairs], [1, null]);
  assert.ok(cramped.notes.some((n) => /upstairs has been left out/.test(n)));
  // A staircase drawn where it cannot go is moved to where it can, and the plan says so.
  const moved = normalisePlan({ ...HOUSE, stairs: { x: 4.3, y: 6.2, w: 1, h: 3.6, up: "up" } })!;
  assert.ok(moved.plan.stairs && moved.notes.some((n) => /staircase has been put/.test(n)), moved.notes.join(" | "));
  // Nothing, nonsense, and a palace are refused.
  for (const bad of [null, "plan", {}, { floors: [] }, { floors: [{ rooms: [] }] }, { floors: [{ rooms: [{ name: "Dot", x: 0, y: 0, w: 0.5, h: 0.5 }] }] }]) assert.equal(normalisePlan(bad), null);
  assert.equal(normalisePlan({ floors: [{ rooms: Array.from({ length: 6 }, (_, i) => ({ name: `Hall ${i}`, x: i * 10, y: 0, w: 10, h: 5 })) }] }), null);
});

test("a plan that comes back is checked before it is built: no overlaps, no room without a way out, the door where it should be", () => {
  const plan = normalisePlan(HOUSE)!.plan;
  const copy = (): HousePlan => JSON.parse(JSON.stringify(plan));
  const broken: ((p: HousePlan) => void)[] = [
    (p) => { p.floors[0].rooms[1].a1 += 2; }, // into the hall
    (p) => { p.floors[0].doors = []; }, // rooms shut off
    (p) => { p.entrance = 3; }, // not the room with the door
    (p) => { p.floors[0].rooms[p.entrance].b0 = 0.5; },
    (p) => { p.stairs = null; }, // two floors and no way up
    (p) => { p.stairs!.a1 += 3; }, // not a staircase's size
    (p) => { p.stairs!.a0 -= 20; p.stairs!.a1 -= 20; }, // out in the garden
    (p) => { p.floors.push(p.floors[1]); }, // three floors
    (p) => { (p.floors[0].rooms[0] as { kind: string }).kind = "X"; },
    (p) => { p.floors[1].doors = []; },
    (p) => { p.floors[0].rooms[2].a1 = 400; },
  ];
  for (const [i, wreck] of broken.entries()) { const p = copy(); wreck(p); assert.equal(checkedPlan(p), null, `wreck ${i}`); }
  // Doors that are not between neighbours are simply dropped, if every room can still be reached.
  const extra = copy();
  extra.floors[0].doors.push([1, 2], [7, 9] as [number, number]);
  assert.deepEqual(checkedPlan(extra), plan);
  assert.equal(checkedPlan(null), null);
});

test("a house built from a plan: both floors at their true size, far above the real house, with a staircase that can be climbed", async () => {
  const { buildInterior, INSIDE } = await import("../src/interior.ts");
  const { PLAN_LIFT_M, STOREY_M, STAIR_STEPS } = await import("../src/plan.ts");
  const { painted } = await import("../src/chunk.ts");
  const plan = normalisePlan(HOUSE)!.plan;
  // A real house of 10 m by 7 m with its door 4 m along its front wall (as in the house tests).
  const home = { id: 77, corners: [[100, -50], [100, -57], [110, -57], [110, -50]] as [number, number][], x: 106, y: -50, along: [-1, 0] as [number, number], out: [0, 1] as [number, number], floor: 12.06, height: 5.85, seed: 5, wall: 0xf6e8c6, porch: false };
  const built = buildInterior(home, 380, { prizes: ["piano", "globe"] }, plan);
  const again = buildInterior(home, 380, { prizes: ["piano", "globe"] }, plan);
  assert.deepEqual(again.sections.map((s) => [s.mat.id, s.mat.color, s.count]), built.sections.map((s) => [s.mat.id, s.mat.color, s.count]), "the same every time");
  const low = home.floor + PLAN_LIFT_M;
  // In the house's own frame: `a` runs west from (110, -50), `b` south; the plan's door is at a = 4.
  const frame = (e: number, n: number): [number, number] => [110 - e, -50 - n];
  let ground = 0, upper = 0, furnitureUp = 0, furnitureDown = 0;
  const treads = new Set<number>();
  const s = plan.stairs!;
  for (const sec of built.sections) {
    assert.ok(sec.mat.id >= 40 && sec.mat.id <= 45);
    for (let i = 0; i < sec.pos.length; i += 3) {
      const [a, b] = frame(sec.pos[i], sec.pos[i + 1]);
      const z = sec.pos[i + 2] - low;
      assert.ok(z >= -1e-6 && z <= STOREY_M * 2 + 1e-6, `between the ground floor and the upstairs ceiling (${z.toFixed(2)})`);
      assert.ok(a >= 4 - 4.9 && a <= 4 + 6.3 && b >= -0.01 && b <= 10.01, `within the plan (${a.toFixed(2)}, ${b.toFixed(2)})`);
      if (sec.mat.id === INSIDE.furniture.id) { if (z > STOREY_M) furnitureUp++; else furnitureDown++; }
    }
    if (sec.mat.id !== INSIDE.floor.id) continue;
    for (let i = 0; i < sec.idx.length; i += 3) {
      const [p, q, r] = [sec.idx[i] * 3, sec.idx[i + 1] * 3, sec.idx[i + 2] * 3];
      const zs = [sec.pos[p + 2], sec.pos[q + 2], sec.pos[r + 2]].map((v) => v - low);
      if (Math.max(...zs) - Math.min(...zs) > 1e-6) continue; // a riser, not something to stand on
      const area = Math.abs((sec.pos[q] - sec.pos[p]) * (sec.pos[r + 1] - sec.pos[p + 1]) - (sec.pos[q + 1] - sec.pos[p + 1]) * (sec.pos[r] - sec.pos[p])) / 2;
      const z = zs[0];
      const [a, b] = frame((sec.pos[p] + sec.pos[q] + sec.pos[r]) / 3, (sec.pos[p + 1] + sec.pos[q + 1] + sec.pos[r + 1]) / 3);
      const onStairs = a > s.a0 + 4 && a < s.a1 + 4 && b > s.b0 && b < s.b1;
      if (Math.abs(z) < 1e-6) ground += area;
      else if (Math.abs(z - STOREY_M) < 1e-6 && !onStairs) upper += area;
      else if (onStairs) treads.add(Math.round(z * 100));
    }
  }
  const areaOf = (f: number): number => plan.floors[f].rooms.reduce((sum, r) => sum + (r.a1 - r.a0) * (r.b1 - r.b0), 0);
  const doorways = (f: number): number => plan.floors[f].doors.length * 0.9 * 0.02; // the strip of floor through each wall
  assert.ok(Math.abs(ground - areaOf(0)) < doorways(0) + 0.05, `the ground floor from wall to wall (${ground.toFixed(1)} of ${areaOf(0).toFixed(1)} m2)`);
  const well = (s.a1 - s.a0) * (s.b1 - s.b0);
  assert.ok(Math.abs(upper - (areaOf(1) - well)) < doorways(1) + 0.05, `upstairs, less the stairwell (${upper.toFixed(1)} of ${(areaOf(1) - well).toFixed(1)} m2)`);
  // Fourteen steps, each a fifth of a metre above the last, the top one level with the upstairs floor.
  assert.deepEqual([...treads].sort((x, y) => x - y), Array.from({ length: STAIR_STEPS }, (_, k) => Math.round(((k + 1) * STOREY_M * 100) / STAIR_STEPS)));
  assert.ok(furnitureDown > 200 && furnitureUp > 200, `furniture on both floors (${furnitureDown}, ${furnitureUp})`);
  // What is stood on and walked into is solid; the walls are in a paint.
  assert.ok(built.sections.filter((x) => x.mat.id === INSIDE.floor.id || x.mat.id === INSIDE.wall.id).every((x) => x.mat.collision));
  assert.ok(buildInterior(home, 380, { walls: "sky", floor: "check", prizes: [] }, plan).sections.some((x) => x.mat.id === INSIDE.wall.id && x.mat.color === painted(INSIDE.wall, 0xa9d3ee).color));
  // A plan of one floor has no stairs and nothing upstairs; and without a plan the house is as it always was.
  const flat = buildInterior(home, 380, null, normalisePlan({ floors: [HOUSE.floors![0]], front: HOUSE.front })!.plan);
  for (const sec of flat.sections) for (let i = 2; i < sec.pos.length; i += 3) assert.ok(sec.pos[i] - low <= 2.6 + 1e-6);
  const plain = buildInterior(home, 380, null);
  for (const sec of plain.sections) for (let i = 2; i < sec.pos.length; i += 3) assert.ok(sec.pos[i] < home.floor + 3, "an ordinary house stays where it is");
});

test("a plan is kept with a house, told to everybody, and served only to a game that asks for it", async () => {
  const { createServer } = await import("node:http");
  const { default: WebSocket } = await import("ws");
  const { createApp } = await import("../src/app.ts");
  const { Homes, viewOfLived } = await import("../src/home.ts");
  const { furnishedInterior } = await import("../src/interior.ts");
  const { GuestDirectory } = await import("../src/people.ts");
  const { Rooms } = await import("../src/rooms.ts");
  const { PLAN_LIFT_M } = await import("../src/plan.ts");
  const { GENERATOR_REV } = await import("../src/chunk.ts"); // (a house measured in another making of the world would be measured again, from the real map)
  type Msg = Record<string, any>;
  const plan = normalisePlan(HOUSE)!.plan;
  const home = { id: 77, corners: [[100, -50], [100, -57], [110, -57], [110, -50]] as [number, number][], x: 106, y: -50, along: [-1, 0] as [number, number], out: [0, 1] as [number, number], floor: 12.06, height: 5.85, seed: 5, wall: 0xf6e8c6, porch: false };

  // Kept with the house, and through a move; forgotten if it no longer passes when the houses are read back.
  const kept: unknown[][] = [];
  const store = { load: async () => (kept[kept.length - 1] ?? []) as never, save: async (all: unknown[]) => void kept.push(JSON.parse(JSON.stringify(all))) };
  const homes = new Homes(store, () => 0);
  homes.claim("sam", "Sam", true, { x: 1, y: 2, id: 77, lat: 52.01, lon: 4.71, yaw: 0, home, gen: GENERATOR_REV });
  assert.deepEqual([viewOfLived(homes.of("sam")!).lift, homes.setPlan("kim", plan)], [undefined, null]);
  const rev = homes.of("sam")!.rev;
  homes.setPlan("sam", plan);
  assert.deepEqual([viewOfLived(homes.of("sam")!).lift, viewOfLived(homes.of("sam")!).floors, homes.of("sam")!.rev > rev], [PLAN_LIFT_M, 2, true]);
  homes.claim("sam", "Sam", true, { x: 1, y: 2, id: 79, lat: 52.01, lon: 4.71, yaw: 0, home: { ...home, id: 79 }, gen: GENERATOR_REV });
  assert.deepEqual(homes.of("sam")!.plan, plan, "the plan moves house with its owner");
  await homes.settled();
  const again = new Homes(store);
  await again.open();
  assert.deepEqual(again.of("sam")!.plan, plan);
  (kept[kept.length - 1][0] as { plan: { entrance: number } }).plan.entrance = 4;
  const wrecked = new Homes(store);
  await wrecked.open();
  assert.equal(wrecked.of("sam")!.plan, undefined, "a plan that does not pass is forgotten");

  // Served: the planned house to a game that asks for it, the ordinary rooms to one that does not.
  const app = createApp({ homes, buildInterior: async () => Buffer.from("rooms"), readCache: async () => null, writeCache: async () => {} });
  await new Promise<void>((r) => app.server.listen(0, r));
  const base = `http://localhost:${(app.server.address() as { port: number }).port}`;
  const get = async (q: string): Promise<Buffer> => Buffer.from(await (await fetch(`${base}/v1/interior/16/1/2/79${q}`)).arrayBuffer());
  try {
    const lived = homes.of("sam")!;
    assert.ok((await get("?r=1&plan=1")).equals(furnishedInterior(1, 2, lived.home, lived.decor, plan)));
    assert.ok((await get("")).equals(furnishedInterior(1, 2, lived.home, lived.decor)), "a game that knows nothing of plans gets the house as it was built");
    assert.ok(!(await get("?plan=1")).equals(await get("")));
  } finally {
    app.close();
  }

  // Over the wire: a plan is checked before it is taken, and null goes back to the house's own rooms.
  const rooms = new Rooms(new GuestDirectory(""), { homes: new Homes(null, () => 0), findHome: async (_x, _y, id) => ({ home: { ...home, id }, lat: 52.01, lon: 4.71, yaw: 0 }) });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => rooms.wss.handleUpgrade(req, socket, head, (ws) => rooms.wss.emit("connection", ws, req)));
  await new Promise<void>((r) => server.listen(0, r));
  const ws = new WebSocket(`ws://localhost:${(server.address() as { port: number }).port}/v1/ws`);
  const inbox: Msg[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
  await new Promise<void>((r) => ws.on("open", () => r()));
  const send = (m: Msg): void => ws.send(JSON.stringify(m));
  const next = async (t: string, ok: (m: Msg) => boolean = () => true): Promise<Msg> => {
    for (let i = 0; i < 300; i++) {
      const at = inbox.findIndex((m) => m.t === t && ok(m));
      if (at >= 0) return inbox.splice(at, 1)[0];
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for "${t}"`);
  };
  try {
    send({ t: "hello", name: "Sam", room: "family", avatar: "fox" });
    await next("welcome");
    send({ t: "house", plan });
    assert.equal((await next("error")).code, "nohome");
    send({ t: "pos", lat: 52.01, lon: 4.71, alt: 0, yaw: 0 });
    await new Promise((r) => setTimeout(r, 2100));
    send({ t: "house", claim: { x: 1, y: 2, id: 77 } });
    await next("house");
    await next("lived");
    send({ t: "house", plan: { ...plan, entrance: 3 } });
    assert.match((await next("error")).text, /cannot be built/);
    send({ t: "house", plan });
    const mine = (await next("house")).house;
    assert.deepEqual([mine.lift, mine.floors, mine.planned.length, /^Ground floor: Hall 3\.0 by 6\.0 m/.test(mine.planned[0])], [PLAN_LIFT_M, 2, 2, true]);
    assert.deepEqual([(await next("lived")).lift], [PLAN_LIFT_M]);
    send({ t: "house", put: { slot: "prize", id: "nothing" } });
    await next("error");
    send({ t: "house", plan: null });
    assert.deepEqual([(await next("house")).house.lift, (await next("lived")).lift], [undefined, undefined]);
    ws.close();
  } finally {
    for (const client of rooms.wss.clients) client.terminate();
    server.close();
    rooms.wss.close();
  }
});
