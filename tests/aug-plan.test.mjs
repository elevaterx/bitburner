import test from "node:test";
import assert from "node:assert/strict";
import {
  AUG_PRICE_MULT, DEFAULT_WEIGHTS, BASE_WEIGHTS, augValue, valueDensity, roundCost, selectRound,
  moneyFarmWeight, nodeWeights, roundEconomics,
  skillBracket, expChannelWeight, repWeight, gangRepPerSec, maxRepGap, hasHackingValue,
  prereqClosure, orderWithPrereqs, orderedCost,
} from "../lib/aug-plan.js";

test("augValue: weighted log-sum, ignores mults <= 1 and unknown keys", () => {
  assert.equal(augValue(null), 0);
  assert.equal(augValue({ hacking: 1, hacking_exp: 0.5, charisma: 99 }), 0);
  assert.ok(Math.abs(augValue({ hacking: 1.2 }) - Math.log(1.2)) < 1e-12);
  // half weight on secondary stats
  assert.ok(Math.abs(augValue({ hacking_speed: 1.2 }) - 0.5 * Math.log(1.2)) < 1e-12);
  // compounding is additive in log space: two 1.1s == one 1.21
  const two = augValue({ hacking: 1.1 }) + augValue({ hacking_exp: 1.1 });
  assert.ok(Math.abs(two - augValue({ hacking: 1.21 })) < 1e-12);
});

test("valueDensity: zero base with value is infinite, zero base without is zero", () => {
  assert.equal(valueDensity(2, 0), Infinity);
  assert.equal(valueDensity(0, 0), 0);
  assert.equal(valueDensity(10, 5), 2);
});

test("roundCost: prices a basket in base-descending order", () => {
  assert.equal(roundCost([]), 0);
  assert.equal(roundCost([100]), 100);
  // 100 at 1.9^0 + 10 at 1.9^1 -- descending, regardless of input order
  assert.ok(Math.abs(roundCost([10, 100]) - (100 + 19)) < 1e-9);
  assert.equal(roundCost([10, 100]), roundCost([100, 10]));
});

test("roundCost: descending really is the cheapest order (rearrangement inequality)", () => {
  const bases = [2.75, 2.0, 0.55, 0.4, 0.03, 0.0175];
  const ascending = [...bases].sort((a, b) => a - b)
    .reduce((t, b, i) => t + b * Math.pow(AUG_PRICE_MULT, i), 0);
  assert.ok(roundCost(bases) < ascending);
  assert.ok(ascending / roundCost(bases) > 5);   // the gap is large, not marginal
});

test("selectRound: picks value density, not price -- the live $7.21b regression", () => {
  // Real numbers from the augstat dump, $b. This is the exact case cost-descending got wrong.
  const cands = [
    { aug: "Neuralstimulator", base: 3.00, value: augValue({ hacking_exp: 1.12, hacking_speed: 1.02, hacking_chance: 1.10 }) },
    { aug: "PCMatrix", base: 2.00, value: augValue({ faction_rep: 1.08 }) },
    { aug: "HyperSight", base: 2.75, value: augValue({ hacking_speed: 1.03, hacking_money: 1.10 }) },
    { aug: "ADR-V2", base: 0.55, value: augValue({ faction_rep: 1.20 }) },
    { aug: "Shadow's Simulacrum", base: 0.40, value: augValue({ faction_rep: 1.15 }) },
    { aug: "Neural-Retention", base: 0.25, value: augValue({ hacking_exp: 1.25 }) },
    { aug: "CRTX42-AA", base: 0.225, value: augValue({ hacking: 1.08, hacking_exp: 1.15 }) },
    { aug: "S.N.A", base: 0.030, value: augValue({ faction_rep: 1.15 }) },
    { aug: "ADR-V1", base: 0.0175, value: augValue({ faction_rep: 1.10 }) },
  ];
  const picked = selectRound(cands, 7.21).map((c) => c.aug);
  // The three biggest-ticket, worst-value augs must all be rejected.
  assert.ok(!picked.includes("PCMatrix"), "PCMatrix is $2b for faction_rep 1.08");
  assert.ok(!picked.includes("Neuralstimulator"));
  assert.ok(!picked.includes("HyperSight"));
  // The cheap high-multiplier ones must all make it.
  for (const a of ["ADR-V2", "Shadow's Simulacrum", "Neural-Retention", "CRTX42-AA", "S.N.A", "ADR-V1"]) {
    assert.ok(picked.includes(a), a + " should be selected");
  }
  assert.ok(roundCost(selectRound(cands, 7.21).map((c) => c.base)) <= 7.21);
});

