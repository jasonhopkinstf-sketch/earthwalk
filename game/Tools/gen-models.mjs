// Turns ready-made car models into a C++ table the Windows game builds its meshes from
// (game/Source/EarthWalk/EarthModels.gen.inl), so no editor import is needed.
//
//   node game/Tools/gen-models.mjs            (reads game/Models/kenney-car-kit)
//   node game/Tools/gen-models.mjs <folder>   (reads another folder of .glb files and colormap.png)
//
// The models are from Kenney's Car Kit 3.1 (www.kenney.nl), public domain (CC0); the licence is beside
// them. Each is a body and four wheels painted from one small palette picture. Here they are joined
// into one mesh, the palette colour is written onto every corner, and the corners that carry the car's
// main paint are marked, so the game can give each car its own colour as it does for its own cars.
//
// A trial (2026-11): the game only draws them when started with -EWModels=free.
import { readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const folder = process.argv[2] ?? join(here, "..", "Models", "kenney-car-kit");
const out = join(here, "..", "Source", "EarthWalk", "EarthModels.gen.inl");

// Which model stands in for which of the game's own vehicles (the names in liferigs.js), and how much
// bigger than the file it is drawn: the kit's cars are about 2.6 units long, ours about 3.9 metres, and
// they are wider and taller for their length, so they are not blown up all the way.
const SCALE = 1.35;
const MODELS = [
  { rig: "car", file: "sedan.glb" },
  { rig: "van", file: "van.glb" },
  { rig: "taxi", file: "taxi.glb" },
];

/** A PNG as { width, height, at(x, y) -> [r, g, b] }: eight bits a channel, plain or with a palette. */
function readPng(path) {
  const buf = readFileSync(path);
  let pos = 8, width = 0, height = 0, depth = 0, type = 0, palette = null;
  const data = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), kind = buf.toString("latin1", pos + 4, pos + 8), body = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === "IHDR") { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; type = body[9]; if (body[12] !== 0) throw new Error("interlaced PNG"); }
    else if (kind === "PLTE") palette = body;
    else if (kind === "IDAT") data.push(body);
    pos += 12 + len;
  }
  if (depth !== 8) throw new Error(`PNG depth ${depth}`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  const raw = inflateSync(Buffer.concat(data)), stride = width * channels, px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? px[y * stride + i - channels] : 0, b = y > 0 ? px[(y - 1) * stride + i] : 0, c = i >= channels && y > 0 ? px[(y - 1) * stride + i - channels] : 0;
      let add = 0;
      if (filter === 1) add = a;
      else if (filter === 2) add = b;
      else if (filter === 3) add = (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + i] = (line[i] + add) & 255;
    }
  }
  const at = (x, y) => {
    const i = Math.min(height - 1, Math.max(0, y)) * stride + Math.min(width - 1, Math.max(0, x)) * channels;
    if (type === 3) return [palette[px[i] * 3], palette[px[i] * 3 + 1], palette[px[i] * 3 + 2]];
    if (type === 0 || type === 4) return [px[i], px[i], px[i]];
    return [px[i], px[i + 1], px[i + 2]];
  };
  return { width, height, at };
}

