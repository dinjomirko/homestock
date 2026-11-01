import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slim, fingerprint, mergeItem, mergeList, mergeSettings, newest } from '../merge.js';

const item = (fields) => ({ id: 'a', name: 'Diced tomatoes', qty: 4, unit: 'can', location: 'Pantry', updated: 1, ...fields });

test('two people each using one: both count', () => {
  const base = slim(item());
  const out = mergeItem(base, item({ qty: 3, updated: 5 }), item({ qty: 3, updated: 6 }));
  assert.equal(out.qty, 2);
});

test('one adds, the other uses', () => {
  const base = slim(item());
  assert.equal(mergeItem(base, item({ qty: 10, updated: 5 }), item({ qty: 3, updated: 6 })).qty, 9);
});

test('a count can not go below zero', () => {
  const base = slim(item({ qty: 1 }));
  assert.equal(mergeItem(base, item({ qty: 0, updated: 5 }), item({ qty: 0, updated: 6 })).qty, 0);
});

test('a typed-in count stands as typed', () => {
  const base = slim(item());
  assert.equal(mergeItem(base, item({ qty: 12, updated: 5 }), item({ qty: 3, updated: 6 }), { absolute: true }).qty, 12);
});

test('different fields changed on each side: both kept', () => {
  const base = slim(item());
  const out = mergeItem(base, item({ name: 'Crushed tomatoes', updated: 5 }), item({ qty: 2, store: 'Aldi', updated: 6 }));
  assert.equal(out.name, 'Crushed tomatoes');
  assert.equal(out.qty, 2);
  assert.equal(out.store, 'Aldi');
  assert.equal(out.updated, 6);
});

test('the same field changed on both sides: the later edit wins', () => {
  const base = slim(item());
  assert.equal(mergeItem(base, item({ location: 'Garage', updated: 9 }), item({ location: 'Fridge', updated: 6 })).location, 'Garage');
  assert.equal(mergeItem(base, item({ location: 'Garage', updated: 5 }), item({ location: 'Fridge', updated: 6 })).location, 'Fridge');
});

test('a field removed on one side stays removed', () => {
  const base = slim(item({ opened: '2026-10-30' }));
  const out = mergeItem(base, item({ updated: 5 }), item({ opened: '2026-10-30', qty: 5, updated: 6 }));
  assert.equal('opened' in out, false);
  assert.equal(out.qty, 5);
});

test('counts kept in other places merge per place', () => {
  const base = slim(item({ qty: 18, spots: { Garage: 12 } }));
  const out = mergeItem(base, item({ qty: 17, spots: { Garage: 11 }, updated: 5 }), item({ qty: 17, spots: { Garage: 11 }, updated: 6 }));
  assert.equal(out.qty, 16);
  assert.deepEqual(out.spots, { Garage: 10 });
});

test('photos are compared by a short hash, and a new photo on one side is kept', () => {
  const photo = `data:image/jpeg;base64,${'A'.repeat(5000)}`;
  const other = `data:image/jpeg;base64,${'B'.repeat(5000)}`;
  const base = slim(item({ image: photo }));
  assert.ok(JSON.stringify(base).length < 400);
  const out = mergeItem(base, item({ image: other, updated: 5 }), item({ image: photo, qty: 1, updated: 6 }));
  assert.equal(out.image, other);
  assert.equal(out.qty, 1);
});

test('no common copy: the newer one is kept', () => {
  assert.equal(newest(item({ updated: 9 }), item({ updated: 3 })).updated, 9);
  assert.equal(mergeItem(undefined, item({ qty: 1, updated: 2 }), item({ qty: 7, updated: 3 })).qty, 7);
});

test('fingerprints ignore key order', () => {
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
});

test('lists: additions and removals from both sides', () => {
  assert.deepEqual(mergeList(['Costco', 'Aldi', 'Target'], ['Costco', 'Aldi', 'Jewel'], ['Costco', 'Target', 'Walmart']), ['Costco', 'Jewel', 'Walmart']);
});

test('lists: a reorder on one side is kept', () => {
  assert.deepEqual(mergeList(['Pantry', 'Fridge', 'Garage'], ['Garage', 'Pantry', 'Fridge'], ['Pantry', 'Fridge', 'Garage']), ['Garage', 'Pantry', 'Fridge']);
});

test('settings: a store added here and a place added there both stay', () => {
  const base = { stores: ['Costco'], places: ['Pantry'], subPlaces: { Garage: ['Shelf 1'] } };
  const local = { stores: ['Costco', 'Aldi'], places: ['Pantry'], subPlaces: { Garage: ['Shelf 1', 'Shelf 2'] } };
  const remote = { stores: ['Costco'], places: ['Pantry', 'Basement'], subPlaces: { Garage: ['Shelf 1'], Basement: ['Bin A'] } };
  assert.deepEqual(mergeSettings(base, local, remote), {
    stores: ['Costco', 'Aldi'],
    places: ['Pantry', 'Basement'],
    subPlaces: { Garage: ['Shelf 1', 'Shelf 2'], Basement: ['Bin A'] },
  });
});

test('settings: spots added on both sides in the same place', () => {
  const base = { subPlaces: { Garage: ['Shelf 1'] } };
  const out = mergeSettings(base, { subPlaces: { Garage: ['Shelf 1', 'Shelf 2'] } }, { subPlaces: { Garage: ['Shelf 1', 'Workbench'] } });
  assert.deepEqual(out.subPlaces.Garage, ['Shelf 1', 'Shelf 2', 'Workbench']);
});
