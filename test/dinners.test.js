import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOODS, DINNERS, dinnerById, matches, shopName, seeded, dinnerPool, allocate, extendPlan, planWeek, swapDinner, goingOff,
  needed, inStock, stockKey,
} from '../dinners.js';

const s = (name, qty, days = null, unit = '') => ({ id: name, name, qty, unit, days });
// Key Record's sample kitchen, as the app hands it over: spinach past its date, milk going tomorrow.
const kitchen = () => [
  s('Diced tomatoes', 4), s('Spaghetti', 2), s('Black beans', 3), s('Olive oil', 1), s('Rice', 1),
  s('Milk', 1, 1), s('Eggs', 12, 9), s('Cheddar cheese', 1), s('Spinach', 1, -2), s('Frozen peas', 2),
];
const uses = (rows, name) => rows.some((x) => x.item?.name === name && !x.short);
const row = (rows, food) => rows.find((x) => x.food === food);
const foodsOf = (name) => Object.keys(FOODS).filter((f) => matches(name, f));
const haveAll = (rows) => inStock(rows) === needed(rows).length;

test('foods match whole words, plurals and singulars, not lookalikes', () => {
  assert.deepEqual(foodsOf('Large brown eggs'), ['eggs']);
  assert.deepEqual(foodsOf('Eggplant'), []);
  assert.deepEqual(foodsOf('Black bean'), ['beans']);
  assert.deepEqual(foodsOf('Dark Red Kidney Beans'), ['beans']);
  assert.deepEqual(foodsOf('Flour tortillas'), ['tortillas']);
  assert.deepEqual(foodsOf('Boneless chicken thighs'), ['chicken']);
  assert.deepEqual(foodsOf('Whole wheat penne pasta'), ['pasta']);
  assert.deepEqual(foodsOf('Peas and carrots'), ['peas', 'carrots']);
});

test('things named after a food that are something else', () => {
  for (const name of ['Chicken broth', 'Chicken nuggets', 'Cream of chicken', 'Garlic powder', 'Rice vinegar', 'Egg noodles', 'Corn tortilla chips', 'Original Potato Chips', 'Sweet potato fries', 'Pasta sauce', 'Taco shells', 'Rice Krispies', 'Mozzarella string cheese', 'Peanut butter']) {
    const wrong = foodsOf(name).filter((f) => !['broth', 'tortillas', 'marinara', 'tacoShells'].includes(f));
    assert.deepEqual(wrong, [], name);
  }
  assert.deepEqual(foodsOf('Pasta sauce'), ['marinara']);
  assert.deepEqual(foodsOf('Reduced sodium chicken broth'), ['broth']);
});

test('names from a real pantry', () => {
  assert.deepEqual(foodsOf('Chick peas, garbanzos'), ['chickpeas']); // not peas
  assert.deepEqual(foodsOf('Shrimp Creole Mix'), []);
  assert.deepEqual(foodsOf('Spring roll Rice Wraps'), []);
  assert.deepEqual(foodsOf('Jambalaya Long Grain Rice Mix with Vegetables & Spices'), []);
  assert.deepEqual(foodsOf('Sun Dried Tomatoes in Extra Virgin Olive Oil'), []);
  assert.deepEqual(foodsOf('100% Pure Organic Avocado Oil'), ['oil']);
  assert.deepEqual(foodsOf('Plain panko bread crumbs'), ['breadcrumbs']);
  assert.deepEqual(foodsOf('Coconut cream of cans milliliter each'), ['coconutMilk']);
  assert.deepEqual(foodsOf('Gold Standard 100% Whey Extreme Milk Chocolate'), []);
  assert.deepEqual(foodsOf('Original Taco Seasoning Mix'), ['tacoSpice']);
  assert.deepEqual(foodsOf('Chunk Chicken Breast'), ['chicken']);
  assert.deepEqual(foodsOf('AHI YELLOWFIN TUNA'), ['tuna']);
  assert.deepEqual(foodsOf('Medium Grain Rice Musenmai'), ['rice']);
});

