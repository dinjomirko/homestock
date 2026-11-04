import {
  parseCommand, resolveActions, matchItem, matchExact, guessLocation, guessEmoji, parsePack, parseListLines,
  suggestShelfLife, openLife, isoDate, DEFAULT_LOCATIONS,
} from './parser.js?v=41';
import {
  initSync, pushSoon, syncInfo, createHousehold, joinHousehold, leaveHousehold, authenticate, useHousehold, signOut,
  removeMember, newJoinCode, renameMe,
} from './sync.js?v=41';
import { mergeItem, slim } from './merge.js?v=41';
import {
  dinnerById, matches as dinnerMatches, shopName, seeded, dinnerPool, allocate, extendPlan, swapDinner, goingOff, PLAN_DAYS,
} from './dinners.js?v=41';

const APP_VERSION = new URL(import.meta.url).searchParams.get('v') || 'dev';
const STORAGE_KEY = 'homestock.v1';
const PREFS_KEY = 'homestock.prefs';
const KITCHEN = ['Pantry', 'Fridge', 'Freezer'];
// Rooms on the House tab: where belongings are, apart from the places stock is kept.
const DEFAULT_ROOMS = ['Kitchen', 'Living room', 'Dining room', 'Bedroom', 'Office', 'Laundry', 'Basement', 'Garage', 'Outdoors'];
// Kept in the kitchen but not for cooking: left out of Recipes.
const NOT_FOOD = /\b(paper towels?|toilet paper|tissues?|napkins?|(aluminum |tin )?foil|plastic wrap|cling film|parchment|wax paper|(trash|garbage|zip ?lock|ziploc|sandwich|freezer) bags?|dish (soap|detergent)|dishwasher|detergent|sponges?|wipes|bleach|cleaner|batter(y|ies)|light ?bulbs?|matches|candles?|filters?|nails|screws|tape)\b/i;
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

const isAsset = (r) => r?.kind === 'asset';
let state = load(STORAGE_KEY, { items: [] });
// Belongings (the House tab) are kept next to stock. One that arrived among the items, from a
// phone still on an older version, goes back with the belongings.
state.assets = [...(state.assets || []), ...state.items.filter(isAsset)];
state.items = state.items.filter((i) => !isAsset(i));
const prefs = {
  scanMode: 'add', sound: true, stores: ['Costco', 'Aldi', 'Target', 'Walmart'], places: [...DEFAULT_LOCATIONS], subPlaces: {}, folded: [], foldedSpots: [],
  rooms: [...DEFAULT_ROOMS], foldedRooms: [], ...load(PREFS_KEY, {}),
};
delete prefs.shopStore; // the store filter used to be remembered between launches; now it isn't
// shopStore: the store picked at the top of the shopping list, for this visit only.
// select: while picking several Stock items to move together, a Map of picked rows.
// hq, room: search and room filter on the House tab. assetEditor: the belonging being edited.
// cq: the ingredient search on the Recipes tab.
// dinnerOpen: which of the planned dinners show their recipe. dinnerSeen: per date, the dinners
// Swap has already offered there.
const ui = {
  view: 'stock', loc: 'All', q: '', bought: new Map(), flash: null, editor: null, paste: null, account: null, shopStore: 'all', select: null,
  hq: '', room: 'All', assetEditor: null, cq: '', dinnerOpen: new Set(), dinnerSeen: new Map(),
};
const undoStack = [];

function load(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    if (v && typeof v === 'object' && (key !== STORAGE_KEY || Array.isArray(v.items))) return v;
  } catch {}
  return fallback;
}

const writePrefs = () => {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
};
function savePrefs() {
  writePrefs();
  pushSoon(); // stores and places are shared with the household
}

// ---------- Keeping it safe ----------
// Anything that leaves the lists, by any route (deleted here or on another phone, erased,
// replaced when joining a household), waits in Recently deleted for 30 days.

const TRASH_KEY = 'homestock.trash';
const TRASH_DAYS = 30;
let trash = load(TRASH_KEY, []);
const allRecords = () => [...state.items, ...state.assets];
let known = new Set(allRecords().map((r) => r.id));
let lastRecords = new Map(allRecords().map((r) => [r.id, r]));

function writeTrash() {
  const fresh = Date.now() - TRASH_DAYS * 864e5;
  trash = trash.filter((t) => t.at > fresh).slice(0, 500);
  // Short on space: the oldest go first, then photos, rather than losing the list itself.
  for (let tries = 0; tries < 12; tries++) {
    try {
      return localStorage.setItem(TRASH_KEY, JSON.stringify(trash));
    } catch {
      if (tries < 8 && trash.length > 1) trash = trash.slice(0, Math.ceil(trash.length / 2));
      else trash = trash.map((t) => ({ ...t, item: { ...t.item, image: '', doc: '' } }));
    }
  }
}

function noteGone(why) {
  const now = new Map(allRecords().map((r) => [r.id, r]));
  const gone = [...known].filter((id) => !now.has(id)).map((id) => lastRecords.get(id)).filter(Boolean);
  // Back again (restored, or saved after someone deleted it): no longer waiting in Recently deleted.
  if ([...now.keys()].some((id) => !known.has(id)) && trash.some((t) => now.has(t.item.id))) {
    trash = trash.filter((t) => !now.has(t.item.id));
    writeTrash();
  }
  known = new Set(now.keys());
  lastRecords = now;
  if (!gone.length) return;
  const at = Date.now();
  const ids = new Set(gone.map((r) => r.id));
  trash = [...gone.map((r) => ({ item: JSON.parse(JSON.stringify(r)), at, why })), ...trash.filter((t) => !ids.has(t.item.id))];
  writeTrash();
}

let fullWarned = 0;
// Writes the lists to this phone's storage. `why` says how anything missing went (for Recently deleted).
function writeState(why = 'Deleted') {
  noteGone(why);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    if (Date.now() - fullWarned > 60000) {
      fullWarned = Date.now();
      setTimeout(() => toast('Couldn’t save — this phone’s storage for Key Record is full. Remove some photos, or back up from the ⋯ menu.'), 0);
    }
    return false;
  }
}

let persistAsked = false;
function save(why) {
  // A dismissed low-stock item comes back once its count changes; a list-only item
  // becomes a normal stock item once you actually have some.
  for (const it of state.items) {
    if (it.skipAt != null && it.qty !== it.skipAt) delete it.skipAt;
    if (it.listOnly && it.qty > 0) delete it.listOnly;
    if (it.qty <= 0) delete it.opened;
    tidySpots(it);
    tidyEach(it);
  }
  updateBadge();
  writeState(why);
  pushSoon(); // even if this phone's storage is full, the household still gets the change
  // Ask the browser not to clear this data when space runs low.
  if (!persistAsked) {
    persistAsked = true;
    navigator.storage?.persist?.().catch(() => {});
  }
  render();
}

// Snapshot before every change so any change can be undone: 'items' (stock), 'assets' (the House
// tab) or 'all'. Belongings are copied rather than written out, so every snapshot shares their
// photos instead of holding its own copy.
// Undo only takes back this phone's own changes: anything someone else changed since (it arrived
// after the snapshot) stays as they left it.
let remoteSeq = 0;
const touchedAt = new Map(); // id → remoteSeq when another phone (or tab) last changed it
function touchRemote(ids) {
  remoteSeq++;
  for (const id of ids) touchedAt.set(id, remoteSeq);
}

function checkpoint(what = 'items') {
  const snap = { seq: remoteSeq };
  if (what !== 'assets') snap.items = JSON.stringify(state.items);
  if (what !== 'items') snap.assets = state.assets.map((a) => ({ ...a, care: (a.care || []).map((c) => ({ ...c })) }));
  undoStack.push(snap);
  if (undoStack.length > 30) undoStack.shift();
}

function undoInto(before, now, seq) {
  const changedThere = (id) => (touchedAt.get(id) || 0) > seq;
  const was = new Map(before.map((r) => [r.id, r]));
  const out = now.filter((r) => changedThere(r.id) || was.has(r.id)).map((r) => (changedThere(r.id) ? r : was.get(r.id)));
  const have = new Set(out.map((r) => r.id));
  for (const r of before) if (!have.has(r.id) && !changedThere(r.id)) out.push(r);
  return out;
}

function undo() {
  const snap = undoStack.pop();
  if (!snap) return false;
  if (snap.items) state.items = undoInto(JSON.parse(snap.items), state.items, snap.seq);
  if (snap.assets) state.assets = undoInto(snap.assets, state.assets, snap.seq);
  save('Undone');
  return true;
}

// Put something from Recently deleted back, for everyone in the household.
function restoreDeleted(id) {
  const entry = trash.find((t) => t.item.id === id);
  if (!entry) return;
  trash = trash.filter((t) => t !== entry);
  writeTrash();
  if (allRecords().some((r) => r.id === id)) return toast(`${entry.item.name} is already back`);
  checkpoint('all');
  const r = { ...entry.item, updated: Date.now() };
  (isAsset(r) ? state.assets : state.items).push(r);
  ui.flash = r.id;
  save();
  toast(`Restored ${r.name}`, { undo: true });
}

function openTrash() {
  const fresh = Date.now() - TRASH_DAYS * 864e5;
  const list = trash.filter((t) => t.at > fresh);
  openSheet(`
    <div class="sheet-head"><h2>Recently deleted</h2><button class="link" data-close>Done</button></div>
    <p class="note">Things removed in the last ${TRASH_DAYS} days, on this phone${syncInfo().joined ? ' or anywhere in the household' : ''}. Restore puts one back${syncInfo().joined ? ' for everyone' : ''}.</p>
    ${list.length ? `<ul class="list trash-list" style="margin-top:12px">${list.map(({ item: r, at, why }) => `<li class="item">
        ${isAsset(r) ? assetThumb(r) : thumb(r, false)}
        <div class="info"><div class="name">${esc(r.name || 'Unnamed')}</div><div class="meta">${esc(why || 'Deleted')} ${esc(ago(at))}${isAsset(r) ? ' · House' : r.qty > 0 ? ` · ${esc(qtyText(r))}` : ''}</div></div>
        <button class="btn small" data-restore="${esc(r.id)}">Restore</button>
      </li>`).join('')}</ul>` : '<p class="note" style="margin-top:12px">Nothing deleted lately.</p>'}`);
}

function newItem(fields) {
  // Pantry unless that place has been renamed or removed; then the first place there is.
  const location = fields.location || (allLocations().includes('Pantry') || !allLocations().length ? 'Pantry' : allLocations()[0]);
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

// Spots within a place (shelves, drawers, bins). An item's `shelf` is its spot in its main place.
const spotsIn = (place) => prefs.subPlaces[place] || [];
const allSpots = () => [...new Set(Object.values(prefs.subPlaces).flat())];
function addSpot(place, spot) {
  if (!spot || spotsIn(place).includes(spot)) return;
  prefs.subPlaces[place] = [...spotsIn(place), spot];
  savePrefs();
}
const shelfAt = (it, place) => (place === it.location ? it.shelf || '' : '');
// A folded spot is remembered as "Place<tab>Spot".
const spotKey = (place, spot) => `${place}\t${spot}`;

// Move an item to a place (and a spot there). From a row under one place (`from`), only what's
// kept there moves, joining whatever is already at the new place; without one, all of it moves.
// Spots belong to the main place, so a spot only sticks when the item ends up there.
function moveItem(it, from, place, spot = '') {
  if (!it.spots || !from) {
    delete it.spots;
    it.location = place;
    it.shelf = spot;
  } else if (from === it.location) {
    if (place !== it.location) {
      delete it.spots[place];
      it.location = place;
    }
    it.shelf = spot;
  } else if (from !== place) {
    const n = it.spots[from] || 0;
    delete it.spots[from];
    if (place === it.location) it.shelf = spot;
    else it.spots[place] = round((it.spots[place] || 0) + n);
  } else if (place === it.location) it.shelf = spot;
  it.updated = Date.now();
}

// "Garage shelf 4", "Garage, shelf 4" or "Basement" → a place and maybe a spot in it.
function parseWhere(text) {
  const t = text.trim().replace(/\s+/g, ' ');
  const lower = t.toLowerCase();
  const known = [...allLocations()].sort((a, b) => b.length - a.length)
    .find((pl) => lower === pl.toLowerCase() || lower.startsWith(pl.toLowerCase() + ' ') || lower.startsWith(pl.toLowerCase() + ','));
  const [place, spot = ''] = known ? [known, t.slice(known.length)] : t.split(/\s*[,·]\s*/);
  return { place: known || sentenceCase(place), spot: tidySpot(spot) };
}

// "bin a" → "Bin A", like the spots voice understands.
const tidySpot = (s) => sentenceCase(s.replace(/^[\s,·:-]+/, '')).replace(/ ([a-z])$/, (m, c) => ` ${c.toUpperCase()}`);

// Move picked rows ({id, from}) to a place and spot, asking for a name when it's a new one.
function moveTo(picks, place, spot = '') {
  if (place === '__new') {
    const typed = prompt('Where to? A new place, or a spot in one (e.g. Basement, or Garage shelf 4)')?.trim();
    if (!typed) return;
    ({ place, spot } = parseWhere(typed));
    if (!place) return;
    if (!allLocations().includes(place)) {
      prefs.places = [...allLocations(), place];
      savePrefs();
    }
    addSpot(place, spot);
  }
  const moving = picks.map((p) => ({ it: byId(p.id), from: p.from || null })).filter((p) => p.it);
  if (!moving.length) return;
  checkpoint();
  for (const { it, from } of moving) moveItem(it, from, place, spot);
  ui.select = null;
  if (!prefs.moveTipSeen) {
    prefs.moveTipSeen = true;
    savePrefs();
  }
  buzz(20);
  save();
  const what = moving.length === 1 ? moving[0].it.name : `${new Set(moving.map((p) => p.it.id)).size} items`;
  toast(`${what} → ${place}${spot ? ` · ${spot}` : ''}`, { undo: true });
}

const pickKey = (id, place) => `${id}@${place || ''}`;

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

// ---------- Expiration ----------
// `useBy` is the expiration date and `opened` the day it was opened ('yes' when the day isn't
// known). Once open, something lasts `openDays` (or the usual for its kind), so it's good until
// whichever comes first. Several of one thing can be tracked one by one in `each`, a list of
// {opened, useBy}; the item's own fields then mirror the soonest, for older copies of the app.

const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const plusDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return isoDate(new Date(y, m - 1, d + n));
};
const openDaysOf = (it) => it.openDays || openLife(it.name);

function goodUntil(it, u = it) {
  const days = openDaysOf(it);
  const fromOpen = isDay(u.opened) && days ? plusDays(u.opened, days) : '';
  return [u.useBy, fromOpen].filter(Boolean).sort()[0] || '';
}
// The date that matters for the item: the soonest any of them goes off.
const useByOf = (it) => (it.each ? it.each.map((u) => goodUntil(it, u)).filter(Boolean).sort()[0] || '' : goodUntil(it));
const soonestFirst = (it) => (a, b) => (goodUntil(it, a) || '9999').localeCompare(goodUntil(it, b) || '9999');

// A new one's expiration: how long this item usually lasts, if known.
function freshDate(it) {
  const days = it.noUseBy ? 0 : it.shelfLife || suggestShelfLife(it.name, it.location);
  return days ? dateIn(days) : '';
}

// Things tracked one by one follow the count: using one takes the one that goes off soonest,
// buying one adds a fresh one. Down to one, it folds back into the item.
function tidyEach(it) {
  if (!it.each) return;
  const n = Math.ceil(round(it.qty));
  while (it.each.length > n) it.each.splice(it.each.indexOf([...it.each].sort(soonestFirst(it))[0]), 1);
  while (it.each.length < n) it.each.push({ opened: '', useBy: freshDate(it) });
  if (n < 2) {
    const [u] = it.each;
    delete it.each;
    if (!u) return;
    it.useBy = u.useBy;
    if (u.opened) it.opened = u.opened;
    else delete it.opened;
    return;
  }
  it.useBy = useByOf(it);
  const opened = it.each.map((u) => u.opened).filter(Boolean).sort()[0];
  if (opened) it.opened = opened;
  else delete it.opened;
}

function daysLeft(it) {
  const by = useByOf(it);
  if (!by) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(by + 'T00:00') - today) / 864e5);
}
const useSoon = (it) => it.qty > 0 && daysLeft(it) !== null && daysLeft(it) <= 7;

function useByHtml(it) {
  const n = daysLeft(it);
  if (n === null || it.qty <= 0) return '';
  if (n < 0) return '<span class="bad">Expired</span>';
  if (n === 0) return '<span class="bad">Use today</span>';
  if (n <= 3) return `<span class="warn">Use within ${n} day${n === 1 ? '' : 's'}</span>`;
  const d = new Date(useByOf(it) + 'T00:00');
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
  document.body.classList.toggle('editing', Boolean(ui.editor || ui.assetEditor || ui.paste || ui.account));
  if (ui.view !== 'stock') ui.select = null;
  document.body.classList.toggle('selecting', Boolean(ui.select));
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('on', t.dataset.view === ui.view);
    t.setAttribute('aria-current', t.dataset.view === ui.view ? 'page' : 'false');
  });
  // Stock and House each have their own search and filters in the same header.
  $('#stockTools').hidden = ui.view !== 'stock' && ui.view !== 'house';
  const search = $('#search');
  const q = ui.view === 'house' ? ui.hq : ui.q;
  if (search.value !== q) search.value = q;
  $('#searchClear').hidden = !q;
  search.placeholder = ui.view === 'house' ? 'Search the house' : 'Search everything';
  $('#title').textContent = { stock: 'Key Record', shop: 'Shopping', cook: 'Recipes', house: 'House' }[ui.view];
  const shopCount = shoppingItems().filter((i) => !ui.bought.has(i.id)).length;
  $('#shopBadge').hidden = !shopCount;
  $('#shopBadge').textContent = shopCount;
  if (ui.editor || ui.assetEditor) return; // an editing page owns the screen while it's open
  if (ui.paste) {
    if (!$('#pasteForm')) $('#main').innerHTML = renderPaste();
    return;
  }
  if (ui.account) {
    if (!$('#accountForm')) $('#main').innerHTML = renderAccount();
    return;
  }
  $('#main').innerHTML = { stock: renderStock, shop: renderShop, cook: renderCook, house: renderHouse }[ui.view]();
  if (ui.view === 'cook') {
    filterCook();
    updateCookSummary();
  }
  renderPickBar();
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
  if (it.qty <= 0) return '';
  if (it.each) {
    const n = it.each.filter((u) => u.opened).length;
    return n ? `${n} of ${it.each.length} opened` : '';
  }
  if (!it.opened) return '';
  if (!isDay(it.opened)) return 'Opened';
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
    : showLoc ? esc(it.location) + (it.shelf ? ` · ${esc(it.shelf)}` : '') : '';
  const meta = [esc(it.brand), where, openedText(it), useByHtml(it), listed ? '<span class="warn">On list</span>' : '']
    .filter(Boolean).join(' · ');
  // Under a place, every row is somewhere to drop: its place and spot.
  const zone = place ? `data-drop-place="${esc(place)}" data-drop-spot="${esc(shelfAt(it, place))}"` : '';
  if (ui.select) {
    const on = ui.select.has(pickKey(it.id, place));
    return `<li class="swipe-row draggable" data-id="${it.id}" data-place="${esc(place || '')}" ${zone}>
      <button class="item pick-item ${on ? 'picked' : ''}" data-act="pick" aria-pressed="${on}">
        <span class="tick" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></span>
        ${thumb(it, false)}
        <span class="info"><span class="name">${esc(it.name)}</span>${meta ? `<span class="meta">${meta}</span>` : ''}</span>
        <span class="qty ${cls}">${fmt(here)}${it.unit ? `<small>${esc(pluralUnit(it.unit, here))}</small>` : ''}</span>
      </button>
    </li>`;
  }
  return `<li class="swipe-row swipeable draggable" data-id="${it.id}" data-place="${esc(place || '')}" ${zone} data-swipe-right="${listed ? 'unlist' : 'tolist'}" data-swipe-left="delete">
    <span class="swipe-label act-right ${listed ? 'off' : ''}" aria-hidden="true">${listed ? 'Off the list' : 'Add to list'}</span>
    <span class="swipe-label act-left" aria-hidden="true">Delete</span>
    <div class="item ${ui.flash === it.id ? 'flash' : ''}">
      ${thumb(it)}
      <button class="info" data-act="edit"><div class="name">${esc(it.name)}</div>${meta ? `<div class="meta">${meta}</div>` : ''}</button>
      <div class="stepper">
        <button data-act="dec" data-place="${esc(place || '')}" aria-label="One less ${esc(it.name)}" ${here <= 0 ? 'disabled' : ''}>−</button>
        <span class="qty ${cls}" role="button" tabindex="0" data-act="count" data-place="${esc(place || '')}" aria-label="${esc(qtyText(it, here))}. Type the exact count">${fmt(here)}${it.unit ? `<small>${esc(pluralUnit(it.unit, here))}</small>` : ''}</span>
        <button data-act="inc" data-place="${esc(place || '')}" aria-label="One more ${esc(it.name)}">+</button>
      </div>
    </div>
  </li>`;
}

