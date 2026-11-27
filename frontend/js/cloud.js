/* ==========================================================
   APERTURE — accounts and cloud sync (roadmap #15–17)
   Boards stay offline-first: the browser copy is the one you edit, and
   this mirrors it to Supabase. Each board carries its last-edit time and
   the newer copy wins. Deletes leave a tombstone so other devices drop the
   board too. Uploaded images go to a private storage bucket under the
   user's id. A board can also get a short share link (/b/<code>, #18)
   that always shows its latest synced copy.

   Off unless /api/config returns Supabase settings: then the account
   button stays hidden and nothing here runs. Tests swap in their own
   backend through window.__apertureBackend.
========================================================== */
(() => {
    const SDK = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js";
    const TOMBS = "aperture:cloud-tombstones"; // { boardId: deletedAt } not yet sent
    const SENT = "aperture:cloud-blobs"; // upload ids already in storage
    const OWNER = "aperture:cloud-owner"; // whose boards this device holds
    const PUSH_DELAY = 1500;
    const POLL = 45000;

    const read = (k, fb) => {
        try {
            return JSON.parse(localStorage.getItem(k)) ?? fb;
        } catch (e) {
            return fb;
        }
    };
    const write = (k, v) => {
        try {
            if (v == null) localStorage.removeItem(k);
            else localStorage.setItem(k, JSON.stringify(v));
        } catch (e) {}
    };
    const q = (s) => document.querySelector(s);

    let backend = null;
    let user = null; // { id, email }
    let state = "off"; // off | out | syncing | synced | offline | error
    let running = null; // the sync in progress
    let lastError = ""; // shown in the account panel so a failed sync says why
    let again = false;
    let pushT = 0;
    let pollT = 0;

    /* ---------- backends ---------- */

    function loadScript(src) {
        return new Promise((res, rej) => {
            const s = document.createElement("script");
            s.src = src;
            s.onload = res;
            s.onerror = () => rej(new Error("couldn't load the sign-in library"));
            document.head.appendChild(s);
        });
    }

    async function supabaseBackend({ url, anonKey }) {
        await loadScript(SDK);
        const sb = window.supabase.createClient(url, anonKey, {
            auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "aperture:auth" },
        });
        const who = (s) => (s?.user ? { id: s.user.id, email: s.user.email || "" } : null);
        const must = ({ data, error }) => {
            if (error) throw error;
            return data;
        };
        const back = `${location.origin}/`;
        return {
            async session() {
                return who(must(await sb.auth.getSession()).session);
            },
            onChange(cb) {
                sb.auth.onAuthStateChange((_event, s) => cb(who(s)));
            },
            async signInEmail(email) {
                must(await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: back } }));
            },
            async signInGoogle() {
                must(await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: back } }));
            },
            async signOut() {
                await sb.auth.signOut();
            },
            async list() {
                return must(await sb.from("boards").select("id, updated, deleted"));
            },
            async get(ids) {
                return must(await sb.from("boards").select("id, data, updated").in("id", ids));
            },
            async upsert(rows) {
                must(await sb.from("boards").upsert(rows.map((r) => ({ ...r, owner: user.id })), { onConflict: "owner,id" }));
            },
            async putBlob(path, blob) {
                must(await sb.storage.from("uploads").upload(path, blob, { upsert: true, contentType: blob.type || "image/webp" }));
            },
            async getBlob(path) {
                const { data, error } = await sb.storage.from("uploads").download(path);
                return error ? null : data;
            },
            async findShare(boardId) {
                const rows = must(await sb.from("shares").select("code").eq("board_id", boardId).limit(1));
                return rows[0]?.code || null;
            },
            async createShare(code, boardId) {
                must(await sb.from("shares").insert({ code, board_id: boardId, owner: user.id }));
            },
            async wipe() {
                must(await sb.from("boards").delete().eq("owner", user.id));
                const files = must(await sb.storage.from("uploads").list(user.id, { limit: 1000 }));
                if (files.length) must(await sb.storage.from("uploads").remove(files.map((f) => `${user.id}/${f.name}`)));
            },
        };
    }

    /* ---------- sync ---------- */

    const uploadsIn = (data) => (data?.pins || []).filter((x) => x.kind === "upload").map((x) => x.id);
    const blobPath = (id) => `${user.id}/${id}`;

    async function pushMedia(data) {
        const sent = new Set(read(SENT, []));
        for (const id of uploadsIn(data)) {
            if (sent.has(id)) continue;
            const blob = await window.media?.get(id).catch(() => null);
            if (!blob) continue;
            await backend.putBlob(blobPath(id), blob);
            sent.add(id);
            write(SENT, [...sent]);
        }
    }

    async function pullMedia(data) {
        const sent = new Set(read(SENT, []));
        for (const id of uploadsIn(data)) {
            if (await window.media?.get(id).catch(() => null)) continue;
            const blob = await backend.getBlob(blobPath(id)).catch(() => null);
            if (!blob) continue;
            await window.media.put(id, blob);
            sent.add(id);
            window.pins.local.mediaArrived(id);
        }
        write(SENT, [...sent]);
    }

    // resolves once this device and the account agree (including a re-run asked for meanwhile)
    function sync() {
        if (!user || !backend || !window.pins?.local) return Promise.resolve();
        if (running) {
            again = true;
            return running;
        }
        running = run().finally(() => {
            running = null;
            if (again) {
                again = false;
                return sync();
            }
        });
        return running;
    }

    async function run() {
        setState("syncing");
        const L = window.pins.local;
        try {
            // boards deleted here since the last sync
            const tombs = read(TOMBS, {});
            const dead = Object.entries(tombs).map(([id, at]) => ({ id, name: "", data: null, updated: at, deleted: true }));
            if (dead.length) {
                await backend.upsert(dead);
                write(TOMBS, {});
            }

            const remote = await backend.list();
            const rmap = new Map(remote.map((r) => [r.id, r]));
            const locals = L.list();
            const lmap = new Map(locals.map((b) => [b.id, b]));
            const pull = [];
            const drop = [];
            const push = new Set();

            for (const r of remote) {
                const l = lmap.get(r.id);
                if (r.deleted) {
                    // edited here after it was deleted elsewhere: keep it
                    if (l && l.updated > r.updated) push.add(l.id);
                    else if (l) drop.push(l.id);
                } else if (!l || r.updated > l.updated) pull.push(r.id);
            }
            for (const l of locals) {
                if (!l.updated && l.empty) continue; // the untouched starter board
                const r = rmap.get(l.id);
                if (!r || (!r.deleted && l.updated > r.updated)) push.add(l.id);
            }

            if (pull.length) {
                for (const row of await backend.get(pull)) {
                    L.put(row.id, row.data, Number(row.updated) || 0);
                    await pullMedia(row.data);
                }
            }
            drop.forEach((id) => L.remove(id));
            // the account already has boards: this device's empty starter board isn't needed
            if (remote.some((r) => !r.deleted)) L.list().forEach((b) => !b.updated && b.empty && L.list().length > 1 && L.remove(b.id));

            const rows = [];
            for (const id of push) {
                const data = L.get(id);
                const meta = L.list().find((b) => b.id === id);
                if (!data || !meta) continue;
                await pushMedia(data);
                rows.push({ id, name: data.name, data, updated: meta.updated, deleted: false });
            }
            if (rows.length) await backend.upsert(rows);
            lastError = "";
            setState("synced");
        } catch (err) {
            lastError = String(err?.message || err || "").slice(0, 160);
            setState(navigator.onLine === false ? "offline" : "error");
            window.reportProblem?.("cloud sync failed", err);
        }
    }

    const soon = (ms = PUSH_DELAY) => {
        clearTimeout(pushT);
        pushT = setTimeout(sync, ms);
    };

    document.addEventListener("pins:changed", () => user && soon());
    document.addEventListener("pins:deleted", (e) => {
        if (!user) return;
        const tombs = read(TOMBS, {});
        tombs[e.detail.id] = e.detail.at;
        write(TOMBS, tombs);
        soon(300);
    });
    document.addEventListener("visibilitychange", () => user && !document.hidden && soon(200));
    addEventListener("online", () => user && soon(200));

    function poll() {
        clearInterval(pollT);
        pollT = setInterval(() => user && !document.hidden && sync(), POLL);
    }

    /* ---------- short share links (#18) ---------- */

    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    function newCode(n = 10) {
        let out = "";
        while (out.length < n) {
            for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) {
                if (b < 248 && out.length < n) out += ALPHABET[b % 62]; // 248 = 4 × 62, keeps it uniform
            }
        }
        return out;
    }

    // "/b/<code>" for this board, made on first use. The board is synced first, so
    // the link shows what's on screen. null when signed out (pins.js falls back to
    // a #board= link); throws if the account can't be reached.
    async function shareLink(boardId) {
        if (!user || !backend?.createShare) return null;
        await sync();
        if (state !== "synced") throw new Error(lastError || "couldn't sync the board");
        let code = await backend.findShare(boardId);
        if (!code) {
            try {
                await backend.createShare(newCode(), boardId);
            } catch (err) {
                // made meanwhile (a second click, another device): use that one
                if (!(await backend.findShare(boardId))) throw err;
            }
            code = await backend.findShare(boardId);
        }
        return `${location.origin}/b/${code}`;
    }

    /* ---------- sign in / out ---------- */

    async function signedIn(u) {
        const first = !user;
        user = u;
        const owner = read(OWNER, null);
        // another account's boards were left on this device (its session expired): don't mix them in
        if (owner && owner !== u.id) {
            window.pins.local.reset();
            write(SENT, []);
            write(TOMBS, {});
        }
        write(OWNER, u.id);
        render();
        if (first) {
            if (!owner) window.toast?.(`Signed in as ${u.email}. Your boards on this device are moving to your account.`);
            await sync();
            poll();
        }
    }

    // `clear`: the person chose to sign out, so this device's copy goes (the account keeps it).
    // A session that simply ended keeps the boards here; the next sign-in syncs them.
    function signedOut(clear) {
        if (!user) return render();
        user = null;
        clearInterval(pollT);
        clearTimeout(pushT);
        if (clear) {
            window.pins.local.reset();
            write(SENT, []);
            write(TOMBS, {});
            write(OWNER, null);
        } else window.toast?.("You've been signed out. Sign in again to keep your boards in sync.", "warn");
        setState("out");
    }

    /* ---------- UI ---------- */

    const btn = q("#pb-account");
    const dlg = q("#acct");
    let returnFocus = null;

    const LABEL = { syncing: "Syncing…", synced: "Synced", offline: "Offline", error: "Sync failed" };

    function setState(s) {
        state = s;
        render();
    }

    function render() {
        if (!btn || !dlg) return;
        btn.hidden = state === "off";
        if (user) {
            btn.dataset.state = state;
            btn.querySelector(".pb-account-label").textContent = LABEL[state] || "Account";
            btn.setAttribute("aria-label", `Account: ${user.email}. ${LABEL[state] || ""}`);
        } else {
            btn.dataset.state = "out";
            btn.querySelector(".pb-account-label").textContent = "Sign in";
            btn.setAttribute("aria-label", "Sign in to sync your boards");
        }
        q("#acct-who").textContent = user?.email || "";
        q("#acct-status").textContent =
            { syncing: "Syncing your boards…", synced: "All boards are saved to your account.", offline: "You're offline. Changes will sync when you're back.", error: `The last sync didn't go through. It will try again shortly.${lastError ? ` (${lastError})` : ""}` }[state] || "";
        if (dlg.hidden) return;
        show(user ? "in" : dlg.dataset.mode === "sent" ? "sent" : "out");
    }

    function show(view) {
        const changed = dlg.dataset.mode !== view;
        dlg.dataset.mode = view;
        dlg.querySelectorAll("[data-view]").forEach((v) => (v.hidden = v.dataset.view !== view));
        // the view swapped under the keyboard: keep focus inside the dialog
        if (changed && !dlg.contains(document.activeElement)) {
            (dlg.querySelector(`[data-view="${view}"] input, [data-view="${view}"] button`) || dlg.querySelector(".acct-close")).focus({ preventScroll: true });
        }
    }

    function open() {
        returnFocus = document.activeElement;
        dlg.hidden = false;
        dlg.dataset.mode = "";
        show(user ? "in" : "out");
        render();
        if (!matchMedia("(prefers-reduced-motion: reduce)").matches && window.gsap) gsap.fromTo(dlg.querySelector(".acct-card"), { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.35, ease: "expo.out" });
    }

    function close() {
        if (dlg.hidden) return;
        dlg.hidden = true;
        q("#acct-error").textContent = "";
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    }

    function fail(err) {
        q("#acct-error").textContent = err?.message?.includes("rate") ? "Too many tries. Wait a minute and try again." : "That didn't work. Check your connection and try again.";
    }

    btn?.addEventListener("click", () => (dlg.hidden ? open() : close()));
    dlg?.addEventListener("click", (e) => e.target === dlg && close());
    dlg?.querySelector(".acct-close").addEventListener("click", close);
    // Escape closes the dialog first (not the board), wherever focus is
    document.addEventListener(
        "keydown",
        (e) => {
            if (e.key !== "Escape" || !dlg || dlg.hidden) return;
            e.preventDefault();
            e.stopImmediatePropagation();
            close();
        },
        true
    );
    // keep board shortcuts (N, Delete…) away while typing in the dialog
    dlg?.addEventListener("keydown", (e) => e.stopPropagation());
    dlg?.addEventListener("pointerdown", (e) => e.stopPropagation());

    q("#acct-form")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const email = q("#acct-email").value.trim();
        if (!email) return;
        const b = e.submitter || q("#acct-form button");
        b.disabled = true;
        q("#acct-error").textContent = "";
        try {
            await backend.signInEmail(email);
            q("#acct-sent-to").textContent = email;
            if (!user) show("sent");
        } catch (err) {
            fail(err);
        } finally {
            b.disabled = false;
        }
    });
    q("#acct-google")?.addEventListener("click", async () => {
        q("#acct-error").textContent = "";
        try {
            await backend.signInGoogle();
        } catch (err) {
            fail(err);
        }
    });
    q("#acct-back")?.addEventListener("click", () => show("out"));
    q("#acct-sync")?.addEventListener("click", () => sync());
    let signingOut = false;
    q("#acct-signout")?.addEventListener("click", async () => {
        signingOut = true;
        await backend.signOut().catch(() => {});
        signingOut = false;
        signedOut(true);
        close();
        window.toast?.("Signed out. Your boards are safe in your account.");
    });
    q("#acct-wipe")?.addEventListener("click", async () => {
        if (!confirm("Delete every board and image saved in your account? Boards on this device go too. This can't be undone.")) return;
        try {
            await backend.wipe();
            signingOut = true;
            await backend.signOut().catch(() => {});
            signingOut = false;
            signedOut(true);
            close();
            window.toast?.("Your cloud boards and images are deleted.");
        } catch (err) {
            fail(err);
        }
    });

    /* ---------- start ---------- */

    async function start() {
        try {
            if (window.__apertureBackend) backend = window.__apertureBackend;
            else {
                const cfg = await fetch("/api/config").then((r) => (r.ok ? r.json() : {}));
                if (!cfg?.supabase) return; // accounts not set up: stay local-only
                backend = await supabaseBackend(cfg.supabase);
            }
        } catch (err) {
            window.reportProblem?.("cloud unavailable", err);
            return;
        }
        setState("out");
        backend.onChange((u) => (u ? signedIn(u) : signingOut || signedOut(false)));
        const u = await backend.session().catch(() => null);
        if (u) signedIn(u);
    }

    window.cloud = { sync, shareLink, state: () => state, user: () => user, open, close };
    start();
})();
