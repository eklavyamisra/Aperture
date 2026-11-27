/* ==========================================================
   APERTURE — pin boards
   Named boards kept in localStorage (uploaded images in IndexedDB via
   media.js). A board is an infinite corkboard over the canvas holding four
   kinds of item: Unsplash photos, your own uploads, links / image URLs and
   notes. Pan and zoom it, drag things anywhere (with snapping), select many,
   align and group them, tie labelled threads between pins, find, palette,
   minimap, undo, share as a link, save as PNG or JSON.
   Relies on globals from api.js: state, lb, lightbox, q, gsap, reduceMotion, api.
========================================================== */
(() => {
    const IMG_HOST = /^https:\/\/images\.unsplash\.com\//;
    const HOST = "https://images.unsplash.com/";
    const INDEX = "aperture:boards";
    const bkey = (id) => `aperture:board:${id}`;
    const vkey = (id) => `aperture:board-view:${id}`;
    const LEGACY = { pins: "aperture:pins", threads: "aperture:threads", view: "aperture:board-view" };
    const MEDIA_LAST = "aperture:media-last";
    const ZMIN = 0.2;
    const ZMAX = 2;
    const CARD_W = 200;
    const CARD_H = Math.round(CARD_W * 1.25 + 96);
    const MAX_PINS = 500;
    const clamp = gsap.utils.clamp;
    const clampZ = (z) => clamp(ZMIN, ZMAX, z);
    const listeners = new Set();
    const KINDS = ["unsplash", "upload", "link", "note"];
    const TINTS = ["sun", "rose", "sky", "mint", "paper"];
    const TINT_HEX = { sun: "#f3dc8c", rose: "#f1bcb2", sky: "#bcd5ee", mint: "#c3e4cf", paper: "#ece7dc" };
    const rnd = () => Math.round((Math.random() * 2 - 1) * 40) / 10;

    /* ---------- toasts ---------- */
    const toastEl = document.getElementById("toast");
    let toastT = 0;
    function toast(msg, tone = "") {
        if (!toastEl) return;
        toastEl.textContent = msg;
        toastEl.dataset.tone = tone;
        toastEl.classList.add("is-on");
        clearTimeout(toastT);
        toastT = setTimeout(() => toastEl.classList.remove("is-on"), tone === "warn" ? 6500 : 3200);
    }
    window.toast = toast;

    /* ---------- storage (+ quota warnings) ---------- */
    let lastFull = 0;
    function storageFull(err) {
        const now = Date.now();
        if (now - lastFull < 30000) return;
        lastFull = now;
        toast("Browser storage is full, so your last change wasn't saved. Export this board (Export → Board file) or remove some items.", "warn");
        window.reportProblem?.("localStorage full", err);
    }

    const store = {
        get(k) {
            try {
                return JSON.parse(localStorage.getItem(k));
            } catch (e) {
                return null;
            }
        },
        set(k, v) {
            try {
                localStorage.setItem(k, JSON.stringify(v));
                return true;
            } catch (e) {
                if (e && (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED" || e.code === 22)) storageFull(e);
                return false;
            }
        },
        del(k) {
            try {
                localStorage.removeItem(k);
            } catch (e) {}
        },
    };

    // warn once a session, before saves start failing
    let usageWarned = false;
    let usageT = 0;
    function checkUsage() {
        clearTimeout(usageT);
        usageT = setTimeout(async () => {
            if (usageWarned) return;
            let chars = 0;
            try {
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    chars += k.length + (localStorage.getItem(k) || "").length;
                }
            } catch (e) {
                return;
            }
            if (chars > 2.4e6) {
                usageWarned = true;
                return toast("Your boards are close to the browser's storage limit. Export big boards (Export → Board file) to keep a copy.", "warn");
            }
            const est = await window.media?.estimate?.();
            if (est && est.quota && est.used / est.quota > 0.9) {
                usageWarned = true;
                toast("Image storage is almost full. Remove some uploads, or export boards to keep copies.", "warn");
            }
        }, 2000);
    }

    const uid = () => Math.random().toString(36).slice(2, 10);
    const newId = (p) => `${p}-${uid()}${uid().slice(0, 4)}`;
    const ID_RE = /^[a-z0-9]{1,20}$/;
    const PHOTO_ID = /^[A-Za-z0-9_-]{1,40}$/;
    const ITEM_ID = /^[uln]-[a-z0-9]{6,24}$/;
    const str = (v, n) => String(v ?? "").slice(0, n);
    const fin = (v) => (Number.isFinite(v) ? v : null);
    const tkey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
    const hostOf = (u) => {
        try {
            return new URL(u).hostname.replace(/^www\./, "");
        } catch (e) {
            return "link";
        }
    };

    /* ---------- sanitising (storage, imports and share links all pass through here) ---------- */
    const okLink = (u, fb) => (typeof u === "string" && /^https:\/\/unsplash\.com\//.test(u) ? u : fb);
    const hexOr = (c, fb = "#2a2723") => (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c || "") ? c : fb);
    const posInt = (n) => (Number.isFinite(+n) && +n > 0 ? Math.min(20000, Math.round(+n)) : 0);
    function safeUrl(u, httpsOnly) {
        if (typeof u !== "string" || !u.trim() || u.length > 2000) return null;
        try {
            const url = new URL(u.trim());
            if (url.protocol !== "https:" && (httpsOnly || url.protocol !== "http:")) return null;
            if (url.username || url.password) return null;
            return url.href;
        } catch (e) {
            return null;
        }
    }
    const validPhoto = (p) => !!p && typeof p.id === "string" && PHOTO_ID.test(p.id) && typeof p.urls?.raw === "string" && IMG_HOST.test(p.urls.raw);

    function snap(p) {
        const username = PHOTO_ID.test(p.user?.username || "") ? p.user.username : "";
        return {
            id: p.id,
            color: hexOr(p.color, "#222222"),
            width: Number(p.width) || 0,
            height: Number(p.height) || 0,
            alt_description: str(p.alt_description, 300),
            description: str(p.description, 300),
            urls: { raw: str(p.urls.raw, 600) },
            links: { html: okLink(p.links?.html, `https://unsplash.com/photos/${p.id}`) },
            user: {
                name: str(p.user?.name || "Unknown", 80),
                username,
                links: { html: okLink(p.user?.links?.html, username ? `https://unsplash.com/@${username}` : "https://unsplash.com") },
            },
        };
    }

    function cleanItem(x) {
        if (!x || typeof x !== "object") return null;
        const kind = KINDS.includes(x.kind) ? x.kind : x.photo ? "unsplash" : null;
        if (!kind) return null;
        const base = {
            note: str(x.note, kind === "note" ? 1000 : 280),
            query: str(x.query, 120),
            at: Number(x.at) || Date.now(),
            x: fin(x.x),
            y: fin(x.y),
            bx: fin(x.bx),
            by: fin(x.by),
            r: clamp(-6, 6, Number(x.r) || 0),
        };
        if (kind === "unsplash") return validPhoto(x.photo) ? { id: x.photo.id, kind, photo: snap(x.photo), ...base } : null;
        if (typeof x.id !== "string" || !ITEM_ID.test(x.id) || x.id[0] !== kind[0]) return null;
        const m = x.media && typeof x.media === "object" ? x.media : {};
        if (kind === "upload") return { id: x.id, kind, media: { w: posInt(m.w), h: posInt(m.h), color: hexOr(m.color), name: str(m.name, 120) }, ...base };
        if (kind === "link") {
            const href = safeUrl(m.href);
            if (!href) return null;
            const src = m.src ? safeUrl(m.src, true) : null;
            return { id: x.id, kind, media: { href, src, title: str(m.title, 200), w: posInt(m.w), h: posInt(m.h), color: hexOr(m.color) }, ...base };
        }
        return { id: x.id, kind, tint: TINTS.includes(x.tint) ? x.tint : "sun", ...base };
    }

    function cleanBoard(raw, fallbackName = "My board") {
        raw = raw && typeof raw === "object" ? raw : {};
        const list = Array.isArray(raw) ? raw : Array.isArray(raw.pins) ? raw.pins : [];
        const seen = new Set();
        const pins = [];
        list.forEach((x) => {
            if (pins.length >= MAX_PINS) return;
            const c = cleanItem(x);
            if (!c || seen.has(c.id)) return;
            seen.add(c.id);
            pins.push(c);
        });
        const threads = [];
        const tk = new Set();
        (Array.isArray(raw.threads) ? raw.threads : []).forEach((t) => {
            if (!t || !seen.has(t.a) || !seen.has(t.b) || t.a === t.b) return;
            const k = tkey(t.a, t.b);
            if (tk.has(k)) return;
            tk.add(k);
            threads.push({ a: t.a, b: t.b, label: str(t.label, 60) });
        });
        const frames = (Array.isArray(raw.frames) ? raw.frames : [])
            .filter((f) => f && [f.x, f.y, f.w, f.h].every(Number.isFinite))
            .slice(0, 100)
            .map((f) => ({ id: ID_RE.test(f.id) ? f.id : uid(), x: f.x, y: f.y, w: clamp(200, 10000, f.w), h: clamp(140, 10000, f.h), title: str(f.title, 60) }));
        return { name: str(Array.isArray(raw) ? "" : raw.name, 60).trim() || fallbackName, pins, threads, frames };
    }

    /* ---------- boards index (+ one-time migration from the single board) ---------- */
    let index = store.get(INDEX);
    if (index && Array.isArray(index.list)) {
        index.list = index.list.filter((b) => b && ID_RE.test(b.id)).map((b) => ({ id: b.id, name: str(b.name, 60) || "Untitled board", updated: Math.max(0, Number(b.updated) || 0) }));
    }
    if (!index || !Array.isArray(index.list) || !index.list.length) {
        const id = uid();
        const first = cleanBoard({ name: "My board", pins: store.get(LEGACY.pins) || [], threads: store.get(LEGACY.threads) || [] });
        const v = store.get(LEGACY.view);
        if (store.set(bkey(id), first)) {
            if (v) store.set(vkey(id), v);
            Object.values(LEGACY).forEach(store.del);
        }
        // a migrated board counts as edited; a brand-new empty one doesn't (cloud sync skips it)
        index = { active: id, list: [{ id, name: first.name, updated: first.pins.length ? Date.now() : 0 }] };
        store.set(INDEX, index);
    }
    if (!index.list.some((b) => b.id === index.active)) index.active = index.list[0].id;

    /* ---------- active board ---------- */
    let B; // { name, pins (items of every kind), threads, frames }
    const ids = new Set();
    let readonly = false; // viewing someone's shared link
    let shared = null; // { code, password } while viewing a /b/<code> link: comments go there (#20)
    let commentCounts = new Map(); // item id -> comments on that card (comments.js fills it)
    // the board on screen changed (switched, opened a shared one, left it): comments.js reloads
    const contextChanged = () => document.dispatchEvent(new CustomEvent("pins:context"));
    const reindex = () => {
        ids.clear();
        B.pins.forEach((x) => ids.add(x.id));
    };

    function loadActive() {
        const meta = index.list.find((b) => b.id === index.active);
        B = cleanBoard(store.get(bkey(index.active)), meta?.name || "My board");
        reindex();
    }
    loadActive();

    // tell cloud.js a board changed locally (it pushes after a short pause)
    const changed = (id) => document.dispatchEvent(new CustomEvent("pins:changed", { detail: { id } }));

    function persist() {
        if (readonly) return;
        if (!store.set(bkey(index.active), B)) return;
        const meta = index.list.find((b) => b.id === index.active);
        if (meta) {
            meta.updated = Date.now();
            if (meta.name !== B.name) {
                meta.name = B.name;
                syncSwitcher();
            }
            store.set(INDEX, index);
        }
        changed(index.active);
        checkUsage();
    }

    function save() {
        persist();
        listeners.forEach((fn) => fn());
    }

    /* ---------- undo / redo ---------- */
    let undoStack = [];
    let redoStack = [];
    const snapshot = () => JSON.stringify({ pins: B.pins, threads: B.threads, frames: B.frames });

    function checkpoint(s = snapshot()) {
        if (readonly) return;
        undoStack.push(s);
        if (undoStack.length > 80) undoStack.shift();
        redoStack = [];
        syncUndo();
    }

    function restore(json) {
        const d = JSON.parse(json);
        B.pins = d.pins;
        B.threads = d.threads;
        B.frames = d.frames;
        reindex();
        save();
    }

    function undo() {
        if (readonly || !undoStack.length) return announce("Nothing to undo");
        redoStack.push(snapshot());
        restore(undoStack.pop());
        syncUndo();
        announce("Undone");
    }

    function redo() {
        if (readonly || !redoStack.length) return announce("Nothing to redo");
        undoStack.push(snapshot());
        restore(redoStack.pop());
        syncUndo();
        announce("Redone");
    }

    function syncUndo() {
        undoBtn.disabled = !undoStack.length;
    }

    /* ---------- items ---------- */
    const has = (id) => ids.has(id);
    const pinBy = (id) => B.pins.find((x) => x.id === id);

    function labelOf(x) {
        if (!x) return "item";
        if (x.kind === "unsplash") return x.photo.user.name;
        if (x.kind === "upload") return x.media.name || "your image";
        if (x.kind === "link") return hostOf(x.media.href);
        return `note “${(x.note || "").trim().slice(0, 30) || "empty"}”`;
    }
    const nameOf = (id) => labelOf(pinBy(id));
    const colorOf = (x) => (x.kind === "unsplash" ? x.photo.color : x.kind === "note" ? TINT_HEX[x.tint] : x.media.color || "#2a2723");
    const fromLabel = (x) =>
        x.kind === "upload" ? "Upload" : x.kind === "link" ? (x.media.src ? "Image link" : "Link") : !x.query ? "Editorial" : x.query.startsWith("@") ? x.query : `“${x.query}”`;

    // an Unsplash photo from the wall / viewer; pos is a world top-left
    function add(p, pos) {
        if (!p || has(p.id) || readonly) return;
        const x = cleanItem({
            kind: "unsplash",
            photo: p,
            query: state.mode === "search" ? state.query : state.mode === "user" && state.user ? `@${state.user.username}` : "",
            at: Date.now(),
            r: rnd(),
            bx: pos?.x,
            by: pos?.y,
        });
        if (!x) return;
        checkpoint();
        B.pins.unshift(x);
        ids.add(x.id);
        save();
    }

    // already-clean items, one undo step
    function insertItems(list) {
        list = list.filter((x) => x && !has(x.id));
        if (!list.length || readonly) return [];
        checkpoint();
        list.forEach((x) => {
            B.pins.unshift(x);
            ids.add(x.id);
        });
        save();
        return list.map((x) => x.id);
    }

    function removeMany(list) {
        const drop = new Set(list.filter(has));
        if (!drop.size || readonly) return 0;
        checkpoint();
        B.pins = B.pins.filter((x) => !drop.has(x.id));
        B.threads = B.threads.filter((t) => !drop.has(t.a) && !drop.has(t.b));
        drop.forEach((id) => {
            ids.delete(id);
            sel.delete(id);
        });
        save();
        return drop.size;
    }
    const remove = (id) => removeMany([id]);

    // returns true when the photo ends up pinned
    function toggle(p, opts = {}) {
        if (!p || readonly) return false;
        if (has(p.id)) {
            remove(p.id);
            return false;
        }
        add(p);
        if (opts.from) flyToButton(p, opts.from);
        else bump();
        return true;
    }

    /* ---------- threads ---------- */
    const threadBy = (k) => B.threads.find((t) => tkey(t.a, t.b) === k);
    const linked = (a, b) => !!threadBy(tkey(a, b));

    function addThread(a, b) {
        if (a === b || linked(a, b) || !has(a) || !has(b)) return false;
        checkpoint();
        B.threads.push({ a, b, label: "" });
        save();
        return true;
    }

    function cutThread(k) {
        if (!threadBy(k)) return;
        checkpoint();
        B.threads = B.threads.filter((t) => tkey(t.a, t.b) !== k);
        save();
        announce("Thread cut");
    }
    /* ---------- elements ---------- */
    const boardBtn = q("#cv-board");
    const countEl = q("#cv-board-n");
    const board = q("#pb");
    const area = q("#pb-area");
    const world = q("#pb-world");
    const framesLayer = q("#pb-frames");
    const strings = q("#pb-strings");
    const tempPath = q("#pb-temp");
    const knots = q("#pb-knots");
    const pop = q("#pb-pop");
    const popInput = q("#pb-pop-label");
    const emptyEl = q("#pb-empty");
    const titleCount = q("#pb-count");
    const nameInput = q("#pb-name");
    const pickBtn = q("#pb-picker-btn");
    const pickPop = q("#pb-picker-pop");
    const pickList = q("#pb-opts");
    const pickName = q("#pb-picker-name");
    const deleteBtn = q("#pb-delete");
    const undoBtn = q("#pb-undo");
    const shareBtn = q("#pb-share");
    const sharedBar = q("#pb-shared");
    const live = q("#pb-live");
    const lbPin = q("#lb-pin");
    const zoomOutBtn = q("#pb-zoom-out");
    const zoomInBtn = q("#pb-zoom-in");
    const zoomLvl = q("#pb-zoom-lvl");
    const ctxEl = q("#pb-ctx");
    const addBtn = q("#pb-add");
    const addMenu = q("#pb-add-menu");
    const exportBtn = q("#pb-export-btn");
    const exportMenu = q("#pb-export-menu");
    const imageBtn = q("#pb-image");
    const findBtn = q("#pb-find-btn");
    const find = q("#pb-find");
    const findInput = q("#pb-find-q");
    const findCount = q("#pb-find-n");
    const paletteBtn = q("#pb-palette-btn");
    const palette = q("#pb-palette");
    const swatches = q("#pb-swatches");
    const fileInput = q("#pb-file");
    const linkbox = q("#pb-linkbox");
    const linkInput = q("#pb-link-q");
    const selbar = q("#pb-selbar");
    const marquee = q("#pb-marquee");
    const minimap = q("#pb-minimap");
    const tray = q("#pb-tray");
    const trayList = q("#pb-tray-list");
    const dropHint = q("#pb-drop");
    const guides = q("#pb-guides");

    let liveT = 0;
    function announce(msg) {
        clearTimeout(liveT);
        live.textContent = "";
        liveT = setTimeout(() => (live.textContent = msg), 40);
    }

    function syncCount() {
        countEl.textContent = B.pins.length;
        titleCount.textContent = String(B.pins.length).padStart(2, "0");
        boardBtn.classList.toggle("has-pins", B.pins.length > 0);
    }

    function bump() {
        if (reduceMotion || board.hidden === false) return;
        gsap.fromTo(countEl, { scale: 1.8 }, { scale: 1, duration: 0.6, ease: "elastic.out(1, 0.4)" });
    }

    // the frame shrinks into a dot and drops into the Board button
    function flyToButton(p, from) {
        if (reduceMotion || !boardBtn.offsetParent) return bump();
        const to = countEl.getBoundingClientRect();
        const el = document.createElement("div");
        el.className = "pb-fly";
        el.style.backgroundImage = `url("${encodeURI(p.urls.raw)}&w=240&q=60&auto=format")`;
        el.style.backgroundColor = p.color || "#222";
        document.body.appendChild(el);
        gsap.set(el, { x: from.left, y: from.top, width: from.width, height: from.height });
        gsap.timeline({ onComplete: () => el.remove() })
            .to(el, { scale: 1.06, duration: 0.18, ease: "power2.out" })
            .to(el, {
                x: to.left + to.width / 2 - 9,
                y: to.top + to.height / 2 - 9,
                width: 18,
                height: 18,
                scale: 1,
                borderRadius: 18,
                duration: 0.75,
                ease: "expo.inOut",
            })
            .to(el, { backgroundImage: "none", backgroundColor: "#ff5b2e", duration: 0.2 }, "-=0.3")
            .add(bump, "-=0.05")
            .to(el, { opacity: 0, scale: 0.2, duration: 0.25 }, "-=0.05");
    }

    /* ---------- lightbox button ---------- */
    function syncLightbox() {
        const p = state.photos[lb.i];
        const on = !!p && has(p.id);
        lbPin.setAttribute("aria-pressed", on);
        lbPin.classList.toggle("is-on", on);
        lbPin.firstElementChild.textContent = on ? `Pinned to ${B.name}` : `Pin to ${B.name}`;
        lbPin.disabled = readonly;
        lbPin.dataset.cursor = on ? "Unpin" : "Pin";
    }

    lbPin.addEventListener("click", () => {
        const on = toggle(state.photos[lb.i]);
        if (!reduceMotion && on) gsap.fromTo(lbPin.lastElementChild, { rotate: -180, scale: 0 }, { rotate: 0, scale: 1, duration: 0.7, ease: "back.out(2)" });
    });

    /* ---------- board switcher ---------- */
    function syncSwitcher() {
        pickName.textContent = B.name;
        deleteBtn.disabled = index.list.length < 2;
        if (document.activeElement !== nameInput) nameInput.value = B.name;
        if (pickOpen) buildPicker();
    }

    /* custom board picker: a listbox with thumbnails instead of a native <select> */
    let pickOpen = false;
    let pickIdx = 0;

    function boardSummary(id) {
        const b = id === index.active && !readonly ? B : store.get(bkey(id));
        const pins = Array.isArray(b?.pins) ? b.pins : [];
        const thumbs = pins
            .map((x) => x?.photo?.urls?.raw)
            .filter((u) => typeof u === "string" && IMG_HOST.test(u))
            .slice(0, 3);
        return { n: pins.length, thumbs };
    }

    function buildPicker() {
        pickList.textContent = "";
        q("#pb-picker-total").textContent = String(index.list.length).padStart(2, "0");
        index.list.forEach((b, i) => {
            const { n, thumbs } = boardSummary(b.id);
            const li = document.createElement("li");
            li.id = `pb-opt-${b.id}`;
            li.className = "pb-opt";
            li.setAttribute("role", "option");
            li.setAttribute("aria-selected", b.id === index.active);
            li.dataset.id = b.id;
            li.dataset.i = i;

            const stack = document.createElement("span");
            stack.className = "pb-opt-stack";
            stack.setAttribute("aria-hidden", "true");
            if (thumbs.length) {
                thumbs.forEach((u) => {
                    const img = document.createElement("img");
                    img.alt = "";
                    img.src = `${u}&w=80&h=100&fit=crop&q=60&auto=format`;
                    stack.appendChild(img);
                });
            } else stack.appendChild(document.createElement("i"));

            const name = document.createElement("span");
            name.className = "pb-opt-name";
            name.textContent = b.name;
            const count = document.createElement("span");
            count.className = "pb-opt-count mono";
            count.textContent = String(n).padStart(2, "0");
            count.setAttribute("aria-label", `${n} pin${n === 1 ? "" : "s"}`);
            const check = document.createElement("span");
            check.className = "pb-opt-check";
            check.setAttribute("aria-hidden", "true");
            check.textContent = "✓";

            li.append(stack, name, count, check);
            pickList.appendChild(li);
        });
        setPickIdx(pickIdx);
    }

    function setPickIdx(i) {
        const opts = [...pickList.children];
        if (!opts.length) return;
        pickIdx = (i + opts.length) % opts.length;
        opts.forEach((o, k) => o.classList.toggle("is-active", k === pickIdx));
        pickList.setAttribute("aria-activedescendant", opts[pickIdx].id);
        opts[pickIdx].scrollIntoView({ block: "nearest" });
    }

    function openPicker() {
        if (pickOpen || readonly) return;
        pickOpen = true;
        pickIdx = Math.max(0, index.list.findIndex((b) => b.id === index.active));
        buildPicker();
        pickPop.hidden = false;
        pickBtn.setAttribute("aria-expanded", "true");
        pickList.focus({ preventScroll: true });
        if (!reduceMotion) {
            gsap.fromTo(pickPop, { opacity: 0, y: -8, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.35, ease: "expo.out", transformOrigin: "0 0" });
            gsap.fromTo(pickList.children, { opacity: 0, x: -8 }, { opacity: 1, x: 0, duration: 0.4, stagger: 0.03, ease: "expo.out" });
        }
    }

    function closePicker(refocus) {
        if (!pickOpen) return;
        pickOpen = false;
        pickPop.hidden = true;
        pickBtn.setAttribute("aria-expanded", "false");
        if (refocus) pickBtn.focus({ preventScroll: true });
    }

    function choosePick(i) {
        const b = index.list[i];
        closePicker(true);
        if (b && b.id !== index.active) switchBoard(b.id);
    }

    pickBtn.addEventListener("click", () => (pickOpen ? closePicker(true) : openPicker()));
    pickList.addEventListener("click", (e) => {
        const li = e.target.closest(".pb-opt");
        if (li) choosePick(+li.dataset.i);
    });
    pickList.addEventListener("pointermove", (e) => {
        const li = e.target.closest(".pb-opt");
        if (li && +li.dataset.i !== pickIdx) setPickIdx(+li.dataset.i);
    });
    pickList.addEventListener("keydown", (e) => {
        const n = index.list.length;
        const moves = { ArrowDown: pickIdx + 1, ArrowUp: pickIdx - 1, Home: 0, End: n - 1 };
        if (e.key in moves) {
            e.preventDefault();
            return setPickIdx(moves[e.key]);
        }
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            return choosePick(pickIdx);
        }
        // type-ahead: jump to the next board starting with that letter
        if (e.key.length === 1 && /\S/.test(e.key)) {
            const k = e.key.toLowerCase();
            for (let s = 1; s <= n; s++) {
                const j = (pickIdx + s) % n;
                if (index.list[j].name.toLowerCase().startsWith(k)) return setPickIdx(j);
            }
        }
    });
    document.addEventListener("pointerdown", (e) => {
        if (pickOpen && !e.target.closest(".pb-picker")) closePicker(false);
    });
    pickPop.addEventListener("focusout", (e) => {
        if (pickOpen && !pickPop.contains(e.relatedTarget) && e.relatedTarget !== pickBtn && e.relatedTarget) closePicker(false);
    });

    function switchBoard(id) {
        if (!index.list.some((b) => b.id === id)) return;
        closePop(false);
        cancelThreadFrom();
        clearSel();
        closeFind(false);
        index.active = id;
        store.set(INDEX, index);
        loadActive();
        undoStack = [];
        redoStack = [];
        syncUndo();
        syncSwitcher();
        render();
        if (!board.hidden) {
            if (loadView()) applyView();
            else fit(false);
        }
        announce(`Switched to ${B.name}`);
        contextChanged();
    }

    q("#pb-new").addEventListener("click", () => {
        closePicker(false);
        const id = uid();
        const name = `Board ${index.list.length + 1}`;
        store.set(bkey(id), cleanBoard({ name }));
        index.list.push({ id, name, updated: Date.now() });
        changed(id);
        switchBoard(id);
        nameInput.focus();
        nameInput.select();
    });

    deleteBtn.addEventListener("click", () => {
        if (index.list.length < 2) return;
        const n = B.pins.length;
        if (!confirm(`Delete “${B.name}”${n ? ` and its ${n} pin${n === 1 ? "" : "s"}` : ""}? This can't be undone.`)) return;
        const id = index.active;
        index.list = index.list.filter((b) => b.id !== id);
        store.del(bkey(id));
        store.del(vkey(id));
        switchBoard(index.list[0].id);
        document.dispatchEvent(new CustomEvent("pins:deleted", { detail: { id, at: Date.now() } }));
    });

    nameInput.addEventListener("input", () => {
        if (readonly) return;
        B.name = nameInput.value.trim().slice(0, 60) || "Untitled board";
        persist();
    });
    nameInput.addEventListener("blur", () => (nameInput.value = B.name));
    nameInput.addEventListener("keydown", (e) => e.key === "Enter" && nameInput.blur());

    /* ---------- board camera ---------- */
    // Cards live in world pixels inside #pb-world; the view pans/zooms that layer.
    // `goal` is where the camera is heading and `view` eases toward it every
    // frame, so wheel, buttons, fit and pan flicks all glide. While a zoom eases,
    // `anchor` pins the world point that was under the cursor to the same spot
    // on screen, so zooming never drifts sideways.
    let view = { x: 0, y: 0, z: 1 };
    let goal = { ...view };
    let anchor = null; // { sx, sy, wx, wy }
    let camRaf = 0;

    function loadView() {
        const v = store.get(vkey(index.active));
        const ok = v && [v.x, v.y, v.z].every(Number.isFinite);
        view = ok ? { x: v.x, y: v.y, z: clampZ(v.z) } : { x: 0, y: 0, z: 1 };
        goal = { ...view };
        anchor = null;
        return ok;
    }
    let hadView = loadView();

    // one coalesced job per animation frame for pointer-driven work
    let jobRaf = 0;
    let job = null;
    function onFrame(fn) {
        job = fn;
        if (!jobRaf)
            jobRaf = requestAnimationFrame(() => {
                jobRaf = 0;
                const f = job;
                job = null;
                f?.();
            });
    }

    // while the view moves, promote the world to its own layer; drop it at rest
    // so the browser re-rasterises text and photos crisply at the new zoom
    let movingT = 0;
    function markMoving() {
        if (!world.classList.contains("is-moving")) world.classList.add("is-moving");
        clearTimeout(movingT);
        movingT = setTimeout(() => world.classList.remove("is-moving"), 160);
    }

    let viewSaveT = 0;
    let lastLvl = "";
    function applyView() {
        world.style.transform = `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.z})`;
        const g = 26 * view.z;
        area.style.backgroundSize = `${g}px ${g}px`;
        area.style.backgroundPosition = `${view.x}px ${view.y}px`;
        const lvl = `${Math.round(goal.z * 100)}%`;
        if (lvl !== lastLvl) {
            lastLvl = lvl;
            zoomLvl.textContent = lvl;
            zoomOutBtn.disabled = goal.z <= ZMIN + 1e-3;
            zoomInBtn.disabled = goal.z >= ZMAX - 1e-3;
        }
        markMoving();
        placePop();
        placeMenu();
        scheduleMinimap();
        if (readonly) return;
        clearTimeout(viewSaveT);
        const id = index.active;
        viewSaveT = setTimeout(() => store.set(vkey(id), goal), 300);
    }

    function camTick() {
        camRaf = 0;
        const k = 0.2;
        // zoom eases in log space so in/out feel symmetric
        view.z = Math.exp(Math.log(view.z) + (Math.log(goal.z) - Math.log(view.z)) * k);
        if (anchor) {
            view.x = anchor.sx - anchor.wx * view.z;
            view.y = anchor.sy - anchor.wy * view.z;
            goal.x = anchor.sx - anchor.wx * goal.z;
            goal.y = anchor.sy - anchor.wy * goal.z;
        } else {
            view.x += (goal.x - view.x) * k;
            view.y += (goal.y - view.y) * k;
        }
        const done = Math.abs(goal.z - view.z) < 1e-4 && Math.abs(goal.x - view.x) < 0.15 && Math.abs(goal.y - view.y) < 0.15;
        if (done) {
            view = { ...goal };
            anchor = null;
        }
        applyView();
        if (!done) camRaf = requestAnimationFrame(camTick);
    }

    function stopCam() {
        cancelAnimationFrame(camRaf);
        camRaf = 0;
        anchor = null;
    }

    function kick() {
        if (reduceMotion) {
            if (anchor) {
                goal.x = anchor.sx - anchor.wx * goal.z;
                goal.y = anchor.sy - anchor.wy * goal.z;
            }
            stopCam();
            view = { ...goal };
            return applyView();
        }
        if (!camRaf) camRaf = requestAnimationFrame(camTick);
    }

    function goTo(t, animate) {
        anchor = null;
        goal = { x: t.x, y: t.y, z: clampZ(t.z) };
        if (!animate) {
            stopCam();
            view = { ...goal };
            return applyView();
        }
        kick();
    }

    // set the view right now (pointer pan / pinch: the board sticks to the finger)
    function setViewNow(x, y, z = view.z) {
        stopCam();
        view = { x, y, z: clampZ(z) };
        goal = { ...view };
        applyView();
    }

    function panBy(dx, dy) {
        if (anchor) {
            goal.x = anchor.sx - anchor.wx * goal.z;
            goal.y = anchor.sy - anchor.wy * goal.z;
            anchor = null;
        }
        goal.x += dx;
        goal.y += dy;
        kick();
    }

    // zoom to z keeping the world point under screen (sx, sy) where it is
    function zoomAt(z, sx, sy) {
        const r = area.getBoundingClientRect();
        const px = sx == null ? r.width / 2 : sx - r.left;
        const py = sy == null ? r.height / 2 : sy - r.top;
        anchor = { sx: px, sy: py, wx: (px - view.x) / view.z, wy: (py - view.y) / view.z };
        goal.z = clampZ(z);
        kick();
    }

    function contentBox() {
        let l = Infinity;
        let t = Infinity;
        let r = -Infinity;
        let b = -Infinity;
        geo.forEach((g) => {
            l = Math.min(l, g.l);
            t = Math.min(t, g.t - 12);
            r = Math.max(r, g.l + g.w);
            b = Math.max(b, g.t + g.h);
        });
        B.frames.forEach((f) => {
            l = Math.min(l, f.x);
            t = Math.min(t, f.y);
            r = Math.max(r, f.x + f.w);
            b = Math.max(b, f.y + f.h);
        });
        return l === Infinity ? null : { l, t, r, b };
    }

    function fit(animate = true, box = contentBox()) {
        if (!box) return goTo({ x: 0, y: 0, z: 1 }, animate);
        const pad = 48;
        const w = area.clientWidth;
        const h = area.clientHeight;
        const z = clamp(ZMIN, 1, Math.min((w - pad * 2) / (box.r - box.l), (h - pad * 2) / (box.b - box.t)));
        goTo({ z, x: (w - (box.r - box.l) * z) / 2 - box.l * z, y: (h - (box.b - box.t) * z) / 2 - box.t * z }, animate);
    }

    // pan just enough to bring a world rect on screen (keyboard focus)
    function reveal(l, t, w, h) {
        const pad = 40;
        const sl = goal.x + l * goal.z;
        const st = goal.y + t * goal.z;
        const sr = sl + w * goal.z;
        const sb = st + h * goal.z;
        let dx = 0;
        let dy = 0;
        if (sl < pad) dx = pad - sl;
        else if (sr > area.clientWidth - pad) dx = area.clientWidth - pad - sr;
        if (st < pad) dy = pad - st;
        else if (sb > area.clientHeight - pad) dy = area.clientHeight - pad - sb;
        if (dx || dy) panBy(dx, dy);
    }

    zoomOutBtn.addEventListener("click", () => zoomAt(goal.z / 1.25));
    zoomInBtn.addEventListener("click", () => zoomAt(goal.z * 1.25));
    zoomLvl.addEventListener("click", () => zoomAt(1));
    q("#pb-fit").addEventListener("click", () => fit(true));

    area.addEventListener(
        "wheel",
        (e) => {
            if (board.hidden) return;
            e.preventDefault();
            const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? area.clientHeight : 1;
            if (e.ctrlKey || e.metaKey) {
                // ctrl/cmd + wheel, and trackpad pinch (sent as ctrl + wheel)
                const d = clamp(-120, 120, e.deltaY * unit);
                return zoomAt(goal.z * Math.exp(-d * 0.003), e.clientX, e.clientY);
            }
            let dx = e.deltaX * unit;
            let dy = e.deltaY * unit;
            if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
            panBy(-dx, -dy);
        },
        { passive: false }
    );

    /* ---------- layout ---------- */
    let top = 10;
    const cards = () => [...world.querySelectorAll(".pb-card")];
    const cardEl = (id) => world.querySelector(`.pb-card[data-id="${CSS.escape(id)}"]`);
    const frameEl = (id) => framesLayer.querySelector(`.pb-frame[data-id="${CSS.escape(id)}"]`);
    const knotEl = (k) => knots.querySelector(`.pb-knot[data-k="${CSS.escape(k)}"]`);
    const placed = (x) => Number.isFinite(x.bx) && Number.isFinite(x.by);

    // items that were never placed: very old saves stored fractions of the area,
    // brand new ones take the first free slot in the visible part of the board
    function placeNew() {
        const w = area.clientWidth || innerWidth;
        const h = area.clientHeight || innerHeight;
        B.pins.forEach((x) => {
            if (placed(x) || x.x == null || x.y == null) return;
            const cw = clamp(150, 210, innerWidth * 0.15);
            x.bx = 16 + clamp(0, 1, x.x) * Math.max(1, w - cw - 32);
            x.by = 16 + Math.max(0, x.y) * Math.max(1, h - (cw * 1.25 + 96) - 32);
        });
        const ox = (32 - view.x) / view.z;
        const oy = (32 - view.y) / view.z;
        const cols = Math.max(1, Math.floor((w / view.z - 64) / (CARD_W + 24)));
        const taken = B.pins.filter(placed).map((x) => ({ l: x.bx, t: x.by }));
        B.pins.forEach((x) => {
            if (placed(x)) return;
            for (let i = 0; i < 4000; i++) {
                const l = ox + (i % cols) * (CARD_W + 24);
                const t = oy + Math.floor(i / cols) * (CARD_H + 28);
                if (taken.some((o) => Math.abs(o.l - l) < CARD_W * 0.8 && Math.abs(o.t - t) < CARD_H * 0.8)) continue;
                x.bx = l;
                x.by = t;
                taken.push({ l, t });
                break;
            }
        });
    }

    function tidy() {
        const n = B.pins.length;
        if (!n || readonly) return;
        checkpoint();
        const w = area.clientWidth;
        const h = area.clientHeight;
        const cols = Math.max(1, Math.round(Math.sqrt(n * (w / h) * ((CARD_H + 28) / (CARD_W + 24)))));
        const from = new Map(cards().map((el) => [el.dataset.id, { left: el.offsetLeft, top: el.offsetTop }]));
        // rows are as tall as their tallest card (notes and links are shorter)
        let y = 0;
        for (let r = 0; r * cols < n; r++) {
            const row = B.pins.slice(r * cols, r * cols + cols);
            let rowH = 0;
            row.forEach((x, c) => {
                x.bx = c * (CARD_W + 24);
                x.by = y;
                x.r = Math.round((Math.random() * 2 - 1) * 30) / 10;
                rowH = Math.max(rowH, geo.get(x.id)?.h || CARD_H);
            });
            y += rowH + 28;
        }
        B.frames = [];
        save();
        fit(true, { l: 0, t: -12, r: Math.min(n, cols) * (CARD_W + 24) - 24, b: y - 28 });
        announce("Tidied into a grid. Groups were removed; undo to bring them back.");
        if (reduceMotion) return;
        cards().forEach((el, i) => {
            const a = from.get(el.dataset.id);
            if (!a) return;
            const id = el.dataset.id;
            gsap.from(el, {
                left: a.left,
                top: a.top,
                duration: 0.9,
                ease: "expo.inOut",
                delay: i * 0.015,
                onUpdate() {
                    const g = geo.get(id);
                    if (!g) return;
                    g.l = parseFloat(el.style.left) || 0;
                    g.t = parseFloat(el.style.top) || 0;
                    drawStrings(id);
                },
            });
        });
    }

    // world-space box of every card, kept in step with what's on screen so
    // threads, snapping and hit tests never have to read layout mid-gesture
    const geo = new Map(); // id -> { l, t, w, h, r }

    // where a card's pin sits in world px, following the card's tilt
    function pinPoint(id) {
        const g = geo.get(id);
        if (!g) return null;
        const r = (g.r * Math.PI) / 180;
        const d = g.h / 2 - 1;
        return [g.l + g.w / 2 + d * Math.sin(r), g.t + g.h / 2 - d * Math.cos(r)];
    }

    const sagOf = (a, b) => Math.min(140, Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.18);
    const ctrlOf = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + sagOf(a, b)];
    // midpoint of the quadratic curve (t = 0.5)
    const knotOf = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + sagOf(a, b) / 2];
    const stringPath = (a, b) => {
        const c = ctrlOf(a, b);
        return `M${a[0].toFixed(1)},${a[1].toFixed(1)} Q${c[0].toFixed(1)},${c[1].toFixed(1)} ${b[0].toFixed(1)},${b[1].toFixed(1)}`;
    };
    const knotPoint = (t) => {
        const a = t && pinPoint(t.a);
        const b = t && pinPoint(t.b);
        return a && b ? knotOf(a, b) : null;
    };

    const SVG = "http://www.w3.org/2000/svg";
    const threadEls = new Map(); // key -> { g, paths: [hit, shadow, line], kn, label }

    // The strings layer sits above every card, so a thread would lie on top of
    // its pin. Pins that hold a thread get a copy of their head drawn above the
    // threads, so each string disappears under the pin it's tied to.
    const headsLayer = document.createElementNS(SVG, "g");
    headsLayer.setAttribute("class", "pb-pinheads");
    strings.insertBefore(headsLayer, tempPath);
    {
        const defs = document.createElementNS(SVG, "defs");
        defs.innerHTML = `<radialGradient id="pb-pinhead-fill" cx="35%" cy="35%" r="65%"><stop offset="0" stop-color="#ffb299"/><stop offset="0.45" stop-color="var(--accent)" style="stop-color: var(--accent)"/><stop offset="1" stop-color="#b8340f"/></radialGradient>`;
        strings.prepend(defs);
    }
    const heads = new Map(); // card id -> circle
    function placeHead(id) {
        const p = pinPoint(id);
        let c = heads.get(id);
        if (!p) return c?.remove(), heads.delete(id);
        if (!c) {
            c = document.createElementNS(SVG, "circle");
            c.setAttribute("class", "pb-pinhead");
            c.setAttribute("r", "8");
            c.dataset.id = id;
            headsLayer.appendChild(c);
            heads.set(id, c);
        }
        c.setAttribute("cx", p[0].toFixed(1));
        c.setAttribute("cy", p[1].toFixed(1));
    }
    const headFor = (id) => heads.get(id);

    function threadEl(k) {
        let te = threadEls.get(k);
        if (te) return te;
        const g = document.createElementNS(SVG, "g");
        g.setAttribute("class", "pb-thread");
        g.dataset.k = k;
        g.dataset.cursor = "Edit";
        const paths = ["pb-thread-hit", "pb-thread-shadow", "pb-thread-line"].map((c) => {
            const p = document.createElementNS(SVG, "path");
            p.setAttribute("class", c);
            g.appendChild(p);
            return p;
        });
        strings.insertBefore(g, headsLayer);
        // the knot: a focusable handle at the middle of the string, showing its label
        const kn = document.createElement("button");
        kn.type = "button";
        kn.className = "pb-knot";
        kn.dataset.k = k;
        kn.dataset.cursor = "Edit";
        kn.appendChild(document.createElement("span"));
        knots.appendChild(kn);
        te = { g, paths, kn, label: null };
        threadEls.set(k, te);
        return te;
    }

    function drawThread(t) {
        const a = pinPoint(t.a);
        const b = pinPoint(t.b);
        if (!a || !b) return null;
        const k = tkey(t.a, t.b);
        const te = threadEl(k);
        const d = stringPath(a, b);
        te.paths.forEach((p) => p.setAttribute("d", d));
        const m = knotOf(a, b);
        te.kn.style.transform = `translate(${m[0].toFixed(1)}px, ${m[1].toFixed(1)}px)`;
        if (te.label !== t.label) {
            te.label = t.label;
            te.kn.firstChild.textContent = t.label;
            te.kn.classList.toggle("has-label", !!t.label);
        }
        te.kn.setAttribute("aria-label", `Thread between ${nameOf(t.a)} and ${nameOf(t.b)}${t.label ? `: ${t.label}` : ""}. Enter to edit, Delete to cut.`);
        te.kn.tabIndex = readonly ? -1 : 0;
        return k;
    }

    // redraw every thread, or only those touching the given card id(s)
    function drawStrings(only) {
        scheduleMinimap();
        if (only != null) {
            const set = new Set(Array.isArray(only) ? only : [only]);
            B.threads.forEach((t) => (set.has(t.a) || set.has(t.b)) && drawThread(t));
            set.forEach((id) => heads.has(id) && placeHead(id));
            if (popKey) placePop();
            return;
        }
        const seen = new Set();
        B.threads.forEach((t) => {
            const k = drawThread(t);
            if (k) seen.add(k);
        });
        threadEls.forEach((te, k) => {
            if (seen.has(k)) return;
            te.g.remove();
            te.kn.remove();
            threadEls.delete(k);
        });
        const tied = new Set();
        B.threads.forEach((t) => (tied.add(t.a), tied.add(t.b)));
        tied.forEach(placeHead);
        heads.forEach((c, id) => {
            if (tied.has(id)) return;
            c.remove();
            heads.delete(id);
        });
        placePop();
    }

    function ariaFor(x) {
        const note = x.note ? `, note: ${x.note}` : "";
        if (x.kind === "unsplash") return `Photo by ${x.photo.user.name}${note}`;
        if (x.kind === "upload") return `Your image ${x.media.name || ""}${note}`;
        if (x.kind === "link") return `${x.media.src ? "Image" : "Link"} from ${hostOf(x.media.href)}${note}`;
        return `Note: ${x.note || "empty"}`;
    }

    function render() {
        syncCount();
        if (!lightbox.hidden) syncLightbox();
        if (board.hidden) return;

        if (B.pins.some((x) => !placed(x))) {
            placeNew();
            persist();
        }

        renderFrames();

        const keep = new Map(cards().map((el) => [el.dataset.id, el]));
        const live = [];
        B.pins.forEach((x) => {
            let el = keep.get(x.id);
            keep.delete(x.id);
            if (!el) el = makeCard(x);
            if (el.classList.contains("is-held") || el.classList.contains("is-carried")) return live.push([el, x]);
            el.style.width = `${CARD_W}px`;
            el.style.left = `${x.bx}px`;
            el.style.top = `${x.by}px`;
            el.style.setProperty("--r", `${x.r || 0}deg`);
            if (x.kind === "note") el.style.setProperty("--tint", TINT_HEX[x.tint]);
            const note = el.querySelector(".pb-note");
            if (document.activeElement !== note) note.value = x.note || "";
            note.readOnly = readonly;
            el.setAttribute("aria-label", ariaFor(x));
            const n = commentCounts.get(x.id) || 0;
            let badge = el.querySelector(".pb-cbadge");
            if (n && !badge) {
                badge = actButton("comments", "", "Comments");
                badge.classList.add("pb-cbadge");
                el.appendChild(badge);
            }
            if (badge) {
                badge.hidden = !n;
                badge.textContent = n > 99 ? "99+" : String(n);
                badge.setAttribute("aria-label", `${n} comment${n === 1 ? "" : "s"} on this card`);
            }
            const loc = el.querySelector('[data-act="locate"]');
            if (loc) {
                const onWall = !!window.canvasView?.onWall?.(x.id);
                loc.disabled = !onWall;
                loc.title = onWall ? "Fly to this frame on the wall" : "Not on the current wall — search for it to locate";
            }
            live.push([el, x]);
        });
        keep.forEach((el) => el.remove());

        // all writes are done: read sizes once
        geo.clear();
        live.forEach(([el, x]) => {
            const moving = el.classList.contains("is-held") || el.classList.contains("is-carried");
            geo.set(x.id, { l: moving ? el.offsetLeft : x.bx, t: moving ? el.offsetTop : x.by, w: el.offsetWidth || CARD_W, h: el.offsetHeight || CARD_H, r: x.r || 0 });
        });

        [...sel].forEach((id) => !has(id) && sel.delete(id));
        syncSel();
        drawStrings();
        syncTray();
        emptyEl.hidden = B.pins.length > 0 || B.frames.length > 0;
        if (document.activeElement !== nameInput) nameInput.value = B.name;
        nameInput.readOnly = readonly;
    }

    const cardSrc = (p) => `${p.urls.raw}&w=420&h=525&fit=crop&crop=entropy&q=70&auto=format`;
    const utmLink = (u) => `${u}?utm_source=aperture&utm_medium=referral`;

    function mk(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function actButton(act, label, cursor, aria) {
        const b = mk("button", "", label);
        b.type = "button";
        b.dataset.act = act;
        b.dataset.cursor = cursor;
        if (aria) b.setAttribute("aria-label", aria);
        return b;
    }

    function extLink(href, label, cursor) {
        const a = mk("a", "", label);
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.dataset.cursor = cursor;
        return a;
    }

    function makeCard(x) {
        const id = x.id;
        const card = mk("figure", `pb-card is-${x.kind}`);
        card.dataset.id = id;
        card.tabIndex = 0;
        card.setAttribute("aria-roledescription", { unsplash: "pinned photo", upload: "your image", link: "link", note: "note" }[x.kind]);
        card.style.setProperty("--c", colorOf(x));

        const pin = mk("span", "pb-pin");
        pin.setAttribute("aria-hidden", "true");
        pin.dataset.cursor = "Thread";
        pin.title = "Drag onto another card to tie a thread";
        card.appendChild(pin);

        // picture
        if (x.kind !== "note") {
            if (x.kind === "link" && !x.media.src) {
                const bm = mk("a", "pb-bookmark");
                bm.href = x.media.href;
                bm.target = "_blank";
                bm.rel = "noopener noreferrer";
                bm.draggable = false;
                bm.dataset.cursor = "Open";
                bm.append(mk("span", "pb-bookmark-host", hostOf(x.media.href)), mk("span", "pb-bookmark-path mono", x.media.title || x.media.href));
                card.appendChild(bm);
            } else {
                const img = mk("img");
                img.draggable = false;
                img.loading = "lazy";
                img.decoding = "async";
                if (x.kind === "unsplash") {
                    img.alt = x.photo.alt_description || x.photo.description || "Pinned photo";
                    img.src = cardSrc(x.photo);
                } else if (x.kind === "upload") {
                    img.alt = x.media.name || "Your image";
                    window.media?.url(id).then((u) => {
                        if (u) img.src = u;
                        else card.classList.add("is-missing");
                    });
                } else {
                    img.alt = x.media.title || "Image from a link";
                    img.referrerPolicy = "no-referrer";
                    img.src = x.media.src;
                    img.onerror = () => card.classList.add("is-missing");
                }
                card.appendChild(img);
            }
        }

        const cap = mk("figcaption");
        const note = mk("textarea", x.kind === "note" ? "pb-note pb-sticky" : "pb-note");
        note.rows = x.kind === "note" ? 6 : 2;
        note.maxLength = x.kind === "note" ? 1000 : 280;
        note.placeholder = x.kind === "note" ? "Write something…" : "why this one…";
        note.value = x.note || "";
        note.setAttribute("aria-label", x.kind === "note" ? "Note text" : "Note for this card");
        let t = 0;
        let marked = false;
        note.addEventListener("focus", () => (marked = false));
        note.addEventListener("input", () => {
            if (!marked) {
                checkpoint();
                marked = true;
            }
            clearTimeout(t);
            t = setTimeout(() => {
                const cur = pinBy(id);
                if (!cur) return;
                cur.note = note.value;
                persist();
            }, 250);
        });
        cap.appendChild(note);

        // credit / source line
        if (x.kind !== "note") {
            const meta = mk("div", "pb-meta mono");
            if (x.kind === "unsplash") meta.append(extLink(utmLink(x.photo.user.links.html), x.photo.user.name, "Profile"), mk("span", "", fromLabel(x)));
            else if (x.kind === "upload") meta.append(mk("span", "", x.media.name || "Your image"), mk("span", "", "Upload"));
            else meta.append(mk("span", "", hostOf(x.media.href)), mk("span", "", fromLabel(x)));
            cap.appendChild(meta);
        }

        const acts = mk("div", "pb-acts mono");
        if (x.kind === "unsplash") acts.append(actButton("locate", "Locate ◎", "Locate"), extLink(utmLink(x.photo.links.html), "Unsplash ↗", "Open"));
        else if (x.kind === "link") acts.append(extLink(x.media.href, "Open ↗", "Open"), mk("span"));
        else if (x.kind === "note") acts.append(actButton("tint", "Colour ◐", "Colour", "Change note colour"), mk("span"));
        else acts.append(mk("span"), mk("span"));
        acts.append(actButton("remove", "✕", "Remove", `Remove ${labelOf(x)}`));
        cap.appendChild(acts);

        card.appendChild(cap);
        world.insertBefore(card, strings);
        if (!reduceMotion && !opening) gsap.from(card, { y: -60, opacity: 0, rotate: (x.r || 0) * 4, duration: 0.8, ease: "back.out(1.6)" });
        return card;
    }

    /* ---------- frames (groups) ---------- */
    const frameBy = (id) => B.frames.find((f) => f.id === id);

    function renderFrames() {
        const keep = new Map([...framesLayer.children].map((el) => [el.dataset.id, el]));
        B.frames.forEach((f) => {
            let el = keep.get(f.id);
            keep.delete(f.id);
            if (!el) el = makeFrame(f);
            el.style.left = `${f.x}px`;
            el.style.top = `${f.y}px`;
            el.style.width = `${f.w}px`;
            el.style.height = `${f.h}px`;
            const input = el.querySelector(".pb-frame-title");
            if (document.activeElement !== input) input.value = f.title;
            input.readOnly = readonly;
        });
        keep.forEach((el) => el.remove());
    }

    function makeFrame(f) {
        const id = f.id;
        const el = document.createElement("section");
        el.className = "pb-frame";
        el.dataset.id = id;
        el.setAttribute("aria-label", "Group");

        const bar = document.createElement("div");
        bar.className = "pb-frame-bar";
        const grip = document.createElement("button");
        grip.type = "button";
        grip.className = "pb-frame-grip";
        grip.dataset.cursor = "Move";
        grip.setAttribute("aria-label", "Move group with arrow keys, or drag");
        grip.textContent = "⠿";
        const title = document.createElement("input");
        title.className = "pb-frame-title";
        title.placeholder = "Untitled group";
        title.maxLength = 60;
        title.spellcheck = false;
        title.setAttribute("aria-label", "Group title");
        let marked = false;
        title.addEventListener("focus", () => (marked = false));
        title.addEventListener("input", () => {
            const cur = frameBy(id);
            if (!cur || readonly) return;
            if (!marked) {
                checkpoint();
                marked = true;
            }
            cur.title = title.value.slice(0, 60);
            persist();
        });
        title.addEventListener("keydown", (e) => e.key === "Enter" && title.blur());
        const del = document.createElement("button");
        del.type = "button";
        del.className = "pb-frame-del";
        del.dataset.cursor = "Delete";
        del.setAttribute("aria-label", "Delete group (photos stay)");
        del.textContent = "✕";
        del.addEventListener("click", () => {
            if (readonly) return;
            checkpoint();
            B.frames = B.frames.filter((x) => x.id !== id);
            save();
            announce("Group deleted");
        });
        bar.append(grip, title, del);

        const handle = document.createElement("span");
        handle.className = "pb-frame-handle";
        handle.dataset.cursor = "Resize";
        handle.setAttribute("aria-hidden", "true");

        el.append(bar, handle);
        framesLayer.appendChild(el);
        if (!reduceMotion && !opening) gsap.from(el, { opacity: 0, scale: 0.96, duration: 0.5, ease: "expo.out", transformOrigin: "0 0" });
        return el;
    }

    // cards whose centre sits inside the frame move with it
    function membersOf(f) {
        const out = [];
        geo.forEach((g, id) => {
            const cx = g.l + g.w / 2;
            const cy = g.t + g.h / 2;
            if (cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h) out.push(id);
        });
        return out;
    }

    function newFrame() {
        if (readonly) return;
        checkpoint();
        const w = 560;
        const h = 420;
        const cx = (area.clientWidth / 2 - view.x) / view.z;
        const cy = (area.clientHeight / 2 - view.y) / view.z;
        const f = { id: uid(), x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h, title: "" };
        B.frames.push(f);
        save();
        frameEl(f.id)?.querySelector(".pb-frame-title").focus({ preventScroll: true });
        announce("Group added. Type a title, drag photos into it; moving the group moves them too.");
    }
    q("#pb-frame").addEventListener("click", () => (sel.size > 1 ? frameAround([...sel]) : newFrame()));

    /* ---------- thread popover (label + cut) ---------- */
    let popKey = null;
    let popMarked = false;

    function openPop(k) {
        const t = threadBy(k);
        if (!t || readonly) return;
        popKey = k;
        popMarked = false;
        popInput.value = t.label || "";
        pop.hidden = false;
        placePop();
        popInput.focus({ preventScroll: true });
        knotEl(k)?.classList.add("is-open");
    }

    function closePop(refocus) {
        if (!popKey) return;
        const k = popKey;
        popKey = null;
        pop.hidden = true;
        const kn = knotEl(k);
        kn?.classList.remove("is-open");
        if (refocus) kn?.focus({ preventScroll: true });
    }

    function placePop() {
        if (!popKey) return;
        const p = knotPoint(threadBy(popKey));
        if (!p) return closePop(false);
        pop.style.left = `${view.x + p[0] * view.z}px`;
        pop.style.top = `${view.y + p[1] * view.z}px`;
    }

    popInput.addEventListener("input", () => {
        const t = threadBy(popKey);
        if (!t) return;
        if (!popMarked) {
            checkpoint();
            popMarked = true;
        }
        t.label = popInput.value.slice(0, 60);
        persist();
        drawStrings();
    });
    popInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            closePop(true);
        }
    });
    q("#pb-pop-cut").addEventListener("click", () => {
        const k = popKey;
        closePop(false);
        cutThread(k);
        area.focus({ preventScroll: true });
    });

    /* ---------- keyboard threading ---------- */
    let threadFrom = null;
    function startThreadFrom(id) {
        threadFrom = id;
        cardEl(id)?.classList.add("is-source");
        announce(`Tying a thread from ${nameOf(id)}. Move to another photo and press T or Enter. Escape cancels.`);
    }
    function cancelThreadFrom() {
        if (!threadFrom) return false;
        cardEl(threadFrom)?.classList.remove("is-source");
        threadFrom = null;
        return true;
    }
    function finishThreadTo(id) {
        const from = threadFrom;
        cancelThreadFrom();
        if (from === id) return;
        if (addThread(from, id)) announce(`Thread tied between ${nameOf(from)} and ${nameOf(id)}`);
        else announce("Those two are already tied");
    }

    /* ---------- menus (Add, Export, right-click / long-press) ---------- */
    let openMenu = null; // { el, btn, onClose }
    const menuItems = (m) => [...m.querySelectorAll('[role="menuitem"]')].filter((i) => !i.disabled && i.offsetParent !== null);

    function showMenu(m, { btn = null, x = 0, y = 0, sheet = false, onClose, pinned = false } = {}) {
        closeMenu(false);
        closePalette();
        m.hidden = false;
        m.classList.toggle("is-sheet", sheet);
        if (!sheet) {
            const r = btn ? btn.getBoundingClientRect() : null;
            const mw = m.offsetWidth;
            const mh = m.offsetHeight;
            let left = r ? r.left : x;
            let topPx = r ? r.bottom + 8 : y;
            left = clamp(8, Math.max(8, innerWidth - mw - 8), left);
            if (topPx + mh > innerHeight - 8) topPx = Math.max(8, (r ? r.top : y) - mh - 8);
            m.style.left = `${left}px`;
            m.style.top = `${topPx}px`;
        } else {
            m.style.left = m.style.top = "";
        }
        btn?.setAttribute("aria-expanded", "true");
        openMenu = { el: m, btn, onClose };
        // a menu opened on the board stays on the spot it was opened for while the view pans or zooms
        if (pinned && !sheet) {
            const r = area.getBoundingClientRect();
            openMenu.anchor = [(x - r.left - view.x) / view.z, (y - r.top - view.y) / view.z];
            openMenu.offset = [parseFloat(m.style.left) - x, parseFloat(m.style.top) - y];
        }
        menuItems(m)[0]?.focus({ preventScroll: true });
        if (!reduceMotion) gsap.fromTo(m, { opacity: 0, y: sheet ? 24 : -6 }, { opacity: 1, y: 0, duration: 0.28, ease: "expo.out" });
    }

    function placeMenu() {
        if (!openMenu?.anchor) return;
        const r = area.getBoundingClientRect();
        const [wx, wy] = openMenu.anchor;
        const [ox, oy] = openMenu.offset;
        openMenu.el.style.left = `${(r.left + view.x + wx * view.z + ox).toFixed(1)}px`;
        openMenu.el.style.top = `${(r.top + view.y + wy * view.z + oy).toFixed(1)}px`;
    }

    function closeMenu(refocus) {
        if (!openMenu) return false;
        const m = openMenu;
        openMenu = null;
        m.el.hidden = true;
        m.btn?.setAttribute("aria-expanded", "false");
        if (refocus) (m.btn || area).focus({ preventScroll: true });
        m.onClose?.();
        return true;
    }

    function menuKeys(e) {
        if (!openMenu) return false;
        const items = menuItems(openMenu.el);
        const i = items.indexOf(document.activeElement);
        const go = (n) => items[(n + items.length) % items.length]?.focus({ preventScroll: true });
        if (e.key === "ArrowDown") go(i + 1);
        else if (e.key === "ArrowUp") go(i - 1);
        else if (e.key === "Home") go(0);
        else if (e.key === "End") go(items.length - 1);
        else if (e.key === "Escape") closeMenu(true);
        else if (e.key === "Tab") closeMenu(false);
        else if ((e.key === "Enter" || e.key === " ") && items[i]) items[i].click();
        else return true; // swallow other keys while a menu is open
        if (e.key !== "Tab") e.preventDefault();
        return true;
    }

    document.addEventListener("pointerdown", (e) => {
        if (openMenu && !openMenu.el.contains(e.target) && !openMenu.btn?.contains(e.target)) closeMenu(false);
    });

    // context menu content is built per use
    function ctxMenu(items, at, sheet) {
        ctxEl.textContent = "";
        items.forEach((it) => {
            if (!it) return;
            const b = mk("button", it.danger ? "is-danger" : "", it.label);
            b.type = "button";
            b.setAttribute("role", "menuitem");
            b.addEventListener("click", () => {
                closeMenu(false);
                it.run();
            });
            ctxEl.appendChild(b);
        });
        showMenu(ctxEl, { x: at[0], y: at[1], sheet, pinned: true });
    }

    function cardMenu(id, at, sheet) {
        const x = pinBy(id);
        if (!x) return;
        const comment = window.comments?.available?.() ? { label: "Comment on this card…", run: () => window.comments.open(id) } : null;
        if (readonly) return comment ? ctxMenu([comment], at, sheet) : undefined;
        const many = sel.size > 1 && sel.has(id);
        ctxMenu(
            [
                { label: "Tie a thread from here…", run: () => startThreadFrom(id) },
                many ? null : comment,
                many ? null : { label: sel.has(id) ? "Deselect" : "Select", run: () => (sel.has(id) ? (sel.delete(id), syncSel()) : setSel([id], true)) },
                { label: "Bring to front", run: () => (cardEl(id).style.zIndex = ++top) },
                many ? { label: `Group ${sel.size} selected`, run: () => frameAround([...sel]) } : null,
                x.kind === "unsplash" && window.canvasView?.onWall?.(id) ? { label: "Locate on the wall", run: () => closeBoard(() => window.canvasView.locate(id)) } : null,
                x.kind === "link" ? { label: "Open link ↗", run: () => window.open(x.media.href, "_blank", "noopener,noreferrer") } : null,
                x.kind === "note" ? { label: "Change colour", run: () => cycleTint(id) } : null,
                { label: many ? `Remove ${sel.size} items` : "Remove", danger: true, run: () => removeWithNote(many ? [...sel] : [id]) },
            ],
            at,
            sheet
        );
    }

    function areaMenu(at, sheet) {
        if (readonly) return;
        ctxMenu(
            [
                { label: "Add a note here", run: () => addNote(at) },
                { label: "Add images…", run: () => pickFiles(at) },
                { label: "Add a link…", run: () => openLinkbox(at) },
                { label: "Photos from the wall", run: openTray },
                B.pins.length ? { label: "Select all", run: () => setSel(B.pins.map((x) => x.id)) } : null,
                { label: "Fit everything", run: () => fit(true) },
            ],
            at,
            sheet
        );
    }

    function removeWithNote(list) {
        const n = removeMany(list);
        if (n) announce(`Removed ${n === 1 ? "1 item" : `${n} items`}. Ctrl+Z to undo.`);
        if (n > 1) toast(`Removed ${n} items — Ctrl+Z to undo`);
    }

    function cycleTint(id) {
        const x = pinBy(id);
        if (!x || x.kind !== "note") return;
        checkpoint();
        x.tint = TINTS[(TINTS.indexOf(x.tint) + 1) % TINTS.length];
        save();
    }

    /* ---------- selection ---------- */
    const sel = new Set();

    function syncSel() {
        cards().forEach((c) => c.classList.toggle("is-selected", sel.has(c.dataset.id)));
        const n = sel.size;
        selbar.hidden = n < 2 || readonly;
        q("#pb-sel-n").textContent = `${n} selected`;
        qa("[data-dist]", selbar).forEach((b) => (b.disabled = n < 3));
    }

    function setSel(list, additive) {
        if (!additive) sel.clear();
        list.forEach((id) => has(id) && sel.add(id));
        syncSel();
    }

    function clearSel() {
        if (!sel.size) return false;
        sel.clear();
        syncSel();
        return true;
    }

    // align / distribute the selection, one undo step
    function arrange(how) {
        const list = [...sel].map((id) => ({ x: pinBy(id), g: geo.get(id) })).filter((o) => o.x && o.g);
        if (list.length < 2) return;
        checkpoint();
        const L = Math.min(...list.map((o) => o.g.l));
        const T = Math.min(...list.map((o) => o.g.t));
        const R = Math.max(...list.map((o) => o.g.l + o.g.w));
        const Bm = Math.max(...list.map((o) => o.g.t + o.g.h));
        if (how === "left") list.forEach((o) => (o.x.bx = L));
        if (how === "right") list.forEach((o) => (o.x.bx = R - o.g.w));
        if (how === "hcenter") list.forEach((o) => (o.x.bx = (L + R) / 2 - o.g.w / 2));
        if (how === "top") list.forEach((o) => (o.x.by = T));
        if (how === "bottom") list.forEach((o) => (o.x.by = Bm - o.g.h));
        if (how === "vcenter") list.forEach((o) => (o.x.by = (T + Bm) / 2 - o.g.h / 2));
        if (how === "hdist" || how === "vdist") {
            const hz = how === "hdist";
            list.sort((a, b) => (hz ? a.g.l - b.g.l : a.g.t - b.g.t));
            const total = list.reduce((s, o) => s + (hz ? o.g.w : o.g.h), 0);
            const gap = ((hz ? R - L : Bm - T) - total) / (list.length - 1);
            let at = hz ? L : T;
            list.forEach((o) => {
                if (hz) o.x.bx = at;
                else o.x.by = at;
                at += (hz ? o.g.w : o.g.h) + gap;
            });
        }
        list.forEach((o) => (o.x.r = 0));
        save();
        announce("Arranged");
    }

    // a titled group drawn around some items
    function frameAround(list) {
        const gs = list.map((id) => geo.get(id)).filter(Boolean);
        if (!gs.length || readonly) return;
        checkpoint();
        const pad = 36;
        const l = Math.min(...gs.map((g) => g.l)) - pad;
        const t = Math.min(...gs.map((g) => g.t)) - pad - 40;
        const r = Math.max(...gs.map((g) => g.l + g.w)) + pad;
        const b = Math.max(...gs.map((g) => g.t + g.h)) + pad;
        const f = { id: uid(), x: Math.round(l), y: Math.round(t), w: Math.round(r - l), h: Math.round(b - t), title: "" };
        B.frames.push(f);
        save();
        clearSel();
        frameEl(f.id)?.querySelector(".pb-frame-title").focus({ preventScroll: true });
        announce("Grouped. Type a title for the group.");
    }

    selbar.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        if (b.dataset.align) arrange(b.dataset.align);
        else if (b.dataset.dist) arrange(b.dataset.dist);
        else if (b.id === "pb-sel-group") frameAround([...sel]);
        else if (b.id === "pb-sel-delete") removeWithNote([...sel]);
        else if (b.id === "pb-sel-clear") clearSel();
    });

    /* ---------- pointer interactions ---------- */
    area.addEventListener("click", (e) => {
        const th = e.target.closest?.(".pb-thread, .pb-knot");
        if (th) return openPop(th.dataset.k);
        const btn = e.target.closest("button[data-act]");
        if (!btn) return;
        const card = btn.closest(".pb-card");
        const id = card.dataset.id;
        if (btn.dataset.act === "remove") {
            if (readonly) return;
            const done = () => {
                remove(id);
                announce("Removed. Ctrl+Z to undo.");
            };
            if (reduceMotion) return done();
            gsap.to(card, { y: 80, rotate: 18, opacity: 0, duration: 0.5, ease: "power2.in", onComplete: done });
        } else if (btn.dataset.act === "locate") {
            closeBoard(() => window.canvasView?.locate?.(id));
        } else if (btn.dataset.act === "tint") {
            cycleTint(id);
        } else if (btn.dataset.act === "comments") {
            window.comments?.open(id);
        }
    });

    let lastLongPress = 0;
    // a long-press sheet opens under the finger: the click that follows lifting
    // it must not land on whichever menu item ended up beneath
    let sheetGuard = false;
    let sheetGuardUntil = 0;
    document.addEventListener(
        "pointerup",
        () => {
            if (!sheetGuard) return;
            sheetGuard = false;
            sheetGuardUntil = performance.now() + 400;
        },
        true
    );
    document.addEventListener(
        "click",
        (e) => {
            if ((sheetGuard || performance.now() < sheetGuardUntil) && e.target.closest?.(".pb-menu")) {
                e.preventDefault();
                e.stopImmediatePropagation();
            }
        },
        true
    );
    const armSheet = () => {
        lastLongPress = performance.now();
        sheetGuard = true;
    };
    area.addEventListener("contextmenu", (e) => {
        // touch browsers fire their own contextmenu after a long press: ours already opened
        if (performance.now() - lastLongPress < 1200) return e.preventDefault();
        if (e.target.closest("textarea, input, a, .pb-pop, .pb-tray, .pb-find, .pb-linkbox, .pb-selbar")) return;
        e.preventDefault();
        const card = e.target.closest(".pb-card");
        if (card) cardMenu(card.dataset.id, [e.clientX, e.clientY], false);
        else areaMenu([e.clientX, e.clientY], false);
    });

    // one gesture at a time: move cards, pull a thread, move/resize a frame,
    // draw a selection box, pan, or pinch-zoom. Pointer events only record
    // where the pointer is; the DOM is touched at most once per frame.
    let drag = null;
    const touches = new Map();
    const LONG_PRESS = 480;
    const pinchGeom = () => {
        const [a, b] = [...touches.values()];
        return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };

    // snap the grabbed card's edges / centre to other cards, and report guides
    function snapTo(d, tx, ty) {
        const g = geo.get(d.cardId);
        if (!g || d.noSnap) return [tx, ty, ""];
        const th = 7 / view.z;
        const l = d.left + tx;
        const t = d.top + ty;
        const xs = [l, l + g.w / 2, l + g.w];
        const ys = [t, t + g.h / 2, t + g.h];
        let bx = null;
        let by = null;
        geo.forEach((o, oid) => {
            if (d.moving.has(oid)) return;
            const ox = [o.l, o.l + o.w / 2, o.l + o.w];
            const oy = [o.t, o.t + o.h / 2, o.t + o.h];
            xs.forEach((a) => ox.forEach((b) => {
                const diff = b - a;
                if (Math.abs(diff) < th && (!bx || Math.abs(diff) < Math.abs(bx.diff))) bx = { diff, at: b, o };
            }));
            ys.forEach((a) => oy.forEach((b) => {
                const diff = b - a;
                if (Math.abs(diff) < th && (!by || Math.abs(diff) < Math.abs(by.diff))) by = { diff, at: b, o };
            }));
        });
        let path = "";
        if (bx) {
            tx += bx.diff;
            const y0 = Math.min(t + (by ? by.diff : 0), bx.o.t) - 16;
            const y1 = Math.max(t + (by ? by.diff : 0) + g.h, bx.o.t + bx.o.h) + 16;
            path += `M${bx.at},${y0} V${y1} `;
        }
        if (by) {
            ty += by.diff;
            const x0 = Math.min(d.left + tx, by.o.l) - 16;
            const x1 = Math.max(d.left + tx + g.w, by.o.l + by.o.w) + 16;
            path += `M${x0},${by.at} H${x1}`;
        }
        return [tx, ty, path];
    }

    // held cards trail the pointer a touch and tilt with their speed, then
    // settle where you let go; the rest of a selection rides along
    function followCard(d) {
        const ids = [d.cardId, ...d.group.map((m) => m.id)];
        const step = () => {
            const k = reduceMotion ? 1 : 0.42;
            const px = d.cx;
            d.cx += (d.tx - d.cx) * k;
            d.cy += (d.ty - d.cy) * k;
            const tiltTo = reduceMotion ? 0 : clamp(-10, 10, (d.cx - px) * 0.55);
            d.tilt += (tiltTo - d.tilt) * 0.3;
            const tr = `${d.cx.toFixed(2)}px ${d.cy.toFixed(2)}px`;
            d.el.style.translate = tr;
            d.el.style.setProperty("--tilt", `${d.tilt.toFixed(2)}deg`);
            const g = geo.get(d.cardId);
            if (g) {
                g.l = d.left + d.cx;
                g.t = d.top + d.cy;
                g.r = d.tilt;
            }
            d.group.forEach((m) => {
                if (m.el) m.el.style.translate = tr;
                const mg = geo.get(m.id);
                if (mg) {
                    mg.l = m.left + d.cx;
                    mg.t = m.top + d.cy;
                }
            });
            if (d.guide !== d.drawnGuide) {
                d.drawnGuide = d.guide;
                guides.setAttribute("d", d.guide || "");
            }
            drawStrings(ids);
            if (d.released && Math.abs(d.tx - d.cx) < 0.25 && Math.abs(d.ty - d.cy) < 0.25 && Math.abs(d.tilt) < 0.15) return finishCard(d);
            d.raf = requestAnimationFrame(step);
        };
        d.raf = requestAnimationFrame(step);
    }

    function finishCard(d) {
        cancelAnimationFrame(d.raf);
        clearTimeout(d.lp);
        guides.removeAttribute("d");
        const all = [{ id: d.cardId, el: d.el, left: d.left, top: d.top }, ...d.group];
        all.forEach((m) => {
            const x = pinBy(m.id);
            if (m.el) {
                m.el.style.left = `${m.left + d.tx}px`;
                m.el.style.top = `${m.top + d.ty}px`;
                m.el.style.translate = "";
                m.el.style.removeProperty("--tilt");
                m.el.classList.remove("is-held", "is-carried");
            }
            const g = geo.get(m.id);
            if (g) {
                g.l = m.left + d.tx;
                g.t = m.top + d.ty;
                g.r = x?.r || 0;
            }
        });
        if (!d.moved) return drawStrings(all.map((m) => m.id));
        checkpoint(d.snap);
        all.forEach((m) => {
            const x = pinBy(m.id);
            if (!x) return;
            x.bx = m.left + d.tx;
            x.by = m.top + d.ty;
        });
        save();
    }

    function cancelDrag() {
        if (!drag) return;
        const d = drag;
        drag = null;
        clearTimeout(d.lp);
        area.classList.remove("is-panning", "is-threading");
        tempPath.removeAttribute("d");
        marquee.hidden = true;
        d.target?.classList.remove("is-target");
        if (d.kind === "card") d.released = true;
        if (d.kind === "frame" || d.kind === "resize") commitFrame(d);
    }

    const worldAt = (cx, cy) => {
        const r = area.getBoundingClientRect();
        return [(cx - r.left - view.x) / view.z, (cy - r.top - view.y) / view.z];
    };

    area.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".pb-pop, .pb-tray, .pb-find, .pb-linkbox, .pb-selbar, .pb-minimap")) return;
        closePop(false);
        if (e.pointerType === "touch") {
            touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (touches.size === 2) {
                cancelDrag();
                area.setPointerCapture(e.pointerId);
                const g = pinchGeom();
                const r = area.getBoundingClientRect();
                stopCam();
                drag = { kind: "pinch", d0: Math.max(1, g.d), z0: view.z, wx: (g.x - r.left - view.x) / view.z, wy: (g.y - r.top - view.y) / view.z };
                return;
            }
            if (touches.size > 2) return;
        }
        if (e.button !== 0 || drag) return;
        if (e.target.closest(".pb-thread, .pb-knot")) return;
        const card = e.target.closest(".pb-card");
        const frame = e.target.closest(".pb-frame");
        const touch = e.pointerType === "touch";

        // view-only on a touch screen: a long press still opens the card's menu (to comment
        // on it); the finger can pan the board as usual meanwhile
        if (card && readonly && touch && window.comments?.available?.() && !e.target.closest("button, a")) {
            const id = card.dataset.id;
            const [sx, sy] = [e.clientX, e.clientY];
            const evs = ["pointermove", "pointerup", "pointercancel"];
            const off = () => evs.forEach((t) => removeEventListener(t, cancel, true));
            const cancel = (ev) => {
                if (ev.type === "pointermove" && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 10) return;
                clearTimeout(t);
                off();
            };
            const t = setTimeout(() => {
                off();
                armSheet();
                cardMenu(id, [sx, sy], true);
            }, LONG_PRESS);
            evs.forEach((ev) => addEventListener(ev, cancel, true));
        }

        if (card && !readonly) {
            const id = card.dataset.id;
            // second half of "tie a thread from here" (menu, keyboard or touch)
            if (threadFrom) {
                e.preventDefault();
                return finishThreadTo(id);
            }
            if (e.target.closest(".pb-pin")) {
                e.preventDefault();
                area.setPointerCapture(e.pointerId);
                area.classList.add("is-threading");
                drag = { kind: "thread", from: id, id: e.pointerId, target: null };
                return threadMove(e.clientX, e.clientY);
            }
            if (e.target.closest("textarea, button, a")) return;
            e.preventDefault();
            if (e.shiftKey || e.metaKey || e.ctrlKey) {
                if (sel.has(id)) sel.delete(id);
                else sel.add(id);
                return syncSel();
            }
            if (card.classList.contains("is-held")) return; // still settling from the last drop
            if (!sel.has(id)) setSel([id]);
            card.focus({ preventScroll: true });
            card.setPointerCapture(e.pointerId);
            card.style.zIndex = ++top;
            card.classList.add("is-held");
            const g = geo.get(id);
            const group = [...sel]
                .filter((o) => o !== id && geo.get(o))
                .map((o) => {
                    const oel = cardEl(o);
                    oel?.classList.add("is-carried");
                    return { id: o, el: oel, left: geo.get(o).l, top: geo.get(o).t };
                });
            drag = {
                kind: "card",
                el: card,
                cardId: id,
                group,
                moving: new Set([id, ...group.map((m) => m.id)]),
                id: e.pointerId,
                sx: e.clientX,
                sy: e.clientY,
                left: g ? g.l : card.offsetLeft,
                top: g ? g.t : card.offsetTop,
                cx: 0,
                cy: 0,
                tx: 0,
                ty: 0,
                tilt: 0,
                guide: "",
                snap: snapshot(),
                moved: false,
                released: false,
            };
            const d = drag;
            if (touch)
                d.lp = setTimeout(() => {
                    if (drag !== d || d.far) return;
                    drag = null;
                    d.moved = false;
                    d.tx = d.ty = 0;
                    d.released = true;
                    armSheet();
                    cardMenu(id, [d.sx, d.sy], true);
                }, LONG_PRESS);
            return followCard(d);
        }
        if (frame && !readonly) {
            const f = frameBy(frame.dataset.id);
            if (f && e.target.closest(".pb-frame-handle")) {
                e.preventDefault();
                frame.setPointerCapture(e.pointerId);
                drag = { kind: "resize", f, el: frame, id: e.pointerId, sx: e.clientX, sy: e.clientY, w: f.w, h: f.h, snap: snapshot(), moved: false };
                return;
            }
            if (e.target.closest("input, .pb-frame-del")) return;
            if (f && e.target.closest(".pb-frame-bar")) {
                e.preventDefault();
                frame.setPointerCapture(e.pointerId);
                frame.classList.add("is-held");
                const members = membersOf(f).map((id) => ({ id, el: cardEl(id), left: geo.get(id).l, top: geo.get(id).t }));
                drag = { kind: "frame", f, el: frame, members, id: e.pointerId, sx: e.clientX, sy: e.clientY, x: f.x, y: f.y, snap: snapshot(), moved: false };
                return;
            }
        }
        if (e.target.closest("a, button, input, textarea, select")) return;
        e.preventDefault();
        area.focus({ preventScroll: true });
        area.setPointerCapture(e.pointerId);
        if (threadFrom) cancelThreadFrom();

        // shift + drag on empty space draws a selection box
        if (e.shiftKey && !readonly && !touch) {
            const r = area.getBoundingClientRect();
            drag = { kind: "marquee", id: e.pointerId, sx: e.clientX, sy: e.clientY, r, base: new Set(sel) };
            return;
        }
        if (!e.shiftKey) clearSel();
        area.classList.add("is-panning");
        stopCam();
        drag = { kind: "pan", id: e.pointerId, sx: e.clientX, sy: e.clientY, x: view.x, y: view.y, samples: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }] };
        const d = drag;
        if (touch && !readonly)
            d.lp = setTimeout(() => {
                if (drag !== d || d.far) return;
                drag = null;
                area.classList.remove("is-panning");
                armSheet();
                areaMenu([d.sx, d.sy], true);
            }, LONG_PRESS);
    });

    function threadMove(cx, cy) {
        if (!drag || drag.kind !== "thread") return;
        const a = pinPoint(drag.from);
        const b = worldAt(cx, cy);
        if (a) tempPath.setAttribute("d", stringPath(a, b));
        const over = document.elementFromPoint(cx, cy)?.closest(".pb-card");
        const target = over && over.dataset.id !== drag.from ? over : null;
        if (target !== drag.target) {
            drag.target?.classList.remove("is-target");
            if (drag.target) headFor(drag.target.dataset.id)?.classList.remove("is-target");
            target?.classList.add("is-target");
            if (target) headFor(target.dataset.id)?.classList.add("is-target");
            drag.target = target;
        }
    }

    // the drawn head covers the real pin: mirror its hover growth
    area.addEventListener("pointerover", (e) => {
        const pin = e.target.closest?.(".pb-pin");
        if (pin) headFor(pin.closest(".pb-card")?.dataset.id)?.classList.add("is-hover");
    });
    area.addEventListener("pointerout", (e) => {
        const pin = e.target.closest?.(".pb-pin");
        if (pin) headFor(pin.closest(".pb-card")?.dataset.id)?.classList.remove("is-hover");
    });

    area.addEventListener("pointermove", (e) => {
        if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const d = drag;
        if (!d) return;
        if (d.kind === "pinch") {
            if (touches.size < 2) return;
            return onFrame(() => {
                if (drag !== d || touches.size < 2) return;
                const g = pinchGeom();
                const r = area.getBoundingClientRect();
                const z = clampZ((d.z0 * g.d) / d.d0);
                setViewNow(g.x - r.left - d.wx * z, g.y - r.top - d.wy * z, z);
            });
        }
        if (e.pointerId !== d.id) return;
        const cx = e.clientX;
        const cy = e.clientY;
        if (!d.far && Math.hypot(cx - d.sx, cy - d.sy) > 8) {
            d.far = true;
            clearTimeout(d.lp);
        }
        if (d.kind === "thread") return onFrame(() => threadMove(cx, cy));
        if (d.kind === "pan") {
            d.samples.push({ t: e.timeStamp, x: cx, y: cy });
            if (d.samples.length > 6) d.samples.shift();
            return onFrame(() => drag === d && setViewNow(d.x + cx - d.sx, d.y + cy - d.sy));
        }
        if (d.kind === "marquee") {
            return onFrame(() => {
                if (drag !== d) return;
                const l = Math.min(cx, d.sx) - d.r.left;
                const t = Math.min(cy, d.sy) - d.r.top;
                const w = Math.abs(cx - d.sx);
                const h = Math.abs(cy - d.sy);
                marquee.hidden = false;
                marquee.style.transform = `translate(${l}px, ${t}px)`;
                marquee.style.width = `${w}px`;
                marquee.style.height = `${h}px`;
                const [wl, wt] = worldAt(Math.min(cx, d.sx), Math.min(cy, d.sy));
                const [wr, wb] = worldAt(Math.max(cx, d.sx), Math.max(cy, d.sy));
                sel.clear();
                d.base.forEach((id) => sel.add(id));
                geo.forEach((g, id) => {
                    if (g.l < wr && g.l + g.w > wl && g.t < wb && g.t + g.h > wt) sel.add(id);
                });
                syncSel();
            });
        }
        const dx = (cx - d.sx) / view.z;
        const dy = (cy - d.sy) / view.z;
        if (Math.abs(dx) + Math.abs(dy) > 1) d.moved = true;
        if (d.kind === "card") {
            d.noSnap = e.altKey;
            [d.tx, d.ty, d.guide] = snapTo(d, dx, dy);
            return;
        }
        onFrame(() => {
            if (drag !== d) return;
            if (d.kind === "frame") {
                d.el.style.left = `${d.x + dx}px`;
                d.el.style.top = `${d.y + dy}px`;
                d.members.forEach((m) => {
                    if (!m.el) return;
                    m.el.style.left = `${m.left + dx}px`;
                    m.el.style.top = `${m.top + dy}px`;
                    const g = geo.get(m.id);
                    if (g) {
                        g.l = m.left + dx;
                        g.t = m.top + dy;
                    }
                });
                d.dx = dx;
                d.dy = dy;
                drawStrings(d.members.map((m) => m.id));
            } else if (d.kind === "resize") {
                d.el.style.width = `${Math.max(200, d.w + dx)}px`;
                d.el.style.height = `${Math.max(140, d.h + dy)}px`;
            }
        });
    });

    function commitFrame(d) {
        d.el.classList.remove("is-held");
        if (!d.moved) return;
        checkpoint(d.snap);
        const f = frameBy(d.f.id);
        if (!f) return;
        if (d.kind === "resize") {
            f.w = d.el.offsetWidth;
            f.h = d.el.offsetHeight;
        } else {
            f.x = d.x + (d.dx || 0);
            f.y = d.y + (d.dy || 0);
            d.members.forEach((m) => {
                const x = pinBy(m.id);
                if (!x) return;
                x.bx = m.left + (d.dx || 0);
                x.by = m.top + (d.dy || 0);
            });
        }
        save();
    }

    function endDrag(e) {
        touches.delete(e.pointerId);
        if (!drag) return;
        if (drag.kind === "pinch") {
            if (touches.size < 2) drag = null;
            return;
        }
        if (e.pointerId !== drag.id) return;
        const d = drag;
        drag = null;
        clearTimeout(d.lp);
        if (d.kind === "marquee") {
            marquee.hidden = true;
            if (sel.size) announce(`${sel.size} selected`);
            return;
        }
        if (d.kind === "pan") {
            area.classList.remove("is-panning");
            // flick: carry the release velocity into a glide
            const s = d.samples;
            const last = s[s.length - 1];
            const first = s.find((p) => last.t - p.t < 90) || s[0];
            const dt = last.t - first.t;
            if (dt > 0 && e.timeStamp - last.t < 60 && !reduceMotion) {
                const vx = (last.x - first.x) / dt;
                const vy = (last.y - first.y) / dt;
                panBy(clamp(-1400, 1400, vx * 170), clamp(-1400, 1400, vy * 170));
            }
            return;
        }
        if (d.kind === "thread") {
            area.classList.remove("is-threading");
            tempPath.removeAttribute("d");
            d.target?.classList.remove("is-target");
            headsLayer.querySelectorAll(".is-target").forEach((c) => c.classList.remove("is-target"));
            const to = d.target?.dataset.id;
            if (e.type === "pointerup" && to && addThread(d.from, to)) {
                announce(`Thread tied between ${nameOf(d.from)} and ${nameOf(to)}`);
                const te = threadEls.get(tkey(d.from, to));
                if (te && !reduceMotion) {
                    const [, shadow, line] = te.paths;
                    const len = line.getTotalLength();
                    gsap.fromTo(
                        [shadow, line],
                        { strokeDasharray: len, strokeDashoffset: len },
                        { strokeDashoffset: 0, duration: 0.6, ease: "power2.out", clearProps: "strokeDasharray,strokeDashoffset" }
                    );
                }
            }
            return;
        }
        if (d.kind === "card") {
            d.released = true;
            return;
        }
        commitFrame(d);
    }
    area.addEventListener("pointerup", endDrag);
    area.addEventListener("pointercancel", endDrag);

    // keep keyboard focus on screen
    area.addEventListener("focusin", (e) => {
        const card = e.target.closest(".pb-card");
        const frame = e.target.closest(".pb-frame");
        const g = card && geo.get(card.dataset.id);
        if (g) reveal(g.l, g.t - 12, g.w, g.h + 12);
        else if (frame) reveal(frame.offsetLeft, frame.offsetTop, Math.min(frame.offsetWidth, 400), 60);
    });

    /* ---------- keyboard ---------- */
    let lastKeyMove = 0;
    function keyMove(list, dx, dy, frameId) {
        const now = performance.now();
        if (now - lastKeyMove > 800) checkpoint();
        lastKeyMove = now;
        if (frameId) {
            const f = frameBy(frameId);
            if (!f) return;
            list = membersOf(f);
            f.x += dx;
            f.y += dy;
        }
        list.forEach((id) => {
            const x = pinBy(id);
            if (!x) return;
            x.bx += dx;
            x.by += dy;
        });
        save();
    }

    const accountDlg = q("#acct");
    document.addEventListener(
        "keydown",
        (e) => {
            if (board.hidden || !lightbox.hidden) return;
            // the account dialog (cloud.js) owns the keyboard while it's open
            if (accountDlg && !accountDlg.hidden) return;
            const handled = () => {
                e.preventDefault();
                e.stopImmediatePropagation();
            };
            // open menus and the board picker own the keyboard
            if (openMenu) {
                if (menuKeys(e)) e.stopImmediatePropagation();
                return;
            }
            if (pickOpen) {
                if (e.key === "Escape") {
                    handled();
                    closePicker(true);
                }
                return;
            }
            const ae = document.activeElement;
            const typing = /INPUT|TEXTAREA|SELECT/.test(ae?.tagName) || ae?.isContentEditable;
            const mod = e.ctrlKey || e.metaKey;
            const key = e.key.toLowerCase();

            if (e.key === "Escape") {
                handled();
                if (!palette.hidden) return closePalette(true);
                if (!linkbox.hidden && linkbox.contains(ae)) return closeLinkbox(true);
                if (!find.hidden && find.contains(ae)) return closeFind(true);
                if (popKey) return closePop(true);
                if (cancelThreadFrom()) return announce("Thread cancelled");
                if (typing) return ae.blur();
                if (!tray.hidden) return closeTray(true);
                if (clearSel()) return announce("Selection cleared");
                if (closeFind(false)) return;
                return closeBoard();
            }
            if (mod && key === "f") {
                handled();
                return openFind();
            }
            if (typing) return;
            if (mod && key === "z") {
                handled();
                return e.shiftKey ? redo() : undo();
            }
            if (mod && key === "y") {
                handled();
                return redo();
            }
            if (mod && key === "a" && !readonly) {
                handled();
                setSel(B.pins.map((x) => x.id));
                return announce(`${sel.size} selected`);
            }
            if (mod || e.altKey) return;

            const card = ae?.classList?.contains("pb-card") ? ae : null;
            const grip = ae?.classList?.contains("pb-frame-grip") ? ae : null;
            const knot = ae?.classList?.contains("pb-knot") ? ae : null;
            const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

            if (arrows[e.key] && !readonly && (card || grip || (sel.size && ae === area))) {
                handled();
                const step = e.shiftKey ? 60 : 12;
                const [ax, ay] = arrows[e.key];
                if (grip) return keyMove([], ax * step, ay * step, grip.closest(".pb-frame").dataset.id);
                const list = card && !sel.has(card.dataset.id) ? [card.dataset.id] : [...sel];
                return keyMove(list.length ? list : [card.dataset.id], ax * step, ay * step);
            }
            if ((e.key === "Delete" || e.key === "Backspace") && !readonly) {
                if (knot) {
                    handled();
                    cutThread(knot.dataset.k);
                    return area.focus({ preventScroll: true });
                }
                const list = sel.size && (!card || sel.has(card.dataset.id)) ? [...sel] : card ? [card.dataset.id] : [];
                if (list.length) {
                    handled();
                    const all = cards();
                    const next = card && all[all.indexOf(card) + 1];
                    removeWithNote(list);
                    return (next && document.contains(next) ? next : area).focus({ preventScroll: true });
                }
            }
            if (card && !readonly && (key === "t" || (e.key === "Enter" && threadFrom))) {
                handled();
                return threadFrom ? finishThreadTo(card.dataset.id) : startThreadFrom(card.dataset.id);
            }
            if (card && e.key === "Enter" && !readonly) {
                handled();
                return card.querySelector(".pb-note")?.focus();
            }
            const k = {
                "+": () => zoomAt(goal.z * 1.25),
                "=": () => zoomAt(goal.z * 1.25),
                "-": () => zoomAt(goal.z / 1.25),
                _: () => zoomAt(goal.z / 1.25),
                0: () => zoomAt(1),
                f: () => fit(true),
                "/": openFind,
                m: toggleMinimap,
                // comments on the focused card, or on the board (#20)
                ...(window.comments?.available?.() ? { c: () => window.comments.open(card ? card.dataset.id : undefined) } : {}),
            };
            const edit = {
                g: () => (sel.size > 1 ? frameAround([...sel]) : newFrame()),
                n: () => addNote(),
                u: () => pickFiles(),
                l: () => openLinkbox(),
                w: () => (tray.hidden ? openTray() : closeTray(true)),
            };
            const fn = k[e.key] || k[key] || (!readonly && edit[key]);
            if (fn) {
                handled();
                fn();
            }
        },
        true
    );

    /* ---------- adding things: uploads, notes, links, the wall tray ---------- */
    const viewCenter = () => {
        const r = area.getBoundingClientRect();
        return [r.left + r.width / 2, r.top + r.height / 2];
    };

    let pickAt = null;
    function pickFiles(at) {
        if (readonly) return;
        pickAt = at || null;
        fileInput.click();
    }
    fileInput.addEventListener("change", () => {
        const files = [...(fileInput.files || [])];
        fileInput.value = "";
        if (files.length) addUploads(files, pickAt);
    });

    async function addUploads(files, at) {
        if (readonly) return;
        files = [...files].filter((f) => f && /^image\//.test(f.type));
        if (!files.length) return toast("Only images can be added to a board", "warn");
        if (!window.media?.available) return toast("This browser can't store images, so uploads aren't available", "warn");
        const [wx, wy] = worldAt(...(at || viewCenter()));
        toast(files.length > 1 ? `Adding ${files.length} images…` : "Adding image…");
        window.media.persist();
        const made = [];
        for (const [i, f] of files.slice(0, 60).entries()) {
            try {
                const { blob, w, h, color } = await window.media.processImage(f);
                const id = newId("u");
                await window.media.put(id, blob);
                made.push(
                    cleanItem({
                        id,
                        kind: "upload",
                        media: { w, h, color, name: (f.name || "image").replace(/\.[a-z0-9]{2,5}$/i, "") },
                        bx: wx - CARD_W / 2 + i * 26,
                        by: wy - CARD_H / 2 + i * 26,
                        r: rnd(),
                        at: Date.now(),
                    })
                );
            } catch (err) {
                const quota = err?.name === "QuotaExceededError";
                toast(quota ? "Image storage is full — remove some uploads first" : `${f.name}: ${err.message || "couldn't be added"}`, "warn");
                if (quota || !/image|MB/.test(err?.message || "")) window.reportProblem?.("upload failed", err);
                if (quota) break;
            }
        }
        try {
            localStorage.setItem(MEDIA_LAST, String(Date.now()));
        } catch (e) {}
        const added = insertItems(made);
        if (!added.length) return;
        setSel(added);
        toast(added.length > 1 ? `Added ${added.length} images` : "Image added");
        if (!reduceMotion) added.forEach((id) => cardEl(id) && gsap.from(cardEl(id), { scale: 0.85, duration: 0.6, ease: "back.out(2)" }));
    }

    // a link becomes an image card if it loads as an image, otherwise a bookmark
    async function addLink(raw, at) {
        if (readonly) return;
        const href = safeUrl(raw);
        if (!href) return toast("That doesn't look like a web address (it should start with https://)", "warn");
        const [wx, wy] = worldAt(...(at || viewCenter()));
        let src = null;
        let w = 0;
        let h = 0;
        if (href.startsWith("https:")) {
            const img = await window.media?.loadImage(href, false);
            if (img) {
                src = href;
                w = img.naturalWidth;
                h = img.naturalHeight;
            }
        }
        const u = new URL(href);
        let title;
        try {
            title = src ? decodeURIComponent(u.pathname.split("/").pop() || u.hostname) : `${u.hostname.replace(/^www\./, "")}${u.pathname !== "/" ? decodeURIComponent(u.pathname) : ""}`;
        } catch (e) {
            title = u.hostname;
        }
        const x = cleanItem({ id: newId("l"), kind: "link", media: { href, src, title, w, h }, bx: wx - CARD_W / 2, by: wy - (src ? CARD_H : 180) / 2, r: rnd(), at: Date.now() });
        const added = insertItems([x]);
        if (added.length) {
            setSel(added);
            toast(src ? "Image added from link" : "Link added");
        }
    }

    function addNote(at, text = "") {
        if (readonly) return;
        const [wx, wy] = worldAt(...(at || viewCenter()));
        const x = cleanItem({ id: newId("n"), kind: "note", note: text, tint: "sun", bx: wx - CARD_W / 2, by: wy - 100, r: rnd() / 2, at: Date.now() });
        const added = insertItems([x]);
        if (!added.length) return;
        setSel(added);
        requestAnimationFrame(() => cardEl(added[0])?.querySelector("textarea")?.focus({ preventScroll: true }));
    }

    /* link box */
    let linkAt = null;
    function openLinkbox(at) {
        if (readonly) return;
        linkAt = at || null;
        linkbox.hidden = false;
        linkInput.value = "";
        linkInput.focus({ preventScroll: true });
        if (!reduceMotion) gsap.fromTo(linkbox, { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 0.3, ease: "expo.out" });
    }
    function closeLinkbox(refocus) {
        if (linkbox.hidden) return false;
        linkbox.hidden = true;
        if (refocus) area.focus({ preventScroll: true });
        return true;
    }
    function submitLink() {
        const v = linkInput.value.trim();
        if (!v) return;
        closeLinkbox(true);
        addLink(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`, linkAt);
    }
    linkInput.addEventListener("keydown", (e) => e.key === "Enter" && (e.preventDefault(), submitLink()));
    q("#pb-link-add").addEventListener("click", submitLink);
    q("#pb-link-cancel").addEventListener("click", () => closeLinkbox(true));

    /* Add menu */
    addBtn.addEventListener("click", () => (openMenu?.el === addMenu ? closeMenu(true) : showMenu(addMenu, { btn: addBtn })));
    addMenu.addEventListener("click", (e) => {
        const b = e.target.closest("[data-add]");
        if (!b) return;
        closeMenu(false);
        ({ image: () => pickFiles(), note: () => addNote(), link: () => openLinkbox(), wall: openTray })[b.dataset.add]?.();
    });

    /* drop files / links / images from other tabs */
    let dropDepth = 0;
    const dropKinds = (dt) => [...(dt?.types || [])].some((t) => t === "Files" || t === "text/uri-list" || t === "text/plain" || t === "text/html");
    area.addEventListener("dragenter", (e) => {
        if (readonly || !dropKinds(e.dataTransfer) || trayDrag) return;
        e.preventDefault();
        dropDepth++;
        dropHint.hidden = false;
    });
    area.addEventListener("dragover", (e) => {
        if (readonly || !dropKinds(e.dataTransfer) || trayDrag) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
    });
    area.addEventListener("dragleave", () => {
        dropDepth = Math.max(0, dropDepth - 1);
        if (!dropDepth) dropHint.hidden = true;
    });
    area.addEventListener("drop", (e) => {
        if (readonly || !e.dataTransfer) return;
        e.preventDefault();
        dropDepth = 0;
        dropHint.hidden = true;
        const at = [e.clientX, e.clientY];
        const files = [...(e.dataTransfer.files || [])];
        if (files.length) return addUploads(files, at);
        // an image dragged from another page: prefer its src over the page link
        const html = e.dataTransfer.getData("text/html");
        const imgSrc = html && /<img[^>]+src=["']([^"']+)["']/i.exec(html)?.[1];
        const uri = (e.dataTransfer.getData("text/uri-list") || "").split(/\r?\n/).find((l) => l && !l.startsWith("#"));
        const text = e.dataTransfer.getData("text/plain");
        const link = (imgSrc && safeUrl(imgSrc, true)) || uri || (safeUrl(text) ? text : null);
        if (link) return addLink(link, at);
        if (text?.trim()) addNote(at, text.trim().slice(0, 1000));
    });

    /* paste: images, links, or text as a note */
    document.addEventListener("paste", (e) => {
        if (board.hidden || readonly || !lightbox.hidden) return;
        const ae = document.activeElement;
        if (/INPUT|TEXTAREA/.test(ae?.tagName)) return;
        const dt = e.clipboardData;
        if (!dt) return;
        const files = [...(dt.files || [])].filter((f) => /^image\//.test(f.type));
        if (files.length) {
            e.preventDefault();
            return addUploads(files);
        }
        const text = (dt.getData("text/plain") || "").trim();
        if (!text) return;
        e.preventDefault();
        if (/^https?:\/\/\S+$/i.test(text)) addLink(text);
        else addNote(undefined, text.slice(0, 1000));
    });

    /* ---------- tray: photos from the wall ---------- */
    let trayDrag = null;
    function openTray() {
        if (readonly) return;
        buildTray();
        tray.hidden = false;
        q("#pb-tray-close").focus({ preventScroll: true });
        if (!reduceMotion) gsap.fromTo(tray, { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: "expo.out" });
    }
    function closeTray(refocus) {
        if (tray.hidden) return false;
        tray.hidden = true;
        if (refocus) area.focus({ preventScroll: true });
        return true;
    }
    q("#pb-tray-close").addEventListener("click", () => closeTray(true));

    function buildTray() {
        trayList.textContent = "";
        const list = state.photos.slice(0, 150);
        if (!list.length) {
            trayList.appendChild(mk("li", "pb-tray-empty", "Nothing on the wall yet — search for something first."));
            return;
        }
        list.forEach((p) => {
            const li = mk("li");
            const b = mk("button", "pb-tray-item");
            b.type = "button";
            b.dataset.id = p.id;
            b.dataset.cursor = "Add";
            b.setAttribute("aria-label", `Add photo by ${p.user?.name || "Unknown"} to the board`);
            b.style.setProperty("--c", hexOr(p.color, "#222222"));
            const img = mk("img");
            img.alt = "";
            img.loading = "lazy";
            img.draggable = false;
            img.src = `${p.urls.raw}&w=160&h=200&fit=crop&crop=entropy&q=60&auto=format`;
            b.appendChild(img);
            li.appendChild(b);
            trayList.appendChild(li);
        });
        syncTray();
    }

    function syncTray() {
        if (tray.hidden) return;
        qa(".pb-tray-item", trayList).forEach((b) => {
            const on = has(b.dataset.id);
            b.classList.toggle("is-pinned", on);
            b.setAttribute("aria-pressed", on);
        });
    }

    const photoById = (id) => state.photos.find((p) => p.id === id);

    function addFromTray(id, at) {
        const p = photoById(id);
        if (!p) return;
        if (has(id)) {
            const g = geo.get(id);
            if (g) flyTo(g.l + g.w / 2, g.t + g.h / 2);
            return announce("Already on the board");
        }
        const [wx, wy] = worldAt(...(at || viewCenter()));
        add(p, { x: wx - CARD_W / 2, y: wy - CARD_H / 2 });
        setSel([id]);
        announce(`Added photo by ${p.user?.name || "Unknown"}`);
    }

    trayList.addEventListener("pointerdown", (e) => {
        const b = e.target.closest(".pb-tray-item");
        if (!b || e.button !== 0) return;
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        trayDrag = { b, id: b.dataset.id, pid: e.pointerId, sx: e.clientX, sy: e.clientY, ghost: null };
    });
    trayList.addEventListener("pointermove", (e) => {
        const d = trayDrag;
        if (!d || e.pointerId !== d.pid) return;
        if (!d.ghost && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 6) {
            d.ghost = mk("div", "pb-ghost");
            d.ghost.style.backgroundImage = `url("${d.b.querySelector("img").src}")`;
            document.body.appendChild(d.ghost);
            area.classList.add("is-dropping");
        }
        if (d.ghost) {
            const x = e.clientX;
            const y = e.clientY;
            onFrame(() => d.ghost && (d.ghost.style.transform = `translate(${x - 40}px, ${y - 50}px) rotate(-4deg)`));
        }
    });
    function endTray(e) {
        const d = trayDrag;
        if (!d || e.pointerId !== d.pid) return;
        trayDrag = null;
        area.classList.remove("is-dropping");
        if (!d.ghost) return addFromTray(d.id); // a click
        d.ghost.remove();
        const r = area.getBoundingClientRect();
        const tr = tray.getBoundingClientRect();
        const inArea = e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom;
        const inTray = e.clientY > tr.top && e.clientX > tr.left && e.clientX < tr.right;
        if (e.type === "pointerup" && inArea && !inTray) addFromTray(d.id, [e.clientX, e.clientY]);
    }
    trayList.addEventListener("pointerup", endTray);
    trayList.addEventListener("pointercancel", endTray);
    trayList.addEventListener("keydown", (e) => {
        const b = e.target.closest(".pb-tray-item");
        if (b && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            addFromTray(b.dataset.id);
        }
    });

    /* ---------- find on the board ---------- */
    let finds = [];
    let findIdx = -1;
    let findT = 0;

    function flyTo(wx, wy, z = Math.max(goal.z, 0.75)) {
        z = clampZ(z);
        goTo({ z, x: area.clientWidth / 2 - wx * z, y: area.clientHeight / 2 - wy * z }, true);
    }

    const matchEl = (m) => (m.type === "card" ? cardEl(m.id) : m.type === "frame" ? frameEl(m.id) : knotEl(m.id));

    function clearFindMarks() {
        qa(".is-match, .is-hit", world).forEach((n) => n.classList.remove("is-match", "is-hit"));
    }

    function openFind() {
        find.hidden = false;
        findInput.focus({ preventScroll: true });
        findInput.select();
        if (!reduceMotion) gsap.fromTo(find, { opacity: 0, y: -10 }, { opacity: 1, y: 0, duration: 0.3, ease: "expo.out" });
        if (findInput.value) runFind();
    }

    function closeFind(refocus) {
        if (find.hidden) return false;
        find.hidden = true;
        clearFindMarks();
        finds = [];
        if (refocus) area.focus({ preventScroll: true });
        return true;
    }

    function runFind() {
        clearFindMarks();
        const qv = findInput.value.trim().toLowerCase();
        finds = [];
        if (qv) {
            B.pins.forEach((x) => {
                const hay = [x.note, labelOf(x), x.query, x.photo?.alt_description, x.photo?.description, x.media?.title, x.media?.href, x.media?.name].join(" ").toLowerCase();
                if (hay.includes(qv)) finds.push({ type: "card", id: x.id });
            });
            B.frames.forEach((f) => f.title.toLowerCase().includes(qv) && finds.push({ type: "frame", id: f.id }));
            B.threads.forEach((t) => t.label.toLowerCase().includes(qv) && finds.push({ type: "thread", id: tkey(t.a, t.b) }));
        }
        finds.forEach((m) => matchEl(m)?.classList.add("is-match"));
        findCount.textContent = finds.length ? `1/${finds.length}` : qv ? "0/0" : "";
        findIdx = -1;
        if (finds.length) goFind(0);
        else if (qv) announce("No matches");
    }

    function goFind(i) {
        if (!finds.length) return;
        findIdx = (i + finds.length) % finds.length;
        findCount.textContent = `${findIdx + 1}/${finds.length}`;
        qa(".is-hit", world).forEach((n) => n.classList.remove("is-hit"));
        const m = finds[findIdx];
        matchEl(m)?.classList.add("is-hit");
        let p = null;
        if (m.type === "card") {
            const g = geo.get(m.id);
            if (g) p = [g.l + g.w / 2, g.t + g.h / 2];
        } else if (m.type === "frame") {
            const f = frameBy(m.id);
            if (f) p = [f.x + f.w / 2, f.y + f.h / 2];
        } else p = knotPoint(threadBy(m.id));
        if (p) flyTo(p[0], p[1]);
        announce(`Match ${findIdx + 1} of ${finds.length}`);
    }

    findInput.addEventListener("input", () => {
        clearTimeout(findT);
        findT = setTimeout(runFind, 140);
    });
    findInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            if (findIdx < 0) runFind();
            else goFind(findIdx + (e.shiftKey ? -1 : 1));
        }
    });
    q("#pb-find-next").addEventListener("click", () => goFind(findIdx + 1));
    q("#pb-find-prev").addEventListener("click", () => goFind(findIdx - 1));
    q("#pb-find-close").addEventListener("click", () => closeFind(true));
    findBtn.addEventListener("click", () => (find.hidden ? openFind() : closeFind(true)));

    /* ---------- minimap ---------- */
    const MM_W = 200;
    const MM_H = 128;
    let mmOn = true;
    try {
        mmOn = localStorage.getItem("aperture:minimap") !== "off";
    } catch (e) {}
    let mmQueued = false;
    let mm = null; // last mapping { s, ox, oy }

    function scheduleMinimap() {
        if (mmQueued || board.hidden) return;
        mmQueued = true;
        requestAnimationFrame(drawMinimap);
    }

    function toggleMinimap() {
        mmOn = !mmOn;
        try {
            localStorage.setItem("aperture:minimap", mmOn ? "on" : "off");
        } catch (e) {}
        announce(mmOn ? "Minimap shown" : "Minimap hidden");
        scheduleMinimap();
    }

    function drawMinimap() {
        mmQueued = false;
        const box = contentBox();
        const show = mmOn && !!box && !board.hidden;
        minimap.hidden = !show;
        if (!show) return;
        const dpr = Math.min(devicePixelRatio || 1, 2);
        if (minimap.width !== MM_W * dpr) {
            minimap.width = MM_W * dpr;
            minimap.height = MM_H * dpr;
        }
        const ctx = minimap.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, MM_W, MM_H);
        const vw = area.clientWidth;
        const vh = area.clientHeight;
        const vr = { l: -view.x / view.z, t: -view.y / view.z, r: (vw - view.x) / view.z, b: (vh - view.y) / view.z };
        const u = { l: Math.min(box.l, vr.l), t: Math.min(box.t, vr.t), r: Math.max(box.r, vr.r), b: Math.max(box.b, vr.b) };
        let s = Math.min((MM_W - 16) / (u.r - u.l), (MM_H - 16) / (u.b - u.t));
        let ox = (MM_W - (u.r - u.l) * s) / 2 - u.l * s;
        let oy = (MM_H - (u.b - u.t) * s) / 2 - u.t * s;
        // while dragging on the map, keep its scale still so it doesn't slide under the pointer
        if (mmDrag != null && mm) ({ s, ox, oy } = mm);
        mm = { s, ox, oy };
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(236, 231, 220, 0.25)";
        B.frames.forEach((f) => ctx.strokeRect(ox + f.x * s + 0.5, oy + f.y * s + 0.5, f.w * s, f.h * s));
        ctx.strokeStyle = "rgba(255, 91, 46, 0.7)";
        ctx.beginPath();
        B.threads.forEach((t) => {
            const a = pinPoint(t.a);
            const b = pinPoint(t.b);
            if (!a || !b) return;
            ctx.moveTo(ox + a[0] * s, oy + a[1] * s);
            ctx.lineTo(ox + b[0] * s, oy + b[1] * s);
        });
        ctx.stroke();
        B.pins.forEach((x) => {
            const g = geo.get(x.id);
            if (!g) return;
            ctx.fillStyle = sel.has(x.id) ? "#ff5b2e" : colorOf(x);
            ctx.fillRect(ox + g.l * s, oy + g.t * s, Math.max(2, g.w * s), Math.max(2, g.h * s));
        });
        ctx.fillStyle = "rgba(236, 231, 220, 0.06)";
        ctx.strokeStyle = "rgba(236, 231, 220, 0.85)";
        const vx = ox + vr.l * s;
        const vy = oy + vr.t * s;
        ctx.fillRect(vx, vy, (vr.r - vr.l) * s, (vr.b - vr.t) * s);
        ctx.strokeRect(vx + 0.5, vy + 0.5, (vr.r - vr.l) * s - 1, (vr.b - vr.t) * s - 1);
    }

    // click / drag on the minimap moves the view there
    let mmDrag = null;
    function mmMove(e, animate) {
        if (!mm) return;
        const r = minimap.getBoundingClientRect();
        const wx = (e.clientX - r.left - mm.ox) / mm.s;
        const wy = (e.clientY - r.top - mm.oy) / mm.s;
        const z = goal.z;
        if (animate) goTo({ z, x: area.clientWidth / 2 - wx * z, y: area.clientHeight / 2 - wy * z }, true);
        else setViewNow(area.clientWidth / 2 - wx * view.z, area.clientHeight / 2 - wy * view.z);
    }
    minimap.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        minimap.setPointerCapture(e.pointerId);
        mmDrag = e.pointerId;
        mmMove(e, true);
    });
    minimap.addEventListener("pointermove", (e) => {
        if (mmDrag !== e.pointerId) return;
        onFrame(() => mmMove(e, false));
    });
    const mmEnd = (e) => mmDrag === e.pointerId && (mmDrag = null);
    minimap.addEventListener("pointerup", mmEnd);
    minimap.addEventListener("pointercancel", mmEnd);

    /* ---------- palette ---------- */
    let palKey = "";
    let palCols = [];

    function closePalette(refocus) {
        if (palette.hidden) return false;
        palette.hidden = true;
        paletteBtn.setAttribute("aria-expanded", "false");
        if (refocus) paletteBtn.focus({ preventScroll: true });
        return true;
    }

    async function openPalette() {
        closeMenu(false);
        palette.hidden = false;
        paletteBtn.setAttribute("aria-expanded", "true");
        const r = paletteBtn.getBoundingClientRect();
        palette.style.left = `${clamp(8, Math.max(8, innerWidth - palette.offsetWidth - 8), r.left)}px`;
        palette.style.top = `${r.bottom + 8}px`;
        if (!reduceMotion) gsap.fromTo(palette, { opacity: 0, y: -6 }, { opacity: 1, y: 0, duration: 0.28, ease: "expo.out" });
        const items = B.pins.filter((x) => x.kind !== "note" && !(x.kind === "link" && !x.media.src)).slice(0, 48);
        const key = items.map((x) => x.id).join(",");
        if (!items.length) return showSwatches([], "Add photos to the board to see its palette.");
        if (key === palKey && palCols.length) return showSwatches(palCols);
        swatches.textContent = "";
        swatches.appendChild(mk("li", "pb-swatch-note", "Reading colours…"));
        const sources = (
            await Promise.all(
                items.map(async (x) => {
                    if (x.kind === "unsplash") return { src: `${x.photo.urls.raw}&w=60&h=75&fit=crop&q=50&auto=format`, cors: true };
                    if (x.kind === "upload") return { src: await window.media?.url(x.id), cors: false };
                    return { src: x.media.src, cors: true };
                })
            )
        ).filter((s) => s.src);
        palCols = await window.media.palette(sources, 6, items.map(colorOf));
        palKey = key;
        if (!palette.hidden) showSwatches(palCols);
    }

    function showSwatches(cols, empty) {
        swatches.textContent = "";
        if (!cols.length) return swatches.appendChild(mk("li", "pb-swatch-note", empty || "No colours found."));
        cols.forEach((c) => {
            const li = mk("li");
            const b = mk("button", "pb-swatch");
            b.type = "button";
            b.style.setProperty("--sw", c.hex);
            b.setAttribute("aria-label", `Copy ${c.hex}`);
            b.append(mk("i"), mk("span", "mono", c.hex.toUpperCase()), mk("small", "mono", `${Math.round(c.share * 100)}%`));
            b.addEventListener("click", () => copyText(c.hex.toUpperCase(), `Copied ${c.hex.toUpperCase()}`));
            li.appendChild(b);
            swatches.appendChild(li);
        });
        swatches.querySelector("button")?.focus({ preventScroll: true });
    }

    async function copyText(text, msg) {
        try {
            await navigator.clipboard.writeText(text);
            toast(msg);
        } catch (e) {
            window.prompt("Copy:", text);
        }
    }

    paletteBtn.addEventListener("click", () => (palette.hidden ? openPalette() : closePalette(true)));
    q("#pb-palette-copy").addEventListener("click", () => {
        if (!palCols.length) return;
        const slugName = B.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "board";
        copyText(`:root {\n${palCols.map((c, i) => `    --${slugName}-${i + 1}: ${c.hex};`).join("\n")}\n}`, "Copied the palette as CSS");
    });
    document.addEventListener("pointerdown", (e) => {
        if (!palette.hidden && !palette.contains(e.target) && !paletteBtn.contains(e.target)) closePalette(false);
    });

    /* ---------- open / close ---------- */
    let opening = false;
    function openBoard() {
        if (!board.hidden) return;
        board.hidden = false;
        boardBtn.setAttribute("aria-expanded", "true");
        window.canvasView?.setPaused?.(true);
        syncSwitcher();
        syncUndo();
        opening = true;
        render();
        opening = false;
        if (readonly || (!hadView && (B.pins.length || B.frames.length))) {
            hadView = true;
            fit(false);
        } else applyView();
        scheduleMinimap();
        if (!reduceMotion) {
            gsap.fromTo(board, { opacity: 0 }, { opacity: 1, duration: 0.45, ease: "power2.out" });
            gsap.fromTo(".pb-head > *", { y: -24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.8, stagger: 0.06, ease: "expo.out" });
            gsap.fromTo([strings, knots, framesLayer], { opacity: 0 }, { opacity: 1, duration: 0.6, delay: 0.5, ease: "power2.out" });
            gsap.fromTo(
                cards(),
                { y: -90, opacity: 0, rotate: (i, c) => parseFloat(getComputedStyle(c).getPropertyValue("--r")) * 5 || 8 },
                { y: 0, opacity: 1, rotate: 0, duration: 0.9, stagger: 0.04, ease: "back.out(1.5)", clearProps: "transform" }
            );
        }
        q("#pb-close").focus({ preventScroll: true });
        document.dispatchEvent(new CustomEvent("pins:open", { detail: { readonly, count: B.pins.length } }));
    }

    function closeBoard(then) {
        if (board.hidden) return then?.();
        document.dispatchEvent(new CustomEvent("pins:close"));
        closePicker(false);
        closeMenu(false);
        closePalette(false);
        closePop(false);
        closeLinkbox(false);
        closeFind(false);
        closeTray(false);
        cancelThreadFrom();
        const done = () => {
            board.hidden = true;
            boardBtn.setAttribute("aria-expanded", "false");
            window.canvasView?.setPaused?.(false);
            if (readonly) leaveShared();
            boardBtn.focus({ preventScroll: true });
            then?.();
        };
        if (reduceMotion) return done();
        gsap.to(board, { opacity: 0, duration: 0.35, ease: "power2.in", onComplete: done });
    }

    boardBtn.addEventListener("click", () => (board.hidden ? openBoard() : closeBoard()));
    q("#pb-close").addEventListener("click", () => closeBoard());
    q("#pb-tidy").addEventListener("click", tidy);
    undoBtn.addEventListener("click", undo);
    exportBtn.addEventListener("click", () => (openMenu?.el === exportMenu ? closeMenu(true) : showMenu(exportMenu, { btn: exportBtn })));

    /* ---------- JSON export / import (uploads travel inside the file) ---------- */
    const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "board";
    function download(blob, name) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    q("#pb-export").addEventListener("click", async () => {
        closeMenu(false);
        const mediaData = {};
        for (const x of B.pins) {
            if (x.kind !== "upload") continue;
            const blob = await window.media?.get(x.id).catch(() => null);
            if (blob) mediaData[x.id] = await window.media.blobToDataURL(blob);
        }
        const data = { app: "aperture", version: 4, name: B.name, pins: B.pins, threads: B.threads, frames: B.frames, media: mediaData };
        download(new Blob([JSON.stringify(data)], { type: "application/json" }), `aperture-${slug(B.name)}-${new Date().toISOString().slice(0, 10)}.json`);
        toast("Board file saved");
    });

    // imports merge into the current board
    q("#pb-import").addEventListener("change", async (e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        closeMenu(false);
        if (!file || readonly) return;
        try {
            if (file.size > 80e6) throw new Error("file too large");
            const raw = JSON.parse(await file.text());
            const data = cleanBoard(raw);
            const mediaData = raw && typeof raw.media === "object" && raw.media ? raw.media : {};
            const before = snapshot();
            const fresh = [];
            for (const x of data.pins) {
                if (has(x.id)) continue;
                if (x.kind === "upload") {
                    try {
                        await window.media.put(x.id, await window.media.dataURLToBlob(mediaData[x.id]));
                    } catch (err) {
                        continue; // no image data for this upload: leave it out
                    }
                }
                fresh.push(x);
            }
            fresh.forEach((x) => {
                B.pins.push(x);
                ids.add(x.id);
            });
            let tied = 0;
            data.threads.forEach((t) => {
                if (has(t.a) && has(t.b) && !linked(t.a, t.b)) {
                    B.threads.push(t);
                    tied++;
                }
            });
            data.frames.forEach((f) => B.frames.push({ ...f, id: uid() }));
            if (fresh.length || tied || data.frames.length) {
                checkpoint(before);
                save();
            }
            toast(`Imported ${fresh.length} item${fresh.length === 1 ? "" : "s"}, ${tied} thread${tied === 1 ? "" : "s"}, ${data.frames.length} group${data.frames.length === 1 ? "" : "s"}`);
        } catch (err) {
            window.reportProblem?.("board import failed", err);
            toast("That file couldn't be imported", "warn");
        }
    });

    /* ---------- share as a link ---------- */
    // Signed in: Share opens the share panel (share.js) for a short /b/<code>
    // link to the synced board, which stays current, gets a real link preview
    // and can need a password (#18–19). Signed out: the board is compressed
    // into the URL fragment, so nothing is uploaded anywhere.
    // Either way uploaded images are left out.
    const b64u = (bytes) => {
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    const unb64u = (s) => {
        s = s.replace(/-/g, "+").replace(/_/g, "/");
        return Uint8Array.from(atob(s + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
    };

    async function pack(obj) {
        const raw = new TextEncoder().encode(JSON.stringify(obj));
        if (typeof CompressionStream === "function") {
            const buf = await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer();
            return "z" + b64u(new Uint8Array(buf));
        }
        return "j" + b64u(raw);
    }

    async function unpack(s) {
        let bytes = unb64u(s.slice(1));
        if (s[0] === "z") {
            const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
            const parts = [];
            let n = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                n += value.length;
                if (n > 2e6) {
                    reader.cancel();
                    throw new Error("shared board too large");
                }
                parts.push(value);
            }
            bytes = new Uint8Array(n);
            let o = 0;
            parts.forEach((p) => {
                bytes.set(p, o);
                o += p.length;
            });
        } else if (s[0] !== "j") throw new Error("unknown share format");
        return JSON.parse(new TextDecoder().decode(bytes));
    }

    function packBoard() {
        const items = B.pins.filter((x) => x.kind !== "upload");
        const at = new Map(items.map((x, i) => [x.id, i]));
        const pos = (x) => [Math.round(x.bx), Math.round(x.by), x.r];
        return {
            v: 2,
            n: B.name,
            i: items.map((x) => {
                if (x.kind === "unsplash") {
                    const p = x.photo;
                    return ["s", p.id, p.urls.raw.slice(HOST.length), p.color, p.width, p.height, p.user.name, p.user.username, p.alt_description.slice(0, 120), x.note, ...pos(x), x.query];
                }
                if (x.kind === "link") return ["l", x.id, x.media.href, x.media.src || "", x.media.title, x.note, ...pos(x)];
                return ["n", x.id, x.note, x.tint, ...pos(x)];
            }),
            t: B.threads.filter((t) => at.has(t.a) && at.has(t.b)).map((t) => [at.get(t.a), at.get(t.b), t.label]),
            f: B.frames.map((f) => [Math.round(f.x), Math.round(f.y), Math.round(f.w), Math.round(f.h), f.title]),
            skipped: B.pins.length - items.length,
        };
    }

    const unsplashFromArr = (a) => ({
        kind: "unsplash",
        photo: { id: a[1], urls: { raw: HOST + str(a[2], 600) }, color: a[3], width: a[4], height: a[5], user: { name: a[6], username: a[7] }, alt_description: a[8] },
        note: a[9],
        bx: a[10],
        by: a[11],
        r: a[12],
        query: a[13],
    });

    function unpackBoard(d) {
        if (!d || !(d.v === 1 || d.v === 2)) throw new Error("not a board");
        let items;
        if (d.v === 1) {
            if (!Array.isArray(d.p)) throw new Error("not a board");
            // v1: unsplash only, [id, raw, color, w, h, name, username, alt, note, bx, by, r, query]
            items = d.p.slice(0, MAX_PINS).map((a) => (Array.isArray(a) ? unsplashFromArr(["s", ...a]) : null));
        } else {
            if (!Array.isArray(d.i)) throw new Error("not a board");
            items = d.i.slice(0, MAX_PINS).map((a) => {
                if (!Array.isArray(a)) return null;
                if (a[0] === "s") return unsplashFromArr(a);
                if (a[0] === "l") return { kind: "link", id: a[1], media: { href: a[2], src: a[3] || null, title: a[4] }, note: a[5], bx: a[6], by: a[7], r: a[8] };
                if (a[0] === "n") return { kind: "note", id: a[1], note: a[2], tint: a[3], bx: a[4], by: a[5], r: a[6] };
                return null;
            });
        }
        const idAt = (i) => {
            const x = Number.isInteger(i) ? items[i] : null;
            return x ? x.id || x.photo?.id : undefined;
        };
        return cleanBoard(
            {
                name: d.n,
                pins: items,
                threads: (Array.isArray(d.t) ? d.t : []).map((t) => (Array.isArray(t) ? { a: idAt(t[0]), b: idAt(t[1]), label: t[2] } : null)),
                frames: (Array.isArray(d.f) ? d.f : []).map((f) => (Array.isArray(f) ? { x: f[0], y: f[1], w: f[2], h: f[3], title: f[4] } : null)),
            },
            "Shared board"
        );
    }

    // Safari only allows a clipboard write during the click itself, so the text is
    // handed over as a promise straight away and filled in when the link is ready.
    async function copyLater(text) {
        try {
            if (window.ClipboardItem && navigator.clipboard?.write) {
                await navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
                return true;
            }
        } catch (e) {}
        try {
            await navigator.clipboard.writeText(await text);
            return true;
        } catch (e) {
            return false;
        }
    }

    let sharing = false;
    shareBtn.addEventListener("click", async () => {
        if (!B.pins.length) return toast("Add something first — an empty board has nothing to share");
        if (sharing) return;
        const label = shareBtn.firstChild;
        try {
            const packed = packBoard();
            if (!packed.i.length) return toast("Uploaded images can't go in a share link. Export the board file instead.", "warn");
            if (window.cloud?.user?.() && window.share) return void window.share.open({ boardId: index.active, skipped: packed.skipped });
            sharing = true;
            const made = pack(packed).then((z) => `${location.origin}/#board=${z}`);
            const copiedP = copyLater(made.catch(() => ""));
            const url = await made;
            const copied = await copiedP;
            if (!copied) window.prompt("Copy this link to share the board:", url);
            const kb = Math.round(url.length / 1024);
            label.textContent = copied ? "Link copied ✓" : "Share";
            const notes = [];
            if (packed.skipped) notes.push(`${packed.skipped} uploaded image${packed.skipped === 1 ? " isn't" : "s aren't"} included`);
            if (kb > 6) notes.push(`it's long (${kb} KB), so some chat apps may cut it${window.cloud?.state?.() === "out" ? ". Sign in for a short link" : ""}`);
            if (copied) toast(`Share link copied${notes.length ? ` — ${notes.join("; ")}` : ""}`, notes.length ? "warn" : "");
            setTimeout(() => (label.textContent = "Share"), 2200);
        } catch (err) {
            label.textContent = "Share";
            window.reportProblem?.("share failed", err);
            toast("Couldn't make a share link in this browser", "warn");
        } finally {
            sharing = false;
        }
    });

    function enterShared(data) {
        readonly = true;
        B = data;
        reindex();
        clearSel();
        board.classList.add("is-readonly");
        sharedBar.hidden = false;
        q("#pb-shared-name").textContent = data.name;
        closePop(false);
        render();
        contextChanged();
    }

    // a /b/<code> page: back to the plain app address once the shared board is closed
    function leavePath() {
        if (!location.pathname.startsWith("/b/")) return;
        try {
            history.replaceState(null, "", "/" + location.search);
        } catch (e) {}
    }

    function leaveShared() {
        leavePath();
        shared = null;
        readonly = false;
        board.classList.remove("is-readonly");
        sharedBar.hidden = true;
        loadActive();
        loadView();
        syncSwitcher();
        render();
        contextChanged();
    }

    q("#pb-keep").addEventListener("click", () => {
        const copy = B;
        const id = uid();
        let name = copy.name;
        if (index.list.some((b) => b.name === name)) name = `${name} (shared)`;
        copy.name = name.slice(0, 60);
        readonly = false;
        shared = null;
        leavePath();
        board.classList.remove("is-readonly");
        sharedBar.hidden = true;
        store.set(bkey(id), copy);
        index.list.push({ id, name: copy.name, updated: Date.now() });
        changed(id);
        store.set(vkey(id), goal);
        switchBoard(id);
        toast(`Saved as “${copy.name}” in your boards`);
    });

    async function openSharedFromHash() {
        const m = location.hash.match(/^#board=([A-Za-z0-9_-]{2,300000})$/);
        if (!m) return;
        try {
            history.replaceState(null, "", location.pathname + location.search);
        } catch (e) {}
        let data;
        try {
            data = unpackBoard(await unpack(m[1]));
        } catch (err) {
            window.reportProblem?.("broken share link", err);
            return toast("That shared board link is broken or incomplete", "warn");
        }
        showShared(data);
    }

    // /b/<code>: the server embedded the board in the page (backend/api/board.js)
    function openSharedFromPage() {
        const el = document.getElementById("shared-board");
        if (!el) return;
        el.remove();
        let s = null;
        try {
            s = JSON.parse(el.textContent);
        } catch (e) {}
        const toBoard = (x) => cleanBoard({ ...x.data, name: x.name }, "Shared board");
        // password-protected (#19): ask once the wall is up, then fetch the board (share.js)
        if (s?.locked && typeof s.code === "string") {
            const ctx = { code: s.code, password: null };
            return showShared(async () => {
                const got = await window.share?.unlock(s.code);
                if (got?.data && typeof got.data === "object") {
                    ctx.password = got.password || null;
                    return toBoard(got);
                }
                leavePath();
                return null;
            }, ctx);
        }
        if (!s?.data || typeof s.data !== "object") {
            leavePath();
            return toast(s?.error ? "Couldn't load that shared board. Try the link again in a moment." : "That shared board doesn't exist any more. Its owner may have deleted it.", "warn");
        }
        showShared(toBoard(s), typeof s.code === "string" ? { code: s.code, password: null } : null);
    }

    // `source` is the board, or an async function that gives it (null: give up).
    // `ctx` is the /b/ link's { code, password } (none for #board= links: no comments there)
    function showShared(source, ctx = null) {
        // wait for the first page so the canvas (which hosts the board) can open
        const t0 = Date.now();
        const wait = setInterval(() => {
            const ready = state.photos.length && !document.body.classList.contains("is-loading") && window.canvasView?.open;
            if (!ready && Date.now() - t0 < 15000) return;
            clearInterval(wait);
            if (!ready) return;
            window.canvasView.open();
            setTimeout(
                async () => {
                    const data = typeof source === "function" ? await source() : source;
                    if (!data) return;
                    shared = ctx;
                    enterShared(data);
                    if (board.hidden) openBoard();
                    else fit(false);
                },
                reduceMotion ? 0 : 1100
            );
        }, 100);
    }
    openSharedFromPage();
    openSharedFromHash();
    window.addEventListener("hashchange", openSharedFromHash);

    /* ---------- export as an image ---------- */
    function rrect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
        else ctx.rect(x, y, w, h);
    }

    function wrapText(ctx, text, x, y, maxW, lineH, maxLines) {
        const words = String(text || "").split(/\s+/).filter(Boolean);
        let line = "";
        let n = 0;
        for (let i = 0; i < words.length; i++) {
            const test = line ? `${line} ${words[i]}` : words[i];
            if (ctx.measureText(test).width > maxW && line) {
                if (n === maxLines - 1) return ctx.fillText(`${line}…`, x, y + n * lineH, maxW);
                ctx.fillText(line, x, y + n * lineH, maxW);
                n++;
                line = words[i];
            } else line = test;
        }
        if (line) ctx.fillText(line, x, y + n * lineH, maxW);
    }

    // draw img to fill (x, y, w, h) like object-fit: cover
    function drawCover(ctx, img, x, y, w, h) {
        const iw = img.naturalWidth || img.width;
        const ih = img.naturalHeight || img.height;
        const s = Math.max(w / iw, h / ih);
        const sw = w / s;
        const sh = h / s;
        ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
    }

    // Unsplash asks apps to report downloads; a board image uses the photos in it
    function trackDownloads(list) {
        list.forEach((x, i) => {
            let ixid = null;
            try {
                ixid = new URL(x.photo.urls.raw).searchParams.get("ixid");
            } catch (e) {}
            setTimeout(() => api(`/photos/${x.photo.id}/download`, ixid ? { ixid } : {}).catch(() => {}), i * 120);
        });
    }

    imageBtn.addEventListener("click", async () => {
        closeMenu(false);
        const box = contentBox();
        if (!box) return toast("Nothing on the board to export yet");
        imageBtn.disabled = true;
        toast("Rendering image…");
        try {
            const css = getComputedStyle(document.documentElement);
            const v = (n, fb) => css.getPropertyValue(n).trim() || fb;
            const bg = v("--bg", "#0d0c0a");
            const paper = v("--paper", "#ece7dc");
            const accent = v("--accent", "#ff5b2e");
            const sans = v("--sans", "sans-serif");
            const serif = v("--serif", "serif");
            const mono = v("--mono", "monospace");
            await document.fonts?.ready;

            const pad = 64;
            const W = box.r - box.l + pad * 2;
            const H = box.b - box.t + pad * 2 + 24;
            const s = Math.min(2, 8000 / Math.max(W, H), Math.sqrt(36e6 / (W * H)));
            const cv = document.createElement("canvas");
            cv.width = Math.round(W * s);
            cv.height = Math.round(H * s);
            const ctx = cv.getContext("2d");
            const drawHead = (p) => {
                if (!p) return;
                const pg = ctx.createRadialGradient(p[0] - 3, p[1] - 3, 1, p[0], p[1], 8);
                pg.addColorStop(0, "#ffb299");
                pg.addColorStop(0.45, accent);
                pg.addColorStop(1, "#b8340f");
                ctx.fillStyle = pg;
                ctx.beginPath();
                ctx.arc(p[0], p[1], 8, 0, Math.PI * 2);
                ctx.fill();
            };
            ctx.scale(s, s);
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, W, H);
            ctx.fillStyle = "rgba(236, 231, 220, 0.09)";
            for (let x = 13; x < W; x += 26) for (let y = 13; y < H; y += 26) ctx.fillRect(x - 0.7, y - 0.7, 1.4, 1.4);
            ctx.translate(pad - box.l, pad - box.t);

            B.frames.forEach((f) => {
                ctx.save();
                rrect(ctx, f.x, f.y, f.w, f.h, 14);
                ctx.fillStyle = "rgba(236, 231, 220, 0.04)";
                ctx.fill();
                ctx.setLineDash([8, 6]);
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = "rgba(236, 231, 220, 0.35)";
                ctx.stroke();
                ctx.fillStyle = paper;
                ctx.font = `500 20px ${sans}`;
                ctx.textBaseline = "top";
                ctx.fillText(f.title || "Untitled group", f.x + 44, f.y + 14, f.w - 60);
                ctx.restore();
            });

            const imgs = new Map(
                await Promise.all(
                    B.pins.map(async (x) => {
                        if (x.kind === "unsplash") return [x.id, await window.media.loadImage(cardSrc(x.photo), true)];
                        if (x.kind === "upload") {
                            const u = await window.media?.url(x.id);
                            return [x.id, u ? await window.media.loadImage(u, false) : null];
                        }
                        if (x.kind === "link" && x.media.src) return [x.id, await window.media.loadImage(x.media.src, true)];
                        return [x.id, null];
                    })
                )
            );
            const order = cards().sort((a, b) => (+a.style.zIndex || 0) - (+b.style.zIndex || 0));
            order.forEach((c) => {
                const x = pinBy(c.dataset.id);
                const g = geo.get(c.dataset.id);
                if (!x || !g) return;
                const { w, h } = g;
                ctx.save();
                ctx.translate(g.l + w / 2, g.t + h / 2);
                ctx.rotate(((x.r || 0) * Math.PI) / 180);
                ctx.translate(-w / 2, -h / 2);
                ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
                ctx.shadowBlur = 30;
                ctx.shadowOffsetY = 14;
                rrect(ctx, 0, 0, w, h, 3);
                ctx.fillStyle = x.kind === "note" ? TINT_HEX[x.tint] : paper;
                ctx.fill();
                ctx.shadowColor = "transparent";
                ctx.textBaseline = "top";
                const iw = w - 20;
                if (x.kind === "note") {
                    ctx.fillStyle = bg;
                    ctx.font = `italic 22px ${serif}`;
                    wrapText(ctx, x.note, 16, 26, w - 32, 23, Math.max(1, Math.floor((h - 50) / 23)));
                } else {
                    const bookmark = x.kind === "link" && !x.media.src;
                    const mediaEl = c.querySelector("img, .pb-bookmark");
                    const ih = mediaEl ? mediaEl.offsetHeight : iw * 1.25;
                    ctx.fillStyle = bookmark ? "#1d1b18" : colorOf(x);
                    ctx.fillRect(10, 10, iw, ih);
                    const img = imgs.get(x.id);
                    if (img) drawCover(ctx, img, 10, 10, iw, ih);
                    if (bookmark) {
                        ctx.fillStyle = paper;
                        ctx.font = `italic 26px ${serif}`;
                        wrapText(ctx, hostOf(x.media.href), 22, 26, iw - 24, 28, 2);
                        ctx.font = `10px ${mono}`;
                        ctx.fillStyle = "rgba(236, 231, 220, 0.6)";
                        wrapText(ctx, x.media.title, 22, ih - 34, iw - 24, 12, 2);
                    }
                    ctx.fillStyle = bg;
                    ctx.font = `italic 19px ${serif}`;
                    wrapText(ctx, x.note, 10, ih + 18, iw, 20, 2);
                    ctx.font = `10px ${mono}`;
                    ctx.fillStyle = "rgba(13, 12, 10, 0.55)";
                    const left = x.kind === "unsplash" ? x.photo.user.name : x.kind === "upload" ? x.media.name || "Your image" : hostOf(x.media.href);
                    ctx.fillText(left.toUpperCase(), 10, ih + 62, iw * 0.55);
                    ctx.textAlign = "right";
                    ctx.fillText(fromLabel(x).toUpperCase(), w - 10, ih + 62, iw * 0.42);
                }
                ctx.restore();
                drawHead(pinPoint(x.id));
            });

            ctx.save();
            ctx.lineCap = "round";
            const tied = new Set();
            B.threads.forEach((t) => {
                const a = pinPoint(t.a);
                const b = pinPoint(t.b);
                if (!a || !b) return;
                tied.add(t.a).add(t.b);
                const c = ctrlOf(a, b);
                [
                    ["rgba(0, 0, 0, 0.38)", 3, 3],
                    [accent, 2.2, 0],
                ].forEach(([col, lw, dy]) => {
                    ctx.strokeStyle = col;
                    ctx.lineWidth = lw;
                    ctx.beginPath();
                    ctx.moveTo(a[0], a[1] + dy);
                    ctx.quadraticCurveTo(c[0], c[1] + dy, b[0], b[1] + dy);
                    ctx.stroke();
                });
            });
            ctx.restore();
            // as on screen: each string ends under the head of the pin it's tied to
            tied.forEach((id) => drawHead(pinPoint(id)));

            ctx.font = `500 12px ${mono}`;
            ctx.textBaseline = "middle";
            B.threads.forEach((t) => {
                if (!t.label) return;
                const m = knotPoint(t);
                if (!m) return;
                const tw = Math.min(220, ctx.measureText(t.label).width);
                rrect(ctx, m[0] - tw / 2 - 10, m[1] - 12, tw + 20, 24, 12);
                ctx.fillStyle = accent;
                ctx.fill();
                ctx.fillStyle = bg;
                ctx.textAlign = "center";
                ctx.fillText(t.label, m[0], m[1] + 1, 220);
            });

            ctx.setTransform(s, 0, 0, s, 0, 0);
            ctx.textAlign = "left";
            ctx.textBaseline = "alphabetic";
            ctx.font = `12px ${mono}`;
            ctx.fillStyle = "rgba(236, 231, 220, 0.5)";
            const hasUnsplash = B.pins.some((x) => x.kind === "unsplash");
            ctx.fillText(`${B.name.toUpperCase()} — APERTURE${hasUnsplash ? " · PHOTOS FROM UNSPLASH" : ""}`, pad, H - 28);

            let blob;
            try {
                blob = await new Promise((res) => cv.toBlob(res, "image/png"));
            } catch (err) {
                throw new Error("an image from a link blocked the export");
            }
            if (!blob) throw new Error("toBlob failed");
            download(blob, `aperture-${slug(B.name)}.png`);
            trackDownloads(B.pins.filter((x) => x.kind === "unsplash"));
            toast("Image saved");
        } catch (err) {
            window.reportProblem?.("image export failed", err);
            toast(`Couldn't render the image${err?.message?.includes("link") ? ` — ${err.message}` : ""}`, "warn");
        } finally {
            imageBtn.disabled = false;
        }
    });

    /* ---------- housekeeping: drop uploaded images no board uses any more ---------- */
    setTimeout(async () => {
        if (!window.media?.available) return;
        try {
            const last = +localStorage.getItem(MEDIA_LAST) || 0;
            if (Date.now() - last < 120000) return; // another tab may be mid-upload
            const keep = new Set();
            const collect = (pins) => (Array.isArray(pins) ? pins : []).forEach((x) => x?.kind === "upload" && keep.add(x.id));
            index.list.forEach((b) => collect(store.get(bkey(b.id))?.pins));
            if (!readonly) collect(B.pins);
            [...undoStack, ...redoStack].forEach((sn) => {
                try {
                    collect(JSON.parse(sn).pins);
                } catch (e) {}
            });
            const all = await window.media.keys();
            for (const k of all) if (!keep.has(k)) await window.media.del(k);
        } catch (e) {}
    }, 20000);

    /* ---------- sync ---------- */
    // another tab changed boards
    window.addEventListener("storage", (e) => {
        if (readonly || !e.key) return;
        if (e.key === INDEX) {
            const next = store.get(INDEX);
            if (next && Array.isArray(next.list) && next.list.length) {
                index = next;
                if (!index.list.some((b) => b.id === index.active)) index.active = index.list[0].id;
                loadActive();
                syncSwitcher();
                listeners.forEach((fn) => fn());
            }
        } else if (e.key === bkey(index.active)) {
            loadActive();
            listeners.forEach((fn) => fn());
        }
    });

    window.addEventListener("resize", () => !board.hidden && render());

    listeners.add(render);
    syncCount();

    /* ---------- for cloud.js: read and apply boards without echoing changes back ---------- */
    function afterIndexChange() {
        if (!index.list.some((b) => b.id === index.active)) {
            index.active = index.list[0].id;
            loadActive();
        }
        store.set(INDEX, index);
        syncSwitcher();
        listeners.forEach((fn) => fn());
    }

    const local = {
        // every board on this device: { id, name, updated, empty }
        list: () => index.list.map((b) => ({ ...b, empty: !(store.get(bkey(b.id))?.pins?.length) })),
        get: (id) => (index.list.some((b) => b.id === id) ? cleanBoard(store.get(bkey(id)), "Untitled board") : null),
        // a newer copy arrived from the cloud
        put(id, data, updated) {
            if (!ID_RE.test(id)) return;
            const clean = cleanBoard(data, "Untitled board");
            if (!store.set(bkey(id), clean)) return;
            const meta = index.list.find((b) => b.id === id);
            if (meta) Object.assign(meta, { name: clean.name, updated });
            else index.list.push({ id, name: clean.name, updated });
            if (id === index.active && !readonly) {
                const typing = document.activeElement?.closest?.(".pb-note, .pb-frame-title, #pb-name");
                loadActive();
                if (!typing) undoStack = redoStack = [];
                syncUndo();
            }
            afterIndexChange();
        },
        // deleted on another device
        remove(id) {
            if (!index.list.some((b) => b.id === id)) return;
            index.list = index.list.filter((b) => b.id !== id);
            store.del(bkey(id));
            store.del(vkey(id));
            if (!index.list.length) {
                const nid = uid();
                store.set(bkey(nid), cleanBoard({ name: "My board" }));
                index.list.push({ id: nid, name: "My board", updated: 0 });
            }
            afterIndexChange();
        },
        // signed out: this device's copy goes, the account keeps them
        reset() {
            index.list.forEach((b) => (store.del(bkey(b.id)), store.del(vkey(b.id))));
            const nid = uid();
            store.set(bkey(nid), cleanBoard({ name: "My board" }));
            index = { active: nid, list: [{ id: nid, name: "My board", updated: 0 }] };
            loadActive();
            afterIndexChange();
        },
        // an uploaded image was fetched from the cloud: show it if its card is waiting
        mediaArrived(id) {
            const card = cardEl(id);
            const img = card?.querySelector("img");
            if (!img) return;
            window.media?.url(id).then((u) => {
                if (!u) return;
                img.src = u;
                card.classList.remove("is-missing");
            });
        },
    };

    window.pins = {
        has,
        toggle,
        count: () => B.pins.length,
        syncLightbox,
        isBoardOpen: () => !board.hidden,
        openBoard,
        closeBoard,
        local,
        // for comments.js (#20)
        commentTarget: () => (board.hidden ? null : shared ? { ...shared } : readonly ? null : { boardId: index.active }),
        isShared: () => !!shared,
        boardName: () => B.name,
        itemLabel: (id) => (has(id) ? labelOf(pinBy(id)) : null),
        focusItem(id) {
            const g = geo.get(id);
            if (!g) return false;
            flyTo(g.l + g.w / 2, g.t + g.h / 2);
            const el = cardEl(id);
            el?.classList.add("is-hit");
            setTimeout(() => el?.classList.remove("is-hit"), 1600);
            return true;
        },
        setCommentCounts(map) {
            commentCounts = map instanceof Map ? map : new Map();
            if (!board.hidden) render();
        },
    };
})();
