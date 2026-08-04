import test from "node:test";
import assert from "node:assert/strict";
import {
  selectTaskNames, gangObjective, needsWantedControl, chooseTask,
  shouldAscend, equipmentToBuy, shouldWarfare, avgCombat, DEFAULT_GANG_CFG,
  ascendGain, ascendRespectCost, projectedWantedPenalty, planAscensions,
} from "../lib/gang-logic.js";

// Minimal combat-gang task stats fixture.
const COMBAT_TASKS = [
  { name: "Train Combat", isHacking: false, isCombat: true, baseMoney: 0, baseRespect: 0, baseWanted: 0 },
  { name: "Mug People", isHacking: false, isCombat: true, baseMoney: 1, baseRespect: 0.5, baseWanted: 0.1 },
  { name: "Human Trafficking", isHacking: false, isCombat: true, baseMoney: 100, baseRespect: 8, baseWanted: 6 },
  { name: "Terrorism", isHacking: false, isCombat: true, baseMoney: 0, baseRespect: 20, baseWanted: 10 },
  { name: "Vigilante Justice", isHacking: false, isCombat: true, baseMoney: 0, baseRespect: 0, baseWanted: -8 },
  // a hacking task that must be ignored for a combat gang:
  { name: "Money Laundering", isHacking: true, isCombat: false, baseMoney: 999, baseRespect: 999, baseWanted: 999 },
];

test("selectTaskNames: data-driven, type-filtered", () => {
  const t = selectTaskNames(COMBAT_TASKS, false);
  assert.equal(t.money, "Human Trafficking");   // highest baseMoney among combat tasks
  assert.equal(t.respect, "Terrorism");         // highest baseRespect
  assert.equal(t.wanted, "Vigilante Justice");  // most negative baseWanted
  assert.equal(t.train, "Train Combat");
});

test("gangObjective: respect until full, then money", () => {
  assert.equal(gangObjective({}, 5), "respect");
  assert.equal(gangObjective({}, 12), "money");
});

test("needsWantedControl: only with real wanted and low penalty", () => {
  assert.equal(needsWantedControl({ wantedLevel: 50, wantedPenalty: 0.5 }), true);
  assert.equal(needsWantedControl({ wantedLevel: 50, wantedPenalty: 0.99 }), false);
  assert.equal(needsWantedControl({ wantedLevel: 2, wantedPenalty: 0.1 }), false);
});

test("chooseTask: train -> earn, and forceWanted override", () => {
  const names = selectTaskNames(COMBAT_TASKS, false);
  const green = { str: 400, def: 400, dex: 400, agi: 400, hack: 0 };
  const raw = { str: 10, def: 10, dex: 10, agi: 10, hack: 0 };
  assert.equal(avgCombat(green), 400);
  assert.equal(chooseTask(raw, {}, { isHacking: false, objective: "money", taskNames: names }), "Train Combat");
  assert.equal(chooseTask(green, {}, { isHacking: false, objective: "money", taskNames: names }), "Human Trafficking");
  assert.equal(chooseTask(green, {}, { isHacking: false, objective: "respect", taskNames: names }), "Terrorism");
  assert.equal(chooseTask(green, {}, { isHacking: false, objective: "money", forceWanted: true, taskNames: names }), "Vigilante Justice");
});

test("shouldAscend: relevant-stat factor vs threshold", () => {
  assert.equal(shouldAscend({ str: 1.6, def: 1.1, dex: 1.1, agi: 1.1, hack: 1 }, false), true);
  assert.equal(shouldAscend({ str: 1.2, def: 1.1, dex: 1.1, agi: 1.1, hack: 9 }, false), false); // hack irrelevant to combat gang
  assert.equal(shouldAscend({ hack: 2.0, str: 1 }, true), true);
  assert.equal(shouldAscend(undefined, false), false);
});

test("equipmentToBuy: relevant, unowned, cheapest first", () => {
  const member = { upgrades: ["Baseball Bat"], augmentations: [] };
  const equip = [
    { name: "Baseball Bat", cost: 100, type: "Weapon", stats: { str: 4 } },   // owned
    { name: "Katana", cost: 300, type: "Weapon", stats: { str: 10, def: 10 } },
    { name: "NUKE Rootkit", cost: 50, type: "Rootkit", stats: { hack: 5 } },   // irrelevant to combat gang
    { name: "Bionic Arms", cost: 200, type: "Augmentation", stats: { str: 20 } },
  ];
  const buy = equipmentToBuy(member, equip, false).map((e) => e.name);
  assert.deepEqual(buy, ["Bionic Arms", "Katana"]); // rootkit dropped, owned dropped, sorted by cost
});

