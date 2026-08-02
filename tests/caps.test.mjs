import test from "node:test";
import assert from "node:assert/strict";
import { sfLevel, hasApi, capabilitiesFrom } from "../lib/caps.js";

const withMap = (node, sfPairs) => ({ currentNode: node, ownedSF: new Map(sfPairs) });

test("sfLevel: Map, array, and object shapes", () => {
  assert.equal(sfLevel({ ownedSF: new Map([[4, 3]]) }, 4), 3);
  assert.equal(sfLevel({ ownedSF: [[10, 1]] }, 10), 1);
  assert.equal(sfLevel({ ownedSF: { 2: 2 } }, 2), 2);
  assert.equal(sfLevel({ ownedSF: new Map() }, 4), 0);
  assert.equal(sfLevel({}, 4), 0);
});

test("hasApi: current node grants access", () => {
  assert.equal(hasApi(withMap(2, []), { nodes: [2], sf: [2] }), true);
  assert.equal(hasApi(withMap(1, []), { nodes: [2], sf: [2] }), false);
});

test("hasApi: owned source file grants access elsewhere", () => {
  assert.equal(hasApi(withMap(1, [[2, 1]]), { nodes: [2], sf: [2] }), true);
  assert.equal(hasApi(withMap(1, [[6, 1]]), { nodes: [6, 7], sf: [6, 7] }), true);
});

test("capabilitiesFrom: BN10 grants sleeves, not corp", () => {
  const c = capabilitiesFrom(withMap(10, []));
  assert.equal(c.sleeves, true);
  assert.equal(c.corporation, false);
  assert.equal(c.go, true);
  assert.equal(c.node, 10);
});

test("capabilitiesFrom: SF-4 grants singularity in any node", () => {
  const c = capabilitiesFrom(withMap(1, [[4, 1]]));
  assert.equal(c.singularity, true);
  assert.equal(c.gang, false);
});
