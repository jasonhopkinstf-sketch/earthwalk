// Turns ready-made car models into the tables both games build their meshes from: C++ for the Windows
// game (game/Source/EarthWalk/EarthModels.gen.inl, so no editor import is needed) and packed numbers
// for the browser (server/public/js/models.gen.js).
//
//   node game/Tools/gen-models.mjs            (reads game/Models/kenney-car-kit)
//   node game/Tools/gen-models.mjs <folder>   (reads another folder of .glb files and colormap.png)
//
// The models are from Kenney's Car Kit 3.1 (www.kenney.nl), public domain (CC0); the licence is beside
// them. Each is a body and four wheels painted from one small palette picture. Here they are joined
// into one mesh, the palette colour is written onto every corner, and the corners that carry the car's
// main paint are marked, so the game can give each car its own colour as it does for its own cars.
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
// `plain`: it keeps the kit's own colours all over (a police car is not painted like the car next door).
const SCALE = 1.35;
const MODELS = [
  { rig: "car", file: "sedan.glb" },
  { rig: "van", file: "van.glb" },
  { rig: "taxi", file: "taxi.glb", seat: 1.51 }, // beside its sign, not on it
  { rig: "hatch", file: "hatchback-sports.glb" },
  { rig: "suv", file: "suv.glb" },
  { rig: "pickup", file: "truck.glb" },
  { rig: "delivery", file: "delivery.glb" },
  { rig: "police", file: "police.glb", plain: true },
  { rig: "ambulance", file: "ambulance.glb", plain: true },
  { rig: "firetruck", file: "firetruck.glb", plain: true },
  { rig: "tractor", file: "tractor.glb" },
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
// A model's body is one mesh without its wheels. The wheels are meshes of their own, each kind once (most
// cars share one), with its middle at the origin and its hub to the car's left: Wheels says where each
// model's stand (tenths of a centimetre), which are turned round for the right-hand side, and how big
// they are, so that a game can roll them. Seat is how high a rider on the roof sits.
`;
const table = [];
const forBrowser = [];
const base64 = (typed) => Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString("base64");
// The browser's axes are x east, y up, z south with the car facing north: the engine's (Y, Z, -X).
const turned = (v) => v.flatMap((_, k) => (k % 3 === 0 ? [v[k + 1], v[k + 2], -v[k]] : []));
/** Corners of some parts as one mesh: places through `place`, each corner's colour and whether it takes the car's paint. */
function meshOf(parts, place, turn, own) {
  const P = [], N = [], C = [], I = [], seen = new Map();
  for (const part of parts) {
    const ids = part.corners.map((c) => {
      const p = place(c.p).map(Math.round);
      const len = Math.hypot(...c.n) || 1;
      const n = turn([c.n[2] / len, -c.n[0] / len, c.n[1] / len]).map((v) => Math.round(v * 127));
      const col = [...colourAt(c.uv), own(part, c) ? 255 : 0];
      const key = [...p, ...n, ...col].join(",");
      if (!seen.has(key)) { seen.set(key, P.length / 3); P.push(...p); N.push(...n); C.push(...col); }
      return seen.get(key);
    });
    for (let i = 0; i < part.idx.length; i += 3) {
      const [a, b, c] = [ids[part.idx[i]], ids[part.idx[i + 1]], ids[part.idx[i + 2]]];
      if (a !== b && b !== c && a !== c) I.push(a, b, c);
    }
  }
  if (P.length / 3 > 65535) throw new Error("too many corners");
  return { P, N, C, I };
}
/**
 * The kit's wheels are perfectly round, hub and all, so nobody could see one turn. This paints five dark
 * slots on the bright ring of the hub's outer face (the wheel's left, the least y), like a steel wheel's.
 */
function spokes(mesh) {
  const { P, N, C, I } = mesh;
  const face = Math.min(...P.filter((_, k) => k % 3 === 1));
  let hub = 0, ring = Infinity;
  for (let k = 0; k < P.length / 3; k++) {
    if (P[k * 3 + 1] > face + 1 || C[k * 4] + C[k * 4 + 1] + C[k * 4 + 2] < 0x60 * 3) continue; // not on the face, or the tyre
    const r = Math.hypot(P[k * 3], P[k * 3 + 2]);
    hub = Math.max(hub, r);
    ring = Math.min(ring, r);
  }
  if (!(hub > 0)) return;
  const inner = Math.max(ring, hub * 0.6) + hub * 0.04, outer = hub * 0.95, half = hub * 0.1;
  for (let s = 0; s < 5; s++) {
    const a = (s / 5) * Math.PI * 2, along = [Math.cos(a), Math.sin(a)], across = [-Math.sin(a), Math.cos(a)];
    const first = P.length / 3;
    for (const [r, side] of [[inner, -1], [inner, 1], [outer, 1], [outer, -1]]) {
      P.push(Math.round(along[0] * r + across[0] * half * side), face - 4, Math.round(along[1] * r + across[1] * half * side));
      N.push(0, -127, 0);
      C.push(0x36, 0x36, 0x3a, 0);
    }
    I.push(first, first + 1, first + 2, first, first + 2, first + 3, first, first + 2, first + 1, first, first + 3, first + 2); // seen from either side
  }
}
const wheelKinds = new Map(); // what tells one kind of wheel from another -> { index, mesh }
const wheelRows = [];
for (const model of MODELS) {
  const parts = readGlb(join(folder, model.file));
  const scale = SCALE * (model.scale ?? 1);
  // (The spare on the back of the SUV is called a wheel too, and does not roll.)
  const isWheel = (p) => /^wheel-(front|back)-(left|right)/.test(p.name);
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
  const paint = model.plain ? -1 : [...area.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1;

  // Stand it on the ground in the middle, then into the engine's axes. The file has x to the car's left,
  // y up and z to its front; the engine wants X forward, Y right, Z up. That is a mirror image, and the
  // engine also counts the corners of a triangle the other way round, so their order stays as it is
  // (tried: turned over, the cars came out inside out).
  const all = parts.flatMap((p) => p.corners);
  const lo = [0, 1, 2].map((k) => Math.min(...all.map((c) => c.p[k]))), hi = [0, 1, 2].map((k) => Math.max(...all.map((c) => c.p[k])));
  const mid = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
  const engine = (p) => [(p[2] - mid[2]) * scale * 1000, -(p[0] - mid[0]) * scale * 1000, (p[1] - mid[1]) * scale * 1000];
  const same = (v) => v;
  const body = meshOf(parts.filter((p) => !isWheel(p)), engine, same, (part, c) => (part.name === "body" || part.name.startsWith("door")) && swatchOf(c.uv) === paint); // (a delivery van has its doors as parts of their own)

  // Where a rider on the roof sits: the top of the body over its middle (a taxi's sign and a police car's lights are not sat on: `seat` says).
  // (Looked for straight down through its triangles at five spots: a roof is often one big flat piece with no corner near the middle.)
  let roof = 0;
  for (const [sx, sy] of [[0, 0], [250, 0], [-250, 0], [0, 200], [0, -200]]) {
    for (let i = 0; i < body.I.length; i += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => body.P.slice(body.I[i + k] * 3, body.I[i + k] * 3 + 3));
      const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(d) < 1e-6) continue;
      const u = ((b[1] - c[1]) * (sx - c[0]) + (c[0] - b[0]) * (sy - c[1])) / d, v = ((c[1] - a[1]) * (sx - c[0]) + (a[0] - c[0]) * (sy - c[1])) / d;
      if (u >= 0 && v >= 0 && u + v <= 1) roof = Math.max(roof, u * a[2] + v * b[2] + (1 - u - v) * c[2]);
    }
  }
  // (A quarter of a metre under the roof is where the seated figure's feet go for it to sit on the roof and not above it: the saloon's 1.5 m, as it always was.)
  const seat = Math.round(model.seat !== undefined ? model.seat * 1000 : roof - 250);

  // The wheels, each a mesh of its own about its middle, hub to the left, so that it can turn.
  const wheels = [];
  for (const part of parts.filter(isWheel)) {
    const at = part.corners.map((c) => engine(c.p));
    const wlo = [0, 1, 2].map((k) => Math.min(...at.map((p) => p[k]))), whi = [0, 1, 2].map((k) => Math.max(...at.map((p) => p[k])));
    const centre = wlo.map((v, k) => (v + whi[k]) / 2);
    const radius = (whi[2] - wlo[2]) / 2, width = whi[1] - wlo[1];
    const right = centre[1] > 0;
    const sign = part.corners.length + ":" + part.idx.length + ":" + Math.round(radius / 5) + ":" + Math.round(width / 5);
    if (!wheelKinds.has(sign)) {
      // (One on the right is turned half round to be one on the left.)
      const about = (p) => { const e = engine(p); return right ? [-(e[0] - centre[0]), -(e[1] - centre[1]), e[2] - centre[2]] : [e[0] - centre[0], e[1] - centre[1], e[2] - centre[2]]; };
      const mesh = meshOf([part], about, (n) => (right ? [-n[0], -n[1], n[2]] : n), () => false);
      spokes(mesh);
      wheelKinds.set(sign, { index: wheelKinds.size, mesh, radius });
    }
    wheels.push({ kind: wheelKinds.get(sign).index, at: centre.map(Math.round), flip: right, radius: Math.round(radius) });
  }

  const name = ident(model.rig);
  const { P, N, C, I } = body;
  text += `static const int16 ${name}_P[] = {\n${rows(P, 30)}\n};\nstatic const int8 ${name}_N[] = {\n${rows(N, 45)}\n};\nstatic const uint8 ${name}_C[] = {\n${rows(C, 40)}\n};\nstatic const uint16 ${name}_I[] = {\n${rows(I, 36)}\n};\n`;
  table.push(`\t{ TEXT("${model.rig}"), ${name}_P, ${name}_N, ${name}_C, ${P.length / 3}, ${name}_I, ${I.length}, ${seat}, ${wheelRows.length}, ${wheels.length} },`);
  for (const w of wheels) wheelRows.push(`\t{ ${w.kind}, ${w.at[0]}, ${w.at[1]}, ${w.at[2]}, ${w.flip}, ${w.radius} }, // ${model.rig}`);
  // (For the browser a wheel's place is turned as its corners are: [kind, x, y, z, turned round, radius], millimetres.)
  const webWheels = wheels.map((w) => `[${[w.kind, w.at[1], w.at[2], -w.at[0], w.flip ? 1 : 0, w.radius].join(", ")}]`).join(", ");
  forBrowser.push(`  ${model.rig}: {\n    p: "${base64(Int16Array.from(turned(P)))}",\n    n: "${base64(Int8Array.from(turned(N)))}",\n    c: "${base64(Uint8Array.from(C))}",\n    i: "${base64(Uint16Array.from(I))}",\n    seat: ${(seat / 1000).toFixed(3)},\n    wheels: [${webWheels}],\n  },`);
  const size = [0, 1, 2].map((k) => ((hi[k] - lo[k]) * scale).toFixed(2));
  console.log(`${model.rig} <- ${model.file}: ${P.length / 3} corners, ${I.length / 3} triangles, ${size[2]} m long, ${size[0]} wide, ${size[1]} high, roof ${(roof / 1000).toFixed(2)} m, seat ${(seat / 1000).toFixed(2)} m, ${wheels.length} wheels of radius ${wheels.map((w) => (w.radius / 1000).toFixed(2)).join(" ")}, own paint on swatch ${paint} (${paint >= 0 ? colourAt([((paint % 8) + 0.25) / 8, (Math.floor(paint / 8) + 0.5) / 4]) : "none"})`);
}
const bodies = table.length;
const forBrowserWheels = [];
for (const { index, mesh } of [...wheelKinds.values()].sort((a, b) => a.index - b.index)) {
  const name = `Wheel${index}`;
  const { P, N, C, I } = mesh;
  text += `static const int16 ${name}_P[] = {\n${rows(P, 30)}\n};\nstatic const int8 ${name}_N[] = {\n${rows(N, 45)}\n};\nstatic const uint8 ${name}_C[] = {\n${rows(C, 40)}\n};\nstatic const uint16 ${name}_I[] = {\n${rows(I, 36)}\n};\n`;
  table.push(`\t{ TEXT("wheel:${index}"), ${name}_P, ${name}_N, ${name}_C, ${P.length / 3}, ${name}_I, ${I.length}, 0, 0, 0 },`);
  forBrowserWheels.push(`  {\n    p: "${base64(Int16Array.from(turned(P)))}",\n    n: "${base64(Int8Array.from(turned(N)))}",\n    c: "${base64(Uint8Array.from(C))}",\n    i: "${base64(Uint16Array.from(I))}",\n  },`);
}
text += `static const FModel Models[] = {\n${table.join("\n")}\n};\nstatic const int32 NumBodies = ${bodies};\nstatic const FWheel Wheels[] = {\n${wheelRows.join("\n")}\n};\n`;
writeFileSync(out, text.replace(/\n/g, "\r\n"));
console.log("wrote", out, `${Math.round(text.length / 1024)} KB, ${bodies} bodies, ${wheelKinds.size} kinds of wheel`);

