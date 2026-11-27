// All Unsplash calls go through /api/unsplash (see backend/api/unsplash.js): the key
// stays on the server and the CDN caches responses.
const PROXY = "/api/unsplash";
const UTM = "utm_source=aperture&utm_medium=referral";
const PER_PAGE = 24;
const AUTO_PAGES = 3; // pages fetched by infinite scroll before we ask

gsap.registerPlugin(ScrollTrigger, Flip);

const q = (s, root = document) => root.querySelector(s);
const qa = (s, root = document) => [...root.querySelectorAll(s)];

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const canHover = matchMedia("(hover: hover) and (pointer: fine)").matches;

if ("scrollRestoration" in history) history.scrollRestoration = "manual";
window.scrollTo(0, 0);

/* ----------------------------------------------------------
   Elements
---------------------------------------------------------- */
const gridEl = q("#grid");
const gridState = q("#grid-state");
const showMore = q("#show-more-button");
const sentinel = q("#sentinel");
const titleEl = q("#results-title");
const resultsEl = q("#results");
const filtersEl = q("#filters");
const dock = q("#dock");
const lightbox = q("#lightbox");
const lbImg = q("#lb-img");
const lbStage = q("#lb-stage");

/* ----------------------------------------------------------
   State
---------------------------------------------------------- */
const state = {
    mode: "feed", // "feed" | "search" | "user"
    query: "",
    user: null, // { username, name } in "user" mode
    order: "relevant",
    color: "",
    orientation: "",
    page: 1,
    totalPages: Infinity,
    total: 0,
    photos: [],
    cards: [],
    ids: new Set(),
    loading: false,
    autoLoads: 0,
    token: 0, // guards against stale responses when searches overlap
    density: 3,
};

try {
    const saved = parseInt(localStorage.getItem("aperture:density"), 10);
    if ([2, 3, 4].includes(saved)) state.density = saved;
} catch (e) {}

/* ----------------------------------------------------------
   Smooth scroll (Lenis) driven by the GSAP ticker
---------------------------------------------------------- */
let lenis = null;
let scrollVelocity = 0;

if (!reduceMotion) {
    lenis = new Lenis({ lerp: 0.09, smoothWheel: true });
    lenis.on("scroll", (e) => {
        scrollVelocity = e.velocity;
        ScrollTrigger.update();
    });
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
    lenis.stop();
}

function scrollToTarget(target, opts = {}) {
    if (lenis) lenis.scrollTo(target, { duration: 1.6, easing: (t) => 1 - Math.pow(1 - t, 4), ...opts });
    else if (typeof target === "number") window.scrollTo(0, target);
    else target.scrollIntoView({ block: "start" });
}

/* ----------------------------------------------------------
   Helpers
---------------------------------------------------------- */
const pad = (n, l = 3) => String(n).padStart(l, "0");
const fmt = (n) => Number(n).toLocaleString("en-US");
const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const utm = (url) => `${url}${url.includes("?") ? "&" : "?"}${UTM}`;
const imgUrl = (p, w, qual = 75) => `${p.urls.raw}&w=${w}&q=${qual}&auto=format&fit=max`;
const photoTitle = (p) => {
    const t = (p.description || p.alt_description || "Untitled frame").trim();
    return t.length > 90 ? t.slice(0, 88).trimEnd() + "…" : t;
};

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

async function api(path, params = {}) {
    const url = new URL(PROXY, location.origin);
    url.searchParams.set("path", path);
    Object.entries(params).forEach(([k, v]) => v !== "" && v != null && url.searchParams.set(k, v));

    let res;
    try {
        res = await fetch(url);
    } catch (e) {
        throw new ApiError(0, "network");
    }

    const remaining = res.headers.get("X-Ratelimit-Remaining");
    const limit = res.headers.get("X-Ratelimit-Limit");
    if (remaining) {
        q("#hud-rate").textContent = limit ? `${remaining}/${limit}` : remaining;
        qa(".hud-rate-wrap").forEach((el) => (el.hidden = false));
    }

    if (!res.ok) throw new ApiError(res.status, res.statusText);
    return res.json();
}

function describeError(err) {
    if (err.status === 403 || err.status === 429)
        return ["Out of film.", "Aperture is very popular right now. Give it a few minutes and try again."];
    if (err.status === 401 || err.status === 500) return ["Darkroom closed.", "The server couldn’t talk to Unsplash. Try again shortly."];
    if (err.status === 0) return ["No signal.", "Couldn’t reach Unsplash. Check your connection and try again."];
    return ["Something slipped.", `Unsplash answered with ${err.status || "an error"}. Try again in a moment.`];
}

/* ----------------------------------------------------------
   Masonry
---------------------------------------------------------- */
let cols = [];
let colHeights = [];

function colCount() {
    const w = window.innerWidth;
    if (w < 600) return state.density === 2 ? 1 : 2;
    if (w < 1000) return Math.min(state.density, 3);
    return state.density;
}

function layout() {
    const n = colCount();
    gridEl.innerHTML = "";
    cols = [];
    colHeights = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        const c = document.createElement("div");
        c.className = "grid-col";
        c._y = 0;
        gridEl.appendChild(c);
        cols.push(c);
    }
    const sizes = n === 1 ? "100vw" : `${Math.ceil(100 / n)}vw`;
    state.cards.forEach((card) => {
        card.querySelector("img.card-img").sizes = sizes;
        place(card);
    });
}

