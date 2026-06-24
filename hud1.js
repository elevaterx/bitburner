/** hud1.js -- always-on display: RAM gauge, collapsed fleet status, launch controls.
 *  Base Netscript only -- no Singularity calls -> cheap, fits in any RAM situation.
 *
 *  Replaces hud.js as the always-on monitor. Removes info already shown by the standard
 *  Overview panel (HP/money/hacking/stats/working-state). Per-target harvest+batch detail
 *  is available on-demand via the "list" buttons (dumped to terminal). For faction rep
 *  and aug planning, launch hud2.js (Singularity-driven, RAM-expensive).
 *
 *  Must be added to pull.js. @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    ns.ui.openTail();
    ns.ui.resizeTail(560, 480);
    const React = globalThis.React;
    const h = React.createElement;
    const HOME_RESERVE = 24;   // match coordinator: GB kept free on home
    let action = null;
    let pendingDump = null;    // "harvest" | "batch" -- printed to terminal next loop
    let statusText = "";       // updated each loop; click handler reads the latest snapshot

    while (true) {
        // --- pending button actions ---
        if (action) {
            try {
                if (action === "pull") {
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
                    ns.toast(pid ? ("coord restarted " + (cargs.length ? cargs.join(" ") : "(defaults)")) : "coordinator.js not found", pid ? "success" : "error", 2500);
                } else if (action === "hud2") {
                    const pid = ns.run("hud2.js");
                    ns.toast(pid ? "launched hud2" : "hud2.js not found or insufficient RAM", pid ? "info" : "error", 2500);
                } else if (action === "killhud2") {
                    const killed = ns.scriptKill("hud2.js", "home");
                    ns.toast(killed ? "killed hud2" : "hud2 not running", killed ? "info" : "warning", 2000);
                } else if (action === "killshare") {
                    // fleet-wide kill of the share system: sharecap.js (controller, on home) AND
                    // all sh.js workers (the actual RAM consumers, spread across the fleet). Killing
                    // only the controller would orphan the workers, leaving their RAM held with no
                    // manager -- so we must sweep sh.js across every host. Leaves coord, prep/h
                    // workers, sing, huds untouched.
                    // NOTE: own local scan -- the main loop's `all` isn't built until after this block.
                    const sseen = new Set(["home"]), sq = ["home"], shosts = ["home"];
                    while (sq.length) { const c = sq.shift(); for (const n of ns.scan(c)) if (!sseen.has(n)) { sseen.add(n); sq.push(n); shosts.push(n); } }
                    let ctrl = ns.scriptKill("sharecap.js", "home");
                    let workerProcs = 0;
                    for (const host of shosts) {
                        for (const p of ns.ps(host)) {
                            if (p.filename === "sh.js") { ns.kill(p.pid); workerProcs++; }
                        }
                    }
                    ns.toast("killed share: controller " + (ctrl ? "yes" : "no") + ", " + workerProcs + " sh.js worker proc(s)", "success", 3000);
                } else if (action === "killcoord") {
                    // kill the coordinator process only. Its prep/h workers keep running (self-loop);
                    // restart coord later to re-adopt them. Use for the sharecap boot-order dance.
                    const killed = ns.scriptKill("coordinator.js", "home");
                    ns.toast(killed ? "killed coord (workers still running)" : "coord not running", killed ? "success" : "warning", 2500);
                } else if (action === "resetcoord") {
                    // full reset: kill coord AND all prep/h workers fleet-wide for a clean re-allocation.
                    // Does NOT auto-restart -- you restart coord (or via the restart button) to re-place
                    // from scratch. Use when you want better server selection, not just a process bounce.
                    // NOTE: own local scan -- the main loop's `all` isn't built until after this block.
                    const rseen = new Set(["home"]), rq = ["home"], rhosts = ["home"];
                    while (rq.length) { const c = rq.shift(); for (const n of ns.scan(c)) if (!rseen.has(n)) { rseen.add(n); rq.push(n); rhosts.push(n); } }
                    ns.scriptKill("coordinator.js", "home");
                    let killed = 0;
                    for (const host of rhosts) {
                        for (const p of ns.ps(host)) {
                            if (p.filename === "prep.js" || p.filename === "h.js") { ns.kill(p.pid); killed++; }
                        }
                    }
                    ns.toast("reset coord + killed " + killed + " worker proc(s) -- restart coord now", "success", 3500);
                }
            } catch (e) { ns.toast("action error: " + e, "error", 4000); }
            action = null;
        }

        // --- BFS network scan ---
        const seen = new Set(["home"]), q = ["home"], all = ["home"];
        while (q.length) {
            const c = q.shift();
            for (const n of ns.scan(c)) if (!seen.has(n)) { seen.add(n); q.push(n); all.push(n); }
        }

        // --- tally workers, income, controllers ---
        const data = {};            // harvest per target
        const batchData = {};       // batch per target
        const batchTargets = new Set();
        const controllers = [];
        const BATCH_WORKERS = new Set(["bhack.js", "bgrow.js", "bweaken.js"]);
        const scriptTally = {};     // filename -> { threads, ramGB } across ALL hosts (every process)
        let totalPrep = 0, totalHack = 0, totalBatch = 0, rooted = 0, contracts = 0;
        let shareThreads = 0;       // aggregate sh.js worker threads across the fleet
        for (const host of all) {
            if (ns.hasRootAccess(host)) rooted++;
            try { contracts += ns.ls(host, ".cct").length; } catch (e) {}
            const hackHere = new Set();
            for (const p of ns.ps(host)) {
                // global per-script tally -- catches EVERYTHING (share, orphans, controllers, workers)
                if (!scriptTally[p.filename]) scriptTally[p.filename] = { threads: 0, ramGB: 0 };
                scriptTally[p.filename].threads += p.threads;
                let perThreadRam = 0;
                try { perThreadRam = ns.getScriptRam(p.filename, host); } catch (e) {}
                scriptTally[p.filename].ramGB += perThreadRam * p.threads;

                if (p.filename === "coordinator.js") { controllers.push({ kind: "coord", label: p.args.join(" "), pid: p.pid }); continue; }
                if (p.filename === "bbatch2.js") { if (p.args[0]) batchTargets.add(p.args[0]); controllers.push({ kind: "batch", label: String(p.args[0] || "?"), pid: p.pid }); continue; }
                if (p.filename === "sharecap.js") { controllers.push({ kind: "share", label: "", pid: p.pid }); continue; }
                if (p.filename === "sh.js") { shareThreads += p.threads; continue; }
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
        const harvestIncome = Object.values(data).reduce((s, d) => s + d.income, 0);
        const harvestServers = Object.keys(data).filter(t => !batchTargets.has(t)).length;

        // --- pool capacity (idle threads + total) ---
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

        // --- RAM gauge: home, cloud, network ---
        const homeMax = ns.getServerMaxRam("home");
        const homeUsed = ns.getServerUsedRam("home");
        let cloudUsed = 0, cloudMax = 0, cloudCount = 0;
        const cloudSet = new Set();
        try {
            const cnames = ns.cloud.getServerNames();
            cloudCount = cnames.length;
            for (const c of cnames) {
                cloudSet.add(c);
                cloudMax += ns.getServerMaxRam(c);
                cloudUsed += ns.getServerUsedRam(c);
            }
        } catch (e) {}
        let netUsed = 0, netMax = 0, netCount = 0;
        for (const host of all) {
            if (host === "home" || cloudSet.has(host)) continue;
            if (!ns.hasRootAccess(host)) continue;
            const m = ns.getServerMaxRam(host); if (m <= 0) continue;
            netMax += m;
            netUsed += ns.getServerUsedRam(host);
            netCount++;
        }

        // --- live income, share, batch income (aggregate-derived) ---
        let liveIncome = 0;
        try { liveIncome = ns.getTotalScriptIncome()[0]; } catch (e) {}
        const batchIncome = Math.max(0, liveIncome - harvestIncome);
        let sharePow = 1;
        try { sharePow = ns.getSharePower(); } catch (e) {}
        const shareDisp = sharePow > 1.001 ? ("x" + sharePow.toFixed(3)) : "off";

        // --- terminal dump (pending from a list-button click last render) ---
        if (pendingDump === "harvest") {
            ns.tprint("=== harvest detail ===");
            ns.tprint("server                   MON%   SEC    PREP    HACK      $/s");
            const sorted = Object.entries(data).filter(([t]) => !batchTargets.has(t)).sort((a, b) => b[1].income - a[1].income);
            for (const [t, d] of sorted) {
                const max = ns.getServerMaxMoney(t) || 1;
                const cur = ns.getServerMoneyAvailable(t);
                const sec = ns.getServerSecurityLevel(t) - ns.getServerMinSecurityLevel(t);
                ns.tprint(
                    t.padEnd(24) + (cur / max * 100).toFixed(1).padStart(5) + "  " +
                    ("+" + sec.toFixed(1)).padStart(5) + "  " +
                    String(d.prep).padStart(6) + "  " +
                    String(d.hack).padStart(6) + "  " +
                    ("$" + fmt(d.income)).padStart(9)
                );
            }
            pendingDump = null;
        } else if (pendingDump === "batch") {
            ns.tprint("=== batch detail ===  (per-server income not directly readable; aggregate $" + fmt(batchIncome) + "/s)");
            ns.tprint("server                   MON%   SEC   threads");
            const sorted = Object.entries(batchData).sort((a, b) => b[1].threads - a[1].threads);
            for (const [t, d] of sorted) {
                const max = ns.getServerMaxMoney(t) || 1;
                const cur = ns.getServerMoneyAvailable(t);
                const sec = ns.getServerSecurityLevel(t) - ns.getServerMinSecurityLevel(t);
                ns.tprint(
                    t.padEnd(24) + (cur / max * 100).toFixed(1).padStart(5) + "  " +
                    ("+" + sec.toFixed(1)).padStart(5) + "  " +
                    String(d.threads).padStart(7)
                );
            }
            pendingDump = null;
        }

        // --- theme ---
        let theme = {};
        try { theme = ns.ui.getTheme(); } catch (e) {}
        const bg = theme.backgroundprimary || "#1a1a1a";
        const muted = theme.secondary || "#888";
        const panelBg = theme.welllight || "rgba(255,255,255,0.04)";
        const panelBorder = theme.well || "#2a2a2a";
        const titleColor = theme.primary || "#5fb3d8";
        const moneyColor = theme.money || "#ffd166";
        const incomeColor = theme.money || "#5ce06c";
        const warnColor = theme.errorlight || "#e06c5c";
        const hackColor = theme.hack || "#5fb3d8";
        const shareColor = sharePow > 1.001 ? (theme.hack || "#5ce06c") : muted;

        const panel = (title, ...children) => h("div", {
            style: { background: panelBg, border: "1px solid " + panelBorder, borderRadius: 4, padding: "6px 8px", marginBottom: 6 },
        },
            h("div", { style: { color: titleColor, fontSize: 10, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 4 } }, title),
            ...children
        );

        const row = (a, b) => h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 12, lineHeight: 1.5 } },
            h("span", null, a), h("span", null, b)
        );

        // RAM bar: label, filled proportion, numbers + percent
        const ramBar = (label, used, max, count) => {
            const pct = max > 0 ? Math.min(100, Math.round(used / max * 100)) : 0;
            const barColor = pct > 90 ? warnColor : (pct > 75 ? moneyColor : incomeColor);
            const countStr = count !== undefined ? " (" + count + ")" : "";
            return h("div", { style: { marginBottom: 4 } },
                h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 11 } },
                    h("span", null, label + countStr),
                    h("span", { style: { color: muted } }, fmtGB(used) + " / " + fmtGB(max) + "  " + pct + "%")
                ),
                h("div", { style: { height: 6, background: panelBorder, borderRadius: 2, overflow: "hidden", marginTop: 2 } },
                    h("div", { style: { width: pct + "%", height: "100%", background: barColor } })
                )
            );
        };

        const btn = (label, onClick, color) => h("button", {
            onClick: onClick,
            style: {
                padding: "3px 8px", fontSize: 11, background: "transparent",
                border: "1px solid " + (color || panelBorder), color: color || muted,
                borderRadius: 3, cursor: "pointer", marginRight: 4, marginBottom: 3,
            },
        }, label);

        // controller uptime via getRunningScript
        const ctrlLabel = (c) => (c.kind === "coord" ? "coord " : c.kind === "batch" ? "batch " : c.kind === "share" ? "share " : c.kind + " ") + c.label;
        // share controller label was left blank during scan; fill it with the aggregate sh.js
        // worker thread count (the meaningful number -- the controller itself is 1 thread on home).
        for (const c of controllers) if (c.kind === "share") c.label = shareThreads + "t workers";
        const ctrlRows = controllers.map(c => {
            let up = "?";
            try { const info = ns.getRunningScript(c.pid); if (info) up = fmtTime(info.onlineRunningTime); } catch (e) {}
            return h("div", { key: c.pid, style: { display: "flex", justifyContent: "space-between", fontSize: 11 } },
                h("span", null, ctrlLabel(c)),
                h("span", { style: { color: muted } }, up)
            );
        });

        // --- build status snapshot text for the [snapshot] button (held in scope for click handler) ---
        const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
        const cash = ns.getPlayer().money;
        const lvl = ns.getHackingLevel();
        const homePct = homeMax > 0 ? Math.round(homeUsed / homeMax * 100) : 0;
        const cloudPct = cloudMax > 0 ? Math.round(cloudUsed / cloudMax * 100) : 0;
        const netPct = netMax > 0 ? Math.round(netUsed / netMax * 100) : 0;
        const lines = [];
        lines.push("=== bb-status @ " + ts + " ===");
        lines.push("level " + lvl + "  cash $" + fmt(cash) + "  income $" + fmt(liveIncome) + "/s  share " + shareDisp + "  rooted " + rooted + "  contracts " + contracts);
        lines.push("");
        lines.push("RAM");
        lines.push("  home    " + fmtGB(homeUsed) + " / " + fmtGB(homeMax) + "   " + homePct + "%");
        lines.push("  cloud   " + fmtGB(cloudUsed) + " / " + fmtGB(cloudMax) + "   " + cloudPct + "% (" + cloudCount + " srv)");
        lines.push("  network " + fmtGB(netUsed) + " / " + fmtGB(netMax) + "   " + netPct + "% (" + netCount + " srv)");
        lines.push("");
        lines.push("THREADS");
        lines.push("  deployed " + deployed + "  batch " + totalBatch + "  idle " + idle + "  total " + total);
        lines.push("  harvest income $" + fmt(harvestIncome) + "/s   batch income $" + fmt(batchIncome) + "/s");
        lines.push("");
        // per-script RAM+thread breakdown -- reveals what's actually consuming the fleet
        // (share workers, orphaned crews, controllers). Sorted by RAM descending.
        lines.push("RAM BY SCRIPT");
        const tallyRows = Object.entries(scriptTally).sort((a, b) => b[1].ramGB - a[1].ramGB);
        if (tallyRows.length === 0) {
            lines.push("  (nothing running)");
        } else {
            for (const [fn, t] of tallyRows) {
                lines.push("  " + fn.padEnd(20) + String(t.threads).padStart(7) + " threads   " + fmtGB(t.ramGB).padStart(9));
            }
        }
        lines.push("");
        lines.push("HARVEST (" + harvestServers + " server" + (harvestServers === 1 ? "" : "s") + ")");
        if (harvestServers === 0) {
            lines.push("  (none)");
        } else {
            lines.push("  server                   MON%   SEC    PREP    HACK      $/s");
            const sorted = Object.entries(data).filter(([t]) => !batchTargets.has(t)).sort((a, b) => b[1].income - a[1].income);
            for (const [t, d] of sorted) {
                const max = ns.getServerMaxMoney(t) || 1;
                const cur = ns.getServerMoneyAvailable(t);
                const sec = ns.getServerSecurityLevel(t) - ns.getServerMinSecurityLevel(t);
                lines.push(
                    "  " + t.padEnd(22) +
                    (cur / max * 100).toFixed(1).padStart(5) + "  " +
                    ("+" + sec.toFixed(1)).padStart(5) + "  " +
                    String(d.prep).padStart(6) + "  " +
                    String(d.hack).padStart(6) + "  " +
                    ("$" + fmt(d.income)).padStart(9)
                );
            }
        }
        lines.push("");
        const batchCount = Object.keys(batchData).length;
        lines.push("BATCH (" + batchCount + " server" + (batchCount === 1 ? "" : "s") + ")");
        if (batchCount === 0) {
            lines.push("  (none)");
        } else {
            lines.push("  server                   MON%   SEC   threads");
            const sorted = Object.entries(batchData).sort((a, b) => b[1].threads - a[1].threads);
            for (const [t, d] of sorted) {
                const max = ns.getServerMaxMoney(t) || 1;
                const cur = ns.getServerMoneyAvailable(t);
                const sec = ns.getServerSecurityLevel(t) - ns.getServerMinSecurityLevel(t);
                lines.push(
                    "  " + t.padEnd(22) +
                    (cur / max * 100).toFixed(1).padStart(5) + "  " +
                    ("+" + sec.toFixed(1)).padStart(5) + "  " +
                    String(d.threads).padStart(7)
                );
            }
        }
        lines.push("");
        lines.push("CONTROLLERS");
        if (controllers.length === 0) {
            lines.push("  (none)");
        } else {
            for (const c of controllers) {
                let up = "?";
                try { const info = ns.getRunningScript(c.pid); if (info) up = fmtTime(info.onlineRunningTime); } catch (e) {}
                lines.push("  " + ctrlLabel(c).padEnd(28) + up);
            }
        }
        lines.push("");
        // --- try to read hud2's data file (written each hud2 render). If fresh, include faction
        // and per-aug detail. hud1 stays Singularity-free; ns.read is base Netscript. ---
        let hud2Read = null;
        try {
            const raw = ns.read("hud2-data.txt");
            if (raw && raw.length > 0) hud2Read = JSON.parse(raw);
        } catch (e) {}
        if (!hud2Read) {
            lines.push("(hud2 data file not found -- launch hud2 to capture faction/aug state)");
        } else {
            const age = Date.now() - (hud2Read.ts || 0);
            if (age > 15000) {
                lines.push("(hud2 data is stale by " + Math.floor(age / 1000) + "s -- hud2 not running)");
            } else {
                // installed augs -- NFG appears at most once in the array regardless of stacked level;
                // the real level comes from hud2's rep-req-derived nfg.level field. Filter NFG out of
                // the per-aug list and append it as "NeuroFlux Governor LN" using the derived level.
                const inst = hud2Read.installed || [];
                const others = inst.filter(a => !a.startsWith("NeuroFlux Governor"));
                const nfgLvl = (hud2Read.nfg && hud2Read.nfg.level) || 0;
                const totalCount = others.length + (nfgLvl > 0 ? nfgLvl : 0);
                lines.push("INSTALLED (" + totalCount + " total: " + others.length + " unique + NFG L" + nfgLvl + ")");
                if (others.length === 0 && nfgLvl === 0) {
                    lines.push("  (none)");
                } else {
                    for (const a of others) lines.push("  " + a);
                    if (nfgLvl > 0) lines.push("  NeuroFlux Governor L" + nfgLvl);
                }
                lines.push("");
                const n = hud2Read.nfg || {};
                lines.push("NEUROFLUX");
                lines.push("  level L" + nfgLvl);
                if (n.nextRep !== null && n.nextRep !== undefined && n.nextCost !== null && n.nextCost !== undefined) {
                    lines.push("  next:  rep " + fmt(n.nextRep) + "   $" + fmt(n.nextCost));
                }
                lines.push("");
                const facs = hud2Read.factions || [];
                lines.push("FACTIONS (" + facs.length + ")");
                if (facs.length === 0) {
                    lines.push("  (none joined)");
                } else {
                    for (const f of facs) {
                        lines.push("  " + f.name.padEnd(22) +
                            " rep " + fmt(f.rep).padStart(9) +
                            "  favor " + (f.favor || 0).toFixed(1).padStart(6) +
                            "  augs remaining " + (f.augs ? f.augs.length : 0));
                        if (f.augs && f.augs.length > 0) {
                            lines.push("    " + "aug".padEnd(34) + " rep req     cost      hacking mults");
                            for (const a of f.augs) {
                                const multStr = Object.entries(a.mults || {})
                                    .map(([k, v]) => k.replace("hacking", "h") + " " + v.toFixed(2)).join(" ");
                                lines.push("    " + a.name.padEnd(34) +
                                    " " + fmt(a.rep).padStart(7) +
                                    "  $" + fmt(a.cost).padStart(8) +
                                    (multStr ? "   " + multStr : ""));
                            }
                        }
                        lines.push("");
                    }
                }
            }
        }
        statusText = lines.join("\n");

        // --- render ---
        ns.clearLog();
        ns.printRaw(h("div", { style: { fontFamily: "monospace", background: bg, padding: 6 } },
            panel("RAM",
                ramBar("home", homeUsed, homeMax),
                ramBar("cloud", cloudUsed, cloudMax, cloudCount),
                ramBar("network", netUsed, netMax, netCount),
            ),
            panel("FLEET",
                row("rooted", rooted),
                row("contracts", h("span", { style: { color: contracts > 0 ? incomeColor : muted } }, contracts)),
                row("share", h("span", { style: { color: shareColor } }, shareDisp)),
                row("income", h("span", { style: { color: incomeColor } }, "$" + fmt(liveIncome) + "/s")),
                h("div", { style: { borderTop: "1px solid " + panelBorder, marginTop: 4, paddingTop: 4 } }),
                h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 } },
                    h("span", null, "harvest"),
                    h("span", null, harvestServers + " srv  " + (totalPrep + totalHack) + " t  $" + fmt(harvestIncome) + "/s"),
                    btn("list", () => { pendingDump = "harvest"; }),
                ),
                h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, marginTop: 2 } },
                    h("span", null, "batch"),
                    h("span", null, Object.keys(batchData).length + " srv  " + totalBatch + " t  $" + fmt(batchIncome) + "/s"),
                    btn("list", () => { pendingDump = "batch"; }),
                ),
                h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 11, color: muted, marginTop: 4 } },
                    h("span", null, "threads"),
                    h("span", null, "dep " + deployed + "  batch " + totalBatch + "  idle " + idle + "  tot " + total)
                ),
            ),
            panel("CONTROLLERS",
                ...(ctrlRows.length === 0 ? [h("div", { style: { color: muted, fontSize: 11 } }, "(none)")] : ctrlRows)
            ),
            panel("CONTROLS",
                h("div", { style: { display: "flex", flexWrap: "wrap" } },
                    btn("pull", () => { action = "pull"; }, hackColor),
                    btn("puzzles", () => { action = "puzzles"; }, hackColor),
                    btn("restart coord", () => { action = "restart"; }, hackColor),
                    btn("kill coord", () => { action = "killcoord"; }, warnColor),
                    btn("reset coord", () => { action = "resetcoord"; }, warnColor),
                    btn("kill share", () => { action = "killshare"; }, warnColor),
                    btn("launch hud2", () => { action = "hud2"; }, titleColor),
                    btn("kill hud2", () => { action = "killhud2"; }, warnColor),
                    btn("snapshot", () => {
                        // download statusText as a timestamped .txt via pure browser APIs.
                        // Safe inside an onClick (no ns calls). statusText is set each loop and
                        // closure captures the outer-scope binding so click always sees the latest.
                        try {
                            const blob = new Blob([statusText], { type: "text/plain" });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = "bb-status-" + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "") + ".txt";
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(url);
                        } catch (e) {
                            // best-effort fallback: stash for terminal dump next loop via action queue.
                            // ns.toast can't be called here -- the loop's action handler can't help either
                            // since this isn't a recognized action. So just log to console for debug.
                            console && console.error && console.error("snapshot download failed:", e);
                        }
                    }, incomeColor),
                )
            ),
        ));

        await ns.sleep(2000);
    }
}

function fmt(n) {
    if (!isFinite(n)) return "--";
    const a = Math.abs(n);
    if (a >= 1e12) return (n / 1e12).toFixed(2) + "t";
    if (a >= 1e9)  return (n / 1e9).toFixed(2)  + "b";
    if (a >= 1e6)  return (n / 1e6).toFixed(2)  + "m";
    if (a >= 1e3)  return (n / 1e3).toFixed(1)  + "k";
    return n.toFixed(0);
}
function fmtGB(gb) {
    if (gb >= 1e6) return (gb / 1e6).toFixed(2) + "PB";
    if (gb >= 1e3) return (gb / 1e3).toFixed(2) + "TB";
    return gb.toFixed(0) + "GB";
}
function fmtTime(secs) {
    secs = Math.floor(secs);
    const m = Math.floor(secs / 60), s = secs % 60;
    if (m >= 60) { const hr = Math.floor(m / 60), mm = m % 60; return hr + "h" + mm + "m"; }
    return m + "m" + s + "s";
}
