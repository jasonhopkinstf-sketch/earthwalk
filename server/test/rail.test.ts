import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/app.ts";
import { Elevation } from "../src/elevation.ts";
import { metersPerTile, xToLon, yToLat } from "../src/geo.ts";
import { buildLabels, generateLabels, partialLabels, type LabelsJson } from "../src/labels.ts";
import type { Features, OsmJson } from "../src/osm.ts";
import { buildTrains, parseRail, RAIL_SPAN, trainsFor, TRAINS_PER_SQUARE } from "../src/rail.ts";
import { pointAt, prepare, trainPose } from "../public/js/trafficmotion.js";

// The rail square that holds the Eiffel Tower's chunk.
const RX = 33185 >> 2;
const RY = 22545 >> 2;
const X0 = RX * RAIL_SPAN;
const Y0 = RY * RAIL_SPAN;
const S = metersPerTile(Y0 + RAIL_SPAN / 2);
const empty = (): Features => ({ buildings: [], roads: [], areas: [], trees: [], addresses: [], coast: [], fields: [] });

/**
 * A main line running east right across the square (and beyond it at both ends) in three pieces, a
 * branch that turns off it, a siding, a tunnel, a track under the ground that the map gives no tunnel, and a
 * station beside the main line.
 */
function railway(): OsmJson {
  let id = 0;
  const node = (x: number, y: number, tags?: Record<string, string>) => ({ type: "node" as const, id: ++id, lon: xToLon(X0 + x), lat: yToLat(Y0 + y), tags });
  const n = [node(-0.5, 2), node(1.5, 2), node(3, 2.1), node(4.5, 2.1), node(1.8, 3.2), node(0.5, 0.5), node(1, 0.5), node(2.5, 3), node(3, 3.5), node(2.25, 2.05, { railway: "station", name: "Middle" })];
  const way = (wid: number, nodes: number[], tags: Record<string, string> = {}) => ({ type: "way" as const, id: wid, nodes: nodes.map((i) => n[i].id), tags: { railway: "rail", ...tags } });
  return { elements: [...n, way(11, [0, 1]), way(12, [1, 2]), way(13, [2, 3]), way(14, [1, 4]), way(15, [5, 6], { service: "siding" }), way(16, [7, 8], { tunnel: "yes" }), way(17, [7, 8], { layer: "-1" })] };
}

test("main-line tracks and stations are read, tunnels too; sidings are left out, and track under the ground with no tunnel", () => {
  const data = parseRail(railway());
  assert.deepEqual(data.lines.map((l) => l.id), [11, 12, 13, 14, 16]);
  assert.equal(data.stations.length, 1);
});

test("tracks are joined into runs, straight on at points, cut at the edge of the square, with a timetable", () => {
  const trains = buildTrains(RX, RY, parseRail(railway()));
  assert.equal(trains.length, 2, "the main line and the branch");
  assert.ok(trains.length <= TRAINS_PER_SQUARE);
  assert.notEqual(trains[0].id, trains[1].id);
  const [main, branch] = trains;

  // The main line: from the west edge of the square to the east edge, never down the branch.
  const first = main.path[0];
  const last = main.path[main.path.length - 1];
  assert.ok(Math.abs(first[0] - X0) < 1e-9 && Math.abs(last[0] - (X0 + RAIL_SPAN)) < 1e-9, "edge to edge");
  let length = 0;
  let stopped = 0;
  for (let i = 1; i < main.path.length; i++) {
    const [x, y, t] = main.path[i];
    const [px, py, pt] = main.path[i - 1];
    assert.ok(x >= X0 - 1e-9 && x <= X0 + RAIL_SPAN + 1e-9 && y > Y0 + 1.95 && y < Y0 + 2.15, "on the main line, inside the square");
    const step = Math.hypot(x - px, y - py) * S;
    length += step;
    assert.ok(t > pt, "time moves on");
    if (step === 0) {
      stopped++;
      assert.ok(Math.abs(t - pt - 14) < 0.11, "it stands at the station for 14 s");
      assert.ok(Math.hypot(x - (X0 + 2.25), y - (Y0 + 2.05)) * S < 80, "beside the station");
    } else {
      assert.ok(step / (t - pt) <= 14.6, `${(step / (t - pt)).toFixed(1)} m/s`);
    }
  }
  assert.equal(stopped, 1, "one stop, at the one station");
  assert.ok(Math.abs(length - RAIL_SPAN * S) < 60, `${length.toFixed(0)} m across a ${(RAIL_SPAN * S).toFixed(0)} m square`);
  assert.ok((Math.hypot(main.path[1][0] - first[0], main.path[1][1] - first[1]) * S) / main.path[1][2] < 3, "it sets off slowly");
  assert.ok(main.wa >= 20 && main.wb >= 20);

  assert.ok(branch.path.every(([x, y]) => x > X0 + 1.45 && x < X0 + 1.85 && y > Y0 + 1.95 && y < Y0 + 3.25), "the branch has a train of its own");
  assert.deepEqual(buildTrains(RX, RY, parseRail(railway())), trains, "the same every time");
});

