import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DINNERS, dinnerById, matches, shopName, seeded, dinnerPool, allocate, extendPlan, swapDinner, goingOff } from '../dinners.js';

const s = (name, qty, days = null) => ({ id: name, name, qty, days });
// Key Record's sample kitchen, as the app hands it over: spinach past its date, milk going tomorrow.
const kitchen = () => [
  s('Diced tomatoes', 4), s('Spaghetti', 2), s('Black beans', 3), s('Olive oil', 1), s('Rice', 1),
  s('Milk', 1, 1), s('Eggs', 12, 9), s('Cheddar cheese', 1), s('Spinach', 1, -2), s('Frozen peas', 2),
];
const uses = (rows, name) => rows.some((x) => x.item?.name === name);

test('ingredients match whole words, not lookalikes', () => {
  assert.ok(matches('Eggs', 'eggs|egg'));
  assert.ok(matches('Large brown eggs', 'eggs|egg'));
  assert.ok(!matches('Eggplant', 'eggs|egg'));
  assert.ok(matches('Cheddar cheese', 'cheddar'));
  assert.ok(matches('Whole wheat spaghetti', 'spaghetti|pasta|penne|rotini|fusilli'));
});

test('broth, powders and sauces only count when the recipe asks for them', () => {
  assert.ok(!matches('Chicken broth', 'chicken breast|chicken'));
  assert.ok(!matches('Garlic powder', 'garlic'));
  assert.ok(!matches('Rice vinegar', 'rice'));
  assert.ok(!matches('Egg noodles', 'eggs|egg'));
  assert.ok(matches('Soy sauce', 'soy sauce'));
  assert.ok(matches('Mild chili powder', 'chili powder'));
});

test('shopping list names come from the first name in the key', () => {
  assert.equal(shopName('frozen peas|peas'), 'Frozen peas');
  assert.equal(shopName('carrots|carrot'), 'Carrots');
});

test('every recipe is quick and complete', () => {
  assert.equal(new Set(DINNERS.map((r) => r.id)).size, DINNERS.length);
  for (const r of DINNERS) {
    assert.ok(r.min <= 30, r.name);
    assert.ok(r.ing.length && r.steps.length && r.tod, r.name);
    for (const [label, key, use] of r.ing) assert.ok(label && key === key.toLowerCase() && use >= 0, `${r.name}: ${label}`);
  }
});

test('filters narrow the recipes', () => {
  assert.equal(dinnerPool().length, DINNERS.length);
  assert.ok(dinnerPool({ veg: true }).every((id) => dinnerById[id].veg));
  assert.ok(dinnerPool({ max: 20 }).every((id) => dinnerById[id].min <= 20));
});

test('each dinner uses what the ones before it left', () => {
  const [frit, rice] = allocate(['frit', 'rice'], kitchen());
  assert.ok(uses(frit, 'Eggs')); // 8 of 12
  const eggs = rice.find((x) => x.key === 'eggs|egg');
  assert.equal(eggs.item, null); // needs 5, only 4 left
});

test('food past its use-by date is not used, and says so', () => {
  const [eggs] = allocate(['eggs'], kitchen());
  const spinach = eggs.find((x) => x.key === 'spinach');
  assert.equal(spinach.item, null);
  assert.equal(spinach.stale, true);
});

test('food is only planned for nights it is still good', () => {
  // The milk goes tomorrow: fine tonight and tomorrow, not the night after.
  assert.ok(uses(allocate(['soup'], kitchen())[0], 'Milk'));
  assert.ok(uses(allocate(['spag', 'soup'], kitchen())[1], 'Milk'));
  const milk = allocate(['spag', 'bowl', 'soup'], kitchen())[2].find((x) => x.key === 'milk');
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
  for (let seed = 1; seed <= 20; seed++) {
    const ids = extendPlan([], kitchen(), {}, seeded(seed));
    const plan = allocate(ids, kitchen());
    assert.ok(uses(plan[0], 'Milk') || uses(plan[1], 'Milk'), `seed ${seed}: ${ids.slice(0, 2)}`);
  }
});

test('rolling on keeps the dinners already planned', () => {
  const ids = extendPlan([], kitchen(), {}, seeded(2));
  const next = extendPlan(ids.slice(1), kitchen(), {}, seeded(3));
  assert.deepEqual(next.slice(0, 6), ids.slice(1));
  assert.equal(next.length, 7);
});

test('too few recipes for a week: repeats, never two nights running', () => {
  const ids = extendPlan([], kitchen(), { max: 20, veg: true }, seeded(1));
  assert.equal(ids.length, 7);
  assert.ok(ids.every((id) => dinnerById[id].veg && dinnerById[id].min <= 20));
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
  const ids = dinnerPool({ max: 20, veg: true });
  assert.equal(swapDinner(ids, 0, kitchen(), { max: 20, veg: true }, new Set()), null);
});
