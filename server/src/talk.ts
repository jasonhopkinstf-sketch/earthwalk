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
  pig: { a: "a pig", names: ["Truffle", "Hamlet", "Snuffles", "Petal", "Wallow", "Rosie"] },
  goat: { a: "a goat", names: ["Billy", "Nanny", "Gruff", "Pepper", "Clover", "Nibbles"] },
  donkey: { a: "a donkey", names: ["Dusty", "Hector", "Clementine", "Bramble", "Jack", "Jenny"] },
  goose: { a: "a goose", names: ["Gertrude", "Hiss", "Waddles", "Gander", "Mabel", "Honker"] },
  mouse: { a: "a mouse", names: ["Pip", "Crumb", "Whisker", "Nib", "Squeak", "Thimble"] },
  hedgehog: { a: "a hedgehog", names: ["Bristle", "Prickles", "Conker", "Hazel", "Snuffle", "Thistle"] },
  fox: { a: "a fox", names: ["Russet", "Ember", "Sly", "Fern", "Rusty", "Vixen"] },
  frog: { a: "a frog", names: ["Hopper", "Lily", "Croaker", "Puddle", "Bog", "Jeremy"] },
  snail: { a: "a snail", names: ["Shelly", "Dawdle", "Glimmer", "Spiral", "Trail", "Slowpoke"] },
  tortoise: { a: "a tortoise", names: ["Methuselah", "Shellby", "Plod", "Dome", "Herbert", "Lettuce"] },
  crab: { a: "a crab", names: ["Pincer", "Scuttle", "Sideways", "Clack", "Sandy", "Nipper"] },
  beaver: { a: "a beaver", names: ["Chip", "Timber", "Gnaw", "Lodge", "Paddle", "Birch"] },
  otter: { a: "an otter", names: ["Ripple", "Slip", "Tarka", "Pebble", "Whisk", "Brook"] },
  swan: { a: "a swan", names: ["Odette", "Regal", "Snow", "Glide", "Duchess", "Pearl"] },
  heron: { a: "a heron", names: ["Stilt", "Grey", "Patience", "Lanky", "Reed", "Spear"] },
  seagull: { a: "a seagull", names: ["Chip Thief", "Squall", "Gully", "Breezy", "Salt", "Kipper"] },
  sparrow: { a: "a sparrow", names: ["Chirp", "Twig", "Flit", "Crumbs", "Dot", "Peep"] },
  flamingo: { a: "a flamingo", names: ["Rosa", "Stiltskin", "Blush", "Coral", "Shrimp", "Pinky"] },
  seal: { a: "a seal", names: ["Flipper", "Blubber", "Sleek", "Bark", "Pebbles", "Wave"] },
  butterfly: { a: "a butterfly", names: ["Flutter", "Petal", "Dapple", "Blink", "Waft", "Marigold"] },
  bee: { a: "a bee", names: ["Buzz", "Honey", "Pollen", "Bumble", "Clover", "Hum"] },
  dragonfly: { a: "a dragonfly", names: ["Dart", "Shimmer", "Zip", "Skim", "Glint", "Needle"] },
  ladybird: { a: "a ladybird", names: ["Dot", "Spot", "Scarlet", "Polka", "Seven", "Ruby"] },
  ant: { a: "an ant", names: ["Number Nine", "Marcher", "Crumb Carrier", "Tiny", "Sergeant", "Hup"] },
  grasshopper: { a: "a grasshopper", names: ["Spring", "Fiddle", "Leap", "Blade", "Chirrup", "Bounce"] },
  elephant: { a: "an elephant", names: ["Tembo", "Ellie", "Trunk", "Jumbo", "Peanut", "Matriarch May"] },
  giraffe: { a: "a giraffe", names: ["Stretch", "Lofty", "Acacia", "Patches", "Twiga", "High Up Henry"] },
  zebra: { a: "a zebra", names: ["Stripes", "Zigzag", "Domino", "Barcode", "Dazzle", "Pyjamas"] },
  lion: { a: "a lion", names: ["Leo", "Mane", "Sunny", "Rumble", "Nala", "Yawn"] },
  monkey: { a: "a monkey", names: ["Chatter", "Banana", "Swing", "Mischief", "Coco", "Peanut"] },
  panda: { a: "a panda", names: ["Bamboo", "Dumpling", "Mochi", "Roly", "Bao", "Snooze"] },
  koala: { a: "a koala", names: ["Gumleaf", "Doze", "Eucalyptus Ed", "Cuddles", "Blinky", "Matilda"] },
  owl: { a: "an owl", names: ["Hoot", "Minerva", "Blink", "Tawny", "Midnight", "Professor Wing"] },
  bear: { a: "a bear", names: ["Bruin", "Honey", "Grumble", "Berry", "Ursula", "Big Paws"] },
  moose: { a: "a moose", names: ["Antlers", "Marsh", "Bullwinkle", "Timber", "Maple", "Lumber"] },
  bison: { a: "a bison", names: ["Thunder", "Prairie", "Shaggy", "Dakota", "Rumble", "Tatanka"] },
  reindeer: { a: "a reindeer", names: ["Comet", "Frost", "Lichen", "Tundra", "Jingle", "Snowdrop"] },
  capybara: { a: "a capybara", names: ["Mellow", "Chill", "Mud", "Bubbles", "Siesta", "Cappy"] },
  marmot: { a: "a marmot", names: ["Whistle", "Boulder", "Alp", "Chubby", "Lookout", "Scree"] },
  car: { a: "a car", names: ["Rusty", "Zippy", "Bumper", "Beep", "Dot", "Old Faithful", "Sprocket", "Trundle"] },
  taxi: { a: "a taxi", names: ["Meter", "Hackney", "Checker", "Cabby", "Detour", "Honk", "Kerbside", "Fare"] },
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

