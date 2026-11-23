// Riding: hop on a horse, a tractor, a boat, a car or a passing train.
//
// A ridden thing belongs to its rider. While someone rides it, their game moves it (it simply goes
// where they go) and everyone else draws it under them, using the positions players already share.
// The server only keeps track of who is on what, and of things left standing where a rider got off
// (docs/PROTOCOL.md, "Riding"). A train is different: it keeps to its timetable and carries you.

import { newCar } from "./cardrive.js";
import { VIEWS } from "./player.js";

/**
 * What can be ridden: pace in metres a second (hold Shift for all of it), how high the rider sits,
 * what to call it, and how near you must be to hop on. `afloat` keeps to water; the rest keep off it.
 * `drive` is for things with an engine, which are driven, not ridden (player.js): top speed forwards and
 * in reverse (metres a second), how hard it pulls and brakes (metres a second, each second), the distance
 * between its axles, and its grip (how quickly a slide sideways is taken up).
 */
export const MOUNTS = {
  horse: { speed: 10, seat: 1.55, name: "horse" },
  cow: { speed: 4, seat: 1.3, name: "cow" },
  sheep: { speed: 4.5, seat: 0.92, name: "sheep" },
  camel: { speed: 5.5, seat: 2.05, name: "camel" },
  llama: { speed: 5, seat: 1.2, name: "llama" },
  kangaroo: { speed: 9, seat: 1.0, name: "kangaroo" },
  deer: { speed: 9, seat: 1.05, name: "deer" },
  donkey: { speed: 6, seat: 1.15, name: "donkey" },
  pig: { speed: 4, seat: 0.6, name: "pig" },
  goat: { speed: 5, seat: 0.75, name: "goat" },
  zebra: { speed: 10, seat: 1.3, name: "zebra" },
  elephant: { speed: 5, seat: 2.75, name: "elephant", reach: 4.5 },
  giraffe: { speed: 8, seat: 2.7, name: "giraffe", reach: 4 },
  bison: { speed: 7, seat: 1.6, name: "bison" },
  moose: { speed: 8, seat: 1.95, name: "moose" },
  reindeer: { speed: 9, seat: 1.25, name: "reindeer" },
  bear: { speed: 6, seat: 1.2, name: "bear" },
  lion: { speed: 9, seat: 1.05, name: "lion" },
  panda: { speed: 3, seat: 0.95, name: "panda" },
  tortoise: { speed: 0.6, seat: 0.3, name: "tortoise" },
  tractor: { speed: 5, seat: 2.12, name: "tractor", reach: 4, drive: { top: 9, reverse: 3.5, pull: 3.2, brake: 9, base: 2.3, grip: 10 } },
  car: { speed: 13, seat: 1.5, name: "car", reach: 3.5, drive: { top: 27, reverse: 7, pull: 7.5, brake: 17, base: 2.6, grip: 7 } }, // the rider sits up on the roof
  taxi: { speed: 13, seat: 1.5, name: "taxi", reach: 4, drive: { top: 27, reverse: 7, pull: 7.5, brake: 17, base: 2.6, grip: 7 } },
  boat: { speed: 2.5, seat: 0.3, name: "rowing boat", reach: 4, afloat: true },
  sailboat: { speed: 5, seat: 0.75, name: "sailing boat", reach: 6, afloat: true },
  train: { seat: 3.5, name: "train", reach: 8 },
};
const REACH_M = 3;

export class Riding {
  /**
   * @param {{ world: import("./world.js").World, player: import("./player.js").Player, meetup: import("./net.js").Meetup,
   *   avatars: import("./avatars.js").Avatars, life: import("./life.js").Life, traffic: import("./traffic.js").Traffic,
   *   hint: (text: string) => void, say: (text: string) => void }} parts
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.mine = null; // what I am on: { thing, sp, seat, mount, k }
    this.wanted = null; // what I have asked the server for
    this.wantedAt = 0;
    this.near = null; // what E would hop on right now
    this.hidden = new Set(); // identities drawn here instead of where their timetable has them
    this.mounts = []; // ridden and left things to draw this frame
    this.gaits = new Map(); // how far each has gone, for swinging legs
    this.extras = []; // others with things to draw in place of the timetable: orders.js, taxi.js
    this.meetup.addEventListener("ride", (e) => this.onRide(e.detail));
    this.meetup.addEventListener("ridefail", () => { this.wanted = null; });
  }

  rides(sp) {
    return sp in MOUNTS;
  }

  /** The E key: hop off, or hop on whatever is nearest. */
  key() {
    if (this.mine) return this.off();
    if (this.wanted || !this.near || !this.meetup.joined) return;
    this.wanted = this.near;
    this.wantedAt = performance.now();
    this.meetup.sendRide(this.near.thing, this.near.sp);
  }

