import { parseCommand, resolveActions, guessLocation, parsePack, DEFAULT_LOCATIONS } from './parser.js';

const STORAGE_KEY = 'homestock.v1';
const SCANNER_LIB = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
const ZXING_LIB = 'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js';
const LOC_ICONS = { Pantry: '🥫', Fridge: '🥛', Freezer: '🧊', Bathroom: '🧴', Garage: '🧰' };
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round = (n) => Math.round(n * 100) / 100;
const fmt = (n) => (n === 0.5 ? '½' : String(round(n)));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const sentenceCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const buzz = () => navigator.vibrate?.(30);

// ---------- State ----------

let state = load();
const ui = { view: 'stock', loc: 'All', q: '' };
const undoStack = [];

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (s && Array.isArray(s.items)) return s;
  } catch {}
  return { items: [] };
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
  render();
}

// Snapshot before every change so any change can be undone from the toast.
function checkpoint() {
  undoStack.push(JSON.stringify(state.items));
  if (undoStack.length > 30) undoStack.shift();
}

function undo() {
  const snap = undoStack.pop();
  if (!snap) return;
  state.items = JSON.parse(snap);
  save();
  toast('Undone');
}

function newItem(fields) {
  const location = fields.location || 'Pantry';
  return {
    id: uid(), name: '', brand: '', barcode: '', unit: '', image: '', qty: 0, scanQty: 1,
    need: false, low: location === 'Garage' ? 0 : 1, ...fields, location, updated: Date.now(),
  };
}

const isLow = (it) => it.need || (it.low != null && it.qty <= it.low);
const shoppingItems = () => state.items.filter(isLow).sort((a, b) => a.location.localeCompare(b.location) || a.name.localeCompare(b.name));

function allLocations() {
  const used = state.items.map((i) => i.location);
  return [...new Set([...DEFAULT_LOCATIONS, ...used])];
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

// ---------- Rendering ----------

function render() {
  const main = $('#main');
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.view === ui.view));
  $('#stockTools').hidden = ui.view !== 'stock';
  $('#title').textContent = ui.view === 'stock' ? 'Homestock' : 'Shopping';
  const shopCount = shoppingItems().length;
  $('#shopBadge').hidden = !shopCount;
  $('#shopBadge').textContent = shopCount;
  main.innerHTML = ui.view === 'stock' ? renderStock() : renderShop();
}

function thumb(it) {
  return `<button class="thumb" data-act="edit" aria-label="Edit ${esc(it.name)}">${
    it.image ? `<img src="${esc(it.image)}" alt="" loading="lazy">` : LOC_ICONS[it.location] || '📦'
  }</button>`;
}

function itemRow(it, showLoc) {
  const cls = it.qty <= 0 ? 'out' : isLow(it) ? 'low' : '';
  const meta = [it.brand, showLoc ? it.location : ''].filter(Boolean).join(' · ');
  return `<li class="item" data-id="${it.id}">
    ${thumb(it)}
    <button class="info" data-act="edit"><div class="name">${esc(it.name)}</div>${meta ? `<div class="meta">${esc(meta)}</div>` : ''}</button>
    <div class="stepper">
      <button data-act="dec" aria-label="One less">−</button>
      <span class="qty ${cls}">${fmt(it.qty)}${it.unit ? `<small>${esc(pluralUnit(it.unit, it.qty))}</small>` : ''}</span>
      <button data-act="inc" aria-label="One more">+</button>
    </div>
  </li>`;
}