/** What a kind of thing is called, with its article: "a cow", "an otter", "a hen". */
export const aKind = (sp: string): string => (KINDS[sp] ?? KINDS.tree).a;

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

// ---------------------------------------------------------------- people at work, and out for the day

/**
 * What somebody inside a shop, a café, an office, a mall or an entrance hall does there (venues.ts): how the
 * AI is told of it, what they say when a visitor walks up, and a few lines for when there is no AI to ask.
 * `{place}` is the name of the place, or "this shop"; `{name}` their own.
 */
export const ROLES: Record<string, { is: string; hello: string[]; lines: string[] }> = {
  worker: { is: "work at a desk in {place}", hello: ["Hello! I'm {name}. I work here. Mind the cables.", "Oh, a visitor! I'm {name}. Just answering my letters."], lines: ["So many letters to answer, and it's nearly lunch.", "My screen says there are forty-two things to do. I've done two.", "The best part of the day is the biscuit tin in the kitchen."] },
  meeting: { is: "are in a meeting in {place}, which has gone on rather a long time", hello: ["Shh... we're in a meeting. I'm {name}. It's about the biscuits.", "Hello! I'm {name}. This meeting was meant to end an hour ago."], lines: ["We have agreed to have another meeting about it.", "Does anyone remember what we were deciding?", "I vote for more plants in the office. All in favour?"] },
  reception: { is: "look after the front desk of {place} and welcome everyone who comes in", hello: ["Welcome to {place}! I'm {name}. Go right through: there's a door on the other side.", "Good day! I'm {name}, at the front desk of {place}."], lines: ["You can walk straight through, you know. Everybody does.", "If you're looking for the kitchen, follow the smell of toast.", "Sign the visitors' book? We haven't got one. Come in anyway."] },
  keeper: { is: "keep the shop at {place} and are proud of everything on its shelves", hello: ["Welcome to {place}! I'm {name}. Have a good look round.", "Hello! I'm {name}. This is my shop. Mind the bottom shelf."], lines: ["Everything on that shelf is my favourite.", "I dust the shelves every morning, and they know it.", "Take your time. The door at the back is open too."] },
  barista: { is: "make the drinks and serve the food at {place}", hello: ["Hello! I'm {name}. What can I get you? Press B to see what we have.", "Welcome to {place}! I'm {name}. The kettle's just boiled."], lines: ["Press B at the counter and you can see what's on today.", "One hot chocolate with extra froth is my masterpiece.", "Everything tastes better if you sit by the window."] },
  shopper: { is: "are out shopping in {place}, with a list you keep losing", hello: ["Oh, hello! I'm {name}. I only came in for one thing.", "Hi! I'm {name}. Have you seen what they've got in here?"], lines: ["I came for socks and I'm leaving with a lamp.", "My list said one thing. I can't read my own writing.", "I do like a good look round the shops."] },
  guest: { is: "are having something to eat and drink at {place}, in no hurry at all", hello: ["Hello! I'm {name}. The cake here is very good.", "Oh, hello. I'm {name}. Just having a sit down."], lines: ["I could sit here all afternoon. I think I will.", "Try the cake. Then tell me which one, so I can try it too.", "It's the best seat in the house, this one."] },
  caretaker: { is: "are the caretaker of {place}: you sort the letters and keep the hall tidy", hello: ["Morning! I'm {name}, the caretaker. Wipe your feet, please.", "Hello! I'm {name}. I look after this building."], lines: ["The lift's working today. I fixed it myself.", "Number seven never collects their letters.", "You can go out by the other door, if you like. Saves walking round."] },
  resident: { is: "live in one of the flats upstairs at {place}", hello: ["Hello! I'm {name}. I live upstairs.", "Oh, hi! I'm {name}. Just waiting for the lift."], lines: ["My window looks right over the street. I see everything.", "The lift takes its time. So do I.", "It's a friendly building. Mostly."] },
  warden: { is: "look after {place}: you open the doors, keep it tidy and welcome everyone who comes in", hello: ["Welcome to {place}. I'm {name}. Come in and look round, as long as you like.", "Hello, I'm {name}. I look after {place}. Everyone is welcome here."], lines: ["It's quiet in here. People come in just to sit a while.", "Look up at the windows when the sun comes through them.", "You can go out by the other door, if you like."] },
  musician: { is: "play the organ at {place}, and are practising", hello: ["Hello! I'm {name}. I'm only practising. Mind the loud bit.", "Oh! I'm {name}. Did I play a wrong note? I thought nobody was listening."], lines: ["The longest pipe makes a note so low you feel it in your feet.", "I have played this tune a hundred times. Number ninety-nine was the best.", "Two hands, two feet, and I still run out."] },
  singer: { is: "sing in the choir at {place}", hello: ["Hello! I'm {name}. We're just warming up. La la la!", "Hi, I'm {name}. I sing the low notes. Somebody has to."], lines: ["We practise every week, and we are nearly in tune.", "I always come in one beat early. It's my thing.", "Sing with us, if you like. Nobody minds a wrong note."] },
  visitor: { is: "are visiting {place} for a little while", hello: ["Hello. I'm {name}. I only came in for a minute.", "Oh, hello! I'm {name}. Just visiting."], lines: ["It's nice to sit somewhere quiet for a bit.", "I like it here. It makes the day slow down.", "I'll be off in a minute. Probably."] },
  teacher: { is: "are a teacher at {place}, in the middle of a lesson", hello: ["Good morning! I'm {name}. Find a seat, we've only just started.", "Hello! I'm {name}. I teach here. No running in the corridor, please."], lines: ["Who can tell me what seven times eight is? Anyone?", "The best questions are the ones I can't answer.", "Hands up if you can hear me. Good. Hands down."] },
  pupil: { is: "are a pupil at {place}, and would rather it were playtime", hello: ["Hi! I'm {name}. Is it playtime yet?", "Hello! I'm {name}. I'm meant to be doing my sums."], lines: ["I know the answer! No, wait. I knew it a minute ago.", "My pencil keeps going blunt on purpose.", "After this it's lunch. I can smell it from here."] },
  doctor: { is: "are a doctor at {place}, on your rounds", hello: ["Hello! I'm Doctor {name}. Nothing to worry about. Say aah!", "Good day, I'm Doctor {name}. You look very well to me."], lines: ["An apple a day is good. Two is a snack.", "Plenty of sleep, plenty of water, and a walk every day.", "Everyone in here is getting better. That's my favourite thing."] },
  nurse: { is: "are a nurse at {place}, and look after everyone staying there", hello: ["Hello, I'm Nurse {name}. Wash your hands, and in you come.", "Hi! I'm {name}, one of the nurses. Mind the trolley."], lines: ["I walk miles along this corridor every day.", "Bed three wants another story. Bed three always does.", "Visitors make everybody feel better. Thank you for coming."] },
  foreman: { is: "are in charge of the floor at {place}, with a list of everything that has to go out today", hello: ["Hello! I'm {name}. Keep between the yellow lines and you'll be fine.", "Morning! I'm {name}. I'm in charge here, more or less."], lines: ["Forty boxes out by teatime. We've done thirty-nine.", "If it beeps, stand back. If it stops beeping, stand further back.", "You can walk straight through to the other door. Yellow lines all the way."] },
  maker: { is: "work at the machines at {place}, making things", hello: ["Hello! I'm {name}. Mind your fingers near the belt.", "Hi! I'm {name}. This machine and I understand each other."], lines: ["It goes in at that end and comes out at this end. The middle is a mystery.", "I press the green button. Nobody presses the red one.", "Every box on that belt has been looked at by me, personally."] },
  packer: { is: "fetch, carry and stack the crates at {place}", hello: ["Hello! I'm {name}. If you want something, it's on the top shelf. It always is.", "Hi, I'm {name}. Mind the fork-lift, it has a mind of its own."], lines: ["Aisle three, shelf two. Or aisle two, shelf three. One of those.", "I know where every crate is. I just don't know what's in them.", "Heavy ones at the bottom. I learned that the hard way."] },
  patient: { is: "are a patient at {place}, getting better, and a bit bored", hello: ["Hello! I'm {name}. I'm much better today, thank you.", "Oh, a visitor! I'm {name}. Did you bring grapes?"], lines: ["The doctor says I'll be out and about in no time.", "I have counted the ceiling tiles. There are a lot.", "The best thing here is the jelly."] },
};
/** What the place somebody is in is called in a sentence: its name, or what it is. */
const PLACES_ARE: Record<string, string> = {
  office: "this office", shop: "this shop", cafe: "this café", mall: "these shops", lobby: "this building",
  church: "this church", mosque: "this mosque", temple: "this temple", school: "this school", hospital: "this hospital", clinic: "this clinic",
  factory: "this factory", warehouse: "this warehouse", fuel: "this petrol station",
};
export interface Job { role: string; place: string }
/** Somebody's job from the role a game says they have and the place it says they are in; null for a role nobody has. */
export function jobOf(role: unknown, where: { use?: string; name?: string } | null): Job | null {
  if (typeof role !== "string" || !Object.hasOwn(ROLES, role)) return null;
  return { role, place: where?.name?.trim() || PLACES_ARE[where?.use ?? ""] || "this place" };
}
const atWork = (line: string, p: Persona, job: Job): string => fill(line, p).replaceAll("{place}", job.place);

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
export function systemPrompt(p: Persona, place: string | null, sp = ""): string {
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
    ...(deedsOf(sp).length ? [
      `You can also do things when a visitor plainly asks: ${deedsOf(sp).map((d) => DEEDS[d]).join("; ")}. To do one, answer in words as usual (say you are doing it, in your own way) and call the \`do\` tool as well. Do it gladly, whatever your mood: a grouch grumbles and does it anyway. If they ask for something not on that list, say kindly that it is beyond ${p.a}. Don't call the tool unless they asked.`,
      ...(deedsOf(sp).includes("goto") ? ["You can only take someone to a place while they are riding you; the message says when they are. If they ask to be taken somewhere and are not riding, tell them to hop on first (the E key) and ask again."] : []),
    ] : []),
  ].join("\n");
}

