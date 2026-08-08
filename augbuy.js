/** augbuy.js -- one-shot hacking-augmentation buyer for the aug ratchet (built for BN9).
 *  Scans the factions you're in, finds hacking-relevant augs you don't own, and BUYS every
 *  one you can afford (rep + money). Picks the basket by VALUE PER DOLLAR and then buys it
 *  most-expensive-first -- see lib/aug-plan.js for why those are two different decisions and what
 *  goes wrong when you conflate them. With "donate" it buys the missing
 *  rep via donations (favor >= ns.getFavorToDonate() -- 150 by default, 75 in BN3). DRY RUN by default.
 *
 *  Buy in SMALL rounds then INSTALL: each aug queued in a round multiplies the next one's
 *  MONEY price by 1.9x, so one huge round blows up cost. This buys until the next is
 *  unaffordable; install between rounds so prices reset.
 *
 *  PREREQ CHAINS ARE BOUGHT IN ONE ROUND. A queued prereq satisfies the purchase gate
 *  (hasAugmentationPrereqs -> Player.hasAugmentation with ignoreQueued=false, Person.ts:233), so
 *  Embedded Netburner Module -> Core -> Core V2 -> Core V3 is a single round's work. Selection prices
 *  a dependent together with its unheld prereqs, and purchase order puts prereqs first even where
 *  base-descending would not -- which costs real money, and the estimate shows it.
 *
 *  usage: run augbuy.js [buy] [donate] [all] [nfg] [--why] [--budget N] [--cutoff K]
 *    (no flags)  DRY RUN -- report what it WOULD buy / donate and what's blocked
 *    buy         actually purchase
 *    donate      buy missing rep via donation (favor >= getFavorToDonate(); 75 in BN3) -- can cost trillions+
 *    all         include non-hacking augs too (for the Daedalus 30-aug count)
 *    nonfg       do NOT buy NeuroFlux Governor levels. The default is to finish every round by
 *                buying NFG until the money runs out: installing DESTROYS your cash
 *                (Player.money = 1000, PlayerObjectGeneralMethods.ts:102), so spare money has no
 *                other use once you commit to installing. Each level costs 2.166x the last.
 *    --nfg-reserve N   hold N dollars back from the NFG tail (default 0 -- spend to zero).
 *    --why       print the per-slot economics of the chosen round: what each aug costs at its
 *                slot, and the MARGINAL cost of including it (higher, because adding an aug pushes
 *                every cheaper one down a slot). Read this before committing -- it is the column
 *                that makes a bad basket obvious without having to trust the selector.
 *    --cutoff K  drop an aug whose realized $/value is worse than K x the round's best buy
 *                (default 10). Guards the tail of a long round, where the 1.9^slot escalation
 *                makes a cheap aug cost more than it is worth deferring one install.
 *    --budget N  plan against N dollars. The DEFAULT is now your NET WORTH, read from
 *                trader-data.txt (which trader.js publishes every tick) -- not your cash. The
 *                trader keeps ~90% of the pile in open positions, so a cash-only plan understates
 *                the round badly and picks a different, worse basket. Falls back to cash when
 *                trader-data.txt is missing, stale (>300s) or from a previous BitNode, and says so.
 *                augbuy still does NOT read ns.stock itself: every ns.stock symbol in the source
 *                costs static RAM whether it runs or not, and this must start without TIX access.
 *                Liquidate (panel: Trader 'SELL ALL') before committing a plan above your cash.
 *    --dump      write status/augbuy-board.json -- the full candidate board, weights, budget and
 *                NFG state, so tools/augbuy-replay.mjs can re-run the SAME planRound() offline
 *                against real game state. Use this before asking for a change to the selection.
 *    --rep-horizon H   how many hours of your existing rep income make a faction_rep multiplier
 *                worth buying (default 4). With a gang running, respect converts to faction rep for
 *                free, so faction_rep augs are usually worthless -- this is the knob that says how
 *                close to free counts as free. Set it high to buy rep augs again.
 *
 *  Real singularity calls (needs SF4) -- RAM is significant (~40-50GB); run on demand, not
 *  continuously (kill xpfarm briefly if home is tight). Excludes "The Red Pill" (node-exit;
 *  install that deliberately as the last step). Does NOT install -- you install when ready.
 *  Deployed by update.js (repo tree is auto-discovered -- no manifest to edit). @param {NS} ns */
import { augValue, selectRound, roundCost, orderedCost, orderWithPrereqs, roundEconomics,
         nodeWeights, gangRepPerSec, maxRepGap, DEFAULT_VALUE_CUTOFF } from "./lib/aug-plan.js";
import { planRound, nfgLadder as ladderOf, roundScore, dropImproves, unlockGains } from "./lib/aug-round.js";
import { hackMoneyIndex } from "./lib/node-policy.js";

