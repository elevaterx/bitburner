/** @param {NS} ns
 * goto.js -- locate a server anywhere in the network and walk to it (Singularity).
 *
 *   run goto.js [target] [backdoor]
 *     target    server to navigate to. default "The-Cave". case-insensitive.
 *     backdoor  pass "backdoor" as 2nd arg to also install a backdoor on arrival
 *               (only if you have root + sufficient hacking level).
 *
 * Discovers the route LIVE via BFS over ns.scan (does NOT hardcode the network topology),
 * prints the path, then connects hop-by-hop using the same ns.singularity.connect pattern
 * sing.js already uses. On arrival it reports root/level/backdoor status and lists neighbors
 * -- so for The-Cave it will show whether w0r1d_d43m0n is adjacent (it appears once The Red
 * Pill is installed). Reusable for the exit itself: `run goto.js w0r1d_d43m0n`.
 *
 * Deployed by update.js (repo tree is auto-discovered -- no manifest to edit). */
export async function main(ns) {
    const targetArg = ns.args[0] !== undefined ? String(ns.args[0]) : "The-Cave";
    const doBackdoor = String(ns.args[1] || "").toLowerCase() === "backdoor";

    // --- BFS from home, recording parent pointers, to find the target (case-insensitive) ---
    const start = "home";
    const seen = new Set([start]);
    const parent = new Map([[start, null]]);
    const queue = [start];
    let found = null;
    while (queue.length) {
        const cur = queue.shift();
        if (cur.toLowerCase() === targetArg.toLowerCase()) { found = cur; break; }
        for (const n of ns.scan(cur)) {
            if (!seen.has(n)) { seen.add(n); parent.set(n, cur); queue.push(n); }
        }
    }
    if (!found) {
        ns.tprint("ERROR: '" + targetArg + "' not found in the reachable network.");
        ns.tprint("  (If you meant w0r1d_d43m0n, it only appears in the network once The Red Pill is installed.)");
        return;
    }

    // --- reconstruct the path home -> ... -> target (home included, as sing.js does) ---
    const path = [];
    for (let s = found; s !== null; s = parent.get(s)) path.unshift(s);
    ns.tprint("=== goto " + found + " ===");
    ns.tprint("path (" + (path.length - 1) + " hops): " + path.join(" -> "));

    // --- walk it. Mirrors sing.js: connect every hop starting from home. ---
    try {
        for (const hop of path) {
            if (!ns.singularity.connect(hop)) {
                ns.tprint("FAILED to connect: " + hop + " -- aborting walk.");
                ns.tprint("Manual fallback, paste in terminal:");
                ns.tprint("  connect " + path.slice(1).join("; connect "));
                return;
            }
        }
    } catch (e) {
        ns.tprint("ERROR during Singularity walk: " + e);
        ns.tprint("Manual fallback, paste in terminal:");
        ns.tprint("  connect " + path.slice(1).join("; connect "));
        return;
    }

    // --- arrived: report status + neighbors (reveals whether w0r1d_d43m0n is adjacent) ---
    const root = ns.hasRootAccess(found);
    const reqLvl = ns.getServerRequiredHackingLevel(found);
    const myLvl = ns.getHackingLevel();
    const srv = ns.getServer(found);
    ns.tprint("ARRIVED at " + found + ".");
    ns.tprint("  root: " + root + " | backdoor: " + (srv.backdoorInstalled ? "yes" : "no") +
              " | req hacking: " + reqLvl + " | your level: " + myLvl);
    ns.tprint("  neighbors: " + ns.scan(found).join(", "));

    if (doBackdoor) {
        if (srv.backdoorInstalled) ns.tprint("  backdoor already installed.");
        else if (!root) ns.tprint("  cannot backdoor: no root access (nuke it first).");
        else if (myLvl < reqLvl) ns.tprint("  cannot backdoor: hacking level " + myLvl + " < required " + reqLvl + ".");
        else {
            ns.tprint("  installing backdoor (blocks until done)...");
            await ns.singularity.installBackdoor();
            ns.tprint("  backdoor installed.");
        }
    }
    ns.tprint("(you are now connected to " + found + " -- terminal 'hack' or further 'connect' from here.)");
}
