import test from "node:test";
import assert from "node:assert/strict";
import { chooseAction, largestAffordableBatch, DEFAULT_BB_CFG } from "../lib/bladeburner-logic.js";

const base = {
  staminaPct: 1, chaos: 0, rank: 1000,
  nextBlackOp: null, blackOpChance: 0,
  candidates: [],
};

test("chooseAction: low stamina -> regen (highest priority)", () => {
  assert.deepEqual(
    chooseAction({ ...base, staminaPct: 0.3, chaos: 99, nextBlackOp: { name: "X", rank: 0 }, blackOpChance: 1 }),
    { type: "General", name: "Hyperbolic Regeneration Chamber" },
  );
});

test("chooseAction: high chaos -> Diplomacy", () => {
  assert.deepEqual(chooseAction({ ...base, chaos: 80 }), { type: "General", name: "Diplomacy" });
});

test("chooseAction: eligible black op with high chance", () => {
  const s = { ...base, nextBlackOp: { name: "Operation Typhoon", rank: 500 }, blackOpChance: 0.97 };
  assert.deepEqual(chooseAction(s), { type: "Black Operations", name: "Operation Typhoon" });
});

test("chooseAction: black op skipped if rank too low or chance too low", () => {
  assert.equal(chooseAction({ ...base, nextBlackOp: { name: "X", rank: 5000 }, blackOpChance: 1 }).name, "Field Analysis");
  assert.equal(chooseAction({ ...base, nextBlackOp: { name: "X", rank: 1 }, blackOpChance: 0.5 }).name, "Field Analysis");
});

test("chooseAction: picks best rankGain/time among safe candidates", () => {
  const s = { ...base, candidates: [
    { type: "Contracts", name: "Tracking", countRemaining: 10, chance: 0.99, rankGain: 2, time: 10 },   // 0.2/s
    { type: "Operations", name: "Assassination", countRemaining: 5, chance: 0.85, rankGain: 30, time: 60 }, // 0.5/s
    { type: "Operations", name: "Raid", countRemaining: 5, chance: 0.4, rankGain: 100, time: 10 },        // unsafe
  ]};
  assert.deepEqual(chooseAction(s), { type: "Operations", name: "Assassination" });
});

test("chooseAction: no safe candidate -> Field Analysis", () => {
  const s = { ...base, candidates: [{ type: "Contracts", name: "Tracking", countRemaining: 0, chance: 0.99, rankGain: 2, time: 10 }] };
  assert.equal(chooseAction(s).name, "Field Analysis");
});

// --- skill batching ---
// Synthetic linear-marginal cost: level k costs k, so cumulative(n) = n(n+1)/2.
const cumTriangular = (n) => (n * (n + 1)) / 2;

test("largestAffordableBatch: budget bound", () => {
  // cumulative(n) <= 55 -> n<=10 (10*11/2=55)
  assert.equal(largestAffordableBatch(cumTriangular, 55), 10);
  assert.equal(largestAffordableBatch(cumTriangular, 54), 9);
  assert.equal(largestAffordableBatch(cumTriangular, 0), 0);
});

test("largestAffordableBatch: marginal ceiling caps the batch", () => {
  // marginal(n) = n; ceiling 5 -> n<=5 regardless of a huge budget
  assert.equal(largestAffordableBatch(cumTriangular, 1e9, 5), 5);
});

test("largestAffordableBatch: exact exponential/binary result vs brute force", () => {
  const cost = (n) => Math.floor(n ** 1.7); // some increasing curve
  for (const budget of [0, 1, 10, 100, 1000, 99999]) {
    let brute = 0;
    while (cost(brute + 1) <= budget) brute++;
    assert.equal(largestAffordableBatch(cost, budget), brute, "budget=" + budget);
  }
});
