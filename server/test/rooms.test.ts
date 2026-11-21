import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { AccountDirectory, GuestDirectory } from "../src/people.ts";
import { Presence } from "../src/presence.ts";
import { Rooms, TOKEN_COOKIE } from "../src/rooms.ts";

type Msg = Record<string, any>;

async function start(accessCode = "") {
  const rooms = new Rooms(new GuestDirectory(accessCode));
  const server = createServer();
  server.on("upgrade", (req, socket, head) => rooms.wss.handleUpgrade(req, socket, head, (ws) => rooms.wss.emit("connection", ws, req)));
  await new Promise<void>((r) => server.listen(0, r));
  const url = `ws://localhost:${(server.address() as AddressInfo).port}/v1/ws`;
  return { url, rooms, stop: () => { rooms.close(); server.close(); } };
}

function client(url: string) {
  const ws = new WebSocket(url);
  const inbox: Msg[] = [];
  const waiters: { want: (m: Msg) => boolean; done: (m: Msg) => void }[] = [];
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString()) as Msg;
    const i = waiters.findIndex((w) => w.want(m));
    if (i >= 0) waiters.splice(i, 1)[0].done(m);
    else inbox.push(m);
  });
  const next = (t: string): Promise<Msg> => {
    const i = inbox.findIndex((m) => m.t === t);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`timed out waiting for "${t}"`)), 3000);
      waiters.push({ want: (m) => m.t === t, done: (m) => { clearTimeout(timer); done(m); } });
    });
  };
  const send = (m: Msg) => ws.send(JSON.stringify(m));
  const open = new Promise<void>((r) => ws.on("open", () => r()));
  return { ws, next, send, open };
}

test("two people meet in a room, see each other move and chat", async () => {
  const s = await start();
  try {
    const mum = client(s.url);
    await mum.open;
    mum.send({ t: "hello", name: "Mum", room: "Family", avatar: "owl" });
    const w1 = await mum.next("welcome");
    assert.equal(w1.peers.length, 0);
    mum.send({ t: "pos", lat: 48.8583, lon: 2.2945, alt: 35, yaw: 90 });

    const kid = client(s.url);
    await kid.open;
    kid.send({ t: "hello", name: "Mum", room: "family" }); // same room (case-insensitive), clashing name
    const w2 = await kid.next("welcome");
    assert.equal(w2.name, "Mum 2");
    assert.equal(w2.peers.length, 1);
    assert.equal(w2.peers[0].lat, 48.8583);
    assert.equal(w2.peers[0].avatar, "owl");
    assert.equal(w2.avatar, "fox", "missing or invalid animals fall back to the default");
    const joined = await mum.next("join");
    assert.equal(joined.name, "Mum 2");
    assert.equal(joined.avatar, "fox");

    kid.send({ t: "pos", lat: 48.86, lon: 2.3, alt: 40, yaw: 10 });
    const peers = await mum.next("peers");
    assert.deepEqual(peers.p, [[w2.id, 48.86, 2.3, 40, 10]]);

    kid.send({ t: "chat", text: "  hello\u0007 there  " });
    const line = await mum.next("chat");
    assert.equal(line.text, "hello  there");
    assert.equal(line.name, "Mum 2");
    await kid.next("chat");

    const late = client(s.url);
    await late.open;
    late.send({ t: "hello", name: "Grandad", room: "family" });
    assert.equal((await late.next("welcome")).history.length, 1);

    kid.ws.close();
    assert.equal((await mum.next("leave")).id, w2.id);
    mum.ws.close();
    late.ws.close();
  } finally {
    s.stop();
  }
});

test("the server shares its clock: in welcome, and on request with the client's own stamp", async () => {
  const s = await start();
  try {
    const mum = client(s.url);
    await mum.open;
    const before = Date.now();
    mum.send({ t: "hello", name: "Mum", room: "family" });
    const welcome = await mum.next("welcome");
    assert.ok(welcome.now >= before && welcome.now <= Date.now());
    mum.send({ t: "time", c: 1234.5 });
    const time = await mum.next("time");
    assert.equal(time.c, 1234.5);
    assert.ok(time.now >= welcome.now && time.now <= Date.now());
    mum.ws.close();
  } finally {
    s.stop();
  }
});

