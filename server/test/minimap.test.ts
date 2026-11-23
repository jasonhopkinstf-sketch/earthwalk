import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { KINDS, SIDE, SPAN, far, goingWords, nextSize, place, raceMarks, sizeName, sizeNamed, sizeSaid } from "../public/js/mapmarks.js";
import { prepare, stopsAlong } from "../public/js/trafficmotion.js";

test("M makes the little map large, hides it, and brings it back; the choice has a name to be kept under", () => {
  assert.deepEqual([1, 2, 0].map(nextSize), [2, 0, 1]);
  for (const size of [0, 1, 2]) assert.equal(sizeNamed(sizeName(size)), size);
  assert.equal(sizeNamed(undefined), 1, "small until somebody says otherwise");
  assert.match(sizeSaid(2), /bigger/);
  assert.match(sizeSaid(0), /hidden/);
  assert.match(sizeSaid(1), /back/);
});

test("a mark on the map is drawn where it is, to scale, with north up", () => {
  const at = place("door", 55, -55, SIDE[1], SPAN[1]);
  // 55 m east and 55 m north on a map of 220 m across 200 pixels: 50 pixels right, 50 up.
  assert.deepEqual(at, { on: true, x: 50, y: -50 });
  assert.deepEqual(place("friend", 0, 0, SIDE[1], SPAN[1]), { on: true, x: 0, y: 0 });
});

test("off the map, what matters gets an arrow at the edge pointing the way, and the rest is left out", () => {
  // A friend two kilometres north-east.
  const friend = place("friend", 1500, -1500, SIDE[1], SPAN[1]);
  assert.ok(friend && !friend.on);
  assert.ok(Math.abs(friend.x - 89) < 1e-9 && Math.abs(friend.y + 89) < 1e-9, "just inside the corner");
  assert.ok(Math.abs(friend.ax - Math.SQRT1_2) < 1e-9 && Math.abs(friend.ay + Math.SQRT1_2) < 1e-9, "pointing north-east");
  for (const kind of ["mycar", "taxi", "goal", "gate"]) assert.ok(place(kind, 0, 900, SIDE[2], SPAN[2]), `${kind} is pointed to`);
  // Doors and parked cars are not worth an arrow; nor is a station, unless it is the nearest one.
  assert.equal(place("door", 500, 0, SIDE[1], SPAN[1]), null);
  assert.equal(place("parked", 0, -500, SIDE[1], SPAN[1]), null);
  assert.equal(place("station", 800, 0, SIDE[1], SPAN[1]), null);
  const station = place("station", 800, 0, SIDE[1], SPAN[1], true);
  assert.ok(station && !station.on && station.ax === 1 && station.ay === 0, "the nearest station, due east");
  // Right at the edge counts as off: a mark is never drawn half over the frame.
  assert.equal(place("door", 109, 0, SIDE[1], SPAN[1]), null);
});

test("where the player is being taken is named along the foot of the map, with how far", () => {
  assert.equal(goingWords("Cheltenham Beach, Narrow Neck", 448, 1), "To Cheltenham Beach  ·  450 m");
  assert.equal(goingWords("Cheltenham Beach, Narrow Neck", 2340, 2), "To Cheltenham Beach, Narrow Neck  ·  2.3 km");
  assert.equal(goingWords("The Museum of Transport and Technology", 100, 1), "To The Museum of Tr…  ·  100 m");
  assert.equal(goingWords("the beach", NaN, 1), "To the beach");
  assert.equal(far(0), "0 m");
  assert.equal(far(949), "950 m");
  assert.equal(far(951), "1.0 km");
});

test("a race puts its gates on the map: only the start for somebody not in it, and none once they have finished", () => {
  assert.deepEqual(raceMarks(5, null), [{ k: 0, label: "the race" }]);
  assert.deepEqual(raceMarks(5, { gate: 2, time: null }), [{ k: 2, label: "next gate" }, { k: 3, label: "" }, { k: 4, label: "" }]);
  assert.deepEqual(raceMarks(5, { gate: 4, time: null }), [{ k: 4, label: "finish" }]);
  assert.deepEqual(raceMarks(5, { gate: 5, time: 61_000 }), []);
});

test("a train's stops are the ends of its run and wherever its timetable has it standing", () => {
  // Out along a straight kilometre, with a stand of twenty seconds half way and a pause of two that is no station.
  const train = prepare({ id: 7, w: 0, left: false, da: 30, db: 30, path: [0, 0, 0, 250, 0, 20, 250, 0, 22, 500, 0, 40, 500, 0, 60, 1000, 0, 100] });
  assert.deepEqual(stopsAlong(train), [0, 500, 1000]);
});

test("the map's marks are the Windows game's, in the same colours", { skip: !existsSync(new URL("../../game/Source/EarthWalk/EarthMiniMap.cpp", import.meta.url)) && "the Windows game's files are not here" }, () => {
  const cpp = readFileSync(new URL("../../game/Source/EarthWalk/EarthMiniMap.cpp", import.meta.url), "utf8");
  const colour = (kind: string): string => {
    const m = new RegExp(`EKind::${kind}: return (?:FLinearColor\\(FColor\\((\\d+), (\\d+), (\\d+)\\)\\)|Gold)`).exec(cpp);
    assert.ok(m, `the Windows colour of ${kind}`);
    return m[1] === undefined ? "#f5c518" : `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
  };
  assert.equal(KINDS.friend.colour, colour("Friend"));
  assert.equal(KINDS.door.colour, colour("Door"));
  assert.equal(KINDS.station.colour, colour("Station"));
  assert.equal(KINDS.parked.colour, colour("Parked"));
  assert.equal(KINDS.mycar.colour, colour("MyCar"));
  assert.equal(KINDS.taxi.colour, colour("Taxi"));
  assert.equal(KINDS.goal.colour, colour("Goal"));
  assert.match(cpp, /FColor\(170, 90, 220\)/);
  assert.equal(KINDS.gate.colour, "#aa5adc");
  // The same sizes on the screen and the same stretch of the world.
  for (const [name, value] of [["SmallSide", SIDE[1]], ["LargeSide", SIDE[2]], ["SmallSpan", SPAN[1]], ["LargeSpan", SPAN[2]]] as const) {
    assert.match(cpp, new RegExp(`${name} = ${value}\\.`), `${name} is ${value}`);
  }
  // And the same words under the large map.
  for (const kind of Object.values(KINDS)) assert.ok(cpp.includes(`TEXT("${kind.words}")`), `the legend says "${kind.words}"`);
});