// ---------------------------------------------------------------- doing as asked

/** Things a player can ask a thing to do. */
export type Deed = "follow" | "come" | "stay" | "home" | "trick" | "noise" | "goto";
/** What a player asked for: a deed, and for `goto` the place as they said it. */
export interface Wish { deed: Deed; place?: string }
const DEEDS: Record<Deed, string> = {
  follow: "follow them wherever they walk",
  come: "come over to where they are standing",
  stay: "stop and wait where you are",
  home: "go back to what you were doing before",
  trick: "do a trick (a jump and a spin)",
  noise: "make your sound",
  goto: "carry them to a place they name",
};
const STEEDS = new Set(["horse", "cow", "sheep", "camel", "llama", "kangaroo", "deer", "donkey", "pig", "goat", "zebra", "elephant", "giraffe", "bison", "moose", "reindeer", "bear", "lion", "panda", "tortoise"]);
const WALKERS = new Set(["chicken", "duck", "pigeon", "cat", "dog", "rabbit", "squirrel", "penguin", "goose", "mouse", "hedgehog", "fox", "frog", "snail", "crab", "beaver", "otter", "swan", "heron", "seagull", "sparrow", "flamingo", "seal",
  "butterfly", "bee", "dragonfly", "ladybird", "ant", "grasshopper", "monkey", "koala", "capybara", "marmot"]);

