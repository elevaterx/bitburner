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
 *  Deployed by update.js (repo tree is auto-discovered -- no manifest to edit).
 *
 *  NODE-AWARE: in nodes where scripted hacking earns ~nothing (BN8 Ghost of Wall
 *  Street), the coordinator/farm produce $0 while consuming the whole pool, so boot
 *  brings up only sing (quiet) + hud1 and SKIPS purchaser + coordinator. Income there
 *  is the stock market -- run the trader. Pass arg[3]='farm' to force the farm anyway
 *  (e.g. as an XP tap toward the daemon gate).
 *
 *  @param {NS} ns */
import { hackMoneyLive } from "./lib/node-policy.js";
import { coordPreset } from "./lib/node-open.js";
export async function main(ns) {
    ns.disableLog("ALL");

    // COLD-NODE OPENER, first thing. A fresh BitNode hands you $1,262 while travel to Aevum costs
    // $200,000 (CONSTANTS.TravelCost), so the casino -- worth ~$10b and the whole early game -- is
    // unreachable until something earns the fare. open.js does crime -> Aevum -> casino.js.
    //
    // Fire-and-forget by design: open.js self-checks getResetInfo() (lastAugReset <= lastNodeReset)
    // and exits immediately if this is not a cold node, so the policy lives in ONE place and boot
    // does not duplicate it. Deliberately not awaited -- the rest of the stack should come up while
    // the crime phase runs.
    try { ns.exec("open.js", "home"); } catch (e) {}

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
    // GB of home RAM sharecap must leave free. Clamped to half of home: the literal 4096 exceeds
    // the entire 32GB home you get after a BitNode reset, which would reserve more than exists.
    const SHARE_HOME_RES = Math.min(4096, Math.floor(ns.getServerMaxRam("home") / 2));
    const PURCHASER_FRAC = ns.args[1] !== undefined ? Number(ns.args[1]) : 0;        // 0 = purchaser off
    // coord scenario preset. Explicit arg wins; otherwise READ IT OFF STATE rather than defaulting
    // blind to "income". After an install, exp is 0 and every purchased server is gone while home RAM
    // survives, so the pool has slack that only xpw can use -- and `rebuild` is `income` with xpw on.
    // See coordPreset() in lib/node-open.js for the window and its (sticky) limitation.
    let coordAuto = false;
    let COORD_PRESET = "income";
    if (ns.args[2] !== undefined) {
        COORD_PRESET = String(ns.args[2]);
    } else {
        try { COORD_PRESET = coordPreset(ns.getResetInfo()); coordAuto = true; } catch (e) {}
    }
    const PURCHASER_RES  = 500_000;   // purchaser cash floor (only used if purchaser enabled)
    const SETTLE_MS      = 600;       // pause between ordered launches so each claims RAM before the next
    const FORCE_FARM     = ns.args[3] === "farm";   // override: run the farm even in a stocks-only node

    // Node-aware: in a dead-hack node (BN8 stocks-only, BN9 hacknet), the farm earns ~$0 and
    // just eats the pool, so we skip purchaser + coordinator and boot only sing + hud1 (plus the
    // node's income engine where we have one, e.g. hacknet.js in BN9).
    let nodeNum = 0; try { nodeNum = ns.getResetInfo().currentNode; } catch (e) {}
    const hackDead = hackIncomeDead(ns);
    const farmMode = !hackDead || FORCE_FARM;   // true = normal farm boot; false = quiet boot

    const log = (m) => ns.tprint("[boot] " + m);
    log("cold-start bootstrap beginning...");
    if (!farmMode) log("NODE hacking-for-money is dead -- quiet boot: sing + hud1"
        + (nodeNum === 9 ? " + hacknet" : "") + " only, farm + purchaser SKIPPED. (arg[3]='farm' forces the farm.)");

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
        log("purchaser SKIPPED (dead-hack node -- cloud earns ~$0, and may be unavailable e.g. BN9)");
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

    // ---- 3b. capability managers, BEFORE coordinator. Same boot-order constraint sharecap has:
    //          coord greedily fills all free RAM and won't yield it back once placed, so anything
    //          launched after it gets nothing. On a post-BitNode 32GB home (Prestige.ts:242-248)
    //          that is the difference between the gang manager running and never starting at all --
    //          and in BN2 the gang IS the economy, not a late-game extra. Each self-gates, so
    //          launching unconditionally costs nothing where its API is absent.
    //          panel.js goes first: it is the cheapest control surface (~6GB) and hud1 (39GB)
    //          cannot run at all until home is upgraded. ----
    await launchManagers(ns, log);

    // ---- 4. coordinator: farm brain. Takes whatever pool remains after sharecap.
    //         SKIPPED in a stocks-only node -- the farm earns $0 there and would just
    //         eat the pool. Income in those nodes is the stock market (run the trader). ----
    if (farmMode) {
        pid = ns.run("coordinator.js", 1, COORD_PRESET);
        log(pid ? ("coordinator.js up (preset '" + COORD_PRESET + "'"
            + (coordAuto ? (COORD_PRESET === "rebuild"
                ? ", auto: installed recently -- xpw ON to soak the idle pool into levels"
                : ", auto") : ", explicit")
            + ") -- takes remaining pool") : "coordinator.js FAILED");
        await ns.sleep(SETTLE_MS);
    } else {
        log("coordinator SKIPPED (hacking-for-money is dead here). arg[3]='farm' forces it (e.g. as an XP tap).");
        if (nodeNum === 9) {
            // hacknet starts PAUSED by its own design (resets hacknet-ctl.txt to "paused" on launch),
            // so a boot can never drain cash. Enable spending from the panel (Payback | Budget) when ready.
            pid = ns.run("hacknet.js");
            log(pid ? "hacknet.js up -- BN9 hash economy (starts PAUSED; enable spend from the panel)" : "hacknet.js FAILED");
            await ns.sleep(SETTLE_MS);
        } else {
            log("  income engine is manual here -- run the trader (stocks work via SF8).");
        }
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

/** Launch the self-gating capability managers, cheapest control surface first.
 *  Reports the actual RAM shortfall rather than "check RAM" -- on a fresh BitNode home the
 *  interesting question is always "by how much", since that decides whether to buy RAM or to
 *  shed a script. */
async function launchManagers(ns, log) {
    const free = (h) => ns.getServerMaxRam(h) - ns.getServerUsedRam(h);
    // Rooted hosts with real RAM, biggest free first. The gang / sleeve / bladeburner / corp and
    // Singularity APIs are NOT home-only -- they work from any server -- so a manager that doesn't
    // fit on a post-BitNode 32GB home can still run on the network. Skip hacknet servers: running
    // scripts on one cuts its hash rate.
    const pool = () => bfs(ns)
        .filter((h) => h !== "home" && !h.startsWith("hacknet-") && ns.hasRootAccess(h) && ns.getServerMaxRam(h) > 0)
        .sort((a, b) => free(b) - free(a));

    for (const f of ["panel.js", "gang.js", "sleeves.js", "bladeburner.js", "corp.js"]) {
        // already running ANYWHERE, not just on home
        let up = false;
        for (const h of bfs(ns)) { if (ns.ps(h).some((p) => p.filename === f)) { up = true; break; } }
        if (up) { log(f + " already running -- left as-is"); continue; }

        let need = 0; try { need = ns.getScriptRam(f, "home"); } catch (e) {}
        if (!need) { log(f + " NOT started -- script not found (run update.js?)"); continue; }

        // home first (cheapest to reason about), then the roomiest rooted host
        let pid = free("home") >= need ? ns.run(f) : 0;
        let where = "home";
        if (!pid) {
            for (const h of pool()) {
                if (free(h) < need) break;              // sorted, so nothing later fits either
                if (!ns.scp(f, h, "home")) continue;
                pid = ns.exec(f, h);
                if (pid) { where = h; break; }
            }
        }
        if (pid) {
            log(f + " up on " + where + " (" + need.toFixed(1) + "GB, self-gates if unavailable)");
        } else {
            const best = pool()[0];
            log(f + " NOT started -- needs " + need.toFixed(1) + "GB; home has "
                + free("home").toFixed(1) + "GB free, best network host "
                + (best ? best + " has " + free(best).toFixed(1) + "GB" : "none rooted yet"));
        }
        await ns.sleep(200);
    }
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
// True where scripted hacking can't meaningfully earn: farm income ~ ScriptHackMoneyGain x
// ServerMaxMoney, which is ~0 in BN8 (gain 0) and BN9 (maxMoney 0.01) -- so both are caught
// without hardcoding node numbers. getBitNodeMultipliers needs SF5; defaults to "alive" if absent.
// Delegates to lib/node-policy.js -- the BN8 fast path is gone because the index catches it anyway
// (ScriptHackMoneyGain 0 -> index 0), and a hardcoded node number is exactly the kind of thing that
// goes stale. getBitNodeMultipliers needs SF5; without it the index defaults to 1 = "assume alive".
function hackIncomeDead(ns) {
    try {
        return !hackMoneyLive(ns.getBitNodeMultipliers());
    } catch (e) {}
    return false;
}
