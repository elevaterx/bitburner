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

// ---------------------------------------------------------------- prerequisite chains
//
// A QUEUED prerequisite satisfies the purchase gate. hasAugmentationPrereqs (FactionHelpers.tsx:56)
// calls Player.hasAugmentation(name) with ignoreQueued defaulting to FALSE (Person.ts:233-241), and
// the game's own refusal string reads "You must first purchase or install ...". So an entire chain
// -- Embedded Netburner Module -> Core -> Core V2 -> Core V3 -- is buyable in ONE round.
//
// augbuy previously required prereqs to be INSTALLED, which with zero installs silently discarded
// every chained aug on the board: the ENM Core line, Cranial Signal Processors Gen II-V, and every
// Graphene upgrade. They never appeared as candidates, so they never appeared as blocked either.
//
// Two consequences, and both have to be modelled or the fix makes things worse:
//   SELECTION -- a dependent is not worth its own price. It is worth its price PLUS every prereq you
//                do not already hold, and its value likewise includes theirs. Ranking it on its own
//                density would buy an upgrade whose chain you cannot afford.
//   ORDERING  -- base-descending is no longer free to choose. A prereq is almost always CHEAPER than
//                the upgrade that needs it, so the unconstrained optimum (expensive first) is exactly
//                the order the game forbids. The constraint costs real money and the estimate has to
//                show it rather than quietly pricing an impossible order.

/** Transitive prereq closure of `aug` restricted to things not already held.
 *  `held` is a Set of aug names you have installed or already queued. `byName` maps name -> cand. */
export function prereqClosure(aug, byName, held, seen = new Set()) {
  const out = [];
  const c = byName.get(aug);
  if (!c) return out;
  for (const req of c.prereqs || []) {
    if (held && held.has(req)) continue;
    if (seen.has(req)) continue;
    seen.add(req);
    out.push(...prereqClosure(req, byName, held, seen));
    if (byName.has(req)) out.push(req);
  }
  return out;
}

/** Order a basket for purchase: base cost DESCENDING, except that a prereq must precede everything
 *  that depends on it. Greedy -- at each slot take the highest-base candidate whose prereqs are all
 *  already placed. Not provably optimal for arbitrary precedence graphs (that is Sidney decomposition
 *  territory), but aug chains are 2-5 long and the greedy is exact on a chain.
 *
 *  Anything whose prereqs are missing from the basket entirely is dropped -- it cannot be bought, and
 *  leaving it in would price a round the game will refuse. */
export function orderWithPrereqs(basket) {
  const items = [...(basket || [])].filter((c) => c && Number.isFinite(Number(c.base)));
  const names = new Set(items.map((c) => c.aug));
  const placed = new Set();
  const out = [];
  let pool = items.slice();
  for (;;) {
    const ready = pool.filter((c) => (c.prereqs || []).every((r) => !names.has(r) || placed.has(r)));
    if (!ready.length) break;
    ready.sort((a, b) => (b.base - a.base) || String(a.aug).localeCompare(String(b.aug)));
    const pick = ready[0];
    out.push(pick);
    placed.add(pick.aug);
    pool = pool.filter((c) => c !== pick);
  }
  return out;
}

/** Cost of a basket priced in a GIVEN order -- purchase i pays base_i * mult^i. Use this whenever
 *  precedence constrains the order; roundCost() sorts internally and would price an illegal one. */
