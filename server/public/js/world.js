// The generated world in the browser: streams chunks around the player and converts between
// latitude/longitude and scene coordinates.
//
// Scene coordinates (three.js, metres): +x east, +y up (height above sea level), +z south,
// measured from a movable origin, the last place the player travelled to.

import * as THREE from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { decodeChunk, GRID, terrainHeight } from "./chunk.js";
import { CHUNK_Z, TILES, latToY, lonToX, metersPerTile, xToLon, yToLat } from "./geo.js";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const MAX_IN_FLIGHT = 4;
const TREE_SECTION = 30; // the server's cone trees; we plant our own from the labels route instead
const LABEL_RETRY_MS = 15000;
const LABEL_TRIES = 4;
const WATER = 7; // the ground that boats sail on and nothing else may cross
const isBuilding = (id) => id >= 20 && id <= 25;
const isWall = (id) => id >= 20 && id <= 23;

/**
 * Where each corner of a wall is on that wall, so the wall material can draw windows that fit it:
 * metres along the wall, metres up from the ground, the length of the wall and its height above the
 * ground (walls go down into the ground a little, and on a slope a long way). The server sends a wall
 * as four corners and two triangles; gable ends and anything else get zeros, and so no windows.
 */
function wallCoords(pos, indices, groundAt) {
  const wall = new Float32Array((pos.length / 3) * 4);
  for (let t = 0; t + 5 < indices.length; ) {
    const a = Math.min(indices[t], indices[t + 1], indices[t + 2]);
    const second = [indices[t + 3], indices[t + 4], indices[t + 5]];
    const quad = Math.max(indices[t], indices[t + 1], indices[t + 2]) === a + 2 && Math.min(...second) === a && Math.max(...second) === a + 3;
    if (!quad) { t += 3; continue; }
    t += 6;
    const y = [0, 1, 2, 3].map((k) => pos[(a + k) * 3 + 1]);
    const foot = Math.min(...y), top = Math.max(...y);
    if (top - foot < 2.6) continue;
    const low = [0, 1, 2, 3].filter((k) => y[k] < (foot + top) / 2);
    if (low.length !== 2) continue;
    const [k0, k1] = low;
    const g0 = groundAt(pos[(a + k0) * 3], pos[(a + k0) * 3 + 2]), g1 = groundAt(pos[(a + k1) * 3], pos[(a + k1) * 3 + 2]);
    const height = top - Math.max(g0, g1);
    if (height < 2.2) continue;
    const dx = pos[(a + k1) * 3] - pos[(a + k0) * 3], dz = pos[(a + k1) * 3 + 2] - pos[(a + k0) * 3 + 2];
    const length = Math.hypot(dx, dz);
    if (length < 1.8) continue;
    for (let k = 0; k < 4; k++) {
      const along = ((pos[(a + k) * 3] - pos[(a + k0) * 3]) * dx + (pos[(a + k) * 3 + 2] - pos[(a + k0) * 3 + 2]) * dz) / length;
      wall.set([along, y[k] - (g0 + (g1 - g0) * Math.min(1, Math.max(0, along / length))), length, height], (a + k) * 4);
    }
  }
  return wall;
}

// Windows, drawn by the wall's own material: one to a bay and a row to a storey, spaced to fit the
// wall so that none is cut off at a corner. White frames, blue glass, a cross of glazing bars.
const WINDOWS = `
  if (vWall.z > 1.8 && vWall.w > 2.2) {
    float bay = vWall.z / max(1.0, floor((vWall.z - 0.5) / 2.7));
    float x = abs(fract(vWall.x / bay) - 0.5) * bay;
    float rows = max(1.0, floor((vWall.w + 0.3) / 3.0));
    float up = vWall.y;
    float row = floor(up / 3.0);
    float y = up - row * 3.0;
    if (row >= 0.0 && row < rows) {
      float frame = step(x, 0.62) * step(0.88, y) * step(y, 2.42);
      float glass = step(x, 0.52) * step(0.98, y) * step(y, 2.32);
      float bars = min(1.0, step(x, 0.04) + step(abs(y - 1.65), 0.04));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.88, 0.8), frame);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.4, 0.62), glass * (1.0 - bars));
    }
  }
`;

