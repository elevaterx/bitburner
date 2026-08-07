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

/** Capability-NEUTRAL base weights. hacking / hacking_exp drive a BitNode's hacking-level gate;
 *  faction_rep multiplies gang respect -> faction reputation (Gang.ts:155) and so the rep gate. Those
 *  three are the binding constraints in most nodes and carry full weight.
 *  hacking_speed and hacking_chance stay weighted even with no money farm: speed raises ops/sec and
 *  therefore XP/sec, and chance decides whether a hack pays full XP or the 25% failure tier
 *  (NetscriptHelpers.tsx:639-641). They are not money-farm-specific. Only hacking_money and
 *  hacking_grow are -- those are scaled by nodeWeights(). */
export const BASE_WEIGHTS = Object.freeze({
  hacking: 1,
  hacking_exp: 1,
  faction_rep: 1,
  hacking_speed: 0.5,
  hacking_chance: 0.5,
  hacking_money: 0.5,
  hacking_grow: 0.25,
});

/** Used when nothing is known about the node -- the neutral base. */
export const DEFAULT_WEIGHTS = BASE_WEIGHTS;

/** How much a hacking-money multiplier is actually worth here, 0..1.
 *
 *  Two independent gates, and both must pass:
 *    CAPABILITY -- what the BitNode permits. Farm income scales with
 *                  ScriptHackMoneyGain x ServerMaxMoney, which is ~0 in BN8 (gain 0) and BN9
 *                  (maxMoney 0.01), and 0.08 in BN2. Same heuristic purchaser.js uses to refuse to
 *                  buy cloud RAM in a dead-hack node (purchaser.js:96-107).
 *    ACTIVITY   -- whether anything is actually harvesting. A node can permit hacking money while
 *                  the coordinator sits stopped and harvest income reads $0/s; the multiplier then
 *                  earns nothing no matter what the node allows.
 *
 *  Deriving this beats hardcoding it: the answer changes when you enter a new BitNode or restart the
 *  money farm, and a constant would silently go stale at exactly those moments. */
export function moneyFarmWeight(hackMoneyPotential, farmRunning) {
  if (!farmRunning) return 0;
  const p = Number(hackMoneyPotential);
  if (!Number.isFinite(p) || p <= 0) return 0;
  return Math.min(1, p);
}

/** Weights for the current node + runtime state.
 *  ctx: { scriptHackMoneyGain, serverMaxMoney, moneyFarmRunning }
 *  Unknown multipliers default to 1 (vanilla), so a missing SF5 degrades to "assume the node allows
 *  it" and lets ACTIVITY carry the decision, rather than silently discarding real value. */
/** Skill bracket at a given hacking exp: calculateSkill is `mult * (32*ln(exp+534.6) - 200)`. */
export function skillBracket(hackingExp) {
  const e = Number(hackingExp);
  if (!Number.isFinite(e) || e < 0) return 0;
  return 32 * Math.log(e + 534.6) - 200;
}

/** How much an EXP-CHANNEL multiplier is worth relative to a HACKING-LEVEL multiplier.
 *
 *  level = mult_h * bracket,  bracket = 32*ln(exp+534.6) - 200. Differentiating each channel:
 *      d(level)/d(ln mult_h) = level          -- the multiplier enters LINEARLY
 *      d(level)/d(ln exp)    = mult_h * 32    -- exp enters LOGARITHMICALLY
 *  so their ratio is 32 / bracket, and an exp-side multiplier is worth that fraction of a
 *  hacking-side one of equal log magnitude.
 *
 *  This is why hacking_exp at weight 1.0 was wrong: at a realistic bracket of ~500 it overstated
 *  exp-channel augs by roughly 15x. hacking_speed and hacking_chance ride the SAME channel --
 *  speed raises exp/sec, chance decides full exp vs the 25% failure tier -- so they take the same
 *  discount rather than a flat 0.5. Returns 1 (no discount) when the bracket is unknown, so a
 *  caller that cannot supply exp is never worse off than the old fixed weights. */
export function expChannelWeight(bracket) {
  const b = Number(bracket);
  if (!Number.isFinite(b) || b <= 0) return 1;
  return Math.min(1, 32 / b);
}

