// The map ahead of a traveller.
//
// A game asks for the world a couple of chunks round its player, and for the next row only as the
// player crosses into a new chunk. Building that row means downloading the map for it, which takes
// the public map servers anything from a few seconds to a minute: fine at a walk, but a train or a
// car reaches the edge of what is built long before, and rides out into nothing.
//
// So the server looks ahead itself. It already hears where every player is, ten times a second, from
// every kind of game. From that it works out which way each one is going and how fast, and downloads
// the map for the ground they will come to in the next couple of minutes, quietly, behind whatever
// anybody is actually waiting for. By the time the game asks for that row, the slow part is done.

import { CHUNK_Z, latToY, lonToX, metersPerTile } from "./geo.ts";
import { DATA_Z } from "./osm.ts";

/** How often one player's travel is looked at. */
const EVERY_MS = 3000;
/** Slower than this (metres a second, a brisk walk) and the game's own asking keeps up. */
const SLOW = 2;
/** How far ahead in time to have the map ready, and the most that is in metres. */
const AHEAD_S = 120;
const MAX_AHEAD_M = 4500;
/** A game asks for this many chunks each side of its player by itself. */
const SEEN_CHUNKS = 2;
/** Further than this between two looks is a journey by magic (a /goto), not travel: nothing to look ahead along. */
const JUMP_M_PER_S = 150;

/**
 * The data tiles a traveller is coming to: from the edge of what their game has already asked for,
 * out to `metres` further, as wide as the game will ask for when it gets there. `east` and `north`
 * are the direction of travel (any length).
 */
export function tilesAhead(lat: number, lon: number, east: number, north: number, metres: number): [number, number][] {
  const length = Math.hypot(east, north);
  if (!(length > 0) || !(metres > 0)) return [];
  const x = lonToX(lon), y = latToY(lat);
  const chunkM = metersPerTile(y);
  const ax = east / length, ay = -north / length; // world y grows southwards
  const shift = CHUNK_Z - DATA_Z;
  const max = 2 ** DATA_Z;
  const out = new Map<string, [number, number]>();
  const far = SEEN_CHUNKS + metres / chunkM;
  for (let along = SEEN_CHUNKS + 0.5; along <= far + 0.5; along += 1) {
    for (const across of [-SEEN_CHUNKS, 0, SEEN_CHUNKS]) {
      const dx = Math.floor(x + ax * along - ay * across) >> shift;
      const dy = Math.floor(y + ay * along + ax * across) >> shift;
      if (dy < 0 || dy >= max) continue;
      const wrapped = ((dx % max) + max) % max;
      out.set(`${wrapped}/${dy}`, [wrapped, dy]);
    }
  }
  return [...out.values()];
}

export class LookAhead {
  private readonly seen = new Map<string, { lat: number; lon: number; at: number; east: number; north: number }>();
  private readonly warm: (dx: number, dy: number) => void;

  /** `warm` sees that one data tile is downloaded; it must not fail, and need not be waited for. */
  constructor(warm: (dx: number, dy: number) => void) {
    this.warm = warm;
  }

  /** A player said where they are. Cheap: all but one call in thirty returns at once. */
  moved(id: string, lat: number, lon: number, now = Date.now()): void {
    const was = this.seen.get(id);
    if (!was) {
      if (this.seen.size >= 2000) this.forgetOld(now);
      this.seen.set(id, { lat, lon, at: now, east: 0, north: 0 });
      return;
    }
    const dt = (now - was.at) / 1000;
    if (dt < EVERY_MS / 1000) return;
    const east = (lon - was.lon) * 111_320 * Math.cos((lat * Math.PI) / 180);
    const north = (lat - was.lat) * 111_320;
    // After a jump, or a long silence, what went before says nothing about where they are going.
    const fresh = dt > 20 || Math.hypot(east, north) > JUMP_M_PER_S * dt;
    const going = fresh ? { east: 0, north: 0 } : { east: was.east * 0.4 + (east / dt) * 0.6, north: was.north * 0.4 + (north / dt) * 0.6 };
    this.seen.set(id, { lat, lon, at: now, ...going });
    const speed = Math.hypot(going.east, going.north);
    if (speed < SLOW) return;
    for (const [dx, dy] of tilesAhead(lat, lon, going.east, going.north, Math.min(MAX_AHEAD_M, speed * AHEAD_S))) this.warm(dx, dy);
  }

  private forgetOld(now: number): void {
    for (const [id, s] of this.seen) if (now - s.at > 10 * 60_000) this.seen.delete(id);
    if (this.seen.size >= 2000) this.seen.clear();
  }
}
