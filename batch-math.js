/** Pure HWGW batch math. NO ns calls -> unit-testable in Node.
 * In-game, the per-thread security/percent values are read from ns/formulas and
 * passed IN here; this module only does the arithmetic and scheduling.
 *
 * Security deltas are stable Bitburner constants, used here only as test defaults;
 * the live batcher reads them via ns.hackAnalyzeSecurity / ns.growthAnalyzeSecurity
 * / ns.weakenAnalyze so it stays correct even if a version retunes them.
 */
export const HACK_SEC_PER_THREAD = 0.002;
export const GROW_SEC_PER_THREAD = 0.004;

// Hack threads to steal `fraction` (0..1) of current money.
// hackPctPerThread = fraction one thread steals (ns.hackAnalyze(target), or Formulas).
export function hackThreadsForFraction(fraction, hackPctPerThread) {
  if (!(hackPctPerThread > 0)) return 0;
  return Math.max(1, Math.floor(fraction / hackPctPerThread));
}

// After stealing `fraction`, money = (1-fraction)*max; grow must multiply by this.
export function growMultiplierAfterHack(fraction) {
  const remaining = 1 - fraction;
  if (remaining <= 0) return Infinity;
  return 1 / remaining;
}

// Weaken threads needed to remove a given security increase.
// weakenPerThread = security one weaken thread removes (ns.weakenAnalyze(1) on the exec host).
export function weakenThreadsForSecurity(secIncrease, weakenPerThread) {
  if (!(weakenPerThread > 0)) return 0;
  return Math.ceil(secIncrease / weakenPerThread);
}
export function weakenThreadsForHack(hackThreads, weakenPerThread, hackSec = HACK_SEC_PER_THREAD) {
  return weakenThreadsForSecurity(hackThreads * hackSec, weakenPerThread);
}
export function weakenThreadsForGrow(growThreads, weakenPerThread, growSec = GROW_SEC_PER_THREAD) {
  return weakenThreadsForSecurity(growThreads * growSec, weakenPerThread);
}

// Landing schedule. All four ops are exec'd together at t0; each op's completion is
// pushed out via additionalMsec so they FINISH in order H -> W1 -> G -> W2, `gap` ms apart,
// all after the longest natural op (weaken). weakenTime >= growTime >= hackTime always,
// so every returned additionalMsec is >= 0.
export function batchOffsets(weakenTime, growTime, hackTime, gap) {
  return {
    hack:    weakenTime + 1 * gap - hackTime,
    weaken1: 2 * gap,
    grow:    weakenTime + 3 * gap - growTime,
    weaken2: 4 * gap,
    batchDuration: weakenTime + 4 * gap,
  };
}

// Land time of an op = its natural duration + its additionalMsec. Helper for tests/diagnostics.
export function landTimes(weakenTime, growTime, hackTime, gap) {
  const o = batchOffsets(weakenTime, growTime, hackTime, gap);
  return {
    hack:    hackTime + o.hack,
    weaken1: weakenTime + o.weaken1,
    grow:    growTime + o.grow,
    weaken2: weakenTime + o.weaken2,
  };
}
