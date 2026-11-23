// The admin screen's routes (admin.ts), the guest list and shutting people out (people.ts), the
// suggestions box (suggestions.ts) and the email about a suggestion (mail.ts). Nothing here reaches the
// network: Google and the mail service are stood in for.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp, type AppOptions } from "../src/app.ts";
import { BuildTimes, LoadHistory, RecentLog } from "../src/admin.ts";
import { mailerFromSettings, resendMailer } from "../src/mail.ts";
import { AccountDirectory, type GoogleIdentity } from "../src/people.ts";
import { letterFor, MAX_SUGGESTION, SuggestionBox, type Sender } from "../src/suggestions.ts";

const identities: Record<string, GoogleIdentity> = {
  boss: { sub: "g-1", email: "Boss@Example.com", name: "Boss" },
  kid: { sub: "g-2", email: "kid@example.com", name: "Kid" },
  stranger: { sub: "g-3", email: "stranger@example.com", name: "Stranger" },
};

async function start(options: AppOptions = {}) {
  const app = createApp({
    accessCode: "otter-42",
    google: { clientId: "app-1", clientSecret: "shh" },
    signIn: async (code) => { if (!identities[code]) throw new Error("bad code"); return identities[code]; },
    invited: ["kid@example.com"],
    admins: ["boss@example.com"],
    placeName: async () => "Montmartre, Paris",
    buildChunk: async () => Buffer.from("chunk"),
    buildLabels: async () => Buffer.from("{}"),
    readCache: async () => null,
    writeCache: async () => undefined,
    ...options,
  });
  await new Promise<void>((r) => app.server.listen(0, r));
  return { app, base: `http://localhost:${(app.server.address() as AddressInfo).port}` };
}

/** Signs somebody in the way a browser does, and returns their cookie (null when they were not let in). */
async function signIn(base: string, who: string, withCode = true): Promise<string | null> {
  const go = await fetch(`${base}/auth/google${withCode ? "?code=otter-42" : ""}`, { redirect: "manual" });
  const state = new URL(go.headers.get("location")!).searchParams.get("state")!;
  const back = await fetch(`${base}/auth/google/callback?state=${encodeURIComponent(state)}&code=${who}`, { redirect: "manual" });
  return back.headers.get("set-cookie")?.split(";")[0] ?? null;
}
const as = (cookie: string | null): Record<string, string> => (cookie ? { Cookie: cookie } : {});
const post = (base: string, at: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}${at}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("only an admin sees the admin screen's data", async () => {
  const s = await start();
  try {
    const boss = await signIn(s.base, "boss"), kid = await signIn(s.base, "kid");
    // Anybody may ask whether they are one.
    assert.deepEqual(await (await fetch(`${s.base}/v1/admin/me`)).json(), { admin: false, signedIn: false, name: null, googleSignIn: true });
    assert.equal((await (await fetch(`${s.base}/v1/admin/me`, { headers: as(kid) })).json()).admin, false);
    assert.deepEqual(await (await fetch(`${s.base}/v1/admin/me`, { headers: as(boss) })).json(), { admin: true, signedIn: true, name: "Boss", googleSignIn: true });
    for (const at of ["now", "history", "log", "people", "suggestions"]) {
      assert.equal((await fetch(`${s.base}/v1/admin/${at}`)).status, 401, `${at}: nobody signed in`);
      assert.equal((await fetch(`${s.base}/v1/admin/${at}`, { headers: as(kid) })).status, 403, `${at}: signed in, not an admin`);
      // (The access code lets somebody play; it does not make them an admin.)
      assert.equal((await fetch(`${s.base}/v1/admin/${at}`, { headers: { Authorization: "Bearer otter-42" } })).status, 401, `${at}: the access code`);
      const res = await fetch(`${s.base}/v1/admin/${at}`, { headers: as(boss) });
      assert.equal(res.status, 200, at);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
    assert.equal((await post(s.base, "/v1/admin/invite", { email: "new@example.com" }, as(kid))).status, 403);
    assert.equal((await post(s.base, "/v1/admin/invite", { email: "new@example.com" })).status, 401);
    // The page itself is plain, and tells nothing.
    const page = await fetch(`${s.base}/admin.html`);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes("EarthWalk admin"));
  } finally { s.app.close(); }
});

