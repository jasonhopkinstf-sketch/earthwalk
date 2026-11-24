// Everything a player can do, in the order the menu shows it (Tab). One table serves the menu, the
// strip of buttons along the bottom and "/do <id>"; a new thing to do is one line here (and, when it
// is not a chat command already, a few in main.js, `menuAction`).
//
// It is the Windows game's table (game/Source/EarthWalk/EarthMenu.cpp, `Table`) with the same ids,
// groups and words, so the two games read alike; test/menu.test.ts fails when they drift apart. The
// rows marked `own` are things only the browser game has so far.
//
// No three.js and no page here: this file is also read by the server's tests.

/**
 * @typedef {{ id: string, group: string, title: string, about: string, key: string, command: string,
 *   ask: string, askHint: string, strip: string, own?: boolean }} Action
 *   `key` is the key that does it without the menu; `command` the chat command behind it ("" when main.js
 *   does it some other way); `ask` the question to put first when it needs a place or a name, with
 *   `askHint` an example of an answer; `strip` its label on the strip of buttons ("" when it is not there).
 */

const row = (id, group, title, about, key = "", command = "", ask = "", askHint = "", strip = "") => ({ id, group, title, about, key, command, ask, askHint, strip });
const own = (...args) => ({ ...row(...args), own: true });

/** @type {Action[]} */
export const ACTIONS = [
  row("goto", "Go somewhere", "Go to a place...", "Anywhere on Earth: a town, a street, a famous place.", "", "goto", "Where to?", "Sydney Opera House", "Go to..."),
  row("shows", "Go somewhere", "Show me...", "A list of things to see and do, and straight to the one you pick.", "G", "", "", "", "Show me"),
  row("join", "Go somewhere", "Go to a friend...", "Lands you beside somebody in your room.", "", "join", "Who do you want to go to?", "their name"),
  row("who", "Go somewhere", "Who is here?", "Lists everybody in your room and how far off they are.", "", "who"),
  row("where", "Go somewhere", "Where am I?", "Says where on Earth you are standing.", "", "where"),
  // (In this game "/house" is the house of your own, so finding a door to go in at is "/houses".)
  row("house", "Go somewhere", "Find a house to go into", "Says where the nearest front door that opens is.", "", "houses"),
  row("fly", "Go somewhere", "Fly, or land", "Up into the air and down again.", "F", "fly"),

  row("ride", "Ride and drive", "Hop on, or hop off", "The nearest animal, car, tractor, boat or train. At a door with a COME IN sign, go in.", "E", "", "", "", "Ride"),
  row("above", "Ride and drive", "Look from above", "While you ride or are carried: a camera above and behind, then one high over the rooftops, then your seat again.", "V"),
  row("car", "Ride and drive", "Call my car", "Your own car drives to where you are.", "C", "car", "", "", "My car"),
  row("caraway", "Ride and drive", "Send my car away", "It goes back to wherever it waits.", "", "car away"),
  row("taketo", "Ride and drive", "Take me to...", "On an animal or in a car: tell it where, and it carries you there by itself.", "", "", "Where should it take you?", "the beach"),
  row("taxi", "Ride and drive", "Call a taxi...", "It comes to you and drives you there. Press E beside it to get in.", "X", "taxi", "Where should the taxi take you?", "the beach", "Taxi..."),

  row("talk", "Talk", "Talk to what is nearest", "Animals, cars, trains, trees and houses all answer. Tell one what to do: follow me, stay, take me to the beach.", "T", "", "", "", "Talk"),
  row("guide", "Talk", "Ask the guide...", "Ask in plain words where you are, what is near, or how to get somewhere. The answer comes with buttons that take you there.", "Q", "guide", "What would you like to know?", "where is the nearest station?"),
  row("chat", "Talk", "Chat with people", "Everybody in your room reads what you type.", "Enter"),

  row("passport", "Play", "My passport", "Today's tasks, treasure hunts, expeditions, coins, hats, riddles and everywhere you have been.", "P", "", "", "", "Passport"),
  row("race", "Play", "A race", "Sets a race up along the roads here, joins a friend's, or starts yours.", "R"),
  row("racestop", "Play", "Leave the race", "Leaves it, or ends your own.", "", "race stop"),
  row("clue", "Play", "Hear the clue again", "The clue of the treasure hunt you are on.", "", "clue"),
  row("tricks", "Play", "My companion's tricks", "Teach the companion at your side its next trick, and have it do the ones it knows.", "K"),
  row("agility", "Play", "An agility course", "Nine obstacles in a ring before you, for you and your companion. R starts it.", "", "agility"),
  row("tag", "Play", "A game of tag", "Sets one up where you stand. Friends press R to join, and you press R to start. It takes two.", "", "tag"),
  row("hide", "Play", "Hide and seek", "Sets one up where you stand, the same way as tag.", "", "hide"),
  row("herd", "Play", "A round-up", "A pen appears where you stand. T beside an animal has it follow you: walk it into the pen.", "", "herd"),
  row("playstop", "Play", "Leave the game", "Leaves the tag, the hide and seek or the round-up, or ends your own.", "", "tag stop"),

  row("animal", "Me", "Change my animal...", "Fox, bear, rabbit, cat, owl or frog.", "", "animal", "Which animal? Fox, bear, rabbit, cat, owl or frog", "bear"),
  row("name", "Me", "Change my name...", "What other people see over your head.", "", "name", "What should people call you?", "your name"),
  row("home", "Me", "Make this my home", "You start here next time (when you are signed in).", "", "home"),
  row("room", "Me", "Change room...", "People in the same room see each other.", "", "room", "Which room?", "family"),
  row("login", "Me", "Sign in with Google", "Keeps your passport, coins and home.", "", "login"),
  row("myhouse", "Me", "My house", "Inside a house nobody lives in, makes it yours. Inside your own, the furniture, paint and garden. Anywhere else, takes you home.", "H"),
  row("lunch", "Me", "My lunch box", "Your five hearts and the food you carry. Beside a real shop or café, what it sells.", "B"),
  row("invite", "Me", "Invite somebody", "Copies a link to send to them: it brings them into your room.", "", "invite"),

  row("look", "The game", "Switch the look", "Between the painted look and the flat cartoon look."),
  row("lines", "The game", "The drawn lines: on, or off", "The ink line round everything. Off is easier on a slow computer."),
  row("sound", "The game", "Sounds on, or off", "The animals' voices, car horns and train whistles."),
  row("daytime", "The game", "The real time of day, or always daytime", "The real sun and moon over wherever you are, with a bright night. Or a fine day whatever the hour."),
  row("weather", "The game", "The real weather, or a fine day", "The real cloud, rain, snow, fog and wind of wherever you are. Or a fine day whatever the weather."),
  row("map", "The game", "The little map: bigger, or hidden", "The map in the corner: friends, doors, trains, cars and where you are going.", "M"),
  row("strip", "The game", "Buttons on, or off", "The row of buttons along the bottom of the screen.", "Z"),
  row("about", "The game", "New here? What you can do", "Opens a page about what EarthWalk is, and everything there is to explore and do in it.", "", "about"),
  row("news", "The game", "What's new", "What has been added to EarthWalk lately."),
  row("help", "The game", "Every typed command", "Lists the slash commands in the chat window, for those who like typing.", "", "help"),
  row("suggest", "The game", "Suggest something...", "Tell the people who make EarthWalk what you would like in it.", "", "suggest", "What would you like to see in the game?", "more animals to ride"),
];

