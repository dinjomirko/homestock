import { parseCommand, resolveActions, matchItem, guessLocation, parsePack, DEFAULT_LOCATIONS } from './parser.js';

const STORAGE_KEY = 'homestock.v1';
const PREFS_KEY = 'homestock.prefs';
const LOC_ICONS = { Pantry: '🥫', Fridge: '🥛', Freezer: '🧊', Bathroom: '🧴', Garage: '🧰' };
const KITCHEN = ['Pantry', 'Fridge', 'Freezer'];
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round = (n) => Math.round(n * 100) / 100;
const fmt = (n) => (n === 0.5 ? '½' : String(round(n)));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const sentenceCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const buzz = (ms = 30) => navigator.vibrate?.(ms);

// ---------- State ----------

let state = load(STORAGE_KEY, { items: [] });
const prefs = { scanMode: 'add', sound: true, ...load(PREFS_KEY, {}) };
const ui = { view: 'stock', loc: 'All', q: '', bought: new Map(), flash: null };
const undoStack = [];

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    if (v && typeof v === 'object' && (key !== STORAGE_KEY || Array.isArray(v.items))) return v;
  } catch {}
  return fallback;
}

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
}

let persistAsked = false;
function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
  // Ask the browser not to clear this data when space runs low.
  if (!persistAsked) {
    persistAsked = true;
    navigator.storage?.persist?.().catch(() => {});
  }
  render();
}

// Snapshot before every change so any change can be undone.
function checkpoint() {
  undoStack.push(JSON.stringify(state.items));
  if (undoStack.length > 30) undoStack.shift();
}

function undo() {
  const snap = undoStack.pop();
  if (!snap) return false;
  state.items = JSON.parse(snap);
  save();
  return true;
}

function newItem(fields) {
  const location = fields.location || 'Pantry';
  return {
    id: uid(), name: '', brand: '', barcode: '', unit: '', image: '', qty: 0, scanQty: 1, useBy: '',
    need: false, low: 0, ...fields, location, updated: Date.now(),
  };
}

const byId = (id) => state.items.find((i) => i.id === id);
const isLow = (it) => it.need || (it.low != null && it.qty <= it.low);
const shoppingItems = () => state.items.filter(isLow).sort((a, b) => a.location.localeCompare(b.location) || a.name.localeCompare(b.name));

function allLocations() {
  return [...new Set([...DEFAULT_LOCATIONS, ...state.items.map((i) => i.location)])];
}

function pluralUnit(unit, n) {
  if (!unit || n === 1) return unit || '';
  if (/(ch|sh|x|s)$/.test(unit)) return unit + 'es';
  if (unit === 'loaf') return 'loaves';
  if (/[^aeiou]y$/.test(unit)) return unit.slice(0, -1) + 'ies';
  return unit + 's';
}

function singularUnit(u) {
  u = u.trim().toLowerCase();
  if (u === 'loaves') return 'loaf';
  if (/ies$/.test(u)) return u.slice(0, -3) + 'y';
  if (/(ch|sh|x)es$/.test(u)) return u.slice(0, -2);
  if (/[^s]s$/.test(u)) return u.slice(0, -1);
  return u;
}

const qtyText = (it, n = it.qty) => `${fmt(n)}${it.unit ? ' ' + pluralUnit(it.unit, n) : ''}`;

function daysLeft(it) {
  if (!it.useBy) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(it.useBy + 'T00:00') - today) / 864e5);
}
const useSoon = (it) => it.qty > 0 && daysLeft(it) !== null && daysLeft(it) <= 7;

