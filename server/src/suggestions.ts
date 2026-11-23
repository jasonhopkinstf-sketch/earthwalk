// The suggestions box: anybody playing can say what they would like in the game. Each suggestion is kept
// (in one file beside the accounts, which is never cleared away), shown on the admin screen where whoever
// runs the server sorts them (new, planned, done, not now), and sent to them as an email when the server
// has been told how (mail.ts). The email carries everything about it twice: in words, and as a small block
// of JSON at the end for a program to read.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Mailer } from "./mail.ts";

export type SuggestionStatus = "new" | "planned" | "done" | "declined";
export const STATUSES: SuggestionStatus[] = ["new", "planned", "done", "declined"];

export interface Suggestion {
  id: number;
  /** When it was made (milliseconds since the epoch). */
  at: number;
  text: string;
  /** Who made it, as they are called in the game; their account and its email when they are signed in. */
  name: string;
  personId: string | null;
  email: string | null;
  /** Which game it came from ("browser", "windows"), that game's version, and the server's. */
  client: string;
  version: string;
  /** Where they stood, when the game said. */
  lat: number | null;
  lon: number | null;
  status: SuggestionStatus;
  /** A note of the admin's own. */
  note: string;
  /** Whether the email about it went: "off" when the server sends none. */
  emailed: "sent" | "failed" | "off" | "waiting";
  mailError?: string;
}

export interface SuggestionInput { text?: unknown; name?: unknown; client?: unknown; lat?: unknown; lon?: unknown }
export interface Sender { personId: string | null; name: string; email: string | null; /** What the limit is counted against: the account, or the address a guest calls from. */ key: string }

export interface BoxOptions {
  /** Sends the email about a new suggestion; none is sent without one. */
  mailer?: Mailer | null;
  /** How many one sender may make in a day, and how many everybody together. */
  perDay?: number;
  allPerDay?: number;
  /** The server's version, and its address on the web (for the links in the email). */
  version?: string;
  site?: string;
  now?: () => number;
}

interface StoreFile { version: 1; next: number; suggestions: Suggestion[] }

export const MAX_SUGGESTION = 1000;
const KEEP = 2000;
const clean = (s: unknown, max: number): string => (typeof s === "string" ? s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max) : "");
const degrees = (v: unknown, most: number): number | null => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= most ? Math.round(v * 1e5) / 1e5 : null);

/** The email about a suggestion: its subject and its text. */
export function letterFor(s: Suggestion, site = ""): { subject: string; text: string } {
  const first = s.text.split("\n")[0];
  const when = new Date(s.at).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const where = s.lat !== null && s.lon !== null ? `${s.lat}, ${s.lon}${site ? `  ${site}/?lat=${s.lat}&lon=${s.lon}` : ""}` : "not said";
  const lines = [
    `A suggestion for EarthWalk (number ${s.id})`,
    "",
    s.text,
    "",
    `From: ${s.name}${s.email ? ` <${s.email}>` : s.personId ? "" : " (a guest, not signed in)"}`,
    `When: ${when}`,
    `Where they stood: ${where}`,
    `Game: ${s.client}, server version ${s.version}`,
    ...(site ? [`Sort it on the admin screen: ${site}/admin.html#suggestions`] : []),
    "",
    "--- the same, for a program to read ---",
    JSON.stringify({ earthwalkSuggestion: { id: s.id, at: new Date(s.at).toISOString(), text: s.text, from: { name: s.name, email: s.email, signedIn: s.personId !== null }, where: s.lat !== null && s.lon !== null ? { lat: s.lat, lon: s.lon } : null, client: s.client, version: s.version } }, null, 1),
  ];
  return { subject: `EarthWalk suggestion ${s.id}: ${first.length > 70 ? `${first.slice(0, 67)}...` : first}`, text: lines.join("\n") };
}

export class SuggestionBox {
  private readonly file: string | null;
  private readonly o: BoxOptions;
  private readonly list_: Suggestion[] = [];
  private next = 1;
  private saving: Promise<void> | null = null;
  private dirty = false;
  /** How many each sender has made on which day, and how many all of them. */
  private readonly made = new Map<string, { day: string; n: number }>();

  constructor(file?: string, options: BoxOptions = {}) {
    this.file = file ?? null;
    this.o = options;
  }

  static async open(file?: string, options: BoxOptions = {}): Promise<SuggestionBox> {
    const box = new SuggestionBox(file, options);
    if (file) {
      try {
        const data = JSON.parse(await readFile(file, "utf8")) as StoreFile;
        for (const s of data.suggestions ?? []) box.list_.push(s);
        box.next = Math.max(data.next ?? 1, ...box.list_.map((s) => s.id + 1), 1);
      } catch { /* first run */ }
    }
    return box;
  }

