// Bumps the app version everywhere a file is referenced, so after an update phones load a
// matching set of files instead of mixing a new one with a cached old one.
// Run before committing a change: `npm run release`.
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('..', import.meta.url);
const read = (f) => readFileSync(new URL(f, root), 'utf8');
const write = (f, s) => writeFileSync(new URL(f, root), s);

const sw = read('sw.js');
const current = Number(sw.match(/const VERSION = (\d+);/)[1]);
const next = current + 1;

write('sw.js', sw.replace(/const VERSION = \d+;/, `const VERSION = ${next};`));
write('index.html', read('index.html').replace(/(app\.js|styles\.css)\?v=\d+/g, `$1?v=${next}`));
for (const f of ['app.js', 'sync.js']) write(f, read(f).replace(/\.\/(parser|sync|config)\.js\?v=\d+/g, `./$1.js?v=${next}`));
console.log(`Homestock version ${current} → ${next}`);
