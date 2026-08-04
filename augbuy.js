/** augbuy.js -- one-shot hacking-augmentation buyer for the aug ratchet (built for BN9).
 *  Scans the factions you're in, finds hacking-relevant augs you don't own, and BUYS every
 *  one you can afford (rep + money). Picks the basket by VALUE PER DOLLAR and then buys it
 *  most-expensive-first -- see lib/aug-plan.js for why those are two different decisions and what
 *  goes wrong when you conflate them. With "donate" it buys the missing
 *  rep via donations (favor >= 150 factions only -- the big money sink). DRY RUN by default.
 *
 *  Buy in SMALL rounds then INSTALL: each aug queued in a round multiplies the next one's
 *  MONEY price by 1.9x, so one huge round blows up cost. This buys until the next is
 *  unaffordable; install between rounds so prices reset and prereqs unlock.
 *
 *  usage: run augbuy.js [buy] [donate] [all] [nfg] [--budget N]
 *    (no flags)  DRY RUN -- report what it WOULD buy / donate and what's blocked
 *    buy         actually purchase
 *    donate      buy missing rep via donation (favor >= 150 only) -- can cost trillions+
 *    all         include non-hacking augs too (for the Daedalus 30-aug count)
 *    nfg         also buy NeuroFlux Governor levels (expensive; buy deliberately)
 *    --cutoff K  drop an aug whose realized $/value is worse than K x the round's best buy
 *                (default 10). Guards the tail of a long round, where the 1.9^slot escalation
 *                makes a cheap aug cost more than it is worth deferring one install.
 *    --budget N  plan against N dollars instead of your CASH. Your buying power is usually net
 *                worth, not cash -- the trader keeps ~90% of it in open positions -- so a plan
 *                built on cash alone badly understates the round. Pass your net worth to see the
 *                real basket, then liquidate (panel: Trader 'SELL ALL') before committing.
 *                augbuy deliberately does NOT read ns.stock itself: that would add stock-API RAM
 *                to an already ~45GB script and make it fail outright without TIX access.
 *
 *  Real singularity calls (needs SF4) -- RAM is significant (~40-50GB); run on demand, not
 *  continuously (kill xpfarm briefly if home is tight). Excludes "The Red Pill" (node-exit;
 *  install that deliberately as the last step). Does NOT install -- you install when ready.
 *  Deployed by update.js (repo tree is auto-discovered -- no manifest to edit). @param {NS} ns */
import { augValue, selectRound, roundCost, nodeWeights, DEFAULT_VALUE_CUTOFF } from "./lib/aug-plan.js";

