import test from "node:test";
import assert from "node:assert/strict";
import { MODULES, relevantModules, parseStatus, formatStatus, statusPath } from "../lib/modules.js";

test("MODULES: covers the five capability modules", () => {
  assert.deepEqual(MODULES.map((m) => m.key).sort(), ["bladeburner", "corp", "gang", "go", "sleeves"]);
  for (const m of MODULES) { assert.ok(m.file.endsWith(".js")); assert.ok(m.cap && m.label); }
});

test("relevantModules: filters by BitNode capabilities", () => {
  const caps = { gang: true, sleeves: false, bladeburner: false, corporation: false, go: true };
  assert.deepEqual(relevantModules(caps).map((m) => m.key).sort(), ["gang", "go"]);
  const all = { gang: true, sleeves: true, bladeburner: true, corporation: true, go: true };
  assert.equal(relevantModules(all).length, 5);
  assert.deepEqual(relevantModules({ go: true }).map((m) => m.key), ["go"]);
});

test("statusPath", () => {
  assert.equal(statusPath("gang"), "status/gang.txt");
});

test("parseStatus: tolerant", () => {
  assert.equal(parseStatus(""), null);
  assert.equal(parseStatus("not json"), null);
  assert.deepEqual(parseStatus('{"line":"3m"}'), { line: "3m" });
});

test("formatStatus: line + staleness", () => {
  assert.equal(formatStatus(null), "-");
  assert.equal(formatStatus({ line: "12 members" }), "12 members");
  assert.equal(formatStatus({ line: "run", t: 1000 }, 1000 + 5000), "run");        // fresh
  assert.equal(formatStatus({ line: "run", t: 1000 }, 1000 + 45000), "run (45s old)"); // stale
  assert.equal(formatStatus({ t: 1000 }, 1000), "running");                          // default line
});