test("selectRound: returns purchase order (base descending)", () => {
  const cands = [
    { aug: "cheap", base: 1, value: 1 },
    { aug: "mid", base: 10, value: 10 },
    { aug: "dear", base: 100, value: 100 },
  ];
  assert.deepEqual(selectRound(cands, 1e6).map((c) => c.aug), ["dear", "mid", "cheap"]);
});

test("selectRound: budget is enforced against the WHOLE basket, not a running total", () => {
  // Two augs at base 100. Alone: 100. Together: 100 + 190 = 290. A running-total greedy would
  // wrongly accept the second at 100 and report 200.
  const cands = [
    { aug: "a", base: 100, value: 5 },
    { aug: "b", base: 100, value: 5 },
  ];
  assert.equal(selectRound(cands, 250).length, 1);
  assert.equal(selectRound(cands, 290).length, 2);
});

test("selectRound: degenerate inputs are safe", () => {
  assert.deepEqual(selectRound([], 100), []);
  assert.deepEqual(selectRound(null, 100), []);
  assert.deepEqual(selectRound([{ aug: "x", base: 1, value: 1 }], 0), []);
  assert.deepEqual(selectRound([{ aug: "x", base: 1, value: 1 }], NaN), []);
  // zero-value augs are never worth an exponent slot
  assert.deepEqual(selectRound([{ aug: "junk", base: 0.001, value: 0 }], 1e9), []);
});

test("DEFAULT_WEIGHTS: the three gate-driving stats carry full weight", () => {
  assert.equal(DEFAULT_WEIGHTS.hacking, 1);
  assert.equal(DEFAULT_WEIGHTS.hacking_exp, 1);
  assert.equal(DEFAULT_WEIGHTS.faction_rep, 1);
});

test("selectRound: marginal cutoff drops augs whose realized price outruns their value", () => {
  // Live case. Synaptic Enhancement Implant has the best BASE density of the lot, but lands in the
  // last slot where it costs $670m for log-value 0.015 -- 15x worse $/value than the round's first
  // buy. It must be deferred, not bought.
  const cands = [
    { aug: "ADR-V2", base: 0.550, value: augValue({ faction_rep: 1.20 }) },
    { aug: "Shadow", base: 0.400, value: augValue({ faction_rep: 1.15 }) },
    { aug: "Neural-Retention", base: 0.250, value: augValue({ hacking_exp: 1.25 }) },
    { aug: "CRTX42-AA", base: 0.225, value: augValue({ hacking: 1.08, hacking_exp: 1.15 }) },
    { aug: "ASP", base: 0.080, value: augValue({ hacking_exp: 1.05, hacking_speed: 1.02, hacking_chance: 1.05 }) },
    { aug: "S.N.A", base: 0.030, value: augValue({ faction_rep: 1.15 }) },
    { aug: "ADR-V1", base: 0.0175, value: augValue({ faction_rep: 1.10 }) },
    { aug: "Synaptic Enh", base: 0.0075, value: augValue({ hacking_speed: 1.03 }) },
  ];
  const picked = selectRound(cands, 8.10).map((c) => c.aug);
  assert.ok(!picked.includes("Synaptic Enh"), "$670m for hacking_speed 1.03 must be deferred");
  assert.ok(picked.includes("ADR-V2") && picked.includes("Neural-Retention"));
  // and the cutoff is tunable -- a permissive one lets the tail back in
  const loose = selectRound(cands, 8.10, { valueCutoff: 1e9 }).map((c) => c.aug);
  assert.ok(loose.includes("Synaptic Enh"));
});

