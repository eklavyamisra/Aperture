/* ==========================================================
   APERTURE — share panel (roadmap #18–19)
   Signed in, the board's Share button opens this panel: make a short
   /b/<code> link, copy it, choose who can open it (anyone with the link,
   or only people with a password), swap it for a new link (the old one
   stops working) or stop sharing. The calls are window.cloud.share.

   Visitors who open a password-protected link get the "unlock" view of
   the same dialog. The password is POSTed to /api/board, never put in a URL.
   Signed out, pins.js keeps its one-click #board= link and this stays shut.
========================================================== */
(() => {
    const q = (s) => document.querySelector(s);
    const dlg = q("#share");
    if (!dlg) return;

    const el = {
        error: q("#share-error"),
        status: q("#share-status"),
        off: q("#share-off"),
        on: q("#share-on"),
        create: q("#share-create"),
        url: q("#share-url"),
        copy: q("#share-copy"),
        anyone: q("#share-anyone"),
        withPass: q("#share-withpass"),
        passForm: q("#share-pass-form"),
        pass: q("#share-pass"),
        passSave: q("#share-pass-save"),
        renew: q("#share-renew"),
        stop: q("#share-stop"),
        note: q("#share-note"),
        unlockForm: q("#share-unlock-form"),
        unlockPass: q("#share-unlock-pass"),
    };

    let returnFocus = null;
    let onClose = null; // the visitor closed the prompt: the waiting unlock() gets null
    let board = null; // { boardId, skipped } for the owner panel
    let link = null; // { url, code, protected } or null when not shared
    let choosing = false; // "password" picked, none saved yet
    let busy = false;

    const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
    const focus = (node) => node?.focus({ preventScroll: true });

    function show(view) {
        dlg.dataset.mode = view;
        dlg.querySelectorAll("[data-view]").forEach((v) => (v.hidden = v.dataset.view !== view));
    }

    function openAs(view) {
        if (dlg.hidden) returnFocus = document.activeElement;
        el.error.textContent = "";
        dlg.hidden = false;
        show(view);
        if (!reduce() && window.gsap) gsap.fromTo(dlg.querySelector(".acct-card"), { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.35, ease: "expo.out" });
    }

    function close() {
        if (dlg.hidden) return;
        dlg.hidden = true;
        el.error.textContent = "";
        el.pass.value = "";
        board = null;
        const cb = onClose;
        onClose = null;
        cb?.();
        if (returnFocus?.isConnected) focus(returnFocus);
    }

    /* ---------- owner ---------- */

    function render() {
        const on = !!link;
        el.off.hidden = on;
        el.on.hidden = !on;
        if (!on) {
            el.status.textContent = "Only you can see this board. A link lets anyone who has it view the board, but not change it.";
        } else {
            const wantPass = link.protected || choosing;
            el.url.value = link.url;
            el.anyone.checked = !wantPass;
            el.withPass.checked = wantPass;
            el.passForm.hidden = !wantPass;
            el.passSave.textContent = link.protected ? "Change" : "Set password";
            el.pass.placeholder = link.protected ? "New password" : "Password (4 or more characters)";
            el.status.textContent = link.protected
                ? "Only people with the link and the password can view this board."
                : "Anyone with the link can view this board, but not change it.";
        }
        const n = board?.skipped || 0;
        el.note.textContent = `${on ? "Viewers see your edits once they've synced. " : ""}${n ? `${n} uploaded image${n === 1 ? " isn't" : "s aren't"} shown on shared boards.` : ""}`.trim();
    }

    function fail(err) {
        const m = String(err?.message || err || "");
        el.error.textContent = /4 to 72/.test(m) ? "Use a password of 4 to 72 characters." : "That didn't work. Check your connection and try again.";
        window.reportProblem?.("share panel", err);
    }

    // one change at a time; buttons are disabled meanwhile. true when it worked
    async function run(job) {
        if (busy || !board) return false;
        let ok = false;
        busy = true;
        el.error.textContent = "";
        dlg.querySelectorAll("[data-view=owner] button, [data-view=owner] input").forEach((b) => (b.disabled = true));
        try {
            const id = board.boardId;
            const next = await job(id);
            if (board?.boardId === id) link = next;
            ok = true;
        } catch (err) {
            fail(err);
        } finally {
            busy = false;
            dlg.querySelectorAll("[data-view=owner] button, [data-view=owner] input").forEach((b) => (b.disabled = false));
            el.url.disabled = false;
            if (board) render();
        }
        return ok;
    }

    async function open({ boardId, skipped = 0 }) {
        if (!window.cloud?.user?.()) return false;
        board = { boardId, skipped };
        link = null;
        choosing = false;
        openAs("owner");
        el.off.hidden = el.on.hidden = true;
        el.status.textContent = "Checking this board's link…";
        el.note.textContent = "";
        await run((id) => window.cloud.share.get(id));
        focus(link ? el.copy : el.create);
        return true;
    }

    el.create.addEventListener("click", async () => {
        await run((id) => window.cloud.share.create(id));
        if (link) focus(el.copy);
    });

    el.copy.addEventListener("click", async () => {
        if (!link) return;
        try {
            await navigator.clipboard.writeText(link.url);
            el.copy.textContent = "Copied ✓";
            setTimeout(() => (el.copy.textContent = "Copy"), 2000);
        } catch (e) {
            el.url.select();
            el.error.textContent = `Couldn't copy here. The link is selected: press ${/Mac|iP/.test(navigator.platform) ? "⌘" : "Ctrl"}+C.`;
        }
    });
    el.url.addEventListener("focus", () => el.url.select());

    el.anyone.addEventListener("change", () => {
        choosing = false;
        if (link?.protected) run((id) => window.cloud.share.setPassword(id, null));
        else render();
    });
    el.withPass.addEventListener("change", () => {
        choosing = true;
        render();
        focus(el.pass);
    });

    el.passForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const pw = el.pass.value;
        if (pw.length < 4 || new TextEncoder().encode(pw).length > 72) return void (el.error.textContent = "Use a password of 4 to 72 characters.");
        if (await run((id) => window.cloud.share.setPassword(id, pw))) {
            el.pass.value = "";
            choosing = false;
            render();
            window.toast?.("Password set. Send it separately from the link.");
        }
    });

    el.renew.addEventListener("click", () => {
        if (!confirm("Make a new link? The current one stops working for everyone who has it.")) return;
        run((id) => window.cloud.share.renew(id));
    });

    el.stop.addEventListener("click", async () => {
        if (!confirm("Stop sharing this board? The link stops working for everyone who has it.")) return;
        await run((id) => window.cloud.share.stop(id));
        if (!link) focus(el.create);
    });

    /* ---------- visitor: unlock a password-protected board ---------- */

    // resolves to { name, data } once the right password is given, or null if the prompt is closed
    function unlock(code) {
        return new Promise((resolve) => {
            openAs("unlock");
            onClose = () => resolve(null);
            el.unlockPass.value = "";
            focus(el.unlockPass);
            el.unlockForm.onsubmit = async (e) => {
                e.preventDefault();
                const password = el.unlockPass.value;
                if (!password) return;
                const btn = el.unlockForm.querySelector("button");
                btn.disabled = true;
                el.error.textContent = "";
                try {
                    const r = await fetch("/api/board", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, password }) });
                    if (r.ok) {
                        const shared = await r.json();
                        onClose = null;
                        close();
                        // the password comes along so comments on this board can use it (#20)
                        return resolve({ ...shared, password });
                    }
                    el.error.textContent =
                        { 403: "That password isn't right.", 429: "Too many wrong tries. Wait 15 minutes, then try again.", 404: "This board isn't shared any more." }[r.status] ||
                        "Couldn't check the password. Try again in a moment.";
                    el.unlockPass.select();
                } catch (err) {
                    el.error.textContent = "Couldn't check the password. Try again in a moment.";
                } finally {
                    btn.disabled = false;
                }
            };
        });
    }

    /* ---------- dialog plumbing ---------- */

    dlg.querySelector(".acct-close").addEventListener("click", close);
    dlg.addEventListener("click", (e) => e.target === dlg && close());
    // on window, capturing, so it runs before the board's and the wall's own Escape handling
    window.addEventListener(
        "keydown",
        (e) => {
            if (e.key !== "Escape" || dlg.hidden) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            close();
        },
        true
    );
    // keep board shortcuts (N, Delete…) and canvas gestures away from the dialog
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    dlg.addEventListener("pointerdown", (e) => e.stopPropagation());
    dlg.addEventListener("wheel", (e) => e.stopPropagation());

    window.share = { open, close, unlock, isOpen: () => !dlg.hidden };
})();