// The same models for the browser game (life.js): packed numbers, as text.
const web = join(here, "..", "..", "server", "public", "js", "models.gen.js");
const webText = `// Made by game/Tools/gen-models.mjs from Kenney's Car Kit 3.1 (www.kenney.nl, CC0). Do not edit by hand.
// Ready-made models that stand in for some of the vehicles of liferigs.js, by the vehicle's name. Each
// is one mesh without its wheels, facing north with the ground at the origin, packed as base64:
// p: every corner's place (x east, y up, z south) in millimetres, 16-bit. n: its normal times 127,
// 8-bit. c: its colour (sRGB) and then 255 where the car's own paint goes, 0 elsewhere. i: three
// corners to a triangle, 16-bit. seat: how high a rider on its roof sits, metres. wheels: where each
// of its wheels stands, [which of WHEELS, x, y, z in millimetres, 1 when turned half round (the
// right-hand side), its radius in millimetres].
export const MODELS = {
${forBrowser.join("\n")}
};
// The wheels, each kind once: a mesh about its own middle, its hub to the car's left (west, the car facing north).
export const WHEELS = [
${forBrowserWheels.join("\n")}
];
`;
writeFileSync(web, webText);
console.log("wrote", web, `${Math.round(webText.length / 1024)} KB`);