function useByHtml(it) {
  const n = daysLeft(it);
  if (n === null || it.qty <= 0) return '';
  if (n < 0) return '<span class="bad">Expired</span>';
  if (n === 0) return '<span class="bad">Use today</span>';
  if (n <= 3) return `<span class="warn">Use within ${n} day${n === 1 ? '' : 's'}</span>`;
  const d = new Date(it.useBy + 'T00:00');
  if (n <= 7) return `<span class="warn">Use by ${d.toLocaleDateString(undefined, { weekday: 'long' })}</span>`;
  return `Use by ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

// ---------- Rendering ----------

function render() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('on', t.dataset.view === ui.view);
    t.setAttribute('aria-current', t.dataset.view === ui.view ? 'page' : 'false');
  });
  $('#stockTools').hidden = ui.view !== 'stock';
  $('#title').textContent = ui.view === 'stock' ? 'Homestock' : 'Shopping';
  const shopCount = shoppingItems().filter((i) => !ui.bought.has(i.id)).length;
  $('#shopBadge').hidden = !shopCount;
  $('#shopBadge').textContent = shopCount;
  $('#main').innerHTML = ui.view === 'stock' ? renderStock() : renderShop();
  ui.flash = null;
}

function thumb(it, asButton = true) {
  const inner = it.image ? `<img src="${esc(it.image)}" alt="" loading="lazy">` : LOC_ICONS[it.location] || '📦';
  return asButton
    ? `<button class="thumb" data-act="edit" aria-label="Edit ${esc(it.name)}">${inner}</button>`
    : `<div class="thumb" aria-hidden="true">${inner}</div>`;
}

function itemRow(it, showLoc) {
  const cls = it.qty <= 0 ? 'out' : isLow(it) ? 'low' : '';
  const meta = [esc(it.brand), showLoc ? esc(it.location) : '', useByHtml(it)].filter(Boolean).join(' · ');
  return `<li class="item ${ui.flash === it.id ? 'flash' : ''}" data-id="${it.id}">
    ${thumb(it)}
    <button class="info" data-act="edit"><div class="name">${esc(it.name)}</div>${meta ? `<div class="meta">${meta}</div>` : ''}</button>
    <div class="stepper">
      <button data-act="dec" aria-label="One less ${esc(it.name)}">−</button>
      <span class="qty ${cls}" aria-label="${esc(qtyText(it))}">${fmt(it.qty)}${it.unit ? `<small>${esc(pluralUnit(it.unit, it.qty))}</small>` : ''}</span>
      <button data-act="inc" aria-label="One more ${esc(it.name)}">+</button>
    </div>
  </li>`;
}

function renderStock() {
  renderChips();
  if (!state.items.length) {
    return `<div class="empty">
      <div class="big">🏠</div>
      <h2>Nothing tracked yet</h2>
      <p>Tap <b>Scan</b> and point at barcodes as you unpack groceries, or tap <b>Speak</b> and say
      “Bought 6 rolls of paper towels.”</p>
      <div class="buttons">
        <button class="btn primary" data-act="sample">Try with sample items</button>
        <button class="btn" data-act="add">Add by hand</button>
      </div>
    </div>`;
  }
  const q = ui.q.trim().toLowerCase();
  let items = state.items.filter((i) => ui.loc === 'All' || (ui.loc === 'soon' ? useSoon(i) : i.location === ui.loc));
  if (q) items = items.filter((i) => `${i.name} ${i.brand} ${i.location}`.toLowerCase().includes(q));
  items.sort(ui.loc === 'soon' ? (a, b) => daysLeft(a) - daysLeft(b) : (a, b) => a.name.localeCompare(b.name));
  if (!items.length) {
    return q
      ? `<div class="empty"><p>Nothing called “${esc(ui.q)}” yet.</p>
         <button class="btn primary" data-act="add-named">Add “${esc(ui.q.trim())}”</button></div>`
      : '<div class="empty"><p>Nothing here.</p></div>';
  }

  let html;
  if (ui.loc === 'All' && !q) {
    html = allLocations()
      .map((loc) => {
        const group = items.filter((i) => i.location === loc);
        return group.length ? `<h2 class="group">${esc(loc)}</h2><ul class="list">${group.map((i) => itemRow(i, false)).join('')}</ul>` : '';
      })
      .join('');
  } else {
    html = `<ul class="list" style="margin-top:12px">${items.map((i) => itemRow(i, ui.loc === 'All' || ui.loc === 'soon')).join('')}</ul>`;
  }
  return html + `<button class="add-row" data-act="add">+ Add an item</button>`;
}

function renderChips() {
  const counts = {};
  state.items.forEach((i) => (counts[i.location] = (counts[i.location] || 0) + 1));
  const locs = allLocations().filter((l) => counts[l]);
  const soon = state.items.filter(useSoon).length;
  if (ui.loc === 'soon' && !soon) ui.loc = 'All';
  if (ui.loc !== 'All' && ui.loc !== 'soon' && !counts[ui.loc]) ui.loc = 'All';
  const chip = (key, label, n, extra = '') =>
    `<button class="chip ${extra} ${ui.loc === key ? 'on' : ''}" data-loc="${esc(key)}" aria-pressed="${ui.loc === key}">${esc(label)}${n ? `<small>${n}</small>` : ''}</button>`;
  $('#chips').innerHTML = locs.length < 2 && !soon ? '' : [
    chip('All', 'All', 0),
    soon ? chip('soon', 'Use soon', soon, 'soon') : '',
    ...locs.map((l) => chip(l, l, counts[l])),
  ].join('');
}

function shopRow(it, bought) {
  const status = it.qty <= 0 ? 'out' : `${esc(qtyText(it))} left`;
  return `<li class="item ${bought ? 'bought' : ''} ${ui.flash === it.id ? 'flash' : ''}" data-id="${it.id}">
    <button class="check" data-act="${bought ? 'unbuy' : 'got'}" role="checkbox" aria-checked="${bought}" aria-label="${esc(it.name)}">
      <svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></button>
    <button class="info" data-act="edit"><div class="name">${esc(it.name)}</div>
      <div class="meta">${bought ? `Back in stock · ${esc(qtyText(it))}` : status}${it.brand ? ` · ${esc(it.brand)}` : ''}</div></button>
    ${!bought && it.need && it.qty > (it.low ?? -1) ? '<span class="tag">Requested</span>' : ''}
  </li>`;
}

function renderShop() {
  const toBuy = shoppingItems().filter((i) => !ui.bought.has(i.id));
  const bought = [...ui.bought.keys()].map(byId).filter(Boolean);
  let html = `<form class="quick-add" id="listAdd">
      <input name="what" placeholder="Add to the list…" autocomplete="off" enterkeyhint="done" aria-label="Add to the shopping list">
      <button>Add</button>
    </form>`;
  if (toBuy.length) {
    html += `<div class="shop-head"><h2>${toBuy.length} to buy</h2><button class="btn small" data-act="share-list">Share</button></div>`;
    for (const loc of allLocations()) {
      const group = toBuy.filter((i) => i.location === loc);
      if (group.length) html += `<h2 class="group">${esc(loc)}</h2><ul class="list">${group.map((i) => shopRow(i, false)).join('')}</ul>`;
    }
  } else if (!bought.length) {
    html += `<div class="empty"><div class="big">🛒</div><h2>Nothing to buy</h2>
      <p>Things land here on their own when they run low. You can also say “add coffee to the shopping list.”</p></div>`;
  }
  if (bought.length) {
    html += `<h2 class="group"><span>In the cart · back in stock</span></h2><ul class="list">${bought.map((i) => shopRow(i, true)).join('')}</ul>
      <p class="note" style="margin:8px 4px">Tapped one by mistake? Tap it again.</p>`;
  }
  const kitchen = state.items.filter((i) => KITCHEN.includes(i.location) && i.qty > 0).length;
  html += `<div class="card">
      <h3>What can I cook?</h3>
      <p>Copies the ${kitchen} things in your pantry, fridge and freezer as a ready-made question, with anything expiring soon listed first. Paste it into Claude or any recipe app.</p>
      <button class="btn primary" data-act="recipe" ${kitchen ? '' : 'disabled'}>Copy kitchen list</button>
    </div>`;
  return html;
}

// ---------- Changes ----------

function bump(it, dir) {
  checkpoint();
  it.qty = round(Math.max(0, it.qty + dir));
  if (dir > 0 && it.qty > (it.low ?? -1)) it.need = false;
  it.updated = Date.now();
  buzz(15);
  save();
}

function markBought(it) {
  ui.bought.set(it.id, { qty: it.qty, need: it.need });
  it.qty = Math.max(it.qty + (it.scanQty || 1), (it.low ?? 0) + 1);
  it.need = false;
  it.updated = Date.now();
  buzz();
  save();
}

function unmarkBought(it) {
  const before = ui.bought.get(it.id);
  ui.bought.delete(it.id);
  if (before) Object.assign(it, before);
  save();
}

function addToList(text) {
  const actions = resolveActions(parseCommand(`need ${text}`), state.items);
  if (!actions.length) return;
  checkpoint();
  for (const a of actions) {
    let it = a.item;
    if (!it) {
      it = newItem({ name: sentenceCase(a.name), qty: 0, location: guessLocation(a.name) });
      state.items.push(it);
    }
    it.need = true;
    it.updated = Date.now();
    ui.bought.delete(it.id);
    ui.flash = it.id;
  }
  save();
}

// Applies parsed voice/typed actions and answers questions.
function applyActions(actions) {
  checkpoint();
  const done = [];
  const problems = [];
  const answers = [];
  for (const a of actions) {
    if (!a.action) {
      problems.push(`Not sure what to do with “${a.name}”. Start with “used”, “bought”, “we have…”, or ask “how many…”`);
      continue;
    }
    let it = a.item;
    if (a.action === 'query') {
      answers.push(answerFor(a));
      continue;
    }
    const create = (qty) => {
      it = newItem({ name: sentenceCase(a.name), qty, unit: a.unit || '', location: a.location || guessLocation(a.name) });
      state.items.push(it);
    };
    switch (a.action) {
      case 'remove':
        if (!it) { problems.push(`Couldn't find “${a.name}” in your stock`); continue; }
        it.qty = round(Math.max(0, it.qty - a.qty));
        done.push(`−${fmt(a.qty)} ${it.name} → ${qtyText(it)} left`);
        break;
      case 'add':
        if (!it) create(0);
        it.qty = round(it.qty + a.qty);
        it.need = false;
        done.push(`+${fmt(a.qty)} ${it.name} → ${qtyText(it)}${a.item ? '' : ' (new)'}`);
        break;
      case 'set':
        if (a.qty == null) { problems.push(`How many ${a.name}? Try “we have 4 ${a.name}”`); continue; }
        if (!it) create(0);
        it.qty = a.qty;
        if (it.qty > (it.low ?? -1)) it.need = false;
        done.push(`${it.name} set to ${qtyText(it)}`);
        break;
      case 'out':
        if (!it) create(0);
        it.qty = 0;
        done.push(`${it.name} → out, added to shopping list`);
        break;
      case 'need':
        if (!it) create(0);
        it.need = true;
        done.push(`🛒 ${it.name} added to shopping list`);
        break;
    }
    if (a.unit && !it.unit) it.unit = a.unit;
    it.updated = Date.now();
  }
  if (done.length) save();
  else undoStack.pop();
  return { done, problems, answers };
}