  /** The server's word on what I am riding: the go-ahead to hop on, or (null) that I am off. */
  onRide(ride) {
    if (!ride) {
      if (this.mine) this.land(); // the driver got off, so the passengers do too
      return;
    }
    const mount = MOUNTS[ride.sp];
    if (!mount) return;
    const from = this.wanted?.thing === ride.thing ? this.wanted : null;
    this.wanted = null;
    this.mine = { ...ride, mount, k: from?.k ?? 0, lost: 0 };
    const p = this.player;
    p.flying = false;
    p.velocityY = 0;
    if (ride.sp === "train" || ride.seat > 0) {
      p.carried = true; // the train, or the friend who is steering, moves me
    } else {
      p.mount = mount;
      p.travelled = 0;
      if (from) {
        p.position.x = from.x;
        p.position.z = from.z;
        p.yaw = -from.yaw;
      }
      // Something with an engine is driven: it has a heading and a speed of its own, and the camera stands back.
      if (mount.drive) p.car = newCar(p.yaw);
    }
    p.setView(0);
    this.say(ride.seat > 0 && ride.sp !== "train" ? `You are riding along on the ${mount.name}. Press E to hop off, V to look from above.`
      : mount.drive && ride.seat === 0 ? `You are driving the ${mount.name}: W and S for the pedals, A and D to steer, Space for the handbrake, the mouse to look round. Press E to get out, V to look from above.`
      : `You are on the ${mount.name}. Press E to hop off, V to look from above.`);
  }

  /** Hop off, and tell everyone. */
  off() {
    if (!this.mine) return;
    this.meetup.sendDismount();
    this.land();
  }

  land() {
    const p = this.player;
    const side = this.mine.sp === "train" ? 3.5 : 1.6; // step down to the right
    this.mine = null;
    p.mount = null;
    p.carried = false;
    if (p.view) p.setView(0);
    if (p.car) { p.yaw = p.car.heading; p.pitch = 0; p.car = null; }
    p.position.x += Math.cos(p.yaw) * side;
    p.position.z += Math.sin(p.yaw) * side;
    p.grounded = false;
    p.velocityY = 0;
  }

