/* ==========================================================
   APERTURE — infinite canvas
   One full-screen WebGL2 shader draws an endless, staggered wall of the
   current results. Photos live in a single texture atlas; the shader works
   out which tile every pixel falls in, so the wall is infinite at the cost
   of one draw call. Speed bends the lens and splits the colour channels.
   Relies on globals from api.js: state, api helpers, openLightbox, lenis,
   gsap, cursor, cursorLabel, cursorReset, reduceMotion, canHover.
========================================================== */
(() => {
    const view = q("#cv");
    const glc = q("#cv-gl");
    const openers = qa("[data-open-canvas]");
    const gl = glc.getContext("webgl2", { antialias: false, alpha: true, premultipliedAlpha: true });

    if (!gl) {
        openers.forEach((b) => (b.hidden = true));
        return;
    }

    /* ---------- sizes ---------- */
    const MAX = 64; // photos the atlas can hold
    const GRID = 8; // atlas is GRID x GRID slots
    const big = Math.min(devicePixelRatio || 1, 2) * Math.min(innerWidth, 1600) > 1400;
    const SLOT_W = big ? 384 : 256;
    const SLOT_H = big ? 480 : 320;
    const ATLAS_W = SLOT_W * GRID;
    const ATLAS_H = SLOT_H * GRID;

    let CW, CH, PX, PY; // card size + pitch, CSS px
    function measure() {
        CW = Math.round(gsap.utils.clamp(128, 280, innerWidth * 0.17));
        CH = Math.round(CW * 1.25);
        const gap = Math.round(CW * 0.09);
        PX = CW + gap;
        PY = CH + gap;
    }
    measure();

    /* ---------- shader ---------- */
    const VERT = `#version 300 es
    in vec2 aPos;
    void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

    const FRAG = `#version 300 es
    precision highp float;
    uniform vec2 uRes;
    uniform float uDpr;
    uniform vec2 uCam;
    uniform float uZoom;
    uniform vec2 uCell;
    uniform vec2 uPitch;
    uniform float uK;
    uniform vec2 uVel;
    uniform float uCA;
    uniform sampler2D uAtlas;
    uniform float uGrid;
    uniform float uCount;
    uniform vec4 uSlots[${MAX}];
    uniform vec2 uHover;
    uniform float uHoverAmt;
    uniform float uFade;
    out vec4 outColor;

    const vec3 BG = vec3(0.051, 0.047, 0.039);

    void main() {
        vec2 viewPx = uRes / uDpr;
        vec2 css = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;
        vec2 c = (css - viewPx * 0.5) / viewPx.y;
        float r2 = dot(c, c);
        vec2 world = uCam + c * (1.0 - uK * r2) * viewPx.y / uZoom;

        float col = floor(world.x / uPitch.x);
        float shift = fract(col * 0.618034) * uPitch.y;
        vec2 w2 = vec2(world.x, world.y + shift);
        float row = floor(w2.y / uPitch.y);
        vec2 local = w2 - vec2(col, row) * uPitch;

        // rounded-rect mask, antialiased from the continuous world coords
        float rad = 3.0;
        vec2 qd = abs(local - uCell * 0.5) - uCell * 0.5 + rad;
        float d = length(max(qd, 0.0)) + min(max(qd.x, qd.y), 0.0) - rad;
        float aa = length(fwidth(world)) * 0.75;
        float mask = 1.0 - smoothstep(-aa, aa, d);

        vec3 color = BG;
        if (mask > 0.0 && uCount > 0.0) {
            float idx = mod(col * 5.0 + row * 11.0, uCount);
            vec4 slot = uSlots[int(idx)];
            float isH = step(abs(col - uHover.x) + abs(row - uHover.y), 0.5);
            float hs = 1.0 + 0.09 * isH * uHoverAmt;

            vec2 luv = (local / uCell - 0.5) / hs + 0.5;
            vec2 origin = vec2(mod(idx, uGrid), floor(idx / uGrid));
            vec2 gx = dFdx(world) / (uCell * uGrid * hs);
            vec2 gy = dFdy(world) / (uCell * uGrid * hs);
            vec2 off = clamp(uVel / viewPx.y * uCA * 0.9, -0.012, 0.012);

            vec2 a = (origin + clamp(luv + off, 0.004, 0.996)) / uGrid;
            vec2 b = (origin + clamp(luv, 0.004, 0.996)) / uGrid;
            vec2 e = (origin + clamp(luv - off, 0.004, 0.996)) / uGrid;
            vec3 tex = vec3(
                textureGrad(uAtlas, a, gx, gy).r,
                textureGrad(uAtlas, b, gx, gy).g,
                textureGrad(uAtlas, e, gx, gy).b
            );

            vec3 photo = mix(slot.rgb, tex, slot.a);
            photo *= mix(1.0, 0.42, uHoverAmt * (1.0 - isH));
            color = mix(BG, photo, mask);
        }

        // lens vignette
        color *= 1.0 - 0.55 * smoothstep(0.18, 0.62, r2);
        outColor = vec4(color * uFade, uFade);
    }`;

    function compile(type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
    }

    let prog;
    try {
        prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (err) {
        console.warn("[aperture] canvas disabled:", err);
        openers.forEach((b) => (b.hidden = true));
        return;
    }
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const U = {};
    ["uRes", "uDpr", "uCam", "uZoom", "uCell", "uPitch", "uK", "uVel", "uCA", "uAtlas", "uGrid", "uCount", "uSlots", "uHover", "uHoverAmt", "uFade"].forEach(
        (n) => (U[n] = gl.getUniformLocation(prog, n))
    );

    /* ---------- atlas ---------- */
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const levels = Math.floor(Math.log2(Math.max(ATLAS_W, ATLAS_H))) + 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA8, ATLAS_W, ATLAS_H);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);

    const scratch = document.createElement("canvas");
    scratch.width = SLOT_W;
    scratch.height = SLOT_H;
    const sctx = scratch.getContext("2d");

    const slotData = new Float32Array(MAX * 4);
    const slots = []; // { photo, a }
    let gen = 0;
    let mipDirty = false;
    let lastMip = 0;

    const hexRgb = (hex) => {
        const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
        const n = m ? parseInt(m[1], 16) : 0x222222;
        return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    };

    function addSlot(p) {
        const k = slots.length;
        const s = { photo: p, a: 0 };
        slots.push(s);
        const [r, g, b] = hexRgb(p.color);
        slotData.set([r * 0.8, g * 0.8, b * 0.8, 0], k * 4);

        const myGen = gen;
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.decoding = "async";
        img.src = `${p.urls.raw}&w=${SLOT_W}&h=${SLOT_H}&fit=crop&crop=entropy&q=72&auto=format`;
        img.decode()
            .then(() => {
                if (myGen !== gen) return;
                // cover-fit into the slot in case the CDN returned another size
                const sc = Math.max(SLOT_W / img.naturalWidth, SLOT_H / img.naturalHeight);
                const w = img.naturalWidth * sc;
                const h = img.naturalHeight * sc;
                sctx.drawImage(img, (SLOT_W - w) / 2, (SLOT_H - h) / 2, w, h);
                gl.bindTexture(gl.TEXTURE_2D, tex);
                gl.texSubImage2D(gl.TEXTURE_2D, 0, (k % GRID) * SLOT_W, Math.floor(k / GRID) * SLOT_H, gl.RGBA, gl.UNSIGNED_BYTE, scratch);
                mipDirty = true;
                gsap.to(s, { a: 1, duration: reduceMotion ? 0 : 0.9, ease: "power2.out", delay: 0.05 });
            })
            .catch(() => {});
    }

    function resetSlots() {
        gen++;
        slots.forEach((s) => gsap.killTweensOf(s));
        slots.length = 0;
        slotData.fill(0);
    }

    function syncSlots() {
        if (cv.token !== state.token) {
            cv.token = state.token;
            resetSlots();
            showTitle();
        }
        const n = Math.min(MAX, state.photos.length);
        for (let k = slots.length; k < n; k++) addSlot(state.photos[k]);
        // a sparse wall repeats too obviously: top it up to ~40 frames
        if (cv.isOpen && n < 40 && !state.loading && hasMore() && !cv.fetching) {
            cv.fetching = true;
            loadPage()
                .catch(() => {})
                .finally(() => (cv.fetching = false));
        }
    }

    /* ---------- camera ---------- */
    const cam = { x: 0, y: 0, tx: 0, ty: 0, px: 0, py: 0, vx: 0, vy: 0 };
    const mom = { x: 0, y: 0 };
    const fx = { intro: 0, speed: 0, hover: 0 };
    const BASE_K = reduceMotion ? 0 : 0.1;
    let K = BASE_K;
    let zoom = 1;
    let hoverCell = null;
    let pointer = null; // last pointer position over the canvas
    let drag = null;

    const cv = (window.canvasView = {
        isOpen: false,
        token: -1,
        fetching: false,
        rectFor,
    });

    function resetCamera() {
        cam.x = cam.tx = CW / 2;
        cam.y = cam.ty = CH / 2;
        mom.x = mom.y = 0;
    }

    const mod = (a, n) => ((a % n) + n) % n;
    const colShift = (col) => mod(col * 0.618034, 1) * PY;
    const photoAt = (col, row) => mod(col * 5 + row * 11, slots.length);

    function screenToWorld(x, y) {
        const cx = (x - innerWidth / 2) / innerHeight;
        const cy = (y - innerHeight / 2) / innerHeight;
        const f = 1 - K * (cx * cx + cy * cy);
        return [cam.x + (cx * f * innerHeight) / zoom, cam.y + (cy * f * innerHeight) / zoom];
    }

    function worldToScreen(wx, wy) {
        // invert the lens: solve c * (1 - K|c|²) = d by fixed-point iteration
        const dx = ((wx - cam.x) * zoom) / innerHeight;
        const dy = ((wy - cam.y) * zoom) / innerHeight;
        let cx = dx;
        let cy = dy;
        for (let i = 0; i < 6; i++) {
            const f = 1 - K * (cx * cx + cy * cy);
            cx = dx / f;
            cy = dy / f;
        }
        return [innerWidth / 2 + cx * innerHeight, innerHeight / 2 + cy * innerHeight];
    }

    function pick(x, y) {
        if (!slots.length) return null;
        const [wx, wy] = screenToWorld(x, y);
        const col = Math.floor(wx / PX);
        const wy2 = wy + colShift(col);
        const row = Math.floor(wy2 / PY);
        const lx = wx - col * PX;
        const ly = wy2 - row * PY;
        if (lx > CW || ly > CH) return null;
        return { col, row, idx: photoAt(col, row) };
    }

    function cellRect(col, row) {
        const x0 = col * PX;
        const y0 = row * PY - colShift(col);
        const [ax, ay] = worldToScreen(x0, y0);
        const [bx, by] = worldToScreen(x0 + CW, y0 + CH);
        return { left: ax, top: ay, width: bx - ax, height: by - ay, right: bx, bottom: by };
    }

    // the on-screen tile showing photo i that is closest to the centre
    function rectFor(i) {
        if (!slots.length || i >= slots.length) return null;
        const [l, t] = screenToWorld(0, 0);
        const [r, b] = screenToWorld(innerWidth, innerHeight);
        let best = null;
        let bestD = Infinity;
        for (let col = Math.floor(l / PX) - 1; col <= Math.ceil(r / PX); col++) {
            const sh = colShift(col);
            for (let row = Math.floor((t + sh) / PY) - 1; row <= Math.ceil((b + sh) / PY); row++) {
                if (photoAt(col, row) !== i) continue;
                const rc = cellRect(col, row);
                const d = Math.hypot(rc.left + rc.width / 2 - innerWidth / 2, rc.top + rc.height / 2 - innerHeight / 2);
                if (d < bestD) {
                    bestD = d;
                    best = rc;
                }
            }
        }
        return best;
    }

    /* ---------- input ---------- */
    glc.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        glc.setPointerCapture(e.pointerId);
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), moved: 0, vx: 0, vy: 0 };
        mom.x = mom.y = 0;
        view.classList.add("is-dragging");
    });

    glc.addEventListener("pointermove", (e) => {
        pointer = { x: e.clientX, y: e.clientY };
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        const now = performance.now();
        const dt = Math.max(1, now - drag.t);
        drag.vx = gsap.utils.interpolate(drag.vx, (dx / dt) * 16, 0.5);
        drag.vy = gsap.utils.interpolate(drag.vy, (dy / dt) * 16, 0.5);
        drag.x = e.clientX;
        drag.y = e.clientY;
        drag.t = now;
        drag.moved = Math.max(drag.moved, Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy));
        cam.tx -= (dx * 1.15) / zoom;
        cam.ty -= (dy * 1.15) / zoom;
    });

    function endDrag(e) {
        if (!drag || e.pointerId !== drag.id) return;
        const wasClick = drag.moved < 6;
        if (!wasClick && performance.now() - drag.t < 80) {
            mom.x = -drag.vx * 1.15;
            mom.y = -drag.vy * 1.15;
        }
        drag = null;
        view.classList.remove("is-dragging");
        if (wasClick && e.type === "pointerup") {
            const hit = pick(e.clientX, e.clientY);
            if (hit) {
                const s = slots[hit.idx];
                const i = state.photos.indexOf(s.photo);
                if (i >= 0) openLightbox(i, cellRect(hit.col, hit.row));
            }
        }
    }
    glc.addEventListener("pointerup", endDrag);
    glc.addEventListener("pointercancel", endDrag);
    glc.addEventListener("pointerleave", () => (pointer = null));

    glc.addEventListener(
        "wheel",
        (e) => {
            e.preventDefault();
            const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
            let dx = e.deltaX * unit;
            let dy = e.deltaY * unit;
            if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
            cam.tx += dx / zoom;
            cam.ty += dy / zoom;
        },
        { passive: false }
    );

    document.addEventListener("keydown", (e) => {
        if (!cv.isOpen || !lightbox.hidden) return;
        if (/INPUT|TEXTAREA/.test(document.activeElement?.tagName)) {
            if (e.key === "Escape") document.activeElement.blur();
            return;
        }
        const step = PX * 0.9;
        if (e.key === "Escape") close();
        else if (e.key === "ArrowRight") cam.tx += step;
        else if (e.key === "ArrowLeft") cam.tx -= step;
        else if (e.key === "ArrowDown") cam.ty += step;
        else if (e.key === "ArrowUp") cam.ty -= step;
    });

    /* ---------- render loop ---------- */
    const capEl = q("#cv-cap");
    const xyEl = q("#cv-xy");
    let raf = 0;
    let lastCap = null;

    function resize() {
        measure();
        const dpr = Math.min(devicePixelRatio || 1, 2);
        glc.width = Math.round(innerWidth * dpr);
        glc.height = Math.round(innerHeight * dpr);
        gl.viewport(0, 0, glc.width, glc.height);
    }
    window.addEventListener("resize", () => cv.isOpen && resize());

    function setCursor(label) {
        if (!canHover || reduceMotion) return;
        if (label) {
            cursorLabel.textContent = label;
            cursor.classList.add("is-label");
        } else cursorReset();
    }

    function frame() {
        raf = requestAnimationFrame(frame);
        syncSlots();

        // momentum, then ease the camera toward its target
        if (!drag) {
            cam.tx += mom.x;
            cam.ty += mom.y;
            mom.x *= 0.93;
            mom.y *= 0.93;
        }
        cam.px = cam.x;
        cam.py = cam.y;
        const ease = reduceMotion ? 1 : 0.11;
        cam.x += (cam.tx - cam.x) * ease;
        cam.y += (cam.ty - cam.y) * ease;
        cam.vx = cam.x - cam.px;
        cam.vy = cam.y - cam.py;

        const v = Math.hypot(cam.vx, cam.vy);
        fx.speed += (gsap.utils.clamp(0, 1, v / 38) - fx.speed) * 0.12;
        const intro = fx.intro;
        K = BASE_K + (reduceMotion ? 0 : fx.speed * 0.32 + (1 - intro) * 0.9);
        zoom = reduceMotion ? 1 : gsap.utils.interpolate(0.42, 1, intro) * (1 - fx.speed * 0.08);

        // hover
        const hit = pointer && !drag && lightbox.hidden ? pick(pointer.x, pointer.y) : null;
        const key = hit ? `${hit.col},${hit.row}` : null;
        if (key !== (hoverCell && hoverCell.key)) {
            hoverCell = hit ? { ...hit, key } : null;
            fx.hover = 0;
            setCursor(hit ? "View" : null);
        }
        fx.hover += ((hoverCell && fx.speed < 0.2 ? 1 : 0) - fx.hover) * 0.12;

        const capIdx = hoverCell ? hoverCell.idx : null;
        if (capIdx !== lastCap) {
            lastCap = capIdx;
            const p = capIdx != null ? slots[capIdx]?.photo : null;
            capEl.innerHTML = p
                ? `<b>N° ${pad(state.photos.indexOf(p) + 1)}</b> ${esc(p.user?.name || "Unknown")} <i style="--c:${esc(p.color || "#222")}"></i>${esc((p.color || "").toUpperCase())}`
                : "&nbsp;";
        }
        const coord = (n) => (n < 0 ? "−" : "") + pad(Math.abs(Math.round(n / 10)), 4);
        xyEl.textContent = `X ${coord(cam.x)} · Y ${coord(cam.y)}`;

        // mipmaps are costly on a large atlas: rebuild at most every 250ms
        const now = performance.now();
        if (mipDirty && now - lastMip > 250) {
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.generateMipmap(gl.TEXTURE_2D);
            mipDirty = false;
            lastMip = now;
        }

        for (let k = 0; k < slots.length; k++) slotData[k * 4 + 3] = slots[k].a;

        gl.uniform2f(U.uRes, glc.width, glc.height);
        gl.uniform1f(U.uDpr, glc.width / innerWidth);
        gl.uniform2f(U.uCam, cam.x, cam.y);
        gl.uniform1f(U.uZoom, zoom);
        gl.uniform2f(U.uCell, CW, CH);
        gl.uniform2f(U.uPitch, PX, PY);
        gl.uniform1f(U.uK, K);
        gl.uniform2f(U.uVel, cam.vx, cam.vy);
        gl.uniform1f(U.uCA, reduceMotion ? 0 : fx.speed);
        gl.uniform1i(U.uAtlas, 0);
        gl.uniform1f(U.uGrid, GRID);
        gl.uniform1f(U.uCount, slots.length);
        gl.uniform4fv(U.uSlots, slotData);
        gl.uniform2f(U.uHover, hoverCell ? hoverCell.col : 1e5, hoverCell ? hoverCell.row : 1e5);
        gl.uniform1f(U.uHoverAmt, fx.hover);
        gl.uniform1f(U.uFade, Math.min(1, intro * 2.2));
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    /* ---------- title card ---------- */
    const titleEl = q("#cv-title");
    function showTitle() {
        const text = state.mode === "search" ? `“${esc(state.query)}”` : "Editorial";
        titleEl.innerHTML = `<span>${text}</span>`;
        if (reduceMotion) return;
        const span = titleEl.firstChild;
        gsap.killTweensOf(span);
        gsap.timeline()
            .fromTo(span, { yPercent: 110, opacity: 1 }, { yPercent: 0, duration: 1.1, ease: "expo.out", delay: 0.25 })
            .to(span, { opacity: 0, filter: "blur(12px)", duration: 0.9, ease: "power2.in" }, "+=0.9")
            .set(span, { filter: "none" });
    }

    /* ---------- open / close ---------- */
    function setViewParam(on) {
        try {
            const url = new URL(location.href);
            if (on) url.searchParams.set("view", "canvas");
            else url.searchParams.delete("view");
            history.replaceState(null, "", url);
        } catch (e) {}
    }

    function open() {
        if (cv.isOpen || !state.photos.length) return;
        cv.isOpen = true;
        view.hidden = false;
        lenis?.stop();
        document.body.style.overflow = "hidden";
        dock.classList.add("is-hidden");
        cursorReset();
        resize();
        resetCamera();
        cv.token = -1; // force a fresh title + slot sync
        q("#cv-q").value = state.mode === "search" ? state.query : "";
        setViewParam(true);

        fx.intro = reduceMotion ? 1 : 0;
        cancelAnimationFrame(raf);
        frame();
        if (!reduceMotion) {
            gsap.to(fx, { intro: 1, duration: 2.1, ease: "expo.out" });
            gsap.fromTo(".cv-bar > *, .cv-foot > *", { y: 20, opacity: 0 }, { y: 0, opacity: 1, duration: 1, stagger: 0.06, ease: "expo.out", delay: 0.5 });
        }
        q("#cv-close").focus({ preventScroll: true });
    }

    function close() {
        if (!cv.isOpen) return;
        const done = () => {
            cv.isOpen = false;
            view.hidden = true;
            cancelAnimationFrame(raf);
            document.body.style.overflow = "";
            dock.classList.remove("is-hidden");
            lenis?.start();
            cursorReset();
            setViewParam(false);
            openers[0]?.focus({ preventScroll: true });
        };
        if (reduceMotion) return done();
        gsap.killTweensOf(fx);
        gsap.to(".cv-bar > *, .cv-foot > *", { opacity: 0, duration: 0.3 });
        gsap.to(fx, { intro: 0, duration: 0.8, ease: "expo.in", onComplete: done });
    }

    openers.forEach((b) => b.addEventListener("click", open));
    q("#cv-close").addEventListener("click", close);

    // deep link: ?view=canvas opens the wall once the first page is in
    if (new URLSearchParams(location.search).get("view") === "canvas") {
        const wait = setInterval(() => {
            if (state.photos.length && !document.body.classList.contains("is-loading")) {
                clearInterval(wait);
                setTimeout(open, reduceMotion ? 0 : 900);
            }
        }, 100);
        setTimeout(() => clearInterval(wait), 15000);
    }
})();
