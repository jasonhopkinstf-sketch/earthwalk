// The treasure at the end of a treasure hunt (docs/PROTOCOL.md, "Treasure hunts and expeditions").
// The server says where it was found; here a chest stands there for a little while, its lid up and
// its coins turning, for the finder to look at.

import * as THREE from "three";

const SHOWN_S = 60;
const box = new THREE.BoxGeometry(1, 1, 1);
const coin = new THREE.CylinderGeometry(0.09, 0.09, 0.025, 12);
const wood = new THREE.MeshLambertMaterial({ color: 0x8a5a3a });
const band = new THREE.MeshLambertMaterial({ color: 0xd0a21e });
const gold = new THREE.MeshLambertMaterial({ color: 0xf2cc4a, emissive: 0x5a4200 });

function part(geometry, material, scale, position) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.set(...scale);
  mesh.position.set(...position);
  return mesh;
}

export class Treasure {
  /** @param {{ scene: THREE.Scene, world: import("./world.js").World }} parts */
  constructor({ scene, world }) {
    this.scene = scene;
    this.world = world;
    this.chests = []; // { group, coins, age, placed }
  }

  /** A chest at a place on the Earth, moved `dx`, `dz` metres from it (a step or two in front of the finder). */
  show(lat, lon, dx = 0, dz = 0) {
    const g = new THREE.Group();
    g.add(part(box, wood, [0.9, 0.5, 0.6], [0, 0.25, 0]));
    for (const x of [-0.3, 0.3]) g.add(part(box, band, [0.08, 0.52, 0.62], [x, 0.25, 0]));
    g.add(part(box, band, [0.16, 0.16, 0.04], [0, 0.34, -0.31])); // the lock
    const lid = new THREE.Group();
    // The lid is hinged along the back edge (the lock is at the front, towards -z) and thrown open past upright.
    lid.add(part(box, wood, [0.9, 0.16, 0.6], [0, 0.08, -0.3]));
    for (const x of [-0.3, 0.3]) lid.add(part(box, band, [0.08, 0.18, 0.62], [x, 0.08, -0.3]));
    lid.position.set(0, 0.5, 0.3);
    lid.rotation.x = 1.9;
    g.add(lid);
    g.add(part(box, gold, [0.8, 0.12, 0.5], [0, 0.48, 0])); // a heap of gold to the brim
    const coins = [];
    for (let i = 0; i < 7; i++) {
      const c = part(coin, gold, [1, 1, 1], [((i * 37) % 60) / 100 - 0.3, 0.8 + (i % 3) * 0.22, ((i * 53) % 40) / 100 - 0.2]);
      c.rotation.z = Math.PI / 2;
      coins.push(c);
      g.add(c);
    }
    const p = this.world.geoToScene(lat, lon, 0);
    g.position.set(p.x + dx, 0, p.z + dz);
    g.rotation.y = Math.atan2(dx, dz); // its front, where the lock is, to the finder
    g.visible = false;
    this.scene.add(g);
    this.chests.push({ group: g, coins, age: 0, placed: false });
  }

  /** Every frame. */
  frame(dt) {
    for (const chest of [...this.chests]) {
      chest.age += dt;
      const g = chest.group;
      if (!chest.placed) {
        const y = this.world.groundHeight(g.position.x, g.position.z);
        if (y !== null) { g.position.y = y; g.visible = true; chest.placed = true; }
      }
      chest.coins.forEach((c, i) => {
        c.rotation.y = chest.age * 3 + i;
        c.position.y = 0.8 + (i % 3) * 0.22 + Math.sin(chest.age * 2 + i) * 0.08;
      });
      const left = SHOWN_S - chest.age;
      if (left < 1) g.scale.setScalar(Math.max(0.01, left));
      if (left <= 0) {
        this.scene.remove(g);
        this.chests.splice(this.chests.indexOf(chest), 1);
      }
    }
  }
}