test("riding: a driver, passengers, getting off, and what a latecomer is told", async () => {
  const s = await start();
  try {
    const join = async (name: string) => {
      const c = client(s.url);
      await c.open;
      c.send({ t: "hello", name, room: "family" });
      return { c, w: await c.next("welcome") };
    };
    const mum = await join("Mum");
    const kid = await join("Kid");
    await mum.c.next("join");
    mum.c.send({ t: "pos", lat: 52.0313, lon: 4.78105, alt: 1.6, yaw: 90 });

    // Mum takes the horse; Kid hops on behind her.
    mum.c.send({ t: "ride", thing: 123456, sp: "horse" });
    assert.deepEqual(await kid.c.next("ride"), { t: "ride", id: mum.w.id, thing: 123456, sp: "horse", seat: 0 });
    assert.deepEqual(await mum.c.next("ride"), { t: "ride", id: mum.w.id, thing: 123456, sp: "horse", seat: 0 }, "the rider is told too: that is the go-ahead");
    kid.c.send({ t: "ride", thing: 123456, sp: "horse" });
    assert.equal((await mum.c.next("ride")).seat, 1);
    await kid.c.next("ride");

    // Nonsense is ignored: an unknown kind of thing, a thing with no number.
    kid.c.send({ t: "ride", thing: 5, sp: "dragon" });
    assert.deepEqual(await mum.c.next("ride"), { t: "ride", id: kid.w.id }, "asking for something else gets you off what you were on");
    await kid.c.next("ride");
    kid.c.send({ t: "ride", thing: 123456, sp: "horse" });
    assert.equal((await mum.c.next("ride")).seat, 1);
    await kid.c.next("ride");

    // A latecomer learns who is riding what.
    const late = await join("Grandad");
    assert.deepEqual(late.w.peers.map((p: Msg) => [p.name, p.ride?.thing, p.ride?.seat]).sort(), [["Kid", 123456, 1], ["Mum", 123456, 0]]);
    assert.deepEqual(late.w.left, []);

    // Mum gets off: Kid is off too, and the horse stays where she left it for a minute.
    const before = Date.now();
    mum.c.send({ t: "ride" });
    const off = [await late.c.next("ride"), await late.c.next("ride")];
    assert.deepEqual(off.map((m) => [m.id, m.thing]).sort(), [[kid.w.id, undefined], [mum.w.id, undefined]].sort());
    const left = await late.c.next("left");
    assert.deepEqual([left.thing, left.sp, left.lat, left.lon, left.yaw], [123456, "horse", 52.0313, 4.78105, 90]);
    assert.ok(left.until >= before + 59_000 && left.until <= Date.now() + 61_000);
    const later = await join("Aunt");
    assert.deepEqual(later.w.left.map((l: Msg) => l.thing), [123456], "and someone arriving in that minute sees it there");

    // Someone taking it again clears that; leaving the room gets you off.
    kid.c.send({ t: "ride", thing: 123456, sp: "horse" });
    assert.equal((await late.c.next("ride")).seat, 0);
    assert.deepEqual((await join("Uncle")).w.left, []);
    kid.c.ws.close();
    assert.equal((await late.c.next("ride")).thing, undefined);

    await later.c.next("ride"); // Aunt heard Kid get on
    await later.c.next("ride"); // and leave

    // A train takes everyone as passengers and is never left anywhere.
    mum.c.send({ t: "ride", thing: 777, sp: "train" });
    late.c.send({ t: "ride", thing: 777, sp: "train" });
    const aboard = [await later.c.next("ride"), await later.c.next("ride")];
    assert.deepEqual(aboard.map((m) => m.seat), [1, 1]);
    mum.c.send({ t: "ride" });
    assert.equal((await later.c.next("ride")).id, mum.w.id);
    for (const c of [mum.c, late.c, later.c]) c.ws.close();
  } finally {
    s.stop();
  }
});

test("rooms are separate and the access code is enforced", async () => {
  const s = await start("secret");
  try {
    const bad = client(s.url);
    await bad.open;
    bad.send({ t: "hello", name: "X", room: "a", token: "nope" });
    assert.equal((await bad.next("error")).code, "denied");

    const a = client(s.url);
    const b = client(s.url);
    await Promise.all([a.open, b.open]);
    a.send({ t: "hello", name: "A", room: "one", token: "secret" });
    b.send({ t: "hello", name: "B", room: "two", token: "secret" });
    assert.equal((await a.next("welcome")).peers.length, 0);
    assert.equal((await b.next("welcome")).peers.length, 0);
    assert.deepEqual(s.rooms.stats(), { rooms: 2, people: 2 });
    a.ws.close();
    b.ws.close();
  } finally {
    s.stop();
  }
});

