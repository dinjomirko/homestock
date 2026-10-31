import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, resolveActions, matchItem, guessLocation, parsePack, guessEmoji, parseDate, parseListLines, suggestShelfLife, openLife } from '../parser.js';

const one = (text) => {
  const r = parseCommand(text);
  assert.equal(r.length, 1, `expected one action for "${text}", got ${JSON.stringify(r)}`);
  return r[0];
};

test('removing a roll of paper towels from the stock', () => {
  assert.deepEqual(one('Removing a roll of paper towels from the stock'), {
    action: 'remove', qty: 1, unit: 'roll', name: 'paper towels', location: null,
  });
});

test('quantities in words and digits', () => {
  assert.equal(one('used two cans of tomatoes').qty, 2);
  assert.equal(one('bought 3 boxes of pasta').qty, 3);
  assert.equal(one('got a dozen eggs').qty, 12);
  assert.equal(one('used half a bag of flour').qty, 0.5);
  assert.equal(one('used to cans of beans').qty, 2); // speech often hears "two" as "to"
  assert.equal(one('grabbed another can of soup').name, 'soup');
});

test('filler words before the verb', () => {
  const a = one("So I'm going to use 2 cans of black beans");
  assert.equal(a.action, 'remove');
  assert.equal(a.name, 'black beans');
});

test('several items in one sentence share the verb', () => {
  const r = parseCommand('Used two cans of tomatoes and a box of pasta');
  assert.deepEqual(r.map((a) => [a.action, a.qty, a.name]), [['remove', 2, 'tomatoes'], ['remove', 1, 'pasta']]);
  const r2 = parseCommand('bought milk, eggs and 2 loaves of bread');
  assert.deepEqual(r2.map((a) => [a.action, a.qty, a.name]), [['add', 1, 'milk'], ['add', 1, 'eggs'], ['add', 2, 'bread']]);
});

test('"and" inside a product name is kept', () => {
  assert.equal(one('bought a bag of salt and vinegar chips').name, 'salt and vinegar chips');
});

test('out, need, set', () => {
  assert.equal(one("We're out of paper towels").action, 'out');
  assert.equal(one('used the last of the olive oil').name, 'olive oil');
  assert.equal(one('running low on dish soap').action, 'need');
  const list = one('add milk to the shopping list');
  assert.deepEqual([list.action, list.name], ['need', 'milk']);
  const set = one('We have 5 rolls of duct tape');
  assert.deepEqual([set.action, set.qty, set.name], ['set', 5, 'duct tape']);
  const set2 = one('set paper towels to 4');
  assert.deepEqual([set2.action, set2.qty, set2.name], ['set', 4, 'paper towels']);
});

test('questions are answered, not applied', () => {
  for (const [text, name] of [
    ['How many paper towels do we have?', 'paper towels'],
    ['do we have any eggs', 'eggs'],
    ['how many rolls of toilet paper are left', 'toilet paper'],
    ['is there any milk in the fridge', 'milk'],
    ['where are the AA batteries', 'aa batteries'],
  ]) {
    const a = one(text);
    assert.deepEqual([a.action, a.name], ['query', name], text);
  }
});

test('taking things off the shopping list', () => {
  for (const [text, name] of [
    ['remove milk from the shopping list', 'milk'],
    ['take the coffee off the list', 'coffee'],
    ["we don't need paper towels", 'paper towels'],
    ['cross eggs off the list', 'eggs'],
    ['delete olive oil from the grocery list', 'olive oil'],
  ]) {
    const a = one(text);
    assert.deepEqual([a.action, a.name], ['unlist', name], text);
  }
  // Without "list" it still means using something up.
  assert.equal(one('remove a roll of paper towels').action, 'remove');
  assert.equal(one('add milk to the list').action, 'need');
});

