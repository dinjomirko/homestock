// Household sharing: every phone in a household sees the same items, stores and places.
//
// Local-first: the app keeps working from this device's copy (offline too). Changes are sent
// in the background; changes from others arrive live and replace the local copy of an item
// when they're newer. Each item is one row, so two people editing different things never
// clash; the same item edited on two phones keeps whichever change came last.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js?v=24';

const LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
const META_KEY = 'homestock.sync';

let app = null; // hooks into app.js, set by initSync
let sb = null;
let channel = null;
let pushing = false;
let again = false;
let retryTimer = 0;
let status = 'off'; // off | connecting | synced | offline
let members = [];
const meta = loadMeta(); // { householdId, code, name, sent: { [itemId]: fingerprint }, settingsSent }

function loadMeta() {
  try {
    return { sent: {}, ...JSON.parse(localStorage.getItem(META_KEY)) };
  } catch {
    return { sent: {} };
  }
}

function saveMeta() {
  try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch {}
}

// Fingerprint of what was last sent or received, so only real changes go out. Keys are sorted
// because the database hands objects back in its own key order.
const stable = (v) =>
  Array.isArray(v) ? v.map(stable)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]))
  : v;
const print = (obj) => JSON.stringify(stable(obj));

export const syncConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
export const syncInfo = () => ({ configured: syncConfigured(), joined: Boolean(meta.householdId), code: meta.code, name: meta.name, status, members });

function setStatus(s) {
  status = s;
  app?.onStatus?.(s);
}

async function client() {
  if (sb) return sb;
  const { createClient } = await import(LIB);
  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: true, storageKey: 'homestock.auth' } });
  return sb;
}

async function signedIn() {
  const c = await client();
  const { data } = await c.auth.getSession();
  if (data.session) return c;
  const { error } = await c.auth.signInAnonymously();
  if (error) throw new Error(error.message.includes('Anonymous') ? 'Anonymous sign-ins are turned off in Supabase.' : error.message);
  return c;
}

// app: { items(), setItems(items), settings(), applySettings(data), persist(), onRemote(), onStatus(s) }
let watching = false;
function watchConnection() {
  if (watching) return;
  watching = true;
  addEventListener('online', () => pull().catch(() => setStatus('offline')));
  document.addEventListener('visibilitychange', () => !document.hidden && meta.householdId && pull().catch(() => setStatus('offline')));
}

export async function initSync(hooks) {
  app = hooks;
  if (!syncConfigured() || !meta.householdId) return;
  watchConnection();
  try {
    setStatus('connecting');
    await signedIn();
    await pull();
    listen();
  } catch {
    setStatus('offline');
    pushSoon(15000);
  }
}

// Start a new household from this phone; its items become the household's.
export async function createHousehold(name) {
  const c = await signedIn();
  const { data, error } = await c.rpc('create_household', { member_name: name });
  if (error) throw new Error(error.message);
  Object.assign(meta, { householdId: data[0].household_id, code: data[0].code, name, sent: {}, settingsSent: null });
  saveMeta();
  await push();
  listen();
  watchConnection();
  await loadMembers();
  return meta.code;
}

// Join an existing household. keepMine: also share this phone's items; otherwise use only theirs.
export async function joinHousehold(code, name, keepMine) {
  const c = await signedIn();
  const { data, error } = await c.rpc('join_household', { join_code: code, member_name: name });
  if (error) throw new Error(error.message.includes('No household') ? 'No household with that code — check it and try again.' : error.message);
  Object.assign(meta, { householdId: data[0].household_id, code: data[0].code, name, sent: {}, settingsSent: null });
  saveMeta();
  if (!keepMine) app.setItems([]);
  await pull();
  listen();
  watchConnection();
  return meta.code;
}

export async function leaveHousehold() {
  try {
    const c = await client();
    const { data } = await c.auth.getUser();
    await c.from('members').delete().eq('household_id', meta.householdId).eq('user_id', data.user.id);
  } catch {}
  channel?.unsubscribe();
  channel = null;
  for (const k of ['householdId', 'code', 'settingsSent']) delete meta[k];
  meta.sent = {};
  saveMeta();
  members = [];
  setStatus('off');
}

async function loadMembers() {
  const { data } = await sb.from('members').select('name').eq('household_id', meta.householdId).order('joined_at');
  members = (data || []).map((m) => m.name || 'Someone');
}

