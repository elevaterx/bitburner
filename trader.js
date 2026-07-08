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
 *  because an early estimate is too noisy to short safely.
 *
 *  Must be added to pull.js. @param {NS} ns */
export async function main(ns) {
    ns.disableLog("ALL");
    ns.ui.openTail();

    const RESERVE_FRAC = Number(ns.args[0]) || 0.10;   // keep this frac of net worth liquid
    const DEPLOY_FRAC  = Number(ns.args[1]) || 0.25;   // commit this frac of spare cash per tick

    const BUY_LONG   = 0.62;    // forecast >= this -> go long (raised: fewer, stronger signals)
    const GO_SHORT   = 0.38;    // forecast <= this -> short (4S mode only)
    const EXIT_LONG  = 0.47;    // long: sell only when clearly bearish (wide hold band cuts churn)
    const EXIT_SHORT = 0.53;    // short: cover only when clearly bullish
    const MAX_VOL    = 0.05;    // 4S mode: skip stocks more volatile than this
    const MAX_POS_FRAC = 0.20;  // cap any single position at this frac of net worth (diversify, cut variance)
    const HIST_LEN   = 45;      // no-4S: window of recent up/down ticks used to estimate each forecast
    const COMMISSION = 100_000; // per-transaction fee; don't open positions too small to clear it
    const TIX_COST   = 5e9;     // TIX API access
    const S4_COST    = 25e9;    // 4S Market Data TIX API access
    const BUY_BUFFER = 1.15;    // only buy access when we hold 15% more than its cost

    // pre-4S forecast estimation: a ring buffer of recent up/down ticks per stock.
    // forecast estimate = fraction of up-ticks over the window = a stable estimate of P(up).
    const hist = {}, lastPx = {};   // hist[sym] = [0/1,...] most-recent appended

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

        let use4S = false;
        try { use4S = ns.stock.has4SDataTixApi(); } catch (e) {}
        if (!use4S) {
            const money = ns.getPlayer().money;
            if (money >= S4_COST * BUY_BUFFER) {
                try { if (ns.stock.purchase4SMarketDataTixApi()) { ns.tprint("trader: bought 4S TIX API -- accurate long+short trading online."); use4S = true; } } catch (e) {}
            }
        }

        const symbols = ns.stock.getSymbols();

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
            if (use4S && ns.stock.getVolatility(s) > MAX_VOL) continue;   // vol filter only in 4S mode
            if (f >= BUY_LONG) cands.push({ s, dir: "long", conv: f - 0.5 });
            else if (use4S && f <= GO_SHORT) cands.push({ s, dir: "short", conv: 0.5 - f });  // shorts: 4S only
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

        report(ns, statusLine(ns, symbols, use4S, netWorth));

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

function statusLine(ns, symbols, use4S, netWorth) {
    let longs = 0, shorts = 0, warming = 0;
    for (const s of symbols) {
        const pos = ns.stock.getPosition(s);
        if (pos[0] > 0) longs++;
        if (pos[2] > 0) shorts++;
    }
    const mode = use4S ? "4S long+short" : "EMA long-only";
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
