// Food, and hearts. A player has five hearts, one for each kind of good food: fruit, vegetables, bread and
// grains, protein, and dairy. Eating something of a kind fills its heart for the day; a meal can fill several.
// With all five full the player is "full of beans" until their midnight: a little quicker on their feet, and
// paid a few coins. Empty hearts cost nothing: nobody is ever hungry here, and nothing is taken away.
//
// Food is carried in a lunch box (the journal keeps it). It comes from the world: things that are talked to
// give what they have, once a day each (a cow milk, a hen an egg, a fruit tree its fruit, a boat a fish); real
// shops and cafés on the map sell it for coins, each country its own dishes; and it is given in thanks for
// favours. Treats are food too, and fill no heart.

import { hash32 } from "./geo.ts";

export type Group = "fruit" | "veg" | "grain" | "protein" | "dairy";
export const GROUPS: { id: Group; title: string }[] = [
  { id: "fruit", title: "Fruit" },
  { id: "veg", title: "Vegetables" },
  { id: "grain", title: "Bread and grains" },
  { id: "protein", title: "Protein" },
  { id: "dairy", title: "Dairy" },
];

export interface Food {
  id: string;
  name: string;
  /** The hearts it fills. None for a treat. */
  groups: Group[];
  /** What it costs where it is sold. */
  price: number;
}

