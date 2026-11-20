// Decodes the EWC1 chunk format (docs/PROTOCOL.md) into plain typed arrays.

export const GRID = 64; // terrain cells per chunk side
const MAGIC = 0x31435745;
const FLAG_COLLISION = 1;

/**
 * @returns {{ x: number, y: number, sections: Array<{ materialId: number, color: [number, number, number],
 *   collision: boolean, uvh: Float32Array, normals: Float32Array, indices: Uint32Array }>, heights: Float32Array }}
 * `uvh` holds u (0 west .. 1 east), v (0 north .. 1 south) and height in metres per vertex.
 * `heights` is the (GRID+1) x (GRID+1) terrain lattice, rebuilt from the ground sections.
 */
export function decodeChunk(buffer) {
  const dv = new DataView(buffer);
  if (buffer.byteLength < 24 || dv.getUint32(0, true) !== MAGIC) throw new Error("not an EWC1 chunk");
  if (dv.getUint32(4, true) !== 1) throw new Error("unsupported chunk version");
  const x = dv.getUint32(8, true);
  const y = dv.getUint32(12, true);
  const count = dv.getUint32(20, true);
  const heights = new Float32Array((GRID + 1) * (GRID + 1));
  const sections = [];
  let o = 24;
  for (let s = 0; s < count; s++) {
    const materialId = dv.getUint32(o, true);
    const rgba = dv.getUint32(o + 4, true);
    const flags = dv.getUint32(o + 8, true);
    const nv = dv.getUint32(o + 12, true);
    const ni = dv.getUint32(o + 16, true);
    o += 20;
    if (o + nv * 24 + ni * 4 > buffer.byteLength) throw new Error("truncated chunk");
    // Offsets are multiples of 4, so the data can be copied out as typed arrays directly.
    const uvh = new Float32Array(buffer.slice(o, o + nv * 12));
    o += nv * 12;
    const normals = new Float32Array(buffer.slice(o, o + nv * 12));
    o += nv * 12;
    const indices = new Uint32Array(buffer.slice(o, o + ni * 4));
    o += ni * 4;
    if (materialId <= 8) {
      // Ground: every vertex sits on the terrain lattice.
      for (let i = 0; i < nv; i++) {
        const gi = Math.round(uvh[i * 3] * GRID);
        const gj = Math.round(uvh[i * 3 + 1] * GRID);
        if (gi >= 0 && gi <= GRID && gj >= 0 && gj <= GRID) heights[gj * (GRID + 1) + gi] = uvh[i * 3 + 2];
      }
    }
    sections.push({
      materialId,
      color: [((rgba >>> 24) & 255) / 255, ((rgba >>> 16) & 255) / 255, ((rgba >>> 8) & 255) / 255],
      collision: (flags & FLAG_COLLISION) !== 0,
      uvh, normals, indices,
    });
  }
  return { x, y, sections, heights };
}

/** Height of the terrain mesh at (u, v) inside a chunk; the same surface as Elevation.surfaceHeight on the server. */
export function terrainHeight(heights, u, v) {
  const gx = Math.min(GRID - 1e-6, Math.max(0, u * GRID));
  const gy = Math.min(GRID - 1e-6, Math.max(0, v * GRID));
  const i = Math.floor(gx);
  const j = Math.floor(gy);
  const fu = gx - i;
  const fv = gy - j;
  const w = GRID + 1;
  const h00 = heights[j * w + i];
  const h11 = heights[(j + 1) * w + i + 1];
  if (fu >= fv) {
    const h10 = heights[j * w + i + 1];
    return h00 + fu * (h10 - h00) + fv * (h11 - h10);
  }
  const h01 = heights[(j + 1) * w + i];
  return h00 + fv * (h01 - h00) + fu * (h11 - h01);
}
