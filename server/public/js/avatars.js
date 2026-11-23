// Other players, shown as simple animal figures with their name above them.
// The figures are built from basic shapes and jointed, so they stride, hop, blink, fly and sit
// (figuremotion.js); the animal id is what travels over the network, so better models can replace
// these without changing anything else.

import * as THREE from "three";
import { newFigureState, restPose, stepFigure } from "./figuremotion.js";
import { makeHat } from "./hats.js";
import { paint } from "./look.js";

export const ANIMALS = [
  { id: "fox", label: "Fox", emoji: "🦊", body: 0xd9682b, belly: 0xf4ede2, ears: "pointed", tail: "bushy" },
  { id: "bear", label: "Bear", emoji: "🐻", body: 0x7a5234, belly: 0xb08a63, ears: "round", tail: "stub" },
  { id: "rabbit", label: "Rabbit", emoji: "🐰", body: 0xe6e0d6, belly: 0xffffff, ears: "long", tail: "stub" },
  { id: "cat", label: "Cat", emoji: "🐱", body: 0x5d6270, belly: 0xc9ccd4, ears: "pointed", tail: "thin" },
  { id: "owl", label: "Owl", emoji: "🦉", body: 0x8a6b4a, belly: 0xd9c7a8, ears: "tuft", tail: "none" },
  { id: "frog", label: "Frog", emoji: "🐸", body: 0x5fae4e, belly: 0xd8e8a8, ears: "none", tail: "none" },
];
const byId = new Map(ANIMALS.map((a) => [a.id, a]));

const sphere = new THREE.SphereGeometry(1, 20, 14);
const cone = new THREE.ConeGeometry(1, 1, 12);
const lambert = (hex) => paint({ color: hex });
const dark = lambert(0x1c1c1c);

function part(geometry, material, scale, position) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.set(...scale);
  mesh.position.set(...position);
  return mesh;
}

// Where a figure bends (the same places as in EarthAnimalFigure.cpp): x to its right, y up, z behind it.
const HIPS = [0, 0.5, 0];
const NECK = [0, 0.88, 0];
const SHOULDER = [0.3, 0.8, -0.02];
const HIP = [0.15, 0.42, 0];
const TAIL_ROOT = [0, 0.42, 0.26];
const LEG = 0.32; // from the hip down to the foot
const EARS = {
  pointed: { at: [0.16, 1.3, 0], shape: cone, size: [0.09, 0.2, 0.06], middle: [0.16, 1.4, 0] },
  round: { at: [0.2, 1.27, 0], shape: sphere, size: [0.1, 0.1, 0.05], middle: [0.2, 1.32, 0] },
  long: { at: [0.1, 1.28, 0.02], shape: sphere, size: [0.06, 0.26, 0.04], middle: [0.1, 1.52, 0.02] },
  tuft: { at: [0.18, 1.29, -0.04], shape: cone, size: [0.05, 0.14, 0.05], middle: [0.18, 1.36, -0.04] },
};

/** A joint: a group that turns about the place `at` (in the figure's own measure), inside `parent`. */
function joint(parent, at) {
  const g = new THREE.Group();
  const from = parent.userData.at ?? [0, 0, 0];
  g.position.set(at[0] - from[0], at[1] - from[1], at[2] - from[2]);
  g.userData.at = at;
  g.userData.rest = g.position.clone();
  parent.add(g);
  return g;
}

/** Hangs a part, placed in the figure's own measure, on a joint. */
function put(on, mesh) {
  const at = on.userData.at;
  mesh.position.x -= at[0];
  mesh.position.y -= at[1];
  mesh.position.z -= at[2];
  on.add(mesh);
  return mesh;
}

/**
 * A figure about 1.4 m tall, feet at y = 0, facing north (-z). It is jointed, so that it can walk,
 * hop, blink, fly and sit: `animateAnimal` moves it.
 */
