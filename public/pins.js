/* ==========================================================
   APERTURE — pin boards
   Pins live in named boards kept in localStorage, so a frame you pin on the
   wall (hover + P, or "Pin" in the viewer) lands on the active board and is
   still there next visit. A board is a corkboard overlay on the canvas: pan
   and zoom it, drag polaroids anywhere, group them in frames, tie labelled
   threads between pins, undo, share as a link, save as PNG or JSON.
   Relies on globals from api.js: state, lb, lightbox, q, gsap, reduceMotion.
========================================================== */
(() => {
    const IMG_HOST = /^https:\/\/images\.unsplash\.com\//;
    const HOST = "https://images.unsplash.com/";
    const INDEX = "aperture:boards";
    const bkey = (id) => `aperture:board:${id}`;
    const vkey = (id) => `aperture:board-view:${id}`;
    const LEGACY = { pins: "aperture:pins", threads: "aperture:threads", view: "aperture:board-view" };
    const ZMIN = 0.2;
    const ZMAX = 2;
    const CARD_W = 200;
    const CARD_H = Math.round(CARD_W * 1.25 + 96);
    const MAX_PINS = 500;
    const clamp = gsap.utils.clamp;
    const clampZ = (z) => clamp(ZMIN, ZMAX, z);
    const listeners = new Set();

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
                return false;
            }
        },
        del(k) {
            try {
                localStorage.removeItem(k);
            } catch (e) {}
        },
    };

    const uid = () => Math.random().toString(36).slice(2, 10);
    const ID_RE = /^[a-z0-9]{1,20}$/;
    const PHOTO_ID = /^[A-Za-z0-9_-]{1,40}$/;
    const str = (v, n) => String(v ?? "").slice(0, n);
    const fin = (v) => (Number.isFinite(v) ? v : null);
    const tkey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

    /* ---------- sanitising (storage, imports and share links all pass through here) ---------- */
    const okLink = (u, fb) => (typeof u === "string" && /^https:\/\/unsplash\.com\//.test(u) ? u : fb);
    const validPin = (x) =>
        !!x && !!x.photo && typeof x.photo.id === "string" && PHOTO_ID.test(x.photo.id) && typeof x.photo.urls?.raw === "string" && IMG_HOST.test(x.photo.urls.raw);

    function snap(p) {
        const username = PHOTO_ID.test(p.user?.username || "") ? p.user.username : "";
        return {
            id: p.id,
            color: /^#[0-9a-fA-F]{3,8}$/.test(p.color || "") ? p.color : "#222222",
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

    const cleanPin = (x) => ({
        photo: snap(x.photo),
        note: str(x.note, 280),
        query: str(x.query, 120),
        at: Number(x.at) || Date.now(),
        x: fin(x.x),
        y: fin(x.y),
        bx: fin(x.bx),
        by: fin(x.by),
        r: clamp(-6, 6, Number(x.r) || 0),
    });

    function cleanBoard(raw, fallbackName = "My board") {
        raw = raw && typeof raw === "object" ? raw : {};
        const list = Array.isArray(raw) ? raw : Array.isArray(raw.pins) ? raw.pins : [];
        const seen = new Set();
        const pins = [];
        list.forEach((x) => {
            if (pins.length >= MAX_PINS || !validPin(x) || seen.has(x.photo.id)) return;
            seen.add(x.photo.id);
            pins.push(cleanPin(x));
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
        index.list = index.list.filter((b) => b && ID_RE.test(b.id)).map((b) => ({ id: b.id, name: str(b.name, 60) || "Untitled board" }));
    }
    if (!index || !Array.isArray(index.list) || !index.list.length) {
        const id = uid();
        const first = cleanBoard({ name: "My board", pins: store.get(LEGACY.pins) || [], threads: store.get(LEGACY.threads) || [] });
        const v = store.get(LEGACY.view);
        if (store.set(bkey(id), first)) {
            if (v) store.set(vkey(id), v);
            Object.values(LEGACY).forEach(store.del);
        }
        index = { active: id, list: [{ id, name: first.name }] };
        store.set(INDEX, index);
    }
    if (!index.list.some((b) => b.id === index.active)) index.active = index.list[0].id;

    /* ---------- active board ---------- */
    let B; // { name, pins, threads, frames }
    const ids = new Set();
    let readonly = false; // viewing someone's shared link
    const reindex = () => {
        ids.clear();
        B.pins.forEach((x) => ids.add(x.photo.id));
    };

    function loadActive() {
        const meta = index.list.find((b) => b.id === index.active);
        B = cleanBoard(store.get(bkey(index.active)), meta?.name || "My board");
        reindex();
    }
    loadActive();

    function persist() {
        if (readonly) return;
        store.set(bkey(index.active), B);
        const meta = index.list.find((b) => b.id === index.active);
        if (meta && meta.name !== B.name) {
            meta.name = B.name;
            store.set(INDEX, index);
            syncSwitcher();
        }
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

    /* ---------- pins ---------- */
    const has = (id) => ids.has(id);
    const pinBy = (id) => B.pins.find((x) => x.photo.id === id);
    const nameOf = (id) => pinBy(id)?.photo.user.name || "photo";

    function add(p) {
        if (!p || has(p.id) || readonly) return;
        checkpoint();
        B.pins.unshift(
            cleanPin({
                photo: p,
                note: "",
                query: state.mode === "search" ? state.query : state.mode === "user" && state.user ? `@${state.user.username}` : "",
                at: Date.now(),
                r: Math.round((Math.random() * 2 - 1) * 40) / 10,
            })
        );
        ids.add(p.id);
        save();
    }

    function remove(id) {
        if (!has(id)) return;
        checkpoint();
        B.pins = B.pins.filter((x) => x.photo.id !== id);
        B.threads = B.threads.filter((t) => t.a !== id && t.b !== id);
        ids.delete(id);
        save();
    }

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

    const fromLabel = (x) => (!x.query ? "Editorial" : x.query.startsWith("@") ? x.query : `“${x.query}”`);

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
            .slice(0, 3)
            .map((x) => x?.photo?.urls?.raw)
            .filter((u) => typeof u === "string" && IMG_HOST.test(u));
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
    }

    q("#pb-new").addEventListener("click", () => {
        closePicker(false);
        const id = uid();
        const name = `Board ${index.list.length + 1}`;
        store.set(bkey(id), cleanBoard({ name }));
        index.list.push({ id, name });
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

    // pins that were never placed: very old saves stored fractions of the area,
    // brand new pins take the first free slot in the visible part of the board
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
        B.pins.forEach((x, i) => {
            x.bx = (i % cols) * (CARD_W + 24);
            x.by = Math.floor(i / cols) * (CARD_H + 28);
            x.r = Math.round((Math.random() * 2 - 1) * 30) / 10;
        });
        B.frames = [];
        const rows = Math.ceil(n / cols);
        save();
        fit(true, { l: 0, t: -12, r: cols * (CARD_W + 24) - 24, b: rows * (CARD_H + 28) - 28 });
        announce("Tidied into a grid. Frames were removed; undo to bring them back.");
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
    // threads and hit tests never have to read layout mid-gesture
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
    const threadEls = new Map(); // key -> { g, paths: [hit, shadow, line], kn }

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
        strings.insertBefore(g, tempPath);
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
            te.kn.setAttribute("aria-label", `Thread between ${nameOf(t.a)} and ${nameOf(t.b)}${t.label ? `: ${t.label}` : ""}. Enter to edit, Delete to cut.`);
        }
        te.kn.tabIndex = readonly ? -1 : 0;
        return k;
    }

    // redraw every thread, or only those touching the given card id(s)
    function drawStrings(only) {
        if (only != null) {
            const set = new Set(Array.isArray(only) ? only : [only]);
            B.threads.forEach((t) => (set.has(t.a) || set.has(t.b)) && drawThread(t));
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
        placePop();
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
            const id = x.photo.id;
            let el = keep.get(id);
            keep.delete(id);
            if (!el) el = makeCard(x);
            if (el.classList.contains("is-held")) return live.push([el, x]);
            el.style.width = `${CARD_W}px`;
            el.style.left = `${x.bx}px`;
            el.style.top = `${x.by}px`;
            el.style.setProperty("--r", `${x.r || 0}deg`);
            const note = el.querySelector(".pb-note");
            if (document.activeElement !== note) note.value = x.note || "";
            note.readOnly = readonly;
            el.setAttribute("aria-label", `Photo by ${x.photo.user.name}${x.note ? `, note: ${x.note}` : ""}`);
            const onWall = !!window.canvasView?.onWall?.(id);
            const loc = el.querySelector('[data-act="locate"]');
            loc.disabled = !onWall;
            loc.title = onWall ? "Fly to this frame on the wall" : "Not on the current wall — search for it to locate";
            live.push([el, x]);
        });
        keep.forEach((el) => el.remove());

        // all writes are done: read sizes once (cards share a width and height)
        geo.clear();
        let w = 0;
        let h = 0;
        live.forEach(([el, x]) => {
            if (!w) {
                w = el.offsetWidth;
                h = el.offsetHeight;
            }
            const held = el.classList.contains("is-held");
            geo.set(x.photo.id, { l: held ? el.offsetLeft : x.bx, t: held ? el.offsetTop : x.by, w: w || CARD_W, h: h || CARD_H, r: x.r || 0 });
        });

        drawStrings();
        emptyEl.hidden = B.pins.length > 0 || B.frames.length > 0;
        if (document.activeElement !== nameInput) nameInput.value = B.name;
        nameInput.readOnly = readonly;
    }

    function makeCard(x) {
        const p = x.photo;
        const el = document.createElement("figure");
        el.className = "pb-card";
        el.dataset.id = p.id;
        el.tabIndex = 0;
        el.setAttribute("aria-roledescription", "pinned photo");
        el.style.setProperty("--c", p.color || "#222");

        const pin = document.createElement("span");
        pin.className = "pb-pin";
        pin.setAttribute("aria-hidden", "true");
        pin.dataset.cursor = "Thread";
        pin.title = "Drag onto another photo to tie a thread";

        const img = document.createElement("img");
        img.alt = p.alt_description || p.description || "Pinned photo";
        img.draggable = false;
        img.loading = "lazy";
        img.src = cardSrc(p);

        const cap = document.createElement("figcaption");
        const note = document.createElement("textarea");
        note.className = "pb-note";
        note.rows = 2;
        note.maxLength = 280;
        note.placeholder = "why this one…";
        note.value = x.note || "";
        note.setAttribute("aria-label", "Note for this pin");
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
                const cur = pinBy(p.id);
                if (!cur) return;
                cur.note = note.value;
                persist();
            }, 250);
        });

        const meta = document.createElement("div");
        meta.className = "pb-meta mono";
        const by = document.createElement("a");
        by.href = `${p.user.links.html}?utm_source=aperture&utm_medium=referral`;
        by.target = "_blank";
        by.rel = "noopener";
        by.textContent = p.user.name;
        const from = document.createElement("span");
        from.textContent = fromLabel(x);
        meta.append(by, from);

        const acts = document.createElement("div");
        acts.className = "pb-acts mono";
        const locate = document.createElement("button");
        locate.type = "button";
        locate.dataset.act = "locate";
        locate.dataset.cursor = "Locate";
        locate.textContent = "Locate ◎";
        const open = document.createElement("a");
        open.href = `${p.links.html}?utm_source=aperture&utm_medium=referral`;
        open.target = "_blank";
        open.rel = "noopener";
        open.dataset.cursor = "Open";
        open.textContent = "Unsplash ↗";
        const del = document.createElement("button");
        del.type = "button";
        del.dataset.act = "remove";
        del.dataset.cursor = "Unpin";
        del.setAttribute("aria-label", `Remove pin: photo by ${p.user.name}`);
        del.textContent = "✕";
        acts.append(locate, open, del);

        cap.append(note, meta, acts);
        el.append(pin, img, cap);
        world.insertBefore(el, strings);

        if (!reduceMotion && !opening) gsap.from(el, { y: -60, opacity: 0, rotate: (x.r || 0) * 4, duration: 0.8, ease: "back.out(1.6)" });
        return el;
    }

    const cardSrc = (p) => `${p.urls.raw}&w=420&h=525&fit=crop&crop=entropy&q=70&auto=format`;

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
    q("#pb-frame").addEventListener("click", newFrame);

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

    /* ---------- pointer interactions ---------- */
    area.addEventListener("click", (e) => {
        const th = e.target.closest?.(".pb-thread, .pb-knot");
        if (th) return openPop(th.dataset.k);
        const btn = e.target.closest("button[data-act]");
        if (!btn) return;
        const el = btn.closest(".pb-card");
        const id = el.dataset.id;
        if (btn.dataset.act === "remove") {
            if (readonly) return;
            const done = () => {
                remove(id);
                announce(`Unpinned. ${navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Z to undo.`);
            };
            if (reduceMotion) return done();
            gsap.to(el, { y: 80, rotate: 18, opacity: 0, duration: 0.5, ease: "power2.in", onComplete: done });
        } else if (btn.dataset.act === "locate") {
            closeBoard(() => window.canvasView?.locate?.(id));
        }
    });

    // one gesture at a time: move a card, pull a thread, move/resize a frame,
    // pan the board, or pinch-zoom with two fingers. Pointer events only record
    // where the pointer is; the DOM is touched at most once per frame.
    let drag = null;
    const touches = new Map();
    const pinchGeom = () => {
        const [a, b] = [...touches.values()];
        return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    };

    // a held card trails the pointer a touch and tilts with its speed, then
    // settles where you let go
    function followCard(d) {
        const id = d.el.dataset.id;
        const step = () => {
            const k = reduceMotion ? 1 : 0.42;
            const px = d.cx;
            d.cx += (d.tx - d.cx) * k;
            d.cy += (d.ty - d.cy) * k;
            const tiltTo = reduceMotion ? 0 : clamp(-10, 10, (d.cx - px) * 0.55);
            d.tilt += (tiltTo - d.tilt) * 0.3;
            d.el.style.translate = `${d.cx.toFixed(2)}px ${d.cy.toFixed(2)}px`;
            d.el.style.setProperty("--tilt", `${d.tilt.toFixed(2)}deg`);
            const g = geo.get(id);
            if (g) {
                g.l = d.left + d.cx;
                g.t = d.top + d.cy;
                g.r = d.tilt;
            }
            drawStrings(id);
            if (d.released && Math.abs(d.tx - d.cx) < 0.25 && Math.abs(d.ty - d.cy) < 0.25 && Math.abs(d.tilt) < 0.15) return finishCard(d);
            d.raf = requestAnimationFrame(step);
        };
        d.raf = requestAnimationFrame(step);
    }

    function finishCard(d) {
        cancelAnimationFrame(d.raf);
        const { el } = d;
        const x = pinBy(el.dataset.id);
        el.style.left = `${d.left + d.tx}px`;
        el.style.top = `${d.top + d.ty}px`;
        el.style.translate = "";
        el.style.removeProperty("--tilt");
        el.classList.remove("is-held");
        const g = geo.get(el.dataset.id);
        if (g) {
            g.l = d.left + d.tx;
            g.t = d.top + d.ty;
            g.r = x?.r || 0;
        }
        if (!x || !d.moved) return drawStrings(el.dataset.id);
        checkpoint(d.snap);
        x.bx = d.left + d.tx;
        x.by = d.top + d.ty;
        save();
    }

    function cancelDrag() {
        if (!drag) return;
        const d = drag;
        drag = null;
        area.classList.remove("is-panning", "is-threading");
        tempPath.removeAttribute("d");
        d.target?.classList.remove("is-target");
        if (d.kind === "card") d.released = true;
        if (d.kind === "frame" || d.kind === "resize") commitFrame(d);
    }

    area.addEventListener("pointerdown", (e) => {
        if (e.target.closest(".pb-pop")) return;
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

        if (card && !readonly && e.target.closest(".pb-pin")) {
            e.preventDefault();
            area.setPointerCapture(e.pointerId);
            area.classList.add("is-threading");
            drag = { kind: "thread", from: card.dataset.id, id: e.pointerId, target: null };
            return threadMove(e.clientX, e.clientY);
        }
        if (card && e.target.closest("textarea, button, a")) return;
        if (card && !readonly) {
            e.preventDefault();
            if (card.classList.contains("is-held")) return; // still settling from the last drop
            card.focus({ preventScroll: true });
            card.setPointerCapture(e.pointerId);
            card.style.zIndex = ++top;
            card.classList.add("is-held");
            const g = geo.get(card.dataset.id);
            drag = {
                kind: "card",
                el: card,
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
                snap: snapshot(),
                moved: false,
                released: false,
            };
            return followCard(drag);
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
        area.classList.add("is-panning");
        stopCam();
        drag = { kind: "pan", id: e.pointerId, sx: e.clientX, sy: e.clientY, x: view.x, y: view.y, samples: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }] };
    });

    function threadMove(cx, cy) {
        if (!drag || drag.kind !== "thread") return;
        const a = pinPoint(drag.from);
        const r = area.getBoundingClientRect();
        const b = [(cx - r.left - view.x) / view.z, (cy - r.top - view.y) / view.z];
        if (a) tempPath.setAttribute("d", stringPath(a, b));
        const over = document.elementFromPoint(cx, cy)?.closest(".pb-card");
        const target = over && over.dataset.id !== drag.from ? over : null;
        if (target !== drag.target) {
            drag.target?.classList.remove("is-target");
            target?.classList.add("is-target");
            drag.target = target;
        }
    }

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
        if (d.kind === "thread") return onFrame(() => threadMove(cx, cy));
        if (d.kind === "pan") {
            d.samples.push({ t: e.timeStamp, x: cx, y: cy });
            if (d.samples.length > 6) d.samples.shift();
            return onFrame(() => drag === d && setViewNow(d.x + cx - d.sx, d.y + cy - d.sy));
        }
        const dx = (cx - d.sx) / view.z;
        const dy = (cy - d.sy) / view.z;
        if (Math.abs(dx) + Math.abs(dy) > 1) d.moved = true;
        if (d.kind === "card") {
            d.tx = dx;
            d.ty = dy;
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
                const glide = 170;
                panBy(clamp(-1400, 1400, vx * glide), clamp(-1400, 1400, vy * glide));
            }
            return;
        }
        if (d.kind === "thread") {
            area.classList.remove("is-threading");
            tempPath.removeAttribute("d");
            d.target?.classList.remove("is-target");
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
        if (card) reveal(card.offsetLeft, card.offsetTop - 12, card.offsetWidth, card.offsetHeight + 12);
        else if (frame) reveal(frame.offsetLeft, frame.offsetTop, Math.min(frame.offsetWidth, 400), 60);
    });

    /* ---------- keyboard ---------- */
    let lastKeyMove = 0;
    function keyMove(kind, el, dx, dy) {
        const now = performance.now();
        if (now - lastKeyMove > 800) checkpoint();
        lastKeyMove = now;
        if (kind === "card") {
            const x = pinBy(el.dataset.id);
            if (!x) return;
            x.bx += dx;
            x.by += dy;
        } else {
            const f = frameBy(el.closest(".pb-frame").dataset.id);
            if (!f) return;
            membersOf(f).forEach((id) => {
                const x = pinBy(id);
                if (!x) return;
                x.bx += dx;
                x.by += dy;
            });
            f.x += dx;
            f.y += dy;
        }
        save();
    }

    document.addEventListener(
        "keydown",
        (e) => {
            if (board.hidden || !lightbox.hidden) return;
            const ae = document.activeElement;
            const typing = /INPUT|TEXTAREA|SELECT/.test(ae?.tagName);
            const handled = () => {
                e.preventDefault();
                e.stopImmediatePropagation();
            };
            // the open board picker owns the keyboard (its list handles arrows / Enter)
            if (pickOpen) {
                if (e.key === "Escape") {
                    handled();
                    closePicker(true);
                }
                return;
            }
            if (e.key === "Escape") {
                handled();
                if (popKey) return closePop(true);
                if (cancelThreadFrom()) return announce("Thread cancelled");
                if (typing) return ae.blur();
                return closeBoard();
            }
            if (typing) return;
            const mod = e.ctrlKey || e.metaKey;
            const key = e.key.toLowerCase();
            if (mod && key === "z") {
                handled();
                return e.shiftKey ? redo() : undo();
            }
            if (mod && key === "y") {
                handled();
                return redo();
            }
            if (mod || e.altKey) return;

            const card = ae?.classList?.contains("pb-card") ? ae : null;
            const grip = ae?.classList?.contains("pb-frame-grip") ? ae : null;
            const knot = ae?.classList?.contains("pb-knot") ? ae : null;
            const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

            if ((card || grip) && arrows[e.key] && !readonly) {
                handled();
                const step = e.shiftKey ? 60 : 12;
                return keyMove(card ? "card" : "frame", card || grip, arrows[e.key][0] * step, arrows[e.key][1] * step);
            }
            if (card && (e.key === "Delete" || e.key === "Backspace") && !readonly) {
                handled();
                const list = cards();
                const next = list[list.indexOf(card) + 1] || list[list.indexOf(card) - 1];
                remove(card.dataset.id);
                announce("Unpinned. Ctrl+Z to undo.");
                return (next || area).focus({ preventScroll: true });
            }
            if (knot && (e.key === "Delete" || e.key === "Backspace")) {
                handled();
                cutThread(knot.dataset.k);
                return area.focus({ preventScroll: true });
            }
            if (card && !readonly && (key === "t" || (e.key === "Enter" && threadFrom))) {
                handled();
                return threadFrom ? finishThreadTo(card.dataset.id) : startThreadFrom(card.dataset.id);
            }
            if (e.key === "+" || e.key === "=") return handled(), zoomAt(goal.z * 1.25);
            if (e.key === "-" || e.key === "_") return handled(), zoomAt(goal.z / 1.25);
            if (e.key === "0") return handled(), zoomAt(1);
            if (key === "f") return handled(), fit(true);
            if (key === "g" && !readonly) return handled(), newFrame();
        },
        true
    );

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
        if (!reduceMotion) {
            gsap.fromTo(board, { opacity: 0 }, { opacity: 1, duration: 0.45, ease: "power2.out" });
            gsap.fromTo(".pb-head > *", { y: -24, opacity: 0 }, { y: 0, opacity: 1, duration: 0.8, stagger: 0.06, ease: "expo.out" });
            gsap.fromTo([strings, knots, framesLayer], { opacity: 0 }, { opacity: 1, duration: 0.6, delay: 0.5, ease: "power2.out" });
            gsap.fromTo(
                cards(),
                { y: -90, opacity: 0, rotate: (i, el) => parseFloat(getComputedStyle(el).getPropertyValue("--r")) * 5 || 8 },
                { y: 0, opacity: 1, rotate: 0, duration: 0.9, stagger: 0.04, ease: "back.out(1.5)", clearProps: "transform" }
            );
        }
        q("#pb-close").focus({ preventScroll: true });
    }

    function closeBoard(then) {
        if (board.hidden) return then?.();
        closePicker(false);
        closePop(false);
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

    /* ---------- JSON export / import ---------- */
    const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "board";
    function download(blob, name) {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }

    q("#pb-export").addEventListener("click", () => {
        const data = { app: "aperture", version: 3, name: B.name, pins: B.pins, threads: B.threads, frames: B.frames };
        download(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), `aperture-${slug(B.name)}-${new Date().toISOString().slice(0, 10)}.json`);
    });

    // imports merge into the current board
    q("#pb-import").addEventListener("change", async (e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file || readonly) return;
        try {
            if (file.size > 5e6) throw new Error("file too large");
            const data = cleanBoard(JSON.parse(await file.text()));
            const before = snapshot();
            const fresh = data.pins.filter((x) => !has(x.photo.id));
            fresh.forEach((x) => {
                B.pins.push(x);
                ids.add(x.photo.id);
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
            announce(`Imported ${fresh.length} photo${fresh.length === 1 ? "" : "s"}, ${tied} thread${tied === 1 ? "" : "s"}, ${data.frames.length} group${data.frames.length === 1 ? "" : "s"}`);
        } catch (err) {
            console.warn("[aperture] board import failed:", err);
            announce("That file couldn't be imported");
        }
    });

    /* ---------- share as a link ---------- */
    // the whole board is compressed into the URL fragment, so nothing is uploaded anywhere
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
        const at = new Map(B.pins.map((x, i) => [x.photo.id, i]));
        return {
            v: 1,
            n: B.name,
            p: B.pins.map((x) => [
                x.photo.id,
                x.photo.urls.raw.slice(HOST.length),
                x.photo.color,
                x.photo.width,
                x.photo.height,
                x.photo.user.name,
                x.photo.user.username,
                x.photo.alt_description.slice(0, 120),
                x.note,
                Math.round(x.bx),
                Math.round(x.by),
                x.r,
                x.query,
            ]),
            t: B.threads.map((t) => [at.get(t.a), at.get(t.b), t.label]),
            f: B.frames.map((f) => [Math.round(f.x), Math.round(f.y), Math.round(f.w), Math.round(f.h), f.title]),
        };
    }

    function unpackBoard(d) {
        if (!d || d.v !== 1 || !Array.isArray(d.p)) throw new Error("not a board");
        const pins = d.p.slice(0, MAX_PINS).map((a) =>
            Array.isArray(a)
                ? {
                      photo: {
                          id: a[0],
                          urls: { raw: HOST + str(a[1], 600) },
                          color: a[2],
                          width: a[3],
                          height: a[4],
                          user: { name: a[5], username: a[6] },
                          alt_description: a[7],
                      },
                      note: a[8],
                      bx: a[9],
                      by: a[10],
                      r: a[11],
                      query: a[12],
                  }
                : null
        );
        const idAt = (i) => (Number.isInteger(i) ? pins[i]?.photo?.id : undefined);
        return cleanBoard(
            {
                name: d.n,
                pins,
                threads: (Array.isArray(d.t) ? d.t : []).map((t) => (Array.isArray(t) ? { a: idAt(t[0]), b: idAt(t[1]), label: t[2] } : null)),
                frames: (Array.isArray(d.f) ? d.f : []).map((f) => (Array.isArray(f) ? { x: f[0], y: f[1], w: f[2], h: f[3], title: f[4] } : null)),
            },
            "Shared board"
        );
    }

    shareBtn.addEventListener("click", async () => {
        if (!B.pins.length) return announce("Pin something first — an empty board has nothing to share");
        const label = shareBtn.firstChild;
        try {
            const url = `${location.origin}${location.pathname}#board=${await pack(packBoard())}`;
            let copied = false;
            try {
                await navigator.clipboard.writeText(url);
                copied = true;
            } catch (e) {}
            if (!copied) window.prompt("Copy this link to share the board:", url);
            const kb = Math.round(url.length / 1024);
            label.textContent = copied ? "Link copied ✓" : "Share";
            announce(copied ? `Share link copied${kb > 6 ? ` — it's long (${kb} KB), some chat apps may cut it` : ""}` : "Share link ready");
            setTimeout(() => (label.textContent = "Share"), 2200);
        } catch (err) {
            console.warn("[aperture] share failed:", err);
            announce("Couldn't make a share link in this browser");
        }
    });

    function enterShared(data) {
        readonly = true;
        B = data;
        reindex();
        board.classList.add("is-readonly");
        sharedBar.hidden = false;
        q("#pb-shared-name").textContent = data.name;
        closePop(false);
        render();
    }

    function leaveShared() {
        readonly = false;
        board.classList.remove("is-readonly");
        sharedBar.hidden = true;
        loadActive();
        loadView();
        syncSwitcher();
        render();
    }

    q("#pb-keep").addEventListener("click", () => {
        const copy = B;
        const id = uid();
        let name = copy.name;
        if (index.list.some((b) => b.name === name)) name = `${name} (shared)`;
        copy.name = name.slice(0, 60);
        readonly = false;
        board.classList.remove("is-readonly");
        sharedBar.hidden = true;
        store.set(bkey(id), copy);
        index.list.push({ id, name: copy.name });
        store.set(vkey(id), goal);
        switchBoard(id);
        announce(`Saved as “${copy.name}” in your boards`);
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
            console.warn("[aperture] shared board link is broken:", err);
            return;
        }
        // wait for the first page so the canvas (which hosts the board) can open
        const t0 = Date.now();
        const wait = setInterval(() => {
            const ready = state.photos.length && !document.body.classList.contains("is-loading") && window.canvasView?.open;
            if (!ready && Date.now() - t0 < 15000) return;
            clearInterval(wait);
            if (!ready) return;
            window.canvasView.open();
            setTimeout(() => {
                enterShared(data);
                if (board.hidden) openBoard();
                else fit(false);
            }, reduceMotion ? 0 : 1100);
        }, 100);
    }
    openSharedFromHash();
    window.addEventListener("hashchange", openSharedFromHash);

    /* ---------- export as an image ---------- */
    const loadImg = (src) =>
        new Promise((res) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            const t = setTimeout(() => res(null), 10000);
            img.onload = () => (clearTimeout(t), res(img));
            img.onerror = () => (clearTimeout(t), res(null));
            img.src = src;
        });

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

    q("#pb-image").addEventListener("click", async (e) => {
        const btn = e.currentTarget;
        const box = contentBox();
        if (!box) return announce("Nothing on the board to export yet");
        btn.disabled = true;
        announce("Rendering image…");
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

            const imgs = new Map(await Promise.all(B.pins.map(async (x) => [x.photo.id, await loadImg(cardSrc(x.photo))])));
            const order = cards().sort((a, b) => (+a.style.zIndex || 0) - (+b.style.zIndex || 0));
            order.forEach((el) => {
                const x = pinBy(el.dataset.id);
                if (!x) return;
                const w = el.offsetWidth;
                const h = el.offsetHeight;
                ctx.save();
                ctx.translate(el.offsetLeft + w / 2, el.offsetTop + h / 2);
                ctx.rotate(((x.r || 0) * Math.PI) / 180);
                ctx.translate(-w / 2, -h / 2);
                ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
                ctx.shadowBlur = 30;
                ctx.shadowOffsetY = 14;
                rrect(ctx, 0, 0, w, h, 3);
                ctx.fillStyle = paper;
                ctx.fill();
                ctx.shadowColor = "transparent";
                const iw = w - 20;
                const ih = iw * 1.25;
                ctx.fillStyle = x.photo.color;
                ctx.fillRect(10, 10, iw, ih);
                const img = imgs.get(x.photo.id);
                if (img) ctx.drawImage(img, 10, 10, iw, ih);
                ctx.textBaseline = "top";
                ctx.fillStyle = bg;
                ctx.font = `italic 19px ${serif}`;
                wrapText(ctx, x.note, 10, ih + 18, iw, 20, 2);
                ctx.font = `10px ${mono}`;
                ctx.fillStyle = "rgba(13, 12, 10, 0.55)";
                ctx.fillText(x.photo.user.name.toUpperCase(), 10, ih + 62, iw * 0.55);
                ctx.textAlign = "right";
                ctx.fillText(fromLabel(x).toUpperCase(), w - 10, ih + 62, iw * 0.42);
                ctx.restore();
            });

            ctx.save();
            ctx.strokeStyle = accent;
            ctx.lineWidth = 2.2;
            ctx.lineCap = "round";
            ctx.shadowColor = "rgba(0, 0, 0, 0.5)";
            ctx.shadowBlur = 4;
            ctx.shadowOffsetY = 4;
            B.threads.forEach((t) => {
                const a = pinPoint(t.a);
                const b = pinPoint(t.b);
                if (!a || !b) return;
                const c = ctrlOf(a, b);
                ctx.beginPath();
                ctx.moveTo(a[0], a[1]);
                ctx.quadraticCurveTo(c[0], c[1], b[0], b[1]);
                ctx.stroke();
            });
            ctx.restore();

            B.pins.forEach((x) => {
                const p = pinPoint(x.photo.id);
                if (!p) return;
                const g = ctx.createRadialGradient(p[0] - 3, p[1] - 3, 1, p[0], p[1], 8);
                g.addColorStop(0, "#ffb299");
                g.addColorStop(0.45, accent);
                g.addColorStop(1, "#b8340f");
                ctx.fillStyle = g;
                ctx.beginPath();
                ctx.arc(p[0], p[1], 8, 0, Math.PI * 2);
                ctx.fill();
            });

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
            ctx.fillText(`${B.name.toUpperCase()} — APERTURE · PHOTOS FROM UNSPLASH`, pad, H - 28);

            const blob = await new Promise((res) => cv.toBlob(res, "image/png"));
            if (!blob) throw new Error("toBlob failed");
            download(blob, `aperture-${slug(B.name)}.png`);
            announce("Image saved");
        } catch (err) {
            console.warn("[aperture] image export failed:", err);
            announce("Couldn't render the image");
        } finally {
            btn.disabled = false;
        }
    });

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

    window.pins = {
        has,
        toggle,
        count: () => B.pins.length,
        syncLightbox,
        isBoardOpen: () => !board.hidden,
        openBoard,
        closeBoard,
    };
})();
