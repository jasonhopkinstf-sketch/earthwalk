// Meetup rooms: everyone in a room sees each other's position and shares a chat.
// Messages are small JSON objects over a WebSocket (docs/PROTOCOL.md).

import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { hash32 } from "./geo.ts";
import type { Home, PeopleDirectory } from "./people.ts";
import { aKind, persona, TALKABLE, Talker, type Said, type Wish } from "./talk.ts";
import { favourNotes, favourWords, offersHelp } from "./favours.ts";
import { COUNTDOWN_MS, type Course, newRace, passed, placeOf, type Race, stale } from "./race.ts";
import { beginPlay, joinPlay, leavePlay, newPlay, outcomes, type Play, stalePlay, stepHerd, stepPlay } from "./play.ts";
import type { TalkNews } from "./journal.ts";
import { breedOf, BREEDS, cleanDecor, gardenView, GARDEN_MAX, type Homes, isGrown, type Lived, pieceById, PRIZES_SHOWN, viewOfLived } from "./home.ts";
import type { HomeDoor } from "./chunk.ts";
import { judge, lesson, trickById } from "./tricks.ts";

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
  hat: string | null;
  /** When they last asked for a house, so that the map is not searched over and over. */
  houseAt: number;
  /** The lesson their companion is having: the trick, its beats (ms from the start) and when it began. And when it last did a trick. */
  lesson: { trick: string; beats: number[]; at: number } | null;
  trickAt: number;
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
/** A player's own car, standing where they called it or last got out of it (garage.ts). */
interface OwnCar { id: string; thing: number; body: string; paint: number; lat: number; lon: number; yaw: number }
interface Room { members: Map<string, Member>; history: ChatLine[]; left: Map<number, Left>; orders: Map<number, Order>; taxis: Map<number, Taxi>; cars: Map<string, OwnCar>; race: Race | null; raceMaking: boolean; play: Play | null }
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
  listen(tell: (key: string, news: { title: string; text: string; kind: string; thing?: number; sp?: string; say?: string; at?: { lat: number; lon: number } }) => void): void;
  joined(key: string, personId: string | null, room: string, tzMinutes?: number): Promise<void>;
  left(key: string): void;
  moved(key: string, lat: number, lon: number): void;
  rode(key: string, sp: string | null, thing?: number): void;
  talked(key: string, thing: number, sp: string, name: string, said: string, reply: string): void;
  view(key: string): unknown;
  /** Companions: choosing one of those won (false if it is not theirs), and the one chosen. */
  setPet?(key: string, sp: string | null): boolean;
  petOf?(key: string): string | null;
  /** Hats: buying one with coins, wearing one owned (false if it is not theirs), and the one worn. */
  buyHat?(key: string, id: string): "ok" | "poor" | "prize" | "unknown";
  wearHat?(key: string, id: string | null): boolean;
  hatOf?(key: string): string | null;
  /** Favours: what a talk has to do with them, a thing starting or stopping following a player, and giving one up. */
  beforeTalk?(key: string, thing: number, sp: string, name: string, asked: boolean): TalkNews;
  following?(key: string, thing: number, on: boolean): void;
  dropFavour?(key: string, id: string): boolean;
  /** Treasure hunts and expeditions, begun and given up from the passport. */
  startHunt?(key: string): Promise<"ok" | "nowhere" | "none" | "busy">;
  dropHunt?(key: string): boolean;
  startExpedition?(key: string, id: string): "ok" | "unknown" | "done" | "full" | "busy";
  dropExpedition?(key: string, id: string): boolean;
  /** The garage: choosing (and buying) a paint or a body for my car, and how it looks. */
  setCar?(key: string, choice: { paint?: string; body?: string }): "ok" | "poor" | "unknown";
  carOf?(key: string): { body: string; paint: number };
  /** A race finished: where they came among how many, and their time in milliseconds. */
  raced?(key: string, place: number, of: number, ms: number): void;
  /** A game of tag or of hide and seek over: how it came out for this player. */
  played?(key: string, kind: string, o: { won: boolean; coins: number; title: string; text: string }): void;
  /** A piece for a house of their own: theirs already, or bought now. */
  takePiece?(key: string, id: string): "ok" | "poor" | "prize" | "unknown";
  /** Food (food.ts): eating from the lunch box, whether all five hearts are full, what is sold where they are, and buying it. */
  eat?(key: string, id: string): "ok" | "none";
  pepOf?(key: string): boolean;
  menuOf?(key: string, use: "shop" | "food"): { country: string | null; items: { id: string; name: string; groups: string[]; price: number }[] };
  buyFood?(key: string, use: "shop" | "food", id: string): "ok" | "poor" | "full" | "unknown";
  /** For the garden: the player's day, paying out of their coins, something earned, and something from the lunch box for a young animal (taken out). */
  dayFor?(key: string): number;
  spend?(key: string, coins: number, what: string): boolean;
  earn?(key: string, gain: { coins?: number; food?: string }): boolean;
  fodder?(key: string, take?: boolean): { id: string; name: string } | null;
  /** Tricks (tricks.ts): whether my companion can be taught one now, that it has learnt it, and whether it knows one. */
  lessonFor?(key: string, id: string): "ok" | "nopet" | "known" | "order" | "unknown";
  learnTrick?(key: string, id: string): boolean;
  knowsTrick?(key: string, id: string): boolean;
  /** Cooking a recipe from the lunch box, and giving one thing from it to another player. */
  cook?(key: string, id: string): "ok" | "locked" | "missing" | "unknown";
  giveFood?(key: string, to: string, id: string, fromName: string, toName: string): "ok" | "none" | "full";
}
export interface RoomsOptions {
  /** Names a position ("Montmartre, Paris") for `/home` without a place given. */
  placeName?: (lat: number, lon: number) => Promise<string | null>;
  /** The people list sent in `people` messages; set by the presence tracker. */
  peopleList?: () => unknown[];
  /** Speaks for the things players talk to. Without one, things answer from their stock lines. */
  talker?: {
    greet(thing: number, sp: string): Said;
    reply(room: string, thing: number, sp: string, said: string, speaker: string, place: string | null, riding?: boolean, notes?: string[], plain?: boolean): Promise<Said>;
    muse?(room: string, thing: number, sp: string, place: string | null, dest: string | null, n: number): Promise<Said>;
  };
  /** Finds where a caller wants a taxi to take them, and a road for the taxi to arrive by. */
  cab?: (lat: number, lon: number, place: string) => Promise<Cab | null>;
  /** How long after its fare boards a taxi first speaks, and how long between remarks, in milliseconds (shortened in tests). */
  taxiRemarkMs?: [number, number];
  /** Finds a place a rider has asked to be taken to, near where they are, with the way there by road if it is close. */
  wayTo?: (lat: number, lon: number, place: string, sp: string) => Promise<Way | null>;
  /** Makes a race course along the roads near a position (race.ts). Without it there are no races. */
  course?: (lat: number, lon: number, seed: number) => Promise<Course | null>;
  /** How long after "go" a race begins (the tests do not wait five seconds). */
  raceCountdownMs?: number;
  /** The same for tag and for hide and seek; and the lot that picks who is it (0 to 1), which the tests fix. */
  playCountdownMs?: number;
  playLot?: () => number;
  /** Writes down where players go and what they do, each in their own journal. Without one, nothing is. */
  journal?: JournalKeeper;
  /** Who lives where (home.ts), and a way to find a house that opens: its measurements, its door on Earth, the way out. */
  homes?: Homes;
  findHome?: (x: number, y: number, id: number) => Promise<{ home: HomeDoor; lat: number; lon: number; yaw: number } | null>;
  /** The making of the world the houses are measured in (GENERATOR_REV). */
  worldRev?: number;
  /** For tests: a lesson may be answered at once, without the time its beats take. */
  quickLessons?: boolean;
  /** Told where each player is, every time they say (ahead.ts fetches the map ahead of whoever is travelling). */
  moved?: (id: string, lat: number, lon: number) => void;
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
      if (!m || m.ws.readyState !== m.ws.OPEN) return;
      const { thing, sp, say, ...stamp } = news;
      m.ws.send(JSON.stringify({ t: "stamp", ...stamp }));
      // A favour done on the move: the thing that asked says its thanks there and then.
      if (thing && sp && say) m.ws.send(JSON.stringify({ t: "say", thing, sp, name: persona(thing, sp).name, text: say, by: m.id, ...(m.hasPos ? { lat: +m.lat.toFixed(7), lon: +m.lon.toFixed(7) } : {}) }));
      // An expedition begun or ended may bring a lost animal to the player's side, or send it home.
      if (news.kind === "expedition") this.walkWith(m);
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
        if (!r) this.rooms.set(roomName, (r = { members: new Map(), history: [], left: new Map(), orders: new Map(), taxis: new Map(), cars: new Map(), race: null, raceMaking: false, play: null }));
        if (r.members.size >= MAX_ROOM_SIZE) { send({ t: "error", code: "full", text: "Room is full" }); ws.close(4002, "full"); return; }
        // Names must be unique in a room so "/join <name>" is unambiguous.
        let name = clean(person.displayName, MAX_NAME) || "Guest";
        const taken = new Set([...r.members.values()].map((m) => m.name.toLowerCase()));
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${clean(person.displayName, MAX_NAME - 3)} ${n}`;
        room = r;
        me = {
          id: randomUUID().slice(0, 8), personId: person.personId, name, avatar: avatarId(person.avatar ?? msg.avatar), ws,
          lat: 0, lon: 0, alt: 0, yaw: 0, hasPos: false, dirty: false, chatTimes: [], home: person.home ?? null, ride: null, talkTimes: [], taxiAt: 0, pet: null, hat: null, houseAt: 0, lesson: null, trickAt: 0,
        };
        clearTimeout(helloTimer);
        send({
          t: "welcome", id: me.id, name: me.name, avatar: me.avatar, room: roomName,
          peers: [...r.members.values()].map((m) => ({ id: m.id, name: m.name, avatar: m.avatar, ...(m.hasPos ? { lat: m.lat, lon: m.lon, alt: m.alt, yaw: m.yaw } : {}), ...(m.ride ? { ride: m.ride } : {}), ...(m.pet ? { pet: m.pet } : {}), ...(m.hat ? { hat: m.hat } : {}) })),
          left: [...r.left.values()].filter((l) => l.until > Date.now()),
          orders: [...r.orders.values()].filter((o) => o.until > Date.now()),
          cars: [...r.cars.values()],
          race: r.race,
          play: r.play,
          taxis: [...r.taxis.values()].filter((x) => !x.aboard && x.until > Date.now()).map((x) => this.publicTaxi(x)),
          history: r.history,
          signedIn: me.personId !== null,
          ...(me.personId !== null ? { personId: me.personId, home: me.home } : {}),
          lived: this.options.homes?.list() ?? [],
          house: this.houseOf(me),
          now: Date.now(),
        });
        this.broadcast(r, { t: "join", id: me.id, name: me.name, avatar: me.avatar });
        r.members.set(me.id, me);
        this.everyone.set(me.id, me);
        // Once their journal is open, the companion they chose last time comes along.
        const arrived = me;
        void this.journal?.joined(me.id, me.personId, roomName, finite(msg.tz) ? msg.tz : undefined).then(() => {
          this.bringPet(r, arrived, this.journal?.petOf?.(arrived.id) ?? null);
          this.wearHat(r, arrived, this.journal?.hatOf?.(arrived.id) ?? null);
          if (this.journal?.pepOf?.(arrived.id) && arrived.ws.readyState === arrived.ws.OPEN) arrived.ws.send(JSON.stringify({ t: "pep", on: true })); // all five hearts were filled earlier today
        }).catch(() => {});
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
        this.options.moved?.(me.id, me.lat, me.lon);
        // In a race, this may take them through their next gate, or over the line.
        const race = room?.race;
        if (race && room) {
          const got = passed(race, me.id, me.lat, me.lon, Date.now());
          if (got === "finish") this.journal?.raced?.(me.id, placeOf(race, me.id), race.runners.length, race.runners.find((r) => r.id === me!.id)?.time ?? 0);
          if (got) this.broadcast(room, { t: "race", race });
        }
        // In a game of tag or of hide and seek, this may be a touch, a find, or a step off the field.
        if (room?.play?.state === "go" && room.play.players.some((p) => p.id === me!.id)) this.runPlay(room);
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
        // Somebody's own car is theirs to drive. Others ride along when its owner is at the wheel.
        const owner = sp === "car" ? [...room.cars.values()].find((c) => c.thing === thing) : undefined;
        if (owner && owner.id !== me.id && seat === 0) { send({ t: "error", code: "taken", text: `That is ${room.members.get(owner.id)?.name ?? "somebody"}'s car. Hop in when they are driving.` }); return; }
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
        // Favours: this talk may bring one home, and the thing may ask one of its own (favours.ts).
        const asked = !!text && offersHelp(text);
        const favours = this.journal?.beforeTalk?.(me.id, thing, sp, persona(thing, sp).name, asked) ?? null;
        let said: Said;
        if (text) {
          const place = me.hasPos && this.options.placeName ? await this.options.placeName(me.lat, me.lon).catch(() => null) : null;
          said = await this.talker.reply(roomName, thing, sp, text, me.avatar, place, me.ride?.thing === thing && me.ride.sp === sp, favours ? favourNotes(favours, aKind) : [],
            // In the middle of a round-up "follow me" is answered at once, in plain words: there is a clock running.
            room.play?.kind === "herd" && room.play.state === "go" && /^\s*follow me\W*$/i.test(text));
        } else said = this.talker.greet(thing, sp);
        // Without an AI to put it in the thing's own words, the favour is asked, and thanked for, in plain ones.
        if (favours && !said.ai && !said.wish) said = { ...said, text: favourWords(said.text, favours, asked, aKind) };
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
        this.bringPet(room, me, this.journal.petOf?.(me.id) ?? sp); // a lost animal on its way home keeps its place
      } else if (msg.t === "expedition" && room) {
        // Set out on a treasure hunt ("hunt") or an expedition, or give one up. My journal comes back either way.
        const start = clean(msg.start, 20), drop = clean(msg.drop, 20);
        if (start === "hunt") {
          const got = (await this.journal?.startHunt?.(me.id)) ?? "none";
          if (!room.members.has(me.id)) return;
          if (got !== "ok") send({ t: "error", code: got === "nowhere" ? "nowhere" : "locked", text: got === "busy" ? "You are on a treasure hunt already" : got === "nowhere" ? "You have not arrived anywhere yet" : "The map knows too little here for a treasure hunt. Try a town or a village." });
        } else if (start) {
          const got = this.journal?.startExpedition?.(me.id, start) ?? "unknown";
          if (got !== "ok") send({ t: "error", code: "locked", text: got === "full" ? "Three expeditions at once is plenty. Finish one first." : got === "busy" ? "One lost animal at a time" : got === "done" ? "You have done that one" : "No such expedition" });
        } else if (drop === "hunt") this.journal?.dropHunt?.(me.id);
        else if (drop) this.journal?.dropExpedition?.(me.id, drop);
        this.walkWith(me);
        send({ t: "journal", journal: this.journal?.view(me.id) ?? null });
      } else if (msg.t === "garden" && room) {
        // The garden of my house (home.ts): a young animal comes to live there (`adopt`, a kind), one is fed from my
        // lunch box (`feed`, its place in the garden), a grown one gives what it gives (`gather`), or one goes (`release`).
        const homes = this.options.homes;
        const owner = me.personId ?? me.id;
        const mine = homes?.of(owner);
        if (!homes || !mine) { send({ t: "error", code: "nohome", text: "A garden comes with a house of your own: go into a house nobody lives in and press H" }); return; }
        const day = this.journal?.dayFor?.(me.id) ?? Math.floor(Date.now() / 86_400_000);
        const at = (v: unknown): number => (Number.isInteger(v) ? (v as number) : -1);
        const adopt = clean(msg.adopt, 12);
        const told = (title: string, text: string): void => send({ t: "stamp", kind: "care", title, text });
        if (adopt) {
          const breed = breedOf(adopt);
          if (!breed) { send({ t: "error", code: "locked", text: "There is no such animal to be had" }); return; }
          if ((mine.garden?.length ?? 0) >= GARDEN_MAX) { send({ t: "error", code: "many", text: `A garden holds ${GARDEN_MAX}: one would have to go first` }); return; }
          if (!(this.journal?.spend?.(me.id, breed.price, breed.young) ?? false)) { send({ t: "error", code: "poor", text: "Not enough coins yet" }); return; }
          homes.adopt(owner, breed.sp);
          told(`A ${breed.young} has come to live in your garden`, `Feed it once a day from your lunch box: after ${breed.meals} meals it is a grown ${breed.grown}, and gives ${breed.gives.what} every day`);
        } else if (at(msg.feed) >= 0) {
          const i = at(msg.feed);
          const can = homes.hungry(owner, i, day);
          const young = mine.garden?.[i];
          const breed = young ? breedOf(young.sp) : undefined;
          if (can !== "ok" || !young || !breed) { send({ t: "error", code: "locked", text: can === "today" ? "It has eaten today: it will be hungry again tomorrow" : can === "grown" ? "It is grown, and feeds itself now" : "There is no such animal in your garden" }); return; }
          const food = this.journal?.fodder?.(me.id) ?? null;
          if (!food) { send({ t: "error", code: "locked", text: "There is nothing it eats in your lunch box: it likes plain vegetables, bread and grains, and fruit" }); return; }
          homes.fed(owner, i, day);
          if (isGrown(young)) told(`Your ${breed.young} is a grown ${breed.grown}!`, `It ate ${food.name}. From tomorrow it gives ${breed.gives.what} every day`);
          else told(`Your ${breed.young} ate ${food.name}`, `${young.fed} of ${breed.meals} meals: it is growing. It will be hungry again tomorrow`);
        } else if (at(msg.gather) >= 0) {
          const i = at(msg.gather);
          const young = mine.garden?.[i];
          const breed = young && isGrown(young) ? breedOf(young.sp) : undefined;
          if (!breed) { send({ t: "error", code: "locked", text: "It is not grown yet" }); return; }
          if (young!.gaveDay === day) { send({ t: "error", code: "locked", text: "It has given today: come back tomorrow" }); return; }
          // (The lunch box is tried first, so that nothing is lost when it is full.)
          if (breed.gives.food && !(this.journal?.earn?.(me.id, { food: breed.gives.food }) ?? false)) { send({ t: "error", code: "locked", text: "Your lunch box is full: eat something first" }); return; }
          if (breed.gives.coins) this.journal?.earn?.(me.id, { coins: breed.gives.coins });
          homes.gather(owner, i, day);
          told(`Your ${breed.grown} gave you ${breed.gives.what}`, breed.gives.coins ? `Worth ${breed.gives.coins} coins` : "It is in your lunch box (B)");
        } else if (at(msg.release) >= 0) {
          if (!homes.release(owner, at(msg.release))) return;
        } else return;
        this.broadcastAll({ t: "lived", ...viewOfLived(mine) });
        send({ t: "house", house: this.houseOf(me) });
        send({ t: "journal", journal: this.journal?.view(me.id) ?? null });
      } else if (msg.t === "trick" && room) {
        // My companion's tricks (tricks.ts): begin a lesson (`learn`), hand in my presses for it (`presses`,
        // milliseconds from its start), or have it do a trick it knows (`do`), which the room is shown.
        const learn = clean(msg.learn, 12), act = clean(msg.do, 12);
        if (learn) {
          const trick = trickById(learn);
          const can = this.journal?.lessonFor?.(me.id, learn) ?? "unknown";
          if (!trick || can !== "ok" || !me.pet) {
            send({ t: "error", code: "locked", text: can === "nopet" || !me.pet ? "You have no companion with you: solve a riddle to win one, and choose it in your passport" : can === "known" ? "It knows that one already" : can === "order" ? "It has an easier trick to learn first" : "There is no such trick" });
            return;
          }
          me.lesson = { trick: trick.id, beats: lesson(trick, (Math.random() * 0x7fffffff) | 0), at: Date.now() };
          send({ t: "lesson", trick: trick.id, name: trick.name, beats: me.lesson.beats, slack: trick.slackMs });
        } else if (Array.isArray(msg.presses)) {
          const had = me.lesson;
          const trick = had ? trickById(had.trick) : undefined;
          me.lesson = null;
          if (!had || !trick) return;
          // A lesson cannot be handed in before its last beat has had time to come.
          const early = !this.options.quickLessons && Date.now() - had.at < had.beats[had.beats.length - 1] - 500;
          const marks = judge(trick, had.beats, early ? [] : (msg.presses as unknown[]).filter(finite));
          const passed = marks.passed && (this.journal?.learnTrick?.(me.id, trick.id) ?? false);
          send({ t: "lesson", trick: trick.id, name: trick.name, done: true, passed, hits: marks.hits, of: marks.of });
          if (passed) {
            send({ t: "journal", journal: this.journal?.view(me.id) ?? null });
            if (me.pet) this.broadcast(room, { t: "trick", id: me.id, thing: me.pet.thing, sp: me.pet.sp, trick: trick.id }); // and it shows off what it has learnt
          }
        } else if (act) {
          if (!me.pet || !this.journal?.knowsTrick?.(me.id, act)) { send({ t: "error", code: "locked", text: "Your companion does not know that trick yet" }); return; }
          if (Date.now() - me.trickAt < 1200) return;
          me.trickAt = Date.now();
          this.broadcast(room, { t: "trick", id: me.id, thing: me.pet.thing, sp: me.pet.sp, trick: act });
        }
      } else if (msg.t === "food" && room) {
        // Food (food.ts): eat something from my lunch box (`eat`), ask what a shop or a café sells where I am
        // (`menu`: "shop" or "food"), or buy something there (`buy`, with `at` saying which of the two it is).
        const eat = clean(msg.eat, 16), buy = clean(msg.buy, 16), cook = clean(msg.cook, 16), give = clean(msg.give, 16);
        const use = msg.menu === "food" || msg.at === "food" ? "food" : "shop";
        if (eat) {
          if (this.journal?.eat?.(me.id, eat) !== "ok") { send({ t: "error", code: "locked", text: "There is none of that in your lunch box" }); return; }
          send({ t: "pep", on: this.journal?.pepOf?.(me.id) ?? false });
          send({ t: "journal", journal: this.journal?.view(me.id) ?? null });
        } else if (buy) {
          const got = this.journal?.buyFood?.(me.id, use, buy) ?? "unknown";
          if (got !== "ok") { send({ t: "error", code: got === "poor" ? "poor" : "locked", text: got === "poor" ? "Not enough coins yet" : got === "full" ? "Your lunch box is full: eat something first" : "That is not sold here" }); return; }
          send({ t: "journal", journal: this.journal?.view(me.id) ?? null });
        } else if (cook) {
          // Cooking is done at home: in, or just outside, a house of my own.
          const mine = this.options.homes?.of(me.personId ?? me.id);
          const metres = mine && me.hasPos ? Math.hypot((mine.lat - me.lat) * 111_320, (mine.lon - me.lon) * 111_320 * Math.cos((me.lat * Math.PI) / 180)) : Infinity;
          if (metres > 40) { send({ t: "error", code: "far", text: mine ? "Cooking is done in your own kitchen: H takes you home" : "Cooking needs a kitchen of your own: go into a house nobody lives in and press H" }); return; }
          const got = this.journal?.cook?.(me.id, cook) ?? "unknown";
          if (got !== "ok") { send({ t: "error", code: "locked", text: got === "missing" ? "Something that recipe needs is not in your lunch box" : got === "locked" ? "You have not learnt that recipe yet" : "There is no such recipe" }); return; }
          send({ t: "journal", journal: this.journal?.view(me.id) ?? null });
        } else if (give) {
          // One thing from my lunch box to a friend who is standing by.
          const friend = room.members.get(clean(msg.to, 64));
          if (!friend || friend === me || !me.hasPos || !friend.hasPos
            || Math.hypot((friend.lat - me.lat) * 111_320, (friend.lon - me.lon) * 111_320 * Math.cos((me.lat * Math.PI) / 180)) > 20) { send({ t: "error", code: "far", text: "Stand beside the friend you want to give it to" }); return; }
          const got = this.journal?.giveFood?.(me.id, friend.id, give, me.name, friend.name) ?? "none";
          if (got !== "ok") { send({ t: "error", code: "locked", text: got === "full" ? `${friend.name}'s lunch box is full` : "There is none of that in your lunch box" }); return; }
          send({ t: "journal", journal: this.journal?.view(me.id) ?? null });
          if (friend.ws.readyState === friend.ws.OPEN) friend.ws.send(JSON.stringify({ t: "journal", journal: this.journal?.view(friend.id) ?? null }));
        } else if (msg.menu === "shop" || msg.menu === "food") {
          const menu = this.journal?.menuOf?.(me.id, use);
          send({ t: "menu", use, country: menu?.country ?? null, items: (menu?.items ?? []).map((x) => ({ id: x.id, name: x.name, groups: x.groups, price: x.price })) });
        }
      } else if (msg.t === "house" && room) {
        // A house of my own (home.ts): make the one I am at mine (`claim`), give mine up (`leave`), or swap a
        // piece in it (`put`: a slot and a piece, or no piece for what the house came with; a prize goes `on` or off).
        const homes = this.options.homes;
        if (!homes) { send({ t: "error", code: "locked", text: "Houses cannot be kept here" }); return; }
        const owner = me.personId ?? me.id;
        const c = msg.claim as { x?: unknown; y?: unknown; id?: unknown } | undefined;
        if (c && typeof c === "object") {
          const x = Number(c.x), y = Number(c.y), id = Number(c.id);
          if (![x, y, id].every(Number.isSafeInteger) || x < 0 || y < 0) return;
          if (!me.hasPos) { send({ t: "error", code: "nowhere", text: "You have not arrived anywhere yet" }); return; }
          const there = homes.at(x, y, id);
          if (there) { send({ t: "error", code: "taken", text: there.owner === owner ? "This is your house already" : `${there.name} lives here` }); return; }
          if (Date.now() - me.houseAt < 2000) { send({ t: "error", code: "busy", text: "One moment" }); return; }
          me.houseAt = Date.now();
          let found: Awaited<ReturnType<NonNullable<RoomsOptions["findHome"]>>> = null;
          try { found = (await this.options.findHome?.(x, y, id)) ?? null; } catch { /* the map would not say */ }
          if (!room.members.has(me.id)) return; // left meanwhile
          if (!found) { send({ t: "error", code: "nohome", text: "That house cannot be moved into" }); return; }
          const metres = Math.hypot((found.lat - me.lat) * 111_320, (found.lon - me.lon) * 111_320 * Math.cos((me.lat * Math.PI) / 180));
          if (metres > 80) { send({ t: "error", code: "far", text: "Go into the house first" }); return; }
          const { got, left } = homes.claim(owner, me.name, me.personId !== null, { x, y, id, ...found, gen: this.options.worldRev ?? 0 });
          if (got !== "ok") { send({ t: "error", code: got === "full" ? "many" : "taken", text: got === "full" ? "There are no more houses to be had just now" : "Somebody lives here" }); return; }
          if (left) this.broadcastAll({ t: "lived", x: left.x, y: left.y, id: left.id, gone: true });
          this.broadcastAll({ t: "lived", ...viewOfLived(homes.of(owner)!) });
          send({ t: "house", house: this.houseOf(me) });
        } else if (msg.leave === true) {
          const left = homes.leave(owner);
          if (left) this.broadcastAll({ t: "lived", x: left.x, y: left.y, id: left.id, gone: true });
          send({ t: "house", house: null });
        } else if (msg.put && typeof msg.put === "object") {
          const mine = homes.of(owner);
          if (!mine) { send({ t: "error", code: "nohome", text: "You have no house yet" }); return; }
          const put = msg.put as { slot?: unknown; id?: unknown; on?: unknown };
          const slot = clean(put.slot, 12), id = clean(put.id, 16);
          const piece = id ? pieceById(id) : undefined;
          if ((id && piece?.slot !== slot) || !["walls", "floor", "sofa", "bed", "rug", "prize"].includes(slot)) { send({ t: "error", code: "locked", text: "There is no such piece" }); return; }
          if (piece) {
            const got = this.journal?.takePiece?.(me.id, piece.id) ?? "unknown";
            if (got !== "ok") { send({ t: "error", code: got === "poor" ? "poor" : "locked", text: got === "poor" ? "Not enough coins yet" : got === "prize" ? "That is a prize: it has to be won" : "There is no such piece" }); return; }
          }
          const decor = cleanDecor(mine.decor);
          if (slot === "prize") {
            if (!piece) return;
            decor.prizes = decor.prizes.filter((p) => p !== piece.id);
            if (put.on !== false) {
              if (decor.prizes.length >= PRIZES_SHOWN) { send({ t: "error", code: "many", text: `A house shows ${PRIZES_SHOWN} prizes at once: put one away first` }); return; }
              decor.prizes.push(piece.id);
            }
          } else if (piece) decor[slot as "walls" | "floor" | "sofa" | "bed" | "rug"] = piece.id;
          else delete decor[slot as "walls" | "floor" | "sofa" | "bed" | "rug"];
          homes.change(owner, { decor });
          this.broadcastAll({ t: "lived", ...viewOfLived(mine) });
          send({ t: "house", house: this.houseOf(me) });
          send({ t: "journal", journal: this.journal?.view(me.id) ?? null });
        }
      } else if (msg.t === "hat" && room) {
        // Buy a hat with my coins (`buy`), put on one I own (`wear`), or take it off (neither).
        const buy = clean(msg.buy, 16), wear = clean(msg.wear, 16) || null;
        if (buy) {
          const got = this.journal?.buyHat?.(me.id, buy) ?? "unknown";
          if (got !== "ok") { send({ t: "error", code: got === "poor" ? "poor" : "locked", text: got === "poor" ? "Not enough coins yet" : got === "prize" ? "That hat is a prize: it cannot be bought" : "No such hat" }); return; }
          this.wearHat(room, me, buy);
        } else {
          if (!this.journal?.wearHat?.(me.id, wear)) { send({ t: "error", code: "locked", text: "That hat is not yours yet" }); return; }
          this.wearHat(room, me, wear);
        }
      } else if (msg.t === "play" && room) {
        // Tag, and hide and seek: set one up where I stand (`make` says which), join it, start it (its maker), or leave.
        const now = Date.now();
        if (room.play && stalePlay(room.play, now)) this.endPlay(room);
        const play = room.play;
        if (msg.make === "tag" || msg.make === "hide" || msg.make === "herd") {
          if ((play && play.state !== "over") || (room.race && room.race.state !== "over")) { send({ t: "error", code: "locked", text: "There is a game set up here already" }); return; }
          if (!me.hasPos) { send({ t: "error", code: "nowhere", text: "You have not arrived anywhere yet" }); return; }
          if (play) this.endPlay(room); // the last game's results make way
          room.play = newPlay(msg.make, me.id, me.name, me.lat, me.lon, now);
        } else if (!play) {
          send({ t: "error", code: "locked", text: "There is no game just now" });
          return;
        } else if (msg.join === true) {
          if (play.state !== "open") { send({ t: "error", code: "locked", text: "That game has already started" }); return; }
          joinPlay(play, me.id, me.name);
        } else if (msg.go === true) {
          if (play.by !== me.id) { send({ t: "error", code: "locked", text: `Only ${play.byName} can start this game` }); return; }
          if (play.state === "open" && !beginPlay(play, now, this.options.playCountdownMs, this.options.playLot)) { send({ t: "error", code: "locked", text: "It takes at least two to play. Wait for someone to join." }); return; }
          if (play.kind === "herd") this.runPlay(room); // (anyone already standing in the pen with a follower)
        } else if (msg.stop === true) {
          this.leavePlay(room, me.id);
          return;
        } else return;
        this.broadcast(room, { t: "play", play: room.play });
      } else if (msg.t === "race" && room) {
        // Set a race up where I stand (`make`), join the one that is set up (`join`), say go (`go`, its maker only),
        // or leave it (`stop`: its maker ends it for everyone). The room is told the whole race each time.
        const now = Date.now();
        if (room.race && stale(room.race, now)) room.race = null;
        const race = room.race;
        if (msg.make === true) {
          if (race && race.state !== "over") { send({ t: "error", code: "locked", text: `${race.byName} has a race set up already` }); return; }
          if (room.play && room.play.state !== "over") { send({ t: "error", code: "locked", text: "There is a game set up here already" }); return; }
          if (!me.hasPos) { send({ t: "error", code: "nowhere", text: "You have not arrived anywhere yet" }); return; }
          if (!this.options.course || room.raceMaking) { send({ t: "error", code: "locked", text: "No race can be set up just now" }); return; }
          room.raceMaking = true;
          const course = await this.options.course(me.lat, me.lon, hash32(parseInt(me.id, 16) | 0, now & 0x7fffffff)).catch(() => null).finally(() => { room!.raceMaking = false; });
          if (!room.members.has(me.id)) return;
          if (!course || course.gates.length < 2) { send({ t: "error", code: "nowhere", text: "There are no roads here to race along. Try beside a street." }); return; }
          room.race = newRace(me.id, me.name, course, Date.now());
        } else if (!race) {
          send({ t: "error", code: "locked", text: "There is no race just now" });
          return;
        } else if (msg.join === true) {
          if (race.state !== "open") { send({ t: "error", code: "locked", text: "That race has already started" }); return; }
          if (!race.runners.some((r) => r.id === me!.id)) race.runners.push({ id: me.id, name: me.name, gate: 0, time: null });
        } else if (msg.go === true) {
          if (race.by !== me.id) { send({ t: "error", code: "locked", text: `Only ${race.byName} can start this race` }); return; }
          if (race.state === "open") { race.state = "go"; race.startAt = now + (this.options.raceCountdownMs ?? COUNTDOWN_MS); }
        } else if (msg.stop === true) {
          this.leaveRace(room, me.id);
          return;
        } else return;
        this.broadcast(room, { t: "race", race: room.race });
      } else if (msg.t === "garage" && room) {
        // My own car: bring it to where I stand (`call`), send it away (`away`), or choose its paint or body.
        const mine = room.cars.get(me.id);
        const driving = !!mine && me.ride?.thing === mine.thing;
        if (msg.call === true) {
          if (!me.hasPos) { send({ t: "error", code: "nowhere", text: "You have not arrived anywhere yet" }); return; }
          if (driving) { send({ t: "error", code: "locked", text: "You are sitting in it" }); return; }
          if (mine) for (const m of room.members.values()) if (m.ride?.thing === mine.thing) this.dismount(room, m);
          // It draws up three metres to the right of where I am facing: near enough to get straight in.
          const side = ((me.yaw + 90) * Math.PI) / 180;
          const seed = parseInt((me.personId ?? me.id).slice(0, 8), 16) | 0;
          const car: OwnCar = {
            id: me.id, thing: (hash32(seed, 0x43415253) >>> 0) || 1, ...(this.journal?.carOf?.(me.id) ?? { body: "car", paint: 0xd94a3a }),
            lat: +(me.lat + (Math.cos(side) * 3) / 111_320).toFixed(7), lon: +(me.lon + (Math.sin(side) * 3) / (111_320 * Math.cos((me.lat * Math.PI) / 180))).toFixed(7), yaw: +me.yaw.toFixed(1),
          };
          room.cars.set(me.id, car);
          room.left.delete(car.thing);
          this.broadcast(room, { t: "car", ...car });
        } else if (msg.away === true) {
          if (mine && !driving) { room.cars.delete(me.id); this.broadcast(room, { t: "car", id: me.id }); }
        } else {
          const paint = clean(msg.paint, 16), body = clean(msg.body, 16);
          const got = this.journal?.setCar?.(me.id, paint ? { paint } : { body }) ?? "unknown";
          if (got !== "ok") { send({ t: "error", code: got === "poor" ? "poor" : "locked", text: got === "poor" ? "Not enough coins yet" : "The garage has nothing of that kind" }); return; }
          if (mine) { Object.assign(mine, this.journal?.carOf?.(me.id)); this.broadcast(room, { t: "car", ...mine }); }
          send({ t: "journal", journal: this.journal?.view(me.id) ?? null });
        }
      } else if (msg.t === "favour") {
        // Give up a favour I was asked (`drop` is its id). My journal comes back without it.
        if (this.journal?.dropFavour?.(me.id, clean(msg.drop, 40))) send({ t: "journal", journal: this.journal.view(me.id) });
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
      if (room.cars.delete(me.id)) this.broadcast(room, { t: "car", id: me.id }); // and their car goes with them
      this.leaveRace(room, me.id);
      this.leavePlay(room, me.id);
      for (const x of [...room.taxis.values()]) if (x.by === me.id && !x.aboard) this.dismiss(room, x.thing); // and their taxi drives off
      // A guest's house is theirs for the visit only.
      const lent = me.personId === null ? this.options.homes?.leave(me.id) : null;
      if (lent) this.broadcastAll({ t: "lived", x: lent.x, y: lent.y, id: lent.id, gone: true });
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
    const own = ride.sp === "car" ? [...room.cars.values()].find((c) => c.thing === ride.thing) : undefined;
    for (const other of room.members.values()) {
      if (other.ride?.thing !== ride.thing || other.ride.sp !== ride.sp) continue;
      other.ride = null;
      this.journal?.rode(other.id, null);
      this.broadcast(room, { t: "ride", id: other.id });
    }
    if (!m.hasPos) return;
    if (own) {
      // Somebody's own car stays where they got out of it, for as long as they are here.
      Object.assign(own, { lat: +m.lat.toFixed(7), lon: +m.lon.toFixed(7), yaw: +m.yaw.toFixed(1) });
      return this.broadcast(room, { t: "car", ...own });
    }
    const now = Date.now();
    for (const [thing, l] of room.left) if (l.until <= now) room.left.delete(thing);
    if (room.left.size >= LEFT_CAP) room.left.delete(room.left.keys().next().value!);
    const left: Left = { thing: ride.thing, sp: ride.sp, lat: +m.lat.toFixed(7), lon: +m.lon.toFixed(7), alt: +m.alt.toFixed(2), yaw: +m.yaw.toFixed(1), until: now + LEFT_MS };
    room.left.set(ride.thing, left);
    this.broadcast(room, { t: "left", ...left });
  }

  /** Sees that the animal at a member's side is the one their journal says: a lost one being taken home, or their companion. */
  private walkWith(m: Member): void {
    for (const room of this.rooms.values()) if (room.members.get(m.id) === m) return this.bringPet(room, m, this.journal?.petOf?.(m.id) ?? null);
  }

  /** Puts a hat on a member (or takes it off) and tells the room. */
  private wearHat(room: Room, m: Member, hat: string | null): void {
    if (!room.members.has(m.id) || m.hat === hat) return;
    m.hat = hat;
    this.broadcast(room, { t: "hat", id: m.id, ...(hat ? { hat } : {}) });
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
  /** Someone leaves the race (or the room). Its maker leaving ends it; so does the last runner; otherwise the rest run on. */
  private leaveRace(room: Room, id: string): void {
    const race = room.race;
    if (!race || !race.runners.some((r) => r.id === id)) return;
    race.runners = race.runners.filter((r) => r.id !== id);
    if (race.by === id || race.runners.length === 0) room.race = null;
    else if (race.state === "go" && race.runners.every((r) => r.time !== null)) { race.state = "over"; race.ended = Date.now(); }
    this.broadcast(room, { t: "race", race: room.race });
  }

  /** Applies the rules of the room's game to where everyone is now; tells the room of any change, and pays up when it is over. */
  private runPlay(room: Room): void {
    const play = room.play;
    if (!play) return;
    const now = Date.now();
    const where = (id: string): { lat: number; lon: number; alt: number } | null => { const m = room.members.get(id); return m?.hasPos ? { lat: m.lat, lon: m.lon, alt: m.alt } : null; };
    let changed: boolean;
    if (play.kind === "herd") {
      const herd = stepHerd(play, where, (id) => [...room.orders.values()].filter((o) => o.by === id && o.act === "follow" && o.until > now).map((o) => ({ thing: o.thing, sp: o.sp })), now);
      changed = herd.changed;
      // Each animal brought in stops following and stands in the pen, a little apart from the others.
      herd.penned.forEach((f) => {
        const n = play.penned.indexOf(f.thing), a = n * 2.4, r = 2 + (n % 3) * 1.8;
        this.journal?.following?.(f.by, f.thing, false);
        const order: Order = {
          thing: f.thing, sp: f.sp, act: "stay", by: f.by, at: now, until: now + ORDER_MS,
          lat: +(play.lat + (Math.cos(a) * r) / 111_320).toFixed(7), lon: +(play.lon + (Math.sin(a) * r) / (111_320 * Math.cos((play.lat * Math.PI) / 180))).toFixed(7),
        };
        room.orders.delete(f.thing);
        room.orders.set(f.thing, order);
        this.broadcast(room, { t: "order", ...order });
      });
    } else changed = stepPlay(play, where, now);
    if (!changed) return;
    if (play.state === "over") for (const o of outcomes(play)) this.journal?.played?.(o.id, play.kind, o);
    this.broadcast(room, { t: "play", play });
  }

  /** Someone leaves the game (or the room): it ends with its maker, or when too few are left. */
  private leavePlay(room: Room, id: string): void {
    const play = room.play;
    if (!play) return;
    const what = leavePlay(play, id, Date.now());
    if (what === "on") return;
    if (what === "ended") this.endPlay(room);
    this.broadcast(room, { t: "play", play: room.play });
  }

  /** Clears the room's game away. The animals of a round-up go back to what they were doing. */
  private endPlay(room: Room): void {
    for (const thing of room.play?.penned ?? []) this.release(room, thing);
    room.play = null;
  }

  private taxiRound(): void {
    // (Every few seconds is also often enough to clear away a race that has run its time.)
    for (const room of this.rooms.values()) {
      // A game of tag ends on the clock, and a hider may be standing still out of the field: looked at here too.
      if (room.play?.state === "go") this.runPlay(room);
      if (room.play && stalePlay(room.play, Date.now())) { this.endPlay(room); this.broadcast(room, { t: "play", play: null }); }
      if (room.race && stale(room.race, Date.now())) { room.race = null; this.broadcast(room, { t: "race", race: null }); }
    }
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
    if (order.act === "follow") this.journal?.following?.(order.by, thing, false);
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
    for (const [id, o] of room.orders) {
      if (o.until > now) continue;
      if (o.act === "follow") this.journal?.following?.(o.by, id, false);
      room.orders.delete(id);
    }
    const mine = [...room.orders.values()].filter((o) => o.by === m.id && o.thing !== thing);
    if (mine.length >= ORDERS_EACH) this.release(room, mine[0].thing);
    if (room.orders.size >= ORDER_CAP && !room.orders.has(thing)) this.release(room, room.orders.keys().next().value!);
    const order: Order = {
      thing, sp, act: wish.deed, by: m.id, lat: round(here.lat), lon: round(here.lon), at: now, until: now + ORDER_MS,
      ...(wish.deed === "come" && m.hasPos ? { to: [round(m.lat), round(m.lon)] as [number, number] } : {}),
    };
    const before = room.orders.get(thing);
    if (before?.act === "follow") this.journal?.following?.(before.by, thing, false);
    room.orders.delete(thing);
    room.orders.set(thing, order);
    if (order.act === "follow") this.journal?.following?.(m.id, thing, true);
    this.broadcast(room, { t: "order", ...order });
  }

  /** My own house, as I am told of it: where it is and how I have furnished it. */
  private houseOf(m: Member): (ReturnType<typeof viewOfLived> & { decor: Lived["decor"]; animals: ReturnType<typeof gardenView>; breeds: typeof BREEDS; gardenMax: number }) | null {
    const mine = this.options.homes?.of(m.personId ?? m.id);
    const day = this.journal?.dayFor?.(m.id) ?? Math.floor(Date.now() / 86_400_000);
    return mine ? { ...viewOfLived(mine), decor: mine.decor, animals: gardenView(mine.garden ?? [], day), breeds: BREEDS, gardenMax: GARDEN_MAX } : null;
  }

  /** Tells everybody, in every room: houses are in the world, not in a room. */
  private broadcastAll(obj: unknown): void {
    const text = JSON.stringify(obj);
    for (const m of this.everyone.values()) if (m.ws.readyState === m.ws.OPEN) m.ws.send(text);
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
