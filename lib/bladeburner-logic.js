/** lib/bladeburner-logic.js -- pure Bladeburner decision logic. NO ns calls. Unit-tested.
 *  Action TYPE strings (v3.0.2): "General", "Contracts", "Operations", "Black Operations".
 *  Success chances are read as [min,max]; we always gate on the MIN (pessimistic). */

export const DEFAULT_BB_CFG = Object.freeze({
  staminaFloor: 0.5,     // regen when current/max stamina drops below this
  chaosCeiling: 50,      // run Diplomacy when city chaos exceeds this
  successFloor: 0.8,     // only run ops/contracts with >= this min success chance
  blackOpChance: 0.95,   // only attempt the next Black Op at >= this min success chance
});

/** Choose the next action from a snapshot of Bladeburner state. Pure.
 *  state = {
 *    staminaPct, chaos, rank,
 *    nextBlackOp: {name, rank} | null,   blackOpChance: number,
 *    candidates: [{ type, name, countRemaining, chance, rankGain, time }]   // ops + contracts
 *  } */
export function chooseAction(state, cfg = DEFAULT_BB_CFG) {
  if (state.staminaPct < cfg.staminaFloor) return { type: "General", name: "Hyperbolic Regeneration Chamber" };
  if (state.chaos > cfg.chaosCeiling) return { type: "General", name: "Diplomacy" };

  const bo = state.nextBlackOp;
  if (bo && bo.rank <= state.rank && state.blackOpChance >= cfg.blackOpChance) {
    return { type: "Black Operations", name: bo.name };
  }

  const viable = (state.candidates || []).filter(
    (c) => c.countRemaining > 0 && c.chance >= cfg.successFloor && c.time > 0,
  );
  if (viable.length) {
    // Maximise rank gained per second of action time.
    const best = viable.reduce((a, b) => (b.rankGain / b.time > a.rankGain / a.time ? b : a));
    return { type: best.type, name: best.name };
  }
  // Nothing safe to run -> improve population estimates so success chances climb.
  return { type: "General", name: "Field Analysis" };
}

/** Largest integer n >= 0 such that cumulativeCostOf(n) <= budget AND the marginal cost of the nth
 *  level (cumulativeCostOf(n) - cumulativeCostOf(n-1)) <= marginalCeiling. Both cost curves are
 *  non-decreasing in n. Exponential probe then binary search -> O(log n) cost lookups instead of n,
 *  which is what lets the daemon drain a huge skill-point backlog in a bounded number of ns calls.
 *  Pure: cumulativeCostOf is any function of n. */
export function largestAffordableBatch(cumulativeCostOf, budget, marginalCeiling = Infinity) {
  const ok = (n) => {
    if (n <= 0) return true;
    const total = cumulativeCostOf(n);
    if (!(total <= budget)) return false;
    const marginal = total - cumulativeCostOf(n - 1);
    return marginal <= marginalCeiling;
  };
  if (!ok(1)) return 0;
  // Exponential search for an upper bound that fails.
  let hi = 1;
  while (ok(hi * 2)) {
    hi *= 2;
    if (hi > 1e9) break; // safety
  }
  // Binary search in (hi, hi*2] for the largest n that passes.
  let lo = hi;
  hi = hi * 2;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ok(mid)) lo = mid; else hi = mid - 1;
  }
  return lo;
}
