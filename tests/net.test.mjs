import test from "node:test";
import assert from "node:assert/strict";
import { bfs } from "../lib/net.js";

// Fake ns exposing only scan(), over a small graph:
//   home - n00, home - n01 ; n00 - deep ; (deep also links back to n00)
const graph = {
  home: ["n00", "n01"],
  n00: ["home", "deep"],
  n01: ["home"],
  deep: ["n00"],
};
const fakeNs = { scan: (h) => graph[h] || [] };

test("bfs: visits every host once, home first", () => {
  const out = bfs(fakeNs);
  assert.equal(out[0], "home");
  assert.deepEqual([...out].sort(), ["deep", "home", "n00", "n01"]);
  assert.equal(new Set(out).size, out.length, "no duplicates");
});

test("bfs: isolated home", () => {
  assert.deepEqual(bfs({ scan: () => [] }), ["home"]);
});