// Tree parts, shared by every chunk: unit shapes scaled per tree (the same proportions as the Unreal game).
const TRUNK = new THREE.CylinderGeometry(0.5, 0.5, 1, 7);
const CROWN = new THREE.IcosahedronGeometry(0.5, 1);
const CONE = new THREE.ConeGeometry(0.5, 1, 8);
const BARK = new THREE.MeshLambertMaterial({ color: 0x5a3d2a });
const LEAF = new THREE.MeshLambertMaterial({ color: 0x3f8a2f, flatShading: true });
const NEEDLE = new THREE.MeshLambertMaterial({ color: 0x2f6b2f, flatShading: true });
// A rounded crown: one big ball with three smaller ones tucked around it. Offsets and sizes are in canopy radii.
const CROWN_PARTS = [
  { at: [0, 0, 0], size: [2, 1.7, 2] },
  { at: [0.45, 0.45, 0.25], size: [1.4, 1.4, 1.4] },
  { at: [-0.5, 0.2, -0.3], size: [1.3, 1.3, 1.3] },
  { at: [0.1, -0.1, -0.55], size: [1.2, 1.2, 1.2] },
];

export class World {
  constructor(scene, { code = "", radius = 2 } = {}) {
    this.scene = scene;
    this.code = code;
    this.radius = radius;
    this.root = new THREE.Group();
    scene.add(this.root);
    this.chunks = new Map(); // "x/y" -> { group, heights, x, y }
    this.pending = new Set();
    this.retryAfter = new Map();
    this.materials = new Map();
    this.solids = []; // building meshes the player collides with
    this.generation = 0;
    this.lastError = "";
    this.setOrigin(0, 0);
  }

  /** Re-centres the world on a place and drops everything loaded for the old one. */
  setOrigin(lat, lon) {
    lat = Math.min(85, Math.max(-85, lat));
    this.originX = lonToX(lon);
    this.originY = latToY(lat);
    this.tileM = metersPerTile(lat);
    this.generation++;
    for (const key of [...this.chunks.keys()]) this.unload(key);
    this.pending.clear();
    this.retryAfter.clear();
  }

  geoToScene(lat, lon, alt = 0) {
    return new THREE.Vector3((lonToX(lon) - this.originX) * this.tileM, alt, (latToY(lat) - this.originY) * this.tileM);
  }

  sceneToGeo(p) {
    return { lat: yToLat(this.originY + p.z / this.tileM), lon: xToLon(this.originX + p.x / this.tileM), alt: p.y };
  }

  chunkAt(x, z) {
    const tx = this.originX + x / this.tileM;
    const ty = this.originY + z / this.tileM;
    return { cx: Math.floor(tx), cy: Math.floor(ty), u: tx - Math.floor(tx), v: ty - Math.floor(ty) };
  }

  /** Terrain height under a scene position, or null while that chunk has not arrived. */
  groundHeight(x, z) {
    const { cx, cy, u, v } = this.chunkAt(x, z);
    const chunk = this.chunks.get(`${cx}/${cy}`);
    return chunk ? terrainHeight(chunk.heights, u, v) : null;
  }

  /** Is this spot open water? Null while that chunk has not arrived. (Streams drawn as a line do not count.) */
  waterAt(x, z) {
    const { cx, cy, u, v } = this.chunkAt(x, z);
    const chunk = this.chunks.get(`${cx}/${cy}`);
    if (!chunk) return null;
    return chunk.water[Math.min(GRID - 1, Math.floor(v * GRID)) * GRID + Math.min(GRID - 1, Math.floor(u * GRID))] === 1;
  }

