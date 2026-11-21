// Riding: hop on a horse, a tractor, a boat, a car or a passing train.
//
// A ridden thing belongs to its rider. While someone rides it, their game moves it (it simply goes
// where they go) and everyone else draws it under them, using the positions players already share.
// The server only keeps track of who is on what, and of things left standing where a rider got off
// (docs/PROTOCOL.md, "Riding"). A train is different: it keeps to its timetable and carries you.

/**
 * What can be ridden: pace in metres a second (hold Shift for all of it), how high the rider sits,
 * what to call it, and how near you must be to hop on. `afloat` keeps to water; the rest keep off it.
 */
export const MOUNTS = {
  horse: { speed: 10, seat: 1.55, name: "horse" },
  cow: { speed: 4, seat: 1.3, name: "cow" },
  sheep: { speed: 4.5, seat: 0.92, name: "sheep" },
  camel: { speed: 5.5, seat: 2.05, name: "camel" },
  llama: { speed: 5, seat: 1.2, name: "llama" },
  kangaroo: { speed: 9, seat: 1.0, name: "kangaroo" },
  deer: { speed: 9, seat: 1.05, name: "deer" },
  tractor: { speed: 5, seat: 1.35, name: "tractor", reach: 4 },
  car: { speed: 13, seat: 0.5, name: "car", reach: 3.5 },
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
    }
    this.say(ride.seat > 0 && ride.sp !== "train" ? `You are riding along on the ${mount.name}. Press E to hop off.` : `You are on the ${mount.name}. Press E to hop off.`);
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
      this.mounts.push({ key, thing, sp, x, z, y: world.groundHeight(x, z) ?? fallbackY, yaw, gait: g.d, moving: dt > 0 && step / dt > 0.2 });
    };
    if (me && me.seat === 0 && me.sp !== "train") ridden("me", me.thing, me.sp, p.position.x, p.position.z, p.position.y - me.mount.seat, -p.yaw);
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
      for (const m of this.mounts) if (m.key !== "me") consider(m); // one left standing, or a friend's, to ride along on
    }
    this.hint(me ? `E: hop off the ${me.mount.name}` : this.near ? `E: ${this.near.key ? "ride along on" : "hop on"} the ${MOUNTS[this.near.sp].name}` : "");
  }

  /** From Life.update: draws everything in `mounts` through Life's meshes. */
  draw(life, t, counts) {
    for (const m of this.mounts) {
      if (m.sp === "car") this.traffic.putMount(life, m, t, counts);
      else life.putMount(m, t, counts);
    }
  }
}
