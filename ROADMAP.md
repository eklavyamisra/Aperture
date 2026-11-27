# Aperture roadmap

Four phases (0–3) plus a track that runs alongside all of them. Status as of 27 November 2026.

**Legend:** ✅ done · 🟡 partly done · ⏸ waiting on a decision · ⬜ not started

| Phase | Theme | Status |
|---|---|---|
| 0 | Fix before more users arrive | ✅ 4 of 5 (approval left until needed) |
| 1 | Make the board useful without Unsplash | ✅ 9 of 9 |
| 2 | Accounts and the cloud (paid tier starts here) | ✅ 6 of 6 (Supabase; #20 needs the updated schema run) |
| 3 | Teams and money | 🟡 1 of 6 (#21 built; needs the updated schema run) |
| Alongside | Growth and quality | 🟡 3 of 5 |

## Phase 0: Fix before more users arrive

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Unsplash production approval (50 → 5,000 requests/hour) | ⏸ | Owner will apply when needed. Until then the demo key's 50/hour is the main scaling limit. |
| 2 | Report an Unsplash download for each photo in a PNG export | ✅ | One API request per photo. |
| 3 | Error monitoring | ✅ | Own endpoint instead of Sentry: `frontend/js/errors.js` → `backend/api/log.js` → Vercel logs (`[client-error]`). |
| 4 | Warn before browser storage fills up | ✅ | Toast plus an error report. |
| 5 | Privacy policy and terms | ✅ | `/privacy`, `/terms`. Plain language, not legal advice; contact is GitHub issues; no governing-law clause yet. |

## Phase 1: Make the board useful without Unsplash

| # | Item | Status |
|---|---|---|
| 6 | Upload your own images (drop, paste, file picker) | ✅ |
| 7 | Paste a link to an image or page (image card or bookmark card) | ✅ |
| 8 | Notes on the board | ✅ |
| 9 | Drag photos from the wall onto the board (tray, `W`) | ✅ |
| 10 | Multi-select, align, distribute, group, delete | ✅ |
| 11 | Snap to other cards while dragging | ✅ |
| 12 | Minimap and find within a board | ✅ |
| 13 | Colour palette from a board's photos | ✅ |
| 14 | Touch: long-press menus as bottom sheets, bigger handles | ✅ |

## Phase 2: Accounts and the cloud

**Backend chosen: Supabase.** Sign-in by email magic link and Google. Boards already on a device move into the account on first sign-in. Live since 27 November 2026 (project `kumohsngovsawzukrnuw`). Setup steps: README → *Accounts (Supabase)*.

**Before real traffic:** custom SMTP for sign-in emails (Supabase's built-in mailer sends only a few an hour), and **Publish app** in Google Auth Platform (until then only listed test users can use Google sign-in). For #20, add `https://aperture-bice-nine.vercel.app/b/*` to Supabase's Redirect URLs so signing in to comment returns to the shared board (otherwise it lands on the home page).

| # | Item | Size | Status |
|---|---|---|---|
| 15 | Accounts (email magic link or Google) | M | ✅ live |
| 16 | Cloud sync of boards across devices | L | ✅ live (newest edit wins per board; offline-first) |
| 17 | Image storage for uploads | M | ✅ live (private bucket per user) |
| 18 | Shared boards with real link previews (short URLs) | M | ✅ live (`/b/<code>`, signed-in only; the link always shows the latest synced board; uploads left out) |
| 19 | Private and password-protected share links | S | ✅ built (Share panel: anyone with the link, or password only; New link; Stop sharing). "Private" means the owner decides who can open it; invite-by-email isn't included |
| 20 | Comments on shared boards | M | ✅ built; live once the updated `schema.sql` is run. Anyone who can open a `/b/` link reads comments; only signed-in people write; a comment can be about one card (badge with a count); author or board owner can delete |

## Phase 3: Teams and money

| # | Item | Size | Status |
|---|---|---|---|
| 21 | Real-time collaboration (live cursors, editing together) | L | ✅ built; live once the updated `schema.sql` is run and Realtime's "Allow public access" is off (README step 9). Share panel → "Edit with you": signed-in people with the link (and password, if set) edit together over a private Supabase Realtime channel. Changes go item by item, with avatars, cursors and cards moving while dragged. Editors save into the owner's board; they can't add device images or see the owner's uploads. Turning editing off, a new link or a new password removes editors. Invite-by-email waits for #24 |
| 22 | Presentation mode (walk through groups like slides) | M | ⬜ |
| 23 | PDF export | M | ⬜ |
| 24 | Team workspaces and roles | M | ⬜ |
| 25 | Billing with Stripe (free / pro / team) | M | ⬜ |
| 26 | Board templates for a chosen niche | S | ⬜ |

## Alongside: growth and quality

| # | Item | Status | Notes |
|---|---|---|---|
| 27 | Landing page with a waitlist | ⬜ | Validates demand before Phase 2's cost. Needs somewhere to store emails. |
| 28 | Privacy-friendly analytics (e.g. Plausible) | ⬜ | Would need a line in the privacy page. |
| 29 | First-run walkthrough on the board | ✅ | `frontend/js/tour.js`; `?` replays it. |
| 30 | Automated tests in CI | ✅ | `npm test`; GitHub Actions on push and PRs. |
| 31 | Accessibility audit | 🟡 | Automated axe scan passes (no serious/critical issues). Not yet checked with a real screen reader. |
| 32 | Layout pass: photo viewer, board toolbar, home search, board backdrop | ✅ | Tied pins no longer show a second pin while a card is lifted; the board keeps its blurred-wall backdrop after a window resize (it used to go see-through to the page below). `tests/threads.spec.js`. Board toolbar no longer scrolls sideways on phones: everyday tools (Add, Undo, Find, Wall) in one row, the rest behind ⋯ (tablets keep Group, Tidy, Palette, Share in the row too); one grouped row with dividers from 1180px up. The viewer's Close bar and actions never scroll out of reach on any screen (only the details scroll); Download full width with Unsplash and Pin side by side; side-by-side panel on phones held sideways; home photos no longer cover the search field. `tests/mobile.spec.js`. |

## Decisions only the owner can make

- **Niche.** Who it's for. Drives templates (#26), the landing page and pricing.
- ~~**Backend.**~~ Decided: Supabase.
- **Pricing.** Suggested split: free for local boards; paid for cloud sync and collaboration.

## Suggested next steps

1. Phase 3: #21 is built (run the schema, then turn off Realtime's public access). Next: #22 presentation mode and #23 PDF export (client-only);
   #24 teams and #25 billing wait on the pricing decision. Follow-ups to #21: editors' own uploads (would need a shared bucket),
   a per-item merge for notes typed by two people at once (now the last edit wins), and live comments over the same channel.
   Follow-ups to #15–20: comment notifications (email or an unread count), live comments instead of the 20 s refresh, full account deletion from inside the app (needs a server key), live updates instead of the 45 s sync check,
   and showing uploaded images on shared boards (signed URLs from the private bucket).
2. #27 landing page and waitlist (can share the same backend for storing emails).
3. #22 presentation mode and #23 PDF export are client-only and can be done any time.