function place(card) {
    let i = 0;
    for (let k = 1; k < colHeights.length; k++) if (colHeights[k] < colHeights[i] - 0.001) i = k;
    cols[i].appendChild(card);
    colHeights[i] += card._ratio + 0.04;
    return i;
}

let lastCols = 0;
let resizeTimer;
window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        if (colCount() !== lastCols) {
            lastCols = colCount();
            layout();
        }
        if (!lightbox.hidden) positionLightboxImage(true);
    }, 150);
});

/* velocity drift — alternate columns lag behind the scroll */
if (!reduceMotion) {
    gsap.ticker.add(() => {
        if (cols.length < 2) return;
        const v = gsap.utils.clamp(-40, 40, scrollVelocity * 1.4);
        cols.forEach((c, i) => {
            const target = i % 2 ? v : -v * 0.4;
            c._y += (target - c._y) * 0.08;
            if (Math.abs(c._y) < 0.05 && target === 0) c._y = 0;
            c.style.transform = `translate3d(0, ${c._y.toFixed(2)}px, 0)`;
        });
    });
}

/* reveal as cards scroll in */
const revealer = new IntersectionObserver(
    (entries) => {
        entries.forEach((e) => {
            if (!e.isIntersecting) return;
            e.target.classList.add("is-in");
            revealer.unobserve(e.target);
        });
    },
    { rootMargin: "0px 0px -8% 0px" }
);

function makeCard(p, index, batchIndex) {
    const fig = document.createElement("figure");
    fig.className = "card";
    fig._ratio = p.height / p.width;
    fig.style.setProperty("--c", p.color || "#222");
    fig.style.setProperty("--lqip", `url("${p.urls.raw}&w=24&q=20&auto=format")`);
    fig.style.setProperty("--d", `${Math.min(batchIndex, 8) * 0.06}s`);

    const name = p.user?.name || "Unknown";
    const alt = p.alt_description || photoTitle(p);
    const n = colCount();

    fig.innerHTML = `
        <button class="card-media" data-cursor="View" aria-label="Open “${esc(alt)}” by ${esc(name)}" style="aspect-ratio:${p.width} / ${p.height}">
            <img class="card-img" alt="${esc(alt)}" loading="lazy" decoding="async"
                srcset="${[400, 700, 1000, 1400].map((w) => `${imgUrl(p, w)} ${w}w`).join(", ")}"
                sizes="${n === 1 ? "100vw" : Math.ceil(100 / n) + "vw"}"
                src="${imgUrl(p, 700)}">
            <span class="card-cap">
                <span class="card-author"><img src="${p.user?.profile_image?.small || ""}" alt="" loading="lazy"><span>${esc(name)}</span></span>
                <span class="card-hex mono">${esc((p.color || "").toUpperCase())}</span>
            </span>
        </button>
        <span class="card-idx mono">N° ${pad(index + 1)}</span>`;

    const img = fig.querySelector(".card-img");
    const loaded = () => fig.classList.add("is-loaded");
    if (img.complete && img.naturalWidth) loaded();
    else img.addEventListener("load", loaded, { once: true });

    fig.querySelector(".card-media").addEventListener("click", () => openLightbox(state.cards.indexOf(fig)));

    if (reduceMotion) fig.classList.add("is-in");
    else revealer.observe(fig);
    return fig;
}

/* ----------------------------------------------------------
   Data loading
---------------------------------------------------------- */
function hasMore() {
    if (state.mode === "feed") return state.page <= 10;
    return state.page <= state.totalPages;
}

async function fetchPage() {
    if (state.mode === "feed") {
        const data = await api("/photos", { page: state.page, per_page: PER_PAGE });
        return { results: data, total: null, totalPages: Infinity };
    }
    if (state.mode === "user") {
        const data = await api(`/users/${state.user.username}/photos`, { page: state.page, per_page: PER_PAGE });
        return { results: Array.isArray(data) ? data : [], total: null, totalPages: Infinity };
    }
    const data = await api("/search/photos", {
        query: state.query,
        page: state.page,
        per_page: PER_PAGE,
        order_by: state.order,
        color: state.color,
        orientation: state.orientation,
    });
    return { results: data.results, total: data.total, totalPages: data.total_pages };
}

async function loadPage() {
    if (state.loading || !hasMore()) return;
    state.loading = true;
    const token = state.token;
    showMore.classList.add("is-busy");

    try {
        const { results, total, totalPages } = await fetchPage();
        if (token !== state.token) return;

        if (total !== null) {
            state.total = total;
            state.totalPages = totalPages;
        }
        state.page++;
        if (state.mode === "feed" && results.length === 0) state.page = 11;
        // the user endpoint has no total in the body: a short page means we're done
        if (state.mode === "user" && results.length < PER_PAGE) state.totalPages = state.page - 1;

        const fresh = results.filter((p) => !state.ids.has(p.id));
        fresh.forEach((p, k) => {
            state.ids.add(p.id);
            state.photos.push(p);
            const card = makeCard(p, state.photos.length - 1, k);
            state.cards.push(card);
            place(card);
        });

        if (state.photos.length === 0) renderEmpty();
        else gridState.hidden = true;
        updateCounts();
    } catch (err) {
        if (token !== state.token) return;
        renderError(err);
        throw err;
    } finally {
        if (token === state.token) {
            state.loading = false;
            showMore.classList.remove("is-busy");
            gridEl.classList.remove("is-busy");
            updateMore();
            // re-arm infinite scroll in case the sentinel never left the viewport
            loadObserver.unobserve(sentinel);
            loadObserver.observe(sentinel);
        }
    }
}