  /** Every frame, before the animals and cars are drawn. `t` is the shared clock in seconds. */
  frame(dt, t) {
    const { player: p, world, meetup, avatars } = this;
    if (this.mine && p.waitingForGround) this.off(); // travelled somewhere else
    if (this.wanted && performance.now() - this.wantedAt > 3000) this.wanted = null;
    const me = this.mine;

    // ---- being carried: by a train, or by the friend who is steering
    if (me?.sp === "train") {
      const at = this.traffic.carriageAt(me.thing, me.k, t);
      if (at) p.position.set(at.x, at.y + me.mount.seat, at.z);
      else this.off(); // the train has gone where this game cannot follow
    } else if (me && me.seat > 0) {
      let driver = null;
      for (const [id, peer] of meetup.peers) if (peer.ride?.thing === me.thing && peer.ride.seat === 0) driver = avatars.shown.get(id);
      if (driver) {
        me.lost = 0;
        const g = driver.group; // sit behind them
        p.position.set(g.position.x + Math.sin(g.rotation.y) * 0.7 * me.seat, g.position.y, g.position.z + Math.cos(g.rotation.y) * 0.7 * me.seat);
      } else if ((me.lost += dt) > 3) this.off();
    }

    // ---- everything being ridden, and everything left standing where its rider got off
    this.hidden.clear();
    this.mounts.length = 0;
    const ridden = (key, thing, sp, x, z, fallbackY, yaw) => {
      let g = this.gaits.get(key);
      if (!g || g.thing !== thing) this.gaits.set(key, (g = { thing, x, z, d: 0 }));
      const step = Math.hypot(x - g.x, z - g.z);
      if (step < 5) g.d += step;
      g.x = x;
      g.z = z;
      this.hidden.add(thing);
      // (The floor under it, which on a bridge is the deck and in a tunnel the tunnel's: not the ground far below, or overhead.)
      this.mounts.push({ key, thing, sp, x, z, y: world.floorAt(x, z, fallbackY) ?? fallbackY, yaw, gait: g.d, moving: dt > 0 && step / dt > 0.2 });
    };
    if (me && me.seat === 0 && me.sp !== "train") {
      ridden("me", me.thing, me.sp, p.position.x, p.position.z, p.position.y - me.mount.seat, -p.yaw);
      if (p.car) this.tilt(this.mounts[this.mounts.length - 1], p.car);
    }
    for (const [id, peer] of meetup.peers) {
      const r = peer.ride;
      if (!r || r.seat !== 0 || r.sp === "train" || !MOUNTS[r.sp]) continue;
      const shown = avatars.shown.get(id);
      if (shown) ridden(id, r.thing, r.sp, shown.group.position.x, shown.group.position.z, shown.group.position.y - MOUNTS[r.sp].seat, shown.group.rotation.y);
      else this.hidden.add(r.thing); // ridden off somewhere out of sight
    }
    for (const [thing, left] of meetup.left) {
      if (left.until <= t * 1000) { meetup.left.delete(thing); continue; } // time to go home: its timetable has it again
      if (this.hidden.has(thing) || !MOUNTS[left.sp]) continue;
      const at = world.geoToScene(left.lat, left.lon);
      const y = world.groundHeight(at.x, at.z);
      this.hidden.add(thing);
      if (y !== null) this.mounts.push({ key: "", thing, sp: left.sp, x: at.x, z: at.z, y, yaw: (-left.yaw * Math.PI) / 180, gait: 0, moving: false });
    }
    if (this.gaits.size > 64) this.gaits.clear();
    for (const extra of this.extras) extra(dt, t); // and everything doing as it was told, and taxis on their way

    // ---- what would E hop on?
    this.near = null;
    if (!me && !this.wanted && !p.flying && !p.waitingForGround) {
      let best = Infinity;
      const consider = (c) => {
        const mount = MOUNTS[c.sp];
        if (!mount) return;
        const d = Math.hypot(c.x - p.position.x, c.z - p.position.z);
        if (d < (c.reach ?? mount.reach ?? REACH_M) && d < best) { best = d; this.near = c; }
      };
      for (const c of this.life.rideable) consider(c);
      for (const c of this.traffic.rideable) consider(c);
      for (const m of this.mounts) if (m.key !== "me" && !m.noRide) consider(m); // one left standing, or a friend's, to ride along on
    }
    this.hint(me ? `E: hop off the ${me.mount.name} · V: ${VIEWS[(p.view + 1) % VIEWS.length].name}` : this.near ? `E: ${this.near.key ? "ride along on" : "hop on"} the ${MOUNTS[this.near.sp].name}` : "");
  }

  /** A driven car sits to the slope of the ground under its wheels, leans out of a bend, and dips its nose under braking. */
  tilt(m, car) {
    const { world } = this;
    const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
    const h = (along, across) => world.floorAt(m.x + sin * along + cos * across, m.z - cos * along + sin * across, m.y) ?? m.y;
    const slope = Math.atan2(h(1.3, 0) - h(-1.3, 0), 2.6);
    const bank = Math.atan2(h(0, 0.8) - h(0, -0.8), 1.6);
    const lean = Math.max(-0.09, Math.min(0.09, car.turn * car.speed * 0.006));
    m.pitch = Math.max(-0.5, Math.min(0.5, slope));
    m.roll = Math.max(-0.4, Math.min(0.4, -bank)) + lean;
  }

  /** From Life.update: draws everything in `mounts` through Life's meshes. */
  draw(life, t, counts) {
    for (const m of this.mounts) {
      if (m.sp === "car" || m.sp === "taxi") this.traffic.putMount(life, m, t, counts);
      else life.putMount(m, t, counts);
    }
  }
}