/** How much a faction_rep multiplier is worth, given how scarce reputation actually is.
 *
 *  faction_rep is INSTRUMENTAL: it does not raise your hacking level, it accelerates access to the
 *  augs that do. So its value is entirely a function of whether reputation is the thing holding you
 *  back. Weighting it a flat 1.0 -- level with `hacking`, which raises the level LINEARLY -- assumes
 *  rep is always the constraint. Once a 12-member gang is running that is badly false: gang respect
 *  converts to gang-faction rep at `faction_rep * respectGain * favorMult / 75` (Gang.ts:152-155),
 *  which for a mature gang is thousands of rep per second, unbounded and free.
 *
 *  Observed cost of getting this wrong: a live round bought ADR-V1, ADR-V2 and The Shadow's
 *  Simulacrum -- three augs with ZERO hacking contribution -- for 37% of the round's value. Sitting
 *  at slots 4, 5 and 7 they also pushed every cheaper hacking aug up the 1.9^n curve, so the round
 *  cost $175.28b instead of $89.60b for the identical 1.975x hacking multiplier. $86b for nothing.
 *
 *  Model: how many HOURS of your existing rep income would it take to close the gap by itself? If
 *  that is short, buying a rep multiplier is pointless. Scales linearly up to the base weight.
 *  With no rep engine (rate 0 or unknown) it returns `base` -- rep genuinely IS the constraint then,
 *  so a caller that cannot measure is never worse off than the old fixed weight. */
export function repWeight(ctx = {}, base = 1) {
  const rate = Number(ctx.repPerSec);
  if (!Number.isFinite(rate) || rate <= 0) return base;   // no engine -> rep is the constraint
  const need = Number(ctx.repShortfall);
  if (!Number.isFinite(need) || need <= 0) return 0;       // nothing is rep-gated -> worthless
  const horizonH = Number(ctx.repHorizonHours) > 0 ? Number(ctx.repHorizonHours) : 4;
  const hours = need / rate / 3600;
  return base * Math.min(1, hours / horizonH);
}

/** The channels that actually raise your hacking level or its income. faction_rep is NOT here --
 *  it is instrumental, and letting it count would make the rep-shortfall calculation circular
 *  (a pure-rep aug would justify buying pure-rep augs). */
export const HACK_CHANNELS = Object.freeze([
  "hacking", "hacking_exp", "hacking_speed", "hacking_chance", "hacking_money", "hacking_grow",
]);

/** Does this aug do anything besides raise reputation? */
export function hasHackingValue(stats) {
  if (!stats) return false;
  for (const k of HACK_CHANNELS) if (Number(stats[k]) > 1) return true;
  return false;
}

/** Reputation per second earned by a running gang, from gang-data.txt + the faction's favor.
 *  Gang.ts:152-155:  playerReputation += mults.faction_rep * respectGainsTotal * favorMult / 75,
 *  favorMult = 1 + favor/100. hud1 prints the same number; this is the shared derivation.
 *  Returns 0 for anything it cannot compute, which is the "no engine" signal repWeight wants. */
export function gangRepPerSec(g, favor = 0) {
  // `g = {}` as a default would NOT cover this: a default parameter fires only on `undefined`, and
  // the caller's shape here is `JSON.parse(ns.read(...)) || null` -- null reaches the body and a
  // property read throws. The point of this function is to return 0 for anything unusable.
  if (!g || typeof g !== "object") return 0;
  const m = Number(g.factionRepMult), r = Number(g.respectPerSec), f = Number(favor);
  if (!Number.isFinite(m) || m <= 0 || !Number.isFinite(r) || r <= 0) return 0;
  const fav = Number.isFinite(f) && f > 0 ? f : 0;
  return (m * r * (1 + fav / 100)) / 75;
}

/** The largest reputation gap still standing between you and an aug worth having, i.e. how much rep
 *  you would have to earn before NOTHING you want is rep-gated. That is the quantity repWeight
 *  divides by your rep income.
 *
 *  cands: [{ repReq, rep, stats }] where `rep` is your rep at the faction you would buy that aug
 *  FROM -- the highest-rep faction offering it. Pure-rep augs are excluded (see hasHackingValue).
 *
 *  KNOWN APPROXIMATION. The income side is the gang's, but `rep` may come from some other faction
 *  with more rep and no income. Because a gang faction sells the entire augmentation table
 *  (FactionHelpers.tsx:172-176) the gang is always among the offering factions, so `rep` is never
 *  BELOW gang rep -- meaning this can understate the time to close a gap, never overstate it. It
 *  therefore errs toward calling rep cheap, which is the direction the live evidence pointed. */
