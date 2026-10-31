import {
  parseCommand, resolveActions, matchItem, matchExact, guessLocation, guessEmoji, parsePack, parseListLines,
  suggestShelfLife, openLife, isoDate, DEFAULT_LOCATIONS,
} from './parser.js?v=24';
import { initSync, pushSoon, syncInfo, createHousehold, joinHousehold, leaveHousehold } from './sync.js?v=24';

const APP_VERSION = new URL(import.meta.url).searchParams.get('v') || 'dev';
const STORAGE_KEY = 'homestock.v1';
const PREFS_KEY = 'homestock.prefs';
const KITCHEN = ['Pantry', 'Fridge', 'Freezer'];
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const round = (n) => Math.round(n * 100) / 100;
const FRACTIONS = { 0.1: '⅒', 0.25: '¼', 0.33: '⅓', 0.5: '½', 0.67: '⅔', 0.75: '¾' };
// 1.5 → "1½", 0.25 → "¼" (what's left in an opened package).
function fmt(n) {
  n = round(n);
  const whole = Math.floor(n);
  const glyph = FRACTIONS[round(n - whole)];
  return glyph ? `${whole || ''}${glyph}` : String(n);
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const sentenceCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const titleCase = (s) => s.trim().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const buzz = (ms = 30) => navigator.vibrate?.(ms);

// ---------- State ----------

let state = load(STORAGE_KEY, { items: [] });
const prefs = { scanMode: 'add', sound: true, stores: ['Costco', 'Aldi', 'Target', 'Walmart'], places: [...DEFAULT_LOCATIONS], ...load(PREFS_KEY, {}) };
delete prefs.shopStore; // the store filter used to be remembered between launches; now it isn't
// shopStore: the store picked at the top of the shopping list, for this visit only.
const ui = { view: 'stock', loc: 'All', q: '', bought: new Map(), flash: null, editor: null, paste: null, shopStore: 'all' };
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
  pushSoon(); // stores and places are shared with the household
}

let persistAsked = false;
function save() {
  // A dismissed low-stock item comes back once its count changes; a list-only item
  // becomes a normal stock item once you actually have some.
  for (const it of state.items) {
    if (it.skipAt != null && it.qty !== it.skipAt) delete it.skipAt;
    if (it.listOnly && it.qty > 0) delete it.listOnly;
    if (it.qty <= 0) delete it.opened;
    tidySpots(it);
  }
  updateBadge();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    pushSoon();
  } catch {
    setTimeout(() => toast('Couldn’t save — this phone’s storage for Key Record is full. Remove some photos, or back up from the ⋯ menu.'), 0);
  }
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

// An item can be kept in several places: `location` is its main place, `spots` holds the
// counts kept elsewhere, and `qty` is always the total.
const spotTotal = (it) => Object.values(it.spots || {}).reduce((a, b) => a + b, 0);
const countAt = (it, place) => (place === it.location ? round(it.qty - spotTotal(it)) : it.spots?.[place] || 0);
const placesOf = (it) => [it.location, ...Object.keys(it.spots || {})];
// Show it under each place that has some, or under its main place when it's out everywhere.
const shownIn = (it) => {
  const have = placesOf(it).filter((pl) => countAt(it, pl) > 0);
  return have.length ? have : [it.location];
};

// Add to or take from one place. Without a place it's the main place; taking more than is
// there stops at zero.
function adjustAt(it, place, d) {
  if (!place || place === it.location) {
    it.qty = round(it.qty + Math.max(d, -countAt(it, it.location)));
    return;
  }
  it.spots ||= {};
  const change = Math.max(d, -(it.spots[place] || 0));
  it.spots[place] = round((it.spots[place] || 0) + change);
  it.qty = round(it.qty + change);
}

// Keep spots consistent after any change: using things up takes from the main place first,
// then from the other places; empty places drop off.
function tidySpots(it) {
  if (!it.spots) return;
  delete it.spots[it.location];
  for (const [pl, n] of Object.entries(it.spots)) if (!(n > 0)) delete it.spots[pl];
  let short = round(spotTotal(it) - it.qty);
  for (const pl of Object.keys(it.spots)) {
    if (short <= 0) break;
    const take = Math.min(short, it.spots[pl]);
    it.spots[pl] = round(it.spots[pl] - take);
    short = round(short - take);
    if (!it.spots[pl]) delete it.spots[pl];
  }
  if (!Object.keys(it.spots).length) delete it.spots;
}

const dateIn = (days) => {
  const d = new Date();
  return isoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
};
const todayIso = () => dateIn(0);

// A fresh purchase gets a fresh use-by: from what you set last time, or a typical shelf life
// for fresh food. Older stock still on hand keeps its earlier date.
function freshUseBy(it, qtyBefore) {
  if (it.noUseBy || (qtyBefore > 0 && it.useBy)) return;
  const days = it.shelfLife || suggestShelfLife(it.name, it.location);
  if (days) it.useBy = dateIn(days);
}

// Number of things to use within two days, on the home-screen icon (if turned on).
function updateBadge() {
  if (!prefs.badge || !navigator.setAppBadge) return;
  const n = state.items.filter((i) => i.qty > 0 && daysLeft(i) !== null && daysLeft(i) <= 2).length;
  (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}
// Out of something that's on the shopping list: it lives on the list, not in Stock.
const inStock = (it) => !(it.qty <= 0 && isLow(it));
const isLow = (it) => it.need || (it.low != null && it.qty <= it.low && it.skipAt !== it.qty);
const shoppingItems = () => state.items.filter(isLow).sort((a, b) => a.location.localeCompare(b.location) || a.name.localeCompare(b.name));

function allStores() {
  return [...new Set([...prefs.stores, ...state.items.map((i) => i.store).filter(Boolean)])];
}

// The store chosen at the top of the shopping list, or 'all'.
function shopStore() {
  const s = ui.shopStore;
  return s && s !== 'all' && allStores().includes(s) ? s : 'all';
}

function allLocations() {
  return [...new Set([...prefs.places, ...state.items.flatMap(placesOf)])];
}

function pluralUnit(unit, n) {
  if (!unit || n <= 1) return unit || ''; // "1 bottle", "½ bottle"

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
  document.body.classList.toggle('editing', Boolean(ui.editor || ui.paste));
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('on', t.dataset.view === ui.view);
    t.setAttribute('aria-current', t.dataset.view === ui.view ? 'page' : 'false');
  });
  $('#stockTools').hidden = ui.view !== 'stock';
  $('#title').textContent = ui.view === 'stock' ? 'Key Record' : 'Shopping';
  const shopCount = shoppingItems().filter((i) => !ui.bought.has(i.id)).length;
  $('#shopBadge').hidden = !shopCount;
  $('#shopBadge').textContent = shopCount;
  if (ui.editor) return; // the editor page owns the screen while it's open
  if (ui.paste) {
    if (!$('#pasteForm')) $('#main').innerHTML = renderPaste();
    return;
  }
  $('#main').innerHTML = ui.view === 'stock' ? renderStock() : renderShop();
  if (ui.flash) $('#main .flash')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  ui.flash = null;
}

function thumb(it, asButton = true) {
  const inner = it.image ? `<img src="${esc(it.image)}" alt="" loading="lazy">` : `<span class="emoji">${guessEmoji(it.name, it.location)}</span>`;
  return asButton
    ? `<button class="thumb" data-act="edit" aria-label="Edit ${esc(it.name)}">${inner}</button>`
    : `<div class="thumb" aria-hidden="true">${inner}</div>`;
}

function openedText(it) {
  if (!it.opened || it.qty <= 0) return '';
  const days = Math.round((new Date(todayIso() + 'T00:00') - new Date(it.opened + 'T00:00')) / 864e5);
  return days <= 0 ? 'Opened today' : days === 1 ? 'Opened yesterday' : `Opened ${days} days ago`;
}

