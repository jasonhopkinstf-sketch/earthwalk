// Doing as asked. Talk to a thing (T) and tell it what to do: "follow me", "come here", "stay",
// "go home", "do a trick", "make your noise", or, to something you are riding, "take me to the
// beach". The server decides what was asked (docs/PROTOCOL.md, "Doing as asked") and this draws it:
//
// - A thing told to follow, come or stay leaves its timetable and is drawn here, like a thing left
//   standing by its rider. Every game works it out from the same order, so friends agree to within a
//   step or two.
// - A trick or a noise is done once, on the spot.
// - "Take me to" belongs to the rider: their own game drives them there, along the road when the
//   server found a way, straight across country on an animal, or in one jump when it is far.

import { MOUNTS } from "./riding.js";
import { RIGS } from "./liferigs.js";

/** How fast a thing walks when told to come or follow, by kind; the rest amble. */
const PACE = { zebra: 7, reindeer: 7, fox: 6, donkey: 4, goat: 4, pig: 3, monkey: 5, elephant: 4, giraffe: 5, bison: 4, moose: 5, bear: 4, lion: 6, mouse: 3, frog: 3, snail: 0.1, tortoise: 0.4, horse: 7, deer: 7, kangaroo: 7, dog: 6, cat: 4.5, rabbit: 5, cow: 3, sheep: 3.5, camel: 4, llama: 4, chicken: 3, duck: 2.5, pigeon: 3, squirrel: 5, penguin: 2 };
const AMBLE = 3;
/** A follower stops this far short of whoever it follows, and gives up the chase for a jump beyond `LOST_M`. */
const HEEL_M = 2.4;
const LOST_M = 120;
const TRICK_S = 1.7;
/** Straight across country is for short trips; anything longer is one jump. */
const CROSS_COUNTRY_M = 1500;
const ARRIVED_M = 6;

export class Orders {
  /**
   * @param {{ world: import("./world.js").World, player: import("./player.js").Player, meetup: import("./net.js").Meetup,
   *   avatars: import("./avatars.js").Avatars, life: import("./life.js").Life, traffic: import("./traffic.js").Traffic,
   *   riding: import("./riding.js").Riding, say: (text: string) => void }} parts
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.poses = new Map(); // thing -> where an ordered thing has got to: { x, z, yaw, d, at }
    this.tricks = new Map(); // thing -> { sp, kind, start, x, z, yaw } for the moment a trick lasts
    this.trip = null; // where I am being taken: { thing, sp, name, x, z, path, i }
    this.remount = null; // what to get back on after a jump
    this.meetup.addEventListener("order", (e) => this.onOrder(e.detail));
    this.riding.extras.push((dt, t) => this.frame(dt, t));
  }

  /** Where a member of the room is in the scene: me, or a friend this game can see. */
  whereIs(id) {
    if (id === this.meetup.me?.id) return this.player.position;
    return this.avatars.shown.get(id)?.group.position ?? null;
  }

  /** Where a thing is right now, as this game has it: ordered about, ridden or left, or on its timetable. */
  find(thing, sp) {
    const pose = this.poses.get(thing);
    if (pose) return pose;
    for (const m of this.riding.mounts) if (m.thing === thing) return m;
    for (const c of [...this.life.nearby, ...this.traffic.rideable]) if (c.thing === thing && c.sp === sp) return c;
    return null;
  }

  onOrder(o) {
    if (typeof o?.thing !== "number" || typeof o.sp !== "string") return;
    if (o.act === "trick" || o.act === "noise") {
      const at = this.find(o.thing, o.sp);
      if (!at) return; // too far off to see or hear
      this.life.speak(o.sp, o.thing, at.x, at.z);
      if (o.act === "trick" && RIGS[o.sp]) this.tricks.set(o.thing, { sp: o.sp, start: performance.now() / 1000, x: at.x, z: at.z, yaw: at.yaw ?? 0 });
    } else if (o.act === "goto") this.setOff(o);
    else if (o.act === "home") this.poses.delete(o.thing);
  }