// Bring in everything from the household, keeping whichever copy of each item is newer.
async function pull() {
  if (!meta.householdId) return;
  const c = await signedIn();
  const [{ data: rows, error }, { data: settings }] = await Promise.all([
    c.from('items').select('id, data, deleted').eq('household_id', meta.householdId),
    c.from('household_settings').select('data').eq('household_id', meta.householdId).maybeSingle(),
  ]);
  if (error) throw new Error(error.message);
  const items = app.items();
  const byId = new Map(items.map((i) => [i.id, i]));
  let changed = false;
  for (const row of rows) {
    const mine = byId.get(row.id);
    if (row.deleted) {
      if (mine && (mine.updated || 0) <= (row.data.updated || 0)) {
        byId.delete(row.id);
        changed = true;
      }
      meta.sent[row.id] = print({ deleted: true });
      continue;
    }
    if (!mine || (row.data.updated || 0) > (mine.updated || 0)) {
      byId.set(row.id, row.data);
      changed = true;
    }
    meta.sent[row.id] = print(row.data);
  }
  if (changed) app.setItems([...byId.values()]);
  if (settings?.data && Object.keys(settings.data).length) {
    app.applySettings(settings.data);
    meta.settingsSent = print(settings.data);
  }
  saveMeta();
  await loadMembers().catch(() => {});
  await push();
  if (changed) app.onRemote();
}

// Live changes from the rest of the household.
function listen() {
  if (channel || !meta.householdId) return;
  const filter = `household_id=eq.${meta.householdId}`;
  channel = sb
    .channel(`household-${meta.householdId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items', filter }, ({ new: row }) => {
      if (!row?.id) return;
      const fp = print(row.deleted ? { deleted: true } : row.data);
      if (meta.sent[row.id] === fp) return; // our own change coming back
      const items = app.items();
      const mine = items.find((i) => i.id === row.id);
      if (mine && (mine.updated || 0) >= (row.data.updated || 0)) return; // ours is as new or newer
      meta.sent[row.id] = fp;
      saveMeta();
      app.setItems(row.deleted ? items.filter((i) => i.id !== row.id) : mine ? items.map((i) => (i.id === row.id ? row.data : i)) : [...items, row.data]);
      app.onRemote(row.deleted ? null : row.data);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'household_settings', filter }, ({ new: row }) => {
      if (!row?.data || print(row.data) === meta.settingsSent) return;
      meta.settingsSent = print(row.data);
      saveMeta();
      app.applySettings(row.data);
      app.onRemote();
    })
    .subscribe((s) => {
      if (s === 'SUBSCRIBED') setStatus('synced');
      else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') setStatus('offline');
    });
}

// Called after every local save: send what changed shortly after (several quick taps go together).
export function pushSoon(delay = 600) {
  if (!meta.householdId) return;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => push().catch(() => {
    setStatus('offline');
    pushSoon(30000);
  }), delay);
}

async function push() {
  if (!meta.householdId) return;
  if (pushing) return void (again = true);
  pushing = true;
  try {
    const c = await signedIn();
    const items = app.items();
    const rows = [];
    let stamped = false;
    for (const it of items) {
      if (meta.sent[it.id] === print(it)) continue;
      // Stamp who changed it and when, so the newest copy wins everywhere.
      it.updated = Math.max(Date.now(), (it.updated || 0) + 1);
      it.by = meta.name;
      stamped = true;
      rows.push({ household_id: meta.householdId, id: it.id, data: it, deleted: false, updated_at: new Date().toISOString() });
    }
    const ids = new Set(items.map((i) => i.id));
    const gone = print({ deleted: true });
    for (const id of Object.keys(meta.sent)) {
      if (ids.has(id) || meta.sent[id] === gone) continue;
      rows.push({ household_id: meta.householdId, id, data: { id, updated: Date.now() }, deleted: true, updated_at: new Date().toISOString() });
    }
    if (stamped) app.persist();
    if (rows.length) {
      const { error } = await c.from('items').upsert(rows);
      if (error) throw new Error(error.message);
      for (const r of rows) meta.sent[r.id] = print(r.deleted ? { deleted: true } : r.data);
    }
    const settings = app.settings();
    if (print(settings) !== meta.settingsSent) {
      const { error } = await c.from('household_settings').upsert({ household_id: meta.householdId, data: settings, updated_at: new Date().toISOString() });
      if (error) throw new Error(error.message);
      meta.settingsSent = print(settings);
    }
    saveMeta();
    setStatus('synced');
  } finally {
    pushing = false;
    if (again) {
      again = false;
      pushSoon(0);
    }
  }
}