test("signed-in people: token hello, home, people list, and the guest fallback", async () => {
  const dir = new AccountDirectory(undefined, { accessCode: "secret" });
  const mum = dir.signIn({ sub: "g-1", email: "mum@example.com", name: "Mum" }, { accessCode: "secret" })!;
  const rooms = new Rooms(dir, { placeName: async () => "Montmartre, Paris" });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => rooms.wss.handleUpgrade(req, socket, head, (ws) => rooms.wss.emit("connection", ws, req)));
  await new Promise<void>((r) => server.listen(0, r));
  const url = `ws://localhost:${(server.address() as AddressInfo).port}/v1/ws`;
  const people = new Presence(dir, rooms, async () => "Montmartre, Paris", 60_000);
  try {
    const a = client(url);
    await a.open;
    a.send({ t: "hello", room: "family", token: mum.token, avatar: "owl" });
    const w = await a.next("welcome");
    assert.equal(w.name, "Mum", "the account's name is used when none is given");
    assert.equal(w.avatar, "owl");
    assert.equal(w.signedIn, true);
    assert.equal(w.personId, mum.person.id);
    assert.equal(w.home, null);
    const list = await a.next("people");
    assert.equal(list.p.length, 1);
    assert.equal(list.p[0].online, true);
    assert.equal(list.p[0].room, "family");

    // Setting home where I stand names the place; setting it to coordinates keeps the given name.
    a.send({ t: "home" });
    assert.equal((await a.next("error")).code, "nowhere");
    a.send({ t: "pos", lat: 48.8867, lon: 2.3431, alt: 100, yaw: 0 });
    a.send({ t: "home" });
    const home = await a.next("home");
    assert.deepEqual(home, { t: "home", lat: 48.8867, lon: 2.3431, name: "Montmartre, Paris" });
    a.send({ t: "home", lat: 48.8583, lon: 2.2945, name: "Eiffel Tower" });
    assert.equal((await a.next("home")).name, "Eiffel Tower");
    assert.equal(dir.get(mum.person.id)?.home?.name, "Eiffel Tower");

    // Presence: once named, the list says where she is.
    await people.refresh();
    a.send({ t: "people" });
    const named = await a.next("people");
    assert.equal(named.p[0].place, "Montmartre, Paris");
    assert.equal(named.p[0].lat, 48.8867);

    // A guest with the access code joins the same room and sees the people list too; guests cannot set a home.
    const g = client(url);
    await g.open;
    g.send({ t: "hello", name: "Visitor", room: "family", token: "secret" });
    const gw = await g.next("welcome");
    assert.equal(gw.signedIn, false);
    assert.equal(gw.home, undefined);
    assert.equal((await g.next("people")).p.length, 1, "guests are not listed");
    g.send({ t: "home" });
    assert.equal((await g.next("error")).code, "guest");

    // A reconnect with the same token lands at home.
    a.ws.close();
    await g.next("leave");
    const b = client(url);
    await b.open;
    b.send({ t: "hello", room: "family", token: mum.token });
    assert.equal((await b.next("welcome")).home.name, "Eiffel Tower");
    b.ws.close();
    g.ws.close();
  } finally {
    people.close();
    rooms.close();
    server.close();
  }
});

test("the browser's cookie stands in for the token in hello", async () => {
  const dir = new AccountDirectory(undefined, { accessCode: "secret" });
  const kid = dir.signIn({ sub: "g-2", email: "kid@example.com", name: "Kid" }, { accessCode: "secret" })!;
  const rooms = new Rooms(dir);
  const server = createServer();
  server.on("upgrade", (req, socket, head) => rooms.wss.handleUpgrade(req, socket, head, (ws) => rooms.wss.emit("connection", ws, req)));
  await new Promise<void>((r) => server.listen(0, r));
  const url = `ws://localhost:${(server.address() as AddressInfo).port}/v1/ws`;
  try {
    const ws = new WebSocket(url, { headers: { cookie: `other=1; ${TOKEN_COOKIE}=${kid.token}` } });
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ t: "hello", room: "family" }));
    const welcome = await new Promise<Msg>((r) => ws.on("message", (d) => r(JSON.parse(d.toString()))));
    assert.equal(welcome.t, "welcome");
    assert.equal(welcome.name, "Kid");
    assert.equal(welcome.signedIn, true);
    ws.close();
  } finally {
    rooms.close();
    server.close();
  }
});
