/** fatcheck.js -- list rooted servers by max money, with prep state.
 *  Use to pick a correct BATCH_FLOOR under BN4's reduced-money multipliers.
 *  @param {NS} ns */
export async function main(ns) {
    const seen = new Set(["home"]), q = ["home"], all = [];
    while (q.length) {
        const c = q.shift();
        for (const n of ns.scan(c)) if (!seen.has(n)) { seen.add(n); q.push(n); all.push(n); }
    }
    const myLevel = ns.getHackingLevel();
    const openers = ["BruteSSH.exe","FTPCrack.exe","relaySMTP.exe","HTTPWorm.exe","SQLInject.exe"]
        .filter(p => ns.fileExists(p, "home")).length;
    const rows = all
        .filter(h => ns.getServerMaxMoney(h) > 0)
        .map(h => {
            const max = ns.getServerMaxMoney(h);
            const cur = ns.getServerMoneyAvailable(h);
            const sec = ns.getServerSecurityLevel(h);
            const min = ns.getServerMinSecurityLevel(h);
            const req = ns.getServerRequiredHackingLevel(h);
            const ports = ns.getServerNumPortsRequired(h);
            const root = ns.hasRootAccess(h);
            const prepped = (cur >= max * 0.99) && (sec <= min + 0.5);
            const hackable = req <= myLevel;
            const rootable = ports <= openers;
            const digEligible = root && hackable;
            return { h, max, pct: cur / max, secOver: sec - min, prepped, req, ports, root, hackable, rootable, digEligible };
        })
        .sort((a, b) => b.max - a.max);

    ns.tprint("=== top 25 by max money (level " + myLevel + ", " + openers + " port openers owned) ===");
    ns.tprint("server                  maxMoney   req  ports root  hackable  digElig");
    for (const r of rows.slice(0, 25)) {
        ns.tprint(
            r.h.padEnd(22) + " " +
            fmt(r.max).padStart(10) + " " +
            String(r.req).padStart(5) + " " +
            String(r.ports).padStart(5) + "  " +
            (r.root ? "yes" : "NO ").padStart(4) + "  " +
            (r.hackable ? "YES" : "no ").padStart(7) + "  " +
            (r.digEligible ? "YES" : "no")
        );
    }

    // THE OPPORTUNITY: servers you can HACK (req <= level) but haven't ROOTED.
    // Split by whether you have enough port openers to root them now vs. need more.
    const hackableUnrooted = rows.filter(r => r.hackable && !r.root);
    const rootableNow = hackableUnrooted.filter(r => r.rootable).sort((a,b) => b.max - a.max);
    const needPorts    = hackableUnrooted.filter(r => !r.rootable).sort((a,b) => b.max - a.max);

    ns.tprint("");
    ns.tprint("=== HACKABLE BUT UNROOTED -- rootable NOW (have the ports, coord should auto-root) ===");
    if (rootableNow.length === 0) ns.tprint("  (none -- everything hackable is already rooted)");
    for (const r of rootableNow.slice(0, 15)) {
        ns.tprint("  " + r.h.padEnd(22) + fmt(r.max).padStart(10) + "  req " + String(r.req).padStart(4) + "  ports " + r.ports);
    }

    ns.tprint("");
    ns.tprint("=== HACKABLE BUT UNROOTED -- NEED MORE PORT OPENERS (the locked income) ===");
    if (needPorts.length === 0) ns.tprint("  (none -- you have enough openers for everything in hacking range)");
    let lockedMoney = 0;
    for (const r of needPorts) lockedMoney += r.max;
    for (const r of needPorts.slice(0, 15)) {
        ns.tprint("  " + r.h.padEnd(22) + fmt(r.max).padStart(10) + "  req " + String(r.req).padStart(4) + "  needs " + r.ports + " ports");
    }
    ns.tprint("  >> total max-money locked behind more openers: " + fmt(lockedMoney) + " across " + needPorts.length + " servers <<");
}
function fmt(n) {
    const a = Math.abs(n);
    if (a >= 1e12) return (n/1e12).toFixed(2) + "t";
    if (a >= 1e9)  return (n/1e9).toFixed(2)  + "b";
    if (a >= 1e6)  return (n/1e6).toFixed(2)  + "m";
    if (a >= 1e3)  return (n/1e3).toFixed(1)  + "k";
    return n.toFixed(0);
}
