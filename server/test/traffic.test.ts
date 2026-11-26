import { test } from "node:test";
import assert from "node:assert/strict";
import { groundClasses } from "../src/chunk.ts";
import { Elevation } from "../src/elevation.ts";
import { latToY, lonToX, metersPerTile } from "../src/geo.ts";
import { buildLabels } from "../src/labels.ts";
import { MACHINE_CAP, placeMachines } from "../src/life.ts";
import { parseOsm, type Features, type Pt, type Road } from "../src/osm.ts";
import { drivesLeft, PARKED_CAP, placeTraffic, TRIP_CAP } from "../src/traffic.ts";
import { creatureAt, SPECIES } from "../public/js/lifemotion.js";
import { boxesMeet, giveWay, KERB_IN, prepare, restPose, setSpots, tripPose, type CarBox, type GivingCar } from "../public/js/trafficmotion.js";

const PARIS: [number, number] = [33185, 22545];
const LONDON: [number, number] = [Math.floor(lonToX(-0.12)), Math.floor(latToY(51.5))];
const empty = (): Features => ({ buildings: [], roads: [], areas: [], trees: [], addresses: [], coast: [], fields: [] });

/**
 * A village: three streets running east and three running south, crossing at shared points, with a
 * house every 40 m or so along them. The southern east-west street is one-way.
 */
function village(cx: number, cy: number): Features {
  const f = empty();
  const S = metersPerTile(cy + 0.5);
  const stops = [-0.2, 0.2, 0.5, 0.8, 1.2];
  [0.2, 0.5, 0.8].forEach((v, n) => {
    f.roads.push({ id: 100 + n, cls: "road", width: 6, hw: "residential", pts: stops.map((u): Pt => [cx + u, cy + v]), ...(n === 2 ? { oneway: true } : {}) });
    f.roads.push({ id: 200 + n, cls: "road", width: n === 1 ? 8 : 6, hw: n === 1 ? "tertiary" : "residential", pts: stops.map((u): Pt => [cx + v, cy + u]) });
  });
  const side = 8 / S;
  let id = 1000;
  for (const v of [0.15, 0.25, 0.45, 0.55, 0.75, 0.85]) {
    for (let u = 0.05; u < 1; u += 0.1) {
      if ([0.2, 0.5, 0.8].some((x) => Math.abs(u - x) < 0.04)) continue;
      f.buildings.push({ id: id++, ring: [[cx + u, cy + v], [cx + u + side, cy + v], [cx + u + side, cy + v + side], [cx + u, cy + v + side]], height: 6, kind: "house" });
    }
  }
  return f;
}

/** The nearest point of any of these roads to a point: how far (metres), the road, and its direction there. */
function nearest(p: Pt, roads: Road[], S: number): { d: number; road: Road; dir: [number, number]; q: Pt } {
  let best = { d: Infinity, road: roads[0], dir: [1, 0] as [number, number], q: p };
  for (const road of roads) {
    for (let i = 0; i + 1 < road.pts.length; i++) {
      const [a, b] = [road.pts[i], road.pts[i + 1]];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len)));
      const q: Pt = [a[0] + dx * t, a[1] + dy * t];
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]) * S;
      if (d < best.d) best = { d, road, dir: [dx / len, dy / len], q };
    }
  }
  return best;
}
const toRad = (deg: number): number => (deg * Math.PI) / 180;

test("people drive on the left where they should", () => {
  const left = { London: [51.5, -0.12], Dublin: [53.35, -6.26], Sydney: [-33.87, 151.21], Auckland: [-36.85, 174.76], Tokyo: [35.68, 139.69], Delhi: [28.6, 77.2], Bangkok: [13.75, 100.5], Nairobi: [-1.29, 36.82], Johannesburg: [-26.2, 28.04], Singapore: [1.35, 103.82], Kathmandu: [27.7, 85.3] };
  const right = { Paris: [48.86, 2.35], Calais: [50.95, 1.85], "New York": [40.71, -74.0], Berlin: [52.52, 13.4], Beijing: [39.9, 116.4], Cairo: [30.04, 31.24], "Sao Paulo": [-23.55, -46.63], Moscow: [55.75, 37.62], Lhasa: [29.65, 91.1] };
  for (const [name, [lat, lon]] of Object.entries(left)) assert.equal(drivesLeft(lat, lon), true, name);
  for (const [name, [lat, lon]] of Object.entries(right)) assert.equal(drivesLeft(lat, lon), false, name);
});

