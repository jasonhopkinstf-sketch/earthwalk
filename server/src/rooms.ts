// Meetup rooms: everyone in a room sees each other's position and shares a chat.
// Messages are small JSON objects over a WebSocket (docs/PROTOCOL.md).

import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { hash32 } from "./geo.ts";
import type { Home, PeopleDirectory } from "./people.ts";
import { TALKABLE, Talker, type Said, type Wish } from "./talk.ts";

const MAX_NAME = 24;
const MAX_ROOM = 32;
const MAX_CHAT = 300;
const MAX_ROOM_SIZE = 32;
const HISTORY = 30;
const TICK_MS = 100;
/** What can be ridden. The clients decide where each of these is; the server only keeps track of who is on what. */
const RIDEABLE = new Set(["horse", "cow", "sheep", "camel", "llama", "kangaroo", "deer", "donkey", "pig", "goat", "zebra", "elephant", "giraffe", "bison", "moose", "reindeer", "bear", "lion", "panda", "tortoise", "tractor", "boat", "sailboat", "car", "taxi", "train"]);
/** A taxi waits this long for whoever called it, may be called this often, and says this many things of its own on a ride, about this far apart. */
const TAXI_WAIT_MS = 5 * 60_000;
const TAXI_EVERY_MS = 15_000;
const TAXI_REMARKS = 10;
const TAXI_REMARK_MS = 24_000;
/** A driver and up to three passengers. A train takes any number, all passengers. */
const SEATS = 4;
/** How long something stays where its rider left it before it goes home, and how many a room remembers. */
const LEFT_MS = 60_000;
const LEFT_CAP = 100;
/** A thing's words reach everyone within this many metres of whoever spoke to it. */
const HEARING_M = 80;
/** Talking to things: at most this many times a minute each, and not faster than one every 1.2 s. */
const TALKS_A_MINUTE = 12;
/** How long a thing goes on doing as it was told, how many orders a room keeps, and how many one player may have out at once. */
const ORDER_MS = 10 * 60_000;
const ORDER_CAP = 60;
const ORDERS_EACH = 6;
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
  taxiAt: number;
  /** The animal that keeps this member company, with an identity of its own (so it can be talked to). */
  pet: { sp: string; thing: number } | null;
}
interface Ride { thing: number; sp: string; seat: number }
/** Something a rider got off: it stays there until `until` (server clock, ms), then goes back to where it belongs. */
interface Left { thing: number; sp: string; lat: number; lon: number; alt: number; yaw: number; until: number }
/**
 * Something a thing has been told to do and is still doing: follow whoever told it (`by`), go over to
 * where they stood (`to`), or stay where it is. `lat`/`lon` are where it was when told, by the word of
 * the player who told it. Clients work out the rest (docs/PROTOCOL.md, "Doing as asked").
 */
