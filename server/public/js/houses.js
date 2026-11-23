// Going into houses, and having one of your own. The labels of a chunk say which front doors open
// (items of kind "door"); the inside of a house is fetched the first time somebody goes in, and stays
// with its chunk (docs/PROTOCOL.md, "Inside houses"). The rooms are inside the real walls, so friends
// who go in together see each other there, and nobody outside can see in.
//
// E beside a door goes in; E just inside it goes out again. H is the home key: inside a house nobody
// lives in it makes the house yours, inside your own it opens the furnishing panel (decor.js), and
// anywhere else it takes you home. A house somebody lives in is furnished their way, and is fetched
// again whenever they change it (docs/PROTOCOL.md, "A house of your own").

import { decodeChunk } from "./chunk.js";
import { CHUNK_Z, TILES } from "./geo.js";

/** How near a door you must stand, outside it and inside it. */
const REACH_OUT_M = 2.2;
const REACH_IN_M = 1.7;
/** Further than this from the door of the house you went into, you are no longer in it. */
const HOUSE_M = 45;

const wrap = (x) => ((x % TILES) + TILES) % TILES;
/** A house's name on the server: its chunk and its number there. */
export const houseKey = (chunk, id) => `${wrap(chunk.x)}/${chunk.y}/${id}`;
/** What goes on the board over the door. */
export const doorName = (name) => (/s$/i.test(name) ? `${name}' house` : `${name}'s house`);

export class Houses {
  /**
   * @param {{ world: import("./world.js").World, player: import("./player.js").Player, meetup: import("./net.js").Meetup,
   *   decor: { open: boolean, toggle: () => void, close: () => void },
   *   hint: (text: string) => void, say: (text: string) => void }} parts
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.near = null; // the door E would use: { chunk, door, x, z, ox, oz, inside }
    this.inside = null; // the house I went into: { chunk, door, key }
    this.busy = false;
    this.sinceScan = 0;
    this.sure = { key: "", until: 0 }; // moving house wants H twice
    this.meetup.addEventListener("lived", (e) => void this.changed(e.detail));
    this.had = ""; // my own house, as last heard, so that moving in and out can be told
    this.quiet = true; // what a new connection says of my house is not news
    this.meetup.addEventListener("homes", () => { this.quiet = true; this.world.nameHomes(this.meetup.homes); });
    this.meetup.addEventListener("house", (e) => {
      const now = e.detail ? `${e.detail.x}/${e.detail.y}/${e.detail.id}` : "";
      if (!this.quiet && now !== this.had) {
        this.say(now ? "This house is yours now, and your name is over the door. Press H in here to furnish it; anywhere else, H brings you home."
          : "You have moved out. Your furniture and prizes are kept for your next house.");
      }
      this.quiet = false;
      this.had = now;
      if (!this.mine() && !this.atDoor()) this.decor.close();
    });
  }

  /** Am I just outside my own front door, in the garden? */
  atDoor() {
    const mine = this.meetup.house;
    if (!mine || this.player.waitingForGround) return false;
    const door = this.world.geoToScene(mine.lat, mine.lon);
    return Math.hypot(door.x - this.player.position.x, door.z - this.player.position.z) < 18;
  }

  /** Is the house I am in my own? */
  mine() {
    const mine = this.meetup.house;
    return !!mine && !!this.inside && this.inside.key === `${mine.x}/${mine.y}/${mine.id}`;
  }