test("selectRound: cutoff never rejects the first buy (nothing to compare against)", () => {
  const only = [{ aug: "solo", base: 5, value: 0.0001 }];
  assert.deepEqual(selectRound(only, 100).map((c) => c.aug), ["solo"]);
});

test("moneyFarmWeight: both gates must pass -- node capability AND an actual farm", () => {
  assert.equal(moneyFarmWeight(1, false), 0);       // farm stopped -> worthless whatever the node
  assert.equal(moneyFarmWeight(0, true), 0);        // BN8: ScriptHackMoneyGain 0
  assert.equal(moneyFarmWeight(0.01, true), 0.01);  // BN9: ServerMaxMoney 0.01
  assert.ok(Math.abs(moneyFarmWeight(0.08, true) - 0.08) < 1e-12);   // BN2
  assert.equal(moneyFarmWeight(1, true), 1);        // BN1 vanilla
  assert.equal(moneyFarmWeight(5, true), 1);        // capped -- a rich node is not worth >full weight
  assert.equal(moneyFarmWeight(NaN, true), 0);
});

test("nodeWeights: scales only the money-farm mults, never the gate-driving ones", () => {
  const stopped = nodeWeights({ scriptHackMoneyGain: 1, serverMaxMoney: 1, moneyFarmRunning: false });
  assert.equal(stopped.hacking_money, 0);
  assert.equal(stopped.hacking_grow, 0);
  // speed and chance survive: they drive XP/sec and the 25% failure tier, not money
  assert.equal(stopped.hacking_speed, BASE_WEIGHTS.hacking_speed);
  assert.equal(stopped.hacking_chance, BASE_WEIGHTS.hacking_chance);
  assert.equal(stopped.hacking, 1);
  assert.equal(stopped.faction_rep, 1);

  // BN2 with the farm UP still scores money mults near zero on the node's own terms
  const bn2 = nodeWeights({ scriptHackMoneyGain: 1, serverMaxMoney: 0.08, moneyFarmRunning: true });
  assert.ok(Math.abs(bn2.hacking_money - 0.04) < 1e-12);

  // unknown node mults degrade to "assume the node allows it" and let activity decide
  const unknown = nodeWeights({ moneyFarmRunning: true });
  assert.equal(unknown.hacking_money, BASE_WEIGHTS.hacking_money);
});

test("node awareness reproduces the live DataJack case", () => {
  // BN2, coordinator stopped -> DataJack (hacking_money 1.25) scores 0 and is not selected.
  const w = nodeWeights({ scriptHackMoneyGain: 1, serverMaxMoney: 0.08, moneyFarmRunning: false });
  assert.equal(augValue({ hacking_money: 1.25 }, w), 0);
  const cands = [
    { aug: "ADR-V2", base: 0.550, value: augValue({ faction_rep: 1.20 }, w) },
    { aug: "DataJack", base: 0.450, value: augValue({ hacking_money: 1.25 }, w) },
  ];
  assert.deepEqual(selectRound(cands, 100).map((c) => c.aug), ["ADR-V2"]);
  // restart the farm in a node that rewards it and DataJack comes back
  const w2 = nodeWeights({ scriptHackMoneyGain: 1, serverMaxMoney: 1, moneyFarmRunning: true });
  assert.ok(augValue({ hacking_money: 1.25 }, w2) > 0);
});

test("selectRound: priceScale accounts for augs already queued from earlier runs", () => {
  const cands = [
    { aug: "big", base: 5.0, value: 0.833 },
    { aug: "small", base: 0.0075, value: 0.015 },
  ];
  // fresh board: both fit easily in $20b
  assert.equal(selectRound(cands, 20).length, 2);
  // with 8 augs already queued the board is at 1.9^8 = 169.8x -- "big" alone is $849b
  const scale = Math.pow(1.9, 8);
  assert.deepEqual(selectRound(cands, 20, { priceScale: scale }).map((c) => c.aug), ["small"]);
  assert.equal(selectRound(cands, 1, { priceScale: scale }).length, 0);
  // scale <= 0 or non-finite is ignored rather than zeroing the budget
  assert.equal(selectRound(cands, 20, { priceScale: 0 }).length, 2);
  assert.equal(selectRound(cands, 20, { priceScale: NaN }).length, 2);
});

