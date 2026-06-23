/** backdoors.js — list backdoor targets and print paste-ready terminal command chains.
 *  Without Singularity (SF4), this script CAN'T execute backdoor itself -- the terminal command
 *  works in BN1, but the `ns.singularity.installBackdoor()` API does not. So this script gives
 *  you the exact connect chain to paste for each server. It marks which ones are reachable now
 *  (level + ports + root), and skips the ones still gated -- useful for the early-BN grind
 *  where you want to pick up faction invites as soon as hacking level allows.
 *
 *  Categories:
 *    - HACKER FACTIONS: backdoor grants faction invite (CSEC, avmnite-02h, I.I.I.I, run4theh111z)
 *    - SPECIAL: fulcrumassets (req for Fulcrum invite), The-Cave (adj to daemon), w0r1d_d43m0n
 *    - MEGACORPS: backdoor reduces aug rep cost at that megacorp's faction
 *
 *  Status legend on each line:
 *    OK    -- reachable now (rooted, level OK); paste command is shown
 *    LVL   -- rooted but hacking level too low
 *    PORTS -- not enough port openers to nuke yet
 *    ROOT? -- ports OK but not rooted (run nuke or rerun coordinator)
 *    --    -- not present on this BN's network
 *
 *  usage: run backdoors.js
 *  @param {NS} ns */
export async function main(ns) {
    // [host, category, label]
    const TARGETS = [
        ["CSEC",           "faction",  "CyberSec"],
        ["avmnite-02h",    "faction",  "NiteSec"],
        ["I.I.I.I",        "faction",  "The Black Hand"],
        ["run4theh111z",   "faction",  "BitRunners"],
        ["fulcrumassets",  "special",  "Fulcrum Secret Tech (also req: company rep)"],
        ["The-Cave",       "special",  "adjacent to w0r1d_d43m0n"],
        ["w0r1d_d43m0n",   "special",  "BN destroyer (req: hack lvl 3000)"],
        ["ecorp",          "megacorp", "ECorp"],
        ["megacorp",       "megacorp", "MegaCorp"],
        ["b-and-a",        "megacorp", "Bachman & Associates"],
        ["blade",          "megacorp", "Blade Industries"],
        ["nwo",            "megacorp", "NWO"],
        ["clarkinc",       "megacorp", "Clarke Incorporated"],
        ["omnitek",        "megacorp", "OmniTek Incorporated"],
        ["4sigma",         "megacorp", "Four Sigma"],
        ["kuai-gong",      "megacorp", "Kuai-Gong International"],
    ];

    // BFS from home for shortest path to each host
    const parent = new Map();
    parent.set("home", null);
    const queue = ["home"];
    while (queue.length) {
        const cur = queue.shift();
        for (const n of ns.scan(cur)) {
            if (!parent.has(n)) {
                parent.set(n, cur);
                queue.push(n);
            }
        }
    }

    const OPENERS = ["BruteSSH.exe", "FTPCrack.exe", "relaySMTP.exe", "HTTPWorm.exe", "SQLInject.exe"];
    const havePorts = OPENERS.filter(f => ns.fileExists(f, "home")).length;
    const myLvl = ns.getHackingLevel();

    const pathTo = (host) => {
        if (!parent.has(host)) return null;
        const path = [];
        let cur = host;
        while (cur) { path.unshift(cur); cur = parent.get(cur); }
        return path;
    };

    // Safe wrappers -- the BFS-presence check should make these safe, but defend against fork quirks
    const safe = (fn, fallback) => { try { return fn(); } catch (e) { return fallback; } };

    const report = (host, label) => {
        const path = pathTo(host);
        if (!path) return { line: "  --    " + pad(host, 18) + " not present on this BN's network", paste: null };
        const required = safe(() => ns.getServerRequiredHackingLevel(host), 99999);
        const portsReq = safe(() => ns.getServerNumPortsRequired(host), 5);
        const rooted   = safe(() => ns.hasRootAccess(host), false);
        const okLvl    = myLvl >= required;
        const okPorts  = havePorts >= portsReq;
        let status;
        if (rooted && okLvl) status = "OK   ";
        else if (!rooted && !okPorts) status = "PORTS";
        else if (!rooted && okPorts)  status = "ROOT?";
        else                          status = "LVL  ";
        const detail = "L" + required + " / " + portsReq + "p";
        const line = "  " + status + " " + pad(host, 18) + " " + pad(detail, 12) + " " + label;
        let paste = null;
        if (status === "OK   ") {
            const chain = path.slice(1).map(h => "connect " + h).join("; ");
            paste = "home; " + chain + "; backdoor";
        }
        return { line, paste };
    };

    ns.tprint("=== backdoors === level " + myLvl + ", port openers " + havePorts + "/5");
    const sections = [
        ["HACKER FACTIONS  (backdoor grants invite)",     "faction"],
        ["SPECIAL",                                        "special"],
        ["MEGACORPS  (backdoor reduces aug rep cost)",    "megacorp"],
    ];
    for (const [title, cat] of sections) {
        ns.tprint("");
        ns.tprint("-- " + title + " --");
        for (const [host, c, label] of TARGETS) {
            if (c !== cat) continue;
            const { line, paste } = report(host, label);
            ns.tprint(line);
            if (paste) ns.tprint("       paste: " + paste);
        }
    }
    ns.tprint("");
    ns.tprint("Note: backdoor is async -- paste one server's chain, wait for backdoor to finish, then the next.");
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); }