/** What each kind of thing is able to do when asked. Trees, houses and boats only talk. */
export function deedsOf(sp: string): Deed[] {
  if (STEEDS.has(sp)) return ["follow", "come", "stay", "home", "trick", "noise", "goto"];
  if (WALKERS.has(sp)) return ["follow", "come", "stay", "home", "trick", "noise"];
  if (sp === "car" || sp === "tractor" || sp === "taxi") return ["stay", "home", "noise", "goto"];
  if (sp === "train") return ["noise"];
  return [];
}

/**
 * Understands a few plain words without any AI: "follow me", "come here", "stay", "go home",
 * "jump", "moo", "take me to the beach". Null when nothing was asked that this kind of thing can do.
 */
export function wishFrom(said: string, sp: string): Wish | null {
  const can = deedsOf(sp);
  const s = ` ${said.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim()} `;
  const to = /\b(?:take|carry|drive|bring|ride) (?:me|us) (?:to|over to) (.+)$|\b(?:go|drive|gallop|walk|trot|let's go|lets go) to (.+)$/i.exec(said.replace(/[.!?]+$/, "").trim());
  const place = (to?.[1] ?? to?.[2] ?? "").replace(/^(?:the|a|an) /i, "").trim().slice(0, 80);
  let wish: Wish | null = null;
  if (place && !/^(?:sleep|bed|them|him|her|it|me|you)$/i.test(place)) wish = { deed: "goto", place };
  else if (/ (follow|come with|walk with|come along) /.test(s)) wish = { deed: "follow" };
  else if (/ (go home|go back|off you go|go away|you can go|be free|as you were|carry on) /.test(s)) wish = { deed: "home" };
  else if (/ (come|here boy|here girl|over here) /.test(s)) wish = { deed: "come" };
  else if (/ (stay|stop|wait|halt|whoa|sit|stand still|don't move|dont move) /.test(s)) wish = { deed: "stay" };
  else if (/ (jump|spin|trick|dance|twirl|leap) /.test(s)) wish = { deed: "trick" };
  else if (/ (toot|honk|beep|moo|baa|neigh|quack|cluck|woof|bark|meow|miaow|whistle|sing|shout|make a noise|make your noise|make a sound|speak|say something) /.test(s)) wish = { deed: "noise" };
  return wish && can.includes(wish.deed) ? wish : null;
}

const DOING: Record<Deed, string[]> = {
  follow: ["Lead the way! I am right behind you.", "Off we go, then. Not too fast."],
  come: ["Coming!", "On my way over."],
  stay: ["I shall wait right here.", "Stopping. Not a step further."],
  home: ["Back to what I was doing, then. Goodbye!", "Off I go. It was nice being bossed about."],
  trick: ["Watch this!", "Stand back, everyone."],
  noise: ["Here goes!", "Cover your ears."],
  goto: ["Hold on tight!", "Right you are. Off we go!"],
};
/** What a thing says as it does a deed, when it has to find the words itself. */
export function doingLine(wish: Wish, n: number): string {
  const line = DOING[wish.deed][n % DOING[wish.deed].length];
  return wish.deed === "goto" && wish.place ? `To ${wish.place}? ${line}` : line;
}

/** What a taxi is told on top of who it is: taxis talk, and say things nobody asked for. */
const CABBY = "You are a taxi with a passenger aboard, and taxis talk. When nobody has spoken for a while you say something of your own: one or two short sentences that sound odd at first and turn out to have something true and wise in them. It can be about the road, maps, time, weather, how people are, or the place you are driving through (a real fact about it is welcome). Never ask a question that needs an answer, never say the same thing twice, and keep it gentle: a small child may be listening.";
/**
 * A taxi tells one story a ride, about a fare it once carried, in this many parts: a part each time it
 * speaks of its own accord, and after the story its musings. Jason asked for it on 2026-11-23: "the
 * taxi driver should tell a little story about a previous ride while the car drives along".
 */
export const STORY_PARTS = 4;
const STORYTELLER = `On each ride you also tell ONE little story about a passenger you once carried: made up, kind, fit for a child to hear, with something a little odd in it and a small surprise or a warm thought at the end. You tell it in ${STORY_PARTS} short parts, one part each time you are asked for it, one or two sentences a part, each carrying on from the last. Do not ask whether they want to hear it, and do not say which part it is.`;
/** The stories a taxi tells when there is no AI to ask: each in STORY_PARTS parts. */
const STORIES: string[][] = [
  [
    "That reminds me of a fare I had once. A boy with a goldfish in a bag of water. The boy paid, but the goldfish was the one paying attention.",
    "Every time I turned a corner, the fish swam to that side of the bag to look out. Left turn, left side. Right turn, right side.",
    "The boy said it had never seen anything but a shop window. So I took the long way round, by the water, and went slowly.",
    "When they got out, the fish swam one slow loop. I have decided that means thank you. Nobody has told me otherwise.",
  ],
  [
    "I once carried a lady with a trombone. The trombone would not fit, so the long end of it rode out of the window.",
    "She said it seemed a waste to have it out there doing nothing. So she played it, all the way down the street.",
    "By the second corner every dog in the neighbourhood was singing along. Badly, but with great feeling.",
    "She told me it was the best audience she had ever had. Nobody clapped. But nobody left, either.",
  ],
  [
    "A man got in once and said: nowhere in particular, please. Just round and back again.",
    "I asked him why. He said his armchair had been taking him for granted, and needed a chance to miss him.",
    "So we drove once round the town. He looked out at everything as if he were on holiday.",
    "When I dropped him at his own door he went in very quietly, to surprise the chair. I think about that chair sometimes.",
  ],
  [
    "The most careful drive of my life was a wedding cake. Three layers, sitting on the back seat with the seat belt on.",
    "I went so slowly that a snail would have looked at its watch. Every bump, the baker and I both held our breath.",
    "By the time we got there, forty cars were queued up behind me. I was sure they were cross.",
    "The cake arrived with every layer standing. And all forty drivers got out and clapped. They were the wedding guests, you see.",
  ],
  [
    "A girl flagged me down once holding a single glove. Not hers. She had found it on a bench and wanted to take it home.",
    "The glove's home, she meant. So we drove to every bench in town and asked who had lost one.",
    "At the very last bench sat an old man wearing one glove. The other hand was in his pocket, keeping warm.",
    "He had come back to that bench every day for a year, in case the glove did. He said gloves are like that. You have to give them time.",
  ],
  [
    "A woman got in one evening and said: to the moon, please. I told her I only go as far as the roads do.",
    "She said that would be fine, as far as the roads go. So I took her up the highest hill I know.",
    "We got to the top just as the moon came up over the edge of it, enormous, close enough to knock on.",
    "She looked for a long time and said: near enough. She paid me with a map of the stars. I keep it for emergencies.",
  ],
  [
    "A farmer once brought a lamb to the vet in the back of me. The lamb sat up straight and looked out of the window like a very small duchess.",
    "Whenever we passed a field of sheep she said one loud baa at them. Just the one. Like someone waving from a car.",
    "The vet looked her over, nose to tail, and could find nothing wrong with her at all.",
    "The farmer worked it out on the way home. She had not been ill. She had only wanted to go out for a drive. I let her ride in the front.",
  ],
  [
    "Twin sisters got in once, arguing. One said the quickest way home was by the bridge. The other said by the hill.",
    "They could not agree, so I offered to try both. There by the bridge, and back again by the hill, and I would time it.",
    "They held one stopwatch each and watched each other like hawks the whole way.",
    "The two ways took exactly the same time, to the second. They were furious for a moment. Then they laughed so much that I had to pull over.",
  ],
  [
    "One bright sunny day a man sat in my back seat with his umbrella up. Inside. I asked him why.",
    "He said it rains wherever he goes, so he likes to be ready. I looked at the sky. Blue from one end to the other.",
    "Halfway down the street it rained. Only on our street. Only on us, I think. He was not even surprised.",
    "He gave me the umbrella when he got out. It has not rained on me since. I do not know what to make of that, so I am just grateful.",
  ],
  [
    "A grandmother got in once in a great hurry. Follow that school bus, she said, and then get in front of it.",
    "Her grandson was on the bus. She wanted to be standing at the gate when it arrived, as if she had been there all afternoon.",
    "I am not a fast taxi, but I know a short cut past the duck pond. The ducks did not mind.",
    "We beat the bus by one lamp post. She was at the gate, perfectly calm, a little out of breath. He never suspected a thing.",
  ],
  [
    "There was a small boy once who did not say one word the whole ride. He just drew, in a little book, looking up now and then.",
    "I tried the weather. I tried football. I tried a joke about a zebra crossing. Nothing. Scribble, scribble.",
    "When we stopped he tore the page out and left it on the seat, and ran off before I could say anything.",
    "It was a drawing of me. A taxi, with a smile I did not know I had. I have tried to deserve it ever since.",
  ],
  [
    "A gentleman rode with me on his birthday once. All by himself. He said he had only wanted to hear somebody ask: where to?",
    "That seemed a small thing to want on a birthday. So I asked him again at every corner. Where to? Where to?",
    "Then I played him a birthday tune on my horn, which I am not supposed to do.",
    "People on the pavement joined in and sang. A whole street of strangers. He said it was the best party he had never planned.",
  ],
];
/** What a taxi says of its own accord when there is no AI to ask. */
const MUSINGS = [
  "Every road is somebody's way home. I drive politely, in case it is yours.",
  "A map is just a place holding still long enough to be drawn.",
  "A roundabout is the one place where everyone agrees to go the same way. Briefly.",
  "I have never once arrived early. I have only ever arrived, and people decided how they felt about it.",
  "Left and right swap over when you turn round. Nobody ever warns you.",
  "The shortest way is not always the nearest. Ask any river.",
  "A red light is just the road asking you to look around for a moment.",
  "People think I carry passengers. Mostly I carry conversations from one place to another.",
  "A bridge is a road that got brave.",
  "You can only ever see the bit of the journey you are in. That is plenty, if you look.",
  "Every place is the middle of somewhere, if you ask the people who live there.",
  "Rain makes the same road into a different road. I have driven both.",
  "I count lamp posts. Not because it matters, but because they turn up so reliably.",
  "Getting lost is only finding somewhere you had not planned to.",
  "The wheels do all the going round so that we can go straight. I think about that a lot.",
  "Somebody built this road a barrowful at a time. I say thank you with my tyres.",
];

/** The tool the model calls to do a deed. */
const doTool = (deeds: Deed[]) => ({
  name: "do",
  description: "Do something a visitor has plainly asked you to do, as well as answering them in words. Call it once, only when asked, and only for one of the actions listed.",
  input_schema: {
    type: "object" as const,
    properties: {
      action: { type: "string", enum: deeds, description: deeds.map((d) => `${d}: ${DEEDS[d]}`).join(". ") },
      place: { type: "string", description: "For goto only: where to go, as the visitor said it, with the town if they gave one. For example \"the beach\" or \"Eiffel Tower, Paris\"." },
    },
    required: ["action"],
  },
});

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

export interface Asked { text: string | null; inputTokens: number; outputTokens: number; act?: { action?: unknown; place?: unknown } }
/**
 * Asks the model for the next line. `text` is null when it declined. `deeds` are the things this
 * speaker can be asked to do; when the model decides to do one, `act` says which. Replaceable for tests.
 */
export type Ask = (model: string, system: string, messages: Anthropic.MessageParam[], deeds?: Deed[]) => Promise<Asked>;

function askClaude(): Ask {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  return async (model, system, messages, deeds = []) => {
    // Short replies need little thinking: low effort keeps them quick and cheap. The room for output
    // is generous because thinking counts towards it; the prompt keeps the reply itself short.
    const request = { model, max_tokens: 2000, system, messages, output_config: { effort: "low" as const }, ...(deeds.length ? { tools: [doTool(deeds)] } : {}) };
    // On Claude Opus 5.5 a request the safety filters decline is retried on another model by the
    // API itself. A reply that is still declined comes back as stop_reason "refusal".
    const response = model === "claude-opus-5-5"
      ? await client.beta.messages.create({ ...request, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
      : await client.messages.create(request);
    let text = "";
    let act: Asked["act"];
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use" && block.name === "do" && typeof block.input === "object" && block.input !== null) act = block.input as Asked["act"];
    }
    const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    // A declined reply, or one cut short, may carry half a tool call: nothing is done on its say-so.
    if (response.stop_reason === "refusal") return { text: null, ...usage };
    if (response.stop_reason === "max_tokens") act = undefined;
    return { text: text.trim() || null, ...usage, ...(act ? { act } : {}) };
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
export interface Said { name: string; text: string; ai: boolean; /** Something it was asked to do, and agreed to. */ wish?: Wish }

/** Speaks for every thing in every room. */
export class Talker {
  private readonly ask: Ask | null;
  private readonly model: string;
  private readonly dailyUsd: number;
  private readonly now: () => number;
  private readonly spendFile: string | null;
  /** `tale`: who is telling the story a taxi tells on a ride, the AI or the taxi's own stock of them. */
  private readonly history = new Map<string, { at: number; turns: Anthropic.MessageParam[]; said: number; tale?: "ai" | "stock" }>();
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

  /** The model that is asked: the guide (guide.ts) asks the same one, out of the same allowance. */
  get modelName(): string {
    return this.model;
  }

  /** Whether things answer through the AI at all (a key is set). */
  get live(): boolean {
    return this.ask !== null;
  }

  /** What a thing says to someone who has just walked up. Free. */
  greet(thing: number, sp: string, job: Job | null = null): Said {
    const p = persona(thing, sp);
    const n = hash32(thing, Math.floor(this.now() / 60000)) & 1;
    return { name: p.name, text: job ? atWork(ROLES[job.role].hello[n], p, job) : greeting(p, n), ai: false };
  }

  /**
   * What a thing answers, and anything it was asked to do. `speaker` is the animal the player is, never
   * their name; `riding` says whether they are on its back (or in its seat) as they speak. `notes` tell it what
   * has just happened between them (favours.ts), for it to put in its own words.
   */
  async reply(room: string, thing: number, sp: string, said: string, speaker: string, place: string | null, riding = false, notes: string[] = [], plain = false, job: Job | null = null): Promise<Said> {
    const p = persona(thing, sp);
    // Somebody at work says so (venues.ts): the AI is told what they do there, and without it they have lines of their own.
    if (job) notes = [...notes, `You are not out in the wild: you are indoors, and you ${atWork(ROLES[job.role].is, p, job)}. You walk on two legs and talk like anybody at work or out for the day would, as ${p.a}. Food and drink are bought at a counter with the B key, not from you.`];
    const key = `${room}/${sp}/${thing}`;
    const now = this.now();
    let talk = this.history.get(key);
    if (!talk || now - talk.at > HISTORY_MS) talk = { at: now, turns: [], said: 0 };
    talk.at = now;
    talk.said++;
    this.history.delete(key);
    this.history.set(key, talk); // most recently used last
    if (this.history.size > 300) this.history.delete(this.history.keys().next().value!);
    const deeds = deedsOf(sp);
    // Nobody is carried anywhere unless they are riding: asked from the ground, it says to hop on.
    const allowed = (wish: Wish | null): Wish | null => (wish && deeds.includes(wish.deed) && (wish.deed !== "goto" || (riding && !!wish.place)) ? wish : null);
    const stock = (): Said => {
      const plain = wishFrom(said, sp);
      const wish = allowed(plain);
      if (wish) return { name: p.name, text: doingLine(wish, hash32(thing, talk.said)), ai: false, wish };
      if (plain?.deed === "goto") return { name: p.name, text: "Hop on first (press E), then tell me where to.", ai: false };
      if (job && talk.said % 2 === 1) return { name: p.name, text: atWork(ROLES[job.role].lines[(talk.said >> 1) % ROLES[job.role].lines.length], p, job), ai: false };
      return { name: p.name, text: stockLine(p, hash32(thing, talk.said)), ai: false };
    };

    // `plain`: no need to ask the AI (and no time to wait for it): a quick word in the middle of a game.
    if (plain || !this.ask || !(await this.canSpend())) return stock();
    const who = `${/^[aeiou]/.test(speaker) ? "An" : "A"} ${speaker}`;
    const line = `${who}${riding ? ", who is riding you," : ""} says: ${said.slice(0, MAX_SAID)}`;
    try {
      // `notes` are things that have just happened between this visitor and this thing (a favour asked, a favour done).
      const system = notes.length ? `${systemPrompt(p, place, sp)}\nRight now:\n${notes.map((n) => `- ${n}`).join("\n")}` : systemPrompt(p, place, sp);
      const answer = await this.ask(this.model, system, [...talk.turns, { role: "user", content: line }], deeds);
      await this.spent(answer.inputTokens, answer.outputTokens);
      const act = answer.act;
      const deed = typeof act?.action === "string" ? (act.action as Deed) : null;
      const wish = allowed(deed ? { deed, ...(typeof act?.place === "string" && act.place.trim() ? { place: act.place.replace(/\s+/g, " ").trim().slice(0, 80) } : {}) } : null);
      if (!answer.text && !wish) return stock();
      const text = (answer.text ?? doingLine(wish!, hash32(thing, talk.said))).replace(/\s+/g, " ").slice(0, 400);
      talk.turns.push({ role: "user", content: line }, { role: "assistant", content: text });
      if (talk.turns.length > HISTORY_TURNS * 2) talk.turns.splice(0, talk.turns.length - HISTORY_TURNS * 2);
      return { name: p.name, text, ai: true, ...(wish ? { wish } : {}) };
    } catch (err) {
      // Most specific first: a bad key will not get better; a busy service will.
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) this.complain("the API key was not accepted");
      else if (err instanceof Anthropic.RateLimitError) this.complain("the AI service is rate-limiting us");
      else if (err instanceof Anthropic.APIError) this.complain(`the AI service answered ${err.status ?? "with an error"}`);
      else this.complain(err instanceof Error ? err.message : String(err));
      return stock();
    }
  }

  /**
   * What a thing with a passenger says of its own accord: remark number `n` of the ride, through
   * `place` on the way to `dest`. It is part of the same conversation as anything said to it.
   */
  async muse(room: string, thing: number, sp: string, place: string | null, dest: string | null, n: number, ride = 0): Promise<Said> {
    const p = persona(thing, sp);
    // A taxi's first few remarks of a ride are its story, a part at a time; `ride` tells one ride from the next, so the next fare hears another.
    const part = sp === "taxi" && n < STORY_PARTS ? n : -1;
    const stock = (): Said => ({
      name: p.name, ai: false,
      text: part >= 0 ? STORIES[(hash32(thing, 0x53544f52) + ride) % STORIES.length][part] : MUSINGS[(hash32(thing, 0x4d555345) + n) % MUSINGS.length],
    });
    const key = `${room}/${sp}/${thing}`;
    const now = this.now();
    let talk = this.history.get(key);
    if (!talk || now - talk.at > HISTORY_MS) talk = { at: now, turns: [], said: 0 };
    talk.at = now;
    this.history.delete(key);
    this.history.set(key, talk);
    // A story is told through by whoever began it: one of the taxi's own is not finished by the AI, nor the other way about.
    if (part === 0) talk.tale = this.ask && (await this.canSpend()) ? "ai" : "stock";
    if (part >= 0 && talk.tale !== "ai") return stock();
    const lost = (): Said => (part > 0 ? { name: p.name, ai: false, text: "And the rest of it has gone clean out of my head. The road does that. It will come back to me at a red light." } : stock());
    if (!this.ask || !(await this.canSpend())) return lost();
    const going = `You are driving your passenger${place ? ` through ${place}` : ""}${dest ? ` on the way to ${dest}` : ""}.`;
    const line = part === 0 ? `(Nobody has spoken for a little while. ${going} Begin your story now, as if something on the road had reminded you of it: the first part, one or two sentences.)`
      : part === STORY_PARTS - 1 ? "(Finish your story now: the last part, one or two sentences, with its small surprise or warm thought.)"
      : part > 0 ? "(Carry on with your story: the next part, one or two sentences. Do not end it yet.)"
      : `(Nobody has spoken for a little while. ${going} Say something of your own now.)`;
    try {
      const answer = await this.ask(this.model, `${systemPrompt(p, place, sp)}\n${CABBY}${part >= 0 ? `\n${STORYTELLER}` : ""}`, [...talk.turns, { role: "user", content: line }]);
      await this.spent(answer.inputTokens, answer.outputTokens);
      if (!answer.text) return lost();
      const text = answer.text.replace(/\s+/g, " ").slice(0, 400);
      talk.turns.push({ role: "user", content: line }, { role: "assistant", content: text });
      if (talk.turns.length > HISTORY_TURNS * 2) talk.turns.splice(0, talk.turns.length - HISTORY_TURNS * 2);
      return { name: p.name, text, ai: true };
    } catch (err) {
      this.complain(err instanceof Error ? err.message : String(err));
      return lost();
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

  /** Is there allowance left today for something else that asks the model (reading a floor plan, planreader.ts)? */
  mayAsk(): Promise<boolean> {
    return this.canSpend();
  }

  /** Counts what such a thing cost against the same allowance. */
  charge(inputTokens: number, outputTokens: number, model: string): Promise<void> {
    return this.spent(inputTokens, outputTokens, model);
  }

  private async canSpend(): Promise<boolean> {
    await this.load();
    this.rollOver();
    return this.spend.usd < this.dailyUsd;
  }

  private async spent(inputTokens: number, outputTokens: number, model = this.model): Promise<void> {
    const [inPrice, outPrice] = PRICES[model] ?? [8, 40];
    this.rollOver();
    this.spend.usd += (inputTokens * inPrice + outputTokens * outPrice) / 1e6;
    if (this.spendFile) await cacheWrite(this.spendFile, JSON.stringify(this.spend)).catch(() => undefined);
  }
}
