// Household sharing: every phone in a household sees the same items, stores and places.
//
// Local-first: the app works from this phone's copy (offline too) and sends changes in the
// background; others' changes arrive live. Nothing is overwritten blindly. For every item (and
// for the shared settings) this phone remembers the household's copy it last agreed with — its
// base — and only writes when the household's copy is still that one. If someone else changed it
// in the meantime, the two are merged (merge.js) and written again, so both people's changes
// count. Deleting something someone else has since changed keeps their version.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js?v=41';
import { slim, fingerprint, print, mergeItem, mergeSettings, newest } from './merge.js?v=41';

const LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
const META_KEY = 'homestock.sync';

// Hooks into app.js, set by initSync: { items(), applyRemote([{id, item|null}]), replaceAll(items),
// settings(), applySettings(data), persist(), onRemote(), onStatus(status), onRemoved() }
let app = null;
let sb = null;
let channel = null;
let status = 'off'; // off | connecting | synced | offline
let members = []; // [{ id, name, role }]
let user = null; // the signed-in account (or a guest from before accounts existed)
let timer = 0;
let chain = Promise.resolve();
let store = globalThis.localStorage;
// { householdId, code, name, rows: { [id]: { at, v } }, settings: { at, v } }. `at` is the
// household copy's updated_at and `v` that copy, with photos reduced to a hash (null: deleted).
// Older versions kept only fingerprints (`sent`, `settingsSent`); those are read once, then dropped.
const meta = loadMeta();

function loadMeta() {
  try {
    return JSON.parse(store.getItem(META_KEY)) || {};
  } catch {
    return {};
  }
}

function saveMeta() {
  try { store.setItem(META_KEY, JSON.stringify(meta)); } catch {}
}

// Another tab of the app on this device moved things along: start from its notes.
globalThis.addEventListener?.('storage', (e) => {
  if (e.key !== META_KEY) return;
  for (const k of Object.keys(meta)) delete meta[k];
  Object.assign(meta, loadMeta());
});

// One thing at a time: pulls, pushes and live changes never interleave.
const run = (fn) => {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
};

