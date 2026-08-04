/** lib/aug-plan.js -- pure planning logic for an augmentation buying round.
 *
 *  THE PROBLEM, AND THE MISTAKE THAT PRECEDED IT.
 *  Every non-SoA aug you QUEUE multiplies the money price of the next by
 *  CONSTANTS.MultipleAugMultiplier = 1.9 (AugmentationHelpers.ts:29-36), so the i-th purchase in a
 *  round costs base_i * 1.9^i. Two separate decisions fall out of that, and conflating them is the
 *  trap:
 *
 *    ORDERING  -- given a FIXED basket, what order is cheapest? Base cost DESCENDING, so the
 *                 largest base pairs with the smallest exponent (rearrangement inequality).
 *    SELECTION -- given a budget, WHICH augs belong in the basket? Must be driven by VALUE.
 *
 *  augbuy.js first sorted by repReq ascending -- wrong ordering. Changing it to cost-descending
 *  fixed the ordering and BROKE the selection, because the greedy then chose the basket by the same
 *  key and spent the entire budget on the most expensive augs on offer. Measured on a live $7.21b
 *  round: cost-descending bought 4 augs (Neuralstimulator, PCMatrix, ASP, ADR-V1) yielding
 *  hacking_exp 1.176 / faction_rep 1.188 and no hacking-level multiplier at all -- because PCMatrix
 *  costs $2b for faction_rep 1.08 while S.N.A costs $30m for 1.15. Value-density selection on the
 *  same budget takes EIGHT augs for $7.04b at hacking_exp 1.509, faction_rep 1.746, hacking 1.08.
 *  Expensive is not the same as valuable.
 *
 *  So: SELECT by value per dollar, then ORDER the winners by base cost descending.
 *  Pure functions only -- no `ns`. Unit-tested in tests/aug-plan.test.mjs.
 */

/** Price escalation per queued non-SoA aug (CONSTANTS.MultipleAugMultiplier). */
export const AUG_PRICE_MULT = 1.9;

/** Relative worth of each multiplier. hacking / hacking_exp drive the BitNode's hacking-level gate;
 *  faction_rep multiplies gang respect -> faction reputation (Gang.ts:155) and so the rep gate.
 *  Those three are the binding constraints and carry full weight; the rest are real but secondary. */
export const DEFAULT_WEIGHTS = Object.freeze({
  hacking: 1,
  hacking_exp: 1,
  faction_rep: 1,
  hacking_speed: 0.5,
  hacking_money: 0.5,
  hacking_chance: 0.5,
  hacking_grow: 0.25,
});

/** Weighted LOG value of an aug's multipliers. Log because multipliers COMPOUND: two augs at 1.1
 *  are worth one at 1.21, and only a log makes that additive so baskets can be compared by summing.
 *  Multipliers <= 1 contribute nothing. */
export function augValue(stats, weights = DEFAULT_WEIGHTS) {
  if (!stats) return 0;
  let v = 0;
  for (const key of Object.keys(weights)) {
    const m = Number(stats[key]);
    if (Number.isFinite(m) && m > 1) v += weights[key] * Math.log(m);
  }
  return v;
}

/** Value per dollar of BASE cost. Base 0 with real value (e.g. The Red Pill) is infinite density. */
export function valueDensity(value, base) {
  const b = Number(base);
  if (!(b > 0)) return value > 0 ? Infinity : 0;
  return value / b;
}

/** Total money for a basket, priced in its own cheapest order (base desc). */
export function roundCost(bases, mult = AUG_PRICE_MULT) {
  const sorted = [...bases].map(Number).filter(Number.isFinite).sort((a, b) => b - a);
  let total = 0;
  for (let i = 0; i < sorted.length; i++) total += sorted[i] * Math.pow(mult, i);
  return total;
}

/** Default marginal cutoff: reject an aug whose REALIZED cost per unit value is worse than this
 *  multiple of the round's best buy. See selectRound. */
export const DEFAULT_VALUE_CUTOFF = 10;

/** Choose this round's basket.
 *  cands: [{ aug, base, value, ... }] -- already filtered to ones you hold the REP for.
 *  Greedy by value-density, best first, keeping a candidate only if the WHOLE resulting basket
 *  (priced in its optimal order) still fits. The fit is re-checked against the full basket every
 *  time rather than against a running total, because adding one aug pushes every cheaper aug in the
 *  basket up an exponent -- a running total would silently understate the cost.
 *  Returns the basket in PURCHASE order: base cost descending. */
export function selectRound(cands, money, opts = {}) {
  const mult = opts.mult || AUG_PRICE_MULT;
  const budget = Number(money);
  if (!Number.isFinite(budget) || budget <= 0) return [];

  const ranked = [...(cands || [])]
    .filter((c) => c && Number.isFinite(Number(c.base)) && Number(c.base) >= 0)
    .map((c) => ({ ...c, density: valueDensity(Number(c.value) || 0, c.base) }))
    .filter((c) => c.density > 0)
    .sort((a, b) => (b.density - a.density) || (a.base - b.base) || String(a.aug).localeCompare(String(b.aug)));

  const cutoff = Number.isFinite(opts.valueCutoff) ? opts.valueCutoff : DEFAULT_VALUE_CUTOFF;

  // PASS 1 -- fill to budget, best density first.
  let chosen = [];
  for (const c of ranked) {
    if (roundCost([...chosen.map((x) => x.base), c.base], mult) <= budget) chosen.push(c);
  }

  // PASS 2 -- prune the tail. Ranking is on value / BASE, but you PAY base * mult^slot, and because
  // the basket is bought base-descending a cheap high-density aug lands in a LATE slot where its
  // realized price is enormous. Live example: Synaptic Enhancement Implant has the best base density
  // in the round ($7.5m for hacking_speed 1.03) yet ends at slot 7 costing $670m for a log-value of
  // 0.015 -- $45.4b per unit value against $3.0b for the round's best buy. Deferring it to slot 0 of
  // the next round costs $7.5m instead.
  //
  // This MUST be judged on the final ordering, not at insertion time: every aug added above a
  // candidate pushes it down another slot, so a candidate that looks fine when it joins can end up
  // far down the curve. Hence a repeated drop-the-worst pass rather than a check inside pass 1.
  for (;;) {
    if (chosen.length < 2) break;
    const ordered = [...chosen].sort((a, b) => (b.base - a.base) || String(a.aug).localeCompare(String(b.aug)));
    const perValue = ordered.map((c, i) =>
      c.value > 0 ? (c.base * Math.pow(mult, i)) / c.value : Infinity);
    const best = Math.min(...perValue);
    let worst = -Infinity, worstIdx = -1;
    for (let i = 0; i < perValue.length; i++) {
      if (perValue[i] > worst) { worst = perValue[i]; worstIdx = i; }
    }
    if (!(worst > best * cutoff)) break;
    chosen = ordered.filter((_, i) => i !== worstIdx);
  }

  return chosen.sort((a, b) => (b.base - a.base) || String(a.aug).localeCompare(String(b.aug)));
}