  /** Whether an email is sent about each new suggestion. */
  get mails(): boolean {
    return !!this.o.mailer;
  }

  private save(): void {
    this.dirty = true;
    if (!this.file || this.saving) { if (!this.file) this.dirty = false; return; }
    const file = this.file;
    this.saving = (async () => {
      while (this.dirty) {
        this.dirty = false;
        const data: StoreFile = { version: 1, next: this.next, suggestions: this.list_ };
        await mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(data, null, 1));
        await rename(tmp, file);
      }
    })().catch((err: unknown) => {
      console.error(`suggestions: could not save ${file} (${err instanceof Error ? err.message : String(err)})`);
    }).finally(() => { this.saving = null; });
  }

  /** Waits for what has been changed to be on disk (for tests, and before the server stops). */
  async settled(): Promise<void> {
    while (this.saving) await this.saving;
  }

  private count(key: string, day: string): { day: string; n: number } {
    let c = this.made.get(key);
    if (!c || c.day !== day) {
      if (this.made.size > 5000) this.made.clear();
      this.made.set(key, c = { day, n: 0 });
    }
    return c;
  }

  /**
   * Takes a suggestion in. Refuses one with nothing in it, and more than a few a day from one sender (or a
   * great many from everybody: the email it sends is somebody's inbox). The email is sent without being
   * waited for; `sent` settles when it has gone or failed.
   */
  add(input: SuggestionInput, sender: Sender): { ok: true; suggestion: Suggestion; sent: Promise<void> } | { ok: false; status: number; error: string } {
    const text = clean(input.text, MAX_SUGGESTION);
    if (text.length < 3) return { ok: false, status: 400, error: "Say what you would like, in a few words or more." };
    const now = (this.o.now ?? Date.now)();
    const day = new Date(now).toISOString().slice(0, 10);
    const mine = this.count(sender.key, day), all = this.count("*", day);
    if (mine.n >= (this.o.perDay ?? 5)) return { ok: false, status: 429, error: "That is all the suggestions one person can make in a day. Thank you: tomorrow there is room for more." };
    if (all.n >= (this.o.allPerDay ?? 100)) return { ok: false, status: 429, error: "The suggestions box is full for today. Try again tomorrow." };
    mine.n++;
    all.n++;
    const s: Suggestion = {
      id: this.next++, at: now, text, name: clean(sender.name, 24) || "Somebody", personId: sender.personId, email: sender.email,
      client: clean(input.client, 20).replace(/[^\w .-]/g, "") || "browser", version: this.o.version ?? "",
      lat: degrees(input.lat, 90), lon: degrees(input.lon, 180), status: "new", note: "", emailed: this.o.mailer ? "waiting" : "off",
    };
    if (s.lat === null || s.lon === null) { s.lat = null; s.lon = null; }
    this.list_.push(s);
    // The oldest that are finished with go first when there are very many.
    while (this.list_.length > KEEP) {
      const at = this.list_.findIndex((o) => o.status === "done" || o.status === "declined");
      this.list_.splice(at < 0 ? 0 : at, 1);
    }
    this.save();
    return { ok: true, suggestion: s, sent: this.mail(s) };
  }

  private async mail(s: Suggestion): Promise<void> {
    if (!this.o.mailer) { s.emailed = "off"; return; }
    const { subject, text } = letterFor(s, this.o.site);
    try {
      await this.o.mailer(subject, text);
      s.emailed = "sent";
      delete s.mailError;
    } catch (err) {
      s.emailed = "failed";
      s.mailError = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      console.error(`suggestions: the email about number ${s.id} did not go (${s.mailError})`);
    }
    this.save();
  }

  /** Newest first. */
  list(): Suggestion[] {
    return [...this.list_].reverse();
  }

  get(id: number): Suggestion | null {
    return this.list_.find((s) => s.id === id) ?? null;
  }

  /** Sorts one, or notes something against it. Null when there is no such suggestion. */
  update(id: number, change: { status?: unknown; note?: unknown }): Suggestion | null {
    const s = this.get(id);
    if (!s) return null;
    if (typeof change.status === "string" && (STATUSES as string[]).includes(change.status)) s.status = change.status as SuggestionStatus;
    if (typeof change.note === "string") s.note = clean(change.note, 500);
    this.save();
    return s;
  }

  remove(id: number): boolean {
    const at = this.list_.findIndex((s) => s.id === id);
    if (at < 0) return false;
    this.list_.splice(at, 1);
    this.save();
    return true;
  }

  /** Sends the email about one again (it failed, or the server was not sending any when it came). */
  async send(id: number): Promise<Suggestion | null> {
    const s = this.get(id);
    if (!s) return null;
    await this.mail(s);
    return s;
  }
}