export function orderedCost(ordered, mult = AUG_PRICE_MULT) {
  let total = 0;
  const list = [...(ordered || [])];
  for (let i = 0; i < list.length; i++) {
    const b = Number(list[i] && list[i].base !== undefined ? list[i].base : list[i]);
    if (Number.isFinite(b)) total += b * Math.pow(mult, i);
  }
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

  // Infinity is a LEGITIMATE cutoff meaning "prune nothing", and Number.isFinite(Infinity) is false --
  // so the obvious guard silently swallowed the one value a caller would reach for to disable this,
  // handing back the default 10 instead. Accept any positive number, Infinity included.
  const cutoff = typeof opts.valueCutoff === "number" && opts.valueCutoff > 0 && !Number.isNaN(opts.valueCutoff)
    ? opts.valueCutoff : DEFAULT_VALUE_CUTOFF;

  // priceScale = the escalation ALREADY standing before this round begins. Every non-SoA aug bought
  // but not installed multiplies the next price by 1.9, and that carries ACROSS separate augbuy runs
  // -- a fresh run is not a fresh round. With 8 queued the board sits at 1.9^8 = 169.8x, so pricing a
  // basket from exponent 0 understates it by that factor and the greedy "affords" what it cannot buy.
  // It scales every candidate uniformly, so it is applied once to the budget here rather than
  // threaded through roundCost.
  const scale = Number.isFinite(opts.priceScale) && opts.priceScale > 0 ? opts.priceScale : 1;
  const effBudget = budget / scale;

  // PASS 1 -- fill to budget, best density first.
  //
  // "Best density" is BUNDLE density: a candidate carries its unheld prereq closure with it, and is
  // ranked on the value and cost of the whole chain. Ranking an upgrade on its own numbers would
  // float it to the top on the strength of multipliers whose entry fee is three augs down the chain.
  //
  // The closure is measured against `held` only, not against what pass 1 has already chosen, so a
  // chain whose prereq is picked up by an earlier bundle stays ranked at its full standalone cost.
  // That UNDER-rates it -- conservative, and it keeps this a single stable pass whose behaviour is
  // identical to the pre-chain version whenever nothing has prereqs.
  const held = opts.held instanceof Set ? opts.held : new Set();

  // Drop anything whose chain cannot actually be completed: a prereq that is neither already held nor
  // present in this candidate list (rep-gated, too expensive, wrong faction) makes its dependent
  // unbuyable, and so on up the chain. Iterated to a fixed point because removing a link can orphan
  // the next one. Without this the basket prices augs the game will refuse at the till.
  let pool = ranked;
  for (;;) {
    const present = new Set(pool.map((c) => c.aug));
    const next = pool.filter((c) => (c.prereqs || []).every((r) => held.has(r) || present.has(r)));
    if (next.length === pool.length) break;
    pool = next;
  }
  const byName = new Map(pool.map((c) => [c.aug, c]));
  const bundleOf = (c) => [...prereqClosure(c.aug, byName, held).map((n) => byName.get(n)).filter(Boolean), c];
  const bundled = pool
    .map((c) => {
      const b = bundleOf(c);
      const cost = b.reduce((a, x) => a + Number(x.base), 0);
      const val = b.reduce((a, x) => a + (Number(x.value) || 0), 0);
      return { c, bundle: b, density: cost > 0 ? val / cost : (val > 0 ? Infinity : 0) };
    })
    .filter((r) => r.density > 0)
    .sort((a, b) => (b.density - a.density) || (a.c.base - b.c.base) || String(a.c.aug).localeCompare(String(b.c.aug)));

  const fits = (list) => orderedCost(orderWithPrereqs(list), mult) <= effBudget;
  const valOf = (list) => list.reduce((a, c) => a + (Number(c.value) || 0), 0);
  // Augs that something else in `list` depends on -- never droppable on their own.
  const neededIn = (list) => {
    const names = new Set(list.map((c) => c.aug));
    const need = new Set();
    for (const c of list) for (const r of c.prereqs || []) if (names.has(r)) need.add(r);
    return need;
  };

  // PASS 1 -- SEED. Density-greedy: best value-per-base first, keeping anything that still fits.
  let chosen = [];
  const inBasket = new Set();
  for (const r of bundled) {
    const add = r.bundle.filter((x) => !inBasket.has(x.aug));
    if (!add.length) continue;
    const trial = [...chosen, ...add];
    if (fits(trial)) {
      chosen = trial;
      for (const x of add) inBasket.add(x.aug);
    }
  }

  // PASS 2 -- REPAIR. Pass 1 alone is pathological once the candidate list gets long, and this was
  // NOT theoretical: a live round lost SPTN-97 (0.140), Xanipher (0.195) and Artificial Bio-neural
  // Network Implant (0.115) -- the three most valuable augs on the board -- and the basket fell from
  // 1.051 to 0.622 of value. Reproduced offline: with twelve extra cheap candidates it collapses to a
  // SINGLE aug worth 0.049.
  //
  // The mechanism is that density means value per BASE, so cheap augs rank first and get admitted
  // first -- and every admission pushes the whole basket up a slot, multiplying its cost by 1.9. By
  // the time an expensive high-value aug is considered, adding it would blow the budget, so it is
  // refused. It is never reconsidered, even after the tail prune frees the room back up. Greedy
  // ordering makes an irreversible commitment on a constraint that later steps relax.
  //
  // So: hill-climb on the actual objective (total value, subject to the budget) instead of trusting
  // one pass of a proxy. Additions first because they are free wins; then value-improving swaps,
  // taking the best swap per sweep rather than the first, so the result does not depend on candidate
  // order. Bounded because the search is a heuristic, not a solver -- each sweep strictly increases
  // total value, so the bound is a safety net rather than a real limit.
  for (let sweep = 0; sweep < 60; sweep++) {
    let improved = false;
    const has = new Set(chosen.map((c) => c.aug));

    for (const r of bundled) {
      const add = r.bundle.filter((x) => !has.has(x.aug));
      if (!add.length) continue;
      const trial = [...chosen, ...add];
      if (fits(trial)) {
        chosen = trial;
        for (const x of add) has.add(x.aug);
        improved = true;
      }
    }
    if (improved) continue;

    let best = null;
    for (const r of bundled) {
      const add = r.bundle.filter((x) => !has.has(x.aug));
      if (!add.length) continue;
      let trial = [...chosen, ...add];
      // Evict lowest-value first, skipping anything the basket still depends on.
      for (const y of [...chosen].sort((a, b) => (Number(a.value) || 0) - (Number(b.value) || 0))) {
        if (fits(trial)) break;
        if (neededIn(trial).has(y.aug)) continue;
        trial = trial.filter((c) => c.aug !== y.aug);
      }
      if (!fits(trial)) continue;
      const gain = valOf(trial) - valOf(chosen);
      if (gain > 1e-12 && (!best || gain > best.gain)) best = { trial, gain };
    }
    if (best) { chosen = best.trial; improved = true; }
    if (!improved) break;
  }

  // PASS 3 -- TAIL PRUNE. Ranking is on value / BASE, but you PAY base * mult^slot, and because the
  // basket is bought base-descending a cheap high-density aug lands in a LATE slot where its realized
  // price is enormous. Live example: Synaptic Enhancement Implant has the best base density in the
  // round ($7.5m for hacking_speed 1.03) yet ends at slot 7 costing $670m for a log-value of 0.015 --
  // $45.4b per unit value against $3.0b for the round's best buy. Deferring it to slot 0 of the next
  // round costs $7.5m instead.
  //
  // THE ANCHOR IS FROZEN. Recomputing `best` against the shrinking basket each iteration is a
  // ratchet: dropping an aug moves every cheaper one to a lower slot, which cuts its realized price,
  // which lowers `best`, which tightens the threshold, which drops another. That feedback loop is
  // what ate the basket down to one aug in the reproduction above. The comparison point is a property
  // of the round as selected, so it is measured once and held.
  // WHAT THE THRESHOLD SHOULD ACTUALLY BE.
  // The question for the last aug in a round is never "is it good value relative to the best aug
  // here" -- it is "would these dollars buy more somewhere else". A RELATIVE cutoff answers the wrong
  // question and answers it unstably, because the comparison point moves as the basket shrinks.
  //
  // And under the real end-of-round policy there IS a well-defined alternative: NeuroFlux Governor.
  // Installing sets Player.money = 1000 (PlayerObjectGeneralMethods.ts:102), so every dollar not
  // spent on augs this round is spent on NFG or destroyed. That makes the marginal NFG level an
  // absolute, measurable price of value in dollars -- pass it as `altPricePerValue` and an aug is
  // kept exactly when it beats it. Measured on the live board: uncapped selection yields 1.482 of
  // value for $14.04t, while the relative cutoff yields 0.897 and "saves" $15.28t that the install
  // then burns; routing that money through NFG instead recovers only 0.166. 1.506 against 1.063.
  //
  // `marginal`, not `paid`: dropping an aug frees what the WHOLE basket then stops costing (every
  // cheaper aug moves up a slot), and that is the money the alternative actually gets.
  //
  // With no alternative supplied this falls back to the relative cutoff, with the anchor FROZEN.
  // Recomputing it against the shrinking basket is a ratchet -- dropping an aug moves cheaper ones to
  // lower slots, cutting their realized price, lowering the anchor, tightening the threshold, and
  // dropping another. That loop ate a live basket down to a single aug.
  const alt = Number(opts.altPricePerValue);
  const useAlt = Number.isFinite(alt) && alt > 0;
  const anchorOrder = orderWithPrereqs(chosen);
  const anchor = Math.min(...anchorOrder.map((c, i) =>
    c.value > 0 ? (c.base * Math.pow(mult, i)) / c.value : Infinity));
  const limit = useAlt ? alt : anchor * cutoff;

  for (;;) {
    if (chosen.length < 2) break;
    const ordered = orderWithPrereqs(chosen);
    const total = orderedCost(ordered, mult);
    // Never orphan a dependent: removing a prereq would leave a purchase the game refuses outright.
    // Skip to the next-worst instead -- if the chain is genuinely bad its LEAF prices out first,
    // since it sits at the later slot, and the prereq becomes droppable once the leaf goes.
    const need = neededIn(ordered);
    const scored = ordered.map((c, i) => {
      const rest = ordered.filter((_, j) => j !== i);
      const marginal = useAlt ? total - orderedCost(rest, mult) : c.base * Math.pow(mult, i);
      return { i, aug: c.aug, ratio: c.value > 0 ? marginal / c.value : Infinity };
    }).filter((x) => !need.has(x.aug)).sort((a, b) => b.ratio - a.ratio);
    if (!scored.length) break;
    if (!(scored[0].ratio > limit)) break;
    chosen = ordered.filter((_, i) => i !== scored[0].i);
  }

  return orderWithPrereqs(chosen);
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
  // Precedence-constrained order, so the numbers describe a round the game will actually accept.
  const items = orderWithPrereqs([...(basket || [])].filter((c) => c && Number.isFinite(Number(c.base))));
  const total = orderedCost(items, mult) * scale;
  const names = new Set(items.map((c) => c.aug));

  // Dropping an aug that others depend on means dropping THEM too -- the marginal cost of a prereq is
  // the cost of its whole subtree, not of itself. Reporting its solo saving would make the cheap root
  // of an expensive chain look like the best buy in the round.
  const dependents = (name) => {
    const doomed = new Set([name]);
    for (;;) {
      const before = doomed.size;
      for (const c of items) if ((c.prereqs || []).some((r) => doomed.has(r) && names.has(r))) doomed.add(c.aug);
      if (doomed.size === before) return doomed;
    }
  };

  return items.map((c, i) => {
    const paid = Number(c.base) * Math.pow(mult, i) * scale;
    const doomed = dependents(c.aug);
    const without = orderedCost(items.filter((x) => !doomed.has(x.aug)), mult) * scale;
    const marginal = total - without;
    const v = Number(c.value) > 0 ? Number(c.value) : 0;
    return {
      aug: c.aug, slot: i, base: Number(c.base), value: v, paid, marginal,
      escalation: Math.pow(mult, i) * scale,
      chain: doomed.size > 1 ? doomed.size : 0,   // >0 means dropping this drops a subtree
      perValue: v > 0 ? paid / v : Infinity,
      // ratio is subtree cost over subtree value, or a prereq's ratio would be judged against only
      // its own multipliers while carrying its dependents' price
      marginalPerValue: (() => {
        const sv = items.filter((x) => doomed.has(x.aug)).reduce((a, x) => a + (Number(x.value) > 0 ? Number(x.value) : 0), 0);
        return sv > 0 ? marginal / sv : Infinity;
      })(),
    };
  });
}