export function makeAnimal(id) {
  const a = byId.get(id) ?? byId.get("fox");
  const body = lambert(a.body);
  const belly = lambert(a.belly);
  const g = new THREE.Group();
  const all = joint(g, [0, 0, 0]); // squashes and stretches from the feet up
  const hips = joint(all, HIPS); // the whole figure lifts and leans here
  const trunk = joint(hips, HIPS);
  const head = joint(hips, NECK);
  const tail = joint(trunk, TAIL_ROOT);
  const ears = [], arms = [], feet = [], eyes = [];

  put(trunk, part(sphere, body, [0.32, 0.4, 0.3], [0, 0.55, 0]));
  put(trunk, part(sphere, belly, [0.24, 0.3, 0.2], [0, 0.52, -0.14]));
  put(head, part(sphere, body, [0.27, 0.25, 0.26], [0, 1.1, 0]));
  if (a.id === "owl") {
    const beak = part(cone, lambert(0xe0a030), [0.05, 0.12, 0.05], [0, 1.06, -0.28]);
    beak.rotation.x = -Math.PI / 2;
    put(head, beak);
  } else {
    put(head, part(sphere, belly, [0.13, 0.1, 0.12], [0, 1.04, -0.22])); // muzzle
    put(head, part(sphere, dark, [0.04, 0.035, 0.03], [0, 1.08, -0.34])); // nose
  }
  for (const side of [-1, 1]) {
    const frog = a.id === "frog";
    const mirrored = ([x, y, z]) => [side * x, y, z];
    if (frog) put(head, part(sphere, belly, [0.09, 0.09, 0.09], [side * 0.14, 1.32, -0.08])); // bulging eye
    eyes.push(put(head, part(sphere, dark, [0.04, 0.05, 0.03], frog ? [side * 0.14, 1.33, -0.16] : [side * 0.11, 1.16, -0.22])));
    const foot = joint(hips, mirrored(HIP));
    put(foot, part(sphere, body, [0.12, 0.1, 0.17], [side * 0.15, 0.1, -0.03]));
    feet.push(foot);
    const arm = joint(trunk, mirrored(SHOULDER));
    put(arm, part(sphere, body, [0.09, 0.2, 0.1], [side * 0.34, 0.62, -0.02]));
    arms.push(arm);
    const kind = EARS[a.ears];
    if (kind) {
      const ear = joint(head, mirrored(kind.at));
      put(ear, part(kind.shape, body, kind.size, mirrored(kind.middle)));
      ears.push(ear);
    }
  }
  if (a.tail === "bushy") {
    const brush = part(sphere, body, [0.12, 0.12, 0.3], [0, 0.42, 0.42]);
    brush.rotation.x = -0.6;
    put(tail, brush);
    put(tail, part(sphere, belly, [0.09, 0.09, 0.1], [0, 0.56, 0.62]));
  }
  if (a.tail === "stub") put(tail, part(sphere, belly, [0.09, 0.09, 0.09], [0, 0.36, 0.3]));
  if (a.tail === "thin") {
    const whip = part(sphere, body, [0.04, 0.04, 0.34], [0, 0.5, 0.42]);
    whip.rotation.x = -0.9;
    put(tail, whip);
  }
  // Each figure blinks and looks about in its own time.
  let seed = 7;
  for (const ch of id) seed = (seed * 31 + ch.charCodeAt(0)) | 0;
  g.userData.rig = {
    all, hips, trunk, head, tail, ears, arms, feet, eyes,
    hopper: a.id === "rabbit" || a.id === "frog",
    state: newFigureState(seed ^ Math.floor(Math.random() * 1e9)),
    pose: restPose(),
  };
  return g;
}

/** Puts a hat (hats.js, made in the figure's own measure) on a figure's head, so it nods and leans with it. */
export function wearHat(figure, hat) {
  put(figure.userData.rig.head, hat);
}

/**
 * Moves a figure made by makeAnimal on by `dt` seconds. `motion`: speed (metres a second), turn
 * (radians a second, to its right), inAir, flying, seated (see figuremotion.js).
 */
export function animateAnimal(figure, dt, motion) {
  const r = figure.userData.rig;
  const p = stepFigure(r.state, dt, { ...motion, hopper: r.hopper }, r.pose);
  const wide = 1 / Math.sqrt(p.squash);
  r.all.scale.set(wide, p.squash, wide);
  r.hips.position.y = r.hips.userData.rest.y + p.lift;
  r.hips.rotation.set(-p.pitch, 0, -p.roll);
  r.trunk.rotation.y = p.twist;
  r.trunk.scale.set(p.breathe, 1, p.breathe);
  r.head.rotation.set(-p.headPitch, -p.headYaw, -p.headRoll);
  r.tail.rotation.set(-p.tailUp, p.tailYaw, 0);
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    r.ears[i]?.rotation.set(p.earBack, 0, p.twitchSide === i ? -side * p.earTwitch : 0);
    r.arms[i].rotation.set(p.armSwing[i], 0, side * p.armOut[i]);
    const foot = r.feet[i], rest = foot.userData.rest, swing = p.footSwing[i];
    foot.position.set(rest.x + side * p.footSpread, rest.y + p.footLift[i] + LEG * (1 - Math.cos(swing)) * p.footArc, rest.z - LEG * Math.sin(swing));
    foot.rotation.x = swing * 0.6;
    r.eyes[i].scale.y = p.blink ? 0.006 : 0.05;
  }
}

function nameLabel(text) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const font = "600 44px system-ui, sans-serif";
  ctx.font = font;
  canvas.width = Math.ceil(ctx.measureText(text).width) + 48;
  canvas.height = 72;
  ctx.font = font;
  ctx.fillStyle = "rgba(18, 22, 28, 0.72)";
  ctx.beginPath();
  ctx.roundRect(0, 0, canvas.width, canvas.height, 22);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 24, 38);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // Constant size on screen, and drawn over buildings so people can find each other.
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, sizeAttenuation: false, depthTest: false, transparent: true }));
  const h = 0.035;
  sprite.scale.set((h * canvas.width) / canvas.height, h, 1);
  sprite.renderOrder = 10;
  sprite.layers.set(1); // not on the little map (minimap.js, NOT_ON_MAP)
  return sprite;
}

