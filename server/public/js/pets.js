// Companions. Solving a riddle wins its answer as an animal that keeps you company (passport.js
// chooses one; docs/PROTOCOL.md, "Riddles and companions"). It trots after its player wherever
// they go, friends see it, and it can be talked to and, if it is big enough, ridden.
//
// Every game works a companion out for itself from where its player is, so friends agree to within
// a step or two. It is drawn like anything else that has left its timetable (riding.js).

import * as THREE from "three";
import { MOUNTS } from "./riding.js";
import { RIGS } from "./liferigs.js";

/** How fast each kind keeps up, in metres a second; anything not listed trots at `TROT`. */
const PACE = { snail: 1.5, tortoise: 1.8, ladybird: 2, crab: 3, frog: 4, mouse: 4, hedgehog: 3, penguin: 3, duck: 3.5, goose: 4, cow: 5, panda: 4.5, koala: 3 };
const TROT = 7;
const LOST_M = 60;
/** Tricks (train.js teaches them): how long each takes, in seconds. */
const TRICK_S = { sit: 2.6, spin: 1.7, jump: 1.5, bow: 2.2, fetch: 4.2, hoop: 2.2, dance: 3.6 };
const FETCH_M = 7;
const HOOP_M = 4.4;
const BALL = new THREE.SphereGeometry(0.14, 12, 8);
const BALL_RED = new THREE.MeshLambertMaterial({ color: 0xd9382e });
const HOOP = new THREE.TorusGeometry(0.8, 0.06, 8, 24);
const HOOP_GOLD = new THREE.MeshLambertMaterial({ color: 0xe0b23c });
/** Up to full and back again, holding in between. */
const hold = (u) => Math.min(1, u * 5, (1 - u) * 5);

export class Pets {
  /**
   * @param {{ world: import("./world.js").World, player: import("./player.js").Player, meetup: import("./net.js").Meetup,
   *   avatars: import("./avatars.js").Avatars, riding: import("./riding.js").Riding }} parts
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.poses = new Map(); // thing -> { x, z, yaw, d }
    this.acts = new Map(); // thing -> the trick it is doing: { trick, start, prop }
    this.hops = new Map(); // thing -> when it took off: a leap in its stride, over a jump of an agility course (race.js)
    this.riding.extras.push((dt) => this.frame(dt));
    this.meetup.addEventListener("trick", (e) => {
      if (!TRICK_S[e.detail.trick]) return;
      this.drop(e.detail.thing);
      this.acts.set(e.detail.thing, { trick: e.detail.trick, start: performance.now() / 1000, prop: null, said: false });
    });
  }

  /** The companion of a member of the room leaps as it runs: it has come to a jump. */
  hop(memberId) {
    const pet = memberId === this.meetup.me?.id ? this.meetup.me?.pet : this.meetup.peers.get(memberId)?.pet;
    if (pet) this.hops.set(pet.thing, performance.now() / 1000);
  }

  /** Ends a trick, and takes away the ball or the hoop it was done with. */
  drop(thing) {
    const act = this.acts.get(thing);
    if (act?.prop) this.scene?.remove(act.prop);
    this.acts.delete(thing);
  }

  /**
   * A companion in the middle of a trick: where it is drawn and how, `u` of the way through (0 to 1). `pose`
   * is where it stood when it began; some tricks move it on from there.
   */
  perform(act, u, pose, y, pet) {
    const out = { x: pose.x, z: pose.z, yaw: pose.yaw, lift: 0, tip: 0, lean: 0, gait: pose.d, moving: false };
    const fx = -Math.sin(pose.yaw), fz = -Math.cos(pose.yaw); // the way it faces
    switch (act.trick) {
      case "sit": out.tip = 0.6 * hold(u); break;
      case "bow": out.tip = -0.5 * hold(u); break;
      case "spin": out.yaw = pose.yaw + u * Math.PI * 4; break;
      case "jump": out.lift = Math.abs(Math.sin(u * Math.PI * 2)) * 1.1; break;
      case "dance":
        out.x += Math.cos(pose.yaw) * Math.sin(u * Math.PI * 6) * 0.5;
        out.z += -Math.sin(pose.yaw) * Math.sin(u * Math.PI * 6) * 0.5;
        out.lift = Math.abs(Math.sin(u * Math.PI * 12)) * 0.28;
        out.lean = Math.sin(u * Math.PI * 6) * 0.25;
        out.yaw = pose.yaw + Math.sin(u * Math.PI * 4) * 0.6;
        break;
      case "fetch": {
        // Out to the ball and back with it.
        const s = FETCH_M * (u < 0.5 ? u * 2 : (1 - u) * 2);
        out.x += fx * s;
        out.z += fz * s;
        if (u >= 0.5) out.yaw = pose.yaw + Math.PI;
        out.moving = true;
        out.gait = pose.d + FETCH_M * 2 * u;
        if (!act.prop && this.scene) {
          act.prop = new THREE.Mesh(BALL, BALL_RED);
          act.prop.position.set(pose.x + fx * (FETCH_M + 0.5), y + 0.14, pose.z + fz * (FETCH_M + 0.5));
          this.scene.add(act.prop);
        }
        if (act.prop) act.prop.visible = u < 0.5;
        break;
      }
      case "hoop": {
        // A run and a leap through a hoop that stands in its way.
        out.x += fx * HOOP_M * u;
        out.z += fz * HOOP_M * u;
        out.lift = Math.sin(u * Math.PI) * 0.95;
        out.moving = true;
        out.gait = pose.d + HOOP_M * u;
        if (!act.prop && this.scene) {
          act.prop = new THREE.Mesh(HOOP, HOOP_GOLD);
          act.prop.position.set(pose.x + fx * HOOP_M * 0.5, y + 1.05, pose.z + fz * HOOP_M * 0.5);
          act.prop.rotation.y = pose.yaw;
          this.scene.add(act.prop);
        }
        break;
      }
    }
    if (!act.said) {
      act.said = true;
      this.riding.life?.speak?.(pet.sp, pet.thing, pose.x, pose.z); // and it says so
    }
    return out;
  }

