/* ==========================================================
   APERTURE — editing a board together, live (roadmap #21)
   The owner can let signed-in people with a board's link edit it
   (Share panel → "Edit with you"). Everyone on the board then shares a
   private Realtime channel (the database lets in only the owner and
   editors) and sees each other's changes, cursors and dragged cards
   as they happen.

   Changes: pins.js tells us when the board on screen changed
   ("pins:edit"); we compare it with what was last sent, item by item,
   and send only the difference: { set, del, tset, tdel, fset, fdel, name }.
   What arrives goes through pins.live.apply(), which cleans it like any
   stored board. Uploaded images never travel: they live in the owner's
   private storage, so editors don't see them.

   Saving: the owner's copy syncs as usual (cloud.js). An editor saves the
   whole board through cloud.live.save(), which keeps the owner's uploads.

   Someone joining gets the board from whoever has been there longest, or
   from the database when nobody answers.
========================================================== */
(() => {
    const SEND_MS = 60; // gather a burst of local changes into one message
    const DRAG_MS = 50;
    const CURSOR_MS = 50;
    const SAVE_MS = 800;
    const ASK_MS = 1500; // a newcomer waits this long for someone to hand over the board
    const CURSOR_IDLE = 10000;
    const STATE_MAX = 250000; // bigger boards come from the database instead
    const COLORS = ["#ff5b2e", "#3fb6a8", "#f2c14e", "#8f7cf5", "#5ab0f0", "#e86a9a", "#7cc36a"];

    const q = (s) => document.querySelector(s);
    const P = () => window.pins?.live;
    const C = () => window.cloud;
    const sid = Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 14);

    let s = null; // the session: see start()
    let blocked = ""; // an edit link whose editing ended while open: don't rejoin it
    let reconT = 0;

    /* ---------- what's on screen, and what was last sent ---------- */

    // Items, threads and frames as JSON by key. Uploads (and threads tied to them)
    // are left out: they never leave the owner's devices.
    function snap(b) {
        const ups = new Set(b.pins.filter((x) => x.kind === "upload").map((x) => x.id));
        const tk = (t) => (t.a < t.b ? `${t.a}\n${t.b}` : `${t.b}\n${t.a}`);
        return {
            name: b.name,
            items: new Map(b.pins.filter((x) => !ups.has(x.id)).map((x) => [x.id, JSON.stringify(x)])),
            threads: new Map(b.threads.filter((t) => !ups.has(t.a) && !ups.has(t.b)).map((t) => [tk(t), JSON.stringify(t)])),
            frames: new Map(b.frames.map((f) => [f.id, JSON.stringify(f)])),
        };
    }

    function diff(a, b) {
        const op = {};
        const pairs = [
            ["items", "set", "del", (j) => JSON.parse(j).id],
            ["threads", "tset", "tdel", (j) => ((t) => ({ a: t.a, b: t.b }))(JSON.parse(j))],
            ["frames", "fset", "fdel", (j) => JSON.parse(j).id],
        ];
        for (const [k, set, del, idOf] of pairs) {
            const add = [];
            const gone = [];
            b[k].forEach((j, key) => a[k].get(key) !== j && add.push(JSON.parse(j)));
            a[k].forEach((j, key) => !b[k].has(key) && gone.push(idOf(j)));
            if (add.length) op[set] = add;
            if (gone.length) op[del] = gone;
        }
        if (a.name !== b.name) op.name = b.name;
        return Object.keys(op).length ? op : null;
    }

    // is the board on screen still the one this session is about?
    function onScreen(sess) {
        const p = P();
        if (!p || s !== sess) return false;
        if (sess.kind === "guest") return p.isGuest();
        return p.target()?.boardId === sess.boardId;
    }

    /* ---------- sending ---------- */

    function send(sess, event, payload) {
        if (!sess?.ready || !sess.ch) return;
        try {
            Promise.resolve(sess.ch.send(event, { from: sid, ...payload })).catch(() => {});
        } catch (e) {}
    }

    // send what changed here since the last message
    function flush(sess = s) {
        if (!sess || !sess.base) return;
        clearTimeout(sess.sendT);
        sess.sendT = 0;
        if (!onScreen(sess)) return;
        const now = snap(P().board());
        const op = diff(sess.base, now);
        if (!op) return;
        // not connected yet: an editor's change is saved now and sent once connected
        if (!sess.ready) return void (sess.kind === "guest" && saveSoon(sess));
        sess.base = now;
        send(sess, "op", { op });
        if (sess.kind === "guest") saveSoon(sess);
    }

    /* ---------- an editor saves ---------- */

    function saveSoon(sess, ms = SAVE_MS) {
        sess.dirty = true;
        clearTimeout(sess.saveT);
        sess.saveT = setTimeout(() => saveNow(sess), ms);
    }

    async function saveNow(sess) {
        clearTimeout(sess.saveT);
        if (!sess.dirty || sess.kind !== "guest" || !sess.room) return;
        if (sess.saving) return void (sess.again = true);
        const b = P()?.isGuest() ? P().board() : sess.last;
        if (!b) return;
        // copied now: the board may be gone (left, or saved as a copy) by the time this lands
        const data = JSON.parse(JSON.stringify({ name: b.name, pins: b.pins, threads: b.threads, frames: b.frames }));
        sess.dirty = false;
        sess.saving = true;
        try {
            await C().live.save(sess.room, data, Date.now());
            sess.failed = false;
        } catch (err) {
            if (/not allowed/i.test(String(err?.message || err))) return ended(sess, "link");
            sess.dirty = true;
            if (!sess.failed) window.toast?.("Your changes to this board haven't saved yet. Trying again…", "warn");
            sess.failed = true;
            window.reportProblem?.("live save failed", err);
            if (s === sess) saveSoon(sess, 4000);
        } finally {
            sess.saving = false;
            if (sess.again) {
                sess.again = false;
                saveNow(sess);
            }
        }
    }

    /* ---------- people and cursors ---------- */

    const hue = (id) => COLORS[[...String(id)].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];

    function myName() {
        const u = C()?.user?.();
        let saved = "";
        try {
            saved = localStorage.getItem("aperture:comment-name") || "";
        } catch (e) {}
        return String(u?.name || saved || "Guest").trim().slice(0, 40) || "Guest";
    }

    const okColor = (c) => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c : COLORS[0]);

    function renderPeople() {
        const ul = q("#pb-people");
        if (!ul) return;
        const mine = C()?.user?.()?.id;
        // the same account on another device is still "you"
        const list = s?.peers ? [...s.peers.values()].filter((p) => p.uid !== mine) : [];
        ul.textContent = "";
        ul.hidden = !list.length;
        if (!list.length) return;
        ul.setAttribute("aria-label", `${list.length} other ${list.length === 1 ? "person" : "people"} on this board`);
        list.slice(0, 5).forEach((p) => {
            const li = document.createElement("li");
            li.className = "pb-person";
            li.style.setProperty("--c", p.color);
            li.title = `${p.name}${p.owner ? " (owner)" : ""}`;
            const dot = document.createElement("span");
            dot.setAttribute("aria-hidden", "true");
            dot.textContent = (p.name.match(/\p{L}|\p{N}/u)?.[0] || "?").toUpperCase();
            const label = document.createElement("span");
            label.className = "sr-only";
            label.textContent = li.title;
            li.append(dot, label);
            ul.appendChild(li);
        });
        if (list.length > 5) {
            const li = document.createElement("li");
            li.className = "pb-person is-more";
            li.textContent = `+${list.length - 5}`;
            li.title = list
                .slice(5)
                .map((p) => p.name)
                .join(", ");
            ul.appendChild(li);
        }
    }

    let layer = null;
    const cursors = new Map(); // sid -> { el, x, y, t }

    function cursorLayer() {
        if (layer?.isConnected) return layer;
        const area = q("#pb-area");
        if (!area) return null;
        layer = document.createElement("div");
        layer.className = "pb-cursors";
        layer.setAttribute("aria-hidden", "true");
        area.appendChild(layer);
        return layer;
    }

    function placeCursor(c, v = P()?.view()) {
        if (!v) return;
        c.el.style.transform = `translate(${(v.x + c.x * v.z).toFixed(1)}px, ${(v.y + c.y * v.z).toFixed(1)}px)`;
    }

    function showCursor(from, x, y) {
        const peer = s?.peers.get(from);
        if (!peer) return;
        let c = cursors.get(from);
        if (x == null || y == null) {
            c?.el.remove();
            return cursors.delete(from);
        }
        if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e6 || Math.abs(y) > 1e6) return;
        if (!c) {
            const L = cursorLayer();
            if (!L) return;
            const el = document.createElement("div");
            el.className = "pb-cursor";
            el.innerHTML = '<svg viewBox="0 0 16 20" width="16" height="20"><path d="M1 1l13 10.5-6 .7L4.6 19z"/></svg><span></span>';
            L.appendChild(el);
            c = { el, x, y, t: 0 };
            cursors.set(from, c);
        }
        c.el.style.setProperty("--c", peer.color);
        c.el.lastElementChild.textContent = peer.name;
        c.x = x;
        c.y = y;
        c.t = Date.now();
        c.el.classList.remove("is-idle");
        placeCursor(c);
    }

    function clearCursors() {
        cursors.forEach((c) => c.el.remove());
        cursors.clear();
    }

    setInterval(() => {
        const now = Date.now();
        cursors.forEach((c, id) => {
            if (!s?.peers.has(id)) {
                c.el.remove();
                cursors.delete(id);
            } else if (now - c.t > CURSOR_IDLE) c.el.classList.add("is-idle");
        });
    }, 2000);

    /* ---------- the session ---------- */

    function handlers(sess) {
        const mine = () => s === sess;
        return {
            ready() {
                if (!mine()) return;
                sess.ready = true;
                sess.tries = 0;
                if (sess.kind === "guest") {
                    // ask the people already here for the board; the database is the fallback
                    sess.waiting = true;
                    clearTimeout(sess.askT);
                    sess.askT = setTimeout(() => fromDatabase(sess), ASK_MS);
                } else C().sync?.();
                flush(sess);
            },
            error(why) {
                if (!mine()) return;
                sess.ready = false;
                window.reportProblem?.("live channel", why);
                reconnect(sess);
            },
            presence(list) {
                if (!mine()) return;
                const before = sess.peers;
                const next = new Map();
                (Array.isArray(list) ? list : []).forEach((m) => {
                    if (!m || typeof m.sid !== "string" || m.sid === sid || next.has(m.sid)) return;
                    next.set(m.sid, { sid: m.sid, uid: String(m.uid || ""), name: String(m.name || "Guest").slice(0, 40), color: okColor(m.color), owner: m.owner === true, guest: m.owner !== true });
                });
                sess.peers = next;
                const fresh = [...next.keys()].filter((k) => !before.has(k));
                if (fresh.length) welcome(sess, fresh, [...before.keys()].filter((k) => next.has(k)));
                renderPeople();
            },
            message(event, p) {
                if (!mine() || !p || typeof p !== "object" || typeof p.from !== "string" || p.from === sid) return;
                if (event === "op" && p.op && typeof p.op === "object") {
                    if (!onScreen(sess)) return;
                    flush(sess); // ours first, so it isn't mistaken for theirs
                    P().apply(p.op);
                    sess.base = snap(P().board());
                } else if (event === "drag") {
                    if (onScreen(sess)) P().preview(p.list);
                } else if (event === "cursor") {
                    showCursor(p.from, p.x, p.y);
                } else if (event === "state" && p.to === sid && sess.waiting && p.board && typeof p.board === "object") {
                    sess.waiting = false;
                    clearTimeout(sess.askT);
                    if (!onScreen(sess)) return;
                    P().resetGuest(p.board);
                    sess.base = snap(P().board());
                } else if (event === "end" && sess.kind === "guest" && sess.peers.get(p.from)?.owner) {
                    ended(sess, p.reason === "off" ? "off" : "link");
                }
            },
        };
    }

    // people arrived: save what's pending, and the longest-present person hands guests the board
    function welcome(sess, fresh, stayed) {
        if (sess.kind === "guest" && sess.dirty) saveNow(sess);
        if (sess.kind === "owner") C().sync?.();
        flush(sess);
        const leader = [sid, ...stayed].sort()[0];
        if (leader !== sid || !onScreen(sess)) return;
        const b = P().board();
        const board = { name: b.name, pins: b.pins.filter((x) => x.kind !== "upload"), threads: b.threads, frames: b.frames };
        if (JSON.stringify(board).length > STATE_MAX) return;
        fresh.forEach((to) => sess.peers.get(to)?.guest && send(sess, "state", { to, board }));
    }

    async function fromDatabase(sess) {
        if (s !== sess || !sess.waiting) return;
        sess.waiting = false;
        try {
            const row = await C().live.board(sess.room);
            if (!onScreen(sess)) return;
            flush(sess);
            P().resetGuest(row.data);
            sess.base = snap(P().board());
        } catch (err) {
            if (s === sess && err?.status === "gone") ended(sess, "link");
        }
    }

    function reconnect(sess) {
        if (s !== sess) return;
        try {
            sess.ch?.leave();
        } catch (e) {}
        sess.ch = null;
        sess.tries = (sess.tries || 0) + 1;
        if (sess.tries > 5) {
            window.toast?.("Lost the live connection to this board. Reload the page to edit together again.", "warn");
            return;
        }
        clearTimeout(sess.retryT);
        sess.retryT = setTimeout(() => s === sess && connect(sess), 1500 * sess.tries);
    }

    function connect(sess) {
        const u = C().user();
        const me = { sid, uid: u?.id || "", name: myName(), color: hue(u?.id || sid), owner: sess.kind === "owner" };
        sess.ch = C().live.channel(sess.room, me, handlers(sess));
    }

    // editing ended under an editor: the owner turned it off, or changed the link or password
    function ended(sess, why) {
        if (s !== sess) return;
        if (sess.kind === "guest") {
            blocked = sess.code;
            P()?.leaveGuest();
            window.toast?.(why === "off" ? "The owner turned off editing. You can still view the board." : "The owner changed this board's link or password. Open the new link to keep editing.", "warn");
        }
        leave();
    }

    async function start(d) {
        const sess = { ...d, room: null, ch: null, base: null, peers: new Map(), ready: false, dirty: false };
        s = sess;
        try {
            if (d.kind === "owner") {
                const link = await C().share.get(d.boardId);
                if (s !== sess) return;
                sess.link = link;
                if (!link?.editable || !link.room) return void (sess.idle = true); // not an edit link: nothing to join
                sess.room = link.room;
            } else {
                const row = await C().live.join(d.code, d.password);
                if (s !== sess) return;
                if (!P().enterGuest(row.data, row.name)) return void (sess.idle = true);
                sess.room = row.room;
            }
        } catch (err) {
            if (s !== sess) return;
            sess.idle = true;
            if (d.kind === "guest") {
                blocked = d.code;
                P()?.sharedMode("view");
                if (err?.status !== "view") window.toast?.("Couldn't open this board for editing. You can still view it.", "warn");
            }
            if (!err?.status) window.reportProblem?.("live start", err);
            return;
        }
        sess.base = snap(P().board());
        connect(sess);
    }

    function leave() {
        const sess = s;
        if (!sess) return;
        flush(sess);
        if (sess.kind === "guest" && sess.dirty) saveNow(sess);
        [sess.sendT, sess.askT, sess.retryT, sess.dragT].forEach(clearTimeout);
        try {
            sess.ch?.leave();
        } catch (e) {}
        s = null;
        // still editing on screen (signed out, say): nothing would save it, so back to view only
        if (sess.kind === "guest" && P()?.isGuest()) P().leaveGuest();
        clearCursors();
        renderPeople();
    }

    function desired() {
        const p = P();
        const c = C();
        const t = p?.target();
        if (!t) return null;
        if (t.shared) {
            const code = t.shared.code;
            if (!t.shared.editable || code === blocked) return null;
            // signed out on an edit link: offer to sign in
            if (!c?.user?.()) {
                if (c?.state?.() !== "off") p.sharedMode("signin");
                return null;
            }
            return c.live?.available() ? { key: `g:${code}`, kind: "guest", code, password: t.shared.password } : null;
        }
        return c?.live?.available() ? { key: `o:${t.boardId}`, kind: "owner", boardId: t.boardId } : null;
    }

    function reconcile() {
        clearTimeout(reconT);
        reconT = setTimeout(() => {
            const d = desired();
            if ((d?.key || "") === (s?.key || "")) return;
            leave();
            if (d) start(d);
            else desired(); // sets the shared bar again ("sign in to edit") after leaving
        }, 30);
    }

    // the owner changed the share: tell editors if it ends their editing, then reconnect or stop
    async function shareChanged(boardId) {
        const sess = s;
        if (!sess || sess.kind !== "owner" || sess.boardId !== boardId) return reconcile();
        let link = null;
        try {
            link = await C().share.get(boardId);
        } catch (e) {
            return;
        }
        if (s !== sess) return;
        const was = sess.link;
        if (!!link?.editable === !!was?.editable && link?.room === was?.room) return void (sess.link = link);
        leave();
        reconcile();
    }

    /* ---------- wiring ---------- */

    document.addEventListener("pins:edit", () => {
        if (!s?.base) return;
        clearTimeout(s.sendT);
        s.sendT = setTimeout(() => flush(), SEND_MS);
    });
    // an editor leaves the board (closed it, or kept a copy): send and save while it's still on screen
    document.addEventListener("pins:guest-leave", () => {
        if (s?.kind !== "guest") return;
        flush(s);
        const b = P().board();
        s.last = { name: b.name, pins: b.pins, threads: b.threads, frames: b.frames };
        if (s.dirty) saveNow(s);
    });
    ["pins:context", "pins:open", "pins:close", "cloud:state"].forEach((t) => document.addEventListener(t, reconcile));
    document.addEventListener("share:changed", (e) => shareChanged(e.detail?.boardId));
    addEventListener("pagehide", () => s?.kind === "guest" && s.dirty && saveNow(s));

    // my cursor, in board coordinates (mouse and pen only: a finger isn't a pointer to follow)
    let cursorT = 0;
    let cursorAt = null;
    const area = q("#pb-area");
    area?.addEventListener("pointermove", (e) => {
        if (!s?.ready || e.pointerType === "touch") return;
        cursorAt = P().worldAt(e.clientX, e.clientY);
        if (cursorT) return;
        cursorT = setTimeout(() => {
            cursorT = 0;
            if (cursorAt) send(s, "cursor", { x: Math.round(cursorAt[0]), y: Math.round(cursorAt[1]) });
        }, CURSOR_MS);
    });
    area?.addEventListener("pointerleave", (e) => {
        if (!s?.ready || e.pointerType === "touch") return;
        clearTimeout(cursorT);
        cursorT = 0;
        cursorAt = null;
        send(s, "cursor", { x: null, y: null });
    });

    const startHooks = setInterval(() => {
        if (!P()) return;
        clearInterval(startHooks);
        P().onView((v) => cursors.forEach((c) => placeCursor(c, v)));
        reconcile();
    }, 50);

    window.live = {
        // pins.js calls this while cards are carried; `list` gives [[id, left, top]]
        dragging(list) {
            const sess = s;
            if (!sess?.ready || sess.dragT) return;
            sess.dragT = setTimeout(() => {
                sess.dragT = 0;
                if (s === sess && onScreen(sess)) send(sess, "drag", { list: list() });
            }, DRAG_MS);
        },
        // cloud.js calls this just before a share change that ends editors' editing ("off": editing
        // or sharing stops; "link": a new link or password), while the database still lets us send
        async ending(boardId, reason) {
            const sess = s;
            if (!sess?.ready || !sess.ch || sess.kind !== "owner" || sess.boardId !== boardId) return;
            try {
                await sess.ch.send("end", { from: sid, reason });
            } catch (e) {}
        },
        // for tests and the console
        status: () => (s ? { kind: s.kind, ready: !!s.ready, idle: !!s.idle, people: s.peers.size } : null),
    };
})();