/**
 * Questions for the guide, ready to click in the box that asks "What would you like to know?". The same six
 * the server's guide offers when it is said hello to (server/src/guide.ts, `HELLO_ASKS`).
 */
export const GUIDE_QUESTIONS = ["Where am I?", "What is near here?", "What can I do here?", "Is there a shop near here?", "Where is the nearest station?", "How do I get to the beach?"];

/** @returns {Action | null} */
export const findAction = (id) => ACTIONS.find((a) => a.id === id) ?? null;

/** The groups in the order the menu shows them, each with its actions. */
export function actionGroups() {
  const groups = [];
  for (const action of ACTIONS) {
    let group = groups.find((g) => g.name === action.group);
    if (!group) groups.push((group = { name: action.group, actions: [] }));
    group.actions.push(action);
  }
  return groups;
}

/**
 * What to say in one click to a thing of this kind, as in the Windows game (AEarthWalkHUD::OpenTalk): a car is
 * told where to go, an animal what to do. `riding` is true for the thing the player is on. Each is
 * [label, words]; the words "..." mean "ask where to first".
 */
export function quickReplies(sp, riding = false, indoors = false) {
  // Somebody at work or at a table inside a shop or an office is not told to follow or to do a trick.
  if (indoors) return [["What do you do here?", "what do you do here?"], ["Tell me about here", "tell me about this place"]];
  const driven = sp === "car" || sp === "taxi" || sp === "tractor";
  const afloat = sp === "boat" || sp === "sailboat";
  const stands = sp === "tree" || sp === "house" || sp === "train";
  const replies = [];
  if (riding || driven) replies.push(["Take me to...", "..."]);
  if (driven) replies.push(["Stay here", "stay"], ["Go home", "go home"], ["Toot!", "make your noise"]);
  else if (!stands && !afloat) replies.push(["Follow me", "follow me"], ["Come here", "come here"], ["Stay", "stay"], ["Go home", "go home"], ["Do a trick", "do a trick"]);
  replies.push(["Can I help?", "can I help?"], ["Tell me about here", "tell me about this place"]);
  return replies;
}
