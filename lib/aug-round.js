/** lib/aug-round.js -- the whole round decision as ONE pure function.
 *
 *  WHY THIS FILE EXISTS. augbuy shipped four defects in a row that only a live dry run caught:
 *  a regression that crowded the three best augs out of the basket, a threshold reported 5x wrong,
 *  an exit-gate line that silently never printed, and two markers that degenerated into flagging
 *  every row. Each cost a round trip through the game because the decision logic lived inside
 *  augbuy.js, tangled with `ns`, and could not be run anywhere else. The unit tests did not catch
 *  them because the tests and the code encode the same model -- augbuy's own header has said so all
 *  along, and the fix is not "write better tests", it is "make the real thing runnable offline".
 *
 *  So: everything from "here are the candidates" to "here is the basket and the NFG tail" is here,
 *  pure and ns-free. augbuy calls it; tools/augbuy-replay.mjs calls it against a board dumped from
 *  the live game (augbuy --dump). Both run the SAME code, so a replay is evidence about augbuy and
 *  not about a reimplementation that drifted.
 */
import { selectRound, orderedCost } from "./aug-plan.js";

/** NFG price ladder. Cost of a level is base * 1.14^level * nodeMult * 1.9^queued, and buying one
 *  increments BOTH exponents -- so each successive level costs 1.14 * 1.9 = 2.166x the last.
 *  `price0` is the live price of the NEXT level with nothing extra queued (ns.getAugmentationPrice
 *  already folds in 1.14^level and the node multiplier).
 *  Returns the levels `cash` buys and the per-value price of the first level it does NOT. */
export const NFG_LADDER_STEP = 1.14 * 1.9;

export function nfgLadder(price0, valuePerLevel, queued, cash) {
  if (!(price0 > 0) || !(valuePerLevel > 0)) return { levels: 0, spent: 0, marginal: Infinity, prices: [] };
  let price = price0 * Math.pow(1.9, Math.max(0, queued));
  let left = Math.max(0, cash), levels = 0, spent = 0;
  const prices = [];
  while (levels < 200 && left >= price) {
    left -= price; spent += price; prices.push(price); levels++;
    price *= NFG_LADDER_STEP;
  }
  return { levels, spent, marginal: price / valuePerLevel, prices };
}

/** Total value of a round: the augs plus whatever NFG the leftover buys. This is THE objective --
 *  augs and NFG compete for one pot of money that the install is about to destroy, so the only
 *  question is which mix buys the most multiplier. */
export function roundScore(sel, budget, nfg, priceScale = 1) {
  const cost = orderedCost(sel) * priceScale;
  const lad = nfgLadder(nfg.price0, nfg.valuePerLevel, sel.length, budget - cost);
  const augs = sel.reduce((a, c) => a + (Number(c.value) || 0), 0);
  return { total: augs + lad.levels * nfg.valuePerLevel, augs, nfg: lad, cost };
}

/** Pick the basket. Scores candidate baskets on roundScore and returns the best.
 *
 *  Candidates come from thresholds fed to selectRound. Iterating the threshold only ever visits its
 *  own fixed points, which sit at the extremes -- the seed basket's rate is huge (a small basket
 *  leaves lots of cash AND a shallow 1.9^queued exponent, so the marginal NFG level lands far up the
 *  ladder) and prunes nothing, while the full basket's rate is tight enough to prune almost
 *  everything. The optimum is usually between them. Worse, the map OSCILLATES -- 16 augs -> $105.6t
 *  -> 17 augs -> $120.4t -> 16 -- so there is no fixed point to converge to and scoring is the only
 *  way to choose. The geometric sweep covers the middle; the relative-cutoff basket is always a
 *  candidate, so this can never do worse than the old rule.
 *
 *  A threshold can only express "drop everything above X", so most subsets are unreachable. That is
 *  a known limit, not an oversight: single-drop testing on the live board found no improvement over
 *  the swept optimum, and a full subset search is exponential. */
export function planRound(cands, budget, opts = {}) {
  const base = {
    valueCutoff: opts.valueCutoff,
    priceScale: opts.priceScale || 1,
    held: opts.held instanceof Set ? opts.held : new Set(),
  };
  const nfg = opts.nfg && opts.nfg.price0 > 0 && opts.nfg.valuePerLevel > 0 ? opts.nfg : null;
  const scale = base.priceScale;

  if (!nfg) {
    const sel = selectRound(cands, budget, base);
    return { list: sel, threshold: null, score: null, tried: 1 };
  }

  const score = (sel) => roundScore(sel, budget, nfg, scale).total;
  let cur = selectRound(cands, budget, base);
  let best = { sel: cur, score: score(cur), rate: null };
  const rates = new Set();
  for (let it = 0; it < 4; it++) {
    const r = nfgLadder(nfg.price0, nfg.valuePerLevel, cur.length, budget - orderedCost(cur) * scale).marginal;
    if (!(r > 0) || !Number.isFinite(r)) break;
    rates.add(r);
    const nx = selectRound(cands, budget, { ...base, altPricePerValue: r / scale });
    if (nx.length === cur.length) break;
    cur = nx;
  }
  const rs = [...rates].filter((x) => x > 0 && Number.isFinite(x));
  if (rs.length) {
    const hi = Math.max(...rs), lo = Math.min(...rs) / 100;
    const steps = Number.isFinite(opts.sweep) ? opts.sweep : 12;
    for (let i = 0; i <= steps; i++) rates.add(lo * Math.pow(hi / lo, i / steps));
  }
  let tried = 1;
  for (const r of rates) {
    const sel = selectRound(cands, budget, { ...base, altPricePerValue: r / scale });
    tried++;
    const sc = score(sel);
    if (sc > best.score) best = { sel, score: sc, rate: r };
  }
  return { list: best.sel, threshold: best.rate, score: best.score, tried };
}

/** Would removing this aug (and anything depending on it) raise total round value? Exact, and the
 *  only honest form of the "is this aug pulling its weight" question -- every ratio proxy tried so
 *  far degenerated into flagging every row. Dropping an aug also frees a QUEUE SLOT, cutting every
 *  NFG level by 1.9x, while the money it frees is lumpy against a ladder climbing 2.166x a step, so
 *  "costs more per value than NFG" does not imply "should go". */
export function dropImproves(list, aug, budget, nfg, priceScale = 1) {
  if (!nfg) return false;
  const names = new Set(list.map((c) => c.aug));
  const doomed = new Set([aug]);
  for (;;) {
    const n = doomed.size;
    for (const c of list) if ((c.prereqs || []).some((q) => doomed.has(q) && names.has(q))) doomed.add(c.aug);
    if (doomed.size === n) break;
  }
  const without = list.filter((c) => !doomed.has(c.aug));
  return roundScore(without, budget, nfg, priceScale).total > roundScore(list, budget, nfg, priceScale).total + 1e-9;
}
