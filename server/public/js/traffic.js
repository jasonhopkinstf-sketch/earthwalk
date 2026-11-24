// Cars in the browser: the parked ones, and the ones out on a trip. The server works out every
// trip; trafficmotion.js replays it from the shared clock, so everyone in a room sees the same car
// in the same place. What a car does about a player in its way (it stops and toots) is worked out
// here, from the player positions we already have.
//
// Cars are drawn through Life's instanced meshes, with the figures of liferigs.js.

import * as THREE from "three";
import { hash32 } from "./lifemotion.js";
import { BODIES, VEHICLES } from "./liferigs.js";
import { headingAt, joinOf, liftAt, pointAt, prepare, runPose, stopsAlong, THROUGH_DWELL_S, trainPose, tripPose } from "./trafficmotion.js";

const SHOW_M = 220;
const MAX_PARKED = 40;
const MAX_TRIPS = 14;
const SALT_PAINT = 0x5041494e;
const TRAIN_SHOW_M = 500;
const CARRIAGES = 4;
const CARRIAGE_M = 13.6;
const COUPLING_M = 0.7;
const TRAIN_M = CARRIAGES * CARRIAGE_M + (CARRIAGES - 1) * COUPLING_M;

const unit = (a, b) => hash32(a, b) / 4294967296;
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
function turn(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
/** A car's body (liferigs.js, BODIES), paint and size come from its identity, so they are the same for everyone. */
function looks(id, sp = "car") {
  if (sp === "taxi") return { rig: VEHICLES.taxi, coat: VEHICLES.taxi.palette[0], size: 1 };
  const rig = VEHICLES[BODIES[hash32(id, SALT_PAINT) % BODIES.length]];
  return { rig, coat: rig.palette[hash32(id, SALT_PAINT + 1) % rig.palette.length], size: 0.94 + 0.12 * unit(id, SALT_PAINT + 2) };
}

/** How far above the ground each point of a route or a train's run is (bridges, tunnels), where the server says: a number a point. */
const liftsOf = (it) => (Array.isArray(it.lift) && it.lift.length === it.pts.length / 3 && it.lift.every(Number.isFinite) ? it.lift : null);

export class Traffic {
  /** @param {import("./world.js").World} world  @param {import("./sounds.js").Sounds} sounds */
  constructor(world, sounds) {
    this.world = world;
    this.sounds = sounds;
    this.byChunk = new Map(); // chunk key -> { chunk, parked, trips }
    this.parked = []; // nearest first
    this.trips = [];
    this.trains = [];
    /** Set by main.js: riding.js, which says what is being ridden (and so not drawn where its timetable has it). */
    this.riding = null;
    /** Every stretch of railway this game has, by its identity: the trains' own runs, and the spare track with no train. */
    this.tracks = new Map();
    /**
     * The train I am on, once it has carried on past the end of its own run (trafficmotion.js, "a train that
     * carries on"), or null. `segs` are the stretches of track it has gone along, the last the one its front is
     * on: { train, back, start, t0 }, the run, which way along it, how far down the whole way it begins, and when
     * the front set off along it. `far` says which end of the train is its front; `hide` the timetable's own
     * trains that are not drawn for me meanwhile (the one I boarded, and any whose track mine is on).
     */
    this.through = null;
    /** The cars and railway carriages near enough to hop on, as drawn last frame. */
    this.rideable = [];
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
        const trip = prepare({ id: it.id >>> 0, w: Math.min(40, Math.max(2.5, it.w)), left: !!it.left, da: Math.max(1, it.da), db: Math.max(1, it.db), path, lift: liftsOf(it) });
        if (trip.time > 0) trips.push({ trip, wx: chunk.x, wy: chunk.y, ...looks(trip.id), d: 0 });
      }
      // A train comes with every chunk on its run. Its path is measured from the chunk that sent it.
      const trains = [];
      for (const it of chunk.trains ?? []) {
        if (![it.id, it.da, it.db].every(Number.isFinite) || !Array.isArray(it.pts) || it.pts.length < 6 || !it.pts.every(Number.isFinite)) continue;
        const path = it.pts.map((n, i) => (i % 3 === 0 ? ox + n * S : i % 3 === 1 ? oz + n * S : n));
        const train = prepare({ id: it.id >>> 0, w: 0, left: false, da: Math.max(1, it.da), db: Math.max(1, it.db), path, lift: liftsOf(it) });
        const rig = VEHICLES.railcar;
        if (train.time > 0 && train.length > TRAIN_M + 30) trains.push({ train, rig, coat: rig.palette[hash32(train.id, SALT_PAINT) % rig.palette.length] });
      }
      // And the stretches of track with no train of their own, for a train somebody rides to carry on along.
      const tracks = trains.map((x) => x.train);
      for (const it of chunk.tracks ?? []) {
        if (![it.id, it.da, it.db].every(Number.isFinite) || !Array.isArray(it.pts) || it.pts.length < 6 || !it.pts.every(Number.isFinite)) continue;
        const path = it.pts.map((n, i) => (i % 3 === 0 ? ox + n * S : i % 3 === 1 ? oz + n * S : n));
        const track = prepare({ id: it.id >>> 0, w: 0, left: false, da: Math.max(1, it.da), db: Math.max(1, it.db), path, lift: liftsOf(it) });
        if (track.time > 0 && track.length > 1) tracks.push(track);
      }
      this.byChunk.set(key, { chunk, parked, trips, trains, tracks });
    }
    this.parked = [];
    this.trips = [];
    const trains = new Map(); // one of each, whichever chunk it came with
    this.tracks = new Map();
    for (const { parked, trips, trains: list, tracks } of this.byChunk.values()) {
      for (const item of list) if (!trains.has(item.train.id)) trains.set(item.train.id, item);
      for (const track of tracks) if (!this.tracks.has(track.id)) this.tracks.set(track.id, track);
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
    this.trains = [...trains.values()];
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
    const taken = this.riding?.hidden;
    this.rideable.length = 0;
    for (const car of this.parked) {
      if (taken?.has(car.id)) continue; // somebody has driven it off
      const y = this.world.groundHeight(car.x, car.z);
      if (y === null) continue;
      if (car.d < 40) this.rideable.push({ thing: car.id, sp: "car", x: car.x, z: car.z, yaw: car.yaw });
      life.base.compose(this.v.set(car.x, y, car.z), this.q.setFromEuler(this.euler.set(0, car.yaw, 0)), this.s.set(car.size, car.size, car.size));
      life.roll = 0;
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
    for (const { car, st, pose, d } of near) {
      if (taken?.has(car.trip.id)) continue;
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

      const ground = this.world.groundHeight(pose.x, pose.y);
      if (ground === null) continue;
      const y = ground + pose.lift; // on a bridge, the road is that far above the ground
      // The body swings round to the way it is going, which is what turns it about at each end of a trip.
      st.yaw = st.yaw === null ? want : st.yaw + turn(st.yaw, want) * ease(pose.moving ? 3.5 : 6, dt);
      if (d < 40) this.rideable.push({ thing: car.trip.id, sp: "car", x: pose.x, z: pose.y, yaw: st.yaw });
      life.base.compose(this.v.set(pose.x, y + (pose.moving ? Math.abs(Math.sin(t * 9 + car.trip.id)) * 0.02 : 0), pose.y), this.q.setFromEuler(this.euler.set(0, st.yaw, 0)), this.s.set(car.size, car.size, car.size));
      life.roll = pose.rolled;
      life.put(car.rig, car.coat, counts, null, 0, 0, t, 0);
      shown++;
    }
    // ---- trains: four carriages spread along the track, the middle of the train where the timetable puts it
    const mine = this.through;
    if (mine) {
      // The train I am carried on down the line by, where it has got to.
      for (let j = 0; j < CARRIAGES; j++) {
        const at = this.throughAt(j, t);
        if (!at) continue;
        life.base.compose(this.v.set(at.x, at.y, at.z), this.q.setFromEuler(this.euler.set(0, at.yaw, 0)), this.s.set(1, 1, 1));
        life.put(VEHICLES.railcar, mine.coat, counts, null, 0, 0, t, 0);
        shown++;
      }
    }
    for (const { train, rig, coat } of this.trains) {
      if (mine?.hide.has(train.id)) continue; // (the one I boarded, and the timetable's own train of the track mine is on)
      const pose = trainPose(train, t);
      const middle = TRAIN_M / 2 + (pose.along * (train.length - TRAIN_M)) / train.length;
      let nearest = Infinity;
      for (let k = 0; k < CARRIAGES; k++) {
        const d = middle - TRAIN_M / 2 + CARRIAGE_M / 2 + k * (CARRIAGE_M + COUPLING_M);
        const [x, z] = pointAt(train, d);
        const away = Math.hypot(x - me.x, z - me.z);
        nearest = Math.min(nearest, away);
        if (away > TRAIN_SHOW_M) continue;
        const ground = this.world.groundHeight(x, z);
        if (ground === null) continue;
        const y = ground + liftAt(train, d); // over a bridge, or under the ground in a tunnel
        const yaw = (-headingAt(train, d, 6) * Math.PI) / 180;
        if (away < 40) this.rideable.push({ thing: train.id, sp: "train", k, x, z, yaw });
        life.base.compose(this.v.set(x, y, z), this.q.setFromEuler(this.euler.set(0, yaw, 0)), this.s.set(1, 1, 1));
        life.put(rig, coat, counts, null, 0, 0, t, 0);
        shown++;
      }
      // It whistles as it sets off, and for anyone standing near the line as it passes.
      let st = this.states.get(`train ${train.id}`); // kept apart from the cars, whose identities are numbers too
      if (!st) this.states.set(`train ${train.id}`, (st = { wasMoving: pose.moving, whistleAt: 0 }));
      if (nearest < 250 && t > st.whistleAt && ((pose.moving && !st.wasMoving) || (pose.moving && nearest < 45))) {
        st.whistleAt = t + 12;
        const [x, z] = pointAt(train, middle);
        this.sounds.play("whistle", x, (this.world.groundHeight(x, z) ?? me.y) + 3, z, 0.92 + 0.16 * unit(train.id, 5));
      }
      st.wasMoving = pose.moving;
    }
    this.shown = shown;
  }

  /** Draws a car that somebody is driving, or has left standing, where they took it. */
  putMount(life, m, t, counts) {
    // Somebody's own car has the body and paint they chose (garage.js); any other is as its identity makes it.
    const { rig, coat, size } = this.owned?.(m.thing) ?? looks(m.thing, m.sp);
    // A driven car tilts to the ground and leans in a bend (riding.js): turned first, then nose up or down, then leaning.
    life.base.compose(this.v.set(m.x, m.y, m.z), this.q.setFromEuler(this.euler.set(m.pitch ?? 0, m.yaw, m.roll ?? 0, "YXZ")), this.s.set(size, size, size));
    life.roll = m.gait ?? 0;
    life.put(rig, coat, counts, null, 0, 0, t, 0);
  }

  /**
   * How high the rider of a car sits, metres: on the roof of the body this very car has (a van's is higher
   * than a saloon's), at the size it is drawn. Null for anything that is not a car, or has no model: the usual seat then.
   */
  seatOf(thing, sp) {
    if (sp !== "car" && sp !== "taxi") return null;
    const { rig, size } = (sp === "car" && this.owned?.(thing)) || looks(thing, sp);
    return rig.model?.seat ? rig.model.seat * size : null;
  }

  /**
   * Where the trains this game has stop, within `within` metres east and south of a spot: the middle of the
   * train as it stands at each end of its run and at every station, in scene metres. For the little map.
   */
  stops(from, within) {
    const out = [];
    for (const { train } of this.trains) {
      if (train.n < 2) continue;
      for (const along of stopsAlong(train)) {
        const [x, z] = pointAt(train, TRAIN_M / 2 + (along * (train.length - TRAIN_M)) / train.length);
        if (Math.abs(x - from.x) > within || Math.abs(z - from.z) > within) continue;
        if (out.some((had) => Math.abs(had.x - x) + Math.abs(had.z - z) < 40)) continue; // two trains use the one station
        out.push({ x, z });
      }
    }
    return out;
  }

  /**
   * Where to stand to catch a train near a spot: for each train this game has that comes within `reach`
   * metres of `from`, the first moment from shared time `t` on when it stands still there for a good while
   * (at a station, or at an end of its run); or, if it does not within `within` seconds, the next time it
   * passes the nearest point of its track, marked `passing`. `x`, `z` are where its middle will be then,
   * `in` how many seconds off that is, and `heading` the compass way the track runs there.
   */
  boarding(t, from, reach, within = 90) {
    const out = [];
    for (const { train } of this.trains) {
      const middle = (along) => TRAIN_M / 2 + (along * (train.length - TRAIN_M)) / train.length;
      const away = (d) => {
        const [x, z] = pointAt(train, d);
        return Math.hypot(x - from.x, z - from.z);
      };
      let found = null;
      for (let dt = 0; dt <= within && !found; dt++) {
        const a = trainPose(train, t + dt);
        if (a.moving) continue;
        const b = trainPose(train, t + dt + 12);
        if (!b.moving && Math.abs(a.along - b.along) < 0.01 && away(middle(a.along)) <= reach) found = { in: dt, d: middle(a.along), passing: false };
      }
      if (!found) {
        // The point of its track nearest the spot, and when its middle next goes by there.
        let near = -1;
        let nearest = reach;
        for (let d = TRAIN_M / 2; d <= train.length - TRAIN_M / 2; d += 10) {
          const m = away(d);
          if (m <= nearest) { nearest = m; near = d; }
        }
        if (near < 0) continue; // this one never comes near
        for (let dt = 8; dt <= within * 4 && !found; dt++) {
          const a = trainPose(train, t + dt);
          if (a.moving && Math.abs(middle(a.along) - near) < 14) found = { in: dt, d: near, passing: true };
        }
        if (!found) continue;
      }
      // Opposite the middle of a carriage, not the gap between two: within reach of a door, so to speak.
      const beside = Math.min(train.length, found.d + (CARRIAGE_M + COUPLING_M) / 2);
      const [x, z] = pointAt(train, beside);
      out.push({ id: train.id, x, z, heading: headingAt(train, beside, 6), in: found.in, passing: found.passing });
    }
    return out;
  }

  /**
   * Where to go to meet each train this game has soonest, wherever on its run that is: where it will be
   * standing still within `wait` seconds, or failing that where it will be `lead` seconds from now.
   */
  soonest(t, wait = 30, lead = 20) {
    const out = [];
    for (const { train } of this.trains) {
      const middle = (along) => TRAIN_M / 2 + (along * (train.length - TRAIN_M)) / train.length;
      let found = null;
      for (let dt = 0; dt <= wait && !found; dt++) {
        const a = trainPose(train, t + dt);
        if (a.moving) continue;
        const b = trainPose(train, t + dt + 12);
        if (!b.moving && Math.abs(a.along - b.along) < 0.01) found = { in: dt, d: middle(a.along), passing: false };
      }
      // Failing that, where it will be on the move: a train standing now but about to leave is met as it sets off.
      for (let dt = lead; dt <= lead + 120 && !found; dt++) {
        const a = trainPose(train, t + dt);
        if (a.moving) found = { in: dt, d: middle(a.along), passing: true };
      }
      if (!found) continue;
      // Opposite the middle of a carriage, not the gap between two: within reach of a door, so to speak.
      const beside = Math.min(train.length, found.d + (CARRIAGE_M + COUPLING_M) / 2);
      const [x, z] = pointAt(train, beside);
      out.push({ id: train.id, x, z, heading: headingAt(train, beside, 6), in: found.in, passing: found.passing });
    }
    return out;
  }

  /**
   * Every frame while I ride the train `id`: where the track goes on past the end of its run, the train carries on
   * along it with me, and on again at the end of that, as far as the line goes. Where the track ends it stands.
   * Returns words to say, when there are any: "the train carries on", "as far as the track goes".
   */
  carryOn(id, t) {
    const all = [...this.tracks.values()];
    const th = this.through;
    if (!th) {
      const item = this.trains.find((x) => x.train.id === id);
      if (!item) return null;
      const pose = trainPose(item.train, t);
      if (pose.leg !== 0 && pose.leg !== 2) return null; // not standing at an end of its run
      const far = pose.leg === 2;
      const join = pose.stood >= THROUGH_DWELL_S ? joinOf(item.train, far, all) : null;
      if (!join) return null;
      // Its front is at the end of the run it was on, and sets off along the next when the train has stood its six
      // seconds (whenever this game came to notice: friends aboard go together).
      this.through = {
        segs: [{ train: item.train, back: !far, start: 0, t0: 0 }, { ...join, start: item.train.length, t0: t - (pose.stood - THROUGH_DWELL_S) }],
        far, coat: item.coat, hide: new Set([id, join.train.id]), said: false,
      };
      return "The train carries on down the line. E hops off when you like.";
    }
    const last = th.segs[th.segs.length - 1];
    if (t - last.t0 < last.train.time) return null;
    const join = joinOf(last.train, !last.back, all);
    if (join) {
      th.segs.push({ ...join, start: last.start + last.train.length, t0: last.t0 + last.train.time });
      if (th.segs.length > 12) th.segs.shift(); // (the train is on the last few of them at most)
      th.hide = new Set([id, join.train.id]);
      return null;
    }
    if (th.said) return null;
    th.said = true;
    return "This is as far as the track goes from here. E hops off.";
  }

  /** Off the train: whatever it was doing for me, it does no longer. */
  leaveTrain() {
    this.through = null;
  }

  /** Where carriage `j` of the train I am carried on by is (0 is its front): the place, and null where the ground has not come. */
  throughAt(j, t) {
    const th = this.through;
    const last = th.segs[th.segs.length - 1];
    const pose = runPose(last.train, t - last.t0, last.back);
    const front = last.start + (last.back ? last.train.length - pose.along : pose.along);
    // So far down the whole way it has come: on whichever stretch that is, and never before the first of them.
    const want = Math.max(th.segs[0].start, front - CARRIAGE_M / 2 - j * (CARRIAGE_M + COUPLING_M));
    let seg = th.segs[0];
    for (const one of th.segs) if (one.start <= want) seg = one;
    const local = Math.min(seg.train.length, want - seg.start);
    const d = seg.back ? seg.train.length - local : local;
    const [x, z] = pointAt(seg.train, d);
    // (Where the ground ahead has not come yet, the train keeps the height it had: it does not stop for the map.)
    const ground = this.world.groundHeight(x, z);
    if (ground !== null) th.ground = ground;
    const y = ground ?? th.ground ?? null;
    return y === null ? null : { x, y: y + liftAt(seg.train, d), z, yaw: (-headingAt(seg.train, d, 6) * Math.PI) / 180 };
  }

  /** Where carriage `k` of a train is at shared time `t`, for a passenger on its roof; null if this game does not have the train. */
  carriageAt(id, k, t) {
    // (Carried on down the line, the carriages count from the train's front, which was its far end or its near one.)
    if (this.through) return this.throughAt(this.through.far ? CARRIAGES - 1 - k : k, t);
    const item = this.trains.find((x) => x.train.id === id);
    if (!item) return null;
    const { train } = item;
    const pose = trainPose(train, t);
    const d = (pose.along * (train.length - TRAIN_M)) / train.length + CARRIAGE_M / 2 + k * (CARRIAGE_M + COUPLING_M);
    const [x, z] = pointAt(train, d);
    const y = this.world.groundHeight(x, z);
    return y === null ? null : { x, y: y + liftAt(train, d), z, yaw: (-headingAt(train, d, 6) * Math.PI) / 180 };
  }

  /** Every train near the player at shared time `t`: where the middle of it is, in scene metres (for the tests). */
  whereTrains(t) {
    return this.trains.map(({ train }) => {
      const pose = trainPose(train, t);
      const [x, y] = pointAt(train, TRAIN_M / 2 + (pose.along * (train.length - TRAIN_M)) / train.length);
      return { id: train.id, x, y, ...pose };
    });
  }
}