export async function main(ns) {
    ns.disableLog("ALL");
    const DO_BUY = ns.args.includes("buy");
    const DONATE = ns.args.includes("donate");
    const ALL    = ns.args.includes("all");
    const NO_NFG = ns.args.includes("nonfg");
    const DUMP   = ns.args.includes("--dump") || ns.args.includes("dump");
    const rIdx   = ns.args.indexOf("--nfg-reserve");
    const NFG_RESERVE = rIdx >= 0 && Number(ns.args[rIdx + 1]) > 0 ? Number(ns.args[rIdx + 1]) : 0;
    const WHY    = ns.args.includes("--why") || ns.args.includes("why");
    const bIdx   = ns.args.indexOf("--budget");
    const BUDGET_ARG = bIdx >= 0 ? Number(ns.args[bIdx + 1]) : NaN;
    const hIdx   = ns.args.indexOf("--rep-horizon");
    const REP_HORIZON = hIdx >= 0 && Number(ns.args[hIdx + 1]) > 0 ? Number(ns.args[hIdx + 1]) : undefined;
    const cIdx   = ns.args.indexOf("--cutoff");
    // "--cutoff Infinity" (or any huge number) must mean "prune nothing" -- Number.isFinite would
    // have quietly turned that into the default 10.
    const CUTOFF = cIdx >= 0 && Number(ns.args[cIdx + 1]) > 0 && !Number.isNaN(Number(ns.args[cIdx + 1]))
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
    let hackExp = undefined;
    try { const pl = ns.getPlayer(); hackExp = (pl.exp && pl.exp.hacking) || undefined; } catch (e) {}
    // WEIGHTS ARE COMPUTED BELOW, NOT HERE. faction_rep's weight depends on how big the rep gap
    // across the CANDIDATE LIST is, so the candidates have to exist first. See the rep-engine block.

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
            if (aug === NFG_NAME) continue;      // handled by the NFG tail, not ranked against augs
            if (aug !== NFG_NAME && !ALL && !isHackingAug(aug)) continue;
            const rep = S.getFactionRep(f);
            const prev = cand.get(aug);
            if (!prev || rep > prev._rep) {
                let base = 0, stats = {};
                try { base = S.getAugmentationBasePrice(aug); } catch (e) { base = 0; }
                try { stats = S.getAugmentationStats(aug); } catch (e) { stats = {}; }
                cand.set(aug, {
                    aug, faction: f, _rep: rep, base, stats,   // value is scored after WEIGHTS exist
                    repReq: S.getAugmentationRepReq(aug), prereqs: S.getAugmentationPrereq(aug),
                });
            }
        }
    }

    // PREREQS: a QUEUED prereq satisfies the gate. hasAugmentationPrereqs (FactionHelpers.tsx:56)
    // calls Player.hasAugmentation(name) with ignoreQueued defaulting to false (Person.ts:233-241) --
    // the game's own refusal even says "purchase or install". So a whole chain is buyable in ONE
    // round, and requiring `installed` (as this did) silently discarded every chained aug on the
    // board: the entire ENM Core line, Cranial Signal Processors Gen II-V, every Graphene upgrade.
    // They were not reported as blocked either -- they simply never became candidates.
    const candNames = new Set(cand.keys());
    const buyable = [...cand.values()].filter(c => c.prereqs.every(p => installed.has(p) || candNames.has(p)));

    // ---- REP ENGINE. Is reputation actually the thing holding you back?
    //
    // faction_rep is INSTRUMENTAL -- it buys nothing by itself, it only shortens the wait for the
    // augs that do raise your hacking level. Weighting it a flat 1.0, level with `hacking`, silently
    // assumes rep is always scarce. With a 12-member gang running that is false: gang respect
    // converts to faction rep at faction_rep * respectGain * favorMult / 75 (Gang.ts:152-155), which
    // is thousands of rep/sec, free and unbounded.
    //
    // The cost of getting this wrong, measured live: a round bought ADR-V1, ADR-V2 and The Shadow's
    // Simulacrum -- three augs with ZERO hacking contribution -- for 37% of the round's value. From
    // slots 4, 5 and 7 they pushed every cheaper hacking aug up the 1.9^n curve, so the round cost
    // $175.28b for a 1.975x hacking multiplier that the six hacking augs alone deliver for $89.60b.
    //
    // Both inputs are read, not assumed, because both change: the gang's respect rate climbs all
    // node, and the gap shrinks every time you buy. gang-data.txt is node-scoped against
    // getResetInfo().lastNodeReset -- a file left over from the previous BitNode would otherwise
    // claim a rep engine that no longer exists.
    let resetInfo = null; try { resetInfo = ns.getResetInfo(); } catch (e) {}
    const nodeStart = resetInfo && resetInfo.lastNodeReset;
    let gRead = null;
    try { const raw = ns.read("gang-data.txt"); if (raw) gRead = JSON.parse(raw); } catch (e) {}
    if (gRead && typeof gRead.ts === "number" && Number.isFinite(nodeStart) && gRead.ts < nodeStart) gRead = null;
    let gangFavor = 0, repPerSec = 0, repSrc = "no gang-data.txt -- rep treated as the constraint";
    if (gRead && gRead.faction) {
        try { gangFavor = S.getFactionFavor(gRead.faction); } catch (e) {}
        repPerSec = gangRepPerSec(gRead, gangFavor);
        const age = Math.round((Date.now() - (gRead.ts || 0)) / 1000);
        repSrc = gRead.faction + " gang, favor " + gangFavor.toFixed(0) + ", data " + age + "s old";
        if (age > 600) { repPerSec = 0; repSrc += " -- STALE, rep treated as the constraint"; }
    }
    // The gap that matters is the LARGEST one still standing over augs that do something other than
    // raise rep -- i.e. how much rep until nothing you want is gated. Pure-rep augs are excluded
    // from that max by maxRepGap, or they would justify their own purchase.
    // Scoped to the gang's own faction: that is where the respect-driven rep actually lands.
    const gangFaction = gRead && gRead.faction ? gRead.faction : null;
    const repGap = maxRepGap(
        buyable.map(c => ({ repReq: c.repReq, rep: c._rep, stats: c.stats, faction: c.faction })),
        gangFaction ? new Set([gangFaction]) : null);

    const WEIGHTS = nodeWeights({
        hackingExp: hackExp,
        scriptHackMoneyGain: bnm && bnm.ScriptHackMoneyGain,
        serverMaxMoney: bnm && bnm.ServerMaxMoney,
        moneyFarmRunning: farmRunning,
        repPerSec, repShortfall: repGap, repHorizonHours: REP_HORIZON,
    });
    for (const c of cand.values()) c.value = augValue(c.stats, WEIGHTS);

    // THE PRICE OF VALUE, IN DOLLARS. NeuroFlux Governor is the alternative use of every dollar not
    // spent on augs, because installing destroys what is left (Player.money = 1000). So the marginal
    // NFG level gives selectRound an ABSOLUTE threshold: keep an aug exactly when it buys value more
    // cheaply than the NFG level its cost would displace. That replaces the old relative cutoff,
    // which compared augs only to each other and so had no idea whether the whole round was a good
    // use of money. Measured on the live board the difference is 1.506 vs 1.063 of round value.
    //
    // nfgValue is scored through the SAME weights as everything else rather than hardcoded, so it
    // tracks the node: NFG's hacking_money +1% is worth nothing here with the farm stopped.
    let nfgValue = 0;
    try { nfgValue = augValue(S.getAugmentationStats(NFG_NAME), WEIGHTS); } catch (e) {}
    let nfgPrice0 = 0;
    try { nfgPrice0 = S.getAugmentationPrice(NFG_NAME); } catch (e) {}
    const NFG = nfgValue > 0 && nfgPrice0 > 0 ? { price0: nfgPrice0, valuePerLevel: nfgValue } : null;

    // LIVE QUEUE ESCALATION. getAugmentationPrice reflects the 1.9^queued multiplier
    // (AugmentationHelpers.ts:157); getAugmentationBasePrice does not. Their RATIO is therefore the
    // current multiplier -- exact, needs no counting, and immune to the NFG quirk where each
    // purchased level is its own queue entry (Augmentation.ts:241-245). Probe any standard aug; SoA
    // and NFG price differently. Without this a second augbuy run after a round of buying prices
    // everything from 1.9^0. Verified live: Unstable Circadian Modulator showed $5.00b in the dry run
    // against a real $849.18b -- ratio 169.83 = 1.9^8, matching 8 queued augs exactly.
    let queueMult = 1;
    for (const probe of buyable) {
        try {
            const b = S.getAugmentationBasePrice(probe.aug), pr = S.getAugmentationPrice(probe.aug);
            if (b > 0 && pr > 0) { queueMult = pr / b; break; }
        } catch (e) {}
    }

    const money0 = ns.getPlayer().money;
    // BUDGET DEFAULTS TO NET WORTH, NOT CASH. Your buying power is what you can liquidate, and the
    // trader parks ~90% of the pile in open positions -- planning on cash alone built a round for
    // $6.7t when $13.5t was available, which picks a materially different (and worse) basket, since
    // a small budget buys cheap high-multiplier augs for slot 0 while a large one can afford the
    // big-ticket ones. augbuy still does not touch ns.stock: every ns.stock symbol appearing in the
    // source costs static RAM whether or not it runs, and augbuy must start on a save with no TIX
    // access. trader.js already pays for the API and publishes trader-data.txt; ns.read is free.
    let tRead = null;
    try { const raw = ns.read("trader-data.txt"); if (raw) tRead = JSON.parse(raw); } catch (e) {}
    if (tRead && typeof tRead.ts === "number" && Number.isFinite(nodeStart) && tRead.ts < nodeStart) tRead = null;
    const tAge = tRead ? Math.round((Date.now() - (tRead.ts || 0)) / 1000) : Infinity;
    // 300s: the trader rewrites this every price tick (~6s), so anything older means it is not
    // running and the positions it describes may already have been sold.
    const netWorth = tRead && Number.isFinite(tRead.net) && tAge <= 300 ? tRead.net : null;
    let budgetSrc;
    let budget;
    if (Number.isFinite(BUDGET_ARG) && BUDGET_ARG > 0) { budget = BUDGET_ARG; budgetSrc = "--budget"; }
    else if (netWorth !== null && netWorth > money0) { budget = netWorth; budgetSrc = "net worth (trader-data.txt, " + tAge + "s old)"; }
    else { budget = money0; budgetSrc = netWorth !== null ? "cash (= net worth)" : "cash -- no fresh trader-data.txt; run trader.js or pass --budget"; }

    const affordableByRep = buyable.filter(c => c._rep >= c.repReq);
    const nfgLadder = (queued, cash) => ladderOf(nfgPrice0, nfgValue, queued, cash);

    const selBase = { valueCutoff: CUTOFF, priceScale: queueMult, held: installed };
    // An explicit --cutoff is the user overriding policy; honour it and skip the search. With the NFG
    // tail off, money is NOT being spent to zero, so preserving it for the next round is a real
    // option and the relative cutoff is the only rule that expresses that.
    const plan = DONATE ? null
        : planRound(affordableByRep, budget, (NO_NFG || cIdx >= 0) ? selBase : { ...selBase, nfg: NFG });
    let selThreshold = plan ? plan.threshold : null;
    const list = DONATE
        ? buyable.sort((a, b) => (b.base - a.base) || (a.repReq - b.repReq))
        : plan.list;

    const planCost = DONATE ? null : orderedCost(list) * queueMult;
    // THE OPERATIVE NUMBER IS THE SETTLED ONE. `selThreshold` is the value that was fed to the
    // search that happened to produce the winning basket -- an input, not a property of the result.
    // Reporting it read as "$743.58t per unit value" while the basket it chose actually leaves the
    // next NFG level at ~$297t, and a reader has no way to tell those apart. The number that means
    // something is what the NEXT NFG level costs given this basket, because that is the line every
    // aug kept had to beat. The loose search threshold is not a correctness problem -- candidate
    // baskets are scored on the true objective and the best one wins regardless of which threshold
    // generated it -- but it is not the thing to print.
    const settledNfg = DONATE ? Infinity
        : nfgLadder(list.length, budget - orderedCost(list) * queueMult).marginal;

    const bought = [], blockedRep = [], blockedMoney = [], donateRefused = [];
    let money = ns.getPlayer().money, spent = 0, donated = 0;
    const repMult = (ns.getPlayer().mults && ns.getPlayer().mults.faction_rep) || 1;
    let fwrg = 1; try { fwrg = ns.getBitNodeMultipliers().FactionWorkRepGain || 1; } catch (e) {}
    // The donation favor gate is NOT a constant 150. It is
    //   floor(CONSTANTS.BaseFavorToDonate * currentNodeMults.FavorToDonateToFaction)
    // (Faction/formulas/donation.ts:17), and ns.getFavorToDonate() returns exactly that. BN3 sets
    // FavorToDonateToFaction: 0.5, so the real gate there is 75 -- hardcoding 150 silently refused
    // to donate across the entire 75..149 band in the one node where donation matters most, since
    // BN3 also triples AugmentationRepCost.
    let favorGate = 150; try { favorGate = ns.getFavorToDonate(); } catch (e) {}

    for (const c of list) {
        let rep = S.getFactionRep(c.faction);
        // buy missing rep via donation, if allowed and favor permits
        // YOU CANNOT DONATE TO YOUR OWN GANG'S FACTION. Not a favor threshold -- a categorical refusal:
        //   if (Player.gang && faction.name === Player.getGangFaction().name) return false
        // (Singularity.ts:903-906, "because you are managing a gang for it"). Favor is irrelevant, and
        // a gang faction reaches enormous favor at the first install, so this looks available exactly
        // when it is most tempting. Slum Snakes hit favor ~383 against a gate of 75 and still refuses.
        //
        // The old code called donateToFaction and IGNORED its return value, then debited money,
        // donated and spent regardless -- so a refused donation corrupted the whole report's
        // accounting, and in a DRY RUN it asserted rep = repReq and listed the aug as affordable.
        // Both directions are now checked.
        const isGangFaction = gangFaction && c.faction === gangFaction;
        if (rep < c.repReq && DONATE && !isGangFaction) {
            let favor = 0; try { favor = S.getFactionFavor(c.faction); } catch (e) {}
            // repFromDonation = amt / DonateMoneyToRepDivisor * mults.faction_rep * FactionWorkRepGain
            // (Faction/formulas/donation.ts:8-10) -- no favor term, so this inverts exactly.
            const need = (c.repReq - rep) * 1e6 / repMult / fwrg * 1.02;   // +2% buffer
            const price0 = DO_BUY ? S.getAugmentationPrice(c.aug) : S.getAugmentationBasePrice(c.aug) * queueMult * Math.pow(1.9, bought.length);
            if (favor >= favorGate && money >= need + price0) {
                const ok = DO_BUY ? S.donateToFaction(c.faction, need) : true;
                if (ok) {
                    money -= need; donated += need; spent += need;
                    rep = DO_BUY ? S.getFactionRep(c.faction) : c.repReq;
                } else {
                    donateRefused.push(c.faction);
                }
            }
        }
        if (rep < c.repReq) { blockedRep.push({ ...c, rep }); continue; }
        // money price: live value when buying (reflects 1.9x escalation); estimated in dry run
        const price = DO_BUY ? S.getAugmentationPrice(c.aug) : S.getAugmentationBasePrice(c.aug) * queueMult * Math.pow(1.9, bought.length);
        if (money < price) { blockedMoney.push({ ...c, price }); continue; }
        if (DO_BUY && !S.purchaseAugmentation(c.faction, c.aug)) { blockedMoney.push({ ...c, price }); continue; }
        money -= price; spent += price; bought.push({ ...c, price }); have.add(c.aug);
    }

    // ---- NFG TAIL ----
    //
    // WHY LAST, AND WHY TO ZERO.
    // Last: every NFG level is its own entry in queuedAugmentations, so each one multiplies the price
    // of everything bought after it by 1.9 (getGenericAugmentationPriceMultiplier, AugmentationHelpers
    // .ts:32-38). NFG also has the smallest base on the board, so the rearrangement inequality puts it
    // at the highest exponents anyway. Both arguments point the same way: buy augs first, NFG after.
    //
    // To zero: prestigeAugmentation sets Player.money = 1000 + CONSTANTS.Donations
    // (PlayerObjectGeneralMethods.ts:102). Installing DESTROYS your cash. So the marginal NFG level
    // being ~1700x worse dollar-for-value than the round's best aug does not matter -- the money has
    // no other use once you commit to installing. It is only wrong if you DON'T install, which is why
    // this says so loudly rather than assuming.
    //
    // The ladder compounds twice over: cost = base * 1.14^level * nodeMult * 1.9^queued, so each
    // successive level costs 1.14 * 1.9 = 2.166x the one before. Roughly 11 levels per order of
    // magnitude of spare cash, and it self-limits fast.
    const NFG_LADDER = 1.14 * 1.9;
    const nfgBought = [];
    let nfgSpent = 0, nfgStop = "";
    if (!NO_NFG && !DONATE) {
        // NFG is sold by nearly every faction; buy from wherever you hold the most rep.
        let nfgFaction = null, nfgRep = -1;
        for (const f of factions) {
            let offers = false;
            try { offers = S.getAugmentationsFromFaction(f).includes(NFG_NAME); } catch (e) {}
            if (!offers) continue;
            const r = S.getFactionRep(f);
            if (r > nfgRep) { nfgRep = r; nfgFaction = f; }
        }
        if (!nfgFaction) nfgStop = "no faction you belong to sells NeuroFlux Governor";
        else {
            // Live price already includes 1.14^level and the node multiplier; in a DRY RUN the augs
            // above were not really queued, so their 1.9^n has to be applied by hand.
            let price0 = 0, repReq0 = 0;
            try { price0 = S.getAugmentationPrice(NFG_NAME); repReq0 = S.getAugmentationRepReq(NFG_NAME); } catch (e) {}
            if (!(price0 > 0)) nfgStop = "could not price NeuroFlux Governor";
            for (let n = 0; n < 200 && !nfgStop; n++) {
                const price = DO_BUY ? S.getAugmentationPrice(NFG_NAME)
                    : price0 * Math.pow(1.9, bought.length) * Math.pow(NFG_LADDER, n);
                const need = DO_BUY ? S.getAugmentationRepReq(NFG_NAME) : repReq0 * Math.pow(1.14, n);
                const repNow = DO_BUY ? S.getFactionRep(nfgFaction) : nfgRep;
                if (repNow < need) { nfgStop = "rep " + fmt(repNow) + " < " + fmt(need) + " at " + nfgFaction; break; }
                if (money - NFG_RESERVE < price) { nfgStop = "next level costs $" + fmt(price) + ", $" + fmt(Math.max(0, money - NFG_RESERVE)) + " left"; break; }
                if (DO_BUY && !S.purchaseAugmentation(nfgFaction, NFG_NAME)) { nfgStop = "purchase refused by the game"; break; }
                money -= price; spent += price; nfgSpent += price;
                nfgBought.push({ level: n, price });
            }
        }
    }

    // ---- BOARD DUMP ----
    // Everything the round decision consumes, written where rfa-sync can pull it to disk. augbuy's
    // defects have only ever been caught by running it in-game and reading the numbers; that costs a
    // round trip per fix, and four fixes in a row went that way. With the board on disk,
    // tools/augbuy-replay.mjs runs the SAME planRound() offline against real state, so the next
    // change is verified before it ships rather than after.
    if (DUMP) {
        try {
            const pl = ns.getPlayer();
            ns.write("status/augbuy-board.json", JSON.stringify({
                ts: Date.now(),
                bitNode: (resetInfo && resetInfo.currentNode) || null,
                budget, money0, netWorth, queueMult, cutoff: CUTOFF,
                flags: { NO_NFG, DONATE, ALL, repHorizon: REP_HORIZON || 4 },
                weights: WEIGHTS,
                weightInputs: {
                    hackingExp: hackExp, repPerSec, repShortfall: repGap, moneyFarmRunning: farmRunning,
                    scriptHackMoneyGain: bnm && bnm.ScriptHackMoneyGain, serverMaxMoney: bnm && bnm.ServerMaxMoney,
                },
                bn: bnm ? {
                    WorldDaemonDifficulty: bnm.WorldDaemonDifficulty,
                    HackingLevelMultiplier: bnm.HackingLevelMultiplier,
                    AugmentationMoneyCost: bnm.AugmentationMoneyCost,
                    AugmentationRepCost: bnm.AugmentationRepCost,
                } : null,
                player: {
                    hackingLevel: pl.skills && pl.skills.hacking,
                    hackingMult: (pl.mults && pl.mults.hacking) || 1,
                    hackingExp: pl.exp && pl.exp.hacking,
                },
                nfg: NFG ? { ...NFG, repReq: (() => { try { return S.getAugmentationRepReq(NFG_NAME); } catch (e) { return null; } })() } : null,
                installed: [...installed],
                // per-faction rep+favor: two dumps apart give a MEASURED rate per faction, which is
                // the only honest basis for a rep ETA outside the gang.
                factions: factions.map(f => {
                    let r = 0, fav = 0;
                    try { r = S.getFactionRep(f); } catch (e) {}
                    try { fav = S.getFactionFavor(f); } catch (e) {}
                    return { faction: f, rep: r, favor: fav, isGang: f === gangFaction };
                }),
                // buyable, not the selected list -- the replay must be free to choose differently
                candidates: buyable.map(c => ({
                    aug: c.aug, faction: c.faction, rep: c._rep, base: c.base,
                    repReq: c.repReq, prereqs: c.prereqs, value: c.value, stats: c.stats,
                })),
            }), "w");
            ns.tprint("dumped " + buyable.length + " candidates -> status/augbuy-board.json"
                + "  (rfa-sync pulls it to the repo; replay with: node tools/augbuy-replay.mjs)");
        } catch (e) { ns.tprint("dump FAILED: " + e); }
    }

    // ---- report ----
    ns.tprint("=== augbuy " + (DO_BUY ? "(PURCHASED)" : "(DRY RUN -- add 'buy' to commit)") + " ===");
    if (!DONATE) {
        if (queueMult > 1.001) {
            ns.tprint("QUEUE ESCALATION x" + queueMult.toFixed(1) + " -- augs bought but NOT installed."
                + " Every price below is base x" + queueMult.toFixed(1) + ". INSTALL to reset it to x1.");
        }
        ns.tprint("weights: money-farm x" + (WEIGHTS.hacking_money / 0.5).toFixed(2)
            + " (node " + hackMoneyIndex(bnm).toFixed(2)
            + ", coordinator " + (farmRunning ? "running" : "STOPPED") + ")"
            + "   exp-channel x" + (WEIGHTS.hacking_exp).toFixed(3)
            + "   faction_rep x" + (WEIGHTS.faction_rep).toFixed(3));
        ns.tprint("  rep: " + fmt(repPerSec) + "/s [" + repSrc + "]"
            + "   largest gap " + fmt(repGap) + " rep"
            + (repPerSec > 0 ? " = " + (repGap / repPerSec / 3600).toFixed(2) + "h of income"
                             : " (no measurable rep income)")
            + "   horizon " + (REP_HORIZON || 4) + "h");
        if (selThreshold !== null) {
            ns.tprint("  NFG line: $" + fmt(settledNfg) + " per unit value -- what the next NFG level costs"
                + " given this basket. Augs above it are NOT automatically wrong to keep: dropping one"
                + " also frees a queue slot, cutting every NFG level by 1.9x"
                + (Number.isFinite(selThreshold) && Math.abs(selThreshold - settledNfg) > settledNfg * 0.2
                    ? "   [search threshold $" + fmt(selThreshold) + "; baskets are scored on total round"
                      + " value, so the winner stands regardless]" : ""));
        } else {
            ns.tprint("  keep-an-aug threshold: relative x" + CUTOFF + " of the round's best buy"
                + (NO_NFG ? " (NFG tail off, so unspent money survives to the next round)" : " (--cutoff given)"));
        }
        ns.tprint("budget $" + fmt(budget) + "  [" + budgetSrc + "]"
            + "   cash $" + fmt(money0)
            + (netWorth !== null ? "   net worth $" + fmt(netWorth) : ""));
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
        ns.tprint("blocked on REP (" + blockedRep.length + ")"
            + (DONATE ? "" : " -- add 'donate' if favor >= " + favorGate) + ":");
        if (DONATE && gangFaction) {
            ns.tprint("  note: donations to " + gangFaction + " are refused outright because you run its gang"
                + " (Singularity.ts:903) -- favor does not matter. Gang rep comes from respect instead.");
        }
        if (donateRefused.length) {
            ns.tprint("  note: the game REFUSED donations to " + [...new Set(donateRefused)].join(", ")
                + " -- these factions may not offer work. Nothing was spent on them.");
        }
        for (const c of blockedRep) ns.tprint("  - " + c.aug + "  [" + c.faction + "]  need " + fmt(c.repReq) + " rep, have " + fmt(c.rep));
    }
    if (blockedMoney.length) {
        ns.tprint("blocked on MONEY (" + blockedMoney.length + "):");
        for (const c of blockedMoney) ns.tprint("  - " + c.aug + "  $" + fmt(c.price));
    }
    // REP-GATED CANDIDATES. These are filtered out before selectRound ever sees them, so without this
    // section the report says "largest gap 268.8k rep" and never says what closing it would buy. That
    // is the number that decides whether to commit now or wait twenty minutes, and money is usually
    // slack enough that waiting wins.
    if (!DONATE) {
        const gated = buyable
            .filter(c => c._rep < c.repReq && c.value > 0)
            .sort((a, b) => (a.repReq - a._rep) - (b.repReq - b._rep));
        if (gated.length) {
            ns.tprint("REP-GATED (" + gated.length + ") -- not in the plan above; ETA at "
                + fmt(repPerSec) + " rep/s" + (repPerSec > 0 ? "" : " (no income -- these need faction work or 'donate')") + ":");
            // An aug's own value is NOT what unlocking it is worth: adding one shifts every cheaper
            // aug down a slot, may push something else out, and changes what is left for NFG. So
            // re-plan with it unlocked and print the ROUND delta -- the number that decides whether
            // to wait. Capped, because each entry costs a full planRound.
            const gains = NFG && !NO_NFG
                ? unlockGains(affordableByRep, gated, budget, { ...selBase, nfg: NFG },
                              roundScore(list, budget, NFG, queueMult).total, 6)
                : [];
            let shown = 0;
            for (const c of gated) {
                if (shown >= 12) { ns.tprint("  ... and " + (gated.length - 12) + " more"); break; }
                const gap = c.repReq - c._rep;
                const g = gains[shown];
                shown++;
                // ONLY quote an ETA when the income actually reaches THIS faction. The gang's rep
                // goes to the gang's faction and nowhere else; quoting it against another faction's
                // gap invents a deadline that will never arrive.
                const fed = gangFaction && c.faction === gangFaction && repPerSec > 0;
                ns.tprint("  ~ " + c.aug.padEnd(38) + " [" + c.faction + "]  need " + fmt(gap) + " more rep"
                    + (fed ? "  ETA " + fmtDur(gap / repPerSec)
                           : "  -- NOT fed by the gang (" + (gangFaction || "no gang") + " gets the respect);"
                             + " needs faction work at " + c.faction + " or 'donate'")
                    + "   value " + c.value.toFixed(3) + "  base $" + fmt(c.base)
                    + (g && g.aug === c.aug && g.gain > 1e-9
                        ? "   WAITING IS WORTH +" + g.gain.toFixed(3) + " round (-> x" + g.hacking.toFixed(3) + " hacking)"
                        : g && g.aug === c.aug ? "   (no round gain -- would not make the basket)" : ""));
            }
        }
    }
    if (nfgBought.length || nfgStop) {
        ns.tprint("NFG TAIL: " + nfgBought.length + " level(s)  $" + fmt(nfgSpent)
            + (nfgBought.length ? "  -> all multipliers x" + Math.pow(1.01, nfgBought.length).toFixed(4) : "")
            + (nfgStop ? "   [stopped: " + nfgStop + "]" : ""));
        if (nfgBought.length) {
            ns.tprint("  each level costs 2.166x the last (1.14 level mult x 1.9 queue mult)."
                + " Cash is DESTROYED on install (Player.money = 1000), so spending to zero is only");
            ns.tprint("  correct if you install NOW. Pass 'nonfg' or --nfg-reserve N to hold money back.");
            if (WHY) for (const l of nfgBought) ns.tprint("    NFG +" + String(l.level + 1).padStart(3) + "   $" + fmt(l.price));
        }
    }
    if (WHY && list.length) {
        // The diagnostic that makes a bad round visible WITHOUT trusting the selector. Every defect
        // this tool has shipped was caught by running it and reading the numbers, never by review or
        // by unit tests -- the tests encode the same model that produced the bug. So: print the model
        // and let it be checked.
        const econ = roundEconomics(list, { priceScale: queueMult });
        const totV = econ.reduce((a, r) => a + r.value, 0);
        const totC = econ.reduce((a, r) => a + r.paid, 0);
        const fin = econ.map(r => r.marginalPerValue).filter(Number.isFinite);
        const best = fin.length ? Math.min(...fin) : Infinity;
        ns.tprint("");
        ns.tprint("WHY -- 'paid' is this aug's own price at its slot; 'marginal' is what DROPPING it would");
        ns.tprint("save, which is larger because every cheaper aug then moves up a slot. Judge on marg$/val.");
        ns.tprint("slot " + "aug".padEnd(34) + "     paid  value    $/val   marginal marg$/val  escal");
        for (const r of econ) {
           // FLAG THE EXACT THING, NOT A PROXY. Both previous markers were ratio heuristics and both
            // degenerated into flagging every row. Worse, "marg$/val is above the NFG line" does NOT
            // mean an aug should go: dropping one also frees a QUEUE SLOT, making every NFG level 1.9x
            // cheaper, while the money it frees is lumpy against a ladder that climbs 2.166x a step.
            // On the live board all sixteen augs sat above the NFG line and not one was worth dropping.
            //
            // The decision is made by scoring whole baskets, so ask that question directly: would
            // removing this aug (and anything depending on it) raise total round value? Normally
            // nothing is flagged, which is the point -- a marker that fires constantly says nothing.
            const weak = selThreshold !== null ? dropImproves(list, r.aug, budget, NFG, queueMult)
                : (Number.isFinite(r.marginalPerValue) && r.marginalPerValue > best * 5);
            ns.tprint(
                String(r.slot).padStart(4) + " " + String(r.aug).slice(0, 34).padEnd(34) +
                " $" + fmt(r.paid).padStart(7) +
                " " + r.value.toFixed(3).padStart(6) +
                " $" + fmt(r.perValue).padStart(7) +
                " $" + fmt(r.marginal).padStart(8) +
                " $" + fmt(r.marginalPerValue).padStart(8) +
                " " + r.escalation.toFixed(1).padStart(6) + "x" + (weak ? (selThreshold !== null ? "  <-- DROP IMPROVES ROUND" : "  <-- weak") : ""));
        }
        ns.tprint("     " + "TOTAL".padEnd(34) + " $" + fmt(totC).padStart(7) + " " + totV.toFixed(3).padStart(6)
            + " $" + fmt(totV > 0 ? totC / totV : 0).padStart(7) + "   avg $/value for the round");
        ns.tprint("");
    }

    // WHAT THIS ROUND IS ACTUALLY WORTH. `value` is a weighted log-sum -- useful for ranking, not
    // readable as progress. The exit gate is a HACKING LEVEL, and level = mult * bracket with the
    // bracket fixed at a given exp, so the gate in multiplier terms is reqLevel * mult / level.
    // Reported as a snapshot: the bracket keeps growing with exp, so the real requirement falls over
    // time and this is the pessimistic reading.
    let hackMult = 1;
    for (const b of bought) { const h = Number(b.stats && b.stats.hacking); if (h > 1) hackMult *= h; }
    const nfgMult = Math.pow(1.01, nfgBought.length);
    if (bought.length || nfgBought.length) {
        let line = "ROUND DELIVERS x" + (hackMult * nfgMult).toFixed(3) + " hacking"
            + "  (augs x" + hackMult.toFixed(3) + (nfgBought.length ? ", NFG x" + nfgMult.toFixed(3) : "") + ")";
        try {
            const pl = ns.getPlayer();
            const lvl = pl.skills.hacking, cur = (pl.mults && pl.mults.hacking) || 1;
            // w0r1d_d43m0n is hidden from server lookups until The Red Pill is INSTALLED
            // (ServerHelpers.ts:340-343), so this throws for the entire run-up -- which is exactly
            // when the number is useful. Fall back to the definition: base requiredHackingSkill 3000
            // (servers.ts:1553) scaled by the node's WorldDaemonDifficulty (ServerHelpers.ts:422-423).
            let req = 0;
            try { req = ns.getServerRequiredHackingLevel("w0r1d_d43m0n"); } catch (e) {}
            if (!(req > 0)) req = 3000 * ((bnm && bnm.WorldDaemonDifficulty) || 1);
            if (lvl > 0 && req > 0) {
                const needMult = req * cur / lvl;               // mult required at TODAY's exp
                const after = cur * hackMult * nfgMult;
                const left = needMult / after;
                line += left <= 1
                    ? "   -- CLEARS the exit gate (needs x" + needMult.toFixed(2) + ", you reach x" + after.toFixed(2) + ")"
                    : "   exit needs x" + needMult.toFixed(2) + " at today's exp; after this round x" + after.toFixed(2)
                      + " -> ~" + Math.ceil(Math.log(left) / Math.log(hackMult * nfgMult)) + " more round(s) at this rate";
            }
        } catch (e) {}
        ns.tprint(line);
    }

    ns.tprint(bought.length || nfgBought.length
        ? "Next: INSTALL (game UI, or singularity.installAugmentations) to apply. The NFG tail assumes you"
          + " do that now -- unspent cash is destroyed on install, and every queued aug keeps the 1.9x"
          + " escalation standing until you do."
        : "Nothing bought. Grind rep/level, or add 'donate' (favor >= getFavorToDonate()) / 'buy' as appropriate.");
}

function fmtDur(sec) {
    if (!isFinite(sec)) return "--";
    if (sec < 60) return Math.round(sec) + "s";
    if (sec < 3600) return Math.round(sec / 60) + "m";
    if (sec < 86400) return (sec / 3600).toFixed(1) + "h";
    return (sec / 86400).toFixed(1) + "d";
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
