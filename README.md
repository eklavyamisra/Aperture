# Aperture

Editorial photo search on the Unsplash API, with an infinite WebGL canvas mode.

```
public/       the site (index.html, style.css, api.js, pins.js, canvas.js, og.jpg, favicon.svg)
api/unsplash.js   serverless proxy: holds the key, allow-lists endpoints, CDN-caches for 1h
dev.mjs       local server that serves public/ and runs the proxy
```

## Run locally

```
node dev.mjs        # http://localhost:5173   (needs .env.local with UNSPLASH_ACCESS_KEY=...)
```

## Deploy (Vercel, free)

```
npx vercel login
npx vercel link                                  # create project "aperture"
npx vercel env add UNSPLASH_ACCESS_KEY production
npx vercel --prod
```

Live: https://aperture-bice-nine.vercel.app  (the root index.html only redirects the old GitHub Pages URL there).

## After the first deploy

1. **Rotate the key.** The old key is public in the GitHub Pages repo. Generate a new one at
   unsplash.com/oauth/applications, put it in the Vercel env var, and redeploy.
2. **Apply for Production** on the same page (50 → 5,000 requests/hr). Aperture already credits
   photographers, links back with UTM params and pings download tracking, as Unsplash requires.
3. Point the old GitHub Pages site at the new URL (or delete the key from that repo).

Deep links: `/?q=tokyo` (search) · `/?q=tokyo&view=canvas` (opens straight into the canvas) ·
`/?by=<username>` (one photographer's work) · `/#board=…` (a shared pin board, opened read-only).

## Search

- Filters on search results: sort, **shape** (landscape / portrait / square) and **tone**; the tone row also
  appears on the canvas while searching.
- The photo viewer has **More → Like this** (searches the photo's tags / description) and **By &lt;photographer&gt;**
  (uses the proxy's `/users/<username>/photos` route).
- Canvas zoom: − / % / + in the footer, Ctrl/⌘ + scroll or pinch, `+` `-` `0`. Resolution adapts when frames run slow.

## Pin boards

Boards live in `localStorage`: an index at `aperture:boards`, each board at `aperture:board:<id>` and its
camera at `aperture:board-view:<id>`. The old single-board keys (`aperture:pins`, `aperture:threads`) are
migrated into "My board" on first load.

- **Pin:** hover a frame on the canvas and press `P`, or use "Pin to …" in the photo viewer. Pins go to the active board.
- **Board:** the "Board" button or `B`. The picker next to the title switches, creates and deletes boards; click the
  title to rename.
- **Canvas:** drag empty space to pan (flicks glide), Ctrl/⌘ + scroll or pinch to zoom, *Fit* to frame everything.
- **Threads:** drag a photo's red pin onto another photo. Click a thread (or its knot) to label or cut it.
- **Groups:** *Group* / `G` adds a titled frame; photos inside move with it; resize from the corner.
- **Undo:** Ctrl/⌘+Z, Ctrl/⌘+Shift+Z (moves, unpins, threads, labels, groups, notes).
- **Keyboard:** Tab to a photo, arrows move it (Shift = bigger steps), `T` … `T` ties a thread, `Del` unpins.
- **Share:** copies a link with the whole board compressed into the URL fragment (nothing is uploaded).
  Recipients get a view-only copy and can *Save a copy* to their own boards.
- **Export:** *Image ↓* renders a PNG; *JSON ↓* / *Import* move boards between browsers (imports merge).

While the board is open the WebGL wall stops redrawing and is blurred once with CSS, so the board stays at 60 fps.
