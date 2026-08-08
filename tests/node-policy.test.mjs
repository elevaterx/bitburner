import test from "node:test";
import assert from "node:assert/strict";
import { hackMoneyIndex, hackMoneyLive, nodePolicy, policyLines, DEAD_HACK_THRESHOLD }
  from "../lib/node-policy.js";

// Real BitNode multiplier products, so the thresholds are checked against the game, not a fixture.
const BN = {
  vanilla: {},                                                     // 1.000
  BN2: { ScriptHackMoneyGain: 1, ServerMaxMoney: 0.08 },           // 0.080
  BN3: { ScriptHackMoneyGain: 1, ServerMaxMoney: 0.04 },           // 0.040
  BN8: { ScriptHackMoneyGain: 0, ServerMaxMoney: 1 },              // 0.000
  BN9: { ScriptHackMoneyGain: 1, ServerMaxMoney: 0.01 },           // 0.010
  BN12r1: { ScriptHackMoneyGain: 1, ServerMaxMoney: 1 },           // 1.000 -- run #1, no penalties
};

test("hackMoneyIndex: the one definition, and it degrades to vanilla", () => {
  assert.equal(hackMoneyIndex(BN.vanilla), 1);
  assert.ok(Math.abs(hackMoneyIndex(BN.BN2) - 0.08) < 1e-12);
  assert.ok(Math.abs(hackMoneyIndex(BN.BN3) - 0.04) < 1e-12);
  assert.equal(hackMoneyIndex(BN.BN8), 0);
  assert.equal(hackMoneyIndex(BN.BN12r1), 1);
  // a missing SF5 must read as "assume allowed", never as "silently disable the farm"
  assert.equal(hackMoneyIndex(null), 1);
  assert.equal(hackMoneyIndex({ ScriptHackMoneyGain: NaN }), 1);
});

test("the 0.05 cutoff splits the nodes the way the suite already assumes", () => {
  assert.equal(DEAD_HACK_THRESHOLD, 0.05);
  for (const n of ["vanilla", "BN2", "BN12r1"]) assert.equal(hackMoneyLive(BN[n]), true, n);
  for (const n of ["BN3", "BN8", "BN9"]) assert.equal(hackMoneyLive(BN[n]), false, n);
});

test("gang: an income SUBSTITUTE, so only where the farm is dead", () => {
  const sf = { 2: 1 };
  // BN3 -- the farm is dead, the gang carried the whole node
  assert.equal(nodePolicy({ mults: BN.BN3, sourceFiles: sf }).gang.on, true);
  // BN12 run #1 -- this is the live failure: the karma gate ran anyway and sing did nothing for 4.2h
  const bn12 = nodePolicy({ mults: BN.BN12r1, sourceFiles: sf }).gang;
  assert.equal(bn12.on, false);
  assert.match(bn12.reason, /28h|farm earns/);
  // no SF2 -> impossible regardless
  assert.equal(nodePolicy({ mults: BN.BN3, sourceFiles: {} }).gang.on, false);
  // BN2 grants gangs without SF2
  assert.equal(nodePolicy({ mults: BN.BN2, bitNode: 2, sourceFiles: {} }).gang.on, true);
});

test("an engine you ALREADY have is always kept -- both survive installs", () => {
  const sf = { 2: 1, 3: 1 };
  // the policy is about whether to ESTABLISH one, never about tearing down a free earner
  const p = nodePolicy({ mults: BN.BN12r1, sourceFiles: sf, hasGang: true, hasCorp: true });
  assert.equal(p.gang.on, true);
  assert.equal(p.corp.on, true);
  assert.match(p.gang.reason, /already/);
  assert.match(p.corp.reason, /already/);
});

test("corp: gated on RAM as well as node, because it is a ~564GB resident", () => {
  const sf = { 3: 1 };
  assert.equal(nodePolicy({ mults: BN.BN3, sourceFiles: sf, homeRamGB: 2000 }).corp.on, true);
  const tight = nodePolicy({ mults: BN.BN3, sourceFiles: sf, homeRamGB: 400 }).corp;
  assert.equal(tight.on, false);
  assert.match(tight.reason, /564GB|400GB/);
});

test("stocks are never gated on hacking -- they compound independently", () => {
  assert.equal(nodePolicy({ mults: BN.BN8, bitNode: 8, sourceFiles: {} }).stocks.on, true);
  assert.equal(nodePolicy({ mults: BN.BN12r1, sourceFiles: { 8: 1 } }).stocks.on, true);
  assert.equal(nodePolicy({ mults: BN.BN12r1, sourceFiles: {} }).stocks.on, false);
});

test("sourceFiles accepts a Map (getResetInfo().ownedSF) as well as an object", () => {
  const asMap = new Map([[2, 1], [3, 1], [8, 1]]);
  const a = nodePolicy({ mults: BN.BN3, sourceFiles: asMap });
  const b = nodePolicy({ mults: BN.BN3, sourceFiles: { 2: 1, 3: 1, 8: 1 } });
  assert.equal(a.gang.on, b.gang.on);
  assert.equal(a.stocks.on, b.stocks.on);
});

test("every decision carries a reason -- that is the point of the module", () => {
  const p = nodePolicy({ mults: BN.BN12r1, sourceFiles: { 2: 1, 3: 1, 8: 1 } });
  for (const k of ["hackFarm", "gang", "corp", "stocks"]) {
    assert.ok(typeof p[k].reason === "string" && p[k].reason.length > 10, k + " has no reason");
  }
  const lines = policyLines(p);
  assert.equal(lines.length, 4);
  // "off by policy" must be visibly different from a bare off-switch
  assert.ok(lines.some((l) => /off/.test(l) && /farm earns/.test(l)));
});