const f = (id: string, name: string, groups: Group[], price: number): Food => ({ id, name, groups, price });
export const FOODS: Food[] = [
  // what grows, and what animals give
  f("apple", "an apple", ["fruit"], 5), f("pear", "a pear", ["fruit"], 5), f("plum", "a plum", ["fruit"], 5), f("cherries", "some cherries", ["fruit"], 6),
  f("orange", "an orange", ["fruit"], 5), f("peach", "a peach", ["fruit"], 6), f("fig", "a fig", ["fruit"], 6),
  f("banana", "a banana", ["fruit"], 5), f("mango", "a mango", ["fruit"], 7), f("coconut", "a coconut", ["fruit"], 7), f("berries", "a handful of berries", ["fruit"], 6),
  f("carrot", "a carrot", ["veg"], 4), f("potato", "a potato", ["veg"], 4), f("pumpkin", "a pumpkin", ["veg"], 6), f("corn", "a corn cob", ["veg"], 5),
  f("tomato", "a tomato", ["veg"], 4), f("lettuce", "a lettuce", ["veg"], 4),
  f("bread", "a loaf of bread", ["grain"], 6), f("rice", "a bowl of rice", ["grain"], 6), f("porridge", "a bowl of porridge", ["grain"], 6),
  f("egg", "an egg", ["protein"], 5), f("fish", "a fish", ["protein"], 8), f("nuts", "a handful of nuts", ["protein"], 6), f("beans", "a tin of beans", ["protein"], 5),
  f("milk", "a glass of milk", ["dairy"], 5), f("cheese", "a piece of cheese", ["dairy"], 7), f("yoghurt", "a pot of yoghurt", ["dairy"], 6),
  f("honey", "a pot of honey", [], 8), f("chocolate", "a bar of chocolate", [], 8), f("cake", "a slice of cake", [], 10), f("icecream", "an ice cream", [], 9),
  // what cafés everywhere have
  f("sandwich", "a cheese sandwich", ["grain", "dairy"], 12), f("soup", "a bowl of vegetable soup", ["veg"], 10), f("fruitsalad", "a fruit salad", ["fruit"], 10), f("omelette", "an omelette", ["protein", "dairy"], 12),
  // and what each country is known for
  f("sushi", "a plate of sushi", ["grain", "protein"], 16), f("ramen", "a bowl of ramen", ["grain", "protein", "veg"], 18),
  f("croissant", "a croissant", ["grain", "dairy"], 10), f("ratatouille", "a dish of ratatouille", ["veg"], 14),
  f("pizza", "a pizza", ["grain", "dairy", "veg"], 18), f("gelato", "a gelato", [], 9),
  f("meatpie", "a meat pie", ["grain", "protein"], 14), f("pavlova", "a slice of pavlova", ["fruit"], 12), f("lamington", "a lamington", [], 9),
  f("fishandchips", "fish and chips", ["protein", "veg"], 16), f("scone", "a scone with cream", ["grain", "dairy"], 10),
  f("stroopwafel", "a stroopwafel", [], 8), f("broodje", "a cheese roll", ["grain", "dairy"], 11),
  f("pretzel", "a pretzel", ["grain"], 8), f("bratwurst", "a bratwurst", ["protein"], 12),
  f("paella", "a plate of paella", ["grain", "protein", "veg"], 18), f("churros", "some churros", [], 9),
  f("tacos", "a plate of tacos", ["grain", "protein", "veg"], 16),
  f("burger", "a burger", ["grain", "protein"], 14), f("pancakes", "a stack of pancakes", ["grain", "dairy"], 12),
  f("dal", "dal and rice", ["protein", "grain"], 14), f("lassi", "a mango lassi", ["dairy", "fruit"], 10),
  f("dumplings", "a basket of dumplings", ["grain", "protein"], 14), f("friedrice", "a bowl of fried rice", ["grain", "veg"], 13),
  f("padthai", "a plate of pad thai", ["grain", "protein", "veg"], 17),
  f("greeksalad", "a Greek salad", ["veg", "dairy"], 13),
  f("kebab", "a kebab", ["protein", "veg"], 14), f("baklava", "a piece of baklava", [], 9),
  f("falafel", "a falafel wrap", ["protein", "veg", "grain"], 15),
  f("feijoada", "beans and rice", ["protein", "grain"], 14), f("empanada", "an empanada", ["grain", "protein"], 12),
  f("poutine", "a dish of poutine", ["veg", "dairy"], 13),
  f("bibimbap", "a bowl of bibimbap", ["grain", "veg", "protein"], 17), f("pho", "a bowl of pho", ["grain", "protein", "veg"], 17),
  f("cinnamonbun", "a cinnamon bun", ["grain"], 9), f("fondue", "a pot of cheese fondue", ["dairy", "grain"], 16),
  f("tagine", "a tagine", ["protein", "veg"], 16), f("stew", "a bowl of stew", ["protein", "veg"], 14),
  f("waffle", "a waffle", ["grain"], 9), f("nata", "a custard tart", ["dairy"], 9),
  // and what is only ever cooked at home
  f("fruitbowl", "a bowl of fruit and cream", ["fruit", "dairy"], 12), f("heartysoup", "a pot of hearty soup", ["veg", "protein"], 14),
  f("breakfast", "a big breakfast bowl", ["grain", "dairy", "fruit"], 16), f("fishpie", "a fish pie", ["protein", "veg", "dairy"], 18),
  f("feast", "a feast", ["fruit", "veg", "grain", "protein", "dairy"], 30),
];
const BY_ID = new Map(FOODS.map((x) => [x.id, x]));
export const foodById = (id: string): Food | undefined => BY_ID.get(id);

/** The lunch box holds this many things in all. */
export const LARDER_MAX = 30;
/** Coins for a day on which all five hearts were filled, and how much quicker on foot the player is for the rest of it. */
export const HEALTHY_COINS = 15;
export const PEP = 1.12;

