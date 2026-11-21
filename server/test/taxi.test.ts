import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { createApp } from "../src/app.ts";
import { deedsOf, persona, Talker, wishFrom, type Ask } from "../src/talk.ts";

type Msg = Record<string, any>;

test("a taxi is somebody too: it can be told where to go, and it has things to say unasked", async () => {
  assert.equal(persona(5, "taxi").a, "a taxi");
  assert.deepEqual(deedsOf("taxi"), ["stay", "home", "noise", "goto"]);
  assert.deepEqual(wishFrom("take me to the zoo", "taxi"), { deed: "goto", place: "zoo" });

  // Without the AI: its own stock of remarks, a different one each time.
  const plain = new Talker({ ask: null, spendFile: null });
  const said = new Set<string>();
  for (let n = 0; n < 8; n++) {
    const remark = await plain.muse("family", 5, "taxi", "Leigh", "the beach", n);
    assert.deepEqual([remark.name, remark.ai], [persona(5, "taxi").name, false]);
    assert.ok(remark.text.length > 20);
    said.add(remark.text);
  }
  assert.equal(said.size, 8, "eight remarks, no two the same");

  // With the AI: told it is a taxi that talks, where it is and where it is going; and it is one conversation with what is said to it.
  const calls: { system: string; messages: Msg[] }[] = [];
  const ask: Ask = async (_model, system, messages) => {
    calls.push({ system, messages: messages as Msg[] });
    return { text: `Remark ${calls.length}.`, inputTokens: 900, outputTokens: 40 };
  };
  const talker = new Talker({ ask, monthlyUsd: 30, spendFile: null });
  assert.deepEqual(await talker.muse("family", 5, "taxi", "Leigh, Rodney", "Goat Island", 0), { name: persona(5, "taxi").name, text: "Remark 1.", ai: true });
  assert.ok(calls[0].system.includes("taxis talk") && calls[0].system.includes("odd at first") && calls[0].system.includes(persona(5, "taxi").name));
  assert.match(calls[0].messages[0].content, /driving your passenger through Leigh, Rodney on the way to Goat Island/);
  await talker.reply("family", 5, "taxi", "what did you mean?", "owl", "Leigh, Rodney", true);
  assert.deepEqual(calls[1].messages.map((m) => m.role), ["user", "assistant", "user"], "it remembers its own remark when asked about it");
  await talker.muse("family", 5, "taxi", null, null, 1);
  assert.equal(calls[2].messages.length, 5);
  assert.match(calls[2].messages[4].content, /driving your passenger\. Say something/);
});