test("shouldWarfare: engage only when we beat every territory holder", () => {
  const others = { "Slum Snakes": { power: 1, territory: 0.3 }, "Tetrads": { power: 1, territory: 0.4 } };
  const win = { "Slum Snakes": 0.8, "Tetrads": 0.7 };
  const lose = { "Slum Snakes": 0.8, "Tetrads": 0.4 };
  assert.equal(shouldWarfare("The Syndicate", others, win), true);
  assert.equal(shouldWarfare("The Syndicate", others, lose), false);
  // we own everything -> no clashes
  assert.equal(shouldWarfare("The Syndicate", { "Slum Snakes": { territory: 0 } }, {}), false);
});

// ---------------------------------------------------------------------------
// Ascension planning. Costs verified against v3.0.2:
//   Gang.ts:357     getWantedPenalty() = respect / (respect + wanted)
//   Gang.ts:390-393 ascendMember: respect = max(1, respect - res.respect)
//   GangMember.ts:298-341 ascend(): zeroes every *_exp, empties upgrades, returns earnedRespect
// ---------------------------------------------------------------------------

test("ascendGain: max relevant factor, 0 when the member cannot ascend", () => {
  assert.equal(ascendGain({ str: 1.6, def: 1.1, dex: 1.1, agi: 1.1, hack: 9 }, false), 1.6);
  assert.equal(ascendGain({ hack: 2.0, str: 9 }, true), 2.0);
  assert.equal(ascendGain(undefined, false), 0);      // getAscensionResult returns undefined
  assert.equal(ascendGain({}, true), 0);              // no finite factors
});

test("ascendRespectCost: prefers asc.respect, falls back to earnedRespect, never negative", () => {
  assert.equal(ascendRespectCost({ asc: { respect: 500 }, earnedRespect: 9 }), 500);
  assert.equal(ascendRespectCost({ asc: { hack: 2 }, earnedRespect: 42 }), 42);
  assert.equal(ascendRespectCost({ asc: null }), 0);
  assert.equal(ascendRespectCost({ asc: { respect: -5 }, earnedRespect: 7 }), 7);
});

test("projectedWantedPenalty: matches Gang.getWantedPenalty and floors respect at 1", () => {
  // The user's live numbers: 4.57m respect, 106 wanted -> effectively no penalty.
  const p = projectedWantedPenalty(4_570_000, 106, 0);
  assert.ok(Math.abs(p - 4_570_000 / 4_570_106) < 1e-12);
  assert.ok(p > 0.9999);
  // Draining all respect floors at 1, which is what makes wanted suddenly matter.
  assert.ok(Math.abs(projectedWantedPenalty(1000, 106, 5000) - 1 / 107) < 1e-12);
  assert.equal(projectedWantedPenalty(1000, 0, 0), 1);
});

test("planAscensions: threshold filter, best-gain-first, cheaper breaks ties", () => {
  const gang = { respect: 1e9, wantedLevel: 0 };
  const r = planAscensions([
    { name: "a", asc: { hack: 1.2, respect: 1 } },        // below threshold
    { name: "b", asc: { hack: 2.0, respect: 900 } },
    { name: "c", asc: { hack: 2.0, respect: 100 } },      // same gain, cheaper -> first
  ], gang, true, { ...DEFAULT_GANG_CFG, ascendMaxPerTick: 10 });
  assert.deepEqual(r.ascend, ["c", "b"]);
  assert.equal(r.skipped.length, 0);                      // 'a' never entered the ranking
});

test("planAscensions: per-tick cap staggers the retraining downtime", () => {
  const gang = { respect: 1e9, wantedLevel: 0 };
  const cands = ["a", "b", "c", "d"].map((n) => ({ name: n, asc: { hack: 2.0, respect: 10 } }));
  const r = planAscensions(cands, gang, true, DEFAULT_GANG_CFG);   // ascendMaxPerTick: 2
  assert.equal(r.ascend.length, 2);
  assert.equal(r.skipped.length, 2);
  assert.ok(r.skipped.every((s) => s.reason === "per-tick cap"));
});