function answerFor(a) {
  const it = a.item;
  if (!it) return `You're not tracking ${a.name} yet.`;
  const where = `in the ${it.location.toLowerCase()}`;
  const list = isLow(it) ? ' It’s on the shopping list.' : '';
  if (it.qty <= 0) return `You're out of ${it.name.toLowerCase()}.${list}`;
  const amount = it.unit ? `${fmt(it.qty)} ${pluralUnit(it.unit, it.qty)} of ${it.name.toLowerCase()}` : `${fmt(it.qty)} ${it.name.toLowerCase()}`;
  return `You have ${amount} ${where}.${list}`;
}

// Speech engines give a few guesses; use the one that matches the most things you own.
function runCommand(texts) {
  const locations = allLocations();
  let best = null;
  for (const t of texts) {
    const r = resolveActions(parseCommand(t, { locations }), state.items);
    const score = r.filter((a) => a.action && (a.item || a.action !== 'remove')).length * 2 + r.filter((a) => a.item).length;
    if (r.length && (!best || score > best.score)) best = { r, score };
  }
  if (!best) return { done: [], answers: [], problems: [`Didn't catch an item in “${texts[0]}”`] };
  return applyActions(best.r);
}

// ---------- Sheets & toast ----------

let sheetOnClose = null;

function openSheet(html, onClose) {
  const s = $('#sheet');
  s.innerHTML = html;
  s.hidden = false;
  $('#backdrop').hidden = false;
  sheetOnClose = onClose || null;
}

function closeSheet() {
  const s = $('#sheet');
  if (s.hidden) return;
  s.hidden = true;
  $('#backdrop').hidden = true;
  s.innerHTML = '';
  const cb = sheetOnClose;
  sheetOnClose = null;
  cb?.();
}

let toastTimer;
function toast(msg, { undo: withUndo = false } = {}) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${withUndo ? '<button data-undo>Undo</button>' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), withUndo ? 6000 : 2500);
}

function locationPicker(current) {
  const locs = allLocations();
  if (!locs.includes(current)) locs.push(current);
  return `<input type="hidden" name="location" value="${esc(current)}">
    <div class="pick" role="radiogroup" aria-label="Kept in">${locs
      .map((l) => `<button type="button" role="radio" data-pick-loc="${esc(l)}" class="${l === current ? 'on' : ''}" aria-checked="${l === current}">${esc(l)}</button>`)
      .join('')}<button type="button" data-pick-loc="__new">+ New place</button></div>`;
}

// Location chips inside any form: pick one, or name a new place.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pick-loc]');
  if (!b) return;
  const form = b.closest('form');
  let loc = b.dataset.pickLoc;
  if (loc === '__new') {
    loc = prompt('Name the new place (e.g. Basement, Laundry room)')?.trim();
    if (!loc) return;
    loc = sentenceCase(loc);
    b.insertAdjacentHTML('beforebegin', `<button type="button" role="radio" data-pick-loc="${esc(loc)}">${esc(loc)}</button>`);
  }
  form.location.value = loc;
  form.querySelectorAll('[data-pick-loc]').forEach((x) => {
    const on = x.dataset.pickLoc === loc;
    x.classList.toggle('on', on);
    x.setAttribute('aria-checked', on);
  });
});

// Resolves with the saved item, or null if cancelled.
function openEditor(item, { isNew = false, hint = '' } = {}) {
  return new Promise((resolve) => {
    let saved = null;
    const lowOpts = [['', 'Never'], ...[0, 1, 2, 3, 5, 10].map((n) => [n, n === 0 ? 'When out' : `${n} left`])];
    openSheet(`
      <form class="form" id="editForm">
        <div class="sheet-head"><h2>${isNew ? 'New item' : 'Edit item'}</h2><button type="button" class="link" data-close>Cancel</button></div>
        ${hint ? `<p class="note">${esc(hint)}</p>` : ''}
        ${item.image ? `<img class="hero" src="${esc(item.image)}" alt="">` : ''}
        <label>Name<input name="name" required value="${esc(item.name)}" placeholder="e.g. Paper towels" autocomplete="off"></label>
        <div class="row2">
          <label>How many
            <div class="stepper big"><button type="button" data-step="-1" aria-label="One less">−</button><input name="qty" type="number" inputmode="decimal" step="any" min="0" value="${item.qty}" aria-label="Quantity"><button type="button" data-step="1" aria-label="One more">+</button></div>
          </label>
          <label>Counted in<input name="unit" value="${esc(item.unit)}" placeholder="rolls, cans…" autocapitalize="off" autocomplete="off"></label>
        </div>
        <span class="label">Kept in</span>
        ${locationPicker(item.location)}
        <label>Use by <span style="font-weight:400">(optional)</span><input name="useBy" type="date" value="${esc(item.useBy || '')}"></label>
        <details><summary>Shopping & scanning</summary>
          <div class="row2">
            <label>Add to list at
              <select name="low">${lowOpts.map(([v, t]) => `<option value="${v}" ${String(item.low ?? '') === String(v) ? 'selected' : ''}>${t}</option>`).join('')}</select>
            </label>
            <label>Each scan adds<input name="scanQty" type="number" inputmode="numeric" min="1" value="${item.scanQty || 1}"></label>
          </div>
          <label>Brand<input name="brand" value="${esc(item.brand)}" autocomplete="off"></label>
          <label>Barcode<input name="barcode" inputmode="numeric" value="${esc(item.barcode)}" autocomplete="off"></label>
        </details>
        <button class="primary" type="submit">${isNew ? 'Add item' : 'Save'}</button>
        ${isNew ? '' : `<button type="button" class="danger" data-delete>Delete item</button>
          <p class="note" style="text-align:center">Last changed ${ago(item.updated)}</p>`}
      </form>`, () => resolve(saved));

    const form = $('#editForm');
    form.addEventListener('click', (e) => {
      const step = e.target.closest('[data-step]');
      if (step) form.qty.value = Math.max(0, round((parseFloat(form.qty.value) || 0) + Number(step.dataset.step)));
      if (e.target.closest('[data-delete]') && confirm(`Delete ${item.name}?`)) {
        checkpoint();
        state.items = state.items.filter((i) => i.id !== item.id);
        save();
        closeSheet();
        toast(`Deleted ${item.name}`, { undo: true });
      }
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      checkpoint();
      Object.assign(item, {
        name: form.name.value.trim(),
        qty: Math.max(0, parseFloat(form.qty.value) || 0),
        unit: singularUnit(form.unit.value),
        location: form.location.value,
        useBy: form.useBy.value,
        low: form.low.value === '' ? null : Number(form.low.value),
        scanQty: Math.max(1, parseInt(form.scanQty.value, 10) || 1),
        brand: form.brand.value.trim(),
        barcode: normCode(form.barcode.value),
        updated: Date.now(),
      });
      if (item.qty > (item.low ?? -1)) item.need = false;
      if (isNew) state.items.push(item);
      saved = item;
      ui.flash = item.id;
      save();
      closeSheet();
      if ($('#scanner').hidden) toast(isNew ? `Added ${item.name}` : 'Saved', { undo: true });
    });
  });
}

