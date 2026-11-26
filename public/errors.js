/* ==========================================================
   APERTURE — error reporting
   Uncaught errors and rejected promises are sent to /api/log, which writes
   them to the Vercel function logs. Reports carry the message, a trimmed
   stack and the page path only: no query string (search terms), no board
   contents, nothing that identifies the visitor. Loaded before everything else.
========================================================== */
(() => {
    const ENDPOINT = "/api/log";
    const MAX_PER_PAGE = 8;
    const seen = new Set();
    let sent = 0;

    // keep stack frames short and drop query strings / fragments from any URL in them
    const scrub = (s, n) =>
        String(s || "")
            .replace(/https?:\/\/[^\s)]+/g, (u) => u.replace(/[?#].*$/, ""))
            .slice(0, n);

    function report(kind, message, stack) {
        message = scrub(message, 300);
        if (!message || sent >= MAX_PER_PAGE) return;
        // extensions and cross-origin scripts produce noise we can't act on
        if (/^Script error\.?$/.test(message) || /extension:\/\//.test(stack || "")) return;
        const key = kind + message;
        if (seen.has(key)) return;
        seen.add(key);
        sent++;
        const body = JSON.stringify({
            kind,
            message,
            stack: scrub(stack, 1500),
            path: location.pathname,
            view: new URLSearchParams(location.search).get("view") === "canvas" ? "canvas" : "grid",
            build: document.documentElement.dataset.build || "",
        });
        try {
            if (navigator.sendBeacon) navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
            else fetch(ENDPOINT, { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true }).catch(() => {});
        } catch (e) {}
    }

    window.addEventListener("error", (e) => report("error", e.message, e.error?.stack || `${e.filename}:${e.lineno}:${e.colno}`));
    window.addEventListener("unhandledrejection", (e) => {
        const r = e.reason;
        report("rejection", r?.message || String(r), r?.stack || "");
    });

    // for handled failures worth knowing about (storage full, export failed…)
    window.reportProblem = (message, err) => report("handled", message, err?.stack || err?.message || "");
})();
