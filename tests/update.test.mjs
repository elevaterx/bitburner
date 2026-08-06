import test from "node:test";
import assert from "node:assert/strict";
import { isWanted, filterRepoFiles } from "../update.js";

test("isWanted: keeps .js/.txt blobs at root and in subdirs", () => {
  assert.equal(isWanted("gang.js", "blob"), true);
  assert.equal(isWanted("lib/net.js", "blob"), true);
  assert.equal(isWanted("version.txt", "blob"), true);
});

test("isWanted: drops directories", () => {
  assert.equal(isWanted("lib", "tree"), false);
  assert.equal(isWanted("tests", "tree"), false);
});

test("isWanted: drops non-game files by extension", () => {
  assert.equal(isWanted("package.json", "blob"), false);
  assert.equal(isWanted("README.md", "blob"), false);
  assert.equal(isWanted("tests/gang.test.mjs", "blob"), false); // .mjs and under tests/
});

test("isWanted: drops excluded prefixes and dotfiles", () => {
  assert.equal(isWanted("tests/foo.js", "blob"), false);
  assert.equal(isWanted("node_modules/x/y.js", "blob"), false);
  assert.equal(isWanted("_to_delete/old.js", "blob"), false);
  assert.equal(isWanted(".gitignore", "blob"), false);
  assert.equal(isWanted(".github/workflows/ci.js", "blob"), false);
});

test("filterRepoFiles: end-to-end over a realistic tree payload", () => {
  const tree = [
    { path: "gang.js", type: "blob" },
    { path: "lib", type: "tree" },
    { path: "lib/net.js", type: "blob" },
    { path: "lib/fmt.js", type: "blob" },
    { path: "tests", type: "tree" },
    { path: "tests/net.test.mjs", type: "blob" },
    { path: "package.json", type: "blob" },
    { path: ".gitignore", type: "blob" },
    { path: "version.txt", type: "blob" },
    { path: "_to_delete/old.js", type: "blob" },
  ];
  assert.deepEqual(filterRepoFiles(tree).sort(), ["gang.js", "lib/fmt.js", "lib/net.js", "version.txt"]);
});

test("filterRepoFiles: tolerates empty/undefined", () => {
  assert.deepEqual(filterRepoFiles(undefined), []);
  assert.deepEqual(filterRepoFiles([]), []);
});

test("isWanted excludes status/ -- the game writes it; it must never be deployed back", () => {
  // The round trip this prevents: game -> rfa-sync -> disk -> git -> update.js -> game.
  // panel-enabled.txt is the sharp edge: config, no timestamp, no ghost guard in readEnabled.
  assert.equal(isWanted("status/panel-enabled.txt", "blob"), false);
  assert.equal(isWanted("status/snapshot.txt", "blob"), false);
  assert.equal(isWanted("status/bb-status.txt", "blob"), false);
  // tools/ is host-side Node, not game scripts -- deploying it just wastes game filesystem
  assert.equal(isWanted("tools/rfa-sync.mjs", "blob"), false);
  // and the things we DO still want are untouched
  assert.equal(isWanted("hud1.js", "blob"), true);
  assert.equal(isWanted("lib/corp-logic.js", "blob"), true);
});
