// What a player's animal gets up to when it has been left standing for half a minute: it fidgets (a wave,
// a little dance, a spin, a stretch, a few hops, a look at its own foot, nodding off, chasing its tail) and
// now and then says something to itself. Numbers and words only: idle.js puts them on the figures, and the
// Windows game can do the same sums.
//
// Everything follows from how long the figure has stood still and a number of its own (`seed`), so every
// game that watches the same player stand about sees much the same thing at much the same time.

const TAU = Math.PI * 2;
/** How long a figure stands still before it starts, and how long from one fidget to the next. */
export const IDLE_AFTER_S = 30;
export const CYCLE_S = 9;
/** When in a cycle a figure speaks, and for how long. */
export const SAY_FROM_S = 0.4;
export const SAY_FOR_S = 5.2;

/** From 0 to 1, gently at both ends. */
const glide = (u) => { const x = Math.min(1, Math.max(0, u)); return x * x * (3 - 2 * x); };
/** Up from nothing and back to nothing over a fidget: 0 at u = 0 and 1, and 1 for the middle three fifths. */
const swell = (u) => glide(u / 0.2) * glide((1 - u) / 0.2);

/** A pose with nothing added: what a fidget puts on top of the figure's own standing about (figuremotion.js). */
export function noFidget() {
  return {
    lift: 0, squash: 0, spin: 0, pitch: 0, roll: 0, twist: 0, headPitch: 0, headYaw: 0, headRoll: 0,
    armSwing: [0, 0], armOut: [0, 0], footSwing: [0, 0], footLift: [0, 0], tailYaw: 0, tailUp: 0,
  };
}

/**
 * The fidgets. `pose(u, p)` adds to `p` what the figure is doing a fraction `u` (0 to 1) of the way through.
 * Angles are radians and lengths metres, as in figuremotion.js; `spin` turns the whole figure about its feet,
 * to its right; index 0 of a pair is the left side and 1 the right.
 */
export const FIDGETS = [
  { id: "wave", seconds: 3.2, pose(u, p) {
    const e = swell(u);
    p.armOut[1] = e * (2.3 + 0.35 * Math.sin(u * TAU * 5));
    p.headRoll = 0.16 * e;
    p.lift = 0.02 * e * Math.abs(Math.sin(u * TAU * 2.5));
    p.tailYaw = 0.5 * e * Math.sin(u * TAU * 5);
  } },
  { id: "dance", seconds: 4.6, pose(u, p) {
    const e = swell(u), beat = Math.sin(u * TAU * 6);
    p.roll = 0.18 * e * beat;
    p.lift = 0.06 * e * Math.abs(beat);
    p.armOut[0] = e * (1.2 + 0.8 * beat);
    p.armOut[1] = e * (1.2 - 0.8 * beat);
    p.twist = 0.35 * e * Math.sin(u * TAU * 3);
    p.headRoll = -0.2 * e * beat;
    p.tailYaw = 0.8 * e * Math.sin(u * TAU * 12);
    p.footLift[0] = 0.08 * e * Math.max(0, beat);
    p.footLift[1] = 0.08 * e * Math.max(0, -beat);
  } },
  { id: "spin", seconds: 2.6, pose(u, p) {
    const e = swell(u);
    p.spin = TAU * 2 * glide(u);
    p.armOut[0] = p.armOut[1] = 1.4 * e;
    p.lift = 0.05 * e;
    p.tailUp = 0.5 * e;
  } },
  { id: "stretch", seconds: 4, pose(u, p) {
    const e = swell(u);
    p.armOut[0] = p.armOut[1] = 2.6 * e;
    p.squash = 0.12 * e;
    p.headPitch = -0.5 * e;
    p.pitch = -0.08 * e;
    p.tailUp = 0.3 * e;
  } },
  { id: "hops", seconds: 2.4, pose(u, p) {
    const e = swell(u), up = Math.abs(Math.sin(u * Math.PI * 3));
    p.lift = 0.28 * up * e;
    p.squash = (0.1 * up - 0.08 * (1 - up)) * e;
    p.armOut[0] = p.armOut[1] = 0.9 * up * e;
    p.footSwing[0] = p.footSwing[1] = -0.4 * up * e;
    p.tailUp = 0.5 * up * e;
  } },
  { id: "foot", seconds: 3.6, pose(u, p) {
    const e = swell(u);
    p.footLift[1] = 0.22 * e;
    p.footSwing[1] = 0.5 * e;
    p.headPitch = 0.7 * e;
    p.headYaw = 0.25 * e;
    p.pitch = 0.15 * e;
    p.roll = -0.08 * e;
    p.armOut[0] = 0.9 * e;
    p.footSwing[0] = 0.1 * e * Math.sin(u * TAU * 4); // wobbling on the other one
  } },
  { id: "nod", seconds: 5, pose(u, p) {
    // The head sinks for three quarters of it, then comes up with a start.
    const sink = glide(u / 0.74), start = u < 0.76 ? 0 : swell((u - 0.76) / 0.24);
    const down = u < 0.76 ? sink : 1 - glide((u - 0.76) / 0.06);
    p.headPitch = 0.78 * down - 0.25 * start;
    p.pitch = 0.1 * down;
    p.squash = -0.05 * down + 0.06 * start;
    p.headRoll = 0.12 * down;
    p.lift = 0.09 * start;
    p.armOut[0] = p.armOut[1] = 0.8 * start;
  } },
  { id: "tail", seconds: 3, pose(u, p) {
    const e = swell(u);
    p.spin = -TAU * 3 * glide(u);
    p.pitch = 0.25 * e;
    p.headYaw = -0.6 * e;
    p.tailYaw = 0.9 * e * Math.sin(u * TAU * 6);
    p.tailUp = 0.4 * e;
  } },
];

