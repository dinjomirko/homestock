# Homestock

**Live:** https://dinjomirko.github.io/homestock/

A tiny household inventory app: pantry, fridge, bathroom, garage. Built so keeping it current takes seconds.

- **Scan** — point the camera at a barcode. A new product is looked up (Open Food/Beauty/Products Facts, then UPCitemdb) and you confirm it once; after that every scan just counts it. Switch between *Adding* (unpacking groceries) and *Using up*. Packs like "12 Mega Rolls" add 12 rolls per scan.
- **Speak** — tap the mic and say it: "removing a roll of paper towels", "used 2 cans of tomatoes and a box of spaghetti", "we're out of milk", "we have 3 rolls of duct tape", "add coffee to the shopping list". You can type the same sentences.
- **Shop** — anything at or below its "shop when down to" level, or that you asked for, appears here. Tick it when bought and it goes back into stock. Share the list by text.
- **What can I cook?** — copies your kitchen contents as a question to paste into Claude or any recipe assistant.
- Every change can be undone from the toast. Data stays on the device (localStorage); back up/restore from the ⋯ menu.

No build step. Plain HTML/CSS/JS modules, installable to the home screen and usable offline.

## Run it

```bash
npm start        # serves on http://localhost:5190
npm test         # voice-command parser tests
```

Camera and microphone need HTTPS, so phones use the live GitHub Pages site. Publishing is automatic: `git push` to `main` and the site updates within a minute or two. On the phone: open the link, then Share → Add to Home Screen.

## Files

- `parser.js` — turns sentences into actions and matches names to items (pure, tested)
- `app.js` — UI, scanning, voice, shopping list
- `sw.js`, `manifest.webmanifest` — offline + install
