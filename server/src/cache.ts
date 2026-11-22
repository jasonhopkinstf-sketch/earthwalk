import { access, mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const CACHE_DIR = path.resolve(process.env.EARTHWALK_CACHE ?? "cache");

export async function cacheRead(rel: string): Promise<Buffer | null> {
  try {
    return await readFile(path.join(CACHE_DIR, rel));
  } catch {
    return null;
  }
}

/** Is it in the cache? (Without reading it: some pieces are many megabytes.) */
export async function cacheHas(rel: string): Promise<boolean> {
  return access(path.join(CACHE_DIR, rel)).then(() => true, () => false);
}

let complained = 0;
/**
 * Keeps something in the cache. The cache is a convenience: when it cannot be written (a full disk), the
 * thing is still served, only not kept, and the half-written file is cleared away. It never throws.
 */
export async function cacheWrite(rel: string, data: Buffer | string): Promise<void> {
  const file = path.join(CACHE_DIR, rel);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    if (Date.now() - complained > 60_000) {
      complained = Date.now();
      console.error(`cache: could not keep ${rel} (${err instanceof Error ? err.message : String(err)}); carrying on without`);
    }
  }
}

/** De-duplicates concurrent loads of the same key. */
/** Removes a file or a whole folder from the cache. Like cacheWrite, it never fails: what cannot be removed is left. */
export async function cacheRemove(rel: string): Promise<void> {
  try {
    await rm(path.join(CACHE_DIR, rel), { recursive: true, force: true });
  } catch (err) {
    console.warn(`cache: could not remove ${rel} (${err instanceof Error ? err.message : String(err)}); carrying on`);
  }
}

export class InFlight<T> {
  private readonly map = new Map<string, Promise<T>>();
  get(key: string, load: () => Promise<T>): Promise<T> {
    let p = this.map.get(key);
    if (!p) {
      p = load().finally(() => this.map.delete(key));
      this.map.set(key, p);
    }
    return p;
  }
}