test("the word local lets in this machine itself, and never from behind a proxy", async () => {
  const here = await start({ admins: ["local"], google: undefined });
  try {
    assert.deepEqual(await (await fetch(`${here.base}/v1/admin/me`)).json(), { admin: true, signedIn: false, name: "this computer", googleSignIn: false });
    assert.equal((await fetch(`${here.base}/v1/admin/now`)).status, 200);
  } finally { here.app.close(); }
  const hosted = await start({ admins: ["local"], trustProxy: true });
  try {
    assert.equal((await (await fetch(`${hosted.base}/v1/admin/me`)).json()).admin, false);
    assert.equal((await fetch(`${hosted.base}/v1/admin/now`)).status, 401);
  } finally { hosted.app.close(); }
});

test("the load now, and what the screen's top shows", async () => {
  const s = await start({ memoryLimitMb: 2048 });
  try {
    const boss = await signIn(s.base, "boss");
    await fetch(`${s.base}/v1/chunk/16/1/1`, { headers: as(boss) }); // one piece built
    const now = await (await fetch(`${s.base}/v1/admin/now`, { headers: as(boss) })).json();
    assert.equal(now.mem.limit, 2048);
    assert.ok(now.mem.now > 20 && now.mem.most >= now.mem.now);
    assert.deepEqual([now.people.accounts, now.people.today, now.people.people, now.people.guests], [1, 1, 0, 0]);
    assert.equal(now.building.sinceStart, 1);
    assert.equal(now.building.now, 0);
    assert.equal(now.ai.live, false);
    assert.deepEqual(now.suggestions, { waiting: 0, all: 0, mails: false });
    assert.equal(typeof now.version, "string");
    assert.ok(now.upSeconds >= 0);
    assert.deepEqual(await (await fetch(`${s.base}/v1/admin/history`, { headers: as(boss) })).json(), { samples: [] });
  } finally { s.app.close(); }
});

test("a day of load is kept a reading a minute, each with that minute's most memory", () => {
  const load = new LoadHistory(3);
  load.note(180); load.note(240); load.note(200);
  load.add({ t: 1, mem: 200, people: 2, building: 1, waiting: 4 });
  load.add({ t: 2, mem: 190, people: 0, building: 0, waiting: 0 });
  assert.deepEqual(load.list(), [{ t: 1, mem: 200, memPeak: 240, people: 2, building: 1, waiting: 4 }, { t: 2, mem: 190, memPeak: 190, people: 0, building: 0, waiting: 0 }]);
  load.add({ t: 3, mem: 1, people: 0, building: 0, waiting: 0 });
  load.add({ t: 4, mem: 1, people: 0, building: 0, waiting: 0 });
  assert.deepEqual(load.list().map((s) => s.t), [2, 3, 4], "only the newest are kept");
});

test("the log's last lines are kept, and still written where they always were", () => {
  const written: string[] = [];
  const target = { log: (...a: unknown[]) => { written.push(a.join(" ")); }, warn: (...a: unknown[]) => { written.push(a.join(" ")); }, error: (...a: unknown[]) => { written.push(a.join(" ")); } };
  const log = new RecentLog(2);
  log.capture(target);
  target.log("one");
  target.warn("two", { n: 2 });
  target.error("three", new Error("broke"));
  assert.equal(written.length, 3);
  assert.deepEqual(log.list().map((l) => [l.level, l.text]), [["warn", 'two {"n":2}'], ["error", "three Error: broke"]]);
});

test("how long building took in the last hour", () => {
  const b = new BuildTimes();
  const now = 10 * 3600_000;
  b.record(900, now - 2 * 3600_000); // too long ago
  for (const ms of [200, 400, 3000]) b.record(ms, now - 60_000);
  assert.deepEqual(b.lastHour(now), { count: 3, typicalMs: 400, slowestMs: 3000, sinceStart: 4 });
  assert.deepEqual(new BuildTimes().lastHour(now), { count: 0, typicalMs: 0, slowestMs: 0, sinceStart: 0 });
});