// One place's items: those without a spot first, then each spot under a small heading.
function placeList(group, place) {
  const order = (it) => {
    const sp = shelfAt(it, place);
    if (!sp) return -1;
    const i = spotsIn(place).indexOf(sp);
    return i >= 0 ? i : 999;
  };
  const sorted = [...group].sort((a, b) => order(a) - order(b) || shelfAt(a, place).localeCompare(shelfAt(b, place)) || a.name.localeCompare(b.name));
  let last = '';
  let html = '';
  for (const it of sorted) {
    const sp = shelfAt(it, place);
    const shut = sp && prefs.foldedSpots.includes(spotKey(place, sp));
    if (sp && sp !== last) {
      const n = sorted.filter((i) => shelfAt(i, place) === sp).length;
      html += `<li class="sub-head" data-drop-place="${esc(place)}" data-drop-spot="${esc(sp)}">
        <button class="fold ${shut ? 'shut' : ''}" data-fold-spot="${esc(spotKey(place, sp))}" aria-expanded="${!shut}">
          <span>${esc(sp)}</span><span class="fold-meta">${shut ? `${n} item${n === 1 ? '' : 's'}` : ''}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span>
        </button></li>`;
    }
    last = sp;
    if (!shut) html += itemRow(it, false, place);
  }
  return html;
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
  const matches = (i) => `${i.name} ${i.brand} ${placesOf(i).join(' ')} ${i.shelf || ''}`.toLowerCase().includes(q);
  let items = state.items.filter(inStock).filter((i) => ui.loc === 'All' || (ui.loc === 'soon' ? useSoon(i) : shownIn(i).includes(ui.loc)));
  if (q) items = items.filter(matches);
  items.sort(ui.loc === 'soon' ? (a, b) => daysLeft(a) - daysLeft(b) : (a, b) => a.name.localeCompare(b.name));
  // Searching for something you're out of: point to the list rather than offering a duplicate.
  const onListOnly = q ? state.items.filter((i) => !inStock(i) && matches(i)) : [];
  const listNote = onListOnly.length
    ? `<div class="card list-note"><p><b>${onListOnly.map((i) => esc(i.name)).join(', ')}</b> ${onListOnly.length === 1 ? 'is' : 'are'} out and on your shopping list.</p>
       <button class="btn small" data-act="go-shop">View shopping list</button></div>`
    : '';
  // The search covers everything: matching belongings from the House tab show underneath.
  const houseHits = q ? state.assets.filter((a) => assetText(a).includes(q)).sort((a, b) => a.name.localeCompare(b.name)) : [];
  const houseNote = houseHits.length
    ? `<h2 class="group"><span>In the house</span></h2><ul class="list house-list">${houseHits.map((a) => assetRow(a, true)).join('')}</ul>`
    : '';
  if (!items.length) {
    if (onListOnly.length) return listNote + houseNote;
    if (q && houseNote) return `${houseNote}<button class="add-row" data-act="add-named">+ Add “${esc(ui.q.trim())}” to stock</button>`;
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
        if (!group.length) return '';
        // Tap a place's heading to fold it away; folding is per phone, not shared.
        const folded = prefs.folded.includes(loc);
        const allPicked = ui.select && group.every((i) => ui.select.has(pickKey(i.id, loc)));
        return `<h2 class="group" data-drop-place="${esc(loc)}" data-drop-spot=""><button class="fold ${folded ? 'shut' : ''}" data-fold="${esc(loc)}" aria-expanded="${!folded}">
            <span>${esc(loc)}</span><span class="fold-meta">${folded ? `${group.length} item${group.length === 1 ? '' : 's'}` : ''}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span>
          </button>${ui.select ? `<button class="pick-all" data-pick-place="${esc(loc)}">${allPicked ? 'Clear' : 'Select all'}</button>` : ''}</h2>${folded ? '' : `<ul class="list stock-list">${placeList(group, loc)}</ul>`}`;
      })
      .join('');
  } else {
    const place = ui.loc !== 'All' && ui.loc !== 'soon' && !q ? ui.loc : null;
    html = `<ul class="list stock-list" style="margin-top:12px">${place ? placeList(items, place) : items.map((i) => itemRow(i, true)).join('')}</ul>`;
  }
  if (ui.select) return html;
  const tip = !prefs.stockSwipeTipSeen
    ? 'Swipe an item right to add it to the shopping list, or left to delete it. Press and hold to move it.'
    : !prefs.moveTipSeen ? 'Press and hold an item, then drag it onto another place or spot. Let go without dragging to pick several.'
    : !prefs.countTipSeen ? 'Counted a shelf? Tap a number to type the exact count.' : '';
  return (tip ? `<p class="note stock-tip">${tip}</p>` : '') +
    html + listNote + houseNote + `<div class="add-pair"><button class="add-row" data-act="add">+ Add an item</button><button class="add-row" data-act="paste">Paste a list</button></div>`;
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
  const meta = bought ? `Back in stock${it.spots ? ' · in all' : ` · ${esc(it.location)}`}` : `${status} · ${esc(it.location)}${it.shelf ? ` · ${esc(it.shelf)}` : ''}`;
  return `<li class="swipe-row ${bought ? '' : 'swipeable'}" data-id="${it.id}" data-drop-store="${esc(it.store || '')}" data-swipe-left="unlist">
    ${bought ? '' : '<span class="swipe-label act-left" aria-hidden="true">Remove</span>'}
    <div class="item ${bought ? 'bought' : ''} ${ui.flash === it.id ? 'flash' : ''}">
      <button class="check" data-act="${bought ? 'unbuy' : 'got'}" role="checkbox" aria-checked="${bought}" aria-label="${esc(it.name)}">
        <svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></button>
      <button class="info" data-act="edit"><div class="name">${esc(it.name)}</div><div class="meta">${meta}</div></button>
      ${bought ? `<div class="stepper">
        <button data-act="dec" aria-label="One less ${esc(it.name)}" ${it.qty <= 0 ? 'disabled' : ''}>−</button>
        <span class="qty" role="button" tabindex="0" data-act="count" aria-label="${esc(qtyText(it))}. Type the exact count">${fmt(it.qty)}${it.unit ? `<small>${esc(pluralUnit(it.unit, it.qty))}</small>` : ''}</span>
        <button data-act="inc" aria-label="One more ${esc(it.name)}">+</button></div>` : ''}
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
  if (stores.length && (all.length || sel !== 'all')) {
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
      if (groups.length > 1) html += `<h2 class="group" data-drop-store="${esc(name === 'Any store' ? '' : name)}">${esc(name)}</h2>`;
      html += `<ul class="list shop-list">${g.sort(byPlace).map((i) => shopRow(i, false)).join('')}</ul>`;
    }
  } else if (!bought.length) {
    html += `<div class="empty"><div class="big">🛒</div><h2>Nothing to buy${sel === 'all' ? '' : ` at ${esc(sel)}`}</h2>
      <p>Things land here on their own when they run low. You can also say “add coffee to the ${sel === 'all' ? 'shopping' : esc(sel)} list.”</p></div>`;
  }
  if (bought.length) {
    html += `<h2 class="group"><span>In the cart · back in stock</span></h2><ul class="list shop-list">${bought.map((i) => shopRow(i, true)).join('')}</ul>
      <p class="note" style="margin:8px 4px">Bought a different amount? Fix the count with − and +. Tapped one by mistake? Tap it again.</p>`;
  } else if (visible.length && !prefs.swipeTipSeen) {
    html += `<p class="note" style="margin:8px 4px">${[
      prefs.storeTipSeen ? '' : 'Tap a store tag, or press and hold an item and drag it onto a store at the top.',
      prefs.swipeTipSeen ? '' : 'Swipe left or tap ✕ to take something off the list.',
    ].filter(Boolean).join(' ') || 'Tick things off as you shop.'}</p>`;
  }
  return html;
}

// ---------- Recipes ----------
// Two halves: the dinner plan (the week's dinners from what's in stock), and recipe ideas (pick
// the ingredients to cook with and get a ready-made question for Claude or any recipe app).

const MEALS = ['Any meal', 'Breakfast', 'Lunch', 'Dinner', 'Side dish', 'Snack', 'Dessert'];
// How each meal reads in the question: "ideas for dinner", "ideas for a side dish".
const MEAL_WORDS = { 'Any meal': 'a meal', 'Side dish': 'a side dish', Snack: 'a snack' };
const CUISINES = ['Any cuisine', 'American', 'Caribbean', 'Chinese', 'French', 'Greek', 'Indian', 'Italian', 'Japanese', 'Korean', 'Mediterranean', 'Mexican', 'Middle Eastern', 'Spanish', 'Thai', 'Vietnamese'];
const byUseBy = (a, b) => (daysLeft(a) ?? 999) - (daysLeft(b) ?? 999) || a.name.localeCompare(b.name);

// Filled in place (not copied), so a change made through it sticks.
function cookPrefs() {
  const c = (prefs.cook ??= {});
  const defaults = {
    picked: [], meal: 'Any meal', cuisine: 'Any cuisine', servings: 2, extras: true, notes: '', others: false, mode: 'dinners',
    dinners: { start: '', ids: [], seed: 1, max: 30, veg: false },
  };
  for (const [k, v] of Object.entries(defaults)) c[k] ??= v;
  return c;
}

const cookModes = (c) => {
  const tab = (mode, label) => `<button role="tab" class="${c.mode === mode ? 'on' : ''}" aria-selected="${c.mode === mode}" data-cook-mode="${mode}">${label}</button>`;
  return `<div class="cook-modes" role="tablist" aria-label="Recipes">${tab('dinners', 'Dinner plan')}${tab('ideas', 'Recipe ideas')}</div>`;
};

// ---------- Dinner plan ----------
// The next seven dinners for two adults and two toddlers, using what's in stock first (dinners.js
// does the choosing). It rolls on by itself: each new day drops the dinners that have passed and
// plans one more at the end, so tonight is always first and the week ahead is always planned.

const dinnerStock = () => state.items.filter((i) => i.qty > 0 && !NOT_FOOD.test(i.name)).map((i) => ({ id: i.id, name: i.name, qty: i.qty, days: daysLeft(i) }));
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00') - new Date(a + 'T00:00')) / 864e5);
const onTheList = (key) => state.items.some((i) => isLow(i) && dinnerMatches(i.name, key));
// What the plan still needs to buy, as recipe keys, leaving out what's already on the list.
const dinnerNeeds = (plan) => [...new Set(plan.flat().filter((x) => !x.item).map((x) => x.key))].filter((k) => !onTheList(k));

function dinnerPlan(stock) {
  const d = cookPrefs().dinners;
  const today = todayIso();
  const shift = d.start ? daysBetween(d.start, today) : PLAN_DAYS;
  const pool = dinnerPool(d);
  let keep = shift >= 0 && shift < PLAN_DAYS ? d.ids.slice(shift) : [];
  if (!keep.every((id) => pool.includes(id))) keep = [];
  if (shift || keep.length < PLAN_DAYS) {
    const ids = extendPlan(keep, stock, d, seeded(d.seed + daysBetween('2000-01-01', today)));
    if (shift || String(ids) !== String(d.ids)) {
      Object.assign(d, { start: today, ids });
      ui.dinnerOpen.clear();
      writePrefs();
    }
  }
  return d.ids;
}

function renderDinners() {
  const d = cookPrefs().dinners;
  const stock = dinnerStock();
  const ids = dinnerPlan(stock);
  const plan = allocate(ids, stock);
  const rows = plan.flat();
  const needs = dinnerNeeds(plan);
  const anyMissing = rows.some((x) => !x.item);
  const chip = (on, attr, label) => `<button class="chip ${on ? 'on' : ''}" ${attr} aria-pressed="${on}">${label}</button>`;
  let html = `<div class="card dinner-head">
      <h3>Next ${ids.length} dinners</h3>
      <p>Quick, healthy dinners for 2 adults and 2 toddlers, made from what you have first.</p>
      <div class="chips">${chip(d.max === 20, 'data-dinner-max="20"', 'Up to 20 min')}${chip(d.max === 30, 'data-dinner-max="30"', 'Up to 30 min')}${chip(d.veg, 'data-dinner="veg"', 'Meatless')}</div>
      <div class="dinner-sum">
        <span><b>${rows.filter((x) => x.item).length} of ${rows.length}</b> ingredients in stock</span>
        ${needs.length ? `<button class="btn small primary" data-dinner="list">Add ${needs.length} to the list</button>` : anyMissing ? '<span class="note">The rest is on the shopping list</span>' : ''}
      </div>
    </div>
    <ul class="list dinner-list">`;
  plan.forEach((ing, i) => {
    const r = dinnerById[ids[i]];
    const day = new Date(dateIn(i) + 'T00:00');
    const open = ui.dinnerOpen.has(i);
    const soon = [...new Set(ing.filter((x) => goingOff(x.item, i) != null).map((x) => x.item.name.toLowerCase()))];
    const when = i === 0 ? 'Tonight' : i === 1 ? 'Tomorrow' : day.toLocaleDateString(undefined, { weekday: 'long' });
    html += `<li class="dinner ${i === 0 ? 'tonight' : ''}">
      <div class="dinner-top">
        <button class="dinner-open" data-dinner-open="${i}" aria-expanded="${open}">
          <span class="dinner-day"><small>${day.toLocaleDateString(undefined, { weekday: 'short' })}</small><b>${day.getDate()}</b></span>
          <span class="info"><span class="name">${esc(r.name)}</span>
            <span class="meta">${i === 0 ? 'Tonight · ' : ''}${r.min} min · ${ing.filter((x) => x.item).length} of ${ing.length} in stock${soon.map((n) => ` · <span class="warn">Uses up ${esc(n)}</span>`).join('')}</span></span>
        </button>
        <button class="btn small" data-dinner-swap="${i}" aria-label="Swap ${esc(when.toLowerCase())}’s dinner">Swap</button>
      </div>
      ${open ? `<div class="dinner-body">
        <h4>Ingredients</h4>
        <ul class="dinner-ing">${ing.map((x) => `<li class="${x.item ? 'have' : ''}"><span>${esc(x.label)}</span><small>${x.item ? 'In stock' : x.stale ? (i ? 'Past its date by then' : 'Yours is past its date') : onTheList(x.key) ? 'On the list' : 'To buy'}</small></li>`).join('')}</ul>
        <h4>Steps</h4>
        <ol>${r.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
        <p class="dinner-tip"><b>For the toddlers</b>${esc(r.tod)}</p>
      </div>` : ''}
    </li>`;
  });
  return `${html}</ul><button class="link small dinner-new" data-dinner="new">Plan different dinners</button>`;
}

// Puts what the plan still needs on the shopping list: something you've run out of goes back on
// it, anything new goes on as list-only.
function listDinnerNeeds() {
  const stock = dinnerStock();
  const needs = dinnerNeeds(allocate(cookPrefs().dinners.ids, stock));
  if (!needs.length) return;
  checkpoint();
  for (const key of needs) {
    const name = shopName(key);
    let it = matchExact(name, state.items)?.item || state.items.find((i) => !NOT_FOOD.test(i.name) && dinnerMatches(i.name, key));
    if (!it) {
      it = newItem({ name, qty: 0, location: guessLocation(name), listOnly: true });
      state.items.push(it);
    }
    it.need = true;
    it.updated = Date.now();
    ui.bought.delete(it.id);
  }
  save();
  toast(`Added ${needs.length} to the shopping list`, { undo: true });
}

$('#main').addEventListener('click', (e) => {
  if (ui.view !== 'cook' || ui.editor || ui.paste || ui.account) return;
  const el = e.target.closest('[data-cook-mode], [data-dinner], [data-dinner-max], [data-dinner-open], [data-dinner-swap]');
  if (!el) return;
  const c = cookPrefs();
  const d = c.dinners;
  const { cookMode, dinner, dinnerMax, dinnerOpen, dinnerSwap } = el.dataset;
  if (dinner === 'list') return listDinnerNeeds();
  if (cookMode) c.mode = cookMode;
  else if (dinnerOpen) {
    const i = Number(dinnerOpen);
    if (!ui.dinnerOpen.delete(i)) ui.dinnerOpen.add(i);
    return render();
  } else if (dinnerSwap) {
    const i = Number(dinnerSwap);
    const date = dateIn(i);
    if (!ui.dinnerSeen.has(date)) ui.dinnerSeen.set(date, new Set());
    const id = swapDinner(d.ids, i, dinnerStock(), d, ui.dinnerSeen.get(date));
    if (!id) return toast('No other dinners fit these filters');
    d.ids[i] = id;
    ui.dinnerOpen.delete(i);
  } else {
    // A filter or a fresh start: plan the whole week again.
    if (dinnerMax) d.max = Number(dinnerMax);
    if (dinner === 'veg') d.veg = !d.veg;
    if (dinner === 'new') d.seed = Math.floor(Math.random() * 1e9);
    d.ids = [];
    ui.dinnerSeen.clear();
  }
  savePrefs();
  render();
});

// ---------- Recipe ideas ----------

// Picked items you still have.
function cookPicked() {
  const have = new Set(state.items.filter((i) => i.qty > 0).map((i) => i.id));
  return cookPrefs().picked.filter((id) => have.has(id));
}

function renderCook() {
  const c = cookPrefs();
  if (c.mode === 'dinners') return cookModes(c) + renderDinners();
  const picked = new Set(cookPicked());
  const have = state.items.filter((i) => i.qty > 0 && !NOT_FOOD.test(i.name));
  if (!have.length) {
    return `${cookModes(c)}<div class="empty"><div class="big">🍳</div><h2>Nothing in stock yet</h2>
      <p>Once you’ve added what’s in your kitchen, pick ingredients here to get recipe ideas.</p></div>`;
  }
  const kitchen = allLocations().filter((pl) => KITCHEN.includes(pl));
  const others = allLocations().filter((pl) => !KITCHEN.includes(pl) && have.some((i) => shownIn(i).includes(pl)));
  const soon = have.filter(useSoon);
  const cuisines = CUISINES.includes(c.cuisine) ? CUISINES : [...CUISINES, c.cuisine];
  let html = `${cookModes(c)}<p class="note" style="margin:12px 4px 0">Choose what you’re making and tick what to cook with, then ask Claude or copy the question for any recipe app.</p>
    <div class="card form cook-options cook-what">
      <h3>What are you making?</h3>
      <div class="row2">
        <label>Category<select data-cook-opt="meal">${MEALS.map((m) => `<option value="${esc(m)}" ${m === c.meal ? 'selected' : ''}>${m === 'Any meal' ? 'Any' : m}</option>`).join('')}</select></label>
        <label>Cuisine<select data-cook-opt="cuisine">${cuisines.map((v) => `<option ${v === c.cuisine ? 'selected' : ''}>${esc(v)}</option>`).join('')}<option value="__other">Other…</option></select></label>
      </div>
      <label class="cook-serves">Servings
        <div class="stepper big"><button type="button" data-cook-serve="-1" aria-label="One fewer serving" ${c.servings <= 1 ? 'disabled' : ''}>−</button><input data-cook-opt="servings" type="number" inputmode="numeric" min="1" max="50" value="${c.servings}" aria-label="Servings"><button type="button" data-cook-serve="1" aria-label="One more serving">+</button></div>
      </label>
      <button type="button" class="cook-exact ${c.extras ? '' : 'on'}" role="checkbox" aria-checked="${!c.extras}" data-cook="exact">
        <span class="check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></span>
        <span><b>Exact ingredients only</b><small>${exactNote(c)}</small></span>
      </button>
    </div>
    <div class="search-wrap cook-search">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
      <input id="cookSearch" type="search" value="${esc(ui.cq)}" placeholder="Search ingredients" autocomplete="off" enterkeyhint="search" aria-label="Search ingredients">
      <button type="button" class="search-clear" data-cook="clear-search" aria-label="Clear search" ${ui.cq ? '' : 'hidden'}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>
      </button>
    </div>
    <div class="chips cook-quick">
      ${soon.length ? `<button class="chip soon" data-cook="soon">Use soon <small>${soon.length}</small></button>` : ''}
      <button class="chip" data-cook="all">All shown</button>
      <button class="chip" data-cook="none">None</button>
    </div>
    <p class="note" id="cookNone" style="margin:12px 4px" hidden></p>`;
  // Every place is drawn; filterCook() shows the kitchen ones, the rest when asked for or searched.
  for (const pl of [...kitchen, ...others]) {
    const group = have.filter((i) => shownIn(i).includes(pl)).sort(byUseBy);
    if (!group.length) continue;
    html += `<section class="cook-group" ${others.includes(pl) ? 'data-other' : ''}><h2 class="group">${esc(pl)}</h2><ul class="list pick-list">${group.map((it) => `
      <li class="item pick-row ${picked.has(it.id) ? 'on' : ''}" data-pick-id="${it.id}" data-find="${esc(`${it.name} ${it.brand || ''}`.toLowerCase())}" role="checkbox" aria-checked="${picked.has(it.id)}" tabindex="0">
        <span class="check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></span>
        ${thumb(it, false)}
        <div class="info"><div class="name">${esc(it.name)}</div><div class="meta">${[esc(qtyText(it)), useByHtml(it), openedText(it)].filter(Boolean).join(' · ')}</div></div>
      </li>`).join('')}</ul></section>`;
  }
  if (others.length) {
    html += `<button class="link small show-others" data-cook="others">${c.others ? 'Hide' : 'Show'} ${others.map((pl) => esc(pl.toLowerCase())).join(', ')}</button>`;
  }
  html += `<div class="card form cook-options">
      <label style="margin-top:0">Anything else?<input data-cook-opt="notes" value="${esc(c.notes)}" placeholder="e.g. vegetarian, 30 minutes, kid-friendly" autocomplete="off" enterkeyhint="done"></label>
      <details class="cook-preview"><summary>See the question</summary><pre class="share-preview" id="cookPreview"></pre></details>
    </div>
    <div class="cook-spacer"></div>
    <div class="cook-bar">
      <span id="cookCount"></span>
      <button class="btn" data-cook="copy">Copy</button>
      <button class="btn primary" data-cook="claude">Ask Claude</button>
    </div>`;
  return html;
}

const exactNote = (c) => (c.extras ? 'Unticked: recipes can suggest a few extras to buy' : 'Only what you tick, plus basics like salt, oil and water');

function recipePrompt() {
  const c = cookPrefs();
  const items = cookPicked().map(byId).filter(Boolean).sort(byUseBy);
  const meal = MEAL_WORDS[c.meal] || c.meal.toLowerCase();
  const cuisine = c.cuisine === 'Any cuisine' ? '' : `${c.cuisine} `;
  const people = `${c.servings} ${c.servings === 1 ? 'person' : 'people'}`;
  const line = (i) => `- ${i.name} (${qtyText(i)})${useSoon(i) ? ' — use soon' : ''}`;
  return [
    `I’d like ${cuisine}recipe ideas for ${meal} for ${people}, using what I have at home:`,
    items.map(line).join('\n'),
    c.extras
      ? 'Feel free to suggest a few additional ingredients — list anything I’d need to buy separately.'
      : 'Use only these ingredients plus basics like salt, pepper, oil and water — nothing I’d need to buy.',
    items.some(useSoon) ? 'Prioritise the ones marked “use soon”.' : '',
    c.notes.trim() ? `Notes: ${c.notes.trim()}` : '',
    `Suggest 3 recipes, each with an ingredient list (amounts for ${people}) and short steps.`,
  ].filter(Boolean).join('\n\n');
}

// Narrows the ingredients as you type, in place: redrawing the page would close the keyboard.
// Places outside the kitchen show when asked for, or when the search finds something there.
function filterCook() {
  const q = ui.cq.trim().toLowerCase();
  const others = cookPrefs().others || Boolean(q);
  let found = 0;
  document.querySelectorAll('.cook-group').forEach((g) => {
    let n = 0;
    g.querySelectorAll('[data-pick-id]').forEach((row) => {
      row.hidden = Boolean(q) && !row.dataset.find.includes(q);
      if (!row.hidden) n++;
    });
    g.hidden = !n || (g.dataset.other !== undefined && !others);
    if (!g.hidden) found += n;
  });
  const none = $('#cookNone');
  if (none) {
    none.hidden = !q || found > 0;
    none.textContent = `Nothing in stock matches “${ui.cq.trim()}”. To use it anyway, add it under Anything else? below.`;
  }
  $('.cook-search .search-clear')?.toggleAttribute('hidden', !ui.cq);
  $('.show-others')?.toggleAttribute('hidden', Boolean(q));
}

function updateCookSummary() {
  const n = cookPicked().length;
  if ($('#cookCount')) $('#cookCount').textContent = n ? `${n} picked` : 'Pick ingredients';
  if ($('#cookPreview')) $('#cookPreview').textContent = n ? recipePrompt() : 'Pick some ingredients first.';
  document.querySelectorAll('.cook-bar .btn').forEach((b) => (b.disabled = !n));
}

function setPicked(ids) {
  cookPrefs().picked = [...new Set(ids)];
  savePrefs();
  document.querySelectorAll('[data-pick-id]').forEach((row) => {
    const on = cookPrefs().picked.includes(row.dataset.pickId);
    row.classList.toggle('on', on);
    row.setAttribute('aria-checked', on);
  });
  updateCookSummary();
}

async function sendRecipe(toClaude) {
  const text = recipePrompt();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    if (!toClaude) return prompt('Copy this:', text);
  }
  if (toClaude) window.open(`https://claude.ai/new?q=${encodeURIComponent(text)}`, '_blank');
  else toast('Copied — paste it into Claude or any recipe app');
}

