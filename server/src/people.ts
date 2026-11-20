// Who is allowed in, what they are called, and where they live.
//
// Two directories implement the same seam. `GuestDirectory` is the original: every visitor
// is a guest identified by the name they type, optionally gated by one shared access code.
// `AccountDirectory` adds people who signed in with Google: each has a record on disk (a
// JSON file under the cache directory), a chosen animal, a home location, and long-lived
// player tokens that clients present instead of the access code. Guests still work as a
// fallback, so a server without Google configured behaves exactly as before.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface Hello { name: string; room: string; token?: string; avatar?: string }
export interface Home { lat: number; lon: number; name: string }
export interface Person {
  personId: string | null;
  displayName: string;
  /** The account's animal, when the person is signed in; guests keep what they asked for. */
  avatar?: string;
  home?: Home | null;
}

export interface PeopleDirectory {
  /** Returns the person for a join request, or null to refuse entry. */
  identify(hello: Hello): Promise<Person | null>;
  /** Saves a signed-in person's home. Absent when the directory has no accounts. */
  setHome?(personId: string, home: Home): Promise<void>;
}

/** Guests only, optionally gated by one shared access code. */
export class GuestDirectory implements PeopleDirectory {
  private readonly accessCode: string;
  constructor(accessCode = "") {
    this.accessCode = accessCode;
  }
  async identify(hello: Hello): Promise<Person | null> {
    if (this.accessCode && hello.token !== this.accessCode) return null;
    return { personId: null, displayName: hello.name || "Guest" };
  }
}

/** What Google tells us about a signed-in account (from a verified id token). */
export interface GoogleIdentity { sub: string; email: string; name: string }

export interface PersonRecord {
  id: string;
  googleSub: string;
  email: string;
  name: string;
  avatar: string;
  home: Home | null;
  created: number;
  lastSeen: number;
  /** Where they were when last seen, for the people list while they are offline. */
  lastRoom: string | null;
  lastPlace: string | null;
  lastLat: number | null;
  lastLon: number | null;
}
interface TokenRecord { personId: string; created: number; lastUsed: number }
interface StoreFile { version: 1; people: PersonRecord[]; tokens: Record<string, TokenRecord> }

export interface AccountOptions {
  /** The shared access code; it also lets a new Google account sign up (see `signIn`). */
  accessCode?: string;
  /** Emails that may sign up without the access code. */
  invited?: Iterable<string>;
}

const TOKEN_BYTES = 32;
const MAX_NAME = 24;
const DEFAULT_AVATAR = "fox";
const avatarId = (s: unknown): string | null => (typeof s === "string" && /^[a-z][a-z0-9-]{0,15}$/.test(s) ? s : null);
const cleanText = (s: unknown, max: number): string => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");
const cleanName = (s: unknown): string => cleanText(s, MAX_NAME);
const hashToken = (raw: string): string => createHash("sha256").update(raw).digest("hex");
const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * People with accounts, kept in one JSON file (memory only when no file is given, for tests).
 * Writes are coalesced and atomic (write to a temporary file, then rename).
 */
export class AccountDirectory implements PeopleDirectory {
  private readonly file: string | null;
  private readonly accessCode: string;
  private readonly invited = new Set<string>();
  private readonly people = new Map<string, PersonRecord>();
  private readonly tokens = new Map<string, TokenRecord>();
  private saving: Promise<void> | null = null;
  private dirty = false;

  constructor(file?: string, options: AccountOptions = {}) {
    this.file = file ?? null;
    this.accessCode = options.accessCode ?? "";
    for (const e of options.invited ?? []) if (e.trim()) this.invited.add(e.trim().toLowerCase());
  }

  /** Creates a directory and loads its file, if there is one. */
  static async open(file?: string, options: AccountOptions = {}): Promise<AccountDirectory> {
    const dir = new AccountDirectory(file, options);
    await dir.load();
    return dir;
  }

