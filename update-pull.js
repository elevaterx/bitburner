/** update-pull.js -- fetch ONLY pull.js from the repo and overwrite the local copy.
 *
 *  Why this exists: pull.js cannot update itself. A running script can't overwrite its own file
 *  (the write is deferred and discarded on reload), so pull.js excludes itself from its own fetch
 *  list. This separate script does the job instead: because update-pull.js is the running script
 *  (not pull.js), the write to pull.js lands cleanly -- no reload, no perpetual "changed" loop.
 *
 *  Run this only when pull.js itself has changed in the repo. For everything else, use pull.js.
 *
 *  usage:  run update-pull.js
 *  @param {NS} ns */
export async function main(ns) {
  const USER = "elevaterx";
  const REPO = "bitburner";
  const BRANCH = "main";
  const url = "https://raw.githubusercontent.com/" + USER + "/" + REPO + "/" + BRANCH + "/pull.js?ts=" + Date.now();

  // make sure pull.js isn't somehow running (it shouldn't be -- it's run-once -- but be safe)
  for (const p of ns.ps("home")) {
    if (p.filename === "pull.js") { ns.kill(p.pid); }
  }
  await ns.sleep(200);

  const before = ns.fileExists("pull.js", "home") ? ns.read("pull.js") : null;
  const got = await ns.wget(url, "pull.js");
  if (!got) { ns.tprint("update-pull: FETCH FAILED -- pull.js not updated (network/repo issue?)"); return; }
  const after = ns.read("pull.js");

  if (before === after) {
    ns.tprint("update-pull: pull.js already current (no change).");
  } else {
    ns.tprint("update-pull: pull.js UPDATED on disk (" + (before ? before.split("\n").length : 0) +
              " -> " + after.split("\n").length + " lines). No reload needed -- run pull.js when ready.");
  }
}
