import test from "node:test";
import assert from "node:assert/strict";
import {
  hashDollarValue, paybackSeconds, paybackOk, parseCtl, ctlToStr, spendCeiling,
} from "../lib/hacknet-budget.js";

test("hashDollarValue: $1e6 / 4 hashes = $250k", () => {
  assert.equal(hashDollarValue(4), 250000);
  assert.equal(hashDollarValue(0), 0);
});

test("paybackSeconds: cost / (gain*value); Infinity when no gain", () => {
  // upgrade costs $1e9, adds 0.1 hash/s, hash worth $250k -> $25k/s -> 40,000s
  assert.equal(paybackSeconds(1e9, 0.1, 250000), 40000);
  assert.equal(paybackSeconds(1e9, 0, 250000), Infinity);
});

test("paybackOk: gate by threshold", () => {
  assert.equal(paybackOk(1e9, 0.1, 250000, 41000), true);
  assert.equal(paybackOk(1e9, 0.1, 250000, 39000), false);
  assert.equal(paybackOk(1e9, 0, 250000, 1e9), false); // no gain never ok
});

test("parseCtl: fail-safe to paused", () => {
  assert.deepEqual(parseCtl(""), { mode: "paused", budget: 0 });
  assert.deepEqual(parseCtl("garbage"), { mode: "paused", budget: 0 });
  assert.deepEqual(parseCtl(null), { mode: "paused", budget: 0 });
  assert.deepEqual(parseCtl("paused"), { mode: "paused", budget: 0 });
  assert.deepEqual(parseCtl("payback"), { mode: "payback", budget: 0 });
  assert.deepEqual(parseCtl("budget:500e9"), { mode: "budget", budget: 500e9 });
  assert.deepEqual(parseCtl("budget: 100000"), { mode: "budget", budget: 100000 });
  assert.deepEqual(parseCtl("budget:0"), { mode: "paused", budget: 0 });   // 0 budget = paused
  assert.deepEqual(parseCtl('{"mode":"payback"}'), { mode: "payback", budget: 0 });
  assert.deepEqual(parseCtl('{"mode":"budget","budget":250}'), { mode: "budget", budget: 250 });
  assert.deepEqual(parseCtl("{bad json"), { mode: "paused", budget: 0 });
});

test("ctlToStr: round-trips", () => {
  for (const s of ["paused", "payback", "budget:500000"]) assert.equal(ctlToStr(parseCtl(s)), s);
});

test("spendCeiling: paused=0, payback=spendable, budget=min(budget,spendable), reserve honored", () => {
  assert.equal(spendCeiling("paused", 0, 1e12, 1e9), 0);
  assert.equal(spendCeiling("payback", 0, 1e12, 1e9), 1e12 - 1e9);
  assert.equal(spendCeiling("budget", 100e9, 1e12, 1e9), 100e9);          // budget < spendable
  assert.equal(spendCeiling("budget", 5e12, 1e12, 1e9), 1e12 - 1e9);      // spendable < budget -> clamp
  assert.equal(spendCeiling("payback", 0, 5e8, 1e9), 0);                  // cash below reserve -> 0
});