/** The dishes a country's cafés are known for, by the name the place lookup gives the country. */
const DISHES: Record<string, string[]> = {
  "Japan": ["sushi", "ramen"], "France": ["croissant", "ratatouille"], "Italy": ["pizza", "gelato"],
  "New Zealand": ["meatpie", "pavlova"], "Australia": ["meatpie", "lamington"], "United Kingdom": ["fishandchips", "scone"], "Ireland": ["stew", "scone"],
  "Netherlands": ["broodje", "stroopwafel"], "Germany": ["bratwurst", "pretzel"], "Austria": ["pretzel", "cake"], "Spain": ["paella", "churros"], "Portugal": ["nata", "fish"],
  "Mexico": ["tacos", "churros"], "United States": ["burger", "pancakes"], "Canada": ["poutine", "pancakes"],
  "India": ["dal", "lassi"], "China": ["dumplings", "friedrice"], "Thailand": ["padthai", "mango"], "Vietnam": ["pho", "friedrice"], "South Korea": ["bibimbap", "dumplings"],
  "Greece": ["greeksalad", "baklava"], "Turkey": ["kebab", "baklava"], "Türkiye": ["kebab", "baklava"], "Egypt": ["falafel", "baklava"], "Morocco": ["tagine", "orange"],
  "Brazil": ["feijoada", "mango"], "Argentina": ["empanada", "churros"], "Sweden": ["cinnamonbun", "fish"], "Norway": ["cinnamonbun", "fish"], "Denmark": ["cinnamonbun", "broodje"],
  "Switzerland": ["fondue", "chocolate"], "Belgium": ["waffle", "chocolate"],
};
const CAFE = ["sandwich", "soup", "fruitsalad", "omelette", "cake", "icecream"];
const GROCER = ["bread", "rice", "porridge", "egg", "beans", "milk", "cheese", "yoghurt", "carrot", "potato", "tomato", "lettuce", "chocolate"];

/** What a shop (`shop`) or somewhere to eat (`food`) sells, in a country (as the place lookup names it) and at a latitude. */
export function menuFor(use: "shop" | "food", country: string | null, lat: number): Food[] {
  const ids = use === "food"
    ? [...(DISHES[country ?? ""] ?? []), ...CAFE]
    : [...GROCER, ...(Math.abs(lat) < 23.5 ? ["banana", "mango"] : Math.abs(lat) < 40 ? ["orange", "peach"] : ["apple", "pear"])];
  return [...new Set(ids)].map((id) => foodById(id)!).filter(Boolean);
}

const TROPICAL = ["banana", "mango", "coconut", "orange"];
const WARM = ["orange", "peach", "fig", "apple"];
const COOL = ["apple", "pear", "plum", "cherries"];
const FIELD = ["carrot", "potato", "pumpkin", "corn"];
const GARDEN = ["tomato", "lettuce", "carrot"];
const pickOf = (list: string[], thing: number, salt: number): string => list[hash32(thing, salt) % list.length];

/**
 * What a thing has to give to whoever talks to it, if anything: the same for everyone, from what it is and
 * which one it is. One tree in three is a fruit tree, and which fruit depends on how far from the equator it grows.
 */
export function giftOf(sp: string, thing: number, lat: number): string | null {
  switch (sp) {
    case "tree":
      if (hash32(thing, 0x46525554) % 3 !== 0) return null;
      return pickOf(Math.abs(lat) < 23.5 ? TROPICAL : Math.abs(lat) < 40 ? WARM : COOL, thing, 0x4652);
    case "cow": case "goat": return "milk";
    case "chicken": case "duck": case "goose": return "egg";
    case "bee": return "honey";
    case "squirrel": return "nuts";
    case "boat": case "sailboat": case "penguin": case "seal": case "heron": case "seagull": return "fish";
    case "tractor": return pickOf(FIELD, thing, 0x4649);
    case "rabbit": return "carrot";
    case "monkey": return "banana";
    case "bear": return "berries";
    case "house": {
      // One house in four has something from its garden, and one in four has just baked.
      const h = hash32(thing, 0x484f5553) % 4;
      return h === 0 ? pickOf(GARDEN, thing, 0x4741) : h === 1 ? "bread" : null;
    }
    default: return null;
  }
}

/** Something to give in thanks for a favour: good plain food, by who was helped. */
export function thanksFood(thing: number): string {
  return pickOf(["apple", "bread", "cheese", "nuts", "carrot", "cake", "yoghurt", "berries"], thing, 0x5448);
}

