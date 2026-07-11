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
        let remaining = Math.max(0, (cash - CASH_RESERVE) * CASH_FRACTION);

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

        // greedy loop: each iteration finds the single cheapest upgrade and buys it
        let upgrades = 0;
        let spent = 0;
        const safetyCap = 200;   // hard upper bound on per-loop buys; prevents pathological spin
        while (upgrades < safetyCap) {
            const numNodes = ns.hacknet.numNodes();
            let best = null;

            // option: buy a new node
            if (numNodes < MAX_NODES) {
                try {
                    const c = ns.hacknet.getPurchaseNodeCost();
                    if (Number.isFinite(c) && (!best || c < best.cost)) best = { kind: "buy", cost: c };
                } catch (e) {}
            }
            // options: upgrade level/RAM/core on each existing node
            for (let i = 0; i < numNodes; i++) {
                try {
                    const lc = ns.hacknet.getLevelUpgradeCost(i, 1);
                    if (Number.isFinite(lc) && (!best || lc < best.cost)) best = { kind: "level", i, cost: lc };
                } catch (e) {}
                try {
                    const rc = ns.hacknet.getRamUpgradeCost(i, 1);
                    if (Number.isFinite(rc) && (!best || rc < best.cost)) best = { kind: "ram", i, cost: rc };
                } catch (e) {}
                try {
                    const cc = ns.hacknet.getCoreUpgradeCost(i, 1);
                    if (Number.isFinite(cc) && (!best || cc < best.cost)) best = { kind: "core", i, cost: cc };
                } catch (e) {}
            }

            if (!best) break;                  // nothing left to upgrade
            if (best.cost > remaining) break;  // can't afford the cheapest

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
