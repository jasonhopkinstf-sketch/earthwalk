// The gardens of houses that are lived in: the young animals their owners are raising, ambling about before
// the front door for everybody to see. What lives in each garden comes with the house (`garden` in the
// `lived` messages: what each animal is and how big it has grown, docs/PROTOCOL.md "A house of your own").
// They are drawn like anything else that has left its timetable (riding.js), only smaller while they are young.

import { hash32 } from "./lifemotion.js";

/** How far from a house its garden is still drawn, how far out from the door the animals keep, and how far apart. */
const SEE_M = 160;
const OUT_M = 3.1;
const APART_M = 2.6;
const ROAM_M = 0.65;

export class Garden {
  /**
   * @param {{ world: import("./world.js").World, player: import("./player.js").Player, meetup: import("./net.js").Meetup,
   *   riding: import("./riding.js").Riding }} parts
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.riding.extras.push((dt, t) => this.frame(t));
  }

  frame(t) {
    const { world, player: p, meetup, riding } = this;
    if (p.waitingForGround) return;
    for (const home of meetup.homes.values()) {
      const animals = home.garden;
      if (!animals?.length) continue;
      const door = world.geoToScene(home.lat, home.lon);
      if (Math.hypot(door.x - p.position.x, door.z - p.position.z) > SEE_M) continue;
      const yaw = (home.yaw * Math.PI) / 180; // the way out of the door
      const ox = Math.sin(yaw), oz = -Math.cos(yaw);
      const sx = Math.cos(yaw), sz = Math.sin(yaw);
      animals.forEach((animal, i) => {
        const thing = (hash32(home.id, 0x47415244 + i) >>> 0) || 1;
        const side = (i - (animals.length - 1) / 2) * APART_M;
        // Each ambles round a spot of its own, some one way and some the other.
        const turn = i % 2 ? -1 : 1;
        const phase = turn * (t * 0.22 + i * 1.9);
        const x = door.x + ox * OUT_M + sx * side + Math.cos(phase) * ROAM_M;
        const z = door.z + oz * OUT_M + sz * side + Math.sin(phase) * ROAM_M;
        const y = world.groundHeight(x, z);
        if (y === null) return;
        const dx = -Math.sin(phase) * turn, dz = Math.cos(phase) * turn; // the way it is going
        riding.hidden.add(thing);
        riding.mounts.push({ key: "", thing, sp: animal.sp, x, z, y, yaw: Math.atan2(-dx, -dz), gait: Math.abs(phase) * ROAM_M, moving: true, scale: animal.size, noRide: true });
      });
    }
  }
}
