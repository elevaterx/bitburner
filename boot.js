/** boot.js -- cold-start bootstrap. Brings up the full stack from nothing (post-install) or
 *  restarts it cleanly, in the ONE ordering that matters: sharecap claims its capped share BEFORE
 *  coordinator starts, because coord greedily fills all free RAM and won't yield it back once placed.
 *  Boot order: sing -> purchaser -> sharecap(cap) -> coordinator -> (ensure hud1). hud2 stays manual.
 *
 *  usage:  run boot.js                      (defaults below)
 *          run boot.js                      income mode: no share, no purchaser, coord 'income'
 *          run boot.js 1000 0 repgrind      rep grind: share cap 1000, coord 'repgrind' preset
 *          run boot.js 0 0.5 rebuild        post-install: no share, purchaser on, coord 'rebuild'
 *          run boot.js <shareCap> <noshare> e.g. run boot.js 0 1   -> skip share entirely
 *
 *  Args:
 *    [0] shareCap   -- sharecap thread cap. DEFAULT 0 = no share (income mode). e.g. 1000 for a rep grind.
 *    [1] purchaserFrac -- cloud purchaser spend fraction. default 0 = off.
 *    [2] coordPreset   -- coord scenario preset. default 'income'.
 *
 *  Must be added to pull.js.
 *
 *  NODE-AWARE: in nodes where scripted hacking earns ~nothing (BN8 Ghost of Wall
 *  Street), the coordinator/farm produce $0 while consuming the whole pool, so boot
 *  brings up only sing (quiet) + hud1 and SKIPS purchaser + coordinator. Income there
 *  is the stock market -- run the trader. Pass arg[3]='farm' to force the farm anyway
 *  (e.g. as an XP tap toward the daemon gate).
 *
 *  @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");

    // ---- config ----
    // Args (positional):
    //   [0] shareCap       sharecap thread cap. DEFAULT 0 = NO share (income mode -- the normal state).
    //                      Set a number to enable faction-rep share, e.g. `run boot.js 1000` for a rep
    //                      grind. 1000 is the standard cap (share saturates fast; more just eats pool).
    //                      WARNING: share is a SEPARATE script and ignores coord's home reserve, so an
    //                      uncapped/huge value (e.g. the old 120000) lets it swallow ~all of home+pool.
    //   [1] purchaserFrac  cloud purchaser spend fraction. default 0 = purchaser OFF.
    //                      >0 enables purchaser at that frac (e.g. 0.5). Cloud doesn't persist
    //                      install AND spends cash, so it's OFF by default -- opt in deliberately.
    //   [2] coordPreset    coordinator scenario preset. default 'income' (post-install earning mode).
    //                      Any coord preset works: income | rebuild | repgrind | digheavy | safe.
    //   Examples:
    //     run boot.js                      -> income mode: no share, no purchaser, coord 'income'
    //     run boot.js 1000 0 repgrind      -> rep grind: share cap 1000, coord 'repgrind'
    //     run boot.js 0 0.5 rebuild        -> post-install rebuild: no share, purchaser on, coord 'rebuild'
    const SHARE_CAP      = ns.args[0] !== undefined ? Number(ns.args[0]) : 0;        // 0 = NO share (default)
    const SHARE_HOME_RES = 4096;          // GB of home RAM sharecap must leave free (so it can't eat home)
    const PURCHASER_FRAC = ns.args[1] !== undefined ? Number(ns.args[1]) : 0;        // 0 = purchaser off
    const COORD_PRESET   = ns.args[2] !== undefined ? String(ns.args[2]) : "income"; // coord scenario preset
    const PURCHASER_RES  = 500_000;   // purchaser cash floor (only used if purchaser enabled)
    const SETTLE_MS      = 600;       // pause between ordered launches so each claims RAM before the next
    const FORCE_FARM     = ns.args[3] === "farm";   // override: run the farm even in a stocks-only node

    // Node-aware: in a stocks-only / dead-hack node (BN8), the farm earns $0 and just
    // eats the pool, so we skip purchaser + coordinator and boot only sing + hud1.
    const hackDead = hackIncomeDead(ns);
    const farmMode = !hackDead || FORCE_FARM;   // true = normal farm boot; false = BN8 quiet boot

    const log = (m) => ns.tprint("[boot] " + m);
    log("cold-start bootstrap beginning...");
    if (!farmMode) log("NODE is stocks-only (scripted hacking earns $0) -- quiet boot: sing + hud1 only, "
        + "farm + purchaser SKIPPED. Income is the stock market. (arg[3]='farm' forces the farm.)");

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
    if (PURCHASER_FRAC > 0 && farmMode) {
        pid = ns.run("purchaser.js", 1, PURCHASER_FRAC, PURCHASER_RES);
        log(pid ? ("purchaser.js up (" + PURCHASER_FRAC + " frac, $" + (PURCHASER_RES / 1e3) + "k reserve)") : "purchaser.js FAILED");
        await ns.sleep(SETTLE_MS);
    } else if (!farmMode) {
        log("purchaser SKIPPED (stocks-only node -- cloud servers earn $0; hold capital for stocks)");
    } else {
        log("purchaser SKIPPED (off by default; pass arg[1]>0 to enable cloud buying)");
    }

    // ---- 3. sharecap WITH CAP -- MUST precede coord (boot-order constraint) ----
    if (SHARE_CAP <= 0) {
        log("share SKIPPED (shareCap 0)");
    } else {
        pid = ns.run("sharecap.js", 1, SHARE_CAP, SHARE_HOME_RES);
        log(pid ? ("sharecap.js up (cap " + SHARE_CAP + "t, home reserve " + SHARE_HOME_RES + "GB) -- claims its slice before coord") : "sharecap.js FAILED");
        await ns.sleep(SETTLE_MS);   // let sharecap deploy its workers before coord scans the pool
    }

    // ---- 4. coordinator: farm brain. Takes whatever pool remains after sharecap.
    //         SKIPPED in a stocks-only node -- the farm earns $0 there and would just
    //         eat the pool. Income in those nodes is the stock market (run the trader). ----
    if (farmMode) {
        pid = ns.run("coordinator.js", 1, COORD_PRESET);
        log(pid ? ("coordinator.js up (preset '" + COORD_PRESET + "') -- takes remaining pool") : "coordinator.js FAILED");
        await ns.sleep(SETTLE_MS);
    } else {
        log("coordinator SKIPPED (stocks-only node: farm earns $0). Income is the stock market -- run the trader. "
            + "arg[3]='farm' forces the farm (e.g. as an XP tap).");
    }

    // ---- 5. ensure hud1 is running (launch only if absent; never kill it -- may be our caller) ----
    let hud1Running = false;
    for (const p of ns.ps("home")) if (p.filename === "hud1.js") { hud1Running = true; break; }
    if (hud1Running) {
        log("hud1.js already running -- left as-is");
    } else {
        pid = ns.run("hud1.js");
        log(pid ? "hud1.js up" : "hud1.js FAILED");
    }

    log("bootstrap complete. " + (farmMode ? "" : "[STOCKS-ONLY node: farm off] ") +
        (SHARE_CAP <= 0 ? "(no share) " : "share cap " + SHARE_CAP + "t ") +
        (PURCHASER_FRAC > 0 && farmMode ? "+ purchaser " + PURCHASER_FRAC + " " : "+ no purchaser ") +
        (farmMode ? "-- watch coord log for harvest growth. " : "-- run the trader for income. ") +
        "Launch hud2 manually for faction/aug state.");
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

// True in nodes where scripted hacking earns ~nothing (BN8 Ghost of Wall Street, or
// any node with ScriptHackMoneyGain ~ 0), so the farm produces no income. Explicit
// BN8 check first (cheap); the multiplier heuristic catches other dead-hack nodes.
// getBitNodeMultipliers needs SF5 -- try/catch defaults to "not dead" if unavailable.
function hackIncomeDead(ns) {
    try {
        if (ns.getResetInfo().currentNode === 8) return true;   // stocks-only node
        const m = ns.getBitNodeMultipliers();
        if (m && typeof m.ScriptHackMoneyGain === "number" && m.ScriptHackMoneyGain < 0.01) return true;
    } catch (e) {}
    return false;
}