test("the guest list: invite, take off, and what the settings put there stays", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-admin-"));
  const file = path.join(dir, "people.json");
  try {
    const accounts = await AccountDirectory.open(file, { accessCode: "otter-42", invited: ["Gran@Example.com"] });
    assert.equal(accounts.invite("not an email"), false);
    assert.equal(accounts.invite("  Cousin@Example.com "), true);
    assert.deepEqual(accounts.invites(), [{ email: "cousin@example.com", fixed: false, joined: false }, { email: "gran@example.com", fixed: true, joined: false }]);
    // An invited email makes an account without the access code; a stranger does not.
    assert.ok(accounts.signIn({ sub: "g-9", email: "cousin@example.com", name: "Cousin" }));
    assert.equal(accounts.signIn({ sub: "g-8", email: "stranger@example.com", name: "Stranger" }), null);
    assert.equal(accounts.invites()[0].joined, true);
    assert.equal(accounts.uninvite("gran@example.com"), false, "the settings' own cannot be taken off here");
    assert.equal(accounts.uninvite("nobody@example.com"), false);
    await accounts.save();
    // It is kept: a server started again knows the list (and does not keep the settings' own twice).
    const again = await AccountDirectory.open(file, { accessCode: "otter-42" });
    assert.deepEqual(again.invites(), [{ email: "cousin@example.com", fixed: false, joined: true }]);
    assert.equal(again.uninvite("cousin@example.com"), true);
    assert.deepEqual(again.invites(), []);
    assert.equal(again.list().length, 1, "somebody who joined keeps their account");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an admin invites, signs somebody out, shuts them out and lets them back in", async () => {
  const s = await start();
  try {
    const boss = await signIn(s.base, "boss");
    let kid = await signIn(s.base, "kid", false);
    assert.ok(kid, "the kid is on the list the settings give");
    assert.equal(await signIn(s.base, "stranger", false), null, "the stranger is not");

    let res = await post(s.base, "/v1/admin/invite", { email: "stranger@example.com" }, as(boss));
    assert.equal(res.status, 200);
    assert.ok(await signIn(s.base, "stranger", false), "invited now");
    assert.equal((await post(s.base, "/v1/admin/invite", { email: "nonsense" }, as(boss))).status, 400);
    assert.equal((await post(s.base, "/v1/admin/uninvite", { email: "kid@example.com" }, as(boss))).status, 409, "that one is in the settings");
    assert.equal((await post(s.base, "/v1/admin/uninvite", { email: "stranger@example.com" }, as(boss))).status, 200);

    const people = await (await fetch(`${s.base}/v1/admin/people`, { headers: as(boss) })).json();
    assert.deepEqual(people.people.map((p: { email: string }) => p.email).sort(), ["boss@example.com", "kid@example.com", "stranger@example.com"]);
    assert.deepEqual(people.invites, [{ email: "kid@example.com", fixed: true, joined: true }]);
    assert.equal(people.accessCodeSet, true);
    const idOf = (email: string): string => people.people.find((p: { email: string }) => p.email === email).id;
    assert.equal(people.people.find((p: { email: string }) => p.email === "boss@example.com").admin, true);

    // Signed out everywhere: the cookie no longer works, and signing in again does.
    res = await post(s.base, "/v1/admin/person", { id: idOf("kid@example.com"), action: "signout" }, as(boss));
    assert.deepEqual(await res.json(), { ok: true, signedOut: 1 });
    assert.equal((await fetch(`${s.base}/v1/me`, { headers: as(kid) })).status, 401);
    kid = await signIn(s.base, "kid", false);
    assert.equal((await fetch(`${s.base}/v1/me`, { headers: as(kid) })).status, 200);

    // Shut out: signed out, and cannot sign in, until let back in.
    assert.equal((await post(s.base, "/v1/admin/person", { id: idOf("kid@example.com"), action: "block" }, as(boss))).status, 200);
    assert.equal((await fetch(`${s.base}/v1/me`, { headers: as(kid) })).status, 401);
    assert.equal(await signIn(s.base, "kid"), null, "not even with the access code");
    assert.equal((await (await fetch(`${s.base}/v1/admin/people`, { headers: as(boss) })).json()).people.find((p: { email: string }) => p.email === "kid@example.com").blocked, true);
    assert.equal((await post(s.base, "/v1/admin/person", { id: idOf("kid@example.com"), action: "unblock" }, as(boss))).status, 200);
    assert.ok(await signIn(s.base, "kid", false));

    // An admin is not shut out from the screen, and a made-up person is nobody.
    assert.equal((await post(s.base, "/v1/admin/person", { id: idOf("boss@example.com"), action: "block" }, as(boss))).status, 409);
    assert.equal((await post(s.base, "/v1/admin/person", { id: "nobody", action: "block" }, as(boss))).status, 404);
    assert.equal((await fetch(`${s.base}/v1/admin/now`, { headers: as(boss) })).status, 200);
  } finally { s.app.close(); }
});

