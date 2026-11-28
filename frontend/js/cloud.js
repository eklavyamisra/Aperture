/* ==========================================================
   APERTURE — accounts and cloud sync (roadmap #15–17)
   Boards stay offline-first: the browser copy is the one you edit, and
   this mirrors it to Supabase. Each board carries its last-edit time and
   the newer copy wins. Deletes leave a tombstone so other devices drop the
   board too. Uploaded images go to a private storage bucket under the
   user's id. A board can also get a short share link (/b/<code>, #18)
   that always shows its latest synced copy, optionally behind a password
   (#19). The Share panel for that is share.js; this holds the calls, and
   the ones for comments on shared boards (#20, comments.js) and for
   editing a shared board together (#21, live.js: edit links, saving,
   the private Realtime channel).

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
        const who = (s) => {
            if (!s?.user) return null;
            const meta = s.user.user_metadata || {};
            return { id: s.user.id, email: s.user.email || "", name: String(meta.full_name || meta.name || "").slice(0, 40) };
        };
        const must = ({ data, error }) => {
            if (error) throw error;
            return data;
        };
        // Signing in leaves the page (email link, Google) and comes back as a fresh load. Come
        // back to the same place: the shared board, or the search and wall view in the address
        // (needs "<site>/**" in Supabase's Redirect URLs; otherwise Supabase uses the site root).
        // Whether the board was open isn't in the address, so it's noted for afterwards.
        const back = () => {
            remember();
            if (location.pathname.startsWith("/b/")) return `${location.origin}${location.pathname}`;
            return `${location.origin}/${location.search}`;
        };
        return {
            async session() {
                return who(must(await sb.auth.getSession()).session);
            },
            onChange(cb) {
                // supabase-js runs these callbacks inside its auth lock and waits for them, and
                // every query needs that lock: so react only after the callback has returned,
                // or the first sync waits on itself forever ("Syncing…" that never ends)
                sb.auth.onAuthStateChange((_event, s) => {
                    const u = who(s);
                    setTimeout(() => cb(u), 0);
                });
            },
            async signInEmail(email) {
                must(await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: back() } }));
            },
            async signInGoogle() {
                must(await sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: back() } }));
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
                let r = await sb.from("shares").select("code, protected, can_edit, room").eq("board_id", boardId).limit(1);
                // the database doesn't have #21's columns yet (schema.sql not re-run): links still work, view-only
                if (r.error && /can_edit|room/.test(r.error.message || "")) r = await sb.from("shares").select("code, protected").eq("board_id", boardId).limit(1);
                return must(r)[0] || null;
            },
            async setShareEditable(boardId, on) {
                must(await sb.from("shares").update({ can_edit: !!on }).eq("board_id", boardId));
            },
            // #21: editing together
            async joinBoard(code, password) {
                const rows = must(await sb.rpc("join_board", { share_code: code, password: password ?? null }));
                return rows?.[0] || null;
            },
            async liveBoard(room) {
                const rows = must(await sb.rpc("live_board", { room_id: room }));
                return rows?.[0] || null;
            },
            async saveLive(room, data, edited) {
                return must(await sb.rpc("save_live_board", { room_id: room, board: data, edited }));
            },
            // A private Realtime channel for one board (the database lets in only its
            // owner and editors). h: { message(event, payload), presence(list), ready(), error(why) }
            channel(room, me, h) {
                const ch = sb.channel(`board:${room}`, { config: { private: true, broadcast: { self: false }, presence: { key: me.sid } } });
                let left = false;
                ch.on("broadcast", { event: "*" }, (m) => h.message(m.event, m.payload));
                ch.on("presence", { event: "sync" }, () => h.presence(Object.values(ch.presenceState()).map((a) => a[0])));
                ch.subscribe(async (status, err) => {
                    if (left) return;
                    if (status === "SUBSCRIBED") {
                        await ch.track(me);
                        h.ready();
                    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") h.error(String(err?.message || status));
                });
                return {
                    send: (event, payload) => ch.send({ type: "broadcast", event, payload }),
                    leave() {
                        left = true;
                        sb.removeChannel(ch);
                    },
                };
            },
            async createShare(code, boardId) {
                must(await sb.from("shares").insert({ code, board_id: boardId, owner: user.id }));
            },
            async renameShare(boardId, code) {
                must(await sb.from("shares").update({ code }).eq("board_id", boardId));
            },
            async setSharePassword(boardId, password) {
                must(await sb.rpc("set_share_password", { board: boardId, password }));
            },
            async deleteShare(boardId) {
                must(await sb.from("shares").delete().eq("board_id", boardId));
            },
            async shareComments(code, password) {
                return must(await sb.rpc("share_comments", { share_code: code, password: password ?? null }));
            },
            async boardComments(boardId) {
                return must(await sb.rpc("board_comments", { board: boardId }));
            },
            async addComment(where, c) {
                if (where.code) must(await sb.rpc("add_comment", { share_code: where.code, password: where.password ?? null, item: c.itemId ?? null, name: c.name, body: c.body }));
                else must(await sb.rpc("add_board_comment", { board: where.boardId, item: c.itemId ?? null, name: c.name, body: c.body }));
            },
            async deleteComment(id) {
                must(await sb.rpc("delete_comment", { comment: id }));
            },
            // #33: the creators' library. Rows are locked to their creator by row-level
            // security; only approved creators can add photos or files (schema.sql).
            async creatorMe() {
                return must(await sb.from("creators").select("username, name, bio, location, link, avatar, status").eq("id", user.id).maybeSingle());
            },
            async creatorApply(row) {
                must(await sb.from("creators").insert({ ...row, id: user.id }));
            },
            async creatorUpdate(fields) {
                must(await sb.from("creators").update(fields).eq("id", user.id));
            },
            async myPhotos() {
                return must(
                    await sb
                        .from("photos")
                        .select("id, title, alt, tags, width, height, color, tone, license, published, hidden, created_at")
                        .eq("creator", user.id)
                        .order("created_at", { ascending: false })
                        .limit(2000)
                );
            },
            async addPhoto(row) {
                must(await sb.from("photos").insert(row));
            },
            async updatePhoto(id, fields) {
                must(await sb.from("photos").update(fields).eq("id", id));
            },
            async deletePhoto(id) {
                must(await sb.from("photos").delete().eq("id", id));
                await sb.storage.from("library").remove(["s", "m", "l"].map((k) => `${user.id}/${id}/${k}.webp`));
            },
            async putLibraryFile(path, blob, long) {
                must(await sb.storage.from("library").upload(path, blob, { upsert: true, contentType: blob.type || "image/webp", cacheControl: long ? "31536000" : "3600" }));
            },
            libraryBase: () => `${url}/storage/v1/object/public/library/`,
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

    const linkOf = (row) => (row ? { url: `${location.origin}/b/${row.code}`, code: row.code, protected: !!row.protected, editable: !!row.can_edit, room: row.room || null } : null);
    // live.js reconnects (or leaves) when the owner changes who can edit
    const shareChanged = (boardId) => document.dispatchEvent(new CustomEvent("share:changed", { detail: { boardId } }));

    function needAccount() {
        if (!user || !backend?.createShare) throw new Error("not signed in");
    }

    // Each returns this board's link as { url, code, protected, editable, room }, or null when it isn't shared.
    const share = {
        async get(boardId) {
            needAccount();
            return linkOf(await backend.findShare(boardId));
        },
        // made once per board; the board is synced first so the link shows what's on screen
        async create(boardId) {
            needAccount();
            await sync();
            if (state !== "synced") throw new Error(lastError || "couldn't sync the board");
            const had = await backend.findShare(boardId);
            if (had) return linkOf(had);
            try {
                await backend.createShare(newCode(), boardId);
            } catch (err) {
                // made meanwhile (a second click, another device): use that one
                if (!(await backend.findShare(boardId))) throw err;
            }
            return linkOf(await backend.findShare(boardId));
        },
        // a new address for the same board: the old link stops working, the password stays
        // (editors are removed by the database: they need the new link)
        async renew(boardId) {
            needAccount();
            await window.live?.ending?.(boardId, "link");
            await backend.renameShare(boardId, newCode());
            shareChanged(boardId);
            return linkOf(await backend.findShare(boardId));
        },
        // null removes the password (either way, editors need to open the link again)
        async setPassword(boardId, password) {
            needAccount();
            await window.live?.ending?.(boardId, "link");
            await backend.setSharePassword(boardId, password);
            shareChanged(boardId);
            return linkOf(await backend.findShare(boardId));
        },
        // #21: signed-in people with the link can edit, or only view.
        // Editors hear that it's ending first, while they can still be told.
        async setEditable(boardId, on) {
            needAccount();
            if (!on) await window.live?.ending?.(boardId, "off");
            await backend.setShareEditable(boardId, on);
            shareChanged(boardId);
            return linkOf(await backend.findShare(boardId));
        },
        async stop(boardId) {
            needAccount();
            await window.live?.ending?.(boardId, "off");
            await backend.deleteShare(boardId);
            shareChanged(boardId);
            return null;
        },
    };

    /* ---------- sign in / out ---------- */

    // Where the person was when they asked to sign in. Kept in localStorage, not sessionStorage,
    // because the email link opens a new tab. An hour covers the email link's lifetime.
    const RETURN = "aperture:return";
    function remember() {
        write(RETURN, { board: !!window.pins?.isBoardOpen?.(), at: Date.now() });
    }

    // back from signing in: open the board again if it was open (a /b/ page opens its own)
    function returnToBoard() {
        const r = read(RETURN, null);
        write(RETURN, null);
        if (!r?.board || Date.now() - r.at > 3600e3 || location.pathname.startsWith("/b/")) return;
        window.pins?.reopen?.();
    }

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
            returnToBoard();
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
        // comments.js shows or hides its composer as people sign in and out
        document.dispatchEvent(new CustomEvent("cloud:state", { detail: { state: s, user: user?.id || null } }));
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

    /* ---------- comments (#20) ---------- */
    // `where` is { code, password } on a shared board, or { boardId } on your own.
    // Reading works signed out; writing needs an account (the database checks).
    const comments = {
        available: () => !!backend?.shareComments,
        async list(where) {
            if (!backend?.shareComments) throw new Error("accounts are off");
            if (where.code) {
                const rows = (await backend.shareComments(where.code, where.password)) || [];
                const blocked = rows.find((r) => r.status && r.status !== "ok");
                if (blocked) throw Object.assign(new Error(blocked.status), { status: blocked.status });
                return rows.filter((r) => r.id);
            }
            needAccount();
            return (await backend.boardComments(where.boardId)) || [];
        },
        async add(where, c) {
            needAccount();
            await backend.addComment(where, c);
        },
        async remove(id) {
            needAccount();
            await backend.deleteComment(id);
        },
    };

    /* ---------- editing together (#21, live.js) ---------- */
    const live = {
        available: () => !!backend?.channel && !!user,
        // { room, name, data, updated }, or throws with .status (view, locked, wrong, slow, gone)
        async join(code, password) {
            needAccount();
            const row = await backend.joinBoard(code, password);
            if (!row) throw Object.assign(new Error("gone"), { status: "gone" });
            if (row.status !== "ok") throw Object.assign(new Error(row.status), { status: row.status });
            return row;
        },
        async board(room) {
            needAccount();
            const row = await backend.liveBoard(room);
            if (!row) throw Object.assign(new Error("not allowed"), { status: "gone" });
            return row;
        },
        async save(room, data, edited) {
            needAccount();
            return Number(await backend.saveLive(room, data, edited)) || edited;
        },
        channel(room, me, handlers) {
            needAccount();
            return backend.channel(room, me, handlers);
        },
    };

    /* ---------- the creators' library (#33, studio.js) ---------- */
    const needUser = () => {
        if (!user || !backend?.creatorMe) throw new Error("not signed in");
    };
    const studio = {
        available: () => !!backend?.creatorMe,
        // the public address of a file in the library bucket ("<user id>/<photo id>/s.webp")
        fileUrl: (path) => backend.libraryBase() + path,
        me() {
            needUser();
            return backend.creatorMe();
        },
        apply(row) {
            needUser();
            return backend.creatorApply(row);
        },
        update(fields) {
            needUser();
            return backend.creatorUpdate(fields);
        },
        photos() {
            needUser();
            return backend.myPhotos();
        },
        add(row) {
            needUser();
            return backend.addPhoto(row);
        },
        edit(id, fields) {
            needUser();
            return backend.updatePhoto(id, fields);
        },
        remove(id) {
            needUser();
            return backend.deletePhoto(id);
        },
        // long: the file never changes (photo sizes); short: it may be replaced (the avatar)
        put(path, blob, long = true) {
            needUser();
            return backend.putLibraryFile(path, blob, long);
        },
    };

    // sign-in from outside the board's account dialog (the studio's own form)
    const signIn = {
        email: (email) => backend.signInEmail(email),
        google: () => backend.signInGoogle(),
        out: async () => {
            signingOut = true;
            await backend.signOut().catch(() => {});
            signingOut = false;
            signedOut(true);
        },
    };

    window.cloud = { sync, share, comments, live, studio, signIn, state: () => state, user: () => user, open, close };
    start();
})();