function updateCounts() {
    q("#hud-count").textContent = pad(state.photos.length);
    q("#results-total").textContent =
        state.mode === "search"
            ? `${fmt(state.total)} frames found`
            : state.mode === "user"
              ? `Work by ${state.user.name}`
              : "Curated by Unsplash editors";
}

function updateMore() {
    const more = hasMore() && state.photos.length > 0;
    showMore.hidden = !more || state.autoLoads < AUTO_PAGES;
    q("#more-count").textContent =
        state.mode === "search" ? `${pad(state.photos.length)} / ${fmt(state.total)}` : `${pad(state.photos.length)} loaded`;
}

function renderEmpty() {
    gridState.hidden = false;
    gridState.innerHTML = `
        <h3>Nothing developed.</h3>
        <p>${state.mode === "user" ? `No public photographs from ${esc(state.user.name)}.` : `No photographs matched “${esc(state.query)}”${state.color || state.orientation ? " with those filters" : ""}. Try something broader.`}</p>
        <div class="chips">
            <button class="chip" data-q="Light">Light</button>
            <button class="chip" data-q="Mountains">Mountains</button>
            <button class="chip" data-q="Interior">Interior</button>
            <button class="chip" data-q="Rain">Rain</button>
        </div>`;
}

function renderError(err) {
    const [title, body] = describeError(err);
    gridState.hidden = false;
    gridState.innerHTML = `<h3>${title}</h3><p>${body}</p>`;
    gridEl.classList.remove("is-busy");
}

/* infinite scroll for the first few pages, then an explicit button */
const loadObserver = new IntersectionObserver(
    (entries) => {
        if (!entries[0].isIntersecting) return;
        if (state.loading || !hasMore() || state.autoLoads >= AUTO_PAGES || state.photos.length === 0) return;
        state.autoLoads++;
        loadPage().catch(() => {});
    },
    { rootMargin: "0px 0px 900px 0px" }
);
loadObserver.observe(sentinel);

showMore.addEventListener("click", () => loadPage().catch(() => {}));

/* ----------------------------------------------------------
   Results header
---------------------------------------------------------- */
function setTitle(html, kicker) {
    const span = titleEl.querySelector("span");
    q("#results-kicker").textContent = kicker;
    if (reduceMotion) {
        span.innerHTML = html;
        return;
    }
    gsap.killTweensOf(span);
    gsap.to(span, {
        yPercent: -110,
        duration: 0.45,
        ease: "power3.in",
        onComplete: () => {
            span.innerHTML = html;
            gsap.fromTo(span, { yPercent: 110 }, { yPercent: 0, duration: 1, ease: "expo.out" });
        },
    });
}

function resetResults() {
    state.token++;
    state.page = 1;
    state.totalPages = Infinity;
    state.total = 0;
    state.photos = [];
    state.cards = [];
    state.ids = new Set();
    state.loading = false;
    state.autoLoads = 0;
    gridState.hidden = true;
    showMore.hidden = true;
    layout();
}

async function runSearch(query, { scroll = true } = {}) {
    query = query.trim();
    if (!query) return;

    const changed = query.toLowerCase() !== state.query.toLowerCase() || state.mode !== "search";
    state.mode = "search";
    state.query = query;
    state.user = null;
    if (changed) {
        state.order = "relevant";
        state.color = "";
        state.orientation = "";
        syncFilters();
    }
    syncModeUI();

    qa(".js-search input").forEach((i) => (i.value = query));
    qa(".js-search input").forEach((i) => i.blur());
    try {
        const url = new URL(location.href);
        url.searchParams.set("q", query);
        url.searchParams.delete("by");
        history.replaceState(null, "", url);
    } catch (e) {}

    document.title = `${query} — Aperture`;
    q("#hud-mode").textContent = `“${query.toUpperCase()}”`;
    filtersEl.hidden = false;
    setTitle(`<em>“</em>${esc(query)}<em>”</em>`, "(Search results)");

    if (scroll) scrollToTarget(resultsEl, { offset: -40 });
    await refresh();
}

// show everything one photographer has published
async function runUser(username, name, { scroll = true } = {}) {
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(username || "")) return;
    name = name || username;
    state.mode = "user";
    state.user = { username, name };
    state.query = "";
    state.order = "relevant";
    state.color = "";
    state.orientation = "";
    syncFilters();
    syncModeUI();

    qa(".js-search input").forEach((i) => (i.value = ""));
    try {
        const url = new URL(location.href);
        url.searchParams.set("by", username);
        url.searchParams.delete("q");
        history.replaceState(null, "", url);
    } catch (e) {}

    document.title = `${name} — Aperture`;
    q("#hud-mode").textContent = `@${username.toUpperCase()}`;
    filtersEl.hidden = true;
    setTitle(`<em>by</em> ${esc(name)}`, "(Photographer)");

    if (scroll) scrollToTarget(resultsEl, { offset: -40 });
    await refresh();
}

// colour / orientation only exist for searches; the canvas tone row follows that
function syncModeUI() {
    const tones = q("#cv-tones");
    if (tones) tones.hidden = state.mode !== "search";
}

async function refresh() {
    gridEl.classList.add("is-busy");
    const old = state.cards;
    if (old.length && !reduceMotion) {
        await gsap.to(gridEl, { opacity: 0, y: 30, duration: 0.35, ease: "power2.in" });
    }
    resetResults();
    gsap.set(gridEl, { opacity: 1, y: 0 });
    await loadPage().catch(() => {});
}