test("the map's kind of road and its one-way streets are kept", () => {
  const n = (id: number, lon: number, lat: number) => ({ type: "node" as const, id, lon, lat });
  const f = parseOsm({ elements: [
    n(1, 2.29, 48.858), n(2, 2.291, 48.858), n(3, 2.292, 48.858),
    { type: "way", id: 10, nodes: [1, 2], tags: { highway: "residential" } },
    { type: "way", id: 11, nodes: [2, 3], tags: { highway: "primary", oneway: "yes" } },
    { type: "way", id: 12, nodes: [1, 3], tags: { highway: "footway" } },
  ] });
  assert.deepEqual(f.roads.map((r) => [r.id, r.hw, r.oneway]), [[10, "residential", undefined], [11, "primary", true], [12, undefined, undefined]]);
});

for (const [name, [cx, cy], left] of [["Paris", PARIS, false], ["London", LONDON, true]] as const) {
  test(`${name}: cars park at the kerb on the proper side, away from junctions`, () => {
    const f = village(cx, cy);
    const S = metersPerTile(cy + 0.5);
    const { parked, trips } = placeTraffic(cx, cy, f);
    assert.ok(parked.length >= 15 && parked.length <= PARKED_CAP, `${parked.length} parked cars`);
    assert.ok(trips.length >= 3 && trips.length <= TRIP_CAP, `${trips.length} trips`);
    assert.equal(new Set([...parked, ...trips].map((c) => c.id)).size, parked.length + trips.length, "every car has its own identity");
    const crossings: Pt[] = [0.2, 0.5, 0.8].flatMap((u) => [0.2, 0.5, 0.8].map((v): Pt => [cx + u, cy + v]));
    for (const car of parked) {
      const p: Pt = [car.wx, car.wy];
      assert.ok(p[0] >= cx && p[0] < cx + 1 && p[1] >= cy - 0.01 && p[1] < cy + 1.01);
      const near = nearest(p, f.roads, S);
      assert.ok(Math.abs(near.d - (near.road.width / 2 - KERB_IN)) < 0.02, `a car's width in from the edge of the road (${near.d.toFixed(2)} m from the middle)`);
      for (const c of crossings) assert.ok(Math.hypot(p[0] - c[0], p[1] - c[1]) * S > 9, "clear of the junction");
      const face: [number, number] = [Math.sin(toRad(car.yaw)), -Math.cos(toRad(car.yaw))];
      assert.ok(Math.abs(Math.abs(face[0] * near.dir[0] + face[1] * near.dir[1]) - 1) < 1e-6, "parked along the street");
      // The kerb is on the car's right where people drive on the right, and on its left otherwise.
      const toKerb: [number, number] = [p[0] - near.q[0], p[1] - near.q[1]];
      const onRight = -face[1] * toKerb[0] + face[0] * toKerb[1] > 0;
      assert.equal(onRight, !left);
    }
    assert.deepEqual(placeTraffic(cx, cy, f), { parked, trips }, "the same every time");
  });

  test(`${name}: a trip follows the streets, at a gentle pace, and the car keeps to its side`, () => {
    const f = village(cx, cy);
    const S = metersPerTile(cy + 0.5);
    const twoWay = f.roads.filter((r) => !r.oneway);
    const oneWay = f.roads.filter((r) => r.oneway);
    const { trips } = placeTraffic(cx, cy, f);
    for (const trip of trips) {
      assert.equal(trip.left, left);
      assert.ok(trip.dwellA >= 30 && trip.dwellB >= 20 && trip.w >= 6);
      let length = 0;
      for (let i = 0; i < trip.path.length; i++) {
        const [x, y, t] = trip.path[i];
        assert.ok(nearest([x, y], twoWay, S).d < 0.05, "on the middle of a two-way street");
        if (i === 0) { assert.equal(t, 0); continue; }
        const [px, py, pt] = trip.path[i - 1];
        const step = Math.hypot(x - px, y - py) * S;
        length += step;
        assert.ok(t > pt, "time moves on");
        const pace = step / (t - pt);
        assert.ok(pace <= 8.6 && pace >= 0.5, `${pace.toFixed(1)} m/s`);
        assert.ok(!(nearest([x, y], oneWay, S).d < 0.05 && nearest([px, py], oneWay, S).d < 0.05), "never along the one-way street");
      }
      assert.ok(length >= 60 && length <= 425, `${length.toFixed(0)} m`);
      const first = (Math.hypot(trip.path[1][0] - trip.path[0][0], trip.path[1][1] - trip.path[0][1]) * S) / trip.path[1][2];
      assert.ok(first < 3.5, `it pulls out slowly (${first.toFixed(1)} m/s)`);

      // ---- replayed by a client
      const car = prepare({ id: trip.id, w: trip.w, left: trip.left, da: trip.dwellA, db: trip.dwellB, path: trip.path.flatMap(([x, y, t]) => [(x - cx) * S, (y - cy) * S, t]) });
      const roadsM = twoWay.map((r) => ({ ...r, pts: r.pts.map(([x, y]): Pt => [(x - cx) * S, (y - cy) * S]) }));
      assert.ok(Math.abs(car.length - length) < 0.01 && car.period > 2 * car.time + 50);
      const t0 = 1_795_000_000;
      let last = tripPose(car, t0);
      const legs = new Set<number>();
      for (let i = 1; i <= car.period * 10 + 20; i++) {
        const now = tripPose(car, t0 + i * 0.1);
        legs.add(now.leg);
        const moved = Math.hypot(now.x - last.x, now.y - last.y);
        assert.ok(moved < 1.3, `no jumps, even when it turns round (${moved.toFixed(2)} m in a tenth of a second)`);
        if (!now.moving && !last.moving) assert.ok(moved < 1e-9, "a waiting car stands still");
        const near = nearest([now.x, now.y], roadsM, 1);
        assert.ok(near.d <= trip.w / 2 - KERB_IN + 0.02, "always on the road");
        if (now.inLane) {
          const face: [number, number] = [Math.sin(toRad(now.yaw)), -Math.cos(toRad(now.yaw))];
          const off = -face[1] * (now.x - near.q[0]) + face[0] * (now.y - near.q[1]); // positive: right of the middle
          if (near.d > 0.5 && Math.abs(Math.abs(face[0] * near.dir[0] + face[1] * near.dir[1]) - 1) < 0.01) assert.equal(off > 0, !left, "in its own lane");
        }
        last = now;
      }
      assert.deepEqual([...legs].sort(), [0, 1, 2, 3], "waits, drives out, waits, drives back");
      assert.deepEqual(tripPose(car, t0 + 77.7), tripPose(prepare({ ...car }), t0 + 77.7), "the same for everyone");
    }
  });
}