test('shopping list names', () => {
  assert.equal(shopName('peas'), 'Frozen peas');
  assert.equal(shopName('groundMeat'), 'Ground turkey');
});

test('every recipe is quick, complete and calls for known foods', () => {
  assert.equal(new Set(DINNERS.map((r) => r.id)).size, DINNERS.length);
  for (const r of DINNERS) {
    assert.ok(r.min <= 30, r.name);
    assert.ok(r.steps.length && r.tod, r.name);
    assert.ok(r.ing.some(([, , , opt]) => !opt), `${r.name}: needs something`);
    for (const [label, foods, use = 0] of r.ing) {
      const list = typeof foods === 'string' ? [foods] : Array.isArray(foods) ? foods : Object.keys(foods);
      for (const f of list) assert.ok(FOODS[f], `${r.name}: ${label} (${f})`);
      assert.ok(label && use >= 0, `${r.name}: ${label}`);
    }
  }
});

test('filters narrow the recipes', () => {
  assert.equal(dinnerPool().length, DINNERS.length);
  assert.ok(dinnerPool({ veg: true }).every((id) => dinnerById[id].veg));
  assert.ok(dinnerPool({ max: 20 }).every((id) => dinnerById[id].min <= 20));
  assert.ok(dinnerPool({ max: 20, veg: true }).length >= 7); // a meatless week without repeats
});

test('each dinner uses what the ones before it left; too little shows as not enough', () => {
  const [frit, rice] = allocate(['frit', 'rice'], kitchen());
  assert.ok(uses(frit, 'Eggs')); // 8 of 12
  const eggs = row(rice, 'eggs');
  assert.equal(eggs.short, true); // needs 5, only 4 left
  assert.equal(inStock(rice), needed(rice).filter((x) => x.item && !x.short).length);
});

test('eggs kept by the carton', () => {
  const two = [s('Eggs', 2, null, 'carton')];
  assert.ok(uses(allocate(['frit'], two)[0], 'Eggs'));
  assert.ok(uses(allocate(['frit'], [s('Eggs', 2)])[0], 'Eggs')); // no unit, 2: cartons
  assert.equal(row(allocate(['frit'], [s('Eggs', 6)])[0], 'eggs').short, true); // 6 eggs
});

test('canned chicken counts by the can: four cans make two dinners', () => {
  const stock = [s('Chunk Chicken Breast', 4)];
  const plan = allocate(['tacn', 'bowl', 'past'], stock);
  assert.ok(uses(plan[0], 'Chunk Chicken Breast'));
  assert.ok(uses(plan[1], 'Chunk Chicken Breast'));
  assert.equal(row(plan[2], 'chicken').item, null);
});

test('another food can stand in, in its own amount', () => {
  const [spag] = allocate(['spag'], [s('Tomato Paste', 1)]);
  assert.ok(uses(spag, 'Tomato Paste'));
  const [chili] = allocate(['chil'], [s('Black beans', 1)]); // needs 2 cans
  assert.equal(row(chili, 'beans').short, true);
});

test('optional extras don’t count against a dinner', () => {
  const [spag] = allocate(['spag'], []);
  assert.ok(needed(spag).every((x) => !x.opt));
  assert.ok(spag.some((x) => x.opt && x.food === 'parmesan'));
});

test('food past its use-by date is not used, and says so', () => {
  const spinach = row(allocate(['spag'], kitchen())[0], 'spinach');
  assert.equal(spinach.item, null);
  assert.equal(spinach.stale, true);
});

test('food is only planned for nights it is still good', () => {
  // The milk goes tomorrow: fine tonight and tomorrow, not the night after.
  assert.ok(uses(allocate(['soup'], kitchen())[0], 'Milk'));
  assert.ok(uses(allocate(['spag', 'soup'], kitchen())[1], 'Milk'));
  const milk = row(allocate(['spag', 'bowl', 'soup'], kitchen())[2], 'milk');
  assert.equal(milk.item, null);
  assert.equal(milk.stale, true);
});

