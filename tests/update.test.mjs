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
