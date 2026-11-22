// Animals in the browser: farm animals, ducks, birds, pets and wild creatures, wherever the server
// says one lives. Where each is comes from lifemotion.js and the shared clock, so everyone in a room
// sees the same animal in the same place. What happens when a player comes close (a look, a step
// aside, a dog trotting over, pigeons taking off) is worked out here, from the player positions we
// already have. What each animal looks like is in liferigs.js.
//
// All animals are drawn with four instanced meshes (one per basic shape), whatever their number.
// Cars, vans and taxis are ready-made models (models.gen.js), one instanced mesh each.

import * as THREE from "three";
import { xToLon, yToLat } from "./geo.js";
import { CALL_SLOT, callTime, creatureAt, hash32, memberId, SPECIES } from "./lifemotion.js";
import { RIGS, VEHICLES } from "./liferigs.js";
import { MODELS } from "./models.gen.js";

const SHOW_M = 220; // homes further off than this are not drawn
const HEAR_M = 70;
const MAX_SHOWN = 170;
const CAPACITY = 2048; // shapes per kind of shape
const SALT_COAT = 0x434f4154;
/** How something being ridden holds its head: up, looking where it is going. */
const MOUNT_POSE = { head: 0, look: 0 };

const SHAPES = {
  sphere: new THREE.SphereGeometry(1, 12, 8),
  cyl: new THREE.CylinderGeometry(1, 1, 1, 8),
  cone: new THREE.ConeGeometry(1, 1, 8),
  box: new THREE.BoxGeometry(1, 1, 1),
};

// Turn the readable tables of liferigs.js into matrices once.
for (const rig of [...Object.values(RIGS), ...Object.values(VEHICLES)]) {
  const o = new THREE.Object3D();
  rig.built = rig.parts.map(([shape, colour, at, size, role = "", tilt = 0]) => {
    o.position.set(at[0], at[1], at[2]);
    o.rotation.set(tilt, 0, 0);
    o.scale.set(size[0], size[1], size[2]);
    o.updateMatrix();
    const half = shape === "sphere" ? size[1] : size[1] / 2;
    let pivot = null;
    if (role === "head") pivot = rig.neck; // a head turns about the neck
    else if (role === "tailup") pivot = [at[0], at[1] - half, at[2]]; // a raised tail stands on its base
    else if (role.startsWith("wing")) {
      // A spread wing flaps from its inner end; a folded one, or a flipper, from its top.
      pivot = size[0] > size[1] ? [at[0] - Math.sign(at[0]) * size[0], at[1], at[2]] : [at[0], at[1] + half, at[2]];
    } else if (role) pivot = [at[0], at[1] + (shape === "sphere" ? 0 : half), at[2]]; // legs and tails hang from their tops
    return { shape, colour: typeof colour === "number" ? new THREE.Color(colour) : colour, rest: o.matrix.clone(), role, pivot: pivot && new THREE.Vector3(...pivot) };
  });
  rig.palette = rig.coats.map(([a, b]) => ({ a: new THREE.Color(a), b: new THREE.Color(b) }));
}

