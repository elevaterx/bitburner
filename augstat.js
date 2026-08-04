/** augstat.js -- augmentation planner. Reads joined factions, current rep, owned augs,
 *  and lists the augs each faction offers that you DON'T own, with rep requirement, cost,
 *  whether you have the rep, and the stat multipliers. Flags hacking-relevant augs.
 *  Uses Singularity (SF4). Read-only -- buys nothing.
 *
 *  usage:  run augstat.js [--top N]     N>0 caps rows per faction (and SAYS how many it hid).
 *  Also writes augstat-data.txt, which hud1.js folds into the bb-status snapshot with an age
 *  stamp -- so the aug picture travels with the snapshot instead of living in terminal scrollback.
 *
 *  Sorting: within each faction, augs you can afford-by-rep first, then by rep requirement.
 *  The MULT column shows hacking-relevant multipliers (hack skill / exp / speed / money / chance)
 *  so you can prioritize the XP-and-level movers. NeuroFluxGovernor is flagged separately since
 *  it's repeatable and the standard level multiplier.
 *
 *  @param {NS} ns */
export async function main(ns) {
    const S = ns.singularity;
    const flags = ns.flags([["top", 0]]);          // 0 = show every aug (default); --top N to cap
    const TOP = Math.max(0, Number(flags.top) || 0);
    const out = [];                                 // mirrored to augstat-data.txt for hud1's snapshot
    const say = (line) => { ns.tprint(line); out.push(line); };
    const me = ns.getPlayer();
    const owned = new Set(S.getOwnedAugmentations(true));   // true = include purchased-but-not-installed
    const factions = me.factions;

    say("=== augstat ===  joined: " + factions.join(", "));
    say("cash: $" + fmt(me.money) + "   owned/queued augs: " + owned.size);

    // hacking-relevant multiplier keys to surface
    const HACK_KEYS = [
        "hacking", "hacking_exp", "hacking_speed", "hacking_money", "hacking_chance", "hacking_grow",
    ];

    for (const fac of factions) {
        let rep = 0;
        try { rep = S.getFactionRep(fac); } catch (e) {}
        let augs = [];
        try { augs = S.getAugmentationsFromFaction(fac); } catch (e) {}
        const rows = [];
        for (const a of augs) {
            if (owned.has(a)) continue;
            let repReq = 0, cost = 0, stats = {};
            try { repReq = S.getAugmentationRepReq(a); } catch (e) {}
            try { cost   = S.getAugmentationPrice(a); } catch (e) {}
            try { stats  = S.getAugmentationStats(a); } catch (e) {}
            // build a short multiplier string for hacking-relevant stats
            const mults = [];
            for (const k of HACK_KEYS) {
                if (stats[k] && stats[k] !== 1) mults.push(k.replace("hacking", "h") + " " + stats[k].toFixed(2));
            }
            const isHack = mults.length > 0;
            const haveRep = rep >= repReq;
            rows.push({ a, repReq, cost, mults: mults.join(" "), isHack, haveRep });
        }
        // sort: hacking augs you can afford-by-rep first, then by rep requirement asc
        rows.sort((x, y) => {
            if (x.haveRep !== y.haveRep) return x.haveRep ? -1 : 1;
            if (x.isHack !== y.isHack) return x.isHack ? -1 : 1;
            return x.repReq - y.repReq;
        });

        say("");
        say("--- " + fac + "   rep " + fmt(rep) + "   (" + rows.length + " unowned) ---");
        if (rows.length === 0) { say("  (all augs owned)"); continue; }
        // NO SILENT CAP. This used to be rows.slice(0, 12), which truncated NiteSec's ~85-aug
        // catalogue to 12 with nothing in the output saying so -- and the augs it hid were the
        // faction-rep ones that matter most in a gang BitNode. If a cap is wanted it is now
        // explicit (--top N) and the elision is printed.
        const shown = TOP > 0 ? rows.slice(0, TOP) : rows;
        for (const r of shown) {
            const repMark = r.haveRep ? " " : "*";   // * = not enough rep yet
            say(
                "  " + repMark + r.a.padEnd(34) +
                " rep " + fmt(r.repReq).padStart(9) +
                "  $" + fmt(r.cost).padStart(9) +
                (r.mults ? "   " + r.mults : "")
            );
        }
        if (shown.length < rows.length) say("  ... " + (rows.length - shown.length) + " more hidden by --top " + TOP);
        say("  (* = insufficient rep)");
    }

    // NeuroFlux note -- repeatable level multiplier, available from most factions
    say("");
    say("note: NeuroFluxGovernor is repeatable (stacks), boosts ALL stats incl hacking level/exp.");
    say("      Standard endgame XP/level multiplier -- buy in bulk once a faction has the rep.");
    say("note: each aug you QUEUE multiplies the next one's money price by 1.9x. Buy most-expensive");
    say("      first (augbuy.js does), and never pad a round with cheap augs you don't need.");

    // Feed hud1's snapshot. augstat is a one-shot, so the reader must show the age -- hud1 does.
    ns.write("augstat-data.txt", JSON.stringify({ ts: Date.now(), lines: out }), "w");
}

function fmt(n) {
    const a = Math.abs(n);
    if (a >= 1e12) return (n/1e12).toFixed(2) + "t";
    if (a >= 1e9)  return (n/1e9).toFixed(2)  + "b";
    if (a >= 1e6)  return (n/1e6).toFixed(2)  + "m";
    if (a >= 1e3)  return (n/1e3).toFixed(1)  + "k";
    return n.toFixed(0);
}
