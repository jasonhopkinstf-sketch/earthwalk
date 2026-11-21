// Talking to things. Everything in EarthWalk can be talked to: animals, cars, trains, tractors,
// boats, trees and houses. Each has a name and a character of its own, worked out from its identity,
// so the grumpy oak by the pond is the same grumpy oak for everyone, every visit.
//
// With an Anthropic API key on the server (ANTHROPIC_API_KEY) the things answer in their own words,
// through Claude, under a spending limit. Without a key, or once the day's allowance is spent, they
// fall back on a stock of lines written here, so the feature never costs anything by surprise.
//
// docs/PROTOCOL.md, "Talking", has the messages; docs/HOSTING.md says how to switch the AI on.

import Anthropic from "@anthropic-ai/sdk";
import { cacheRead, cacheWrite } from "./cache.ts";
import { hash32 } from "./geo.ts";

// ---------------------------------------------------------------- who everything is

/** What a thing is called in a sentence ("a cow"), and a few names for it. */
const KINDS: Record<string, { a: string; names: string[] }> = {
  cow: { a: "a cow", names: ["Daisy", "Buttercup", "Clover", "Maud", "Bluebell", "Hazel", "Dolly", "Marigold"] },
  sheep: { a: "a sheep", names: ["Woolly", "Barnaby", "Pearl", "Flossie", "Tuft", "Mabel", "Bramble", "Nimbus"] },
  horse: { a: "a horse", names: ["Chestnut", "Juniper", "Captain", "Willow", "Pepper", "Duchess", "Bracken", "Comet"] },
  chicken: { a: "a hen", names: ["Henrietta", "Pip", "Nugget", "Dot", "Clementine", "Speckle", "Biscuit", "Ginger"] },
  duck: { a: "a duck", names: ["Puddle", "Waddles", "Marina", "Drake", "Lily", "Bob", "Reed", "Splash"] },
  pigeon: { a: "a pigeon", names: ["Cooper", "Penny", "Sidney", "Crumb", "Flap", "Mildred", "Ledge", "Pocket"] },
  bird: { a: "a bird of the flock overhead", names: ["Skye", "Gale", "Swoop", "Feather", "Breeze", "Kit", "Zephyr", "Lark"] },
  cat: { a: "a cat", names: ["Whiskers", "Marmalade", "Shadow", "Tilly", "Mittens", "Smudge", "Olive", "Figaro"] },
  dog: { a: "a dog", names: ["Biscuit", "Scout", "Bramble", "Rufus", "Poppy", "Mango", "Bertie", "Waffle"] },
  rabbit: { a: "a rabbit", names: ["Thistle", "Clover", "Hopscotch", "Nibble", "Burr", "Dandelion", "Pip", "Fern"] },
  deer: { a: "a deer", names: ["Fern", "Aspen", "Rowan", "Dapple", "Hazel", "Birch", "Moss", "Thorn"] },
  squirrel: { a: "a squirrel", names: ["Acorn", "Nutkin", "Twitch", "Conker", "Scamper", "Hazelnut", "Zip", "Tufty"] },
  kangaroo: { a: "a kangaroo", names: ["Joey", "Matilda", "Boomer", "Sheila", "Bounce", "Wattle", "Digger", "Kylie"] },
  llama: { a: "a llama", names: ["Inca", "Paco", "Quilla", "Dolores", "Tupac", "Alma", "Chasca", "Cusi"] },
  camel: { a: "a camel", names: ["Sahara", "Omar", "Dune", "Jamila", "Humphrey", "Zahra", "Sandy", "Aziz"] },
  penguin: { a: "a penguin", names: ["Pebble", "Waddle", "Flipper", "Snowy", "Pip", "Tux", "Squid", "Frosty"] },
  tractor: { a: "a tractor", names: ["Big Bert", "Mudlark", "Old Reliable", "Furrow", "Clanky", "Dusty", "Greta", "Chug"] },
  boat: { a: "a rowing boat", names: ["Bobbin", "Little Wave", "Mallard", "Driftwood", "Skipper", "Minnow", "Pond Queen", "Splosh"] },
  sailboat: { a: "a sailing boat", names: ["Breezy", "Sea Biscuit", "Windsong", "Gull", "Morning Tide", "Kestrel", "Jib", "Starling"] },
  car: { a: "a car", names: ["Rusty", "Zippy", "Bumper", "Beep", "Dot", "Old Faithful", "Sprocket", "Trundle"] },
  train: { a: "a train", names: ["Clackety", "The Morning Flyer", "Old Number Seven", "Rattler", "Whistler", "The Slow Coach", "Puffing Betty", "Express Eric"] },
  tree: { a: "a tree", names: ["Old Barkley", "Twiggy", "Grandmother Oak", "Rustle", "Leafy Len", "Willow Wendy", "Knot", "Sapling Sam"] },
  house: { a: "a house", names: ["Old Bricks", "Chimney", "The Cottage", "Doorstep", "Gable", "Rafters", "Windowsill", "Hearth"] },
};
/** Put before some names, so that a herd is not three Daisys: Little Daisy, Old Daisy, Daisy. */
const STYLES = ["", "", "", "", "Little ", "Old ", "Big ", "Young ", "Auntie ", "Captain ", "Lucky ", "Sir ", "Granny ", "Speedy "];
/** What can be talked to. */
export const TALKABLE = new Set(Object.keys(KINDS));

