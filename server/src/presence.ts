// Who is online and where: joins the account records with what the rooms know right now,
// and names positions ("Montmartre, Paris") through a throttled reverse lookup.

import type { AccountDirectory } from "./people.ts";
import type { RoomMember, Rooms } from "./rooms.ts";

/** One line of the people list, as sent to clients and from `GET /v1/people`. */
export interface PeopleEntry {
  id: string;
  name: string;
  avatar: string;
  online: boolean;
  room: string | null;
  place: string | null;
  lat: number | null;
  lon: number | null;
  /** Milliseconds since the epoch; for someone online, now. */
  lastSeen: number;
  home: string | null;
}

interface Named { lat: number; lon: number; place: string | null; at: number }

/** Roughly 300 m at the equator; a new place name is not looked up for smaller moves. */
const MOVE_DEG = 0.003;
const RENAME_MS = 30_000;
const ROUND = 4; // decimals kept in positions sent to others (about 10 m)

export class Presence {
  private readonly dir: AccountDirectory;
  private readonly rooms: Rooms;
  private readonly placeName: (lat: number, lon: number) => Promise<string | null>;
  private readonly named = new Map<string, Named>(); // personId -> last named position
  private readonly timer: NodeJS.Timeout;
  private naming = new Set<string>();

  constructor(dir: AccountDirectory, rooms: Rooms, placeName: (lat: number, lon: number) => Promise<string | null>, intervalMs = 5000) {
    this.dir = dir;
    this.rooms = rooms;
    this.placeName = placeName;
    rooms.setPeopleList(() => this.snapshot());
    rooms.listen({
      joined: (m) => { if (m.personId) { this.dir.touch(m.personId, { room: m.room }); rooms.announcePeople(); } },
      left: (m) => this.left(m),
    });
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
  }

  /** Everyone with an account, online ones first, then by when they were last seen. */
  snapshot(): PeopleEntry[] {
    const online = new Map<string, RoomMember>();
    for (const m of this.rooms.listMembers()) if (m.personId && !online.has(m.personId)) online.set(m.personId, m);
    const now = Date.now();
    const list = this.dir.list().map((p): PeopleEntry => {
      const m = online.get(p.id);
      const named = this.named.get(p.id);
      if (m) {
        return {
          id: p.id, name: m.name, avatar: m.avatar, online: true, room: m.room,
          place: named?.place ?? null, lat: m.hasPos ? +m.lat.toFixed(ROUND) : null, lon: m.hasPos ? +m.lon.toFixed(ROUND) : null,
          lastSeen: now, home: p.home?.name ?? null,
        };
      }
      return { id: p.id, name: p.name, avatar: p.avatar, online: false, room: p.lastRoom, place: p.lastPlace, lat: null, lon: null, lastSeen: p.lastSeen, home: p.home?.name ?? null };
    });
    return list.sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen || a.name.localeCompare(b.name));
  }

  /** Names the position of anyone who moved far enough since their last name. Safe to call often. */
  async refresh(): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const m of this.rooms.listMembers()) {
      if (!m.personId || !m.hasPos || this.naming.has(m.personId)) continue;
      const last = this.named.get(m.personId);
      const now = Date.now();
      if (last && Math.abs(last.lat - m.lat) < MOVE_DEG && Math.abs(last.lon - m.lon) < MOVE_DEG) continue;
      if (last && now - last.at < RENAME_MS) continue;
      const personId = m.personId;
      this.naming.add(personId);
      jobs.push(this.placeName(m.lat, m.lon).catch(() => null).then((place) => {
        this.naming.delete(personId);
        const before = this.named.get(personId)?.place ?? null;
        this.named.set(personId, { lat: m.lat, lon: m.lon, place: place ?? before, at: Date.now() });
        this.dir.touch(personId, { room: m.room, place: place ?? before, lat: m.lat, lon: m.lon });
        if (place !== before) this.rooms.announcePeople();
      }));
    }
    await Promise.all(jobs);
  }

  private left(m: RoomMember): void {
    if (!m.personId) return;
    const named = this.named.get(m.personId);
    this.dir.touch(m.personId, { room: m.room, place: named?.place ?? null, lat: m.hasPos ? m.lat : null, lon: m.hasPos ? m.lon : null });
    this.rooms.announcePeople();
  }
}
