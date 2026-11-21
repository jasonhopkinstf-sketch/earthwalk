// Meetup rooms: everyone in a room sees each other's position and shares a chat.
// Messages are small JSON objects over a WebSocket (docs/PROTOCOL.md).

import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { Home, PeopleDirectory } from "./people.ts";
import { TALKABLE, Talker, type Said } from "./talk.ts";

const MAX_NAME = 24;
const MAX_ROOM = 32;
const MAX_CHAT = 300;
const MAX_ROOM_SIZE = 32;
const HISTORY = 30;
const TICK_MS = 100;
/** What can be ridden. The clients decide where each of these is; the server only keeps track of who is on what. */
const RIDEABLE = new Set(["horse", "cow", "sheep", "camel", "llama", "kangaroo", "deer", "tractor", "boat", "sailboat", "car", "train"]);
/** A driver and up to three passengers. A train takes any number, all passengers. */
const SEATS = 4;
/** How long something stays where its rider left it before it goes home, and how many a room remembers. */
const LEFT_MS = 60_000;
const LEFT_CAP = 100;
/** A thing's words reach everyone within this many metres of whoever spoke to it. */
const HEARING_M = 80;
/** Talking to things: at most this many times a minute each, and not faster than one every 1.2 s. */
const TALKS_A_MINUTE = 12;
/** Name of the browser's sign-in cookie; the token in it stands in for `hello.token`. */
export const TOKEN_COOKIE = "ew_token";

interface Member {
  id: string;
  /** The account this member is signed in to, or null for a guest. */
  personId: string | null;
  name: string;
  /** Which animal the player appears as; clients decide how each one looks. */
  avatar: string;
  ws: WebSocket;
  lat: number; lon: number; alt: number; yaw: number;
  hasPos: boolean;
  dirty: boolean;
  chatTimes: number[];
  home: Home | null;
  /** What this member is riding: the thing's identity, what it is, and their seat (0 drives). */
  ride: Ride | null;
  talkTimes: number[];
}
interface Ride { thing: number; sp: string; seat: number }
/** Something a rider got off: it stays there until `until` (server clock, ms), then goes back to where it belongs. */
interface Left { thing: number; sp: string; lat: number; lon: number; alt: number; yaw: number; until: number }
interface ChatLine { id: string; name: string; text: string; ts: number }
interface Room { members: Map<string, Member>; history: ChatLine[]; left: Map<number, Left> }

/** What the rest of the server may know about someone in a room. */
export interface RoomMember {
  id: string; personId: string | null; name: string; avatar: string; room: string;
  lat: number; lon: number; alt: number; hasPos: boolean;
}
export interface RoomsListener { joined?(m: RoomMember): void; left?(m: RoomMember): void }
/** Keeps each player's journal (journal.ts). A member's id is the key; the keeper never learns who else is in the room. */
export interface JournalKeeper {
  listen(tell: (key: string, news: { title: string; text: string; kind: string }) => void): void;
  joined(key: string, personId: string | null, room: string): Promise<void>;
  left(key: string): void;
  moved(key: string, lat: number, lon: number): void;
  rode(key: string, sp: string | null, thing?: number): void;
  talked(key: string, thing: number, sp: string, name: string, said: string, reply: string): void;
  view(key: string): unknown;
}
export interface RoomsOptions {
  /** Names a position ("Montmartre, Paris") for `/home` without a place given. */
  placeName?: (lat: number, lon: number) => Promise<string | null>;
  /** The people list sent in `people` messages; set by the presence tracker. */
  peopleList?: () => unknown[];
  /** Speaks for the things players talk to. Without one, things answer from their stock lines. */
  talker?: { greet(thing: number, sp: string): Said; reply(room: string, thing: number, sp: string, said: string, speaker: string, place: string | null): Promise<Said> };
  /** Writes down where players go and what they do, each in their own journal. Without one, nothing is. */
  journal?: JournalKeeper;
}

const clean = (s: unknown, max: number): string =>
  typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "";
const DEFAULT_AVATAR = "fox";
const avatarId = (s: unknown): string => (typeof s === "string" && /^[a-z][a-z0-9-]{0,15}$/.test(s) ? s : DEFAULT_AVATAR);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

export class Rooms {
  readonly wss: WebSocketServer;
  private readonly rooms = new Map<string, Room>();
  private readonly timer: NodeJS.Timeout;
  private readonly people: PeopleDirectory;
  private readonly options: RoomsOptions;
  private listener: RoomsListener = {};
  private peopleTimer: NodeJS.Timeout | null = null;
  private readonly talker: NonNullable<RoomsOptions["talker"]>;
  private readonly journal: JournalKeeper | null;
  /** Everyone in every room, by member id: for news that is one player's alone. */
  private readonly everyone = new Map<string, Member>();

