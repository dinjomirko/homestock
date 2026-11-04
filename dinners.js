// The dinner plan on the Recipes tab: the next seven dinners, picked to use what's in stock
// first (soonest use-by first), for two adults and two toddlers. Pure, so it's tested on its own.
//
// Stock comes in as [{ id, name, qty, days }], where days is how long until the use-by date
// (null when there isn't one, below zero once it's past).

// Each ingredient: [what the recipe says, names it matches in stock ("a|b", the first is the name
// it gets on the shopping list), how much it uses in the stock's own units (0: just needs some)].
export const DINNERS = [
  { id: 'spag', name: 'Turkey & spinach spaghetti', min: 25, veg: false,
    ing: [['1 box spaghetti', 'spaghetti|pasta|penne|rotini|fusilli', 1], ['2 cans diced tomatoes', 'diced tomatoes|crushed tomatoes|canned tomatoes', 2], ['1 lb ground turkey', 'ground turkey', 1], ['2 handfuls spinach', 'spinach', 0.5], ['2 tbsp olive oil', 'olive oil', 0], ['2 cloves garlic', 'garlic', 0], ['Parmesan to serve', 'parmesan', 0]],
    steps: ['Boil the spaghetti, about 10 minutes.', 'Meanwhile brown the turkey with garlic in olive oil, 6 minutes.', 'Add the tomatoes and simmer 8 minutes. Stir in the spinach until wilted.', 'Toss with the pasta and top with parmesan.'],
    tod: 'Break the spaghetti in half before cooking. Chop the spinach fine so it disappears into the sauce.' },
  { id: 'ques', name: 'Black bean quesadillas with buttery peas', min: 15, veg: true,
    ing: [['1 can black beans', 'black beans', 1], ['2 cups grated cheddar', 'cheddar', 0.5], ['6 whole-wheat tortillas', 'tortillas|tortilla', 0], ['2 cups frozen peas', 'frozen peas|peas', 0.5], ['Salsa for the adults', 'salsa', 0]],
    steps: ['Rinse the beans and mash them roughly with a fork.', 'Spread beans and cheese on half of each tortilla and fold.', 'Cook 3 minutes per side in a dry pan until golden.', 'Microwave the peas 4 minutes with a little butter.'],
    tod: 'Cut into thin strips. Squish the peas a little for younger toddlers so they don’t roll.' },
  { id: 'rice', name: 'Veggie egg fried rice', min: 25, veg: true,
    ing: [['1½ cups rice', 'rice', 0.3], ['5 eggs', 'eggs|egg', 5], ['2 cups frozen peas', 'frozen peas|peas', 0.5], ['2 carrots, diced', 'carrots|carrot', 0], ['Low-sodium soy sauce', 'soy sauce', 0], ['1 tbsp olive oil', 'olive oil', 0]],
    steps: ['Cook the rice (or use leftover rice and skip to step 2).', 'Scramble the eggs in oil, then set aside.', 'Stir-fry carrots and peas 4 minutes, add the rice and fry 3 more.', 'Fold in the eggs and a splash of soy sauce.'],
    tod: 'Cook the eggs fully. Add just a splash of soy sauce and season the adult plates more.' },
  { id: 'frit', name: 'Spinach & cheddar frittata with toast', min: 20, veg: true,
    ing: [['8 eggs', 'eggs|egg', 8], ['½ cup milk', 'milk', 0.04], ['2 handfuls spinach', 'spinach', 0.5], ['1 cup grated cheddar', 'cheddar', 0.25], ['Whole-grain bread', 'bread', 0], ['1 tbsp olive oil', 'olive oil', 0]],
    steps: ['Heat the oven to 400°F (200°C).', 'Whisk the eggs and milk; wilt spinach in an oven-safe pan with oil.', 'Pour in the eggs, scatter the cheese and cook 3 minutes on the stove.', 'Bake 10–12 minutes until set. Serve with toast.'],
    tod: 'Cut into fingers they can hold. Check the center is fully set.' },
  { id: 'bowl', name: 'Chicken burrito bowls', min: 25, veg: false,
    ing: [['1 cup rice', 'rice', 0.2], ['1 can black beans', 'black beans', 1], ['1 lb chicken breast', 'chicken breast|chicken', 1], ['1 cup frozen corn', 'frozen corn|corn', 0], ['1 avocado', 'avocados|avocado', 0], ['Grated cheddar', 'cheddar', 0.15], ['Mild taco seasoning', 'taco seasoning', 0]],
    steps: ['Start the rice.', 'Dice the chicken, toss with taco seasoning and pan-fry 8 minutes.', 'Warm the beans and corn together.', 'Build bowls with rice, chicken, beans, corn, cheese and avocado.'],
    tod: 'Dice the chicken small and lightly mash the beans. Avocado slices make an easy finger food.' },
  { id: 'salm', name: 'Baked salmon with rice & peas', min: 20, veg: false,
    ing: [['1¼ lb salmon fillet', 'salmon', 1], ['1 cup rice', 'rice', 0.2], ['2 cups frozen peas', 'frozen peas|peas', 0.5], ['1 lemon', 'lemons|lemon', 0], ['1 tbsp olive oil', 'olive oil', 0]],
    steps: ['Heat the oven to 425°F (220°C) and start the rice.', 'Brush the salmon with oil and bake 12–14 minutes.', 'Microwave the peas for the last 4 minutes.', 'Squeeze lemon over the adult portions.'],
    tod: 'Flake the salmon and check carefully for bones before serving.' },
  { id: 'soup', name: 'Tomato soup & grilled cheese', min: 20, veg: true,
    ing: [['2 cans diced tomatoes', 'diced tomatoes|crushed tomatoes|canned tomatoes', 2], ['1 cup milk', 'milk', 0.06], ['8 slices whole-grain bread', 'bread', 0], ['Sliced cheddar', 'cheddar', 0.3], ['½ onion', 'onions|onion', 0], ['1 tbsp olive oil', 'olive oil', 0]],
    steps: ['Soften the onion in oil, 4 minutes.', 'Add the tomatoes, simmer 8 minutes, then blend until smooth and stir in the milk.', 'Meanwhile make grilled cheese sandwiches, 3 minutes per side.'],
    tod: 'Cool the soup to lukewarm and cut sandwiches into strips for dipping.' },
  { id: 'eggs', name: 'Eggs baked in tomato sauce', min: 20, veg: true,
    ing: [['6 eggs', 'eggs|egg', 6], ['2 cans diced tomatoes', 'diced tomatoes|crushed tomatoes|canned tomatoes', 2], ['2 handfuls spinach', 'spinach', 0.5], ['1 tbsp olive oil', 'olive oil', 0], ['Whole-grain bread', 'bread', 0], ['Mild paprika', 'paprika', 0]],
    steps: ['Simmer the tomatoes with oil and paprika for 6 minutes. Stir in the spinach.', 'Make 6 wells and crack in the eggs.', 'Cover and cook 6–8 minutes. Serve with toast for dipping.'],
    tod: 'Cook the toddler eggs until the yolks are firm, not runny.' },
  { id: 'chil', name: 'Mild turkey & black bean chili', min: 30, veg: false,
    ing: [['1 lb ground turkey', 'ground turkey', 1], ['2 cans black beans', 'black beans', 2], ['1 can diced tomatoes', 'diced tomatoes|crushed tomatoes|canned tomatoes', 1], ['1 cup rice', 'rice', 0.2], ['Grated cheddar', 'cheddar', 0.15], ['1 onion', 'onions|onion', 0], ['Mild chili powder', 'chili powder', 0]],
    steps: ['Start the rice.', 'Brown the turkey and onion, 7 minutes.', 'Add beans, tomatoes and chili powder; simmer 15 minutes.', 'Serve over rice with cheese.'],
    tod: 'Keep it mild and add hot sauce to adult bowls. Stirring in cheese cools it down faster.' },
  { id: 'past', name: 'Creamy chicken & pea pasta', min: 25, veg: false,
    ing: [['1 box pasta', 'spaghetti|pasta|penne|rotini|fusilli', 1], ['1 lb chicken breast', 'chicken breast|chicken', 1], ['2 cups frozen peas', 'frozen peas|peas', 0.5], ['1 cup milk', 'milk', 0.06], ['1 cup grated cheddar', 'cheddar', 0.25], ['1 tbsp olive oil', 'olive oil', 0]],
    steps: ['Boil the pasta, adding the peas for the last 3 minutes.', 'Pan-fry diced chicken in oil, 8 minutes.', 'Drain the pasta, return to the pot with milk and cheese and stir until creamy.', 'Fold in the chicken.'],
    tod: 'Cut the pasta short and the chicken into pea-sized pieces.' },
  { id: 'taco', name: 'Sweet potato & black bean tacos', min: 25, veg: true,
    ing: [['2 sweet potatoes', 'sweet potatoes|sweet potato', 0], ['1 can black beans', 'black beans', 1], ['8 small tortillas', 'tortillas|tortilla', 0], ['Grated cheddar', 'cheddar', 0.15], ['Plain Greek yogurt', 'greek yogurt|yogurt', 0], ['1 lime', 'limes|lime', 0]],
    steps: ['Dice the sweet potatoes, microwave 6 minutes, then crisp in a pan with cumin.', 'Warm the beans and tortillas.', 'Fill the tacos and top with cheese, yogurt and lime.'],
    tod: 'Serve it deconstructed: soft sweet potato cubes, mashed beans and cheese in separate piles.' },
];
export const dinnerById = Object.fromEntries(DINNERS.map((r) => [r.id, r]));
export const PLAN_DAYS = 7;

