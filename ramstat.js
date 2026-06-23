/** ramstat -- one-shot diagnostic. Aggregates thread counts by script across all rooted hosts,
 *  plus total RAM used/free per script type. Use this instead of `ps home` when scrollback truncates.
 *  Prints a small table to terminal then exits.
 *  @param {NS} ns */
export async function main(ns) {
    const seen = new Set(["home"]), q = ["home"], all = [];
    while (q.length) {
        const cur = q.shift();
        all.push(cur);
        for (const n of ns.scan(cur)) if (!seen.has(n)) { seen.add(n); q.push(n); }
    }

    // per-script aggregates: filename -> { threads, ramGB, procs, hosts:Set }
    const byScript = new Map();
    let totalMax = 0, totalUsed = 0;

    for (const h of all) {
        if (!ns.hasRootAccess(h)) continue;
        totalMax += ns.getServerMaxRam(h);
        totalUsed += ns.getServerUsedRam(h);
        for (const p of ns.ps(h)) {
            const ram = (ns.getScriptRam(p.filename, h) || 0) * p.threads;
            if (!byScript.has(p.filename)) byScript.set(p.filename, { threads: 0, ramGB: 0, procs: 0, hosts: new Set() });
            const r = byScript.get(p.filename);
            r.threads += p.threads;
            r.ramGB += ram;
            r.procs += 1;
            r.hosts.add(h);
        }
    }

    // sort by RAM consumed desc
    const rows = [...byScript.entries()].sort((a, b) => b[1].ramGB - a[1].ramGB);

    ns.tprint("=== ramstat ===");
    ns.tprint(`fleet RAM: ${(totalUsed/1e3).toFixed(1)} TB used / ${(totalMax/1e3).toFixed(1)} TB total  (${((totalUsed/totalMax)*100).toFixed(1)}%)`);
    ns.tprint("script                threads      RAM       procs  hosts");
    for (const [name, r] of rows) {
        const ramStr = r.ramGB >= 1e6 ? (r.ramGB/1e6).toFixed(2) + " PB"
                     : r.ramGB >= 1e3 ? (r.ramGB/1e3).toFixed(2) + " TB"
                     : r.ramGB.toFixed(1) + " GB";
        ns.tprint(name.padEnd(20) + " " + String(r.threads).padStart(10) + "  " + ramStr.padStart(8) + "    " + String(r.procs).padStart(4) + "   " + String(r.hosts.size).padStart(4));
    }
}