/** The parts of a .glb as flat lists: every corner's place (the file's own axes), normal and palette place. */
function readGlb(path) {
  const buf = readFileSync(path);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString("utf8", 20, 20 + jsonLen));
  const bin = buf.subarray(20 + jsonLen + 8);
  const sizes = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const read = (index) => {
    const acc = json.accessors[index], view = json.bufferViews[acc.bufferView], n = sizes[acc.type];
    const bytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[acc.componentType];
    const stride = view.byteStride ?? n * bytes, start = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const values = [];
    for (let i = 0; i < acc.count; i++) {
      for (let k = 0; k < n; k++) {
        const at = start + i * stride + k * bytes;
        let v = acc.componentType === 5126 ? bin.readFloatLE(at) : acc.componentType === 5125 ? bin.readUInt32LE(at) : acc.componentType === 5123 ? bin.readUInt16LE(at) : acc.componentType === 5122 ? bin.readInt16LE(at) : acc.componentType === 5121 ? bin[at] : bin.readInt8(at);
        if (acc.normalized) v /= { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[acc.componentType];
        values.push(v);
      }
    }
    return values;
  };
  const turn = (q, v) => {
    const [x, y, z, w] = q, ix = w * v[0] + y * v[2] - z * v[1], iy = w * v[1] + z * v[0] - x * v[2], iz = w * v[2] + x * v[1] - y * v[0], iw = -x * v[0] - y * v[1] - z * v[2];
    return [ix * w + iw * -x + iy * -z - iz * -y, iy * w + iw * -y + iz * -x - ix * -z, iz * w + iw * -z + ix * -y - iy * -x];
  };
  const parts = [];
  const walk = (index, place) => {
    const node = json.nodes[index];
    const t = node.translation ?? [0, 0, 0], q = node.rotation ?? [0, 0, 0, 1], s = node.scale ?? [1, 1, 1];
    if (node.matrix) throw new Error("node with a matrix");
    const mine = (p) => place(turn(q, [p[0] * s[0], p[1] * s[1], p[2] * s[2]]).map((v, k) => v + t[k]));
    const mineTurn = (n) => place.turn(turn(q, n));
    mine.turn = mineTurn;
    if (node.mesh !== undefined) {
      for (const prim of json.meshes[node.mesh].primitives) {
        const p = read(prim.attributes.POSITION), n = read(prim.attributes.NORMAL), uv = read(prim.attributes.TEXCOORD_0);
        const idx = prim.indices !== undefined ? read(prim.indices) : p.map((_, i) => i).slice(0, p.length / 3);
        const corners = [];
        for (let i = 0; i < p.length / 3; i++) corners.push({ p: mine([p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]), n: mineTurn([n[i * 3], n[i * 3 + 1], n[i * 3 + 2]]), uv: [uv[i * 2], uv[i * 2 + 1]] });
        parts.push({ name: node.name, corners, idx });
      }
    }
    for (const child of node.children ?? []) walk(child, mine);
  };
  const same = (p) => p;
  same.turn = (n) => n;
  for (const root of json.scenes[json.scene ?? 0].nodes) walk(root, same);
  return parts;
}

const palette = readPng(join(folder, "colormap.png"));
const colourAt = (uv) => palette.at(Math.floor(uv[0] * palette.width), Math.floor(uv[1] * palette.height));
// The palette is eight swatches across and four down; a swatch is the unit of "one paint".
const swatchOf = (uv) => Math.min(7, Math.max(0, Math.floor(uv[0] * 8))) + 8 * Math.min(3, Math.max(0, Math.floor(uv[1] * 4)));
const saturation = ([r, g, b]) => { const hi = Math.max(r, g, b), lo = Math.min(r, g, b); return hi === 0 ? 0 : (hi - lo) / hi; };

const ident = (name) => name.replace(/(^|[^a-z0-9])([a-z0-9])/gi, (_, __, c) => c.toUpperCase());
const rows = (values, per) => { const lines = []; for (let i = 0; i < values.length; i += per) lines.push("\t\t" + values.slice(i, i + per).join(",") + ","); return lines.join("\n"); };