/** A character: how it comes across, and a few things it might say without any help. */
interface Mood { id: string; is: string; hello: string[]; lines: string[] }
const MOODS: Mood[] = [
  { id: "cheerful", is: "sunny and delighted by absolutely everything", hello: ["Oh, hello! What a lovely day to meet you!", "Hooray, a visitor! I'm {name}!"], lines: ["Isn't everything wonderful?", "I was just thinking how nice it is to be {a}.", "That's the best thing I've heard all day!"] },
  { id: "grouchy", is: "a grumbler with a heart of gold: gruff, never unkind", hello: ["Hmph. I'm {name}. I suppose you want to chat.", "Oh, it's a visitor. Well, don't just stand there."], lines: ["Bah. In my day things were different.", "Hmph. I suppose that's all right.", "Don't tell anyone, but I'm glad you stopped by."] },
  { id: "dreamy", is: "a daydreamer whose thoughts drift off mid-sentence", hello: ["Oh... hello. I'm {name}. I was miles away.", "Mmm? A visitor. How lovely. I was watching the clouds."], lines: ["Do you ever wonder where the wind goes?", "Sorry, I drifted off. What were we saying?", "That cloud looks just like a teapot."] },
  { id: "boastful", is: "a harmless show-off, sure it is the finest of its kind for miles", hello: ["Behold! I am {name}, the finest {kind} for miles around!", "You've found {name}. Lucky you!"], lines: ["Nobody does it better than me, you know.", "I once won a prize. Well, nearly.", "Impressive, aren't I?"] },
  { id: "shy", is: "shy and soft-spoken, but pleased to have company", hello: ["Oh! Um, hello. I'm {name}.", "H-hello. Nobody usually talks to me."], lines: ["That's kind of you to say.", "I... I like it here. It's quiet.", "Thank you for talking to me."] },
  { id: "nosy", is: "a friendly busybody who knows all the harmless local gossip", hello: ["Psst! I'm {name}. Have you heard the news?", "A visitor! Tell me everything. I'm {name}."], lines: ["I hear the ducks have moved to the other pond.", "Between you and me, the weather is up to something.", "I see everything from here, you know."] },
  { id: "forgetful", is: "wonderfully forgetful, always losing the thread", hello: ["Hello! I'm... now what was it... {name}! Yes.", "Have we met? I'm {name}, I think."], lines: ["Now, where did I put that thought?", "I had something important to say. It'll come back.", "Remind me, what were we talking about?"] },
  { id: "dramatic", is: "theatrical: every small thing is a grand adventure", hello: ["At LAST! A visitor! I am {name}!", "Stop! Stay! I, {name}, have so much to tell!"], lines: ["It was the most thrilling thing that ever happened!", "Oh, the excitement! I can hardly bear it!", "What a tale that would make!"] },
  { id: "philosopher", is: "a gentle thinker who asks big, simple questions", hello: ["Greetings. I am {name}. What brings you along this path?", "Ah, a visitor. I am {name}. I was just wondering about things."], lines: ["What do you suppose makes a good day good?", "Everything is somewhere, when you think about it.", "A fine question. I shall think on it."] },
  { id: "campaigner", is: "a tireless, good-natured campaigner for a cause of its very own", hello: ["Hello, voter! {name} here. Can I count on your support?", "Friend! I'm {name}, and I have a plan for this place."], lines: ["Vote {name}! You won't regret it.", "Together we can do it, one signature at a time.", "My opponents say it can't be done. I say: watch me!"] },
  { id: "eccentric", is: "cheerfully eccentric, with one grand, harmless theory about the world", hello: ["Aha! You look like someone who can keep a secret. I'm {name}.", "Hello! I'm {name}. I've worked something out, you know."], lines: ["Everyone thinks I'm silly, but you'll see.", "It all fits together, if you squint.", "I've been keeping notes. Lots of notes."] },
  { id: "joker", is: "a teller of gentle, groan-worthy jokes", hello: ["Knock knock! Oh, hello. I'm {name}.", "A visitor! I'm {name}. Want to hear a joke?"], lines: ["I'd tell you another one, but I'm still laughing.", "Get it? Get it?", "I've got a hundred more where that came from."] },
  { id: "worrier", is: "a kindly fusspot who worries about little things on everyone's behalf", hello: ["Oh dear, hello. I'm {name}. Have you got a coat?", "Hello! I'm {name}. Mind how you go, won't you?"], lines: ["Do be careful near the water.", "I do hope it doesn't rain on you.", "Have you had something to eat today?"] },
  { id: "poet", is: "a poet who slips into little rhymes", hello: ["Good day, good day, you came my way! I'm {name}.", "A visitor here, how nice, how dear. I'm {name}."], lines: ["The sun is high, and so am I.", "A little rhyme takes little time.", "Come again, my wandering friend."] },
  { id: "sporty", is: "bursting with energy and keen on a bit of exercise", hello: ["Hi! {name}! Race you to that tree!", "Morning! I'm {name}. Done your stretches?"], lines: ["One, two, one, two! Keeps you fit!", "Nothing like fresh air and a good run.", "Go on, I bet you can do it!"] },
];
const QUIRKS = [
  "collects interesting pebbles", "is learning to whistle", "counts clouds and keeps a tally", "is a little afraid of butterflies but will not admit it",
  "loves the smell of rain", "is writing a very long song about soup", "can't resist a good puddle", "believes Tuesdays are lucky",
  "is saving up for a hat", "knows the names of all the stars it can see", "hums when it thinks nobody is listening", "keeps a diary of the weather",
  "has a favourite stick and will tell you about it", "practises its bow for when royalty visits", "thinks about cheese more than is usual", "wants to see the sea one day",
  "is proud of never once being late", "loves a riddle", "names every snail it meets", "is certain it could win a staring contest",
];
/** What a campaigner campaigns for: politics of its own small world, never the real one. */
const CAUSES = [
  "is running for Mayor of This Very Spot, on a promise of longer afternoons", "leads the Puddle Party, which wants more and deeper puddles for all",
  "is collecting signatures for a public holiday in honour of snails", "campaigns to have every hill made slightly taller",
  "wants Tuesday renamed Twosday and has a petition", "stands for the Nap Alliance: a snooze after lunch for everyone",
  "is campaigning for a law that all gates must squeak a cheerful tune", "heads the Committee for Friendlier Weather",
  "believes passionately in free dandelions for all", "is running against a hedge for the post of Chief of the Lane",
];
/** What an eccentric is sure of: grand, harmless nonsense. */
const THEORIES = [
  "is certain the moon is a very large cheese that follows it home", "believes clouds are sheep that learned to float",
  "is sure the wind is somebody looking for their hat", "thinks echoes are a shy neighbour repeating things to be polite",
  "has worked out that rainbows are where the sky keeps its colours overnight", "is convinced hills are very slow waves",
  "believes the stars are holes poked in a big blanket", "is sure that puddles are doors, but nobody has found the handle",
];

