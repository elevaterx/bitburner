/** xph -- XP hack worker. Loops hack() on one target purely for hacking XP.
 *
 *  WHY hack AND NOT grow/weaken: hack(), grow() and weaken() all call the SAME
 *  calculateHackingExpGain (v3.0.2 Hacking.ts:30) -- identical XP per thread per op --
 *  but growTime = 3.2 * hackTime and weakenTime = 4 * hackTime (Hacking.ts:84,91).
 *  So hack() is 3.2x the XP/sec of a grow worker and 4x a weaken worker.
 *
 *  WHY THIS SCALES: NetscriptHelpers.tsx:667 fortifies by
 *      0.002 * Math.min(threads, maxThreadNeeded)
 *  -- the security cost of a hack is capped at the threads that were actually useful --
 *  while line 618 grants exp for the FULL uncapped thread count. A 200,000-thread hack
 *  on a small server therefore pays the security cost of ~600 threads.
 *
 *  DELIBERATELY MINIMAL: hack() only, no state reads, so RAM/thread is
 *  1.60 (base) + 0.10 (ns.hack) = 1.70GB, vs 2.10GB for the old grow/weaken xp.js.
 *  Keeping security at min and the balance non-zero is xpfarm.js's job -- the controller
 *  pays those API costs once instead of once per thread.
 *
 *  CAVEAT: NetscriptHelpers.tsx:639 downgrades a successful hack to the 25% "failure"
 *  XP tier if the balance is EXACTLY $0 when the op lands. moneyDrained is a raw float
 *  (no Math.floor in v3.0.2), so any non-zero balance -- even a fraction of a cent --
 *  pays full XP. xpfarm keeps staggered xpg.js grow workers alive so that never persists;
 *  grow() adds `threads` dollars before multiplying (formulas/grow.ts:46), so it re-arms
 *  the target even from exactly zero.
 *
 *  usage: run xph.js <target> [staggerMs]
 *  @param {NS} ns */
export async function main(ns) {
    const t = ns.args[0];
    if (!t) return;
    const stagger = Number(ns.args[1]) || 0;
    if (stagger > 0) await ns.sleep(stagger);
    while (true) await ns.hack(t);
}
