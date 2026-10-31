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
  // Bought something on the list: off the list and into stock (like ticking it off).
  restock: ['move', 'moving', 'moved', 'mark', 'mark off', 'check off', 'tick off'],
  // Opening a package doesn't use it up; it starts the clock on using it.
  open: ['opened', 'open', 'opening', 'just opened', 'cracked open', 'broke open'],
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
    'drank', 'drink', 'grabbed', 'grab', 'grabbing', 'consumed',
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

const TAIL = /^(.*\S)\s+(from|to|into|in|on|onto|at|for|of|off of|off|out of|back to|back in|back into)\s+(?:the |my |our |a )?([a-z0-9' ]+)$/;

// A spot within a place: "shelf 2", "top shelf", "bin b", "drawer three", or one you've named.
const SPOT = /^(?:(?:top|bottom|middle|upper|lower|left|right|back|front|first|second|third)\s+(?:shelf|drawer|bin|rack|cabinet|cupboard|basket)|(?:shelf|drawer|bin|rack|tote|cabinet|cupboard|basket|row|section)\s+(?:\d+|[a-z]))$/;
const SPOT_NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

function matchSpot(tail, known = []) {
  const t = tail.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, (w) => SPOT_NUMBERS[w]);
  const mine = known.find((k) => k.toLowerCase() === t);
  if (mine) return mine;
  if (!SPOT.test(t)) return null;
  return t.charAt(0).toUpperCase() + t.slice(1).replace(/ ([a-z])$/, (m) => m.toUpperCase());
}

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
    if (s === p || s.startsWith(p + ' ')) return { action, phrase: p, rest: s.slice(p.length).trim() };
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
  const ctx = { locByLower, stores: opts.stores || [], spots: opts.spots || [], listContext: Boolean(opts.listContext) };
  const clean = String(text)
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/&/g, ' and ')
    .replace(/\.(?!\d)/g, ' ')
    .replace(/[^a-z0-9'.,;\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return [];

  const query = parseQuery(clean, ctx);
  if (query) return [query];
  const special = parseExpiry(clean, opts.today || new Date()) || parseLevel(clean);
  if (special) return [special];

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
    const a = parseClause(clause, prevAction, ctx);
    if (!a) continue;
    prevAction = a.action;
    actions.push(a);
  }
  return actions;
}

