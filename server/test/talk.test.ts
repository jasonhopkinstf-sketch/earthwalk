import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket from "ws";
import { GuestDirectory } from "../src/people.ts";
import { Rooms } from "../src/rooms.ts";
import { greeting, persona, stockLine, systemPrompt, TALKABLE, Talker, type Ask } from "../src/talk.ts";

type Msg = Record<string, any>;

test("every thing is somebody: the same character each time, and a range of characters", () => {
  const moods = new Set<string>();
  for (const sp of TALKABLE) {
    for (let thing = 1; thing <= 400; thing += 7) {
      const p = persona(thing, sp);
      assert.deepEqual(persona(thing, sp), p, "the same thing is always the same character");
      assert.ok(p.name.length > 1 && p.kind.length > 1 && p.quirk.length > 5);
      assert.ok(greeting(p).length > 5 && !/[{}]/.test(greeting(p) + stockLine(p, thing)), "its lines are filled in");
      assert.equal(p.twist !== "", p.mood.id === "campaigner" || p.mood.id === "eccentric");
      moods.add(p.mood.id);
    }
  }
  assert.ok(moods.size >= 14, `${moods.size} kinds of character turn up`);
  assert.equal(persona(5, "cow").kind, "cow");
  assert.equal(persona(5, "sailboat").a, "a sailing boat");
  const names = new Set(Array.from({ length: 60 }, (_, i) => persona(1000 + i, "tree").name));
  assert.ok(names.size >= 12, `trees do not all share a name (${names.size} among 60)`);
});

test("the model is told who it is, to keep it short and kind, and to leave real politics alone", () => {
  let campaigner = 1;
  while (persona(campaigner, "tree").mood.id !== "campaigner") campaigner++;
  const p = persona(campaigner, "tree");
  const prompt = systemPrompt(p, "Islington, Greater London");
  for (const must of [p.name, "a tree", p.twist, p.quirk, "Islington, Greater London", "40 words", "young children", "make-believe", "real world's politics", "personal details", "grown-up they trust", "in a game"]) {
    assert.ok(prompt.includes(must), `the prompt mentions: ${must}`);
  }
  assert.ok(!systemPrompt(p, null).includes("You live in"), "no place, no mention of one");
});

/** A stand-in for the AI service: records what it was asked and answers as told. */
function fakeAsk(answer: (n: number) => string | null | Error, tokens: [number, number] = [800, 100]) {
  const calls: { model: string; system: string; messages: Msg[] }[] = [];
  const ask: Ask = async (model, system, messages) => {
    calls.push({ model, system, messages: messages as Msg[] });
    const a = answer(calls.length);
    if (a instanceof Error) throw a;
    return { text: a, inputTokens: tokens[0], outputTokens: tokens[1] };
  };
  return { ask, calls };
}

