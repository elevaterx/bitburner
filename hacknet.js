/** hacknet.js -- simple greedy hacknet node manager.
 *  Each loop: scan all possible next upgrades (buy new node, or upgrade level/RAM/cores
 *  on each existing node), pick the cheapest, buy it if budget allows. Repeat until
 *  budget exhausted or no affordable upgrade remains.
 *
 *  No ROI math -- relies on "cheapest first" being a sound greedy in early game where
 *  almost every upgrade pays back quickly. Maxed slots (e.g., level 200) return Infinity
 *  from the cost API and are filtered out via isFinite.
 *
 *  Tunables at top:
 *    CASH_RESERVE   -- never drop player cash below this
 *    CASH_FRACTION  -- spend at most this fraction of (cash - reserve) per loop
 *    MAX_NODES      -- hard cap on node count (vanilla = 23)
 *    LOOP_MS        -- seconds between iterations
 *
 *  Static RAM should be low (hacknet API functions are 0-0.05 GB each + script base 1.6).
 *  Verify with `mem hacknet.js`.
 *  Must be added to pull.js's file list to deploy via pull.
 *
 *  @param {NS} ns */
export async function main(ns) {
    const CASH_RESERVE  = 1_000_000;   // floor under which we don't spend
    const CASH_FRACTION = 0.5;         // spend up to this fraction of (cash - reserve) per loop
    const HASH_SPEND    = ns.args[0] || "Sell for Money";  // hash upgrade bought each loop (servers only)
    const CACHE_AT      = 0.85;        // buy cache when hashes exceed this frac of capacity
    const LOOP_MS       = 5000;

    ns.disableLog("ALL");
    ns.ui.openTail();
    ns.ui.resizeTail(560, 320);
    // ROI (production-per-dollar) uses the Formulas API, which carries ~10GB of STATIC RAM --
    // and a direct ns.formulas reference is charged whether or not it runs. So we reach it via
    // eval(), which hides it from the RAM calculator entirely, keeping this script lean (~2-3GB)
    // for RAM-starved nodes like BN9. ROI is opt-in ("roi" arg); the default cheapest-first path
    // never touches Formulas. (Same static-RAM dodge casino.js uses for document; the default
    // path never runs the eval, so it's safe regardless -- only 'roi' mode depends on it.)
    const USE_ROI = !ns.args.includes("noroi");   // ROI on by default (free via eval-dodge); "noroi" to disable
    let F = null;
    if (USE_ROI) {
        try { F = eval("ns.formulas.hacknetServers"); F.hashGainRate(1, 0, 1, 1, 1); }
        catch (e) { F = null; ns.tprint("hacknet: ROI unavailable (" + e + ") -- cheapest-first."); }
    }
    // RAM-aware bootstrap (for a fresh, RAM-starved node like BN9): buy home RAM from hash income
    // until the whole stack fits, and launch stack scripts as each one fits -- fully hands-off.
    // Home-RAM + launch use eval-dodged singularity / ns.run so they add ~no static RAM.
    const AUTO_HOME   = !ns.args.includes("nohome");    // buy home RAM to fit the stack (default on)
    const AUTO_LAUNCH = !ns.args.includes("nolaunch");  // launch trader/hud1/sing as RAM allows (default on)
    const HOME_TARGET = 256;   // GB: stop buying home RAM here (fits the full stack + headroom)
    const STACK = ["trader.js", "hud1.js", "sing.js"];  // launch order (income, eyes, endgame) as RAM frees up

    while (true) {
        const MAX_NODES = ns.hacknet.maxNumNodes();   // real cap (23 nodes / 20 servers / fork limit)
        // BN9: convert accumulated hashes to cash first so production isn't wasted (no-op with plain nodes).
        try {
            let hc = ns.hacknet.hashCost(HASH_SPEND);
            while (ns.hacknet.numHashes() >= hc) { if (!ns.hacknet.spendHashes(HASH_SPEND)) break; hc = ns.hacknet.hashCost(HASH_SPEND); }
        } catch (e) {}

        const lines = [];
        const log = (s) => lines.push(s);
        const cash = ns.getPlayer().money;
        // reserve the next home-RAM upgrade cost so the hacknet greedy doesn't starve it (RAM-aware)
        let homeReserve = 0;
        if (AUTO_HOME) { try { if (ns.getServerMaxRam("home") < HOME_TARGET) homeReserve = ns.singularity.getUpgradeHomeRamCost(); } catch (e) {} }
        let remaining = Math.max(0, (cash - CASH_RESERVE - homeReserve) * CASH_FRACTION);

        // current production rate, for display
        let prod = 0;
        const n0 = ns.hacknet.numNodes();
        for (let i = 0; i < n0; i++) {
            try { prod += ns.hacknet.getNodeStats(i).production || 0; } catch (e) {}
        }
        let hashes = 0, hcap = 0;
        try { hashes = ns.hacknet.numHashes(); hcap = ns.hacknet.hashCapacity(); } catch (e) {}
        log("=== hacknet  nodes " + n0 + "/" + MAX_NODES + "  prod " + fmt(prod) + "/s  budget $" + fmt(remaining) + " ===");
        if (hcap > 0) log("  hashes " + fmt(hashes) + "/" + fmt(hcap) + "  selling: " + HASH_SPEND);

        // --- RAM-aware: buy the reserved home upgrade once cash covers it (real singularity call) ---
        if (AUTO_HOME && homeReserve > 0) {
            if (ns.getPlayer().money - CASH_RESERVE >= homeReserve) {
                try { if (ns.singularity.upgradeHomeRam()) log("  home RAM -> " + ns.getServerMaxRam("home") + "GB"); }
                catch (e) { log("  [home upgrade err] " + e); }
            } else {
                log("  saving for home upgrade $" + fmt(homeReserve) + " (cash $" + fmt(ns.getPlayer().money) + "; hacknet paused until covered)");
            }
        }

        // --- RAM-aware: launch stack scripts (income, eyes, endgame) as home RAM allows ---
        if (AUTO_LAUNCH) {
            try {
                const running = new Set(ns.ps("home").map((p) => p.filename));
                for (const scr of STACK) {
                    if (running.has(scr)) continue;
                    const need = ns.getScriptRam(scr, "home");
                    const free = ns.getServerMaxRam("home") - ns.getServerUsedRam("home");
                    if (need > 0 && need <= free && ns.run(scr)) log("  launched " + scr);
                }
            } catch (e) {}
        }

        // buy cache where hashes are backing up toward capacity (protects production; servers only)
        for (let i = 0; i < n0 && remaining > 0; i++) {
            try {
                const st = ns.hacknet.getNodeStats(i);
                if (st.hashCapacity && ns.hacknet.numHashes() > st.hashCapacity * CACHE_AT) {
                    const cc = ns.hacknet.getCacheUpgradeCost(i, 1);
                    if (Number.isFinite(cc) && cc <= remaining && ns.hacknet.upgradeCache(i, 1)) remaining -= cc;
                }
            } catch (e) {}
        }

        // greedy loop: each iteration buys the affordable upgrade with the best hash-production
        // gain PER DOLLAR (ROI, via Formulas). Production mult cancels in the ratio so we pass
        // mult=1. Falls back to cheapest-first when Formulas isn't usable (plain nodes / no SF5).
        let useF = false;
        try { useF = !!F && ns.hacknet.hashCapacity() > 0; } catch (e) {}
        let upgrades = 0;
        let spent = 0;
        const safetyCap = 200;   // hard upper bound on per-loop buys; prevents pathological spin
        while (upgrades < safetyCap) {
            const numNodes = ns.hacknet.numNodes();
            let best = null, bestScore = -1;
            const consider = (cand) => {
                if (!Number.isFinite(cand.cost) || cand.cost > remaining) return;
                const score = useF ? cand.gain / cand.cost : 1 / cand.cost;   // ROI, or cheapest-first
                if (score > bestScore) { bestScore = score; best = cand; }
            };

            // option: buy a new server (fresh: level 1 / ram 1 / cores 1)
            if (numNodes < MAX_NODES) {
                try {
                    const c = ns.hacknet.getPurchaseNodeCost();
                    consider({ kind: "buy", cost: c, gain: useF ? F.hashGainRate(1, 0, 1, 1, 1) : 1 });
                } catch (e) {}
            }
            // options: level / RAM / core on each existing server (RAM upgrade doubles maxRam)
            for (let i = 0; i < numNodes; i++) {
                try {
                    const s = ns.hacknet.getNodeStats(i);
                    const ru = s.ramUsed || 0;
                    const cur = useF ? F.hashGainRate(s.level, ru, s.ram, s.cores, 1) : 0;
                    consider({ kind: "level", i, cost: ns.hacknet.getLevelUpgradeCost(i, 1), gain: useF ? F.hashGainRate(s.level + 1, ru, s.ram, s.cores, 1) - cur : 1 });
                    consider({ kind: "ram",   i, cost: ns.hacknet.getRamUpgradeCost(i, 1),   gain: useF ? F.hashGainRate(s.level, ru, s.ram * 2, s.cores, 1) - cur : 1 });
                    consider({ kind: "core",  i, cost: ns.hacknet.getCoreUpgradeCost(i, 1),  gain: useF ? F.hashGainRate(s.level, ru, s.ram, s.cores + 1, 1) - cur : 1 });
                } catch (e) {}
            }

            if (!best) break;   // nothing affordable/available left (consider already filtered cost > remaining)

            // execute the chosen upgrade
            let ok = false;
            try {
                if (best.kind === "buy")        ok = ns.hacknet.purchaseNode() !== -1;
                else if (best.kind === "level") ok = ns.hacknet.upgradeLevel(best.i, 1);
                else if (best.kind === "ram")   ok = ns.hacknet.upgradeRam(best.i, 1);
                else if (best.kind === "core")  ok = ns.hacknet.upgradeCore(best.i, 1);
            } catch (e) { break; }
            if (!ok) break;
            remaining -= best.cost;
            spent += best.cost;
            upgrades++;
        }

        if (upgrades > 0) {
            log("  bought " + upgrades + " upgrade(s)  spent $" + fmt(spent));
        } else {
            log("  no affordable upgrades this loop");
        }

        ns.clearLog();
        for (const l of lines) ns.print(l);
        await ns.sleep(LOOP_MS);
    }
}

function fmt(n) {
    const a = Math.abs(n);
    if (a >= 1e12) return (n / 1e12).toFixed(2) + "t";
    if (a >= 1e9)  return (n / 1e9).toFixed(2)  + "b";
    if (a >= 1e6)  return (n / 1e6).toFixed(2)  + "m";
    if (a >= 1e3)  return (n / 1e3).toFixed(1)  + "k";
    return n.toFixed(0);
}
