/** purchaser.js -- buys/upgrades cloud servers with a fraction of spare cash.
 *
 *  usage:  run purchaser.js [spendFrac] [cashReserve] [force]
 *          spendFrac    fraction of (cash - reserve) spent per loop (default 0.5)
 *          cashReserve  never spend below this (default 500k)
 *          force        override the node-income guard (buy even in stocks-only nodes)
 *
 *  NODE-AWARE: refuses to run in nodes where scripted hacking earns ~nothing (BN8
 *  Ghost of Wall Street, or any node with ScriptHackMoneyGain ~ 0), because cloud
 *  servers produce no income there and buying them just drains capital the node's
 *  real earner (stocks/corp/etc.) needs. This is what stops the BN8 seed-capital
 *  drain. Pass 'force' to override.
 *
 *  @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    const spendFrac = Number(ns.args[0]) || 0.5;       // max fraction of (cash - reserve) spent per loop
    const CASH_RESERVE = Number(ns.args[1]) || 500_000; // never let cash drop below this
    const FORCE = ns.args[2] === "force";               // override the node-income guard below

    // Node-aware guard -- see header. In a stocks-only / dead-hack node, cloud RAM
    // earns nothing, so refuse to run unless explicitly forced.
    if (!FORCE && hackIncomeDead(ns)) {
        ns.tprint("purchaser: SKIPPING -- this node's cloud servers earn no income "
            + "(hacking money ~0). Hold capital for the node's real earner. "
            + "Pass 'force' as arg[3] to override.");
        return;
    }

    const RAM_CAP = ns.cloud.getRamLimit();
    const LIMIT = ns.cloud.getServerLimit();

    while (true) {
        const cash = ns.getPlayer().money;
        const budget = Math.max(0, (cash - CASH_RESERVE) * spendFrac);
        const names = ns.cloud.getServerNames();
        let acted = false;

        if (names.length < LIMIT) {
            // empty slots: buy the biggest power-of-2 we can afford
            let buyRam = 0;
            for (let r = 2; r <= RAM_CAP; r *= 2) {
                if (ns.cloud.getServerCost(r) <= budget) buyRam = r; else break;
            }
            if (buyRam >= 2) {
                const name = freeName(ns, names);
                if (ns.cloud.purchaseServer(name, buyRam) !== "") {
                    ns.print("bought " + name + " @ " + buyRam + "GB");
                    acted = true;
                }
            }
        } else {
            // full: upgrade the smallest server, in place, to the biggest tier affordable
            let smallest = null, smallestRam = Infinity;
            for (const n of names) {
                const ram = ns.getServerMaxRam(n);
                if (ram < smallestRam) { smallestRam = ram; smallest = n; }
            }
            if (smallest && smallestRam < RAM_CAP) {
                let toRam = 0;
                for (let r = smallestRam * 2; r <= RAM_CAP; r *= 2) {
                    if (ns.cloud.getServerUpgradeCost(smallest, r) <= budget) toRam = r; else break;
                }
                if (toRam > smallestRam) {
                    ns.cloud.upgradeServer(smallest, toRam);
                    ns.print("upgraded " + smallest + " " + smallestRam + " -> " + toRam + "GB");
                    acted = true;
                }
            }
        }

        const cur = ns.cloud.getServerNames();
        if (cur.length >= LIMIT && cur.every(n => ns.getServerMaxRam(n) >= RAM_CAP)) {
            ns.tprint("all " + LIMIT + " cloud servers at max (" + RAM_CAP + "GB). done.");
            return;
        }

        await ns.sleep(acted ? 200 : 5000);
    }
}

function freeName(ns, names) {
    let i = 0;
    while (names.includes("cloud-" + i)) i++;
    return "cloud-" + i;
}

// True in nodes where scripted hacking earns ~nothing, so cloud RAM produces no
// income and buying it just burns capital (e.g. BN8 Ghost of Wall Street). Explicit
// BN8 check first (cheap); ScriptHackMoneyGain heuristic catches other dead-hack
// nodes. getBitNodeMultipliers needs SF5 -- the try/catch defaults to "not dead"
// if it's unavailable, so purchaser still runs normally where we can't tell.
function hackIncomeDead(ns) {
    try {
        if (ns.getResetInfo().currentNode === 8) return true;   // stocks-only node
        const m = ns.getBitNodeMultipliers();
        if (m && typeof m.ScriptHackMoneyGain === "number" && m.ScriptHackMoneyGain < 0.01) return true;
    } catch (e) {}
    return false;
}
