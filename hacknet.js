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
 *
 *  SPEND CONTROL (fail-safe by design). hacknet ALWAYS starts PAUSED -- it resets the control file to
 *  "paused" on launch, so a boot/relaunch can never spend your cash. It sells hashes for money the
 *  whole time; spending on upgrades is opt-in, re-read live every loop from `hacknet-ctl.txt`:
 *      paused        -> buy nothing (default; absent or unrecognised file = paused)
 *      payback       -> buy an upgrade only if it pays for itself (from extra hash income) within
 *                       MAX_PAYBACK seconds. CONVERGES: once nodes are strong it stops on its own,
 *                       so cash accumulates untouched -- it can't drain your treasury.
 *      budget:<$N>   -> spend up to $N total (best ROI first), IGNORING payback -- grow beyond the
 *                       payback line, or clamp below it. Decrements as it spends; exhausts -> paused.
 *  Set it from the panel (Pause | Payback | Budget) or by hand: `nano hacknet-ctl.txt` -> type e.g.
 *  `payback` or `budget:500e9`, save. CASH_RESERVE is a hard floor under everything.
 *
 *  Tunables at top: CASH_RESERVE, MAX_PAYBACK, CACHE_AT, HOME_TARGET, STACK, LOOP_MS.
 *  Verify RAM with `mem hacknet.js`. Deployed by update.js (repo tree is auto-discovered -- no manifest to edit). to deploy.
 *
 *  @param {NS} ns */
import { parseCtl, ctlToStr, paybackOk, spendCeiling, hashDollarValue } from "./lib/hacknet-budget.js";

export async function main(ns) {
    const CASH_RESERVE  = 1_000_000;   // hard floor: never spend below this
    const MAX_PAYBACK   = 3600;        // payback mode: buy an upgrade only if it pays for itself (from
                                       // extra hash income) within this many seconds. Raise to reinvest
                                       // harder; lower to take only the very cheapest wins.
    const CTL_FILE      = "hacknet-ctl.txt";  // spend control: paused | payback | budget:$N. Absent = paused.
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
    // Launch ALWAYS starts paused (fail-safe): reset the control so a boot can NEVER spend. Activate
    // spending afterwards from the panel (Pause | Payback | Budget) or `nano hacknet-ctl.txt`.
    ns.write(CTL_FILE, "paused", "w");
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
        // Fail-safe spend control, re-read EVERY loop. Default (absent/garbage) = PAUSED. Forms:
        // "paused" | "payback" | "budget:<$>" -- set by the panel or `nano hacknet-ctl.txt`.
        const ctl = parseCtl(ns.read(CTL_FILE));
        const paused = ctl.mode === "paused";
        const payMode = ctl.mode === "payback";
        // $-value of one hash (for payback math), from the live "Sell for Money" hash cost.
        let hashVal = 0;
        try { hashVal = hashDollarValue(ns.hacknet.hashCost("Sell for Money")); } catch (e) {}
        let hmult = 1;
        try { hmult = ns.getPlayer().mults.hacknet_node_money || 1; } catch (e) {}   // real player mult for payback (BN mult is already baked into hashGainRate)
        // reserve the next home-RAM upgrade cost only when we're allowed to spend (RAM-aware)
        let homeReserve = 0;
        if (AUTO_HOME && !paused) { try { if (ns.getServerMaxRam("home") < HOME_TARGET) homeReserve = ns.singularity.getUpgradeHomeRamCost(); } catch (e) {} }
        let remaining = spendCeiling(ctl.mode, ctl.budget, cash, CASH_RESERVE + homeReserve);
        const ceil0 = remaining;   // starting ceiling, for budget accounting

        // current production rate, for display
        let prod = 0;
        const n0 = ns.hacknet.numNodes();
        for (let i = 0; i < n0; i++) {
            try { prod += ns.hacknet.getNodeStats(i).production || 0; } catch (e) {}
        }
        let hashes = 0, hcap = 0;
        try { hashes = ns.hacknet.numHashes(); hcap = ns.hacknet.hashCapacity(); } catch (e) {}
        const hnRate = loopSale / (LOOP_MS / 1000);   // realized $/s from hash sales this loop
        const modeStr = paused ? "PAUSED (no spend)"
            : ctl.mode === "budget" ? ("BUDGET $" + fmt(ctl.budget) + " left")
            : ("PAYBACK<=" + MAX_PAYBACK + "s  cap $" + fmt(remaining));
        log("=== hacknet  nodes " + n0 + "/" + MAX_NODES + "  prod " + fmt(prod) + " h/s  $" + fmt(hnRate) + "/s  " + modeStr + " ===");
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
        if (AUTO_LAUNCH) {
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
        const useF = !!F;   // Formulas usable; do NOT gate on hashCapacity (0 at bootstrap -> deadlock)
        let upgrades = 0;
        let spent = 0;
        const safetyCap = 200;   // hard upper bound on per-loop buys; prevents pathological spin
        while (upgrades < safetyCap) {
            const numNodes = ns.hacknet.numNodes();
            let best = null, bestScore = -1;
            const consider = (cand) => {
                if (!Number.isFinite(cand.cost) || cand.cost > remaining) return;
                // payback mode: only buy if it pays for itself within MAX_PAYBACK (needs the Formulas
                // gain). budget mode ignores payback -- you asked for that upgrade explicitly.
                if (payMode && (!useF || !paybackOk(cand.cost, cand.gain * hmult, hashVal, MAX_PAYBACK))) return;
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
        } else if (!paused) {
            log("  no upgrade cleared the bar this loop");
        }
        // budget accounting: decrement the pool by what we actually spent (incl. cache); exhaust -> paused.
        if (ctl.mode === "budget") {
            const left = Math.max(0, ctl.budget - (ceil0 - remaining));
            ns.write(CTL_FILE, left > 0 ? ctlToStr({ mode: "budget", budget: left }) : "paused", "w");
        }

        // durable status line for the panel + hud1 snapshot (ns.write = 0GB; inline, no import).
        try {
            const _modeShort = paused ? "PAUSED"
                : ctl.mode === "budget" ? ("BUDGET $" + fmt(ctl.budget))
                : ("PAYBACK<=" + MAX_PAYBACK + "s");
            const _sline = n0 + "/" + MAX_NODES + "n  " + fmt(prod) + " h/s  $" + fmt(hnRate) + "/s  "
                + _modeShort + (upgrades > 0 ? "  +" + upgrades + " ($" + fmt(spent) + ")" : "");
            ns.write("status/hacknet.txt", JSON.stringify({ line: _sline, t: Date.now() }), "w");
        } catch (e) {}

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
