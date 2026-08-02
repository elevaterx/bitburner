import test from "node:test";
import assert from "node:assert/strict";
import { MODULES, WORKER_JOBS, MODES, relevantModules, parseStatus, formatStatus, statusPath, argsEqual, activeRelaunchMode } from "../lib/modules.js";

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

test("WORKER_JOBS: well-formed; hacknet carries a status key", () => {
  assert.ok(WORKER_JOBS.length >= 1);
  for (const j of WORKER_JOBS) { assert.ok(j.file.endsWith(".js")); assert.ok(j.label); if (j.key) assert.equal(typeof j.key, "string"); }
  assert.equal(WORKER_JOBS.find((j) => j.file === "hacknet.js").key, "hacknet");
});

test("argsEqual: string-wise, order-sensitive", () => {
  assert.equal(argsEqual([], []), true);
  assert.equal(argsEqual(["income"], ["income"]), true);
  assert.equal(argsEqual(["1000"], [1000]), true);           // number vs string
  assert.equal(argsEqual(["--aug-frac", "0.01"], ["--aug-frac", "0.01"]), true);
  assert.equal(argsEqual(["a"], ["a", "b"]), false);
  assert.equal(argsEqual(["a", "b"], ["b", "a"]), false);
});

test("activeRelaunchMode: matches running args to a mode", () => {
  const opts = MODES["coordinator.js"].options;
  assert.equal(activeRelaunchMode(opts, ["repgrind"]), 2);
  assert.equal(activeRelaunchMode(opts, ["income"]), 0);
  assert.equal(activeRelaunchMode(opts, ["nonsense"]), -1);
  const gang = MODES["gang.js"].options;
  assert.equal(activeRelaunchMode(gang, []), 0);              // default = Warfare (no args)
  assert.equal(activeRelaunchMode(gang, ["--no-warfare"]), 1);
});

test("MODES: hacknet is a write-control (paused/payback/budget)", () => {
  assert.equal(MODES["hacknet.js"].type, "write");
  assert.equal(MODES["hacknet.js"].file, "hacknet-ctl.txt");
  const labels = MODES["hacknet.js"].options.map((o) => o.label);
  assert.ok(labels.includes("Pause") && labels.includes("Payback"));
});

test("formatStatus: line + staleness", () => {
  assert.equal(formatStatus(null), "-");
  assert.equal(formatStatus({ line: "12 members" }), "12 members");
  assert.equal(formatStatus({ line: "run", t: 1000 }, 1000 + 5000), "run");        // fresh
  assert.equal(formatStatus({ line: "run", t: 1000 }, 1000 + 45000), "run (45s old)"); // stale
  assert.equal(formatStatus({ t: 1000 }, 1000), "running");                          // default line
});