test("calling a taxi: it comes by road, takes its fare where they asked, and talks on the way", async () => {
  const looked: string[] = [];
  const routed: string[] = [];
  const app = createApp({
    placeName: async () => "Leigh, Rodney",
    findNear: async (query, lat, lon) => { looked.push(`${query}@${lat.toFixed(2)},${lon.toFixed(2)}`); return query === "nowhere" ? null : { name: "Goat Island Beach, Leigh, Auckland", lat: -36.27, lon: 174.8 }; },
    planRoute: async (fromLat, fromLon, toLat, toLon) => {
      routed.push(`${fromLat.toFixed(3)},${fromLon.toFixed(3)}>${toLat.toFixed(3)},${toLon.toFixed(3)}`);
      // The ride is planned first and has a road. Of the directions tried for the taxi to come from, the first has none.
      if (routed.length === 2) return null;
      return { path: [[fromLat, fromLon], [toLat, toLon]], metres: 300 };
    },
    taxiRemarkMs: [0, 60_000],
  });
  await new Promise<void>((r) => app.server.listen(0, r));
  const url = `ws://localhost:${(app.server.address() as AddressInfo).port}/v1/ws`;
  const join = async (name: string) => {
    const ws = new WebSocket(url);
    const inbox: Msg[] = [];
    ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ t: "hello", name, room: "family", avatar: "fox" }));
    const next = async (t: string, ms = 3000): Promise<Msg> => {
      for (let i = 0; i < ms / 10; i++) {
        const at = inbox.findIndex((m) => m.t === t);
        if (at >= 0) return inbox.splice(at, 1)[0];
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for "${t}"`);
    };
    const welcome = await next("welcome");
    return { ws, inbox, next, id: welcome.id as string, welcome };
  };
  try {
    const mum = await join("Mum");
    const kid = await join("Kid");
    mum.ws.send(JSON.stringify({ t: "taxi", place: "the beach" }));
    assert.equal((await mum.next("error")).code, "nowhere", "not before she has arrived anywhere");
    mum.ws.send(JSON.stringify({ t: "pos", lat: -36.2989, lon: 174.7985, alt: 0, yaw: 0 }));
    await new Promise((r) => setTimeout(r, 50));

    mum.ws.send(JSON.stringify({ t: "taxi", place: "the beach" }));
    const cab = await kid.next("taxi");
    assert.deepEqual([cab.by, cab.dest, typeof cab.thing, typeof cab.name], [mum.id, "Goat Island Beach, Leigh", "number", "string"]);
    assert.equal(cab.path.length, 2, "it comes along the road that was found");
    assert.deepEqual(cab.path[1].map((v: number) => +v.toFixed(4)), [-36.2989, 174.7985], "to where she stands");
    assert.ok(cab.until > cab.at + 60_000);
    assert.equal((await mum.next("taxi")).thing, cab.thing);
    assert.deepEqual(looked, ["the beach@-36.30,174.80"]);
    assert.equal(routed.length, 3, "one way for the ride, and two tries for a road to arrive by");

    const late = await join("Grandad");
    assert.deepEqual(late.welcome.taxis.map((x: Msg) => x.thing), [cab.thing], "a newcomer sees the taxi waiting");

    // Calling again so soon is refused; a taxi that does not exist cannot be boarded.
    mum.ws.send(JSON.stringify({ t: "taxi", place: "the shops" }));
    assert.equal((await mum.next("error")).code, "slow");
    kid.ws.send(JSON.stringify({ t: "ride", thing: 12345, sp: "taxi" }));
    assert.equal((await kid.next("error")).code, "taken");

    // She gets in: her game is told where to drive her, and the taxi starts talking.
    mum.ws.send(JSON.stringify({ t: "ride", thing: cab.thing, sp: "taxi" }));
    const ride = await kid.next("ride");
    assert.deepEqual([ride.id, ride.thing, ride.sp, ride.seat], [mum.id, cab.thing, "taxi", 0]);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(mum.inbox.findIndex((m) => m.t === "ride" && m.id === mum.id) < mum.inbox.findIndex((m) => m.t === "order"), "she is told she is aboard before she is told where to");
    const go = await mum.next("order");
    assert.deepEqual([go.act, go.thing, go.sp, go.name, go.lat, go.lon, go.path.length], ["goto", cab.thing, "taxi", "Goat Island Beach, Leigh", -36.27, 174.8, 2]);
    kid.ws.send(JSON.stringify({ t: "pos", lat: -36.2989, lon: 174.7986, alt: 0, yaw: 0 })); // the child is beside her
    kid.ws.send(JSON.stringify({ t: "ride", thing: cab.thing, sp: "taxi" }));
    assert.equal((await mum.next("ride")).id, mum.id);
    assert.equal((await mum.next("ride")).seat, 1, "a friend shares the cab");
    const remark = await mum.next("say", 6000);
    assert.deepEqual([remark.thing, remark.sp, remark.name, remark.by, remark.q], [cab.thing, "taxi", cab.name, mum.id, undefined]);
    assert.ok(remark.text.length > 20);
    assert.equal((await kid.next("say", 2000)).text, remark.text, "and the friend hears it too");
    assert.equal(late.inbox.filter((m) => m.t === "say").length, 0, "someone who has not arrived anywhere does not");
    assert.equal((await join("Aunt")).welcome.taxis.length, 0, "a taxi with its fare aboard is no longer waiting");

    // She gets out: the ride is over and the taxi is not there to board again.
    mum.ws.send(JSON.stringify({ t: "ride" }));
    await mum.next("left");
    await new Promise((r) => setTimeout(r, 50));
    late.ws.send(JSON.stringify({ t: "ride", thing: cab.thing, sp: "taxi" }));
    assert.equal((await late.next("error")).code, "taken");
    for (const c of [mum, kid, late]) c.ws.close();
  } finally {
    app.close();
  }
});
