# Key Record

**Live:** https://dinjomirko.github.io/homestock/

A tiny household inventory app: pantry, fridge, bathroom, garage, plus a record of what's in the house itself. Built so keeping it current takes seconds.

- **Scan** — point the camera at a barcode (horizontal or vertical). Three modes: *Add* (unpacking groceries), *Use* (taking something out) and *Check* (in the store: "do I have this?", changes nothing). A new product is looked up (Open Food/Beauty/Products Facts, then UPCitemdb) and confirmed once on a card under the camera; if it looks like something you already added by voice, one tap links them. After that every scan just counts it. Packs like "12 Mega Rolls" add 12 rolls per scan. Beep + flash on every read, flashlight and zoom where the phone supports them.
- **Speak** — tap the mic and say it: "removing a roll of paper towels", "used 2 cans of tomatoes and a box of spaghetti", "we're out of milk", "we have 3 rolls of duct tape", "add coffee to the shopping list". Ask questions too — "how many rolls of toilet paper do we have?" — and it answers out loud. You can type the same sentences.
- **Shop** — anything at or below its "add to list at" level, or that you asked for, appears here. Type to add things; tick them off as you shop and they go back into stock (tap again to undo). Swipe left or tap ✕ to take something off the list; on the Stock tab, swipe a row left to put it on the list.
- **Stores** — tag items with where you buy them (Costco, Aldi…), then pick the store at the top of the list to see what to get there plus anything not tied to a store. Voice understands "add eggs to the Costco list" and "bought paper towels at Costco". On the shopping list, tap an item's store tag to pick a store, or press and hold the item and drag it onto a store in the tray. Manage stores from ⋯ → Stores.
- **Share to Notes** — Share sends the list (or one store's list) as one item per line. In the Notes share card, choose which note to add it to; in the note, select the lines and tap the checklist button to make them checkable. (Notes doesn't let other apps create checkboxes directly.)
- **Use by** — optional dates; a "Use soon" filter shows what to eat first, and the recipe question lists those first.
- **Places** — rename, reorder or remove places, and tap a place to add spots inside it like Shelf 2, Top drawer or Bin A (⋯ → Places & spots). On an item's page, pick the place first, then a spot — the spot list only shows that place's spots, with "+ New spot…" at the end. Stock groups each place by spot, and voice understands "put 3 boxes of screws on shelf 2 in the garage". Tap a place or spot heading on Stock to collapse it.
- **Moving things** — press and hold an item on Stock and drag it straight onto a place or spot heading, any item already there, or a place chip at the top (they wrap so every place is in reach); the list scrolls as you near the edge. Let go without dragging to pick several, then drag any picked item to move them all, or use Move to. For an item kept in several places, only the row you moved goes. On the shopping list, drag an item onto a store heading or store chip. Places and spots fold away with a tap on their heading.
- **Exact counts** — counted a shelf? Tap the number on a Stock row and type it ("12", "2.5", "1 1/2"). On the shopping list, ticked-off items show − and + so the count matches what you actually bought. Adding something by hand that you already track offers the existing one instead of making a duplicate.
- **Opened & partly used** — "opened the salsa" starts its after-opening clock; "half a bottle of olive oil left" / "the shampoo is almost empty" record what's left (shown as ½, ¼…).
- **Use-by, faster** — one-tap +3 days / 1 week / 2 weeks / 1 month, "milk expires Friday", and the app remembers how long each item lasts so the next purchase gets a date automatically (typical shelf lives are suggested for fresh food). Optional count of use-soon items on the home-screen icon.
- **House** (own tab) — appliances, furniture, electronics and other belongings, kept apart from stock: room, type, brand, model and serial numbers, how many, when and where bought, price, warranty end date, a receipt or label photo, a manual link and notes. Model and serial numbers can be read off their label's barcode (or with iPhone's Scan Text), and the app warns about a serial number already on something else, a price typo, or a warranty that ends before the purchase. Upkeep reminders (suggested for things like furnaces, fridges and dryers) and warranties ending within two months show under *Needs attention*, with one tap to mark upkeep done. Scan on the House tab looks a product up and starts its record. Share the whole inventory as text or a spreadsheet (CSV) for an insurer. Rooms are managed from ⋯ → Rooms on the House tab. Stock searches also show matching belongings.
- **Paste a list** — paste lines from Notes, a text, or receipt text copied with Live Text; review the names and add them to stock or the shopping list at once.
- **Recipes** (own tab) — tick the ingredients you want to cook with (quick picks: use soon, all, none), choose meal, servings, extras and notes, then Copy the question or Ask Claude (opens Claude with it filled in).
- **Photos** — scanned products bring their own; for anything else, tap the picture on the item's page to take or choose one (stored as a small thumbnail). Items without a photo show a matching emoji.
- **Household sharing** — ⋯ → Household sharing: sign in or create an account (email + password), then start a household (you become its owner and get an 8-character code) or join one with its code. Signing in on another phone brings the household back. The owner can remove members and replace the code. Everyone sees the same stock, list, stores and places, live, and each item shows who changed it last. Works offline and catches up later. Backed by the Supabase project in `config.js`; set up with `supabase/schema.sql`.
- **Hey Siri** — ⋯ → Set up "Hey Siri, Key Record" builds a Shortcut that dictates and opens `?say=…`, which runs the command.
- Every change can be undone. Data stays on the device (localStorage); back up/restore from the ⋯ menu.

No build step. Plain HTML/CSS/JS modules, installable to the home screen and usable offline.

## Run it

```bash
npm start        # serves on http://localhost:5190
npm test         # voice-command parser tests
npm run release  # bump the file versions — run before pushing any change
```

Every release must bump the version (`npm run release`): the page loads `app.js?v=N`, which imports `parser.js?v=N`, so a phone never mixes a new file with a cached old one. If the app still fails to start, `index.html` clears the offline copy and reloads once, then offers a Reload button.

Camera and microphone need HTTPS, so phones use the live GitHub Pages site. Publishing is automatic: `git push` to `main` and the site updates within a minute or two. On the phone: open the link, then Share → Add to Home Screen.

## Files

- `parser.js` — turns sentences into actions and matches names to items (pure, tested)
- `app.js` — UI, camera scanning, voice, shopping list
- `scan-worker.js` — barcode decoding off the main thread (ZXing, upright + rotated)
- `sw.js`, `manifest.webmanifest` — offline + install