// Timestamps come back from the database in a few spellings; compare them as instants.
const ts = (s) => (s ? Date.parse(String(s).replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1').replace(/([+-]\d\d)$/, '$1:00')) : NaN);
const sameAt = (a, b) => Boolean(a && b) && ts(a) === ts(b);
const stamp = (prev) => new Date(Math.max(Date.now(), (ts(prev) || 0) + 1)).toISOString();

// The account signed in on this phone, even before the connection is up (from the saved sign-in).
function savedUser() {
  try {
    const s = JSON.parse(store.getItem('homestock.auth'));
    return s?.user || s?.currentSession?.user || null;
  } catch {
    return null;
  }
}

export const syncConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
export const syncInfo = () => {
  const u = user || savedUser();
  return {
    configured: syncConfigured(),
    joined: Boolean(meta.householdId),
    code: meta.code,
    name: meta.name,
    status,
    members,
    account: u ? { email: u.email || '', guest: Boolean(u.is_anonymous) } : null,
    me: u?.id,
    owner: members.some((m) => m.id === u?.id && m.role === 'owner'),
  };
};

const FRIENDLY = [
  [/invalid login credentials/i, 'That email and password don’t match an account.'],
  [/already registered|already been registered/i, 'There’s already an account with that email — sign in instead.'],
  [/password should be at least/i, 'Use a password of at least 6 characters.'],
  [/unable to validate email|invalid format/i, 'That doesn’t look like an email address.'],
  [/signups not allowed/i, 'New accounts are turned off for this app.'],
  [/rate limit/i, 'Too many tries — wait a minute and try again.'],
];
const friendly = (msg) => FRIENDLY.find(([re]) => re.test(msg))?.[1] || msg;

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
  if (!data.session) throw new Error('Sign in first.');
  user = data.session.user;
  return c;
}

const hasSavedSession = () => {
  try { return Boolean(store.getItem('homestock.auth')); } catch { return false; }
};

// Start over with a household: nothing agreed on yet.
function startHousehold(h) {
  for (const k of Object.keys(meta)) delete meta[k];
  Object.assign(meta, { householdId: h.householdId, code: h.code, name: h.name, rows: {}, settings: null });
  saveMeta();
}

function stopHousehold() {
  channel?.unsubscribe();
  channel = null;
  for (const k of ['householdId', 'code', 'rows', 'settings', 'sent', 'settingsSent']) delete meta[k];
  saveMeta();
  members = [];
  setStatus('off');
}

// Create an account or sign in. A guest on this phone (from before accounts) hands its household
// and role over to the account, so nothing has to be set up again. Returns the account's
// household, if it has one.
export async function authenticate(kind, email, password, name = '') {
  const { createClient } = await import(LIB);
  const tmp = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'homestock.auth.tmp' },
  });
  const { data, error } = kind === 'up'
    ? await tmp.auth.signUp({ email, password, options: { data: { name } } })
    : await tmp.auth.signInWithPassword({ email, password });
  if (error) throw new Error(friendly(error.message));
  if (!data.session) throw new Error('Check your email to confirm the account, then sign in.');
  const c = await client();
  const current = (await c.auth.getSession()).data.session;
  if (current?.user?.is_anonymous && current.user.id !== data.user.id) {
    const { error: handOver } = await c.rpc('hand_over_membership', { new_user: data.user.id });
    if (handOver) throw new Error(friendly(handOver.message));
  }
  const { error: switchError } = await c.auth.setSession({ access_token: data.session.access_token, refresh_token: data.session.refresh_token });
  if (switchError) throw new Error(friendly(switchError.message));
  user = data.user;
  const { data: rows } = await c.from('members').select('household_id, name, households(code)').eq('user_id', user.id).order('joined_at');
  const h = rows?.[0];
  if (h && h.household_id === meta.householdId) await loadMembers().catch(() => {});
  return h ? { householdId: h.household_id, code: h.households.code, name: h.name || name } : null;
}

// After signing in on a phone that isn't in the household yet: start syncing it.
export async function useHousehold(h, keepMine) {
  startHousehold(h);
  if (!keepMine) app.replaceAll([]);
  await run(pull);
  listen();
  watchConnection();
}

// Stop syncing on this phone and sign out of it (only this phone, so it works offline too);
// this phone keeps its copy of everything.
export async function signOut() {
  stopHousehold();
  try { await (await client()).auth.signOut({ scope: 'local' }); } catch {}
  try { store.removeItem('homestock.auth'); } catch {}
  user = null;
}

export async function renameMe(name) {
  const c = await signedIn();
  const { error } = await c.from('members').update({ name }).eq('household_id', meta.householdId).eq('user_id', user.id);
  if (error) throw new Error(friendly(error.message));
  meta.name = name;
  saveMeta();
  await loadMembers();
}

// Owner only.
export async function removeMember(id) {
  const c = await signedIn();
  const { error } = await c.rpc('remove_member', { h: meta.householdId, member: id });
  if (error) throw new Error(friendly(error.message));
  await loadMembers();
}

export async function newJoinCode() {
  const c = await signedIn();
  const { data, error } = await c.rpc('new_join_code', { h: meta.householdId });
  if (error) throw new Error(friendly(error.message));
  meta.code = data;
  saveMeta();
  return data;
}

let watching = false;
function watchConnection() {
  if (watching) return;
  watching = true;
  globalThis.addEventListener?.('online', () => sync());
  globalThis.document?.addEventListener('visibilitychange', () => !document.hidden && sync());
}

// Catch up with the household and send anything waiting.
function sync() {
  if (!meta.householdId) return;
  run(pull).then(() => {
    listen();
    setStatus('synced');
  }, failed);
}

function failed(err) {
  if (err?.removed || !meta.householdId) return;
  setStatus('offline');
  pushSoon(30000);
}

