/* ==========================================================
   APERTURE — media store
   Images people upload to a board live in IndexedDB (localStorage tops out
   around 5 MB), keyed by the board item's id. They never leave the browser
   unless the board is exported as JSON. Also: image downscaling on upload and
   colour-palette extraction for the board's Palette tool.
========================================================== */
(() => {
    const DB = "aperture-media";
    const STORE = "blobs";
    const MAX_SIDE = 2000;
    const MAX_FILE = 40 * 1024 * 1024;

    let dbp = null;
    function db() {
        if (!dbp) {
            dbp = new Promise((res, rej) => {
                const r = indexedDB.open(DB, 1);
                r.onupgradeneeded = () => r.result.createObjectStore(STORE);
                r.onsuccess = () => res(r.result);
                r.onerror = () => rej(r.error);
            });
            dbp.catch(() => (dbp = null));
        }
        return dbp;
    }

    async function tx(mode, fn) {
        const d = await db();
        return new Promise((res, rej) => {
            const t = d.transaction(STORE, mode);
            const req = fn(t.objectStore(STORE));
            t.oncomplete = () => res(req?.result);
            t.onerror = () => rej(t.error);
            t.onabort = () => rej(t.error || new Error("aborted"));
        });
    }

    const put = (key, blob) => tx("readwrite", (s) => s.put(blob, key));
    const get = (key) => tx("readonly", (s) => s.get(key));
    const keys = () => tx("readonly", (s) => s.getAllKeys());

    const urls = new Map();
    async function url(key) {
        if (urls.has(key)) return urls.get(key);
        const b = await get(key).catch(() => null);
        if (!b) return null;
        const u = URL.createObjectURL(b);
        urls.set(key, u);
        return u;
    }

    async function del(key) {
        const u = urls.get(key);
        if (u) URL.revokeObjectURL(u);
        urls.delete(key);
        await tx("readwrite", (s) => s.delete(key)).catch(() => {});
    }

    const hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

    function decode(file) {
        if (typeof createImageBitmap === "function") return createImageBitmap(file).catch(() => viaImg(file));
        return viaImg(file);
    }
    function viaImg(file) {
        return new Promise((res, rej) => {
            const u = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => res(img);
            img.onerror = () => rej(new Error("This file isn't an image the browser can read"));
            img.src = u;
        });
    }

    // downscale to MAX_SIDE, re-encode, and measure an average colour
    async function processImage(file) {
        if (!file || !/^image\//.test(file.type)) throw new Error("Only image files can be added");
        if (file.size > MAX_FILE) throw new Error("That image is over 40 MB");
        const src = await decode(file);
        const w0 = src.width || src.naturalWidth;
        const h0 = src.height || src.naturalHeight;
        if (!w0 || !h0) throw new Error("This file isn't an image the browser can read");
        const s = Math.min(1, MAX_SIDE / Math.max(w0, h0));
        const w = Math.round(w0 * s);
        const h = Math.round(h0 * s);
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        ctx.drawImage(src, 0, 0, w, h);
        src.close?.();
        let blob = await new Promise((r) => c.toBlob(r, "image/webp", 0.86));
        if (!blob || blob.type !== "image/webp") blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.86));
        // keep the original if re-encoding made it bigger (small PNG icons etc.)
        if (s === 1 && file.size < blob.size && file.size < 4e6) blob = file;
        const t = document.createElement("canvas");
        t.width = t.height = 1;
        const tc = t.getContext("2d");
        tc.drawImage(c, 0, 0, 1, 1);
        const [r, g, b] = tc.getImageData(0, 0, 1, 1).data;
        return { blob, w, h, color: hex(r, g, b) };
    }

    function loadImage(src, cors) {
        return new Promise((res) => {
            const img = new Image();
            if (cors) img.crossOrigin = "anonymous";
            const t = setTimeout(() => res(null), 8000);
            img.onload = () => (clearTimeout(t), res(img));
            img.onerror = () => (clearTimeout(t), res(null));
            img.src = src;
        });
    }

    // dominant colours across a set of images: sample each small, k-means in RGB
    async function palette(sources, k = 6, hints = []) {
        const px = [];
        const imgs = await Promise.all(sources.slice(0, 48).map((s) => loadImage(s.src, s.cors)));
        const c = document.createElement("canvas");
        c.width = 20;
        c.height = 25;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        imgs.forEach((img) => {
            if (!img) return;
            ctx.clearRect(0, 0, 20, 25);
            ctx.drawImage(img, 0, 0, 20, 25);
            try {
                const d = ctx.getImageData(0, 0, 20, 25).data;
                for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) px.push([d[i], d[i + 1], d[i + 2]]);
            } catch (e) {} // a cross-origin image without CORS: skip it
        });
        hints.forEach((h) => {
            const m = /^#([0-9a-f]{6})$/i.exec(h || "");
            if (!m) return;
            const n = parseInt(m[1], 16);
            for (let i = 0; i < 40; i++) px.push([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
        });
        if (!px.length) return [];
        k = Math.min(k, px.length);
        // k-means++ style seeding, deterministic: start from the mean, then farthest points
        const dist = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
        const mean = px.reduce((m, p) => [m[0] + p[0], m[1] + p[1], m[2] + p[2]], [0, 0, 0]).map((v) => v / px.length);
        const cents = [px.reduce((best, p) => (dist(p, mean) < dist(best, mean) ? p : best), px[0]).slice()];
        while (cents.length < k) {
            let far = px[0];
            let fd = -1;
            px.forEach((p) => {
                const d = Math.min(...cents.map((c2) => dist(p, c2)));
                if (d > fd) {
                    fd = d;
                    far = p;
                }
            });
            cents.push(far.slice());
        }
        const owner = new Array(px.length).fill(0);
        for (let it = 0; it < 12; it++) {
            px.forEach((p, i) => {
                let bi = 0;
                let bd = Infinity;
                cents.forEach((c2, j) => {
                    const d = dist(p, c2);
                    if (d < bd) {
                        bd = d;
                        bi = j;
                    }
                });
                owner[i] = bi;
            });
            const sum = cents.map(() => [0, 0, 0, 0]);
            px.forEach((p, i) => {
                const s = sum[owner[i]];
                s[0] += p[0];
                s[1] += p[1];
                s[2] += p[2];
                s[3]++;
            });
            sum.forEach((s, j) => s[3] && (cents[j] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]));
        }
        const counts = cents.map(() => 0);
        owner.forEach((o) => counts[o]++);
        return cents
            .map((c2, j) => ({ hex: hex(...c2), share: counts[j] / px.length }))
            .filter((c2) => c2.share > 0.01)
            .sort((a, b) => b.share - a.share);
    }

    const blobToDataURL = (blob) =>
        new Promise((res, rej) => {
            const r = new FileReader();
            r.onload = () => res(r.result);
            r.onerror = () => rej(r.error);
            r.readAsDataURL(blob);
        });

    async function dataURLToBlob(d) {
        if (typeof d !== "string" || !/^data:image\/(png|jpeg|webp|gif|avif);base64,/.test(d)) throw new Error("bad image data");
        return (await fetch(d)).blob();
    }

    let asked = false;
    async function persist() {
        if (asked) return;
        asked = true;
        try {
            await navigator.storage?.persist?.();
        } catch (e) {}
    }

    async function estimate() {
        try {
            const e = await navigator.storage?.estimate?.();
            return e ? { used: e.usage || 0, quota: e.quota || 0 } : null;
        } catch (e) {
            return null;
        }
    }

    window.media = { put, get, del, keys, url, processImage, palette, loadImage, blobToDataURL, dataURLToBlob, persist, estimate, available: "indexedDB" in window };
})();