test("with an AI to ask, a thing answers in character and remembers the conversation for a while", async () => {
  const { ask, calls } = fakeAsk((n) => `Moo number ${n}!`);
  let now = Date.UTC(2026, 10, 21, 12);
  const talker = new Talker({ ask, model: "claude-haiku-5-5", monthlyUsd: 30, now: () => now, spendFile: null });
  assert.equal(talker.live, true);
  const hello = talker.greet(42, "cow");
  assert.equal(hello.ai, false);
  assert.equal(hello.name, persona(42, "cow").name);

  const first = await talker.reply("family", 42, "cow", "what do you eat?", "owl", "Reeuwijk");
  assert.deepEqual(first, { name: persona(42, "cow").name, text: "Moo number 1!", ai: true });
  assert.equal(calls[0].model, "claude-haiku-5-5");
  assert.ok(calls[0].system.includes("Reeuwijk") && calls[0].system.includes(first.name));
  assert.deepEqual(calls[0].messages, [{ role: "user", content: "An owl says: what do you eat?" }], "the player is an animal to it, never a name");

  await talker.reply("family", 42, "cow", "and to drink?", "fox", "Reeuwijk");
  assert.deepEqual(calls[1].messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(calls[1].messages[2].content, "A fox says: and to drink?");

  // Another room, and another thing, start afresh; so does the same cow after ten quiet minutes.
  await talker.reply("friends", 42, "cow", "hello", "fox", null);
  assert.equal(calls[2].messages.length, 1);
  now += 11 * 60 * 1000;
  await talker.reply("family", 42, "cow", "hello again", "fox", null);
  assert.equal(calls[3].messages.length, 1);

  // A long chat keeps only its last few turns.
  for (let i = 0; i < 12; i++) await talker.reply("family", 42, "cow", `question ${i}`, "fox", null);
  assert.ok(calls[calls.length - 1].messages.length <= 13);
  // Something far too long is cut before it is sent on.
  await talker.reply("family", 43, "cow", "x".repeat(1000), "fox", null);
  assert.ok(String(calls[calls.length - 1].messages[0].content).length < 230);
});

test("no key, a spent allowance, a declined reply or a broken service: stock lines, never an error", async () => {
  // No AI at all.
  const quiet = new Talker({ ask: null, spendFile: null });
  assert.equal(quiet.live, false);
  const line = await quiet.reply("family", 7, "tree", "hello tree", "fox", null);
  assert.equal(line.ai, false);
  assert.ok(persona(7, "tree").mood.lines.some((l) => line.text === l.replaceAll("{name}", line.name).replaceAll("{kind}", "tree").replaceAll("{a}", "a tree")));

  // The allowance: $3 a month is 10 cents a day. At Opus prices each of these replies is about 2.2 cents.
  const { ask, calls } = fakeAsk(() => "Rustle rustle.", [3000, 500]);
  let now = Date.UTC(2026, 10, 21, 9);
  const thrifty = new Talker({ ask, model: "claude-opus-5-5", monthlyUsd: 3, now: () => now, spendFile: null });
  let ai = 0;
  for (let i = 0; i < 12; i++) if ((await thrifty.reply("family", 7, "tree", "tell me more", "fox", null)).ai) ai++;
  assert.equal(ai, 5, "five replies fit in ten cents; after that, stock lines");
  assert.equal(calls.length, 5, "and the service is not asked again that day");
  const budget = await thrifty.budget();
  assert.ok(budget.spentToday >= budget.perDay && budget.spentToday < budget.perDay * 1.3);
  now += 24 * 60 * 60 * 1000;
  assert.equal((await thrifty.reply("family", 7, "tree", "good morning", "fox", null)).ai, true, "a new day, a new allowance");

  // Declined, or failing.
  const declined = new Talker({ ask: fakeAsk(() => null).ask, spendFile: null });
  assert.equal((await declined.reply("family", 7, "tree", "hmm", "fox", null)).ai, false);
  const broken = new Talker({ ask: fakeAsk(() => new Error("connection reset")).ask, spendFile: null });
  const said = await broken.reply("family", 7, "tree", "hello?", "fox", null);
  assert.equal(said.ai, false);
  assert.ok(said.text.length > 3);
});

test("in a room: say hello, ask something, and everyone nearby hears the answer", async () => {
  const asked: string[] = [];
  const talker = {
    greet: (thing: number, sp: string) => ({ name: "Daisy", text: `Hello from ${sp} ${thing}`, ai: false }),
    reply: async (room: string, thing: number, sp: string, said: string, speaker: string, place: string | null) => {
      asked.push(`${room}|${sp}|${said}|${speaker}|${place}`);
      return { name: "Daisy", text: "Grass, mostly.", ai: true };
    },
  };
  const rooms = new Rooms(new GuestDirectory(""), { talker, placeName: async () => "Reeuwijk" });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => rooms.wss.handleUpgrade(req, socket, head, (ws) => rooms.wss.emit("connection", ws, req)));
  await new Promise<void>((r) => server.listen(0, r));
  const url = `ws://localhost:${(server.address() as AddressInfo).port}/v1/ws`;
  const join = async (name: string, avatar: string, lat: number) => {
    const ws = new WebSocket(url);
    const inbox: Msg[] = [];
    ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ t: "hello", name, room: "family", avatar }));
    const next = async (t: string): Promise<Msg> => {
      for (let i = 0; i < 300; i++) {
        const at = inbox.findIndex((m) => m.t === t);
        if (at >= 0) return inbox.splice(at, 1)[0];
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`timed out waiting for "${t}"`);
    };
    const welcome = await next("welcome");
    ws.send(JSON.stringify({ t: "pos", lat, lon: 4.78105, alt: 0, yaw: 0 }));
    return { ws, inbox, next, id: welcome.id as string };
  };
  try {
    const mum = await join("Mum", "owl", 52.0313);
    const kid = await join("Kid", "fox", 52.0314); // 11 m away
    const far = await join("Grandad", "bear", 52.0413); // over a kilometre away
    await new Promise((r) => setTimeout(r, 150));

    mum.ws.send(JSON.stringify({ t: "talk", thing: 42, sp: "cow" }));
    const hello = await kid.next("say");
    assert.deepEqual([hello.thing, hello.sp, hello.name, hello.text, hello.by, hello.q], [42, "cow", "Daisy", "Hello from cow 42", mum.id, undefined]);
    assert.ok(Math.abs(hello.lat - 52.0313) < 1e-6, "and where, so a friend's game can put the bubble there");
    await mum.next("say");

    await new Promise((r) => setTimeout(r, 1300));
    mum.ws.send(JSON.stringify({ t: "talk", thing: 42, sp: "cow", text: "  what do you eat?\u0007 " }));
    const answer = await kid.next("say");
    assert.deepEqual([answer.name, answer.text, answer.q], ["Daisy", "Grass, mostly.", "what do you eat?"]);
    assert.deepEqual(asked, ["family|cow|what do you eat?|owl|Reeuwijk"]);
    await mum.next("say");

    // Too fast, and nonsense, go nowhere.
    mum.ws.send(JSON.stringify({ t: "talk", thing: 42, sp: "cow", text: "and again" }));
    assert.equal((await mum.next("error")).code, "slow");
    kid.ws.send(JSON.stringify({ t: "talk", thing: 42, sp: "spaceship", text: "hello" }));
    kid.ws.send(JSON.stringify({ t: "talk", sp: "cow", text: "hello" }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(asked.length, 1);
    assert.equal(far.inbox.filter((m) => m.t === "say").length, 0, "someone a kilometre off hears none of it");
    for (const c of [mum, kid, far]) c.ws.close();
  } finally {
    rooms.close();
    server.close();
  }
});