  constructor(people: PeopleDirectory, options: RoomsOptions = {}) {
    this.people = people;
    this.options = options;
    this.talker = options.talker ?? new Talker({ ask: null, spendFile: null });
    this.journal = options.journal ?? null;
    this.journal?.listen((key, news) => {
      const m = this.everyone.get(key);
      if (m && m.ws.readyState === m.ws.OPEN) m.ws.send(JSON.stringify({ t: "stamp", ...news }));
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => this.onConnection(ws, req));
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref();
  }

  close(): void {
    clearInterval(this.timer);
    if (this.peopleTimer) clearTimeout(this.peopleTimer);
    for (const c of this.wss.clients) c.terminate();
    this.wss.close();
  }

  stats(): { rooms: number; people: number } {
    let people = 0;
    for (const r of this.rooms.values()) people += r.members.size;
    return { rooms: this.rooms.size, people };
  }

  /** Who to tell when someone arrives or leaves (one listener: the presence tracker). */
  listen(listener: RoomsListener): void {
    this.listener = listener;
  }

  setPeopleList(list: () => unknown[]): void {
    this.options.peopleList = list;
  }

  /** Everyone in every room right now. */
  listMembers(): RoomMember[] {
    const out: RoomMember[] = [];
    for (const [room, r] of this.rooms) for (const m of r.members.values()) out.push(this.publicMember(m, room));
    return out;
  }

  /** Sends the current people list to every connection, at most a few times a second. */
  announcePeople(): void {
    if (this.peopleTimer || !this.options.peopleList) return;
    this.peopleTimer = setTimeout(() => {
      this.peopleTimer = null;
      const text = JSON.stringify({ t: "people", p: this.options.peopleList!() });
      for (const r of this.rooms.values()) for (const m of r.members.values()) if (m.ws.readyState === m.ws.OPEN) m.ws.send(text);
    }, 300);
    this.peopleTimer.unref();
  }

  private publicMember(m: Member, room: string): RoomMember {
    return { id: m.id, personId: m.personId, name: m.name, avatar: m.avatar, room, lat: m.lat, lon: m.lon, alt: m.alt, hasPos: m.hasPos };
  }

  private onConnection(ws: WebSocket, req?: IncomingMessage): void {
    let room: Room | null = null;
    let roomName = "";
    let me: Member | null = null;
    let joining = false;
    const cookieToken = cookieValue(req?.headers.cookie, TOKEN_COOKIE);
    const send = (obj: unknown): void => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
    const helloTimer = setTimeout(() => { if (!me) ws.close(4000, "no hello"); }, 10000);

    ws.on("message", async (data, isBinary) => {
      if (isBinary) return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString("utf8"));
      } catch {
        return;
      }
      if (typeof msg !== "object" || msg === null) return;

      if (!me) {
        if (msg.t !== "hello" || joining) return;
        joining = true;
        const hello = {
          name: clean(msg.name, MAX_NAME), room: clean(msg.room, MAX_ROOM) || "lobby",
          token: clean(msg.token, 128) || cookieToken || undefined, avatar: clean(msg.avatar, 16) || undefined,
        };
        const person = await this.people.identify(hello).catch(() => null);
        if (!person) { send({ t: "error", code: "denied", text: "Access denied" }); ws.close(4001, "denied"); return; }
        if (ws.readyState !== ws.OPEN) return;
        roomName = hello.room.toLowerCase();
        let r = this.rooms.get(roomName);
        if (!r) this.rooms.set(roomName, (r = { members: new Map(), history: [], left: new Map() }));
        if (r.members.size >= MAX_ROOM_SIZE) { send({ t: "error", code: "full", text: "Room is full" }); ws.close(4002, "full"); return; }
        // Names must be unique in a room so "/join <name>" is unambiguous.
        let name = clean(person.displayName, MAX_NAME) || "Guest";
        const taken = new Set([...r.members.values()].map((m) => m.name.toLowerCase()));
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${clean(person.displayName, MAX_NAME - 3)} ${n}`;
        room = r;
        me = {
          id: randomUUID().slice(0, 8), personId: person.personId, name, avatar: avatarId(person.avatar ?? msg.avatar), ws,
          lat: 0, lon: 0, alt: 0, yaw: 0, hasPos: false, dirty: false, chatTimes: [], home: person.home ?? null, ride: null, talkTimes: [],
        };
        clearTimeout(helloTimer);
        send({
          t: "welcome", id: me.id, name: me.name, avatar: me.avatar, room: roomName,
          peers: [...r.members.values()].map((m) => ({ id: m.id, name: m.name, avatar: m.avatar, ...(m.hasPos ? { lat: m.lat, lon: m.lon, alt: m.alt, yaw: m.yaw } : {}), ...(m.ride ? { ride: m.ride } : {}) })),
          left: [...r.left.values()].filter((l) => l.until > Date.now()),
          history: r.history,
          signedIn: me.personId !== null,
          ...(me.personId !== null ? { personId: me.personId, home: me.home } : {}),
          now: Date.now(),
        });
        this.broadcast(r, { t: "join", id: me.id, name: me.name, avatar: me.avatar });
        r.members.set(me.id, me);
        this.everyone.set(me.id, me);
        void this.journal?.joined(me.id, me.personId, roomName).catch(() => {});
        this.listener.joined?.(this.publicMember(me, roomName));
        if (this.options.peopleList) send({ t: "people", p: this.options.peopleList() });
        return;
      }

      if (msg.t === "pos") {
        if (!finite(msg.lat) || !finite(msg.lon) || Math.abs(msg.lat) > 90 || Math.abs(msg.lon) > 180) return;
        me.lat = msg.lat;
        me.lon = msg.lon;
        me.alt = finite(msg.alt) ? Math.max(-500, Math.min(20000, msg.alt)) : 0;
        me.yaw = finite(msg.yaw) ? msg.yaw % 360 : 0;
        me.hasPos = true;
        me.dirty = true;
        this.journal?.moved(me.id, me.lat, me.lon);
      } else if (msg.t === "chat" && room) {
        const text = clean(msg.text, MAX_CHAT);
        if (!text) return;
        const now = Date.now();
        me.chatTimes = me.chatTimes.filter((t) => now - t < 5000);
        if (me.chatTimes.length >= 6) { send({ t: "error", code: "slow", text: "You are sending messages too fast" }); return; }
        me.chatTimes.push(now);
        const line: ChatLine = { id: me.id, name: me.name, text, ts: now };
        room.history.push(line);
        if (room.history.length > HISTORY) room.history.shift();
        this.broadcast(room, { t: "chat", ...line });
      } else if (msg.t === "ride" && room) {
        // Hop on something, or (with no `thing`) hop off.
        this.dismount(room, me);
        const sp = clean(msg.sp, 16);
        if (!finite(msg.thing) || !Number.isInteger(msg.thing) || msg.thing < 1 || msg.thing > 0xffffffff || !RIDEABLE.has(sp)) return;
        const thing = msg.thing;
        const taken = new Set([...room.members.values()].filter((m) => m.ride?.thing === thing && m.ride.sp === sp).map((m) => m.ride!.seat));
        let seat = sp === "train" ? 1 : 0;
        while (sp !== "train" && taken.has(seat)) seat++;
        if (seat >= SEATS) { send({ t: "error", code: "taken", text: "There is no room left on that one" }); return; }
        me.ride = { thing, sp, seat };
        this.journal?.rode(me.id, sp, thing);
        room.left.delete(thing);
        this.broadcast(room, { t: "ride", id: me.id, ...me.ride });
      } else if (msg.t === "talk" && room) {
        // Say hello to a thing (no `text`), or say something to it. Everyone nearby hears the answer.
        const sp = clean(msg.sp, 16);
        if (!finite(msg.thing) || !Number.isInteger(msg.thing) || msg.thing < 1 || msg.thing > 0xffffffff || !TALKABLE.has(sp)) return;
        const now = Date.now();
        me.talkTimes = me.talkTimes.filter((t) => now - t < 60_000);
        if (me.talkTimes.length >= TALKS_A_MINUTE || now - (me.talkTimes[me.talkTimes.length - 1] ?? 0) < 1200) {
          send({ t: "error", code: "slow", text: "Give them a moment to answer" });
          return;
        }
        me.talkTimes.push(now);
        const thing = msg.thing;
        const text = clean(msg.text, 200);
        let said: Said;
        if (text) {
          const place = me.hasPos && this.options.placeName ? await this.options.placeName(me.lat, me.lon).catch(() => null) : null;
          said = await this.talker.reply(roomName, thing, sp, text, me.avatar, place);
        } else said = this.talker.greet(thing, sp);
        if (!room.members.has(me.id)) return; // left while it was thinking
        this.journal?.talked(me.id, thing, sp, said.name, text, said.text);
        const out = JSON.stringify({ t: "say", thing, sp, name: said.name, text: said.text, by: me.id, ...(text ? { q: text } : {}), ...(me.hasPos ? { lat: +me.lat.toFixed(7), lon: +me.lon.toFixed(7) } : {}) });
        for (const m of room.members.values()) {
          const near = m === me || (m.hasPos && me.hasPos && Math.hypot((m.lat - me.lat) * 111_320, (m.lon - me.lon) * 111_320 * Math.cos((me.lat * Math.PI) / 180)) <= HEARING_M);
          if (near && m.ws.readyState === m.ws.OPEN) m.ws.send(out);
        }
      } else if (msg.t === "time") {
        // The shared clock: the client sends its own stamp and gets it back with our time, so it can allow for the delay.
        send({ t: "time", c: finite(msg.c) ? msg.c : 0, now: Date.now() });
      } else if (msg.t === "journal") {
        // My own journal: nobody can ask for anyone else's.
        send({ t: "journal", journal: this.journal?.view(me.id) ?? null });
      } else if (msg.t === "people") {
        if (this.options.peopleList) send({ t: "people", p: this.options.peopleList() });
      } else if (msg.t === "home") {
        // Set my home: to the given place, or to where I am standing.
        if (me.personId === null || !this.people.setHome) { send({ t: "error", code: "guest", text: "Sign in to set a home" }); return; }
        const given = finite(msg.lat) && finite(msg.lon) && Math.abs(msg.lat) <= 85 && Math.abs(msg.lon) <= 180;
        if (!given && !me.hasPos) { send({ t: "error", code: "nowhere", text: "You have not arrived anywhere yet" }); return; }
        const lat = given ? (msg.lat as number) : me.lat;
        const lon = given ? (msg.lon as number) : me.lon;
        let name = clean(msg.name, 80);
        if (!name && this.options.placeName) name = (await this.options.placeName(lat, lon).catch(() => null)) ?? "";
        const home: Home = { lat, lon, name: name || `${lat.toFixed(5)}, ${lon.toFixed(5)}` };
        try {
          await this.people.setHome(me.personId, home);
        } catch {
          send({ t: "error", code: "home", text: "Could not save your home" });
          return;
        }
        me.home = home;
        send({ t: "home", ...home });
      }
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (!room || !me) return;
      this.dismount(room, me);
      this.journal?.left(me.id);
      this.everyone.delete(me.id);
      room.members.delete(me.id);
      if (room.members.size === 0) this.rooms.delete(roomName);
      else this.broadcast(room, { t: "leave", id: me.id });
      this.listener.left?.(this.publicMember(me, roomName));
    });
    ws.on("error", () => ws.terminate());
  }

  /**
   * Takes a member off whatever they are riding and tells the room. When the driver gets off, the
   * passengers get off too, and the thing stays where it is for a minute (a train just carries on).
   */
  private dismount(room: Room, m: Member): void {
    const ride = m.ride;
    if (!ride) return;
    m.ride = null;
    this.journal?.rode(m.id, null);
    this.broadcast(room, { t: "ride", id: m.id });
    if (ride.seat !== 0 || ride.sp === "train") return;
    for (const other of room.members.values()) {
      if (other.ride?.thing !== ride.thing || other.ride.sp !== ride.sp) continue;
      other.ride = null;
      this.journal?.rode(other.id, null);
      this.broadcast(room, { t: "ride", id: other.id });
    }
    if (!m.hasPos) return;
    const now = Date.now();
    for (const [thing, l] of room.left) if (l.until <= now) room.left.delete(thing);
    if (room.left.size >= LEFT_CAP) room.left.delete(room.left.keys().next().value!);
    const left: Left = { thing: ride.thing, sp: ride.sp, lat: +m.lat.toFixed(7), lon: +m.lon.toFixed(7), alt: +m.alt.toFixed(2), yaw: +m.yaw.toFixed(1), until: now + LEFT_MS };
    room.left.set(ride.thing, left);
    this.broadcast(room, { t: "left", ...left });
  }

  private broadcast(room: Room, obj: unknown): void {
    const text = JSON.stringify(obj);
    for (const m of room.members.values()) if (m.ws.readyState === m.ws.OPEN) m.ws.send(text);
  }

  /** Ten times a second, tell each room who moved. */
  private tick(): void {
    for (const room of this.rooms.values()) {
      const moved: [string, number, number, number, number][] = [];
      for (const m of room.members.values()) {
        if (!m.dirty) continue;
        m.dirty = false;
        moved.push([m.id, +m.lat.toFixed(7), +m.lon.toFixed(7), +m.alt.toFixed(2), +m.yaw.toFixed(1)]);
      }
      if (moved.length === 0 || room.members.size < 2) continue;
      for (const m of room.members.values()) {
        const others = moved.filter((p) => p[0] !== m.id);
        if (others.length && m.ws.readyState === m.ws.OPEN) m.ws.send(JSON.stringify({ t: "peers", p: others }));
      }
    }
  }
}