function openMenu() {
  openSheet(`
    <div class="sheet-head"><h2>Options</h2><button class="link" data-close>Done</button></div>
    <div class="menu">
      <button data-menu="add">Add an item by hand</button>
      <button data-menu="recipe">Copy kitchen list for recipe ideas</button>
      <button data-menu="sound">Scan beep: ${prefs.sound ? 'On' : 'Off'}</button>
      <button data-menu="export">Back up to a file</button>
      <button data-menu="import">Restore from a backup file</button>
      <button data-menu="sample">Load sample items</button>
      <button data-menu="erase" class="danger">Erase everything</button>
    </div>`);
}

async function shareText(text, title) {
  try {
    if (navigator.share) return await navigator.share({ title, text });
  } catch (e) {
    if (e.name === 'AbortError') return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied — paste it anywhere');
  } catch {
    prompt('Copy this:', text);
  }
}

function shareShoppingList() {
  const lines = shoppingItems().map((it) => `☐ ${it.name}${it.brand ? ` (${it.brand})` : ''}`);
  shareText(`Shopping list\n${lines.join('\n')}`, 'Shopping list');
}

function shareKitchen() {
  const items = state.items.filter((i) => KITCHEN.includes(i.location) && i.qty > 0);
  const soon = items.filter(useSoon).sort((a, b) => daysLeft(a) - daysLeft(b));
  const rest = items.filter((i) => !useSoon(i));
  const line = (i) => `- ${i.name} (${qtyText(i)})`;
  let text = "Here's what I have in my kitchen right now:\n";
  if (soon.length) text += `\nUse these soon:\n${soon.map(line).join('\n')}\n\nEverything else:\n`;
  text += rest.map(line).join('\n');
  text += `\n\nWhat could I make using mostly these${soon.length ? ', ideally using up the ones that expire soon' : ''}? Suggest a few recipes and tell me anything small I'd need to buy.`;
  shareText(text, 'My kitchen');
}

