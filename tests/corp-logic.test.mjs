import test from "node:test";
import assert from "node:assert/strict";
import {
  distributeJobs, shouldAcceptOffer, upgradesToLevel, amountToReach,
  CORP_CITIES, DEFAULT_CORP_CFG,
} from "../lib/corp-logic.js";

test("distributeJobs: sums exactly to size, non-negative", () => {
  for (const size of [0, 1, 3, 4, 5, 9, 30, 60, 123]) {
    const d = distributeJobs(size);
    const total = Object.values(d).reduce((a, b) => a + b, 0);
    assert.equal(total, size, "size=" + size);
    for (const v of Object.values(d)) assert.ok(v >= 0);
  }
});

test("distributeJobs: covers all five jobs at reasonable size", () => {
  const d = distributeJobs(30);
  assert.deepEqual(Object.keys(d).sort(), ["Business", "Engineer", "Management", "Operations", "Research & Development"]);
  assert.ok(d.Operations >= d.Business); // ops-weighted
});

test("shouldAcceptOffer: round-gated thresholds", () => {
  assert.equal(shouldAcceptOffer({ round: 1, funds: 3e11 }), true);
  assert.equal(shouldAcceptOffer({ round: 1, funds: 1e11 }), false);
  assert.equal(shouldAcceptOffer({ round: 4, funds: 3e15 }), true);
  assert.equal(shouldAcceptOffer({ round: 5, funds: 1e18 }), false); // not configured -> hold
  assert.equal(shouldAcceptOffer(null), false);
});

test("upgradesToLevel: priority order within budget", () => {
  const catalog = [
    { name: "Smart Storage", cost: 100 },
    { name: "Smart Factories", cost: 200 },
    { name: "Wilson Analytics", cost: 5000 },
    { name: "ABC SalesBots", cost: 300 },
  ];
  // funds 5000 * 0.2 = 1000 budget: Storage(100)+Factories(200)+SalesBots(300)=600, Wilson too dear.
  const picks = upgradesToLevel(catalog, 5000);
  assert.deepEqual(picks, ["Smart Storage", "Smart Factories", "ABC SalesBots"]);
});

test("amountToReach: clamped", () => {
  assert.equal(amountToReach(1000, 250), 750);
  assert.equal(amountToReach(1000, 1000), 0);
  assert.equal(amountToReach(1000, 1200), 0);
});

test("CORP_CITIES: the six", () => {
  assert.equal(CORP_CITIES.length, 6);
  assert.ok(CORP_CITIES.includes("Aevum") && CORP_CITIES.includes("Volhaven"));
});
