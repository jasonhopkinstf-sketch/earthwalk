// Farm animals in the browser: cows, sheep, horses and chickens that graze and wander where the
// server says a herd lives. Where each one is comes from lifemotion.js and the shared clock, so
// everyone in a room sees the same animal in the same place. What happens when a player comes close
// (a look, a step aside, a squawk) is worked out here, from the player positions we already have.
//
// All animals are drawn with four instanced meshes (one per basic shape), whatever their number.

import * as THREE from "three";
import { xToLon, yToLat } from "./geo.js";
import { CALL_SLOT, callTime, creatureAt, hash32, memberId, SPECIES } from "./lifemotion.js";

const SHOW_M = 220; // herds further off than this are not drawn
const HEAR_M = 70;
const MAX_SHOWN = 90;
const CAPACITY = 2048; // shapes per kind of shape
const SALT_COAT = 0x434f4154;

const SHAPES = {
  sphere: new THREE.SphereGeometry(1, 12, 8),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 8),
  cone: new THREE.ConeGeometry(1, 1, 8),
  box: new THREE.BoxGeometry(1, 1, 1),
};
const PINK = 0xe8b4a8;
const DARK = 0x26221f;
const CREAM = 0xf3ecd9;

/**
 * The figures, built from basic shapes like the players' animals. Each stands with its feet at
 * y = 0, facing north (-z), sizes in metres. A part is [shape, colour, position, size, role, tilt].
 * Size is the three radii of a sphere; radius, height, radius of a cylinder or cone; and the width,
 * height and depth of a box. Colour "a" is the animal's coat and "b" its second colour. Roles move:
 * head (about `neck`, and `drop` metres lower while grazing), leg0..3 and tail.
 */
