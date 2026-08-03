/** xpg -- XP grow worker. Loops grow() on one target.
 *
 *  Two jobs at once:
 *   1. XP. grow() grants the full calculateHackingExpGain * threads unconditionally
 *      (NetscriptFunctions.ts:291-300) -- even at max money, even if nothing grew.
 *   2. Re-arming the hack workers. calculateGrowMoney does `moneyAvailable += threads`
 *      BEFORE applying multiplicative growth (formulas/grow.ts:46), so any grow op
 *      restores a non-zero balance from exactly $0. That is what keeps xph.js workers
 *      out of the 25% failure-XP tier.
 *
 *  Thread count is almost irrelevant for job 2 -- the balance only has to be non-zero,
 *  not large -- so xpfarm runs several SMALL staggered grow instances per host rather
 *  than one big one. What matters is how OFTEN a grow completes, not how much it grows.
 *
 *  RAM/thread: 1.60 (base) + 0.15 (ns.grow) = 1.75GB.
 *
 *  usage: run xpg.js <target> [staggerMs]
 *  @param {NS} ns */
export async function main(ns) {
    const t = ns.args[0];
    if (!t) return;
    const stagger = Number(ns.args[1]) || 0;
    if (stagger > 0) await ns.sleep(stagger);
    while (true) await ns.grow(t);
}
