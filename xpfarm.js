/** xpfarm — flood the whole network with xp workers on the best XP server to
 *  push hacking level (BN1 needs level 3000 to hack w0r1d_d43m0n). Pure XP:
 *  no money, no batching, no timing to tune.
 *  usage: run xpfarm.js [targetOverride] [secBand]
 *    targetOverride : force a server (e.g. joesguns, foodnstuff); default auto-pick
 *    secBand        : weaken only if security exceeds min by more than this (default 2)
 *  @param {NS} ns */
export async function main(ns) {
    const override = ns.args[0] || null;
    const band = Number(ns.args[1]) || 2;
    const HOME_RESERVE = 24;        // GB kept free on home for hud/pull/etc
    const WORKER = "xp.js";
    ns.disableLog("ALL");

    // singleton: kill any older xpfarm instance, newest wins
    for (const p of ns.ps("home")) {
        if (p.filename === ns.getScriptName() && p.pid !== ns.pid) ns.kill(p.pid);
    }

    const scan = () => {
        const out = [], seen = new Set(["home"]), q = ["home"];
        while (q.length) {
            const cur = q.shift(); out.push(cur);
            for (const n of ns.scan(cur)) if (!seen.has(n)) { seen.add(n); q.push(n); }
        }
        return out;
    };
    const root = (hosts) => {
        const openers = ["BruteSSH.exe","FTPCrack.exe","relaySMTP.exe","HTTPWorm.exe","SQLInject.exe"];
        const have = openers.filter(f => ns.fileExists(f, "home")).length;
        for (const h of hosts) {
            if (ns.hasRootAccess(h)) continue;
            if (ns.fileExists("BruteSSH.exe","home")) ns.brutessh(h);
            if (ns.fileExists("FTPCrack.exe","home")) ns.ftpcrack(h);
            if (ns.fileExists("relaySMTP.exe","home")) ns.relaysmtp(h);
            if (ns.fileExists("HTTPWorm.exe","home")) ns.httpworm(h);
            if (ns.fileExists("SQLInject.exe","home")) ns.sqlinject(h);
            if (ns.getServerNumPortsRequired(h) <= have) ns.nuke(h);
        }
    };

    // --- initial scan/root, then pick the XP target ---
    let all = scan();
    root(all);
    const L0 = ns.getHackingLevel();
    const ranked = all
        .filter(h => ns.hasRootAccess(h) && ns.getServerMaxMoney(h) > 0
                  && ns.getServerRequiredHackingLevel(h) <= L0)
        // proxy for XP/sec per thread: exp per action (~3 + 0.3*minSec) over grow time
        .map(h => ({ h, score: (3 + 0.3 * ns.getServerMinSecurityLevel(h)) / Math.max(1, ns.getGrowTime(h)) }))
        .sort((a, b) => b.score - a.score);
    const target = override || (ranked.length ? ranked[0].h : "n00dles");
    ns.tprint("xpfarm target: " + target + (override ? " (override)" : " (auto)")
        + "   top candidates: " + ranked.slice(0, 5).map(r => r.h).join(", "));

    // --- switch to XP mode: stop the money farm so its RAM is free (leaves hud/pull/etc alone) ---
    const moneyScripts = ["coordinator.js", "prep.js", "h.js"];
    for (const h of all) {
        if (!ns.hasRootAccess(h)) continue;
        for (const p of ns.ps(h)) if (moneyScripts.includes(p.filename)) ns.kill(p.pid);
    }

    const workerRam = ns.getScriptRam(WORKER, "home");

    // --- fill all RAM with xp workers, and keep topping up (new pservers, freed RAM) ---
    while (true) {
        all = scan();
        root(all);
        let threads = 0, hosts = 0;
        for (const h of all) {
            if (!ns.hasRootAccess(h) || ns.getServerMaxRam(h) <= 0) continue;
            let max = ns.getServerMaxRam(h);
            if (h === "home") max -= HOME_RESERVE;
            const free = Math.floor((max - ns.getServerUsedRam(h)) / workerRam);
            if (free > 0) {
                ns.scp(WORKER, h, "home");
                const pid = ns.exec(WORKER, h, free, target, band);
                if (pid) { threads += free; hosts++; }
            }
        }
        if (threads > 0) ns.tprint("xpfarm: +" + threads + " xp threads on " + target
            + " across " + hosts + " servers @L" + ns.getHackingLevel());
        await ns.sleep(15000);
    }
}
