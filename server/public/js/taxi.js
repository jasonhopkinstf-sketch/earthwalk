// Taxis. `/taxi the beach` calls one: it comes along the road from a few streets away, waits beside
// you, and when you hop on (E) it drives you there, talking as it goes (docs/PROTOCOL.md, "Taxis").
//
// The server says where a taxi set off from and when, so every game draws it arriving in the same
// place. Once somebody is aboard it is a ridden thing like any other, and riding.js and orders.js
// take over: this only draws a taxi on its way to whoever called it.

/** How fast a taxi comes for its fare, in metres a second. */
const PACE = 9;

export class Taxis {
  /**
   * @param {{ world: import("./world.js").World, meetup: import("./net.js").Meetup,
   *   riding: import("./riding.js").Riding, say: (text: string) => void }} parts
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.ways = new Map(); // thing -> its road in scene metres, for the world as it is now: { generation, pts, upTo }
    this.used = new Set(); // taxis somebody has boarded: riding.js draws those
    this.told = new Set();
    this.meetup.addEventListener("taxi", (e) => this.onTaxi(e.detail));
    this.riding.extras.push((dt, t) => this.frame(dt, t));
  }

  onTaxi(msg) {
    if (msg.gone) {
      this.ways.delete(msg.thing);
      if (msg.by === this.meetup.me?.id) this.say("Your taxi gave up waiting and drove off.");
      return;
    }
    if (msg.by === this.meetup.me?.id) this.say(`${msg.name} the taxi is on its way, to take you to ${msg.dest}. Hop on (E) when it gets here.`);
  }

  frame(dt, t) {
    const { world, meetup, riding } = this;
    const now = t * 1000;
    for (const [thing, taxi] of meetup.taxis) {
      if (riding.hidden.has(thing)) this.used.add(thing); // somebody is aboard, or it stands where they got off
      if (this.used.has(thing) || taxi.until <= now) {
        if (taxi.until <= now) { meetup.taxis.delete(thing); this.ways.delete(thing); }
        continue;
      }
      let way = this.ways.get(thing);
      if (!way || way.generation !== world.generation) {
        const pts = taxi.path.map(([lat, lon]) => world.geoToScene(lat, lon));
        const upTo = [0];
        for (let i = 1; i < pts.length; i++) upTo.push(upTo[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
        this.ways.set(thing, (way = { generation: world.generation, pts, upTo }));
      }
      const total = way.upTo[way.upTo.length - 1];
      const gone = Math.min(total, Math.max(0, ((now - taxi.at) / 1000) * PACE));
      let i = 1;
      while (i < way.pts.length - 1 && way.upTo[i] < gone) i++;
      const a = way.pts[Math.max(0, i - 1)], b = way.pts[Math.min(i, way.pts.length - 1)];
      const span = (way.upTo[i] ?? 0) - (way.upTo[i - 1] ?? 0);
      const f = span > 0 ? (gone - way.upTo[i - 1]) / span : 1;
      const x = a.x + (b.x - a.x) * f, z = a.z + (b.z - a.z) * f;
      const y = world.groundHeight(x, z);
      const arrived = gone >= total;
      if (arrived && taxi.by === meetup.me?.id && !this.told.has(thing)) {
        this.told.add(thing);
        this.say(`${taxi.name} the taxi is here. Press E beside it to hop on.`);
      }
      riding.hidden.add(thing);
      if (y === null) continue;
      const yaw = a === b ? 0 : Math.atan2(-(b.x - a.x), -(b.z - a.z));
      riding.mounts.push({ key: "", thing, sp: "taxi", x, z, y, yaw, gait: gone, moving: !arrived });
    }
  }
}