  /** The thing I am riding has agreed to take me somewhere. */
  setOff(o) {
    const mine = this.riding.mine;
    if (!mine || mine.thing !== o.thing || mine.seat !== 0 || typeof o.lat !== "number") return;
    const p = this.player;
    const target = this.world.geoToScene(o.lat, o.lon);
    const far = Math.hypot(target.x - p.position.x, target.z - p.position.z);
    const path = Array.isArray(o.path) && o.path.length > 1 ? o.path.map(([lat, lon]) => this.world.geoToScene(lat, lon)) : null;
    // A car keeps to roads, so without a way by road it jumps; an animal or a tractor can cut across country.
    if (path || (far <= CROSS_COUNTRY_M && !mine.mount.afloat && mine.sp !== "car" && mine.sp !== "taxi")) {
      // Join the way at its nearest point: whoever boards a taxi before it has pulled up is not driven back to where they called it.
      let i = 0;
      if (path) for (let k = 1; k < path.length; k++) if (Math.hypot(path[k].x - p.position.x, path[k].z - p.position.z) < Math.hypot(path[i].x - p.position.x, path[i].z - p.position.z)) i = k;
      this.trip = { thing: o.thing, sp: o.sp, name: o.name, path: path ?? [target], i, end: { lat: o.lat, lon: o.lon } };
      this.say(`${path ? "Driving" : "Riding"} to ${o.name}. Steer (WASD) to take over.`);
    } else {
      // Too far to go by road in this lifetime: one jump, and back on at the other end.
      this.say(`Off to ${o.name}!`);
      this.remount = { thing: o.thing, sp: o.sp };
      this.riding.off();
      p.travelTo(o.lat, o.lon);
    }
  }

