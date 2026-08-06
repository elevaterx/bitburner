import test from "node:test";
import assert from "node:assert/strict";
import {
  distributeJobs, shouldAcceptOffer, upgradesToLevel, amountToReach,
  CORP_CITIES, DEFAULT_CORP_CFG,
  nextProductName, lowestRated, planProduct,
  warehouseUpgradeCost, warehouseLevelsToBuy, officeTarget, warehouseStalled,
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

test("nextProductName: increments past the highest index", () => {
  assert.equal(nextProductName([]), "Prod-0");
  assert.equal(nextProductName(["Prod-0", "Prod-1"]), "Prod-2");
  assert.equal(nextProductName(["Prod-3", "Prod-1"]), "Prod-4"); // max+1, not count
});

test("lowestRated: picks the weakest product", () => {
  const ps = [{ name: "a", effectiveRating: 50 }, { name: "b", effectiveRating: 10 }, { name: "c", effectiveRating: 30 }];
  assert.equal(lowestRated(ps).name, "b");
});

test("planProduct: wait -> make -> replace", () => {
  // a product still developing -> wait
  assert.deepEqual(
    planProduct([{ name: "Prod-0", developmentProgress: 40, effectiveRating: 0 }], 3),
    { action: "wait", name: "Prod-0" },
  );
  // room for more, none developing -> make next
  assert.deepEqual(
    planProduct([{ name: "Prod-0", developmentProgress: 100, effectiveRating: 20 }], 3),
    { action: "make", name: "Prod-1" },
  );
  // at cap, none developing -> churn the weakest
  const full = [
    { name: "Prod-0", developmentProgress: 100, effectiveRating: 20 },
    { name: "Prod-1", developmentProgress: 100, effectiveRating: 5 },
    { name: "Prod-2", developmentProgress: 100, effectiveRating: 40 },
  ];
  assert.deepEqual(planProduct(full, 3), { action: "replace", discontinue: "Prod-1", make: "Prod-3" });
});

test("warehouseUpgradeCost matches Actions.ts:420 -- 1e9 * 1.07^(level+1+i)", () => {
  assert.ok(Math.abs(warehouseUpgradeCost(1, 1) - 1e9 * 1.07 ** 2) < 1);
  assert.ok(Math.abs(warehouseUpgradeCost(1, 2) - (1e9 * 1.07 ** 2 + 1e9 * 1.07 ** 3)) < 1);
  assert.equal(warehouseUpgradeCost(1, 0), 0);
  assert.equal(warehouseUpgradeCost(1, -3), 0);
});

test("warehouseLevelsToBuy: only when constrained, and never over budget", () => {
  const full = { level: 1, size: 160, sizeUsed: 160 };
  const half = { level: 1, size: 160, sizeUsed: 80 };
  // half-empty warehouse gains nothing from more shelves, however rich we are
  assert.equal(warehouseLevelsToBuy(half, 1e12), 0);
  // REGRESSION. This test previously asserted that a $281m budget correctly buys nothing -- true
  // in isolation, but $281m was funds*0.35/6, i.e. the budget corp.js actually handed it. So the
  // test blessed the exact arithmetic that made the feature inert: with six cities sharing the
  // budget, no warehouse could be upgraded until funds hit $19.6b. The budget is no longer divided.
  assert.equal(warehouseLevelsToBuy(full, 281e6), 0, "$281m genuinely cannot buy a $1.14b level");
  assert.equal(warehouseLevelsToBuy(full, 4.82e9 * 0.35), 1,
               "the UNDIVIDED budget at the live $4.82b funds must buy exactly one level");
  assert.equal(warehouseLevelsToBuy(full, 1.15e9), 1);
  assert.equal(warehouseLevelsToBuy(full, 2.5e9), 2);
  // budget is a hard ceiling, never exceeded
  const n = warehouseLevelsToBuy(full, 5e9);
  assert.ok(warehouseUpgradeCost(1, n) <= 5e9);
  assert.ok(warehouseUpgradeCost(1, n + 1) > 5e9);
  // degenerate inputs are safe
  assert.equal(warehouseLevelsToBuy(null, 1e12), 0);
  assert.equal(warehouseLevelsToBuy({ level: 1, size: 0, sizeUsed: 0 }, 1e12), 0);
  assert.equal(warehouseLevelsToBuy(full, 0), 0);
});

test("officeTarget grows past the start size but stops at the cap", () => {
  // the live bug: office frozen at 3 forever, so R&D never got a seat
  assert.equal(officeTarget(3, 100e9), 6);
  assert.equal(officeTarget(27, 100e9), 30);
  assert.equal(officeTarget(30, 100e9), 30, "capped");
  assert.equal(officeTarget(3, 1e6), 3, "no growth without budget");
});

test("warehouseStalled: one full city is enough to hold the whole division back", () => {
  const full = { whUsed: 159, whSize: 160 }, roomy = { whUsed: 40, whSize: 160 };
  assert.equal(warehouseStalled([roomy, roomy, full]), true, "any one at the trigger stalls the pass");
  assert.equal(warehouseStalled([roomy, roomy, roomy]), false);
  // the exact live reading: 158-159 of 160 across all six
  assert.equal(warehouseStalled([{ whUsed: 158, whSize: 160 }]), true);
  assert.equal(warehouseStalled([]), false);
  assert.equal(warehouseStalled(null), false);
  assert.equal(warehouseStalled([{ whUsed: 0, whSize: 0 }]), false, "no warehouse is not a stall");
});

test("stall budget clears an upgrade at funds the normal budget cannot", () => {
  const full = { level: 1, size: 160, sizeUsed: 159 };
  const funds = 1.5e9;   // roughly where the corp sits after a few hours of $56k/s
  assert.equal(warehouseLevelsToBuy(full, funds * DEFAULT_CORP_CFG.warehouseBudgetFrac), 0,
               "normal 35% budget still cannot reach $1.14b -- this is the jam");
  assert.equal(warehouseLevelsToBuy(full, funds * DEFAULT_CORP_CFG.warehouseStallBudgetFrac), 1,
               "stall 80% budget breaks the jam");
});
