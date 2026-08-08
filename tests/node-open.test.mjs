import test from "node:test";
import assert from "node:assert/strict";
import { isColdNode, rankCrimes, bestCrime, crimeTarget, etaSeconds, openerStep, TRAVEL_COST, justInstalled, coordPreset, REBUILD_WINDOW_MS }
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

// --- boot's coordinator preset -------------------------------------------------------------------
// `income` and `rebuild` differ in ONE positional arg (xpw). Reading that bit off getResetInfo beats
// making the operator remember `run boot.js 0 0.5 rebuild` after every install.

test("justInstalled reads lastAugReset as an epoch TIMESTAMP, not an elapsed time", () => {
  const now = 1_700_000_000_000;
  // PlayerObject.ts:168 -- lastAugReset = lastNodeReset = Date.now()
  assert.equal(justInstalled({ lastAugReset: now - 5_000 }, now), true);
  assert.equal(justInstalled({ lastAugReset: now - (REBUILD_WINDOW_MS - 1) }, now), true);
  assert.equal(justInstalled({ lastAugReset: now - (REBUILD_WINDOW_MS + 1) }, now), false);
  // PlayerObject.ts:61 -- the field is -1 before init. Must not read as "installed 54 years ago".
  assert.equal(justInstalled({ lastAugReset: -1 }, now), false);
  assert.equal(justInstalled({ lastAugReset: 0 }, now), false);
  assert.equal(justInstalled(null, now), false);
  assert.equal(justInstalled({}, now), false);
  // a clock skewing backwards must not read as installed
  assert.equal(justInstalled({ lastAugReset: now + 60_000 }, now), false);
});

test("a cold BitNode entry counts as a rebuild -- it is the most extreme case there is", () => {
  const now = 1_700_000_000_000;
  // entering a node sets BOTH stamps (prestigeSourceFile calls prestigeAugmentation first)
  assert.equal(coordPreset({ lastAugReset: now, lastNodeReset: now }, now), "rebuild");
  assert.equal(isColdNode({ lastAugReset: now, lastNodeReset: now }), true);
});

test("coordPreset: rebuild inside the window, income outside, income when unknown", () => {
  const now = 1_700_000_000_000;
  assert.equal(coordPreset({ lastAugReset: now - 60_000, lastNodeReset: 0 }, now), "rebuild");
  assert.equal(coordPreset({ lastAugReset: now - 3 * 3600_000, lastNodeReset: 0 }, now), "income");
  // unknown state must fall back to the everyday workhorse, never to a mode that suppresses income
  assert.equal(coordPreset(null, now), "income");
});
