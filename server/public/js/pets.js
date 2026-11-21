// Companions. Solving a riddle wins its answer as an animal that keeps you company (passport.js
// chooses one; docs/PROTOCOL.md, "Riddles and companions"). It trots after its player wherever
// they go, friends see it, and it can be talked to and, if it is big enough, ridden.
//
// Every game works a companion out for itself from where its player is, so friends agree to within
// a step or two. It is drawn like anything else that has left its timetable (riding.js).

import { MOUNTS } from "./riding.js";
import { RIGS } from "./liferigs.js";

/** How fast each kind keeps up, in metres a second; anything not listed trots at `TROT`. */
const PACE = { snail: 1.5, tortoise: 1.8, ladybird: 2, crab: 3, frog: 4, mouse: 4, hedgehog: 3, penguin: 3, duck: 3.5, goose: 4, cow: 5, panda: 4.5, koala: 3 };
const TROT = 7;
const LOST_M = 60;

export class Pets {
  /**
   * @param {{ world: import("./world.js").World, player: import("./player.js").Player, meetup: import("./net.js").Meetup,
   *   avatars: import("./avatars.js").Avatars, riding: import("./riding.js").Riding }} parts
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.poses = new Map(); // thing -> { x, z, yaw, d }
    this.riding.extras.push((dt) => this.frame(dt));
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
      if (y !== null) riding.mounts.push({ key: "", thing: pet.thing, sp: pet.sp, x: pose.x, z: pose.z, y, yaw: pose.yaw, gait: pose.d, moving });
    };
    if (!player.waitingForGround) keep(meetup.me?.pet, player.position);
    for (const [id, peer] of meetup.peers) keep(peer.pet, avatars.shown.get(id)?.group.position);
    for (const thing of this.poses.keys()) if (!live.has(thing)) this.poses.delete(thing);
  }
}