export async function main(ns) {
    ns.disableLog("ALL");
    const DO_BUY = ns.args.includes("buy");
    const DONATE = ns.args.includes("donate");
    const ALL    = ns.args.includes("all");
    const NFG    = ns.args.includes("nfg");
    const bIdx   = ns.args.indexOf("--budget");
    const BUDGET_ARG = bIdx >= 0 ? Number(ns.args[bIdx + 1]) : NaN;
    const cIdx   = ns.args.indexOf("--cutoff");
    const CUTOFF = cIdx >= 0 && Number.isFinite(Number(ns.args[cIdx + 1]))
        ? Number(ns.args[cIdx + 1]) : DEFAULT_VALUE_CUTOFF;
    const S = ns.singularity;
    const NFG_NAME = "NeuroFlux Governor", REDPILL = "The Red Pill";

    const factions = ns.getPlayer().factions;
    if (!factions.length) { ns.tprint("augbuy: you're not in any factions yet -- backdoor faction servers first."); return; }

    const have = new Set(S.getOwnedAugmentations(true));    // purchased + queued + installed -> "already have"
    const installed = new Set(S.getOwnedAugmentations(false)); // installed only -> for prereq checks

    // NODE-AWARE WEIGHTS. Whether a hacking_money multiplier is worth anything depends on the node
    // (ScriptHackMoneyGain x ServerMaxMoney) AND on whether a farm is actually running. Both are
    // read live rather than assumed: getBitNodeMultipliers is already paid for below, and ns.ps is
    // 0.2GB. In BN2 the node alone scores 0.08, so even with the farm up these barely register.
    let bnm = null; try { bnm = ns.getBitNodeMultipliers(); } catch (e) {}
    let farmRunning = false;
    try { farmRunning = ns.ps("home").some(p => p.filename === "coordinator.js"); } catch (e) {}
    const WEIGHTS = nodeWeights({
        scriptHackMoneyGain: bnm && bnm.ScriptHackMoneyGain,
        serverMaxMoney: bnm && bnm.ServerMaxMoney,
        moneyFarmRunning: farmRunning,
    });

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
                let base = 0, stats = {};
                try { base = S.getAugmentationBasePrice(aug); } catch (e) { base = 0; }
                try { stats = S.getAugmentationStats(aug); } catch (e) { stats = {}; }
                cand.set(aug, {
                    aug, faction: f, _rep: rep, base, value: augValue(stats, WEIGHTS),
                    repReq: S.getAugmentationRepReq(aug), prereqs: S.getAugmentationPrereq(aug),
                });
            }
        }
    }

    // Only augs whose prerequisites are already INSTALLED are buyable this round.
    const buyable = [...cand.values()].filter(c => c.prereqs.every(p => installed.has(p)));

    // SELECTION vs ORDERING -- two decisions, two keys. See lib/aug-plan.js.
    //   ordering:  base cost DESCENDING is cheapest for a fixed basket (rearrangement inequality),
    //              because purchase i costs base_i * 1.9^i.
    //   selection: must be VALUE PER DOLLAR. Selecting by cost buys the dearest augs on the board,
    //              which is how a $7.21b round bought PCMatrix ($2b for faction_rep 1.08) while
    //              skipping S.N.A ($30m for 1.15).
    // selectRound does both: greedy on density, returned in purchase order.
    const money0 = ns.getPlayer().money;
    const budget = Number.isFinite(BUDGET_ARG) && BUDGET_ARG > 0 ? BUDGET_ARG : money0;
    const affordableByRep = buyable.filter(c => c._rep >= c.repReq);
    // The donate path can manufacture rep, so it can't be pre-selected against a rep filter --
    // fall back to the whole buyable set, ordered cheapest-for-the-basket.
    const list = DONATE
        ? buyable.sort((a, b) => (b.base - a.base) || (a.repReq - b.repReq))
        : selectRound(affordableByRep, budget, { valueCutoff: CUTOFF });
    const planCost = DONATE ? null : roundCost(list.map(c => c.base));

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
    if (!DONATE) {
        ns.tprint("weights: money-farm mults x" + (WEIGHTS.hacking_money / 0.5).toFixed(2)
            + "  (node " + (bnm ? ((bnm.ScriptHackMoneyGain ?? 1) * (bnm.ServerMaxMoney ?? 1)).toFixed(2) : "?")
            + ", coordinator " + (farmRunning ? "running" : "STOPPED") + ")");
        ns.tprint("budget $" + fmt(budget) + (Number.isFinite(BUDGET_ARG) && BUDGET_ARG > 0
            ? "  (--budget; your CASH is $" + fmt(money0) + ")" : "  (cash -- pass --budget <net worth> to plan against positions too)"));
        if (planCost !== null && planCost > money0) {
            ns.tprint("LIQUIDATE FIRST: this plan needs $" + fmt(planCost) + " but you hold $" + fmt(money0)
                + " in cash. Panel -> Trader -> SELL ALL, then re-run.");
            // Without this the next line reads as a recommendation, and it isn't. The buy loop stops
            // at real cash, so what follows is the affordable PREFIX of a plan built for a bigger
            // budget -- which is NOT the best basket for the cash on hand. Those are different
            // optimisations: a big budget picks big-ticket augs for slot 0, a small one picks cheap
            // high-multiplier augs. Re-run without --budget to see the right plan for your cash.
            ns.tprint("  (the list below is only the part you can afford NOW, not an optimal plan for"
                + " $" + fmt(money0) + " -- re-run without --budget for that)");
        }
    }
    ns.tprint((DO_BUY ? "bought " : "would buy ") + bought.length + " aug(s)  |  money $" + fmt(spent - donated)
        + (donated > 0 ? "  + donations $" + fmt(donated) : "") + "  |  total $" + fmt(spent));
    for (const b of bought) ns.tprint("  + " + b.aug.padEnd(38) + " [" + b.faction + "]  $" + fmt(b.price)
        + "   value " + (b.value || 0).toFixed(3) + "  (base $" + fmt(b.base) + ")");
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