/* forms, chips, marquee */
qa(".js-search").forEach((form) =>
    form.addEventListener("submit", (e) => {
        e.preventDefault();
        runSearch(form.querySelector("input").value);
    })
);

document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-q]");
    if (t) runSearch(t.dataset.q);
});

/* filters */
function syncFilters() {
    qa("[data-order]").forEach((b) => {
        const on = b.dataset.order === state.order;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-checked", on);
    });
    qa("[data-color]").forEach((b) => {
        const on = b.dataset.color === state.color;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-checked", on);
    });
    qa("[data-orient]").forEach((b) => {
        const on = b.dataset.orient === state.orientation;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-checked", on);
    });
}

qa("[data-orient]").forEach((b) =>
    b.addEventListener("click", () => {
        if (state.orientation === b.dataset.orient) return;
        state.orientation = b.dataset.orient;
        syncFilters();
        refresh();
    })
);

qa("[data-order]").forEach((b) =>
    b.addEventListener("click", () => {
        if (state.order === b.dataset.order) return;
        state.order = b.dataset.order;
        syncFilters();
        refresh();
    })
);

qa("[data-color]").forEach((b) =>
    b.addEventListener("click", () => {
        if (state.color === b.dataset.color) return;
        state.color = b.dataset.color;
        syncFilters();
        refresh();
    })
);

/* density */
function syncDensity() {
    qa("[data-density]").forEach((b) => {
        const on = +b.dataset.density === state.density;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-checked", on);
    });
}
syncDensity();

qa("[data-density]").forEach((b) =>
    b.addEventListener("click", () => {
        const d = +b.dataset.density;
        if (d === state.density) return;
        state.density = d;
        try {
            localStorage.setItem("aperture:density", d);
        } catch (e) {}
        syncDensity();

        // only animate cards on screen; the rest just snap into place
        const visible = state.cards.filter((c) => {
            const r = c.getBoundingClientRect();
            return r.bottom > -200 && r.top < innerHeight + 200;
        });
        const flipState = reduceMotion ? null : Flip.getState(visible);
        lastCols = colCount();
        layout();
        if (flipState) {
            Flip.from(flipState, {
                duration: 1,
                ease: "expo.inOut",
                stagger: 0.012,
                onEnter: (els) => gsap.fromTo(els, { opacity: 0 }, { opacity: 1, duration: 0.6 }),
            });
        }
    })
);

/* ----------------------------------------------------------
   Lightbox — FLIP from the thumbnail
---------------------------------------------------------- */
const lb = { i: -1, hidden: null, lastFocus: null, busy: false };

// keep these in step with the lightbox media queries in style.css
// photo above, panel below (phones held upright)
const lbStacked = () => matchMedia("(max-width: 860px) and (min-height: 521px), (max-width: 560px)").matches;
// small screens: tighter margins around the photo (phones either way up, short windows)
const lbCompact = () => matchMedia("(max-width: 860px), (max-height: 640px)").matches;

function fitRect(p) {
    const s = lbStage.getBoundingClientRect();
    const pad = lbCompact() ? 16 : 48;
    const px = pad;
    const pt = pad;
    const pb = pad;
    const aw = s.width - px * 2;
    const ah = s.height - pt - pb;
    const scale = Math.min(aw / p.width, ah / p.height);
    const w = p.width * scale;
    const h = p.height * scale;
    return { x: s.left + (s.width - w) / 2, y: s.top + pt + (ah - h) / 2, width: w, height: h };
}

function positionLightboxImage(immediate) {
    const p = state.photos[lb.i];
    if (!p) return;
    const r = fitRect(p);
    if (immediate) gsap.set(lbImg, r);
    return r;
}

function fillPanel(p) {
    const user = p.user || {};
    lightbox.style.setProperty("--c", p.color || "#222");
    q("#lb-index").textContent = `${pad(lb.i + 1)} / ${state.mode === "search" ? fmt(state.total) : pad(state.photos.length)}`;
    q("#lb-title").textContent = photoTitle(p);
    q("#lb-author").href = utm(user.links?.html || "https://unsplash.com");
    q("#lb-avatar").src = user.profile_image?.medium || "";
    q("#lb-name").textContent = user.name || "Unknown";
    q("#lb-credit-name").textContent = user.name || "Unknown";
    q("#lb-credit-name").href = utm(user.links?.html || "https://unsplash.com");
    q("#lb-handle").textContent = user.username ? `@${user.username}` : "";
    q("#lb-dim").textContent = `${fmt(p.width)} × ${fmt(p.height)}`;
    q("#lb-color").textContent = (p.color || "—").toUpperCase();
    q("#lb-likes").textContent = fmt(p.likes || 0);
    q("#lb-date").textContent = new Date(p.created_at).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
    });
    q("#lb-loc").textContent = user.location || "—";
    q("#lb-download").href = `${p.links.download}?force=true&${UTM}`;
    q("#lb-download").dataset.track = p.links.download_location;
    q("#lb-open").href = utm(p.links.html);
    const sim = similarQuery(p);
    const simBtn = q("#lb-similar");
    simBtn.disabled = !sim;
    simBtn.title = sim ? `Search “${sim}”` : "No description to search with";
    const byBtn = q("#lb-by");
    q("#lb-by-name").textContent = user.name || "photographer";
    byBtn.disabled = !user.username || (state.mode === "user" && state.user?.username === user.username);
    q("#lb-prev").hidden = lb.i === 0;
    q("#lb-next").hidden = lb.i >= state.photos.length - 1 && !hasMore();
    window.pins?.syncLightbox(); // pins.js
}

