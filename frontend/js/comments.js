/* ==========================================================
   APERTURE — comments on shared boards (roadmap #20)
   A side panel on the board. On a /b/<code> link anyone who can open the
   board can read its comments; signed-in people can write (a comment can be
   about one card). The owner sees and answers them on their own board.
   Cards with comments get a small count badge (pins.js draws it).

   Data goes through window.cloud.comments (Supabase functions in
   backend/supabase/schema.sql). Hidden when accounts are off, and on
   #board= links, which have no server copy to comment on.
========================================================== */
(() => {
    const q = (s) => document.querySelector(s);
    const btn = q("#pb-comments-btn");
    const panel = q("#pb-comments");
    if (!btn || !panel) return;

    const el = {
        count: q("#pb-ccount"),
        close: panel.querySelector(".pbc-close"),
        status: q("#pbc-status"),
        list: q("#pbc-list"),
        form: q("#pbc-form"),
        on: q("#pbc-on"),
        onLabel: q("#pbc-on-label"),
        onClear: q("#pbc-on-clear"),
        body: q("#pbc-body"),
        name: q("#pbc-name"),
        post: q("#pbc-post"),
        error: q("#pbc-error"),
        signin: q("#pbc-signin"),
        signinBtn: q("#pbc-signin-btn"),
    };

    const NAME = "aperture:comment-name";
    const POLL = 20000;
    let target = null; // { code, password } or { boardId }
    let key = "";
    let rows = [];
    let forItem = null; // the card the next comment is about
    let pollT = 0;
    let returnFocus = null;

    const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
    const C = () => window.cloud?.comments;
    const me = () => window.cloud?.user?.() || null;
    const keyOf = (t) => (t ? (t.code ? `c:${t.code}` : `b:${t.boardId}`) : "");
    const mk = (tag, cls, text) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        return n;
    };
    const readName = () => {
        try {
            return localStorage.getItem(NAME) || "";
        } catch (e) {
            return "";
        }
    };
    const saveName = (v) => {
        try {
            localStorage.setItem(NAME, v);
        } catch (e) {}
    };

    function when(iso) {
        const t = new Date(iso);
        const s = (Date.now() - t.getTime()) / 1000;
        if (!Number.isFinite(s)) return "";
        if (s < 60) return "just now";
        if (s < 3600) return `${Math.floor(s / 60)} min ago`;
        if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
        return t.toLocaleDateString(undefined, { day: "numeric", month: "short", year: t.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
    }

    /* ---------- what's on screen ---------- */

    // own board: signed in only; shared board: anyone (reading)
    function refresh() {
        const t = window.pins?.commentTarget?.() || null;
        const ok = !!t && !!C()?.available?.() && (!!t.code || !!me());
        const next = ok ? t : null;
        const changed = keyOf(next) !== key || next?.password !== target?.password;
        target = next;
        key = keyOf(next);
        btn.hidden = !ok;
        if (!ok) {
            close(false);
            rows = [];
            paint();
            return;
        }
        if (changed) {
            rows = [];
            forItem = null;
            paint();
            load();
        } else syncComposer();
        poll();
    }

    async function load() {
        if (!target) return;
        const k = key;
        if (!panel.hidden && !rows.length) el.status.textContent = "Loading comments…";
        try {
            const list = await C().list(target);
            if (k !== key) return;
            rows = list;
            el.status.textContent = "";
        } catch (err) {
            if (k !== key) return;
            el.status.textContent = err?.status
                ? "This board isn't shared with you any more."
                : "Couldn't load comments. They'll try again shortly.";
            if (!err?.status) window.reportProblem?.("comments load", err);
        }
        paint();
    }

    function poll() {
        clearInterval(pollT);
        if (!target) return;
        pollT = setInterval(() => target && !document.hidden && window.pins?.isBoardOpen?.() && load(), POLL);
    }

    /* ---------- drawing ---------- */

    function paint() {
        const counts = new Map();
        rows.forEach((r) => r.item_id && counts.set(r.item_id, (counts.get(r.item_id) || 0) + 1));
        window.pins?.setCommentCounts?.(counts);
        el.count.textContent = rows.length ? String(rows.length) : "";
        btn.setAttribute("aria-label", rows.length ? `Comments (${rows.length})` : "Comments");

        el.list.textContent = "";
        if (!rows.length && !el.status.textContent) {
            el.list.append(mk("li", "pbc-empty", target?.code ? "No comments yet." : "No comments yet. People who open your share link can comment here."));
        }
        rows.forEach((r) => {
            const li = mk("li", "pbc-item");
            li.dataset.id = r.id;
            if (r.item_id) li.dataset.item = r.item_id;
            if (forItem && r.item_id === forItem) li.classList.add("is-focus");
            const meta = mk("p", "pbc-meta mono");
            meta.append(mk("b", "", r.author_name), mk("span", "", " · "));
            const time = mk("time", "", when(r.created_at));
            time.dateTime = r.created_at;
            time.title = new Date(r.created_at).toLocaleString();
            meta.append(time);
            if (r.can_delete) {
                const del = mk("button", "pbc-del", "Delete");
                del.type = "button";
                del.dataset.del = r.id;
                del.setAttribute("aria-label", `Delete ${r.mine ? "your" : `${r.author_name}'s`} comment`);
                meta.append(del);
            }
            li.append(meta);
            if (r.item_id) {
                const label = window.pins?.itemLabel?.(r.item_id);
                const chip = mk("button", "pbc-chip mono", label ? `On ${label}` : "On a card that's gone");
                chip.type = "button";
                chip.disabled = !label;
                chip.dataset.item = r.item_id;
                li.append(chip);
            }
            li.append(mk("p", "pbc-text", r.body));
            el.list.append(li);
        });
        syncComposer();
    }

    function syncComposer() {
        const u = me();
        const canWrite = !!u && !!target;
        el.form.hidden = !canWrite;
        el.signin.hidden = canWrite || !target;
        if (canWrite && !el.name.value) el.name.value = readName() || u.name || (u.email || "").split("@")[0].slice(0, 40);
        const label = forItem ? window.pins?.itemLabel?.(forItem) : null;
        if (forItem && !label) forItem = null;
        el.on.hidden = !forItem;
        el.onLabel.textContent = label ? `On ${label}` : "";
        el.body.placeholder = forItem ? "Comment on this card…" : "Comment on the board…";
    }

    /* ---------- open / close ---------- */

    // start below the board's header, so its buttons (Wall, Share, Save a copy…) stay usable
    function place() {
        const head = document.querySelector("#pb .pb-head");
        const host = panel.offsetParent;
        if (!head || !host) return;
        const top = Math.round(head.getBoundingClientRect().bottom - host.getBoundingClientRect().top + 8);
        panel.style.setProperty("--pbc-top", `${Math.max(8, top)}px`);
    }
    addEventListener("resize", () => !panel.hidden && place());

    function open(itemId) {
        refresh();
        if (!target) return;
        if (typeof itemId === "string") forItem = itemId;
        if (panel.hidden) {
            returnFocus = document.activeElement;
            panel.hidden = false;
            place();
            btn.setAttribute("aria-expanded", "true");
            if (!reduce() && window.gsap) gsap.fromTo(panel, { opacity: 0, x: 16 }, { opacity: 1, x: 0, duration: 0.35, ease: "expo.out" });
        }
        el.error.textContent = "";
        paint();
        load();
        const first = forItem && el.list.querySelector(`[data-item="${CSS.escape(forItem)}"]`);
        first?.scrollIntoView({ block: "nearest", behavior: reduce() ? "auto" : "smooth" });
        (!el.form.hidden ? el.body : !el.signin.hidden ? el.signinBtn : el.close).focus({ preventScroll: true });
    }

    function close(restore = true) {
        if (panel.hidden) return;
        panel.hidden = true;
        btn.setAttribute("aria-expanded", "false");
        forItem = null;
        el.error.textContent = "";
        if (restore && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    }

    btn.addEventListener("click", () => (panel.hidden ? open() : close()));
    el.close.addEventListener("click", () => close());

    /* ---------- writing ---------- */

    el.form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const body = el.body.value.trim();
        const name = el.name.value.trim();
        el.error.textContent = "";
        if (!name) return void ((el.error.textContent = "Add the name to show with your comment."), el.name.focus());
        if (!body) return void el.body.focus();
        el.post.disabled = true;
        try {
            await C().add(target, { itemId: forItem, name: name.slice(0, 40), body: body.slice(0, 1000) });
            saveName(name);
            el.body.value = "";
            forItem = null;
            await load();
            el.list.lastElementChild?.scrollIntoView({ block: "nearest" });
        } catch (err) {
            const m = String(err?.message || err || "");
            el.error.textContent = /sign in|not signed/.test(m)
                ? "Sign in again to comment."
                : /too many comments/.test(m)
                  ? "You've posted a lot just now. Wait a few minutes."
                  : /not shared|wrong password|not your board/.test(m)
                    ? "This board isn't open for comments any more."
                    : "Couldn't post that. Check your connection and try again.";
            window.reportProblem?.("comment post", err);
        } finally {
            el.post.disabled = false;
        }
    });

    // Ctrl/⌘+Enter posts
    el.body.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            el.form.requestSubmit();
        }
    });

    el.onClear.addEventListener("click", () => {
        forItem = null;
        paint();
        el.body.focus();
    });

    el.list.addEventListener("click", async (e) => {
        const chip = e.target.closest(".pbc-chip");
        if (chip && !chip.disabled) return void window.pins?.focusItem?.(chip.dataset.item);
        const del = e.target.closest("[data-del]");
        if (!del) return;
        if (!confirm("Delete this comment?")) return;
        del.disabled = true;
        try {
            await C().remove(del.dataset.del);
            await load();
            el.close.focus({ preventScroll: true });
        } catch (err) {
            del.disabled = false;
            el.error.textContent = "Couldn't delete that. Try again.";
            window.reportProblem?.("comment delete", err);
        }
    });

    el.signinBtn.addEventListener("click", () => window.cloud?.open?.());

    /* ---------- keyboard and events ---------- */

    // Escape closes the panel before the board (unless a dialog sits on top)
    window.addEventListener(
        "keydown",
        (e) => {
            if (e.key !== "Escape" || panel.hidden) return;
            if (!q("#acct")?.hidden || window.share?.isOpen?.()) return;
            if (document.querySelector(".pb-menu:not([hidden])")) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            close();
        },
        true
    );
    // typing here mustn't trigger board shortcuts; gestures here mustn't pan the board
    panel.addEventListener("keydown", (e) => e.key !== "Escape" && e.stopPropagation());
    panel.addEventListener("pointerdown", (e) => e.stopPropagation());
    panel.addEventListener("wheel", (e) => e.stopPropagation());

    document.addEventListener("pins:context", refresh);
    document.addEventListener("pins:open", refresh);
    document.addEventListener("pins:close", () => close(false));
    document.addEventListener("cloud:state", refresh);
    document.addEventListener("visibilitychange", () => !document.hidden && target && load());

    window.comments = {
        available: () => !!target,
        open,
        close,
        reload: load,
    };
})();
