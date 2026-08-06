import test from "node:test";
import assert from "node:assert/strict";
import {
  AUG_PRICE_MULT, DEFAULT_WEIGHTS, BASE_WEIGHTS, augValue, valueDensity, roundCost, selectRound,
  moneyFarmWeight, nodeWeights, roundEconomics,
  skillBracket, expChannelWeight,
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
