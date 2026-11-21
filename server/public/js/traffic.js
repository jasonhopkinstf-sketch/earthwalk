// Cars in the browser: the parked ones, and the ones out on a trip. The server works out every
// trip; trafficmotion.js replays it from the shared clock, so everyone in a room sees the same car
// in the same place. What a car does about a player in its way (it stops and toots) is worked out
// here, from the player positions we already have.
//
// Cars are drawn through Life's instanced meshes, with the figures of liferigs.js.

import * as THREE from "three";
import { hash32 } from "./lifemotion.js";
import { VEHICLES } from "./liferigs.js";
import { prepare, tripPose } from "./trafficmotion.js";

const SHOW_M = 220;
const MAX_PARKED = 40;
const MAX_TRIPS = 14;
const SALT_PAINT = 0x5041494e;

const unit = (a, b) => hash32(a, b) / 4294967296;
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
function turn(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
/** One car in six is a van. Its paint and size come from its identity, so they are the same for everyone. */
function looks(id) {
  const rig = VEHICLES[hash32(id, SALT_PAINT) % 6 === 0 ? "van" : "car"];
  return { rig, coat: rig.palette[hash32(id, SALT_PAINT + 1) % rig.palette.length], size: 0.94 + 0.12 * unit(id, SALT_PAINT + 2) };
}

export class Traffic {
  /** @param {import("./world.js").World} world  @param {import("./sounds.js").Sounds} sounds */
  constructor(world, sounds) {
    this.world = world;
    this.sounds = sounds;
    this.byChunk = new Map(); // chunk key -> { chunk, parked, trips }
    this.parked = []; // nearest first
    this.trips = [];
    this.states = new Map(); // car id -> { lag, yaw, tooted }
    this.shown = 0;
    this.euler = new THREE.Euler(0, 0, 0, "YXZ");
    this.q = new THREE.Quaternion();
    this.v = new THREE.Vector3();
    this.s = new THREE.Vector3();
  }

  /** Call a couple of times a second: picks up cars from chunks that have arrived and drops those that left. */
  sync(position) {
    const world = this.world;
    const S = world.tileM;
    for (const [key, entry] of this.byChunk) if (world.chunks.get(key) !== entry.chunk) this.byChunk.delete(key);
    for (const [key, chunk] of world.chunks) {
      if (!chunk.cars || this.byChunk.has(key)) continue;
      const ox = (chunk.x - world.originX) * S;
      const oz = (chunk.y - world.originY) * S;
      const parked = [];
      for (const it of chunk.cars) {
        if (![it.id, it.u, it.v, it.yaw].every(Number.isFinite)) continue;
        parked.push({ id: it.id >>> 0, x: ox + it.u * S, z: oz + it.v * S, yaw: (-it.yaw * Math.PI) / 180, ...looks(it.id >>> 0), d: 0 });
      }
      const trips = [];
      for (const it of chunk.routes ?? []) {
        if (![it.id, it.w, it.da, it.db].every(Number.isFinite) || !Array.isArray(it.pts) || it.pts.length < 6 || !it.pts.every(Number.isFinite)) continue;
        // The path in scene metres: x east, z south, and the seconds since setting off.
        const path = it.pts.map((n, i) => (i % 3 === 0 ? ox + n * S : i % 3 === 1 ? oz + n * S : n));
        const trip = prepare({ id: it.id >>> 0, w: Math.min(40, Math.max(2.5, it.w)), left: !!it.left, da: Math.max(1, it.da), db: Math.max(1, it.db), path });
        if (trip.time > 0) trips.push({ trip, wx: chunk.x, wy: chunk.y, ...looks(trip.id), d: 0 });
      }
      this.byChunk.set(key, { chunk, parked, trips });
    }
    this.parked = [];
    this.trips = [];
    for (const { parked, trips } of this.byChunk.values()) {
      for (const car of parked) {
        car.d = Math.hypot(car.x - position.x, car.z - position.z);
        if (car.d < SHOW_M) this.parked.push(car);
      }
      for (const car of trips) {
        // A trip is never longer than 420 m, so a car that starts further off than that cannot be near.
        car.d = Math.hypot(car.trip.path[0] - position.x, car.trip.path[1] - position.z);
        if (car.d < SHOW_M + 450) this.trips.push(car);
      }
    }
    this.parked.sort((a, b) => a.d - b.d);
    this.parked.length = Math.min(this.parked.length, MAX_PARKED);
    if (this.states.size > 300) this.states.clear();
  }

  /** Every car out on a trip near the player at shared time `t`, in scene metres (for the tests). */
  where(t) {
    return this.trips.map(({ trip }) => ({ id: trip.id, ...tripPose(trip, t) }));
  }

  /** Every frame, from Life.update: writes the cars into Life's meshes. */
  draw(life, dt, t, players, counts) {
    let shown = 0;
    for (const car of this.parked) {
      const y = this.world.groundHeight(car.x, car.z);
      if (y === null) continue;
      life.base.compose(this.v.set(car.x, y, car.z), this.q.setFromEuler(this.euler.set(0, car.yaw, 0)), this.s.set(car.size, car.size, car.size));
      life.put(car.rig, car.coat, counts, null, 0, 0, t, 0);
      shown++;
    }
    // Where every car on a trip is now; the nearest are drawn, and of those on the move only so many.
    const me = players[0];
    const near = [];
    for (const car of this.trips) {
      let st = this.states.get(car.trip.id);
      if (!st) this.states.set(car.trip.id, (st = { lag: 0, yaw: null, tootAt: 0 }));
      const pose = tripPose(car.trip, t - st.lag);
      const d = Math.hypot(pose.x - me.x, pose.y - me.z);
      if (d <= SHOW_M) near.push({ car, st, pose, d });
    }
    near.sort((a, b) => a.d - b.d);
    let moving = 0;
    for (const { car, st, pose } of near) {
      if (pose.moving && ++moving > MAX_TRIPS) continue;
      const want = (-pose.yaw * Math.PI) / 180;
      const fx = Math.sin(-want); // the way it faces, in the scene: x east, z south
      const fz = -Math.cos(want);

      // ---- is somebody in the way? Then wait, toot, and make up the time afterwards.
      let blocked = false;
      if (pose.moving) {
        for (const p of players) {
          const ahead = (p.x - pose.x) * fx + (p.z - pose.y) * fz;
          const aside = Math.abs((p.x - pose.x) * fz - (p.z - pose.y) * fx);
          if (ahead > 1 && ahead < 8 && aside < 1.6) { blocked = true; break; }
        }
      }
      if (blocked) {
        st.lag = Math.min(90, st.lag + dt); // after a minute and a half it gives up waiting and drives on
        if (t > st.tootAt) {
          st.tootAt = t + 4;
          this.sounds.play("toot", pose.x, (this.world.groundHeight(pose.x, pose.y) ?? 0) + 1, pose.y, 0.9 + 0.2 * unit(car.trip.id, 9));
        }
      } else if (st.lag > 0) st.lag = Math.max(0, st.lag - dt * 0.3);

      const y = this.world.groundHeight(pose.x, pose.y);
      if (y === null) continue;
      // The body swings round to the way it is going, which is what turns it about at each end of a trip.
      st.yaw = st.yaw === null ? want : st.yaw + turn(st.yaw, want) * ease(pose.moving ? 3.5 : 6, dt);
      life.base.compose(this.v.set(pose.x, y + (pose.moving ? Math.abs(Math.sin(t * 9 + car.trip.id)) * 0.02 : 0), pose.y), this.q.setFromEuler(this.euler.set(0, st.yaw, 0)), this.s.set(car.size, car.size, car.size));
      life.put(car.rig, car.coat, counts, null, 0, 0, t, 0);
      shown++;
    }
    this.shown = shown;
  }
}