for (const [name, [cx, cy]] of [["Paris", PARIS], ["London", LONDON]] as const) {
  test(`${name}: cars steer out round the ones at the kerb, give way to each other, and rest where nothing else stands`, () => {
    const S = metersPerTile(cy + 0.5);
    const { parked, trips } = placeTraffic(cx, cy, village(cx, cy));
    const boxOf = (c: { x: number; y: number; yaw: number }): CarBox => ({ x: c.x, y: c.y, fx: Math.sin(toRad(c.yaw)), fy: -Math.cos(toRad(c.yaw)) });
    const ready = (): GivingCar[] => trips.map((trip) => ({
      trip: prepare({ id: trip.id, w: trip.w, left: trip.left, da: trip.dwellA, db: trip.dwellB, path: trip.path.flatMap(([x, y, t]) => [(x - cx) * S, (y - cy) * S, t]) }),
      st: { lag: 0 },
    }));
    const kerb = parked.map((p) => ({ id: p.id, x: (p.wx - cx) * S, y: (p.wy - cy) * S, yaw: p.yaw }));
    const cars = ready();

    // ---- where each car waits, at either end of its trip: no parked car there, and no other trip's car
    const rests = cars.flatMap(({ trip }) => [false, true].map((far) => ({ id: trip.id, far, ...restPose(trip, far) })));
    for (const a of rests) {
      assert.ok(!kerb.some((p) => boxesMeet(boxOf(a), boxOf(p))), "no trip ends where a parked car stands");
      for (const b of rests) if (b.id !== a.id) assert.ok(!boxesMeet(boxOf(a), boxOf(b)), "nor where another trip does");
    }

    // ---- an hour of it, as a game plays it: told what stands at the kerbs, and giving way
    const spots = [...kerb.map((p) => ({ x: p.x, y: p.y, key: `p${p.id}` })), ...rests.map((r) => ({ x: r.x, y: r.y, key: `${r.far ? "b" : "a"}${r.id}` }))];
    for (const { trip } of cars) setSpots(trip, spots.filter((s) => s.key !== `a${trip.id}` && s.key !== `b${trip.id}`));
    const plain = ready(); // and the timetables alone, as it was before, to see that there was something to mend
    const t0 = 1_795_000_000;
    const count = { parked: 0, each: 0, plainParked: 0, behind: 0 };
    const [LONG, WIDE] = [4.2, 1.8]; // a car as it is drawn: inside that is through it
    for (let i = 0; i < 3600 * 4; i++) {
      const t = t0 + i * 0.25;
      giveWay(cars, t, 0.25);
      for (const a of cars) {
        count.behind = Math.max(count.behind, a.st.lag);
        if (!a.pose!.moving) continue;
        if (kerb.some((p) => boxesMeet(a.box!, boxOf(p), LONG, WIDE))) count.parked++;
        for (const b of cars) if (b !== a && boxesMeet(a.box!, b.box!, LONG, WIDE)) count.each++;
      }
      for (const a of plain) {
        const pose = tripPose(a.trip, t);
        if (pose.moving && kerb.some((p) => boxesMeet(boxOf(pose), boxOf(p), LONG, WIDE))) count.plainParked++;
      }
    }
    assert.ok(count.plainParked > 200, `left to their timetables they drive through the parked cars (${count.plainParked} quarter seconds of it)`);
    assert.equal(count.parked, 0, "never through a parked car");
    assert.equal(count.each, 0, "nor through each other");
    assert.ok(count.behind < 45, `and nobody is kept waiting long (${count.behind.toFixed(0)} s at most)`);
    // What a car does is the same whoever works it out: from the same start, the same answer.
    const again = ready();
    for (const { trip } of again) setSpots(trip, spots.filter((s) => s.key !== `a${trip.id}` && s.key !== `b${trip.id}`));
    const first = ready();
    for (const { trip } of first) setSpots(trip, spots.filter((s) => s.key !== `a${trip.id}` && s.key !== `b${trip.id}`));
    for (let i = 0; i < 400; i++) { giveWay(again, t0 + i * 0.25, 0.25); giveWay(first, t0 + i * 0.25, 0.25); }
    assert.deepEqual(again.map((c) => [c.pose!.x, c.pose!.y, c.st.lag]), first.map((c) => [c.pose!.x, c.pose!.y, c.st.lag]));
  });
}