  async load(): Promise<void> {
    if (!this.file) return;
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return; // first run
    }
    const data = JSON.parse(text) as StoreFile;
    for (const p of data.people ?? []) this.people.set(p.id, { ...p, lastRoom: p.lastRoom ?? null, lastPlace: p.lastPlace ?? null, lastLat: p.lastLat ?? null, lastLon: p.lastLon ?? null });
    for (const [hash, t] of Object.entries(data.tokens ?? {})) this.tokens.set(hash, t);
  }

  /** Writes the file (once, even if asked many times while a write is in progress). */
  save(): Promise<void> {
    this.dirty = true;
    if (!this.file) { this.dirty = false; return Promise.resolve(); }
    if (this.saving) return this.saving;
    const file = this.file;
    this.saving = (async () => {
      while (this.dirty) {
        this.dirty = false;
        const data: StoreFile = { version: 1, people: [...this.people.values()], tokens: Object.fromEntries(this.tokens) };
        await mkdir(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(data, null, 1));
        await rename(tmp, file);
      }
    })().finally(() => { this.saving = null; });
    return this.saving;
  }

  // ------------------------------------------------------------------ joining

  async identify(hello: Hello): Promise<Person | null> {
    if (hello.token) {
      const person = this.byToken(hello.token);
      if (person) {
        // The name and animal a signed-in client asks for become the account's.
        const name = cleanName(hello.name);
        const avatar = avatarId(hello.avatar);
        if (name) person.name = name;
        if (avatar) person.avatar = avatar;
        person.lastSeen = Date.now();
        void this.save();
        return { personId: person.id, displayName: person.name, avatar: person.avatar, home: person.home };
      }
    }
    if (this.accessCode && !(hello.token && same(hello.token, this.accessCode))) return null;
    return { personId: null, displayName: hello.name || "Guest" };
  }

  // ------------------------------------------------------------------ accounts

  /**
   * Signs a Google account in, creating its record the first time. A new account is accepted
   * when its email was invited, when the sign-in carried the access code (`gate`), or when
   * the server has no access code at all. Returns null when it is not allowed in.
   */
  signIn(identity: GoogleIdentity, gate: { accessCode?: string } = {}): { person: PersonRecord; token: string } | null {
    const email = identity.email.trim().toLowerCase();
    let person = [...this.people.values()].find((p) => p.googleSub === identity.sub) ?? (email ? [...this.people.values()].find((p) => p.email === email) : undefined);
    if (!person) {
      const hasCode = !!gate.accessCode && same(gate.accessCode, this.accessCode);
      if (this.accessCode && !hasCode && !this.invited.has(email)) return null;
      const now = Date.now();
      person = {
        id: randomBytes(6).toString("hex"), googleSub: identity.sub, email, name: cleanName(identity.name) || "Someone", avatar: DEFAULT_AVATAR,
        home: null, created: now, lastSeen: now, lastRoom: null, lastPlace: null, lastLat: null, lastLon: null,
      };
      this.people.set(person.id, person);
    } else {
      person.googleSub = identity.sub; // an invited email claims its record on first sign-in
      if (email) person.email = email;
      if (!person.name) person.name = cleanName(identity.name) || "Someone";
    }
    const token = this.issueToken(person.id);
    void this.save();
    return { person, token };
  }

  /** A new long-lived token for a person. Only its hash is kept. */
  issueToken(personId: string): string {
    const raw = randomBytes(TOKEN_BYTES).toString("base64url");
    const now = Date.now();
    this.tokens.set(hashToken(raw), { personId, created: now, lastUsed: now });
    void this.save();
    return raw;
  }

  revokeToken(raw: string): boolean {
    const had = this.tokens.delete(hashToken(raw));
    if (had) void this.save();
    return had;
  }

  /** The person a token belongs to, or null. */
  byToken(raw: string | undefined | null): PersonRecord | null {
    if (!raw) return null;
    const t = this.tokens.get(hashToken(raw));
    if (!t) return null;
    const person = this.people.get(t.personId);
    if (!person) { this.tokens.delete(hashToken(raw)); return null; }
    t.lastUsed = Date.now();
    return person;
  }

  get(id: string): PersonRecord | null {
    return this.people.get(id) ?? null;
  }

  list(): PersonRecord[] {
    return [...this.people.values()];
  }

  async setHome(personId: string, home: Home): Promise<void> {
    const p = this.people.get(personId);
    if (!p) throw new Error("unknown person");
    p.home = { lat: home.lat, lon: home.lon, name: cleanText(home.name, 80) || `${home.lat.toFixed(5)}, ${home.lon.toFixed(5)}` };
    await this.save();
  }

  /** Records where a person was last, so the people list can say so while they are offline. */
  touch(personId: string, where: { room?: string | null; place?: string | null; lat?: number | null; lon?: number | null }): void {
    const p = this.people.get(personId);
    if (!p) return;
    p.lastSeen = Date.now();
    if (where.room !== undefined) p.lastRoom = where.room;
    if (where.place !== undefined) p.lastPlace = where.place;
    if (where.lat !== undefined) p.lastLat = where.lat;
    if (where.lon !== undefined) p.lastLon = where.lon;
    void this.save();
  }
}
