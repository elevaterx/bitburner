/** pull.js -- fetch all scripts from the repo, overwriting local copies.
 *
 *  DEFAULT BEHAVIOR (changed): kills ALL running scripts fleet-wide (except pull.js itself) BEFORE
 *  fetching. This is required because Bitburner will NOT overwrite a script file that is currently
 *  running -- the write is silently DEFERRED until game reload, which is the trap that made pulls
 *  appear to "not take" (nano kept showing the old version). Killing first means every file is
 *  unlocked when written, so the new code lands on disk immediately. Only pull.js itself can't be
 *  killed mid-run, so ITS own update still needs a reload (reported below).
 *
 *  After a default pull: RELOAD the game (to finish pull.js's self-update), then `run boot.js`.
 *
 *  usage:  run pull.js            kill-all then pull (clean slate; farm stops -> boot.js after)
 *          run pull.js nokill     OLD behavior: pull without killing (deferred writes for running
 *                                 files; use only when fetching files that aren't currently running)
 *
 *  @param {NS} ns */
export async function main(ns) {
  // ---- edit these three once, to match your repo ----
  const USER = "elevaterx";
  const REPO = "bitburner";
  const BRANCH = "main";
  const NOKILL = ns.args[0] === "nokill";
  // pull.js is NOT in this list: a running script cannot overwrite its own file (the write is
  // deferred and discarded on reload), which made pull.js perpetually report itself as "changed."
  // To update pull.js itself, run `update-pull.js` (a separate script -- pull.js isn't running then,
  // so the write lands cleanly). update-pull.js IS pulled here so it stays current.
  const files = [
    "coordinator.js", "prep.js", "h.js", "boot.js",
    "farm-status.js", "status.js", "hud.js",
    "puzzles.js", "purchaser.js", "cleanup.js",
    "xp.js", "xpfarm.js", "sh.js", "shareall.js",
    "diagnose-income.js", "earners.js", "backdoors.js",
    "ramstat.js", "sing.js", "hacknet.js", "digrank.js",
    "hud1.js", "hud2.js", "cloudstat.js", "fatcheck.js",
    "winlayout.js", "arrange.js", "goto.js",
    // --- HWGW batcher ---
    "batch-math.js", "batch-live.js", "sharecap.js",
    "bhack.js", "bgrow.js", "bweaken.js",
    "bprep.js", "bdiag.js", "bbatch.js",
    "killfarm.js", "bbatch2.js", "xpw.js", "trader.js", "casino.js", "augbuy.js", "update-pull.js"
  ];
  const base = "https://raw.githubusercontent.com/" + USER + "/" + REPO + "/" + BRANCH + "/";

  // ---- kill everything (except pull.js) so no file is locked against overwrite ----
  if (!NOKILL) {
    const all = bfs(ns);
    let killed = 0;
    for (const h of all) {
      for (const p of ns.ps(h)) {
        if (h === "home" && p.filename === "pull.js") continue;   // can't kill ourselves mid-run
        ns.kill(p.pid);
        killed++;
      }
    }
    ns.tprint("pull: killed " + killed + " running scripts (clean slate). Files now unlocked for overwrite.");
    await ns.sleep(400);   // let kills settle so the FS releases the file handles before we write
  } else {
    ns.tprint("pull: NOKILL mode -- running files' writes will be DEFERRED until reload.");
  }

  // ---- which files are still running (only matters in NOKILL mode; after a kill-all this is ~empty) ----
  const running = new Set();
  for (const p of ns.ps("home")) running.add(p.filename);

  let ok = 0, miss = 0;
  const changed = [], needReload = [];
  for (const f of files) {
    const before = ns.fileExists(f, "home") ? ns.read(f) : null;
    const got = await ns.wget(base + f + "?ts=" + Date.now(), f);
    if (!got) { miss++; ns.tprint("MISS " + f); continue; }
    ok++;
    const after = ns.read(f);
    if (before !== after) {
      changed.push(f);
      if (f === "pull.js" || running.has(f)) needReload.push(f);
    }
  }
  ns.tprint("pull: " + ok + " ok, " + miss + " missing, " + changed.length + " changed"
    + (changed.length ? "  [" + changed.join(", ") + "]" : ""));

  if (NOKILL) {
    if (needReload.length) ns.tprint("RELOAD to apply (these were running): " + needReload.join(", "));
    else ns.tprint("no reload needed -- changed files compile fresh on next run.");
  } else {
    // after a kill-all, every file is unlocked when written, so all changes land on disk now.
    // pull.js isn't in the list (can't self-update), so NO reload is needed at all.
    ns.tprint("ALL SCRIPTS KILLED + files updated on disk. No reload needed -- `run boot.js` to restart the stack."
      + " (To update pull.js itself, run update-pull.js.)");
  }
}

// BFS the network from home, returning all reachable hosts (incl. home).
function bfs(ns) {
  const seen = new Set(["home"]), q = ["home"], out = ["home"];
  while (q.length) {
    const c = q.shift();
    for (const n of ns.scan(c)) if (!seen.has(n)) { seen.add(n); q.push(n); out.push(n); }
  }
  return out;
}