  /** Every frame: which door, if any, is within reach? */
  frame(dt) {
    if ((this.sinceScan += dt) < 0.15) return;
    this.sinceScan = 0;
    const { world, player: p } = this;
    let best = null;
    let bestD = Infinity;
    if (!p.waitingForGround && !p.mount && !p.carried) {
      const here = world.chunkAt(p.position.x, p.position.z);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const chunk = world.chunks.get(`${here.cx + dx}/${here.cy + dy}`);
          for (const door of chunk?.doors ?? []) {
            const { x, z } = this.doorAt(chunk, door);
            const d = Math.hypot(x - p.position.x, z - p.position.z);
            if (d >= bestD || d > REACH_OUT_M) continue;
            const yaw = (door.yaw * Math.PI) / 180; // the way out, as a compass heading
            const ox = Math.sin(yaw), oz = -Math.cos(yaw);
            const side = (p.position.x - x) * ox + (p.position.z - z) * oz;
            const inside = side < 0;
            if (inside && (d > REACH_IN_M || Math.abs(p.position.y - door.h) > 1.5)) continue;
            bestD = d;
            best = { chunk, door, x, z, ox, oz, inside };
          }
        }
      }
    }
    this.near = best;
    // Still in the house I went into? Not once I have travelled, or wandered off (flying out through the roof).
    const at = this.inside;
    if (at) {
      const door = this.doorAt(at.chunk, at.door);
      const gone = p.waitingForGround || world.chunks.get(`${at.chunk.x}/${at.chunk.y}`) !== at.chunk
        || Math.hypot(door.x - p.position.x, door.z - p.position.z) > HOUSE_M || Math.abs(p.position.y - at.door.h) > 4;
      if (gone) this.left();
    }
    const whose = best && !best.inside ? this.meetup.homes.get(houseKey(best.chunk, best.door.id)) : null;
    this.hint(best ? (best.inside ? "E: go out" : whose ? `E: go into ${doorName(whose.name)}` : "E: go in")
      : this.inside ? (this.mine() ? "H: furnish your house" : this.meetup.homes.has(this.inside.key) ? "" : "H: make this your house") : "");
  }

  doorAt(chunk, door) {
    const { world } = this;
    return { x: (chunk.x + door.u - world.originX) * world.tileM, z: (chunk.y + door.v - world.originY) * world.tileM };
  }

  left() {
    this.inside = null;
    this.decor.close();
  }

  /** Fetches the inside of a house and puts it in its chunk, in place of what was there. */
  async fetchInside(chunk, door) {
    const { world } = this;
    const key = houseKey(chunk, door.id);
    const rev = this.meetup.homes.get(key)?.rev ?? 0;
    const res = await fetch(`/v1/interior/${CHUNK_Z}/${wrap(chunk.x)}/${chunk.y}/${door.id}${rev ? `?r=${rev}` : ""}`, { headers: world.code ? { Authorization: `Bearer ${world.code}` } : {} });
    if (!res.ok) throw new Error(res.status === 404 ? "This door is stuck." : "The door would not open just now. Try again in a moment.");
    const data = decodeChunk(await res.arrayBuffer());
    if (world.chunks.get(`${chunk.x}/${chunk.y}`) !== chunk) return false; // the chunk went away meanwhile
    world.addInterior(chunk, door.id, data, rev);
    return true;
  }

  /** A house has been moved into, furnished differently, or left: what is built of its inside is out of date. */
  async changed(home) {
    const { world } = this;
    world.nameHomes(this.meetup.homes);
    const key = `${home.x}/${home.y}/${home.id}`;
    for (const chunk of world.chunks.values()) {
      if (wrap(chunk.x) !== home.x || chunk.y !== home.y || !chunk.interiors?.has(home.id)) continue;
      const rev = home.gone ? 0 : home.rev;
      if (chunk.interiors.get(home.id).rev === rev) continue;
      const door = chunk.doors?.find((d) => d.id === home.id);
      // Standing in it, I see it change round me; otherwise it is fetched afresh the next time I go in.
      if (door && this.inside?.key === key) {
        try { await this.fetchInside(chunk, door); } catch { /* it stays as it was until the next change */ }
      } else world.removeInterior(chunk, home.id);
    }
  }

  /** The E key at a door. */
  async use() {
    const at = this.near;
    if (!at || this.busy) return;
    const { world, player: p } = this;
    if (at.inside) {
      p.position.x = at.x + at.ox * 1.4;
      p.position.z = at.z + at.oz * 1.4;
      p.position.y = world.groundHeight(p.position.x, p.position.z) ?? at.door.h;
      p.velocityY = 0;
      this.left();
      return;
    }
    this.busy = true;
    try {
      const key = houseKey(at.chunk, at.door.id);
      const whose = this.meetup.homes.get(key);
      if (at.chunk.interiors?.get(at.door.id)?.rev !== (whose?.rev ?? 0) && !(await this.fetchInside(at.chunk, at.door))) return;
      p.flying = false;
      p.position.x = at.x - at.ox * 0.9;
      p.position.z = at.z - at.oz * 0.9;
      p.position.y = at.door.h + 0.02;
      p.velocityY = 0;
      p.grounded = true;
      p.yaw = Math.atan2(-at.ox, at.oz); // facing in
      this.inside = { chunk: at.chunk, door: at.door, key };
      const mine = this.meetup.house;
      if (this.mine()) this.say("Welcome home. Press H to change the furniture.");
      else if (whose) this.say(`This is ${doorName(whose.name)}.`);
      else this.say(mine ? "Nobody lives here. Press H twice to move in here, and your furniture comes with you." : "Nobody lives here. Press H to make it your house.");
    } catch (err) {
      this.say(err.message);
    } finally {
      this.busy = false;
    }
  }

  /** The H key: make this house mine, furnish my own, or go home. */
  home() {
    const { meetup, player: p } = this;
    const mine = meetup.house;
    const at = this.inside;
    if (at && this.mine()) return void this.decor.toggle();
    if (at) {
      const whose = meetup.homes.get(at.key);
      if (whose) return this.say(`${doorName(whose.name)}: it is theirs to furnish. Yours is a press of H away, once you are outside.`);
      // Moving out of a furnished house wants a second press, so that it cannot happen by accident.
      if (mine && !(this.sure.key === at.key && performance.now() < this.sure.until)) {
        this.sure = { key: at.key, until: performance.now() + 8000 };
        return this.say("Move here from your other house? Press H again to move in. Your furniture and prizes come with you.");
      }
      this.sure = { key: "", until: 0 };
      return void meetup.sendHouse({ claim: { x: wrap(at.chunk.x), y: at.chunk.y, id: at.door.id } });
    }
    // Just outside my own front door, where the garden is, H opens the same panel: the animals are in view.
    if (mine && !at) {
      const door = this.world.geoToScene(mine.lat, mine.lon);
      if (!p.waitingForGround && Math.hypot(door.x - p.position.x, door.z - p.position.z) < 18) return void this.decor.toggle();
    }
    if (!mine) return this.say("You have no house yet. Go into a house nobody lives in (E at a door with a COME IN board) and press H there.");
    if (p.mount || p.carried) return this.say("Hop off first (E), then H takes you home.");
    this.goHome();
  }

  /** Travels to my own front door, a few steps outside it. */
  goHome() {
    const mine = this.meetup.house;
    if (!mine) return;
    const yaw = (mine.yaw * Math.PI) / 180; // the way out of the door
    const out = 3;
    const lat = mine.lat + (Math.cos(yaw) * out) / 111_320;
    const lon = mine.lon + (Math.sin(yaw) * out) / (111_320 * Math.cos((mine.lat * Math.PI) / 180));
    this.say("Going home...");
    this.left();
    this.player.travelTo(lat, lon);
    this.player.yaw = yaw + Math.PI; // facing the door
    this.player.pitch = 0;
  }

  /** Gives my house up. */
  moveOut() {
    if (!this.meetup.house) return this.say("You have no house to move out of.");
    this.meetup.sendHouse({ leave: true });
    this.decor.close();
  }
}