// "Chicken broth" isn't chicken and "garlic powder" isn't garlic, unless the recipe asks for that.
const EXTRAS = /\b(broth|stock|bouillon|soup|seasoning|sauce|powder|paste|vinegar|flour|chips|crackers|bars?|juice|chocolate|dressing|noodles?)\b/gi;
const patterns = new Map();
export function matches(name, key) {
  let re = patterns.get(key);
  if (!re) patterns.set(key, (re = new RegExp(`\\b(${key})\\b`, 'i')));
  return re.test(name) && (name.match(EXTRAS) || []).every((w) => key.includes(w.toLowerCase()));
}

// "frozen peas|peas" → "Frozen peas"
export const shopName = (key) => key.charAt(0).toUpperCase() + key.split('|')[0].slice(1);

export function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Recipes allowed by the filters: { max } minutes, { veg } meatless only.
export const dinnerPool = ({ max = 30, veg = false } = {}) => DINNERS.filter((r) => r.min <= max && (!veg || r.veg)).map((r) => r.id);

// Past its use-by date by night `day` of the plan (0 is tonight).
const expired = (s, day = 0) => s.days != null && s.days < day;
// Which stock entries each ingredient matches, worked out once per stock list.
const hitCache = new WeakMap();
function hits(stock, key) {
  let m = hitCache.get(stock);
  if (!m) hitCache.set(stock, (m = new Map()));
  if (!m.has(key)) m.set(key, stock.filter((s) => matches(s.name, key)));
  return m.get(key);
}
const fresh = (stock) => new Map(stock.map((s) => [s, expired(s) ? 0 : Math.max(0, Number(s.qty) || 0)]));

