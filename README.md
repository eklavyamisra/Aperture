# Aperture

Editorial photo search on the Unsplash API, with an infinite WebGL canvas mode and pin boards that
sync across devices when you sign in.

```
frontend/     the site: index.html, js/, css/, img/, pages/ (privacy, terms)
backend/      api/ (serverless functions: unsplash proxy, error log, config) and supabase/schema.sql
api/          one-line Vercel entry points that re-export backend/api/*
dev.mjs       local server: serves frontend/ and runs the backend functions
```

More: [ARCHITECTURE.md](ARCHITECTURE.md) (how it fits together) · [ROADMAP.md](ROADMAP.md) (what's done and next).

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

## Accounts (Supabase)

Accounts stay switched off until these are done; the site works local-only meanwhile.

1. Create a project at supabase.com (free tier is fine). Pick the region closest to your users.
2. **SQL Editor → New query**: paste `backend/supabase/schema.sql` and run it. It creates the `boards`
   table, the private `uploads` bucket and the rules that let each person see only their own data.
3. **Authentication → URL Configuration**: Site URL `https://aperture-bice-nine.vercel.app`; add
   `http://localhost:5173` to Redirect URLs for local testing.
4. **Authentication → Providers → Email**: on (magic link). For real traffic, set up custom SMTP under
   **Authentication → Emails**: Supabase's built-in mailer is only for testing and sends a few emails an hour.
5. **Google sign-in**: in Google Cloud Console create an OAuth client (type *Web application*), add
   `https://<your-project>.supabase.co/auth/v1/callback` as an authorised redirect URI, then paste the client
   ID and secret into **Authentication → Providers → Google**.
6. **Project Settings → API**: copy the Project URL and the `anon` public key, then
   ```
   npx vercel env add SUPABASE_URL production
   npx vercel env add SUPABASE_ANON_KEY production
   ```
   and redeploy. Locally, add the same two lines to `.env.local`. Never use the `service_role` key here.
7. When `schema.sql` changes (for example the `shares` table and `shared_board()` for short share links),
   paste and run it again. It's safe to re-run.

## After the first deploy

1. **Rotate the key.** The old key is public in the GitHub Pages repo. Generate a new one at
   unsplash.com/oauth/applications, put it in the Vercel env var, and redeploy.
2. **Apply for Production** on the same page (50 → 5,000 requests/hr). Aperture already credits
   photographers, links back with UTM params and pings download tracking, as Unsplash requires.
3. Point the old GitHub Pages site at the new URL (or delete the key from that repo).

Deep links: `/?q=tokyo` (search) · `/?q=tokyo&view=canvas` (opens straight into the canvas) ·
`/?by=<username>` (one photographer's work) · `/b/<code>` (a signed-in user's shared board, with a link preview; may ask for a password) ·
`/#board=…` (a board packed into the link). Shared boards open read-only.

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

**What a board can hold:** Unsplash photos, your own images (*+ Add*, drop, or paste; stored in IndexedDB by
`media.js`, downscaled to 2000 px, never uploaded), links and image addresses (`L`, drop or paste; an address that
loads as an image becomes a picture card, anything else a bookmark), and notes (`N`, or paste plain text).

- **From the wall:** `W` opens a tray of the current wall's photos — drag onto the board or click to add.
- **Select:** click, Shift+click, Shift+drag a box, or Ctrl/⌘+A. The bar at the bottom aligns, spaces, groups or removes.
- **Snapping:** dragged cards snap to other cards' edges and centres (hold Alt to place freely).
- **Find / minimap / palette:** `/` or Ctrl/⌘+F searches notes, names, links, labels and group titles; `M` toggles the
  minimap; *Palette* pulls the board's dominant colours (click to copy, or copy all as CSS).
- **Right-click** (long-press on touch) a card or empty space for its actions.
- Share links leave out uploaded images (they can't fit in a URL); *Export → Board file* includes them.
- Exporting a board image reports each Unsplash photo in it to Unsplash's download endpoint, as the API guidelines ask.

## Errors, storage, legal

- `errors.js` sends uncaught errors to `backend/api/log.js`, which writes them to the Vercel function logs
  (Project → Logs, search `[client-error]`). Reports carry the message, a trimmed stack, the page path and grid/canvas —
  no query string, board contents or visitor details.
- The board warns before browser storage fills up, and says so if a save fails.
- `/privacy` and `/terms` are plain pages (`pages/privacy.html`, `pages/terms.html`, `css/legal.css`), linked from the footer;
  `vercel.json` rewrites the short URLs, and `dev.mjs` reads the same rewrites.

## Tests

```
npm install
npx playwright install chromium
npm test              # unit tests (api/) + browser tests (tests/*.spec.js)
```

Unsplash is mocked in `tests/mock.js`, so tests need no API key and never touch the rate limit.
GitHub Actions runs them on every push to `main` and on pull requests (`.github/workflows/test.yml`).
`tests/a11y.spec.js` runs axe-core and fails on serious or critical accessibility problems.

First-time board visitors get a five-step walkthrough (`tour.js`); `?` on the board replays it.
