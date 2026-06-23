/** @param {NS} ns */
export async function main(ns) {
    // ---- edit these three once, to match your repo ----
    const USER = "Avruch0101";
    const REPO = "bitburner";
    const BRANCH = "main";
    // pull.js is fetched LAST: a running script can't reload its own code.
    const files = [
        "coordinator.js", "prep.js", "h.js",
        "farm-status.js", "status.js", "hud.js",
        "puzzles.js", "purchaser.js", "cleanup.js",
        "xp.js", "xpfarm.js", "sh.js", "shareall.js",
        "diagnose-income.js", "earners.js", "backdoors.js",
        "sing.js",
        // --- HWGW batcher ---
        "batch-math.js", "batch-live.js", "sharecap.js",
        "bhack.js", "bgrow.js", "bweaken.js",
        "bprep.js", "bdiag.js", "bbatch.js",
        "pull.js", "killfarm.js", "bbatch2.js", "xpw.js"
    ];
    const base = "https://raw.githubusercontent.com/" + USER + "/" + REPO + "/" + BRANCH + "/";
    const running = new Set();
    for (const p of ns.ps("home")) running.add(p.filename);

    let ok = 0, miss = 0;
    const changed = [], needReload = [];
    for (const f of files) {
        const before = ns.fileExists(f, "home") ? ns.read(f) : null;
        const got = await ns.wget(base + f + "?ts=" + Date.now(), f);
        if (!got) { miss++; ns.tprint("MISS " + f); continue; }
        ok++;
        const after = ns.read(f);
        if (before !== after) {
            changed.push(f);
            if (f === "pull.js" || running.has(f)) needReload.push(f);
        }
    }
    ns.tprint("pull: " + ok + " ok, " + miss + " missing, " + changed.length + " changed"
        + (changed.length ? "  [" + changed.join(", ") + "]" : ""));
    if (needReload.length) ns.tprint("RELOAD the game to apply (running or self-update): " + needReload.join(", "));
    else ns.tprint("no reload needed - changed files compile fresh on next run.");
}