// Night `day`'s dinner drawn from what's left, which it updates. Only food still good that night
// counts. `stale`: there is some, but it'll be past its use-by date by then.
function take(stock, left, id, day) {
  return dinnerById[id].ing.map(([label, key, use]) => {
    const found = hits(stock, key);
    const item = found.find((s) => !expired(s, day) && left.get(s) > 0 && left.get(s) >= use - 1e-9) || null;
    if (item) left.set(item, left.get(item) - use);
    return { label, key, item, stale: !item && found.some((s) => s.qty > 0 && expired(s, day)) };
  });
}

// The plan in order, each dinner using what the ones before it left.
export function allocate(ids, stock) {
  const left = fresh(stock);
  return ids.map((id, day) => take(stock, left, id, day));
}

// Days from night `day` until the item's use-by date, when that's 3 or fewer; otherwise null.
export const goingOff = (item, day) => (item?.days != null && item.days - day <= 3 ? item.days - day : null);

// The best next dinner: most ingredients in stock, extra credit for using food that's about to go.
function pick(stock, left, cands, day, rand) {
  let best = null;
  let top = -Infinity;
  for (const id of cands) {
    const rows = take(stock, new Map(left), id, day);
    let score = (rows.filter((x) => x.item).length / rows.length) * 10 - dinnerById[id].min / 30 + (rand ? rand() * 2.5 : 0);
    for (const { item } of rows) if (goingOff(item, day) != null) score += (4 - goingOff(item, day)) * 1.5;
    if (score > top) [best, top] = [id, score];
  }
  return best;
}

// Fills the plan up to seven dinners after the ones already in it, without repeating any
// unless the filters leave too few to choose from.
export function extendPlan(ids, stock, filters, rand) {
  const all = dinnerPool(filters);
  const out = [...ids];
  const left = fresh(stock);
  out.forEach((id, day) => take(stock, left, id, day));
  while (out.length < PLAN_DAYS) {
    let cands = all.filter((id) => !out.includes(id));
    if (!cands.length) cands = all.filter((id) => id !== out.at(-1));
    if (!cands.length) break;
    const id = pick(stock, left, cands, out.length, rand);
    take(stock, left, id, out.length);
    out.push(id);
  }
  return out;
}

// Another dinner for day `d`, one not already in the plan or shown there before (`seen`, which
// starts over once every choice has had a turn). Null when there's nothing else to offer.
export function swapDinner(ids, d, stock, filters, seen) {
  const free = dinnerPool(filters).filter((id) => !ids.includes(id));
  seen.add(ids[d]);
  let cands = free.filter((id) => !seen.has(id));
  if (!cands.length) {
    seen.clear();
    seen.add(ids[d]);
    cands = free;
  }
  if (!cands.length) return null;
  const left = fresh(stock);
  ids.slice(0, d).forEach((id, day) => take(stock, left, id, day));
  const id = pick(stock, left, cands, d);
  seen.add(id);
  return id;
}
