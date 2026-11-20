import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createApp, type AppOptions } from "../src/app.ts";
import type { GoogleIdentity } from "../src/people.ts";

/** Google is never called: the "code" Google would send back is the identity itself. */
const identities: Record<string, GoogleIdentity> = {
  mum: { sub: "g-1", email: "mum@example.com", name: "Mum" },
  kid: { sub: "g-2", email: "kid@example.com", name: "Kid" },
  stranger: { sub: "g-3", email: "stranger@example.com", name: "Stranger" },
};

async function start(options: AppOptions = {}) {
  const app = createApp({
    accessCode: "otter-42",
    google: { clientId: "app-1", clientSecret: "shh" },
    signIn: async (code, nonce, redirectUri) => {
      assert.ok(nonce && redirectUri.endsWith("/auth/google/callback"));
      if (!identities[code]) throw new Error("bad code");
      return identities[code];
    },
    invited: ["kid@example.com"],
    placeName: async () => "Montmartre, Paris",
    buildChunk: async () => Buffer.from("chunk"),
    buildLabels: async () => Buffer.from("{}"),
    readCache: async () => null,
    writeCache: async () => undefined,
    findPlace: async (q) => ({ name: q, lat: 1, lon: 2 }),
    ...options,
  });
  await new Promise<void>((r) => app.server.listen(0, r));
  const base = `http://localhost:${(app.server.address() as AddressInfo).port}`;
  return { base, app };
}

const noFollow = { redirect: "manual" as const };

/** Walks the browser flow: /auth/google -> (Google) -> callback. Returns the callback response. */
async function browserSignIn(base: string, who: string, query = "") {
  const go = await fetch(`${base}/auth/google${query}`, noFollow);
  assert.equal(go.status, 302);
  const google = new URL(go.headers.get("location")!);
  assert.equal(google.origin, "https://accounts.google.com");
  assert.equal(google.searchParams.get("client_id"), "app-1");
  assert.equal(google.searchParams.get("redirect_uri"), `${base}/auth/google/callback`);
  const state = google.searchParams.get("state")!;
  return fetch(`${base}/auth/google/callback?state=${encodeURIComponent(state)}&code=${who}`, noFollow);
}
const cookieOf = (res: Response): string => res.headers.get("set-cookie")!.split(";")[0];

test("browser sign-in: cookie, /v1/me, world data, and the sign-up gate", async () => {
  const s = await start();
  try {
    assert.equal((await (await fetch(`${s.base}/health`)).json()).googleSignIn, true);
    // Mum types the access code on the join screen, so she may sign up.
    const back = await browserSignIn(s.base, "mum", "?code=otter-42&next=/%3Froom%3Dfamily");
    assert.equal(back.status, 302);
    assert.equal(back.headers.get("location"), "/?room=family");
    const cookie = cookieOf(back);
    assert.match(back.headers.get("set-cookie")!, /HttpOnly/);
    const me = await (await fetch(`${s.base}/v1/me`, { headers: { cookie } })).json();
    assert.equal(me.email, "mum@example.com");
    assert.equal(me.name, "Mum");
    assert.equal(me.home, null);
    // The cookie opens the world data too (no access code needed).
    assert.equal((await fetch(`${s.base}/v1/chunk/16/1/2`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${s.base}/v1/geocode?q=Paris`, { headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${s.base}/v1/chunk/16/1/2`)).status, 401);
    assert.equal((await fetch(`${s.base}/v1/me`)).status, 401);
    assert.equal((await fetch(`${s.base}/v1/me`, { headers: { cookie: "ew_token=forged" } })).status, 401);

    // The kid was invited by email, so needs no code; a stranger with neither is turned away.
    assert.equal((await browserSignIn(s.base, "kid")).status, 302);
    const refused = await browserSignIn(s.base, "stranger");
    assert.equal(refused.status, 302);
    assert.equal(refused.headers.get("location"), "/?signin=not-invited");
    assert.equal(s.app.accounts.list().length, 2);

    // A bad or reused state and a failed exchange are refused.
    assert.equal((await fetch(`${s.base}/auth/google/callback?state=nope&code=mum`)).status, 400);
    const go = await fetch(`${s.base}/auth/google`, noFollow);
    const state = new URL(go.headers.get("location")!).searchParams.get("state")!;
    assert.equal((await fetch(`${s.base}/auth/google/callback?state=${state}&code=garbage`)).status, 502);
    assert.equal((await fetch(`${s.base}/auth/google/callback?state=${state}&code=mum`)).status, 400, "state is single-use");

    // Signing out revokes the token.
    const out = await fetch(`${s.base}/auth/logout`, { method: "POST", headers: { cookie } });
    assert.equal(out.status, 200);
    assert.match(out.headers.get("set-cookie")!, /Max-Age=0/);
    assert.equal((await fetch(`${s.base}/v1/me`, { headers: { cookie } })).status, 401);
  } finally {
    s.app.close();
  }
});

