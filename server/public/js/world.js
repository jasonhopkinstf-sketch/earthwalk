// The generated world in the browser: streams chunks around the player and converts between
// latitude/longitude and scene coordinates.
//
// Scene coordinates (three.js, metres): +x east, +y up (height above sea level), +z south,
// measured from a movable origin, the last place the player travelled to.

import * as THREE from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { decodeChunk, terrainHeight } from "./chunk.js";
import { CHUNK_Z, TILES, latToY, lonToX, metersPerTile, xToLon, yToLat } from "./geo.js";

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const MAX_IN_FLIGHT = 4;
const isBuilding = (id) => id >= 20 && id <= 25;

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

  unload(key) {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    this.root.remove(chunk.group);
    for (const mesh of chunk.group.children) {
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
    for (const section of data.sections) {
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
      const mesh = new THREE.Mesh(geometry, this.material(section.color));
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      if (isBuilding(section.materialId)) {
        geometry.computeBoundsTree();
        this.solids.push(mesh);
      }
    }
    group.updateMatrixWorld(true);
    this.root.add(group);
    this.chunks.set(key, { group, heights: data.heights, x, y });
  }
}