let text = `// Made by game/Tools/gen-models.mjs from Kenney's Car Kit 3.1 (www.kenney.nl, CC0). Do not edit by hand.
// P: each corner's place in tenths of a centimetre, engine axes (X forward, Y right, Z up), wheels on
// the ground at the origin. N: its normal, times 127. C: its colour as in the palette picture (sRGB),
// then 255 where the car's own paint goes and 0 elsewhere. I: three corners to a triangle.
`;
const table = [];
for (const model of MODELS) {
  const parts = readGlb(join(folder, model.file));
  // The car's main paint: the most-used strongly coloured swatch on its body.
  const area = new Map();
  for (const part of parts.filter((p) => p.name === "body")) {
    for (let i = 0; i < part.idx.length; i += 3) {
      const [a, b, c] = [part.corners[part.idx[i]], part.corners[part.idx[i + 1]], part.corners[part.idx[i + 2]]];
      const u = a.p.map((v, k) => b.p[k] - v), w = a.p.map((v, k) => c.p[k] - v);
      const size = Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) / 2;
      const mid = [(a.uv[0] + b.uv[0] + c.uv[0]) / 3, (a.uv[1] + b.uv[1] + c.uv[1]) / 3];
      if (saturation(colourAt(mid)) > 0.4) area.set(swatchOf(mid), (area.get(swatchOf(mid)) ?? 0) + size);
    }
  }
  const paint = [...area.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1;

  // Stand it on the ground in the middle, then into the engine's axes. The file has x to the car's left,
  // y up and z to its front; the engine wants X forward, Y right, Z up. That is a mirror image, and the
  // engine also counts the corners of a triangle the other way round, so their order stays as it is
  // (tried: turned over, the cars came out inside out).
  const all = parts.flatMap((p) => p.corners);
  const lo = [0, 1, 2].map((k) => Math.min(...all.map((c) => c.p[k]))), hi = [0, 1, 2].map((k) => Math.max(...all.map((c) => c.p[k])));
  const mid = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
  const P = [], N = [], C = [], I = [], seen = new Map();
  for (const part of parts) {
    const ids = part.corners.map((c) => {
      const p = [(c.p[2] - mid[2]) * SCALE * 1000, -(c.p[0] - mid[0]) * SCALE * 1000, (c.p[1] - mid[1]) * SCALE * 1000].map(Math.round);
      const len = Math.hypot(...c.n) || 1;
      const n = [c.n[2] / len, -c.n[0] / len, c.n[1] / len].map((v) => Math.round(v * 127));
      const col = [...colourAt(c.uv), part.name === "body" && swatchOf(c.uv) === paint ? 255 : 0];
      const key = [...p, ...n, ...col].join(",");
      if (!seen.has(key)) { seen.set(key, P.length / 3); P.push(...p); N.push(...n); C.push(...col); }
      return seen.get(key);
    });
    for (let i = 0; i < part.idx.length; i += 3) {
      const [a, b, c] = [ids[part.idx[i]], ids[part.idx[i + 1]], ids[part.idx[i + 2]]];
      if (a !== b && b !== c && a !== c) I.push(a, b, c);
    }
  }
  if (P.length / 3 > 65535) throw new Error(`${model.file}: too many corners`);
  const name = ident(model.rig);
  text += `static const int16 ${name}_P[] = {\n${rows(P, 30)}\n};\nstatic const int8 ${name}_N[] = {\n${rows(N, 45)}\n};\nstatic const uint8 ${name}_C[] = {\n${rows(C, 40)}\n};\nstatic const uint16 ${name}_I[] = {\n${rows(I, 36)}\n};\n`;
  table.push(`\t{ TEXT("${model.rig}"), ${name}_P, ${name}_N, ${name}_C, ${P.length / 3}, ${name}_I, ${I.length} },`);
  const size = [0, 1, 2].map((k) => ((hi[k] - lo[k]) * SCALE).toFixed(2));
  console.log(`${model.rig} <- ${model.file}: ${P.length / 3} corners, ${I.length / 3} triangles, ${size[2]} m long, ${size[0]} wide, ${size[1]} high, own paint on swatch ${paint} (${paint >= 0 ? colourAt([((paint % 8) + 0.25) / 8, (Math.floor(paint / 8) + 0.5) / 4]) : "none"})`);
}
text += `static const FModel Models[] = {\n${table.join("\n")}\n};\n`;
writeFileSync(out, text.replace(/\n/g, "\r\n"));
console.log("wrote", out, `${Math.round(text.length / 1024)} KB`);