// The ready-made models: three cars from Kenney's Car Kit (public domain), in place of the shapes above
// for the vehicles that have one. ?models=ours in the address draws our own shapes again.
const MODEL_CAPACITY = 512;
const bytes = (text) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));
/** One model as a geometry: each corner has its own colour, and `own` is 1 where the car's paint goes. */
function modelGeometry(model) {
  const p = new Int16Array(bytes(model.p).buffer), n = new Int8Array(bytes(model.n).buffer), c = bytes(model.c);
  const count = p.length / 3;
  const position = new Float32Array(count * 3), normal = new Float32Array(count * 3), color = new Float32Array(count * 3), own = new Float32Array(count);
  const paint = new THREE.Color();
  for (let k = 0; k < count; k++) {
    for (let a = 0; a < 3; a++) {
      position[k * 3 + a] = p[k * 3 + a] / 1000;
      normal[k * 3 + a] = n[k * 3 + a] / 127;
    }
    paint.setRGB(c[k * 4] / 255, c[k * 4 + 1] / 255, c[k * 4 + 2] / 255, THREE.SRGBColorSpace);
    color[k * 3] = paint.r;
    color[k * 3 + 1] = paint.g;
    color[k * 3 + 2] = paint.b;
    own[k] = c[k * 4 + 3] / 255;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(color, 3));
  geometry.setAttribute("own", new THREE.BufferAttribute(own, 1));
  geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(bytes(model.i).buffer), 1));
  return geometry;
}
if (new URLSearchParams(globalThis.location?.search ?? "").get("models") !== "ours") {
  for (const [name, model] of Object.entries(MODELS)) {
    if (VEHICLES[name]) VEHICLES[name].model = { key: `model:${name}`, geometry: modelGeometry(model) };
  }
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
  /**
   * @param {import("./world.js").World} world  @param {import("./sounds.js").Sounds} sounds
   * @param {import("./traffic.js").Traffic} [traffic]  cars, drawn through the same meshes
   */
  constructor(scene, world, sounds, traffic = null) {
    this.world = world;
    this.sounds = sounds;
    this.traffic = traffic;
    /** Set by main.js: riding.js, which says what is being ridden (and so not drawn where its timetable has it). */
    this.riding = null;
    /** The animals, tractors and boats near enough to hop on, as drawn last frame. */
    this.rideable = [];
    /** Everything on the ground near enough to talk to, as drawn last frame. */
    this.nearby = [];
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
    // The ready-made models: a corner keeps its own colour, except where `own` says the car's paint goes.
    const modelMaterial = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
    modelMaterial.onBeforeCompile = (shader) => {
      shader.vertexShader = "attribute float own;\n" + shader.vertexShader.replace("#include <color_vertex>", "#include <color_vertex>\n#ifdef USE_INSTANCING_COLOR\n\tvColor.xyz = mix( color.xyz, instanceColor.xyz, own );\n#endif");
    };
    for (const rig of Object.values(VEHICLES)) {
      if (!rig.model) continue;
      const mesh = new THREE.InstancedMesh(rig.model.geometry, modelMaterial, MODEL_CAPACITY);
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.setColorAt(0, new THREE.Color(0xffffff));
      scene.add(mesh);
      this.meshes[rig.model.key] = mesh;
    }
    this.base = new THREE.Matrix4();
    this.tmp = new THREE.Matrix4();
    this.rot = new THREE.Matrix4();
    this.euler = new THREE.Euler(0, 0, 0, "YXZ");
    this.q = new THREE.Quaternion();
    this.v = new THREE.Vector3();
    this.s = new THREE.Vector3();
  }

  /** Call a couple of times a second: picks up homes from chunks that have arrived and drops those that left. */
  sync(position) {
    const world = this.world;
    const S = world.tileM;
    for (const [key, entry] of this.byChunk) if (world.chunks.get(key) !== entry.chunk) this.byChunk.delete(key);
    for (const [key, chunk] of world.chunks) {
      if (!chunk.homes || this.byChunk.has(key)) continue;
      const herds = [];
      for (const it of chunk.homes) {
        if (!RIGS[it.sp] || !SPECIES[it.sp] || ![it.id, it.n, it.r, it.u, it.v, it.h].every(Number.isFinite)) continue;
        const home = { id: it.id >>> 0, sp: it.sp, n: Math.min(12, Math.max(1, Math.round(it.n))), r: Math.min(80, Math.max(1, it.r)) };
        herds.push({ home, h: it.h, wx: chunk.x + it.u, wy: chunk.y + it.v, x: (chunk.x + it.u - world.originX) * S, z: (chunk.y + it.v - world.originY) * S, d: 0 });
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
    this.traffic?.sync(position);
    if (this.states.size > 600) this.states.clear(); // far-off animals are forgotten; they are calm again by the time we return
  }

  /** Every animal of the homes near the player at shared time `t`, by latitude and longitude (for the tests). */
  where(t) {
    const S = this.world.tileM;
    const out = [];
    for (const h of this.herds) {
      for (let k = 0; k < h.home.n; k++) {
        const c = creatureAt(h.home, k, t);
        out.push({ id: c.id, sp: h.home.sp, lat: yToLat(h.wy + c.y / S), lon: xToLon(h.wx + c.x / S), alt: c.alt, moving: c.moving });
      }
    }
    return out;
  }

  /**
   * Every frame. `t` is the shared clock in seconds; `players` are scene positions of everyone
   * (this player's feet and the other players' figures).
   */
  update(dt, t, players, camera) {
    const counts = {};
    for (const name in this.meshes) counts[name] = 0;
    const slot = Math.floor(t / CALL_SLOT);
    this.rideable.length = 0;
    this.nearby.length = 0;
    let shown = 0;
    for (const herd of this.herds) {
      if (shown >= MAX_SHOWN) break;
      const rig = RIGS[herd.home.sp];
      for (let k = 0; k < herd.home.n && shown < MAX_SHOWN; k++) {
        if (this.draw(herd, rig, k, dt, t, slot, players, counts)) shown++;
      }
    }
    this.traffic?.draw(this, dt, t, players, counts);
    this.riding?.draw(this, t, counts);
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
    // A machine that stopped for somebody is running late; it makes the time up afterwards.
    const late = rig.yields ? this.states.get(memberId(herd.home.id, k)) : null;
    const c = creatureAt(herd.home, k, t - (late?.lag ?? 0));
    if (this.riding?.hidden.has(c.id)) return false; // somebody is riding it, or has left it somewhere
    const sx = herd.x + c.x;
    const sz = herd.z + c.y;
    const beat = (c.id % 628) / 100; // so no two animals nod, wag or flap in step
    const size = 0.9 + 0.2 * unit(c.id, SALT_COAT + 1);
    const coat = rig.palette[hash32(rig.flock ? herd.home.id : c.id, SALT_COAT) % rig.palette.length];

    // ---- its voice: at moments everyone agrees on
    if (rig.voice && herd.d < HEAR_M + (rig.fly ? herd.home.r : 0)) {
      const at = callTime(c.id, herd.home.sp, slot);
      if (at !== null && at > this.lastTime && at <= t && t - this.lastTime < 1) this.call(rig.voice, c.id, sx, sz, herd.h + c.alt);
    }

    // ---- a flock overhead takes no notice of anyone
    if (rig.fly) {
      const [mid, amp] = rig.wing.air;
      this.base.compose(this.v.set(sx, herd.h + c.alt, sz), this.q.setFromEuler(this.euler.set(0, (-c.yaw * Math.PI) / 180, 0)), this.s.set(size, size, size));
      this.put(rig, coat, counts, null, mid + amp * Math.sin(t * rig.wing.rate + beat), 0, t, beat);
      return true;
    }

    let st = this.states.get(c.id);
    if (!st) this.states.set(c.id, (st = { lag: 0, tootAt: 0, ox: 0, oz: 0, up: 0, yaw: (-c.yaw * Math.PI) / 180, walk: 0, head: 0, look: 0, gait: 0, startled: false, greeted: false, quietUntil: 0 }));

    // ---- who is near? Measured from where the animal should be, so stepping aside does not make it dither.
    let near = null;
    let nearD = Infinity;
    for (const p of players) {
      const d = Math.hypot(p.x - sx, p.z - sz);
      if (d < nearD) { nearD = d; near = p; }
    }
    const startled = rig.flee > 0 && nearD < rig.flee;
    const greeting = !!rig.curious && nearD < rig.alert;
    let wantX = 0;
    let wantZ = 0;
    if (startled) {
      // Step aside, straight away from whoever it is.
      const away = Math.min(3, rig.flee - nearD + 0.8) / Math.max(nearD, 0.01);
      wantX = (sx - near.x) * away;
      wantZ = (sz - near.z) * away;
    } else if (greeting) {
      // Trot over to say hello, stopping a little short.
      const toward = Math.min(rig.curious, Math.max(0, nearD - 1.2)) / Math.max(nearD, 0.01);
      wantX = (near.x - sx) * toward;
      wantZ = (near.z - sz) * toward;
    }
    const pull = ease(startled ? 5 : greeting ? 2 : 0.8, dt);
    const stepX = (wantX - st.ox) * pull;
    const stepZ = (wantZ - st.oz) * pull;
    st.ox += stepX;
    st.oz += stepZ;
    const aside = Math.hypot(stepX, stepZ);
    const hurrying = dt > 0 && aside / dt > 0.25;
    st.up += ((startled && rig.takesOff ? rig.takesOff : 0) - st.up) * ease(startled ? 3 : 0.9, dt);
    // An insect on the wing never lands: it bobs about at its own height.
    const hover = rig.hover ? rig.hover[0] + (rig.hover[1] - rig.hover[0]) * (0.5 + 0.5 * Math.sin(t * 0.8 + beat * 3)) : 0;
    const airborne = st.up > 0.15 || !!rig.hover;
    if (((startled && !st.startled) || (greeting && !st.greeted)) && rig.alarm && t > st.quietUntil) {
      st.quietUntil = t + 5;
      this.call(rig.alarm, c.id, sx, sz);
    }
    st.startled = startled;
    st.greeted = greeting;

    const x = sx + st.ox;
    const z = sz + st.oz;
    const ground = this.world.groundHeight(x, z);
    if (ground === null) return false;

    if (rig.yields) {
      // A tractor stops for anyone in front of it, and toots.
      const a = (c.yaw * Math.PI) / 180;
      let blocked = false;
      for (const p of players) {
        const ahead = (p.x - x) * Math.sin(a) - (p.z - z) * Math.cos(a);
        const aside = Math.abs((p.x - x) * Math.cos(a) + (p.z - z) * Math.sin(a));
        if (ahead > 0.5 && ahead < rig.yields && aside < 1.8) { blocked = true; break; }
      }
      if (blocked) {
        st.lag = Math.min(90, st.lag + dt);
        if (rig.alarm && t > st.tootAt) { st.tootAt = t + 4; this.call(rig.alarm, c.id, x, z, ground); }
      } else if (st.lag > 0) st.lag = Math.max(0, st.lag - dt * 0.3);
    }

    // ---- pose
    const moving = c.moving || hurrying;
    st.walk += ((moving ? 1 : 0) - st.walk) * ease(8, dt);
    st.gait += aside;
    const facing = greeting && !hurrying && !c.moving ? Math.atan2(-(near.x - x), -(near.z - z)) : hurrying ? Math.atan2(-stepX, -stepZ) : (-c.yaw * Math.PI) / 180;
    st.yaw += turn(st.yaw, facing) * ease(hurrying ? 10 : 4, dt);
    const alert = rig.alert > 0 && nearD < rig.alert && !moving;
    let pitch = 0;
    let look = 0;
    if (alert) {
      // Head up, turned to the visitor as far as a neck goes.
      const dx = near.x - x;
      const dz = near.z - z;
      const lx = dx * Math.cos(st.yaw) - dz * Math.sin(st.yaw);
      const lz = dx * Math.sin(st.yaw) + dz * Math.cos(st.yaw);
      look = Math.min(1.1, Math.max(-1.1, Math.atan2(-lx, -lz)));
    } else if (c.graze && !moving && !airborne) {
      const tick = t * (rig.peck ? 5 : 4) + beat;
      pitch = rig.peck ? -rig.graze * Math.max(0, Math.sin(tick)) ** 3 : -rig.graze + Math.sin(tick) * 0.06;
    }
    st.head += (pitch - st.head) * ease(rig.peck ? 14 : 2.5, dt);
    st.look += (look - st.look) * ease(4, dt);
    const stride = ((c.gait + st.gait) / rig.stride) * Math.PI * 2;
    const swing = airborne ? 0 : Math.sin(stride) * 0.55 * st.walk;
    const lift = rig.hop ? Math.abs(Math.sin(stride / 2)) * rig.hop * st.walk : Math.abs(Math.sin(stride)) * 0.03 * st.walk;
    const bob = rig.swim ? Math.sin(t * 1.7 + beat) * 0.012 - rig.swim : 0;
    const roll = rig.waddle ? Math.sin(stride) * rig.waddle * st.walk : rig.heel ?? 0;
    let flap = 0;
    if (rig.wing) {
      const [mid, amp] = airborne ? rig.wing.air : startled && rig.wing.startled ? rig.wing.startled : moving ? rig.wing.walk : [0, 0];
      flap = mid + amp * Math.sin(rig.wing.rate ? t * rig.wing.rate + beat : stride);
    }

    if (herd.d < 60) this.nearby.push({ thing: c.id, sp: herd.home.sp, x, z });
    if (herd.d < 60 && this.riding?.rides(herd.home.sp)) this.rideable.push({ thing: c.id, sp: herd.home.sp, x, z, yaw: st.yaw, reach: Math.max(3, rig.flee + 2.5) }); // near enough, even as it shies away
    this.base.compose(this.v.set(x, ground + st.up + hover + (lift + bob) * size, z), this.q.setFromEuler(this.euler.set(0, st.yaw, roll)), this.s.set(size, size, size));
    this.put(rig, coat, counts, st, flap, swing, t, beat, greeting ? 4 : 1, !!rig.hop);
    return true;
  }

  /** Writes one animal's shapes: each part where its role puts it, in the animal's colours. `this.base` places the animal. */
  put(rig, coat, counts, st, flap, swing, t, beat, wag = 1, together = false) {
    if (rig.model) {
      // A vehicle with a ready-made model is that one mesh, its bodywork in the vehicle's own paint.
      const mesh = this.meshes[rig.model.key];
      const i = counts[rig.model.key];
      if (i < MODEL_CAPACITY) {
        counts[rig.model.key] = i + 1;
        mesh.setMatrixAt(i, this.base);
        mesh.setColorAt(i, coat.a);
      }
      return;
    }
    for (const part of rig.built) {
      const mesh = this.meshes[part.shape];
      const i = counts[part.shape];
      if (i >= CAPACITY) continue;
      counts[part.shape] = i + 1;
      if (part.role) {
        let drop = 0;
        if (part.role === "head") {
          this.euler.set(st.head, st.look, 0);
          drop = rig.graze ? rig.drop * Math.min(1, Math.max(0, -st.head / rig.graze)) : 0;
        } else if (part.role === "tail" || part.role === "tailup") this.euler.set(0, 0, Math.sin(t * 2.2 * wag + beat) * (wag > 1 ? 0.5 : 0.25));
        else if (part.role === "wing0") this.euler.set(0, 0, -flap);
        else if (part.role === "wing1") this.euler.set(0, 0, flap);
        else this.euler.set(together || part.role === "leg0" || part.role === "leg3" ? swing : -swing, 0, 0);
        // Turn the part about its pivot: move the pivot to the origin, rotate, move it back.
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
  }

  /**
   * Draws an animal, a tractor or a boat that somebody is riding, or has left standing, where they
   * took it. It looks just as it did at home: its coat and size come from its identity.
   * @param {{ thing: number, sp: string, x: number, y: number, z: number, yaw: number, gait: number, moving: boolean }} m
   */
  putMount(m, t, counts) {
    const rig = RIGS[m.sp];
    if (!rig) return;
    const beat = (m.thing % 628) / 100;
    const size = 0.9 + 0.2 * unit(m.thing, SALT_COAT + 1);
    const coat = rig.palette[hash32(m.thing, SALT_COAT) % rig.palette.length];
    const stride = (m.gait / rig.stride) * Math.PI * 2;
    const walk = m.moving ? 1 : 0;
    const lift = rig.hop ? Math.abs(Math.sin(stride / 2)) * rig.hop * walk : Math.abs(Math.sin(stride)) * 0.03 * walk;
    const bob = rig.swim ? Math.sin(t * 1.7 + beat) * 0.012 - rig.swim : 0;
    // An insect keeps to the air here too, wings going.
    const hover = rig.hover ? rig.hover[0] + (rig.hover[1] - rig.hover[0]) * (0.5 + 0.5 * Math.sin(t * 0.8 + beat * 3)) : 0;
    const flap = rig.hover && rig.wing ? rig.wing.air[0] + rig.wing.air[1] * Math.sin(t * rig.wing.rate + beat) : 0;
    this.base.compose(this.v.set(m.x, m.y + hover + (lift + bob) * size, m.z), this.q.setFromEuler(this.euler.set(0, m.yaw, rig.heel ?? 0)), this.s.set(size, size, size));
    this.put(rig, coat, counts, MOUNT_POSE, flap, Math.sin(stride) * 0.55 * walk, t, beat, 1, !!rig.hop);
  }

  /** A thing that is being talked to speaks up in its own voice as well, if it has one. */
  speak(sp, thing, x, z) {
    const voice = RIGS[sp]?.voice ?? { car: "toot", taxi: "toot", train: "whistle" }[sp];
    if (voice) this.call(voice, thing, x, z);
  }

  /** Each animal has its own voice: a little higher or lower than its neighbours. */
  call(kind, id, x, z, y = this.world.groundHeight(x, z) ?? 0) {
    this.sounds.play(kind, x, y + 0.8, z, 0.86 + 0.28 * unit(id, 0x564f4943));
  }
}

export { SPECIES, memberId };