function renderStock() {
  renderChips();
  if (!state.items.length) {
    return `<div class="empty">
      <div class="big">🏠</div>
      <h2>Nothing tracked yet</h2>
      <p>Tap <b>Scan</b> and point at a barcode while you unpack groceries, or tap <b>Speak</b> and say
      “Bought 6 rolls of paper towels.”</p>
      <div class="buttons">
        <button class="btn primary" data-act="sample">Try with sample items</button>
        <button class="btn" data-act="add">Add by hand</button>
      </div>
    </div>`;
  }
  const q = ui.q.trim().toLowerCase();
  let items = state.items.filter((i) => ui.loc === 'All' || i.location === ui.loc);
  if (q) items = items.filter((i) => `${i.name} ${i.brand} ${i.location}`.toLowerCase().includes(q));
  items.sort((a, b) => a.name.localeCompare(b.name));
  if (!items.length) return `<div class="empty"><p>No matches for “${esc(ui.q)}”.</p></div><button class="add-row" data-act="add">+ Add an item</button>`;

  let html;
  if (ui.loc === 'All' && !q) {
    html = allLocations()
      .map((loc) => {
        const group = items.filter((i) => i.location === loc);
        return group.length ? `<h2 class="group">${esc(loc)}</h2><ul class="list">${group.map((i) => itemRow(i, false)).join('')}</ul>` : '';
      })
      .join('');
  } else {
    html = `<ul class="list" style="margin-top:12px">${items.map((i) => itemRow(i, ui.loc === 'All')).join('')}</ul>`;
  }
  return html + `<button class="add-row" data-act="add">+ Add an item</button>`;
}

function renderChips() {
  const counts = {};
  state.items.forEach((i) => (counts[i.location] = (counts[i.location] || 0) + 1));
  const locs = allLocations().filter((l) => counts[l]);
  if (ui.loc !== 'All' && !counts[ui.loc]) ui.loc = 'All';
  $('#chips').innerHTML = locs.length < 2 ? '' : ['All', ...locs]
    .map((l) => `<button class="chip ${ui.loc === l ? 'on' : ''}" data-loc="${esc(l)}">${esc(l)}${l === 'All' ? '' : `<small>${counts[l]}</small>`}</button>`)
    .join('');
}

function renderShop() {
  const items = shoppingItems();
  const list = items.length
    ? `<div class="shop-head"><h2>${items.length} to buy</h2><button class="btn" data-act="share-list">Share list</button></div>
       <ul class="list">${items.map((it) => `<li class="item" data-id="${it.id}">
         <button class="check" data-act="got" aria-label="Bought ${esc(it.name)}"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></button>
         <button class="info" data-act="edit"><div class="name">${esc(it.name)}</div>
           <div class="meta">${esc(it.location)} · ${it.qty <= 0 ? 'out' : `${esc(qtyText(it))} left`}</div></button>
         ${it.need && it.qty > it.low ? '<span class="tag">asked for</span>' : ''}
       </li>`).join('')}</ul>
       <p class="note" style="margin:10px 4px">Tap the circle when you've bought it — it goes back into stock.</p>`
    : `<div class="empty"><div class="big">🛒</div><h2>Nothing to buy</h2>
       <p>Things land here on their own when they run low, or say “add coffee to the shopping list.”</p></div>`;
  const kitchen = state.items.filter((i) => ['Pantry', 'Fridge', 'Freezer'].includes(i.location) && i.qty > 0).length;
  return list + `<div class="card">
      <h3>What can I cook?</h3>
      <p>Copies the ${kitchen} things in your pantry, fridge and freezer as a ready-made question you can paste into Claude or any recipe app.</p>
      <button class="btn primary" data-act="recipe" ${kitchen ? '' : 'disabled'}>Copy kitchen list</button>
    </div>`;
}

// ---------- Changes ----------

function bump(it, dir) {
  checkpoint();
  it.qty = round(Math.max(0, it.qty + dir));
  if (dir > 0 && it.qty > (it.low ?? -1)) it.need = false;
  it.updated = Date.now();
  buzz();
  save();
}

function restock(it) {
  checkpoint();
  it.qty = Math.max(it.qty + (it.scanQty || 1), (it.low ?? 0) + 1);
  it.need = false;
  it.updated = Date.now();
  buzz();
  save();
  toast(`${it.name} restocked · ${qtyText(it)}`, { undo: true });
}