test("what changes anything must be JSON from the admin page itself", async () => {
  const s = await start();
  try {
    const boss = await signIn(s.base, "boss");
    const form = await fetch(`${s.base}/v1/admin/invite`, { method: "POST", headers: { ...as(boss), "Content-Type": "application/x-www-form-urlencoded" }, body: "email=sneak@example.com" });
    assert.equal(form.status, 400, "a form another site could post is refused");
    const elsewhere = await post(s.base, "/v1/admin/invite", { email: "sneak@example.com" }, { ...as(boss), Origin: "https://elsewhere.example" });
    assert.equal(elsewhere.status, 400, "and so is one that says it comes from another site");
    const own = await post(s.base, "/v1/admin/invite", { email: "friend@example.com" }, { ...as(boss), Origin: s.base });
    assert.equal(own.status, 200);
    const list = (await (await fetch(`${s.base}/v1/admin/people`, { headers: as(boss) })).json()).invites.map((i: { email: string }) => i.email);
    assert.deepEqual(list, ["friend@example.com", "kid@example.com"]);
    assert.equal((await fetch(`${s.base}/v1/admin/invite`, { method: "DELETE", headers: as(boss) })).status, 405);
  } finally { s.app.close(); }
});

const guest: Sender = { personId: null, name: "Maple", email: null, key: "a:1.2.3.4" };