$('#main').addEventListener('click', (e) => {
  if (ui.view !== 'cook' || ui.editor || ui.paste || ui.account) return;
  const row = e.target.closest('[data-pick-id]');
  if (row) {
    const id = row.dataset.pickId;
    const picked = cookPicked();
    return setPicked(picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]);
  }
  const c = cookPrefs();
  const serve = e.target.closest('[data-cook-serve]');
  if (serve) {
    c.servings = Math.min(50, Math.max(1, c.servings + Number(serve.dataset.cookServe)));
    showServings();
  }
  const act = e.target.closest('[data-cook]')?.dataset.cook;
  if (act === 'exact') {
    c.extras = !c.extras;
    const box = e.target.closest('.cook-exact');
    box.classList.toggle('on', !c.extras);
    box.setAttribute('aria-checked', !c.extras);
    box.querySelector('small').textContent = exactNote(c);
  }
  if (serve || act === 'exact') {
    savePrefs();
    return updateCookSummary();
  }
  const shown = () => [...document.querySelectorAll('.cook-group:not([hidden]) [data-pick-id]:not([hidden])')].map((r) => r.dataset.pickId);
  if (act === 'clear-search') {
    ui.cq = '';
    $('#cookSearch').value = '';
    filterCook();
  }
  if (act === 'soon') setPicked(state.items.filter(useSoon).map((i) => i.id));
  if (act === 'all') setPicked(shown());
  if (act === 'none') setPicked([]);
  if (act === 'copy') sendRecipe(false);
  if (act === 'claude') sendRecipe(true);
  if (act === 'others') {
    cookPrefs().others = !cookPrefs().others;
    savePrefs();
    render();
  }
});

$('#main').addEventListener('keydown', (e) => {
  if ((e.key === ' ' || e.key === 'Enter') && e.target.matches('[data-pick-id], [data-asset-open], [role="button"][data-act]')) {
    e.preventDefault();
    e.target.click();
  }
});

// The servings box shows the saved count; − can't go below one.
function showServings(typing = false) {
  const n = cookPrefs().servings;
  const box = $('[data-cook-opt="servings"]');
  if (!box) return;
  if (!typing) box.value = n;
  box.previousElementSibling.disabled = n <= 1;
}

const readCookOption = (e) => {
  const key = e.target.dataset?.cookOpt;
  if (!key) return;
  const c = cookPrefs();
  const v = e.target.value;
  if (key === 'servings') {
    // While typing, a blank or 0 waits; leaving the box puts the last good number back.
    const n = parseInt(v, 10);
    if (n >= 1) c.servings = Math.min(n, 50);
    showServings(e.type === 'input');
  } else if (key === 'cuisine' && v === '__other') {
    if (e.type !== 'change') return;
    const typed = titleCase(prompt('Which cuisine? (e.g. Cajun, Ethiopian, Filipino)') || '');
    if (!typed) {
      e.target.value = c.cuisine;
      return;
    }
    c.cuisine = typed;
    if (![...e.target.options].some((o) => o.value === typed)) e.target.querySelector('[value="__other"]').insertAdjacentHTML('beforebegin', `<option>${esc(typed)}</option>`);
    e.target.value = typed;
  } else c[key] = v;
  savePrefs();
  updateCookSummary();
};
$('#main').addEventListener('change', readCookOption);
$('#main').addEventListener('input', readCookOption);
$('#main').addEventListener('input', (e) => {
  if (e.target.id !== 'cookSearch') return;
  ui.cq = e.target.value;
  filterCook();
});

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

// "3", "2.5", "1 1/2", "½" → a count; anything else → null.
function parseCount(s) {
  const t = String(s).trim().replace(',', '.');
  const glyph = Object.entries(FRACTIONS).find(([, g]) => t.endsWith(g));
  const [, whole = '0', num, den] = (glyph ? [t, t.slice(0, -1).trim() || '0', glyph[0], '1'] : t.match(/^(?:(\d+)\s+)?(\d+)\/(\d+)$/)) || [];
  if (num) return /^\d+$/.test(whole) && Number(den) > 0 ? round(Number(whole) + Number(num) / Number(den)) : null;
  return /^\d*\.?\d+$/.test(t) ? round(Number(t)) : null;
}

// Type the exact count, e.g. after counting what's on the shelf. From a row under one place,
// it's the count there.
function setCount(it, place = null) {
  if (!it) return;
  const at = place && it.spots ? place : null;
  const here = at ? countAt(it, at) : it.qty;
  const where = at ? ` in the ${at.toLowerCase()}` : '';
  const typed = prompt(`How many ${it.unit ? `${pluralUnit(it.unit, 2)} of ` : ''}${it.name.toLowerCase()}${where}?`, String(here));
  if (typed == null || !typed.trim()) return;
  const n = parseCount(typed);
  if (n == null) return toast('Type a number, like 3, 2.5 or 1 1/2');
  if (n === here) return;
  checkpoint();
  const wasInStock = inStock(it);
  if (at) adjustAt(it, at, n - here);
  else it.qty = n;
  if (n > here && it.qty > (it.low ?? -1)) it.need = false;
  it.updated = Date.now();
  if (!prefs.countTipSeen) {
    prefs.countTipSeen = true;
    savePrefs();
  }
  buzz(15);
  save();
  toast(wasInStock && !inStock(it) ? `${it.name} is out — moved to the shopping list` : `${it.name}${where}: ${fmt(here)} → ${qtyText(it, at ? countAt(it, at) : it.qty)}`, { undo: true });
}

// Ticked off in the cart: what to put back if it's unticked.
const boughtSnapshot = (it) => ({
  qty: it.qty, need: it.need, listOnly: it.listOnly, location: it.location, useBy: it.useBy, opened: it.opened,
  each: it.each?.map((u) => ({ ...u })), spots: it.spots && { ...it.spots },
});

function markBought(it) {
  ui.bought.set(it.id, boughtSnapshot(it));
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
  if (before) {
    Object.assign(it, before);
    for (const k of ['opened', 'each', 'spots', 'listOnly']) if (before[k] === undefined) delete it[k];
    it.updated = Date.now();
  }
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
      it = newItem({ name: sentenceCase(a.name), qty, unit: a.unit || '', location: a.location || guessLocation(a.name), shelf: a.shelf || '', listOnly: qty <= 0 && (a.action === 'need' || a.action === 'out') });
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
          ui.bought.set(it.id, boughtSnapshot(it));
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
        } else if ((a.location && a.location !== it.location) || (a.shelf && a.shelf !== it.shelf)) {
          // Moving it all: other places merge into the new one.
          if (a.location && a.location !== it.location) {
            it.location = a.location;
            it.shelf = '';
            delete it.spots;
          }
          if (a.shelf) it.shelf = a.shelf;
          done.push(`${it.name} moved to the ${it.location.toLowerCase()}${it.shelf ? `, ${it.shelf.toLowerCase()}` : ''}`);
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
    // "…on shelf 2": that's its spot in its main place.
    if (a.shelf && ['add', 'set', 'restock'].includes(a.action) && (!a.location || a.location === it.location)) {
      it.shelf = a.shelf;
      addSpot(it.location, a.shelf);
    }
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

// Expiration date set by hand or by voice; remembered as how long this item usually lasts.
// Set by voice for something tracked one by one, it applies to each of them.
function setUseBy(it, useBy) {
  it.useBy = useBy;
  delete it.noUseBy;
  it.each?.forEach((u) => (u.useBy = useBy));
  const days = Math.round((new Date(useBy + 'T00:00') - new Date(todayIso() + 'T00:00')) / 864e5);
  if (days >= 1 && days <= 120 && !it.opened) it.shelfLife = days;
}

// Opening starts the clock: things like milk or salsa only last so long once open. Of several
// tracked one by one, the one opened is the unopened one that goes off soonest.
function markOpened(it, date = todayIso()) {
  const u = it.each ? it.each.filter((x) => !x.opened).sort(soonestFirst(it))[0] : it;
  if (u) u.opened = date;
  tidyEach(it);
  return openDaysOf(it);
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
    : ` in the ${(have[0] || it.location).toLowerCase()}${it.shelf && (have[0] || it.location) === it.location ? `, ${it.shelf.toLowerCase()}` : ''}`;
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
    const r = resolveActions(parseCommand(t, { locations, stores: allStores(), spots: allSpots(), listContext: ui.view === 'shop' && !ui.editor }), state.items);
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

const storePicker = (current) =>
  selectPicker('store', ['', ...allStores()], current, { label: 'Buy at', text: (v) => v || 'Any store', other: { label: '+ New store…', ask: 'Store name (e.g. Costco, Aldi)' } });

// Where it's kept, as two dropdowns: the place, then a spot in it. The spot list only offers
// that place's spots, so neither list gets long.
function wherePickers(place, spot) {
  const places = allLocations().includes(place) ? allLocations() : [...allLocations(), place];
  const spots = ['', ...spotsIn(place)];
  if (!spots.includes(spot)) spots.push(spot);
  return `<label>Kept in <select name="location" aria-label="Kept in" data-prev="${esc(place)}">${places
    .map((p) => `<option value="${esc(p)}" ${p === place ? 'selected' : ''}>${esc(p)}</option>`)
    .join('')}<option value="__new">+ New place…</option></select></label>
    <label>Spot <select name="shelf" aria-label="Spot in ${esc(place)}" data-prev="${esc(spot)}">${spots
    .map((s) => `<option value="${esc(s)}" ${s === spot ? 'selected' : ''}>${esc(s || 'No spot')}</option>`)
    .join('')}<option value="__new">+ New spot…</option></select></label>`;
}

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

// Saving a page that was open while someone else changed the same thing: what was changed on
// the page wins, and their changes to everything else are kept. (Deleted meanwhile: it comes back.)
function keepTheirs(list, before, edited) {
  const current = list.find((r) => r.id === edited.id);
  if (!current || current === edited) return edited;
  return mergeItem(before, { ...edited, updated: Date.now() }, current, { absolute: true });
}

// The item editor is an ordinary page rather than an overlay: on iPhone, text fields inside
// fixed panels end up behind the keyboard, while on a normal page Safari scrolls them into view.
// Resolves with { item, note } when saved, or null when cancelled.
function openEditor(item, opts = {}) {
  return new Promise((resolve) => {
    if (ui.editor) ui.editor.resolve(null);
    // `before`: the item as the page found it, so a save only applies what was changed here.
    ui.editor = { item, before: slim(item), ...opts, resolve, scrollY: window.scrollY };
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
const photoButtons = (has, attr = 'data-edit') =>
  `<button type="button" class="link" ${attr}="photo">${has ? 'Change photo' : 'Add photo'}</button>${has ? `<button type="button" class="link quiet" ${attr}="nophoto">Remove</button>` : ''}`;

// Take or choose a picture (iOS offers camera or library) and shrink it to a small square
// thumbnail, so photos don't fill up the browser's storage.
function pickPhoto() {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*' });
    input.addEventListener('change', () => resolve(input.files?.[0] || null), { once: true });
    input.click();
  });
}

// whole: keep the whole picture (a receipt or a label to read later) at most `size` across,
// rather than a square thumbnail.
async function shrinkPhoto(file, size = 192, whole = false) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = rej;
      i.src = url;
    });
    const { naturalWidth: w, naturalHeight: h } = img;
    if (whole) {
      const s = Math.min(1, size / Math.max(w, h));
      const c = Object.assign(document.createElement('canvas'), { width: Math.round(w * s), height: Math.round(h * s) });
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.6);
    }
    const side = Math.min(w, h);
    const c = Object.assign(document.createElement('canvas'), { width: size, height: size });
    c.getContext('2d').drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
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

// Opened and expiration on the item page: for all of them at once, or, when there are several,
// for each one separately. The page's choices live in ui.editor.dates and ui.editor.each.
const OPEN_DAYS = [2, 3, 5, 7, 10, 14, 21, 30, 60, 90, 180, 365];
const daysText = (n) => (n % 365 === 0 ? `${n / 365} year${n > 365 ? 's' : ''}` : n % 30 === 0 ? `${n / 30} month${n > 30 ? 's' : ''}`
  : n % 7 === 0 ? `${n / 7} week${n > 7 ? 's' : ''}` : `${n} day${n === 1 ? '' : 's'}`);
const dayText = (iso) => new Date(iso + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: iso.slice(0, 4) === todayIso().slice(0, 4) ? undefined : 'numeric' });
const MAX_EACH = 24;

// What the page's choices add up to, as an item the expiration helpers understand.
function draftOf(name) {
  const d = ui.editor.dates;
  const asStored = (u) => ({ opened: u.opened ? u.openedOn || 'yes' : '', useBy: u.useBy });
  return { name, openDays: Number(d.openDays) || 0, ...asStored(d), each: ui.editor.each?.map(asStored) };
}

// "Use by Nov 11: 1 week after opening, before its Mar 1 expiration date."
function goodNote(it, u) {
  const days = openDaysOf(it);
  const until = goodUntil(it, u);
  if (u.opened && !isDay(u.opened) && days) return `Add the date it was opened to count the ${daysText(days)} it lasts once open.`;
  if (isDay(u.opened) && !days && !u.useBy) return 'Choose how long it lasts once opened to work out when to use it by.';
  if (!until) return '';
  const fromOpen = isDay(u.opened) && days ? plusDays(u.opened, days) : '';
  const left = Math.round((new Date(until + 'T00:00') - new Date(todayIso() + 'T00:00')) / 864e5);
  const when = left < 0 ? `Expired ${dayText(until)}` : left === 0 ? 'Use today' : `Use by ${dayText(until)}`;
  if (until !== fromOpen) return `${when}: the expiration date.`;
  return `${when}: ${daysText(days)} after opening${u.useBy && u.useBy > until ? `, before its ${dayText(u.useBy)} expiration date` : ''}.`;
}