test('going off counts from the night of the dinner', () => {
  assert.equal(goingOff({ days: 1 }, 0), 1);
  assert.equal(goingOff({ days: 5 }, 3), 2);
  assert.equal(goingOff({ days: 9 }, 0), null);
  assert.equal(goingOff({ days: null }, 0), null);
  assert.equal(goingOff(null, 0), null);
});

test('a week is seven different dinners, the same each time for the same seed', () => {
  const a = extendPlan([], kitchen(), {}, seeded(5));
  assert.equal(a.length, 7);
  assert.equal(new Set(a).size, 7);
  assert.deepEqual(extendPlan([], kitchen(), {}, seeded(5)), a);
});

test('milk that goes tomorrow is used in the first two dinners', () => {
  const ids = planWeek(Array(7).fill(null), kitchen(), {});
  const plan = allocate(ids, kitchen());
  assert.ok(uses(plan[0], 'Milk') || uses(plan[1], 'Milk'), ids.slice(0, 2).join());
});

test('a pantry of beans, pasta and broth gets pantry dinners', () => {
  const pantry = [s('Great Northern Beans', 1), s('Orzo', 1), s('Reduced sodium chicken broth', 1), s('Tomato Paste', 2), s('Yellow onion', 3, null, 'pound'), s('Granulated garlic', 1)];
  const [first] = allocate(planWeek(Array(7).fill(null), pantry, {}), pantry);
  assert.equal(haveAll(first), true);
});

test('rolling on keeps the dinners already planned', () => {
  const ids = extendPlan([], kitchen(), {}, seeded(2));
  const next = extendPlan(ids.slice(1), kitchen(), {}, seeded(3));
  assert.deepEqual(next.slice(0, 6), ids.slice(1));
  assert.equal(next.length, 7);
});

test('re-planning keeps the nights it is told to, where they are', () => {
  const fixed = [null, null, 'curr', null, null, 'macc', null];
  const ids = planWeek(fixed, kitchen(), {}, seeded(1));
  assert.equal(ids[2], 'curr');
  assert.equal(ids[5], 'macc');
  assert.equal(new Set(ids).size, 7);
});

test('too few recipes for a week: repeats, never two nights running', () => {
  const filters = { max: 15, veg: true };
  const ids = extendPlan([], kitchen(), filters, seeded(1));
  assert.equal(ids.length, 7);
  assert.ok(ids.every((id) => dinnerById[id].veg && dinnerById[id].min <= 15));
  for (let i = 1; i < ids.length; i++) assert.notEqual(ids[i], ids[i - 1]);
});

test('swap offers each other dinner once before starting over', () => {
  const ids = extendPlan([], kitchen(), {}, seeded(4));
  const free = dinnerPool().filter((id) => !ids.includes(id));
  const seen = new Set();
  const offered = free.map(() => {
    const id = swapDinner(ids, 2, kitchen(), {}, seen);
    assert.ok(!ids.includes(id));
    return id;
  });
  assert.deepEqual([...offered].sort(), [...free].sort());
  assert.ok(free.includes(swapDinner(ids, 2, kitchen(), {}, seen)));
});

test('swap has nothing to offer when every allowed dinner is planned', () => {
  const filters = { max: 15, veg: true };
  assert.equal(swapDinner(dinnerPool(filters), 0, kitchen(), filters, new Set()), null);
});

test('the stock fingerprint changes with the food, not with anything else', () => {
  const a = stockKey(kitchen());
  assert.equal(stockKey(kitchen()), a);
  assert.notEqual(stockKey([...kitchen().slice(1), s('Diced tomatoes', 3)]), a);
  assert.equal(stockKey([...kitchen(), s('Coffee beans', 2)]), a);
});