test("roundEconomics: marginal exceeds paid for every aug except the cheapest", () => {
  const basket = [
    { aug: "a", base: 4, value: 1 },
    { aug: "b", base: 2, value: 1 },
    { aug: "c", base: 1, value: 1 },
  ];
  const rows = roundEconomics(basket);
  assert.deepEqual(rows.map((r) => r.aug), ["a", "b", "c"]);          // purchase order
  assert.equal(rows[0].slot, 0);
  assert.ok(Math.abs(rows[0].paid - 4) < 1e-9);                       // 4 * 1.9^0
  assert.ok(Math.abs(rows[1].paid - 2 * 1.9) < 1e-9);
  assert.ok(Math.abs(rows[2].paid - 1 * 3.61) < 1e-9);
  // dropping a mid aug also moves everything cheaper up a slot -> marginal > paid
  assert.ok(rows[0].marginal > rows[0].paid);
  assert.ok(rows[1].marginal > rows[1].paid);
  // ...except the LAST slot, where nothing sits below it
  assert.ok(Math.abs(rows[2].marginal - rows[2].paid) < 1e-9);
  // marginal is exactly total minus the basket without it
  const total = roundCost([4, 2, 1]);
  assert.ok(Math.abs(rows[1].marginal - (total - roundCost([4, 1]))) < 1e-9);
});

test("roundEconomics: reproduces the live 8-aug round", () => {
  const W = nodeWeights({ scriptHackMoneyGain: 1, serverMaxMoney: 0.08, moneyFarmRunning: false });
  const basket = [
    { aug: "Neuronal Densification", base: 1.38, value: augValue({ hacking: 1.15, hacking_exp: 1.10, hacking_speed: 1.03 }, W) },
    { aug: "ADR-V2", base: 0.550, value: augValue({ faction_rep: 1.20 }, W) },
    { aug: "Shadow", base: 0.400, value: augValue({ faction_rep: 1.15 }, W) },
    { aug: "Neural-Retention", base: 0.250, value: augValue({ hacking_exp: 1.25 }, W) },
    { aug: "CRTX42-AA", base: 0.225, value: augValue({ hacking: 1.08, hacking_exp: 1.15 }, W) },
    { aug: "ASP", base: 0.080, value: augValue({ hacking_exp: 1.05, hacking_speed: 1.02, hacking_chance: 1.05 }, W) },
    { aug: "S.N.A", base: 0.030, value: augValue({ faction_rep: 1.15 }, W) },
    { aug: "ADR-V1", base: 0.0175, value: augValue({ faction_rep: 1.10 }, W) },
  ];
  const rows = roundEconomics(basket);
  const top = rows[0];
  assert.equal(top.aug, "Neuronal Densification");
  assert.ok(Math.abs(top.value - 0.250) < 0.001);
  assert.ok(Math.abs(top.paid - 1.38) < 0.01);
  assert.ok(Math.abs(top.marginal - 7.11) < 0.05);          // measured in game: $7.11b
  assert.ok(Math.abs(top.marginalPerValue - 28.4) < 0.3);   // $28.4b per unit value
  // paid and marginal rank the basket differently -- the whole reason both columns exist
  const worstPaid = [...rows].sort((a, b) => b.perValue - a.perValue)[0].aug;
  const worstMarg = [...rows].sort((a, b) => b.marginalPerValue - a.marginalPerValue)[0].aug;
  assert.notEqual(worstPaid, worstMarg);
});

test("roundEconomics: priceScale and degenerate inputs", () => {
  assert.deepEqual(roundEconomics([]), []);
  assert.deepEqual(roundEconomics(null), []);
  const scaled = roundEconomics([{ aug: "x", base: 2, value: 1 }], { priceScale: 10 });
  assert.equal(scaled[0].paid, 20);
  assert.equal(scaled[0].escalation, 10);
  // zero-value augs report Infinity rather than dividing by zero
  assert.equal(roundEconomics([{ aug: "z", base: 1, value: 0 }])[0].perValue, Infinity);
});