test("every chunk on a run gets the very same train, and chunks off it get none", async () => {
  const load = async () => railway();
  const onLine = await trainsFor(X0 + 2, Y0 + 2, load);
  assert.ok(onLine.length >= 1);
  const main = onLine.find((t) => t.path.length > 100)!;
  for (const cx of [X0, X0 + 1, X0 + 3]) {
    const here = (await trainsFor(cx, Y0 + 2, load)).find((t) => t.id === main.id);
    assert.deepEqual(here, main, "identical in every chunk it passes through");
  }
  assert.deepEqual(await trainsFor(X0 + 2, Y0, load), [], "none where there is no track");
});

test("a train replayed by a client: out, a stop at the station, the far end, and back, without turning round", () => {
  const [main] = buildTrains(RX, RY, parseRail(railway()));
  const train = prepare({ id: main.id, w: 0, left: false, da: main.wa, db: main.wb, path: main.path.flatMap(([x, y, t]) => [(x - X0) * S, (y - Y0) * S, t]) });
  const t0 = 1_795_000_000;
  let last = trainPose(train, t0);
  const legs = new Set<number>();
  let stoodMidway = 0;
  for (let i = 1; i <= train.period * 10 + 20; i++) {
    const now = trainPose(train, t0 + i * 0.1);
    legs.add(now.leg);
    assert.ok(now.along >= 0 && now.along <= train.length + 1e-9, "on its track");
    assert.ok(Math.abs(now.along - last.along) < 1.6, "no jumps");
    if (!now.moving && !last.moving) assert.ok(Math.abs(now.along - last.along) < 1e-9, "a standing train stands still");
    if (!now.moving && (now.leg === 1 || now.leg === 3) && now.along > 500 && now.along < train.length - 500) stoodMidway++;
    if (now.moving && last.moving && now.leg === last.leg) assert.equal(now.along > last.along, !now.back, "out, then back");
    last = now;
  }
  assert.deepEqual([...legs].sort(), [0, 1, 2, 3]);
  assert.ok(stoodMidway > 200, `it stands at the station both ways (${stoodMidway} tenths of a second)`);
  const p = pointAt(train, train.length / 2);
  assert.ok(p[1] > 1.95 * S && p[1] < 2.15 * S);
  assert.deepEqual(trainPose(train, t0 + 55.5), trainPose(prepare({ ...train }), t0 + 55.5), "the same for everyone");
});

test("labels carry the trains; without the tracks they are sent anyway, marked as not worth keeping", async () => {
  const cx = X0 + 3;
  const cy = Y0 + 2;
  const elev = new Elevation(async () => new Float32Array(256 * 256).fill(40));
  await elev.ensure(cx - 0.5, cy - 0.5, cx + 1.5, cy + 1.5);
  const trains = await trainsFor(cx, cy, async () => railway());
  const items = buildLabels(cx, cy, empty(), elev, trains).filter((i) => i.kind === "train");
  assert.equal(items.length, trains.length);
  for (const it of items) {
    assert.ok(it.pts!.length % 3 === 0 && it.pts!.length > 300 && it.da! >= 20 && it.db! >= 20 && it.id! > 0);
    assert.equal(it.text, undefined, "older games skip an item with no text");
    assert.ok(Math.abs(it.pts![0] - (X0 - cx)) < 1e-4, "the path is measured from this chunk, and starts three chunks to the west");
  }

  const whole = await generateLabels(cx, cy, elev, async () => empty(), async () => trains);
  assert.equal(partialLabels.has(whole), false);
  assert.ok((JSON.parse(whole.toString("utf8")) as LabelsJson).items.some((i) => i.kind === "train"));
  const without = await generateLabels(cx, cy, elev, async () => empty(), async () => { throw new Error("no answer"); });
  assert.equal(partialLabels.has(without), true);
  assert.equal((JSON.parse(without.toString("utf8")) as LabelsJson).items.filter((i) => i.kind === "train").length, 0);
});

test("labels built with a piece missing are served but not kept, so the next visit tries again", async () => {
  const kept: string[] = [];
  let builds = 0;
  const app = createApp({
    buildChunk: async () => Buffer.from("chunk"),
    buildLabels: async (x) => {
      builds++;
      const out = Buffer.from(JSON.stringify({ x, items: [] }));
      if (x === 7) partialLabels.add(out);
      return out;
    },
    readCache: async () => null,
    writeCache: async (rel) => { kept.push(rel); },
  });
  await new Promise<void>((r) => app.server.listen(0, r));
  const base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/v1/labels/16/7/2`)).status, 200);
    assert.equal((await fetch(`${base}/v1/labels/16/8/2`)).status, 200);
    assert.equal(builds, 2);
    assert.equal(kept.length, 1);
    assert.ok(kept[0].endsWith("/8/2.json"));
  } finally {
    app.close();
  }
});