// Questions don't change anything: "how many paper towels do we have", "do we have eggs".
const QUESTION = /^(?:(?:hey|ok|okay|so|um|uh)\s+)*(?:how many|how much|do we have|do i have|do we still have|have we got|have i got|is there|are there|got any|where is|where are|where's|wheres|check on|check(?!\s+off))\s+(.+)$/;

function parseQuery(clean, ctx) {
  const m = clean.match(QUESTION);
  if (!m) return null;
  const rest = m[1]
    .replace(/\b(?:do|did|have|has)\s+(?:we|i)(?:\s+(?:have|got))?\b/g, ' ')
    .replace(/\b(?:(?:is|are)\s+)?(?:left|in stock|at home|in the house|there|still|anymore)\b/g, ' ')
    .replace(/\s+(?:is|are)$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const a = parseClause(rest, 'query', ctx);
  return a && { ...a, action: 'query', qty: null };
}

// Common chains, so a store can be recognised (and spelling-corrected) the first time it's
// mentioned: speech hears "Jewel-Osco" as "jewel cosco" and "Costco" as "cosco".
const KNOWN_STORES = [
  ['Costco'], ['Aldi'], ['Target'], ['Walmart'], ['Jewel-Osco', 'jewel'], ["Trader Joe's", 'trader joes'],
  ['Whole Foods', 'whole foods market'], ["Mariano's"], ["Sam's Club", 'sams'], ["BJ's"], ['Kroger'],
  ['Safeway'], ['Publix'], ['Meijer'], ['H-E-B', 'heb'], ['Wegmans'], ['Sprouts'], ['Hy-Vee'],
  ['Fresh Thyme'], ['Home Depot'], ["Lowe's"], ['Menards'], ['Walgreens'], ['CVS'], ['Amazon'],
  ['Kohls'], ['Ace Hardware', 'ace'],
];
const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

// Your own stores first, then well-known chains; exact match first, then a near spelling.
export function findStore(heard, stores = []) {
  const h = squash(heard);
  if (h.length < 3) return null;
  const candidates = [...stores.map((st) => [st, [st]]), ...KNOWN_STORES.map(([name, ...aka]) => [name, [name, ...aka]])];
  for (const [name, keys] of candidates) if (keys.some((k) => squash(k) === h)) return name;
  let best = null;
  let bestD = Infinity;
  for (const [name, keys] of candidates) {
    for (const k of keys) {
      const kk = squash(k);
      if (kk.length < 4) continue;
      const d = editDistance(h, kk);
      if (d <= (kk.length >= 8 ? 2 : 1) && d < bestD) {
        best = name;
        bestD = d;
      }
    }
  }
  return best;
}

// On the shopping list, "add bananas" means put them on the list, not into stock.
const LIST_VERBS = new Set(['add', 'get', 'buy', 'put', 'pick up']);

function parseClause(clause, prevAction, ctx = {}) {
  const { locByLower = new Map(), stores = [], spots = [], listContext = false } = ctx;
  let s = stripFiller(clause.split(' ')).join(' ');
  let action = null;
  const m = matchPhrase(s);
  if (m) {
    action = listContext && m.action === 'add' && LIST_VERBS.has(m.phrase) ? 'need' : m.action;
    s = m.rest;
  }

  // Trailing "from the stock" / "in the garage" / "to the (Costco) shopping list" /
  // "to the shopping list for Jewel" / "at Aldi". A bare "to the shopping" is a list too:
  // Safari sometimes cuts off the last word.
  // "Move X from the list to the pantry": the place after "to/in" is where it goes.
  let to = null;
  let from = null;
  let store = null;
  let shelf = null;
  for (let k = 0; k < 3; k++) {
    const t = s.match(TAIL);
    if (!t) break;
    let prep = t[2];
    const tail = t[3].trim();
    // "out of" / "off of" are one word here, not "out" + "of".
    const split = prep === 'of' && t[1].match(/^(.*\S)\s+(out|off)$/);
    if (split) [t[1], prep] = [split[1], `${split[2]} of`];
    const list = tail.match(/^(?:(.+?) )?(?:(?:shopping |grocery )?list|shopping|grocery)$/);
    if (list) {
      action =
        action === 'remove' || action === 'unlist' ? 'unlist'
        : action === 'restock' || (prep === 'from' && action) ? 'restock' // "put X from the list in the fridge"
        : 'need';
      if (list[1]) store = findStore(list[1], stores) || store;
    } else if (locByLower.has(tail)) {
      if (['from', 'out of', 'off', 'off of'].includes(prep)) from ||= locByLower.get(tail);
      else to ||= locByLower.get(tail);
    }
    else if (prep !== 'of' && findStore(tail, stores)) store = findStore(tail, stores);
    else if (matchSpot(tail, spots)) shelf ||= matchSpot(tail, spots);
    // "…to the list for tomorrow": not a store, but the list part before it still counts.
    else if (prep === 'for' && /\b(?:list|shopping|grocery)$/.test(t[1])) { /* drop it */ }
    // "of" only ends a place ("top shelf of the pantry"), never "a can of stock".
    else if (prep === 'of' || !STOCK_WORDS.has(tail)) break;
    s = t[1];
  }
  if (!action) action = prevAction;
  const location = to || from;

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
  if (action === 'restock') name = name.replace(/\s+(?:as\s+)?(?:bought|purchased|done|got|gotten|in stock)$/, '');

  if (action === 'set' && qty === null) {
    const tm = name.match(/^(.*?)\s+(?:to|at|is|are)\s+(\S+)$/) || name.match(/^(.*?)\s+(\d+(?:\.\d+)?)$/);
    if (tm && numOf(tm[2]) !== null) {
      name = tm[1].replace(/^the /, '');
      qty = numOf(tm[2]);
    }
  }
  if (!name) return null;
  if ((action === 'add' || action === 'remove') && qty === null) qty = 1;
  return { action, qty, unit, name, location, ...(store ? { store } : {}), ...(shelf ? { shelf } : {}) };
}

// ---------- Dates, use-by and how much is left ----------

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
export const isoDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
// A month after Oct 31 is Nov 30, not Dec 1.
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate()));