export async function initSync(hooks) {
  app = hooks;
  if (!syncConfigured() || !hasSavedSession()) return;
  try {
    user = (await (await client()).auth.getSession()).data.session?.user || null;
  } catch {}
  if (!meta.householdId) return;
  watchConnection();
  setStatus('connecting');
  try {
    await run(pull);
    listen();
    setStatus('synced');
  } catch (err) {
    failed(err);
    if (meta.householdId) listen();
  }
}

// Start a new household from this phone; its items become the household's.
export async function createHousehold(name) {
  const c = await signedIn();
  const { data, error } = await c.rpc('create_household', { member_name: name });
  if (error) throw new Error(error.message);
  startHousehold({ householdId: data[0].household_id, code: data[0].code, name });
  await run(pull);
  listen();
  watchConnection();
  setStatus('synced');
  return meta.code;
}

// Join an existing household. keepMine: also share this phone's items; otherwise use only theirs.
export async function joinHousehold(code, name, keepMine) {
  const c = await signedIn();
  const { data, error } = await c.rpc('join_household', { join_code: code, member_name: name });
  if (error) throw new Error(error.message.includes('No household') ? 'No household with that code — check it and try again.' : error.message);
  startHousehold({ householdId: data[0].household_id, code: data[0].code, name });
  if (!keepMine) app.replaceAll([]);
  await run(pull);
  listen();
  watchConnection();
  setStatus('synced');
  return meta.code;
}

export async function leaveHousehold() {
  try {
    await (await signedIn()).rpc('leave_household', { h: meta.householdId });
  } catch {}
  stopHousehold();
}

async function loadMembers() {
  const { data, error } = await sb.from('members').select('user_id, name, role').eq('household_id', meta.householdId).order('joined_at');
  if (error) throw error;
  members = (data || []).map((m) => ({ id: m.user_id, name: m.name || 'Someone', role: m.role }));
}

// Taken out of the household by its owner: stop syncing, keep this phone's copy.
async function checkMembership() {
  await loadMembers();
  if (members.some((m) => m.id === user?.id)) return;
  stopHousehold();
  app.onRemoved?.();
  throw Object.assign(new Error('Removed from the household'), { removed: true });
}

// ---------- Bringing in the household's copies ----------

const localById = () => new Map(app.items().map((i) => [i.id, i]));

// Has this phone changed the item since it last agreed with the household?
function changedHere(local, base) {
  if (base) return fingerprint(local) !== print(base.v);
  // Not yet remembered by this version of the app: the older fingerprint, if there is one.
  return !meta.sent?.[local.id] || print(local) !== meta.sent[local.id];
}

// One household row in: added, replaced, merged with this phone's changes, or left as it is.
// Returns true when the result still needs sending (it holds changes made here).
function takeRow(row, here, changes) {
  const base = meta.rows[row.id];
  if (base && sameAt(base.at, row.updated_at)) return false; // nothing new (or our own write)
  if (!row.deleted && !row.data) return false; // gone between two requests: next time
  const local = here.get(row.id);
  const remote = row.deleted ? null : row.data;
  let next; // undefined: this phone's copy stays as it is
  if (!local) {
    // New here, restored by someone, or changed by someone after this phone deleted it (theirs
    // is kept, so nothing anyone changed is lost). Unchanged since this phone deleted it: stays deleted.
    if (remote && !(base?.v && fingerprint(remote) === print(base.v))) next = remote;
  } else if (!changedHere(local, base)) next = remote;
  else if (remote) next = base?.v ? mergeItem(base.v, local, remote) : newest(local, remote);
  // Deleted there but changed here since: ours stays and goes back up.
  meta.rows[row.id] = { at: row.updated_at, v: remote ? slim(remote) : null };
  if (next !== undefined) changes.set(row.id, next);
  return next === undefined ? Boolean(local) : next !== remote;
}

function commit(changes) {
  if (!changes.size) return;
  app.applyRemote([...changes].map(([id, item]) => ({ id, item })));
  app.onRemote();
}

