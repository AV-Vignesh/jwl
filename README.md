# JewelBox

Private gold & silver jewellery portfolio, built as a PWA. **All data stays on your phone** — IndexedDB for jewels and photos, localStorage for settings. Nothing is sent anywhere except the rate API you configure.

## Features
- Photo, weight, purity (hallmark 999/916/750/925), owner, purchase date & price per jewel
- Live gold/silver rates (goldapi.io or metals.dev — your own free key) with 24h caching, India premium %, and manual override
- Portfolio value, gain vs invested, and honest "recovery if sold" estimate
- Themes: Velvet (dark), Ivory (light), Onyx (AMOLED) + 5 accent colors
- Export/Import JSON backup (photos included)
- Works offline, installable to home screen

## Publish on GitHub Pages
1. Create a repo, push these files to the root of `main`.
2. Repo → Settings → Pages → Source: `main` / root.
3. Open `https://<username>.github.io/<repo>/` on your phone → browser menu → **Add to Home Screen**.

## Rate API key
Get a free key at [goldapi.io](https://www.goldapi.io) (100 req/month) or [metals.dev](https://metals.dev). Paste it in **Settings → API key** inside the app. The key is stored only in your browser's localStorage — never in this repo.

## Backup discipline
Data is device-local. Export a backup from Settings before clearing browser data or switching phones.
