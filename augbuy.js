/** augbuy.js -- one-shot hacking-augmentation buyer for the aug ratchet (built for BN9).
 *  Scans the factions you're in, finds hacking-relevant augs you don't own, and BUYS every
 *  one you can afford (rep + money), cheapest-rep-first. With "donate" it buys the missing
 *  rep via donations (favor >= 150 factions only -- the big money sink). DRY RUN by default.
 *
 *  Buy in SMALL rounds then INSTALL: each aug queued in a round multiplies the next one's
 *  MONEY price by 1.9x, so one huge round blows up cost. This buys until the next is
 *  unaffordable; install between rounds so prices reset and prereqs unlock.
 *
 *  usage: run augbuy.js [buy] [donate] [all] [nfg]
 *    (no flags)  DRY RUN -- report what it WOULD buy / donate and what's blocked
 *    buy         actually purchase
 *    donate      buy missing rep via donation (favor >= 150 only) -- can cost trillions+
 *    all         include non-hacking augs too (for the Daedalus 30-aug count)
 *    nfg         also buy NeuroFlux Governor levels (expensive; buy deliberately)
 *
 *  Real singularity calls (needs SF4) -- RAM is significant (~40-50GB); run on demand, not
 *  continuously (kill xpfarm briefly if home is tight). Excludes "The Red Pill" (node-exit;
 *  install that deliberately as the last step). Does NOT install -- you install when ready.
 *  Must be in pull.js. @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    const DO_BUY = ns.args.includes("buy");
    const DONATE = ns.args.includes("donate");
    const ALL    = ns.args.includes("all");
    const NFG    = ns.args.includes("nfg");
    const S = ns.singularity;
    const NFG_NAME = "NeuroFlux Governor", REDPILL = "The Red Pill";

    const factions = ns.getPlayer().factions;
    if (!factions.length) { ns.tprint("augbuy: you're not in any factions yet -- backdoor faction servers first."); return; }

    const have = new Set(S.getOwnedAugmentations(true));    // purchased + queued + installed -> "already have"
    const installed = new Set(S.getOwnedAugmentations(false)); // installed only -> for prereq checks

    const isHackingAug = (aug) => {
        try {
            const m = S.getAugmentationStats(aug);
            return m.hacking > 1 || m.hacking_exp > 1 || m.faction_rep > 1
                || m.hacking_chance > 1 || m.hacking_speed > 1 || m.hacking_money > 1 || m.hacking_grow > 1;
        } catch (e) { return false; }
    };

    // build unique candidate list; for each aug pick the member-faction where we have the most rep
    const cand = new Map();
    for (const f of factions) {
        let list = [];
        try { list = S.getAugmentationsFromFaction(f); } catch (e) { continue; }
        for (const aug of list) {
            if (have.has(aug) || aug === REDPILL) continue;
            if (aug === NFG_NAME && !NFG) continue;
            if (aug !== NFG_NAME && !ALL && !isHackingAug(aug)) continue;
            const rep = S.getFactionRep(f);
            const prev = cand.get(aug);
            if (!prev || rep > prev._rep) {
                cand.set(aug, { aug, faction: f, _rep: rep, repReq: S.getAugmentationRepReq(aug), prereqs: S.getAugmentationPrereq(aug) });
            }
        }
    }

    // only augs whose prerequisites are already INSTALLED are buyable this round; cheapest-rep first
    const list = [...cand.values()]
        .filter(c => c.prereqs.every(p => installed.has(p)))
        .sort((a, b) => a.repReq - b.repReq);

    const bought = [], blockedRep = [], blockedMoney = [];
    let money = ns.getPlayer().money, spent = 0, donated = 0;
    const repMult = (ns.getPlayer().mults && ns.getPlayer().mults.faction_rep) || 1;
    let fwrg = 1; try { fwrg = ns.getBitNodeMultipliers().FactionWorkRepGain || 1; } catch (e) {}

    for (const c of list) {
        let rep = S.getFactionRep(c.faction);
        // buy missing rep via donation, if allowed and favor permits
        if (rep < c.repReq && DONATE) {
            let favor = 0; try { favor = S.getFactionFavor(c.faction); } catch (e) {}
            const need = (c.repReq - rep) * 1e6 / repMult / fwrg * 1.02;   // +2% buffer
            const price0 = DO_BUY ? S.getAugmentationPrice(c.aug) : S.getAugmentationBasePrice(c.aug) * Math.pow(1.9, bought.length);
            if (favor >= 150 && money >= need + price0) {
                if (DO_BUY) S.donateToFaction(c.faction, need);
                money -= need; donated += need; spent += need;
                rep = DO_BUY ? S.getFactionRep(c.faction) : c.repReq;
            }
        }
        if (rep < c.repReq) { blockedRep.push({ ...c, rep }); continue; }
        // money price: live value when buying (reflects 1.9x escalation); estimated in dry run
        const price = DO_BUY ? S.getAugmentationPrice(c.aug) : S.getAugmentationBasePrice(c.aug) * Math.pow(1.9, bought.length);
        if (money < price) { blockedMoney.push({ ...c, price }); continue; }
        if (DO_BUY && !S.purchaseAugmentation(c.faction, c.aug)) { blockedMoney.push({ ...c, price }); continue; }
        money -= price; spent += price; bought.push({ ...c, price }); have.add(c.aug);
    }

    // ---- report ----
    ns.tprint("=== augbuy " + (DO_BUY ? "(PURCHASED)" : "(DRY RUN -- add 'buy' to commit)") + " ===");
    ns.tprint((DO_BUY ? "bought " : "would buy ") + bought.length + " aug(s)  |  money $" + fmt(spent - donated)
        + (donated > 0 ? "  + donations $" + fmt(donated) : "") + "  |  total $" + fmt(spent));
    for (const b of bought) ns.tprint("  + " + b.aug + "  [" + b.faction + "]  $" + fmt(b.price));
    if (blockedRep.length) {
        ns.tprint("blocked on REP (" + blockedRep.length + ")" + (DONATE ? "" : " -- add 'donate' if favor>=150") + ":");
        for (const c of blockedRep) ns.tprint("  - " + c.aug + "  [" + c.faction + "]  need " + fmt(c.repReq) + " rep, have " + fmt(c.rep));
    }
    if (blockedMoney.length) {
        ns.tprint("blocked on MONEY (" + blockedMoney.length + "):");
        for (const c of blockedMoney) ns.tprint("  - " + c.aug + "  $" + fmt(c.price));
    }
    ns.tprint(bought.length
        ? "Next: INSTALL (game UI, or singularity.installAugmentations) to apply -- then run again for the next round."
        : "Nothing bought. Grind rep/level, or add 'donate' (favor>=150) / 'buy' as appropriate.");
}

function fmt(n) {
    const a = Math.abs(n);
    if (a >= 1e15) return (n / 1e15).toFixed(2) + "q";
    if (a >= 1e12) return (n / 1e12).toFixed(2) + "t";
    if (a >= 1e9)  return (n / 1e9).toFixed(2)  + "b";
    if (a >= 1e6)  return (n / 1e6).toFixed(2)  + "m";
    if (a >= 1e3)  return (n / 1e3).toFixed(1)  + "k";
    return n.toFixed(0);
}
