// Keeping room on the disk. The world cache (downloaded map data and the areas built from it) only
// ever grew: every new version of the generator left the old version's chunks behind, and every
// place anyone visited stayed for good. When the disk filled, saving failed, and the server stopped.
//
// Two things are done about it, both only ever inside the folders that hold things which can be
// made again (never accounts, journals or anything else that is somebody's):
// - at start-up, what older versions of the generator built is removed;
// - whenever free room runs low, the pieces that were made longest ago are removed until there is
//   room again. They are downloaded or built afresh if anyone goes back there.

import { readdir, rm, stat, statfs, unlink } from "node:fs/promises";
import path from "node:path";

/** The folders of the cache whose contents can always be made again. Nothing outside them is ever touched. */
export const REBUILDABLE = ["chunks", "labels", "interiors", "osm", "elevation", "rail"] as const;
/** Free room to keep, and to get back to once it has run short. */
export const MIN_FREE_BYTES = 150 * 1024 * 1024;
export const WANT_FREE_BYTES = 350 * 1024 * 1024;

/** Free bytes on the disk that holds `dir`, or null where that cannot be told. */
export async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * Removes what older versions built: every folder directly under `chunks`, `labels` and `interiors`
 * that is not one of `current` (for example "chunks/v1.9"). Returns the folders removed.
 */
export async function removeOldVersions(cacheDir: string, current: string[]): Promise<string[]> {
  const keep = new Set(current.map((c) => c.replaceAll("\\", "/")));
  const removed: string[] = [];
  for (const kind of ["chunks", "labels", "interiors"]) {
    const versions = await readdir(path.join(cacheDir, kind), { withFileTypes: true }).catch(() => []);
    for (const v of versions) {
      const rel = `${kind}/${v.name}`;
      if (!v.isDirectory() || keep.has(rel)) continue;
      await rm(path.join(cacheDir, kind, v.name), { recursive: true, force: true }).then(() => removed.push(rel), () => undefined);
    }
  }
  return removed;
}

/** Removes whole folders of the cache that nothing reads any more (given as "osm/15", "rail"). Returns those that were there. */
export async function removeRetired(cacheDir: string, retired: string[]): Promise<string[]> {
  const gone: string[] = [];
  for (const rel of retired) {
    const dir = path.join(cacheDir, rel);
    if (!(await stat(dir).then((s) => s.isDirectory(), () => false))) continue;
    await rm(dir, { recursive: true, force: true }).then(() => gone.push(rel), () => undefined);
  }
  return gone;
}

/** Every file under a folder, with when it was last written. */
async function filesUnder(dir: string, out: { file: string; at: number; size: number }[] = []): Promise<{ file: string; at: number; size: number }[]> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await filesUnder(full, out);
    else if (entry.isFile()) {
      const s = await stat(full).catch(() => null);
      if (s) out.push({ file: full, at: s.mtimeMs, size: s.size });
    }
  }
  return out;
}

/**
 * When free room is below `minFree`, removes the oldest rebuildable pieces until `wantFree` is free
 * (or there is nothing left to remove). `free` is replaceable for the tests. Returns how many files went.
 */
export async function makeRoom(cacheDir: string, minFree = MIN_FREE_BYTES, wantFree = WANT_FREE_BYTES, free: (dir: string) => Promise<number | null> = freeBytes): Promise<number> {
  const before = await free(cacheDir);
  if (before === null || before >= minFree) return 0;
  const files: { file: string; at: number; size: number }[] = [];
  for (const kind of REBUILDABLE) await filesUnder(path.join(cacheDir, kind), files);
  files.sort((a, b) => a.at - b.at);
  let need = wantFree - before;
  let gone = 0;
  for (const f of files) {
    if (need <= 0) break;
    if (await unlink(f.file).then(() => true, () => false)) { need -= f.size; gone++; }
  }
  return gone;
}

/**
 * Looks after the disk for as long as the server runs: old versions go at once, and room is made
 * now and every few minutes after. Nothing here can stop the server: whatever fails is only said.
 */
export function keepRoom(cacheDir: string, current: string[], everyMs = 5 * 60_000): NodeJS.Timeout {
  const tidy = async (first: boolean): Promise<void> => {
    try {
      if (first) {
        const removed = await removeOldVersions(cacheDir, current);
        if (removed.length) console.log(`cache: removed what older versions built (${removed.join(", ")})`);
      }
      const gone = await makeRoom(cacheDir);
      if (gone) console.log(`cache: the disk was nearly full, so the ${gone} oldest pieces were removed; they are made again when needed`);
      const now = await freeBytes(cacheDir);
      if (first && now !== null) console.log(`cache: ${Math.round(now / 1024 / 1024)} MB free`);
    } catch (err) {
      console.error(`cache: could not tidy (${err instanceof Error ? err.message : String(err)})`);
    }
  };
  void tidy(true);
  const timer = setInterval(() => void tidy(false), everyMs);
  timer.unref();
  return timer;
}