function itemRow(it, showLoc, place = null) {
  const listed = isLow(it);
  const here = place && it.spots ? countAt(it, place) : it.qty;
  const cls = here <= 0 ? 'out' : listed ? 'low' : '';
  const where = it.spots
    ? place
      ? `${fmt(it.qty)} total · ${placesOf(it).filter((pl) => pl !== place && countAt(it, pl) > 0).map((pl) => `${esc(pl)} ${fmt(countAt(it, pl))}`).join(', ')}`
      : placesOf(it).map((pl) => `${esc(pl)} ${fmt(countAt(it, pl))}`).join(' · ')
    : showLoc ? esc(it.location) : '';
  const meta = [esc(it.brand), where, openedText(it), useByHtml(it), listed ? '<span class="warn">On list</span>' : '']
    .filter(Boolean).join(' · ');
  return `<li class="swipe-row swipeable" data-id="${it.id}" data-swipe-right="${listed ? 'unlist' : 'tolist'}" data-swipe-left="delete">
    <span class="swipe-label act-right ${listed ? 'off' : ''}" aria-hidden="true">${listed ? 'Off the list' : 'Add to list'}</span>
    <span class="swipe-label act-left" aria-hidden="true">Delete</span>
    <div class="item ${ui.flash === it.id ? 'flash' : ''}">
      ${thumb(it)}
      <button class="info" data-act="edit"><div class="name">${esc(it.name)}</div>${meta ? `<div class="meta">${meta}</div>` : ''}</button>
      <div class="stepper">
        <button data-act="dec" data-place="${esc(place || '')}" aria-label="One less ${esc(it.name)}" ${here <= 0 ? 'disabled' : ''}>−</button>
        <span class="qty ${cls}" aria-label="${esc(qtyText(it, here))}">${fmt(here)}${it.unit ? `<small>${esc(pluralUnit(it.unit, here))}</small>` : ''}</span>
        <button data-act="inc" data-place="${esc(place || '')}" aria-label="One more ${esc(it.name)}">+</button>
      </div>
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
  const matches = (i) => `${i.name} ${i.brand} ${placesOf(i).join(' ')}`.toLowerCase().includes(q);
  let items = state.items.filter(inStock).filter((i) => ui.loc === 'All' || (ui.loc === 'soon' ? useSoon(i) : shownIn(i).includes(ui.loc)));
  if (q) items = items.filter(matches);
  items.sort(ui.loc === 'soon' ? (a, b) => daysLeft(a) - daysLeft(b) : (a, b) => a.name.localeCompare(b.name));
  // Searching for something you're out of: point to the list rather than offering a duplicate.
  const onListOnly = q ? state.items.filter((i) => !inStock(i) && matches(i)) : [];
  const listNote = onListOnly.length
    ? `<div class="card list-note"><p><b>${onListOnly.map((i) => esc(i.name)).join(', ')}</b> ${onListOnly.length === 1 ? 'is' : 'are'} out and on your shopping list.</p>
       <button class="btn small" data-act="go-shop">View shopping list</button></div>`
    : '';
  if (!items.length) {
    if (onListOnly.length) return listNote;
    if (q) {
      return `<div class="empty"><p>Nothing called “${esc(ui.q)}” yet.</p>
         <button class="btn primary" data-act="add-named">Add “${esc(ui.q.trim())}”</button></div>`;
    }
    const out = state.items.length - state.items.filter(inStock).length;
    return `<div class="empty"><p>Nothing in stock here.${out ? ` ${out} thing${out === 1 ? ' is' : 's are'} on your shopping list.` : ''}</p>
      ${out ? '<button class="btn" data-act="go-shop">View shopping list</button>' : ''}</div>`;
  }

  let html;
  if (ui.loc === 'All' && !q) {
    html = allLocations()
      .map((loc) => {
        const group = items.filter((i) => shownIn(i).includes(loc));
        return group.length ? `<h2 class="group">${esc(loc)}</h2><ul class="list">${group.map((i) => itemRow(i, false, loc)).join('')}</ul>` : '';
      })
      .join('');
  } else {
    const place = ui.loc !== 'All' && ui.loc !== 'soon' ? ui.loc : null;
    html = `<ul class="list" style="margin-top:12px">${items.map((i) => itemRow(i, !place, place)).join('')}</ul>`;
  }
  const tip = prefs.stockSwipeTipSeen ? '' : '<p class="note" style="margin:10px 4px 0">Swipe an item right to add it to the shopping list, or left to delete it.</p>';
  return tip + html + listNote + `<div class="add-pair"><button class="add-row" data-act="add">+ Add an item</button><button class="add-row" data-act="paste">Paste a list</button></div>`;
}

function renderChips() {
  const counts = {};
  state.items.filter(inStock).forEach((i) => shownIn(i).forEach((pl) => (counts[pl] = (counts[pl] || 0) + 1)));
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
  const status = it.listOnly ? 'Not in stock' : it.qty <= 0 ? 'Out' : `${esc(qtyText(it))} left`;
  const meta = bought ? `Back in stock · ${esc(qtyText(it))}` : `${status} · ${esc(it.location)}`;
  return `<li class="swipe-row ${bought ? '' : 'swipeable'}" data-id="${it.id}" data-swipe-left="unlist">
    ${bought ? '' : '<span class="swipe-label act-left" aria-hidden="true">Remove</span>'}
    <div class="item ${bought ? 'bought' : ''} ${ui.flash === it.id ? 'flash' : ''}">
      <button class="check" data-act="${bought ? 'unbuy' : 'got'}" role="checkbox" aria-checked="${bought}" aria-label="${esc(it.name)}">
        <svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></button>
      <button class="info" data-act="edit"><div class="name">${esc(it.name)}</div><div class="meta">${meta}</div></button>
      ${bought ? '' : `<button class="store-btn" data-act="pick-store" aria-label="Store for ${esc(it.name)}: ${esc(it.store || 'any store')}">
        <span class="store-pill ${it.store ? '' : 'empty'}">${esc(it.store || '+ Store')}</span></button>`}
      ${bought ? '' : `<button class="remove" data-act="unlist" aria-label="Remove ${esc(it.name)} from the list">
        <svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button>`}
    </div>
  </li>`;
}

const byPlace = (a, b) => a.location.localeCompare(b.location) || a.name.localeCompare(b.name);

// What's on the list for the chosen store: that store's items plus anything not tied to a store.
function listForStore(store) {
  const items = shoppingItems().filter((i) => !ui.bought.has(i.id));
  return store === 'all' ? items : items.filter((i) => i.store === store || !i.store);
}

function renderShop() {
  const all = listForStore('all');
  const bought = [...ui.bought.keys()].map(byId).filter(Boolean);
  const stores = allStores();
  const sel = shopStore();
  const counts = {};
  all.forEach((i) => (counts[i.store || ''] = (counts[i.store || ''] || 0) + 1));
  let html = '';
  if (all.some((i) => i.store) || sel !== 'all') {
    const chip = (key, label, n) =>
      `<button class="chip ${sel === key ? 'on' : ''}" data-shop-store="${esc(key)}" aria-pressed="${sel === key}">${esc(label)}${n ? `<small>${n}</small>` : ''}</button>`;
    html += `<nav class="chips shop-stores" aria-label="Store">${chip('all', 'All stores', all.length)}${stores
      .filter((st) => counts[st] || st === sel)
      .map((st) => chip(st, st, counts[st]))
      .join('')}</nav>`;
  }
  html += `<form class="quick-add" id="listAdd">
      <input name="what" placeholder="${sel === 'all' ? 'Add to the list…' : `Add to the ${esc(sel)} list…`}" autocomplete="off" enterkeyhint="done" aria-label="Add to the shopping list">
      <button>Add</button>
    </form>
    <button class="link small paste-link" data-act="paste">Paste a list instead</button>`;
  const visible = listForStore(sel);
  if (visible.length) {
    html += `<div class="shop-head"><h2>${visible.length} to buy${sel === 'all' ? '' : ` at ${esc(sel)}`}</h2>
      <button class="btn small" data-act="share-list">Share</button></div>`;
    const groups = (sel === 'all' ? stores.map((st) => [st, all.filter((i) => i.store === st)]) : [[sel, visible.filter((i) => i.store === sel)]])
      .concat([['Any store', visible.filter((i) => !i.store)]])
      .filter(([, g]) => g.length);
    for (const [name, g] of groups) {
      if (groups.length > 1) html += `<h2 class="group">${esc(name)}</h2>`;
      html += `<ul class="list shop-list">${g.sort(byPlace).map((i) => shopRow(i, false)).join('')}</ul>`;
    }
  } else if (!bought.length) {
    html += `<div class="empty"><div class="big">🛒</div><h2>Nothing to buy${sel === 'all' ? '' : ` at ${esc(sel)}`}</h2>
      <p>Things land here on their own when they run low. You can also say “add coffee to the ${sel === 'all' ? 'shopping' : esc(sel)} list.”</p></div>`;
  }
  if (bought.length) {
    html += `<h2 class="group"><span>In the cart · back in stock</span></h2><ul class="list shop-list">${bought.map((i) => shopRow(i, true)).join('')}</ul>
      <p class="note" style="margin:8px 4px">Tapped one by mistake? Tap it again.</p>`;
  } else if (visible.length && !prefs.swipeTipSeen) {
    html += `<p class="note" style="margin:8px 4px">${[
      prefs.storeTipSeen ? '' : 'Tap a store tag, or press and hold an item and drag it onto a store.',
      prefs.swipeTipSeen ? '' : 'Swipe left or tap ✕ to take something off the list.',
    ].filter(Boolean).join(' ') || 'Tick things off as you shop.'}</p>`;
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

function bump(it, dir, place = null) {
  checkpoint();
  const wasInStock = inStock(it);
  if (place) adjustAt(it, place, dir);
  else it.qty = round(Math.max(0, it.qty + dir));
  if (dir > 0 && it.qty > (it.low ?? -1)) it.need = false;
  it.updated = Date.now();
  buzz(15);
  save();
  if (wasInStock && !inStock(it)) toast(`${it.name} is out — moved to the shopping list`, { undo: true });
}

function markBought(it) {
  ui.bought.set(it.id, { qty: it.qty, need: it.need, listOnly: it.listOnly, useBy: it.useBy, spots: it.spots && { ...it.spots } });
  const qtyBefore = it.qty;
  it.qty = Math.max(it.qty + (it.scanQty || 1), (it.low ?? 0) + 1);
  freshUseBy(it, qtyBefore);
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

// Off the list without opening it. Something that was only ever on the list goes away
// entirely; anything in stock stays there, just not on the list until its count changes.
function unlist(it) {
  if (it.listOnly && it.qty <= 0) {
    state.items = state.items.filter((i) => i !== it);
  } else {
    it.need = false;
    if (isLow(it)) it.skipAt = it.qty;
    it.updated = Date.now();
  }
}

function deleteItem(it) {
  if (!it) return;
  checkpoint();
  state.items = state.items.filter((i) => i.id !== it.id);
  buzz(20);
  save();
  toast(`Deleted ${it.name}`, { undo: true });
}

function removeFromList(it) {
  if (!it) return;
  checkpoint();
  unlist(it);
  buzz(15);
  if (!prefs.swipeTipSeen) {
    prefs.swipeTipSeen = true;
    savePrefs();
  }
  save();
  toast(`Removed ${it.name} from the list`, { undo: true });
}

function assignStore(it, store) {
  if (!it) return;
  if (store === '__new') {
    const name = prompt('Store name (e.g. Costco, Aldi)')?.trim();
    if (!name) return;
    store = titleCase(name);
  }
  if ((it.store || '') === store) return;
  checkpoint();
  it.store = store;
  it.updated = Date.now();
  if (store && !prefs.stores.includes(store)) prefs.stores.push(store);
  prefs.storeTipSeen = true;
  savePrefs();
  ui.flash = it.id;
  buzz(20);
  save();
  toast(`${it.name} → ${store || 'any store'}`, { undo: true });
}

function storeChoices(it, attr) {
  return `<div class="drop-grid">${['', ...allStores()]
    .map((st) => `<button type="button" ${attr}="${esc(st)}" class="${(it.store || '') === st ? 'current' : ''}">${esc(st || 'Any store')}</button>`)
    .join('')}<button type="button" ${attr}="__new" class="new">+ New store</button></div>`;
}

function openStorePicker(it) {
  openSheet(`
    <div class="sheet-head"><h2>Where do you buy ${esc(it.name.toLowerCase())}?</h2><button class="link" data-close>Cancel</button></div>
    <div class="picker" data-id="${it.id}">${storeChoices(it, 'data-assign-store')}</div>`);
}

function putOnList(it) {
  if (!it) return;
  checkpoint();
  it.need = true;
  it.updated = Date.now();
  revealOnList(it);
  buzz(15);
  save();
  toast(`Added ${it.name} to the list`, { undo: true });
}

// Something just put on the list must be visible there: if the store filter would hide it,
// show all stores. The row is highlighted and scrolled into view on the next render.
function revealOnList(it) {
  if (!it) return;
  ui.flash = it.id;
  const sel = shopStore();
  if (sel !== 'all' && it.store && it.store !== sel) ui.shopStore = 'all';
}

function addToList(text) {
  const sel = shopStore();
  const actions = resolveActions(parseCommand(`need ${text}`, { locations: allLocations(), stores: allStores() }), state.items);
  if (!actions.length) return;
  checkpoint();
  for (const a of actions) {
    let it = a.item;
    if (!it) {
      it = newItem({ name: sentenceCase(a.name), qty: 0, location: guessLocation(a.name), listOnly: true });
      state.items.push(it);
    }
    if (a.store) it.store = a.store;
    else if (sel !== 'all' && !it.store) it.store = sel;
    it.need = true;
    it.updated = Date.now();
    ui.bought.delete(it.id);
    revealOnList(it);
  }
  save();
}

// Applies parsed voice/typed actions and answers questions.
function applyActions(actions) {
  checkpoint();
  const done = [];
  const problems = [];
  const answers = [];
  const listed = [];
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
      it = newItem({ name: sentenceCase(a.name), qty, unit: a.unit || '', location: a.location || guessLocation(a.name), listOnly: qty <= 0 && (a.action === 'need' || a.action === 'out') });
      state.items.push(it);
    };
    switch (a.action) {
      case 'remove': {
        if (!it) { problems.push(`Couldn't find “${a.name}” in your stock`); continue; }
        // "…from the garage" takes from there; otherwise from the main place first.
        const from = a.location && placesOf(it).includes(a.location) ? a.location : null;
        if (from) adjustAt(it, from, -a.qty);
        else it.qty = round(Math.max(0, it.qty - a.qty));
        done.push(`−${fmt(a.qty)} ${it.name}${from && it.spots ? ` from the ${from.toLowerCase()}` : ''} → ${qtyText(it)} left`);
        break;
      }
      case 'add': {
        const isNew = !it;
        if (!it) create(0);
        const qtyBefore = it.qty;
        // "Put 6 rolls of paper towels in the garage" for something kept elsewhere adds a second place.
        const elsewhere = !isNew && a.location && a.location !== it.location;
        if (elsewhere && qtyBefore > 0) adjustAt(it, a.location, a.qty);
        else {
          if (elsewhere) it.location = a.location;
          it.qty = round(it.qty + a.qty);
        }
        it.need = false;
        freshUseBy(it, qtyBefore);
        done.push(`+${fmt(a.qty)} ${it.name}${elsewhere ? ` in the ${a.location.toLowerCase()}` : ''} → ${qtyText(it)}${isNew ? ' (new)' : it.spots ? ' total' : ''}`);
        break;
      }
      case 'set':
        if (a.qty == null) { problems.push(`How many ${a.name}? Try “we have 4 ${a.name}”`); continue; }
        if (!it) create(0);
        if (a.location && placesOf(it).includes(a.location) && it.spots) adjustAt(it, a.location, a.qty - countAt(it, a.location));
        else it.qty = a.qty;
        if (it.qty > (it.low ?? -1)) it.need = false;
        done.push(`${it.name} set to ${qtyText(it)}`);
        break;
      case 'expiry':
        if (!it) { problems.push(`Couldn't find “${a.name}” to set its use-by date`); continue; }
        setUseBy(it, a.useBy);
        done.push(`${it.name}: use by ${new Date(a.useBy + 'T00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`);
        break;
      case 'open': {
        if (!it) { problems.push(`Couldn't find “${a.name}” in your stock`); continue; }
        const days = markOpened(it);
        done.push(`Opened ${it.name}${days ? ` · use within ${days} days` : ''}`);
        break;
      }
      case 'level': {
        if (!it) { problems.push(`Couldn't find “${a.name}” in your stock`); continue; }
        setLevel(it, a.level);
        done.push(it.qty === a.level ? `${it.name}: ${qtyText(it)} left` : `${it.name}: ${fmt(a.level)} left in the open ${it.unit || 'one'} · ${qtyText(it)} in all`);
        break;
      }
      case 'out':
        if (!it) create(0);
        it.qty = 0;
        done.push(`${it.name} → out, added to shopping list`);
        break;
      case 'need': {
        if (!it) create(0);
        it.need = true;
        ui.bought.delete(it.id);
        listed.push(it);
        // Asked for from a store's list: belongs to that store unless already tied to another.
        const sel = shopStore();
        if (!a.store && ui.view === 'shop' && sel !== 'all' && !it.store) it.store = sel;
        const store = a.store || it.store;
        done.push(`🛒 ${it.name} added to the ${store ? `${store} ` : 'shopping '}list`);
        break;
      }
      case 'restock': {
        // "Move tomatoes from the list to the pantry": same as ticking it off in the Shop tab,
        // then filed where you said. Not on the list? Then it's just moving where it's kept.
        const listed = state.items.filter(isLow);
        if (!it || !isLow(it)) it = matchExact(a.name, listed)?.item || matchItem(a.name, listed)?.item || it;
        if (!it) { problems.push(`Couldn't find “${a.name}” on the list or in stock`); continue; }
        if (isLow(it)) {
          ui.bought.set(it.id, { qty: it.qty, need: it.need, listOnly: it.listOnly, location: it.location, useBy: it.useBy, spots: it.spots && { ...it.spots } });
          const qtyBefore = it.qty;
          const bought = a.qty != null ? a.qty : Math.max(it.scanQty || 1, (it.low ?? 0) + 1 - it.qty);
          // Still have some in the main place? Then what you bought goes to the place you named.
          if (a.location && a.location !== it.location && qtyBefore > 0) adjustAt(it, a.location, bought);
          else {
            if (a.location) it.location = a.location;
            it.qty = round(it.qty + bought);
          }
          it.need = false;
          freshUseBy(it, qtyBefore);
          done.push(`✓ ${it.name} bought · ${qtyText(it)}${it.spots ? ' in all' : ` in the ${it.location.toLowerCase()}`}`);
        } else if (a.location && a.location !== it.location) {
          // Moving it all: other places merge into the new one.
          it.location = a.location;
          delete it.spots;
          done.push(`${it.name} moved to the ${it.location.toLowerCase()}`);
        } else {
          problems.push(`${it.name} isn't on the shopping list${a.location ? ` and is already in the ${a.location.toLowerCase()}` : ''}`);
          continue;
        }
        ui.flash = it.id;
        break;
      }
      case 'unlist':
        if (!it || !isLow(it)) { problems.push(`“${a.name}” isn't on the shopping list`); continue; }
        unlist(it);
        done.push(`Took ${it.name} off the shopping list`);
        continue;
    }
    if (a.unit && !it.unit) it.unit = a.unit;
    if (a.store) {
      it.store = a.store;
      if (!prefs.stores.includes(a.store)) {
        prefs.stores.push(a.store);
        savePrefs();
      }
    }
    it.updated = Date.now();
  }
  listed.forEach(revealOnList);
  if (done.length) save();
  else undoStack.pop();
  return { done, problems, answers };
}

