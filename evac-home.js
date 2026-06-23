/** evac-home.js -- kill worker scripts running ON HOME so coordinator re-places them.
 *  With coord's cloud-preferred sort, the re-placed deficit goes to cloud first. Only useful
 *  when cloud has free RAM -- if cloud is full, coord will just re-place on home as overflow.
 *
 *  Default kills prep.js only (the usual home hog). Pass "all" to also kill h.js harvest workers.
 *  Does NOT touch bbatch2.js controllers (home-pinned by design) or batch workers on cloud.
 *
 *    run evac-home.js          -> kill prep.js on home
 *    run evac-home.js all      -> kill prep.js AND h.js on home
 *
 *  @param {NS} ns */
export async function main(ns) {
    const mode = (ns.args[0] || "prep").toLowerCase();
    const kill = new Set(["prep.js"]);
    if (mode === "all") kill.add("h.js");

    let killed = 0, threads = 0;
    for (const p of ns.ps("home")) {
        if (kill.has(p.filename)) {
            threads += p.threads;
            ns.kill(p.pid);
            killed++;
        }
    }
    ns.tprint("evac-home: killed " + killed + " process(es), " + threads
        + " threads on home (" + [...kill].join("+") + "). Coord will re-place cloud-first next loop.");
}