// The shared settings in: the household's lists, merged with any changes made here.
function takeSettings(row) {
  const base = meta.settings;
  if (base && sameAt(base.at, row.updated_at)) return false;
  const remote = row.data || {};
  const local = app.settings();
  const changed = base ? fingerprint(local) !== print(base.v) : meta.settingsSent ? print(local) !== meta.settingsSent : true;
  const next = !changed ? remote
    : base ? mergeSettings(base.v, local, remote)
    : meta.settingsSent ? mergeSettings(null, local, remote) // changed under an older version: keep both
    : { ...local, ...remote }; // first time in this household: its lists
  meta.settings = { at: row.updated_at, v: slim(remote) };
  if (print(next) !== print(local)) {
    app.applySettings(next);
    app.onRemote();
  }
  return print(next) !== print(remote);
}

// Everything from the household. A light list of what's there and when it last changed comes
// first; only rows that changed since this phone last saw them are fetched in full.
async function pull() {
  if (!meta.householdId) return;
  const c = await signedIn();
  const h = meta.householdId;
  const { data: settingsRow, error: settingsError } = await c.from('household_settings').select('data, updated_at').eq('household_id', h).maybeSingle();
  if (settingsError) throw settingsError;
  // The database hands back at most 1000 rows at a time.
  const heads = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await c.from('items').select('id, deleted, updated_at').eq('household_id', h).order('id').range(from, from + 999);
    if (error) throw error;
    heads.push(...data);
    if (data.length < 1000) break;
  }
  await checkMembership();
  meta.rows ||= {};
  const wanted = heads.filter((r) => !r.deleted && !sameAt(meta.rows[r.id]?.at, r.updated_at)).map((r) => r.id);
  const full = new Map();
  for (let i = 0; i < wanted.length; i += 100) {
    const { data, error: e } = await c.from('items').select('id, data, deleted, updated_at').eq('household_id', h).in('id', wanted.slice(i, i + 100));
    if (e) throw e;
    for (const r of data) full.set(r.id, r);
  }
  const here = localById();
  const changes = new Map();
  for (const head of heads) takeRow(full.get(head.id) || head, here, changes);
  // Remembered but gone from the household entirely (shouldn't happen): send ours again.
  const onServer = new Set(heads.map((r) => r.id));
  for (const id of Object.keys(meta.rows)) if (!onServer.has(id)) delete meta.rows[id];
  if (settingsRow) takeSettings(settingsRow);
  delete meta.sent;
  delete meta.settingsSent;
  saveMeta();
  commit(changes);
  await push();
}