// Use-by set by hand or by voice; remembered as how long this item usually lasts.
function setUseBy(it, useBy) {
  it.useBy = useBy;
  delete it.noUseBy;
  const days = Math.round((new Date(useBy + 'T00:00') - new Date(todayIso() + 'T00:00')) / 864e5);
  if (days >= 1 && days <= 120 && !it.opened) it.shelfLife = days;
}

// Opening starts the clock: things like milk or salsa only last so long once open.
function markOpened(it, date = todayIso()) {
  it.opened = date;
  const days = openLife(it.name);
  if (!days) return null;
  const by = isoDate(new Date(new Date(date + 'T00:00').getTime() + days * 864e5));
  if (!it.useBy || by < it.useBy) it.useBy = by;
  return days;
}

// "Half a bottle left": the open one is part used; any unopened ones stay whole.
function setLevel(it, level) {
  const main = countAt(it, it.location);
  const whole = main % 1 ? Math.floor(main) : Math.max(0, main - 1);
  adjustAt(it, it.location, round(whole + level - main));
  if (!it.opened) markOpened(it);
}

function answerFor(a) {
  const it = a.item;
  if (!it) return `You're not tracking ${a.name} yet.`;
  const have = placesOf(it).filter((pl) => countAt(it, pl) > 0);
  const where = have.length > 1
    ? `: ${have.map((pl) => `${fmt(countAt(it, pl))} in the ${pl.toLowerCase()}`).join(' and ')}`
    : ` in the ${(have[0] || it.location).toLowerCase()}`;
  const list = isLow(it) ? ' It’s on the shopping list.' : '';
  if (it.qty <= 0) return `You're out of ${it.name.toLowerCase()}.${list}`;
  const amount = it.unit ? `${fmt(it.qty)} ${pluralUnit(it.unit, it.qty)} of ${it.name.toLowerCase()}` : `${fmt(it.qty)} ${it.name.toLowerCase()}`;
  return `You have ${amount}${where}.${list}`;
}

// Speech engines give a few guesses; use the one that matches the most things you own.
function runCommand(texts) {
  const locations = allLocations();
  let best = null;
  for (const t of texts) {
    const r = resolveActions(parseCommand(t, { locations, stores: allStores(), listContext: ui.view === 'shop' && !ui.editor }), state.items);
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

const UNIT_CHOICES = ['', 'can', 'box', 'bottle', 'bag', 'jar', 'roll', 'pack'];

// A compact dropdown with a "new…" choice at the end, which asks for a name.
function selectPicker(field, options, current, { label, other, text = (v) => v } = {}) {
  const opts = options.includes(current) ? options : [...options, current];
  return `<select name="${field}" aria-label="${esc(label)}" data-prev="${esc(current)}" data-ask="${esc(other.ask)}">${opts
    .map((v) => `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(text(v))}</option>`)
    .join('')}<option value="__new">${esc(other.label)}</option></select>`;
}

const locationPicker = (current) =>
  selectPicker('location', allLocations(), current, { label: 'Kept in', other: { label: '+ New place…', ask: 'Name the new place (e.g. Basement, Laundry room)' } });

const storePicker = (current) =>
  selectPicker('store', ['', ...allStores()], current, { label: 'Buy at', text: (v) => v || 'Any store', other: { label: '+ New store…', ask: 'Store name (e.g. Costco, Aldi)' } });

const unitPicker = (current) =>
  selectPicker('unit', UNIT_CHOICES, current, { label: 'Counted in', text: (v) => v || 'each', other: { label: 'Other…', ask: 'Counted in what? (e.g. tube, carton, pound)' } });

document.addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-ask]');
  if (!sel) return;
  if (sel.value === '__new') {
    let value = prompt(sel.dataset.ask)?.trim();
    if (!value) {
      sel.value = sel.dataset.prev;
      return;
    }
    const field = sel.name;
    value = field === 'unit' ? singularUnit(value) : field === 'store' ? titleCase(value) : sentenceCase(value);
    if (![...sel.options].some((o) => o.value === value)) sel.querySelector('[value="__new"]').insertAdjacentHTML('beforebegin', `<option value="${esc(value)}">${esc(value)}</option>`);
    sel.value = value;
  }
  sel.dataset.prev = sel.value;
});

