// Map data that comes a block at a time from somebody else's server, and may come late.
//
// The world must never wait long for it: a block's worth is kept in the cache once it has come; asked for
// when it is not there, it is waited for a few seconds only. If it has not come by then the block is "owed"
// it: what is built there is built without, the question carries on (or is put again later), and when the
// answer does come whoever asked to be told forgets what was built there, so that it is built again with
// it. This is the way the 3D pieces of buildings have always come (fetchExtras in osm.ts); here it is for
// any source (overture.ts, cover.ts).

import { cacheRead, cacheWrite } from "./cache.ts";

export interface LateOptions<T> {
  /** What it is called in the log. */
  name: string;
  /** Where a block's worth is kept in the cache. */
  rel: (bx: number, by: number) => string;
  /** Where the list of blocks owed it is kept. */
  owedRel: string;
  /** Fetches a block's worth. `quiet` when nobody is waiting (a block owed it, asked for again). */
  fetch: (bx: number, by: number, quiet: boolean) => Promise<T>;
  encode: (value: T) => Buffer | string;
  decode: (kept: Buffer) => T;
  /** How long a build waits for it, and how long a block that failed is left alone. */
  waitMs?: number;
  restMs?: number;
  /** Reading and writing, for tests; the cache otherwise. */
  read?: (rel: string) => Promise<Buffer | null>;
  write?: (rel: string, data: Buffer | string) => Promise<void>;
  say?: (line: string) => void;
}

export class Late<T> {
  private readonly o: LateOptions<T>;
  private readonly loads = new Map<string, Promise<T | null>>();
  /** Blocks that failed, and when they may be asked for again. */
  private readonly rest = new Map<string, number>();
  private readonly owed = new Set<string>();
  private owedRead: Promise<void> | null = null;
  /** One write at a time: two at once fall over each other's temporary file. */
  private owedWritten: Promise<void> = Promise.resolve();
  private readonly listeners: ((bx: number, by: number) => void)[] = [];
  private readonly read: (rel: string) => Promise<Buffer | null>;
  private readonly write: (rel: string, data: Buffer | string) => Promise<void>;

  constructor(options: LateOptions<T>) {
    this.o = options;
    this.read = options.read ?? cacheRead;
    this.write = options.write ?? cacheWrite;
  }

  private readOwed(): Promise<void> {
    return (this.owedRead ??= this.read(this.o.owedRel).then((buf) => {
      if (buf) for (const key of JSON.parse(buf.toString("utf8")) as string[]) this.owed.add(key);
    }).catch(() => undefined));
  }

  private writeOwed(): void {
    this.owedWritten = this.owedWritten.then(() => this.write(this.o.owedRel, JSON.stringify([...this.owed].slice(-4000)))).catch(() => undefined);
  }

  /** Asks to be told when a block's worth comes after something was built there without it. */
  onArrive(listener: (bx: number, by: number) => void): void {
    this.listeners.push(listener);
  }

  /** How many blocks are owed their data now (as far as this run of the server knows). */
  get owedCount(): number {
    return this.owed.size;
  }

  /** True while a block is owed its data. */
  owes(bx: number, by: number): boolean {
    return this.owed.has(`${bx}/${by}`);
  }

  private start(bx: number, by: number, quiet: boolean): Promise<T | null> {
    const key = `${bx}/${by}`;
    const load = this.o.fetch(bx, by, quiet).then(async (value) => {
      await this.write(this.o.rel(bx, by), this.o.encode(value));
      if (this.owed.delete(key)) {
        this.writeOwed();
        for (const tell of this.listeners) tell(bx, by);
      }
      return value;
    }, (err) => {
      if (this.rest.size > 2000) this.rest.clear();
      this.rest.set(key, Date.now() + (this.o.restMs ?? 10 * 60_000));
      this.o.say?.(`map: no ${this.o.name} for block ${key} this time (${err instanceof Error ? err.message : String(err)})`);
      return null;
    }).finally(() => { this.loads.delete(key); });
    this.loads.set(key, load);
    return load;
  }

  /**
   * A block's worth: from the cache, or fetched. Null when it is not in the cache and does not come within
   * `waitMs` (the block is then owed it).
   */
  async get(bx: number, by: number, waitMs = this.o.waitMs ?? 6000): Promise<T | null> {
    const key = `${bx}/${by}`;
    const kept = await this.read(this.o.rel(bx, by));
    if (kept) {
      try {
        return this.o.decode(kept);
      } catch { /* a file cut short: fetched again */ }
    }
    await this.readOwed();
    const owe = (): null => {
      if (!this.owed.has(key)) { this.owed.add(key); this.writeOwed(); }
      return null;
    };
    let load = this.loads.get(key);
    if (!load) {
      if (Date.now() < (this.rest.get(key) ?? 0)) return owe();
      load = this.start(bx, by, false);
    }
    // A block already owed it is not waited for again: what is built there now is built without.
    if (this.owed.has(key)) return null;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs); });
    try {
      return (await Promise.race([load, late])) ?? owe();
    } finally {
      clearTimeout(timer);
    }
  }

  /** Every so often, asks again for one block that is owed. Returns the timer, so that it can be stopped. */
  keepComing(everyMs = 3 * 60_000): NodeJS.Timeout {
    const timer = setInterval(() => {
      void this.readOwed().then(() => {
        for (const key of this.owed) {
          if (this.loads.has(key) || Date.now() < (this.rest.get(key) ?? 0)) continue;
          const [bx, by] = key.split("/").map(Number);
          void this.start(bx, by, true);
          return;
        }
      });
    }, everyMs);
    timer.unref();
    return timer;
  }
}
