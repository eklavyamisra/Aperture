/* ==========================================================
   APERTURE — Studio: creators publish their own photos (roadmap #33)
   A full-screen panel (Studio in the nav, or /studio → /?studio=1).
   Signed-in people apply with a public profile; the site's owner approves
   them in Supabase. Approved creators upload photos here. Each file is
   resized in the browser to three WebP sizes (s / m / l: 640 / 1600 /
   3000 px on the long side, which also drops EXIF and location data) and
   stored in the public "library" bucket under <user id>/<photo id>/. A
   photo starts as a draft; once published it shows up for everyone through
   /api/library (api.js mixes it into the feed, search, wall and boards).
   All calls go through window.cloud.studio (cloud.js); the database checks
   every one of them (backend/supabase/schema.sql).
========================================================== */
(() => {
    const SIZES = [
        ["s", 640, 0.82],
        ["m", 1600, 0.86],
        ["l", 3000, 0.88],
    ];
    const MIN_LONG = 1200;
    const MAX_FILE = 40 * 1024 * 1024;
    const USER = /^[a-z0-9_-]{3,30}$/;

    const $ = (s) => document.querySelector(s);
    const panel = $("#studio");
    const navBtn = $("#nav-studio");
    if (!panel || !navBtn) return;

    const list = $("#studio-list");
    const form = $("#studio-form");
    const errEl = $("#studio-error");
    const progress = $("#studio-progress");

    let me = null; // { username, name, bio, location, link, avatar, status } or null (not applied)
    let meFor = null; // user id `me` was read for
    let photos = [];
    let editing = false; // the profile form is open over the desk
    let sentTo = "";
    let returnFocus = null;
    let busy = 0;

    const cloud = () => window.cloud;
    const user = () => cloud()?.user?.() || null;
    const ready = () => !!cloud()?.studio?.available?.() && cloud().state() !== "off";
    const fileUrl = (path) => cloud().studio.fileUrl(path);
    const reduce = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

    const fail = (err, what = "That didn't work") => {
        const m = String(err?.message || err || "");
        let why = "Check your connection and try again.";
        if (/duplicate|unique|creators_username_key/i.test(m)) why = "That username is taken. Try another.";
        else if (/too many|limit/i.test(m)) why = m.replace(/^.*?(too many|photo limit)/i, (x, y) => y.charAt(0).toUpperCase() + y.slice(1));
        else if (/row-level security|not allowed|permission/i.test(m)) why = "Your account can't do that yet.";
        else if (m && m.length < 140 && !/fetch|network/i.test(m)) why = m;
        errEl.textContent = `${what}. ${why}`;
        if (!/^(Only|At least|That)/.test(m)) window.reportProblem?.("studio", err);
    };
    const clearError = () => (errEl.textContent = "");

    /* ---------- open / close ---------- */

    function setUrl(on) {
        try {
            const u = new URL(location.href);
            if (on) u.searchParams.set("studio", "1");
            else u.searchParams.delete("studio");
            history.replaceState(history.state, "", u);
        } catch (e) {}
    }

    function open() {
        if (!panel.hidden) return;
        returnFocus = document.activeElement;
        panel.hidden = false;
        navBtn.setAttribute("aria-expanded", "true");
        document.body.classList.add("studio-open");
        if (typeof lenis !== "undefined") lenis?.stop(); // api.js
        setUrl(true);
        render();
        if (!reduce() && window.gsap) gsap.fromTo(".studio-sheet", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.5, ease: "expo.out" });
        $("#studio-close").focus({ preventScroll: true });
    }

    function close() {
        if (panel.hidden) return;
        panel.hidden = true;
        navBtn.setAttribute("aria-expanded", "false");
        document.body.classList.remove("studio-open");
        // the wall, board and viewer keep the page still themselves
        if (typeof lenis !== "undefined" && !window.canvasView?.isOpen && lightbox.hidden) lenis?.start();
        setUrl(false);
        clearError();
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    }

    navBtn.addEventListener("click", open);
    $("#studio-close").addEventListener("click", close);
    document.addEventListener(
        "keydown",
        (e) => {
            if (panel.hidden) return;
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopImmediatePropagation();
                if (editing && me) return stopEditing();
                return close();
            }
            if (e.key === "Tab") trap(e);
        },
        true
    );
    // keep the page's own shortcuts ("/" to search, board keys) out while typing here
    panel.addEventListener("keydown", (e) => e.stopPropagation());

    function trap(e) {
        const items = [...panel.querySelectorAll("button, a[href], input, textarea, select")].filter((el) => !el.disabled && el.offsetParent !== null && !el.classList.contains("sr-only"));
        const files = [...panel.querySelectorAll("input[type=file]")].filter((el) => el.closest("label")?.offsetParent);
        const all = [...new Set([...items, ...files])].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
        if (!all.length) return;
        const first = all[0];
        const last = all[all.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    }

    /* ---------- views ---------- */

    function show(view) {
        panel.dataset.view = view;
        panel.querySelectorAll("[data-view]").forEach((v) => (v.hidden = v.dataset.view !== view));
        $("#studio-fine").hidden = !user();
        $("#studio-who").textContent = user()?.email || "";
    }

    let loadingFor = null;
    async function render() {
        if (panel.hidden) return;
        if (!ready()) {
            $("#studio-loading").textContent = cloud()?.state?.() === "off" && started ? "Accounts aren't set up on this site yet, so the studio is closed." : "Opening the studio…";
            return show("loading");
        }
        const u = user();
        if (!u) {
            me = null;
            meFor = null;
            return show(sentTo ? "sent" : "out");
        }
        if (meFor !== u.id) {
            if (loadingFor === u.id) return;
            loadingFor = u.id;
            $("#studio-loading").textContent = "Opening the studio…";
            show("loading");
            try {
                me = (await cloud().studio.me()) || null;
                meFor = u.id;
            } catch (err) {
                fail(err, "Couldn't open the studio");
                return;
            } finally {
                loadingFor = null;
            }
            if (me && me.status !== "pending") await loadPhotos();
        }
        paintMe();
        if (!me || editing) return openForm();
        if (me.status === "pending") return show("pending");
        show(me.status === "approved" ? "studio" : "blocked");
        // a blocked creator can still see (and delete) what they uploaded
        if (me.status === "blocked") panel.querySelector('[data-view="blocked"]').append($(".studio-desk .studio-bar"), list);
        paintList();
    }

    function paintMe() {
        if (!me) return;
        panel.querySelectorAll(".studio-me-name").forEach((el) => (el.textContent = me.name));
        panel.querySelectorAll(".studio-me-url").forEach((el) => (el.textContent = `${location.host}/?creator=${me.username}`));
        const link = $("#studio-me-link");
        link.href = `/?creator=${me.username}`;
        [$("#studio-me-avatar"), $("#studio-avatar")].forEach((el) => {
            el.textContent = "";
            if (me.avatar > 0) {
                const img = document.createElement("img");
                img.alt = "";
                img.src = `${fileUrl(`${user().id}/avatar.webp`)}?v=${me.avatar}`;
                el.appendChild(img);
            } else el.textContent = (me.name || "?").trim().charAt(0).toUpperCase();
        });
    }

    // a creator's page lives inside the app: close the studio and open it there
    $("#studio-me-link").addEventListener("click", (e) => {
        if (!me || e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        close();
        window.runUser?.(me.username, me.name, { source: "aperture" });
    });

    /* ---------- signing in ---------- */

    $("#studio-signin").addEventListener("submit", async (e) => {
        e.preventDefault();
        clearError();
        const email = $("#studio-email").value.trim();
        if (!email) return;
        const b = e.submitter || $("#studio-signin button");
        b.disabled = true;
        try {
            await cloud().signIn.email(email);
            sentTo = email;
            $("#studio-sent-to").textContent = email;
            if (!user()) show("sent");
        } catch (err) {
            errEl.textContent = /rate/i.test(err?.message || "") ? "Too many tries. Wait a minute and try again." : "That didn't work. Check your connection and try again.";
        } finally {
            b.disabled = false;
        }
    });
    $("#studio-google").addEventListener("click", () => cloud().signIn.google().catch(() => (errEl.textContent = "Google sign-in didn't start. Try the email link instead.")));
    $("#studio-back").addEventListener("click", () => {
        sentTo = "";
        show("out");
    });
    $("#studio-signout").addEventListener("click", async () => {
        await cloud().signIn.out();
        sentTo = "";
        editing = false;
        render();
    });

    /* ---------- applying, and editing the profile ---------- */

    const field = (id) => $(`#studio-${id}`);

    function openForm() {
        const applying = !me;
        form.classList.toggle("is-applying", applying);
        $("#studio-form-submit").textContent = applying ? "Apply to publish" : "Save profile";
        field("rights").required = applying;
        const src = me || { name: user()?.name || "", username: suggestName(), bio: "", location: "", link: "" };
        for (const k of ["name", "username", "bio", "location", "link"]) field(k).value = src[k] || "";
        show("apply");
    }

    function suggestName() {
        const base = String(user()?.name || user()?.email?.split("@")[0] || "")
            .toLowerCase()
            .normalize("NFKD")
            .replace(/[^a-z0-9_-]+/g, "")
            .slice(0, 30);
        return base.length >= 3 ? base : "";
    }

    function stopEditing() {
        editing = false;
        clearError();
        render();
    }

    panel.addEventListener("click", (e) => {
        if (!e.target.closest("[data-studio-edit]")) return;
        editing = true;
        clearError();
        openForm();
        field("name").focus();
    });
    $("#studio-form-cancel").addEventListener("click", stopEditing);
    field("username").addEventListener("input", (e) => (e.target.value = e.target.value.toLowerCase().replace(/\s+/g, "-")));

    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        clearError();
        const row = {
            name: field("name").value.trim().slice(0, 60),
            username: field("username").value.trim().toLowerCase(),
            bio: field("bio").value.trim().slice(0, 300),
            location: field("location").value.trim().slice(0, 60),
            link: field("link").value.trim().slice(0, 200),
        };
        if (!row.name) return (errEl.textContent = "Add the name people should see.");
        if (!USER.test(row.username)) return (errEl.textContent = "Usernames are 3–30 lowercase letters, digits, - or _.");
        if (row.link && !/^https:\/\/\S+$/.test(row.link)) return (errEl.textContent = "The website needs to start with https://");
        if (!me && !field("rights").checked) return (errEl.textContent = "Please confirm you have the rights to the photos you'll publish.");
        const b = $("#studio-form-submit");
        b.disabled = true;
        try {
            if (me) await cloud().studio.update(row);
            else await cloud().studio.apply(row);
            me = { avatar: 0, status: "pending", ...me, ...row };
            editing = false;
            window.toast?.(me.status === "pending" ? "Application sent. We'll review it soon." : "Profile saved");
            render();
        } catch (err) {
            fail(err, me ? "Couldn't save your profile" : "Couldn't send your application");
        } finally {
            b.disabled = false;
        }
    });

    $("#studio-avatar-file").addEventListener("change", async (e) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file || !me) return;
        clearError();
        try {
            const src = await decode(file);
            const side = Math.min(src.width, src.height);
            const c = canvas(256, 256);
            c.getContext("2d").drawImage(src, (src.width - side) / 2, (src.height - side) / 2, side, side, 0, 0, 256, 256);
            src.close?.();
            await cloud().studio.put(`${user().id}/avatar.webp`, await encode(c, 0.85), false);
            const avatar = (me.avatar || 0) + 1;
            await cloud().studio.update({ avatar });
            me.avatar = avatar;
            paintMe();
            window.toast?.("Picture updated");
        } catch (err) {
            fail(err, "Couldn't change your picture");
        }
    });

    /* ---------- images: sizes, colour, tone ---------- */

    function canvas(w, h) {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        return c;
    }

    function decode(file) {
        // createImageBitmap applies the EXIF orientation, so portraits stay upright
        if (typeof createImageBitmap === "function") return createImageBitmap(file).catch(() => viaImg(file));
        return viaImg(file);
    }
    function viaImg(file) {
        return new Promise((res, rej) => {
            const u = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => res(Object.assign(img, { close: () => URL.revokeObjectURL(u) }));
            img.onerror = () => rej(new Error("That file isn't an image the browser can read"));
            img.src = u;
        });
    }

    async function encode(c, quality) {
        let blob = await new Promise((r) => c.toBlob(r, "image/webp", quality));
        // browsers that can't write WebP: JPEG (the bucket takes both)
        if (!blob || blob.type !== "image/webp") blob = await new Promise((r) => c.toBlob(r, "image/jpeg", quality));
        if (!blob) throw new Error("This browser couldn't prepare the image");
        return blob;
    }

    const hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

    // Unsplash's colour names, so the Tone filter works for both libraries
    function toneOf(data) {
        let n = 0, sx = 0, sy = 0, sw = 0, satSum = 0, lumSum = 0;
        for (let i = 0; i < data.length; i += 4) {
            const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            const l = (max + min) / 2;
            const d = max - min;
            const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
            let h = 0;
            if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
            const a = (h * Math.PI) / 3;
            const w = s * (1 - Math.abs(2 * l - 1)); // vivid mid-tones count most
            sx += Math.cos(a) * w;
            sy += Math.sin(a) * w;
            sw += w;
            satSum += s;
            lumSum += l;
            n++;
        }
        const sat = satSum / n, lum = lumSum / n;
        if (lum < 0.12) return "black";
        if (lum > 0.9) return "white";
        if (sat < 0.12 || sw / n < 0.04) return lum < 0.22 ? "black" : lum > 0.82 ? "white" : "black_and_white";
        const hue = ((Math.atan2(sy, sx) * 180) / Math.PI + 360) % 360;
        if (hue < 15 || hue >= 345) return "red";
        if (hue < 40) return "orange";
        if (hue < 68) return "yellow";
        if (hue < 160) return "green";
        if (hue < 195) return "teal";
        if (hue < 255) return "blue";
        if (hue < 290) return "purple";
        return "magenta";
    }

    function titleFrom(name) {
        const t = String(name || "")
            .replace(/\.[a-z0-9]{2,5}$/i, "")
            .replace(/[_-]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        // camera file names (IMG 1234, DSC00012) make poor titles
        if (!t || /^(img|dsc|dscf|dscn|pxl|photo|image|mvimg|p)\s*\d+/i.test(t) || /^\d[\d\s]*$/.test(t)) return "Untitled";
        return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 120);
    }

    function newId() {
        const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
        let out = "";
        for (const b of crypto.getRandomValues(new Uint8Array(24))) if (b < 252 && out.length < 12) out += abc[b % 36];
        return out.length === 12 ? `ap-${out}` : newId();
    }

    // one file -> { id, width, height, color, tone, files: [[size, blob]] }
    async function prepare(file) {
        if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("Only JPEG, PNG or WebP files can be published");
        if (file.size > MAX_FILE) throw new Error("That file is over 40 MB");
        const src = await decode(file);
        try {
            const width = src.width || src.naturalWidth;
            const height = src.height || src.naturalHeight;
            if (!width || !height) throw new Error("That file isn't an image the browser can read");
            const long = Math.max(width, height);
            if (long < MIN_LONG) throw new Error(`At least ${MIN_LONG} px on the long side, please (this one is ${long} px)`);
            const files = [];
            for (const [k, L, quality] of SIZES) {
                const s = Math.min(1, L / long);
                const c = canvas(Math.round(width * s), Math.round(height * s));
                const ctx = c.getContext("2d");
                ctx.imageSmoothingQuality = "high";
                ctx.drawImage(src, 0, 0, c.width, c.height);
                files.push([k, await encode(c, quality)]);
            }
            const t = canvas(24, 24);
            const tctx = t.getContext("2d", { willReadFrequently: true });
            tctx.drawImage(src, 0, 0, 24, 24);
            const data = tctx.getImageData(0, 0, 24, 24).data;
            let r = 0, g = 0, b = 0;
            for (let i = 0; i < data.length; i += 4) {
                r += data[i];
                g += data[i + 1];
                b += data[i + 2];
            }
            const n = data.length / 4;
            return { id: newId(), width, height, color: hex(r / n, g / n, b / n), tone: toneOf(data), files };
        } finally {
            src.close?.();
        }
    }

    /* ---------- uploading ---------- */

    async function upload(fileList) {
        const files = [...fileList].slice(0, 30);
        if (!files.length || me?.status !== "approved") return;
        clearError();
        busy++;
        const problems = [];
        let done = 0;
        for (const [i, file] of files.entries()) {
            progress.textContent = `Preparing ${i + 1} of ${files.length}: ${file.name}`;
            try {
                const p = await prepare(file);
                progress.textContent = `Uploading ${i + 1} of ${files.length}: ${file.name}`;
                for (const [k, blob] of p.files) await cloud().studio.put(`${user().id}/${p.id}/${k}.webp`, blob);
                const row = { id: p.id, title: titleFrom(file.name), alt: "", tags: [], width: p.width, height: p.height, color: p.color, tone: p.tone, license: "free", published: false };
                await cloud().studio.add(row);
                photos.unshift({ ...row, hidden: false, created_at: new Date().toISOString() });
                done++;
                paintList();
            } catch (err) {
                problems.push(`${file.name}: ${err?.message || "didn't upload"}`);
                if (!/^(Only|At least|That)/.test(err?.message || "")) window.reportProblem?.("studio upload", err);
            }
        }
        busy--;
        progress.textContent = done ? `${done} uploaded as ${done === 1 ? "a draft" : "drafts"}. Add titles and tags, then publish.` : "";
        if (problems.length) errEl.textContent = problems.slice(0, 3).join(" · ") + (problems.length > 3 ? ` · and ${problems.length - 3} more` : "");
        list.querySelector(".studio-title-in")?.focus({ preventScroll: true });
    }

    $("#studio-file").addEventListener("change", (e) => {
        upload(e.target.files || []);
        e.target.value = "";
    });
    const drop = $("#studio-drop");
    ["dragenter", "dragover"].forEach((t) =>
        drop.addEventListener(t, (e) => {
            e.preventDefault();
            drop.classList.add("is-over");
        })
    );
    ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, () => drop.classList.remove("is-over")));
    drop.addEventListener("drop", (e) => {
        e.preventDefault();
        upload(e.dataTransfer?.files || []);
    });
    // dropping a file anywhere on the open studio shouldn't navigate away to it
    panel.addEventListener("dragover", (e) => e.preventDefault());
    panel.addEventListener("drop", (e) => e.preventDefault());

    /* ---------- the creator's photos ---------- */

    async function loadPhotos() {
        try {
            photos = (await cloud().studio.photos()) || [];
        } catch (err) {
            photos = [];
            fail(err, "Couldn't load your photos");
        }
    }

    const parseTags = (s) => [...new Set(String(s).toLowerCase().split(/[,#\n]+/).map((t) => t.trim().replace(/\s+/g, " ").slice(0, 30)).filter(Boolean))].slice(0, 12);

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function stateOf(p) {
        if (p.hidden) return ["hidden", "Hidden by Aperture"];
        return p.published ? ["live", "Published"] : ["draft", "Draft"];
    }

    function paintList() {
        list.textContent = "";
        const drafts = photos.filter((p) => !p.published).length;
        const live = photos.filter((p) => p.published && !p.hidden).length;
        $("#studio-count").textContent = photos.length ? `${live} published · ${drafts} ${drafts === 1 ? "draft" : "drafts"}` : "";
        $("#studio-publish-all").hidden = !drafts || me?.status !== "approved";
        $("#studio-empty").hidden = !!photos.length;
        photos.forEach((p) => list.appendChild(item(p)));
    }

    function item(p) {
        const li = el("li", "studio-item");
        li.dataset.id = p.id;
        const [st, label] = stateOf(p);
        li.dataset.state = st;

        const fig = el("a", "studio-thumb");
        fig.href = fileUrl(`${user().id}/${p.id}/l.webp`);
        fig.target = "_blank";
        fig.rel = "noopener";
        fig.style.setProperty("--c", p.color);
        fig.setAttribute("aria-label", `Open “${p.title}” full size`);
        const img = el("img");
        img.alt = "";
        img.loading = "lazy";
        img.src = fileUrl(`${user().id}/${p.id}/s.webp`);
        fig.appendChild(img);
        fig.appendChild(el("span", "studio-state mono", label));

        const body = el("div", "studio-fields");
        const mkInput = (cls, value, name, ph, max) => {
            const wrap = el("label", "studio-field");
            wrap.appendChild(el("span", "mono", name));
            const i = el("input", cls);
            i.value = value;
            i.placeholder = ph;
            i.maxLength = max;
            wrap.appendChild(i);
            body.appendChild(wrap);
            return i;
        };
        const title = mkInput("studio-title-in", p.title, "Title", "What is it?", 120);
        const alt = mkInput("studio-alt-in", p.alt || "", "Description", "Describe it for people who can't see it", 300);
        const tags = mkInput("studio-tags-in", (p.tags || []).join(", "), "Tags", "harbour, fog, morning", 400);

        const row = el("div", "studio-row");
        const lic = el("select", "studio-license");
        lic.setAttribute("aria-label", `What people may do with “${p.title}”`);
        [
            ["free", "Free to use and download"],
            ["view", "View and pin only"],
        ].forEach(([v, t]) => {
            const o = el("option", "", t);
            o.value = v;
            lic.appendChild(o);
        });
        lic.value = p.license;
        const pub = el("button", p.published ? "acct-quiet mono" : "acct-primary mono", p.published ? "Unpublish" : "Publish");
        pub.type = "button";
        pub.disabled = p.hidden || me?.status !== "approved";
        const del = el("button", "acct-danger studio-delete", "Delete");
        del.type = "button";
        del.setAttribute("aria-label", `Delete “${p.title}”`);
        const saved = el("span", "studio-saved mono");
        saved.setAttribute("role", "status");
        row.append(lic, pub, saved, del);
        body.appendChild(row);
        li.append(fig, body);

        let t = 0;
        const save = async (fields, note = "Saved") => {
            clearError();
            try {
                await cloud().studio.edit(p.id, fields);
                Object.assign(p, fields);
                saved.textContent = note;
                clearTimeout(t);
                t = setTimeout(() => (saved.textContent = ""), 1800);
                return true;
            } catch (err) {
                fail(err, "Couldn't save that change");
                return false;
            }
        };
        title.addEventListener("change", () => {
            const v = title.value.trim().slice(0, 120);
            if (!v) return (title.value = p.title);
            if (v !== p.title) save({ title: v });
        });
        alt.addEventListener("change", () => alt.value.trim() !== (p.alt || "") && save({ alt: alt.value.trim().slice(0, 300) }));
        tags.addEventListener("change", () => {
            const next = parseTags(tags.value);
            tags.value = next.join(", ");
            if (next.join() !== (p.tags || []).join()) save({ tags: next });
        });
        lic.addEventListener("change", () => save({ license: lic.value }));
        pub.addEventListener("click", async () => {
            if (!p.published && (!p.title || p.title === "Untitled")) {
                errEl.textContent = "Give the photo a title before publishing it.";
                return title.focus();
            }
            pub.disabled = true;
            if (await save({ published: !p.published }, p.published ? "Back to draft" : "Published")) {
                window.toast?.(p.published ? `“${p.title}” is live on Aperture` : `“${p.title}” is a draft again`);
                const fresh = item(p);
                li.replaceWith(fresh);
                paintCounts();
                fresh.querySelector(".studio-row button").focus({ preventScroll: true });
            } else pub.disabled = false;
        });
        del.addEventListener("click", async () => {
            if (!confirm(`Delete “${p.title}”? It disappears from Aperture, and boards that pinned it show an empty card. This can't be undone.`)) return;
            try {
                await cloud().studio.remove(p.id);
                photos = photos.filter((x) => x !== p);
                paintList();
                window.toast?.("Photo deleted");
            } catch (err) {
                fail(err, "Couldn't delete it");
            }
        });
        return li;
    }

    function paintCounts() {
        const drafts = photos.filter((p) => !p.published).length;
        const live = photos.filter((p) => p.published && !p.hidden).length;
        $("#studio-count").textContent = photos.length ? `${live} published · ${drafts} ${drafts === 1 ? "draft" : "drafts"}` : "";
        $("#studio-publish-all").hidden = !drafts || me?.status !== "approved";
    }

    $("#studio-publish-all").addEventListener("click", async () => {
        const ready = photos.filter((p) => !p.published && !p.hidden && p.title && p.title !== "Untitled");
        const skipped = photos.filter((p) => !p.published && !p.hidden).length - ready.length;
        clearError();
        for (const p of ready) {
            try {
                await cloud().studio.edit(p.id, { published: true });
                p.published = true;
            } catch (err) {
                fail(err, "Couldn't publish everything");
                break;
            }
        }
        paintList();
        if (skipped) errEl.textContent = `${skipped} ${skipped === 1 ? "draft has" : "drafts have"} no title yet, so ${skipped === 1 ? "it stays" : "they stay"} a draft.`;
        else window.toast?.("Drafts published");
    });

    /* ---------- start ---------- */

    let started = false;
    document.addEventListener("cloud:state", (e) => {
        navBtn.hidden = !ready();
        // only a change of account needs the profile read again
        if ((e.detail?.user || null) !== meFor && !e.detail?.user) {
            me = null;
            meFor = null;
            photos = [];
        }
        render();
    });
    // give accounts a moment to start before saying the studio is closed
    setTimeout(() => {
        started = true;
        render();
    }, 6000);

    // cloud.js may already have started (its first state change came before this file loaded)
    navBtn.hidden = !ready();

    window.studio = { open, close, isOpen: () => !panel.hidden };
    if (new URLSearchParams(location.search).has("studio")) open();
})();
