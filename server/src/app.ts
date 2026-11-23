import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { cacheRead, cacheRemove, cacheWrite, InFlight } from "./cache.ts";
import { Gate } from "./net.ts";
import { FORMAT_VERSION, GENERATOR_REV, generateChunk } from "./chunk.ts";
import { Elevation } from "./elevation.ts";
import { CHUNK_Z } from "./geo.ts";
import { generateLabels, LABELS_REV, partialLabels } from "./labels.ts";
import { geocode, geocodeAround, geocodeNear, placeDetail as reverseDetail, placeName as reversePlace, type Place, type PlaceDetail } from "./geocode.ts";
import { laned, planRoute, type Route } from "./route.ts";
import { drivesLeft } from "./traffic.ts";
import { planCourse } from "./race.ts";
import { authUrl, googleSignIn, type GoogleOptions } from "./google.ts";
import { AccountDirectory, type GoogleIdentity, type PeopleDirectory } from "./people.ts";
import { Talker } from "./talk.ts";
import { Journals, type JournalStore } from "./journal.ts";
import { type HuntStop, planHunt } from "./hunt.ts";
import { findHome, furnishedInterior, INTERIOR_REV } from "./interior.ts";
import { generateInside, VENUES_REV } from "./venues.ts";
import { Homes } from "./home.ts";
import { describePlan, normalisePlan } from "./plan.ts";
import { claudePlanReader, PLAN_MAX_BYTES, PLAN_MEDIA, type ReadPlan } from "./planreader.ts";
import { Presence } from "./presence.ts";
import { cookieValue, Rooms, TOKEN_COOKIE } from "./rooms.ts";
import { LookAhead } from "./ahead.ts";
import { SHOWS } from "./showcase.ts";
import { newsSince } from "./news.ts";
import { claudeGuide, Guide, sightsOf, type ChunkSights, type GuideAsk } from "./guide.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
/** Browser libraries served straight from node_modules. */
const VENDOR: Record<string, string> = {
  three: path.join(ROOT, "node_modules", "three"),
  "three-mesh-bvh": path.join(ROOT, "node_modules", "three-mesh-bvh"),
};
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
};

export interface AppOptions {
  /** If set, players need this code for the world data as well as for the meetup rooms. */
  accessCode?: string;
  /** Use the X-Forwarded-For header for the caller's address (set when behind a hosting provider's proxy). */
  trustProxy?: boolean;
  /** How many not-yet-cached chunks one address may have built per window. */
  coldBuildLimit?: number;
  coldBuildWindowMs?: number;
  people?: PeopleDirectory;
  /** The accounts (people who signed in with Google). Created in memory when not given. */
  accounts?: AccountDirectory;
  /** Emails allowed to sign up without the access code. */
  invited?: string[];
  /** Google OAuth client; sign-in is offered only when set. */
  google?: GoogleOptions;
  /** Public address of this server (for Google's redirect), e.g. https://earthwalk.onrender.com. Taken from the request when absent. */
  baseUrl?: string;
  /** Swaps Google's one-time code for a verified identity. Replaceable for tests (Google is never called). */
  signIn?: (code: string, nonce: string, redirectUri: string) => Promise<GoogleIdentity>;
  /** Names a position for the people list and `/home`. */
  placeName?: (lat: number, lon: number) => Promise<string | null>;
  /** Speaks for the things players talk to. Defaults to one that uses Claude when ANTHROPIC_API_KEY is set, and stock lines otherwise. */
  talker?: Talker;
  /** Names a position, with its country, for the header that tells a player where they are. Defaults to `placeName` when that is given. */
  placeDetail?: (lat: number, lon: number) => Promise<PlaceDetail>;
  /** Where each player's journal is kept. Without one, journals last only as long as the visit. */
  journalStore?: JournalStore | null;
  /** A test aid: coins every new journal starts with. */
  startCoins?: number;
  /** Reads a floor plan off a picture (planreader.ts). Defaults to Claude when ANTHROPIC_API_KEY is set, and to nothing when it is not; null turns it off. */
  readPlan?: ReadPlan | null;
  /** How many pictures a person may have read in a day. */
  plansPerDay?: number;
  /** Makes treasure hunts (hunt.ts); replaceable for tests. */
  planHunt?: (lat: number, lon: number, day: number) => Promise<HuntStop[] | null>;
  /**
   * Sees that the map for one data tile is downloaded, without waiting (osm.ts, warmOsmTile). When given,
   * the server fetches the map ahead of anyone who is travelling (ahead.ts). Not given in tests, which
   * must never reach for the real map.
   */
  warm?: (dx: number, dy: number) => void;
  /** Replaceable for tests. */
  buildChunk?: (x: number, y: number) => Promise<Buffer>;
  buildLabels?: (x: number, y: number) => Promise<Buffer>;
  /** The inside of a home, or null when the chunk has no such home to walk into. */
  buildInterior?: (x: number, y: number, id: number) => Promise<Buffer | null>;
  /** The same with who is inside (a shop, an office, a mall); when given, it is used and not `buildInterior`. */
  buildInside?: (x: number, y: number, id: number) => Promise<{ mesh: Buffer; who: Buffer | null } | null>;
  /** Who lives where (home.ts); without one, houses are kept only while the server runs. And a way to measure a house, for tests. */
  homes?: Homes;
  findHome?: (x: number, y: number, id: number) => ReturnType<typeof findHome>;
  readCache?: (rel: string) => Promise<Buffer | null>;
  writeCache?: (rel: string, data: Buffer) => Promise<void>;
  findPlace?: (query: string) => Promise<Place | null>;
  /** How many chunks and label sets may be being built at one time (default 2; EARTHWALK_BUILDS_AT_ONCE overrides). */
  buildsAtOnce?: number;
  /** Finds a place by name for "Go to...", asked from a position: the one close by, unless the whole world knows another. */
  findAround?: (query: string, lat: number, lon: number) => Promise<Place | null>;
  /** Finds a place by name near a position, and the way by road between two positions: for a rider who asks to be taken somewhere. */
  findNear?: (query: string, lat: number, lon: number) => Promise<Place | null>;
  planRoute?: (fromLat: number, fromLon: number, toLat: number, toLon: number, far?: boolean) => Promise<Route | null>;
  /** The model behind the guide's fuller answers (guide.ts). Defaults to Claude when ANTHROPIC_API_KEY is set, and to nothing (built-in answers only) when it is not; null turns it off. */
  guideAsk?: GuideAsk | null;
  /** How soon a taxi first speaks to its fare and how long between remarks, in milliseconds. For tests. */
  taxiRemarkMs?: [number, number];
}

