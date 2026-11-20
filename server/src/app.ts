import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cacheRead, cacheWrite, InFlight } from "./cache.ts";
import { FORMAT_VERSION, GENERATOR_REV, generateChunk } from "./chunk.ts";
import { Elevation } from "./elevation.ts";
import { CHUNK_Z } from "./geo.ts";
import { generateLabels, LABELS_REV } from "./labels.ts";
import { geocode, type Place } from "./geocode.ts";
import { GuestDirectory, type PeopleDirectory } from "./people.ts";
import { Rooms } from "./rooms.ts";

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
  /** Replaceable for tests. */
  buildChunk?: (x: number, y: number) => Promise<Buffer>;
  buildLabels?: (x: number, y: number) => Promise<Buffer>;
  readCache?: (rel: string) => Promise<Buffer | null>;
  writeCache?: (rel: string, data: Buffer) => Promise<void>;
  findPlace?: (query: string) => Promise<Place | null>;
}

export interface App { server: Server; rooms: Rooms; close(): void }

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
  const limit = options.coldBuildLimit ?? 150;
  const windowMs = options.coldBuildWindowMs ?? 5 * 60 * 1000;
  const readCache = options.readCache ?? cacheRead;
  const writeCache = options.writeCache ?? cacheWrite;
  const findPlace = options.findPlace ?? geocode;
  const elevation = new Elevation();
  const buildChunk = options.buildChunk ?? ((x, y) => generateChunk(x, y, elevation));
  const buildLabels = options.buildLabels ?? ((x, y) => generateLabels(x, y, elevation));
  const rooms = new Rooms(options.people ?? new GuestDirectory(accessCode));
  const building = new InFlight<Buffer>();
  const coldBuilds = new Map<string, number[]>(); // caller address -> times of recent uncached builds

  const callerOf = (req: IncomingMessage): string => {
    const forwarded = options.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
    return forwarded || req.socket.remoteAddress || "unknown";
  };

  const allowed = (req: IncomingMessage, url: URL): boolean => {
    if (!accessCode) return true;
    const header = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    return sameCode(header ?? url.searchParams.get("code") ?? "", accessCode);
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
    cacheRel: (x: number, y: number) => string, build: (x: number, y: number) => Promise<Buffer>, contentType: string): Promise<void> => {
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
        await writeCache(rel, built);
        return built;
      });
    }
    res.writeHead(200, { "Content-Type": contentType, "Content-Length": data.length, "Cache-Control": "private, max-age=86400" });
    res.end(data);
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const p = url.pathname;
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });

      const chunk = /^\/v1\/chunk\/(\d+)\/(\d+)\/(\d+)$/.exec(p);
      if (chunk) {
        return serveBuilt(req, res, url, chunk, (x, y) => `chunks/v${FORMAT_VERSION}.${GENERATOR_REV}/${CHUNK_Z}/${x}/${y}.ewc`,
          buildChunk, "application/octet-stream");
      }
      const labels = /^\/v1\/labels\/(\d+)\/(\d+)\/(\d+)$/.exec(p);
      if (labels) {
        return serveBuilt(req, res, url, labels, (x, y) => `labels/v1.${LABELS_REV}/${CHUNK_Z}/${x}/${y}.json`,
          buildLabels, "application/json; charset=utf-8");
      }
      if (p === "/v1/geocode") {
        if (!allowed(req, url)) return json(res, 401, { error: "access code required" });
        const place = await findPlace(url.searchParams.get("q") ?? "");
        return place ? json(res, 200, place) : json(res, 404, { error: "place not found" });
      }
      if (p === "/health") return json(res, 200, { ok: true, chunkZoom: CHUNK_Z, format: FORMAT_VERSION, codeRequired: !!accessCode, ...rooms.stats() });
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

  return { server, rooms, close: () => { rooms.close(); server.close(); } };
}