test("expChannelWeight: exp-side mults are worth 32/bracket of a hacking-side one", () => {
  // level = mult_h * bracket. d(level)/d(ln mult_h) = level; d(level)/d(ln exp) = mult_h*32.
  assert.ok(Math.abs(skillBracket(2.7e9) - (32 * Math.log(2.7e9 + 534.6) - 200)) < 1e-9);
  assert.ok(Math.abs(expChannelWeight(500) - 32 / 500) < 1e-12);
  assert.equal(expChannelWeight(16), 1, "never exceeds 1 -- exp cannot beat the linear channel");
  assert.equal(expChannelWeight(0), 1, "unknown bracket -> no discount, never worse than before");
  assert.equal(expChannelWeight(NaN), 1);
});

test("nodeWeights discounts the whole exp channel, not just hacking_exp", () => {
  // hacking_speed raises exp/sec and hacking_chance decides full-vs-25% exp: same channel.
  const w = nodeWeights({ hackingExp: 2.7e9, moneyFarmRunning: false });
  const x = expChannelWeight(skillBracket(2.7e9));
  assert.ok(Math.abs(w.hacking_exp - BASE_WEIGHTS.hacking_exp * x) < 1e-12);
  assert.ok(Math.abs(w.hacking_speed - BASE_WEIGHTS.hacking_speed * x) < 1e-12);
  assert.ok(Math.abs(w.hacking_chance - BASE_WEIGHTS.hacking_chance * x) < 1e-12);
  // the two channels that are NOT exp-side are untouched by this discount
  assert.equal(w.hacking, BASE_WEIGHTS.hacking, "the linear channel keeps full weight");
  assert.equal(w.faction_rep, BASE_WEIGHTS.faction_rep);
  // omitting hackingExp must reproduce the old behaviour exactly
  const old = nodeWeights({ moneyFarmRunning: false });
  assert.equal(old.hacking_exp, BASE_WEIGHTS.hacking_exp);
  assert.equal(old.hacking_speed, BASE_WEIGHTS.hacking_speed);
});

test("BN3 case: the exp channel collapses and hacking-level augs win", () => {
  const w = nodeWeights({ hackingExp: 2.7e9, scriptHackMoneyGain: 0.2, serverMaxMoney: 0.04,
                          moneyFarmRunning: false });
  assert.equal(w.hacking_money, 0, "no farm and BN3 money mults -> worthless");
  assert.equal(w.hacking_grow, 0);
  assert.ok(w.hacking_exp < 0.07, "hacking_exp was 1.0; at BN3 bracket it is ~0.065");
  // ENM Core V3 (h 1.10, h_exp 1.25, h_speed 1.05, h_money 1.40, h_chance 1.10) vs a pure exp aug
  const core = { hacking: 1.10, hacking_exp: 1.25, hacking_speed: 1.05, hacking_money: 1.40, hacking_chance: 1.10 };
  const pureExp = { hacking_exp: 1.60 };
  assert.ok(augValue(core, w) > augValue(pureExp, w) * 3,
            "a hacking-level aug should dominate a bigger pure-exp aug once the channel is priced");
});

test("hasHackingValue: pure-rep augs do not count", () => {
  assert.equal(hasHackingValue(null), false);
  assert.equal(hasHackingValue({}), false);
  // ADR-V1 / The Shadow's Simulacrum shape -- rep only
  assert.equal(hasHackingValue({ faction_rep: 1.5, company_rep: 1.5 }), false);
  assert.equal(hasHackingValue({ hacking_grow: 1.02 }), true);
  assert.equal(hasHackingValue({ hacking: 1.1, faction_rep: 1.5 }), true);
  // a multiplier of exactly 1 is not a contribution
  assert.equal(hasHackingValue({ hacking: 1 }), false);
});

