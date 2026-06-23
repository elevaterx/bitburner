/** @param {NS} ns
 * Kill every farm/batch WORKER script across all hosts. Controllers (coordinator.js, hud.js,
 * bbatch.js) are NOT in the list, so this clears the field without stopping whatever you run next.
 * Use before an isolated batcher test so leftover workers don't corrupt the target's trajectory.
 *   run killfarm.js
 */
export async function main(ns) {
  const workers = ["h.js", "prep.js", "bhack.js", "bgrow.js", "bweaken.js", "bprep.js"];
  const seen = new Set(["home"]), q = ["home"], all = ["home"];
  while (q.length) { const c = q.shift(); for (const n of ns.scan(c)) if (!seen.has(n)) { seen.add(n); q.push(n); all.push(n); } }
  let killed = 0;
  for (const h of all) {
    if (!ns.hasRootAccess(h)) continue;
    for (const w of workers) if (ns.scriptKill(w, h)) killed++;
  }
  ns.tprint("killfarm: cleared workers on " + killed + " host/script pair(s)");
}