/**
 * Cooking, in the kitchen of a house of one's own: a recipe turns things from the lunch box into a meal, two
 * helpings of it (one to eat and one to give away). Each thing needed is a food by name, one of several
 * ("honey|chocolate"), or anything plain of a kind ("any:fruit"). The first three recipes are known from the
 * start, and each recipe cooked for the first time teaches the next.
 */
export interface Recipe { id: string; makes: string; needs: string[] }
export const RECIPES: Recipe[] = [
  { id: "sandwich", makes: "sandwich", needs: ["bread", "any:dairy"] },
  { id: "omelette", makes: "omelette", needs: ["egg", "any:dairy"] },
  { id: "fruitbowl", makes: "fruitbowl", needs: ["any:fruit", "any:dairy"] },
  { id: "heartysoup", makes: "heartysoup", needs: ["any:veg", "any:veg", "any:protein"] },
  { id: "breakfast", makes: "breakfast", needs: ["any:grain", "milk", "any:fruit"] },
  { id: "pancakes", makes: "pancakes", needs: ["egg", "milk", "any:grain"] },
  { id: "pizza", makes: "pizza", needs: ["bread", "cheese", "tomato"] },
  { id: "fishpie", makes: "fishpie", needs: ["fish", "potato", "milk"] },
  { id: "cake", makes: "cake", needs: ["egg", "milk", "honey|chocolate"] },
  { id: "feast", makes: "feast", needs: ["any:fruit", "any:veg", "any:grain", "any:protein", "any:dairy"] },
];
export const recipeById = (id: string): Recipe | undefined => RECIPES.find((r) => r.id === id);
export const HELPINGS = 2;
export const RECIPES_AT_FIRST = 3;
/** How many recipes somebody knows who has cooked these (by recipe, how many times). */
export const recipesKnown = (cooked: Record<string, number>): number => Math.min(RECIPES.length, RECIPES_AT_FIRST + RECIPES.filter((r) => cooked[r.id] > 0).length);

/** A thing a recipe needs, in words: "a loaf of bread", "any fruit", "a pot of honey or a bar of chocolate". */
export function needName(need: string): string {
  if (need.startsWith("any:")) return `any ${GROUPS.find((g) => g.id === need.slice(4))?.title.toLowerCase() ?? "food"}`;
  return need.split("|").map((id) => foodById(id)?.name ?? id).join(" or ");
}

/** What in a lunch box would do for one thing a recipe needs: plain foods only where any of a kind will do, so that no meal is cooked into another. */
function fits(need: string, larder: Record<string, number>): string | null {
  const have = (id: string): boolean => (larder[id] ?? 0) > 0;
  if (need.startsWith("any:")) {
    const group = need.slice(4);
    return FOODS.find((x) => have(x.id) && x.groups.length === 1 && x.groups[0] === group)?.id ?? null;
  }
  return need.split("|").find(have) ?? null;
}

/**
 * The things from a lunch box that a recipe would use, one for each thing it needs (null where there is
 * nothing that will do). The named things are taken first, so that "any dairy" does not use up the milk
 * that the recipe asks for by name.
 */
export function ingredients(recipe: Recipe, larder: Record<string, number>): (string | null)[] {
  const left = { ...larder };
  const out: (string | null)[] = recipe.needs.map(() => null);
  const order = recipe.needs.map((need, i) => ({ need, i })).sort((a, b) => Number(a.need.startsWith("any:")) - Number(b.need.startsWith("any:")));
  for (const { need, i } of order) {
    const id = fits(need, left);
    out[i] = id;
    if (id) left[id]--;
  }
  return out;
}

/** The hearts that a set of eaten groups fills, in order. */
export function heartsOf(ate: string[]): { group: Group; title: string; full: boolean }[] {
  return GROUPS.map((g) => ({ group: g.id, title: g.title, full: ate.includes(g.id) }));
}