test("gangRepPerSec: matches Gang.ts:152-155 and degrades to 0, not NaN", () => {
  // faction_rep 3.654 x respect 2.9k/s x favorMult 2.594 / 75  -- the live BN2 NiteSec reading
  const r = gangRepPerSec({ factionRepMult: 3.654, respectPerSec: 2900 }, 159.4);
  assert.ok(Math.abs(r - (3.654 * 2900 * 2.594) / 75) < 1e-9);
  assert.ok(r > 360 && r < 370, "should reproduce hud1's ~363/s, got " + r);
  // favor 0 is legitimate, favorMult 1
  assert.equal(gangRepPerSec({ factionRepMult: 1, respectPerSec: 75 }, 0), 1);
  // anything unusable is "no engine", not a NaN that would poison repWeight
  assert.equal(gangRepPerSec({}, 10), 0);
  assert.equal(gangRepPerSec({ factionRepMult: 1, respectPerSec: 0 }, 10), 0);
  assert.equal(gangRepPerSec(null, 10), 0);
  assert.equal(gangRepPerSec({ factionRepMult: 1, respectPerSec: 100 }, -5), 100 / 75);
});

test("maxRepGap: largest gap over augs that are not pure rep", () => {
  const cands = [
    { repReq: 1_000_000, rep: 100_000, stats: { faction_rep: 1.5 } },   // pure rep -- excluded
    { repReq: 500_000, rep: 100_000, stats: { hacking: 1.1 } },         // gap 400k
    { repReq: 200_000, rep: 100_000, stats: { hacking_exp: 1.2 } },     // gap 100k
    { repReq: 50_000, rep: 100_000, stats: { hacking: 1.5 } },          // already affordable
  ];
  assert.equal(maxRepGap(cands), 400_000);
  assert.equal(maxRepGap([]), 0);
  assert.equal(maxRepGap(null), 0);
  // nothing gated -> 0, which is what tells repWeight the multiplier is worthless
  assert.equal(maxRepGap([{ repReq: 10, rep: 99, stats: { hacking: 1.1 } }]), 0);
});

test("repWeight: full weight without an engine, scaled by hours of income with one", () => {
  // no measurement -> unchanged from the old fixed weight. A caller that cannot measure must never
  // be worse off than before this existed.
  assert.equal(repWeight({}, 1), 1);
  assert.equal(repWeight({ repPerSec: 0, repShortfall: 1e6 }, 1), 1);
  // engine running, nothing gated -> worthless
  assert.equal(repWeight({ repPerSec: 1565, repShortfall: 0 }, 1), 0);
  // the live case: 180k of gap against 1565 rep/s is 32s of income -> ~0.008
  const live = repWeight({ repPerSec: 1565, repShortfall: 180_000 }, 1);
  assert.ok(live > 0.007 && live < 0.009, "expected ~0.008, got " + live);
  // a weak engine against a big gap still saturates at the base weight
  assert.equal(repWeight({ repPerSec: 50, repShortfall: 1e6 }, 1), 1);
  // horizon is the knob: same numbers, 24h horizon -> 1/6 the weight of a 4h one
  const h4 = repWeight({ repPerSec: 100, repShortfall: 100 * 3600 * 2 }, 1);
  const h24 = repWeight({ repPerSec: 100, repShortfall: 100 * 3600 * 2, repHorizonHours: 24 }, 1);
  assert.ok(Math.abs(h4 - 0.5) < 1e-12);
  assert.ok(Math.abs(h24 - 2 / 24) < 1e-12);
});

test("nodeWeights: faction_rep collapses once a gang is closing the gap for free", () => {
  const base = nodeWeights({});
  assert.equal(base.faction_rep, 1);
  const gang = nodeWeights({ repPerSec: 1565, repShortfall: 180_000 });
  assert.ok(gang.faction_rep < 0.01);
  // and that has to change the ORDER: a pure-rep aug must lose to a small hacking aug
  const pureRep = { faction_rep: 1.5, company_rep: 1.5 };   // ADR-V2 shape
  const smallHack = { hacking: 1.03 };
  assert.ok(augValue(pureRep, base) > augValue(smallHack, base),
            "without a gang the rep aug should still win -- rep is the constraint then");
  assert.ok(augValue(pureRep, gang) < augValue(smallHack, gang),
            "with a gang running the rep aug must lose to even a 3% hacking multiplier");
});