// The item editor is an ordinary page rather than an overlay: on iPhone, text fields inside
// fixed panels end up behind the keyboard, while on a normal page Safari scrolls them into view.
// Resolves with { item, note } when saved, or null when cancelled.
function openEditor(item, opts = {}) {
  return new Promise((resolve) => {
    if (ui.editor) ui.editor.resolve(null);
    ui.editor = { item, ...opts, resolve, scrollY: window.scrollY };
    $('#toast').hidden = true; // a message from before would sit over the page's buttons
    render();
    $('#main').innerHTML = renderEditor();
    window.scrollTo(0, 0);
  });
}

function closeEditor(saved = null) {
  const ed = ui.editor;
  if (!ed) return;
  ui.editor = null;
  document.activeElement?.blur?.();
  render();
  window.scrollTo(0, ed.fromScan ? 0 : ed.scrollY);
  ed.resolve(saved);
}

const photoTile = (image, item) =>
  image ? `<img src="${esc(image)}" alt="">` : `<span class="emoji">${guessEmoji(item.name, item.location)}</span><span class="cam">📷</span>`;
const photoButtons = (has) =>
  `<button type="button" class="link" data-edit="photo">${has ? 'Change photo' : 'Add photo'}</button>${has ? '<button type="button" class="link quiet" data-edit="nophoto">Remove</button>' : ''}`;

// Take or choose a picture (iOS offers camera or library) and shrink it to a small square
// thumbnail, so photos don't fill up the browser's storage.
function pickPhoto() {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
    input.addEventListener('change', () => resolve(input.files?.[0] || null), { once: true });
    input.click();
  });
}

async function shrinkPhoto(file, size = 192) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const c = Object.assign(document.createElement('canvas'), { width: size, height: size });
    c.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size);
    return c.toDataURL('image/jpeg', 0.72);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function showEditorPhoto(form) {
  const ed = ui.editor;
  const image = ed.photo !== undefined ? ed.photo : ed.item.image;
  const preview = { ...ed.item, name: form.name.value || ed.item.name, location: form.location.value };
  form.querySelector('.photo-tile').innerHTML = photoTile(image, preview);
  form.querySelector('.photo-actions').innerHTML = photoButtons(Boolean(image));
}

// Other places this item is kept, each with its own count, on the item page.
function spotsHtml(main) {
  const spots = ui.editor.spots;
  const rows = Object.entries(spots)
    .map(([pl, n]) => `<div class="spot-row"><span>${esc(pl)}</span>
      <div class="stepper big"><button type="button" data-spot-step="-1" data-place="${esc(pl)}" aria-label="One less">−</button><input type="number" inputmode="decimal" min="0" step="any" data-spot="${esc(pl)}" value="${n}" aria-label="How many in ${esc(pl)}"><button type="button" data-spot-step="1" data-place="${esc(pl)}" aria-label="One more">+</button></div>
      <button type="button" class="remove" data-spot-del="${esc(pl)}" aria-label="Not kept in ${esc(pl)}"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button></div>`)
    .join('');
  const free = allLocations().filter((pl) => pl !== main && !(pl in spots));
  return `${rows ? `<span class="label">Also kept in</span>${rows}` : ''}
    ${free.length ? `<select class="add-spot" data-add-spot aria-label="Also kept in another place"><option value="">+ Also kept in another place…</option>${free.map((pl) => `<option>${esc(pl)}</option>`).join('')}</select>` : ''}`;
}

function syncSpots(form) {
  form.querySelectorAll('[data-spot]').forEach((i) => (ui.editor.spots[i.dataset.spot] = Math.max(0, parseFloat(i.value) || 0)));
}

const redrawSpots = (form) => ($('#spots', form).innerHTML = spotsHtml(form.location.value));

const LEVELS = [['', 'Full'], ['0.75', '¾'], ['0.5', '½'], ['0.25', '¼'], ['0.1', 'Almost empty']];