test('stores: list for a store, and where something was bought', () => {
  const stores = ['Costco', 'Aldi', "Trader Joe's"];
  const p = (t) => {
    const r = parseCommand(t, { stores });
    assert.equal(r.length, 1, t);
    return [r[0].action, r[0].qty, r[0].name, r[0].store];
  };
  assert.deepEqual(p('add milk to the Costco list'), ['need', null, 'milk', 'Costco']);
  assert.deepEqual(p('put paper towels on the costco shopping list'), ['need', null, 'paper towels', 'Costco']);
  assert.deepEqual(p('we need eggs from aldi'), ['need', null, 'eggs', 'Aldi']);
  assert.deepEqual(p('bought 2 boxes of pasta at costco'), ['add', 2, 'pasta', 'Costco']);
  assert.deepEqual(p('take milk off the aldi list'), ['unlist', null, 'milk', 'Aldi']);
  assert.deepEqual(p('add bananas to the trader joes list'), ['need', null, 'bananas', "Trader Joe's"]);
  // An unknown store name doesn't swallow the item.
  assert.deepEqual(p('add milk to the list'), ['need', null, 'milk', undefined]);
});

test('store at the end, misheard store names, cut-off phrases', () => {
  const stores = ['Costco', 'Aldi'];
  const p = (t, opts = {}) => {
    const r = parseCommand(t, { stores, ...opts });
    assert.equal(r.length, 1, t);
    return [r[0].action, r[0].name, r[0].store];
  };
  assert.deepEqual(p('add tomatoes to the shopping list for jewel cosco'), ['need', 'tomatoes', 'Jewel-Osco']);
  assert.deepEqual(p('add tomatoes to the shopping list for Jewel'), ['need', 'tomatoes', 'Jewel-Osco']);
  assert.deepEqual(p('add milk to the cosco list'), ['need', 'milk', 'Costco']);
  assert.deepEqual(p('put eggs on the list at aldi'), ['need', 'eggs', 'Aldi']);
  assert.deepEqual(p('add yogurt to the shopping'), ['need', 'yogurt', undefined]);
  // Not a store: stays part of the request rather than inventing one.
  assert.deepEqual(p('add milk to the list for tomorrow'), ['need', 'milk', undefined]);
});

test('on the shopping list, "add X" means put it on the list', () => {
  assert.equal(one('add bananas').action, 'add');
  assert.equal(parseCommand('add bananas', { listContext: true })[0].action, 'need');
  assert.equal(parseCommand('get 2 boxes of cereal', { listContext: true })[0].action, 'need');
  // Past tense still means you bought it.
  assert.equal(parseCommand('bought bananas', { listContext: true })[0].action, 'add');
});

test('moving things off the list into stock', () => {
  const p = (t) => {
    const r = parseCommand(t);
    assert.equal(r.length, 1, t);
    return [r[0].action, r[0].qty, r[0].name, r[0].location];
  };
  assert.deepEqual(p('move tomatoes from shopping list to pantry'), ['restock', null, 'tomatoes', 'Pantry']);
  assert.deepEqual(p('Move the tomatoes from the shopping list to the pantry'), ['restock', null, 'tomatoes', 'Pantry']);
  assert.deepEqual(p('put the eggs from the list in the fridge'), ['restock', null, 'eggs', 'Fridge']);
  assert.deepEqual(p('move 2 cans of tomatoes from the list to the pantry'), ['restock', 2, 'tomatoes', 'Pantry']);
  assert.deepEqual(p('mark paper towels as bought'), ['restock', null, 'paper towels', null]);
  assert.deepEqual(p('check off milk'), ['restock', null, 'milk', null]);
  assert.deepEqual(p('move the batteries to the garage'), ['restock', null, 'batteries', 'Garage']);
  assert.deepEqual(p('move tomatoes from the fridge to the pantry'), ['restock', null, 'tomatoes', 'Pantry']);
  // Unchanged: taking something off the list, and asking about something.
  assert.equal(one('remove milk from the shopping list').action, 'unlist');
  assert.equal(one('check on the milk').action, 'query');
});

test('location at the end of a sentence', () => {
  const a = one('Took 2 cans of paint out of the garage');
  assert.deepEqual([a.action, a.qty, a.name, a.location], ['remove', 2, 'paint', 'Garage']);
  assert.equal(one('put 3 boxes of screws in the garage').location, 'Garage');
});