test("the suggestions box takes a suggestion, keeps it, and has limits", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-sugg-"));
  const file = path.join(dir, "suggestions.json");
  try {
    let now = Date.UTC(2026, 10, 24, 9, 0);
    const box = await SuggestionBox.open(file, { perDay: 2, allPerDay: 3, version: "0.2.48", now: () => now });
    assert.deepEqual(box.add({ text: " " }, guest), { ok: false, status: 400, error: "Say what you would like, in a few words or more." });
    const first = box.add({ text: "  Boats to row\u0007 across   the harbour  ", lat: -36.84101234, lon: 174.76831234, client: "browser" }, guest);
    assert.ok(first.ok);
    assert.deepEqual({ ...first.suggestion }, { id: 1, at: now, text: "Boats to row across the harbour", name: "Maple", personId: null, email: null, client: "browser", version: "0.2.48", lat: -36.84101, lon: 174.76831, status: "new", note: "", emailed: "off" });
    const long = box.add({ text: "x".repeat(5000), lat: 999 }, guest);
    assert.ok(long.ok && long.suggestion.text.length === MAX_SUGGESTION && long.suggestion.lat === null && long.suggestion.lon === null);
    assert.equal(box.add({ text: "a third from the same person" }, guest).ok, false, "two a day each, here");
    assert.equal(box.add({ text: "somebody else" }, { ...guest, key: "a:5.6.7.8", name: "Otter" }).ok, true);
    const full = box.add({ text: "and a fourth person" }, { ...guest, key: "a:9.9.9.9" });
    assert.ok(!full.ok && full.status === 429, "three a day from everybody, here");
    now += 86400_000;
    assert.equal(box.add({ text: "tomorrow there is room again" }, guest).ok, true);

    assert.deepEqual(box.list().map((s) => s.id), [4, 3, 2, 1], "newest first");
    assert.equal(box.update(1, { status: "planned", note: "  for the summer  " })?.status, "planned");
    assert.equal(box.get(1)?.note, "for the summer");
    assert.equal(box.update(1, { status: "nonsense" })?.status, "planned", "an unknown state changes nothing");
    assert.equal(box.update(99, { status: "done" }), null);
    assert.equal(box.remove(2), true);
    assert.equal(box.remove(2), false);
    await box.settled();
    const again = await SuggestionBox.open(file, { version: "0.2.48" });
    assert.deepEqual(again.list().map((s) => [s.id, s.status]), [[4, "new"], [3, "new"], [1, "planned"]]);
    const next = again.add({ text: "numbers carry on" }, guest);
    assert.ok(next.ok && next.suggestion.id === 5);
    await again.settled();
    assert.equal(JSON.parse(await readFile(file, "utf8")).next, 6);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an email goes out about a suggestion, says everything, and a failure is kept and can be sent again", async () => {
  const sent: { subject: string; text: string }[] = [];
  let down = true;
  const box = new SuggestionBox(undefined, { site: "https://earthwalk.example", version: "0.2.48", now: () => Date.UTC(2026, 10, 24, 9, 5), mailer: async (subject, text) => { if (down) throw new Error("the mail service answered 500"); sent.push({ subject, text }); } });
  assert.equal(box.mails, true);
  const made = box.add({ text: "A treehouse you can build in your own garden,\nwith a rope ladder.", lat: -36.841, lon: 174.7683, client: "browser" }, { personId: "p1", name: "Kid", email: "kid@example.com", key: "p:p1" });
  assert.ok(made.ok);
  assert.equal(made.suggestion.emailed, "waiting");
  await made.sent;
  assert.equal(box.get(1)?.emailed, "failed");
  assert.equal(box.get(1)?.mailError, "the mail service answered 500");
  down = false;
  assert.equal((await box.send(1))?.emailed, "sent");
  assert.equal(box.get(1)?.mailError, undefined);
  assert.equal(await box.send(42), null);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, "EarthWalk suggestion 1: A treehouse you can build in your own garden,");
  for (const part of ["with a rope ladder.", "From: Kid <kid@example.com>", "When: 2026-11-24 09:05 UTC", "Where they stood: -36.841, 174.7683  https://earthwalk.example/?lat=-36.841&lon=174.7683", "Game: browser, server version 0.2.48", "https://earthwalk.example/admin.html#suggestions"]) {
    assert.ok(sent[0].text.includes(part), part);
  }
  // The same once more as JSON, for a program to read.
  const data = JSON.parse(sent[0].text.slice(sent[0].text.indexOf("{")));
  assert.deepEqual(data.earthwalkSuggestion, { id: 1, at: "2026-11-24T09:05:00.000Z", text: "A treehouse you can build in your own garden,\nwith a rope ladder.", from: { name: "Kid", email: "kid@example.com", signedIn: true }, where: { lat: -36.841, lon: 174.7683 }, client: "browser", version: "0.2.48" });
  // A guest's says so, and one without a place says that.
  const letter = letterFor({ ...box.get(1)!, id: 7, personId: null, email: null, name: "Maple", lat: null, lon: null, text: "x".repeat(200) });
  assert.ok(letter.text.includes("From: Maple (a guest, not signed in)") && letter.text.includes("Where they stood: not said"));
  assert.ok(letter.subject.length < 100 && letter.subject.endsWith("..."));
});