  /** Before the player moves each frame: steers them along the way when they are being taken somewhere. */
  steer(dt) {
    const p = this.player;
    p.autopilot = null;
    if (this.remount && !p.waitingForGround) {
      // Arrived by jump: get back on, here.
      const { thing, sp } = this.remount;
      this.remount = null;
      this.riding.wanted = { thing, sp, x: p.position.x, z: p.position.z, yaw: -p.yaw, k: 0 };
      this.riding.wantedAt = performance.now();
      this.meetup.sendRide(thing, sp);
    }
    const trip = this.trip;
    if (!trip) return;
    const mine = this.riding.mine;
    const k = p.keys;
    if (!mine || mine.thing !== trip.thing || p.waitingForGround) { this.trip = null; return; }
    if (!p.typing && (k.has("KeyW") || k.has("KeyS") || k.has("KeyA") || k.has("KeyD"))) {
      this.trip = null;
      this.say("You have the reins again.");
      return;
    }
    // Getting no nearer for five seconds (a wall in the way, a part of the world that will not load):
    // do the rest in one jump. Getting nearer means passing a point of the way, or closing on the next.
    const ahead = trip.path[trip.i];
    const short = (trip.path.length - trip.i) * 1000 + Math.hypot(ahead.x - p.position.x, ahead.z - p.position.z);
    if (trip.best === undefined || short < trip.best - 1.5) { trip.best = short; trip.held = 0; } else trip.held = (trip.held ?? 0) + dt;
    if (trip.held > 5 && trip.end) {
      this.trip = null;
      this.say(`The road gave out. Off to ${trip.name} the quick way!`);
      this.remount = { thing: trip.thing, sp: trip.sp };
      this.riding.off();
      p.travelTo(trip.end.lat, trip.end.lon);
      return;
    }
    // Aim a little way ahead along the path, so corners are rounded and not jerked through.
    while (trip.i < trip.path.length - 1 && Math.hypot(trip.path[trip.i].x - p.position.x, trip.path[trip.i].z - p.position.z) < 7) trip.i++;
    const aim = trip.path[trip.i];
    const dx = aim.x - p.position.x, dz = aim.z - p.position.z;
    const left = Math.hypot(dx, dz);
    if (trip.i === trip.path.length - 1 && left < ARRIVED_M) {
      this.trip = null;
      this.say(`Here we are: ${trip.name}.`);
      return;
    }
    p.autopilot = { dx: dx / left, dz: dz / left, pace: left < 20 && trip.i === trip.path.length - 1 ? 0.4 : 0.8 };
    // Turn to face the way we are going, a little each frame, so the view follows the road.
    const want = Math.atan2(dx, -dz);
    const turn = ((want - p.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    p.yaw += Math.max(-2.2 * dt, Math.min(2.2 * dt, turn));
  }

  /** From Riding.frame, once it knows what is ridden: adds everything doing as it was told to what is drawn in place of the timetable. */
  frame(dt, t) {
    const { world, meetup, riding } = this;
    const now = t * 1000;
    const stand = (thing, sp, pose, moving, lift = 0, spin = 0) => {
      const y = world.groundHeight(pose.x, pose.z);
      riding.hidden.add(thing);
      if (y !== null) riding.mounts.push({ key: "", thing, sp, x: pose.x, z: pose.z, y: y + lift, yaw: pose.yaw + spin, gait: pose.d ?? 0, moving });
    };

    for (const [thing, o] of meetup.orders) {
      if (o.until <= now) { meetup.orders.delete(thing); this.poses.delete(thing); continue; }
      if (riding.hidden.has(thing)) { this.poses.delete(thing); continue; } // somebody is riding it
      if (!RIGS[o.sp] && !MOUNTS[o.sp]) continue;
      let pose = this.poses.get(thing);
      if (!pose || pose.at !== o.at) {
        // A new order: carry on from where it stands if this game has been drawing it, else from where it was when told.
        const from = pose ?? world.geoToScene(o.lat, o.lon);
        this.poses.set(thing, (pose = { x: from.x, z: from.z, yaw: pose?.yaw ?? 0, d: pose?.d ?? 0, at: o.at }));
      }
      let goal = null;
      let stopAt = 0.3;
      if (o.act === "follow") { goal = this.whereIs(o.by); stopAt = HEEL_M; }
      else if (o.act === "come" && Array.isArray(o.to)) { goal = world.geoToScene(o.to[0], o.to[1]); stopAt = 1.6; }
      let moving = false;
      if (goal) {
        const dx = goal.x - pose.x, dz = goal.z - pose.z;
        const left = Math.hypot(dx, dz);
        if (left > LOST_M) { pose.x = goal.x - (dx / left) * HEEL_M; pose.z = goal.z - (dz / left) * HEEL_M; } // left far behind: catch up in one go
        else if (left > stopAt) {
          const pace = (PACE[o.sp] ?? AMBLE) * (left > 12 ? 1.6 : 1); // hurry when left behind
          const step = Math.min(left - stopAt, pace * dt);
          pose.x += (dx / left) * step;
          pose.z += (dz / left) * step;
          pose.d += step;
          pose.yaw = Math.atan2(-dx, -dz); // facing the way it walks
          moving = step > 0.001;
        }
      }
      const trick = this.tricks.get(thing);
      const u = trick ? (performance.now() / 1000 - trick.start) / TRICK_S : 2;
      if (trick && u >= 1) this.tricks.delete(thing);
      stand(thing, o.sp, pose, moving, u < 1 ? Math.sin(u * Math.PI) * 1.1 : 0, u < 1 ? u * Math.PI * 2 : 0);
    }
    for (const thing of this.poses.keys()) if (!meetup.orders.has(thing)) this.poses.delete(thing);

    // Tricks by things that are otherwise going about their business: up, round, and back to it.
    for (const [thing, trick] of this.tricks) {
      if (meetup.orders.has(thing)) continue;
      const u = (performance.now() / 1000 - trick.start) / TRICK_S;
      if (u >= 1 || riding.hidden.has(thing)) { this.tricks.delete(thing); continue; }
      stand(thing, trick.sp, { x: trick.x, z: trick.z, yaw: trick.yaw, d: 0 }, false, Math.sin(u * Math.PI) * 1.1, u * Math.PI * 2);
    }
  }
}