test("nodeWeights: rep and exp discounts are independent", () => {
  const w = nodeWeights({ hackingExp: 5.7e5, repPerSec: 1565, repShortfall: 180_000 });
  // exp channel still discounted by 32/bracket, untouched by the rep math
  assert.ok(Math.abs(w.hacking_exp - expChannelWeight(skillBracket(5.7e5))) < 1e-12);
  assert.ok(Math.abs(w.hacking_speed - 0.5 * expChannelWeight(skillBracket(5.7e5))) < 1e-12);
  // hacking itself is never discounted -- it is the numeraire
  assert.equal(w.hacking, 1);
});

// ---------------------------------------------------------------- prerequisite chains
// The ENM line, which is the real case this exists for.
const ENM = [
  { aug: "Embedded Netburner Module", base: 750e6, value: 0.077, prereqs: [] },
  { aug: "ENM Core", base: 2.5e9, value: 0.180, prereqs: ["Embedded Netburner Module"] },
  { aug: "ENM Core V2", base: 4.5e9, value: 0.300, prereqs: ["ENM Core"] },
  { aug: "ENM Core V3", base: 7.5e9, value: 0.400, prereqs: ["ENM Core V2"] },
];

test("prereqClosure: transitive, skips what you already hold", () => {
  const byName = new Map(ENM.map((c) => [c.aug, c]));
  assert.deepEqual(prereqClosure("ENM Core V3", byName, new Set()),
    ["Embedded Netburner Module", "ENM Core", "ENM Core V2"]);
  // already installed -> the chain below it disappears
  assert.deepEqual(prereqClosure("ENM Core V3", byName, new Set(["ENM Core"])), ["ENM Core V2"]);
  assert.deepEqual(prereqClosure("Embedded Netburner Module", byName, new Set()), []);
  // a prereq that is not a candidate at all contributes nothing (it is unbuyable, not free) --
  // selectRound's pool prune is what removes the dependent
  assert.deepEqual(prereqClosure("ENM Core", new Map([["ENM Core", ENM[1]]]), new Set()), []);
});

test("orderWithPrereqs: prereq-first, base-descending within what is legal", () => {
  const ordered = orderWithPrereqs(ENM).map((c) => c.aug);
  assert.deepEqual(ordered, ["Embedded Netburner Module", "ENM Core", "ENM Core V2", "ENM Core V3"]);
  // the constraint is binding: unconstrained order would be the exact reverse (base descending)
  const unconstrained = [...ENM].sort((a, b) => b.base - a.base).map((c) => c.aug);
  assert.deepEqual(unconstrained, [...ordered].reverse());
  // ...and it costs money. Pricing the illegal order would understate the round.
  assert.ok(orderedCost(orderWithPrereqs(ENM)) > orderedCost([...ENM].sort((a, b) => b.base - a.base)));
});

test("orderWithPrereqs: independent augs still sort base-descending, chains interleave by base", () => {
  const mixed = [
    { aug: "Big", base: 10e9, value: 0.2, prereqs: [] },
    ...ENM,
    { aug: "Small", base: 1e6, value: 0.01, prereqs: [] },
  ];
  const o = orderWithPrereqs(mixed).map((c) => c.aug);
  assert.equal(o[0], "Big");                       // highest base, unconstrained
  assert.equal(o[o.length - 1], "Small");          // lowest base, unconstrained
  assert.ok(o.indexOf("Embedded Netburner Module") < o.indexOf("ENM Core"));
  assert.ok(o.indexOf("ENM Core V2") < o.indexOf("ENM Core V3"));
});

test("orderWithPrereqs: a prereq missing from the basket entirely is treated as already held", () => {
  // augbuy passes installed augs as `held`; they are not basket members, so they must not block.
  const only = [{ aug: "ENM Core", base: 2.5e9, value: 0.18, prereqs: ["Embedded Netburner Module"] }];
  assert.deepEqual(orderWithPrereqs(only).map((c) => c.aug), ["ENM Core"]);
});

