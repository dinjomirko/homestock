// Several phones in one household, against a stand-in for the database, to check that changes
// made at the same time (or offline) all survive.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const at = (s) => Date.parse(String(s));
const tick = () => new Promise((r) => setTimeout(r, 5));
async function settle() {
  for (let i = 0; i < 12; i++) await tick();
}

// ---------- The stand-in database ----------

function makeServer() {
  const tables = { items: [], household_settings: [], members: [] };
  const listeners = []; // { client, table, household, cb }
  const deliver = (table, row) => {
    for (const l of listeners) {
      if (l.table === table && l.household === row.household_id && l.client.online) setTimeout(() => l.client.online && l.cb({ new: clone(row) }), 1);
    }
  };
  return { tables, listeners, deliver };
}

function makeClient(server, userId) {
  const client = { online: true };
  const offline = () => ({ data: null, error: { message: 'TypeError: Failed to fetch' } });
  client.auth = { getSession: async () => ({ data: { session: { user: { id: userId, email: `${userId}@example.com` } } } }) };
  client.from = (table) => {
    const rows = server.tables[table];
    const filters = [];
    let op = 'select';
    let payload = null;
    let returning = false;
    let single = false;
    const match = (r) => filters.every(([col, kind, v]) => (kind === 'in' ? v.includes(r[col]) : col === 'updated_at' ? at(r[col]) === at(v) : r[col] === v));
    const exec = async () => {
      await tick();
      if (!client.online) return offline();
      if (op === 'select') {
        const found = rows.filter(match).map(clone);
        return { data: single ? found[0] || null : found, error: null };
      }
      if (op === 'insert') {
        const list = [].concat(payload);
        if (list.some((n) => rows.some((r) => r.household_id === n.household_id && r.id === n.id))) return { data: null, error: { code: '23505', message: 'duplicate key' } };
        for (const n of list) {
          rows.push(clone(n));
          server.deliver(table, n);
        }
        return { data: null, error: null };
      }
      if (op === 'update') {
        const hit = rows.filter(match);
        for (const r of hit) {
          Object.assign(r, clone(payload));
          server.deliver(table, r);
        }
        return { data: returning ? hit.map(clone) : null, error: null };
      }
      if (op === 'upsert') {
        for (const n of [].concat(payload)) {
          const key = table === 'household_settings' ? (r) => r.household_id === n.household_id : (r) => r.household_id === n.household_id && r.id === n.id;
          const old = rows.find(key);
          if (old) Object.assign(old, clone(n));
          else rows.push(clone(n));
          server.deliver(table, old || n);
        }
        return { data: null, error: null };
      }
    };
    const q = {
      select: () => ((returning = op !== 'select'), q),
      eq: (col, v) => (filters.push([col, 'eq', v]), q),
      in: (col, v) => (filters.push([col, 'in', v]), q),
      order: () => q,
      range: () => q,
      maybeSingle: () => ((single = true), q),
      insert: (v) => ((op = 'insert'), (payload = v), q),
      update: (v) => ((op = 'update'), (payload = v), q),
      upsert: (v) => ((op = 'upsert'), (payload = v), q),
      then: (ok, bad) => exec().then(ok, bad),
    };
    return q;
  };
  client.channel = () => {
    const subs = [];
    const ch = {
      on: (_, { table, filter }, cb) => (subs.push({ client, table, household: filter.split('eq.')[1], cb }), ch),
      subscribe: (cb) => {
        server.listeners.push(...subs);
        setTimeout(() => cb('SUBSCRIBED'), 1);
        return ch;
      },
      unsubscribe: () => subs.forEach((s) => server.listeners.splice(server.listeners.indexOf(s), 1)),
    };
    return ch;
  };
  client.rpc = async () => ({ data: null, error: null });
  return client;
}