/** The server version, from package.json, shown by clients so a deploy can be told apart. */
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;

export interface App {
  server: Server; rooms: Rooms; accounts: AccountDirectory; presence: Presence; journals: Journals; close(): void;
  /** Builds one chunk (mesh and labels) into the cache if it is not there: for keeping the showcase ready. */
  prepare(x: number, y: number): Promise<void>;
  /** Drops what was built for one chunk (mesh, labels, the insides of its houses) from the cache, so the next visit builds it again. */
  forget(x: number, y: number): Promise<void>;
}

const PENDING_MS = 10 * 60 * 1000; // sign-ins and game links wait at most this long
const COOKIE_DAYS = 180;
const LINK_CODE = /^[A-Za-z0-9]{4,16}$/;

function html(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>
<style>body{font:17px/1.5 system-ui,sans-serif;background:#141922;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:28em;padding:2em}h1{font-size:1.5em}a{color:#9fd98f}</style>
<main><h1>${title}</h1>${body}</main>`);
}
const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function sendFile(res: ServerResponse, base: string, rel: string): Promise<void> {
  const file = path.resolve(base, rel);
  if (!file.startsWith(base + path.sep)) return json(res, 403, { error: "forbidden" });
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

function sameCode(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp(options: AppOptions = {}): App {
  const accessCode = options.accessCode ?? "";
  // A trip somewhere new builds about 50 things (25 chunks and their labels), so this is eight trips in
  // the window. The shared services are protected by the one-at-a-time map download, not by this.
  const limit = options.coldBuildLimit ?? 400;
  const windowMs = options.coldBuildWindowMs ?? 5 * 60 * 1000;
  const readCache = options.readCache ?? cacheRead;
  const writeCache = options.writeCache ?? cacheWrite;
  const findPlace = options.findPlace ?? geocode;
  const findAround = options.findAround ?? (options.findPlace ? (query: string) => findPlace(query) : geocodeAround);
  const elevation = new Elevation();
  const buildChunk = options.buildChunk ?? ((x, y) => generateChunk(x, y, elevation));
  const buildLabels = options.buildLabels ?? ((x, y) => generateLabels(x, y, elevation));
  // The inside of a building: a home's rooms, or a shop's, an office's, a mall's, with who is in there (venues.ts).
  const buildInside = options.buildInside ?? (options.buildInterior
    ? async (x: number, y: number, id: number) => { const mesh = await options.buildInterior!(x, y, id); return mesh ? { mesh, who: null } : null; }
    : (x: number, y: number, id: number) => generateInside(x, y, id, elevation));
  const interiorRel = (x: number, y: number, id: number): string => `interiors/v${FORMAT_VERSION}.${GENERATOR_REV}.${INTERIOR_REV}/${CHUNK_Z}/${x}/${y}/${id}.ewc`;
  const whoRel = (x: number, y: number, id: number): string => `interiors/v${FORMAT_VERSION}.${GENERATOR_REV}.${INTERIOR_REV}/${CHUNK_Z}/${x}/${y}/${id}.who${VENUES_REV}.json`;
  /** Builds the inside of a building and keeps both halves of it; null when there is no such building to walk into. */
  const insides = new InFlight<{ mesh: Buffer; who: Buffer | null } | null>();
  const makeInside = (x: number, y: number, id: number): Promise<{ mesh: Buffer; who: Buffer | null } | null> => insides.get(`${x}/${y}/${id}`, async () => {
    const built = await buildInside(x, y, id);
    if (built) await Promise.all([writeCache(interiorRel(x, y, id), built.mesh), ...(built.who ? [writeCache(whoRel(x, y, id), built.who)] : [])]);
    return built;
  });
  const homes = options.homes ?? new Homes();
  const readPlan: ReadPlan | null = options.readPlan !== undefined ? options.readPlan : process.env.ANTHROPIC_API_KEY ? claudePlanReader() : null;
  const plansPerDay = options.plansPerDay ?? 3;
  /** How many pictures each person has had read today. */
  const planTries = new Map<string, { day: string; n: number }>();
  const measureHome = options.findHome ?? ((x: number, y: number, id: number) => findHome(x, y, id, elevation));
  /** The insides of lived-in houses, as last built: a few, by house and by how often it has changed. */
  const furnished = new Map<string, Buffer>();
  const insideNames = new Map<string, { use?: string; name?: string } | null>();
  const accounts = options.accounts ?? new AccountDirectory(undefined, { accessCode, invited: options.invited });
  const placeName = options.placeName ?? reversePlace;
  const givenName = options.placeName;
  const placeDetail = options.placeDetail ?? (givenName ? async (lat: number, lon: number) => ({ name: await givenName(lat, lon), country: null }) : reverseDetail);
  const talker = options.talker ?? new Talker();
  const journals = new Journals({ store: options.journalStore ?? null, startCoins: options.startCoins, placeDetail, planHunt: options.planHunt ?? ((lat, lon, day) => planHunt(lat, lon, day)) });
  const findNear = options.findNear ?? geocodeNear;
  const routeBetween: (fromLat: number, fromLon: number, toLat: number, toLon: number, far?: boolean) => Promise<Route | null> =
    options.planRoute ?? ((fromLat, fromLon, toLat, toLon, far) => planRoute(fromLat, fromLon, toLat, toLon, undefined, far));
  /**
   * Where a rider asked to go, and for a car or tractor the way there by road: all of it when it is close, the
   * first leg of it when it is a long drive (`more`). Slow map downloads are not waited for.
   */
  const wayTo = async (lat: number, lon: number, place: string, sp: string, at?: { lat: number; lon: number }) => {
    // (`at`: the game asking knows where the place is already, from an answer of the guide.)
    const found = at ? { name: place, lat: at.lat, lon: at.lon } : await findNear(place, lat, lon);
    if (!found) return null;
    const driven = sp === "car" || sp === "tractor" || sp === "taxi"
      ? await Promise.race([routeBetween(lat, lon, found.lat, found.lon, true).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 12_000).unref())])
      : null;
    // (Driven on the car's own side of the road, not down the middle of it.)
    return { name: found.name.split(",").slice(0, 2).join(","), lat: found.lat, lon: found.lon, ...(driven ? { path: laned(driven, drivesLeft(lat, lon)), ...(driven.more ? { more: true } : {}) } : {}) };
  };
  /** A taxi for someone at a position who wants to go to a place: the place, and a road for the taxi to come along from a few streets away. */
  const cab = async (lat: number, lon: number, place: string, at?: { lat: number; lon: number }) => {
    const dest = await wayTo(lat, lon, place, "taxi", at);
    if (!dest) return null;
    let pickup: [number, number][] = [[lat, lon]]; // failing a road to come by, it simply turns up
    const gaveUp = Date.now() + 8000;
    for (const k of [0, 3, 6, 1, 4, 7, 2, 5]) {
      if (Date.now() > gaveUp) break;
      const from = [lat + (260 / 111_320) * Math.cos((k * Math.PI) / 4), lon + (260 / (111_320 * Math.cos((lat * Math.PI) / 180))) * Math.sin((k * Math.PI) / 4)];
      const way = await routeBetween(from[0], from[1], lat, lon).catch(() => null);
      if (way && way.metres >= 100 && way.metres <= 900) { pickup = laned(way, drivesLeft(lat, lon)); break; }
    }
    return { dest, pickup };
  };
  const ahead = options.warm ? new LookAhead(options.warm) : null;
  // The guide (guide.ts) reads what is near a player out of the labels already built for the chunks round them:
  // it never has a chunk built for a question. What it made of a chunk's labels is kept a while.
  const sightsKept = new Map<string, { at: number; sights: ChunkSights }>();
  const sights = async (x: number, y: number): Promise<ChunkSights | null> => {
    const key = `${x}/${y}`;
    const kept = sightsKept.get(key);
    if (kept && Date.now() - kept.at < 10 * 60_000) return kept.sights;
    const data = await readCache(`labels/v1.${LABELS_REV}/${CHUNK_Z}/${x}/${y}.json`);
    if (!data) return null;
    const made = sightsOf(JSON.parse(data.toString("utf8")));
    sightsKept.delete(key);
    sightsKept.set(key, { at: Date.now(), sights: made });
    if (sightsKept.size > 90) sightsKept.delete(sightsKept.keys().next().value!);
    return made;
  };
  const guide = new Guide({
    // (Rounded to about a kilometre before it goes anywhere, as for `/v1/place`.)
    placeDetail: (lat, lon) => placeDetail(Math.round(lat * 100) / 100, Math.round(lon * 100) / 100),
    sights, findNear, planRoute: (aLat, aLon, bLat, bLon) => routeBetween(aLat, aLon, bLat, bLon),
    tasks: (key) => journals.view(key)?.today.tasks ?? [],
    shows: SHOWS,
    ask: options.guideAsk !== undefined ? options.guideAsk : process.env.ANTHROPIC_API_KEY ? claudeGuide() : null,
    budget: talker, model: talker.modelName,
  });
  const rooms = new Rooms(options.people ?? accounts, { placeName, talker, journal: journals, wayTo, cab, guide, taxiRemarkMs: options.taxiRemarkMs,
    homes, findHome: measureHome, worldRev: GENERATOR_REV,
    // What the building somebody is talked to in is called: from what was kept when its inside was built (nothing is built for this).
    insideOf: async (x, y, id) => {
      const key = `${x}/${y}/${id}`;
      let known = insideNames.get(key);
      if (known === undefined) {
        const who = await readCache(whoRel(x, y, id));
        try { const j = who ? JSON.parse(who.toString("utf8")) as { use?: unknown; name?: unknown } : null; known = j ? { ...(typeof j.use === "string" ? { use: j.use } : {}), ...(typeof j.name === "string" ? { name: j.name.slice(0, 40) } : {}) } : null; } catch { known = null; }
        if (insideNames.size >= 200) insideNames.delete(insideNames.keys().next().value!);
        insideNames.set(key, known);
      }
      return known;
    },
    ...(ahead ? { moved: (id: string, lat: number, lon: number) => ahead.moved(id, lat, lon) } : {}),
    course: (lat, lon, seed) => planCourse(lat, lon, seed, (aLat, aLon, bLat, bLon) => routeBetween(aLat, aLon, bLat, bLon)),
  });
  const presence = new Presence(accounts, rooms, placeName);
  const google = options.google;
  const signIn = options.signIn ?? (google ? googleSignIn(google) : undefined);
  const pendingAuth = new Map<string, { nonce: string; link: string | null; next: string; accessCode: string; created: number }>();
  const links = new Map<string, { token: string; name: string; avatar: string; created: number }>(); // game link code -> token waiting to be collected
  // How much memory the process holds, in megabytes, and the most it has held since it started: on /health,
  // because the live machine stops the server at 512 and nothing else says how near that is.
  // (memParts says where it is: the JavaScript heap as set aside and as in use, and what lies outside it in
  // buffers; memTop the same at the moment of the most; memSet how the process was started. On this PC the
  // heap was the whole story and on the live machine it was not, which is what these are for.)
  let memMost = 0;
  const mbOf = (bytes: number): number => Math.round(bytes / 1048576);
  const partsOf = (m: NodeJS.MemoryUsage): Record<string, number> => ({ rss: mbOf(m.rss), heap: mbOf(m.heapTotal), used: mbOf(m.heapUsed), outside: mbOf(m.external) });
  let memTop: Record<string, number> = {};
  const memNow = (): number => {
    const m = process.memoryUsage();
    const mb = mbOf(m.rss);
    if (mb > memMost) { memMost = mb; memTop = partsOf(m); }
    return mb;
  };
  setInterval(memNow, 500).unref();
  const memSet = { args: process.execArgv.join(" "), arenas: process.env.MALLOC_ARENA_MAX ?? null, node: process.version, platform: process.platform };
  const building = new InFlight<Buffer>();
  // A game arriving somewhere new asks for fifty pieces at once (25 chunks and their labels). Built all
  // together, each holds its half-made meshes while the others take their turns, and the memory that
  // takes is what the 512 MB live machine ran out of (2026-11-23, after 0.2.47). Built a few at a time
  // they take no longer in all: there is one processor, and they were only ever taking turns on it.
  const buildsAtOnce = new Gate(Math.max(1, Number(process.env.EARTHWALK_BUILDS_AT_ONCE) || options.buildsAtOnce || 2));
  const coldBuilds = new Map<string, number[]>(); // caller address -> times of recent uncached builds

  const callerOf = (req: IncomingMessage): string => {
    const forwarded = options.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
    return forwarded || req.socket.remoteAddress || "unknown";
  };

  /** The player token a request carries (Bearer header or the browser's cookie), if it is a live one. */
  const tokenOf = (req: IncomingMessage): string | null => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (bearer && accounts.byToken(bearer)) return bearer;
    const cookie = cookieValue(req.headers.cookie, TOKEN_COOKIE);
    return cookie && accounts.byToken(cookie) ? cookie : null;
  };

  const allowed = (req: IncomingMessage, url: URL): boolean => {
    if (!accessCode) return true;
    const header = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    return sameCode(header ?? url.searchParams.get("code") ?? "", accessCode) || tokenOf(req) !== null;
  };

  const baseUrlOf = (req: IncomingMessage): string => {
    if (options.baseUrl) return options.baseUrl.replace(/\/+$/, "");
    const proto = (options.trustProxy && String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim()) || "http";
    return `${proto}://${req.headers.host ?? "localhost"}`;
  };
  const expire = <T extends { created: number }>(map: Map<string, T>): void => {
    const cutoff = Date.now() - PENDING_MS;
    for (const [k, v] of map) if (v.created < cutoff) map.delete(k);
  };
  const tokenCookie = (req: IncomingMessage, token: string | null): string =>
    `${TOKEN_COOKIE}=${token ?? ""}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? COOKIE_DAYS * 86400 : 0}${baseUrlOf(req).startsWith("https:") ? "; Secure" : ""}`;

  /**
   * Sign-in and account routes, kept apart from the world routes. A server without Google
   * configured answers the sign-in routes with 404 and everything else keeps working.
   */
  const serveAccounts = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const p = url.pathname;
    if (p === "/auth/google") {
      if (!google || !signIn) return json(res, 404, { error: "Google sign-in is not set up on this server" }), true;
      expire(pendingAuth);
      const link = url.searchParams.get("link") ?? "";
      const next = url.searchParams.get("next") ?? "/";
      const state = randomBytes(16).toString("base64url");
      const nonce = randomBytes(16).toString("base64url");
      pendingAuth.set(state, { nonce, link: LINK_CODE.test(link) ? link.toUpperCase() : null, next: next.startsWith("/") && !next.startsWith("//") ? next : "/", accessCode: url.searchParams.get("code") ?? "", created: Date.now() });
      res.writeHead(302, { Location: authUrl(google, `${baseUrlOf(req)}/auth/google/callback`, state, nonce), "Cache-Control": "no-store" });
      res.end();
      return true;
    }
    if (p === "/auth/google/callback") {
      if (!google || !signIn) return json(res, 404, { error: "Google sign-in is not set up on this server" }), true;
      expire(pendingAuth);
      const state = url.searchParams.get("state") ?? "";
      const pending = pendingAuth.get(state);
      pendingAuth.delete(state);
      const code = url.searchParams.get("code");
      if (!pending || !code) return html(res, 400, "Sign-in did not complete", `<p>${escapeHtml(url.searchParams.get("error") ?? "The sign-in link has expired.")} <a href="/">Try again</a>.</p>`), true;
      let identity: GoogleIdentity;
      try {
        identity = await signIn(code, pending.nonce, `${baseUrlOf(req)}/auth/google/callback`);
      } catch (err) {
        console.error(`google sign-in: ${err instanceof Error ? err.message : String(err)}`);
        return html(res, 502, "Google did not confirm the sign-in", `<p>Please <a href="/">try again</a>.</p>`), true;
      }
      const result = accounts.signIn(identity, { accessCode: pending.accessCode });
      if (!result) {
        if (pending.link) return html(res, 403, "Not invited yet", `<p>${escapeHtml(identity.email)} is not on this server's guest list. Type <b>/code &lt;access code&gt;</b> in the game first, then <b>/login</b> again, or ask whoever runs the server to invite you.</p>`), true;
        res.writeHead(302, { Location: "/?signin=not-invited", "Cache-Control": "no-store" });
        return res.end(), true;
      }
      if (pending.link) {
        expire(links);
        links.set(pending.link, { token: result.token, name: result.person.name, avatar: result.person.avatar, created: Date.now() });
        return html(res, 200, `Signed in as ${escapeHtml(result.person.name)}`, `<p>You can close this page and go back to EarthWalk. The game signs itself in within a few seconds.</p>`), true;
      }
      res.writeHead(302, { Location: pending.next, "Set-Cookie": tokenCookie(req, result.token), "Cache-Control": "no-store" });
      res.end();
      return true;
    }
    if (p === "/auth/logout") {
      const token = tokenOf(req);
      if (token) accounts.revokeToken(token);
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Set-Cookie": tokenCookie(req, null), "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: true }));
      return true;
    }
    if (p === "/link") {
      // The game opened this page: hand the person to Google, remembering which game asked.
      const code = url.searchParams.get("code") ?? "";
      if (!LINK_CODE.test(code)) return html(res, 400, "Bad link", "<p>This link is missing its code. Type <b>/login</b> in the game to get a fresh one.</p>"), true;
      if (!google) return html(res, 404, "Sign-in is not set up", "<p>This server has no Google sign-in. Use <b>/code</b> in the game instead.</p>"), true;
      const to = new URL("/auth/google", "http://x");
      to.searchParams.set("link", code.toUpperCase());
      if (url.searchParams.get("access")) to.searchParams.set("code", url.searchParams.get("access")!);
      res.writeHead(302, { Location: to.pathname + to.search, "Cache-Control": "no-store" });
      res.end();
      return true;
    }
    const link = /^\/v1\/link\/([A-Za-z0-9]+)$/.exec(p);
    if (link) {
      // The game polls this until its person has signed in; the token is handed out once.
      if (!LINK_CODE.test(link[1])) return json(res, 400, { error: "bad link code" }), true;
      expire(links);
      const ready = links.get(link[1].toUpperCase());
      res.setHeader("Cache-Control", "no-store");
      if (!ready) return json(res, 200, { pending: true }), true;
      links.delete(link[1].toUpperCase());
      return json(res, 200, { token: ready.token, name: ready.name, avatar: ready.avatar }), true;
    }
    if (p === "/v1/me" || p === "/v1/people" || p === "/v1/journal") {
      const me = accounts.byToken(tokenOf(req));
      if (!me) return json(res, 401, { error: "sign in first" }), true;
      res.setHeader("Cache-Control", "no-store");
      // A journal goes to its owner and nobody else: there is no way to name another person here.
      if (p === "/v1/journal") return json(res, 200, await journals.viewPerson(me.id)), true;
      if (p === "/v1/me") return json(res, 200, { id: me.id, name: me.name, avatar: me.avatar, email: me.email, home: me.home, created: me.created }), true;
      return json(res, 200, { people: presence.snapshot() }), true;
    }
    return false;
  };

  /** Building a new part of the world costs downloads from shared public services, so cap it per caller. */
  const mayBuild = (caller: string): boolean => {
    const now = Date.now();
    const recent = (coldBuilds.get(caller) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) {
      coldBuilds.set(caller, recent);
      return false;
    }
    recent.push(now);
    coldBuilds.set(caller, recent);
    if (coldBuilds.size > 5000) coldBuilds.delete(coldBuilds.keys().next().value!);
    return true;
  };

  /**
   * Serves one per-chunk product (mesh or labels) from the cache, building and caching it on a miss.
   * Both kinds share the access check, the zoom/range checks and the per-caller cold-build limit.
   */
  const serveBuilt = async (req: IncomingMessage, res: ServerResponse, url: URL, m: RegExpExecArray,
    cacheRel: (x: number, y: number) => string, build: (x: number, y: number) => Promise<Buffer>, contentType: string,
    keep: (built: Buffer) => boolean = () => true): Promise<void> => {
    if (!allowed(req, url)) return json(res, 401, { error: "access code required" });
    const z = Number(m[1]);
    const x = Number(m[2]);
    const y = Number(m[3]);
    const n = 2 ** CHUNK_Z;
    if (z !== CHUNK_Z || x >= n || y >= n) return json(res, 400, { error: `chunks exist only at zoom ${CHUNK_Z}` });
    const rel = cacheRel(x, y);
    let data = await readCache(rel);
    if (!data) {
      if (!mayBuild(callerOf(req))) {
        res.setHeader("Retry-After", "30");
        return json(res, 429, { error: "exploring too fast; try again shortly" });
      }
      data = await building.get(rel, async () => {
        const built = await buildsAtOnce.run(() => build(x, y));
        if (keep(built)) await writeCache(rel, built); // something built with a piece missing is sent but not kept
        return built;
      });
    }
    res.writeHead(200, { "Content-Type": contentType, "Content-Length": data.length, "Cache-Control": "private, max-age=86400" });
    res.end(data);
  };

  const chunkRel = (x: number, y: number): string => `chunks/v${FORMAT_VERSION}.${GENERATOR_REV}/${CHUNK_Z}/${x}/${y}.ewc`;
  const labelsRel = (x: number, y: number): string => `labels/v1.${LABELS_REV}/${CHUNK_Z}/${x}/${y}.json`;
  const keepLabels = (built: Buffer): boolean => !partialLabels.has(built);

  const prepare = async (x: number, y: number): Promise<void> => {
    const pieces: [string, (x: number, y: number) => Promise<Buffer>, (built: Buffer) => boolean][] = [[chunkRel(x, y), buildChunk, () => true], [labelsRel(x, y), buildLabels, keepLabels]];
    for (const [rel, build, keep] of pieces) {
      if (await readCache(rel)) continue;
      await building.get(rel, async () => {
        const built = await buildsAtOnce.run(() => build(x, y));
        if (keep(built)) await writeCache(rel, built);
        return built;
      });
    }
  };

  const forget = async (x: number, y: number): Promise<void> => {
    await Promise.all([chunkRel(x, y), labelsRel(x, y), `interiors/v${FORMAT_VERSION}.${GENERATOR_REV}.${INTERIOR_REV}/${CHUNK_Z}/${x}/${y}`].map((rel) => cacheRemove(rel)));
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const p = url.pathname;
      if (req.method === "POST" && p === "/v1/plan") {
        // A picture of a floor plan, from somebody signed in who has a house: read into a plan for it, which they are
        // shown and may then have built (the `plan` of a `house` message). Three tries a day each; the reading is
        // paid for out of the same daily allowance as the talking things.
        const me = accounts.byToken(tokenOf(req));
        if (!me) return json(res, 401, { error: "Sign in first: plans are for people with their own account" });
        if (!homes.of(me.id)) return json(res, 409, { error: "You need a house of your own first: go into a house nobody lives in and press H" });
        const mediaType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
        if (!PLAN_MEDIA.includes(mediaType)) return json(res, 415, { error: "A plan is a picture (PNG, JPEG, WebP or GIF) or a PDF" });
        if (!readPlan) return json(res, 503, { error: "Plans cannot be read here just now" });
        const day = new Date().toISOString().slice(0, 10);
        const tries = planTries.get(me.id)?.day === day ? planTries.get(me.id)! : { day, n: 0 };
        if (tries.n >= plansPerDay) return json(res, 429, { error: `${plansPerDay === 1 ? "One plan" : `${plansPerDay} plans`} a day: try again tomorrow`, left: 0 });
        if (!(await talker.mayAsk())) return json(res, 503, { error: "The game has asked the AI all it may today: try again tomorrow" });
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > PLAN_MAX_BYTES) return json(res, 413, { error: "That picture is too big: four megabytes at most" });
          chunks.push(chunk as Buffer);
        }
        if (size < 100) return json(res, 400, { error: "No picture came" });
        tries.n++;
        planTries.set(me.id, tries);
        if (planTries.size > 5000) planTries.clear();
        const left = plansPerDay - tries.n;
        let read: Awaited<ReturnType<ReadPlan>>;
        try {
          read = await readPlan(Buffer.concat(chunks), mediaType);
        } catch (err) {
          console.error("plan: the picture could not be read", err instanceof Error ? err.message : err);
          tries.n--; // not their fault: the try is given back
          return json(res, 502, { error: "The picture could not be read just now. Try again in a moment.", left: left + 1 });
        }
        await talker.charge(read.inputTokens, read.outputTokens, read.model).catch(() => undefined);
        const made = read.raw ? normalisePlan(read.raw) : null;
        if (!made) return json(res, 422, { error: read.raw ? "No rooms could be made out on that picture" : "That does not look like the floor plan of a house", left });
        res.setHeader("Cache-Control", "no-store");
        return json(res, 200, { plan: made.plan, notes: made.notes, lines: describePlan(made.plan), left });
      }
      if (req.method !== "GET" && !(req.method === "POST" && p === "/auth/logout")) return json(res, 405, { error: "method not allowed" });
      if (await serveAccounts(req, res, url)) return;

      // The builds below are awaited, not just returned: one that fails must be caught here, or the
      // rejection goes unhandled and takes the whole server down with everyone in it.
      const chunk = /^\/v1\/chunk\/(\d+)\/(\d+)\/(\d+)$/.exec(p);
      if (chunk) {
        return await serveBuilt(req, res, url, chunk, chunkRel, buildChunk, "application/octet-stream");
      }
      const labels = /^\/v1\/labels\/(\d+)\/(\d+)\/(\d+)$/.exec(p);
      if (labels) {
        return await serveBuilt(req, res, url, labels, labelsRel, buildLabels, "application/json; charset=utf-8", keepLabels);
      }
      const interior = /^\/v1\/interior\/(\d+)\/(\d+)\/(\d+)\/(-?\d+)$/.exec(p);
      if (interior) {
        // The inside of one home: built the first time someone walks in, and kept.
        if (!allowed(req, url)) return json(res, 401, { error: "access code required" });
        const [z, x, y, id] = [Number(interior[1]), Number(interior[2]), Number(interior[3]), Number(interior[4])];
        if (z !== CHUNK_Z || x >= 2 ** CHUNK_Z || y >= 2 ** CHUNK_Z || !Number.isSafeInteger(id)) return json(res, 400, { error: `homes exist only at zoom ${CHUNK_Z}` });
        // Somebody lives there: it is built from what is kept of it (home.ts), furnished their way, and not from the map.
        const lived = homes.at(x, y, id);
        if (lived) {
          if (lived.gen !== GENERATOR_REV) homes.measured(lived, await measureHome(x, y, id).catch(() => null), GENERATOR_REV); // the world was made again since
          // A game that knows about houses built from their owner's plan asks for that (`?plan=1`), and is given it far
          // above the real house; any other is given the house's ordinary rooms, where it expects them.
          const planned = url.searchParams.get("plan") === "1" && lived.plan ? lived.plan : null;
          const key = `${x}/${y}/${id}/${lived.rev}${planned ? "/plan" : ""}`;
          let inside = furnished.get(key);
          if (!inside) {
            inside = furnishedInterior(x, y, lived.home, lived.decor, planned);
            if (furnished.size >= 40) furnished.delete(furnished.keys().next().value!);
            furnished.set(key, inside);
          }
          res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": inside.length, "Cache-Control": "no-store" });
          return void res.end(inside);
        }
        let data = await readCache(interiorRel(x, y, id));
        if (!data) {
          if (!mayBuild(callerOf(req))) {
            res.setHeader("Retry-After", "30");
            return json(res, 429, { error: "exploring too fast; try again shortly" });
          }
          const built = await makeInside(x, y, id);
          if (!built) return json(res, 404, { error: "no home to walk into there" });
          data = built.mesh;
        }
        res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": data.length, "Cache-Control": "private, max-age=86400" });
        return void res.end(data);
      }
      const inside = /^\/v1\/inside\/(\d+)\/(\d+)\/(\d+)\/(-?\d+)$/.exec(p);
      if (inside) {
        // Who is in a shop, an office, a mall: its people, its lettering and its tills, as JSON (venues.ts).
        if (!allowed(req, url)) return json(res, 401, { error: "access code required" });
        const [z, x, y, id] = [Number(inside[1]), Number(inside[2]), Number(inside[3]), Number(inside[4])];
        if (z !== CHUNK_Z || x >= 2 ** CHUNK_Z || y >= 2 ** CHUNK_Z || !Number.isSafeInteger(id)) return json(res, 400, { error: `buildings exist only at zoom ${CHUNK_Z}` });
        let who = await readCache(whoRel(x, y, id));
        if (!who) {
          if (!mayBuild(callerOf(req))) {
            res.setHeader("Retry-After", "30");
            return json(res, 429, { error: "exploring too fast; try again shortly" });
          }
          who = (await makeInside(x, y, id))?.who ?? null;
          if (!who) return json(res, 404, { error: "nobody is in there" });
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": who.length, "Cache-Control": "private, max-age=86400" });
        return void res.end(who);
      }
      if (p === "/v1/showcase") {
        // Things to show people, each with a place where it is right there (showcase.ts).
        if (!allowed(req, url)) return json(res, 401, { error: "access code required" });
        return json(res, 200, { shows: SHOWS });
      }
      if (p === "/v1/news") {
        // What is new since the version a player last saw (news.ts); with no `since`, the newest few.
        if (!allowed(req, url)) return json(res, 401, { error: "access code required" });
        return json(res, 200, newsSince(url.searchParams.get("since")));
      }
      if (p === "/v1/geocode") {
        if (!allowed(req, url)) return json(res, 401, { error: "access code required" });
        // With where the asker is (lat, lon), "the beach" is the beach down the road and not a town of that name abroad.
        const q = url.searchParams.get("q") ?? "";
        const lat = Number(url.searchParams.get("lat") ?? NaN), lon = Number(url.searchParams.get("lon") ?? NaN);
        const from = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 85 && Math.abs(lon) <= 180;
        const place = from ? await findAround(q, lat, lon) : await findPlace(q);
        return place ? json(res, 200, place) : json(res, 404, { error: "place not found" });
      }
      if (p === "/v1/place") {
        if (!allowed(req, url)) return json(res, 401, { error: "access code required" });
        const lat = Number(url.searchParams.get("lat"));
        const lon = Number(url.searchParams.get("lon"));
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) return json(res, 400, { error: "lat and lon are needed" });
        // Rounded to about a kilometre before it goes anywhere: enough to name the neighbourhood, and no more.
        return json(res, 200, await placeDetail(Math.round(lat * 100) / 100, Math.round(lon * 100) / 100));
      }
      if (p === "/health") return json(res, 200, { ok: true, version: VERSION, chunkZoom: CHUNK_Z, format: FORMAT_VERSION, codeRequired: !!accessCode, googleSignIn: !!google, talking: talker.live, guide: guide.live, ...rooms.stats(), mem: memNow(), memMost, memParts: partsOf(process.memoryUsage()), memTop, memSet });
      if (p === "/") return sendFile(res, PUBLIC, "play.html");
      const vendor = /^\/vendor\/([a-z-]+)\/(.+)$/.exec(p);
      if (vendor && VENDOR[vendor[1]]) return sendFile(res, VENDOR[vendor[1]], vendor[2]);
      return sendFile(res, PUBLIC, p.slice(1));
    } catch (err) {
      console.error(`${req.url}: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) json(res, 502, { error: "could not build this part of the world right now" });
      else res.end();
    }
  });

  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/v1/ws") return void socket.destroy();
    rooms.wss.handleUpgrade(req, socket, head, (ws) => rooms.wss.emit("connection", ws, req));
  });

  return { server, rooms, accounts, presence, journals, prepare, forget, close: () => { presence.close(); rooms.close(); void journals.close(); server.close(); } };
}