function upgradeImage(p, rect) {
    const w = Math.min(2400, Math.round(rect.width * Math.min(devicePixelRatio || 1, 2)));
    const hi = new Image();
    hi.src = imgUrl(p, w, 85);
    const i = lb.i;
    hi.decode?.()
        .catch(() => {})
        .then(() => {
            if (lb.i === i && !lightbox.hidden) lbImg.src = hi.src;
        });
}

function thumbSrc(i) {
    const img = state.cards[i]?.querySelector(".card-img");
    return img?.currentSrc || img?.src || imgUrl(state.photos[i], 700);
}

function hideCard(i) {
    if (lb.hidden) lb.hidden.style.visibility = "";
    lb.hidden = state.cards[i]?.querySelector(".card-media") || null;
    if (lb.hidden) lb.hidden.style.visibility = "hidden";
}

// set by canvas.js while the infinite canvas is open
const inCanvas = () => !!window.canvasView?.isOpen;

function openLightbox(i, fromRect) {
    if (i < 0 || lb.busy) return;
    const p = state.photos[i];
    const media = state.cards[i].querySelector(".card-media");
    const from = fromRect || media.getBoundingClientRect();

    lb.i = i;
    lb.lastFocus = document.activeElement;
    lb.busy = true;
    lightbox.hidden = false;
    lenis?.stop();
    document.body.style.overflow = "hidden";
    cursorReset();
    fillPanel(p);

    lbImg.src = thumbSrc(i);
    lbImg.alt = p.alt_description || photoTitle(p);
    const to = fitRect(p);
    if (!inCanvas()) hideCard(i);

    const mobile = lbStacked();
    const tl = gsap.timeline({
        defaults: { ease: "expo.inOut" },
        onComplete: () => {
            lb.busy = false;
            q("#lb-close").focus({ preventScroll: true });
        },
    });
    if (reduceMotion) {
        gsap.set(lbImg, to);
        tl.set({}, {}, 0.01);
    } else {
        tl.fromTo(".lb-bg", { opacity: 0 }, { opacity: 1, duration: 0.8, ease: "power2.out" }, 0)
            .fromTo(lbImg, { x: from.left, y: from.top, width: from.width, height: from.height }, { ...to, duration: 1.1 }, 0)
            .fromTo(".lb-panel", mobile ? { yPercent: 100 } : { xPercent: 100 }, { xPercent: 0, yPercent: 0, duration: 1.1 }, 0)
            .fromTo(".lb-body > *, .lb-actions > *, .lb-hint", { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.9, stagger: 0.05, ease: "expo.out" }, 0.55);
    }
    upgradeImage(p, to);
}

function closeLightbox() {
    if (lightbox.hidden || lb.busy) return;
    lb.busy = true;
    const canvasOpen = inCanvas();
    const media = canvasOpen ? null : state.cards[lb.i]?.querySelector(".card-media");
    const r = canvasOpen ? window.canvasView.rectFor(lb.i) : media?.getBoundingClientRect();
    const onScreen = r && r.bottom > 0 && r.top < innerHeight;
    const mobile = lbStacked();

    const done = () => {
        lightbox.hidden = true;
        if (lb.hidden) lb.hidden.style.visibility = "";
        lb.hidden = null;
        lb.busy = false;
        if (!canvasOpen) {
            document.body.style.overflow = "";
            lenis?.start();
        }
        gsap.set([lbImg, ".lb-bg", ".lb-panel"], { clearProps: "all" });
        (media || lb.lastFocus)?.focus?.({ preventScroll: true });
    };

    if (reduceMotion) return done();

    const tl = gsap.timeline({ defaults: { ease: "expo.inOut" }, onComplete: done });
    tl.to(".lb-panel", mobile ? { yPercent: 100, duration: 0.9 } : { xPercent: 100, duration: 0.9 }, 0).to(
        ".lb-bg",
        { opacity: 0, duration: 0.8, ease: "power2.inOut" },
        0.15
    );
    if (onScreen) tl.to(lbImg, { x: r.left, y: r.top, width: r.width, height: r.height, duration: 1 }, 0);
    else tl.to(lbImg, { opacity: 0, scale: 0.9, duration: 0.6, ease: "power2.in" }, 0);
}

async function go(dir) {
    if (lb.busy || lightbox.hidden) return;
    let next = lb.i + dir;
    if (next < 0) return;
    if (next >= state.photos.length) {
        if (!hasMore()) return;
        lb.busy = true;
        try {
            await loadPage();
        } catch (e) {
            lb.busy = false;
            return;
        }
        lb.busy = false;
        if (next >= state.photos.length) return;
    }

    lb.busy = true;
    const p = state.photos[next];
    const to = fitRect(p);

    // keep the page behind in sync so closing lands on the right card
    const card = state.cards[next];
    if (!inCanvas()) {
        const y = card.getBoundingClientRect().top + (lenis ? lenis.scroll : scrollY) - innerHeight * 0.3;
        if (lenis) lenis.scrollTo(Math.max(0, y), { immediate: true, force: true });
        else window.scrollTo(0, Math.max(0, y));
    }

    const finish = () => {
        lb.i = next;
        if (!inCanvas()) hideCard(next);
        fillPanel(p);
        lbImg.src = thumbSrc(next);
        lbImg.alt = p.alt_description || photoTitle(p);
        upgradeImage(p, to);
    };

    if (reduceMotion) {
        finish();
        gsap.set(lbImg, to);
        lb.busy = false;
        return;
    }

    gsap.timeline({ onComplete: () => (lb.busy = false) })
        .to(lbImg, { x: `-=${dir * 60}`, opacity: 0, duration: 0.35, ease: "power2.in" })
        .to(".lb-body > *", { y: -16, opacity: 0, duration: 0.3, stagger: 0.02, ease: "power2.in" }, 0)
        .add(finish)
        .set(lbImg, { ...to, x: to.x + dir * 60 })
        .to(lbImg, { x: to.x, opacity: 1, duration: 0.8, ease: "expo.out" })
        .fromTo(".lb-body > *", { y: 20, opacity: 0 }, { y: 0, opacity: 1, duration: 0.7, stagger: 0.04, ease: "expo.out" }, "<");
}