const RIGS = {
  cow: {
    voice: "moo", alarm: "moo", alert: 7, flee: 2.4, stride: 1.5, graze: 1.1, drop: 0.35, neck: [0, 1.05, -0.7],
    coats: [[0xf4efe6, 0x2b2623], [0x8a4f2d, 0xf4efe6], [0x2b2623, 0xf4efe6], [0xc79a62, 0xf4efe6], [0xf4efe6, 0x8a4f2d]],
    parts: [
      ["sphere", "a", [0, 0.95, 0], [0.42, 0.42, 0.85]],
      ["sphere", "b", [0.2, 1.1, 0.25], [0.3, 0.26, 0.36]],
      ["sphere", "b", [-0.22, 0.98, -0.3], [0.27, 0.3, 0.3]],
      ["sphere", PINK, [0, 0.56, 0.4], [0.15, 0.11, 0.17]],
      ["sphere", "a", [0, 1.2, -1.0], [0.24, 0.26, 0.32], "head"],
      ["sphere", PINK, [0, 1.1, -1.27], [0.19, 0.15, 0.16], "head"],
      ["sphere", DARK, [0.13, 1.28, -1.25], [0.035, 0.045, 0.03], "head"],
      ["sphere", DARK, [-0.13, 1.28, -1.25], [0.035, 0.045, 0.03], "head"],
      ["sphere", "b", [0.3, 1.3, -0.9], [0.12, 0.05, 0.07], "head"],
      ["sphere", "b", [-0.3, 1.3, -0.9], [0.12, 0.05, 0.07], "head"],
      ["cone", CREAM, [0.17, 1.5, -0.92], [0.04, 0.16, 0.04], "head"],
      ["cone", CREAM, [-0.17, 1.5, -0.92], [0.04, 0.16, 0.04], "head"],
      ["cyl", "a", [-0.24, 0.43, -0.55], [0.085, 0.86, 0.085], "leg0"],
      ["cyl", "a", [0.24, 0.43, -0.55], [0.085, 0.86, 0.085], "leg1"],
      ["cyl", "a", [-0.24, 0.43, 0.55], [0.085, 0.86, 0.085], "leg2"],
      ["cyl", "a", [0.24, 0.43, 0.55], [0.085, 0.86, 0.085], "leg3"],
      ["cyl", "b", [0, 0.82, 0.86], [0.025, 0.5, 0.025], "tail"],
    ],
  },
  sheep: {
    voice: "baa", alarm: "baa", alert: 9, flee: 4, stride: 0.8, graze: 0.9, drop: 0.3, neck: [0, 0.7, -0.4],
    coats: [[0xf1ead8, 0x3a3430], [0xe9e2cf, 0x3a3430], [0xf4f0e4, 0xe6dcc6], [0xdcd3bd, 0x4a403a], [0xf1ead8, 0x3a3430], [0xe9e2cf, 0x4a403a], [0xf4f0e4, 0x3a3430], [0xf1ead8, 0xe6dcc6], [0xe9e2cf, 0x3a3430], [0x3d3632, 0x2a2522]],
    parts: [
      ["sphere", "a", [0, 0.62, 0], [0.36, 0.34, 0.5]],
      ["sphere", "a", [0.12, 0.82, 0.2], [0.26, 0.24, 0.26]],
      ["sphere", "a", [-0.14, 0.8, -0.15], [0.26, 0.24, 0.27]],
      ["sphere", "a", [0, 0.7, 0.42], [0.27, 0.26, 0.2]],
      ["sphere", "b", [0, 0.78, -0.6], [0.14, 0.16, 0.2], "head"],
      ["sphere", "a", [0, 0.92, -0.5], [0.14, 0.09, 0.13], "head"],
      ["sphere", "b", [0.17, 0.84, -0.55], [0.09, 0.035, 0.05], "head"],
      ["sphere", "b", [-0.17, 0.84, -0.55], [0.09, 0.035, 0.05], "head"],
      ["cyl", "b", [-0.16, 0.24, -0.3], [0.045, 0.48, 0.045], "leg0"],
      ["cyl", "b", [0.16, 0.24, -0.3], [0.045, 0.48, 0.045], "leg1"],
      ["cyl", "b", [-0.16, 0.24, 0.3], [0.045, 0.48, 0.045], "leg2"],
      ["cyl", "b", [0.16, 0.24, 0.3], [0.045, 0.48, 0.045], "leg3"],
      ["sphere", "a", [0, 0.66, 0.56], [0.07, 0.07, 0.07], "tail"],
    ],
  },
  horse: {
    voice: "neigh", alarm: "neigh", alert: 8, flee: 3, stride: 2.1, graze: 1.5, drop: 0.5, neck: [0, 1.45, -0.68],
    coats: [[0x8a4b2a, 0x2b211c], [0x5e3a22, 0x1f1a17], [0xb8b4ac, 0x6d6a66], [0x2e2a28, 0x191615], [0xd9b06a, 0xf1e6cc], [0x8a4b2a, 0xf1e6cc]],
    parts: [
      ["sphere", "a", [0, 1.25, 0], [0.38, 0.42, 0.9]],
      ["cyl", "a", [0, 1.62, -0.92], [0.2, 0.62, 0.22], "head", -0.95],
      ["sphere", "a", [0, 1.82, -1.42], [0.16, 0.19, 0.36], "head", -0.75],
      ["box", "b", [0, 1.74, -0.8], [0.06, 0.62, 0.14], "head", -0.95],
      ["sphere", DARK, [0.13, 1.92, -1.38], [0.03, 0.04, 0.03], "head"],
      ["sphere", DARK, [-0.13, 1.92, -1.38], [0.03, 0.04, 0.03], "head"],
      ["cone", "a", [0.09, 2.06, -1.2], [0.045, 0.14, 0.045], "head"],
      ["cone", "a", [-0.09, 2.06, -1.2], [0.045, 0.14, 0.045], "head"],
      ["cyl", "a", [-0.21, 0.55, -0.6], [0.08, 1.1, 0.08], "leg0"],
      ["cyl", "a", [0.21, 0.55, -0.6], [0.08, 1.1, 0.08], "leg1"],
      ["cyl", "a", [-0.21, 0.55, 0.6], [0.08, 1.1, 0.08], "leg2"],
      ["cyl", "a", [0.21, 0.55, 0.6], [0.08, 1.1, 0.08], "leg3"],
      ["cyl", "b", [0, 1.05, 0.98], [0.07, 0.75, 0.07], "tail", 0.3],
    ],
  },
  chicken: {
    voice: "cluck", alarm: "squawk", alert: 5, flee: 3, stride: 0.22, graze: 1.1, drop: 0.15, neck: [0, 0.3, -0.08], peck: true,
    coats: [[0xf6f1e4, 0xf6f1e4], [0xb5622e, 0x7a3d1c], [0x2b2b2b, 0x1c1c1c], [0xcfc8ba, 0x8f8a80], [0xb5622e, 0x2b2b2b]],
    parts: [
      ["sphere", "a", [0, 0.24, 0], [0.13, 0.13, 0.17]],
      ["cone", "b", [0, 0.36, 0.17], [0.07, 0.17, 0.07], "tail", 0.7],
      ["sphere", "a", [0, 0.42, -0.13], [0.07, 0.075, 0.07], "head"],
      ["sphere", 0xd23a2e, [0, 0.5, -0.13], [0.02, 0.04, 0.05], "head"],
      ["sphere", 0xd23a2e, [0, 0.36, -0.18], [0.02, 0.03, 0.02], "head"],
      ["cone", 0xe8a23a, [0, 0.42, -0.22], [0.025, 0.07, 0.025], "head", -Math.PI / 2],
      ["sphere", DARK, [0.05, 0.44, -0.17], [0.012, 0.014, 0.012], "head"],
      ["sphere", DARK, [-0.05, 0.44, -0.17], [0.012, 0.014, 0.012], "head"],
      ["cyl", 0xe8a23a, [-0.05, 0.07, 0], [0.012, 0.14, 0.012], "leg0"],
      ["cyl", 0xe8a23a, [0.05, 0.07, 0], [0.012, 0.14, 0.012], "leg1"],
    ],
  },
};