  unload(key) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.root.remove(chunk.group);
    for (const mesh of chunk.group.children) {
      if (mesh.isInstancedMesh) {
        mesh.dispose(); // trees share their geometry between chunks, so only the instance data goes
        continue;
      }
      mesh.geometry.disposeBoundsTree?.();
      mesh.geometry.dispose();
    }
    this.solids = this.solids.filter((m) => m.parent !== chunk.group);
    this.chunks.delete(key);
  }

  material(color) {
    const key = color.join(",");
    let m = this.materials.get(key);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color: new THREE.Color().setRGB(color[0], color[1], color[2], THREE.SRGBColorSpace) });
      this.materials.set(key, m);
    }
    return m;
  }

  /** Paint seen from both sides: the insides of houses, whose walls are thin sheets. */
  insideMaterial(color) {
    const key = `inside,${color.join(",")}`;
    let m = this.materials.get(key);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color: new THREE.Color().setRGB(color[0], color[1], color[2], THREE.SRGBColorSpace), side: THREE.DoubleSide });
      this.materials.set(key, m);
    }
    return m;
  }

  ceilingMaterial(color) {
    const key = `ceiling,${color.join(",")}`;
    let m = this.materials.get(key);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(color[0] * 0.9, color[1] * 0.9, color[2] * 0.9, THREE.SRGBColorSpace), side: THREE.DoubleSide });
      this.materials.set(key, m);
    }
    return m;
  }

  /** Adds the inside of a house (in the chunk format) to its chunk; it leaves with the chunk. */
  addInterior(chunk, id, data) {
    const S = this.tileM;
    for (const section of data.sections) {
      const n = section.uvh.length / 3;
      const pos = new Float32Array(n * 3);
      const nrm = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        pos[i * 3] = section.uvh[i * 3] * S;
        pos[i * 3 + 1] = section.uvh[i * 3 + 2];
        pos[i * 3 + 2] = section.uvh[i * 3 + 1] * S;
        nrm[i * 3] = section.normals[i * 3];
        nrm[i * 3 + 1] = section.normals[i * 3 + 2];
        nrm[i * 3 + 2] = -section.normals[i * 3 + 1];
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
      geometry.setIndex(new THREE.BufferAttribute(section.indices, 1));
      // A ceiling faces the floor, where no light comes from: it is simply its own colour, a little dimmed.
      const mesh = new THREE.Mesh(geometry, section.materialId === 42 ? this.ceilingMaterial(section.color) : this.insideMaterial(section.color));
      mesh.matrixAutoUpdate = false;
      chunk.group.add(mesh);
      mesh.updateMatrixWorld(true);
      if (section.collision) {
        geometry.computeBoundsTree();
        this.solids.push(mesh);
      }
    }
    (chunk.interiors ??= new Set()).add(id);
  }

  /** The same paint for a wall, with windows in it. */
  wallMaterial(color) {
    const key = `wall,${color.join(",")}`;
    let m = this.materials.get(key);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color: new THREE.Color().setRGB(color[0], color[1], color[2], THREE.SRGBColorSpace) });
      m.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", "#include <common>\nattribute vec4 wall;\nvarying vec4 vWall;")
          .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWall = wall;");
        shader.fragmentShader = shader.fragmentShader
          .replace("#include <common>", "#include <common>\nvarying vec4 vWall;")
          .replace("#include <color_fragment>", `#include <color_fragment>\n${WINDOWS}`);
      };
      this.materials.set(key, m);
    }
    return m;
  }

  /** Call regularly with the player's position: loads what is near, drops what is far. */
  update(position) {
    const { cx, cy } = this.chunkAt(position.x, position.z);
    for (const [key, chunk] of this.chunks) {
      if (Math.max(Math.abs(chunk.x - cx), Math.abs(chunk.y - cy)) > this.radius + 1) this.unload(key);
    }
    const wanted = [];
    const now = performance.now();
    for (let dy = -this.radius; dy <= this.radius; dy++) {
      for (let dx = -this.radius; dx <= this.radius; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        const key = `${x}/${y}`;
        if (y < 0 || y >= TILES || this.chunks.has(key) || this.pending.has(key)) continue;
        if ((this.retryAfter.get(key) ?? 0) > now) continue;
        wanted.push({ x, y, key, d: dx * dx + dy * dy });
      }
    }
    wanted.sort((a, b) => a.d - b.d);
    for (const w of wanted) {
      if (this.pending.size >= MAX_IN_FLIGHT) break;
      this.request(w);
    }
  }

  async request({ x, y, key }) {
    this.pending.add(key);
    const generation = this.generation;
    try {
      const wrapped = ((x % TILES) + TILES) % TILES;
      const res = await fetch(`/v1/chunk/${CHUNK_Z}/${wrapped}/${y}`, { headers: this.code ? { Authorization: `Bearer ${this.code}` } : {} });
      if (!res.ok) throw new Error(res.status === 429 ? "Exploring too fast; the server asked us to slow down" : res.status === 401 ? "The access code was not accepted" : `The server could not build part of this area (${res.status})`);
      const data = decodeChunk(await res.arrayBuffer());
      if (generation !== this.generation) return; // the player travelled away meanwhile
      this.add(x, y, key, data);
      this.lastError = "";
      this.requestTrees(x, y, key);
    } catch (err) {
      if (generation !== this.generation) return;
      this.lastError = err instanceof TypeError ? "Cannot reach the world server" : err.message;
      this.retryAfter.set(key, performance.now() + 10000);
    } finally {
      if (generation === this.generation) this.pending.delete(key);
    }
  }

  add(x, y, key, data) {
    const S = this.tileM;
    const group = new THREE.Group();
    group.position.set((x - this.originX) * S, 0, (y - this.originY) * S);
    const water = new Uint8Array(GRID * GRID); // which cells of the terrain are water, from where its triangles lie
    for (const section of data.sections) {
      if (section.materialId === TREE_SECTION) continue;
      if (section.materialId === WATER) {
        const { uvh, indices } = section;
        for (let t = 0; t + 2 < indices.length; t += 3) {
          const u = (uvh[indices[t] * 3] + uvh[indices[t + 1] * 3] + uvh[indices[t + 2] * 3]) / 3;
          const v = (uvh[indices[t] * 3 + 1] + uvh[indices[t + 1] * 3 + 1] + uvh[indices[t + 2] * 3 + 1]) / 3;
          water[Math.min(GRID - 1, Math.max(0, Math.floor(v * GRID))) * GRID + Math.min(GRID - 1, Math.max(0, Math.floor(u * GRID)))] = 1;
        }
      }
      const n = section.uvh.length / 3;
      const pos = new Float32Array(n * 3);
      const nrm = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        pos[i * 3] = section.uvh[i * 3] * S; // east
        pos[i * 3 + 1] = section.uvh[i * 3 + 2]; // up
        pos[i * 3 + 2] = section.uvh[i * 3 + 1] * S; // south
        nrm[i * 3] = section.normals[i * 3]; // file order is east, north, up
        nrm[i * 3 + 1] = section.normals[i * 3 + 2];
        nrm[i * 3 + 2] = -section.normals[i * 3 + 1];
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geometry.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
      geometry.setIndex(new THREE.BufferAttribute(section.indices, 1));
      const walls = isWall(section.materialId);
      if (walls) geometry.setAttribute("wall", new THREE.BufferAttribute(wallCoords(pos, section.indices, (px, pz) => terrainHeight(data.heights, px / S, pz / S)), 4));
      const mesh = new THREE.Mesh(geometry, walls ? this.wallMaterial(section.color) : this.material(section.color));
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      if (isBuilding(section.materialId)) {
        geometry.computeBoundsTree();
        this.solids.push(mesh);
      }
    }
    group.updateMatrixWorld(true);
    this.root.add(group);
    this.chunks.set(key, { group, heights: data.heights, water, x, y });
  }

  /** Fetches a chunk's trees from the labels route. It is optional, so failures are retried slowly and quietly. */
  async requestTrees(x, y, key, tries = LABEL_TRIES) {
    const chunk = this.chunks.get(key);
    if (!chunk || chunk.trees) return;
    try {
      const wrapped = ((x % TILES) + TILES) % TILES;
      const res = await fetch(`/v1/labels/${CHUNK_Z}/${wrapped}/${y}`, { headers: this.code ? { Authorization: `Bearer ${this.code}` } : {} });
      if (!res.ok) throw new Error(`labels ${res.status}`);
      const { items } = await res.json();
      if (this.chunks.get(key) !== chunk || chunk.trees) return; // unloaded (or reloaded) meanwhile
      chunk.trees = true;
      chunk.treeItems = items.filter((it) => it.kind === "tree"); // kept so that trees, and
      chunk.doors = items.filter((it) => it.kind === "door"); // front doors that open (houses.js)
      chunk.houses = items.filter((it) => it.kind === "house"); // the houses with a number, can be talked to (talk.js)
      chunk.homes = items.filter((it) => it.kind === "home"); // where herds live; life.js brings them to life
      chunk.routes = items.filter((it) => it.kind === "route"); // the trips cars make, and
      chunk.cars = items.filter((it) => it.kind === "car"); // the cars parked at the kerb; traffic.js drives them
      chunk.trains = items.filter((it) => it.kind === "train"); // and the trains, each sent with every chunk on its run
      this.plant(chunk, items.filter((it) => it.kind === "tree"));
    } catch {
      if (tries > 1) setTimeout(() => { if (this.chunks.get(key) === chunk) this.requestTrees(x, y, key, tries - 1); }, LABEL_RETRY_MS);
    }
  }

  /** Plants a chunk's trees: a trunk with a leafy crown, or with a cone for conifers. One instanced mesh per part. */
  plant(chunk, trees) {
    if (trees.length === 0) return;
    const S = this.tileM;
    const clampTo = (v, lo, hi, fallback) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
    const leafy = trees.filter((t) => !t.c);
    const conifers = trees.filter((t) => t.c);
    const make = (geometry, material, count) => {
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.frustumCulled = false; // instances spread over the whole chunk, far beyond the unit shape's bounds
      return mesh;
    };
    const trunks = make(TRUNK, BARK, trees.length);
    const crowns = leafy.length ? make(CROWN, LEAF, leafy.length * CROWN_PARTS.length) : null;
    const cones = conifers.length ? make(CONE, NEEDLE, conifers.length) : null;
    const part = new THREE.Object3D();
    const offset = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    let nTrunk = 0, nCrown = 0, nCone = 0;
    for (const t of trees) {
      const height = clampTo(t.s, 2, 40, 7);
      const radius = clampTo(t.r, 0.5, 12, 2);
      const yaw = THREE.MathUtils.degToRad(t.yaw || 0);
      const bx = t.u * S, by = t.h, bz = t.v * S;
      const trunkH = height * (t.c ? 0.3 : 0.45);
      part.rotation.set(0, yaw, 0);
      part.position.set(bx, by + trunkH / 2, bz);
      part.scale.set(0.3, trunkH, 0.3);
      part.updateMatrix();
      trunks.setMatrixAt(nTrunk++, part.matrix);
      if (t.c) {
        part.position.set(bx, by + height * 0.6, bz);
        part.scale.set(radius * 1.8, height * 0.8, radius * 1.8);
        part.updateMatrix();
        cones.setMatrixAt(nCone++, part.matrix);
      } else {
        for (const { at, size } of CROWN_PARTS) {
          offset.set(at[0], at[1], at[2]).multiplyScalar(radius).applyAxisAngle(up, yaw);
          part.position.set(bx + offset.x, by + height * 0.65 + offset.y, bz + offset.z);
          part.scale.set(size[0] * radius, size[1] * radius, size[2] * radius);
          part.updateMatrix();
          crowns.setMatrixAt(nCrown++, part.matrix);
        }
      }
    }
    for (const mesh of [trunks, crowns, cones]) {
      if (!mesh) continue;
      mesh.instanceMatrix.needsUpdate = true;
      chunk.group.add(mesh);
      mesh.updateMatrixWorld(true);
    }
  }
}