function makeStorage(entries = {}) {
  const m = new Map(Object.entries(entries));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

// ---------- A phone: the app's side of the hooks, plus its own copy of sync.js ----------

let n = 0;
async function phone(server, name, { household = 'h1', items = [], settings = { stores: ['Costco'], places: ['Pantry'], subPlaces: {}, rooms: [] } } = {}) {
  const sync = await import(`../sync.js?phone=${++n}`);
  const client = makeClient(server, name);
  server.tables.members.push({ household_id: household, user_id: name, name, role: 'member', joined_at: n });
  const storage = makeStorage({
    'homestock.auth': '{}',
    'homestock.sync': JSON.stringify({ householdId: household, code: 'ABCD1234', name }),
  });
  sync._testSetup({ client, storage });
  const p = {
    name, sync, client, items: clone(items), settings: clone(settings), removed: false,
    byName: (x) => p.items.find((i) => i.name === x),
    async change(fn) {
      fn(p);
      sync.pushSoon(0);
      await settle();
    },
  };
  await sync.initSync({
    items: () => p.items,
    applyRemote: (changes) => {
      for (const { id, item } of changes) {
        const i = p.items.findIndex((x) => x.id === id);
        if (item && i >= 0) p.items[i] = item;
        else if (item) p.items.push(item);
        else if (i >= 0) p.items.splice(i, 1);
      }
    },
    replaceAll: (all) => (p.items = all),
    settings: () => p.settings,
    applySettings: (data) => (p.settings = clone(data)),
    persist: () => {},
    onRemote: () => {},
    onStatus: (s) => (p.status = s),
    onRemoved: () => (p.removed = true),
  });
  await settle();
  return p;
}

function household() {
  const server = makeServer();
  server.tables.household_settings.push({ household_id: 'h1', data: {}, updated_at: new Date(0).toISOString() });
  return server;
}

const tomatoes = { id: 't1', name: 'Diced tomatoes', qty: 4, unit: 'can', location: 'Pantry', updated: 1 };

// ---------- Scenarios ----------

test('something added on one phone shows up on the other', async () => {
  const server = household();
  const a = await phone(server, 'ann');
  const b = await phone(server, 'bob');
  await a.change((p) => p.items.push({ ...tomatoes }));
  assert.equal(b.byName('Diced tomatoes')?.qty, 4);
});

test('two people each using a can at the same moment: both count', async () => {
  const server = household();
  const a = await phone(server, 'ann', { items: [tomatoes] });
  const b = await phone(server, 'bob');
  assert.equal(b.byName('Diced tomatoes').qty, 4);
  // Both change before either hears about the other.
  a.byName('Diced tomatoes').qty = 3;
  b.byName('Diced tomatoes').qty = 3;
  a.sync.pushSoon(0);
  b.sync.pushSoon(0);
  await settle();
  await settle();
  assert.equal(a.byName('Diced tomatoes').qty, 2);
  assert.equal(b.byName('Diced tomatoes').qty, 2);
  assert.equal(server.tables.items.find((r) => r.id === 't1').data.qty, 2);
});

test('one phone offline: its changes and the other phone’s both survive', async () => {
  const server = household();
  const a = await phone(server, 'ann', { items: [tomatoes] });
  const b = await phone(server, 'bob');
  a.client.online = false;
  await a.change((p) => {
    p.byName('Diced tomatoes').qty = 1; // used three while offline
    p.byName('Diced tomatoes').store = 'Aldi';
  });
  await b.change((p) => {
    p.byName('Diced tomatoes').qty = 10; // bought six
    p.byName('Diced tomatoes').location = 'Garage';
  });
  a.client.online = true;
  await a.sync._testNow.pull();
  await settle();
  for (const p of [a, b]) {
    const it = p.byName('Diced tomatoes');
    assert.equal(it.qty, 7, `${p.name}: qty`);
    assert.equal(it.store, 'Aldi', `${p.name}: store`);
    assert.equal(it.location, 'Garage', `${p.name}: location`);
  }
});

test('deleted on one phone while edited on the other: the edit is kept', async () => {
  const server = household();
  const a = await phone(server, 'ann', { items: [tomatoes] });
  const b = await phone(server, 'bob');
  a.client.online = false;
  await a.change((p) => (p.items = p.items.filter((i) => i.id !== 't1')));
  await b.change((p) => (p.byName('Diced tomatoes').name = 'Crushed tomatoes'));
  a.client.online = true;
  await a.sync._testNow.pull();
  await settle();
  assert.equal(a.byName('Crushed tomatoes')?.qty, 4);
  assert.equal(b.byName('Crushed tomatoes')?.qty, 4);
});

test('deleted on one phone with no other changes: gone everywhere', async () => {
  const server = household();
  const a = await phone(server, 'ann', { items: [tomatoes] });
  const b = await phone(server, 'bob');
  await a.change((p) => (p.items = []));
  assert.equal(b.items.length, 0);
  assert.equal(server.tables.items.find((r) => r.id === 't1').deleted, true);
});

test('deleted while offline is not brought back when the phone reconnects', async () => {
  const server = household();
  const a = await phone(server, 'ann', { items: [tomatoes] });
  const b = await phone(server, 'bob');
  a.client.online = false;
  await a.change((p) => (p.items = []));
  a.client.online = true;
  await a.sync._testNow.pull();
  await settle();
  assert.equal(a.items.length, 0);
  assert.equal(b.items.length, 0);
});

test('a store added on one phone and a place on the other: both stay', async () => {
  const server = household();
  const a = await phone(server, 'ann');
  const b = await phone(server, 'bob');
  a.client.online = false;
  await a.change((p) => (p.settings = { ...p.settings, stores: [...p.settings.stores, 'Aldi'] }));
  await b.change((p) => (p.settings = { ...p.settings, places: [...p.settings.places, 'Basement'] }));
  a.client.online = true;
  await a.sync._testNow.pull();
  await settle();
  for (const p of [a, b]) {
    assert.deepEqual(p.settings.stores, ['Costco', 'Aldi'], `${p.name}: stores`);
    assert.deepEqual(p.settings.places, ['Pantry', 'Basement'], `${p.name}: places`);
  }
});

const plan = (ids, updated = 0) => ({ start: '2026-11-03', ids, seed: 1, max: 30, veg: false, updated });

test('a dinner plan made on one phone, and a swap there, show up on the other', async () => {
  const server = household();
  const a = await phone(server, 'ann');
  const b = await phone(server, 'bob');
  await a.change((p) => (p.settings = { ...p.settings, dinners: plan(['spag', 'ques', 'rice']) }));
  assert.deepEqual(b.settings.dinners, plan(['spag', 'ques', 'rice']));
  await b.change((p) => (p.settings = { ...p.settings, dinners: plan(['spag', 'soup', 'rice'], 5) }));
  assert.deepEqual(a.settings.dinners.ids, ['spag', 'soup', 'rice']);
});

test('both phones change the dinner plan while one is offline: the newer change wins whole', async () => {
  const server = household();
  const a = await phone(server, 'ann');
  const b = await phone(server, 'bob');
  await a.change((p) => (p.settings = { ...p.settings, dinners: plan(['spag', 'ques', 'rice']) }));
  a.client.online = false;
  await b.change((p) => (p.settings = { ...p.settings, dinners: plan(['eggs', 'ques', 'rice'], 9) }));
  await a.change((p) => (p.settings = { ...p.settings, stores: [...p.settings.stores, 'Aldi'], dinners: plan(['spag', 'soup', 'rice'], 5) }));
  a.client.online = true;
  await a.sync._testNow.pull();
  await settle();
  for (const p of [a, b]) {
    assert.deepEqual(p.settings.dinners, plan(['eggs', 'ques', 'rice'], 9), `${p.name}: plan`);
    assert.deepEqual(p.settings.stores, ['Costco', 'Aldi'], `${p.name}: stores`);
  }
});

test('three phones all changing the same item at once', async () => {
  const server = household();
  const a = await phone(server, 'ann', { items: [{ ...tomatoes, qty: 10 }] });
  const b = await phone(server, 'bob');
  const c = await phone(server, 'cat');
  for (const p of [a, b, c]) p.byName('Diced tomatoes').qty -= 1;
  for (const p of [a, b, c]) p.sync.pushSoon(0);
  for (let i = 0; i < 4; i++) await settle();
  for (const p of [a, b, c]) assert.equal(p.byName('Diced tomatoes').qty, 7, p.name);
});

test('taken out of the household: syncing stops and the phone keeps its copy', async () => {
  const server = household();
  const a = await phone(server, 'ann', { items: [tomatoes] });
  const b = await phone(server, 'bob');
  server.tables.members = server.tables.members.filter((m) => m.user_id !== 'bob');
  await b.sync._testNow.pull().catch(() => {});
  assert.equal(b.removed, true);
  assert.equal(b.items.length, 1);
  assert.equal(b.sync.syncInfo().joined, false);
  assert.equal(a.items.length, 1);
});

test('a phone coming from the previous version keeps its unsent change and takes the rest', async () => {
  const { print } = await import('../merge.js');
  const server = household();
  const milk = { id: 'm1', name: 'Milk', qty: 1, location: 'Fridge', updated: 5 };
  const eggs = { id: 'e1', name: 'Eggs', qty: 12, location: 'Fridge', updated: 5 };
  const stamp = new Date(1000).toISOString();
  server.tables.items.push(
    { household_id: 'h1', id: 'm1', data: { ...milk, qty: 2, updated: 9 }, deleted: false, updated_at: stamp },
    { household_id: 'h1', id: 'e1', data: eggs, deleted: false, updated_at: stamp },
  );
  const sync = await import('../sync.js?phone=legacy');
  const client = makeClient(server, 'old');
  server.tables.members.push({ household_id: 'h1', user_id: 'old', name: 'old', role: 'member', joined_at: 99 });
  // Milk: unchanged since the last send (the household's newer copy should arrive). Eggs: used 2 here, not yet sent.
  const storage = makeStorage({
    'homestock.auth': '{}',
    'homestock.sync': JSON.stringify({ householdId: 'h1', code: 'ABCD1234', name: 'old', sent: { m1: print(milk), e1: print(eggs) } }),
  });
  sync._testSetup({ client, storage });
  let items = [clone(milk), { ...eggs, qty: 10, updated: 20 }];
  await sync.initSync({
    items: () => items,
    applyRemote: (changes) => { for (const { id, item } of changes) items = items.map((i) => (i.id === id ? item : i)); },
    replaceAll: (all) => (items = all),
    settings: () => ({ stores: [], places: ['Fridge'], subPlaces: {}, rooms: [] }),
    applySettings: () => {},
    persist: () => {},
    onRemote: () => {},
    onStatus: () => {},
  });
  await settle();
  assert.equal(items.find((i) => i.id === 'm1').qty, 2);
  assert.equal(items.find((i) => i.id === 'e1').qty, 10);
  assert.equal(server.tables.items.find((r) => r.id === 'e1').data.qty, 10);
  assert.equal(JSON.parse(storage.getItem('homestock.sync')).sent, undefined);
});

test('new things added on two phones while offline: all of them end up everywhere', async () => {
  const server = household();
  const a = await phone(server, 'ann');
  const b = await phone(server, 'bob');
  a.client.online = false;
  b.client.online = false;
  await a.change((p) => p.items.push({ id: 'x1', name: 'Rice', qty: 1, location: 'Pantry', updated: 2 }));
  await b.change((p) => p.items.push({ id: 'x2', name: 'Beans', qty: 3, location: 'Pantry', updated: 2 }));
  a.client.online = true;
  b.client.online = true;
  await a.sync._testNow.pull();
  await b.sync._testNow.pull();
  await a.sync._testNow.pull();
  await settle();
  for (const p of [a, b]) assert.deepEqual(p.items.map((i) => i.name).sort(), ['Beans', 'Rice'], p.name);
});