/* "more like this": a search built from the photo's tags / description */
const STOP = new Set(
    "a an the of in on at and or with for to from by is are was its it this that these those over under into onto near some two three one few many very top front back side view photo image picture shot person people man woman their his her".split(
        " "
    )
);
function similarQuery(p) {
    const tags = (Array.isArray(p.tags) ? p.tags : []).map((t) => t?.title).filter((t) => typeof t === "string" && t.length > 2);
    if (tags.length) return tags.slice(0, 3).join(" ");
    const words = String(p.alt_description || p.description || "")
        .toLowerCase()
        .replace(/[^a-z\s-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP.has(w));
    return [...new Set(words)].slice(0, 3).join(" ");
}

// close the viewer, then run the next search once it's out of the way
async function afterLightbox(fn) {
    for (let i = 0; i < 80 && !lightbox.hidden; i++) {
        if (!lb.busy) closeLightbox();
        await new Promise((r) => setTimeout(r, 50));
    }
    fn();
}

q("#lb-similar").addEventListener("click", () => {
    const p = state.photos[lb.i];
    const query = p && similarQuery(p);
    if (query) afterLightbox(() => runSearch(query, { scroll: !inCanvas() }));
});

q("#lb-by").addEventListener("click", () => {
    const u = state.photos[lb.i]?.user;
    if (u?.username) afterLightbox(() => runUser(u.username, u.name, { scroll: !inCanvas() }));
});

q("#lb-close").addEventListener("click", closeLightbox);
q("#lb-prev").addEventListener("click", () => go(-1));
q("#lb-next").addEventListener("click", () => go(1));
q(".lb-bg").addEventListener("click", closeLightbox);

// Unsplash asks apps to ping download_location whenever a photo is downloaded
q("#lb-download").addEventListener("click", (e) => {
    const track = e.currentTarget.dataset.track;
    if (!track) return;
    try {
        const u = new URL(track);
        api(u.pathname, { ixid: u.searchParams.get("ixid") }).catch(() => {});
    } catch (err) {}
});

/* swipe on touch */
let touchX = null;
lbStage.addEventListener("touchstart", (e) => (touchX = e.touches[0].clientX), { passive: true });
lbStage.addEventListener("touchend", (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
    touchX = null;
});

/* keyboard */
document.addEventListener("keydown", (e) => {
    if (!lightbox.hidden) {
        if (e.key === "Escape") closeLightbox();
        else if (e.key === "ArrowRight") go(1);
        else if (e.key === "ArrowLeft") go(-1);
        else if (e.key === "Tab") trapFocus(e);
        return;
    }
    const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
    if (e.key === "/" && !typing) {
        e.preventDefault();
        const heroVisible = q(".hero").getBoundingClientRect().bottom > innerHeight * 0.4;
        q(inCanvas() ? "#cv-q" : heroVisible ? "#hero-q" : "#dock-q").focus({ preventScroll: true });
    }
});

function trapFocus(e) {
    const items = qa("button:not([hidden]), a[href]", lightbox).filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
    }
}

/* ----------------------------------------------------------
   Cursor + magnetic elements
---------------------------------------------------------- */
const cursor = q("#cursor");
const cursorLabel = q(".cursor-label");

function cursorReset() {
    cursor.classList.remove("is-label");
}

if (canHover && !reduceMotion) {
    const cx = gsap.quickTo(cursor, "x", { duration: 0.45, ease: "power3.out" });
    const cy = gsap.quickTo(cursor, "y", { duration: 0.45, ease: "power3.out" });
    gsap.set(cursor, { autoAlpha: 0 });

    window.addEventListener("pointermove", (e) => {
        if (!cursor._shown) {
            cursor._shown = true;
            gsap.set(cursor, { x: e.clientX, y: e.clientY });
            gsap.to(cursor, { autoAlpha: 1, duration: 0.3 });
        }
        cx(e.clientX);
        cy(e.clientY);
    });
    document.addEventListener("pointerleave", () => gsap.to(cursor, { autoAlpha: 0, duration: 0.3 }));
    document.addEventListener("pointerenter", () => cursor._shown && gsap.to(cursor, { autoAlpha: 1, duration: 0.3 }));
    window.addEventListener("pointerdown", () => cursor.classList.add("is-down"));
    window.addEventListener("pointerup", () => cursor.classList.remove("is-down"));

    document.addEventListener("pointerover", (e) => {
        const t = e.target.closest("[data-cursor]");
        if (!t) return;
        cursorLabel.textContent = t.dataset.cursor;
        cursor.classList.add("is-label");
    });
    document.addEventListener("pointerout", (e) => {
        const t = e.target.closest("[data-cursor]");
        if (t && !t.contains(e.relatedTarget)) cursorReset();
    });

    qa(".magnetic").forEach((el) => {
        const mx = gsap.quickTo(el, "x", { duration: 0.6, ease: "elastic.out(1, 0.4)" });
        const my = gsap.quickTo(el, "y", { duration: 0.6, ease: "elastic.out(1, 0.4)" });
        el.addEventListener("pointermove", (e) => {
            const r = el.getBoundingClientRect();
            mx((e.clientX - r.left - r.width / 2) * 0.3);
            my((e.clientY - r.top - r.height / 2) * 0.3);
        });
        el.addEventListener("pointerleave", () => {
            mx(0);
            my(0);
        });
    });
}

