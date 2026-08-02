/** update.js -- self-discovering repo updater. Replaces pull.js + update-pull.js.
 *
 *  Fetches the repo file tree from the GitHub API (NO hardcoded manifest -> new files are picked up
 *  automatically), then downloads every script/text file, overwriting in place.
 *
 *  WHY THERE'S NO KILL-ALL AND NO SEPARATE SELF-UPDATE STEP:
 *  Overwriting a RUNNING script's file is fine in Bitburner v3. Verified against the game source
 *  (BaseServer.writeToScriptFile -> Script's `content` setter): the write persists to disk (it's part
 *  of the save) and invalidates the script's compiled module. There is no lock and nothing is
 *  discarded on reload. The running instance keeps its already-loaded code until it stops; the new
 *  code takes effect the next time that script starts. So update.js can overwrite itself too -- the
 *  old pull.js "kill everything first / reload to finish" dance was unnecessary.
 *
 *  usage:
 *    run update.js              discover + download everything; report new/changed files
 *    run update.js --dry        fetch the tree and list files (marking ones new to your machine); no writes
 *    run update.js --restart    after updating, kill managed scripts and relaunch boot.js so new code is live now
 *
 *  First-time bootstrap (terminal):
 *    wget https://raw.githubusercontent.com/elevaterx/bitburner/main/update.js update.js
 *    run update.js
 *
 *  @param {NS} ns */

// ---- edit these three to match your repo ----
const USER = "elevaterx";
const REPO = "bitburner";
const BRANCH = "main";

const EXCLUDE_PREFIXES = ["tests/", "node_modules/", "_to_delete/"];
const TREE_TMP = "update-tree.txt"; // temp landing for the tree JSON (.txt so wget accepts it)

/** Should this tree entry be pulled into the game? Pure + exported for tests.
 *  Keeps .js/.txt blobs; drops directories, dotfiles, tests/build cruft. */
export function isWanted(path, type) {
  if (type !== "blob") return false;
  if (path.startsWith(".")) return false;
  if (!(path.endsWith(".js") || path.endsWith(".txt"))) return false;
  for (const ex of EXCLUDE_PREFIXES) if (path.startsWith(ex)) return false;
  return true;
}

/** Map a GitHub tree payload to the list of wanted paths. Pure + exported for tests. */
export function filterRepoFiles(treeEntries) {
  return (treeEntries || []).filter((e) => isWanted(e.path, e.type)).map((e) => e.path);
}

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("ALL");
  const flags = ns.flags([["dry", false], ["restart", false]]);
  const say = (m) => ns.tprint("[update] " + m);
  const bust = () => "?nocache=" + Date.now();

  // 1. Discover the file tree via the GitHub API (a branch name resolves to its tree).
  const treeUrl = `https://api.github.com/repos/${USER}/${REPO}/git/trees/${BRANCH}?recursive=1`;
  if (!(await ns.wget(treeUrl + "&nocache=" + Date.now(), TREE_TMP))) {
    say("FAILED to fetch the repo tree from api.github.com. Is the repo public and the API reachable?");
    return;
  }
  let tree;
  try { tree = JSON.parse(ns.read(TREE_TMP)); }
  catch (e) { say("could not parse the tree JSON: " + e); ns.rm(TREE_TMP, "home"); return; }
  ns.rm(TREE_TMP, "home");

  if (tree.message) { say("GitHub API error: " + tree.message); return; } // rate limit / not found / private
  if (tree.truncated) say("WARNING: GitHub truncated the tree (very large repo) -- some files may be missed.");

  const files = filterRepoFiles(tree.tree);
  if (!files.length) { say("no script/text files found in the tree -- nothing to do."); return; }

  const base = `https://raw.githubusercontent.com/${USER}/${REPO}/${BRANCH}/`;

  // 2a. Dry run: just list, mark files not present locally. No downloads, no writes.
  if (flags.dry) {
    const fresh = files.filter((p) => !ns.fileExists(p, "home"));
    say(`[DRY] tree has ${files.length} file(s); ${fresh.length} not present locally:` + listOf(fresh.length ? fresh : ["(all already present)"]));
    say("dry run -- nothing written. Run without --dry to download.");
    return;
  }

  // 2b. Real: download every file, categorising new/changed/unchanged/failed.
  const me = ns.getScriptName();
  const isNew = [], changed = [], failed = [];
  let unchanged = 0, selfChanged = false;
  for (const path of files) {
    const existed = ns.fileExists(path, "home");
    const before = existed ? ns.read(path) : null;
    if (!(await ns.wget(base + path + bust(), path))) { failed.push(path); continue; }
    const after = ns.read(path);
    if (!existed) isNew.push(path);
    else if (after !== before) { changed.push(path); if (path === me) selfChanged = true; }
    else unchanged++;
  }

  // 3. Report.
  say(`tree ${files.length} | new ${isNew.length}, changed ${changed.length}, unchanged ${unchanged}` +
    (failed.length ? `, FAILED ${failed.length}` : ""));
  if (isNew.length) say("new:" + listOf(isNew));
  if (changed.length) say("changed:" + listOf(changed));
  if (failed.length) say("FAILED (retry / check the path):" + listOf(failed));
  if (selfChanged) say("update.js updated itself -- the new version runs next time you `run update.js` (this run finished on the old copy; expected).");

  // 4. Optional restart so the new code is live immediately.
  if (flags.restart) {
    say("restarting stack: killing managed scripts, then boot.js ...");
    for (const h of bfs(ns)) for (const p of ns.ps(h)) if (!(h === "home" && p.filename === me)) ns.kill(p.pid);
    await ns.sleep(400);
    if (ns.fileExists("boot.js", "home")) { ns.run("boot.js"); say("boot.js launched -- stack restarting on the new code."); }
    else say("boot.js not found -- start your stack manually.");
  } else if (isNew.length || changed.length) {
    say("done. Changed files take effect next time each script starts -- `run update.js --restart`, or `run boot.js`, to go live now.");
  } else {
    say("already up to date.");
  }
}

function listOf(arr) { return "\n  " + arr.join("\n  "); }

// BFS the network from home (inline so update.js has no dependencies and bootstraps from one wget).
function bfs(ns) {
  const seen = new Set(["home"]), q = ["home"], out = ["home"];
  while (q.length) { const c = q.shift(); for (const n of ns.scan(c)) if (!seen.has(n)) { seen.add(n); q.push(n); out.push(n); } }
  return out;
}
