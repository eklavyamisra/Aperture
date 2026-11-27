# Aperture

Editorial photo search on the Unsplash API, with an infinite WebGL wall and pin boards.
Live at https://aperture-bice-nine.vercel.app (Vercel, deploys from `main`).

- **Plan and status:** [ROADMAP.md](ROADMAP.md). Update it whenever an item is finished.
- **How it fits together:** [ARCHITECTURE.md](ARCHITECTURE.md).
- **Run:** `node dev.mjs` (needs `.env.local` with `UNSPLASH_ACCESS_KEY`, plus `SUPABASE_URL` and `SUPABASE_ANON_KEY` for accounts; never commit it).
- **Test:** `npm test`. Unsplash is mocked, so tests need no key. Add or update a test with each change.

## Working rules

- **Frontend** is `frontend/` (no build step or framework: plain scripts in `frontend/js/`, styles in `frontend/css/`, globals shared through `js/api.js` and `window.*`).
- **Backend** is `backend/`: serverless functions in `backend/api/` and the database schema in `backend/supabase/schema.sql`. The root `api/` folder only holds one-line Vercel entry points that re-export `backend/api/*`; add a matching one for each new function.
- Short URLs (`/privacy`, `/terms`) are rewrites in `vercel.json`; `dev.mjs` reads the same file.
- Anything read from storage, imports or share links must go through `cleanItem` / `cleanBoard` in `pins.js`.
- Respect `reduceMotion`, keep touch targets at 44 px or more on coarse pointers, and check mobile widths.
- Don't spend the Unsplash demo key (50 requests/hour) on manual testing; use the Playwright suite.
- Commit or push only when the owner asks.
