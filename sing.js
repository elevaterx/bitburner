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
 *  NODE-AWARE: on launch sing reads the current BitNode (getResetInfo) and its
 *  multipliers (getBitNodeMultipliers, needs SF5) and picks a launch PROFILE that
 *  turns the four hacking-economy phases on/off. DEFAULT = full autopilot. Nodes
 *  with confirmed quirks get an explicit NODE_PROFILES entry (e.g. BN8 = stocks-only).
 *  Un-profiled nodes where scripts can't earn (ScriptHackMoneyGain ~ 0) auto-fall
 *  back to a quiet profile, so we never repeat the BN8 capital-drain blind.
 *
 *  @param {NS} ns */
import { applyLayout } from "winlayout.js";
export async function main(ns) {
    // === CONFIG ===
    const ENABLE_INVITES   = true;
    const ENABLE_PROGRAMS  = true;
    const ENABLE_BACKDOORS = true;
    const ENABLE_WORK      = true;
    const ENABLE_CRIME     = true;        // commit crime when cash < CASH_FLOOR

    const CASH_RESERVE = 1_000_000;   // never let cash drop below this from purchases
    const CASH_FLOOR   = 500_000;     // crime when cash below this; faction work above.
                                       // LOWERED from $5M: crime is useful only for the cold-start
                                       // bootstrap (post-install, no income). Once coord earns >$500/s,
                                       // faction work outperforms crime because (a) rep grind is the
                                       // bottlenecking resource for the next install batch, and (b)
                                       // hacking work gives XP too. Crime at low combat stats is slow,
                                       // and combat stats don't serve the hacker-faction path.
    const FOCUS        = true;        // true = 2x rep rate, blocks manual UI activity
    const LOOP_MS      = 5000;        // seconds between loop iterations

    // === node-aware launch profiles ===
    // A profile flips the four hacking-economy phases on/off and can request a one-time
    // travel. DEFAULT = full hacking-economy autopilot. Add a NODE_PROFILES entry for any
    // node that needs different launch behavior; unlisted nodes fall back to DEFAULT, or
    // to the ScriptHackMoneyGain guard below. The master ENABLE_* toggles still apply on
    // top -- a phase runs only if BOTH ENABLE_* and the profile allow it, so ENABLE_*
    // stays a global kill switch. Partial NODE_PROFILES entries inherit DEFAULT for any
    // field they omit (they're merged over DEFAULT_PROFILE).
    const DEFAULT_PROFILE = { label: "standard", programs: true, backdoors: true, crime: true, work: true, travelCity: null };
    const NODE_PROFILES = {
        // BN8 Ghost of Wall Street: only the stock market earns; scripted hacking pays
        // $0 (ScriptHackMoneyGain = 0). Suppress every hacking-economy phase so we don't
        // burn stock capital or hold FOCUS (which blocks the casino seed bootstrap), and
        // travel to Aevum for the casino. Re-profile for the rep grind once stocks fund you.
        8: { label: "Ghost of Wall Street (stocks-only)", programs: false, backdoors: true, crime: false, work: false, travelCity: "Aevum" },
        // Add nodes as you reach them; confirm behavior live before trusting a hand-written
        // profile. e.g. BN2 (gangs -- hacking still earns), BN3 (corp, all income -75%).
    };
    // Fallback for un-profiled nodes where scripts can't earn: suppress the money-spend
    // and focus-grab phases (programs/crime/work) so we never blindly drain capital.
    const HACK_DEAD_EPS = 0.01;

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
    // NOTE: NiteSec promoted above Black Hand for the overnight rep grind -- NiteSec offers
    // Neurotrainer II, Artificial Synaptic, Neural-Retention, CRTX42-AA, which Black Hand
    // doesn't. Restore the original order (Black Hand above NiteSec) when ready to pivot.
    const WORK_PRIORITY = [
        "Daedalus",
        "Illuminati",
        "The Covenant",
        "BitRunners",
        "NiteSec",
        "The Black Hand",
        "CyberSec",
        "Tian Di Hui",
        "Netburners",
    ];

    // servers whose backdoor grants a faction invite or unlocks the daemon path
    const BACKDOOR_TARGETS = ["CSEC", "avmnite-02h", "I.I.I.I", "run4theh111z", "The-Cave", "fulcrumassets"];

    // port openers, cheapest first -- buy in this order so we don't blow cash on
    // SQLInject and skip the cheaper ones. Each program can have a `minLevel` gate:
    // if player level is below it, sing skips the buy. Default minLevel=0 means
    // "always buy when affordable". SQLInject gated at L800 because the 5-port
    // servers it unlocks all require hacking 900+ -- buying it earlier is just
    // a $250M tax on disposable RAM (programs reset on install).
    const PROGRAMS = [
        { name: "BruteSSH.exe",  cost: 500_000,     minLevel: 0 },
        { name: "FTPCrack.exe",  cost: 1_500_000,   minLevel: 0 },
        { name: "relaySMTP.exe", cost: 5_000_000,   minLevel: 0 },
        { name: "HTTPWorm.exe",  cost: 30_000_000,  minLevel: 0 },
        { name: "SQLInject.exe", cost: 250_000_000, minLevel: 800 },
    ];

    ns.disableLog("ALL");
    ns.ui.openTail();
    await applyLayout(ns, "sing", ns.pid);   // self-position to the preferred stack layout

    // --- resolve the node launch profile (once; BitNode can't change mid-session) ---
    let node = 1, mults = null;
    try { node = ns.getResetInfo().currentNode; } catch (e) {}
    try { mults = ns.getBitNodeMultipliers(); } catch (e) {}   // needs SF5; null if unavailable
    let profile, profileSource;
    if (NODE_PROFILES[node]) {
        profile = { ...DEFAULT_PROFILE, ...NODE_PROFILES[node] };   // partial entries inherit DEFAULT
        profileSource = "explicit";
    } else if (mults && typeof mults.ScriptHackMoneyGain === "number" && mults.ScriptHackMoneyGain < HACK_DEAD_EPS) {
        profile = { ...DEFAULT_PROFILE, label: "auto: hacking earns $0", programs: false, crime: false, work: false };
        profileSource = "auto (ScriptHackMoneyGain~0)";
    } else {
        profile = { ...DEFAULT_PROFILE };
        profileSource = "default";
    }
    let traveled = (profile.travelCity == null);   // nothing to travel to => already done

    ns.tprint("sing: BN" + node + " profile=" + profileSource + " [" + profile.label + "]  "
        + "phases{prog:" + profile.programs + " bd:" + profile.backdoors
        + " crime:" + profile.crime + " work:" + profile.work + "}"
        + (profile.travelCity ? "  travel:" + profile.travelCity : ""));
    if (mults) {
        const m = (k) => (typeof mults[k] === "number" ? mults[k].toFixed(2) : "?");
        ns.tprint("sing: mults  ScriptHackMoneyGain=" + m("ScriptHackMoneyGain")
            + "  CrimeMoney=" + m("CrimeMoney") + "  HackExpGain=" + m("HackExpGain")
            + "  ServerMaxMoney=" + m("ServerMaxMoney")
            + "  HackLvlMult=" + m("HackingLevelMultiplier")
            + "  DaemonDiff=" + m("WorldDaemonDifficulty"));
    }

    while (true) {
        const lines = [];
        const log = (s) => lines.push(s);
        const cash = ns.getPlayer().money;
        const lvl  = ns.getHackingLevel();
        log("=== sing  L" + lvl + "  $" + fmt(cash) + "  [BN" + node + ": " + profile.label + "] ===");

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

        // --- one-time travel requested by the node profile (e.g. Aevum for BN8 casino) ---
        if (profile.travelCity && !traveled) {
            try {
                const acity = ns.getPlayer().city;
                if (acity === profile.travelCity) {
                    traveled = true;
                } else if (cash > 200_000 + CASH_RESERVE) {
                    if (ns.singularity.travelToCity(profile.travelCity)) { log("  traveled to " + profile.travelCity); traveled = true; }
                } else {
                    log("  travel to " + profile.travelCity + ": waiting on cash ($200k + reserve)");
                }
            } catch (e) { log("  [travel error] " + e); }
        }

        // --- PHASE 2: TOR + port opener acquisition ---
        if (ENABLE_PROGRAMS && profile.programs) {
            try {
                // purchaseTor returns true if newly bought OR already owned. Either way
                // we proceed to program purchases; if it failed (insufficient funds),
                // the program purchases below will also fail gracefully.
                const torOk = ns.singularity.purchaseTor();
                if (!torOk) log("  TOR not yet purchased (need $200k)");
                for (const prog of PROGRAMS) {
                    if (ns.fileExists(prog.name, "home")) continue;
                    if (prog.minLevel && lvl < prog.minLevel) {
                        log("  skip " + prog.name + ": L" + lvl + " < L" + prog.minLevel + " (server reqs too high to use)");
                        continue;   // don't break -- a level-gated program shouldn't block subsequent ones
                    }
                    if (cash - prog.cost < CASH_RESERVE) {
                        log("  " + prog.name + ": $" + fmt(prog.cost) + " needed, waiting on cash");
                        break;   // cash-gated; cheaper ones already owned, pricier won't be cheaper
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

        if (ENABLE_BACKDOORS && profile.backdoors) {
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
        const doCrime = ENABLE_CRIME && cash < CASH_FLOOR && profile.crime;
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
        } else if (ENABLE_WORK && profile.work) {
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