test("planAscensions: stops before the projected wanted penalty breaks the floor", () => {
  // respect 100k, wanted 100 -> penalty 0.999, comfortably over the 0.95 floor.
  // Ascending 'a' (cost 99k) would leave respect 1000 -> 1000/1100 = 0.909, under it.
  const gang = { respect: 100_000, wantedLevel: 100 };
  const r = planAscensions([
    { name: "a", asc: { hack: 3.0, respect: 99_000 } },
    { name: "b", asc: { hack: 2.0, respect: 0 } },        // free -> still allowed
  ], gang, true, { ...DEFAULT_GANG_CFG, ascendMaxPerTick: 10 });
  assert.deepEqual(r.ascend, ["b"]);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].name, "a");
  assert.ok(r.skipped[0].reason.startsWith("penalty floor"));
});

test("planAscensions: an already-sub-floor gang is not deadlocked -- free ascensions still pass", () => {
  // Opening penalty is 1000/1100 = 0.909, already under the 0.95 floor. A hard floor would
  // refuse everything forever; the effective floor clamps to the current penalty instead.
  const gang = { respect: 1000, wantedLevel: 100 };
  const r = planAscensions([
    { name: "a", asc: { hack: 3.0, respect: 900 } },      // would drop it to 0.50 -> still blocked
    { name: "b", asc: { hack: 2.0, respect: 0 } },        // costs nothing -> must be allowed
  ], gang, true, { ...DEFAULT_GANG_CFG, ascendMaxPerTick: 10 });
  assert.deepEqual(r.ascend, ["b"]);
  assert.equal(r.skipped[0].name, "a");
  assert.ok(r.skipped[0].reason.startsWith("penalty floor"));
});

test("planAscensions: the floor is checked against RUNNING respect, not the opening balance", () => {
  // Each of these alone is fine; together they'd drop respect to 200 -> penalty 200/300 = 0.67.
  const gang = { respect: 10_000, wantedLevel: 100 };
  const r = planAscensions([
    { name: "a", asc: { hack: 3.0, respect: 4900 } },
    { name: "b", asc: { hack: 2.0, respect: 4900 } },
  ], gang, true, { ...DEFAULT_GANG_CFG, ascendMaxPerTick: 10, ascendPenaltyFloor: 0.95 });
  assert.deepEqual(r.ascend, ["a"]);                       // 5100/5200 = 0.981, ok
  assert.equal(r.skipped[0].name, "b");                    // 200/300 = 0.667, blocked
});

test("planAscensions: never ascends the designated wanted-reducer", () => {
  const gang = { respect: 1e9, wantedLevel: 0 };
  const r = planAscensions([
    { name: "reducer", asc: { hack: 5.0, respect: 0 }, isReducer: true },
    { name: "b", asc: { hack: 2.0, respect: 0 } },
  ], gang, true, { ...DEFAULT_GANG_CFG, ascendMaxPerTick: 10 });
  assert.deepEqual(r.ascend, ["b"]);
  assert.equal(r.skipped[0].reason, "wanted-reducer");
});

test("planAscensions: empty / no-candidate inputs are safe", () => {
  const gang = { respect: 1000, wantedLevel: 10 };
  assert.deepEqual(planAscensions([], gang, true), { ascend: [], skipped: [] });
  assert.deepEqual(planAscensions(null, gang, true), { ascend: [], skipped: [] });
  assert.deepEqual(planAscensions([{ name: "a", asc: undefined }], gang, true), { ascend: [], skipped: [] });
});

test("planAscensions: the live-gang case -- 106 wanted against millions of respect blocks nothing", () => {
  const gang = { respect: 4_570_000, wantedLevel: 106 };
  const r = planAscensions([
    { name: "a", asc: { hack: 2.0, respect: 400_000 } },
    { name: "b", asc: { hack: 1.9, respect: 400_000 } },
  ], gang, true, { ...DEFAULT_GANG_CFG, ascendMaxPerTick: 10 });
  assert.deepEqual(r.ascend, ["a", "b"]);
});