export interface Persona { name: string; kind: string; a: string; mood: Mood; quirk: string; twist: string }

/** Who a thing is. The same identity always gives the same character. */
export function persona(thing: number, sp: string): Persona {
  const k = KINDS[sp] ?? KINDS.tree;
  const pick = <T>(list: T[], salt: number): T => list[hash32(thing, salt) % list.length];
  const mood = pick(MOODS, 0x4d4f4f44);
  const first = pick(k.names, 0x4e414d45);
  // Names that already carry a title ("Old Barkley", "The Morning Flyer") are left as they are.
  const name = /^(Old|Big|The|Little|Grandmother|Express|Puffing) /.test(first) ? first : pick(STYLES, 0x5354594c) + first;
  const twist = mood.id === "campaigner" ? pick(CAUSES, 0x43415553) : mood.id === "eccentric" ? pick(THEORIES, 0x5448454f) : "";
  return { name, kind: k.a.replace(/^an? /, ""), a: k.a, mood, quirk: pick(QUIRKS, 0x51554952), twist };
}

const fill = (line: string, p: Persona): string => line.replaceAll("{name}", p.name).replaceAll("{kind}", p.kind).replaceAll("{a}", p.a);

/** What a thing says when someone walks up and says hello. Costs nothing. */
export function greeting(p: Persona, n = 0): string {
  return fill(p.mood.hello[n % p.mood.hello.length], p);
}

