import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { GuestDirectory } from "../src/people.ts";
import { Rooms } from "../src/rooms.ts";

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
