import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const CACHE_DIR = path.resolve(process.env.EARTHWALK_CACHE ?? "cache");

export async function cacheRead(rel: string): Promise<Buffer | null> {
  try {
    return await readFile(path.join(CACHE_DIR, rel));
  } catch {
    return null;
  }
}

export async function cacheWrite(rel: string, data: Buffer | string): Promise<void> {
  const file = path.join(CACHE_DIR, rel);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/** De-duplicates concurrent loads of the same key. */
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
