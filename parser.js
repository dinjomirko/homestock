// Turns spoken or typed sentences into inventory actions, and matches names to items.
// Pure functions only, so the same file runs in the browser and under `node --test`.

export const DEFAULT_LOCATIONS = ['Pantry', 'Fridge', 'Freezer', 'Bathroom', 'Garage'];

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, single: 1, another: 1,
  two: 2, to: 2, too: 2, couple: 2,
  three: 3, few: 3, several: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12, fifteen: 15, twenty: 20,
  half: 0.5,
};

// Words people say before the verb that carry no meaning ("so I'm going to use…").
const FILLER = new Set([
  'ok', 'okay', 'so', 'um', 'umm', 'uh', 'hey', 'please', 'just', 'also', 'and', 'then',
  'now', 'actually', 'yeah', 'well', 'i', 'we', 'im', "i'm", 'were', "we're", 'ill',
  "i'll", "we'll", 'going', 'gonna', 'to', 'am', 'are', 'is', 'been',
]);

const ACTION_PHRASES = {
  out: [
    'ran out of', 'run out of', 'out of', 'all out of', 'used up', 'used up all',
    'used up all the', 'used the last', 'used the last of', 'finished the last',
    'finished the last of', 'finished off', 'no more', 'none left of',
  ],
  need: [
    'need', 'needs', 'need more', 'need some', 'running low on', 'running out of',
    'getting low on', 'low on', 'almost out of', 'nearly out of', 'buy more', 'get more',
    'pick up more', 'should buy', 'should get',
  ],
  unlist: [
    "don't need", 'dont need', 'do not need', 'no longer need', "don't need any", 'cross off', 'cross',
    'scratch off', 'scratch',
  ],
  set: [
    'have', 'has', 'have got', "i've got", "we've got", 'ive got', 'weve got', "i've", "we've",
    'there are', 'there is', "there's", 'theres', 'only have', 'set', 'count', 'update',
  ],
  remove: [
    'took out', 'take out', 'taking out', 'threw out', 'throw out', 'threw away', 'throw away',
    'tossed', 'toss', 'removing', 'removed', 'remove', 'subtracting', 'subtract', 'minus',
    'using', 'used', 'use', 'took', 'take', 'taking', 'ate', 'eaten', 'eat', 'eating',
    'drank', 'drink', 'opened', 'open', 'opening', 'grabbed', 'grab', 'grabbing', 'consumed',
    'finished', 'pulled', 'pull', 'gave away', 'cooked with', 'baked with', 'have used',
    'have been using', 'had', 'delete', 'deleting',
  ],
  add: [
    'adding', 'added', 'add', 'bought', 'buying', 'buy', 'got', 'get', 'getting', 'picked up',
    'pick up', 'restocked', 'restock', 'restocking', 'stocked', 'stocking', 'put away',
    'putting away', 'put', 'putting', 'stored', 'plus', 'received', 'brought home', 'new',
    'have bought', 'have added',
  ],
};

// Longest phrase first, so "used up" wins over "used" and "get more" over "get".
const PHRASES = Object.entries(ACTION_PHRASES)
  .flatMap(([action, list]) => list.map((p) => [p, action]))
  .sort((a, b) => b[0].length - a[0].length);

const UNITS = new Set([
  'roll', 'can', 'box', 'bottle', 'bag', 'pack', 'package', 'packet', 'jar', 'tube', 'bar',
  'carton', 'container', 'jug', 'loaf', 'loave', 'bunch', 'case', 'sleeve', 'sheet', 'piece',
  'tub', 'stick', 'gallon', 'quart', 'pint', 'pound', 'lb', 'ounce', 'oz', 'cup', 'spool',
  'sack', 'bucket', 'tin', 'pouch', 'tray', 'head', 'bundle', 'pair', 'set', 'kit', 'cartridge',
]);

const STOCK_WORDS = new Set([
  'stock', 'inventory', 'supply', 'supplies', 'shelf', 'shelves', 'cupboard', 'cabinet',
  'storage', 'stash', 'house', 'home',
]);

