// Players' own cars (docs/PROTOCOL.md, "The garage"). Everyone has one, called to where they stand
// from the passport or with /car. The server says where each stands, what body it has and what
// colour it is painted; here it is drawn standing there until somebody drives it, and it keeps its
// own look while it is driven (traffic.js asks for that look by the car's identity).

import * as THREE from "three";
import { VEHICLES } from "./liferigs.js";

export class Garage {
  /**
   * @param {{ world: import("./world.js").World, meetup: import("./net.js").Meetup,
   *   riding: import("./riding.js").Riding, traffic: import("./traffic.js").Traffic }} parts
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.looks = new Map(); // "van:14306874" -> { rig, coat, size }
    this.traffic.owned = (thing) => this.lookOf(thing);
    this.riding.extras.push(() => this.frame());
  }

  /** How somebody's own car is drawn, or undefined for a car that is nobody's. */
  lookOf(thing) {
    for (const car of this.meetup.cars.values()) {
      if (car.thing !== thing) continue;
      const key = `${car.body}:${car.paint}`;
      let look = this.looks.get(key);
      if (!look) {
        const rig = VEHICLES[car.body] ?? VEHICLES.car;
        this.looks.set(key, (look = { rig, coat: { a: new THREE.Color(car.paint), b: rig.palette[0].b }, size: 1 }));
        if (this.looks.size > 64) this.looks.delete(this.looks.keys().next().value);
      }
      return look;
    }
    return undefined;
  }

  /** Every frame: each car that nobody is driving stands where it was called to, or left. */
  frame() {
    const { world, riding } = this;
    for (const car of this.meetup.cars.values()) {
      if (riding.hidden.has(car.thing)) continue; // being driven: riding.js draws it under its driver
      const at = world.geoToScene(car.lat, car.lon);
      const y = world.groundHeight(at.x, at.z);
      riding.hidden.add(car.thing);
      if (y !== null) riding.mounts.push({ key: "", thing: car.thing, sp: "car", x: at.x, z: at.z, y, yaw: (-car.yaw * Math.PI) / 180, gait: 0, moving: false });
    }
  }
}