const items = [
  { id: '1', name: 'Paper Towels', brand: 'Bounty', qty: 6 },
  { id: '2', name: 'Toilet Paper', brand: 'Charmin', qty: 12 },
  { id: '3', name: 'Diced Tomatoes', qty: 4 },
  { id: '4', name: 'Milk', qty: 1 },
  { id: '5', name: 'Eggs', qty: 12 },
  { id: '6', name: 'Strawberries', qty: 1 },
];

test('matching handles plurals, brands and partial names', () => {
  assert.equal(matchItem('paper towel', items).item.id, '1');
  assert.equal(matchItem('bounty', items).item.id, '1');
  assert.equal(matchItem('toilet paper', items).item.id, '2');
  assert.equal(matchItem('tomatoes', items).item.id, '3');
  assert.equal(matchItem('strawberry', items).item.id, '6');
  assert.equal(matchItem('flour', items), null);
});

test('resolve splits "milk and eggs" when each matches', () => {
  const r = resolveActions(parseCommand('add milk and eggs to the shopping list'), items);
  assert.deepEqual(r.map((a) => a.item?.id), ['4', '5']);
});

test('an "and" list is split unless one item has every word', () => {
  const r = resolveActions(parseCommand('add coffee and paper towels to the list'), items);
  assert.deepEqual(r.map((a) => [a.name, a.item?.id ?? null]), [['coffee', null], ['paper towels', '1']]);
  const chips = [...items, { id: '7', name: 'Salt and Vinegar Chips', qty: 2 }];
  const r2 = resolveActions(parseCommand('used a bag of salt and vinegar chips'), chips);
  assert.deepEqual(r2.map((a) => a.item?.id), ['7']);
});

test('list requests use your exact words; stock changes match loosely', () => {
  const need = (t) => resolveActions(parseCommand(t), items)[0].item?.id ?? null;
  assert.equal(need('add tomatoes to the list'), null); // not "Diced Tomatoes"
  assert.equal(need('add diced tomatoes to the list'), '3');
  assert.equal(need('add paper towels to the list'), '1');
  assert.equal(need('add bounty paper towels to the list'), '1'); // brand is ignored
  assert.equal(need('we need milk'), '4');
  const packaged = [{ id: '9', name: 'Charmin Ultra Soft Toilet Paper 12 Mega Rolls', brand: 'Charmin', qty: 3 }];
  assert.equal(resolveActions(parseCommand('add ultra soft toilet paper rolls to the list'), packaged)[0].item?.id, '9');
  const sized = [{ id: '10', name: 'Diced Tomatoes 14.5 Ounces Value Pack', brand: "Hunt's", qty: 2 }];
  assert.equal(resolveActions(parseCommand('add diced tomatoes to the list'), sized)[0].item?.id, '10');
  // Using something up still finds what you have.
  assert.equal(resolveActions(parseCommand('used 2 cans of tomatoes'), items)[0].item?.id, '3');
});

test('guessing location and pack size', () => {
  assert.equal(guessLocation('Charmin Ultra Soft Toilet Paper'), 'Bathroom');
  assert.equal(guessLocation('Bounty Paper Towels'), 'Pantry');
  assert.equal(guessLocation('Gorilla Duct Tape'), 'Garage');
  assert.equal(guessLocation('Greek yogurt'), 'Fridge');
  assert.deepEqual(parsePack('12 Mega Rolls'), { count: 12, unit: 'roll' });
  assert.deepEqual(parsePack('4 bars'), { count: 4, unit: 'bar' });
  assert.equal(parsePack('500 g'), null);
});