function renderEditor() {
  const { item, isNew, hint, similar, fromScan } = ui.editor;
  ui.editor.spots ??= { ...(item.spots || {}) };
  const lowOpts = [['', 'Never'], ...[0, 1, 2, 3, 5, 10].map((n) => [n, n === 0 ? 'When out' : `${n} left`])];
  // A part-used package shows as a whole count plus how much is left in the open one.
  const main = countAt(item, item.location);
  const frac = round(main % 1);
  const count = frac ? Math.ceil(main) : main;
  const level = frac ? LEVELS.slice(1).reduce((best, l) => (Math.abs(l[0] - frac) < Math.abs(best[0] - frac) ? l : best))[0] : '';
  const today = todayIso();
  const usual = item.shelfLife || suggestShelfLife(item.name, item.location);
  return `<form class="form editor" id="editForm" novalidate>
    <div class="page-head">
      <button type="button" class="link" data-edit="cancel">${fromScan && isNew ? 'Skip' : 'Cancel'}</button>
      <h2>${isNew ? 'New item' : 'Edit item'}</h2>
      <button type="submit" class="link strong">Save</button>
    </div>
    <div class="photo-row">
      <button type="button" class="photo-tile" data-edit="photo" aria-label="${item.image ? 'Change photo' : 'Add a photo'}">${photoTile(item.image, item)}</button>
      <div class="photo-side">
        ${hint ? `<p class="note">${esc(hint)}</p>` : ''}
        <div class="photo-actions">${photoButtons(Boolean(item.image))}</div>
      </div>
    </div>
    ${similar ? `<div class="suggest"><span>Is this your <b>${esc(similar.name)}</b>?</span>
      <button type="button" class="btn small primary" data-edit="link" data-id="${similar.id}">Yes, same thing</button></div>` : ''}
    <label>Name<input name="name" value="${esc(item.name)}" placeholder="What is it?" autocomplete="off" enterkeyhint="done"></label>
    <div class="row2">
      <label>How many
        <div class="stepper big"><button type="button" data-step="-1" aria-label="One less">−</button><input name="qty" type="number" inputmode="decimal" step="any" min="0" value="${count}" aria-label="Quantity"><button type="button" data-step="1" aria-label="One more">+</button></div>
      </label>
      <label>Counted in ${unitPicker(item.unit)}</label>
    </div>
    <div class="row2">
      <label>Kept in ${locationPicker(item.location)}</label>
      <label>Buy at ${storePicker(item.store || '')}</label>
    </div>
    <div id="spots">${spotsHtml(item.location)}</div>
    <div class="row2">
      <label>Opened
        <select name="opened">
          <option value="">Not opened</option>
          <option value="${today}" ${item.opened === today ? 'selected' : ''}>Opened today</option>
          ${item.opened && item.opened !== today ? `<option value="${item.opened}" selected>Opened ${new Date(item.opened + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</option>` : ''}
        </select>
      </label>
      <label>Left in the open one
        <select name="level">${LEVELS.map(([v, t]) => `<option value="${v}" ${v === level ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </label>
    </div>
    <label>Use by <span style="font-weight:400">(optional)</span><input name="useBy" type="date" value="${esc(item.useBy || '')}"></label>
    <div class="quick-dates">
      ${[[3, '+3 days'], [7, '1 week'], [14, '2 weeks'], [30, '1 month']].map(([d, t]) => `<button type="button" data-days="${d}">${t}</button>`).join('')}
      ${usual ? `<button type="button" data-days="${usual}" class="usual">Usually ${usual} days</button>` : ''}
      <button type="button" data-days="clear">Clear</button>
    </div>
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
    <button class="primary" type="submit">${fromScan ? 'Save & keep scanning' : isNew ? 'Add item' : 'Save'}</button>
    ${isNew ? '' : `<button type="button" class="danger" data-edit="delete">Delete item</button>
      <p class="note" style="text-align:center">Last changed ${ago(item.updated)}${item.by && syncInfo().joined ? ` by ${esc(item.by)}` : ''}</p>`}
  </form>`;
}

$('#main').addEventListener('click', (e) => {
  const form = e.target.closest('#editForm');
  if (!form || !ui.editor) return;
  const { item } = ui.editor;
  const step = e.target.closest('[data-step]');
  if (step) form.qty.value = Math.max(0, round((parseFloat(form.qty.value) || 0) + Number(step.dataset.step)));
  const act = e.target.closest('[data-edit]')?.dataset.edit;
  if (act === 'cancel') closeEditor(null);
  if (act === 'link') linkScannedTo(byId(e.target.closest('[data-id]').dataset.id));
  const days = e.target.closest('[data-days]')?.dataset.days;
  if (days) form.useBy.value = days === 'clear' ? '' : dateIn(Number(days));
  const spotStep = e.target.closest('[data-spot-step]');
  if (spotStep) {
    syncSpots(form);
    const pl = spotStep.dataset.place;
    ui.editor.spots[pl] = Math.max(0, round(ui.editor.spots[pl] + Number(spotStep.dataset.spotStep)));
    redrawSpots(form);
  }
  const spotDel = e.target.closest('[data-spot-del]')?.dataset.spotDel;
  if (spotDel) {
    syncSpots(form);
    delete ui.editor.spots[spotDel];
    redrawSpots(form);
  }
  // The new photo is kept aside until Save, so Cancel throws it away.
  if (act === 'photo') {
    pickPhoto().then(async (file) => {
      if (!file || !ui.editor) return;
      try {
        ui.editor.photo = await shrinkPhoto(file);
        showEditorPhoto(form);
      } catch {
        toast('Couldn’t read that picture — try another one.');
      }
    });
  }
  if (act === 'nophoto') {
    ui.editor.photo = '';
    showEditorPhoto(form);
  }
  // The emoji placeholder follows the name and place as you edit them.
  if (act === 'delete' && confirm(`Delete ${item.name}?`)) {
    closeEditor(null);
    deleteItem(item);
  }
});

$('#main').addEventListener('change', (e) => {
  const form = e.target.closest('#editForm');
  if (!form || !ui.editor) return;
  if (e.target.matches('[data-add-spot]') && e.target.value) {
    syncSpots(form);
    ui.editor.spots[e.target.value] = 1;
    redrawSpots(form);
  }
  // Making another place the main one folds its count into the main count.
  if (e.target.name === 'location' && e.target.value !== '__new') {
    syncSpots(form);
    const pl = e.target.value;
    if (pl in ui.editor.spots) {
      form.qty.value = round((parseFloat(form.qty.value) || 0) + ui.editor.spots[pl]);
      delete ui.editor.spots[pl];
    }
    redrawSpots(form);
  }
});

$('#main').addEventListener('input', (e) => {
  const form = e.target.closest('#editForm');
  if (form && ['name', 'location'].includes(e.target.name) && ui.editor && ui.editor.photo === undefined && !ui.editor.item.image) showEditorPhoto(form);
});

$('#main').addEventListener('submit', (e) => {
  const form = e.target;
  if (form.id !== 'editForm' || !ui.editor) return;
  e.preventDefault();
  const { item, isNew, fromScan } = ui.editor;
  const name = form.name.value.trim();
  if (!name) {
    form.name.focus();
    form.name.placeholder = 'Give it a name first';
    return;
  }
  checkpoint();
  const qtyBefore = item.qty;
  const { opened: openedBefore, useBy: useByBefore } = item;
  syncSpots(form);
  const count = Math.max(0, parseFloat(form.qty.value) || 0);
  const level = parseFloat(form.level.value) || 0;
  const main = level ? round(Math.max(0, Math.ceil(count) - 1) + level) : count;
  const spots = Object.fromEntries(Object.entries(ui.editor.spots).filter(([pl, n]) => n > 0 && pl !== form.location.value));
  Object.assign(item, {
    name: sentenceCase(name),
    qty: round(main + Object.values(spots).reduce((a, b) => a + b, 0)),
    unit: singularUnit(form.unit.value),
    location: form.location.value,
    store: form.store.value,
    low: form.low.value === '' ? null : Number(form.low.value),
    scanQty: Math.max(1, parseInt(form.scanQty.value, 10) || 1),
    brand: form.brand.value.trim(),
    barcode: normCode(form.barcode.value),
    updated: Date.now(),
  });
  if (ui.editor.photo !== undefined) item.image = ui.editor.photo;
  if (Object.keys(spots).length) item.spots = spots;
  else delete item.spots;
  if (form.useBy.value !== (useByBefore || '')) {
    if (form.useBy.value) setUseBy(item, form.useBy.value);
    else {
      item.useBy = '';
      item.noUseBy = true; // cleared on purpose: don't fill it in again on the next purchase
    }
  }
  if (!form.opened.value) delete item.opened;
  else if (form.opened.value !== openedBefore) markOpened(item, form.opened.value);
  for (const pl of placesOf(item)) if (!prefs.places.includes(pl)) prefs.places.push(pl);
  savePrefs();
  // Restocking clears a list request; just editing other details doesn't.
  if (item.qty > qtyBefore && item.qty > (item.low ?? -1)) item.need = false;
  if (item.store && !prefs.stores.includes(item.store)) {
    prefs.stores.push(item.store);
    savePrefs();
  }
  if (isNew) state.items.push(item);
  // Someone else's change may have replaced this item while the page was open; this save wins.
  else if (byId(item.id) !== item) state.items = byId(item.id) ? state.items.map((i) => (i.id === item.id ? item : i)) : [...state.items, item];
  ui.flash = item.id;
  save();
  closeEditor({ item, note: isNew ? `New · ${qtyText(item)}` : 'Saved' });
  if (!fromScan) toast(isNew ? `Added ${item.name}` : 'Saved', { undo: true });
});

function openMenu() {
  openSheet(`
    <div class="sheet-head"><h2>Options</h2><button class="link" data-close>Done</button></div>
    <div class="menu">
      <button data-menu="add">Add an item by hand</button>
      <button data-menu="paste">Paste a list</button>
      <button data-menu="places">Places</button>
      <button data-menu="stores">Stores</button>
      <button data-menu="household">Household sharing${syncInfo().joined ? ' · On' : ''}</button>
      <button data-menu="siri">Set up “Hey Siri, Key Record”</button>
      <button data-menu="badge">Use-soon count on app icon: ${prefs.badge ? 'On' : 'Off'}</button>
      <button data-menu="recipe">Copy kitchen list for recipe ideas</button>
      <button data-menu="sound">Scan beep: ${prefs.sound ? 'On' : 'Off'}</button>
      <button data-menu="export">Back up to a file</button>
      <button data-menu="import">Restore from a backup file</button>
      <button data-menu="sample">Load sample items</button>
      <button data-menu="erase" class="danger">Erase everything</button>
    </div>
    <p class="note" style="text-align:center">Key Record version ${esc(APP_VERSION)}</p>`);
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

// iPhone shows a home-screen icon count only for apps allowed to send notifications.
async function toggleBadge(button) {
  if (prefs.badge) {
    prefs.badge = false;
    navigator.clearAppBadge?.().catch(() => {});
  } else {
    if (!('setAppBadge' in navigator)) return toast('Add Key Record to your Home Screen first (Share → Add to Home Screen), then turn this on from there.');
    const allowed = window.Notification ? await Notification.requestPermission() : 'granted';
    if (allowed !== 'granted') return toast('The iPhone only shows the count when notifications are allowed for Key Record.');
    prefs.badge = true;
  }
  savePrefs();
  updateBadge();
  button.textContent = `Use-soon count on app icon: ${prefs.badge ? 'On' : 'Off'}`;
}

function openPlaces() {
  const places = allLocations();
  const count = (pl) => state.items.filter((i) => placesOf(i).includes(pl)).length;
  openSheet(`
    <div class="sheet-head"><h2>Places</h2><button class="link" data-close>Done</button></div>
    <p class="note">Where things are kept. Add spots like “Garage shelf 2”, tap a name to rename it, and use the arrows to change the order.</p>
    <ul class="list" style="margin-top:12px">${places
      .map((pl, i) => `<li class="item place-row">
        <button class="info" data-place-rename="${esc(pl)}"><div class="name">${esc(pl)}</div><div class="meta">${count(pl)} item${count(pl) === 1 ? '' : 's'}</div></button>
        <button class="icon-btn" data-place-move="-1" data-place="${esc(pl)}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(pl)} up">↑</button>
        <button class="icon-btn" data-place-move="1" data-place="${esc(pl)}" ${i === places.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(pl)} down">↓</button>
        <button class="remove" data-place-del="${esc(pl)}" aria-label="Remove ${esc(pl)}"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button>
      </li>`)
      .join('')}</ul>
    <button class="add-row" data-place-add>+ Add a place</button>`);
}

// Renaming into an existing place merges the two.
function renamePlace(from, to) {
  for (const it of state.items) {
    if (it.location === from) it.location = to;
    if (it.spots && from in it.spots) {
      it.spots[to] = round((it.spots[to] || 0) + it.spots[from]);
      delete it.spots[from];
    }
  }
  prefs.places = [...new Set(allLocations().map((pl) => (pl === from ? to : pl)))];
}

function placeAction(e) {
  const t = (k) => e.target.closest(`[${k}]`);
  if (t('data-place-add')) {
    const name = sentenceCase(prompt('Name the new place (e.g. Basement, Garage shelf 2)')?.trim() || '');
    if (name && !allLocations().includes(name)) {
      prefs.places = [...allLocations(), name];
      savePrefs();
    }
    return openPlaces();
  }
  const rename = t('data-place-rename')?.dataset.placeRename;
  if (rename) {
    const to = sentenceCase(prompt(`Rename “${rename}” to:`, rename)?.trim() || '');
    if (!to || to === rename) return;
    if (allLocations().includes(to) && !confirm(`${to} already exists. Put everything from ${rename} there?`)) return;
    checkpoint();
    renamePlace(rename, to);
  }
  const move = t('data-place-move');
  if (move) {
    const places = allLocations();
    const i = places.indexOf(move.dataset.place);
    const j = i + Number(move.dataset.placeMove);
    [places[i], places[j]] = [places[j], places[i]];
    prefs.places = places;
  }
  const del = t('data-place-del')?.dataset.placeDel;
  if (del) {
    const others = allLocations().filter((pl) => pl !== del);
    if (!others.length) return toast('Keep at least one place.');
    const n = state.items.filter((i) => placesOf(i).includes(del)).length;
    if (n && !confirm(`Move the ${n} item${n === 1 ? '' : 's'} in ${del} to ${others[0]}?`)) return;
    checkpoint();
    renamePlace(del, others[0]);
    prefs.places = prefs.places.filter((pl) => pl !== del);
  }
  savePrefs();
  save();
  openPlaces();
}

// Paste a list: Notes, a text, or receipt text copied with Live Text → many items at once.
function openPaste() {
  ui.paste = { target: ui.view === 'shop' ? 'list' : 'stock' };
  render();
  scrollTo(0, 0);
}

function closePaste() {
  ui.paste = null;
  render();
}

function renderPaste() {
  return `<form class="form editor" id="pasteForm" novalidate>
    <div class="page-head">
      <button type="button" class="link" data-paste="cancel">Cancel</button>
      <h2>Paste a list</h2>
      <button type="submit" class="link strong">Add</button>
    </div>
    <p class="note" style="margin-top:14px">One thing per line, like “2 cans of tomatoes”. Lists from Notes or texts work, and so do receipts: open a photo of the receipt, press and hold its text, tap Select All, then Copy, and paste it here.</p>
    <label>Add to
      <select name="target">
        <option value="stock" ${ui.paste.target === 'stock' ? 'selected' : ''}>My stock — I have these</option>
        <option value="list" ${ui.paste.target === 'list' ? 'selected' : ''}>Shopping list — I need these</option>
      </select>
    </label>
    <label>List<textarea name="text" rows="6" placeholder="Milk&#10;2 cans of tomatoes&#10;Paper towels"></textarea></label>
    <div id="pastePreview"></div>
    <button class="primary" type="submit">Add items</button>
  </form>`;
}

function showPastePreview(form) {
  const rows = parseListLines(form.text.value);
  $('#pastePreview', form).innerHTML = rows.length
    ? `<span class="label">${rows.length} item${rows.length === 1 ? '' : 's'} — fix any names before adding</span>
      ${rows.map((r) => `<div class="paste-row">
        <input name="pq" type="number" inputmode="decimal" min="0" step="any" value="${r.qty}" aria-label="How many">
        <input name="pn" value="${esc(sentenceCase(r.name))}" data-unit="${esc(r.unit)}" aria-label="Name" autocomplete="off">
        <button type="button" class="remove" data-paste-drop aria-label="Leave this one out"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button>
      </div>`).join('')}`
    : '';
}

function addPasted(form) {
  const rows = [...form.querySelectorAll('.paste-row')].map((r) => ({
    name: r.querySelector('[name=pn]').value.trim(),
    qty: Math.max(0, parseFloat(r.querySelector('[name=pq]').value) || 1),
    unit: r.querySelector('[name=pn]').dataset.unit || '',
  })).filter((r) => r.name);
  if (!rows.length) return form.text.focus();
  const toList = form.target.value === 'list';
  checkpoint();
  for (const { name, qty, unit } of rows) {
    // The list uses your exact words; stock finds what you already have, like voice does.
    let it = (toList ? matchExact(name, state.items) : matchItem(name, state.items))?.item;
    if (!it) {
      it = newItem({ name: sentenceCase(name), qty: 0, unit, location: guessLocation(name), listOnly: toList });
      state.items.push(it);
    }
    if (toList) {
      it.need = true;
      ui.bought.delete(it.id);
      revealOnList(it);
    } else {
      const qtyBefore = it.qty;
      it.qty = round(it.qty + qty);
      it.need = false;
      if (unit && !it.unit) it.unit = unit;
      freshUseBy(it, qtyBefore);
    }
    it.updated = Date.now();
  }
  ui.paste = null;
  ui.view = toList ? 'shop' : 'stock';
  save();
  scrollTo(0, 0);
  toast(`Added ${rows.length} item${rows.length === 1 ? '' : 's'} to ${toList ? 'the shopping list' : 'your stock'}`, { undo: true });
}

$('#main').addEventListener('input', (e) => {
  if (e.target.name === 'text' && e.target.closest('#pasteForm')) showPastePreview(e.target.form);
});
$('#main').addEventListener('click', (e) => {
  if (!e.target.closest('#pasteForm')) return;
  if (e.target.closest('[data-paste="cancel"]')) closePaste();
  e.target.closest('[data-paste-drop]')?.closest('.paste-row').remove();
});
$('#main').addEventListener('submit', (e) => {
  if (e.target.id !== 'pasteForm') return;
  e.preventDefault();
  addPasted(e.target);
});

// ---------- Household sharing ----------

const SYNC_WORDS = { synced: 'Up to date', connecting: 'Connecting…', offline: 'Offline — changes will sync when you’re back online', off: '' };

function openHousehold() {
  const info = syncInfo();
  let body;
  if (!info.configured) {
    body = '<p class="note">Household sharing isn’t connected to its cloud database yet.</p>';
  } else if (!info.joined) {
    body = `<p class="note">Share one stock and shopping list with everyone in your home. Changes show up on every phone within a second or two, and work offline too.</p>
      <div class="row-actions"><button class="btn" data-hh="join">Join with a code</button><button class="btn primary" data-hh="create">Start a household</button></div>`;
  } else {
    body = `<p class="note">${info.members.length ? `Shared with ${info.members.map(esc).join(', ')}.` : 'Shared household.'} ${esc(SYNC_WORDS[info.status] || '')}</p>
      <div class="card hh-code"><span class="label">Household code</span><b>${esc(info.code)}</b>
        <p>Others join from ⋯ → Household sharing → Join with a code. Keep it somewhere safe; anyone with it can join.</p>
        <button class="btn small" data-hh="copy">Copy code</button></div>
      <button class="danger" data-hh="leave">Leave household</button>`;
  }
  openSheet(`<div class="sheet-head"><h2>Household sharing</h2><button class="link" data-close>Done</button></div>${body}`);
}

async function householdAction(act) {
  const info = syncInfo();
  try {
    if (act === 'copy') {
      await navigator.clipboard?.writeText(info.code);
      return toast('Code copied');
    }
    if (act === 'leave') {
      if (!confirm('Leave the household? This phone keeps a copy of everything but stops syncing.')) return;
      await leaveHousehold();
      toast('Left the household');
      return openHousehold();
    }
    const name = prompt('Your first name — shown to others in the household', info.name || '')?.trim();
    if (!name) return;
    if (act === 'create') {
      toast('Setting up…');
      const code = await createHousehold(name);
      toast(`Household started. Code: ${code}`);
    } else {
      const code = prompt('Household code (8 letters and numbers)')?.trim();
      if (!code) return;
      const keepMine = state.items.length ? confirm(`Also add the ${state.items.length} items on this phone to the household? Cancel to use only the household’s items.`) : false;
      toast('Joining…');
      await joinHousehold(code, name, keepMine);
      toast('Joined — you’re now sharing');
    }
    render();
    openHousehold();
  } catch (err) {
    toast(err.message || 'Couldn’t reach the household — check your connection.');
  }
}

function persistOnly() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
}

// ---------- Hey Siri ----------
//
// A one-time iPhone Shortcut dictates what you say and opens this page with ?say=…;
// the app then applies it like a typed command. Shortcuts open links in Safari, which keeps
// its own data, so Safari joins the household once and everything stays in step.

function openSiriSetup() {
  const link = `${location.origin}${location.pathname}?say=`;
  openSheet(`
    <div class="sheet-head"><h2>Hey Siri, Key Record</h2><button class="link" data-close>Done</button></div>
    <ol class="steps">
      <li>Open the <b>Shortcuts</b> app and tap <b>+</b>.</li>
      <li>Add the action <b>Dictate Text</b>.</li>
      <li>Add <b>URL Encode</b> (it uses the Dictated Text).</li>
      <li>Add <b>Open URLs</b>. For the URL, paste the link below, then tap at its end and insert <b>URL Encoded Text</b>.</li>
      <li>Rename the shortcut <b>Key Record</b>.</li>
    </ol>
    <pre class="share-preview">${esc(link)}</pre>
    <div class="row-actions"><button class="btn primary" data-siri="copy">Copy link</button></div>
    <p class="note">Then say “Hey Siri, Key Record” and speak, e.g. “used two cans of tomatoes”. It opens in Safari, so first open Key Record in Safari once and join your household there (⋯ → Household sharing) so both stay in step.</p>`);
}

// Run a command passed in the link by the Siri shortcut.
function runFromLink() {
  const said = new URLSearchParams(location.search).get('say');
  if (!said) return;
  history.replaceState(null, '', location.pathname);
  openVoice();
  $('#heard').textContent = `“${said}”`;
  handleCommand([said], false);
}

function openStores() {
  const count = (st) => state.items.filter((i) => i.store === st).length;
  openSheet(`
    <div class="sheet-head"><h2>Stores</h2><button class="link" data-close>Done</button></div>
    <p class="note">Tag items with where you buy them on the item’s page. In the store, pick it at the top of the shopping list to see just what to get there.</p>
    <ul class="list" style="margin-top:12px">${allStores()
      .map((st) => `<li class="item"><div class="info"><div class="name">${esc(st)}</div><div class="meta">${count(st)} item${count(st) === 1 ? '' : 's'}</div></div>
        <button class="remove" data-store-del="${esc(st)}" aria-label="Remove ${esc(st)}"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button></li>`)
      .join('')}</ul>
    <button class="add-row" data-store-add>+ Add a store</button>`);
}

// Plain lines, one item each, so Notes can turn them into a checklist in one tap.
function shareShoppingList() {
  const sel = shopStore();
  const title = sel === 'all' ? 'Shopping list' : `${sel} list`;
  const items = listForStore(sel).sort((a, b) => !a.store - !b.store || (a.store || '').localeCompare(b.store || '') || byPlace(a, b));
  const text = `${title}\n${items.map((it) => it.name + (sel === 'all' && it.store ? ` – ${it.store}` : '')).join('\n')}`;
  openSheet(`
    <div class="sheet-head"><h2>Share ${sel === 'all' ? 'shopping list' : `${esc(sel)} list`}</h2><button class="link" data-close>Done</button></div>
    <ol class="steps">
      <li>Tap <b>Share</b>, then <b>Notes</b>.</li>
      <li>On the Notes card, tap where it says <b>New Note</b> to choose the note you want it added to.</li>
      <li>In that note, select the items and tap the <b>checklist</b> button (circle with a check mark) to make them checkable.</li>
    </ol>
    <pre class="share-preview">${esc(text)}</pre>
    <div class="row-actions"><button class="btn" data-share="copy">Copy</button><button class="btn primary" data-share="send">Share…</button></div>`);
  $('#sheet')._shareText = text;
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
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `key-record-${new Date().toISOString().slice(0, 10)}.json` });
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
    toast("That file isn't a Key Record backup");
  }
}

function loadSample() {
  checkpoint();
  const inDays = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const s = (name, qty, unit, location, extra = {}) => newItem({ name, qty, unit, location, ...extra });
  state.items.push(
    s('Paper towels', 18, 'roll', 'Pantry', { brand: 'Bounty', scanQty: 6, low: 2, store: 'Costco', spots: { Garage: 12 } }),
    s('Diced tomatoes', 4, 'can', 'Pantry'),
    s('Spaghetti', 2, 'box', 'Pantry'),
    s('Black beans', 3, 'can', 'Pantry'),
    s('Olive oil', 1, 'bottle', 'Pantry', { low: 1, store: 'Aldi' }),
    s('Rice', 1, 'bag', 'Pantry', { low: 0 }),
    s('Milk', 1, 'gallon', 'Fridge', { low: 1, useBy: inDays(3), store: 'Aldi', opened: inDays(-1) }),
    s('Eggs', 12, '', 'Fridge', { scanQty: 12, low: 4, useBy: inDays(12), store: 'Aldi' }),
    s('Cheddar cheese', 1, 'block', 'Fridge', { low: 0 }),
    s('Spinach', 1, 'bag', 'Fridge', { low: 0, useBy: inDays(1) }),
    s('Frozen peas', 2, 'bag', 'Freezer'),
    s('Toilet paper', 9, 'roll', 'Bathroom', { brand: 'Charmin', scanQty: 12, low: 4, store: 'Costco' }),
    s('Toothpaste', 1, 'tube', 'Bathroom', { low: 1 }),
    s('Shampoo', 1, 'bottle', 'Bathroom', { low: 0 }),
    s('Duct tape', 2, 'roll', 'Garage'),
    s('AA batteries', 8, '', 'Garage', { low: 4, store: 'Costco' }),
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
      <div class="sheet-head"><h2>${ui.view === 'shop' ? 'What do you need?' : 'Say what changed'}</h2><button class="link" data-close>Done</button></div>
      <button id="micBtn" class="mic" aria-label="Start or stop listening" aria-pressed="false" ${SR ? '' : 'disabled'}>
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
        <button type="button">Add coffee to the shopping list</button><button type="button">Take coffee off the list</button><button type="button">Add eggs to the Costco list</button><button type="button">Move tomatoes from the list to the pantry</button><button type="button">Milk expires Friday</button><button type="button">Opened the salsa</button><button type="button">Half a bottle of olive oil left</button><button type="button">Put 6 rolls of paper towels in the garage</button>
      </div>
    </div>`, () => {
    stopListening();
    window.speechSynthesis?.cancel();
  });
}

// iPhone Safari often keeps listening (and keeps the orange mic dot on) until the page
// explicitly stops recognition, and may never mark a result final. So: stop after a short
// pause in speech or 12s at most, use the last thing heard if nothing came back final, and
// always abort at the end so the microphone is released.
function startListening() {
  if (!SR) return;
  stopListening();
  window.speechSynthesis?.cancel();
  audioCtx?.suspend().catch(() => {});
  const r = new SR();
  r.lang = navigator.language || 'en-US';
  r.continuous = false;
  r.interimResults = true;
  r.maxAlternatives = 3;
  let latest = null;
  let finals = null;
  let done = false;
  let silenceTimer = 0;
  let endTimer = 0;
  const capTimer = setTimeout(() => session.stop(), 12000);

  const release = () => {
    clearTimeout(silenceTimer);
    clearTimeout(endTimer);
    clearTimeout(capTimer);
    r.onresult = r.onerror = r.onend = null;
    try { r.abort(); } catch {}
    if (rec === session) rec = null;
    setMicUi(false);
  };
  const finish = () => {
    if (done) return;
    done = true;
    release();
    const texts = finals || latest;
    if (texts) handleCommand(texts, true);
  };
  const session = {
    // Wrap up: ask for the final result, but don't wait long for Safari to deliver it.
    stop() {
      clearTimeout(silenceTimer);
      try { r.stop(); } catch {}
      clearTimeout(endTimer);
      endTimer = setTimeout(finish, 1200);
    },
    // Abandon without acting on what was heard (typing, closing, leaving the app).
    cancel() {
      done = true;
      release();
    },
  };
  rec = session;

  r.onresult = (e) => {
    const results = Array.from(e.results);
    const head = results.slice(0, -1).map((x) => x[0].transcript).join(' ');
    const last = results.at(-1);
    $('#heard').textContent = `“${(head + ' ' + last[0].transcript).trim()}”`;
    latest = Array.from(last).map((alt) => (head + ' ' + alt.transcript).trim());
    if (last.isFinal) {
      finals = latest;
      session.stop();
    } else {
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => session.stop(), 1500);
    }
  };
  r.onerror = (e) => {
    if (e.error === 'aborted') return;
    const heard = $('#heard');
    if (heard) {
      heard.textContent =
        e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'Microphone access is blocked — you can type instead.'
        : e.error === 'no-speech' ? 'Didn’t hear anything. Tap the mic to try again.'
        : `Couldn’t listen (${e.error}). You can type instead.`;
    }
    latest = finals = null;
    session.cancel();
  };
  r.onend = finish;

  setMicUi(true);
  $('#heard').textContent = 'Listening… tap the mic to stop';
  try {
    r.start();
  } catch {
    session.cancel();
  }
}

function stopListening() {
  rec?.cancel();
}

function setMicUi(on) {
  const mic = $('#micBtn');
  if (!mic) return;
  mic.classList.toggle('live', on);
  mic.setAttribute('aria-pressed', String(on));
  const heard = $('#heard');
  if (!on && heard?.textContent.startsWith('Listening')) heard.textContent = 'Tap the mic and talk';
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
  $('#typeCodeBtn').classList.remove('prominent');
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
  cam.hasCamera = true;
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
  audioCtx?.suspend().catch(() => {});
  $('#scanner').hidden = true;
  $('#scanCard').innerHTML = '';
  document.body.style.overflow = '';
  render();
}

function showManual() {
  $('#typeCodeBtn').classList.add('prominent');
}

// The system prompt handles the keyboard better than a field inside the camera screen.
function typeBarcode() {
  const code = normCode(prompt('Type the barcode number') || '');
  if (!code) return;
  cam.lastCode = code;
  cam.lastSeen = performance.now();
  handleCode(code);
}

async function handleCode(code) {
  scanFeedback();
  const item = findByCode(code);
  if (prefs.scanMode === 'check') return showCheckCard(item, code);
  if (!item) return quickAdd(code);
  checkpoint();
  let delta;
  if (prefs.scanMode === 'add') {
    const qtyBefore = item.qty;
    item.qty = round(item.qty + (item.scanQty || 1));
    freshUseBy(item, qtyBefore);
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
    <div class="result"><div class="thumb" aria-hidden="true">🔎</div>
      <div class="info"><div class="name">Looking it up…</div><div class="skeleton" style="margin-top:8px;width:70%"></div></div></div>
    <div class="result-actions"><button class="btn" data-scan="cancel">Cancel</button></div>`;
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
  const hint = info
    ? `Found: ${[info.brand, /[a-z]/i.test(info.size) ? info.size : ''].filter(Boolean).join(' · ') || info.name}. Check it and save.`
    : 'Not found online — give it a name once and it’s remembered from now on.';
  $('#scanCard').innerHTML = '';
  editFromScanner(draft, { isNew: true, hint, similar: findSimilar(info), pack });
}

// Step out of the camera to a full editing page; Save or Cancel brings you back to scanning.
async function editFromScanner(item, opts = {}) {
  pauseScanning();
  $('#scanner').hidden = true;
  document.body.style.overflow = '';
  const saved = await openEditor(item, { ...opts, fromScan: true });
  $('#scanner').hidden = false;
  document.body.style.overflow = 'hidden';
  if (!cam.stream && cam.hasCamera) startCamera().catch(() => showManual());
  if (saved) showResultCard(saved.item, saved.note, false);
  else if (!opts.isNew && byId(item.id)) showResultCard(item, '', false);
  else $('#scanCard').innerHTML = '';
  resumeScanning();
}

// "Is this your Paper towels?" — attach the scanned barcode to an item you already have.
function linkScannedTo(existing) {
  const { item: draft, pack } = ui.editor;
  checkpoint();
  existing.barcode = draft.barcode;
  existing.brand ||= draft.brand;
  existing.image ||= draft.image;
  if (pack && (existing.scanQty || 1) === 1) {
    existing.scanQty = pack.count;
    existing.unit ||= pack.unit;
  }
  let note = 'Barcode linked';
  if (prefs.scanMode === 'add') {
    const qtyBefore = existing.qty;
    existing.qty = round(existing.qty + (existing.scanQty || 1));
    freshUseBy(existing, qtyBefore);
    existing.need = false;
    note = `+${fmt(existing.scanQty || 1)} added · barcode linked`;
  } else if (prefs.scanMode === 'use') {
    existing.qty = round(Math.max(0, existing.qty - 1));
    note = '−1 used · barcode linked';
  }
  existing.updated = Date.now();
  save();
  closeEditor({ item: existing, note });
}

$('#scanCard').addEventListener('click', (e) => {
  const act = e.target.closest('[data-scan]')?.dataset.scan;
  if (!act) return;
  const it = byId($('#scanCard [data-id]')?.dataset.id);
  if (act === 'cancel') {
    lookupToken++;
    $('#scanCard').innerHTML = '';
    resumeScanning();
  } else if (act === 'undo') {
    undo();
    $('#scanCard').innerHTML = '';
    cam.lastCode = '';
  } else if (act === 'inc' || act === 'dec') {
    bump(it, act === 'inc' ? 1 : -1);
    showResultCard(it, '', false);
  } else if (act === 'edit') {
    editFromScanner(it);
  } else if (act === 'list') {
    checkpoint();
    it.need = !it.need;
    save();
    showCheckCard(it, it.barcode);
  } else if (act === 'new') {
    quickAdd(e.target.closest('[data-code]').dataset.code);
  }
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
  const storeChip = e.target.closest('[data-shop-store]');
  if (storeChip) {
    ui.shopStore = storeChip.dataset.shopStore;
    return render();
  }
  const btn = e.target.closest('[data-act]');
  if (!btn || Date.now() - lastSwipeAt < 400) return;
  const item = byId(btn.closest('[data-id]')?.dataset.id);
  switch (btn.dataset.act) {
    case 'inc': return bump(item, 1, btn.dataset.place || null);
    case 'dec': return bump(item, -1, btn.dataset.place || null);
    case 'paste': return openPaste();
    case 'edit': return openEditor(item);
    case 'got': return markBought(item);
    case 'unlist': return removeFromList(item);
    case 'pick-store': return openStorePicker(item);
    case 'unbuy': return unmarkBought(item);
    case 'add': return openEditor(newItem({ location: KITCHEN.includes(ui.loc) || DEFAULT_LOCATIONS.includes(ui.loc) ? ui.loc : 'Pantry', qty: 1 }), { isNew: true });
    case 'add-named': {
      const name = sentenceCase(ui.q.trim());
      return openEditor(newItem({ name, qty: 1, location: guessLocation(name) }), { isNew: true });
    }
    case 'sample': return loadSample();
    case 'share-list': return shareShoppingList();
    case 'go-shop':
      ui.view = 'shop';
      render();
      return scrollTo(0, 0);
    case 'recipe': return shareKitchen();
  }
});

// Press and hold a shopping-list row to pick it up, then drop it on a store in the tray that
// appears at the bottom. Moving before the hold completes is a normal scroll or swipe.
let drag = null;
const HOLD_MS = 350;

$('#main').addEventListener('pointerdown', (e) => {
  const row = e.target.closest('.shop-list .swipe-row.swipeable');
  if (!row || e.button > 0) return;
  drag = { row, id: e.pointerId, x: e.clientX, y: e.clientY, active: false, timer: setTimeout(startDrag, HOLD_MS) };
});

function startDrag() {
  if (!drag) return;
  swipe = null;
  const { row } = drag;
  const item = row.querySelector('.item');
  item.style.transform = '';
  const rect = item.getBoundingClientRect();
  drag.active = true;
  drag.offX = drag.x - rect.left;
  drag.offY = drag.y - rect.top;
  drag.ghost = item.cloneNode(true);
  drag.ghost.classList.add('drag-ghost');
  drag.ghost.style.width = `${rect.width}px`;
  document.body.append(drag.ghost);
  moveGhost(drag.x, drag.y);
  row.classList.add('drag-src');
  try { row.setPointerCapture(drag.id); } catch {}
  const tray = $('#dropTray');
  tray.innerHTML = `<p>Drop on a store</p>${storeChoices(byId(row.dataset.id), 'data-drop-store')}`;
  tray.hidden = false;
  buzz(25);
}

function moveGhost(x, y) {
  // Float the item just above the finger so the store under it stays visible.
  drag.ghost.style.transform = `translate(${x - drag.offX}px, ${y - drag.offY - 44}px) scale(.9) rotate(-1.5deg)`;
}

const dropTargetAt = (x, y) => document.elementFromPoint(x, y)?.closest('[data-drop-store]');

function endDrag() {
  if (!drag) return;
  clearTimeout(drag.timer);
  drag.ghost?.remove();
  drag.row.classList.remove('drag-src');
  $('#dropTray').hidden = true;
  $('#dropTray').innerHTML = '';
  drag = null;
}

$('#main').addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8) endDrag();
    return;
  }
  moveGhost(e.clientX, e.clientY);
  const over = dropTargetAt(e.clientX, e.clientY);
  document.querySelectorAll('#dropTray .over').forEach((b) => b !== over && b.classList.remove('over'));
  over?.classList.add('over');
});

$('#main').addEventListener('pointerup', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.active) return endDrag();
  const target = dropTargetAt(e.clientX, e.clientY);
  const it = byId(drag.row.dataset.id);
  endDrag();
  lastSwipeAt = Date.now();
  if (target) assignStore(it, target.dataset.dropStore);
});

$('#main').addEventListener('pointercancel', (e) => {
  if (drag && e.pointerId === drag.id) endDrag();
});

// While dragging, the page must not scroll under your finger.
document.addEventListener('touchmove', (e) => drag?.active && e.preventDefault(), { passive: false });
$('#main').addEventListener('contextmenu', (e) => e.target.closest('.shop-list') && e.preventDefault());

// Swipe rows sideways. Stock: right puts it on the shopping list (or takes it off), left
// deletes it. Shopping list: left takes it off the list. The row only follows the finger once
// the gesture is clearly sideways, so scrolling still works normally.
let swipe = null;
let lastSwipeAt = 0;
const SWIPE_ACT = 90;

$('#main').addEventListener('pointerdown', (e) => {
  const row = e.target.closest('.swipe-row.swipeable');
  if (!row || e.pointerType === 'mouse' || e.button > 0) return;
  swipe = { row, item: row.querySelector('.item'), id: e.pointerId, x: e.clientX, y: e.clientY, dx: 0, dir: null, active: false };
});

$('#main').addEventListener('pointermove', (e) => {
  if (!swipe || e.pointerId !== swipe.id || drag?.active) return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  if (!swipe.active) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) return (swipe = null);
    if (Math.abs(dx) < 12) return;
    const dir = dx < 0 ? 'left' : 'right';
    if (!swipe.row.dataset[dir === 'left' ? 'swipeLeft' : 'swipeRight']) return (swipe = null);
    swipe.active = true;
    swipe.dir = dir;
    swipe.row.classList.add(`going-${dir}`);
    try { swipe.row.setPointerCapture(e.pointerId); } catch {}
    swipe.item.style.transition = 'none';
  }
  swipe.dx = swipe.dir === 'left' ? Math.min(0, dx) : Math.max(0, dx);
  swipe.item.style.transform = `translateX(${swipe.dx}px)`;
  swipe.row.classList.toggle('armed', Math.abs(swipe.dx) > SWIPE_ACT);
});

function endSwipe(e) {
  if (!swipe || e.pointerId !== swipe.id) return;
  const { row, item, dx, dir, active } = swipe;
  swipe = null;
  if (!active) return;
  lastSwipeAt = Date.now();
  item.style.transition = 'transform .18s ease-out';
  const settle = () => setTimeout(() => row.classList.remove('going-left', 'going-right', 'armed'), 180);
  if (Math.abs(dx) <= SWIPE_ACT || e.type !== 'pointerup') {
    item.style.transform = '';
    return settle();
  }
  const it = byId(row.dataset.id);
  const action = row.dataset[dir === 'left' ? 'swipeLeft' : 'swipeRight'];
  if (!row.closest('.shop-list') && !prefs.stockSwipeTipSeen) {
    prefs.stockSwipeTipSeen = true;
    savePrefs();
  }
  // Actions that take the row away slide it off-screen; the others spring back.
  const leaves = action === 'delete' || (action === 'unlist' && row.closest('.shop-list'));
  if (leaves) {
    item.style.transform = `translateX(${dir === 'left' ? -110 : 110}%)`;
    setTimeout(() => (action === 'delete' ? deleteItem(it) : removeFromList(it)), 160);
  } else {
    item.style.transform = '';
    settle();
    if (action === 'tolist') putOnList(it);
    else removeFromList(it);
  }
}
$('#main').addEventListener('pointerup', endSwipe);
$('#main').addEventListener('pointercancel', endSwipe);

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
  const pick = e.target.closest('[data-assign-store]');
  if (pick) {
    const it = byId(pick.closest('[data-id]').dataset.id);
    closeSheet();
    return assignStore(it, pick.dataset.assignStore);
  }
  const hh = e.target.closest('[data-hh]')?.dataset.hh;
  if (hh) return householdAction(hh);
  if (e.target.closest('[data-siri="copy"]')) {
    navigator.clipboard?.writeText(`${location.origin}${location.pathname}?say=`).then(() => toast('Link copied'), () => {});
    return;
  }
  const share = e.target.closest('[data-share]')?.dataset.share;
  if (share) {
    const text = $('#sheet')._shareText;
    if (share === 'send' && navigator.share) navigator.share({ text }).catch(() => {});
    else navigator.clipboard?.writeText(text).then(() => toast('Copied — paste it into any note'), () => prompt('Copy this:', text));
    return;
  }
  if (e.target.closest('[data-place-add], [data-place-rename], [data-place-move], [data-place-del]')) return placeAction(e);
  if (e.target.closest('[data-store-add]')) {
    const name = titleCase(prompt('Store name (e.g. Costco, Aldi)') || '');
    if (name && !allStores().includes(name)) {
      prefs.stores.push(name);
      savePrefs();
    }
    return openStores();
  }
  const del = e.target.closest('[data-store-del]')?.dataset.storeDel;
  if (del) {
    const tagged = state.items.filter((i) => i.store === del);
    if (tagged.length && !confirm(`${del} is set on ${tagged.length} item${tagged.length === 1 ? '' : 's'}. Remove it from them?`)) return;
    checkpoint();
    tagged.forEach((i) => (i.store = ''));
    prefs.stores = prefs.stores.filter((st) => st !== del);
    if (ui.shopStore === del) ui.shopStore = 'all';
    savePrefs();
    save();
    return openStores();
  }
  const m = e.target.closest('[data-menu]')?.dataset.menu;
  if (!m) return;
  if (m === 'sound') {
    prefs.sound = !prefs.sound;
    savePrefs();
    e.target.closest('[data-menu]').textContent = `Scan beep: ${prefs.sound ? 'On' : 'Off'}`;
    return;
  }
  if (m === 'badge') return toggleBadge(e.target.closest('[data-menu]'));
  closeSheet();
  if (m === 'add') openEditor(newItem({ qty: 1 }), { isNew: true });
  if (m === 'stores') openStores();
  if (m === 'places') openPlaces();
  if (m === 'paste') openPaste();
  if (m === 'household') openHousehold();
  if (m === 'siri') openSiriSetup();
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

$('#sheet').addEventListener('focusin', (e) => {
  if (e.target.id === 'typeInput') stopListening();
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
  if (e.target.closest('#typeCodeBtn')) return typeBarcode();
  const mode = e.target.closest('[data-mode]')?.dataset.mode;
  if (mode) {
    setScanMode(mode);
    buzz(10);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#sheet').hidden) closeSheet();
  else if (ui.editor) closeEditor(null);
  else if (!$('#scanner').hidden) closeScanner();
});

// Release the camera when the app goes to the background; pick it back up on return.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopListening();
    audioCtx?.suspend().catch(() => {});
  }
  if (document.hidden && cam.stream) {
    cam.running = false;
    cam.stream?.getTracks().forEach((t) => t.stop());
    cam.stream = null;
  } else if (!document.hidden && !cam.stream && cam.hasCamera && !$('#scanner').hidden) {
    startCamera().catch(() => showManual());
  }
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

render();
// Tells the startup safety net in index.html that the app is running.
window.homestockReady = true;

// Join up with the household (if this phone is in one), then run anything Siri passed in.
Promise.race([
  initSync({
    items: () => state.items,
    setItems: (items) => {
      state.items = items;
      persistOnly();
    },
    settings: () => ({ stores: prefs.stores, places: prefs.places }),
    applySettings: (data) => {
      if (Array.isArray(data.stores)) prefs.stores = data.stores;
      if (Array.isArray(data.places)) prefs.places = data.places;
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
    },
    persist: persistOnly,
    onRemote: () => !ui.editor && !ui.paste && !drag?.active && !swipe?.active && render(),
    onStatus: () => {},
  }).catch(() => {}),
  new Promise((r) => setTimeout(r, 5000)),
]).then(runFromLink);
try { sessionStorage.removeItem('homestock.recovered'); } catch {}
