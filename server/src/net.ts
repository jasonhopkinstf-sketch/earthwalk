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

/** Runs async jobs one at a time with a minimum gap, to stay polite to shared public APIs. */
export class Throttle {
  private tail: Promise<unknown> = Promise.resolve();
  private last = 0;
  private readonly gapMs: number;
  constructor(gapMs: number) {
    this.gapMs = gapMs;
  }
  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await job();
      } finally {
        this.last = Date.now();
      }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
}
