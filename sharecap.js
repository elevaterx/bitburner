/** sharecap — run a CAPPED slice of share workers ALONGSIDE the farm, to boost faction-rep
 *  gain without killing the money/batch farm.
 *
 *  Unlike shareall.js (a mode-switch that kills the coordinator + harvest and floods ALL RAM),
 *  this:
 *    - kills nothing (coordinator, batchers, harvest, hud all keep running),
 *    - holds a FIXED thread budget (the cap), never grabbing more than that,
 *    - skips home entirely, so the coordinator's controllers/HOME_RESERVE are untouched,
 *    - tops up only to the cap (re-deploys onto freed/new RAM until it's back at cap, then idles).
 *
 *  Share only helps WHILE you are doing faction work in the UI -- hacking contracts give the full
 *  multiplier. With no faction work active this consumes RAM for nothing.
 *
 *  The rep-boost curve is brutally flat: ~64k share threads ~= +20%, ~150k ~= +21.5%, and you need
 *  ~350k to reach ~23%. So a cap around 100k-150k captures nearly the whole benefit; going higher
 *  just burns RAM the farm could use. Default 120000.
 *
 *  usage: run sharecap.js [maxThreads]      e.g.  run sharecap.js 120000
 *  stop:  kill it (Active Scripts), and its share workers stop topping up; kill sh.js to clear them.
 *  @param {NS} ns */
export async function main(ns) {
    const CAP = Number(ns.args[0]) || 120000;
    const WORKER = "sh.js";
    ns.disableLog("ALL");

    // singleton: newest instance wins
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

    const workerRam = ns.getScriptRam(WORKER, "home");

    while (true) {
        const all = scan();

        // count share threads already running across the network
        let cur = 0;
        for (const h of all) {
            if (!ns.hasRootAccess(h)) continue;
            for (const p of ns.ps(h)) if (p.filename === WORKER) cur += p.threads;
        }

        // top up toward the cap on free RAM only -- never displace the farm, never touch home
        let deficit = CAP - cur;
        if (deficit > 0) {
            let added = 0;
            for (const h of all) {
                if (deficit <= 0) break;
                if (h === "home") continue;                       // controllers live on home
                if (!ns.hasRootAccess(h) || ns.getServerMaxRam(h) <= 0) continue;
                const free = Math.floor((ns.getServerMaxRam(h) - ns.getServerUsedRam(h)) / workerRam);
                const want = Math.min(free, deficit);
                if (want > 0) {
                    ns.scp(WORKER, h, "home");
                    const pid = ns.exec(WORKER, h, want);
                    if (pid) { deficit -= want; added += want; }
                }
            }
            if (added > 0) ns.tprint(`sharecap: +${added} share threads (now ~${cur + added}/${CAP})`);
        }
        await ns.sleep(15000);
    }
}
