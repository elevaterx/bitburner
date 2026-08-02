/** lib/corp-logic.js -- pure Corporation decision logic. NO ns calls. Unit-tested.
 *  Scope of v1: the Agriculture money engine (create -> cities -> offices/jobs -> Smart Supply ->
 *  sell outputs -> level upgrades -> AdVert -> accept investment). Product (Tobacco) division and
 *  boost-material micro are the documented next layer. Constants below are v3.0.2 names. */

export const CORP_CITIES = ["Aevum", "Chongqing", "Sector-12", "New Tokyo", "Ishima", "Volhaven"];

/** Employee job ratios for an Agriculture office (sum = 1.0). */
const JOB_RATIOS = [
  ["Operations", 0.32],
  ["Engineer", 0.28],
  ["Management", 0.16],
  ["Business", 0.12],
  ["Research & Development", 0.12],
];

/** Upgrades to level, in priority order (only the affordable prefix is bought each pass). */
export const UPGRADE_PRIORITY = [
  "Smart Storage", "Smart Factories", "ABC SalesBots", "Wilson Analytics",
  "Nuoptimal Nootropic Injector Implants", "Speech Processor Implants",
  "Neural Accelerators", "FocusWires", "Project Insight",
];

export const DEFAULT_CORP_CFG = Object.freeze({
  corpName: "Bitrunner Industries",
  division: "Agriculture",
  officeStartSize: 3,
  upgradeBudgetFrac: 0.20,   // of funds per pass, spread across priority upgrades
  advertFundsFrac: 0.01,     // buy AdVert only when it costs <= this fraction of funds
  // Minimum investor cash to accept, by round. Heuristic -- tune to taste. Rounds beyond this are ignored.
  investThresholds: { 1: 2e11, 2: 5e12, 3: 2e14, 4: 2e15 },
});

/** Split `size` seats across jobs summing exactly to size (largest-remainder rounding). Pure. */
export function distributeJobs(size) {
  const out = {};
  for (const [job] of JOB_RATIOS) out[job] = 0;
  if (size <= 0) return out;

  const exact = JOB_RATIOS.map(([job, r]) => ({ job, want: r * size }));
  let assigned = 0;
  for (const e of exact) { out[e.job] = Math.floor(e.want); assigned += out[e.job]; }
  // Distribute the remainder to the largest fractional parts.
  const rema = size - assigned;
  exact.sort((a, b) => (b.want - Math.floor(b.want)) - (a.want - Math.floor(a.want)));
  for (let i = 0; i < rema; i++) out[exact[i % exact.length].job] += 1;
  return out;
}

/** Accept an investment offer if its round is configured and the cash meets the bar. Pure. */
export function shouldAcceptOffer(offer, cfg = DEFAULT_CORP_CFG) {
  if (!offer) return false;
  const min = cfg.investThresholds[offer.round];
  if (min == null) return false;
  return offer.funds >= min;
}

/** From a catalog of {name,cost}, the priority-ordered upgrades affordable within funds*budgetFrac,
 *  each leveled once this pass. Returns names in the order to buy. Pure. */
export function upgradesToLevel(catalog, funds, cfg = DEFAULT_CORP_CFG, priority = UPGRADE_PRIORITY) {
  const cost = Object.fromEntries(catalog.map((u) => [u.name, u.cost]));
  let budget = funds * cfg.upgradeBudgetFrac;
  const out = [];
  for (const name of priority) {
    const c = cost[name];
    if (c == null) continue;
    if (c <= budget) { out.push(name); budget -= c; }
  }
  return out;
}

/** Amount to bulk-buy to reach a target stock, given what's already stored. Pure. */
export function amountToReach(target, stored) {
  return Math.max(0, target - stored);
}