// "friday", "tomorrow", "in 5 days", "a week", "november 20th", "the 12th", "11/20" → "2026-11-20"
export function parseDate(text, today = new Date()) {
  const t = String(text).toLowerCase()
    .replace(/(\d+)(?:st|nd|rd|th)\b/g, '$1')
    .replace(/[,.]/g, ' ')
    .replace(/\b(?:on|the|of|this|coming|from now)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (/^(?:today|tonight)$/.test(t)) return isoDate(base);
  if (t === 'tomorrow') return isoDate(addDays(base, 1));
  if (t === 'next week') return isoDate(addDays(base, 7));
  if (t === 'next month') return isoDate(addMonths(base, 1));
  let m = t.match(/^(?:in )?(\S+) (day|week|month)s?$/);
  if (m && numOf(m[1]) !== null) {
    const n = Math.round(numOf(m[1]));
    return isoDate(m[2] === 'month' ? addMonths(base, n) : addDays(base, n * (m[2] === 'week' ? 7 : 1)));
  }
  m = t.match(/^(?:next )?([a-z]+)$/);
  if (m && WEEKDAYS.includes(m[1])) return isoDate(addDays(base, (WEEKDAYS.indexOf(m[1]) - base.getDay() + 7) % 7 || 7));
  m = t.match(/^([a-z]{3,}) (\d{1,2})$/) || t.match(/^(\d{1,2}) ([a-z]{3,})$/);
  if (m) {
    const [word, day] = /^\d/.test(m[1]) ? [m[2], +m[1]] : [m[1], +m[2]];
    const month = MONTHS.findIndex((mo) => mo.startsWith(word.slice(0, 3)) && mo.startsWith(word));
    if (month >= 0 && day >= 1 && day <= 31) {
      let d = new Date(base.getFullYear(), month, day);
      if (d < base) d = new Date(base.getFullYear() + 1, month, day);
      return isoDate(d);
    }
  }
  m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    let year = m[3] ? +m[3] + (m[3].length === 2 ? 2000 : 0) : base.getFullYear();
    let d = new Date(year, +m[1] - 1, +m[2]);
    if (!m[3] && d < base) d = new Date(year + 1, +m[1] - 1, +m[2]);
    return isoDate(d);
  }
  m = t.match(/^(\d{1,2})$/);
  if (m && +m[1] >= 1 && +m[1] <= 31) {
    let d = new Date(base.getFullYear(), base.getMonth(), +m[1]);
    if (d < base) d = new Date(base.getFullYear(), base.getMonth() + 1, +m[1]);
    return isoDate(d);
  }
  return null;
}

// "milk expires friday", "use the spinach by tomorrow", "eggs are good until the 20th"
const EXPIRY_PATTERNS = [
  /^(.+?)\s+(?:expires?|expiring|will expire|goes bad|go bad|is good until|are good until|is good till|are good till|good until|good till|is good|are good|lasts until|is fresh until)\s+(.+)$/,
  /^(?:use|eat|finish|drink)\s+(?:up\s+)?(.+?)\s+by\s+(.+)$/,
  /^(?:set\s+)?(?:the\s+)?(?:use by|expiration|expiry)(?:\s+date)?\s+(?:for|of|on)\s+(.+?)\s+(?:to|as)\s+(.+)$/,
];

