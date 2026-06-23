/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    const spendFrac = Number(ns.args[0]) || 0.5;       // max fraction of (cash - reserve) spent per loop
    const CASH_RESERVE = Number(ns.args[1]) || 500_000; // never let cash drop below this
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