test("no cars where nobody lives, and the labels carry cars and trips a game can replay", async () => {
  const [cx, cy] = PARIS;
  const lonely = village(cx, cy);
  lonely.buildings = [];
  assert.deepEqual(placeTraffic(cx, cy, lonely), { parked: [], trips: [] });

  const elev = new Elevation(async () => new Float32Array(256 * 256).fill(40));
  await elev.ensure(cx - 0.5, cy - 0.5, cx + 1.5, cy + 1.5);
  const items = buildLabels(cx, cy, village(cx, cy), elev);
  const cars = items.filter((i) => i.kind === "car");
  const routes = items.filter((i) => i.kind === "route");
  assert.ok(cars.length >= 15 && routes.length >= 3);
  for (const it of [...cars, ...routes]) {
    assert.ok(Number.isInteger(it.id) && it.id! > 0 && it.text === undefined, "older games skip an item with no text");
    assert.ok(Math.abs(it.h - elev.surfaceHeight(cx + it.u, cy + it.v)) < 1e-6);
  }
  for (const r of routes) {
    assert.ok(r.pts!.length >= 45 && r.pts!.length % 3 === 0 && r.w! >= 6 && r.left === 0 && r.da! >= 30 && r.db! >= 20);
    assert.equal(r.pts![0], r.u);
    assert.equal(r.pts![2], 0);
  }
});

