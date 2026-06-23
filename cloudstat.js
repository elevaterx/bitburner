/** cloudstat.js -- RAM utilization for home vs cloud. Answers "is cloud full?"
 *  Prints home used/free, cloud aggregate used/free, and the worst-packed cloud servers.
 *  @param {NS} ns */
export async function main(ns) {
    const seen = new Set(["home"]), q = ["home"], all = [];
    while (q.length) {
        const c = q.shift();
        for (const n of ns.scan(c)) if (!seen.has(n)) { seen.add(n); q.push(n); all.push(n); }
    }

    // home
    const hMax = ns.getServerMaxRam("home");
    const hUsed = ns.getServerUsedRam("home");
    ns.tprint("=== RAM utilization ===");
    ns.tprint("HOME   " + fmt(hUsed) + " / " + fmt(hMax) + "  (" + pct(hUsed, hMax) + " used, " + fmt(hMax - hUsed) + " free)");

    // cloud = purchased servers, via the fork's cloud API (getPurchasedServers was removed in v3.0.0).
    // getServerNames returns every purchased server regardless of naming scheme (cloud-## or cloud##).
    // Iterate the purchased list DIRECTLY (not a filter of the BFS scan) so a server is never missed.
    const cloudNames = ns.cloud.getServerNames();
    const purchased = new Set(cloudNames);
    let cMax = 0, cUsed = 0;
    const rows = [];
    for (const h of cloudNames) {
        const m = ns.getServerMaxRam(h), u = ns.getServerUsedRam(h);
        cMax += m; cUsed += u;
        rows.push({ h, m, u, free: m - u });
    }
    ns.tprint("CLOUD  " + fmt(cUsed) + " / " + fmt(cMax) + "  (" + pct(cUsed, cMax) + " used, " + fmt(cMax - cUsed) + " free) across " + cloudNames.length + " servers");

    // also report any OTHER rooted servers hosting workers (non-home, non-purchased -- the network servers)
    let nMax = 0, nUsed = 0;
    for (const h of all) {
        if (purchased.has(h)) continue;
        if (!ns.hasRootAccess(h)) continue;
        const m = ns.getServerMaxRam(h); if (m <= 0) continue;
        nMax += m; nUsed += ns.getServerUsedRam(h);
    }
    ns.tprint("NETWORK " + fmt(nUsed) + " / " + fmt(nMax) + "  (" + pct(nUsed, nMax) + " used, " + fmt(nMax - nUsed) + " free) -- rooted non-cloud servers");

    // free RAM remaining cloud-wide is the key number: if ~0, cloud is FULL and home prep is overflow
    ns.tprint("");
    ns.tprint(">> CLOUD FREE: " + fmt(cMax - cUsed) + "  <<  (near 0 = full = home prep is overflow; large = home prep is adoption leftover)");

    // show the 8 cloud servers with the most free RAM (where new workers would land)
    rows.sort((a, b) => b.free - a.free);
    ns.tprint("");
    ns.tprint("cloud servers with most free RAM:");
    for (const r of rows.slice(0, 8)) {
        ns.tprint("  " + r.h.padEnd(12) + fmt(r.free).padStart(9) + " free  (" + fmt(r.u) + " / " + fmt(r.m) + ")");
    }
}
function fmt(gb) {
    if (gb >= 1e6) return (gb / 1e6).toFixed(2) + "PB";
    if (gb >= 1e3) return (gb / 1e3).toFixed(2) + "TB";
    return gb.toFixed(1) + "GB";
}
function pct(u, m) { return m > 0 ? (100 * u / m).toFixed(0) + "%" : "n/a"; }