// The short form, for each one's card: "Use by Nov 11".
function goodShort(it, u) {
  const until = goodUntil(it, u);
  if (!until) return '';
  const left = Math.round((new Date(until + 'T00:00') - new Date(todayIso() + 'T00:00')) / 864e5);
  return left < 0 ? 'Expired' : left === 0 ? 'Use today' : `Use by ${dayText(until)}`;
}

const openedPick = (attr, on) => `<select ${attr}><option value="">Not opened</option><option value="1" ${on ? 'selected' : ''}>Opened</option></select>`;

function datesHtml(item, n) {
  const d = ui.editor.dates;
  const each = ui.editor.each;
  const word = item.unit || 'one';
  const today = todayIso();
  const draft = draftOf(item.name);
  const anyOpen = each ? each.some((u) => u.opened) : d.opened;
  const usualOpen = openLife(item.name);
  const usual = item.shelfLife || suggestShelfLife(item.name, item.location);
  const openRow = `<div class="row2" ${anyOpen ? '' : 'hidden'}>
      <label>Left in the open ${esc(word)}<select name="level">${LEVELS.map(([v, t]) => `<option value="${v}" ${v === d.level ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <label>Lasts once opened<select data-d="openDays"><option value="">${usualOpen ? `Usually ${daysText(usualOpen)}` : 'Not sure'}</option>${OPEN_DAYS.map((n) => `<option value="${n}" ${String(n) === d.openDays ? 'selected' : ''}>${daysText(n)}</option>`).join('')}</select></label>
    </div>`;
  if (each) {
    const name = (i) => `${item.unit ? esc(sentenceCase(item.unit)) : 'No.'} ${i + 1}`;
    return `<div class="each-head"><span class="label">Each ${esc(word)} separately</span><button type="button" class="link small" data-edit="same">Same for all</button></div>
      ${each.map((u, i) => `<div class="unit-card" data-unit="${i}">
        <div class="unit-head"><b>${name(i)}</b><span class="meta">${esc(goodShort(draft, draft.each[i]))}</span></div>
        <div class="row2">
          <label>Opened${openedPick('data-u="opened"', u.opened)}</label>
          <label ${u.opened ? '' : 'hidden'}>Date opened<input type="date" data-u="openedOn" value="${esc(u.openedOn)}" max="${today}"></label>
        </div>
        <label>Expiration date<input type="date" data-u="useBy" value="${esc(u.useBy)}"></label>
      </div>`).join('')}
      ${openRow}`;
  }
  return `<div class="row2">
      <label>Opened${openedPick('data-d="opened"', d.opened)}</label>
      <label ${d.opened ? '' : 'hidden'}>Date opened <span class="opt">(optional)</span><input type="date" data-d="openedOn" value="${esc(d.openedOn)}" max="${today}"></label>
    </div>
    ${openRow}
    <label>Expiration date <span class="opt">(optional)</span><input type="date" data-d="useBy" value="${esc(d.useBy)}"></label>
    <div class="quick-dates">
      ${[[3, '+3 days'], [7, '1 week'], [14, '2 weeks'], [30, '1 month']].map(([n, t]) => `<button type="button" data-days="${n}">${t}</button>`).join('')}
      ${usual ? `<button type="button" data-days="${usual}" class="usual">Usually ${usual} days</button>` : ''}
      <button type="button" data-days="clear">Clear</button>
    </div>
    <p class="note good-note" id="goodNote">${esc(goodNote(draft, draft))}</p>
    ${n >= 2 && n <= MAX_EACH ? `<button type="button" class="link small each-link" data-edit="each">Not all the same? Set each ${esc(word)} separately</button>` : ''}`;
}

// Reads what's on the page into ui.editor.dates and ui.editor.each.
function readDates(form) {
  $('#editError', form).textContent = '';
  const box = $('#dates', form);
  const d = ui.editor.dates;
  const field = (k) => box.querySelector(`[data-d="${k}"]`);
  if (field('opened')) {
    d.opened = field('opened').value === '1';
    d.openedOn = field('openedOn').value;
    d.useBy = field('useBy').value;
  }
  d.level = form.level.value;
  d.openDays = field('openDays').value;
  ui.editor.each?.forEach((u, i) => {
    const card = box.querySelector(`[data-unit="${i}"]`);
    if (!card) return;
    u.opened = card.querySelector('[data-u="opened"]').value === '1';
    u.openedOn = card.querySelector('[data-u="openedOn"]').value;
    u.useBy = card.querySelector('[data-u="useBy"]').value;
  });
}

// How many there are in all, going by the page: the count here plus any kept elsewhere.
function pageCount(form) {
  syncSpots(form);
  const elsewhere = Object.entries(ui.editor.spots).filter(([pl]) => pl !== form.location.value).reduce((a, [, n]) => a + n, 0);
  return Math.ceil(round((parseFloat(form.qty.value) || 0) + elsewhere));
}

// One for all: any of them opened counts, from the earliest date; the soonest expiration wins.
function sameForAll() {
  const each = ui.editor.each;
  const d = ui.editor.dates;
  d.opened = each.some((u) => u.opened);
  d.openedOn = each.filter((u) => u.opened).map((u) => u.openedOn).filter(Boolean).sort()[0] || '';
  d.useBy = each.map((u) => u.useBy).filter(Boolean).sort()[0] || '';
  ui.editor.each = null;
}

// Redraws the dates after a change; the cards follow the count (the last ones go first).
function redrawDates(form) {
  const n = pageCount(form);
  const each = ui.editor.each;
  if (each) {
    each.length = Math.min(each.length, n);
    while (each.length < n) each.push({ opened: false, openedOn: '', useBy: freshDate({ ...ui.editor.item, name: form.name.value }) });
    if (n < 2) sameForAll();
  }
  const d = ui.editor.dates;
  if (!(each ? each.some((u) => u.opened) : d.opened)) d.level = '';
  const unit = form.unit.value === '__new' ? ui.editor.item.unit : singularUnit(form.unit.value); // "Other…" is still asking
  $('#dates', form).innerHTML = datesHtml({ ...ui.editor.item, name: form.name.value, unit, location: form.location.value }, n);
}

// Notes only, so typing a date doesn't redraw the field under your finger.
function updateGoodNotes(form) {
  const draft = draftOf(form.name.value);
  const note = $('#goodNote', form);
  if (note) note.textContent = goodNote(draft, draft);
  draft.each?.forEach((u, i) => {
    const meta = $(`[data-unit="${i}"] .unit-head .meta`, form);
    if (meta) meta.textContent = goodShort(draft, u);
  });
}

function renderEditor() {
  const { item, isNew, hint, similar, fromScan } = ui.editor;
  ui.editor.spots ??= { ...(item.spots || {}) };
  const lowOpts = [['', 'Never'], ...[0, 1, 2, 3, 5, 10].map((n) => [n, n === 0 ? 'When out' : `${n} left`])];
  // A part-used package shows as a whole count plus how much is left in the open one.
  const main = countAt(item, item.location);
  const frac = round(main % 1);
  const count = frac ? Math.ceil(main) : main;
  const level = frac ? LEVELS.slice(1).reduce((best, l) => (Math.abs(l[0] - frac) < Math.abs(best[0] - frac) ? l : best))[0] : '';
  // A part-used one counts as opened even if that was never recorded.
  ui.editor.dates ??= {
    opened: Boolean(item.opened || frac), openedOn: isDay(item.opened) ? item.opened : '', useBy: item.useBy || '', level, openDays: item.openDays ? String(item.openDays) : '',
  };
  ui.editor.each ??= item.each ? item.each.map((u) => ({ opened: Boolean(u.opened), openedOn: isDay(u.opened) ? u.opened : '', useBy: u.useBy || '' })) : null;
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
    ${isNew && !fromScan ? '<div id="dupHint"></div>' : ''}
    <div class="row2">
      <label>How many
        <div class="stepper big"><button type="button" data-step="-1" aria-label="One less">−</button><input name="qty" type="number" inputmode="decimal" step="any" min="0" value="${count}" aria-label="Quantity"><button type="button" data-step="1" aria-label="One more">+</button></div>
      </label>
      <label>Counted in ${unitPicker(item.unit)}</label>
    </div>
    <div class="row2" id="wherePick">${wherePickers(item.location, item.shelf || '')}</div>
    <div id="spots">${spotsHtml(item.location)}</div>
    <label>Buy at ${storePicker(item.store || '')}</label>
    <div id="dates">${datesHtml(item, Math.ceil(round(item.qty)))}</div>
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
    <p class="note error" id="editError" role="alert"></p>
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
  if (step) {
    form.qty.value = Math.max(0, round((parseFloat(form.qty.value) || 0) + Number(step.dataset.step)));
    readDates(form);
    redrawDates(form);
  }
  const act = e.target.closest('[data-edit]')?.dataset.edit;
  // Several of one thing: one card each, starting from what's set for all of them (that's the
  // open one, if one is open, and the rest sealed).
  if (act === 'each') {
    readDates(form);
    const d = ui.editor.dates;
    ui.editor.each = Array.from({ length: pageCount(form) }, (_, i) => ({ opened: i === 0 && d.opened, openedOn: i === 0 && d.opened ? d.openedOn : '', useBy: d.useBy }));
    redrawDates(form);
  }
  if (act === 'same') {
    readDates(form);
    sameForAll();
    redrawDates(form);
  }
  if (act === 'cancel') closeEditor(null);
  if (act === 'link') linkScannedTo(byId(e.target.closest('[data-id]').dataset.id));
  if (act === 'open-existing') {
    const existing = byId(e.target.closest('[data-id]').dataset.id);
    closeEditor(null);
    if (existing) openEditor(existing);
  }
  const days = e.target.closest('[data-days]')?.dataset.days;
  if (days) {
    $('[data-d="useBy"]', form).value = days === 'clear' ? '' : dateIn(Number(days));
    readDates(form);
    updateGoodNotes(form);
  }
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
  if (spotStep || spotDel) {
    readDates(form);
    redrawDates(form);
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
  // Opening or counting shows and hides fields; anything else only changes the notes.
  if (e.target.closest('#dates') || e.target.matches('[name="qty"], [name="unit"], [data-spot], [data-add-spot]')) {
    readDates(form);
    if (e.target.matches('[data-d="opened"], [data-u="opened"], [name="qty"], [name="unit"], [data-spot], [data-add-spot]')) redrawDates(form);
    else updateGoodNotes(form);
  }
  if (e.target.name === 'location' || e.target.name === 'shelf') {
    const sel = e.target;
    const was = form.location.dataset.prev;
    let pl = form.location.value;
    // A different place starts with no spot; going back to where it was brings its spot back.
    let sp = sel.name === 'shelf' ? sel.value : pl === ui.editor.item.location ? ui.editor.item.shelf || '' : '';
    if (sel.value === '__new') {
      const typed = prompt(sel.name === 'location' ? 'New place (e.g. Basement, Hall closet)' : `New spot in the ${was.toLowerCase()} (e.g. Shelf 2, Top drawer, Bin A)`)?.trim();
      if (sel.name === 'location') ({ place: pl, spot: sp } = typed ? parseWhere(typed) : { place: '', spot: '' });
      else [pl, sp] = [was, tidySpot(typed || '')];
      if (!pl || (sel.name === 'shelf' && !sp)) {
        sel.value = sel.dataset.prev; // cancelled
        return;
      }
      // Typing a spot you already have picks that one.
      sp = spotsIn(pl).find((s) => s.toLowerCase() === sp.toLowerCase()) || sp;
      addSpot(pl, sp);
    }
    $('#wherePick', form).innerHTML = wherePickers(pl, sp);
    const moved = pl !== was;
    // Making another place the main one folds its count into the main count.
    if (moved) {
      syncSpots(form);
      if (pl in ui.editor.spots) {
        form.qty.value = round((parseFloat(form.qty.value) || 0) + ui.editor.spots[pl]);
        delete ui.editor.spots[pl];
      }
      redrawSpots(form);
      if (ui.editor.photo === undefined && !ui.editor.item.image) showEditorPhoto(form);
    }
  }
});

$('#main').addEventListener('input', (e) => {
  const form = e.target.closest('#editForm');
  if (form && ui.editor && e.target.matches('#dates input')) {
    readDates(form);
    updateGoodNotes(form);
  }
  if (!form || e.target.name !== 'name' || !ui.editor) return;
  if (ui.editor.photo === undefined && !ui.editor.item.image) showEditorPhoto(form);
  showDupHint(form);
});

// Adding by hand something already tracked would split its count in two: offer the existing one.
function showDupHint(form) {
  const box = $('#dupHint', form);
  if (!box) return;
  const name = form.name.value.trim();
  const same = name.length > 1 ? matchExact(name, state.items)?.item : null;
  box.innerHTML = same
    ? `<div class="suggest"><span>You already have <b>${esc(same.name)}</b> · ${same.qty > 0 ? esc(qtyText(same)) : 'out'} in the ${esc(same.location.toLowerCase())}</span>
       <button type="button" class="btn small primary" data-edit="open-existing" data-id="${same.id}">Open it</button></div>`
    : '';
}

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
  readDates(form);
  const d = ui.editor.dates;
  const today = todayIso();
  const opens = ui.editor.each ? ui.editor.each.filter((u) => u.opened).map((u) => u.openedOn) : d.opened ? [d.openedOn] : [];
  if (opens.some((day) => day > today)) {
    $('#editError', form).textContent = 'A date opened can’t be in the future.';
    return $('#dates', form).scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  checkpoint();
  const qtyBefore = item.qty;
  const useByBefore = item.each ? '' : item.useBy;
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
    shelf: form.shelf.value,
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
  if (d.openDays) item.openDays = Number(d.openDays);
  else delete item.openDays;
  const each = ui.editor.each;
  if (each && each.length >= 2) {
    item.each = each.map((u) => ({ opened: u.opened ? u.openedOn || 'yes' : '', useBy: u.useBy }));
  } else {
    delete item.each;
    if (d.useBy !== (useByBefore || '')) {
      if (d.useBy) setUseBy(item, d.useBy);
      else {
        item.useBy = '';
        item.noUseBy = true; // cleared on purpose: don't fill it in again on the next purchase
      }
    }
    if (d.opened) item.opened = d.openedOn || 'yes';
    else delete item.opened;
  }
  for (const pl of placesOf(item)) if (!prefs.places.includes(pl)) prefs.places.push(pl);
  if (item.shelf && !spotsIn(item.location).includes(item.shelf)) prefs.subPlaces[item.location] = [...spotsIn(item.location), item.shelf];
  savePrefs();
  // Restocking clears a list request; just editing other details doesn't.
  if (item.qty > qtyBefore && item.qty > (item.low ?? -1)) item.need = false;
  if (item.store && !prefs.stores.includes(item.store)) {
    prefs.stores.push(item.store);
    savePrefs();
  }
  const saved = isNew ? item : keepTheirs(state.items, ui.editor.before, item);
  if (isNew) state.items.push(item);
  else state.items = state.items.some((i) => i.id === item.id) ? state.items.map((i) => (i.id === item.id ? saved : i)) : [...state.items, saved];
  ui.flash = saved.id;
  save();
  closeEditor({ item: saved, note: isNew ? `New · ${qtyText(saved)}` : 'Saved' });
  if (!fromScan) toast(isNew ? `Added ${saved.name}` : 'Saved', { undo: true });
});

// Who's signed in on this phone, with the way in or out.
function accountMenu() {
  const info = syncInfo();
  if (!info.configured) return '';
  const acct = info.account;
  if (!acct) {
    return `<p class="menu-label">Account</p>
      <p class="menu-who">Not signed in. Sign in to share with your household and get back in on any phone.</p>
      <button data-menu="signin">Sign in</button>
      <button data-menu="signup">Create an account</button>`;
  }
  if (acct.guest) {
    return `<p class="menu-label">Account</p>
      <p class="menu-who">Using a guest sign-in from before accounts. Create an account to keep your household safe.</p>
      <button data-menu="signup">Create an account</button>
      <button data-menu="signin">Sign in to an account</button>`;
  }
  return `<p class="menu-label">Account</p>
    <p class="menu-who">Signed in as <b>${esc(acct.email)}</b></p>
    <button data-menu="signout">Sign out</button>`;
}

function openMenu() {
  openSheet(`
    <div class="sheet-head"><h2>Options</h2><button class="link" data-close>Done</button></div>
    <div class="menu">
      ${accountMenu()}
      <p class="menu-label">Add</p>
      <button data-menu="add">Add an item by hand</button>
      <button data-menu="paste">Paste a list</button>
      <p class="menu-label">Organize</p>
      <button data-menu="places">Places & spots</button>
      <button data-menu="stores">Stores</button>
      <button data-menu="rooms">Rooms on the House tab</button>
      <p class="menu-label">Sharing</p>
      <button data-menu="household">Household sharing${syncInfo().joined ? ' · On' : ''}</button>
      <button data-menu="siri">Set up “Hey Siri, Key Record”</button>
      <p class="menu-label">Settings</p>
      <button data-menu="badge">Use-soon count on app icon: ${prefs.badge ? 'On' : 'Off'}</button>
      <button data-menu="sound">Scan beep: ${prefs.sound ? 'On' : 'Off'}</button>
      <p class="menu-label">Your data</p>
      <button data-menu="trash">Recently deleted${trash.length ? ` · ${trash.length}` : ''}</button>
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
    <div class="sheet-head"><h2>Places & spots</h2><button class="link" data-close>Done</button></div>
    <p class="note">Where things are kept. Tap a place to add spots inside it, like shelves, drawers or bins. Use the arrows to change the order.</p>
    <ul class="list" style="margin-top:12px">${places
      .map((pl, i) => `<li class="item place-row">
        <button class="info" data-place-open="${esc(pl)}"><div class="name">${esc(pl)}</div><div class="meta">${count(pl)} item${count(pl) === 1 ? '' : 's'}${spotsIn(pl).length ? ` · ${spotsIn(pl).length} spot${spotsIn(pl).length === 1 ? '' : 's'}` : ''} ›</div></button>
        <button class="icon-btn" data-place-move="-1" data-place="${esc(pl)}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(pl)} up">↑</button>
        <button class="icon-btn" data-place-move="1" data-place="${esc(pl)}" ${i === places.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(pl)} down">↓</button>
        <button class="remove" data-place-del="${esc(pl)}" aria-label="Remove ${esc(pl)}"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button>
      </li>`)
      .join('')}</ul>
    <button class="add-row" data-place-add>+ Add a place</button>`);
}

function openSpots(place) {
  const spots = spotsIn(place);
  const count = (sp) => state.items.filter((i) => i.location === place && i.shelf === sp).length;
  openSheet(`
    <div class="sheet-head"><button class="link" data-place-back>‹ Places</button><h2>${esc(place)}</h2><button class="link" data-close>Done</button></div>
    <p class="note">Spots inside the ${esc(place.toLowerCase())}, like shelves, drawers or bins. Items show under their spot on the Stock tab. Tap a spot to rename it.</p>
    ${spots.length ? `<ul class="list" style="margin-top:12px">${spots
      .map((sp, i) => `<li class="item place-row">
        <button class="info" data-sub-rename="${esc(sp)}" data-sub-place="${esc(place)}"><div class="name">${esc(sp)}</div><div class="meta">${count(sp)} item${count(sp) === 1 ? '' : 's'}</div></button>
        <button class="icon-btn" data-sub-move="-1" data-sub="${esc(sp)}" data-sub-place="${esc(place)}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(sp)} up">↑</button>
        <button class="icon-btn" data-sub-move="1" data-sub="${esc(sp)}" data-sub-place="${esc(place)}" ${i === spots.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(sp)} down">↓</button>
        <button class="remove" data-sub-del="${esc(sp)}" data-sub-place="${esc(place)}" aria-label="Remove ${esc(sp)}"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button>
      </li>`)
      .join('')}</ul>` : ''}
    <button class="add-row" data-sub-add="${esc(place)}">+ Add a spot</button>
    <button class="link" data-place-rename="${esc(place)}" style="width:100%">Rename ${esc(place.toLowerCase())}</button>`);
}

function spotAction(e) {
  const t = (k) => e.target.closest(`[${k}]`);
  const place = t('data-sub-place')?.dataset.subPlace || t('data-sub-add')?.dataset.subAdd;
  if (t('data-sub-add')) {
    const name = sentenceCase(prompt(`Name a spot in the ${place.toLowerCase()} (e.g. Shelf 2, Top drawer, Bin A)`)?.trim() || '');
    if (name) addSpot(place, name);
  }
  const rename = t('data-sub-rename')?.dataset.subRename;
  if (rename) {
    const to = sentenceCase(prompt(`Rename “${rename}” to:`, rename)?.trim() || '');
    if (!to || to === rename) return;
    checkpoint();
    for (const it of state.items) if (it.location === place && it.shelf === rename) it.shelf = to;
    prefs.subPlaces[place] = [...new Set(spotsIn(place).map((sp) => (sp === rename ? to : sp)))];
    prefs.foldedSpots = prefs.foldedSpots.map((k) => (k === spotKey(place, rename) ? spotKey(place, to) : k));
  }
  const move = t('data-sub-move');
  if (move) {
    const list = [...spotsIn(place)];
    const i = list.indexOf(move.dataset.sub);
    const j = i + Number(move.dataset.subMove);
    [list[i], list[j]] = [list[j], list[i]];
    prefs.subPlaces[place] = list;
  }
  const del = t('data-sub-del')?.dataset.subDel;
  if (del) {
    const n = state.items.filter((i) => i.location === place && i.shelf === del).length;
    if (n && !confirm(`Remove ${del}? Its ${n} item${n === 1 ? '' : 's'} stay in the ${place.toLowerCase()}, just without a spot.`)) return;
    checkpoint();
    for (const it of state.items) if (it.location === place && it.shelf === del) it.shelf = '';
    prefs.subPlaces[place] = spotsIn(place).filter((sp) => sp !== del);
  }
  savePrefs();
  save();
  openSpots(place);
}

// Renaming into an existing place merges the two (and their spots).
function renamePlace(from, to) {
  if (prefs.subPlaces[from]) {
    prefs.subPlaces[to] = [...new Set([...spotsIn(to), ...prefs.subPlaces[from]])];
    delete prefs.subPlaces[from];
  }
  for (const it of state.items) {
    if (it.location === from) it.location = to;
    if (it.spots && from in it.spots) {
      it.spots[to] = round((it.spots[to] || 0) + it.spots[from]);
      delete it.spots[from];
    }
  }
  prefs.places = [...new Set(allLocations().map((pl) => (pl === from ? to : pl)))];
  prefs.folded = prefs.folded.map((pl) => (pl === from ? to : pl));
  prefs.foldedSpots = prefs.foldedSpots.map((k) => (k.startsWith(`${from}\t`) ? `${to}${k.slice(from.length)}` : k));
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
    savePrefs();
    save();
    return e.target.closest('[data-place-rename]').closest('#sheet').querySelector('[data-place-back]') ? openSpots(to) : openPlaces();
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
    // Its spots don't exist in the other place, so moved items lose them.
    for (const it of state.items) if (it.location === del) it.shelf = '';
    delete prefs.subPlaces[del];
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
  const acct = info.account;
  let body = '';
  if (!info.configured) {
    body = '<p class="note">Household sharing isn’t connected to its cloud database yet.</p>';
  } else if (!acct) {
    body = `<p class="note">Share one stock and shopping list with everyone in your home. Sign in or create an account first; it keeps your household private to the people you let in.</p>
      <div class="row-actions"><button class="btn" data-account="in">Sign in</button><button class="btn primary" data-account="up">Create account</button></div>`;
  } else {
    body = acct.guest
      ? `<div class="card guard"><h3>Protect your household</h3>
          <p>You joined before accounts existed. Create an account (or sign in to one) so you can get back in on any phone, and so only people with accounts can join.</p>
          <div class="row-actions"><button class="btn" data-account="in">I have an account</button><button class="btn primary" data-account="up">Create account</button></div></div>`
      : `<div class="account-row"><p class="note">Signed in as <b>${esc(acct.email)}</b></p><button class="btn small" data-hh="signout">Sign out</button></div>`;
    if (!info.joined) {
      body += `<p class="note">Start a household to share your stock and list, or join one with the code someone gave you.</p>
        <div class="row-actions"><button class="btn" data-hh="join">Join with a code</button><button class="btn primary" data-hh="create">Start a household</button></div>`;
    } else {
      body += `<p class="note">${esc(SYNC_WORDS[info.status] || '')}</p>
        <ul class="list members">${info.members.map((m) => `<li class="item">
          <div class="info"><div class="name">${esc(m.name)}${m.id === info.me ? ' (you)' : ''}</div><div class="meta">${m.role === 'owner' ? 'Owner' : 'Member'}${m.id === info.me ? ' · <button class="link small" data-hh="rename">Change my name</button>' : ''}</div></div>
          ${info.owner && m.id !== info.me ? `<button class="remove" data-hh-remove="${esc(m.id)}" aria-label="Remove ${esc(m.name)}"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button>` : ''}
        </li>`).join('')}</ul>
        <div class="card hh-code"><span class="label">Household code</span><b>${esc(info.code)}</b>
          <p>Others join from ⋯ → Household sharing → Join with a code, after signing in.${info.owner ? ' Give it only to people you want in; you can replace it any time.' : ''}</p>
          <div class="row-actions"><button class="btn small" data-hh="copy">Copy code</button>${info.owner ? '<button class="btn small" data-hh="newcode">New code</button>' : ''}</div></div>
        <button class="danger" data-hh="leave">Leave household</button>`;
    }
  }
  openSheet(`<div class="sheet-head"><h2>Household sharing</h2><button class="link" data-close>Done</button></div>${body}`);
}

async function householdAction(act, id) {
  const info = syncInfo();
  try {
    if (act === 'copy') {
      await navigator.clipboard?.writeText(info.code);
      return toast('Code copied');
    }
    if (act === 'signout') {
      if (!confirm('Sign out? This phone keeps its copy of everything but stops syncing until you sign in again.')) return;
      await signOut();
      toast('Signed out');
      return openHousehold();
    }
    if (act === 'remove') {
      const who = info.members.find((m) => m.id === id);
      if (!confirm(`Remove ${who?.name || 'this person'} from the household? They’ll keep their phone’s copy but stop seeing changes. Make a new code too if they have it.`)) return;
      await removeMember(id);
      toast(`Removed ${who?.name || 'them'}`);
      return openHousehold();
    }
    if (act === 'rename') {
      const name = prompt('Your first name — shown to others in the household', info.name || '')?.trim();
      if (!name) return;
      if (/^[0-9a-f]{8}$/i.test(name)) return toast('That looks like the household code — enter your first name instead.');
      await renameMe(name);
      toast('Name changed');
      return openHousehold();
    }
    if (act === 'newcode') {
      if (!confirm('Make a new code? The current one stops working; people already in stay in.')) return;
      const code = await newJoinCode();
      toast(`New code: ${code}`);
      return openHousehold();
    }
    if (act === 'leave') {
      if (!confirm('Leave the household? This phone keeps a copy of everything but stops syncing.')) return;
      await leaveHousehold();
      toast('Left the household');
      return openHousehold();
    }
    // Code first, then name (asking for the name first got codes typed into the name box).
    const code = act === 'join' ? prompt('Household code (8 letters and numbers)')?.trim() : null;
    if (act === 'join' && !code) return;
    const name = prompt('Your first name — shown to others in the household', info.name || '')?.trim();
    if (!name) return;
    if (/^[0-9a-f]{8}$/i.test(name)) return toast('That looks like the household code — enter your first name instead.');
    if (act === 'create') {
      toast('Setting up…');
      const newCode = await createHousehold(name);
      toast(`Household started. Code: ${newCode}`);
    } else {
      const keepMine = state.items.length ? confirm(`Also add the ${state.items.length} items on this phone to the household? Cancel to use only the household’s items (this phone’s go to Recently deleted).`) : false;
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

// ---------- Sign in / create account (a full page, so the iPhone keyboard behaves) ----------

function openAccount(mode) {
  closeSheet();
  ui.account = { mode };
  render();
  scrollTo(0, 0);
}

function closeAccount() {
  ui.account = null;
  render();
}

function renderAccount() {
  const up = ui.account.mode === 'up';
  const guest = syncInfo().account?.guest;
  return `<form class="form editor" id="accountForm" novalidate>
    <div class="page-head">
      <button type="button" class="link" data-account-act="cancel">Cancel</button>
      <h2>${up ? 'Create account' : 'Sign in'}</h2>
      <button type="submit" class="link strong">${up ? 'Create' : 'Sign in'}</button>
    </div>
    <p class="note" style="margin-top:14px">${guest
      ? 'Your household and everything in it moves to this account; nothing needs setting up again.'
      : up ? 'An account keeps your household private and lets you sign in on any phone.' : 'Signing in brings back your household on this phone.'}</p>
    ${up ? `<label>First name<input name="name" autocomplete="given-name" value="${esc(syncInfo().name || '')}" placeholder="Shown to others in your household"></label>` : ''}
    <label>Email<input name="email" type="email" inputmode="email" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="you@example.com"></label>
    <label>Password<input name="password" type="password" autocomplete="${up ? 'new-password' : 'current-password'}" minlength="6" placeholder="${up ? 'At least 6 characters' : ''}" enterkeyhint="go"></label>
    <p class="note error" id="accountError" role="alert"></p>
    <button class="primary" type="submit">${up ? 'Create account' : 'Sign in'}</button>
    <button type="button" class="link" data-account-act="switch" style="width:100%">${up ? 'Already have an account? Sign in' : 'New here? Create an account'}</button>
    ${up ? '' : '<p class="note" style="text-align:center">Forgot your password? Ask your household’s owner to remove your old account, then create a new one and join with the code.</p>'}
  </form>`;
}

async function submitAccount(form) {
  const up = ui.account.mode === 'up';
  const email = form.email.value.trim();
  const password = form.password.value;
  const name = up ? form.name.value.trim() : '';
  const show = (msg) => ($('#accountError', form).textContent = msg);
  if (up && !name) return show('Add your first name.');
  if (!/^\S+@\S+\.\S+$/.test(email)) return show('Add your email address.');
  if (password.length < 6) return show('Use a password of at least 6 characters.');
  const submit = form.querySelector('.primary');
  submit.disabled = true;
  show('');
  try {
    const wasJoined = syncInfo().joined;
    const household = await authenticate(up ? 'up' : 'in', email, password, name);
    document.activeElement?.blur?.();
    ui.account = null;
    if (household && !wasJoined) {
      const keepMine = state.items.length ? confirm(`Also add the ${state.items.length} items on this phone to your household? Cancel to use only the household’s items (this phone’s go to Recently deleted).`) : false;
      await useHousehold(household, keepMine);
    }
    render();
    toast(up ? 'Account created' : 'Signed in');
    openHousehold();
  } catch (err) {
    submit.disabled = false;
    show(err.message || 'Couldn’t reach the server — check your connection.');
  }
}

$('#main').addEventListener('click', (e) => {
  if (!e.target.closest('#accountForm')) return;
  const act = e.target.closest('[data-account-act]')?.dataset.accountAct;
  if (act === 'cancel') closeAccount();
  if (act === 'switch') {
    ui.account.mode = ui.account.mode === 'up' ? 'in' : 'up';
    $('#main').innerHTML = renderAccount();
  }
});
$('#main').addEventListener('submit', (e) => {
  if (e.target.id !== 'accountForm') return;
  e.preventDefault();
  submitAccount(e.target);
});

// Written without sending: for changes that came from the household, or stamps made while sending.
const persistOnly = (why) => writeState(why);

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
    <p class="note">Then say “Hey Siri, Key Record” and speak, e.g. “used two cans of tomatoes”. It opens in Safari, so first open Key Record in Safari once and sign in there (⋯ → Household sharing) so both stay in step.</p>`);
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

// Everything: items, belongings, and the lists of stores, places, spots and rooms.
function exportBackup() {
  const backup = { version: APP_VERSION, saved: new Date().toISOString(), items: state.items, assets: state.assets, settings: sharedSettings() };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `key-record-${todayIso()}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Restoring adds back what's missing and brings back older copies only where the backup's is
// newer; nothing here now (or anything someone in the household added since) is removed.
async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
    if (!Array.isArray(data.items)) throw new Error('not a backup');
  } catch {
    return toast("That file isn't a Key Record backup");
  }
  const records = [...data.items, ...(Array.isArray(data.assets) ? data.assets : [])].filter((r) => r && r.id && r.name !== undefined);
  const here = new Map(allRecords().map((r) => [r.id, r]));
  const back = records.filter((r) => !here.has(r.id) || (r.updated || 0) > (here.get(r.id).updated || 0));
  const settings = data.settings || {};
  if (!back.length && !Object.keys(settings).length) return toast('Everything in that backup is already here');
  const added = back.filter((r) => !here.has(r.id)).length;
  if (!confirm(`Restore from this backup? ${added} missing thing${added === 1 ? '' : 's'} come${added === 1 ? 's' : ''} back${back.length > added ? ` and ${back.length - added} get${back.length - added === 1 ? 's' : ''} the backup’s newer details` : ''}. Nothing you have now is removed.`)) return;
  checkpoint('all');
  const restored = new Map(back.map((r) => [r.id, { ...r, updated: Date.now() }]));
  const all = [...allRecords().map((r) => restored.get(r.id) || r), ...[...restored.values()].filter((r) => !here.has(r.id))];
  state.items = all.filter((r) => !isAsset(r));
  state.assets = all.filter(isAsset);
  // Lists: anything in the backup that's missing here is added.
  for (const key of ['stores', 'places', 'rooms']) if (Array.isArray(settings[key])) prefs[key] = [...new Set([...prefs[key], ...settings[key]])];
  if (settings.subPlaces && typeof settings.subPlaces === 'object') {
    for (const [pl, spots] of Object.entries(settings.subPlaces)) if (Array.isArray(spots)) prefs.subPlaces[pl] = [...new Set([...spotsIn(pl), ...spots])];
  }
  savePrefs();
  save();
  toast('Backup restored', { undo: true });
}

function loadSample() {
  checkpoint();
  const inDays = dateIn;
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
    s('Duct tape', 2, 'roll', 'Garage', { shelf: 'Shelf 1' }),
    s('AA batteries', 8, '', 'Garage', { low: 4, store: 'Costco', shelf: 'Shelf 2' }),
    s('Wood screws 1-5/8"', 1, 'box', 'Garage', { shelf: 'Shelf 2' }),
    s('Furnace filter 16x25x1', 0, '', 'Garage'),
  );
  addSpot('Garage', 'Shelf 1');
  addSpot('Garage', 'Shelf 2');
  save();
  toast('Sample items added', { undo: true });
}

// ---------- Voice ----------

let rec = null;

function openVoice() {
  openSheet(`
    <div class="voice">
      <div class="sheet-head"><h2>${ui.view === 'shop' ? 'What do you need?' : 'Say what changed'}</h2><button class="link" data-close>Done</button></div>
      ${ui.view === 'house' ? '<p class="note">Voice keeps stock and the shopping list up to date. Belongings on the House tab are added by hand or by scanning.</p>' : ''}
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
        <button type="button">Add coffee to the shopping list</button><button type="button">Take coffee off the list</button><button type="button">Add eggs to the Costco list</button><button type="button">Move tomatoes from the list to the pantry</button><button type="button">Milk expires Friday</button><button type="button">Opened the salsa</button><button type="button">Half a bottle of olive oil left</button><button type="button">Put 6 rolls of paper towels in the garage</button><button type="button">Put 3 boxes of screws on shelf 2 in the garage</button>
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
const scanHint = () => cam.task?.hint || MODE_HINTS[prefs.scanMode];

function setScanMode(mode) {
  prefs.scanMode = mode;
  savePrefs();
  document.querySelectorAll('.seg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === mode);
    b.setAttribute('aria-checked', b.dataset.mode === mode);
  });
  if (cam.running) hint(scanHint());
}

// task: scanning for something other than stock, without the Add/Use/Check modes —
// { house: true, hint } adds to the House tab; { fill(text), typeInstead(), hint } reads one
// code (a model or serial number) into a field and closes.
async function openScanner(task = null) {
  cam.task = task;
  $('#scanner').classList.toggle('task', Boolean(task));
  $('#typeCodeBtn').textContent = task?.fill ? 'Type it instead' : 'Type a barcode instead';
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
    hint(scanHint());
  } catch (e) {
    const typeIt = task?.fill ? 'type it in' : 'type the barcode';
    hint(e?.name === 'NotAllowedError' ? `Camera access is off — allow it in Settings, or ${typeIt}.` : `No camera here — ${typeIt} instead.`);
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
  handleCode(code, String(text).trim());
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
  cam.task = null;
  $('#scanner').classList.remove('task');
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
  const task = cam.task;
  if (task?.fill) {
    closeScanner();
    return task.typeInstead?.();
  }
  const code = normCode(prompt('Type the barcode number') || '');
  if (!code) return;
  cam.lastCode = code;
  cam.lastSeen = performance.now();
  handleCode(code);
}

// raw: the code exactly as read (a serial number keeps its leading zeros and letters).
async function handleCode(code, raw = code) {
  if (cam.task?.fill) {
    scanFeedback();
    const { fill } = cam.task;
    closeScanner();
    return fill(raw);
  }
  if (cam.task?.house) return houseScan(code, raw);
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
        <div class="meta">${esc(item.location)}${useByOf(item) ? ` · ${useByHtml(item)}` : ''}</div>
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
  if (!it && ['inc', 'dec', 'edit', 'list'].includes(act)) {
    $('#scanCard').innerHTML = '';
    return resumeScanning();
  }
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
    it.updated = Date.now();
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
    if (it?.title) hit = { name: it.title, brand: it.brand || '', model: it.model || '', size: it.size || '', image: it.images?.[0] || '', category: it.category || '', kind: 'product' };
  }
  lookupCache.set(code, hit);
  return hit;
}