// Applies parsed voice/typed actions. Returns human-readable lines for what happened.
function applyActions(actions) {
  checkpoint();
  const done = [];
  const problems = [];
  for (const a of actions) {
    if (!a.action) {
      problems.push(`Not sure what to do with “${a.name}”. Start with “used”, “bought”, “we have…”`);
      continue;
    }
    let it = a.item;
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
  return { done, problems };
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
  if (!best) return { done: [], problems: [`Didn't catch an item in “${texts[0]}”`] };
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

// Resolves with the saved item, or null if cancelled.
function openEditor(item, { isNew = false, hint = '' } = {}) {
  return new Promise((resolve) => {
    let saved = null;
    const locs = allLocations();
    if (!locs.includes(item.location)) locs.push(item.location);
    const lowOpts = [['', 'Never'], ...[0, 1, 2, 3, 5, 10].map((n) => [n, n === 0 ? 'Out (0)' : String(n)])];
    openSheet(`
      <form class="form" id="editForm">
        <div class="sheet-head"><h2>${isNew ? 'New item' : 'Edit item'}</h2><button type="button" class="link" data-close>Cancel</button></div>
        ${hint ? `<p class="note">${esc(hint)}</p>` : ''}
        ${item.image ? `<img class="hero" src="${esc(item.image)}" alt="">` : ''}
        <label>Name<input name="name" required value="${esc(item.name)}" placeholder="e.g. Paper towels"></label>
        <div class="row2">
          <label>How many
            <div class="stepper big"><button type="button" data-step="-1">−</button><input name="qty" type="number" inputmode="decimal" step="any" min="0" value="${item.qty}"><button type="button" data-step="1">+</button></div>
          </label>
          <label>Counted in<input name="unit" value="${esc(item.unit)}" placeholder="rolls, cans…" autocapitalize="off"></label>
        </div>
        <label>Kept in
          <select name="location">${locs.map((l) => `<option ${l === item.location ? 'selected' : ''}>${esc(l)}</option>`).join('')}<option value="__new">+ New place…</option></select>
        </label>
        <div class="row2">
          <label>Shop when down to
            <select name="low">${lowOpts.map(([v, t]) => `<option value="${v}" ${String(item.low ?? '') === String(v) ? 'selected' : ''}>${t}</option>`).join('')}</select>
          </label>
          <label>Each scan adds<input name="scanQty" type="number" inputmode="numeric" min="1" value="${item.scanQty || 1}"></label>
        </div>
        <details><summary>Brand & barcode</summary>
          <label>Brand<input name="brand" value="${esc(item.brand)}"></label>
          <label>Barcode<input name="barcode" inputmode="numeric" value="${esc(item.barcode)}"></label>
        </details>
        <button class="primary" type="submit">Save</button>
        ${isNew ? '' : '<button type="button" class="danger" data-delete>Delete item</button>'}
      </form>`, () => resolve(saved));

    const form = $('#editForm');
    form.location.addEventListener('change', () => {
      if (form.location.value !== '__new') return;
      const name = prompt('Name the new place (e.g. Basement, Laundry room)')?.trim();
      if (name) form.location.insertAdjacentHTML('afterbegin', `<option selected>${esc(name)}</option>`);
      else form.location.value = item.location;
    });
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
        low: form.low.value === '' ? null : Number(form.low.value),
        scanQty: Math.max(1, parseInt(form.scanQty.value, 10) || 1),
        brand: form.brand.value.trim(),
        barcode: normCode(form.barcode.value),
        updated: Date.now(),
      });
      if (item.qty > (item.low ?? -1)) item.need = false;
      if (isNew) state.items.push(item);
      saved = item;
      save();
      closeSheet();
      toast(isNew ? `Added ${item.name}` : 'Saved', { undo: true });
    });
  });
}

