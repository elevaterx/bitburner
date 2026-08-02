import test from "node:test";
import assert from "node:assert/strict";
import { chooseSleeveAction, actionMatchesTask, affordableSleeveAugs } from "../lib/sleeve-logic.js";

test("chooseSleeveAction: sync -> shock -> crime priority", () => {
  assert.deepEqual(chooseSleeveAction({ sync: 40, shock: 90 }), { type: "sync" });
  assert.deepEqual(chooseSleeveAction({ sync: 100, shock: 90 }), { type: "shock" });
  assert.deepEqual(chooseSleeveAction({ sync: 100, shock: 0 }), { type: "crime", crime: "Homicide" });
});

test("chooseSleeveAction: honors cfg overrides", () => {
  const cfg = { syncTarget: 100, maxShock: 50, crime: "Mug" };
  assert.deepEqual(chooseSleeveAction({ sync: 100, shock: 40 }, cfg), { type: "crime", crime: "Mug" });
  assert.deepEqual(chooseSleeveAction({ sync: 100, shock: 60 }, cfg), { type: "shock" });
});

test("actionMatchesTask: avoids redundant setTo calls", () => {
  assert.equal(actionMatchesTask({ type: "crime", crime: "Homicide" }, { type: "CRIME", crimeType: "Homicide" }), true);
  assert.equal(actionMatchesTask({ type: "crime", crime: "Homicide" }, { type: "CRIME", crimeType: "Mug" }), false);
  assert.equal(actionMatchesTask({ type: "sync" }, { type: "SYNCHRO" }), true);
  assert.equal(actionMatchesTask({ type: "shock" }, { type: "RECOVERY" }), true);
  assert.equal(actionMatchesTask({ type: "shock" }, null), false);
});

test("affordableSleeveAugs: cheapest-first within budget", () => {
  const augs = [{ name: "A", cost: 500 }, { name: "B", cost: 100 }, { name: "C", cost: 300 }];
  assert.deepEqual(affordableSleeveAugs(augs, 450), ["B", "C"]);   // 100 + 300 = 400 <= 450, A too dear
  assert.deepEqual(affordableSleeveAugs(augs, 900), ["B", "C", "A"]);
  assert.deepEqual(affordableSleeveAugs(augs, 50), []);
});