// ---------- House ----------
//
// Belongings kept for the record rather than counted: appliances, furniture, electronics and the
// like, with what a repair, a warranty claim or an insurance claim asks for (model and serial
// numbers, when it was bought and for how much, a receipt or label photo) and upkeep reminders.
// They sync with the household as items of kind 'asset' but live on their own tab.

const CATEGORIES = ['Appliances', 'Electronics', 'Furniture', 'Home systems', 'Tools', 'Outdoor & garden', 'Decor & art', 'Jewelry & valuables', 'Sports & hobbies', 'Other'];
const CATEGORY_HINTS = [
  [/\b(fridge|refrigerator|freezer|dishwasher|washer|washing machine|dryer|oven|range|stove|cooktop|microwave|range hood|toaster|blender|mixer|kettle|coffee maker|espresso|vacuum|dehumidifier|humidifier|air fryer|disposal)\b/, 'Appliances'],
  [/\b(furnace|boiler|water heater|water softener|air conditioner|ac unit|heat pump|hvac|thermostat|sump pump|generator|garage door opener|smoke (detector|alarm)|carbon monoxide|alarm system|solar)\b/, 'Home systems'],
  [/\b(tv|television|laptop|computer|macbook|imac|desktop|monitor|ipad|tablet|iphone|phone|camera|speaker|sonos|headphones|airpods|console|playstation|xbox|nintendo|router|modem|printer|projector|receiver|soundbar)\b/, 'Electronics'],
  [/\b(sofa|couch|sectional|loveseat|chairs?|table|desk|bed|mattress|dresser|nightstand|bookcase|bookshelf|cabinet|wardrobe|armoire|ottoman|bench|stool|rug|crib|futon|recliner)\b/, 'Furniture'],
  [/\b(drill|saw|sander|grinder|wrench|toolbox|tools?|ladder|compressor|welder|nailer|workbench|socket set)\b/, 'Tools'],
  [/\b(mower|trimmer|edger|leaf blower|snow ?blower|grill|bbq|smoker|patio|hose|wheelbarrow|chainsaw|pressure washer)\b/, 'Outdoor & garden'],
  [/\b(painting|artwork|sculpture|vase|mirror|lamp|chandelier|clock)\b/, 'Decor & art'],
  [/\b(ring|necklace|bracelet|earrings|jewelry|jewellery|diamond|pearls?)\b/, 'Jewelry & valuables'],
  [/\b(bike|bicycle|kayak|treadmill|peloton|weights|golf|skis?|snowboard|guitar|piano|violin)\b/, 'Sports & hobbies'],
];
const guessCategory = (text) => CATEGORY_HINTS.find(([re]) => re.test(String(text || '').toLowerCase()))?.[1] || '';
const ASSET_EMOJI = [
  [/\b(fridge|refrigerator|freezer)\b/, '🧊'], [/\bdishwasher\b/, '🍽️'], [/\b(washer|washing machine|dryer)\b/, '🧺'],
  [/\b(oven|range|stove|cooktop|microwave|air fryer|toaster)\b/, '🍳'], [/\b(coffee|espresso|kettle)\b/, '☕'], [/\bvacuum\b/, '🧹'],
  [/\b(tv|television|projector)\b/, '📺'], [/\b(laptop|computer|macbook|imac|desktop|monitor)\b/, '💻'], [/\b(phone|iphone|ipad|tablet)\b/, '📱'],
  [/\bcamera\b/, '📷'], [/\b(speaker|sonos|soundbar|headphones|airpods|receiver)\b/, '🔊'], [/\b(console|playstation|xbox|nintendo)\b/, '🎮'],
  [/\b(router|modem)\b/, '📶'], [/\bprinter\b/, '🖨️'], [/\b(sofa|couch|sectional|loveseat|recliner)\b/, '🛋️'], [/\b(bed|mattress|crib|futon)\b/, '🛏️'],
  [/\b(chairs?|stool|bench)\b/, '🪑'], [/\b(lamp|chandelier)\b/, '💡'], [/\b(furnace|boiler|water heater|fireplace)\b/, '🔥'],
  [/\b(air conditioner|ac unit|hvac|heat pump)\b/, '❄️'], [/\bthermostat\b/, '🌡️'], [/\b(smoke|carbon monoxide|alarm)\b/, '🚨'], [/\bladder\b/, '🪜'],
  [/\b(drill|saw|sander|grinder|wrench|toolbox|tools?)\b/, '🔧'], [/\b(mower|trimmer|blower|chainsaw)\b/, '🌱'], [/\b(grill|bbq|smoker)\b/, '🍖'],
  [/\b(bike|bicycle)\b/, '🚲'], [/\b(guitar|piano|violin)\b/, '🎸'], [/\b(ring|necklace|bracelet|earrings|jewelry|jewellery)\b/, '💍'],
  [/\b(watch|clock)\b/, '⌚'], [/\b(painting|artwork|sculpture)\b/, '🖼️'], [/\bmirror\b/, '🪞'], [/\b(table|desk)\b/, '🪵'],
  [/\b(dresser|cabinet|bookcase|bookshelf|wardrobe)\b/, '🗄️'],
];
const CATEGORY_EMOJI = {
  Appliances: '🔌', Electronics: '💻', Furniture: '🛋️', 'Home systems': '🏠', Tools: '🔧', 'Outdoor & garden': '🌿',
  'Decor & art': '🖼️', 'Jewelry & valuables': '💎', 'Sports & hobbies': '⚽', Other: '📦',
};
const assetEmoji = (a) => ASSET_EMOJI.find(([re]) => re.test(String(a.name || '').toLowerCase()))?.[1] || CATEGORY_EMOJI[a.category] || '📦';
const assetThumb = (a) =>
  `<div class="thumb" aria-hidden="true">${a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy">` : `<span class="emoji">${assetEmoji(a)}</span>`}</div>`;
const assetTile = (image, a) => (image ? `<img src="${esc(image)}" alt="">` : `<span class="emoji">${assetEmoji(a)}</span><span class="cam">📷</span>`);

// Typical upkeep, offered as one-tap reminders once the name says what it is: [task, every N months].
const CARE_HINTS = [
  [/\b(furnace|hvac|air handler|heat pump)\b/, [['Replace air filter', 3], ['Yearly service', 12]]],
  [/\b(air conditioner|ac unit)\b/, [['Yearly service', 12]]],
  [/\b(fridge|refrigerator)\b/, [['Replace water filter', 6], ['Clean coils', 12]]],
  [/\bdishwasher\b/, [['Clean the filter', 3]]],
  [/\bdryer\b/, [['Clean the dryer vent', 12]]],
  [/\b(washer|washing machine)\b/, [['Clean drum and door seal', 1]]],
  [/\bwater heater\b/, [['Flush the tank', 12]]],
  [/\bwater softener\b/, [['Add salt', 2]]],
  [/\b(range hood|hood)\b/, [['Clean grease filter', 3]]],
  [/\b(smoke|carbon monoxide)\b/, [['Test the alarm', 1], ['Replace battery', 12]]],
  [/\bsump pump\b/, [['Test the pump', 3]]],
  [/\b(fireplace|chimney)\b/, [['Chimney sweep', 12]]],
  [/\bgarage door\b/, [['Lubricate rollers and springs', 6]]],
  [/\bmattress\b/, [['Rotate', 6]]],
  [/\b(mower|snow ?blower|generator)\b/, [['Service before the season', 12]]],
  [/\bhumidifier\b/, [['Replace the pad', 12]]],
];
const CARE_EVERY = [1, 2, 3, 4, 6, 12, 24];
const everyText = (m) => (m === 1 ? 'every month' : m === 12 ? 'every year' : m === 24 ? 'every 2 years' : `every ${m} months`);
const HOUSE_SCAN = { house: true, hint: 'Scan the barcode on its box or manual — or the one by the serial number' };

const assetById = (id) => state.assets.find((a) => a.id === id);
const assetValue = (a) => (a.price || 0) * (a.qty || 1);
const assetText = (a) => [a.name, a.brand, a.model, a.serial, a.room, a.category, a.store, a.notes].join(' ').toLowerCase();
const money = (n) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
const tidyCode = (s) => String(s || '').trim().replace(/\s+/g, ' ');
// Two serial numbers are the same whatever their spacing, dashes or letter case.
const codeKey = (s) => s.toUpperCase().replace(/[\s-]/g, '');
// "S/N: 4AB12" read off a label → "4AB12" (only a label followed by a colon or #, or "S/N ").
const cleanCode = (s) => tidyCode(s).replace(/^(?:(?:s\/n|sn|ser(?:ial)?(?:\s*(?:no|number))?\.?|m\/n|mod(?:el)?(?:\s*(?:no|number))?\.?)\s*[:#]\s*|s\/n\s+)/i, '');

function newAsset(fields = {}) {
  return {
    id: uid(), kind: 'asset', name: '', room: '', category: '', brand: '', model: '', serial: '', qty: 1, bought: '', price: null,
    store: '', warranty: '', link: '', notes: '', image: '', doc: '', barcode: '', care: [], ...fields, updated: Date.now(),
  };
}

function allRooms() {
  return [...new Set([...prefs.rooms, ...state.assets.map((a) => a.room).filter(Boolean)])];
}

// "$1,299.99" → 1299.99; blank → null; anything else → NaN, so a typo is caught rather than saved.
function parsePrice(s) {
  const t = String(s || '').replace(/[$\s,]/g, '');
  if (!t) return null;
  return /^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(t) ? Number(t) : NaN;
}

function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return isoDate(new Date(y, m - 1 + n, Math.min(d, new Date(y, m + n, 0).getDate())));
}
const daysUntil = (iso) => Math.round((new Date(iso + 'T00:00') - new Date(todayIso() + 'T00:00')) / 864e5);
const shortDate = (iso, year = false) => new Date(iso + 'T00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(year && { year: 'numeric' }) });
const monthYear = (iso) => new Date(iso + 'T00:00').toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

// Upkeep comes due a set time after it was last done, or after the reminder was added.
const careDue = (c) => addMonths(c.last || c.from || todayIso(), c.every || 12);
function dueHtml(due) {
  const n = daysUntil(due);
  if (n < -30) return `<span class="bad">Overdue since ${shortDate(due)}</span>`;
  if (n < 0) return `<span class="bad">Overdue ${-n} day${n === -1 ? '' : 's'}</span>`;
  if (n === 0) return '<span class="bad">Due today</span>';
  if (n <= 14) return `<span class="warn">Due in ${n} day${n === 1 ? '' : 's'}</span>`;
  return `Next ${shortDate(due)}`;
}

// Upkeep due within two weeks (or overdue) and warranties ending within two months.
function attention() {
  const list = [];
  for (const a of state.assets) {
    for (const c of a.care || []) {
      const due = careDue(c);
      if (daysUntil(due) <= 14) list.push({ a, c, due });
    }
    if (a.warranty && daysUntil(a.warranty) >= 0 && daysUntil(a.warranty) <= 60) list.push({ a, due: a.warranty });
  }
  return list.sort((x, y) => x.due.localeCompare(y.due));
}

function assetRow(a, showRoom = false) {
  const made = [a.brand, a.model].filter(Boolean).join(' ');
  const covered = a.warranty && daysUntil(a.warranty) >= 0;
  const meta = [a.qty > 1 ? `×${a.qty}` : '', showRoom ? esc(a.room || 'No room set') : '', esc(made || a.category || ''), covered ? `Warranty to ${monthYear(a.warranty)}` : '']
    .filter(Boolean).join(' · ');
  return `<li class="item asset-row" data-asset-open="${a.id}" role="button" tabindex="0">
    ${assetThumb(a)}
    <div class="info"><div class="name">${esc(a.name)}</div>${meta ? `<div class="meta">${meta}</div>` : ''}</div>
    ${a.price != null ? `<span class="value">${money(assetValue(a))}</span>` : ''}
  </li>`;
}

function attentionList(due) {
  return `<h2 class="group"><span>Needs attention</span></h2><ul class="list house-list">${due
    .map(({ a, c, due: d }) => (c
      ? `<li class="item att-row">${assetThumb(a)}
          <button class="info" data-asset-open="${a.id}"><div class="name">${esc(c.task)}</div><div class="meta">${esc(a.name)} · ${dueHtml(d)}</div></button>
          <button class="btn small" data-care-done="${a.id}" data-care="${esc(c.id)}">Done</button></li>`
      : `<li class="item att-row">${assetThumb(a)}
          <button class="info" data-asset-open="${a.id}"><div class="name">${esc(a.name)}</div>
            <div class="meta"><span class="warn">Warranty ends ${shortDate(d)}</span> · ${daysUntil(d)} day${daysUntil(d) === 1 ? '' : 's'} left</div></button></li>`))
    .join('')}</ul>`;
}

function renderRoomChips() {
  const counts = {};
  state.assets.forEach((a) => (counts[a.room || ''] = (counts[a.room || ''] || 0) + 1));
  const rooms = [...allRooms(), ''].filter((r) => counts[r]);
  const due = attention().length;
  if (ui.room === 'attention' && !due) ui.room = 'All';
  if (ui.room !== 'All' && ui.room !== 'attention' && !counts[ui.room]) ui.room = 'All';
  const chip = (key, label, n, extra = '') =>
    `<button class="chip ${extra} ${ui.room === key ? 'on' : ''}" data-room="${esc(key)}" aria-pressed="${ui.room === key}">${esc(label)}${n ? `<small>${n}</small>` : ''}</button>`;
  $('#chips').innerHTML = rooms.length < 2 && !due ? '' : [
    chip('All', 'All', 0),
    due ? chip('attention', 'Needs attention', due, 'soon') : '',
    ...rooms.map((r) => chip(r, r || 'No room set', counts[r])),
  ].join('');
}

function renderHouse() {
  renderRoomChips();
  if (!state.assets.length) {
    return `<div class="empty">
      <div class="big">🏡</div>
      <h2>Your house, on record</h2>
      <p>Keep appliances, furniture, electronics and other belongings here with their model and serial numbers,
      receipts, warranties and upkeep, ready for a repair or an insurance claim.</p>
      <div class="buttons">
        <button class="btn primary" data-house="add">Add something</button>
        <button class="btn" data-house="scan">Scan a barcode</button>
      </div>
    </div>`;
  }
  const q = ui.hq.trim().toLowerCase();
  const byName = (x, y) => x.name.localeCompare(y.name);
  const add = `<button class="add-row" data-house="add">+ Add something</button>`;
  if (q) {
    const hits = state.assets.filter((a) => assetText(a).includes(q)).sort(byName);
    return hits.length
      ? `<ul class="list house-list" style="margin-top:12px">${hits.map((a) => assetRow(a, true)).join('')}</ul>${add}`
      : `<div class="empty"><p>Nothing in the house matches “${esc(ui.hq)}”.</p>
         <button class="btn primary" data-house="add-named">Add “${esc(ui.hq.trim())}”</button></div>`;
  }
  const due = attention();
  if (ui.room === 'attention') return attentionList(due);
  if (ui.room !== 'All') {
    const group = state.assets.filter((a) => (a.room || '') === ui.room).sort(byName);
    return `<ul class="list house-list" style="margin-top:12px">${group.map((a) => assetRow(a)).join('')}</ul>${add}`;
  }
  const total = state.assets.reduce((s, a) => s + assetValue(a), 0);
  const unpriced = state.assets.filter((a) => a.price == null).length;
  let html = `<div class="card house-sum">
      <div><b>${state.assets.length}</b> thing${state.assets.length === 1 ? '' : 's'} · <b>${money(total)}</b> recorded
        ${unpriced ? `<p>${unpriced === state.assets.length ? 'No prices yet' : `${unpriced} without a price`}</p>` : ''}</div>
      <button class="btn small" data-house="export">Share</button>
    </div>`;
  if (due.length) html += attentionList(due);
  for (const room of [...allRooms(), '']) {
    const group = state.assets.filter((a) => (a.room || '') === room);
    if (!group.length) continue;
    // Tap a room's heading to fold it away; like places, folding is per phone.
    const folded = prefs.foldedRooms.includes(room);
    html += `<h2 class="group"><button class="fold ${folded ? 'shut' : ''}" data-fold-room="${esc(room)}" aria-expanded="${!folded}">
        <span>${esc(room || 'No room set')}</span><span class="fold-meta">${folded ? `${group.length} thing${group.length === 1 ? '' : 's'}` : ''}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></span>
      </button></h2>${folded ? '' : `<ul class="list house-list">${group.sort(byName).map((a) => assetRow(a)).join('')}</ul>`}`;
  }
  return html + add;
}

// Clicks on the House tab, and on belongings shown in a Stock search. True when handled.
function houseClick(e) {
  if (e.target.closest('#assetForm')) return false;
  const done = e.target.closest('[data-care-done]');
  if (done) {
    careDone(assetById(done.dataset.careDone), done.dataset.care);
    return true;
  }
  const open = e.target.closest('[data-asset-open]');
  if (open) {
    const a = assetById(open.dataset.assetOpen);
    if (a) openAsset(a);
    return true;
  }
  const fold = e.target.closest('[data-fold-room]');
  if (fold) {
    const room = fold.dataset.foldRoom;
    prefs.foldedRooms = prefs.foldedRooms.includes(room) ? prefs.foldedRooms.filter((r) => r !== room) : [...prefs.foldedRooms, room];
    savePrefs();
    render();
    return true;
  }
  const act = e.target.closest('[data-house]')?.dataset.house;
  if (!act) return false;
  if (act === 'add') openAsset(newAsset({ room: ui.room !== 'All' && ui.room !== 'attention' ? ui.room : '' }), { isNew: true });
  if (act === 'add-named') openAsset(newAsset({ name: ui.hq.trim(), category: guessCategory(ui.hq) }), { isNew: true });
  if (act === 'scan') openScanner(HOUSE_SCAN);
  if (act === 'export') openHouseExport();
  return true;
}

function careDone(a, careId) {
  const c = a?.care?.find((x) => x.id === careId);
  if (!c) return;
  checkpoint('assets');
  c.last = todayIso();
  a.updated = Date.now();
  buzz(15);
  save();
  toast(`${c.task} done · next ${shortDate(careDue(c), true)}`, { undo: true });
}

function deleteAsset(a) {
  checkpoint('assets');
  state.assets = state.assets.filter((x) => x.id !== a.id);
  buzz(20);
  save();
  toast(`Deleted ${a.name}`, { undo: true });
}

// From the House tab: a product barcode is looked up and starts a new record; any other code
// (like the one by a serial number) starts one with that serial number. Something already
// recorded opens instead.
async function houseScan(code, raw) {
  scanFeedback();
  const known = state.assets.find((a) => a.barcode && normCode(a.barcode) === code);
  if (known) {
    closeScanner();
    toast(`Already in the house: ${known.name}`);
    return openAsset(known);
  }
  const product = /^\d{8,14}$/.test(code);
  let info = null;
  if (product) {
    pauseScanning();
    const token = ++lookupToken;
    $('#scanCard').innerHTML = `
      <div class="result"><div class="thumb" aria-hidden="true">🔎</div>
        <div class="info"><div class="name">Looking it up…</div><div class="skeleton" style="margin-top:8px;width:70%"></div></div></div>
      <div class="result-actions"><button class="btn" data-scan="cancel">Cancel</button></div>`;
    info = await lookupBarcode(code);
    if (token !== lookupToken) return;
  }
  closeScanner();
  const name = info?.name || '';
  openAsset(newAsset({
    name, brand: info?.brand || '', model: info?.model || '', image: info?.image || '',
    barcode: product ? code : '', serial: product ? '' : cleanCode(raw), category: guessCategory(`${name} ${info?.category || ''}`),
  }), {
    isNew: true,
    hint: !product ? `Read ${cleanCode(raw)} — it’s in Serial number below. Check it matches the label.`
      : info ? 'Found online. Check the details, then add the serial number.' : 'Not found online — fill in what you know.',
  });
}

// ---------- House: the page for one belonging ----------

function openAsset(asset, opts = {}) {
  if (!asset) return;
  ui.assetEditor = { asset, before: slim(asset), ...opts, scrollY: window.scrollY };
  $('#toast').hidden = true;
  render();
  $('#main').innerHTML = renderAssetEditor();
  updateAssetNotes($('#assetForm'));
  window.scrollTo(0, 0);
}

function closeAsset() {
  const ed = ui.assetEditor;
  if (!ed) return;
  ui.assetEditor = null;
  document.activeElement?.blur?.();
  render();
  window.scrollTo(0, ed.scrollY);
}

const codeField = (name, value, label) => `<div class="code-field">
    <input name="${name}" class="code" value="${esc(value)}" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="done">
    <button type="button" class="scan-mini" data-scan-into="${name}" aria-label="Scan the ${label} barcode"><svg viewBox="0 0 24 24"><path d="M3 7V4h3M18 4h3v3M21 17v3h-3M6 20H3v-3M7 8v8M10 8v8M13 8v8M16.5 8v8"/></svg></button>
  </div>`;

const careRow = (c) => `<div class="care-row" data-care-id="${esc(c.id)}" data-from="${esc(c.from || todayIso())}">
    <input class="care-task" value="${esc(c.task)}" placeholder="What needs doing" aria-label="Upkeep task" autocomplete="off" enterkeyhint="done">
    <button type="button" class="remove" data-care-del aria-label="Remove this reminder"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button>
    <label>Every<select class="care-every">${CARE_EVERY.map((m) => `<option value="${m}" ${m === c.every ? 'selected' : ''}>${m === 1 ? 'Month' : m === 12 ? 'Year' : m === 24 ? '2 years' : `${m} months`}</option>`).join('')}</select></label>
    <label>Last done<input type="date" class="care-last" value="${esc(c.last || '')}" max="${todayIso()}"></label>
    <button type="button" class="link small" data-care-today>Today</button>
  </div>`;

function careSuggestHtml(text, have) {
  const t = String(text || '').toLowerCase();
  const taken = new Set(have.map((x) => x.toLowerCase()));
  const tips = CARE_HINTS.filter(([re]) => re.test(t)).flatMap(([, tasks]) => tasks).filter(([task]) => !taken.has(task.toLowerCase()));
  return tips.length
    ? `<div class="quick-dates care-suggest">${tips.map(([task, every]) => `<button type="button" data-care-suggest="${esc(task)}" data-every="${every}">+ ${esc(task)}, ${everyText(every)}</button>`).join('')}</div>`
    : '';
}

const docHtml = (doc) => (doc
  ? `<div class="doc-row"><button type="button" class="doc-tile" data-asset="doc-view" aria-label="See the receipt or label photo"><img src="${esc(doc)}" alt=""></button>
      <div class="photo-actions"><button type="button" class="link" data-asset="doc">Replace</button><button type="button" class="link quiet" data-asset="nodoc">Remove</button></div></div>`
  : '<button type="button" class="add-row doc-add" data-asset="doc">+ Photo of the receipt or label</button>');

function renderAssetEditor() {
  const { asset: a, isNew, hint } = ui.assetEditor;
  const today = todayIso();
  const stores = [...new Set([...state.assets.map((x) => x.store).filter(Boolean), ...prefs.stores])];
  const category = a.category || guessCategory(a.name) || 'Other';
  const manual = [a.brand, a.model].filter(Boolean).join(' ');
  return `<form class="form editor" id="assetForm" novalidate>
    <div class="page-head">
      <button type="button" class="link" data-asset="cancel">Cancel</button>
      <h2>${isNew ? 'Add to the house' : 'Details'}</h2>
      <button type="submit" class="link strong">Save</button>
    </div>
    <div class="photo-row">
      <button type="button" class="photo-tile" data-asset="photo" aria-label="${a.image ? 'Change photo' : 'Add a photo'}">${assetTile(a.image, a)}</button>
      <div class="photo-side">
        ${hint ? `<p class="note">${esc(hint)}</p>` : ''}
        <div class="photo-actions">${photoButtons(Boolean(a.image), 'data-asset')}</div>
      </div>
    </div>
    <label>Name<input name="name" value="${esc(a.name)}" placeholder="e.g. Dishwasher, Sofa, Laptop" autocomplete="off" enterkeyhint="done"></label>
    <div class="row2">
      <label>Room ${selectPicker('room', ['', ...allRooms()], a.room || '', { label: 'Room', text: (v) => v || 'Not set', other: { label: '+ New room…', ask: 'Room name (e.g. Guest room, Attic)' } })}</label>
      <label>Type<select name="category">${CATEGORIES.map((c) => `<option ${c === category ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    </div>
    <div class="row2 wide-first">
      <label>Brand<input name="brand" value="${esc(a.brand)}" autocomplete="off" enterkeyhint="done"></label>
      <label>How many
        <div class="stepper big"><button type="button" data-step="-1" aria-label="One less">−</button><input name="qty" type="number" inputmode="numeric" min="1" step="1" value="${a.qty || 1}" aria-label="How many"><button type="button" data-step="1" aria-label="One more">+</button></div>
      </label>
    </div>

    <p class="form-section">For repairs and claims</p>
    <label>Model number${codeField('model', a.model, 'model number')}</label>
    <label>Serial number${codeField('serial', a.serial, 'serial number')}</label>
    <p class="note">Usually on a label inside the door, on the back or underneath. Scan the barcode next to it, or on iPhone tap the box, then Scan Text, to read it off the label.</p>

    <p class="form-section">Purchase & warranty</p>
    <div class="row2">
      <label>Bought on<input name="bought" type="date" value="${esc(a.bought)}" max="${today}"></label>
      <label>Price paid<input name="price" inputmode="decimal" value="${a.price != null ? a.price : ''}" placeholder="$" autocomplete="off" enterkeyhint="done"></label>
    </div>
    <p class="note" id="priceNote"></p>
    <label>Bought at<input name="store" value="${esc(a.store)}" list="assetStores" autocomplete="off" enterkeyhint="done"></label>
    <datalist id="assetStores">${stores.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
    <label>Warranty until<input name="warranty" type="date" value="${esc(a.warranty)}"></label>
    <div class="quick-dates">${[1, 2, 3, 5].map((y) => `<button type="button" data-warranty="${y}">${y} year${y === 1 ? '' : 's'}</button>`).join('')}<button type="button" data-warranty="clear">Clear</button></div>
    <p class="note" id="warrantyNote"></p>
    <span class="label">Receipt or label</span>
    <div id="docBox">${docHtml(a.doc)}</div>

    <p class="form-section">Upkeep</p>
    <div id="careList">${(a.care || []).map(careRow).join('')}</div>
    <div id="careSuggest">${careSuggestHtml(a.name, (a.care || []).map((c) => c.task))}</div>
    <button type="button" class="add-row" data-care-add>+ Add a reminder</button>

    <p class="form-section">Notes</p>
    <label>Manual or support link<input name="link" type="url" inputmode="url" value="${esc(a.link)}" placeholder="https://" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    <div class="manual-links">
      ${a.link ? `<a class="link small" href="${esc(a.link)}" target="_blank" rel="noopener">Open the link ↗</a>` : ''}
      ${manual ? `<a class="link small" href="https://www.google.com/search?q=${encodeURIComponent(`${manual} manual`)}" target="_blank" rel="noopener">Find the ${esc(manual)} manual ↗</a>` : ''}
    </div>
    <label>Notes<textarea name="notes" rows="3" placeholder="Paint colour, who installed it, what the warranty covers…">${esc(a.notes)}</textarea></label>
    <p class="note error" id="assetError" role="alert"></p>
    <button class="primary" type="submit">${isNew ? 'Add to the house' : 'Save'}</button>
    ${isNew ? '' : `<button type="button" class="danger" data-asset="delete">Delete</button>
      <p class="note" style="text-align:center">Last changed ${ago(a.updated)}${a.by && syncInfo().joined ? ` by ${esc(a.by)}` : ''}</p>`}
  </form>`;
}

// The price total and the warranty quick picks explain themselves as the form changes.
function updateAssetNotes(form) {
  const qty = Math.max(1, parseInt(form.qty.value, 10) || 1);
  const price = parsePrice(form.price.value);
  const note = $('#priceNote', form);
  note.classList.toggle('error', Number.isNaN(price));
  note.textContent = Number.isNaN(price) ? 'Numbers only, like 1299.99'
    : price != null && qty > 1 ? `That’s for each one: ${qty} × ${money(price)} = ${money(price * qty)}` : '';
  const { value: bought } = form.bought;
  const { value: warranty } = form.warranty;
  const bad = warranty && bought && warranty < bought;
  $('#warrantyNote', form).classList.toggle('error', Boolean(bad));
  $('#warrantyNote', form).textContent = bad ? 'The warranty ends before it was bought — check both dates.'
    : bought ? `Quick picks count from when it was bought, ${shortDate(bought, true)}.` : 'Quick picks count from today. Add when it was bought first, if you know.';
}

function showAssetPhoto(form) {
  const ed = ui.assetEditor;
  const image = ed.photo !== undefined ? ed.photo : ed.asset.image;
  const preview = { ...ed.asset, name: form.name.value, category: form.category.value };
  $('.photo-tile', form).innerHTML = assetTile(image, preview);
  $('.photo-row .photo-actions', form).innerHTML = photoButtons(Boolean(image), 'data-asset');
}

function redrawCareSuggest(form) {
  const have = [...form.querySelectorAll('.care-task')].map((i) => i.value.trim());
  $('#careSuggest', form).innerHTML = careSuggestHtml(form.name.value, have);
}

function addCareRow(form, c, focus = false) {
  $('#careList', form).insertAdjacentHTML('beforeend', careRow({ id: uid(), from: todayIso(), last: '', ...c }));
  redrawCareSuggest(form);
  if (focus) $('#careList .care-row:last-child .care-task', form).focus();
}

// Read a model or serial number off its barcode; the number read is shown so it can be checked.
function scanInto(form, field) {
  const label = field === 'model' ? 'model number' : 'serial number';
  openScanner({
    hint: `Point at the barcode by the ${label}`,
    fill: (text) => {
      const input = form[field];
      if (!input || !ui.assetEditor) return;
      input.value = cleanCode(text);
      input.classList.remove('just-read');
      void input.offsetWidth;
      input.classList.add('just-read');
      toast(`Read ${label} ${input.value} — check it against the label`);
    },
    typeInstead: () => form[field]?.focus(),
  });
}

$('#main').addEventListener('click', (e) => {
  const form = e.target.closest('#assetForm');
  const ed = ui.assetEditor;
  if (!form || !ed) return;
  const step = e.target.closest('[data-step]');
  if (step) {
    form.qty.value = Math.max(1, (parseInt(form.qty.value, 10) || 1) + Number(step.dataset.step));
    updateAssetNotes(form);
  }
  const act = e.target.closest('[data-asset]')?.dataset.asset;
  if (act === 'cancel') return closeAsset();
  if (act === 'delete') {
    if (!confirm(`Delete ${ed.asset.name}? Its details and photos go too.`)) return;
    closeAsset();
    return deleteAsset(ed.asset);
  }
  // New photos are kept aside until Save, so Cancel throws them away.
  if (act === 'photo' || act === 'doc') {
    pickPhoto().then(async (file) => {
      if (!file || ui.assetEditor !== ed) return;
      try {
        if (act === 'photo') {
          ed.photo = await shrinkPhoto(file);
          showAssetPhoto(form);
        } else {
          ed.doc = await shrinkPhoto(file, 1000, true);
          $('#docBox', form).innerHTML = docHtml(ed.doc);
        }
      } catch {
        toast('Couldn’t read that picture — try another one.');
      }
    });
  }
  if (act === 'nophoto') {
    ed.photo = '';
    showAssetPhoto(form);
  }
  if (act === 'nodoc') {
    ed.doc = '';
    $('#docBox', form).innerHTML = docHtml('');
  }
  if (act === 'doc-view') {
    const doc = ed.doc !== undefined ? ed.doc : ed.asset.doc;
    openSheet(`<div class="sheet-head"><h2>Receipt or label</h2><button class="link" data-close>Done</button></div><img class="doc-full" src="${esc(doc)}" alt="Receipt or label">`);
  }
  const years = e.target.closest('[data-warranty]')?.dataset.warranty;
  if (years) {
    form.warranty.value = years === 'clear' ? '' : addMonths(form.bought.value || todayIso(), 12 * Number(years));
    updateAssetNotes(form);
  }
  const into = e.target.closest('[data-scan-into]')?.dataset.scanInto;
  if (into) scanInto(form, into);
  if (e.target.closest('[data-care-add]')) addCareRow(form, { task: '', every: 12 }, true);
  const tip = e.target.closest('[data-care-suggest]');
  if (tip) addCareRow(form, { task: tip.dataset.careSuggest, every: Number(tip.dataset.every) });
  if (e.target.closest('[data-care-today]')) e.target.closest('.care-row').querySelector('.care-last').value = todayIso();
  if (e.target.closest('[data-care-del]')) {
    e.target.closest('.care-row').remove();
    redrawCareSuggest(form);
  }
});

$('#main').addEventListener('input', (e) => {
  const form = e.target.closest('#assetForm');
  const ed = ui.assetEditor;
  if (!form || !ed) return;
  if (e.target.name === 'name') {
    // The type follows the name until it's picked by hand.
    const guess = !ed.typePicked && !ed.asset.category && guessCategory(form.name.value);
    if (guess) form.category.value = guess;
    if (ed.photo === undefined && !ed.asset.image) showAssetPhoto(form);
    redrawCareSuggest(form);
  }
  if (e.target.classList.contains('care-task')) redrawCareSuggest(form);
  if (['qty', 'price', 'bought', 'warranty'].includes(e.target.name)) updateAssetNotes(form);
});

$('#main').addEventListener('change', (e) => {
  const form = e.target.closest('#assetForm');
  if (!form || !ui.assetEditor) return;
  if (e.target.name === 'category') {
    ui.assetEditor.typePicked = true;
    if (ui.assetEditor.photo === undefined && !ui.assetEditor.asset.image) showAssetPhoto(form);
  }
  if (['bought', 'warranty'].includes(e.target.name)) updateAssetNotes(form);
});

$('#main').addEventListener('submit', (e) => {
  if (e.target.id !== 'assetForm' || !ui.assetEditor) return;
  e.preventDefault();
  saveAsset(e.target);
});

// Checks what's easy to get wrong (a price typo, dates the wrong way round, a serial number
// already on something else) before saving.
function saveAsset(form) {
  const { asset, isNew, photo, doc } = ui.assetEditor;
  const fail = (msg, field) => {
    $('#assetError', form).textContent = msg;
    field?.focus();
    field?.scrollIntoView({ block: 'center' });
  };
  const name = form.name.value.trim();
  if (!name) return fail('Give it a name first.', form.name);
  const price = parsePrice(form.price.value);
  if (Number.isNaN(price)) return fail('Price paid: numbers only, like 1299.99.', form.price);
  const today = todayIso();
  const bought = form.bought.value;
  if (bought > today) return fail('“Bought on” is in the future — check the date.', form.bought);
  const warranty = form.warranty.value;
  if (warranty && bought && warranty < bought) return fail('The warranty ends before it was bought — check both dates.', form.warranty);
  let link = form.link.value.trim();
  if (link && !/^https?:\/\//i.test(link)) link = `https://${link}`;
  try {
    if (link) new URL(link);
  } catch {
    return fail('That link doesn’t look like a web address.', form.link);
  }
  const care = [...form.querySelectorAll('.care-row')]
    .map((row) => ({ id: row.dataset.careId, task: $('.care-task', row).value.trim(), every: Number($('.care-every', row).value), last: $('.care-last', row).value, from: row.dataset.from }))
    .filter((c) => c.task);
  const early = care.find((c) => c.last > today);
  if (early) return fail(`“${early.task}” was last done in the future — check the date.`, form.querySelector(`[data-care-id="${CSS.escape(early.id)}"] .care-last`));
  const serial = tidyCode(form.serial.value);
  const twin = serial && state.assets.find((x) => x.id !== asset.id && x.serial && codeKey(x.serial) === codeKey(serial));
  if (twin && !confirm(`${twin.name} already has serial number ${twin.serial}. Save it on this one too?`)) return fail('Check the serial number.', form.serial);
  checkpoint('assets');
  const room = form.room.value === '__new' ? '' : form.room.value;
  Object.assign(asset, {
    name, room, category: form.category.value, brand: form.brand.value.trim(), model: tidyCode(form.model.value), serial,
    qty: Math.max(1, parseInt(form.qty.value, 10) || 1), bought, price, store: form.store.value.trim(), warranty, link,
    notes: form.notes.value.trim(), care, updated: Date.now(),
  });
  if (photo !== undefined) asset.image = photo;
  if (doc !== undefined) asset.doc = doc;
  if (room && !prefs.rooms.includes(room)) {
    prefs.rooms.push(room);
    savePrefs();
  }
  const saved = isNew ? asset : keepTheirs(state.assets, ui.assetEditor.before, asset);
  if (isNew) state.assets.push(asset);
  else state.assets = state.assets.some((x) => x.id === asset.id) ? state.assets.map((x) => (x.id === asset.id ? saved : x)) : [...state.assets, saved];
  save();
  closeAsset();
  toast(isNew ? `Added ${asset.name}` : 'Saved', { undo: true });
}

// ---------- House: rooms and sharing ----------

function openRooms() {
  const rooms = allRooms();
  const count = (r) => state.assets.filter((a) => a.room === r).length;
  openSheet(`
    <div class="sheet-head"><h2>Rooms</h2><button class="link" data-close>Done</button></div>
    <p class="note">Rooms group things on the House tab. Tap one to rename it; use the arrows to change the order.</p>
    <ul class="list" style="margin-top:12px">${rooms
      .map((r, i) => `<li class="item place-row">
        <button class="info" data-room-rename="${esc(r)}"><div class="name">${esc(r)}</div><div class="meta">${count(r)} thing${count(r) === 1 ? '' : 's'}</div></button>
        <button class="icon-btn" data-room-move="-1" data-room-name="${esc(r)}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${esc(r)} up">↑</button>
        <button class="icon-btn" data-room-move="1" data-room-name="${esc(r)}" ${i === rooms.length - 1 ? 'disabled' : ''} aria-label="Move ${esc(r)} down">↓</button>
        <button class="remove" data-room-del="${esc(r)}" aria-label="Remove ${esc(r)}"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></button>
      </li>`)
      .join('')}</ul>
    <button class="add-row" data-room-add>+ Add a room</button>`);
}

function roomAction(e) {
  const t = (k) => e.target.closest(`[${k}]`);
  if (t('data-room-add')) {
    const name = sentenceCase(prompt('Name the room (e.g. Guest room, Attic)')?.trim() || '');
    if (name && !allRooms().includes(name)) prefs.rooms = [...allRooms(), name];
  }
  const rename = t('data-room-rename')?.dataset.roomRename;
  if (rename) {
    const to = sentenceCase(prompt(`Rename “${rename}” to:`, rename)?.trim() || '');
    if (!to || to === rename) return;
    if (allRooms().includes(to) && !confirm(`${to} already exists. Put everything from ${rename} there?`)) return;
    checkpoint('assets');
    for (const a of state.assets) {
      if (a.room !== rename) continue;
      a.room = to;
      a.updated = Date.now();
    }
    prefs.rooms = [...new Set(allRooms().map((r) => (r === rename ? to : r)))];
    prefs.foldedRooms = prefs.foldedRooms.map((r) => (r === rename ? to : r));
    if (ui.room === rename) ui.room = to;
  }
  const move = t('data-room-move');
  if (move) {
    const rooms = allRooms();
    const i = rooms.indexOf(move.dataset.roomName);
    const j = i + Number(move.dataset.roomMove);
    [rooms[i], rooms[j]] = [rooms[j], rooms[i]];
    prefs.rooms = rooms;
  }
  const del = t('data-room-del')?.dataset.roomDel;
  if (del) {
    const n = state.assets.filter((a) => a.room === del).length;
    if (n && !confirm(`Remove ${del}? Its ${n} thing${n === 1 ? '' : 's'} stay on the House tab under “No room set”.`)) return;
    checkpoint('assets');
    for (const a of state.assets) {
      if (a.room !== del) continue;
      a.room = '';
      a.updated = Date.now();
    }
    prefs.rooms = prefs.rooms.filter((r) => r !== del);
  }
  savePrefs();
  save();
  openRooms();
}

function openHouseExport() {
  openSheet(`
    <div class="sheet-head"><h2>Share the house inventory</h2><button class="link" data-close>Done</button></div>
    <p class="note">For an insurer, a move or your own records: every room with makes, model and serial numbers, purchase dates,
      prices and warranties. Photos stay in the app; to keep everything, use Back up to a file in the ⋯ menu.</p>
    <div class="row-actions"><button class="btn" data-house-export="text">As text</button><button class="btn primary" data-house-export="csv">As a spreadsheet</button></div>`);
}

async function exportHouse(kind) {
  const order = [...allRooms(), ''];
  const rows = [...state.assets].sort((a, b) => order.indexOf(a.room || '') - order.indexOf(b.room || '') || a.name.localeCompare(b.name));
  const today = todayIso();
  if (kind === 'csv') {
    const cols = [
      ['Name', 'name'], ['Room', 'room'], ['Type', 'category'], ['Brand', 'brand'], ['Model', 'model'], ['Serial number', 'serial'],
      ['Quantity', 'qty'], ['Bought on', 'bought'], ['Price each', (a) => (a.price != null ? a.price.toFixed(2) : '')],
      ['Total value', (a) => (a.price != null ? assetValue(a).toFixed(2) : '')], ['Bought at', 'store'], ['Warranty until', 'warranty'],
      ['Manual', 'link'], ['Notes', 'notes'],
    ];
    const cell = (v) => {
      const s = String(v ?? '');
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.map(([h]) => h), ...rows.map((a) => cols.map(([, k]) => (typeof k === 'function' ? k(a) : a[k])))]
      .map((r) => r.map(cell).join(','))
      .join('\r\n');
    const file = new File([csv], `house-inventory-${today}.csv`, { type: 'text/csv' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        return await navigator.share({ files: [file], title: 'House inventory' });
      } catch (err) {
        if (err.name === 'AbortError') return;
      }
    }
    const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: file.name });
    link.click();
    return setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  const total = rows.reduce((s, a) => s + assetValue(a), 0);
  const lines = [`House inventory · ${shortDate(today, true)}`, `${rows.length} thing${rows.length === 1 ? '' : 's'}${total ? ` · ${money(total)} recorded` : ''}`];
  let room = null;
  for (const a of rows) {
    if ((a.room || '') !== room) {
      room = a.room || '';
      lines.push('', (room || 'No room set').toUpperCase());
    }
    const bits = [
      a.qty > 1 ? `×${a.qty}` : '', [a.brand, a.model].filter(Boolean).join(' '), a.serial ? `S/N ${a.serial}` : '',
      a.bought ? `bought ${shortDate(a.bought, true)}` : '', a.price != null ? `${money(a.price)}${a.qty > 1 ? ' each' : ''}` : '',
      a.warranty ? `warranty to ${shortDate(a.warranty, true)}` : '',
    ].filter(Boolean);
    lines.push(`• ${a.name}${bits.length ? ` — ${bits.join(' · ')}` : ''}`);
  }
  shareText(lines.join('\n'), 'House inventory');
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
  const pickAll = e.target.closest('[data-pick-place]');
  if (pickAll) {
    const place = pickAll.dataset.pickPlace;
    const group = state.items.filter(inStock).filter((i) => shownIn(i).includes(place));
    const keys = group.map((i) => pickKey(i.id, place));
    const all = keys.every((k) => ui.select.has(k));
    group.forEach((i, n) => (all ? ui.select.delete(keys[n]) : ui.select.set(keys[n], { id: i.id, from: place })));
    if (!ui.select.size) ui.select = null;
    return render();
  }
  const foldSpot = e.target.closest('[data-fold-spot]');
  if (foldSpot) {
    const key = foldSpot.dataset.foldSpot;
    prefs.foldedSpots = prefs.foldedSpots.includes(key) ? prefs.foldedSpots.filter((k) => k !== key) : [...prefs.foldedSpots, key];
    savePrefs();
    return render();
  }
  const fold = e.target.closest('[data-fold]');
  if (fold) {
    const place = fold.dataset.fold;
    prefs.folded = prefs.folded.includes(place) ? prefs.folded.filter((p) => p !== place) : [...prefs.folded, place];
    savePrefs();
    return render();
  }
  if (houseClick(e)) return;
  const btn = e.target.closest('[data-act]');
  if (!btn || Date.now() - lastSwipeAt < 400) return;
  const item = byId(btn.closest('[data-id]')?.dataset.id);
  // Removed on another phone while it was on screen: just show the list as it is now.
  if (!item && ['inc', 'dec', 'count', 'pick', 'edit', 'got', 'unlist', 'pick-store', 'unbuy'].includes(btn.dataset.act)) return render();
  switch (btn.dataset.act) {
    case 'inc': return bump(item, 1, btn.dataset.place || null);
    case 'dec': return bump(item, -1, btn.dataset.place || null);
    case 'count': return setCount(item, btn.dataset.place || null);
    case 'paste': return openPaste();
    case 'pick': {
      const from = btn.closest('[data-place]').dataset.place || null;
      const key = pickKey(item.id, from);
      if (ui.select.has(key)) ui.select.delete(key);
      else ui.select.set(key, { id: item.id, from });
      if (!ui.select.size) ui.select = null;
      buzz(10);
      return render();
    }
    case 'edit': return openEditor(item);
    case 'got': return markBought(item);
    case 'unlist': return removeFromList(item);
    case 'pick-store': return openStorePicker(item);
    case 'unbuy': return unmarkBought(item);
    case 'add': return openEditor(newItem({ location: allLocations().includes(ui.loc) ? ui.loc : undefined, qty: 1 }), { isNew: true });
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
  }
});

