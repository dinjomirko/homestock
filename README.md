# Homestock

**Live:** https://dinjomirko.github.io/homestock/

A tiny household inventory app: pantry, fridge, bathroom, garage. Built so keeping it current takes seconds.

- **Scan** — point the camera at a barcode (horizontal or vertical). Three modes: *Add* (unpacking groceries), *Use* (taking something out) and *Check* (in the store: "do I have this?", changes nothing). A new product is looked up (Open Food/Beauty/Products Facts, then UPCitemdb) and confirmed once on a card under the camera; if it looks like something you already added by voice, one tap links them. After that every scan just counts it. Packs like "12 Mega Rolls" add 12 rolls per scan. Beep + flash on every read, flashlight and zoom where the phone supports them.
- **Speak** — tap the mic and say it: "removing a roll of paper towels", "used 2 cans of tomatoes and a box of spaghetti", "we're out of milk", "we have 3 rolls of duct tape", "add coffee to the shopping list". Ask questions too — "how many rolls of toilet paper do we have?" — and it answers out loud. You can type the same sentences.
- **Shop** — anything at or below its "add to list at" level, or that you asked for, appears here. Type to add things; tick them off as you shop and they go back into stock (tap again to undo). Swipe left or tap ✕ to take something off the list; on the Stock tab, swipe a row left to put it on the list.
- **Stores** — tag items with where you buy them (Costco, Aldi…), then pick the store at the top of the list to see what to get there plus anything not tied to a store. Voice understands "add eggs to the Costco list" and "bought paper towels at Costco". Manage stores from ⋯ → Stores.
- **Share to Notes** — Share sends the list (or one store's list) as one item per line. In the Notes share card, choose which note to add it to; in the note, select the lines and tap the checklist button to make them checkable. (Notes doesn't let other apps create checkboxes directly.)
- **Use by** — optional dates; a "Use soon" filter shows what to eat first, and the recipe question lists those first.
- **What can I cook?** — copies your kitchen contents as a question to paste into Claude or any recipe assistant.
- Every change can be undone. Data stays on the device (localStorage); back up/restore from the ⋯ menu.

No build step. Plain HTML/CSS/JS modules, installable to the home screen and usable offline.

## Run it

```bash
npm start        # serves on http://localhost:5190
npm test         # voice-command parser tests
```

Camera and microphone need HTTPS, so phones use the live GitHub Pages site. Publishing is automatic: `git push` to `main` and the site updates within a minute or two. On the phone: open the link, then Share → Add to Home Screen.

## Files

- `parser.js` — turns sentences into actions and matches names to items (pure, tested)
- `app.js` — UI, camera scanning, voice, shopping list
- `scan-worker.js` — barcode decoding off the main thread (ZXing, upright + rotated)
- `sw.js`, `manifest.webmanifest` — offline + install