const TAIL = /^(.*\S)\s+(?:from|to|into|in|on|onto|at|off of|off|out of|back to|back in|back into)\s+(?:the |my |our |a )?([a-z' ]+)$/;

const numOf = (t) => {
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  return Object.hasOwn(NUMBER_WORDS, t) ? NUMBER_WORDS[t] : null;
};

function stripFiller(words) {
  let i = 0;
  while (i < words.length && FILLER.has(words[i])) i++;
  return words.slice(i);
}

function matchPhrase(s) {
  for (const [p, action] of PHRASES) {
    if (s === p || s.startsWith(p + ' ')) return { action, rest: s.slice(p.length).trim() };
  }
  return null;
}

function startsNewClause(words) {
  const w = stripFiller(words);
  if (!w.length) return false;
  return Boolean(matchPhrase(w.join(' '))) || numOf(w[0]) !== null;
}

export function parseCommand(text, opts = {}) {
  const locations = opts.locations || DEFAULT_LOCATIONS;
  const locByLower = new Map(locations.map((l) => [l.toLowerCase(), l]));
  // Stores match without apostrophes, since speech often drops them ("trader joes").
  const stores = new Map((opts.stores || []).map((st) => [storeKey(st), st]));
  const clean = String(text)
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/[^a-z0-9'.,;\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return [];

  const query = parseQuery(clean, locByLower, stores);
  if (query) return [query];

  // Split into clauses on commas/"then", and on "and" only when what follows starts a new
  // command ("…tomatoes and a box of pasta"), so "salt and pepper" stays one item.
  const clauses = [];
  for (const part of clean.split(/\s*(?:[,;]|\band then\b|\bthen\b|\balso\b)\s*/)) {
    const words = part.split(' ').filter(Boolean);
    let cur = [];
    words.forEach((word, i) => {
      if (word === 'and' && cur.length && startsNewClause(words.slice(i + 1))) {
        clauses.push(cur.join(' '));
        cur = [];
      } else {
        cur.push(word);
      }
    });
    if (cur.length) clauses.push(cur.join(' '));
  }

  const actions = [];
  let prevAction = null;
  for (const clause of clauses) {
    const a = parseClause(clause, prevAction, locByLower, stores);
    if (!a) continue;
    prevAction = a.action;
    actions.push(a);
  }
  return actions;
}

// Questions don't change anything: "how many paper towels do we have", "do we have eggs".
const QUESTION = /^(?:(?:hey|ok|okay|so|um|uh)\s+)*(?:how many|how much|do we have|do i have|do we still have|have we got|have i got|is there|are there|got any|where is|where are|where's|wheres|check on|check)\s+(.+)$/;

function parseQuery(clean, locByLower, stores) {
  const m = clean.match(QUESTION);
  if (!m) return null;
  const rest = m[1]
    .replace(/\b(?:do|did|have|has)\s+(?:we|i)(?:\s+(?:have|got))?\b/g, ' ')
    .replace(/\b(?:(?:is|are)\s+)?(?:left|in stock|at home|in the house|there|still|anymore)\b/g, ' ')
    .replace(/\s+(?:is|are)$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const a = parseClause(rest, 'query', locByLower, stores);
  return a && { ...a, action: 'query', qty: null };
}

const storeKey = (s) => s.toLowerCase().replace(/'/g, '').trim();

function parseClause(clause, prevAction, locByLower, stores = new Map()) {
  let s = stripFiller(clause.split(' ')).join(' ');
  let action = null;
  const m = matchPhrase(s);
  if (m) {
    action = m.action;
    s = m.rest;
  }

  // Trailing "from the stock" / "in the garage" / "to the (Costco) shopping list" / "at Aldi".
  let location = null;
  let store = null;
  for (let k = 0; k < 3; k++) {
    const t = s.match(TAIL);
    if (!t) break;
    const tail = t[2].trim();
    const list = tail.match(/^(?:(.+?) )?(?:shopping |grocery )?list$/);
    if (list) {
      action = action === 'remove' || action === 'unlist' ? 'unlist' : 'need';
      if (list[1] && stores.has(storeKey(list[1]))) store = stores.get(storeKey(list[1]));
    } else if (stores.has(storeKey(tail))) store = stores.get(storeKey(tail));
    else if (locByLower.has(tail)) location = locByLower.get(tail);
    else if (!STOCK_WORDS.has(tail)) break;
    s = t[1];
  }
  if (!action) action = prevAction;

  let w = s.split(' ').filter(Boolean);
  let qty = null;
  if ((w[0] === 'a' || w[0] === 'an') && ['couple', 'few', 'dozen', 'single', 'half'].includes(w[1])) {
    qty = NUMBER_WORDS[w[1]];
    w = w.slice(2);
  } else if (w[0] === 'half' && (w[1] === 'a' || w[1] === 'an')) {
    qty = 0.5;
    w = w.slice(2);
  } else if (w.length > 1 && numOf(w[0]) !== null) {
    qty = numOf(w[0]);
    w = w.slice(1);
  }
  if (w[0] === 'of') w.shift();
  if (qty !== null && w[0] === 'dozen' && w.length > 1) {
    qty *= 12;
    w.shift();
    if (w[0] === 'of') w.shift();
  }

  let unit = null;
  if (w.length > 2 && w[1] === 'of' && UNITS.has(stem(w[0]))) {
    unit = stem(w[0]) === 'loave' ? 'loaf' : stem(w[0]).replace(/i$/, 'y');
    w = w.slice(2);
  }

  while (w.length && ['the', 'some', 'my', 'our', 'more', 'of', 'any', 'all', 'a', 'an', 'your'].includes(w[0])) w.shift();
  while (w.length && ['please', 'thanks', 'now', 'today', 'too', 'left'].includes(w.at(-1))) w.pop();
  let name = w.join(' ');

  if (action === 'set' && qty === null) {
    const tm = name.match(/^(.*?)\s+(?:to|at|is|are)\s+(\S+)$/) || name.match(/^(.*?)\s+(\d+(?:\.\d+)?)$/);
    if (tm && numOf(tm[2]) !== null) {
      name = tm[1].replace(/^the /, '');
      qty = numOf(tm[2]);
    }
  }
  if (!name) return null;
  if ((action === 'add' || action === 'remove') && qty === null) qty = 1;
  return { action, qty, unit, name, location, ...(store ? { store } : {}) };
}

// ---------- Matching names to items ----------

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'with', 'for', 'in', 'my', 'our', 'some', 'to']);

// Crude plural folding: "berries"/"berry" → "berri", "boxes" → "box", "towels" → "towel".
export function stem(word) {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'i';
  else if (w.length > 3 && /(ch|sh|x|ss|z|o)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  return w.replace(/(ie|y)$/, 'i');
}

export function tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !STOP.has(t))
    .map(stem);
}

export function matchItem(query, items, preferStocked = false) {
  const q = tokens(query);
  if (!q.length) return null;
  let best = null;
  for (const item of items) {
    const nameT = tokens(item.name);
    const allT = [...new Set([...nameT, ...tokens(item.brand)])];
    const hit = (t) => allT.includes(t) || allT.some((x) => x.length >= 4 && t.length >= 4 && (x.startsWith(t) || t.startsWith(x)));
    const coverage = q.filter(hit).length / q.length;
    if (coverage < (q.length === 1 ? 1 : 0.6)) continue;
    const precision = nameT.length ? nameT.filter((t) => q.includes(t)).length / nameT.length : 0;
    let score = coverage * 0.7 + precision * 0.3;
    if (preferStocked && item.qty > 0) score += 0.05;
    if (!best || score > best.score) best = { item, score, coverage };
  }
  return best;
}

// Attach the matching inventory item to each parsed action. "milk and eggs" that doesn't
// match one item is split into two when each half matches (or when it's a shopping request).
export function resolveActions(actions, items) {
  const out = [];
  for (const a of actions) {
    const prefer = a.action === 'remove' || a.action === 'out';
    const m = matchItem(a.name, items, prefer);
    if (/ and /.test(a.name) && !(m && m.coverage === 1)) {
      const parts = a.name.split(/\s+and\s+/).filter(Boolean);
      const ms = parts.map((p) => matchItem(p, items, prefer));
      if (ms.every(Boolean) || ['need', 'out', 'unlist'].includes(a.action)) {
        parts.forEach((p, i) => out.push({ ...a, name: p, item: ms[i]?.item || null }));
        continue;
      }
    }
    out.push({ ...a, item: m?.item || null });
  }
  return out;
}

// ---------- Guessing details for new items ----------

const LOCATION_HINTS = [
  ['Freezer', /\b(frozen|ice cream|popsicles?|ice pops?)\b/],
  ['Pantry', /\b(paper towels?|dish soap|dishwasher|detergent|trash bags?|garbage bags?|foil|plastic wrap|zip ?lock|ziploc|sponges?|napkins?)\b/],
  ['Bathroom', /\b(toilet paper|tissues?|shampoo|conditioner|soap|body wash|toothpaste|toothbrush(es)?|floss|deodorant|razors?|lotion|mouthwash|cotton|bandages?|band aids?|q tips?|sunscreen|contact solution)\b/],
  ['Fridge', /\b(milk|eggs?|cheese|butter|yogh?urt|cream|creamer|lettuce|spinach|ham|bacon|deli|hummus|tofu|sour cream)\b/],
  ['Garage', /\b(screws?|nails?|bolts?|washers?|anchors?|batter(y|ies)|tape|paint|primer|caulk|glue|sandpaper|light ?bulbs?|bulbs?|drywall|spackle|lumber|wd ?40|furnace filters?|air filters?|fuses?|wire|zip ties?|sealant|grout|stain|motor oil|antifreeze|windshield|fertilizer|charcoal|propane|work gloves|hardware|tools?)\b/],
];

export function guessLocation(text, kind = '') {
  const t = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  for (const [loc, re] of LOCATION_HINTS) if (re.test(t)) return loc;
  if (kind === 'beauty') return 'Bathroom';
  if (kind === 'product') return 'Garage';
  return 'Pantry';
}

// "12 Mega Rolls" → { count: 12, unit: 'roll' } so one scan of the pack adds 12 rolls.
export function parsePack(size) {
  const m = String(size || '').match(/(\d+)\s*(?:x\s*)?(?:[a-z]+\s+)?(rolls?|bars?|cans?|bottles?|pods?|tablets?|bags?|wipes?|capsules?|batteries|battery|pieces?|count|ct|pk|pack|pcs)\b/i);
  if (!m) return null;
  const count = parseInt(m[1], 10);
  if (count < 2 || count > 500) return null;
  const raw = m[2].toLowerCase();
  const unit = ['count', 'ct', 'pk', 'pack', 'pcs'].includes(raw) ? '' : raw.startsWith('batter') ? 'battery' : raw.replace(/s$/, '');
  return { count, unit };
}