function exportBackup() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `homestock-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.items)) throw new Error('not a backup');
    if (!confirm(`Replace your ${state.items.length} items with ${data.items.length} from the backup?`)) return;
    checkpoint();
    state = { items: data.items };
    save();
    toast('Backup restored', { undo: true });
  } catch {
    toast("That file isn't a Homestock backup");
  }
}

function loadSample() {
  checkpoint();
  const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const s = (name, qty, unit, location, extra = {}) => newItem({ name, qty, unit, location, ...extra });
  state.items.push(
    s('Paper towels', 6, 'roll', 'Pantry', { brand: 'Bounty', scanQty: 6, low: 2 }),
    s('Diced tomatoes', 4, 'can', 'Pantry'),
    s('Spaghetti', 2, 'box', 'Pantry'),
    s('Black beans', 3, 'can', 'Pantry'),
    s('Olive oil', 1, 'bottle', 'Pantry'),
    s('Rice', 1, 'bag', 'Pantry', { low: 0 }),
    s('Milk', 1, 'gallon', 'Fridge', { useBy: inDays(3) }),
    s('Eggs', 12, '', 'Fridge', { scanQty: 12, low: 4, useBy: inDays(12) }),
    s('Cheddar cheese', 1, 'block', 'Fridge', { low: 0 }),
    s('Spinach', 1, 'bag', 'Fridge', { low: 0, useBy: inDays(1) }),
    s('Frozen peas', 2, 'bag', 'Freezer'),
    s('Toilet paper', 9, 'roll', 'Bathroom', { brand: 'Charmin', scanQty: 12, low: 4 }),
    s('Toothpaste', 1, 'tube', 'Bathroom'),
    s('Shampoo', 1, 'bottle', 'Bathroom', { low: 0 }),
    s('Duct tape', 2, 'roll', 'Garage'),
    s('AA batteries', 8, '', 'Garage', { low: 4 }),
    s('Wood screws 1-5/8"', 1, 'box', 'Garage'),
    s('Furnace filter 16x25x1', 0, '', 'Garage'),
  );
  save();
  toast('Sample items added', { undo: true });
}

// ---------- Voice ----------

let rec = null;

function openVoice() {
  openSheet(`
    <div class="voice">
      <div class="sheet-head"><h2>Say what changed</h2><button class="link" data-close>Done</button></div>
      <button id="micBtn" class="mic" aria-label="Start or stop listening">
        <svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>
      </button>
      <p id="heard" class="heard">${SR ? 'Tap the mic and talk' : 'Voice isn’t supported in this browser — type it instead'}</p>
      <ul id="voiceResult" class="results"></ul>
      <form id="typeForm" class="type-form">
        <input id="typeInput" placeholder="…or type it" autocomplete="off" enterkeyhint="go" aria-label="Type a change or question">
        <button>Go</button>
      </form>
      <div class="examples"><b>Things you can say</b>
        <button type="button">Removing a roll of paper towels</button><button type="button">Used 2 cans of tomatoes and a box of spaghetti</button>
        <button type="button">Bought a dozen eggs</button><button type="button">We're out of milk</button>
        <button type="button">How many rolls of toilet paper do we have?</button><button type="button">We have 3 rolls of duct tape</button>
        <button type="button">Add coffee to the shopping list</button>
      </div>
    </div>`, () => {
    stopListening();
    window.speechSynthesis?.cancel();
  });
  if (SR) startListening();
}

function startListening() {
  stopListening();
  window.speechSynthesis?.cancel();
  const r = new SR();
  r.lang = navigator.language || 'en-US';
  r.interimResults = true;
  r.maxAlternatives = 3;
  rec = r;
  let finals = null;
  $('#micBtn')?.classList.add('live');
  $('#heard').textContent = 'Listening…';
  r.onresult = (e) => {
    const results = Array.from(e.results);
    const head = results.slice(0, -1).map((x) => x[0].transcript).join(' ');
    const last = results.at(-1);
    $('#heard').textContent = `“${(head + ' ' + last[0].transcript).trim()}”`;
    if (last.isFinal) finals = Array.from(last).map((alt) => (head + ' ' + alt.transcript).trim());
  };
  r.onerror = (e) => {
    const heard = $('#heard');
    if (!heard) return;
    heard.textContent =
      e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'Microphone access is blocked — you can type instead.'
      : e.error === 'no-speech' ? 'Didn’t hear anything. Tap the mic to try again.'
      : `Couldn’t listen (${e.error}). You can type instead.`;
  };
  r.onend = () => {
    $('#micBtn')?.classList.remove('live');
    if (rec === r) rec = null;
    if (finals) handleCommand(finals, true);
  };
  try {
    r.start();
  } catch {
    rec = null;
  }
}

function stopListening() {
  if (!rec) return;
  rec.onend = rec.onresult = rec.onerror = null;
  rec.abort();
  rec = null;
}

function say(text) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = navigator.language || 'en-US';
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

function handleCommand(texts, spoken) {
  const { done, problems, answers } = runCommand(texts);
  if (done.length && !problems.length && !answers.length) {
    closeSheet();
    buzz();
    toast(done.join('\n'), { undo: true });
    return;
  }
  if (answers.length && spoken) say(answers.join(' '));
  const box = $('#voiceResult');
  if (!box) return toast([...answers, ...done, ...problems].join('\n'), { undo: done.length > 0 });
  box.innerHTML =
    answers.map((a) => `<li class="answer">${esc(a)}</li>`).join('') +
    done.map((d) => `<li>${esc(d)}</li>`).join('') +
    problems.map((p) => `<li class="bad">${esc(p)}</li>`).join('');
  if (done.length) box.insertAdjacentHTML('beforeend', '<li style="background:none;text-align:right;padding:0"><button class="link" data-undo>Undo</button></li>');
}

// ---------- Barcode scanning ----------
//
// Camera frames go to the browser's own barcode reader where there is one (Chrome, Android).
// Elsewhere (Safari, iPhone) a cropped grayscale copy of each frame goes to a worker running
// ZXing, which tries it upright and turned 90°. Frames are only grabbed when the previous one
// is finished, so slower phones never queue up work.

const cam = {
  stream: null, track: null, running: false, paused: false, busy: false, raf: 0,
  detector: null, worker: null, zooms: [], zoomIdx: 0, torch: false,
  pending: null, lastCode: '', lastSeen: 0,
};
const crop = document.createElement('canvas');
const cropCtx = crop.getContext('2d', { willReadFrequently: true });
let audioCtx = null;
let lookupToken = 0;

// UPC-A (12 digits) and EAN-13 with a leading 0 are the same product.
function normCode(c) {
  const s = String(c || '').trim().replace(/\s+/g, '');
  return /^\d{12}$/.test(s) ? '0' + s : s;
}
const findByCode = (code) => state.items.find((i) => i.barcode && normCode(i.barcode) === code);

const MODE_HINTS = {
  add: 'Adding — each scan puts one in stock',
  use: 'Using — each scan takes one out',
  check: 'Checking — see what you have, nothing changes',
};
const hint = (t) => ($('#scanHint').textContent = t);

function setScanMode(mode) {
  prefs.scanMode = mode;
  savePrefs();
  document.querySelectorAll('.seg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === mode);
    b.setAttribute('aria-checked', b.dataset.mode === mode);
  });
  if (cam.running) hint(MODE_HINTS[mode]);
}

async function openScanner() {
  $('#scanner').hidden = false;
  document.body.style.overflow = 'hidden';
  $('#scanCard').innerHTML = '';
  $('#manualCode').hidden = true;
  $('#typeCodeBtn').hidden = false;
  setScanMode(prefs.scanMode);
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    audioCtx.resume();
  } catch {}
  hint('Starting camera…');
  try {
    await startCamera();
    hint(MODE_HINTS[prefs.scanMode]);
  } catch (e) {
    hint(e?.name === 'NotAllowedError' ? 'Camera access is off — allow it in Settings, or type the barcode.' : 'No camera here — type the barcode instead.');
    showManual();
  }
}

async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  if ($('#scanner').hidden) return stream.getTracks().forEach((t) => t.stop());
  cam.stream = stream;
  cam.track = stream.getVideoTracks()[0];
  const video = $('#camera');
  video.srcObject = stream;
  await video.play().catch(() => {});
  await tuneCamera();
  cam.detector ||= await makeDetector();
  if (!cam.detector) startWorker();
  cam.running = true;
  resumeScanning();
  cam.raf = requestAnimationFrame(loop);
}

// Continuous focus, a little zoom (so you can hold things farther away, where phones focus
// better), and the flashlight where the phone allows it.
async function tuneCamera() {
  const t = cam.track;
  const caps = t.getCapabilities?.() || {};
  const adv = {};
  if (caps.focusMode?.includes('continuous')) adv.focusMode = 'continuous';
  cam.zooms = [];
  if (caps.zoom && caps.zoom.max >= 1.5) {
    const min = Math.max(1, caps.zoom.min || 1);
    cam.zooms = [...new Set([min, 1.5, Math.min(2, caps.zoom.max)])];
    cam.zoomIdx = 1;
    adv.zoom = cam.zooms[1];
  }
  try {
    if (Object.keys(adv).length) await t.applyConstraints({ advanced: [adv] });
  } catch {}
  $('#zoomBtn').hidden = !cam.zooms.length;
  updateZoomLabel();
  $('#torchBtn').hidden = !caps.torch;
  cam.torch = false;
  $('#torchBtn').setAttribute('aria-pressed', 'false');
}

function updateZoomLabel() {
  const z = cam.zooms[cam.zoomIdx];
  if (z) $('#zoomBtn').textContent = `${fmt(z)}×`;
}

async function cycleZoom() {
  if (!cam.zooms.length) return;
  cam.zoomIdx = (cam.zoomIdx + 1) % cam.zooms.length;
  try { await cam.track.applyConstraints({ advanced: [{ zoom: cam.zooms[cam.zoomIdx] }] }); } catch {}
  updateZoomLabel();
}

async function toggleTorch() {
  cam.torch = !cam.torch;
  try { await cam.track.applyConstraints({ advanced: [{ torch: cam.torch }] }); } catch { cam.torch = false; }
  $('#torchBtn').setAttribute('aria-pressed', String(cam.torch));
}

async function makeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const formats = ['ean_13', 'upc_a', 'ean_8', 'upc_e', 'code_128', 'code_39'].filter((f) => supported.includes(f));
    return formats.includes('ean_13') ? new window.BarcodeDetector({ formats }) : null;
  } catch {
    return null;
  }
}

function startWorker() {
  if (cam.worker) return;
  cam.worker = new Worker('scan-worker.js');
  cam.worker.onmessage = ({ data }) => {
    if (data?.ready) return;
    cam.busy = false;
    if (data?.text) accept(data.text, data.format, false);
  };
  cam.worker.onerror = () => {
    cam.busy = false;
    cam.worker = null;
    hint('The scanner couldn’t load — check your connection, or type the barcode.');
    showManual();
  };
}

function loop() {
  if (!cam.running) return;
  cam.raf = requestAnimationFrame(loop);
  const v = $('#camera');
  if (cam.paused || cam.busy || v.readyState < 2 || !v.videoWidth) return;
  cam.busy = true;
  if (cam.detector) {
    cam.detector.detect(v).then(
      (codes) => {
        cam.busy = false;
        if (codes[0]) accept(codes[0].rawValue, codes[0].format, true);
      },
      () => (cam.busy = false),
    );
  } else if (cam.worker) {
    const frame = grabFrame(v);
    cam.worker.postMessage(frame, [frame.lum.buffer]);
  } else {
    cam.busy = false;
  }
}

// Grayscale crop of the middle of what's visible on screen, at most ~1000px across.
function grabFrame(v) {
  const vw = v.videoWidth;
  const vh = v.videoHeight;
  const box = v.getBoundingClientRect();
  const s = box.width && box.height ? Math.max(box.width / vw, box.height / vh) : 0;
  const visW = s ? Math.min(vw, box.width / s) : vw;
  const visH = s ? Math.min(vh, box.height / s) : vh;
  const cw = visW * 0.92;
  const ch = Math.min(visH * 0.75, cw);
  const scale = Math.min(1, 1000 / Math.max(cw, ch));
  const w = Math.round(cw * scale);
  const h = Math.round(ch * scale);
  crop.width = w;
  crop.height = h;
  cropCtx.drawImage(v, (vw - cw) / 2, (vh - ch) / 2, cw, ch, 0, 0, w, h);
  const px = cropCtx.getImageData(0, 0, w, h).data;
  const lum = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < lum.length; i++, j += 4) lum[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;
  return { lum, w, h };
}

// EAN-13/UPC-A carry a check digit, so one read is enough. Shorter formats must read the
// same twice in a row. The same code held in view only counts once; take it out of view
// for a moment (or bring the next identical can) to count it again.
function accept(text, format, trusted) {
  const code = normCode(text);
  const now = performance.now();
  if (!trusted && !/^(EAN_13|UPC_A)$/.test(format)) {
    if (cam.pending?.code !== code || now - cam.pending.at > 1500) {
      cam.pending = { code, at: now };
      return;
    }
  }
  cam.pending = null;
  if (code === cam.lastCode && now - cam.lastSeen < 1200) {
    cam.lastSeen = now;
    return;
  }
  cam.lastCode = code;
  cam.lastSeen = now;
  handleCode(code);
}

function scanFeedback() {
  buzz(40);
  if (prefs.sound && audioCtx) {
    try {
      const t = audioCtx.currentTime;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = 1760;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      o.connect(g).connect(audioCtx.destination);
      o.start(t);
      o.stop(t + 0.13);
    } catch {}
  }
  const vf = $('#viewfinder');
  vf.classList.remove('hit');
  void vf.offsetWidth;
  vf.classList.add('hit');
  setTimeout(() => vf.classList.remove('hit'), 450);
}

function pauseScanning() {
  cam.paused = true;
  $('#viewfinder').classList.add('paused');
}

function resumeScanning() {
  cam.paused = false;
  cam.lastSeen = performance.now();
  $('#viewfinder').classList.remove('paused');
}

async function closeScanner() {
  lookupToken++;
  cam.running = false;
  cancelAnimationFrame(cam.raf);
  cam.stream?.getTracks().forEach((t) => t.stop());
  cam.stream = cam.track = null;
  cam.busy = false;
  cam.lastCode = '';
  $('#camera').srcObject = null;
  $('#scanner').hidden = true;
  $('#scanCard').innerHTML = '';
  document.body.style.overflow = '';
  if (!$('#sheet').hidden) closeSheet();
  render();
}

function showManual() {
  $('#manualCode').hidden = false;
  $('#typeCodeBtn').hidden = true;
}

async function handleCode(code) {
  scanFeedback();
  const item = findByCode(code);
  if (prefs.scanMode === 'check') return showCheckCard(item, code);
  if (!item) return quickAdd(code);
  checkpoint();
  let delta;
  if (prefs.scanMode === 'add') {
    item.qty = round(item.qty + (item.scanQty || 1));
    item.need = false;
    delta = `+${fmt(item.scanQty || 1)} added`;
  } else {
    item.qty = round(Math.max(0, item.qty - 1));
    delta = '−1 used';
  }
  item.updated = Date.now();
  save();
  showResultCard(item, delta, prefs.scanMode === 'use');
}

function showResultCard(item, delta, minus) {
  const low = isLow(item) ? ' · <span style="color:var(--warn)">on shopping list</span>' : '';
  $('#scanCard').innerHTML = `
    <div class="result" data-id="${item.id}">
      ${thumb(item, false)}
      <div class="info">
        <div class="delta ${minus ? 'minus' : ''}">${esc(delta)}</div>
        <div class="name">${esc(item.name)}</div>
        <div class="meta">${esc(item.location)}${low}</div>
      </div>
      <div class="stepper">
        <button data-scan="dec" aria-label="One less">−</button>
        <span class="qty">${fmt(item.qty)}${item.unit ? `<small>${esc(pluralUnit(item.unit, item.qty))}</small>` : ''}</span>
        <button data-scan="inc" aria-label="One more">+</button>
      </div>
    </div>
    <div class="result-actions">
      ${delta ? '<button class="btn" data-scan="undo">Undo</button>' : ''}
      <button class="btn" data-scan="edit">Edit details</button>
    </div>`;
}

function showCheckCard(item, code) {
  if (!item) {
    $('#scanCard').innerHTML = `
      <div class="result"><div class="thumb" aria-hidden="true">❔</div>
        <div class="info"><div class="name">Not in your stock</div><div class="meta">Barcode ${esc(code)}</div></div></div>
      <div class="result-actions"><button class="btn primary" data-scan="new" data-code="${esc(code)}">Add it</button></div>`;
    return;
  }
  const status = item.qty <= 0 ? 'You’re out' : `You have ${esc(qtyText(item))}`;
  $('#scanCard').innerHTML = `
    <div class="result" data-id="${item.id}">
      ${thumb(item, false)}
      <div class="info">
        <div class="delta ${isLow(item) ? 'minus' : ''}">${status}</div>
        <div class="name">${esc(item.name)}</div>
        <div class="meta">${esc(item.location)}${item.useBy ? ` · ${useByHtml(item)}` : ''}</div>
      </div>
    </div>
    <div class="result-actions">
      <button class="btn" data-scan="list">${item.need ? '✓ On the list' : isLow(item) ? '✓ On the list (low)' : 'Add to list'}</button>
      <button class="btn" data-scan="edit">Edit details</button>
    </div>`;
}

// Pick the existing item without a barcode that this product most likely is, e.g. a
// "Paper towels" you added by voice and are now scanning for the first time.
function findSimilar(info) {
  if (!info?.name) return null;
  const product = [{ name: info.name, brand: info.brand, qty: 0 }];
  let best = null;
  for (const it of state.items) {
    if (it.barcode) continue;
    const m = matchItem(it.name, product);
    if (m && m.score >= 0.6 && (!best || m.score > best.score)) best = { item: it, score: m.score };
  }
  return best?.item || null;
}

async function quickAdd(code) {
  pauseScanning();
  const token = ++lookupToken;
  $('#scanCard').innerHTML = `
    <div class="quick"><div class="top-row"><div class="thumb" aria-hidden="true">🔎</div>
      <div style="flex:1"><h3>Looking it up…</h3><div class="skeleton" style="margin-top:10px;width:70%"></div></div></div>
      <div class="row-actions"><button class="btn" data-quick="skip">Cancel</button></div></div>`;
  const info = await lookupBarcode(code);
  if (token !== lookupToken) return;

  const pack = parsePack(`${info?.size || ''} ${info?.name || ''}`);
  const draft = newItem({
    name: info?.name || '',
    brand: info?.brand || '',
    image: info?.image || '',
    barcode: code,
    location: guessLocation(`${info?.name || ''} ${info?.category || ''}`, info?.kind),
    unit: pack?.unit || '',
    scanQty: pack?.count || 1,
    qty: prefs.scanMode === 'add' ? pack?.count || 1 : 0,
  });
  const similar = findSimilar(info);
  const found = info ? [info.brand, info.size].filter(Boolean).join(' · ') || 'Found it' : '';
  $('#scanCard').innerHTML = `
    <form class="quick form" id="quickForm" data-code="${esc(code)}">
      <div class="top-row">
        ${draft.image ? `<img src="${esc(draft.image)}" alt="">` : '<div class="thumb" aria-hidden="true">📦</div>'}
        <div style="flex:1;min-width:0">
          <input name="name" value="${esc(draft.name)}" placeholder="What is it?" required autocomplete="off" aria-label="Name">
          <p class="note">${info ? esc(found) : 'Not in the product databases — name it once and it’s remembered.'}</p>
        </div>
      </div>
      ${similar ? `<div class="suggest"><span>Is this your <b>${esc(similar.name)}</b>?</span>
        <button type="button" class="btn small primary" data-quick="link" data-id="${similar.id}">Yes, same thing</button></div>` : ''}
      <span class="label">Kept in</span>
      ${locationPicker(draft.location)}
      <div class="row2">
        <label>How many
          <div class="stepper big"><button type="button" data-step="-1" aria-label="One less">−</button><input name="qty" type="number" inputmode="decimal" min="0" step="any" value="${draft.qty}" aria-label="Quantity"><button type="button" data-step="1" aria-label="One more">+</button></div>
        </label>
        <label>Counted in<input name="unit" value="${esc(draft.unit)}" placeholder="rolls, cans…" autocapitalize="off" autocomplete="off"></label>
      </div>
      <div class="row-actions">
        <button type="button" class="btn" data-quick="skip">Skip</button>
        <button class="btn primary">Save</button>
      </div>
      <button type="button" class="link" data-quick="more" style="width:100%">More details (use-by date, brand…)</button>
    </form>`;
  const form = $('#quickForm');
  if (!info) form.name.focus();
  form._draft = draft;
  form._pack = pack;
}

function finishQuickAdd(item, delta) {
  showResultCard(item, delta, false);
  resumeScanning();
}

$('#scanCard').addEventListener('click', async (e) => {
  const form = e.target.closest('#quickForm');
  const step = e.target.closest('[data-step]');
  if (form && step) {
    form.qty.value = Math.max(0, round((parseFloat(form.qty.value) || 0) + Number(step.dataset.step)));
    return;
  }
  const q = e.target.closest('[data-quick]')?.dataset.quick;
  if (q === 'skip') {
    lookupToken++;
    $('#scanCard').innerHTML = '';
    return resumeScanning();
  }
  if (q === 'link') {
    const it = byId(e.target.closest('[data-quick]').dataset.id);
    const draft = form._draft;
    checkpoint();
    it.barcode = draft.barcode;
    it.brand ||= draft.brand;
    it.image ||= draft.image;
    if (form._pack && (it.scanQty || 1) === 1) {
      it.scanQty = form._pack.count;
      it.unit ||= form._pack.unit;
    }
    let delta = 'Barcode linked';
    if (prefs.scanMode === 'add') {
      it.qty = round(it.qty + (it.scanQty || 1));
      it.need = false;
      delta = `+${fmt(it.scanQty || 1)} added · barcode linked`;
    } else if (prefs.scanMode === 'use') {
      it.qty = round(Math.max(0, it.qty - 1));
      delta = '−1 used · barcode linked';
    }
    it.updated = Date.now();
    save();
    return finishQuickAdd(it, delta);
  }
  if (q === 'more') {
    const draft = readQuickForm(form);
    const saved = await openEditor(draft, { isNew: true });
    if (saved) finishQuickAdd(saved, 'New item');
    return;
  }

  const act = e.target.closest('[data-scan]')?.dataset.scan;
  if (!act) return;
  const it = byId(e.target.closest('[data-id]')?.dataset.id || $('#scanCard [data-id]')?.dataset.id);
  if (act === 'undo') {
    undo();
    $('#scanCard').innerHTML = '';
    cam.lastCode = '';
  } else if (act === 'inc' || act === 'dec') {
    bump(it, act === 'inc' ? 1 : -1);
    showResultCard(it, '', false);
  } else if (act === 'edit') {
    pauseScanning();
    await openEditor(it);
    if (byId(it.id)) showResultCard(it, '', false);
    else $('#scanCard').innerHTML = '';
    resumeScanning();
  } else if (act === 'list') {
    checkpoint();
    it.need = !it.need;
    save();
    showCheckCard(it, it.barcode);
  } else if (act === 'new') {
    quickAdd(e.target.closest('[data-code]').dataset.code);
  }
});

function readQuickForm(form) {
  return Object.assign(form._draft, {
    name: sentenceCase(form.name.value.trim()),
    qty: Math.max(0, parseFloat(form.qty.value) || 0),
    unit: singularUnit(form.unit.value),
    location: form.location.value,
  });
}

$('#scanCard').addEventListener('submit', (e) => {
  if (e.target.id !== 'quickForm') return;
  e.preventDefault();
  const item = readQuickForm(e.target);
  if (!item.name) return e.target.name.focus();
  checkpoint();
  state.items.push(item);
  save();
  finishQuickAdd(item, `New · ${qtyText(item)}`);
});

async function fetchJSON(url, ms = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Open Food / Beauty / Products Facts are queried together; the first in priority order that
// knows the product wins, without waiting on slower ones. UPCitemdb fills in hardware.
const lookupCache = new Map();
async function lookupBarcode(code) {
  if (lookupCache.has(code)) return lookupCache.get(code);
  const fields = 'product_name,product_name_en,generic_name,brands,quantity,categories,image_front_small_url,image_small_url';
  const sources = [['world.openfoodfacts.org', 'food'], ['world.openbeautyfacts.org', 'beauty'], ['world.openproductsfacts.org', 'product']];
  const pending = sources.map(async ([host, kind]) => {
    const j = await fetchJSON(`https://${host}/api/v2/product/${encodeURIComponent(code)}.json?fields=${fields}`);
    const p = j?.status === 1 ? j.product : null;
    const name = p && (p.product_name_en || p.product_name || p.generic_name);
    return name ? {
      name: name.trim(), brand: (p.brands || '').split(',')[0].trim(), size: (p.quantity || '').replace(/\s+e$/, ''),
      image: p.image_front_small_url || p.image_small_url || '', category: p.categories || '', kind,
    } : null;
  });
  let hit = null;
  for (const p of pending) if ((hit = await p)) break;
  if (!hit) {
    const u = await fetchJSON(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(code)}`);
    const it = u?.items?.[0];
    if (it?.title) hit = { name: it.title, brand: it.brand || '', size: it.size || '', image: it.images?.[0] || '', category: it.category || '', kind: 'product' };
  }
  lookupCache.set(code, hit);
  return hit;
}

// ---------- Wiring ----------

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-undo]')) {
    $('#toast').hidden = true;
    if (undo()) toast('Undone');
    if ($('#voiceResult')) $('#voiceResult').innerHTML = '';
  }
});

$('#main').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const item = byId(btn.closest('[data-id]')?.dataset.id);
  switch (btn.dataset.act) {
    case 'inc': return bump(item, 1);
    case 'dec': return bump(item, -1);
    case 'edit': return openEditor(item);
    case 'got': return markBought(item);
    case 'unbuy': return unmarkBought(item);
    case 'add': return openEditor(newItem({ location: KITCHEN.includes(ui.loc) || DEFAULT_LOCATIONS.includes(ui.loc) ? ui.loc : 'Pantry', qty: 1 }), { isNew: true });
    case 'add-named': {
      const name = sentenceCase(ui.q.trim());
      return openEditor(newItem({ name, qty: 1, location: guessLocation(name) }), { isNew: true });
    }
    case 'sample': return loadSample();
    case 'share-list': return shareShoppingList();
    case 'recipe': return shareKitchen();
  }
});

$('#main').addEventListener('submit', (e) => {
  if (e.target.id !== 'listAdd') return;
  e.preventDefault();
  const text = e.target.what.value.trim();
  if (!text) return;
  addToList(text);
  $('#listAdd input')?.focus();
});

$('#chips').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-loc]');
  if (!chip) return;
  ui.loc = chip.dataset.loc;
  render();
});

$('#search').addEventListener('input', (e) => {
  ui.q = e.target.value;
  render();
});

document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => {
    if (ui.view !== t.dataset.view) ui.bought.clear();
    ui.view = t.dataset.view;
    render();
    scrollTo(0, 0);
  }),
);

$('#scanBtn').addEventListener('click', openScanner);
$('#speakBtn').addEventListener('click', openVoice);
$('#menuBtn').addEventListener('click', openMenu);
$('#backdrop').addEventListener('click', closeSheet);

$('#sheet').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) return closeSheet();
  if (e.target.closest('#micBtn')) return rec ? rec.stop() : startListening();
  const example = e.target.closest('.examples button');
  if (example) {
    $('#typeInput').value = example.textContent;
    $('#typeInput').focus();
    return;
  }
  const m = e.target.closest('[data-menu]')?.dataset.menu;
  if (!m) return;
  if (m === 'sound') {
    prefs.sound = !prefs.sound;
    savePrefs();
    e.target.closest('[data-menu]').textContent = `Scan beep: ${prefs.sound ? 'On' : 'Off'}`;
    return;
  }
  closeSheet();
  if (m === 'add') openEditor(newItem({ qty: 1 }), { isNew: true });
  if (m === 'recipe') shareKitchen();
  if (m === 'export') exportBackup();
  if (m === 'import') $('#importFile').click();
  if (m === 'sample') loadSample();
  if (m === 'erase' && confirm('Erase every item? (You can undo right after.)')) {
    checkpoint();
    state.items = [];
    save();
    toast('Everything erased', { undo: true });
  }
});

$('#sheet').addEventListener('submit', (e) => {
  if (e.target.id !== 'typeForm') return;
  e.preventDefault();
  const text = $('#typeInput').value.trim();
  if (!text) return;
  stopListening();
  $('#heard').textContent = `“${text}”`;
  $('#typeInput').value = '';
  handleCommand([text], false);
});

$('#importFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) importBackup(f);
  e.target.value = '';
});

$('#scanner').addEventListener('click', (e) => {
  if (e.target.closest('[data-close-scan]')) return closeScanner();
  if (e.target.closest('#torchBtn')) return toggleTorch();
  if (e.target.closest('#zoomBtn')) return cycleZoom();
  if (e.target.closest('#typeCodeBtn')) {
    showManual();
    $('#manualCode input').focus();
    return;
  }
  const mode = e.target.closest('[data-mode]')?.dataset.mode;
  if (mode) {
    setScanMode(mode);
    buzz(10);
  }
});

$('#manualCode').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = e.target.querySelector('input');
  const code = normCode(input.value);
  input.value = '';
  input.blur();
  if (code) {
    cam.lastCode = code;
    cam.lastSeen = performance.now();
    handleCode(code);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#sheet').hidden) closeSheet();
  else if (!$('#scanner').hidden) closeScanner();
});

// Release the camera when the app goes to the background; pick it back up on return.
document.addEventListener('visibilitychange', () => {
  if ($('#scanner').hidden) return;
  if (document.hidden) {
    cam.running = false;
    cam.stream?.getTracks().forEach((t) => t.stop());
    cam.stream = null;
  } else if (!cam.stream) {
    startCamera().catch(() => showManual());
  }
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

render();