function openMenu() {
  openSheet(`
    <div class="sheet-head"><h2>Options</h2><button class="link" data-close>Done</button></div>
    <div class="menu">
      <button data-menu="add">Add an item by hand</button>
      <button data-menu="recipe">Copy kitchen list for recipe ideas</button>
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
  const items = state.items.filter((i) => ['Pantry', 'Fridge', 'Freezer'].includes(i.location) && i.qty > 0);
  const lines = items.map((i) => `- ${i.name} (${qtyText(i)})`).join('\n');
  shareText(`Here's what I have in my kitchen right now:\n${lines}\n\nWhat could I make using mostly these? Suggest a few recipes and tell me anything small I'd need to buy.`, 'My kitchen');
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
  const s = (name, qty, unit, location, extra = {}) => newItem({ name, qty, unit, location, ...extra });
  state.items.push(
    s('Paper towels', 6, 'roll', 'Pantry', { brand: 'Bounty', scanQty: 6, low: 2 }),
    s('Diced tomatoes', 4, 'can', 'Pantry'),
    s('Spaghetti', 2, 'box', 'Pantry'),
    s('Black beans', 3, 'can', 'Pantry'),
    s('Olive oil', 1, 'bottle', 'Pantry'),
    s('Rice', 1, 'bag', 'Pantry', { low: 0 }),
    s('Milk', 1, 'gallon', 'Fridge'),
    s('Eggs', 12, '', 'Fridge', { scanQty: 12, low: 4 }),
    s('Cheddar cheese', 1, 'block', 'Fridge', { low: 0 }),
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
        <input id="typeInput" placeholder="…or type it" autocomplete="off" enterkeyhint="go">
        <button>Go</button>
      </form>
      <div class="examples"><b>Things you can say</b>
        <span>Removing a roll of paper towels</span><span>Used 2 cans of tomatoes and a box of spaghetti</span>
        <span>Bought a dozen eggs</span><span>We're out of milk</span><span>We have 3 rolls of duct tape</span>
        <span>Add coffee to the shopping list</span><span>Put 2 boxes of screws in the garage</span>
      </div>
    </div>`, stopListening);
  if (SR) startListening();
}

function startListening() {
  stopListening();
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
    if (finals) handleCommand(finals);
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

function handleCommand(texts) {
  const { done, problems } = runCommand(texts);
  if (done.length && !problems.length) {
    closeSheet();
    buzz();
    toast(done.join('\n'), { undo: true });
    return;
  }
  const box = $('#voiceResult');
  if (!box) return toast([...done, ...problems].join('\n'), { undo: done.length > 0 });
  box.innerHTML = done.map((d) => `<li>${esc(d)}</li>`).join('') + problems.map((p) => `<li class="bad">${esc(p)}</li>`).join('');
  if (done.length) box.insertAdjacentHTML('beforeend', '<li style="background:none;text-align:right"><button class="link" data-undo>Undo</button></li>');
}

// ---------- Barcode scanning ----------

let scanner = null;
let scanMode = localStorage.getItem('homestock.scanMode') || 'add';
let lastCode = '';
let lastAt = 0;
let scanBusy = false;

// UPC-A (12 digits) and EAN-13 with a leading 0 are the same product.
const normCode = (c) => {
  const s = String(c || '').trim().replace(/\s+/g, '');
  return /^\d{12}$/.test(s) ? '0' + s : s;
};

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = Object.assign(document.createElement('script'), { src, onload: resolve, onerror: reject });
    document.head.append(s);
  });
}

function setScanMode(mode) {
  scanMode = mode;
  try { localStorage.setItem('homestock.scanMode', mode); } catch {}
  document.querySelectorAll('.seg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === mode);
    b.setAttribute('aria-checked', b.dataset.mode === mode);
  });
}

async function openScanner() {
  $('#scanner').hidden = false;
  $('#scanLog').innerHTML = '';
  setScanMode(scanMode);
  const hint = $('#scanHint');
  hint.textContent = 'Starting camera…';
  try {
    await loadScript(SCANNER_LIB);
    const F = window.Html5QrcodeSupportedFormats;
    scanner = new window.Html5Qrcode('reader', {
      verbose: false,
      formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.QR_CODE],
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
    });
    // Full frame at high resolution: laptop webcams are fixed-focus, so barcodes are small and soft.
    await scanner.start(
      { facingMode: 'environment' },
      {
        fps: 15,
        videoConstraints: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 }, advanced: [{ focusMode: 'continuous' }] },
      },
      onCode,
      () => {},
    );
    if ($('#scanner').hidden) return closeScanner();
    startExtraDetector();
    hint.textContent = 'Hold the barcode flat, about 8–12 inches away, and keep it still';
  } catch (e) {
    hint.textContent = 'Camera unavailable here — type the barcode number below.';
    scanner = null;
  }
}