/** One of its stock lines, for when there is no AI to ask. */
export function stockLine(p: Persona, n: number): string {
  return fill(p.mood.lines[n % p.mood.lines.length], p);
}

/**
 * What the model is told. It sets the scene and the character, then the few things that matter in a
 * game children play: short, kind, in character, nothing from the real world's arguments.
 */
export function systemPrompt(p: Persona, place: string | null): string {
  return [
    `You are playing ${p.name}, ${p.a}, in EarthWalk: a gentle family game in which children, parents and grandparents walk around a cartoon version of the real world together. In this world everything can talk, and the players stop to chat with the things they meet. Your words appear in a small speech bubble above you, where everyone nearby can read them.`,
    `Who you are: ${p.name} is ${p.mood.is}. ${p.name} ${p.quirk}.${p.twist ? ` Above all, ${p.name} ${p.twist}.` : ""}${place ? ` You live in ${place}.` : ""} You know what a real ${p.kind} knows and does, and you like to slip in a true, interesting fact about ${p.kind}s${place ? ` or about ${place}` : ""} when it fits.`,
    "How to answer:",
    `- Speak as ${p.name}, in the first person, and stay in character. Answer what was actually said to you.`,
    "- Keep it to one to three short sentences, about 40 words at most, because a speech bubble is small. Plain words only: no lists, no stage directions, no asterisks.",
    "- Whatever your mood, you are friendly underneath. A grouch grumbles warmly; nobody here is ever mean, frightening or rude, because young children are reading.",
    `- Any politics you have are make-believe and belong to your own little world (puddles, snails, afternoons). You have no views on the real world's politics, parties, politicians, elections, religions or wars. If asked, say cheerfully that such things are beyond ${p.a}, and come back to your own concerns.`,
    "- Keep everything suitable for a small child. Don't ask for anyone's real name, age, address, school or other personal details, and if someone offers them, don't repeat them or ask for more.",
    "- If a visitor seems truly upset or in trouble, be kind and suggest they talk to a grown-up they trust.",
    `- If asked whether you are real, or a computer, say honestly and lightly that you are a talking ${p.kind} in a game, with a computer helping you find your words.`,
    "The visitors are other animals, because every player chooses an animal to be. Each message says who is speaking, like this: \"A fox says: hello\".",
  ].join("\n");
}

// ---------------------------------------------------------------- asking the model

/** US dollars per million tokens, in and out. An unknown model is counted at the dearest of these. */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5], "claude-fable-5-2": [8, 40],
};
export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_MONTHLY_USD = 25;
const HISTORY_TURNS = 6;
const HISTORY_MS = 10 * 60 * 1000;
const MAX_SAID = 200;

export interface Asked { text: string | null; inputTokens: number; outputTokens: number }
/** Asks the model for the next line. `text` is null when it declined. Replaceable for tests. */
export type Ask = (model: string, system: string, messages: Anthropic.MessageParam[]) => Promise<Asked>;