// Press and hold a row, then drag it straight onto where it should go. Stock: a place or spot
// heading, any item already there, or a place chip at the top. Shopping list: a store heading or
// a store chip. The page scrolls when your finger nears the top or bottom. On Stock, letting go
// where you pressed starts picking several, and dragging any picked item takes them all.
// Moving before the hold completes is a normal scroll or swipe.
let drag = null;
const HOLD_MS = 350;

$('#main').addEventListener('pointerdown', (e) => {
  const row = e.target.closest('.shop-list .swipe-row.swipeable, .stock-list .swipe-row.draggable');
  if (!row || e.button > 0 || e.target.closest('.stepper')) return;
  drag = { row, id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, active: false, timer: setTimeout(startDrag, HOLD_MS) };
});

function startDrag() {
  if (!drag) return;
  swipe = null;
  const { row } = drag;
  row.querySelector('.item').style.transform = '';
  drag.active = true;
  drag.shop = Boolean(row.closest('.shop-list'));
  drag.item = byId(row.dataset.id);
  drag.from = row.dataset.place || null;
  if (ui.select) {
    const key = pickKey(drag.item.id, drag.from);
    if (!ui.select.has(key)) {
      ui.select.set(key, { id: drag.item.id, from: drag.from });
      row.querySelector('.pick-item')?.classList.add('picked');
    }
    drag.picks = [...ui.select.values()];
    drag.srcRows = [...document.querySelectorAll('.pick-item.picked')].map((b) => b.closest('.swipe-row'));
  } else {
    drag.picks = [{ id: drag.item.id, from: drag.from }];
    drag.srcRows = [row];
  }
  drag.srcRows.forEach((r) => r.classList.add('drag-src'));
  const n = new Set(drag.picks.map((p) => p.id)).size;
  drag.ghost = document.createElement('div');
  drag.ghost.className = 'drag-ghost';
  drag.ghost.innerHTML = `${drag.shop ? '' : thumb(drag.item, false)}<span class="ghost-text"><b>${n > 1 ? `${n} items` : esc(drag.item.name)}</b><small></small></span>`;
  document.body.append(drag.ghost);
  document.body.classList.add('dragging');
  try { row.setPointerCapture(drag.id); } catch {}
  showDropChips();
  moveGhost(drag.x, drag.y);
  updateDrop(drag.x, drag.y);
  drag.raf = requestAnimationFrame(autoScroll);
  buzz(25);
}