export class Avatars {
  constructor(scene) {
    this.scene = scene;
    this.shown = new Map(); // peer id -> { group, target, yaw, name, avatar }
  }

  /**
   * My own figure. The game is seen through its eyes, so it is only drawn when the camera stands back from it:
   * at the wheel of a car. `me` is null to put it away; `yaw` is its rotation about the upright.
   */
  showSelf(dt, me, position, yaw, flying = -1) {
    const own = this.own;
    if (!me || own?.avatar !== me.avatar) {
      if (own) this.scene.remove(own.group);
      this.own = null;
      if (!me) return;
    }
    if (!this.own) {
      this.own = { group: makeAnimal(me.avatar), avatar: me.avatar, hat: null, hatMesh: null };
      this.scene.add(this.own.group);
    }
    const mine = this.own;
    if ((me.hat ?? null) !== mine.hat) {
      mine.hatMesh?.removeFromParent();
      mine.hat = me.hat ?? null;
      mine.hatMesh = mine.hat ? makeHat(mine.hat) : null;
      if (mine.hatMesh) wearHat(mine.group, mine.hatMesh);
    }
    mine.group.position.copy(position);
    mine.group.rotation.y = yaw;
    // Seated on what I ride; or, being flown somewhere (`flying` is then the speed, in metres a second), stretched out in the air.
    if (dt > 0) animateAnimal(mine.group, dt, { speed: Math.max(0, Math.min(60, flying)), turn: 0, inAir: flying >= 0, flying: flying >= 0, seated: flying < 0 });
  }

  remove(id) {
    const entry = this.shown.get(id);
    if (!entry) return;
    this.scene.remove(entry.group);
    entry.label.material.map.dispose();
    entry.label.material.dispose();
    this.shown.delete(id);
  }

  /** @param {Map<string, any>} peers  @param {import("./world.js").World} world */
  update(dt, peers, world) {
    for (const id of [...this.shown.keys()]) {
      const peer = peers.get(id);
      const entry = this.shown.get(id);
      if (!peer || !peer.hasPosition || peer.name !== entry.name || peer.avatar !== entry.avatar) this.remove(id);
    }
    for (const [id, peer] of peers) {
      if (!peer.hasPosition) continue;
      const target = world.geoToScene(peer.lat, peer.lon, peer.alt);
      let entry = this.shown.get(id);
      if (!entry) {
        const group = makeAnimal(peer.avatar);
        const label = nameLabel(peer.name);
        label.position.y = 1.85;
        group.add(label);
        group.position.copy(target);
        this.scene.add(group);
        entry = { group, label, name: peer.name, avatar: peer.avatar, hat: null, hatMesh: null, before: new THREE.Vector3() };
        this.shown.set(id, entry);
      }
      // The hat they are wearing, if any.
      if ((peer.hat ?? null) !== entry.hat) {
        entry.hatMesh?.removeFromParent();
        entry.hat = peer.hat ?? null;
        entry.hatMesh = entry.hat ? makeHat(entry.hat) : null;
        if (entry.hatMesh) wearHat(entry.group, entry.hatMesh);
        entry.label.position.y = entry.hatMesh ? 2.08 : 1.85; // the name clears the tallest hat
      }
      // Glide to the latest reported position; jump if they travelled.
      const g = entry.group;
      const before = entry.before.copy(g.position);
      const jumped = g.position.distanceToSquared(target) > 50 * 50;
      if (jumped) g.position.copy(target);
      else g.position.lerp(target, 1 - Math.exp(-10 * dt));
      const want = (-peer.yaw * Math.PI) / 180; // compass heading -> rotation about y
      let diff = (want - g.rotation.y) % (Math.PI * 2);
      if (diff > Math.PI) diff -= Math.PI * 2;
      if (diff < -Math.PI) diff += Math.PI * 2;
      const turned = diff * (1 - Math.exp(-10 * dt));
      g.rotation.y += turned;

      // What they are doing, worked out from how they move: nothing about it is sent.
      if (dt <= 0) continue;
      const speed = jumped ? 0 : Math.hypot(g.position.x - before.x, g.position.z - before.z) / dt;
      const climb = jumped ? 0 : (g.position.y - before.y) / dt;
      const ground = world.groundHeight(g.position.x, g.position.z);
      const above = ground === null ? 0 : g.position.y - ground;
      const seated = !!peer.ride;
      // Well clear of the ground is flying; a little clear and rising or falling is a jump (a floor
      // inside a house on a slope is a little clear of the ground too, but nobody on it is rising).
      const flying = !seated && above > 2.5;
      const inAir = !seated && (flying || (above > 0.5 && Math.abs(climb) > 0.8));
      animateAnimal(g, dt, { speed: Math.min(speed, 60), turn: -turned / dt, inAir, flying, seated });
    }
  }
}
