// Outbound HTTP with a timeout and an identifying User-Agent (required by the
// OpenStreetMap services' usage policies).

const contact = process.env.EARTHWALK_CONTACT ?? "";
export const USER_AGENT = `earthwalk-server/0.1${contact ? ` (${contact})` : ""}`;

export async function httpGet(url: string, timeoutMs = 30000, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { "User-Agent": USER_AGENT, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
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