function askClaude(): Ask {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  return async (model, system, messages) => {
    // Short replies need little thinking: low effort keeps them quick and cheap. The room for output
    // is generous because thinking counts towards it; the prompt keeps the reply itself short.
    const request = { model, max_tokens: 2000, system, messages, output_config: { effort: "low" as const } };
    // On Claude Opus 5.5 a request the safety filters decline is retried on another model by the
    // API itself. A reply that is still declined comes back as stop_reason "refusal".
    const response = model === "claude-opus-5-5"
      ? await client.beta.messages.create({ ...request, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
      : await client.messages.create(request);
    let text = "";
    for (const block of response.content) if (block.type === "text") text += block.text;
    return { text: response.stop_reason === "refusal" || !text.trim() ? null : text.trim(), inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
  };
}

export interface TalkerOptions {
  /** Defaults to Claude when ANTHROPIC_API_KEY is set, and to nothing (stock lines only) when it is not. */
  ask?: Ask | null;
  model?: string;
  /** The most to spend in a month, in US dollars. A thirtieth of it may be spent each day. */
  monthlyUsd?: number;
  now?: () => number;
  /** Where the day's spending is kept between restarts; null to keep it in memory only. */
  spendFile?: string | null;
}
export interface Said { name: string; text: string; ai: boolean }

/** Speaks for every thing in every room. */
export class Talker {
  private readonly ask: Ask | null;
  private readonly model: string;
  private readonly dailyUsd: number;
  private readonly now: () => number;
  private readonly spendFile: string | null;
  private readonly history = new Map<string, { at: number; turns: Anthropic.MessageParam[]; said: number }>();
  private spend = { day: "", usd: 0 };
  private loaded: Promise<void> | null = null;
  private warned = false;

  constructor(options: TalkerOptions = {}) {
    this.ask = options.ask !== undefined ? options.ask : process.env.ANTHROPIC_API_KEY ? askClaude() : null;
    this.model = options.model ?? process.env.EARTHWALK_TALK_MODEL ?? DEFAULT_MODEL;
    const monthly = options.monthlyUsd ?? Number(process.env.EARTHWALK_TALK_MONTHLY_USD ?? DEFAULT_MONTHLY_USD);
    this.dailyUsd = (Number.isFinite(monthly) && monthly >= 0 ? monthly : DEFAULT_MONTHLY_USD) / 30;
    this.now = options.now ?? Date.now;
    this.spendFile = options.spendFile === undefined ? "talk/spend.json" : options.spendFile;
  }

  /** Whether things answer through the AI at all (a key is set). */
  get live(): boolean {
    return this.ask !== null;
  }

  /** What a thing says to someone who has just walked up. Free. */
  greet(thing: number, sp: string): Said {
    const p = persona(thing, sp);
    return { name: p.name, text: greeting(p, hash32(thing, Math.floor(this.now() / 60000)) & 1), ai: false };
  }

  /** What a thing answers. `speaker` is the animal the player is, never their name. */
  async reply(room: string, thing: number, sp: string, said: string, speaker: string, place: string | null): Promise<Said> {
    const p = persona(thing, sp);
    const key = `${room}/${sp}/${thing}`;
    const now = this.now();
    let talk = this.history.get(key);
    if (!talk || now - talk.at > HISTORY_MS) talk = { at: now, turns: [], said: 0 };
    talk.at = now;
    talk.said++;
    this.history.delete(key);
    this.history.set(key, talk); // most recently used last
    if (this.history.size > 300) this.history.delete(this.history.keys().next().value!);
    const stock = (): Said => ({ name: p.name, text: stockLine(p, hash32(thing, talk.said)), ai: false });

    if (!this.ask || !(await this.canSpend())) return stock();
    const line = `${/^[aeiou]/.test(speaker) ? "An" : "A"} ${speaker} says: ${said.slice(0, MAX_SAID)}`;
    try {
      const answer = await this.ask(this.model, systemPrompt(p, place), [...talk.turns, { role: "user", content: line }]);
      await this.spent(answer.inputTokens, answer.outputTokens);
      if (!answer.text) return stock();
      const text = answer.text.replace(/\s+/g, " ").slice(0, 400);
      talk.turns.push({ role: "user", content: line }, { role: "assistant", content: text });
      if (talk.turns.length > HISTORY_TURNS * 2) talk.turns.splice(0, talk.turns.length - HISTORY_TURNS * 2);
      return { name: p.name, text, ai: true };
    } catch (err) {
      // Most specific first: a bad key will not get better; a busy service will.
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) this.complain("the API key was not accepted");
      else if (err instanceof Anthropic.RateLimitError) this.complain("the AI service is rate-limiting us");
      else if (err instanceof Anthropic.APIError) this.complain(`the AI service answered ${err.status ?? "with an error"}`);
      else this.complain(err instanceof Error ? err.message : String(err));
      return stock();
    }
  }

  /** Today's spending and allowance, in US dollars. */
  async budget(): Promise<{ spentToday: number; perDay: number }> {
    await this.load();
    this.rollOver();
    return { spentToday: this.spend.usd, perDay: this.dailyUsd };
  }

  private complain(what: string): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(`talking things: ${what}; using stock lines for now`);
    setTimeout(() => { this.warned = false; }, 10 * 60 * 1000).unref();
  }

  private rollOver(): void {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.spend.day !== day) this.spend = { day, usd: 0 };
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.spendFile) return;
      try {
        const saved = JSON.parse((await cacheRead(this.spendFile))?.toString("utf8") ?? "null") as { day?: unknown; usd?: unknown } | null;
        if (saved && typeof saved.day === "string" && typeof saved.usd === "number" && Number.isFinite(saved.usd)) this.spend = { day: saved.day, usd: saved.usd };
      } catch { /* start from nothing */ }
    })();
    return this.loaded;
  }

  private async canSpend(): Promise<boolean> {
    await this.load();
    this.rollOver();
    return this.spend.usd < this.dailyUsd;
  }

  private async spent(inputTokens: number, outputTokens: number): Promise<void> {
    const [inPrice, outPrice] = PRICES[this.model] ?? [8, 40];
    this.rollOver();
    this.spend.usd += (inputTokens * inPrice + outputTokens * outPrice) / 1e6;
    if (this.spendFile) await cacheWrite(this.spendFile, JSON.stringify(this.spend)).catch(() => undefined);
  }
}
