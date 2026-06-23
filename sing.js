/** sing.js — Singularity-driven auto-pilot for the early-BN grind.
 *  Does the four things you'd otherwise click manually:
 *    1. accept whitelisted faction invites
 *    2. buy TOR + port opener programs from darkweb (never below CASH_RESERVE)
 *    3. nuke newly-reachable servers and backdoor faction servers
 *    4. faction work driver -- works the highest-priority faction you've joined
 *
 *  Does NOT touch augmentations -- the 1.9x per-queued-aug price scaling makes
 *  auto-purchase risky, so install timing stays manual.
 *
 *  Each phase has an ENABLE_* toggle at the top -- flip off any you don't want.
 *
 *  Whitelist excludes city factions (they have enemies and joining one bans
 *  you from rivals). Accept those manually if you want them.
 *
 *  FOCUS=true gives 2x rep rate but you can't do anything else manually while
 *  the script is working. Set FOCUS=false if you want to gym/crime in parallel.
 *
 *  RAM: this script statically references ~10 Singularity functions; at SF4
 *  base costs in BN4 expect ~20-30 GB. Run `mem sing.js` to verify before deploy.
 *  Must be added to pull.js's file list to deploy via pull on other hosts.
 *
 *  @param {NS} ns */
export async function main(ns) {
    // === CONFIG ===
    const ENABLE_INVITES   = true;
    const ENABLE_PROGRAMS  = true;
    const ENABLE_BACKDOORS = true;
    const ENABLE_WORK      = true;
    const ENABLE_CRIME     = true;        // commit crime when cash < CASH_FLOOR

    const CASH_RESERVE = 1_000_000;   // never let cash drop below this from purchases
    const CASH_FLOOR   = 5_000_000;   // crime when cash below this; faction work above
    const FOCUS        = true;        // true = 2x rep rate, blocks manual UI activity
    const LOOP_MS      = 5000;        // seconds between loop iterations

    // candidate crimes for the EV picker. v3 requires exact-match strings.
    // The picker evaluates chance × money / time and selects the best at current stats,
    // so this list can stay broad -- low-stat crimes get filtered out automatically.
    const CRIMES = [
        "Shoplift", "Rob Store", "Mug", "Larceny",
        "Deal Drugs", "Bond Forgery", "Traffick Illegal Arms",
        "Homicide", "Grand Theft Auto", "Kidnap and Ransom",
        "Assassination", "Heist",
    ];

    // factions safe to auto-join: no enemies, no city factions, no gang factions
    const JOIN_WHITELIST = new Set([
        // hacker progression -- the standard BN exit path
        "CyberSec", "NiteSec", "The Black Hand", "BitRunners",
        // hacknet / early
        "Tian Di Hui", "Netburners",
        // endgame
        "Daedalus", "Illuminati", "The Covenant",
        // megacorps -- if you've been invited, you've earned company rep, safe to join
        "ECorp", "MegaCorp", "Bachman & Associates", "Blade Industries",
        "NWO", "Clarke Incorporated", "OmniTek Incorporated",
        "Four Sigma", "KuaiGong International", "Fulcrum Secret Technologies",
    ]);

    // ordered priority: works highest-priority faction we're a member of. Daedalus first
    // because Red Pill is the BN exit gate; the rest stack rep for future aug purchases.
    const WORK_PRIORITY = [
        "Daedalus",
        "Illuminati",
        "The Covenant",
        "BitRunners",
        "The Black Hand",
        "NiteSec",
        "CyberSec",
        "Tian Di Hui",
        "Netburners",
    ];

    // servers whose backdoor grants a faction invite or unlocks the daemon path
    const BACKDOOR_TARGETS = ["CSEC", "avmnite-02h", "I.I.I.I", "run4theh111z", "The-Cave", "fulcrumassets"];

    // port openers, cheapest first -- buy in this order so we don't blow cash on
    // SQLInject and skip the cheaper ones
    const PROGRAMS = [
        { name: "BruteSSH.exe",  cost: 500_000 },
        { name: "FTPCrack.exe",  cost: 1_500_000 },
        { name: "relaySMTP.exe", cost: 5_000_000 },
        { name: "HTTPWorm.exe",  cost: 30_000_000 },
        { name: "SQLInject.exe", cost: 250_000_000 },
    ];

    ns.disableLog("ALL");
    ns.ui.openTail();
    ns.ui.resizeTail(680, 380);

    while (true) {
        const lines = [];
        const log = (s) => lines.push(s);
        const cash = ns.getPlayer().money;
        const lvl  = ns.getHackingLevel();
        log("=== sing  L" + lvl + "  $" + fmt(cash) + " ===");

        // --- PHASE 1: invite accept ---
        if (ENABLE_INVITES) {
            try {
                const invites = ns.singularity.checkFactionInvitations();
                for (const inv of invites) {
                    if (JOIN_WHITELIST.has(inv)) {
                        const ok = ns.singularity.joinFaction(inv);
                        if (ok) log("  joined " + inv);
                    } else {
                        log("  skip invite: " + inv + " (not in whitelist)");
                    }
                }
            } catch (e) { log("  [invite phase error] " + e); }
        }

        // --- PHASE 2: TOR + port opener acquisition ---
        if (ENABLE_PROGRAMS) {
            try {
                // purchaseTor returns true if newly bought OR already owned. Either way
                // we proceed to program purchases; if it failed (insufficient funds),
                // the program purchases below will also fail gracefully.
                const torOk = ns.singularity.purchaseTor();
                if (!torOk) log("  TOR not yet purchased (need $200k)");
                for (const prog of PROGRAMS) {
                    if (ns.fileExists(prog.name, "home")) continue;
                    if (cash - prog.cost < CASH_RESERVE) {
                        log("  " + prog.name + ": $" + fmt(prog.cost) + " needed, waiting on cash");
                        break;   // cheaper ones already owned (filtered above); pricier won't help
                    }
                    const bought = ns.singularity.purchaseProgram(prog.name);
                    if (bought) log("  bought " + prog.name + " for $" + fmt(prog.cost));
                }
            } catch (e) { log("  [program phase error] " + e); }
        }

        // --- PHASE 3: root + backdoor sweep ---
        const all = scan(ns);
        const havePorts = PROGRAMS.filter(p => ns.fileExists(p.name, "home")).length;
        let newlyRooted = 0;
        for (const host of all) {
            if (ns.hasRootAccess(host)) continue;
            if (ns.getServerNumPortsRequired(host) > havePorts) continue;
            // open ports + nuke -- ns.nuke and ns.* port functions silently no-op if
            // missing the .exe or insufficient ports, per the v3 API behavior change.
            if (ns.fileExists("BruteSSH.exe","home"))  ns.brutessh(host);
            if (ns.fileExists("FTPCrack.exe","home"))  ns.ftpcrack(host);
            if (ns.fileExists("relaySMTP.exe","home")) ns.relaysmtp(host);
            if (ns.fileExists("HTTPWorm.exe","home"))  ns.httpworm(host);
            if (ns.fileExists("SQLInject.exe","home")) ns.sqlinject(host);
            ns.nuke(host);
            if (ns.hasRootAccess(host)) newlyRooted++;
        }
        if (newlyRooted > 0) log("  rooted " + newlyRooted + " new server(s)");

        if (ENABLE_BACKDOORS) {
            try {
                const parent = bfsParents(ns);
                for (const tgt of BACKDOOR_TARGETS) {
                    if (!parent.has(tgt)) continue;             // not on network this BN
                    if (!ns.hasRootAccess(tgt)) continue;       // not rooted yet
                    const req = ns.getServerRequiredHackingLevel(tgt);
                    if (lvl < req) continue;                    // level too low (silent; reported below)
                    // skip if already backdoored
                    const srv = ns.getServer(tgt);
                    if (srv.backdoorInstalled) continue;
                    // walk the connect path
                    const path = [];
                    let cur = tgt;
                    while (cur) { path.unshift(cur); cur = parent.get(cur); }
                    log("  backdoor " + tgt + " (this blocks the loop)...");
                    for (const hop of path) ns.singularity.connect(hop);
                    await ns.singularity.installBackdoor();
                    ns.singularity.connect("home");
                    log("  backdoored " + tgt);
                }
            } catch (e) { log("  [backdoor phase error] " + e); }
        }

        // --- PHASE 4: earner driver -- crime when cash low, faction work otherwise ---
        // The choice is per-loop: if cash is below CASH_FLOOR and ENABLE_CRIME, commit
        // the best-EV crime. Otherwise work the highest-priority faction we're a member of.
        // Crime in progress isn't restarted each loop (alreadyAt check). When cash crosses
        // back above CASH_FLOOR, next loop's workForFaction cancels any running crime and
        // starts work, costing the partial crime earnings -- acceptable for the simpler logic.
        const doCrime = ENABLE_CRIME && cash < CASH_FLOOR;
        if (doCrime) {
            try {
                // pick the crime with the highest EV/sec at current stats
                let best = null;
                for (const c of CRIMES) {
                    try {
                        const stats  = ns.singularity.getCrimeStats(c);
                        const chance = ns.singularity.getCrimeChance(c);
                        const seconds = (stats.time || 1) / 1000;
                        const evPerSec = (chance * (stats.money || 0)) / seconds;
                        if (!best || evPerSec > best.evPerSec) {
                            best = { name: c, evPerSec, chance, money: stats.money || 0, time: stats.time || 0 };
                        }
                    } catch (e) {}   // crime name not recognized in this fork -- skip silently
                }
                if (!best) {
                    log("  crime: no crime selectable");
                } else {
                    // only restart if we're not already committing this crime
                    let alreadyAt = false;
                    try {
                        const cur = ns.singularity.getCurrentWork();
                        // crime shape varies by version -- check both common forms
                        const isCrime = cur && (cur.type === "CRIME" || cur.type === "Crime" || cur.type === "CrimeWork");
                        const matches = isCrime && (cur.crimeType === best.name || cur.crime === best.name);
                        if (matches) alreadyAt = true;
                    } catch (e) {}
                    if (!alreadyAt) {
                        ns.singularity.commitCrime(best.name, FOCUS);
                        log("  crime start: " + best.name + "  "
                            + (best.chance * 100).toFixed(0) + "% \u00d7 $" + fmt(best.money)
                            + " = $" + fmt(best.evPerSec) + "/s ev");
                    } else {
                        log("  crime: " + best.name + " (running, ev $" + fmt(best.evPerSec) + "/s)");
                    }
                }
            } catch (e) { log("  [crime phase error] " + e); }
        } else if (ENABLE_WORK) {
            try {
                const me = ns.getPlayer().factions;
                const target = WORK_PRIORITY.find(f => me.includes(f));
                if (!target) {
                    log("  work: no priority faction joined yet");
                } else {
                    // only restart work if not already on this target -- repeated
                    // workForFaction calls cancel + restart, losing time.
                    let alreadyAt = false;
                    try {
                        const cur = ns.singularity.getCurrentWork();
                        // type field varies by version; check multiple shapes defensively
                        if (cur && (cur.type === "FACTION" || cur.type === "Faction") && cur.factionName === target) {
                            alreadyAt = true;
                        }
                    } catch (e) {}
                    if (!alreadyAt) {
                        const started = ns.singularity.workForFaction(target, "hacking", FOCUS);
                        if (started) log("  start work: " + target + " (hacking, focus=" + FOCUS + ")");
                        else log("  could not start work: " + target + " (may need to qualify for hacking work type)");
                    } else {
                        let rep = 0;
                        try { rep = ns.singularity.getFactionRep(target); } catch (e) {}
                        log("  working: " + target + "  rep " + fmt(rep));
                    }
                }
            } catch (e) { log("  [work phase error] " + e); }
        }

        ns.clearLog();
        for (const l of lines) ns.print(l);
        await ns.sleep(LOOP_MS);
    }
}

function scan(ns) {
    const seen = new Set(["home"]), q = ["home"], out = ["home"];
    while (q.length) {
        const cur = q.shift();
        for (const n of ns.scan(cur)) {
            if (!seen.has(n)) { seen.add(n); q.push(n); out.push(n); }
        }
    }
    return out;
}

function bfsParents(ns) {
    const parent = new Map();
    parent.set("home", null);
    const q = ["home"];
    while (q.length) {
        const cur = q.shift();
        for (const n of ns.scan(cur)) {
            if (!parent.has(n)) { parent.set(n, cur); q.push(n); }
        }
    }
    return parent;
}

function fmt(n) {
    const a = Math.abs(n);
    if (a >= 1e12) return (n/1e12).toFixed(2) + "t";
    if (a >= 1e9)  return (n/1e9).toFixed(2)  + "b";
    if (a >= 1e6)  return (n/1e6).toFixed(2)  + "m";
    if (a >= 1e3)  return (n/1e3).toFixed(1)  + "k";
    return n.toFixed(0);
}