function parseExpiry(clean, today) {
  for (const re of EXPIRY_PATTERNS) {
    const m = clean.match(re);
    if (!m) continue;
    const useBy = parseDate(m[2].replace(/^(?:on|by|until|till)\s+/, ''), today);
    if (!useBy) continue;
    const name = m[1].replace(/^(?:the|my|our|a|an)\s+/, '').trim();
    if (name) return { action: 'expiry', qty: null, unit: null, name, location: null, useBy };
  }
  return null;
}

// "half a bottle of olive oil left", "a little milk left", "the shampoo is almost empty"
const LEVEL_WORDS = { half: 0.5, 'a half': 0.5, quarter: 0.25, 'a quarter': 0.25, 'three quarters': 0.75, 'a third': 0.33, 'two thirds': 0.67, 'a little': 0.1, 'a bit': 0.1, 'very little': 0.1, 'almost nothing': 0.1, 'barely any': 0.1 };
const LEVEL_LEFT = new RegExp(`^(?:there'?s|theres|there is|we have|i have|we've got|weve got|got|only)?\\s*(${Object.keys(LEVEL_WORDS).sort((a, b) => b.length - a.length).join('|')})\\s+(?:(?:a|an|one)\\s+)?(?:([a-z]+)\\s+of\\s+|of\\s+)?(?:the\\s+|my\\s+|our\\s+)?(.+?)\\s+left$`);
const LEVEL_STATE = /^(?:the\s+|my\s+|our\s+)?(.+?)\s+(?:is|are|'s|s)\s+(half|a quarter|quarter|three quarters|almost|nearly)\s+(full|empty|gone|used up|used|left|done)$/;

function parseLevel(clean) {
  let m = clean.match(LEVEL_LEFT);
  if (m && m[3]) return { action: 'level', qty: null, unit: m[2] && UNITS.has(stem(m[2])) ? stem(m[2]) : null, name: m[3], location: null, level: LEVEL_WORDS[m[1]] };
  m = clean.match(LEVEL_STATE);
  if (m) {
    const full = /^(full|left)$/.test(m[3]);
    const v = /^(almost|nearly)$/.test(m[2]) ? (full ? 0.9 : 0.1) : LEVEL_WORDS[m[2]];
    return { action: 'level', qty: null, unit: null, name: m[1], location: null, level: full || /^(almost|nearly)$/.test(m[2]) ? v : round2(1 - v) };
  }
  return null;
}
const round2 = (n) => Math.round(n * 100) / 100;

// Typical days fresh food stays good after buying, and after opening a package.
const SHELF_LIFE = [
  [/\b(heavy cream|whipping cream|sour cream|cream cheese)\b/, 14], [/\b(milk|half and half|creamer)\b/, 7], [/\byogh?urt\b/, 14],
  [/\beggs?\b/, 28], [/\b(cheese|cheddar|parmesan|swiss|provolone|mozzarella)\b/, 21], [/\bbutter\b/, 30],
  [/\b(bread|bagels?|buns?|english muffins?)\b/, 6], [/\btortillas?\b/, 14],
  [/\b(lettuce|spinach|kale|greens|salad|arugula|cilantro|parsley|herbs)\b/, 5], [/\b(berries|strawberr(y|ies)|blueberr(y|ies)|raspberr(y|ies))\b/, 4],
  [/\bbananas?\b/, 5], [/\bavocados?\b/, 4], [/\bmushrooms?\b/, 5],
  [/\b(ground beef|ground turkey|chicken|turkey|fish|salmon|shrimp)\b/, 2], [/\b(beef|pork|steak|lamb)\b/, 3],
  [/\b(bacon|ham|hot dogs?|deli|lunch meat|salami)\b/, 7], [/\b(hummus|salsa|guacamole|tofu)\b/, 7], [/\bjuice\b/, 10],
];
const NOT_FRESH = /\b(canned|cans?|dried|frozen|diced|crushed|paste|powder|mix|chips|shelf stable|evaporated|condensed)\b/;

export function suggestShelfLife(name, location = '') {
  const t = String(name || '').toLowerCase();
  if (NOT_FRESH.test(t) || location === 'Freezer') return null;
  for (const [re, days] of SHELF_LIFE) if (re.test(t)) return days;
  return null;
}

const OPEN_LIFE = [
  [/\b(sour cream|cream cheese)\b/, 14], [/\b(milk|half and half|creamer|cream)\b/, 7], [/\bjuice\b/, 7], [/\byogh?urt\b/, 5],
  [/\b(salsa|hummus|guacamole|pesto)\b/, 7], [/\b(marinara|pasta sauce|tomato sauce|sauce)\b/, 5], [/\b(broth|stock)\b/, 4],
  [/\bwine\b/, 3], [/\bcoconut milk\b/, 4], [/\b(jam|jelly)\b/, 30], [/\b(mayo|mayonnaise|pickles?)\b/, 60], [/\bketchup\b/, 180],
];

export function openLife(name) {
  const t = String(name || '').toLowerCase();
  for (const [re, days] of OPEN_LIFE) if (re.test(t)) return days;
  return null;
}

// ---------- Pasted lists ----------

const RECEIPT_NOISE = /\b(sub ?total|total|tax|balance|change due|cash|visa|mastercard|amex|debit|credit|card #|savings|you saved|coupon|discount|thank you|receipt|store #|tel|phone|items sold|approval|auth code)\b/;

// One item per line from Notes, a text, or receipt text copied with Live Text.
export function parseListLines(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n|;/)) {
    let line = raw
      .replace(/^[\s\-–*•◦▪▢☐☑✓✔□○●>]+/, '')
      .replace(/^\[[ xX]?\]\s*/, '')
      .trim();
    if (!line || RECEIPT_NOISE.test(line.toLowerCase())) continue;
    line = line
      .replace(/\s+-?\$?\d+[.,]\d{2}\s*[A-Za-z]{0,2}$/, '') // trailing price, e.g. "3.49 F"
      .replace(/^\d{5,}\s+/, '') // leading item code
      .replace(/\s+\d{5,}$/, '')
      .replace(/^(\d+)\s*[x×]\s*/i, '$1 ') // "2x milk"
      .replace(/^(.+?)\s+[x×]\s*(\d+)$/i, '$2 $1') // "milk x2"
      .replace(/,/g, ' ')
      .trim();
    if (!/[a-z]/i.test(line)) continue;
    const a = parseCommand(`add ${line}`)[0];
    if (a?.name) out.push({ name: a.name, qty: a.qty ?? 1, unit: a.unit || '' });
  }
  return out;
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

// Words that describe the package, not the product ("6 Double Rolls", "14.5 oz").
const SIZE_WORDS = new Set(['oz', 'ounce', 'fl', 'lb', 'pound', 'g', 'gram', 'kg', 'ml', 'l', 'liter', 'litre', 'ct', 'count',
  'pack', 'pk', 'pc', 'pcs', 'qt', 'quart', 'gal', 'gallon', 'value', 'family', 'jumbo', 'mega', 'double', 'triple'].map(stem));

function coreTokens(text, brandT) {
  return [...new Set(tokens(text).filter((t) => !brandT.has(t) && !SIZE_WORDS.has(t) && !/^\d/.test(t)))].sort().join(' ');
}

// Same product name as what was said, ignoring brand, package size and plurals:
// "paper towels" is "Bounty Paper Towels", but "tomatoes" is not "Diced Tomatoes".
export function matchExact(query, items) {
  for (const item of items) {
    const brandT = new Set(tokens(item.brand));
    const want = coreTokens(query, brandT);
    if (want && want === coreTokens(item.name, brandT)) return { item, score: 1, coverage: 1 };
  }
  return null;
}

// Attach the matching inventory item to each parsed action. "milk and eggs" that doesn't
// match one item is split into two when each half matches (or when it's a shopping request).
// Shopping-list requests use your exact words (a new list item if nothing has that name);
// everything about stock you already have matches loosely.
export function resolveActions(actions, items) {
  const out = [];
  for (const a of actions) {
    const prefer = ['remove', 'out', 'open', 'level', 'expiry'].includes(a.action);
    const find = (name) =>
      a.action === 'need' ? matchExact(name, items)
      : a.action === 'unlist' || a.action === 'restock' ? matchExact(name, items) || matchItem(name, items)
      : matchItem(name, items, prefer);
    const m = find(a.name);
    if (/ and /.test(a.name) && !(m && m.coverage === 1)) {
      const parts = a.name.split(/\s+and\s+/).filter(Boolean);
      const ms = parts.map(find);
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

// A picture for items without a photo. Specific phrases come before the words inside them
// ("sour cream" before "cream", "toothbrush" before "brush"); otherwise, where it's kept.
const EMOJI_HINTS = [
  [/\b(paper towels?|toilet paper|tissues?|napkins?|kleenex)\b/, '🧻'],
  [/\b(peanut butter|peanuts?|almonds?|cashews?|walnuts?|pecans?|nuts)\b/, '🥜'],
  [/\b(dog food|dog treats?|kibble|dog)\b/, '🐶'],
  [/\b(cat food|cat litter|litter|cat)\b/, '🐱'],
  [/\b(ice cream|gelato|popsicles?)\b/, '🍨'],
  [/\b(light ?bulbs?|bulbs?)\b/, '💡'],
  [/\b(trash bags?|garbage bags?|bin bags?)\b/, '🗑️'],
  [/\b(dish soap|dishwasher|detergent|laundry|bleach|fabric softener|dryer sheets?)\b/, '🧺'],
  [/\b(sponges?|scrubbers?)\b/, '🧽'],
  [/\b(toothpaste|toothbrush(es)?|floss|mouthwash)\b/, '🪥'],
  [/\b(sour cream|cream cheese|heavy cream|whipped cream|creamer|half and half|milk|yogh?urt|kefir)\b/, '🥛'],
  [/\b(soap|hand wash|body wash)\b/, '🧼'],
  [/\b(shampoo|conditioner|lotion|sunscreen|deodorant|moisturi[sz]er|cream)\b/, '🧴'],
  [/\b(razors?|shaving)\b/, '🪒'],
  [/\b(bandages?|band aids?|first aid)\b/, '🩹'],
  [/\b(vitamins?|medicine|pills?|tylenol|advil|ibuprofen|aspirin|allergy)\b/, '💊'],
  [/\b(diapers?|baby wipes|wipes)\b/, '👶'],
  [/\b(batter(y|ies))\b/, '🔋'],
  [/\b(screws?|bolts?|washers?|anchors?|hooks?)\b/, '🔩'],
  [/\b(nails?|hammer)\b/, '🔨'],
  [/\b(paint|primer|stain|brush(es)?|rollers?)\b/, '🎨'],
  [/\b(lumber|wood|plywood|boards?|mulch)\b/, '🪵'],
  [/\b(gloves?)\b/, '🧤'],
  [/\b(candles?)\b/, '🕯️'],
  [/\b(charcoal|propane|firewood)\b/, '🔥'],
  [/\b(tape|glue|caulk|sealant|spackle|wd ?40|filters?|fuses?|wire|zip ties?|tools?)\b/, '🧰'],
  [/\b(tomato(es)?|marinara|salsa)\b/, '🍅'],
  [/\b(eggplants?)\b/, '🍆'],
  [/\b(eggs?)\b/, '🥚'],
  [/\b(cheese|cheddar|mozzarella|parmesan|swiss|provolone)\b/, '🧀'],
  [/\b(butter|margarine)\b/, '🧈'],
  [/\b(croissants?|pastr(y|ies))\b/, '🥐'],
  [/\b(bread|bagels?|buns?|tortillas?|loaf|english muffins?)\b/, '🍞'],
  [/\b(pasta|spaghetti|noodles?|macaroni|penne|lasagna|linguine)\b/, '🍝'],
  [/\b(rice)\b/, '🍚'],
  [/\b(peas|snap peas)\b/, '🫛'],
  [/\b(beans?|lentils?|chickpeas?)\b/, '🫘'],
  [/\b(olive oil|olives?|oil|vinegar)\b/, '🫒'],
  [/\b(flour|oats?|oatmeal|quinoa)\b/, '🌾'],
  [/\b(cereal|granola)\b/, '🥣'],
  [/\b(honey|syrup)\b/, '🍯'],
  [/\b(coffee|espresso|k cups?)\b/, '☕'],
  [/\b(tea)\b/, '🍵'],
  [/\b(juice|juice boxes)\b/, '🧃'],
  [/\b(water|seltzer|la croix)\b/, '💧'],
  [/\b(soda|cola|coke|pepsi|sprite|ginger ale)\b/, '🥤'],
  [/\b(beer|ale|lager|ipa)\b/, '🍺'],
  [/\b(wine)\b/, '🍷'],
  [/\b(chicken|turkey)\b/, '🍗'],
  [/\b(bacon|ham|sausages?|hot dogs?|pepperoni|salami)\b/, '🥓'],
  [/\b(beef|steak|pork|meat|burgers?|lamb)\b/, '🥩'],
  [/\b(fish|salmon|tuna|shrimp|cod|tilapia|seafood)\b/, '🐟'],
  [/\b(apples?)\b/, '🍎'], [/\b(bananas?)\b/, '🍌'], [/\b(oranges?|clementines?|mandarins?)\b/, '🍊'],
  [/\b(lemons?|limes?)\b/, '🍋'], [/\b(grapes?|raisins?)\b/, '🍇'], [/\b(strawberr(y|ies)|jam|jelly)\b/, '🍓'],
  [/\b(blueberr(y|ies)|berries)\b/, '🫐'], [/\b(peach(es)?)\b/, '🍑'], [/\b(pears?)\b/, '🍐'],
  [/\b(cherr(y|ies))\b/, '🍒'], [/\b(watermelons?|melons?)\b/, '🍉'], [/\b(pineapples?)\b/, '🍍'],
  [/\b(mangos?|mangoes)\b/, '🥭'], [/\b(avocados?|guacamole)\b/, '🥑'], [/\b(coconuts?)\b/, '🥥'],
  [/\b(carrots?)\b/, '🥕'], [/\b(potato(es)?|fries|hash browns?)\b/, '🥔'], [/\b(onions?|shallots?)\b/, '🧅'],
  [/\b(garlic)\b/, '🧄'], [/\b(lettuce|spinach|kale|greens|salad|cabbage|arugula)\b/, '🥬'], [/\b(broccoli|cauliflower)\b/, '🥦'],
  [/\b(bell peppers?|peppers?)\b/, '🫑'], [/\b(cucumbers?|pickles?|zucchini)\b/, '🥒'], [/\b(corn)\b/, '🌽'],
  [/\b(mushrooms?)\b/, '🍄'],
  [/\b(salt|spices?|cinnamon|paprika|cumin|oregano|seasoning)\b/, '🧂'],
  [/\b(sugar|candy|candies|gummies)\b/, '🍬'],
  [/\b(chips|crackers|pretzels|popcorn|snacks?)\b/, '🥨'],
  [/\b(cookies?|biscuits?)\b/, '🍪'], [/\b(chocolate|cocoa)\b/, '🍫'], [/\b(cakes?|cupcakes?|muffins?)\b/, '🧁'],
  [/\b(pies?)\b/, '🥧'], [/\b(donuts?|doughnuts?)\b/, '🍩'], [/\b(pizza)\b/, '🍕'],
  [/\b(soup|broth|stock|chili)\b/, '🍲'],
  [/\b(ketchup|mustard|mayo|mayonnaise|sauce|dressing|relish)\b/, '🫙'],
  [/\b(frozen|ice)\b/, '🧊'],
];
const PLACE_EMOJI = { Pantry: '🥫', Fridge: '🧊', Freezer: '❄️', Bathroom: '🧴', Garage: '🧰' };

export function guessEmoji(name, location = '') {
  const t = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  for (const [re, emoji] of EMOJI_HINTS) if (re.test(t)) return emoji;
  return PLACE_EMOJI[location] || '📦';
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