// A second reader runs on the live video alongside the library's own decoder, which only
// reads barcodes running left-to-right. Chrome/Android have a built-in reader that handles
// any angle and blurry webcam frames; elsewhere (Safari, iPhone) ZXing reads a copy of each
// frame turned 90°, so barcodes printed vertically on a box still scan.
let extraTimer = null;
async function startExtraDetector() {
  const read = (await nativeReader()) || (await sidewaysReader());
  if (!read) return;
  const tick = async () => {
    const video = $('#reader video');
    if (!scanner || $('#scanner').hidden) return;
    try {
      if (video?.readyState >= 2 && !scanBusy) {
        const code = await read(video);
        if (code) onCode(code);
      }
    } catch {}
    extraTimer = setTimeout(tick, 200);
  };
  tick();
}

async function nativeReader() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'].filter((f) => supported.includes(f));
    if (!formats.length) return null;
    const detector = new window.BarcodeDetector({ formats });
    return async (video) => (await detector.detect(video))[0]?.rawValue;
  } catch {
    return null;
  }
}

async function sidewaysReader() {
  try {
    await loadScript(ZXING_LIB);
  } catch {
    return null;
  }
  const Z = window.ZXing;
  const reader = new Z.MultiFormatReader();
  const F = Z.BarcodeFormat;
  reader.setHints(new Map([
    [Z.DecodeHintType.POSSIBLE_FORMATS, [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39]],
    [Z.DecodeHintType.TRY_HARDER, true],
  ]));
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return (video) => {
    const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    canvas.width = h;
    canvas.height = w;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.translate(h / 2, w / 2);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(video, -w / 2, -h / 2, w, h);
    try {
      return reader.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)))).getText();
    } catch {
      return null;
    } finally {
      reader.reset();
    }
  };
}

async function closeScanner() {
  clearTimeout(extraTimer);
  $('#scanner').hidden = true;
  const s = scanner;
  scanner = null;
  try {
    if (s?.isScanning) await s.stop();
    s?.clear();
  } catch {}
  $('#reader').innerHTML = '';
}

function pauseScanner(on) {
  try {
    if (on) scanner?.pause(true);
    else scanner?.resume();
  } catch {}
}

async function onCode(raw) {
  const code = normCode(raw);
  if (scanBusy || (code === lastCode && Date.now() - lastAt < 2500)) return;
  lastCode = code;
  lastAt = Date.now();
  scanBusy = true;
  buzz();
  try {
    await handleCode(code);
  } finally {
    lastAt = Date.now();
    scanBusy = false;
  }
}

function logScan(text) {
  $('#scanLog').insertAdjacentHTML('afterbegin', `<li>${esc(text)}</li>`);
}

async function handleCode(code) {
  const known = state.items.find((i) => i.barcode && normCode(i.barcode) === code);
  if (known) {
    checkpoint();
    if (scanMode === 'add') {
      known.qty = round(known.qty + (known.scanQty || 1));
      known.need = false;
    } else {
      known.qty = round(Math.max(0, known.qty - 1));
    }
    known.updated = Date.now();
    save();
    const delta = scanMode === 'add' ? `+${known.scanQty || 1}` : '−1';
    logScan(`${delta} ${known.name} → ${qtyText(known)}`);
    toast(`${delta} ${known.name} · ${qtyText(known)}`, { undo: true });
    return;
  }

  // New barcode: look it up, then confirm the details once. Next time it's a single beep.
  pauseScanner(true);
  let cancelled = false;
  openSheet(`<div class="sheet-head"><h2>Looking it up…</h2><button class="link" data-close>Cancel</button></div>
    <p class="note">Barcode ${esc(code)}</p>`, () => (cancelled = true));
  const info = await lookupBarcode(code);
  if (cancelled) return pauseScanner(false);

  const pack = parsePack(`${info?.size || ''} ${info?.name || ''}`);
  const location = guessLocation(`${info?.name || ''} ${info?.category || ''}`, info?.kind);
  const item = newItem({
    name: info?.name || '',
    brand: info?.brand || '',
    image: info?.image || '',
    barcode: code,
    location,
    unit: pack?.unit || '',
    scanQty: pack?.count || 1,
    qty: scanMode === 'add' ? pack?.count || 1 : 0,
  });
  const hint = info
    ? `Found it${info.size ? ` (${info.size})` : ''}. Check the details and save — next time this barcode just counts.`
    : 'Not in the product databases — give it a name once and it will be remembered.';
  const saved = await openEditor(item, { isNew: true, hint });
  if (saved) logScan(`New: ${saved.name} → ${qtyText(saved)}`);
  pauseScanner(false);
}

