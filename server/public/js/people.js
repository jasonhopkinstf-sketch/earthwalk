// The animals inside shops, cafés, offices, malls and entrance halls: at their desks and in meetings, behind
// counters, at café tables, strolling the mall. Who is where comes with the inside of the building
// (`GET /v1/inside`, kept by world.addInsideWho); only the building I am standing in has its people drawn.
//
// They are the same figures the players are (avatars.js), so they sit, stand, walk, blink and look about.
// Someone strolling is placed by the shared clock (peoplemotion.js), so friends see them in the same place.
// Everybody can be talked to (talk.js): `nearby` is the list it looks through.

import { animateAnimal, makeAnimal } from "./avatars.js";
import { TILES } from "./geo.js";
import { strollAt, STROLL_PACE } from "./peoplemotion.js";

/** How far below the seat a sitting figure's feet are: it sits a little into the chair, as on a horse. */
const SEAT_DROP = 0.13;
/** Whoever stands behind a counter turns to face a player this near. */
const NOTICE_M = 3.5;

export class People {
  /** @param {{ world: import("./world.js").World, player: import("./player.js").Player, meetup: import("./net.js").Meetup, houses: import("./houses.js").Houses }} parts */
  constructor(parts) {
    Object.assign(this, parts);
    this.shown = null; // { chunk, id, who, figures: [{ person, figure, pts, yaw }] }
    this.nearby = []; // for talk.js: { thing, sp, x, z, y, lift, job }
  }

  /** Every frame: the people of the building I am in, and nobody else. */
  frame(dt) {
    const at = this.houses.inside;
    const inside = at?.place ? at.chunk.interiors?.get(at.door.id) : null;
    const who = inside?.who ?? null;
    if (this.shown && (this.shown.who !== who || this.shown.chunk !== at?.chunk)) this.clear();
    if (who && !this.shown) this.show(at.chunk, at.door.id, who);
    this.nearby.length = 0;
    const shown = this.shown;
    if (!shown) return;
    const { world, player } = this;
    const S = world.tileM;
    const ox = (shown.chunk.x - world.originX) * S, oz = (shown.chunk.y - world.originY) * S;
    const t = this.meetup.now();
    const job = (person) => ({ role: person.role, at: { x: ((shown.chunk.x % TILES) + TILES) % TILES, y: shown.chunk.y, id: shown.id } });
    for (const f of shown.figures) {
      const { person, figure } = f;
      let speed = 0;
      if (f.pts) {
        const now = strollAt(person.id, f.pts, t);
        figure.position.set(now.x, person.h, now.z);
        f.yaw = Math.atan2(now.fx, -now.fz);
        speed = now.moving ? STROLL_PACE : 0;
      } else if (person.pose === "stand") {
        // Behind a counter, they look up at whoever comes near.
        const dx = player.position.x - (ox + figure.position.x), dz = player.position.z - (oz + figure.position.z);
        const want = Math.hypot(dx, dz) < NOTICE_M ? Math.atan2(dx, -dz) : f.rest;
        const turn = ((((want - f.yaw + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
        f.yaw += turn * Math.min(1, dt * 4);
      }
      figure.rotation.y = -f.yaw;
      animateAnimal(figure, dt, { speed, turn: 0, inAir: false, flying: false, seated: person.pose === "sit" });
      this.nearby.push({ thing: person.id, sp: person.sp, x: ox + figure.position.x, z: oz + figure.position.z, y: person.h, lift: person.pose === "sit" ? 1.55 : 1.8, job: job(person) });
    }
  }

  show(chunk, id, who) {
    const S = this.world.tileM;
    const figures = [];
    for (const person of who.people ?? []) {
      if (![person.u, person.v, person.h, person.id].every(Number.isFinite)) continue;
      const figure = makeAnimal(person.sp);
      const yaw = ((Number(person.yaw) || 0) * Math.PI) / 180; // the way they face, as a compass heading
      figure.position.set(person.u * S, person.h + (person.pose === "sit" ? (Number(person.seat) || 0.45) - SEAT_DROP : 0), person.v * S);
      figure.rotation.y = -yaw;
      const pts = person.pose === "walk" && Array.isArray(person.pts) && person.pts.length >= 4 ? person.pts.map((n) => n * S) : null;
      chunk.group.add(figure);
      figures.push({ person, figure, pts, yaw, rest: yaw });
    }
    this.shown = { chunk, id, who, figures };
  }

  clear() {
    for (const f of this.shown?.figures ?? []) this.shown.chunk.group.remove(f.figure);
    this.shown = null;
  }
}
