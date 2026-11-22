// Outbound HTTP with a timeout and an identifying User-Agent (required by the
// OpenStreetMap services' usage policies).

const contact = process.env.EARTHWALK_CONTACT ?? "";
export const USER_AGENT = `earthwalk-server/0.1${contact ? ` (${contact})` : ""}`;

export async function httpGet(url: string, timeoutMs = 30000, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { "User-Agent": USER_AGENT, ...(init.headers ?? {}) },
    // A caller's own signal (to call the request off) is kept, beside the time limit.
    signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
}

/**
 * Runs async jobs a few at a time, with a minimum gap between starts, to stay polite to shared public APIs.
 *
 * The job asked for last runs next: someone who travels to three far places in a minute leaves map
 * downloads queued for the first two, and the place they are actually standing in must not wait behind
 * them. A `quiet` job is one nobody is waiting for (the map ahead of a traveller): it runs only when
 * nothing else is waiting, never takes the last free place, and is dropped when too many are queued.
 * `hurry` turns a quiet job into an ordinary one, for when somebody arrives who does want it.
 */
/** Lets only so many jobs run at once; the rest wait their turn, first come first served. */
export class Gate {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly size: number;
  constructor(size: number) {
    this.size = size;
  }
  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.running >= this.size) await new Promise<void>((go) => this.waiting.push(go));
    else this.running++;
    try {
      return await job();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); // the turn passes straight on
      else this.running--;
    }
  }
}

export class Pool {
  private readonly loud: { start: () => void; drop: () => void }[] = [];
  private readonly quiet: { start: () => void; drop: () => void }[] = [];
  private running = 0;
  private last = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly size: number;
  private readonly gapMs: number;
  private readonly quietMax: number;
  constructor(size: number, gapMs: number, quietMax = 6) {
    this.size = size;
    this.gapMs = gapMs;
    this.quietMax = quietMax;
  }
  add<T>(job: () => Promise<T>, quiet = false): { promise: Promise<T>; hurry: () => void } {
    let entry!: { start: () => void; drop: () => void };
    const promise = new Promise<T>((resolve, reject) => {
      entry = {
        start: () => {
          job().then(resolve, reject).finally(() => {
            this.running--;
            this.next();
          });
        },
        drop: () => reject(new Error("dropped: too much else was waiting")),
      };
    });
    if (quiet) {
      this.quiet.push(entry);
      while (this.quiet.length > this.quietMax) this.quiet.shift()!.drop();
    } else this.loud.push(entry);
    this.next();
    return {
      promise,
      hurry: () => {
        const at = this.quiet.indexOf(entry);
        if (at < 0) return;
        this.quiet.splice(at, 1);
        this.loud.push(entry);
        this.next();
      },
    };
  }
  private next(): void {
    if (this.timer) return;
    for (;;) {
      const quietOnly = this.loud.length === 0;
      if (quietOnly ? this.quiet.length === 0 || this.running >= Math.max(1, this.size - 1) : this.running >= this.size) return;
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.next();
        }, wait);
        this.timer.unref();
        return;
      }
      const entry = (quietOnly ? this.quiet : this.loud).pop()!;
      this.running++;
      this.last = Date.now();
      entry.start();
    }
  }
}

/**
 * Runs async jobs one at a time with a minimum gap, to stay polite to shared public APIs.
 *
 * With `newestFirst`, the job asked for last runs next. That is for work a player may have walked
 * away from: someone who travels to three far places in a minute leaves map downloads queued for the
 * first two, each of which can take most of a minute, and the place they are actually standing in
 * must not wait behind them (the game gives up on a chunk after 90 seconds).
 */
export class Throttle {
  private readonly waiting: (() => void)[] = [];
  private busy = false;
  private last = 0;
  private readonly gapMs: number;
  private readonly newestFirst: boolean;
  constructor(gapMs: number, newestFirst = false) {
    this.gapMs = gapMs;
    this.newestFirst = newestFirst;
  }
  run<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push(() => {
        job().then(resolve, reject).finally(() => {
          this.last = Date.now();
          this.busy = false;
          this.next();
        });
      });
      this.next();
    });
  }
  private next(): void {
    if (this.busy) return;
    const start = this.newestFirst ? this.waiting.pop() : this.waiting.shift();
    if (!start) return;
    this.busy = true;
    const wait = this.last + this.gapMs - Date.now();
    if (wait > 0) setTimeout(start, wait);
    else start();
  }
}