test('emoji placeholders', () => {
  for (const [name, emoji] of [
    ['Diced tomatoes', '🍅'], ['Paper towels', '🧻'], ['Toilet paper', '🧻'], ['Milk', '🥛'], ['Sour cream', '🥛'],
    ['Cheddar cheese', '🧀'], ['Eggs', '🥚'], ['Eggplant', '🍆'], ['Toothpaste', '🪥'], ['Shampoo', '🧴'],
    ['AA batteries', '🔋'], ['Wood screws 1-5/8"', '🔩'], ['Duct tape', '🧰'], ['Black beans', '🫘'], ['Frozen peas', '🫛'],
    ['Olive oil', '🫒'], ['Spaghetti', '🍝'], ['Coffee', '☕'], ['Peanut butter', '🥜'], ['Dog food', '🐶'],
  ]) assert.equal(guessEmoji(name), emoji, name);
  assert.equal(guessEmoji('Furnace filter 16x25x1'), '🧰');
  assert.equal(guessEmoji('Mystery thing', 'Garage'), '🧰');
  assert.equal(guessEmoji('Mystery thing', 'Fridge'), '🧊');
  assert.equal(guessEmoji('Mystery thing'), '📦');
});

// Saturday, October 31, 2026
const TODAY = new Date(2026, 9, 31);

test('dates said out loud', () => {
  for (const [said, date] of [
    ['today', '2026-10-31'], ['tomorrow', '2026-11-01'], ['friday', '2026-11-06'], ['saturday', '2026-11-07'],
    ['in 5 days', '2026-11-05'], ['a week', '2026-11-07'], ['2 weeks', '2026-11-14'], ['next month', '2026-11-30'],
    ['november 20th', '2026-11-20'], ['the 12th', '2026-11-12'], ['11/20', '2026-11-20'], ['jan 3', '2027-01-03'],
  ]) assert.equal(parseDate(said, TODAY), date, said);
  assert.equal(parseDate('whenever', TODAY), null);
});

test('use-by by voice', () => {
  const p = (t) => { const [a] = parseCommand(t, { today: TODAY }); return [a.action, a.name, a.useBy]; };
  assert.deepEqual(p('milk expires friday'), ['expiry', 'milk', '2026-11-06']);
  assert.deepEqual(p('the yogurt expires in 5 days'), ['expiry', 'yogurt', '2026-11-05']);
  assert.deepEqual(p('use the spinach by tomorrow'), ['expiry', 'spinach', '2026-11-01']);
  assert.deepEqual(p('eggs are good until november 20th'), ['expiry', 'eggs', '2026-11-20']);
});

test('opened and how much is left', () => {
  assert.deepEqual([one('opened the salsa').action, one('opened the salsa').name], ['open', 'salsa']);
  const lv = (t) => { const [a] = parseCommand(t); return [a.action, a.name, a.level]; };
  assert.deepEqual(lv('half a bottle of olive oil left'), ['level', 'olive oil', 0.5]);
  assert.deepEqual(lv('there is a quarter of the dish soap left'), ['level', 'dish soap', 0.25]);
  assert.deepEqual(lv('a little milk left'), ['level', 'milk', 0.1]);
  assert.deepEqual(lv('the shampoo is almost empty'), ['level', 'shampoo', 0.1]);
  assert.deepEqual(lv('the olive oil is half full'), ['level', 'olive oil', 0.5]);
  assert.deepEqual(lv('the ketchup is a quarter gone'), ['level', 'ketchup', 0.75]);
});

test('shelf life suggestions', () => {
  assert.equal(suggestShelfLife('Milk', 'Fridge'), 7);
  assert.equal(suggestShelfLife('Strawberries'), 4);
  assert.equal(suggestShelfLife('Diced tomatoes', 'Pantry'), null);
  assert.equal(suggestShelfLife('Frozen peas', 'Freezer'), null);
  assert.equal(openLife('Salsa'), 7);
  assert.equal(openLife('Rice'), null);
});

test('pasted lists, including receipt text', () => {
  const r = parseListLines('- Milk\n☐ 2 cans of tomatoes\nBREAD x2\nGV MLK 2% GAL 3.49 F\nSUBTOTAL 12.34\n• paper towels\n\n4.99');
  assert.deepEqual(r.map((i) => [i.name, i.qty, i.unit]), [
    ['milk', 1, ''], ['tomatoes', 2, 'can'], ['bread', 2, ''], ['gv mlk 2 gal', 1, ''], ['paper towels', 1, ''],
  ]);
});
