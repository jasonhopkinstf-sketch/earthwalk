// The admin screen's half of the server: what whoever runs it can see and do from /admin.html.
//
// - how loaded the server is, now and over the last day (memory against the machine's limit, people
//   online, how much is being built), and what it has lately written in its log;
// - the game and its people: who has an account, who is online, the guest list (invite, take off the
//   list, sign somebody out, shut somebody out);
// - the suggestions box (suggestions.ts).
//
// Only an admin sees any of it: somebody signed in with Google whose email is in EARTHWALK_ADMINS. (On a
// developer's own machine, where there is no Google sign-in, the word "local" in that setting lets in
// whoever asks from the machine itself, and nobody else; it does nothing behind a host's proxy.)
// What changes anything is a POST of JSON from the admin page itself: the sign-in cookie is not sent with a
// POST from another site, and a request that says it comes from another site is refused as well.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AccountDirectory, PersonRecord } from "./people.ts";
import type { Presence } from "./presence.ts";
import type { Rooms } from "./rooms.ts";
import { STATUSES, type SuggestionBox } from "./suggestions.ts";

/** One reading of the load: the memory held (megabytes) and the most in that minute, people online, pieces being built and waiting. */
export interface LoadSample { t: number; mem: number; memPeak: number; people: number; building: number; waiting: number }

/** The load over the last day, a reading a minute, kept in memory (a restart starts it afresh). */
export class LoadHistory {
  private readonly samples: LoadSample[] = [];
  private readonly keep: number;
  private peak = 0;
  private timer: NodeJS.Timeout | null = null;
  constructor(keep = 1440) {
    this.keep = keep;
  }
  /** Told the memory held each time it is measured, so that a minute's reading has that minute's most. */
  note(mem: number): void {
    if (mem > this.peak) this.peak = mem;
  }
  add(sample: Omit<LoadSample, "memPeak">): void {
    this.samples.push({ ...sample, memPeak: Math.max(this.peak, sample.mem) });
    this.peak = 0;
    while (this.samples.length > this.keep) this.samples.shift();
  }
  start(read: () => Omit<LoadSample, "memPeak">, everyMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.add(read()), everyMs);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  list(): LoadSample[] {
    return this.samples;
  }
}

/** The last few hundred lines the server wrote in its log, for reading on the admin screen. */
export class RecentLog {
  private readonly lines: { t: number; level: string; text: string }[] = [];
  private readonly keep: number;
  constructor(keep = 300) {
    this.keep = keep;
  }
  add(level: string, text: string): void {
    this.lines.push({ t: Date.now(), level, text: text.slice(0, 500) });
    while (this.lines.length > this.keep) this.lines.shift();
  }
  /** Has everything written with console.log, .warn and .error kept here as well as written where it always was. */
  capture(target: Pick<Console, "log" | "warn" | "error"> = console): void {
    for (const level of ["log", "warn", "error"] as const) {
      const was = target[level].bind(target);
      target[level] = (...args: unknown[]): void => {
        was(...args);
        try {
          this.add(level, args.map((a) => (typeof a === "string" ? a : a instanceof Error ? `${a.name}: ${a.message}` : JSON.stringify(a))).join(" "));
        } catch { /* something that cannot be written down: it is in the real log all the same */ }
      };
    }
  }
  list(): { t: number; level: string; text: string }[] {
    return this.lines;
  }
}

/** How long the pieces of the world built in the last hour took. */
export class BuildTimes {
  private readonly took: [number, number][] = []; // when, milliseconds
  private total = 0;
  record(ms: number, now = Date.now()): void {
    this.total++;
    this.took.push([now, ms]);
    while (this.took.length > 5000) this.took.shift();
  }
  lastHour(now = Date.now()): { count: number; typicalMs: number; slowestMs: number; sinceStart: number } {
    const recent = this.took.filter(([t]) => now - t < 3600_000).map(([, ms]) => ms).sort((a, b) => a - b);
    return { count: recent.length, typicalMs: Math.round(recent[Math.floor(recent.length / 2)] ?? 0), slowestMs: Math.round(recent[recent.length - 1] ?? 0), sinceStart: this.total };
  }
}

export interface AdminContext {
  /** The emails of the admins (lower case), and "local" where that is allowed. */
  admins: string[];
  trustProxy: boolean;
  accounts: AccountDirectory;
  presence: Presence;
  rooms: Rooms;
  suggestions: SuggestionBox;
  load: LoadHistory;
  log: RecentLog;
  /** The account a request is signed in to, if any. */
  me(req: IncomingMessage): PersonRecord | null;
  /** Everything the top of the screen shows, measured now. */
  now(): Promise<Record<string, unknown>>;
  googleSignIn: boolean;
  accessCodeSet: boolean;
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};

const LOOPBACK = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;

/** Who is asking, when they are an admin: their account, or "local" for the machine itself where that is allowed. */
export function adminOf(ctx: Pick<AdminContext, "admins" | "trustProxy" | "me">, req: IncomingMessage): PersonRecord | "local" | null {
  const me = ctx.me(req);
  if (me && ctx.admins.includes(me.email.toLowerCase())) return me;
  if (ctx.admins.includes("local") && !ctx.trustProxy && LOOPBACK.test(req.socket.remoteAddress ?? "")) return "local";
  return null;
}

