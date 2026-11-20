import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cacheRead, cacheWrite, InFlight } from "./cache.ts";
import { FORMAT_VERSION, GENERATOR_REV, generateChunk } from "./chunk.ts";
import { Elevation } from "./elevation.ts";
import { CHUNK_Z } from "./geo.ts";
import { geocode } from "./geocode.ts";
import { GuestDirectory } from "./people.ts";
import { Rooms } from "./rooms.ts";

const PORT = Number(process.env.PORT ?? 8787);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const THREE = path.join(ROOT, "node_modules", "three");

const elevation = new Elevation();
const rooms = new Rooms(new GuestDirectory(process.env.EARTHWALK_ACCESS_CODE ?? ""));
const building = new InFlight<Buffer>();

const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body));
}

async function sendFile(res: ServerResponse, base: string, rel: string): Promise<void> {
  const file = path.resolve(base, rel);
  if (!file.startsWith(base + path.sep)) return json(res, 403, { error: "forbidden" });
  try {
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

function chunk(x: number, y: number): Promise<Buffer> {
  const rel = `chunks/v${FORMAT_VERSION}.${GENERATOR_REV}/${CHUNK_Z}/${x}/${y}.ewc`;
  return building.get(rel, async () => {
    const cached = await cacheRead(rel);
    if (cached) return cached;
    const data = await generateChunk(x, y, elevation);
    await cacheWrite(rel, data);
    return data;
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });

    const m = /^\/v1\/chunk\/(\d+)\/(\d+)\/(\d+)$/.exec(p);
    if (m) {
      const z = Number(m[1]);
      const x = Number(m[2]);
      const y = Number(m[3]);
      const n = 2 ** CHUNK_Z;
      if (z !== CHUNK_Z || x >= n || y >= n) return json(res, 400, { error: `chunks exist only at zoom ${CHUNK_Z}` });
      const data = await chunk(x, y);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": data.length, "Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*" });
      return void res.end(data);
    }
    if (p === "/v1/geocode") {
      const place = await geocode(url.searchParams.get("q") ?? "");
      return place ? json(res, 200, place) : json(res, 404, { error: "place not found" });
    }
    if (p === "/health") return json(res, 200, { ok: true, chunkZoom: CHUNK_Z, format: FORMAT_VERSION, ...rooms.stats() });
    if (p === "/") return sendFile(res, PUBLIC, "viewer.html");
    if (p.startsWith("/vendor/three/")) return sendFile(res, THREE, p.slice("/vendor/three/".length));
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

server.listen(PORT, () => console.log(`EarthWalk world server on http://localhost:${PORT}  (viewer at /, rooms at /v1/ws)`));
