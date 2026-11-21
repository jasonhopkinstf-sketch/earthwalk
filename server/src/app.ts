import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { cacheRead, cacheWrite, InFlight } from "./cache.ts";
import { FORMAT_VERSION, GENERATOR_REV, generateChunk } from "./chunk.ts";
import { Elevation } from "./elevation.ts";
import { CHUNK_Z } from "./geo.ts";
import { generateLabels, LABELS_REV, partialLabels } from "./labels.ts";
import { geocode, placeDetail as reverseDetail, placeName as reversePlace, type Place, type PlaceDetail } from "./geocode.ts";
import { authUrl, googleSignIn, type GoogleOptions } from "./google.ts";
import { AccountDirectory, type GoogleIdentity, type PeopleDirectory } from "./people.ts";
import { Talker } from "./talk.ts";
import { Journals, type JournalStore } from "./journal.ts";
import { Presence } from "./presence.ts";
import { cookieValue, Rooms, TOKEN_COOKIE } from "./rooms.ts";

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
  /** Replaceable for tests. */
  buildChunk?: (x: number, y: number) => Promise<Buffer>;
  buildLabels?: (x: number, y: number) => Promise<Buffer>;
  readCache?: (rel: string) => Promise<Buffer | null>;
  writeCache?: (rel: string, data: Buffer) => Promise<void>;
  findPlace?: (query: string) => Promise<Place | null>;
}

/** The server version, from package.json, shown by clients so a deploy can be told apart. */
export const VERSION: string = createRequire(import.meta.url)("../package.json").version;

export interface App { server: Server; rooms: Rooms; accounts: AccountDirectory; presence: Presence; journals: Journals; close(): void }

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
  const elevation = new Elevation();
  const buildChunk = options.buildChunk ?? ((x, y) => generateChunk(x, y, elevation));
  const buildLabels = options.buildLabels ?? ((x, y) => generateLabels(x, y, elevation));
  const accounts = options.accounts ?? new AccountDirectory(undefined, { accessCode, invited: options.invited });
  const placeName = options.placeName ?? reversePlace;
  const givenName = options.placeName;
  const placeDetail = options.placeDetail ?? (givenName ? async (lat: number, lon: number) => ({ name: await givenName(lat, lon), country: null }) : reverseDetail);
  const talker = options.talker ?? new Talker();
  const journals = new Journals({ store: options.journalStore ?? null, placeDetail });
  const rooms = new Rooms(options.people ?? accounts, { placeName, talker, journal: journals });
  const presence = new Presence(accounts, rooms, placeName);
  const google = options.google;
  const signIn = options.signIn ?? (google ? googleSignIn(google) : undefined);
  const pendingAuth = new Map<string, { nonce: string; link: string | null; next: string; accessCode: string; created: number }>();
  const links = new Map<string, { token: string; name: string; avatar: string; created: number }>(); // game link code -> token waiting to be collected
  const building = new InFlight<Buffer>();
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
        const built = await build(x, y);
        if (keep(built)) await writeCache(rel, built); // something built with a piece missing is sent but not kept
        return built;
      });
    }
    res.writeHead(200, { "Content-Type": contentType, "Content-Length": data.length, "Cache-Control": "private, max-age=86400" });
    res.end(data);
  };

  const server = createServer(async (req, res) => {
    // Everything that can fail is awaited inside this try: a promise returned without await would
    // slip past the catch, and a rejection nobody handles ends the whole server for everyone.
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const p = url.pathname;
      if (req.method !== "GET" && !(req.method === "POST" && p === "/auth/logout")) return json(res, 405, { error: "method not allowed" });
      if (await serveAccounts(req, res, url)) return;

      const chunk = /^\/v1\/chunk\/(\d+)\/(\d+)\/(\d+)$/.exec(p);
      if (chunk) {
        return await serveBuilt(req, res, url, chunk, (x, y) => `chunks/v${FORMAT_VERSION}.${GENERATOR_REV}/${CHUNK_Z}/${x}/${y}.ewc`,
          buildChunk, "application/octet-stream");
      }
      const labels = /^\/v1\/labels\/(\d+)\/(\d+)\/(\d+)$/.exec(p);
      if (labels) {
        return await serveBuilt(req, res, url, labels, (x, y) => `labels/v1.${LABELS_REV}/${CHUNK_Z}/${x}/${y}.json`,
          buildLabels, "application/json; charset=utf-8", (built) => !partialLabels.has(built));
      }
      if (p === "/v1/geocode") {
        if (!allowed(req, url)) return json(res, 401, { error: "access code required" });
        const place = await findPlace(url.searchParams.get("q") ?? "");
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
      if (p === "/health") return json(res, 200, { ok: true, version: VERSION, chunkZoom: CHUNK_Z, format: FORMAT_VERSION, codeRequired: !!accessCode, googleSignIn: !!google, talking: talker.live, ...rooms.stats() });
      if (p === "/") return await sendFile(res, PUBLIC, "play.html");
      const vendor = /^\/vendor\/([a-z-]+)\/(.+)$/.exec(p);
      if (vendor && VENDOR[vendor[1]]) return await sendFile(res, VENDOR[vendor[1]], vendor[2]);
      return await sendFile(res, PUBLIC, p.slice(1));
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

  return { server, rooms, accounts, presence, journals, close: () => { presence.close(); rooms.close(); void journals.close(); server.close(); } };
}
