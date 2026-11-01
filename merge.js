// Combining two people's changes to the same thing, so neither is lost.
//
// Every merge is three-way: `base` is the copy both sides last agreed on, `local` is this phone's,
// `remote` is the household's. A field only one side changed takes that side's value. A count
// both changed takes both changes (4 → 3 here and 4 → 3 there makes 2). Anything else both
// changed goes to the more recent edit. Lists of names (stores, places) keep both sides'
// additions and removals.
//
// Pure functions with no browser parts, so they can be tested on their own.

export const stable = (v) =>
  Array.isArray(v) ? v.map(stable)
  : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]))
  : v;
export const print = (v) => (v === undefined ? 'undefined' : JSON.stringify(stable(v)));

// Long strings (photos) stand in as a short hash, so a remembered copy stays small.
const LONG = 300;
function hash(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
export const slim = (v) =>
  typeof v === 'string' ? (v.length > LONG ? `\u0000${hash(v)}:${v.length}` : v)
  : Array.isArray(v) ? v.map(slim)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, slim(x)]))
  : v;
export const fingerprint = (v) => print(slim(v));
// Whether a full value (local or remote) matches a remembered slim one.
const same = (full, base) => fingerprint(full) === print(base);

const round = (n) => Math.round(n * 100) / 100;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Counts per place: each side's change is applied on top of the other's.
function mergeCounts(b = {}, l = {}, r = {}) {
  const out = {};
  for (const k of new Set([...Object.keys(b || {}), ...Object.keys(l || {}), ...Object.keys(r || {})])) {
    const bv = b?.[k] || 0;
    const lv = l?.[k] || 0;
    const rv = r?.[k] || 0;
    const v = lv === bv ? rv : rv === bv ? lv : rv + lv - bv;
    if (v > 0) out[k] = round(v);
  }
  return Object.keys(out).length ? out : undefined;
}

// The newer of two copies with nothing in common to compare against.
export const newest = (local, remote) => ((local.updated || 0) >= (remote.updated || 0) ? local : remote);

// absolute: this phone's changes were typed in on the item's page just now, so where both sides
// changed the same thing, this phone's stands (a counted 12 stays 12).
export function mergeItem(base, local, remote, { absolute = false } = {}) {
  if (!base) return newest(local, remote);
  const localNewer = (local.updated || 0) >= (remote.updated || 0);
  const out = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
    if (k === 'updated' || k === 'by') continue;
    const b = base[k];
    const l = local[k];
    const r = remote[k];
    let v;
    if (same(l, b)) v = r;
    else if (same(r, b)) v = l;
    else if (absolute) v = l;
    else if (k === 'qty' && [b, l, r].every((n) => typeof n === 'number')) v = Math.max(0, round(r + l - b));
    else if (k === 'spots') v = mergeCounts(b, l, r);
    else v = localNewer ? l : r;
    if (v !== undefined) out[k] = v;
  }
  out.updated = Math.max(local.updated || 0, remote.updated || 0);
  const by = localNewer ? local.by : remote.by;
  if (by !== undefined) out.by = by;
  return out;
}

// A list of names: the other side's list, minus what this side removed, plus what it added
// (each placed after the name it followed here).
export function mergeList(b = [], l = [], r = []) {
  if (print(r) === print(b)) return [...l];
  if (print(l) === print(b)) return [...r];
  const removed = new Set(b.filter((x) => !l.includes(x)));
  const out = r.filter((x) => !removed.has(x));
  l.forEach((x, i) => {
    if (out.includes(x) || b.includes(x)) return; // only what this side added
    const after = l.slice(0, i).reverse().find((y) => out.includes(y));
    out.splice(after === undefined ? 0 : out.indexOf(after) + 1, 0, x);
  });
  return out;
}

// Shared settings: stores, places, spots in each place, rooms.
export function mergeSettings(base, local, remote) {
  const out = { ...remote };
  for (const k of new Set([...Object.keys(local || {}), ...Object.keys(remote || {})])) {
    const b = base?.[k];
    const l = local?.[k];
    const r = remote?.[k];
    if (base && print(l) === print(b)) continue; // only the household's side changed
    if (r === undefined || (base && print(r) === print(b))) out[k] = l;
    else if (Array.isArray(l) && Array.isArray(r)) out[k] = mergeList(Array.isArray(b) ? b : [], l, r);
    else if (isObj(l) && isObj(r)) {
      out[k] = {};
      for (const key of new Set([...Object.keys(l), ...Object.keys(r)])) {
        const merged = mergeList(isObj(b) && Array.isArray(b[key]) ? b[key] : [], l[key] || [], r[key] || []);
        if (merged.length) out[k][key] = merged;
      }
    } else out[k] = l;
  }
  return out;
}