/** What a figure says to itself. */
export const MUTTERS = [
  "I wonder what clouds taste like.",
  "Left foot, right foot... which one was next?",
  "La la la, la-la la...",
  "If I stand very still, am I a statue?",
  "Did that tree just wink at me?",
  "I spy, with my little eye... everything!",
  "Is it lunchtime yet?",
  "One day I shall walk all the way round the world.",
  "Hello, toes. Still there? Good.",
  "What is the hurry? That is what the snail says.",
  "Hmm hm hmm, hm hmm...",
  "I bet I could hop to the moon. Almost.",
];

/** A number of a figure's own, from its name or its id. */
export function seedOf(text) {
  let h = 2166136261;
  for (const ch of String(text)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/**
 * What a figure that has stood still for `still` seconds is doing: null before half a minute is up. After
 * that, cycle `n` (0, 1, 2...) of nine seconds each: `fidget` is the index in FIDGETS and `u` how far through
 * it is (null in the rest that follows it); `say` is the index in MUTTERS of what it is saying now, or null.
 * It goes through every fidget before it does one again, and speaks in every other cycle.
 */
export function idleAt(still, seed) {
  if (!(still >= IDLE_AFTER_S)) return null;
  const since = still - IDLE_AFTER_S;
  const n = Math.floor(since / CYCLE_S);
  const t = since - n * CYCLE_S;
  const s = seed >>> 0;
  const step = [1, 3, 5, 7][(s >>> 8) % 4]; // each is coprime with the eight fidgets
  const fidget = (s + n * step) % FIDGETS.length;
  const u = t < FIDGETS[fidget].seconds ? t / FIDGETS[fidget].seconds : null;
  const speaks = n % 2 === 0 && t >= SAY_FROM_S && t < SAY_FROM_S + SAY_FOR_S;
  return { n, fidget, u, say: speaks ? ((s >>> 3) + (n / 2) * 7) % MUTTERS.length : null };
}

/** The pose a fidget adds, a fraction `u` of the way through it, into `p` (made afresh if not given). */
export function fidgetPose(fidget, u, p = noFidget()) {
  p.lift = p.squash = p.spin = p.pitch = p.roll = p.twist = p.headPitch = p.headYaw = p.headRoll = p.tailYaw = p.tailUp = 0;
  for (const pair of [p.armSwing, p.armOut, p.footSwing, p.footLift]) pair[0] = pair[1] = 0;
  if (u !== null && u !== undefined && FIDGETS[fidget]) FIDGETS[fidget].pose(u, p);
  return p;
}