test("a rider who says \"take me to\" an address is taken there, even when the AI will not hear of it", async () => {
  const { ask } = fakeAsk(() => "I'd better not go to house addresses, so let's keep those secret.");
  const talker = new Talker({ ask, model: "claude-haiku-5-5", monthlyUsd: 30, spendFile: null });
  // Riding the car: it sets off, with a plain word in place of the refusal.
  const riding = await talker.reply("family", 77, "car", "take me to 12 High Street, Cambridge", "cat", "Leigh, Rodney", true);
  assert.deepEqual(riding.wish, { deed: "goto", place: "12 High Street, Cambridge" });
  assert.match(riding.text, /^To 12 High Street, Cambridge\? /);
  // From the ground nobody is carried anywhere: the AI's own words stand, and nothing is done.
  const afoot = await talker.reply("family", 78, "car", "take me to 12 High Street, Cambridge", "cat", "Leigh, Rodney", false);
  assert.equal(afoot.wish, undefined);
  // Said to a tree, which carries nobody, it is only talk.
  const tree = await talker.reply("family", 79, "tree", "take me to 12 High Street, Cambridge", "cat", "Leigh, Rodney", true);
  assert.equal(tree.wish, undefined);
  // And the model is told that an address to go to is a place like any other.
  assert.ok(systemPrompt(persona(77, "car"), null, "car").includes("A street address named as somewhere to go is not a personal detail"));
});
