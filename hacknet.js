/** hacknet.js -- ROI-optimal Hacknet manager + RAM-aware bootstrap (built for BN9).
 *  Each loop: sell accumulated hashes to cash, then buy the upgrade (new server, or
 *  level/RAM/core on an existing one) with the best hash-production gain PER DOLLAR.
 *
 *  ROI (default on) uses the Formulas API for the gain math. Formulas carries ~10GB of
 *  static RAM, so it's reached via eval() to hide it from the RAM calculator, keeping the
 *  script lean (~7-8GB incl. the singularity home-buy). "noroi" falls back to cheapest-first.
 *
 *  RAM-AWARE BOOTSTRAP (for a fresh, RAM-starved node): reserves the next home-RAM upgrade
 *  cost out of its own budget (so cash accumulates instead of being spent on hacknet), buys
 *  home RAM via real singularity calls until HOME_TARGET, and auto-launches the stack as RAM
 *  frees up -- hud1 immediately, but trader/sing held until home is maxed (they spend cash and
 *  would deadlock the home saving). In steady state (home >= target) all of this goes dormant.
 *
 *  args:  [hashSpend] -- hash upgrade to buy (default "Sell for Money")
 *  flags: noroi (cheapest-first) | nohome (don't buy home RAM) | nolaunch (don't auto-start stack)
 *         hoard (sell hashes to cash but buy NOTHING -- pile up liquid money, e.g. for a donation round)
 *
 *  Tunables at top: CASH_RESERVE, CASH_FRACTION, CACHE_AT, HOME_TARGET, STACK, LOOP_MS.
 *  Verify RAM with `mem hacknet.js`. Must be in pull.js to deploy.
 *
 *  @param {NS} ns */
export async function main(ns) {
    const CASH_RESERVE  = 1_000_000;   // floor under which we don't spend
    const CASH_FRACTION = 0.5;         // spend up to this fraction of (cash - reserve) per loop
    const FLAGS = ["noroi", "nohome", "nolaunch", "hoard", "roi"];
    const HASH_SPEND = ns.args.find((a) => typeof a === "string" && !FLAGS.includes(a)) || "Sell for Money";  // first non-flag arg
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
    const HOARD       = ns.args.includes("hoard");      // sell hashes to cash but buy NOTHING -- just pile up money
    const HOME_TARGET = 256;   // GB: stop buying home RAM here (fits the full stack + headroom)
    const STACK = ["hud1.js"];  // ONLY hud1 auto-launches (no cash cost). sing.js and trader.js are
    // deliberately NOT here: hacknet relaunching them fought casino/trader/donation phases repeatedly.
    // Launch sing + trader yourself via boot.js -- hacknet's job is hacknet, not booting the stack.

    while (true) {
        const MAX_NODES = ns.hacknet.maxNumNodes();   // real cap (23 nodes / 20 servers / fork limit)
        // BN9: convert accumulated hashes to cash first so production isn't wasted (no-op with plain nodes).
        const mBeforeSell = ns.getPlayer().money;
        try {
            let hc = ns.hacknet.hashCost(HASH_SPEND);
            while (ns.hacknet.numHashes() >= hc) { if (!ns.hacknet.spendHashes(HASH_SPEND)) break; hc = ns.hacknet.hashCost(HASH_SPEND); }
        } catch (e) {}
        const loopSale = Math.max(0, ns.getPlayer().money - mBeforeSell);   // cash this loop's hash sale produced

        const lines = [];
        const log = (s) => lines.push(s);
        const cash = ns.getPlayer().money;
        // reserve the next home-RAM upgrade cost so the hacknet greedy doesn't starve it (RAM-aware)
        let homeReserve = 0;
        if (AUTO_HOME && !HOARD) { try { if (ns.getServerMaxRam("home") < HOME_TARGET) homeReserve = ns.singularity.getUpgradeHomeRamCost(); } catch (e) {} }
        let remaining = HOARD ? 0 : Math.max(0, (cash - CASH_RESERVE - homeReserve) * CASH_FRACTION);

        // current production rate, for display
        let prod = 0;
        const n0 = ns.hacknet.numNodes();
        for (let i = 0; i < n0; i++) {
            try { prod += ns.hacknet.getNodeStats(i).production || 0; } catch (e) {}
        }
        let hashes = 0, hcap = 0;
        try { hashes = ns.hacknet.numHashes(); hcap = ns.hacknet.hashCapacity(); } catch (e) {}
        const hnRate = loopSale / (LOOP_MS / 1000);   // realized $/s from hash sales this loop
        log("=== hacknet  nodes " + n0 + "/" + MAX_NODES + "  prod " + fmt(prod) + " h/s  $" + fmt(hnRate) + "/s  " + (HOARD ? "HOARDING (no spend)" : "budget $" + fmt(remaining)) + " ===");
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

        // --- RAM-aware: launch stack scripts as home RAM allows (income, eyes, endgame) ---
        // hud1 costs no cash so it comes up as soon as it fits; trader and sing SPEND player cash
        // and would starve the home-RAM saving into a deadlock, so we hold them until home is maxed.
        if (AUTO_LAUNCH && !HOARD) {
            try {
                const homeAtTarget = ns.getServerMaxRam("home") >= HOME_TARGET;
                const running = new Set(ns.ps("home").map((p) => p.filename));
                for (const scr of STACK) {
                    if (running.has(scr)) continue;
                    if (scr !== "hud1.js" && !homeAtTarget) continue;   // hold cash-spenders until home done
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