test("game link flow: /link hands off to Google and /v1/link/<code> delivers the token once", async () => {
  const s = await start();
  try {
    assert.deepEqual(await (await fetch(`${s.base}/v1/link/ABCD2345`)).json(), { pending: true });
    const link = await fetch(`${s.base}/link?code=abcd2345&access=otter-42`, noFollow);
    assert.equal(link.status, 302);
    assert.equal(link.headers.get("location"), "/auth/google?link=ABCD2345&code=otter-42");
    const done = await browserSignIn(s.base, "mum", "?link=ABCD2345&code=otter-42");
    assert.equal(done.status, 200, "the browser shows a done page instead of entering the world");
    assert.equal(done.headers.get("set-cookie"), null);
    assert.match(await done.text(), /Signed in as Mum/);

    const got = await (await fetch(`${s.base}/v1/link/ABCD2345`)).json();
    assert.ok(got.token);
    assert.equal(got.name, "Mum");
    assert.deepEqual(await (await fetch(`${s.base}/v1/link/ABCD2345`)).json(), { pending: true }, "handed out only once");
    assert.equal((await fetch(`${s.base}/v1/link/x`)).status, 400);
    assert.equal((await fetch(`${s.base}/link`)).status, 400);

    // The game then uses the token as its Bearer everywhere.
    const auth = { Authorization: `Bearer ${got.token}` };
    assert.equal((await fetch(`${s.base}/v1/chunk/16/1/2`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${s.base}/v1/labels/16/1/2`, { headers: auth })).status, 200);
    assert.equal((await (await fetch(`${s.base}/v1/me`, { headers: auth })).json()).email, "mum@example.com");
    assert.equal((await fetch(`${s.base}/v1/chunk/16/1/2`, { headers: { Authorization: "Bearer wrong" } })).status, 401);

    // A stranger signing in through a link sees why they were refused.
    await fetch(`${s.base}/link?code=ZZZZ9999`, noFollow);
    const refused = await browserSignIn(s.base, "stranger", "?link=ZZZZ9999");
    assert.equal(refused.status, 403);
    assert.deepEqual(await (await fetch(`${s.base}/v1/link/ZZZZ9999`)).json(), { pending: true });
  } finally {
    s.app.close();
  }
});

test("/v1/people shows who is online and where, through the rooms", async () => {
  const s = await start();
  try {
    const mum = cookieOf(await browserSignIn(s.base, "mum", "?code=otter-42"));
    const kid = cookieOf(await browserSignIn(s.base, "kid"));
    assert.equal((await fetch(`${s.base}/v1/people`)).status, 401);
    assert.equal((await fetch(`${s.base}/v1/people`, { headers: { Authorization: "Bearer otter-42" } })).status, 401, "the access code alone is not an account");
    let people = (await (await fetch(`${s.base}/v1/people`, { headers: { cookie: mum } })).json()).people;
    assert.equal(people.length, 2);
    assert.ok(people.every((p: any) => !p.online));

    // Mum joins a room from the browser (the cookie identifies her) and walks to Montmartre.
    const ws = new WebSocket(`${s.base.replace("http", "ws")}/v1/ws`, { headers: { cookie: mum } });
    const inbox: any[] = [];
    ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ t: "hello", room: "family" }));
    await new Promise<void>((r) => { const i = setInterval(() => { if (inbox.some((m) => m.t === "welcome")) { clearInterval(i); r(); } }, 10); });
    ws.send(JSON.stringify({ t: "pos", lat: 48.8867, lon: 2.3431, alt: 100, yaw: 0 }));
    await new Promise((r) => setTimeout(r, 50));
    await s.app.presence.refresh();

    people = (await (await fetch(`${s.base}/v1/people`, { headers: { cookie: kid } })).json()).people;
    const her = people.find((p: any) => p.name === "Mum");
    assert.equal(her.online, true);
    assert.equal(her.room, "family");
    assert.equal(her.place, "Montmartre, Paris");
    assert.equal(her.lat, 48.8867);
    assert.equal(people[0].name, "Mum", "online people come first");
    assert.equal(people.find((p: any) => p.name === "Kid").online, false);

    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    people = (await (await fetch(`${s.base}/v1/people`, { headers: { cookie: kid } })).json()).people;
    const gone = people.find((p: any) => p.name === "Mum");
    assert.equal(gone.online, false);
    assert.equal(gone.place, "Montmartre, Paris", "the last known place is kept while offline");
    assert.equal(gone.room, "family");
    assert.ok(Date.now() - gone.lastSeen < 5000);
  } finally {
    s.app.close();
  }
});

test("without Google configured, sign-in routes say so and guests work as before", async () => {
  const s = await start({ google: undefined, signIn: undefined });
  try {
    assert.equal((await (await fetch(`${s.base}/health`)).json()).googleSignIn, false);
    assert.equal((await fetch(`${s.base}/auth/google`, noFollow)).status, 404);
    assert.equal((await fetch(`${s.base}/link?code=ABCD2345`, noFollow)).status, 404);
    assert.equal((await fetch(`${s.base}/v1/chunk/16/1/2?code=otter-42`)).status, 200);
    assert.equal((await fetch(`${s.base}/v1/chunk/16/1/2`)).status, 401);
    assert.equal((await fetch(`${s.base}/`)).status, 200);
  } finally {
    s.app.close();
  }
});
