import test from "node:test";
import assert from "node:assert/strict";
import {
  selectTaskNames, gangObjective, needsWantedControl, chooseTask,
  shouldAscend, equipmentToBuy, shouldWarfare, avgCombat, DEFAULT_GANG_CFG,
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
