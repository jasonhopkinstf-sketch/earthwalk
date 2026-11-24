// "Fly me there": the player is carried through the air to a place they chose, and watches. The sums
// (which kind of flight, how long, how high, how fast) are flightplan.js; this moves the player.
//
// A low flight goes up from where the player stands, over the rooftops along a straight line, and down
// beside the place, with the world loading under it all the way. A high flight climbs out until the
// ground is lost in the haze, moves the world's origin to the place, crosses in the haze, and comes down
// over the place as the ground there appears. Either way the player may look round with the mouse and
// use the view from above (V); any movement key, F or Esc takes over and leaves them flying where they are.
//
// While a flight is on, main.js asks this where the world should be loaded round (`loadAt`) and where the
// player is on Earth when the scene cannot say (`where`), and tells the server with each position that the
// player is being flown: the flight is not a walk for the passport, and the server downloads no map ahead of it.

import * as THREE from "three";
import { climbAt, descentAt, farWords, flightHeading, flyingWords, LOW_TRIM_M, lowAt, metresBetween, overAt, PACES, paceStep, planFlight, roofClear, shortName, smooth, timeWords, trimHeight } from "./flightplan.js";

const DOWN = new THREE.Vector3(0, -1, 0);
/** Any of these takes over. (The arrow keys only look round; Space, C, 1 and 2 trim a low flight and are otherwise left alone.) */
const HANDS = ["KeyW", "KeyA", "KeyS", "KeyD"];
/** Where the height and pace the player last flew at are kept, for their next flight. */
const KEPT = "earthwalk.flight";
/** A flight looks this many seconds ahead for hills and roofs. (How far it keeps above a roof is roofClear, in flightplan.js.) */
const AHEAD_S = 3;
/** How far along the way one note of the ground's height covers. */
const NOTE_M = 8;
/** While it crosses in the haze the player is kept this near the place in the scene, whatever the real distance: far-off numbers draw badly. */
const HELD_OFF_M = 18_000;
/** Where to look for clear ground to land on beside the place: metres out from it. */
const RINGS = [0, 5, 9, 14, 20, 28, 38, 50, 65, 80];
const HERE = { x: 0, z: 0 };
const wrap = (a) => ((a % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;

export class Flight {
  /**
   * @param {{ world: import("./world.js").World, player: import("./player.js").Player, say: (text: string) => void,
   *   hint: (text: string) => void }} parts
   */
  constructor(parts) {
    Object.assign(this, parts);
    /** The flight that is on, or null. */
    this.now = null;
    /** What the last flight came to, for measuring: { kind, metres, seconds, chunks, topSpeed, frames, frameMs, worstFrameMs, ended }. */
    this.last = null;
  }

  get active() {
    return !!this.now;
  }

  /** The flight from where the player is to a place ({ lat, lon }), or null when there is none to make: too near, or nowhere to take off from yet. */
  plan(place) {
    if (this.player.waitingForGround) return null;
    return planFlight(this.geo(), place);
  }

  /** The height and pace the player chose on an earlier low flight: { high, pace }, either of them null for "as the sums have it". */
  kept() {
    try {
      const was = JSON.parse(localStorage.getItem(KEPT) ?? "{}");
      return {
        high: Number.isFinite(was.high) ? Math.min(LOW_TRIM_M[1], Math.max(LOW_TRIM_M[0], was.high)) : null,
        pace: PACES.includes(was.pace) ? was.pace : null,
      };
    } catch { return { high: null, pace: null }; }
  }

  /** Sets off. `place` is { name, lat, lon }. False when there is no flight to make. */
  start(place) {
    if (this.now) this.takeOver(true); // on from where the flight that is on has got to
    const plan = this.plan(place);
    if (!plan) return false;
    const { world, player: p } = this;
    const heading = flightHeading(plan);
    const start = p.position.clone();
    const f = this.now = {
      plan, name: place.name, to: plan.to, part: plan.kind === "low" ? "low" : "up", t: 0,
      generation: world.generation, start, dir: { x: heading.east, z: heading.south }, yaw: heading.yaw,
      // A low flight ends at the place, until clear ground beside it has been found.
      end: new THREE.Vector3(start.x + plan.dx * world.tileM, 0, start.z + plan.dy * world.tileM), aim: null, land: null,
      notes: new Map(), base: null, offset: 0, alt: start.y, from: null, geo: null, tileM0: world.tileM, tileM1: world.tileM,
      looks: p.looks, left: plan.metres, was: null, words: flyingWords(place.name, plan.kind === "low" ? "low" : "up", plan.metres),
      asked: world.asked, began: performance.now(), tick: performance.now(), frames: 0, worst: 0, top: 0,
    };
    f.aim = f.end.clone();
    // A low flight goes as high and as fast as the player last had one go, until they say otherwise.
    const kept = plan.kind === "low" ? this.kept() : { high: null, pace: null };
    f.high = kept.high ?? plan.height;
    f.pace = kept.pace ?? 1;
    f.keptHigh = kept.high;
    f.held = {};
    if (plan.kind === "low") {
      // What is known of the ground and the roofs along the first of the way, so the climb clears them.
      const length = Math.hypot(f.end.x - start.x, f.end.z - start.z);
      for (let along = 0; along <= Math.min(length, 450); along += NOTE_M) this.note(f, along, length);
      const top = this.top(start.x, start.z);
      f.base = top ?? start.y;
      f.offset = start.y - f.base; // from where the player is, not from where the sums start
    }
    p.flight = this;
    p.flying = false;
    p.grounded = false;
    p.velocityY = 0;
    p.keys.clear();
    this.say(`Flying to ${shortName(place.name)}: ${farWords(plan.metres)}, ${timeWords(plan.seconds / f.pace)}. Look round with the mouse; V looks from above; W, A, S, D or Esc takes over.`
      + (plan.kind === "low" ? " Space and C take you higher and lower, 1 and 2 slower and faster." : "")
      + (plan.kind === "high" ? " High up in the middle there is only sky and haze: the land between is not drawn." : ""));
    return true;
  }

  /** The first roof under a spot, from far above, or null. */
  roofAt(x, z) {
    const hit = this.player.hit(new THREE.Vector3(x, 9000, z), DOWN, 12000);
    return hit ? hit.point.y : null;
  }

  /** What must be cleared at a spot: the ground, or a roof with room over it. Null while that part of the world has not arrived. */
  top(x, z) {
    const ground = this.world.groundHeight(x, z);
    if (ground === null) return null;
    const roof = this.roofAt(x, z);
    return roof !== null && roof > ground + 0.5 ? roof + roofClear(this.now?.high ?? 300) : ground;
  }

  /** Notes what must be cleared at a point of a low flight's way, `along` metres from its start. */
  note(f, along, length) {
    if (along < 0 || along > length || length < 1) return;
    const s = along / length;
    const top = this.top(f.start.x + (f.end.x - f.start.x) * s, f.start.z + (f.end.z - f.start.z) * s);
    if (top === null) return;
    const key = Math.round(along / NOTE_M);
    if (!(f.notes.get(key) >= top)) f.notes.set(key, top);
  }

  /**
   * Clear ground to land on beside a place in the scene: the place itself when nothing is built there,
   * else the nearest spot round it with no roof over it, on the side the flight comes from, and dry if
   * there is any. Null while the ground there has not arrived.
   */
  landing(f, x, z) {
    const { world } = this;
    const here = world.groundHeight(x, z);
    if (here === null) return null;
    const clear = (px, pz) => {
      const ground = world.groundHeight(px, pz);
      if (ground === null) return null;
      for (const [ox, oz] of [[0, 0], [1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]]) {
        const roof = this.roofAt(px + ox, pz + oz);
        if (roof !== null && roof > ground + 0.3) return null;
      }
      return { x: px, z: pz, y: ground, wet: world.waterAt(px, pz) === true };
    };
    const back = Math.atan2(-f.dir.x, f.dir.z); // the way back to where the flight came from, as an angle round the place
    let wet = null;
    for (const r of RINGS) {
      for (let k = 0; k < (r ? 12 : 1); k++) {
        // Nearest the way we came first, then round to either side.
        const turn = back + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * (Math.PI / 6);
        const spot = clear(x - Math.sin(turn) * r, z + Math.cos(turn) * r);
        if (!spot) continue;
        if (!spot.wet) return spot;
        wet ??= spot;
      }
    }
    return wet ?? { x, z, y: here, wet: false };
  }

  /** Where on Earth the flyer is. */
  geo() {
    const f = this.now;
    if (f?.geo) return { lat: f.geo.lat, lon: f.geo.lon, alt: f.alt };
    return this.world.sceneToGeo(this.player.position);
  }

  /** Where on Earth the flyer is while the scene cannot say (crossing in the haze), or null. */
  where() {
    return this.now?.geo ? this.geo() : null;
  }

  /**
   * The spot the world should be asked for round, or null for round the player as usual. A low flight
   * looks a chunk ahead, and never past the place. A high one keeps what it took off from while it
   * climbs, and from then on asks only for the place.
   */
  loadAt() {
    const f = this.now;
    if (!f) return null;
    const p = this.player.position;
    if (f.part === "up") return f.start;
    if (f.plan.kind === "high") return HERE;
    if (f.part !== "low") return null;
    const lead = Math.min(this.world.tileM, Math.hypot(f.end.x - p.x, f.end.z - p.z));
    return { x: p.x + f.dir.x * lead, z: p.z + f.dir.z * lead };
  }

  /** For the little map: where the flight is going, like the way of a ride. */
  trip() {
    const f = this.now;
    if (!f) return null;
    const p = this.player.position;
    const out = Math.min(f.left, 1e6);
    const goal = f.land ?? (f.part === "low" ? f.aim : { x: p.x + f.dir.x * out, z: p.z + f.dir.z * out });
    return { name: f.name, path: [goal], i: 0, left: f.left };
  }

  /** Every frame, before the player's own update: puts the player where the flight has got to. */
  step(dt) {
    const f = this.now;
    if (!f) return;
    const { world, player: p } = this;
    // Sent somewhere else meanwhile (Show me, a friend, home), or hopped on something: that wins, quietly.
    if (world.generation !== f.generation || p.mount || p.carried) return this.finish("left");
    if (!p.typing && HANDS.some((code) => p.keys.has(code))) return this.takeOver();
    const tick = performance.now();
    if (f.frames++) f.worst = Math.max(f.worst, tick - f.tick);
    f.tick = tick;
    // A low flight is trimmed as it goes: higher and lower while Space or C is held, a step slower or faster at each press of 1 or 2.
    if (f.part === "low" && !p.typing) {
      const up = (p.keys.has("Space") ? 1 : 0) - (p.keys.has("KeyC") ? 1 : 0);
      if (up) {
        f.high = trimHeight(f.high, up, dt);
        f.keptHigh = f.high;
        f.chose = true;
      }
      for (const [code, by] of [["Digit1", -1], ["Digit2", 1]]) {
        const down = p.keys.has(code);
        if (down && !f.held[code]) {
          f.pace = paceStep(f.pace, by);
          f.chose = true;
        }
        f.held[code] = down;
      }
    }
    f.t += f.part === "low" ? dt * f.pace : dt;
    if (f.part === "low") this.low(f, dt);
    else if (f.part === "up") this.up(f);
    else if (f.part === "over" || f.part === "wait") this.over(f, dt);
    else if (f.part === "down") this.down(f);
    else this.settle(f, dt);
    if (!this.now) return; // landed
    // How far there is to go, and how fast this is.
    const at = this.geo();
    f.left = metresBetween(at.lat, at.lon, f.to.lat, f.to.lon);
    if (f.was && dt > 0) f.top = Math.max(f.top, metresBetween(f.was.lat, f.was.lon, at.lat, at.lon) / dt);
    f.was = at;
    // Until the player looks round for themselves, the view faces the way the flight goes and tips down to the ground.
    if (p.looks === f.looks) {
      p.yaw += Math.max(-2.2 * dt, Math.min(2.2 * dt, wrap(f.yaw - p.yaw)));
      const tip = f.part === "low" ? -0.3 : f.part === "up" ? -0.5 : f.part === "down" ? -0.6 : f.part === "settle" ? -0.15 : -0.1;
      p.pitch += (tip - p.pitch) * (1 - Math.exp(-1.5 * dt));
    }
    const waiting = f.part === "wait" || (f.part === "settle" && !f.land);
    f.words = flyingWords(f.name, waiting ? "wait" : f.part, f.left, { high: f.high, pace: f.pace });
    this.hint(f.words.hint);
  }

  low(f, dt) {
    const { plan } = f;
    const p = this.player.position;
    // Clear ground beside the place, once the ground there has come: the way bends to it gently.
    if (!f.land) {
      f.land = this.landing(f, f.aim.x, f.aim.z);
      if (f.land) f.aim.set(f.land.x, 0, f.land.z);
    }
    f.end.lerp(f.aim, 1 - Math.exp(-2 * dt));
    const { s, lift } = lowAt(plan, f.t);
    const x = f.start.x + (f.end.x - f.start.x) * s, z = f.start.z + (f.end.z - f.start.z) * s;
    // The highest thing between here and a few seconds ahead: hills, and roofs with room over them.
    const length = Math.hypot(f.end.x - f.start.x, f.end.z - f.start.z);
    const along = s * length;
    const ahead = Math.min(450, Math.max(40, (Math.hypot(x - p.x, z - p.z) / Math.max(dt, 1e-3)) * AHEAD_S));
    for (const d of [0, ahead / 2, ahead]) this.note(f, along + d, length);
    let high = -Infinity;
    for (const [key, top] of f.notes) {
      const at = key * NOTE_M;
      if (at < along - 15) f.notes.delete(key);
      else if (at <= along + ahead) high = Math.max(high, top);
    }
    // (Up briskly, down at leisure: between two towers it does not dip.)
    if (high > -Infinity) f.base += (high - f.base) * (1 - Math.exp(-(high > f.base ? 4 : 0.9) * dt));
    // Not down again until the ground at the place is known.
    const held = f.land || f.t < plan.seconds / 2 ? lift : 1;
    let y = f.base + f.high * held + f.offset * (1 - smooth(f.t / 3));
    const here = f.t > 3 ? this.top(x, z) : null;
    if (here !== null && y < here + 1) y = here + 1;
    p.set(x, y, z);
    f.alt = y;
    if (f.t >= plan.seconds) this.next(f, "settle");
  }

  up(f) {
    const { plan } = f;
    const { along, lift } = climbAt(plan, f.t);
    const y = f.start.y + plan.height * lift;
    this.player.position.set(f.start.x + f.dir.x * along, y, f.start.z + f.dir.z * along);
    f.alt = y;
    if (f.t < plan.up) return;
    // Lost in the haze: the world's middle moves to the place, and what was round the start goes.
    f.tileM0 = this.world.tileM;
    this.world.setOrigin(f.to.lat, f.to.lon);
    f.generation = this.world.generation;
    f.tileM1 = this.world.tileM;
    this.next(f, "over");
    this.over(f, 0);
  }

  over(f, dt) {
    const { plan } = f;
    const waiting = f.part === "wait";
    f.geo = overAt(plan, waiting ? plan.over : f.t, f.tileM0, f.tileM1);
    // Level with what the coming down will start from, once the ground at the place is known.
    const ground = this.world.groundHeight(0, 0);
    if (ground !== null) f.alt += (ground + plan.height - f.alt) * (1 - Math.exp(-1.2 * dt));
    const out = plan.ends + HELD_OFF_M * (1 - f.geo.w);
    this.player.position.set(-f.dir.x * out, f.alt, -f.dir.z * out);
    if (!waiting && f.t < plan.over) return;
    if (ground === null) { if (!waiting) this.next(f, "wait"); return; } // the world there is still being built: wait above it
    f.geo = null;
    f.from = this.player.position.clone();
    f.land = this.landing(f, 0, 0);
    this.next(f, "down");
  }

  down(f) {
    const { plan } = f;
    const { left, lift } = descentAt(plan, f.t);
    const q = left / plan.ends;
    const x = f.land.x + (f.from.x - f.land.x) * q, z = f.land.z + (f.from.z - f.land.z) * q;
    let y = f.land.y + (f.from.y - f.land.y) * lift;
    const here = this.top(x, z);
    if (here !== null && y < here + 1) y = here + 1;
    this.player.position.set(x, y, z);
    f.alt = y;
    if (f.t >= plan.down) this.next(f, "settle");
  }

  /** The last of it: straight down onto the clear ground, slower and slower. Above a place whose ground has not come, it waits. */
  settle(f, dt) {
    const p = this.player.position;
    if (!f.land) {
      const aim = f.plan.kind === "low" ? f.aim : { x: 0, z: 0 };
      f.land = this.landing(f, aim.x, aim.z);
      if (!f.land) return;
    }
    const k = 1 - Math.exp(-4 * dt);
    p.x += (f.land.x - p.x) * k;
    p.z += (f.land.z - p.z) * k;
    const above = p.y - f.land.y;
    p.y = Math.max(f.land.y, p.y - Math.min(70, Math.max(4, above * 2.5)) * dt);
    f.alt = p.y;
    if (p.y - f.land.y > 0.02 || Math.hypot(f.land.x - p.x, f.land.z - p.z) > 0.3) return;
    p.set(f.land.x, f.land.y, f.land.z);
    this.landed(f);
  }

  next(f, part) {
    f.part = part;
    f.t = 0;
  }

  landed(f) {
    const p = this.player;
    this.finish("landed");
    p.flying = false;
    p.grounded = true;
    p.velocityY = 0;
    if (p.looks === f.looks) {
      // Facing the place, when the landing is beside it and not on it.
      const place = f.plan.kind === "low" ? f.end : { x: 0, z: 0 };
      const dx = place.x - p.position.x, dz = place.z - p.position.z;
      if (Math.hypot(dx, dz) > 1.5) p.yaw = Math.atan2(dx, -dz);
      p.pitch = 0;
    }
    this.say(`Here we are: ${shortName(f.name)}.`);
  }

  /** A movement key, F or Esc: the player has it, flying where they are. (`quiet`: without a word, when another flight is about to start.) */
  takeOver(quiet = false) {
    const f = this.now;
    if (!f) return false;
    const p = this.player;
    const high = f.plan.kind === "high" && (!!f.geo || (f.part === "up" && f.t > 5) || (f.part === "down" && f.t < 5));
    if (f.geo) {
      // Crossing in the haze: the world comes to where they really are.
      const at = f.geo;
      this.world.setOrigin(at.lat, at.lon);
      p.position.set(0, f.alt, 0);
    }
    this.finish("taken over");
    p.flying = true;
    p.grounded = false;
    p.velocityY = 0;
    p.waitingForGround = false;
    if (!quiet) this.say("You have taken over, and are flying where you were. W, A, S and D move you, Space and C go up and down, Shift is fast, and F drops you to the ground."
      + (high ? " You are high in the haze: hold C to come down to where the land is drawn." : ""));
    return true;
  }

  /** The flight is over, however it ended: what it came to is kept for measuring. */
  finish(ended) {
    const f = this.now;
    if (!f) return;
    this.now = null;
    this.player.flight = null;
    // How they trimmed it is how the next one sets off. (A height they never touched stays "as the sums have it".)
    if (f.chose) { try { localStorage.setItem(KEPT, JSON.stringify({ high: f.keptHigh, pace: f.pace })); } catch { /* no storage: next time as the sums have it */ } }
    const seconds = (performance.now() - f.began) / 1000;
    this.last = {
      kind: f.plan.kind, name: f.name, metres: Math.round(f.plan.metres), planned: +f.plan.seconds.toFixed(1), seconds: +seconds.toFixed(1),
      chunks: this.world.asked - f.asked, mostChunks: f.plan.chunks, topSpeed: Math.round(f.top),
      frames: f.frames, frameMs: +((seconds * 1000) / Math.max(1, f.frames)).toFixed(2), worstFrameMs: +f.worst.toFixed(1), ended,
    };
    this.hint("");
  }
}
