# Aperture

Editorial photo search on the Unsplash API, with an infinite WebGL canvas mode.

```
public/       the site (index.html, style.css, api.js, canvas.js, og.jpg, favicon.svg)
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

Deep links: `/?q=tokyo` (search) · `/?q=tokyo&view=canvas` (opens straight into the canvas).