// Turn the readable tables above into matrices once.
for (const rig of Object.values(RIGS)) {
  const o = new THREE.Object3D();
  rig.built = rig.parts.map(([shape, colour, at, size, role = "", tilt = 0]) => {
    o.position.set(at[0], at[1], at[2]);
    o.rotation.set(tilt, 0, 0);
    o.scale.set(size[0], size[1], size[2]);
    o.updateMatrix();
    // A leg swings from its top, a tail hangs from its top, a head turns about the neck.
    const pivot = role === "head" ? rig.neck : role ? [at[0], at[1] + (shape === "sphere" ? 0 : size[1] / 2), at[2]] : null;
    return { shape, colour: typeof colour === "number" ? new THREE.Color(colour) : colour, rest: o.matrix.clone(), role, pivot: pivot && new THREE.Vector3(...pivot) };
  });
  rig.palette = rig.coats.map(([a, b]) => ({ a: new THREE.Color(a), b: new THREE.Color(b) }));
}

const unit = (a, b) => hash32(a, b) / 4294967296;
const ease = (rate, dt) => 1 - Math.exp(-rate * dt);
/** The shortest way round from one angle to another, in radians. */
function turn(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class Life {
  /** @param {import("./world.js").World} world  @param {import("./sounds.js").Sounds} sounds */
  constructor(scene, world, sounds) {
    this.world = world;
    this.sounds = sounds;
    this.byChunk = new Map(); // chunk key -> { chunk, herds }
    this.herds = []; // nearest first
    this.states = new Map(); // animal id -> how it is reacting to players
    this.shown = 0;
    this.lastTime = 0;
    this.meshes = {};
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    for (const [name, geometry] of Object.entries(SHAPES)) {
      const mesh = new THREE.InstancedMesh(geometry, material, CAPACITY);
      mesh.frustumCulled = false; // the instances are spread around the player, far from the unit shape
      mesh.count = 0;
      mesh.setColorAt(0, new THREE.Color(0xffffff));
      scene.add(mesh);
      this.meshes[name] = mesh;
    }
    this.base = new THREE.Matrix4();
    this.tmp = new THREE.Matrix4();
    this.rot = new THREE.Matrix4();
    this.euler = new THREE.Euler(0, 0, 0, "YXZ");
    this.q = new THREE.Quaternion();
    this.v = new THREE.Vector3();
    this.s = new THREE.Vector3();
  }

  /** Call a couple of times a second: picks up herds from chunks that have arrived and drops those that left. */
  sync(position) {
    const world = this.world;
    const S = world.tileM;
    for (const [key, entry] of this.byChunk) if (world.chunks.get(key) !== entry.chunk) this.byChunk.delete(key);
    for (const [key, chunk] of world.chunks) {
      if (!chunk.homes || this.byChunk.has(key)) continue;
      const herds = [];
      for (const it of chunk.homes) {
        if (!RIGS[it.sp] || ![it.id, it.n, it.r, it.u, it.v].every(Number.isFinite)) continue;
        const home = { id: it.id >>> 0, sp: it.sp, n: Math.min(12, Math.max(1, Math.round(it.n))), r: Math.min(40, Math.max(1, it.r)) };
        herds.push({ home, wx: chunk.x + it.u, wy: chunk.y + it.v, x: (chunk.x + it.u - world.originX) * S, z: (chunk.y + it.v - world.originY) * S, d: 0 });
      }
      this.byChunk.set(key, { chunk, herds });
    }
    this.herds = [];
    for (const { herds } of this.byChunk.values()) {
      for (const h of herds) {
        h.d = Math.hypot(h.x - position.x, h.z - position.z);
        if (h.d < SHOW_M + h.home.r) this.herds.push(h);
      }
    }
    this.herds.sort((a, b) => a.d - b.d);
    if (this.states.size > 600) this.states.clear(); // far-off animals are forgotten; they are calm again by the time we return
  }

  /** Every animal of the herds near the player at shared time `t`, by latitude and longitude (for the tests). */
  where(t) {
    const S = this.world.tileM;
    const out = [];
    for (const h of this.herds) {
      for (let k = 0; k < h.home.n; k++) {
        const c = creatureAt(h.home, k, t);
        out.push({ id: c.id, sp: h.home.sp, lat: yToLat(h.wy + c.y / S), lon: xToLon(h.wx + c.x / S), moving: c.moving });
      }
    }
    return out;
  }

  /**
   * Every frame. `t` is the shared clock in seconds; `players` are scene positions of everyone
   * (this player's feet and the other players' figures).
   */
  update(dt, t, players, camera) {
    const counts = { sphere: 0, cyl: 0, cone: 0, box: 0 };
    const slot = Math.floor(t / CALL_SLOT);
    let shown = 0;
    for (const herd of this.herds) {
      if (shown >= MAX_SHOWN) break;
      const rig = RIGS[herd.home.sp];
      for (let k = 0; k < herd.home.n && shown < MAX_SHOWN; k++) {
        if (this.draw(herd, rig, k, dt, t, slot, players, counts)) shown++;
      }
    }
    for (const [name, mesh] of Object.entries(this.meshes)) {
      mesh.count = counts[name];
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
    }
    this.shown = shown;
    this.lastTime = t;
    this.sounds.listen(camera);
  }

  draw(herd, rig, k, dt, t, slot, players, counts) {
    const c = creatureAt(herd.home, k, t);
    const sx = herd.x + c.x;
    const sz = herd.z + c.y;
    let st = this.states.get(c.id);
    if (!st) this.states.set(c.id, (st = { ox: 0, oz: 0, yaw: (-c.yaw * Math.PI) / 180, walk: 0, head: 0, look: 0, gait: 0, fleeing: false, quietUntil: 0 }));

    // ---- who is near? Measured from where the animal should be, so stepping aside does not make it dither.
    let near = null;
    let nearD = Infinity;
    for (const p of players) {
      const d = Math.hypot(p.x - sx, p.z - sz);
      if (d < nearD) { nearD = d; near = p; }
    }
    const fleeing = nearD < rig.flee;
    let wantX = 0;
    let wantZ = 0;
    if (fleeing) {
      const away = Math.min(3, rig.flee - nearD + 0.8) / Math.max(nearD, 0.01);
      wantX = (sx - near.x) * away;
      wantZ = (sz - near.z) * away;
    }
    const pull = ease(fleeing ? 5 : 0.8, dt);
    const stepX = (wantX - st.ox) * pull;
    const stepZ = (wantZ - st.oz) * pull;
    st.ox += stepX;
    st.oz += stepZ;
    const aside = Math.hypot(stepX, stepZ);
    const hurrying = dt > 0 && aside / dt > 0.25;
    if (fleeing && !st.fleeing && t > st.quietUntil) {
      st.quietUntil = t + 5;
      this.call(rig.alarm, c.id, sx, sz);
    }
    st.fleeing = fleeing;

    const x = sx + st.ox;
    const z = sz + st.oz;
    const y = this.world.groundHeight(x, z);
    if (y === null) return false;

    // ---- its voice: at moments everyone agrees on
    if (herd.d < HEAR_M) {
      const at = callTime(c.id, herd.home.sp, slot);
      if (at !== null && at > this.lastTime && at <= t && t - this.lastTime < 1) this.call(rig.voice, c.id, x, z, y);
    }

    // ---- pose
    const moving = c.moving || hurrying;
    st.walk += ((moving ? 1 : 0) - st.walk) * ease(8, dt);
    st.gait += aside;
    const wantYaw = hurrying ? Math.atan2(-stepX, -stepZ) : (-c.yaw * Math.PI) / 180;
    st.yaw += turn(st.yaw, wantYaw) * ease(hurrying ? 10 : 4, dt);
    const alert = nearD < rig.alert && !moving;
    let pitch = 0;
    let look = 0;
    if (alert) {
      // Head up, turned to the visitor as far as a neck goes.
      const dx = near.x - x;
      const dz = near.z - z;
      const lx = dx * Math.cos(st.yaw) - dz * Math.sin(st.yaw);
      const lz = dx * Math.sin(st.yaw) + dz * Math.cos(st.yaw);
      look = Math.min(1.1, Math.max(-1.1, Math.atan2(-lx, -lz)));
    } else if (c.graze && !moving) {
      const tick = t * (rig.peck ? 5 : 4) + (c.id % 628) / 100;
      pitch = rig.peck ? -rig.graze * Math.max(0, Math.sin(tick)) ** 3 : -rig.graze + Math.sin(tick) * 0.06;
    }
    st.head += (pitch - st.head) * ease(rig.peck ? 14 : 2.5, dt);
    st.look += (look - st.look) * ease(4, dt);
    const stride = ((c.gait + st.gait) / rig.stride) * Math.PI * 2;
    const swing = Math.sin(stride) * 0.55 * st.walk;
    const size = 0.9 + 0.2 * unit(c.id, SALT_COAT + 1);
    const coat = rig.palette[hash32(c.id, SALT_COAT) % rig.palette.length];

    this.base.compose(this.v.set(x, y + Math.abs(Math.sin(stride)) * 0.03 * st.walk * size, z), this.q.setFromEuler(this.euler.set(0, st.yaw, 0)), this.s.set(size, size, size));
    for (const part of rig.built) {
      const mesh = this.meshes[part.shape];
      const i = counts[part.shape];
      if (i >= CAPACITY) continue;
      counts[part.shape] = i + 1;
      if (part.role) {
        if (part.role === "head") this.euler.set(st.head, st.look, 0);
        else if (part.role === "tail") this.euler.set(0, 0, Math.sin(t * 2.2 + (c.id % 628) / 100) * 0.25);
        else this.euler.set(part.role === "leg0" || part.role === "leg3" ? swing : -swing, 0, 0);
        // Turn the part about its pivot: move the pivot to the origin, rotate, move it back.
        const drop = part.role === "head" ? rig.drop * Math.min(1, Math.max(0, -st.head / rig.graze)) : 0;
        this.rot.makeRotationFromEuler(this.euler);
        this.tmp.makeTranslation(part.pivot.x, part.pivot.y - drop, part.pivot.z).multiply(this.rot);
        this.rot.makeTranslation(-part.pivot.x, -part.pivot.y, -part.pivot.z);
        this.tmp.multiply(this.rot).multiply(part.rest).premultiply(this.base);
      } else {
        this.tmp.multiplyMatrices(this.base, part.rest);
      }
      mesh.setMatrixAt(i, this.tmp);
      mesh.setColorAt(i, part.colour === "a" ? coat.a : part.colour === "b" ? coat.b : part.colour);
    }
    return true;
  }

  /** Each animal has its own voice: a little higher or lower than its neighbours. */
  call(kind, id, x, z, y = this.world.groundHeight(x, z) ?? 0) {
    this.sounds.play(kind, x, y + 0.8, z, 0.86 + 0.28 * unit(id, 0x564f4943));
  }
}

export { SPECIES, memberId };