test("a tractor works ploughed land and boats keep to water near a shore", async () => {
  const [cx, cy] = PARIS;
  const S = metersPerTile(cy + 0.5);
  const elev = new Elevation(async () => new Float32Array(256 * 256).fill(40));
  await elev.ensure(cx - 0.5, cy - 0.5, cx + 1.5, cy + 1.5);
  const sq = (x0: number, y0: number, x1: number, y1: number): Pt[] => [[cx + x0, cy + y0], [cx + x1, cy + y0], [cx + x1, cy + y1], [cx + x0, cy + y1]];
  const f = empty();
  f.areas.push({ id: 1, cls: "farm", rings: [sq(-0.1, -0.1, 1.1, 0.5)] }, { id: 2, cls: "water", rings: [sq(-0.1, 0.5, 1.1, 1.1)] });
  f.fields!.push({ id: 1, kind: "farmland", rings: [sq(-0.1, -0.1, 1.1, 0.5)] });
  const homes = placeMachines(cx, cy, f, groundClasses(cx, cy, f, elev));
  const of = (sp: string) => homes.filter((h) => h.sp === sp);
  assert.ok(homes.length >= 3 && homes.length <= MACHINE_CAP, homes.map((h) => h.sp).join(" "));
  assert.ok(of("tractor").length >= 1 && of("sailboat").length + of("boat").length >= 1);
  for (const h of homes) {
    assert.equal(h.n, 1);
    if (h.sp === "tractor") assert.ok(h.wy + h.r / S <= cy + 0.5 && h.r >= 12, "its patch is all field");
    else assert.ok(h.wy - h.r / S >= cy + 0.5 && (h.wy - cy - 0.5) * S <= 250 + h.r, "afloat, and not far out");
    if (h.sp === "sailboat") assert.ok(h.r >= 14);
  }
  // Open water with no shore in sight has no boats.
  const sea = empty();
  sea.areas.push({ id: 1, cls: "water", rings: [sq(-0.5, -0.5, 1.5, 1.5)] });
  assert.equal(placeMachines(cx, cy, sea, groundClasses(cx, cy, sea, elev)).length, 0);
});

test("a tractor or a boat goes steadily round its patch, the same for everyone", () => {
  const t0 = 1_795_000_000;
  for (const sp of Object.keys(SPECIES).filter((k) => SPECIES[k].lap)) {
    for (const r of [6, 14, 28]) {
      const home = { id: 4000 + r, sp, n: 1, r };
      let last = creatureAt(home, 0, t0);
      let turned = 0;
      for (let i = 1; i <= 4000; i++) {
        const now = creatureAt(home, 0, t0 + i * 0.1);
        assert.ok(Math.hypot(now.x, now.y) <= r * 0.85 + 1e-9, `${sp} stays in its patch`);
        const pace = Math.hypot(now.x - last.x, now.y - last.y) / 0.1;
        assert.ok(pace > SPECIES[sp].pace * 0.5 && pace < SPECIES[sp].pace * 1.6, `${sp} at ${pace.toFixed(2)} m/s`);
        turned += Math.abs(((now.yaw - last.yaw + 540) % 360) - 180);
        last = now;
      }
      assert.ok(turned > 300 || r * 6 > SPECIES[sp].pace * 400, "it comes round again");
      assert.deepEqual(creatureAt(home, 0, t0 + 12.3), creatureAt({ ...home }, 0, t0 + 12.3));
    }
  }
});
