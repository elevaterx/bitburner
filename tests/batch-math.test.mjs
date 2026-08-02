/** Demonstrates the renovation applies to EXISTING pure code too: batch-math.js was written
 *  ns-free precisely so it could be tested, but had no harness. Now it does. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  hackThreadsForFraction, weakenThreadsForSecurity, growMultiplierToMax,
  batchOffsets, landTimes, HACK_SEC_PER_THREAD,
} from "../batch-math.js";

test("hackThreadsForFraction: floor, min 1, guards zero pct", () => {
  assert.equal(hackThreadsForFraction(0.5, 0.01), 50);
  assert.equal(hackThreadsForFraction(0.001, 0.01), 1); // min 1
  assert.equal(hackThreadsForFraction(0.5, 0), 0);      // guard
});

test("weakenThreadsForSecurity: ceil", () => {
  assert.equal(weakenThreadsForSecurity(0.05, 0.05), 1);
  assert.equal(weakenThreadsForSecurity(0.06, 0.05), 2);
});

test("growMultiplierToMax", () => {
  assert.equal(growMultiplierToMax(500, 1000), 2);
  assert.equal(growMultiplierToMax(1000, 1000), 1);
});

test("batch landing order: H < W1 < G < W2, gap apart", () => {
  const weakenT = 1000, growT = 800, hackT = 250, gap = 100;
  const land = landTimes(weakenT, growT, hackT, gap);
  assert.ok(land.hack < land.weaken1);
  assert.ok(land.weaken1 < land.grow);
  assert.ok(land.grow < land.weaken2);
  assert.equal(Math.round(land.weaken1 - land.hack), gap);
  assert.equal(Math.round(land.weaken2 - land.grow), gap);
  const o = batchOffsets(weakenT, growT, hackT, gap);
  assert.equal(o.batchDuration, weakenT + 4 * gap);
});

test("HACK_SEC_PER_THREAD constant sanity", () => {
  assert.equal(HACK_SEC_PER_THREAD, 0.002);
});