test("players send suggestions to the server, and the admin sorts them", async () => {
  const mailed: string[] = [];
  const s = await start({ mailer: async (subject) => { mailed.push(subject); }, baseUrl: "https://earthwalk.example" });
  try {
    const boss = await signIn(s.base, "boss"), kid = await signIn(s.base, "kid", false);
    assert.equal((await post(s.base, "/v1/suggest", { text: "Let me in" })).status, 401, "only those who may play");
    assert.equal((await fetch(`${s.base}/v1/suggest`, { method: "POST", headers: { Authorization: "Bearer otter-42" }, body: "text=hello" })).status, 400);
    let res = await post(s.base, "/v1/suggest", { text: "More dogs please", name: "Maple", lat: 48.8583, lon: 2.2945, client: "windows" }, { Authorization: "Bearer otter-42" });
    assert.deepEqual(await res.json(), { ok: true, id: 1 });
    res = await post(s.base, "/v1/suggest", { text: "Boats on the harbour", name: "Somebody Else" }, as(kid));
    assert.deepEqual(await res.json(), { ok: true, id: 2 });
    assert.equal((await post(s.base, "/v1/suggest", { text: "" }, as(kid))).status, 400);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(mailed, ["EarthWalk suggestion 1: More dogs please", "EarthWalk suggestion 2: Boats on the harbour"]);

    let box = await (await fetch(`${s.base}/v1/admin/suggestions`, { headers: as(boss) })).json();
    assert.equal(box.mails, true);
    assert.deepEqual(box.statuses, ["new", "planned", "done", "declined"]);
    assert.deepEqual(box.suggestions.map((g: Record<string, unknown>) => [g.id, g.name, g.email, g.client, g.lat, g.emailed]), [[2, "Kid", "kid@example.com", "browser", null, "sent"], [1, "Maple", null, "windows", 48.8583, "sent"]], "a signed-in player is known by their account, not by the name they send");
    assert.equal((await (await fetch(`${s.base}/v1/admin/now`, { headers: as(boss) })).json()).suggestions.waiting, 2);

    res = await post(s.base, "/v1/admin/suggestion", { id: 1, status: "planned", note: "Dogs are coming in the animal games" }, as(boss));
    assert.equal((await res.json()).suggestion.status, "planned");
    assert.equal((await post(s.base, "/v1/admin/suggestion", { id: 2, resend: true }, as(boss))).status, 200);
    assert.equal(mailed.length, 3);
    assert.equal((await post(s.base, "/v1/admin/suggestion", { id: 2, remove: true }, as(boss))).status, 200);
    assert.equal((await post(s.base, "/v1/admin/suggestion", { id: 2, status: "done" }, as(boss))).status, 404);
    assert.equal((await post(s.base, "/v1/admin/suggestion", { id: 1, status: "done" }, as(kid))).status, 403);
    box = await (await fetch(`${s.base}/v1/admin/suggestions`, { headers: as(boss) })).json();
    assert.deepEqual(box.suggestions.map((g: Record<string, unknown>) => [g.id, g.status, g.note]), [[1, "planned", "Dogs are coming in the animal games"]]);
  } finally { s.app.close(); }
});

test("the letter goes to the mail service as its settings say, and nowhere without them", async () => {
  assert.equal(mailerFromSettings({}), null);
  assert.equal(mailerFromSettings({ EARTHWALK_RESEND_KEY: "re_test" }), null, "a key and no address sends nothing");
  assert.equal(typeof mailerFromSettings({ EARTHWALK_RESEND_KEY: "re_test", EARTHWALK_MAIL_TO: "owner@example.com" }), "function");
  const asked: { url: string; init: RequestInit }[] = [];
  const web = (async (url: string | URL | Request, init?: RequestInit) => { asked.push({ url: String(url), init: init! }); return new Response(asked.length === 1 ? "{}" : '{"message":"the address is not allowed"}', { status: asked.length === 1 ? 200 : 403 }); }) as typeof fetch;
  const mail = resendMailer("re_test", "owner@example.com", undefined, web);
  await mail("A subject\nwith a line break", "The text.");
  assert.equal(asked[0].url, "https://api.resend.com/emails");
  assert.equal((asked[0].init.headers as Record<string, string>).Authorization, "Bearer re_test");
  assert.deepEqual(JSON.parse(String(asked[0].init.body)), { from: "EarthWalk <onboarding@resend.dev>", to: ["owner@example.com"], subject: "A subject with a line break", text: "The text." });
  await assert.rejects(mail("Again", "The text."), /answered 403: .*the address is not allowed/);
});