interface Order { thing: number; sp: string; act: "follow" | "come" | "stay"; by: string; lat: number; lon: number; to?: [number, number]; at: number; until: number }
interface ChatLine { id: string; name: string; text: string; ts: number }
interface Room { members: Map<string, Member>; history: ChatLine[]; left: Map<number, Left>; orders: Map<number, Order>; taxis: Map<number, Taxi> }
/** Where a named place is, and the way there by road when there is one. */
export interface Way { name: string; lat: number; lon: number; path?: [number, number][] }
/** A taxi somebody called: where it is coming from (`path`, ending beside them), where it will take them, and who is aboard. */
interface Taxi { thing: number; by: string; name: string; path: [number, number][]; at: number; until: number; dest: Way; aboard: string | null; remarks: number; nextRemark: number }
/** What `cab` finds for a caller: where they want to go, and the road the taxi comes along. */
export interface Cab { dest: Way; pickup: [number, number][] }

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
  /** Companions: choosing one of those won (false if it is not theirs), and the one chosen. */
  setPet?(key: string, sp: string | null): boolean;
  petOf?(key: string): string | null;
}
export interface RoomsOptions {
  /** Names a position ("Montmartre, Paris") for `/home` without a place given. */
  placeName?: (lat: number, lon: number) => Promise<string | null>;
  /** The people list sent in `people` messages; set by the presence tracker. */
  peopleList?: () => unknown[];
  /** Speaks for the things players talk to. Without one, things answer from their stock lines. */
  talker?: {
    greet(thing: number, sp: string): Said;
    reply(room: string, thing: number, sp: string, said: string, speaker: string, place: string | null, riding?: boolean): Promise<Said>;
    muse?(room: string, thing: number, sp: string, place: string | null, dest: string | null, n: number): Promise<Said>;
  };
  /** Finds where a caller wants a taxi to take them, and a road for the taxi to arrive by. */
  cab?: (lat: number, lon: number, place: string) => Promise<Cab | null>;
  /** How long after its fare boards a taxi first speaks, and how long between remarks, in milliseconds (shortened in tests). */
  taxiRemarkMs?: [number, number];
  /** Finds a place a rider has asked to be taken to, near where they are, with the way there by road if it is close. */
  wayTo?: (lat: number, lon: number, place: string, sp: string) => Promise<Way | null>;
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
        if (!r) this.rooms.set(roomName, (r = { members: new Map(), history: [], left: new Map(), orders: new Map(), taxis: new Map() }));
        if (r.members.size >= MAX_ROOM_SIZE) { send({ t: "error", code: "full", text: "Room is full" }); ws.close(4002, "full"); return; }
        // Names must be unique in a room so "/join <name>" is unambiguous.
        let name = clean(person.displayName, MAX_NAME) || "Guest";
        const taken = new Set([...r.members.values()].map((m) => m.name.toLowerCase()));
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${clean(person.displayName, MAX_NAME - 3)} ${n}`;
        room = r;
        me = {
          id: randomUUID().slice(0, 8), personId: person.personId, name, avatar: avatarId(person.avatar ?? msg.avatar), ws,
          lat: 0, lon: 0, alt: 0, yaw: 0, hasPos: false, dirty: false, chatTimes: [], home: person.home ?? null, ride: null, talkTimes: [], taxiAt: 0, pet: null,
        };
        clearTimeout(helloTimer);
        send({
          t: "welcome", id: me.id, name: me.name, avatar: me.avatar, room: roomName,
          peers: [...r.members.values()].map((m) => ({ id: m.id, name: m.name, avatar: m.avatar, ...(m.hasPos ? { lat: m.lat, lon: m.lon, alt: m.alt, yaw: m.yaw } : {}), ...(m.ride ? { ride: m.ride } : {}), ...(m.pet ? { pet: m.pet } : {}) })),
          left: [...r.left.values()].filter((l) => l.until > Date.now()),
          orders: [...r.orders.values()].filter((o) => o.until > Date.now()),
          taxis: [...r.taxis.values()].filter((x) => !x.aboard && x.until > Date.now()).map((x) => this.publicTaxi(x)),
          history: r.history,
          signedIn: me.personId !== null,
          ...(me.personId !== null ? { personId: me.personId, home: me.home } : {}),
          now: Date.now(),
        });
        this.broadcast(r, { t: "join", id: me.id, name: me.name, avatar: me.avatar });
        r.members.set(me.id, me);
        this.everyone.set(me.id, me);
        // Once their journal is open, the companion they chose last time comes along.
        const arrived = me;
        void this.journal?.joined(me.id, me.personId, roomName).then(() => this.bringPet(r, arrived, this.journal?.petOf?.(arrived.id) ?? null)).catch(() => {});
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
        const taxi = sp === "taxi" ? room.taxis.get(thing) : undefined;
        if (sp === "taxi" && !taxi) { send({ t: "error", code: "taken", text: "That taxi has gone" }); return; }
        const taken = new Set([...room.members.values()].filter((m) => m.ride?.thing === thing && m.ride.sp === sp).map((m) => m.ride!.seat));
        let seat = sp === "train" ? 1 : 0;
        while (sp !== "train" && taken.has(seat)) seat++;
        if (seat >= SEATS) { send({ t: "error", code: "taken", text: "There is no room left on that one" }); return; }
        me.ride = { thing, sp, seat };
        this.journal?.rode(me.id, sp, thing);
        room.left.delete(thing);
        this.release(room, thing); // whoever rides it is in charge of it now
        this.broadcast(room, { t: "ride", id: me.id, ...me.ride });
        if (taxi && seat === 0) {
          // The fare is aboard: off to where they asked to go, with a driver who talks. (Told after the
          // `ride` above: their game must know it is aboard before it is told where to drive.)
          taxi.aboard = me.id;
          taxi.nextRemark = Date.now() + (this.options.taxiRemarkMs?.[0] ?? 9000);
          const way = taxi.dest;
          send({ t: "order", thing, sp, act: "goto", name: way.name, lat: +way.lat.toFixed(7), lon: +way.lon.toFixed(7), ...(way.path ? { path: way.path } : {}) });
        }
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
          said = await this.talker.reply(roomName, thing, sp, text, me.avatar, place, me.ride?.thing === thing && me.ride.sp === sp);
        } else said = this.talker.greet(thing, sp);
        if (!room.members.has(me.id)) return; // left while it was thinking
        this.journal?.talked(me.id, thing, sp, said.name, text, said.text);
        const out = JSON.stringify({ t: "say", thing, sp, name: said.name, text: said.text, by: me.id, ...(text ? { q: text } : {}), ...(me.hasPos ? { lat: +me.lat.toFixed(7), lon: +me.lon.toFixed(7) } : {}) });
        for (const m of room.members.values()) {
          const near = m === me || (m.hasPos && me.hasPos && Math.hypot((m.lat - me.lat) * 111_320, (m.lon - me.lon) * 111_320 * Math.cos((me.lat * Math.PI) / 180)) <= HEARING_M);
          if (near && m.ws.readyState === m.ws.OPEN) m.ws.send(out);
        }
        if (said.wish) {
          // Where the thing is, by the word of the player talking to it; failing that, where they are themselves.
          const here = finite(msg.lat) && finite(msg.lon) && Math.abs(msg.lat) <= 90 && Math.abs(msg.lon) <= 180 ? { lat: msg.lat, lon: msg.lon } : me.hasPos ? { lat: me.lat, lon: me.lon } : null;
          if (here) await this.obey(room, me, thing, sp, said, here);
        }
      } else if (msg.t === "time") {
        // The shared clock: the client sends its own stamp and gets it back with our time, so it can allow for the delay.
        send({ t: "time", c: finite(msg.c) ? msg.c : 0, now: Date.now() });
      } else if (msg.t === "taxi" && room) {
        // Call a taxi to take me somewhere. One comes along the road, and waits.
        const place = clean(msg.place, 80);
        const now = Date.now();
        if (!place || !me.hasPos) { send({ t: "error", code: "nowhere", text: "Say where to: /taxi the beach" }); return; }
        if (now - me.taxiAt < TAXI_EVERY_MS || !this.options.cab) { send({ t: "error", code: "slow", text: "No taxi is free just now. Try again in a moment." }); return; }
        me.taxiAt = now;
        const cab = await this.options.cab(me.lat, me.lon, place).catch(() => null);
        if (!room.members.has(me.id)) return;
        if (!cab) { send({ t: "error", code: "nowhere", text: `No taxi could find "${place}"` }); return; }
        for (const old of [...room.taxis.values()]) if (old.by === me.id && !old.aboard) this.dismiss(room, old.thing); // one at a time
        const thing = (hash32(parseInt(me.id, 16) | 0, (now & 0x7fffffff) ^ room.taxis.size) >>> 0) || 1;
        const called: Taxi = { thing, by: me.id, name: this.talker.greet(thing, "taxi").name, path: cab.pickup, at: Date.now(), until: Date.now() + TAXI_WAIT_MS, dest: cab.dest, aboard: null, remarks: 0, nextRemark: 0 };
        room.taxis.set(thing, called);
        this.broadcast(room, this.publicTaxi(called));
      } else if (msg.t === "pet" && room) {
        // Choose a companion from those I have won, or (with no `sp`) send it home.
        const sp = clean(msg.sp, 16) || null;
        if (!this.journal?.setPet?.(me.id, sp)) { send({ t: "error", code: "locked", text: "Solve its riddle first" }); return; }
        this.bringPet(room, me, sp);
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
      for (const o of [...room.orders.values()]) if (o.by === me.id) this.release(room, o.thing); // their followers go home
      for (const x of [...room.taxis.values()]) if (x.by === me.id && !x.aboard) this.dismiss(room, x.thing); // and their taxi drives off
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
    if (ride.sp === "taxi") room.taxis.delete(ride.thing); // the ride is over; it stands a minute like anything left, then is gone
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

  /** Gives a member their companion (or takes it away) and tells the room. Its identity is the member's own, so it is the same somebody on every visit. */
  private bringPet(room: Room, m: Member, sp: string | null): void {
    if (!room.members.has(m.id) || (m.pet?.sp ?? null) === sp) return;
    const seed = parseInt((m.personId ?? m.id).slice(0, 8), 16) | 0;
    let kind = 0;
    for (const ch of sp ?? "") kind = (kind * 31 + ch.charCodeAt(0)) | 0;
    m.pet = sp ? { sp, thing: (hash32(seed, kind) >>> 0) || 1 } : null;
    this.broadcast(room, { t: "pet", id: m.id, ...(m.pet ?? {}) });
  }

  /** What everyone is told of a taxi: where it comes from and when it set off, so each game can draw it arriving. */
  private publicTaxi(x: Taxi): unknown {
    return { t: "taxi", thing: x.thing, by: x.by, name: x.name, path: x.path, at: x.at, until: x.until, dest: x.dest.name };
  }

  /** A taxi nobody boarded goes away. */
  private dismiss(room: Room, thing: number): void {
    if (room.taxis.delete(thing)) this.broadcast(room, { t: "taxi", thing, gone: true });
  }

  /** Every few seconds: taxis that waited too long leave, and those with a fare aboard say something now and then. */
  private taxiRound(): void {
    const now = Date.now();
    for (const [roomName, room] of this.rooms) {
      for (const x of [...room.taxis.values()]) {
        if (!x.aboard) { if (x.until <= now) this.dismiss(room, x.thing); continue; }
        const fare = room.members.get(x.aboard);
        if (!fare || fare.ride?.thing !== x.thing) { room.taxis.delete(x.thing); continue; }
        if (now < x.nextRemark || x.remarks >= TAXI_REMARKS || !this.talker.muse) continue;
        const n = x.remarks++;
        x.nextRemark = now + (this.options.taxiRemarkMs ? this.options.taxiRemarkMs[1] : TAXI_REMARK_MS + (hash32(x.thing, n) % 9000));
        void (async () => {
          const place = fare.hasPos && this.options.placeName ? await this.options.placeName(fare.lat, fare.lon).catch(() => null) : null;
          const said = await this.talker.muse!(roomName, x.thing, "taxi", place, x.dest.name, n);
          if (fare.ride?.thing !== x.thing) return; // they got out while it was thinking
          const out = JSON.stringify({ t: "say", thing: x.thing, sp: "taxi", name: said.name, text: said.text, by: fare.id, ...(fare.hasPos ? { lat: +fare.lat.toFixed(7), lon: +fare.lon.toFixed(7) } : {}) });
          for (const m of room.members.values()) {
            const near = m === fare || (m.hasPos && fare.hasPos && Math.hypot((m.lat - fare.lat) * 111_320, (m.lon - fare.lon) * 111_320 * Math.cos((fare.lat * Math.PI) / 180)) <= HEARING_M);
            if (near && m.ws.readyState === m.ws.OPEN) m.ws.send(out);
          }
          this.journal?.talked(fare.id, x.thing, "taxi", said.name, "", said.text);
        })().catch(() => {});
      }
    }
  }

  /** Lets a thing go back to what it was doing, and tells the room. */
  private release(room: Room, thing: number): void {
    const order = room.orders.get(thing);
    if (!order) return;
    room.orders.delete(thing);
    this.broadcast(room, { t: "order", thing, sp: order.sp, act: "home" });
  }

  /** A thing has agreed to do something: work out what that means and tell whoever needs to know. */
  private async obey(room: Room, m: Member, thing: number, sp: string, said: Said, here: { lat: number; lon: number }): Promise<void> {
    const wish = said.wish as Wish;
    const now = Date.now();
    const round = (v: number): number => +v.toFixed(7);
    if (wish.deed === "home") return this.release(room, thing);
    if (wish.deed === "trick" || wish.deed === "noise") {
      // Done once, there and then, wherever each game has the thing.
      return this.broadcast(room, { t: "order", thing, sp, act: wish.deed, at: now });
    }
    if (wish.deed === "goto") {
      // Only its rider is carried, and their own game does the carrying; friends see them go.
      const send = (obj: unknown): void => { if (m.ws.readyState === m.ws.OPEN) m.ws.send(JSON.stringify(obj)); };
      const way = this.options.wayTo && wish.place ? await this.options.wayTo(m.lat, m.lon, wish.place, sp).catch(() => null) : null;
      if (!way) return send({ t: "error", code: "nowhere", text: `${said.name} could not find "${wish.place ?? "that place"}"` });
      return send({ t: "order", thing, sp, act: "goto", name: way.name, lat: round(way.lat), lon: round(way.lon), ...(way.path ? { path: way.path } : {}) });
    }
    for (const [id, o] of room.orders) if (o.until <= now) room.orders.delete(id);
    const mine = [...room.orders.values()].filter((o) => o.by === m.id && o.thing !== thing);
    if (mine.length >= ORDERS_EACH) this.release(room, mine[0].thing);
    if (room.orders.size >= ORDER_CAP && !room.orders.has(thing)) this.release(room, room.orders.keys().next().value!);
    const order: Order = {
      thing, sp, act: wish.deed, by: m.id, lat: round(here.lat), lon: round(here.lon), at: now, until: now + ORDER_MS,
      ...(wish.deed === "come" && m.hasPos ? { to: [round(m.lat), round(m.lon)] as [number, number] } : {}),
    };
    room.orders.delete(thing);
    room.orders.set(thing, order);
    this.broadcast(room, { t: "order", ...order });
  }

  private broadcast(room: Room, obj: unknown): void {
    const text = JSON.stringify(obj);
    for (const m of room.members.values()) if (m.ws.readyState === m.ws.OPEN) m.ws.send(text);
  }

  private ticks = 0;

  /** Ten times a second, tell each room who moved. */
  private tick(): void {
    if (++this.ticks % 30 === 0) this.taxiRound();
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