  frame(dt) {
    const { world, meetup, riding, avatars, player } = this;
    const live = new Set();
    const keep = (pet, owner) => {
      if (!pet || !owner || (!RIGS[pet.sp] && !MOUNTS[pet.sp])) return;
      live.add(pet.thing);
      if (riding.hidden.has(pet.thing)) { this.poses.delete(pet.thing); return; } // being ridden: riding.js draws it
      let pose = this.poses.get(pet.thing);
      // A little behind and to one side of its player, so it is in view when they look round.
      const heel = MOUNTS[pet.sp] ? 2.6 : 1.6; // the big ones keep a little further off
      const dx = owner.x - (pose?.x ?? owner.x - heel), dz = owner.z - (pose?.z ?? owner.z);
      const left = Math.hypot(dx, dz);
      if (!pose || left > LOST_M) this.poses.set(pet.thing, (pose = { x: owner.x - (left > 0 ? (dx / left) * heel : heel), z: owner.z - (left > 0 ? (dz / left) * heel : 0), yaw: pose?.yaw ?? 0, d: 0 }));
      let moving = false;
      // In the middle of a trick it stays where it began, and is drawn doing it.
      const act = this.acts.get(pet.thing);
      if (act) {
        const u = (performance.now() / 1000 - act.start) / TRICK_S[act.trick];
        const y = world.groundHeight(pose.x, pose.z);
        if (u < 1 && y !== null) {
          const show = this.perform(act, u, pose, y, pet);
          riding.hidden.add(pet.thing);
          riding.mounts.push({ key: "", thing: pet.thing, sp: pet.sp, x: show.x, z: show.z, y: (world.groundHeight(show.x, show.z) ?? y) + show.lift, yaw: show.yaw, gait: show.gait, moving: show.moving, tip: show.tip, lean: show.lean });
          return;
        }
        if (act.trick === "hoop") { pose.x += -Math.sin(pose.yaw) * HOOP_M; pose.z += -Math.cos(pose.yaw) * HOOP_M; } // it landed further on
        this.drop(pet.thing);
      }
      if (left > heel && left <= LOST_M) {
        const pace = (PACE[pet.sp] ?? TROT) * (left > 8 ? 2.2 : 1); // hurry when left behind
        const step = Math.min(left - heel, pace * dt);
        pose.x += (dx / left) * step;
        pose.z += (dz / left) * step;
        pose.d += step;
        pose.yaw = Math.atan2(-dx, -dz);
        moving = step > 0.001;
      }
      const y = world.groundHeight(pose.x, pose.z);
      riding.hidden.add(pet.thing);
      const took = this.hops.get(pet.thing);
      const air = took === undefined ? 1 : (performance.now() / 1000 - took) / 0.7;
      if (air >= 1) this.hops.delete(pet.thing);
      if (y !== null) riding.mounts.push({ key: "", thing: pet.thing, sp: pet.sp, x: pose.x, z: pose.z, y: y + (air < 1 ? Math.sin(air * Math.PI) * 0.9 : 0), yaw: pose.yaw, gait: pose.d, moving });
    };
    if (!player.waitingForGround) keep(meetup.me?.pet, player.position);
    for (const [id, peer] of meetup.peers) keep(peer.pet, avatars.shown.get(id)?.group.position);
    for (const thing of this.poses.keys()) if (!live.has(thing)) this.poses.delete(thing);
    for (const thing of [...this.acts.keys()]) if (!live.has(thing)) this.drop(thing);
  }
}
