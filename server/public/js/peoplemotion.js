// Where somebody strolling inside a shop, an office or a mall is, by the shared clock: numbers only, so
// that everybody sees them in the same place, and so that the server's tests can check the rule
// (docs/PROTOCOL.md, "Inside other buildings"). people.js draws them; the Windows game does the same sums.

import { hash32 } from "./lifemotion.js";

/** How fast a stroller walks, in metres a second, and how long they stand at each end of their path. */
export const STROLL_PACE = 0.9;
export const STROLL_WAIT = 4;

/**
 * A stroller `id` on the path `pts` (x, z, x, z... in metres) at shared time `t` seconds: where they are,
 * the way they face (a unit vector), and whether they are walking. They walk the path, stand a while,
 * walk back, stand a while, for ever.
 */
export function strollAt(id, pts, t) {
  const n = pts.length / 2;
  const far = [0];
  for (let i = 1; i < n; i++) far.push(far[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]));
  const L = far[n - 1];
  if (!(L > 0.01)) return { x: pts[0], z: pts[1], fx: 0, fz: 1, moving: false };
  const leg = L / STROLL_PACE;
  const P = 2 * (leg + STROLL_WAIT);
  const tau = (((t + (hash32(id, 0x57414c4b) / 4294967296) * P) % P) + P) % P;
  const back = tau >= leg + STROLL_WAIT;
  const into = back ? tau - leg - STROLL_WAIT : tau; // seconds into this leg
  const moving = into < leg;
  const along = moving ? into * STROLL_PACE : L; // metres from where this leg began
  const d = back ? L - along : along; // metres from the start of the path
  let i = 1;
  while (i < n - 1 && far[i] < d) i++;
  const span = far[i] - far[i - 1] || 1;
  const f = Math.min(1, Math.max(0, (d - far[i - 1]) / span));
  const dx = (pts[i * 2] - pts[i * 2 - 2]) / span, dz = (pts[i * 2 + 1] - pts[i * 2 - 1]) / span;
  // Standing at an end, they have turned round ready to set off again.
  const sign = (back ? -1 : 1) * (moving ? 1 : -1);
  return { x: pts[i * 2 - 2] + (pts[i * 2] - pts[i * 2 - 2]) * f, z: pts[i * 2 - 1] + (pts[i * 2 + 1] - pts[i * 2 - 1]) * f, fx: dx * sign, fz: dz * sign, moving };
}