// Every place (or store) as a chip to drop on, including empty ones the list doesn't show.
function showDropChips() {
  if (drag.shop) {
    const nav = $('#main .shop-stores');
    if (!nav) return;
    const before = document.body.offsetHeight;
    nav.innerHTML = ['', ...allStores()].map((st) => `<button class="chip" data-drop-store="${esc(st)}">${esc(st || 'Any store')}</button>`).join('');
    nav.classList.add('dropping');
    if (scrollY > 0) scrollBy(0, document.body.offsetHeight - before);
  } else {
    // They wrap so every place is in reach; the list is nudged so it doesn't jump under your finger.
    const before = $('.top').offsetHeight;
    $('#chips').innerHTML = allLocations().map((pl) => `<button class="chip" data-drop-place="${esc(pl)}" data-drop-spot="">${esc(pl)}</button>`).join('');
    $('#chips').classList.add('dropping');
    if (scrollY > 0) scrollBy(0, $('.top').offsetHeight - before);
  }
}

function moveGhost(x, y) {
  // Float just above and left of the finger so what's under it stays visible.
  drag.ghost.style.transform = `translate(${Math.max(8, x - 56)}px, ${y - 78}px)`;
}

function dropAt(x, y) {
  const el = document.elementFromPoint(x, y)?.closest(drag.shop ? '[data-drop-store]' : '[data-drop-place]');
  if (!el) return null;
  const t = drag.shop ? { store: el.dataset.dropStore } : { place: el.dataset.dropPlace, spot: el.dataset.dropSpot || '' };
  // Dropping one item back where it already is does nothing, so it isn't offered.
  const { item, from, picks } = drag;
  if (drag.shop ? t.store === (item.store || '') : picks.length === 1 && t.place === (from || item.location) && t.spot === shelfAt(item, t.place)) return null;
  return t;
}