/* ----------------------------------------------------------
   Marquee (duplicate the group for a seamless loop)
---------------------------------------------------------- */
(() => {
    const group = q(".marquee-group");
    const clone = group.cloneNode(true);
    clone.setAttribute("aria-hidden", "true");
    qa("button", clone).forEach((b) => (b.tabIndex = -1));
    group.after(clone);
})();

/* ----------------------------------------------------------
   Hero — floating frames
---------------------------------------------------------- */
const floats = qa(".float");

function fillHero(photos) {
    const picks = photos.slice(0, floats.length);
    const loads = picks.map((p, k) => {
        const img = floats[k].querySelector("img");
        floats[k].style.background = p.color || "";
        img.src = imgUrl(p, 500, 70);
        return img.decode ? img.decode().catch(() => {}) : Promise.resolve();
    });

    const names = [...new Map(picks.map((p) => [p.user.username, p.user])).values()];
    const credit = names
        .slice(0, 2)
        .map((u) => `<a href="${utm(u.links.html)}" target="_blank" rel="noopener">${esc(u.name)}</a>`)
        .join(", ");
    q("#hero-credit").innerHTML = names.length
        ? `Frames by ${credit}${names.length > 2 ? ` &amp; ${names.length - 2} more` : ""}`
        : "&nbsp;";
    return loads;
}

function heroMotion() {
    if (reduceMotion) return;
    floats.forEach((f) => {
        const depth = parseFloat(f.dataset.depth);
        gsap.to(f, {
            yPercent: -depth * 70,
            ease: "none",
            scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true },
        });
    });

    gsap.to(".hero-title .line:nth-child(odd) > span", {
        xPercent: -8,
        ease: "none",
        scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true },
    });
    gsap.to(".hero-title .line:nth-child(2) > span", {
        xPercent: 10,
        ease: "none",
        scrollTrigger: { trigger: ".hero", start: "top top", end: "bottom top", scrub: true },
    });

    if (canHover) {
        const movers = floats.map((f) => ({
            d: parseFloat(f.dataset.depth),
            x: gsap.quickTo(f, "x", { duration: 1.2, ease: "power3.out" }),
            y: gsap.quickTo(f, "y", { duration: 1.2, ease: "power3.out" }),
        }));
        q(".hero").addEventListener("pointermove", (e) => {
            const nx = e.clientX / innerWidth - 0.5;
            const ny = e.clientY / innerHeight - 0.5;
            movers.forEach((m) => {
                m.x(nx * m.d * -50);
                m.y(ny * m.d * -40);
            });
        });
    }
}

/* dock appears once the hero is behind you */
ScrollTrigger.create({
    trigger: ".hero",
    start: "bottom 55%",
    onEnter: () => dock.classList.add("is-visible"),
    onLeaveBack: () => dock.classList.remove("is-visible"),
});

const toTop = () => scrollToTarget(0, { duration: 2 });
q("#dock-top").addEventListener("click", toTop);
q("#footer-top").addEventListener("click", toTop);

/* ----------------------------------------------------------
   Boot: loader → intro
---------------------------------------------------------- */
/* Camera iris: six blades around a hexagonal opening of radius `r`,
   turned by `turn` degrees. Progress is shown by the tick ring. */
const iris = (() => {
    const R = 60;
    const TICKS = 60;
    const blades = q("#iris-blades");
    const seams = q("#iris-seams");
    const ring = q("#iris-ring");
    const tickWrap = q("#iris-ticks");
    const NS = "http://www.w3.org/2000/svg";
    const ticks = [];
    for (let i = 0; i < TICKS; i++) {
        const a = (i / TICKS) * Math.PI * 2 - Math.PI / 2;
        const len = i % 5 === 0 ? 6 : 3.5;
        const l = document.createElementNS(NS, "line");
        l.setAttribute("x1", (Math.cos(a) * (R + 4)).toFixed(2));
        l.setAttribute("y1", (Math.sin(a) * (R + 4)).toFixed(2));
        l.setAttribute("x2", (Math.cos(a) * (R + 4 + len)).toFixed(2));
        l.setAttribute("y2", (Math.sin(a) * (R + 4 + len)).toFixed(2));
        tickWrap.appendChild(l);
        ticks.push(l);
    }
    const s = { r: 2, turn: 0, p: 0 };
    const draw = () => {
        const pts = [];
        for (let i = 0; i < 6; i++) {
            const a = ((s.turn + i * 60) * Math.PI) / 180;
            pts.push([Math.cos(a) * s.r, Math.sin(a) * s.r]);
        }
        const hole = "M" + pts.map((p) => p[0].toFixed(2) + " " + p[1].toFixed(2)).join("L") + "Z";
        blades.setAttribute("d", "M-5000-5000H5000V5000H-5000Z" + hole);
        // each hexagon edge runs on past its corner to the rim: the blade seams
        let d = "";
        if (s.r < R) {
            pts.forEach((v, i) => {
                const w = pts[(i + 1) % 6];
                const dx = w[0] - v[0], dy = w[1] - v[1];
                const n = Math.hypot(dx, dy) || 1;
                const ux = dx / n, uy = dy / n;
                const b = v[0] * ux + v[1] * uy;
                const t = -b + Math.sqrt(Math.max(0, b * b - (v[0] ** 2 + v[1] ** 2) + R * R));
                d += `M${v[0].toFixed(2)} ${v[1].toFixed(2)}L${(v[0] + ux * t).toFixed(2)} ${(v[1] + uy * t).toFixed(2)}`;
            });
        }
        seams.setAttribute("d", d);
        ring.style.opacity = Math.max(0, Math.min(1, 1 - (s.r - R * 0.8) / (R * 0.4)));
        const on = Math.round(s.p * TICKS);
        ticks.forEach((l, i) => l.classList.toggle("on", i < on));
    };
    // loading progress 0..1 opens the iris part way
    const progress = (p) => {
        s.p = p;
        s.r = 2 + p * R * 0.62;
        s.turn = p * 75;
        draw();
    };
    draw();
    return { s, draw, progress };
})();

