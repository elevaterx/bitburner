/** boot.js -- cold-start bootstrap. Brings up the full stack from nothing (post-install) or
 *  restarts it cleanly, in the ONE ordering that matters: sharecap claims its capped share BEFORE
 *  coordinator starts, because coord greedily fills all free RAM and won't yield it back once placed.
 *  Boot order: sing -> purchaser -> sharecap(cap) -> coordinator -> (ensure hud1). hud2 stays manual.
 *
 *  usage:  run boot.js                      (defaults below)
 *          run boot.js <shareCap>           e.g. run boot.js 120000
 *          run boot.js <shareCap> <noshare> e.g. run boot.js 0 1   -> skip share entirely
 *
 *  Args:
 *    [0] shareCap   -- sharecap thread cap (default SHARE_CAP). 0 with arg[1]=1 disables share.
 *    [1] noShare    -- 1 = skip sharecap (pure income/rebuild, no rep boost). default 0.
 *
 *  Must be added to pull.js. @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");

    // ---- config ----
    // Args (positional):
    //   [0] shareCap       sharecap thread cap. default 120000. 0 = NO share.
    //   [1] purchaserFrac  cloud purchaser spend fraction. default 0 = purchaser OFF.
    //                      >0 enables purchaser at that frac (e.g. 0.5). Cloud doesn't persist
    //                      install AND spends cash, so it's OFF by default -- opt in deliberately.
    //   [2] coordPreset    coordinator scenario preset. default 'income' (post-install earning mode).
    //                      Any coord preset works: income | rebuild | repgrind | digheavy | safe.
    //                      e.g. `run boot.js 120000 0 rebuild` -> share on, no purchaser, coord in rebuild mode.
    //                      Note: if you want share for a rep grind, pair it with the 'repgrind' coord preset.
    const SHARE_CAP      = ns.args[0] !== undefined ? Number(ns.args[0]) : 120000;  // 0 disables share
    const PURCHASER_FRAC = ns.args[1] !== undefined ? Number(ns.args[1]) : 0;        // 0 = purchaser off
    const COORD_PRESET   = ns.args[2] !== undefined ? String(ns.args[2]) : "income"; // coord scenario preset
    const PURCHASER_RES  = 500_000;   // purchaser cash floor (only used if purchaser enabled)
    const SETTLE_MS      = 600;       // pause between ordered launches so each claims RAM before the next

    const log = (m) => ns.tprint("[boot] " + m);
    log("cold-start bootstrap beginning...");

    // ---- 0. clean slate: kill managed scripts if already running (idempotent). NEVER kills hud1
    //         (the button runs FROM it) or hud2 (on-demand). Sweeps sh.js workers fleet-wide. ----
    const all = bfs(ns);
    const killHostScript = (file) => { let n = 0; for (const h of all) if (ns.scriptKill(file, h)) n++; return n; };
    ns.scriptKill("coordinator.js", "home");        // kill coord first so it stops claiming RAM
    ns.scriptKill("sharecap.js", "home");
    for (const h of all) for (const p of ns.ps(h)) if (p.filename === "sh.js") ns.kill(p.pid);  // share workers
    ns.scriptKill("purchaser.js", "home");
    ns.scriptKill("sing.js", "home");
    await ns.sleep(300);  // let kills settle so freed RAM is available to the relaunch

    // ---- 1. sing: foundation (invites, TOR, port openers, root+backdoor, faction work) ----
    let pid = ns.run("sing.js");
    log(pid ? "sing.js up" : "sing.js FAILED to launch");
    await ns.sleep(SETTLE_MS);

    // ---- 2. purchaser: cloud rebuild -- OFF by default (spends cash, cloud doesn't persist install).
    //         Enable only with an explicit purchaserFrac arg. ----
    if (PURCHASER_FRAC > 0) {
        pid = ns.run("purchaser.js", 1, PURCHASER_FRAC, PURCHASER_RES);
        log(pid ? ("purchaser.js up (" + PURCHASER_FRAC + " frac, $" + (PURCHASER_RES / 1e3) + "k reserve)") : "purchaser.js FAILED");
        await ns.sleep(SETTLE_MS);
    } else {
        log("purchaser SKIPPED (off by default; pass arg[1]>0 to enable cloud buying)");
    }

    // ---- 3. sharecap WITH CAP -- MUST precede coord (boot-order constraint) ----
    if (SHARE_CAP <= 0) {
        log("share SKIPPED (shareCap 0)");
    } else {
        pid = ns.run("sharecap.js", 1, SHARE_CAP);
        log(pid ? ("sharecap.js up (cap " + SHARE_CAP + "t) -- claims its slice before coord") : "sharecap.js FAILED");
        await ns.sleep(SETTLE_MS);   // let sharecap deploy its workers before coord scans the pool
    }

    // ---- 4. coordinator: farm brain. Takes whatever pool remains after sharecap. ----
    pid = ns.run("coordinator.js", 1, COORD_PRESET);
    log(pid ? ("coordinator.js up (preset '" + COORD_PRESET + "') -- takes remaining pool") : "coordinator.js FAILED");
    await ns.sleep(SETTLE_MS);

    // ---- 5. ensure hud1 is running (launch only if absent; never kill it -- may be our caller) ----
    let hud1Running = false;
    for (const p of ns.ps("home")) if (p.filename === "hud1.js") { hud1Running = true; break; }
    if (hud1Running) {
        log("hud1.js already running -- left as-is");
    } else {
        pid = ns.run("hud1.js");
        log(pid ? "hud1.js up" : "hud1.js FAILED");
    }

    log("bootstrap complete. " + (SHARE_CAP <= 0 ? "(no share) " : "share cap " + SHARE_CAP + "t ") +
        (PURCHASER_FRAC > 0 ? "+ purchaser " + PURCHASER_FRAC + " " : "+ no purchaser ") +
        "-- watch coord log for harvest growth. Launch hud2 manually for faction/aug state.");
}

// BFS the network from home, returning all reachable hosts (incl. home).
function bfs(ns) {
    const seen = new Set(["home"]), q = ["home"], out = ["home"];
    while (q.length) {
        const c = q.shift();
        for (const n of ns.scan(c)) if (!seen.has(n)) { seen.add(n); q.push(n); out.push(n); }
    }
    return out;
}
