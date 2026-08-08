import test from "node:test";
import assert from "node:assert/strict";
import { isColdNode, rankCrimes, bestCrime, crimeTarget, etaSeconds, openerStep, TRAVEL_COST }
  from "../lib/node-open.js";

test("isColdNode: equal timestamps mean no install since node entry", () => {
  assert.equal(isColdNode({ lastNodeReset: 1000, lastAugReset: 1000 }), true);
  assert.equal(isColdNode({ lastNodeReset: 1000, lastAugReset: 5000 }), false);
  // never trust cash or aug count as the proxy -- the casino leaves you rich inside a cold node
  assert.equal(isColdNode(null), false);
  assert.equal(isColdNode({}), false);
});

test("rankCrimes: expected value per second, not raw payout", () => {
  const crimes = [
    { name: "Shoplift", money: 15e3, time: 2000, chance: 0.90 },   // 6,750/s
    { name: "Homicide", money: 45e3, time: 3000, chance: 0.03 },   //   450/s
    { name: "Heist", money: 120e6, time: 600000, chance: 0.0001 }, //    20/s
  ];
  assert.deepEqual(rankCrimes(crimes).map((c) => c.name), ["Shoplift", "Homicide", "Heist"]);
  assert.equal(bestCrime(crimes).name, "Shoplift");
  // the trap this exists to avoid: Heist has 8000x Shoplift's payout and is by far the worst pick
  assert.ok(rankCrimes(crimes)[0].evPerSec > rankCrimes(crimes)[2].evPerSec * 300);
});

test("rankCrimes: ties break toward the shorter crime", () => {
  const same = [
    { name: "Slow", money: 20e3, time: 4000, chance: 1 },
    { name: "Fast", money: 10e3, time: 2000, chance: 1 },
  ];
  assert.equal(rankCrimes(same)[0].name, "Fast");
});

test("rankCrimes: drops anything that cannot earn", () => {
  assert.deepEqual(rankCrimes([{ name: "Zero", money: 0, time: 1000, chance: 1 }]), []);
  assert.deepEqual(rankCrimes([{ name: "Never", money: 1e6, time: 1000, chance: 0 }]), []);
  assert.deepEqual(rankCrimes(null), []);
});

test("crimeTarget: clears the fare with a buffer", () => {
  assert.equal(TRAVEL_COST, 200e3);
  assert.ok(crimeTarget() > TRAVEL_COST);
  assert.equal(crimeTarget(200e3, 1.25), 250e3);
});

test("etaSeconds is advisory and never returns NaN", () => {
  assert.equal(etaSeconds(null, 1e6), Infinity);
  assert.equal(etaSeconds({ evPerSec: 0 }, 1e6), Infinity);
  assert.equal(etaSeconds({ evPerSec: 1000 }, 250e3), 250);
});

test("openerStep: the full chain, and it is resumable from any point", () => {
  const cold = { cold: true, casinoTarget: 10e9 };
  assert.equal(openerStep({ ...cold, money: 1262, city: "Sector-12" }), "crime");
  assert.equal(openerStep({ ...cold, money: 250e3, city: "Sector-12" }), "travel");
  assert.equal(openerStep({ ...cold, money: 50e3, city: "Aevum" }), "casino");
  assert.equal(openerStep({ ...cold, money: 12e9, city: "Aevum" }), "done");
  assert.equal(openerStep({ cold: false, money: 1262, city: "Sector-12" }), "skip");
});

test("openerStep: already in Aevum but broke still goes to casino, not back to crime", () => {
  // after a save-scum RELOAD the script restarts mid-node; it must not re-run the crime phase just
  // because cash dipped below the fare it already spent
  assert.equal(openerStep({ cold: true, money: 1e3, city: "Aevum", casinoTarget: 10e9 }), "casino");
});