// Live changes from the rest of the household.
function listen() {
  if (channel || !meta.householdId || !sb) return;
  const filter = `household_id=eq.${meta.householdId}`;
  channel = sb
    .channel(`household-${meta.householdId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items', filter }, ({ new: row }) => {
      if (!row?.id) return;
      run(async () => {
        if (!meta.rows) return;
        // Large rows can arrive without their data; fetch those.
        if (!row.deleted && !row.data) row = (await fetchRow(row.id)) || row;
        if (!row.deleted && !row.data) return;
        const changes = new Map();
        const resend = takeRow(row, localById(), changes);
        saveMeta();
        commit(changes);
        if (resend) pushSoon(300);
      }).catch(() => {});
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'household_settings', filter }, ({ new: row }) => {
      if (!row?.data) return;
      run(() => {
        if (takeSettings(row)) pushSoon(300);
        saveMeta();
      }).catch(() => {});
    })
    .subscribe((s) => {
      if (s === 'SUBSCRIBED') {
        setStatus('synced');
        sync(); // catch anything missed while the connection was down
      } else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') setStatus('offline');
    });
}

async function fetchRow(id) {
  const { data, error } = await sb.from('items').select('id, data, deleted, updated_at').eq('household_id', meta.householdId).eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

// ---------- Sending this phone's changes ----------

// Called after every local save: send what changed shortly after (several quick taps go together).
export function pushSoon(delay = 600) {
  if (!meta.householdId) return;
  clearTimeout(timer);
  timer = setTimeout(() => run(push).then(() => setStatus('synced'), failed), delay);
  timer.unref?.(); // (tests: don't hold the process open)
}

// Write one row, but only over the household copy this phone last saw. False: someone else
// changed it first.
async function writeRow(c, id, data, deleted) {
  const base = meta.rows[id];
  const at = stamp(base?.at);
  const row = { data, deleted, updated_at: at };
  if (!base) {
    const { error } = await c.from('items').insert({ household_id: meta.householdId, id, ...row });
    if (error?.code === '23505') return false; // already there
    if (error) throw error;
  } else {
    const { data: done, error } = await c.from('items').update(row).eq('household_id', meta.householdId).eq('id', id).eq('updated_at', base.at).select('id');
    if (error) throw error;
    if (!done.length) return false;
  }
  meta.rows[id] = { at, v: deleted ? null : slim(data) };
  return true;
}

// A few at a time, so a big change (a rename across many items) doesn't flood the connection.
async function eachLimited(list, n, fn) {
  const queue = [...list];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  }));
}

async function push(round = 0) {
  if (!meta.householdId) return;
  if (!meta.rows) return pull(); // nothing agreed on yet: catch up first
  const c = await signedIn();
  const items = app.items();
  const here = new Set(items.map((i) => i.id));
  const changed = items.filter((it) => !meta.rows[it.id] || fingerprint(it) !== print(meta.rows[it.id].v));
  const gone = Object.keys(meta.rows).filter((id) => meta.rows[id].v && !here.has(id));
  // Stamp who changed it and when, for "Last changed … by …".
  for (const it of changed) {
    it.updated = Math.max(Date.now(), (it.updated || 0) + 1);
    it.by = meta.name;
  }
  if (changed.length) app.persist();
  const conflicts = [];
  await eachLimited([...changed.map((it) => [it.id, it, false]), ...gone.map((id) => [id, { id, updated: Date.now(), by: meta.name }, true])], 6, async ([id, data, deleted]) => {
    if (!(await writeRow(c, id, data, deleted))) conflicts.push(id);
  });
  saveMeta();
  // Someone else got there first: bring in their copy, merge, and send the result.
  if (conflicts.length) {
    const changes = new Map();
    const fresh = localById();
    for (const id of conflicts) {
      const row = await fetchRow(id);
      if (row) takeRow(row, fresh, changes);
      else delete meta.rows[id];
    }
    saveMeta();
    commit(changes);
    if (round >= 3) throw new Error('Still changing — will try again shortly');
    return push(round + 1);
  }
  await pushSettings(c, round);
}

async function pushSettings(c, round) {
  const h = meta.householdId;
  if (!meta.settings) {
    const { data: row, error } = await c.from('household_settings').select('data, updated_at').eq('household_id', h).maybeSingle();
    if (error) throw error;
    if (row) takeSettings(row);
  }
  const local = app.settings();
  if (meta.settings && fingerprint(local) === print(meta.settings.v)) return saveMeta();
  const at = stamp(meta.settings?.at);
  if (!meta.settings) {
    const { error } = await c.from('household_settings').upsert({ household_id: h, data: local, updated_at: at });
    if (error) throw error;
  } else {
    const { data: done, error } = await c.from('household_settings').update({ data: local, updated_at: at }).eq('household_id', h).eq('updated_at', meta.settings.at).select('household_id');
    if (error) throw error;
    if (!done.length) {
      const { data: row, error: e } = await c.from('household_settings').select('data, updated_at').eq('household_id', h).maybeSingle();
      if (e) throw e;
      if (row) takeSettings(row);
      else meta.settings = null; // the row is gone: write a new one
      saveMeta();
      if (round >= 3) throw new Error('Still changing — will try again shortly');
      return pushSettings(c, round + 1);
    }
  }
  meta.settings = { at, v: slim(local) };
  saveMeta();
}

// For tests: a stand-in database and storage, so several phones can share one household.
export function _testSetup({ client: c, storage }) {
  sb = c;
  store = storage;
  for (const k of Object.keys(meta)) delete meta[k];
  Object.assign(meta, loadMeta());
}
export const _testNow = { pull: () => run(pull), push: () => run(push) };