function intro() {
    document.body.classList.remove("is-loading");
    lenis?.start();

    if (reduceMotion) {
        gsap.set("#loader", { display: "none" });
        gsap.set(".float", { clipPath: "inset(0% 0 0 0)" });
        gsap.set(".float img", { scale: 1 });
        return;
    }

    const tl = gsap.timeline({ defaults: { ease: "expo.out" } });
    tl.to("#loader .loader-row", { opacity: 0, y: -10, duration: 0.45, ease: "power2.in", stagger: 0.05 })
        .to(iris.s, { r: 420, turn: "+=60", duration: 1.3, ease: "expo.inOut", onUpdate: iris.draw }, 0.1)
        .to("#loader .loader-lens", { opacity: 0, duration: 0.7, ease: "power2.inOut" }, 0.45)
        .set("#loader", { display: "none" })
        .from(".hero-title .line > span", { yPercent: 110, duration: 1.3, stagger: 0.09 }, "-=0.45")
        .to(".float", { clipPath: "inset(0% 0 0 0)", duration: 1.4, stagger: 0.08, ease: "expo.inOut" }, "<0.1")
        .to(".float img", { scale: 1, duration: 1.8, stagger: 0.08 }, "<")
        .from(".hero-meta > *, .search--hero > *, .hero-foot, #nav > *", { y: 24, opacity: 0, duration: 1, stagger: 0.05 }, "<0.3");
    heroMotion();
}

async function boot() {
    const fstop = q("#loader-fstop");
    const status = q("#loader-status");
    const STOPS = ["22", "16", "11", "8", "5.6", "4", "2.8", "2", "1.4"];
    const prog = { v: 0 };
    const render = () => {
        const p = prog.v / 100;
        iris.progress(p);
        fstop.textContent = STOPS[Math.min(STOPS.length - 1, Math.floor(p * STOPS.length))];
    };
    const crawl = gsap.to(prog, { v: 78, duration: 2.4, ease: "power2.out", onUpdate: render });

    lastCols = colCount();
    layout();

    const params = new URLSearchParams(location.search);
    const initial = (params.get("q") || "").trim();
    const by = (params.get("by") || "").trim();
    if (!initial && /^[A-Za-z0-9_-]{1,40}$/.test(by)) {
        state.mode = "user";
        state.user = { username: by, name: by };
        document.title = `${by} — Aperture`;
        q("#hud-mode").textContent = `@${by.toUpperCase()}`;
        titleEl.querySelector("span").innerHTML = `<em>by</em> @${esc(by)}`;
        q("#results-kicker").textContent = "(Photographer)";
    }
    if (initial) {
        state.mode = "search";
        state.query = initial;
        qa(".js-search input").forEach((i) => (i.value = initial));
        document.title = `${initial} — Aperture`;
        q("#hud-mode").textContent = `“${initial.toUpperCase()}”`;
        filtersEl.hidden = false;
        titleEl.querySelector("span").innerHTML = `<em>“</em>${esc(initial)}<em>”</em>`;
        q("#results-kicker").textContent = "(Search results)";
    }
    syncModeUI();

    status.textContent = "FETCHING FRAMES";
    try {
        await loadPage();
        status.textContent = "DEVELOPING";
        const first = state.photos[0];
        if (first) {
            const frame = q("#loader-frame");
            frame.onload = () => frame.classList.add("is-developed");
            frame.src = imgUrl(first, 600, 70);
        }
        const timeout = new Promise((r) => setTimeout(r, 3500));
        await Promise.race([Promise.all(fillHero(state.photos)), timeout]);
        status.textContent = "READY";
    } catch (err) {
        status.textContent = "OFFLINE";
    }

    crawl.kill();
    const start = () => {
        intro();
        if (initial || state.mode === "user") setTimeout(() => scrollToTarget(resultsEl, { offset: -40 }), reduceMotion ? 0 : 1400);
    };
    if (reduceMotion) {
        prog.v = 100;
        render();
        start();
    } else {
        gsap.to(prog, { v: 100, duration: 0.6, ease: "power2.inOut", onUpdate: render, onComplete: start });
    }
}

boot();
