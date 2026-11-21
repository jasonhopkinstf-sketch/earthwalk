// Going into houses. The labels of a chunk say which front doors open (items of kind "door"); the
// inside of a house is fetched the first time somebody goes in, and stays with its chunk
// (docs/PROTOCOL.md, "Inside houses"). The rooms are inside the real walls, so friends who go in
// together see each other there, and nobody outside can see in.
//
// E beside a door goes in; E just inside it goes out again.

import { decodeChunk } from "./chunk.js";
import { CHUNK_Z, TILES } from "./geo.js";

/** How near a door you must stand, outside it and inside it. */
const REACH_OUT_M = 2.2;
const REACH_IN_M = 1.7;

export class Houses {
  /**
   * @param {{ world: import("./world.js").World, player: import("./player.js").Player,
   *   hint: (text: string) => void, say: (text: string) => void }} parts
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.near = null; // the door E would use: { chunk, door, x, z, ox, oz, inside }
    this.busy = false;
    this.sinceScan = 0;
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
            const x = (chunk.x + door.u - world.originX) * world.tileM;
            const z = (chunk.y + door.v - world.originY) * world.tileM;
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
    this.hint(best ? (best.inside ? "E: go out" : "E: go in") : "");
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
      return;
    }
    this.busy = true;
    try {
      if (!at.chunk.interiors?.has(at.door.id)) {
        const wrapped = ((at.chunk.x % TILES) + TILES) % TILES;
        const res = await fetch(`/v1/interior/${CHUNK_Z}/${wrapped}/${at.chunk.y}/${at.door.id}`, { headers: world.code ? { Authorization: `Bearer ${world.code}` } : {} });
        if (!res.ok) throw new Error(res.status === 404 ? "This door is stuck." : "The door would not open just now. Try again in a moment.");
        const data = decodeChunk(await res.arrayBuffer());
        if (world.chunks.get(`${at.chunk.x}/${at.chunk.y}`) !== at.chunk) return; // the chunk went away meanwhile
        world.addInterior(at.chunk, at.door.id, data);
      }
      p.flying = false;
      p.position.x = at.x - at.ox * 0.9;
      p.position.z = at.z - at.oz * 0.9;
      p.position.y = at.door.h + 0.02;
      p.velocityY = 0;
      p.grounded = true;
      p.yaw = Math.atan2(-at.ox, at.oz); // facing in
    } catch (err) {
      this.say(err.message);
    } finally {
      this.busy = false;
    }
  }
}
