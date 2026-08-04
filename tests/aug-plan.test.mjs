import test from "node:test";
import assert from "node:assert/strict";
import {
  AUG_PRICE_MULT, DEFAULT_WEIGHTS, augValue, valueDensity, roundCost, selectRound,
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
