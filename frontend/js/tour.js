/* ==========================================================
   APERTURE — first-run walkthrough for the pin board
   Five short steps the first time someone opens an editable board, each
   pointing at the real control. "?" replays it; Escape skips it.
   Remembered in localStorage (aperture:tour) so it shows once.
========================================================== */
(() => {
    const KEY = "aperture:tour";
    const board = document.querySelector("#pb");
    if (!board) return;
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

    const done = () => {
        try {
            return localStorage.getItem(KEY) === "done";
        } catch (e) {
            return true; // no storage: don't nag on every open
        }
    };
    const markDone = () => {
        try {
            localStorage.setItem(KEY, "done");
        } catch (e) {}
    };

    const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
    // first card pin that is actually on screen
    const onScreenPin = () => {
        const area = document.querySelector("#pb-area").getBoundingClientRect();
        return [...document.querySelectorAll(".pb-card .pb-pin")].find((p) => {
            const r = p.getBoundingClientRect();
            return r.width && r.left > area.left && r.right < area.right && r.top > area.top && r.bottom < area.bottom;
        });
    };

    const STEPS = [
        {
            target: () => onScreenPin() || document.querySelector("#pb-add"),
            title: "Tie ideas together",
            text: () =>
                onScreenPin()
                    ? "Drag a photo’s red pin onto another photo to tie a thread. Click the knot on a thread to label it."
                    : "Once there are photos here, drag one’s red pin onto another to tie a thread between them.",
        },
        {
            target: () => document.querySelector("#pb-add"),
            title: "Bring anything in",
            text: () => "Add your own images, links and notes, or just drop and paste them onto the board. W pulls photos from the wall.",
        },
        {
            target: () => document.querySelector("#pb-area"),
            title: "Select and arrange",
            text: () => "Shift + drag to select several cards, then line them up or group them from the bar that appears. Right-click (or long-press) anything for more.",
            inside: true,
        },
        {
            target: () => document.querySelector("#pb-frame"),
            title: "Group into frames",
            text: () => "Group draws a titled frame. Photos inside it move with it.",
        },
        {
            target: () => document.querySelector("#pb-share"),
            title: "Share a view-only copy",
            text: () => "Share copies a link with the whole board inside it: nothing is uploaded. Press ? any time to see this again.",
        },
    ];

    let tip = null;
    let ring = null;
    let i = 0;
    let active = false;
    let returnFocus = null;

    function build() {
        ring = document.createElement("div");
        ring.className = "tour-ring";
        ring.setAttribute("aria-hidden", "true");
        tip = document.createElement("div");
        tip.className = "tour";
        tip.setAttribute("role", "dialog");
        tip.setAttribute("aria-labelledby", "tour-title");
        tip.setAttribute("aria-describedby", "tour-text");
        tip.innerHTML = `
            <p class="tour-step mono" id="tour-step"></p>
            <h3 class="tour-title" id="tour-title"></h3>
            <p class="tour-text" id="tour-text"></p>
            <div class="tour-actions mono">
                <button type="button" class="tour-skip" data-act="skip">Skip</button>
                <span class="tour-gap"></span>
                <button type="button" class="tour-back" data-act="back">Back</button>
                <button type="button" class="tour-next" data-act="next">Next</button>
            </div>`;
        tip.addEventListener("click", (e) => {
            const act = e.target.closest("[data-act]")?.dataset.act;
            if (act === "skip") end();
            else if (act === "back") show(i - 1);
            else if (act === "next") i === STEPS.length - 1 ? end() : show(i + 1);
        });
        // keep pointer gestures on the tip from reaching the board underneath
        tip.addEventListener("pointerdown", (e) => e.stopPropagation());
        board.append(ring, tip);
    }

    function place() {
        if (!tip || tip.hidden) return;
        const step = STEPS[i];
        const el = step.target();
        const vw = innerWidth;
        const vh = innerHeight;
        const tw = tip.offsetWidth;
        const th = tip.offsetHeight;
        if (!visible(el)) {
            ring.hidden = true;
            tip.style.left = `${(vw - tw) / 2}px`;
            tip.style.top = `${(vh - th) / 2}px`;
            return;
        }
        const r = el.getBoundingClientRect();
        let x;
        let y;
        if (step.inside) {
            // a big target (the board area): highlight a margin inside it and centre the tip
            ring.hidden = false;
            Object.assign(ring.style, { left: `${r.left + 12}px`, top: `${r.top + 12}px`, width: `${r.width - 24}px`, height: `${r.height - 24}px` });
            x = r.left + (r.width - tw) / 2;
            y = r.top + (r.height - th) / 2;
        } else {
            const pad = 6;
            ring.hidden = false;
            Object.assign(ring.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
            x = r.left + r.width / 2 - tw / 2;
            y = r.bottom + 16;
            if (y + th > vh - 16) y = r.top - th - 16;
        }
        tip.style.left = `${Math.max(16, Math.min(vw - tw - 16, x))}px`;
        tip.style.top = `${Math.max(16, Math.min(vh - th - 16, y))}px`;
    }

    function show(n) {
        i = Math.max(0, Math.min(STEPS.length - 1, n));
        const step = STEPS[i];
        tip.querySelector("#tour-step").textContent = `${i + 1} / ${STEPS.length}`;
        tip.querySelector("#tour-title").textContent = step.title;
        tip.querySelector("#tour-text").textContent = step.text();
        tip.querySelector(".tour-back").hidden = i === 0;
        tip.querySelector(".tour-next").textContent = i === STEPS.length - 1 ? "Done" : "Next";
        tip.hidden = false;
        place();
        if (!reduceMotion && window.gsap) gsap.fromTo(tip, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.3, ease: "expo.out" });
        tip.querySelector(".tour-next").focus({ preventScroll: true });
    }

    function start() {
        if (board.hidden || board.classList.contains("is-readonly")) return;
        if (!tip) build();
        if (active) return;
        active = true;
        returnFocus = document.activeElement;
        board.classList.add("is-touring");
        show(0);
    }

    function end() {
        if (!active) return;
        active = false;
        markDone();
        tip.hidden = true;
        ring.hidden = true;
        board.classList.remove("is-touring");
        if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
        else document.querySelector("#pb-area")?.focus({ preventScroll: true });
    }

    // the board dispatches this once it has opened (see pins.js openBoard)
    document.addEventListener("pins:open", (e) => {
        if (done() || e.detail?.readonly) return;
        // let the opening animation finish first
        setTimeout(() => !board.hidden && start(), reduceMotion ? 50 : 1100);
    });
    document.addEventListener("pins:close", () => active && end());

    // captured before the board's own keys: Escape ends the tour without closing the board
    document.addEventListener(
        "keydown",
        (e) => {
            if (active) {
                if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    end();
                } else if (e.key === "ArrowRight" && !e.target.closest("input, textarea")) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    i === STEPS.length - 1 ? end() : show(i + 1);
                } else if (e.key === "ArrowLeft" && !e.target.closest("input, textarea")) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    show(i - 1);
                }
                return;
            }
            if (e.key === "?" && !board.hidden && !e.ctrlKey && !e.metaKey && !e.altKey && !e.target.closest("input, textarea, [contenteditable]")) {
                e.preventDefault();
                e.stopImmediatePropagation();
                start();
            }
        },
        true
    );

    addEventListener("resize", () => active && place());
    // the camera can move under a pin step; keep the ring on it
    board.addEventListener("wheel", () => active && requestAnimationFrame(place), { passive: true });

    window.tour = { start, end, isActive: () => active };
})();