function updateDrop(x, y) {
  const t = dropAt(x, y);
  const key = t ? JSON.stringify(t) : '';
  if (key === drag.overKey) return;
  drag.overKey = key;
  drag.target = t;
  document.querySelectorAll('.drop-over').forEach((el) => el.classList.remove('drop-over'));
  if (t) {
    const sel = drag.shop ? `[data-drop-store="${CSS.escape(t.store)}"]` : `[data-drop-place="${CSS.escape(t.place)}"][data-drop-spot="${CSS.escape(t.spot)}"]`;
    document.querySelectorAll(sel).forEach((el) => el.classList.add('drop-over'));
    buzz(8);
  }
  drag.ghost.querySelector('small').textContent = t ? `→ ${drag.shop ? t.store || 'Any store' : t.place + (t.spot ? ` · ${t.spot}` : '')}` : '';
}

// Near the top or bottom of the list, scroll toward your finger; faster the closer it gets.
function autoScroll() {
  if (!drag?.active) return;
  const top = $('.top').getBoundingClientRect().bottom;
  const bottom = innerHeight - ($(ui.select ? '#dropTray' : '.tabbar')?.offsetHeight || 0);
  const y = drag.lastY;
  const edge = 70;
  let v = 0;
  if (y > top && y < top + edge) v = -(top + edge - y) / 4;
  else if (y > bottom - edge) v = (y - (bottom - edge)) / 4;
  if (v) {
    scrollBy(0, Math.max(-20, Math.min(20, v)));
    updateDrop(drag.lastX, drag.lastY);
  }
  drag.raf = requestAnimationFrame(autoScroll);
}

function endDrag() {
  if (!drag) return;
  clearTimeout(drag.timer);
  cancelAnimationFrame(drag.raf);
  drag.ghost?.remove();
  drag.srcRows?.forEach((r) => r.classList.remove('drag-src'));
  document.querySelectorAll('.drop-over').forEach((el) => el.classList.remove('drop-over'));
  document.body.classList.remove('dragging');
  $('#chips').classList.remove('dropping');
  const wasActive = drag.active;
  drag = null;
  if (!wasActive) return;
  const before = $('.top').offsetHeight;
  render(); // puts the chips back
  if (scrollY > 0) scrollBy(0, $('.top').offsetHeight - before);
}

// While picking several Stock items: a small bar in place of the tabs. Drag any picked item to
// move them all, or choose from Move to.
function renderPickBar() {
  const bar = $('#dropTray');
  if (!ui.select || ui.view !== 'stock' || ui.editor || ui.paste || ui.account) {
    bar.hidden = true;
    bar.innerHTML = '';
    bar.setAttribute('aria-hidden', 'true');
    return;
  }
  const n = new Set([...ui.select.values()].map((p) => p.id)).size;
  const dests = allLocations().flatMap((pl) => [[pl, ''], ...spotsIn(pl).map((sp) => [pl, sp])]);
  bar.innerHTML = `<button class="link" data-pick-done>Cancel</button>
    <p>${n} picked<span class="hint"> · drag to move</span></p>
    <label class="btn primary move-to">Move to…<select data-move-to aria-label="Move ${n === 1 ? 'it' : 'them'} to">
      <option value="" selected disabled>Move to…</option>
      ${dests.map(([p, sp]) => `<option value="${esc(p)}\t${esc(sp)}">${esc(sp ? `${p} · ${sp}` : p)}</option>`).join('')}
      <option value="__new">+ New place or spot…</option></select></label>`;
  bar.setAttribute('aria-hidden', 'false');
  bar.hidden = false;
  document.documentElement.style.setProperty('--tray-h', `${bar.offsetHeight}px`);
}

$('#dropTray').addEventListener('click', (e) => {
  if (ui.select && e.target.closest('[data-pick-done]')) {
    ui.select = null;
    render();
  }
});

$('#dropTray').addEventListener('change', (e) => {
  const sel = e.target.closest('[data-move-to]');
  if (!sel || !ui.select) return;
  const [place, spot = ''] = sel.value === '__new' ? ['__new'] : sel.value.split('\t');
  moveTo([...ui.select.values()], place, spot);
  if (ui.select) sel.value = ''; // a new place was cancelled
});

$('#main').addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 8) endDrag();
    return;
  }
  drag.lastX = e.clientX;
  drag.lastY = e.clientY;
  moveGhost(e.clientX, e.clientY);
  updateDrop(e.clientX, e.clientY);
});

$('#main').addEventListener('pointerup', (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  if (!drag.active) return endDrag();
  updateDrop(e.clientX, e.clientY);
  const { target, picks, item, from, shop } = drag;
  // Let go where you pressed (on Stock): start picking, with this one picked.
  if (!target && !shop && !ui.select && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 24) {
    ui.select = new Map([[pickKey(item.id, from), { id: item.id, from }]]);
    buzz(10);
  }
  lastSwipeAt = Date.now();
  endDrag();
  if (target && shop) assignStore(item, target.store);
  else if (target) moveTo(picks, target.place, target.spot);
});

$('#main').addEventListener('pointercancel', (e) => {
  if (drag && e.pointerId === drag.id) endDrag();
});

// While dragging, the page must not scroll under your finger.
document.addEventListener('touchmove', (e) => drag?.active && e.preventDefault(), { passive: false });
$('#main').addEventListener('contextmenu', (e) => e.target.closest('.shop-list, .stock-list') && e.preventDefault());

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
  const chip = e.target.closest('[data-loc], [data-room]');
  if (!chip) return;
  if (chip.dataset.room !== undefined) ui.room = chip.dataset.room;
  else ui.loc = chip.dataset.loc;
  render();
});

$('#search').addEventListener('input', (e) => {
  if (ui.view === 'house') ui.hq = e.target.value;
  else ui.q = e.target.value;
  render();
});

// ✕ empties the search in one tap. Holding off the press keeps the keyboard as it was:
// still up if you were typing, still down if you'd already put it away.
document.addEventListener('mousedown', (e) => {
  if (e.target.closest('.search-clear')) e.preventDefault();
});
$('#searchClear').addEventListener('click', () => {
  if (ui.view === 'house') ui.hq = '';
  else ui.q = '';
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

// On the House tab, Scan adds to the house instead of counting stock.
$('#scanBtn').addEventListener('click', () => openScanner(ui.view === 'house' ? HOUSE_SCAN : null));
$('#speakBtn').addEventListener('click', openVoice);
$('#menuBtn').addEventListener('click', openMenu);
$('#backdrop').addEventListener('click', closeSheet);

$('#sheet').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) return closeSheet();
  const restore = e.target.closest('[data-restore]')?.dataset.restore;
  if (restore) {
    restoreDeleted(restore);
    return openTrash();
  }
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
  const removeId = e.target.closest('[data-hh-remove]')?.dataset.hhRemove;
  if (removeId) return householdAction('remove', removeId);
  const acct = e.target.closest('[data-account]')?.dataset.account;
  if (acct) return openAccount(acct);
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
  const openPlace = e.target.closest('[data-place-open]')?.dataset.placeOpen;
  if (openPlace) return openSpots(openPlace);
  if (e.target.closest('[data-place-back]')) return openPlaces();
  if (e.target.closest('[data-sub-add], [data-sub-rename], [data-sub-move], [data-sub-del]')) return spotAction(e);
  if (e.target.closest('[data-place-add], [data-place-rename], [data-place-move], [data-place-del]')) return placeAction(e);
  if (e.target.closest('[data-room-add], [data-room-rename], [data-room-move], [data-room-del]')) return roomAction(e);
  const houseExport = e.target.closest('[data-house-export]')?.dataset.houseExport;
  if (houseExport) return exportHouse(houseExport);
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
  if (m === 'rooms') openRooms();
  if (m === 'paste') openPaste();
  if (m === 'household') openHousehold();
  if (m === 'siri') openSiriSetup();
  if (m === 'export') exportBackup();
  if (m === 'trash') openTrash();
  if (m === 'signin') openAccount('in');
  if (m === 'signup') openAccount('up');
  if (m === 'signout') householdAction('signout');
  if (m === 'import') $('#importFile').click();
  if (m === 'sample') loadSample();
  if (m === 'erase' && confirm(`Erase every item${state.assets.length ? ' and everything on the House tab' : ''}${syncInfo().joined ? ' for everyone in the household' : ''}? You can undo right after, or restore things from Recently deleted for ${TRASH_DAYS} days.`)) {
    checkpoint('all');
    state.items = [];
    state.assets = [];
    save('Erased');
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
  else if (ui.assetEditor) closeAsset();
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

// What's shared with the household besides the items: the lists of stores, places, spots and rooms.
const sharedSettings = () => ({ stores: prefs.stores, places: prefs.places, subPlaces: prefs.subPlaces, rooms: prefs.rooms });

// Offline (or out of the household) shows next to the title; changes stay safe on this phone.
function showSyncStatus(status) {
  const pill = $('#syncPill');
  pill.hidden = status !== 'offline';
  pill.textContent = 'Offline — changes are saved on this phone';
}
$('#syncPill').addEventListener('click', () => toast('Offline — everything you change is kept on this phone and shared as soon as it’s back online.'));

// The app open in another tab on this device changed something: pick it up here rather than
// writing over it later.
addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY && e.newValue) {
    try {
      const next = JSON.parse(e.newValue);
      const before = new Map(allRecords().map((r) => [r.id, JSON.stringify(r)]));
      const after = [...(next.items || []), ...(next.assets || [])];
      touchRemote([...after.filter((r) => before.get(r.id) !== JSON.stringify(r)).map((r) => r.id), ...[...before.keys()].filter((id) => !after.some((r) => r.id === id))]);
      state.items = (next.items || []).filter((r) => !isAsset(r));
      state.assets = [...(next.assets || []), ...(next.items || []).filter(isAsset)];
      known = new Set(allRecords().map((r) => r.id)); // that tab already noted anything it removed
      lastRecords = new Map(allRecords().map((r) => [r.id, r]));
      if (!ui.editor && !ui.assetEditor && !ui.paste && !ui.account) render();
    } catch {}
  }
  if (e.key === PREFS_KEY && e.newValue) {
    try { Object.assign(prefs, JSON.parse(e.newValue)); } catch {}
  }
  if (e.key === TRASH_KEY) trash = load(TRASH_KEY, []);
});

render();
// Tells the startup safety net in index.html that the app is running.
window.homestockReady = true;

// Join up with the household (if this phone is in one), then run anything Siri passed in.
Promise.race([
  initSync({
    // Belongings travel with the items, marked kind 'asset', and are sorted back out on arrival.
    items: allRecords,
    // Changes from the household: [{ id, item }] puts or replaces one, { id, item: null } removes it.
    applyRemote: (changes) => {
      touchRemote(changes.map((c) => c.id));
      const put = new Map(changes.filter((c) => c.item).map((c) => [c.id, c.item]));
      const drop = new Set(changes.map((c) => c.id));
      const all = allRecords();
      const had = new Set(all.map((r) => r.id));
      const next = all.filter((r) => !drop.has(r.id) || put.has(r.id)).map((r) => put.get(r.id) || r);
      for (const [id, r] of put) if (!had.has(id)) next.push(r);
      state.items = next.filter((r) => !isAsset(r));
      state.assets = next.filter(isAsset);
      updateBadge();
      persistOnly('Deleted on another phone');
    },
    replaceAll: (all) => {
      touchRemote(allRecords().map((r) => r.id));
      state.items = all.filter((r) => !isAsset(r));
      state.assets = all.filter(isAsset);
      persistOnly('Replaced by the household’s items');
      render();
    },
    settings: sharedSettings,
    applySettings: (data) => {
      if (Array.isArray(data.stores)) prefs.stores = data.stores;
      if (Array.isArray(data.places)) prefs.places = data.places;
      if (data.subPlaces && typeof data.subPlaces === 'object') prefs.subPlaces = data.subPlaces;
      if (Array.isArray(data.rooms)) prefs.rooms = data.rooms;
      writePrefs();
    },
    persist: persistOnly,
    onRemote: () => !ui.editor && !ui.assetEditor && !ui.paste && !ui.account && !drag?.active && !swipe?.active && render(),
    onStatus: showSyncStatus,
    onRemoved: () => toast('You’re no longer in the household. This phone keeps its copy of everything.'),
  }).catch(() => {}),
  new Promise((r) => setTimeout(r, 5000)),
]).then(runFromLink);
try { sessionStorage.removeItem('homestock.recovered'); } catch {}