export function maxRepGap(cands) {
  let max = 0;
  for (const c of cands || []) {
    if (!c || !hasHackingValue(c.stats)) continue;
    const gap = Number(c.repReq) - Number(c.rep);
    if (Number.isFinite(gap) && gap > max) max = gap;
  }
  return max;
}

export function nodeWeights(ctx = {}, base = BASE_WEIGHTS) {
  const gain = Number.isFinite(Number(ctx.scriptHackMoneyGain)) ? Number(ctx.scriptHackMoneyGain) : 1;
  const maxMoney = Number.isFinite(Number(ctx.serverMaxMoney)) ? Number(ctx.serverMaxMoney) : 1;
  const w = moneyFarmWeight(gain * maxMoney, !!ctx.moneyFarmRunning);
  const x = ctx.hackingExp === undefined ? 1 : expChannelWeight(skillBracket(ctx.hackingExp));
  return Object.freeze({
    ...base,
    hacking_exp: base.hacking_exp * x,
    hacking_speed: base.hacking_speed * x,
    hacking_chance: base.hacking_chance * x,
    hacking_money: base.hacking_money * w,
    hacking_grow: base.hacking_grow * w,
    faction_rep: repWeight(ctx, base.faction_rep),
  });
}

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

  // priceScale = the escalation ALREADY standing before this round begins. Every non-SoA aug bought
  // but not installed multiplies the next price by 1.9, and that carries ACROSS separate augbuy runs
  // -- a fresh run is not a fresh round. With 8 queued the board sits at 1.9^8 = 169.8x, so pricing a
  // basket from exponent 0 understates it by that factor and the greedy "affords" what it cannot buy.
  // It scales every candidate uniformly, so it is applied once to the budget here rather than
  // threaded through roundCost.
  const scale = Number.isFinite(opts.priceScale) && opts.priceScale > 0 ? opts.priceScale : 1;
  const effBudget = budget / scale;

  // PASS 1 -- fill to budget, best density first.
  let chosen = [];
  for (const c of ranked) {
    if (roundCost([...chosen.map((x) => x.base), c.base], mult) <= effBudget) chosen.push(c);
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

/** Per-slot economics for a chosen basket -- the diagnostic that makes a bad round visible without
 *  having to trust the selector.
 *
 *  Two cost columns, and they disagree, which is the point:
 *    paid     -- this aug's own price at its slot: base * mult^slot * priceScale.
 *    marginal -- what DROPPING this aug would actually save. Higher than `paid` for every aug except
 *                the cheapest, because removing an aug also moves every cheaper aug UP a slot. The
 *                two columns can even rank the basket differently: by `paid` the cheap augs at the
 *                bottom look worst, by `marginal` they are usually the best buys in the round.
 *  `marginal / value` is the honest "should this be here" number. `paid / value` is what the cutoff
 *  currently prunes on, which is exact only for the last slot.
 *
 *  basket: [{ aug, base, value }] in any order. Returns purchase order (base descending). Pure. */
export function roundEconomics(basket, opts = {}) {
  const mult = opts.mult || AUG_PRICE_MULT;
  const scale = Number.isFinite(opts.priceScale) && opts.priceScale > 0 ? opts.priceScale : 1;
  const items = [...(basket || [])]
    .filter((c) => c && Number.isFinite(Number(c.base)))
    .sort((a, b) => (b.base - a.base) || String(a.aug).localeCompare(String(b.aug)));
  const bases = items.map((c) => Number(c.base));
  const total = roundCost(bases, mult) * scale;

  return items.map((c, i) => {
    const paid = Number(c.base) * Math.pow(mult, i) * scale;
    const without = roundCost(bases.filter((_, j) => j !== i), mult) * scale;
    const marginal = total - without;
    const v = Number(c.value) > 0 ? Number(c.value) : 0;
    return {
      aug: c.aug, slot: i, base: Number(c.base), value: v, paid, marginal,
      escalation: Math.pow(mult, i) * scale,
      perValue: v > 0 ? paid / v : Infinity,
      marginalPerValue: v > 0 ? marginal / v : Infinity,
    };
  });
}
