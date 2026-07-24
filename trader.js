/** trader.js -- BN8 stock-market income engine (self-provisioning).
 *
 *  In BN8 (Ghost of Wall Street) the stock market is the ONLY income source. This
 *  runs the whole loop: it buys its own market access when it can afford it, then
 *  trades continuously -- long+short on 4S forecasts once affordable, long-only on
 *  an estimated (EMA) forecast before that.
 *
 *  BN8 grants WSE + TIX API access AND $250m at the start, so this trades IMMEDIATELY
 *  from the starting seed -- no casino, no manual bootstrap. It runs EMA / long-only
 *  until it can afford the 4S Market Data TIX API ($25b), then switches to accurate
 *  long+short trading. (The TIX-API self-purchase below is a fallback for OTHER nodes
 *  where -- via SF8 -- you may need to buy access; in BN8 you already have it.)
 *
 *  Optional accelerant: the casino (Aevum) can fast-forward the slow early EMA phase
 *  straight to the 4S tier, but it is NOT required -- the $250m seed is enough to start.
 *
 *  usage:  run trader.js [reserveFrac] [deployFrac]
 *          reserveFrac  fraction of net worth kept liquid (default 0.10)
 *          deployFrac   fraction of spare cash committed per tick (default 0.25)
 *
 *  Caveats: (1) before installing augmentations, sell everything -- positions are
 *  lost on reset. (2) shorting is enabled only on 4S (accurate); EMA mode is long-only
 *  because an early estimate is too noisy to short safely. (3) shorting ALSO requires
 *  short-market access -- you must be in BN8 or hold Source-File 8 Level 2. Outside BN8,
 *  SF8.1 grants WSE/TIX/4S but NOT shorting, so this runs long-only (4S) until SF8.2.
 *
 *  Must be added to pull.js. @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    ns.ui.openTail();

    const RESERVE_FRAC = Number(ns.args[0]) || 0.05;   // keep this frac of net worth liquid
    const DEPLOY_FRAC  = Number(ns.args[1]) || 0.90;   // commit this frac of spare cash per tick
    const SELL_ALL     = ns.args.includes("sellall");  // liquidate everything and exit (do this before installing augs!)

    // With an ACCURATE forecast (4S), expected log-growth per tick = (2f-1) * ln(1+av),
    // where av is proportional to volatility. So any f != 0.5 is +EV, and volatility is the
    // MULTIPLIER on that edge -- not risk to be filtered out. Hence: loose entry thresholds,
    // exit at the true break-even (0.50), and rank candidates by (2f-1)*vol, not |f-0.5|.
    const BUY_LONG   = 0.55;    // forecast >= this -> go long
    const GO_SHORT   = 0.45;    // forecast <= this -> short (4S mode only)
    const EXIT_LONG  = 0.50;    // long: exit at break-even forecast
    const EXIT_SHORT = 0.50;    // short: cover at break-even forecast
    const EMA_MIN_CONV = 0.12;  // EMA mode only: stricter entry (|f-0.5|) since the estimate is noisy
    const MAX_POS_FRAC = 0.20;  // cap any single position at this frac of net worth (diversify, cut variance)
    const HIST_LEN   = 45;      // no-4S: window of recent up/down ticks used to estimate each forecast
    const COMMISSION = 100_000; // per-transaction fee; don't open positions too small to clear it
    const TIX_COST   = 5e9;     // TIX API access
    const S4_COST    = 25e9;    // 4S Market Data TIX API access
    const BUY_BUFFER = 1.15;    // only buy access when we hold 15% more than its cost
    // Once NET WORTH clears this, stop deploying and liquidate into cash so we can actually
    // afford 4S. Without this the trader keeps ~90% of net worth in positions and its cash
    // never reaches S4_COST -- it would never buy 4S no matter how rich it got.
    const S4_SAVE_AT = S4_COST * 1.30;   // net worth at which we start saving for the 4S purchase

    // pre-4S forecast estimation: a ring buffer of recent up/down ticks per stock.
    // forecast estimate = fraction of up-ticks over the window = a stable estimate of P(up).
    const hist = {}, lastPx = {};   // hist[sym] = [0/1,...] most-recent appended

    // Short-selling access is gated separately from 4S: it requires BN8 or Source-File 8
    // Level 2. Having 4S data does NOT imply it (in BN8 it happens to coincide; elsewhere,
    // e.g. under SF8.1, you can hold 4S yet be unable to short). Probed once below.
    let canShort;

    if (SELL_ALL) {
        const syms = ns.stock.getSymbols();
        let sold = 0;
        for (const s of syms) {
            const pos = ns.stock.getPosition(s);
            if (pos[0] > 0) { ns.stock.sellStock(s, pos[0]); sold++; }
            if (pos[2] > 0) { ns.stock.sellShort(s, pos[2]); sold++; }
        }
        ns.tprint("trader: SELLALL -- liquidated " + sold + " positions. cash $" + fmt(ns.getPlayer().money)
            + ". Safe to install augmentations now (an install wipes the stock market).");
        return;
    }

    while (true) {
        // ---- provisioning: buy market access as cash allows ----
        let hasTix = false;
        try { hasTix = ns.stock.hasTixApiAccess(); } catch (e) {}
        if (!hasTix) {
            const money = ns.getPlayer().money;
            if (money >= TIX_COST * BUY_BUFFER) {
                try { if (ns.stock.purchaseTixApi()) ns.tprint("trader: bought TIX API -- scripted trading online."); } catch (e) {}
            } else {
                report(ns, "waiting for seed: need $" + fmt(TIX_COST) + " for TIX API (win it at the casino, Aevum). have $" + fmt(money));
                await ns.sleep(10000);
                continue;
            }
        }

        const symbols = ns.stock.getSymbols();

        // ---- short-access capability: probe ONCE (needs BN8 or SF8.2; 4S does not imply it) ----
        // A zero-share buyShort throws the access error if shorting is locked, and is a
        // harmless no-op if it's allowed -- so it's a side-effect-free capability test.
        if (canShort === undefined) {
            canShort = false;
            try { ns.stock.buyShort(symbols[0], 0); canShort = true; } catch (e) { canShort = false; }
            if (!canShort) ns.tprint("trader: shorting unavailable here (need BitNode-8 or Source-File 8 Level 2) -- running LONG-ONLY.");
        }

        // ---- 4S purchase: gate on NET WORTH, then liquidate into cash to afford it ----
        let use4S = false;
        try { use4S = ns.stock.has4SDataTixApi(); } catch (e) {}
        let savingFor4S = false;
        if (!use4S) {
            const nw = worth(ns, symbols);
            const cashNow = ns.getPlayer().money;
            if (cashNow >= S4_COST * BUY_BUFFER) {
                try {
                    if (ns.stock.purchase4SMarketDataTixApi()) { ns.tprint("trader: bought 4S TIX API -- accurate long+short trading online."); use4S = true; }
                } catch (e) {}
            } else if (nw >= S4_SAVE_AT) {
                // Rich enough overall, but too much is tied up in positions. Sell down to raise cash.
                savingFor4S = true;
                for (const s of symbols) {
                    const pos = ns.stock.getPosition(s);
                    if (pos[0] > 0) ns.stock.sellStock(s, pos[0]);
                    if (pos[2] > 0) ns.stock.sellShort(s, pos[2]);
                }
                report(ns, "trader: SAVING FOR 4S -- liquidating. net $" + fmt(nw) + "  cash $" + fmt(ns.getPlayer().money) + " / need $" + fmt(S4_COST * BUY_BUFFER));
                if (typeof ns.stock.nextUpdate === "function") await ns.stock.nextUpdate(); else await ns.sleep(6000);
                continue;   // don't re-deploy this tick
            }
        }

        // ---- update forecast estimates (only used before 4S) ----
        if (!use4S) {
            for (const s of symbols) {
                const p = ns.stock.getPrice(s);
                if (lastPx[s] !== undefined && p !== lastPx[s]) {   // only count real moves, not flat ticks
                    (hist[s] || (hist[s] = [])).push(p > lastPx[s] ? 1 : 0);
                    if (hist[s].length > HIST_LEN) hist[s].shift();
                }
                lastPx[s] = p;
            }
        }

        const forecastOf = (s) => {
            if (use4S) return ns.stock.getForecast(s);
            const h = hist[s];
            if (!h || h.length === 0) return 0.5;
            let up = 0; for (const v of h) up += v;
            return up / h.length;
        };
        const ready = (s) => use4S || (hist[s] && hist[s].length >= HIST_LEN);   // full window = stable estimate

        // ---- manage existing positions: exit on forecast reversal ----
        for (const s of symbols) {
            const pos = ns.stock.getPosition(s);
            const long = pos[0], short = pos[2];
            const f = forecastOf(s);
            if (long > 0 && f < EXIT_LONG)  ns.stock.sellStock(s, long);
            if (short > 0 && f > EXIT_SHORT) ns.stock.sellShort(s, short);
        }

        // ---- open positions with spare budget, best conviction first ----
        const netWorth = worth(ns, symbols);
        const reserve  = netWorth * RESERVE_FRAC;
        let budget = Math.max(0, (ns.getPlayer().money - reserve) * DEPLOY_FRAC);

        const cands = [];
        for (const s of symbols) {
            if (!ready(s)) continue;
            const f = forecastOf(s);
            if (use4S) {
                // EV rank = |2f-1| * volatility  (proportional to expected log-growth per tick).
                // NOTE: no volatility ceiling -- with a true forecast, high vol AMPLIFIES the edge.
                const vol = ns.stock.getVolatility(s);
                if (f >= BUY_LONG)                 cands.push({ s, dir: "long",  conv: (2 * f - 1) * vol });
                else if (canShort && f <= GO_SHORT) cands.push({ s, dir: "short", conv: (1 - 2 * f) * vol });
            } else {
                // EMA mode: no getVolatility (needs 4S) and the forecast is a noisy estimate,
                // so demand real conviction and stay long-only.
                if (f - 0.5 >= EMA_MIN_CONV) cands.push({ s, dir: "long", conv: f - 0.5 });
            }
        }
        cands.sort((a, b) => b.conv - a.conv);

        const posCap = netWorth * MAX_POS_FRAC;
        for (const c of cands) {
            if (budget < COMMISSION * 2) break;
            const pos = ns.stock.getPosition(c.s);
            const owned = c.dir === "long" ? pos[0] : pos[2];
            const price = c.dir === "long" ? ns.stock.getAskPrice(c.s) : ns.stock.getBidPrice(c.s);
            const room  = ns.stock.getMaxShares(c.s) - owned;
            if (room <= 0 || price <= 0) continue;
            // per-stock diversification cap: keep any single position <= posCap of net worth
            const heldVal = owned > 0 ? ns.stock.getSaleGain(c.s, owned, c.dir === "long" ? "L" : "S") : 0;
            const headroom = posCap - heldVal;
            if (headroom < COMMISSION * 10) continue;            // already at cap for this stock
            const spend = Math.min(budget, headroom);
            let shares = Math.min(room, Math.floor((spend - COMMISSION) / price));
            if (shares <= 0) continue;
            if (shares * price < COMMISSION * 10) continue;      // too small to be worth the fee
            if (c.dir === "long") ns.stock.buyStock(c.s, shares);
            else ns.stock.buyShort(c.s, shares);
            budget -= shares * price + COMMISSION;
        }

        report(ns, statusLine(ns, symbols, use4S, canShort, netWorth));

        // sleep to the next price tick (v3), with a fallback for older APIs
        if (typeof ns.stock.nextUpdate === "function") await ns.stock.nextUpdate();
        else await ns.sleep(6000);
    }
}

// net worth = liquid cash + what every open position would sell for right now
function worth(ns, symbols) {
    let w = ns.getPlayer().money;
    for (const s of symbols) {
        const pos = ns.stock.getPosition(s);
        if (pos[0] > 0) w += ns.stock.getSaleGain(s, pos[0], "L");
        if (pos[2] > 0) w += ns.stock.getSaleGain(s, pos[2], "S");
    }
    return w;
}

function statusLine(ns, symbols, use4S, canShort, netWorth) {
    let longs = 0, shorts = 0, warming = 0;
    for (const s of symbols) {
        const pos = ns.stock.getPosition(s);
        if (pos[0] > 0) longs++;
        if (pos[2] > 0) shorts++;
    }
    const mode = use4S ? (canShort ? "4S long+short" : "4S long-only") : "EMA long-only";
    return "trader [" + mode + "]  net $" + fmt(netWorth) + "  cash $" + fmt(ns.getPlayer().money)
        + "  positions " + longs + "L/" + shorts + "S";
}

function report(ns, line) { ns.clearLog(); ns.print(line); }

function fmt(n) {
    const a = Math.abs(n);
    if (a >= 1e12) return (n / 1e12).toFixed(2) + "t";
    if (a >= 1e9)  return (n / 1e9).toFixed(2)  + "b";
    if (a >= 1e6)  return (n / 1e6).toFixed(2)  + "m";
    if (a >= 1e3)  return (n / 1e3).toFixed(1)  + "k";
    return n.toFixed(0);
}
