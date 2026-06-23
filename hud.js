/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    ns.ui.openTail();
    ns.ui.resizeTail(700, 520);
    const React = globalThis.React;
    const h = React.createElement;
    const HOME_RESERVE = 24;   // match coordinator: GB kept free on home
    let action = null;         // set by buttons, performed by the loop (no ns calls inside click handlers)

    while (true) {
        // --- perform any pending button action in loop context ---
        if (action) {
            try {
                if (action === "copied") {
                    ns.toast("HUD copied to clipboard", "success", 1500);
                } else if (action === "pull") {
                    const pid = ns.run("pull.js");
                    ns.toast(pid ? "running pull.js" : "pull.js not found", pid ? "info" : "error", 2500);
                } else if (action === "puzzles") {
                    const pid = ns.run("puzzles.js");
                    ns.toast(pid ? "running puzzles.js" : "puzzles.js not found", pid ? "info" : "error", 2500);
                } else if (action === "restart") {
                    let cargs = [];
                    for (const p of ns.ps("home")) if (p.filename === "coordinator.js") { cargs = p.args; break; }
                    ns.scriptKill("coordinator.js", "home");
                    const pid = ns.run("coordinator.js", 1, ...cargs);
                    ns.toast(pid ? ("coordinator restarted " + (cargs.length ? cargs.join(" ") : "(defaults)")) : "coordinator.js not found", pid ? "success" : "error", 2500);
                }
            } catch (e) { ns.toast("action error: " + e, "error", 4000); }
            action = null;
        }

        // --- scan the whole network ---
        const seen = new Set(["home"]);
        const queue = ["home"];
        const all = ["home"];
        while (queue.length) {
            const cur = queue.shift();
            for (const n of ns.scan(cur)) {
                if (!seen.has(n)) { seen.add(n); queue.push(n); all.push(n); }
            }
        }

        // --- tally workers + income per target, count rooted + contracts ---
        const data = {};        // prep-and-hold per target
        const batchData = {};   // batch per target: { threads, income }
        const batchTargets = new Set();   // targets with a bbatch2 controller running
        const controllers = [];           // {kind, label, pid} for coordinator.js + bbatch2.js instances
        const BATCH_WORKERS = new Set(["bhack.js", "bgrow.js", "bweaken.js"]);
        let totalPrep = 0, totalHack = 0, totalBatch = 0, rooted = 0, contracts = 0;
        for (const host of all) {
            if (ns.hasRootAccess(host)) rooted++;
            try { contracts += ns.ls(host, ".cct").length; } catch (e) {}
            const hackHere = new Set();
            for (const p of ns.ps(host)) {
                if (p.filename === "coordinator.js") { controllers.push({ kind: "coord", label: p.args.join(" "), pid: p.pid }); continue; }
                if (p.filename === "bbatch2.js") { if (p.args[0]) batchTargets.add(p.args[0]); controllers.push({ kind: "batch", label: String(p.args[0] || "?"), pid: p.pid }); continue; }
                const t = p.args[0];
                if (!t) continue;
                if (p.filename === "prep.js") {
                    if (!data[t]) data[t] = { prep: 0, hack: 0, income: 0 };
                    data[t].prep += p.threads;
                    totalPrep += p.threads;
                } else if (p.filename === "h.js") {
                    if (!data[t]) data[t] = { prep: 0, hack: 0, income: 0 };
                    data[t].hack += p.threads;
                    totalHack += p.threads;
                    hackHere.add(t);
                } else if (BATCH_WORKERS.has(p.filename)) {
                    if (!batchData[t]) batchData[t] = { threads: 0 };
                    batchData[t].threads += p.threads;
                    totalBatch += p.threads;
                }
            }
            for (const t of hackHere) data[t].income += ns.getScriptIncome("h.js", host, t);
        }
        // Per-target batch income isn't readable: batch workers run with a per-batch [target, msec] arg,
        // so getScriptIncome(file, host, target) can't match them (returns -1). Measure batch income in
        // aggregate instead: total script income minus harvest income (h.js + bhack.js are the only earners).
        const harvestIncome = Object.values(data).reduce((s, d) => s + d.income, 0);

        // --- pool capacity (idle threads = free RAM now; total = idle + deployed) ---
        const workerRam = Math.max(ns.getScriptRam("prep.js", "home"), ns.getScriptRam("h.js", "home")) || 1.75;
        let idle = 0;
        for (const host of all) {
            if (!ns.hasRootAccess(host)) continue;
            const maxR = ns.getServerMaxRam(host);
            if (maxR <= 0) continue;
            let avail = maxR - ns.getServerUsedRam(host);
            if (host === "home") avail -= HOME_RESERVE;
            const free = Math.floor(avail / workerRam);
            if (free > 0) idle += free;
        }
        const deployed = totalPrep + totalHack;
        const total = idle + deployed + totalBatch;

        // --- globals ---
        const lvl = ns.getHackingLevel();
        const cash = ns.getPlayer().money;
        let pserv = 0, cloudRam = 0, cloudMax = 0;
        try {
            const cnames = ns.cloud.getServerNames();
            pserv = cnames.length;
            for (const c of cnames) cloudRam += ns.getServerMaxRam(c);
            cloudMax = ns.cloud.getRamLimit() * ns.cloud.getServerLimit();   // max possible total cloud RAM
        } catch (e) { pserv = 0; cloudRam = 0; cloudMax = 0; }
        let liveIncome = 0;
        try { liveIncome = ns.getTotalScriptIncome()[0]; } catch (e) { liveIncome = 0; }
        let sharePow = 1;
        try { sharePow = ns.getSharePower(); } catch (e) { sharePow = 1; }
        const shareDisp = sharePow > 1.001 ? ("x" + sharePow.toFixed(3)) : "off";

        // --- theme (for sticky bar background so it covers scrolled content) ---
        let theme = {};
        try { theme = ns.ui.getTheme(); } catch (e) {}
        const bg = theme.backgroundprimary || "#1a1a1a";
        const muted = theme.secondary || "#888";
        // --- styling primitives derived from theme, with safe fallbacks ---
        const panelBg     = theme.welllight  || "rgba(255,255,255,0.04)";
        const panelBorder = theme.well       || "#2a2a2a";
        const titleColor  = theme.primary    || "#5fb3d8";
        const moneyColor  = theme.money      || "#ffd166";
        const incomeColor = theme.money      || "#5ce06c";
        const warnColor   = theme.errorlight || "#e06c5c";
        const hackColor   = theme.hack       || "#5fb3d8";
        const shareColor  = sharePow > 1.001 ? (theme.hack || "#5ce06c") : muted;
        // Panel wrapper: titled container with border + background. Title is uppercase + letterspaced for hierarchy.
        const panel = (title, ...children) => h("div", {
            style: {
                border: "1px solid " + panelBorder,
                background: panelBg,
                borderRadius: "6px",
                padding: "6px 10px 8px 10px",
                marginBottom: "8px"
            }
        },
            title ? h("div", {
                style: {
                    fontSize: "10px",
                    fontWeight: 700,
                    letterSpacing: "1.5px",
                    color: titleColor,
                    marginBottom: "6px",
                    paddingBottom: "3px",
                    borderBottom: "1px solid " + panelBorder,
                    textTransform: "uppercase"
                }
            }, title) : null,
            ...children
        );
        // Batch-row tier color from max money. Top earners get visual emphasis at a glance.
        const tierColor = (m) =>
            m >= 1e12 ? moneyColor :         // $1T+ gold
            m >= 4e11 ? "#f29045" :          // $400b+ orange (deep megacorp tier)
            m >= 1e10 ? undefined :          // $10b+ default text color
            muted;                           // sub-$10b muted

        // --- sorted target rows ---
        const rows = Object.keys(data).sort((a, b) =>
            (data[b].income - data[a].income) ||
            (data[b].hack - data[a].hack) ||
            (data[b].prep - data[a].prep));
        const rowMeta = rows.map(t => {
            const max = ns.getServerMaxMoney(t);
            const mon = max > 0 ? (ns.getServerMoneyAvailable(t) / max * 100) : 0;
            const sec = ns.getServerSecurityLevel(t) - ns.getServerMinSecurityLevel(t);
            return { t, mon, sec, prep: data[t].prep, hack: data[t].hack, income: data[t].income };
        });

        // --- batched targets (union of controllers + any running batch workers) ---
        const batchAll = new Set([...batchTargets, ...Object.keys(batchData)]);
        const batchIncome = Math.max(0, liveIncome - harvestIncome);
        const batchMeta = [...batchAll].map(t => {
            const bd = batchData[t] || { threads: 0 };
            const max = ns.getServerMaxMoney(t);
            const mon = max > 0 ? (ns.getServerMoneyAvailable(t) / max * 100) : 0;
            const sec = ns.getServerSecurityLevel(t) - ns.getServerMinSecurityLevel(t);
            return { t, mon, sec, threads: bd.threads, maxMoney: max, prepping: bd.threads === 0 };
        }).sort((a, b) => b.maxMoney - a.maxMoney);

        // --- controller runtimes (coordinator + batchers): exposes duplicate coordinators, orphaned
        // batchers, and whether a restart actually took (uptime resets to ~0) ---
        const ctrlRows = controllers.map(c => {
            let rt = 0;
            try { const rs = ns.getRunningScript(c.pid); if (rs) rt = rs.onlineRunningTime; } catch (e) {}
            let st = null;
            if (c.kind === "batch") {
                try {
                    const raw = ns.read("bstat-" + c.label + ".txt");
                    if (raw) { const o = JSON.parse(raw); if (Date.now() - o.ts < 30000) st = o; }
                } catch (e) {}
            }
            return { kind: c.kind, label: c.label, rt, st };
        }).sort((a, b) => (a.kind === b.kind) ? (b.rt - a.rt) : (a.kind === "coord" ? -1 : 1));
        const coordCount = controllers.filter(c => c.kind === "coord").length;

        // --- text snapshot for the Copy button ---
        const lines = [];
        lines.push("L" + lvl + "  $" + fmt(cash) + "  income +$" + fmt(liveIncome) + "/s (batch +$" + fmt(batchIncome) + "/s)  share " + shareDisp);
        lines.push("threads: total " + grp(total) + "  prep " + grp(totalPrep) + "  hack " + grp(totalHack)
            + "  batch " + grp(totalBatch) + "  idle " + grp(idle));
        lines.push("rooted " + rooted + "  pserv " + pserv + "  contracts " + contracts
            + "  cloud " + fmtRam(cloudRam) + (cloudMax ? " / " + fmtRam(cloudMax) : ""));
        lines.push("");
        lines.push(pad("HARVEST", 20) + padL("MON%", 6) + padL("SEC", 7) + padL("PREP", 8) + padL("HACK", 7) + padL("$/s", 9));
        for (const r of rowMeta) {
            lines.push(pad(r.t, 20) + padL(r.mon.toFixed(1), 6) + padL("+" + r.sec.toFixed(1), 7)
                + padL(grp(r.prep), 8) + padL(grp(r.hack), 7) + padL(fmt(r.income), 9));
        }
        if (batchMeta.length) {
            lines.push("");
            lines.push(pad("BATCH", 20) + padL("MON%", 6) + padL("SEC", 7) + padL("THR", 9) + padL("MAX$", 9));
            for (const r of batchMeta) {
                lines.push(pad(r.t, 20) + padL(r.mon.toFixed(1), 6) + padL("+" + r.sec.toFixed(1), 7)
                    + padL(r.prepping ? "prep" : grp(r.threads), 9) + padL(fmt(r.maxMoney), 9));
            }
        }
        if (ctrlRows.length) {
            lines.push("");
            lines.push("controllers" + (coordCount > 1 ? "  ** " + coordCount + " COORDS! **" : "") + ":");
            for (const c of ctrlRows) {
                const s = c.st;
                lines.push("  " + (c.kind === "coord" ? "coord " : "batch ") + pad(c.label, 14) + " " + fmtDur(c.rt)
                    + (s ? "  fired " + grp(s.f) + "  skip " + grp(s.s) + "  resync " + grp(s.r) : (c.kind === "batch" ? "  (prep)" : "")));
            }
        }
        const snapshot = lines.join("\n");

        // --- REGION: buttons (pinned to top) ---
        const btn = (label, onClick) => h("button",
            {
                onClick,
                style: {
                    padding: "3px 12px",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    fontSize: "12px",
                    background: panelBg,
                    border: "1px solid " + panelBorder,
                    borderRadius: "4px",
                    color: titleColor
                }
            }, label);
        const buttonsRegion = h("div", {
            style: {
                position: "sticky", top: 0, zIndex: 10, background: bg,
                display: "flex", gap: "6px", padding: "4px 0 6px 0", flexWrap: "wrap",
                borderBottom: "1px solid " + muted, marginBottom: "6px"
            }
        },
            btn("Copy", () => { try { globalThis.navigator.clipboard.writeText(snapshot); } catch (e) {} action = "copied"; }),
            btn("Pull", () => { action = "pull"; }),
            btn("Restart Coord", () => { action = "restart"; }),
            btn("Solve Contracts", () => { action = "puzzles"; })
        );

        // --- REGION: pool table (summary values incl. total + idle threads) ---
        const lc = (s) => h("td", { style: { color: muted, padding: "1px 6px 1px 0", whiteSpace: "nowrap" } }, s);
        const vc = (s, color) => h("td", { style: { padding: "1px 18px 1px 0", whiteSpace: "nowrap", fontWeight: 600, color } }, s);
        const prow = (...cells) => h("tr", null, ...cells);
        const poolTable = h("table", { style: { borderCollapse: "collapse", fontSize: "12px" } },
            h("tbody", null,
                prow(lc("Level"),    vc(String(lvl), hackColor),                  lc("Cash"),      vc("$" + fmt(cash), moneyColor)),
                prow(lc("Income/s"), vc("+$" + fmt(liveIncome), incomeColor),     lc("Batch/s"),   vc("+$" + fmt(batchIncome), incomeColor)),
                prow(lc("Total"),    vc(grp(total) + "t"),                        lc("Idle"),      vc(grp(idle) + "t")),
                prow(lc("Prep"),     vc(grp(totalPrep)),                          lc("Hack"),      vc(grp(totalHack))),
                prow(lc("Batch thr"),vc(grp(totalBatch)),                         lc("Share"),     vc(shareDisp, shareColor)),
                prow(lc("Harvesting"),vc(String(rowMeta.length)),                 lc("Batching"),  vc(String(batchMeta.length))),
                prow(lc("Rooted"),   vc(String(rooted)),                          lc("Pserv"),     vc(String(pserv))),
                prow(lc("Contracts"),vc(String(contracts)),                       lc("Cloud RAM"), vc(fmtRam(cloudRam) + (cloudMax ? " / " + fmtRam(cloudMax) : "")))
            )
        );
        const poolPanel = panel("Fleet Status", poolTable);

        // --- REGION: harvest table (prep-and-hold, per-target) ---
        const th = (s, align) => h("th", { style: { textAlign: align, padding: "2px 12px 4px 0", borderBottom: "1px solid " + muted, whiteSpace: "nowrap" } }, s);
        const td = (s, align) => h("td", { style: { textAlign: align, padding: "1px 12px 1px 0", whiteSpace: "nowrap" } }, s);

        // --- REGION: controllers (coordinator + batchers) with uptimes + batch counters; flags dupes/resyncs ---
        const ctrlPanel = ctrlRows.length ? panel(
            coordCount > 1 ? h("span", { style: { color: warnColor } }, "Controllers  ** " + coordCount + " COORDS! **") : "Controllers",
            h("table", { style: { borderCollapse: "collapse", fontSize: "12px" } },
                h("thead", null, h("tr", null,
                    th("NAME", "left"),
                    th("UPTIME", "right"), th("FIRED", "right"), th("SKIP", "right"), th("RESYNC", "right"))),
                h("tbody", null, ...ctrlRows.map((c, i) => {
                    const s = c.st;
                    const resyncCell = s
                        ? h("td", { style: { textAlign: "right", padding: "1px 12px 1px 0", whiteSpace: "nowrap", color: s.r > 0 ? warnColor : undefined, fontWeight: s.r > 0 ? 700 : undefined } }, grp(s.r))
                        : td("", "right");
                    return h("tr", { key: "ctl" + i },
                        td((c.kind === "coord" ? "coord " : "batch ") + c.label, "left"),
                        td(fmtDur(c.rt), "right"),
                        td(s ? grp(s.f) : (c.kind === "batch" ? "prep" : ""), "right"),
                        td(s ? grp(s.s) : "", "right"),
                        resyncCell);
                }))
            )
        ) : null;
        const farmBody = rowMeta.length
            ? rowMeta.map(r => h("tr", { key: r.t },
                td(r.t, "left"),
                td(r.mon.toFixed(1), "right"),
                td("+" + r.sec.toFixed(1), "right"),
                td(grp(r.prep), "right"),
                td(grp(r.hack), "right"),
                h("td", { style: { textAlign: "right", padding: "1px 12px 1px 0", whiteSpace: "nowrap", color: r.income > 0 ? incomeColor : muted } }, fmt(r.income))))
            : [h("tr", { key: "_none" }, h("td", { colSpan: 6, style: { color: muted, padding: "4px 0" } }, "(no harvest workers deployed)"))];
        const farmPanel = panel("Harvest",
            h("table", { style: { borderCollapse: "collapse", fontSize: "12px" } },
                h("thead", null, h("tr", null,
                    th("TARGET", "left"), th("MON%", "right"), th("SEC", "right"),
                    th("PREP", "right"), th("HACK", "right"), th("$/s", "right"))),
                h("tbody", null, ...farmBody)
            )
        );

        // --- REGION: batch table (overlapping HWGW per target); omitted entirely when no batchers run ---
        let batchPanel = null;
        if (batchMeta.length) {
            const bbody = batchMeta.map(r => {
                const tc = tierColor(r.maxMoney);
                const maxCell = h("td", { style: { textAlign: "right", padding: "1px 12px 1px 0", whiteSpace: "nowrap", color: tc, fontWeight: tc === moneyColor || tc === "#f29045" ? 600 : undefined } }, "$" + fmt(r.maxMoney));
                return h("tr", { key: "b_" + r.t },
                    td(r.t, "left"),
                    td(r.mon.toFixed(1), "right"),
                    td("+" + r.sec.toFixed(1), "right"),
                    td(r.prepping ? "prep" : grp(r.threads), "right"),
                    maxCell);
            });
            batchPanel = panel("Batch",
                h("table", { style: { borderCollapse: "collapse", fontSize: "12px" } },
                    h("thead", null, h("tr", null,
                        th("TARGET", "left"), th("MON%", "right"), th("SEC", "right"),
                        th("THREADS", "right"), th("MAX$", "right"))),
                    h("tbody", null, ...bbody)
                )
            );
        }

        // --- render the whole HUD as one tree ---
        ns.clearLog();
        ns.printRaw(h("div", { style: { fontFamily: "inherit", fontSize: "12px" } },
            buttonsRegion, poolPanel, ctrlPanel, farmPanel, batchPanel));

        await ns.sleep(2000);
    }
}

function fmt(n) {
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(2) + "b";
    if (a >= 1e6) return (n / 1e6).toFixed(2) + "m";
    if (a >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return n.toFixed(0);
}
function grp(n) { return Math.round(n).toLocaleString("en-US"); }
function fmtRam(gb) {
    if (gb >= 1e6) return (gb / 1e6).toFixed(2) + " PB";
    if (gb >= 1e3) return (gb / 1e3).toFixed(1) + " TB";
    return Math.round(gb) + " GB";
}
function fmtDur(s) {
    s = Math.floor(s);
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m" + (s % 60 ? (s % 60) + "s" : "");
    return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m";
}
function pad(s, n) { s = String(s); return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length); }
function padL(s, n) { s = String(s); return s.length >= n ? s : " ".repeat(n - s.length) + s; }
