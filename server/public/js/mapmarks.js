// The little map's arithmetic: where a mark goes, which marks get an arrow at the edge when they are
// off the map, and the words under it. The drawing is minimap.js; the Windows game's is
// game/Source/EarthWalk/EarthMiniMap.cpp, and the sizes and colours here are the same as there.
//
// No three.js and no page here: this file is also run by the server's tests.

/** The map on the screen: pixels a side, and how many metres of the world that is. 1 is small, 2 large. */
export const SIDE = { 1: 200, 2: 420 };
export const SPAN = { 1: 220, 2: 640 };
/** The ink line round the map, and under the large one the box that says what each mark is. */
export const EDGE = 3;
export const LEGEND_H = 96;

/** What each mark is, in the order the legend lists them. */
export const KINDS = {
  friend: { colour: "#40c860", words: "A friend", wide: 14, shape: "disc", points: true },
  door: { colour: "#fffdf4", words: "A door you can go in", wide: 6, shape: "square", points: false },
  station: { colour: "#3478e6", words: "A train stops here", wide: 14, shape: "square", points: false },
  parked: { colour: "#d6deec", words: "A parked car", wide: 7, shape: "disc", points: false },
  mycar: { colour: "#ff8c1e", words: "Your own car", wide: 14, shape: "disc", points: true, letter: "C" },
  taxi: { colour: "#f5c518", words: "Your taxi", wide: 14, shape: "disc", points: true, letter: "T" },
  goal: { colour: "#e8343c", words: "Where you are going", wide: 17, shape: "disc", points: true },
  gate: { colour: "#aa5adc", words: "A gate of the race", wide: 14, shape: "disc", points: true },
};

/** M: small, large, hidden, small again. */
export const nextSize = (size) => (size === 1 ? 2 : size === 2 ? 0 : 1);
export const sizeName = (size) => (size === 0 ? "off" : size === 2 ? "big" : "small");
export const sizeNamed = (name) => (name === "off" ? 0 : name === "big" ? 2 : 1);
export const sizeSaid = (size) => (size === 2 ? "The map is bigger, and says what each mark is. M again hides it."
  : size === 0 ? "The map is hidden. M brings it back."
  : "The little map is back. M makes it bigger.");

/** How far off, for people: "120 m", "2.3 km". */
export const far = (metres) => (metres < 950 ? `${Math.round(metres / 10) * 10} m` : `${(metres / 1000).toFixed(1)} km`);

/**
 * Where a mark is drawn. `dx`, `dz` are metres east and south of the player; `side` the map's width in
 * pixels and `span` in metres. On the map: { on: true, x, y } in pixels from its middle. Off it, a mark
 * that matters (its kind `points`, or it is marked `point`) gets an arrow just inside the edge, pointing
 * the way: { on: false, x, y, ax, ay } with (ax, ay) the direction. Anything else off the map is null.
 */
export function place(kind, dx, dz, side, span, point = false) {
  const perMetre = side / span;
  const x = dx * perMetre, y = dz * perMetre;
  const reach = side / 2;
  const most = Math.max(Math.abs(x), Math.abs(y));
  if (most <= reach - 6) return { on: true, x, y };
  if (!KINDS[kind]?.points && !point) return null;
  const k = (reach - 11) / most;
  const length = Math.hypot(x, y);
  return { on: false, x: x * k, y: y * k, ax: x / length, ay: y / length };
}

/**
 * The words along the foot of the map while the player is being taken somewhere: "To Cheltenham Beach · 450 m".
 * The small map has room for little: a name is cut at its first comma, and shortened to fit.
 */
export function goingWords(name, metres, size) {
  let words = name;
  if (size !== 2 && words.includes(",")) words = words.slice(0, words.indexOf(","));
  const room = size === 2 ? 44 : 17;
  if (words.length > room) words = `${words.slice(0, room - 1).trimEnd()}…`;
  return `To ${words}${Number.isFinite(metres) ? `  ·  ${far(metres)}` : ""}`;
}

/**
 * The marks of a race: the gates still to go through, the next one named. `mine` is my runner
 * ({ gate, time }) or null when I am not in it, and then only where it starts is shown.
 * @returns {{ k: number, label: string }[]}
 */
export function raceMarks(gates, mine) {
  if (mine && mine.time !== null && mine.time !== undefined) return []; // finished
  const next = mine ? mine.gate : 0;
  const out = [];
  for (let k = next; k < gates; k++) {
    out.push({ k, label: k !== next ? "" : !mine ? "the race" : k === gates - 1 ? "finish" : "next gate" });
    if (!mine) break; // not in it: just where it starts
  }
  return out;
}
