import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, resolveActions, matchItem, guessLocation, parsePack } from '../parser.js';

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

test('guessing location and pack size', () => {
  assert.equal(guessLocation('Charmin Ultra Soft Toilet Paper'), 'Bathroom');
  assert.equal(guessLocation('Bounty Paper Towels'), 'Pantry');
  assert.equal(guessLocation('Gorilla Duct Tape'), 'Garage');
  assert.equal(guessLocation('Greek yogurt'), 'Fridge');
  assert.deepEqual(parsePack('12 Mega Rolls'), { count: 12, unit: 'roll' });
  assert.deepEqual(parsePack('4 bars'), { count: 4, unit: 'bar' });
  assert.equal(parsePack('500 g'), null);
});
