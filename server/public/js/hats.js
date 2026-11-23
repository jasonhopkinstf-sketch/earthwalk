// Hats. A player buys them with the coins that daily tasks pay, or wins them, and wears one at a
// time (docs/PROTOCOL.md, "Daily tasks, coins and hats"). Only the hat's id travels; each game
// builds the hat from basic shapes, as it does the figures, sized for the head of a player's figure
// (avatars.js: the head is a ball about 0.26 m across its middle at 1.1 m, facing -z).

import * as THREE from "three";
import { paint as lookPaint } from "./look.js";

const sphere = new THREE.SphereGeometry(1, 18, 12);
const dome = new THREE.SphereGeometry(1, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2);
const tube = new THREE.CylinderGeometry(1, 1, 1, 20);
const cone = new THREE.ConeGeometry(1, 1, 16);
const paints = new Map();
const paint = (hex) => {
  let m = paints.get(hex);
  if (!m) paints.set(hex, (m = lookPaint({ color: hex })));
  return m;
};

/** The top of the head a hat sits on, and how far out the head reaches there. */
const BROW = 1.22;
const HEAD = 0.27;

const BUILD = {
  cap(g, add) {
    add(dome, 0xc8362e, [HEAD + 0.015, 0.2, HEAD + 0.015], [0, BROW, 0]);
    add(tube, 0xc8362e, [0.17, 0.025, 0.2], [0, BROW + 0.02, -0.3]); // the peak
    add(sphere, 0xf3ead7, [0.035, 0.03, 0.035], [0, BROW + 0.2, 0]);
  },
  bobble(g, add) {
    add(dome, 0x3f6fb0, [HEAD + 0.02, 0.24, HEAD + 0.02], [0, BROW - 0.02, 0]);
    add(tube, 0xf7f5ef, [HEAD + 0.035, 0.08, HEAD + 0.035], [0, BROW, 0]);
    add(sphere, 0xf7f5ef, [0.08, 0.08, 0.08], [0, BROW + 0.27, 0]);
  },
  party(g, add) {
    const hat = add(cone, 0xd8559a, [0.15, 0.4, 0.15], [0.03, BROW + 0.27, 0]);
    hat.rotation.z = -0.12;
    add(sphere, 0xf2cc4a, [0.045, 0.045, 0.045], [0.055, BROW + 0.47, 0]);
    add(tube, 0xf2cc4a, [0.155, 0.03, 0.155], [0.005, BROW + 0.085, 0]);
  },
  straw(g, add) {
    add(tube, 0xe2c675, [0.46, 0.03, 0.46], [0, BROW + 0.05, 0]);
    add(tube, 0xe2c675, [0.22, 0.15, 0.22], [0, BROW + 0.13, 0]);
    add(tube, 0xb5372e, [0.225, 0.045, 0.225], [0, BROW + 0.09, 0]);
  },
  chef(g, add) {
    add(tube, 0xf7f5ef, [0.2, 0.2, 0.2], [0, BROW + 0.14, 0]);
    add(sphere, 0xf7f5ef, [0.27, 0.15, 0.27], [0, BROW + 0.3, 0]);
  },
  cowboy(g, add) {
    const brim = add(tube, 0x8a5a3a, [0.48, 0.03, 0.4], [0, BROW + 0.05, 0]);
    brim.rotation.z = 0;
    for (const side of [-1, 1]) add(tube, 0x8a5a3a, [0.1, 0.03, 0.34], [side * 0.42, BROW + 0.085, 0]).rotation.z = side * 0.5; // the brim curls up at the sides
    add(tube, 0x8a5a3a, [0.2, 0.2, 0.2], [0, BROW + 0.15, 0]);
    add(sphere, 0x8a5a3a, [0.2, 0.06, 0.2], [0, BROW + 0.25, 0]);
    add(tube, 0x3a2a1e, [0.205, 0.04, 0.205], [0, BROW + 0.09, 0]);
  },
  top(g, add) {
    add(tube, 0x26262b, [0.33, 0.03, 0.33], [0, BROW + 0.05, 0]);
    add(tube, 0x26262b, [0.2, 0.34, 0.2], [0, BROW + 0.22, 0]);
    add(tube, 0xb5372e, [0.205, 0.05, 0.205], [0, BROW + 0.1, 0]);
  },
  flowers(g, add) {
    add(tube, 0x3f9a45, [HEAD + 0.005, 0.035, HEAD + 0.005], [0, BROW + 0.03, 0]);
    const petals = [0xe85a7a, 0xf2cc4a, 0xf7f5ef, 0x9a6ad0, 0xf08a3a];
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      add(sphere, petals[i % petals.length], [0.06, 0.05, 0.06], [Math.sin(a) * (HEAD + 0.01), BROW + 0.05, Math.cos(a) * (HEAD + 0.01)]);
    }
  },
  pirate(g, add) {
    add(dome, 0x26262b, [HEAD + 0.02, 0.22, HEAD + 0.02], [0, BROW, 0]);
    // A bicorne: the brim turned up into a half-moon before and behind.
    const front = add(dome, 0x26262b, [0.42, 0.3, 0.035], [0, BROW + 0.02, -0.25]);
    front.rotation.x = 0.22;
    const back = add(dome, 0x26262b, [0.42, 0.3, 0.035], [0, BROW + 0.02, 0.25]);
    back.rotation.x = -0.22;
    add(tube, 0xf0c53a, [0.43, 0.02, 0.3], [0, BROW + 0.03, 0]); // gold braid round the brim
    add(sphere, 0xf7f5ef, [0.06, 0.06, 0.02], [0, BROW + 0.16, -0.3]); // the badge
  },
  wizard(g, add) {
    add(tube, 0x5a3f9a, [0.4, 0.03, 0.4], [0, BROW + 0.05, 0]);
    const hat = add(cone, 0x5a3f9a, [0.24, 0.62, 0.24], [0, BROW + 0.36, 0.03]);
    hat.rotation.x = 0.12;
    for (const [x, y, z] of [[0.1, 0.2, -0.17], [-0.08, 0.34, -0.1], [0.03, 0.47, -0.02]]) add(sphere, 0xf2cc4a, [0.035, 0.035, 0.02], [x, BROW + y, z]);
  },
  explorer(g, add) {
    add(tube, 0xcdb98a, [0.4, 0.03, 0.44], [0, BROW + 0.04, 0]);
    add(dome, 0xd9c79a, [HEAD + 0.03, 0.26, HEAD + 0.03], [0, BROW + 0.04, 0]);
    add(tube, 0x8a6a4a, [HEAD + 0.035, 0.04, HEAD + 0.035], [0, BROW + 0.08, 0]);
    add(sphere, 0xcdb98a, [0.04, 0.03, 0.04], [0, BROW + 0.3, 0]);
  },
  feather(g, add) {
    add(dome, 0x3f7f4f, [HEAD + 0.02, 0.2, HEAD + 0.02], [0, BROW, 0]);
    add(tube, 0x3f7f4f, [0.3, 0.025, 0.37], [0, BROW + 0.02, -0.07]); // a brim, longest in front
    const feather = add(cone, 0xc8362e, [0.035, 0.44, 0.035], [0.21, BROW + 0.3, 0.06]);
    feather.rotation.z = -0.5;
    feather.rotation.x = -0.3;
  },
  crown(g, add) {
    add(tube, 0xf0c53a, [0.21, 0.12, 0.21], [0, BROW + 0.12, 0]);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      add(cone, 0xf0c53a, [0.05, 0.13, 0.05], [Math.sin(a) * 0.185, BROW + 0.24, Math.cos(a) * 0.185]);
      add(sphere, i % 2 ? 0xc8362e : 0x3f6fb0, [0.03, 0.03, 0.03], [Math.sin(a) * 0.215, BROW + 0.12, Math.cos(a) * 0.215]);
    }
  },
};

export const HAT_IDS = Object.keys(BUILD);

/** A hat for a player's figure, in the figure's own frame; null for a hat this game does not know. */
export function makeHat(id) {
  const build = BUILD[id];
  if (!build) return null;
  const g = new THREE.Group();
  build(g, (geometry, hex, scale, position) => {
    const mesh = new THREE.Mesh(geometry, paint(hex));
    mesh.scale.set(...scale);
    mesh.position.set(...position);
    g.add(mesh);
    return mesh;
  });
  return g;
}
