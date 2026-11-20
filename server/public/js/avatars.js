// Other players, shown as simple animal figures with their name above them.
// The figures are placeholders built from basic shapes; the animal id is what travels
// over the network, so better models can replace these without changing anything else.

import * as THREE from "three";

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
const lambert = (hex) => new THREE.MeshLambertMaterial({ color: hex });
const dark = lambert(0x1c1c1c);

function part(geometry, material, scale, position) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.set(...scale);
  mesh.position.set(...position);
  return mesh;
}

/** A figure about 1.4 m tall, feet at y = 0, facing north (-z). */
export function makeAnimal(id) {
  const a = byId.get(id) ?? byId.get("fox");
  const body = lambert(a.body);
  const belly = lambert(a.belly);
  const g = new THREE.Group();
  g.add(part(sphere, body, [0.32, 0.4, 0.3], [0, 0.55, 0]));
  g.add(part(sphere, belly, [0.24, 0.3, 0.2], [0, 0.52, -0.14]));
  g.add(part(sphere, body, [0.27, 0.25, 0.26], [0, 1.1, 0]));
  if (a.id === "owl") {
    const beak = part(cone, lambert(0xe0a030), [0.05, 0.12, 0.05], [0, 1.06, -0.28]);
    beak.rotation.x = -Math.PI / 2;
    g.add(beak);
  } else {
    g.add(part(sphere, belly, [0.13, 0.1, 0.12], [0, 1.04, -0.22])); // muzzle
    g.add(part(sphere, dark, [0.04, 0.035, 0.03], [0, 1.08, -0.34])); // nose
  }
  for (const side of [-1, 1]) {
    const frog = a.id === "frog";
    g.add(part(sphere, frog ? belly : dark, frog ? [0.09, 0.09, 0.09] : [0.04, 0.05, 0.03], frog ? [side * 0.14, 1.32, -0.08] : [side * 0.11, 1.16, -0.22]));
    if (frog) g.add(part(sphere, dark, [0.04, 0.05, 0.03], [side * 0.14, 1.33, -0.16]));
    g.add(part(sphere, body, [0.12, 0.1, 0.17], [side * 0.15, 0.1, -0.03])); // feet
    g.add(part(sphere, body, [0.09, 0.2, 0.1], [side * 0.34, 0.62, -0.02])); // arms
    if (a.ears === "pointed") g.add(part(cone, body, [0.09, 0.2, 0.06], [side * 0.16, 1.4, 0]));
    if (a.ears === "round") g.add(part(sphere, body, [0.1, 0.1, 0.05], [side * 0.2, 1.32, 0]));
    if (a.ears === "long") g.add(part(sphere, body, [0.06, 0.26, 0.04], [side * 0.1, 1.52, 0.02]));
    if (a.ears === "tuft") g.add(part(cone, body, [0.05, 0.14, 0.05], [side * 0.18, 1.36, -0.04]));
  }
  if (a.tail === "bushy") {
    const tail = part(sphere, body, [0.12, 0.12, 0.3], [0, 0.42, 0.42]);
    tail.rotation.x = -0.6;
    g.add(tail);
    g.add(part(sphere, belly, [0.09, 0.09, 0.1], [0, 0.56, 0.62]));
  }
  if (a.tail === "stub") g.add(part(sphere, belly, [0.09, 0.09, 0.09], [0, 0.36, 0.3]));
  if (a.tail === "thin") {
    const tail = part(sphere, body, [0.04, 0.04, 0.34], [0, 0.5, 0.42]);
    tail.rotation.x = -0.9;
    g.add(tail);
  }
  return g;
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
  return sprite;
}

export class Avatars {
  constructor(scene) {
    this.scene = scene;
    this.shown = new Map(); // peer id -> { group, target, yaw, name, avatar }
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
        entry = { group, label, name: peer.name, avatar: peer.avatar };
        this.shown.set(id, entry);
      }
      // Glide to the latest reported position; jump if they travelled.
      const g = entry.group;
      if (g.position.distanceToSquared(target) > 50 * 50) g.position.copy(target);
      else g.position.lerp(target, 1 - Math.exp(-10 * dt));
      const want = (-peer.yaw * Math.PI) / 180; // compass heading -> rotation about y
      let diff = (want - g.rotation.y) % (Math.PI * 2);
      if (diff > Math.PI) diff -= Math.PI * 2;
      if (diff < -Math.PI) diff += Math.PI * 2;
      g.rotation.y += diff * (1 - Math.exp(-10 * dt));
    }
  }
}