async function fetchJSON(url, ms = 6000) {
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

// Open Food / Beauty / Products Facts cover groceries, toiletries and general goods;
// UPCitemdb fills in hardware and other retail items.
async function lookupBarcode(code) {
  const fields = 'product_name,product_name_en,generic_name,brands,quantity,categories,image_front_small_url,image_small_url';
  const sources = [['world.openfoodfacts.org', 'food'], ['world.openbeautyfacts.org', 'beauty'], ['world.openproductsfacts.org', 'product']];
  const found = await Promise.all(
    sources.map(async ([host, kind]) => {
      const j = await fetchJSON(`https://${host}/api/v2/product/${encodeURIComponent(code)}.json?fields=${fields}`);
      const p = j?.status === 1 ? j.product : null;
      const name = p && (p.product_name_en || p.product_name || p.generic_name);
      return name ? {
        name: name.trim(), brand: (p.brands || '').split(',')[0].trim(), size: p.quantity || '',
        image: p.image_front_small_url || p.image_small_url || '', category: p.categories || '', kind,
      } : null;
    }),
  );
  const hit = found.find(Boolean);
  if (hit) return hit;
  const u = await fetchJSON(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(code)}`);
  const it = u?.items?.[0];
  if (!it?.title) return null;
  return { name: it.title, brand: it.brand || '', size: it.size || '', image: it.images?.[0] || '', category: it.category || '', kind: 'product' };
}

// ---------- Wiring ----------

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-undo]')) {
    $('#toast').hidden = true;
    undo();
    if (!$('#sheet').hidden && $('#voiceResult')) $('#voiceResult').innerHTML = '';
  }
});

$('#main').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('[data-id]')?.dataset.id;
  const item = state.items.find((i) => i.id === id);
  switch (btn.dataset.act) {
    case 'inc': return bump(item, 1);
    case 'dec': return bump(item, -1);
    case 'edit': return openEditor(item);
    case 'got': return restock(item);
    case 'add': return openEditor(newItem({ location: ui.loc === 'All' ? 'Pantry' : ui.loc, qty: 1 }), { isNew: true });
    case 'sample': return loadSample();
    case 'share-list': return shareShoppingList();
    case 'recipe': return shareKitchen();
  }
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
  const example = e.target.closest('.examples span');
  if (example) {
    $('#typeInput').value = example.textContent;
    $('#typeInput').focus();
  }
  const m = e.target.closest('[data-menu]')?.dataset.menu;
  if (!m) return;
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
  handleCommand([text]);
});

$('#importFile').addEventListener('change', (e) => {
  const f = e.target.files[0];
  if (f) importBackup(f);
  e.target.value = '';
});

$('#scanner').addEventListener('click', (e) => {
  if (e.target.closest('[data-close-scan]')) return closeScanner();
  const mode = e.target.closest('[data-mode]')?.dataset.mode;
  if (mode) {
    setScanMode(mode);
    $('#scanHint').textContent = mode === 'add' ? 'Scan each thing as you put it away' : 'Scan each thing as you use it up';
  }
});

$('#manualCode').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = e.target.querySelector('input');
  const code = input.value.trim();
  input.value = '';
  if (code) {
    lastCode = '';
    onCode(code);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#sheet').hidden) closeSheet();
  else if (!$('#scanner').hidden) closeScanner();
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

render();