/** The JSON a POST carries, or null when it is not JSON, is too long, or says it comes from another site. */
export async function postedJson(req: IncomingMessage, most = 8192): Promise<Record<string, unknown> | null> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return null;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return null;
    } catch { return null; }
  }
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    size += (part as Buffer).length;
    if (size > most) return null;
    parts.push(part as Buffer);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch { return null; }
}

/** The admin routes (/v1/admin/...). Returns false for any other path. */
export async function serveAdmin(ctx: AdminContext, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;
  if (!p.startsWith("/v1/admin/")) return false;
  const admin = adminOf(ctx, req);
  const me = ctx.me(req);
  if (p === "/v1/admin/me") {
    // Anybody may ask whether they are an admin: the page needs to know what to show them.
    return send(res, 200, { admin: !!admin, signedIn: !!me, name: admin === "local" ? "this computer" : me?.name ?? null, googleSignIn: ctx.googleSignIn }), true;
  }
  if (!admin) return send(res, me ? 403 : 401, { error: me ? "This account is not an admin of this server." : "Sign in first." }), true;

  if (req.method === "GET") {
    if (p === "/v1/admin/now") return send(res, 200, await ctx.now()), true;
    if (p === "/v1/admin/history") return send(res, 200, { samples: ctx.load.list() }), true;
    if (p === "/v1/admin/log") return send(res, 200, { lines: ctx.log.list().slice(-200) }), true;
    if (p === "/v1/admin/people") {
      const seen = new Map(ctx.presence.snapshot().map((e) => [e.id, e]));
      const people = ctx.accounts.list().map((a) => {
        const now = seen.get(a.id);
        return {
          id: a.id, name: a.name, email: a.email, avatar: a.avatar, created: a.created, lastSeen: now?.lastSeen ?? a.lastSeen,
          online: now?.online ?? false, room: now?.room ?? a.lastRoom, place: now?.place ?? a.lastPlace, home: a.home?.name ?? null,
          blocked: !!a.blocked, admin: ctx.admins.includes(a.email.toLowerCase()),
        };
      }).sort((a, b) => Number(b.online) - Number(a.online) || b.lastSeen - a.lastSeen);
      const guests = ctx.rooms.listMembers().filter((m) => !m.personId).map((m) => ({ name: m.name, room: m.room }));
      return send(res, 200, { people, guests, invites: ctx.accounts.invites(), accessCodeSet: ctx.accessCodeSet, googleSignIn: ctx.googleSignIn }), true;
    }
    if (p === "/v1/admin/suggestions") return send(res, 200, { suggestions: ctx.suggestions.list(), mails: ctx.suggestions.mails, statuses: STATUSES }), true;
    return send(res, 404, { error: "not found" }), true;
  }

  if (req.method !== "POST") return send(res, 405, { error: "method not allowed" }), true;
  const body = await postedJson(req);
  if (!body) return send(res, 400, { error: "This needs JSON, sent from the admin page itself." }), true;
  const who = admin === "local" ? "somebody at this computer" : admin.email;
  if (p === "/v1/admin/invite") {
    const email = typeof body.email === "string" ? body.email : "";
    if (!ctx.accounts.invite(email)) return send(res, 400, { error: "That does not look like an email address." }), true;
    console.log(`admin: ${who} put ${email.trim().toLowerCase()} on the guest list`);
    return send(res, 200, { ok: true, invites: ctx.accounts.invites() }), true;
  }
  if (p === "/v1/admin/uninvite") {
    const email = typeof body.email === "string" ? body.email : "";
    if (!ctx.accounts.uninvite(email)) return send(res, 409, { error: "That email is not on the list, or is there by the server's own settings (EARTHWALK_INVITED) and can only be taken off there." }), true;
    console.log(`admin: ${who} took ${email.trim().toLowerCase()} off the guest list`);
    return send(res, 200, { ok: true, invites: ctx.accounts.invites() }), true;
  }
  if (p === "/v1/admin/person") {
    const person = typeof body.id === "string" ? ctx.accounts.get(body.id) : null;
    if (!person) return send(res, 404, { error: "There is no such person." }), true;
    if (body.action === "signout") {
      const n = ctx.accounts.signOutEverywhere(person.id);
      console.log(`admin: ${who} signed ${person.email} out everywhere (${n})`);
      return send(res, 200, { ok: true, signedOut: n }), true;
    }
    if (body.action === "block" || body.action === "unblock") {
      // Nobody shuts themselves out, or another admin: that is done in the server's settings.
      if (body.action === "block" && ctx.admins.includes(person.email.toLowerCase())) return send(res, 409, { error: "An admin cannot be shut out from here. Take them out of EARTHWALK_ADMINS first." }), true;
      ctx.accounts.block(person.id, body.action === "block");
      console.log(`admin: ${who} ${body.action === "block" ? "shut out" : "let back in"} ${person.email}`);
      return send(res, 200, { ok: true }), true;
    }
    return send(res, 400, { error: "Unknown action." }), true;
  }
  if (p === "/v1/admin/suggestion") {
    const id = Number(body.id);
    if (!Number.isSafeInteger(id)) return send(res, 400, { error: "Which suggestion?" }), true;
    if (body.remove === true) return send(res, ctx.suggestions.remove(id) ? 200 : 404, { ok: true }), true;
    const s = body.resend === true ? await ctx.suggestions.send(id) : ctx.suggestions.update(id, { status: body.status, note: body.note });
    return s ? (send(res, 200, { ok: true, suggestion: s }), true) : (send(res, 404, { error: "There is no such suggestion." }), true);
  }
  return send(res, 404, { error: "not found" }), true;
}
