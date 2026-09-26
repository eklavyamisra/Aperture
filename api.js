const accessKey = "LYbwcbJK4e34RLGNmDW4Y10enrnYAqqYzZjHUl0lw5Y";
const API = "https://api.unsplash.com";
const UTM = "utm_source=aperture&utm_medium=referral";
const PER_PAGE = 24;
const AUTO_PAGES = 2; // pages fetched by infinite scroll before we ask (the demo key allows 50 req/hr)

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
    mode: "feed", // "feed" | "search"
    query: "",
    order: "relevant",
    color: "",
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
    const url = new URL(API + path);
    Object.entries(params).forEach(([k, v]) => v !== "" && v != null && url.searchParams.set(k, v));
    url.searchParams.set("client_id", accessKey);

    let res;
    try {
        res = await fetch(url);
    } catch (e) {
        throw new ApiError(0, "network");
    }

    const remaining = res.headers.get("X-Ratelimit-Remaining");
    const limit = res.headers.get("X-Ratelimit-Limit");
    if (remaining !== null) {
        q("#hud-rate").textContent = limit ? `${remaining}/${limit}` : remaining;
        qa(".hud-rate-wrap").forEach((el) => (el.hidden = false));
    }

    if (!res.ok) throw new ApiError(res.status, res.statusText);
    return res.json();
}

function describeError(err) {
    if (err.status === 403 || err.status === 429)
        return ["Out of film.", "The Unsplash demo key allows 50 requests an hour. Give it a few minutes and try again."];
    if (err.status === 401) return ["Access denied.", "The Unsplash access key was rejected. Check the key in api.js."];
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
    const data = await api("/search/photos", {
        query: state.query,
        page: state.page,
        per_page: PER_PAGE,
        order_by: state.order,
        color: state.color,
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
        state.mode === "search" ? `${fmt(state.total)} frames found` : "Curated by Unsplash editors";
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
        <p>No photographs matched “${esc(state.query)}”${state.color ? " in that tone" : ""}. Try something broader.</p>
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
    if (changed) {
        state.order = "relevant";
        state.color = "";
        syncFilters();
    }

    qa(".js-search input").forEach((i) => (i.value = query));
    qa(".js-search input").forEach((i) => i.blur());
    try {
        const url = new URL(location.href);
        url.searchParams.set("q", query);
        history.replaceState(null, "", url);
    } catch (e) {}

    document.title = `${query} — Aperture`;
    q("#hud-mode").textContent = `“${query.toUpperCase()}”`;
    filtersEl.hidden = false;
    setTitle(`<em>“</em>${esc(query)}<em>”</em>`, "(Search results)");

    if (scroll) scrollToTarget(resultsEl, { offset: -40 });
    await refresh();
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
}

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

function fitRect(p) {
    const s = lbStage.getBoundingClientRect();
    const mobile = innerWidth < 860;
    const px = mobile ? 16 : 48;
    const pt = mobile ? 16 : 48;
    const pb = mobile ? 16 : 48;
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
    q("#lb-prev").hidden = lb.i === 0;
    q("#lb-next").hidden = lb.i >= state.photos.length - 1 && !hasMore();
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

function openLightbox(i) {
    if (i < 0 || lb.busy) return;
    const p = state.photos[i];
    const media = state.cards[i].querySelector(".card-media");
    const from = media.getBoundingClientRect();

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
    hideCard(i);

    const mobile = innerWidth < 860;
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
    const media = state.cards[lb.i]?.querySelector(".card-media");
    const r = media?.getBoundingClientRect();
    const onScreen = r && r.bottom > 0 && r.top < innerHeight;
    const mobile = innerWidth < 860;

    const done = () => {
        lightbox.hidden = true;
        if (lb.hidden) lb.hidden.style.visibility = "";
        lb.hidden = null;
        lb.busy = false;
        document.body.style.overflow = "";
        lenis?.start();
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
    const y = card.getBoundingClientRect().top + (lenis ? lenis.scroll : scrollY) - innerHeight * 0.3;
    if (lenis) lenis.scrollTo(Math.max(0, y), { immediate: true, force: true });
    else window.scrollTo(0, Math.max(0, y));

    const finish = () => {
        lb.i = next;
        hideCard(next);
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

q("#lb-close").addEventListener("click", closeLightbox);
q("#lb-prev").addEventListener("click", () => go(-1));
q("#lb-next").addEventListener("click", () => go(1));
q(".lb-bg").addEventListener("click", closeLightbox);

// Unsplash asks apps to ping download_location whenever a photo is downloaded
q("#lb-download").addEventListener("click", (e) => {
    const track = e.currentTarget.dataset.track;
    if (track) fetch(`${track}${track.includes("?") ? "&" : "?"}client_id=${accessKey}`).catch(() => {});
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
        q(heroVisible ? "#hero-q" : "#dock-q").focus({ preventScroll: true });
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
    tl.to("#loader", { yPercent: -100, duration: 1.1, ease: "expo.inOut" })
        .set("#loader", { display: "none" })
        .from(".hero-title .line > span", { yPercent: 110, duration: 1.3, stagger: 0.09 }, "-=0.45")
        .to(".float", { clipPath: "inset(0% 0 0 0)", duration: 1.4, stagger: 0.08, ease: "expo.inOut" }, "<0.1")
        .to(".float img", { scale: 1, duration: 1.8, stagger: 0.08 }, "<")
        .from(".hero-meta > *, .search--hero > *, .hero-foot, #nav > *", { y: 24, opacity: 0, duration: 1, stagger: 0.05 }, "<0.3");
    heroMotion();
}

async function boot() {
    const num = q("#loader-num");
    const bar = q("#loader-bar");
    const status = q("#loader-status");
    const prog = { v: 0 };
    const render = () => {
        const v = Math.round(prog.v);
        num.textContent = v;
        gsap.set(bar, { scaleX: v / 100 });
    };
    const crawl = gsap.to(prog, { v: 78, duration: 2.4, ease: "power2.out", onUpdate: render });

    lastCols = colCount();
    layout();

    const params = new URLSearchParams(location.search);
    const initial = (params.get("q") || "").trim();
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

    status.textContent = "FETCHING FRAMES";
    try {
        await loadPage();
        status.textContent = "DEVELOPING";
        const timeout = new Promise((r) => setTimeout(r, 3500));
        await Promise.race([Promise.all(fillHero(state.photos)), timeout]);
        status.textContent = "READY";
    } catch (err) {
        status.textContent = "OFFLINE";
    }

    crawl.kill();
    const start = () => {
        intro();
        if (initial) setTimeout(() => scrollToTarget(resultsEl, { offset: -40 }), reduceMotion ? 0 : 1400);
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