test("selectRound: buys a whole chain, and never a dependent without its prereq", () => {
  // With the cutoff disabled the whole chain is bought, in dependency order.
  const chosen = selectRound(ENM, 1e12, { held: new Set(), valueCutoff: Infinity });
  assert.deepEqual(chosen.map((c) => c.aug),
    ["Embedded Netburner Module", "ENM Core", "ENM Core V2", "ENM Core V3"]);

  // With the DEFAULT cutoff the chain's tail is pruned, and that is correct rather than a chain bug:
  // ENM Core V3 sits at slot 3 paying 1.9^3 = 6.86x, which is $128.6b per unit value against $9.7b
  // for the round's best buy. Deferring it to slot 0 of the next round -- by which point its whole
  // chain is INSTALLED -- costs its bare base instead. The cutoff prunes chains from the leaf end,
  // which is the only end it can prune from without orphaning anything.
  const trimmed = selectRound(ENM, 1e12, { held: new Set() }).map((c) => c.aug);
  assert.deepEqual(trimmed, ["Embedded Netburner Module", "ENM Core", "ENM Core V2"]);
  // whatever the budget, the basket is always prereq-closed
  for (const b of [1e9, 3e9, 8e9, 2e10, 1e11]) {
    const got = selectRound(ENM, b, { held: new Set() });
    const names = new Set(got.map((c) => c.aug));
    for (const c of got) for (const r of c.prereqs) {
      assert.ok(names.has(r), "budget " + b + ": " + c.aug + " kept without " + r);
    }
  }
});

test("selectRound: drops a dependent whose prereq is not on offer", () => {
  // ENM Core V3 is rep-affordable but ENM Core V2 is not, so the whole tail is unbuyable.
  const offered = [ENM[0], ENM[1], ENM[3]];
  const got = selectRound(offered, 1e12, { held: new Set() }).map((c) => c.aug);
  assert.deepEqual(got, ["Embedded Netburner Module", "ENM Core"]);
  // ...unless the missing link is already installed
  const got2 = selectRound(offered, 1e12, { held: new Set(["ENM Core V2"]) }).map((c) => c.aug);
  assert.ok(got2.includes("ENM Core V3"));
});

test("selectRound: prereq-free baskets behave exactly as before chains existed", () => {
  const plain = [
    { aug: "A", base: 1e9, value: 0.20 },
    { aug: "B", base: 5e8, value: 0.05 },
    { aug: "C", base: 2e9, value: 0.30 },
  ];
  const got = selectRound(plain, 1e11).map((c) => c.aug);
  assert.deepEqual(got, ["C", "A", "B"]);   // purchase order: base descending
});

test("roundEconomics: a prereq's marginal cost is its whole subtree, not itself", () => {
  const econ = roundEconomics(ENM);
  assert.deepEqual(econ.map((r) => r.aug),
    ["Embedded Netburner Module", "ENM Core", "ENM Core V2", "ENM Core V3"]);
  const root = econ[0], leaf = econ[3];
  // dropping the root drops all four; dropping the leaf drops one
  assert.equal(root.chain, 4);
  assert.equal(leaf.chain, 0);
  assert.ok(root.marginal > root.paid * 5,
            "the cheap root of an expensive chain must not look cheap to drop");
  assert.ok(Math.abs(leaf.marginal - leaf.paid) / leaf.paid < 1e-9, "a leaf's marginal is its own price");
  // and the ratio is judged on subtree value, so the root is not credited only its own 0.077
  assert.ok(root.marginalPerValue < root.marginal / root.value);
});

test("NFG ladder: each level costs 1.14 x 1.9 the last, and self-limits", () => {
  // base 750e3 x BN3 AugmentationMoneyCost 3, after 11 queued augs
  const price0 = 750e3 * 3 * Math.pow(1.9, 11);
  const step = 1.14 * 1.9;
  assert.ok(Math.abs(price0 - 2.6213e9) / 2.6213e9 < 0.001, "level 0 ~ $2.62b, got " + price0);
  let cash = 14.07e12, levels = 0, spent = 0;
  for (let n = 0; n < 200; n++) {
    const price = price0 * Math.pow(step, n);
    if (price > cash) break;
    cash -= price; spent += price; levels++;
  }
  assert.equal(levels, 11, "expected 11 levels from $14.07t, got " + levels);
  assert.ok(spent > 11e12 && spent < 11.2e12, "expected ~$11.08t, got " + spent);
  // 11 levels is +1% each, multiplicative
  assert.ok(Math.abs(Math.pow(1.01, levels) - 1.1157) < 1e-4);
});
