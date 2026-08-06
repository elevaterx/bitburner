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
  // RAISED from 0.01. AdVert level 1 costs ~$1e9, so a 1% gate required $100b of funds before it
  // would EVER fire -- and it is adverts that drive awareness/popularity -> demand -> revenue.
  // No adverts meant no revenue growth meant funds never reached $100b: a self-locking deadlock.
  // Observed live: 13 h into BN3, adverts 0 and profit flat at $23.8k/s.
  advertFundsFrac: 0.25,     // buy AdVert when it costs <= this fraction of funds
  // Warehouse growth. corp.js purchased a warehouse per city and then NEVER upgraded it, so all six
  // sat at level 1 (size = level * 100 * storageMults) and hit 100% full. A full warehouse silently
  // stalls production -- output has nowhere to go, revenue flatlines, and nothing errors.
  warehouseFillTrigger: 0.85,  // upgrade once this full
  warehouseBudgetFrac: 0.35,   // of funds per pass, normal operation
  // When warehouses are full, EVERYTHING else is downstream of them -- production is capped, so
  // office seats, AdVert and corp upgrades are all buying capacity that cannot be used. Observed
  // live: funds hovered at ~$500m for hours while offices grew and warehouses stayed pegged at
  // 100%, because the other ensures kept draining the treasury below the $1.14b an upgrade costs.
  // Under stall, warehouses get first claim and the rest stand down until the jam clears.
  warehouseStallBudgetFrac: 0.80,
  // Office growth. The old code pinned office size to officeStartSize forever, so every city ran
  // 3 seats -- and distributeJobs(3) across five roles leaves R&D at 0, which is why research
  // stayed at 0 all node.
  officeMaxSize: 30,
  officeGrowthFrac: 0.15,      // of funds per pass, across all cities
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

// ---------------------------------------------------------------------------
// Product division (corp v2 -- Tobacco). Pure lifecycle logic.
// ---------------------------------------------------------------------------

export const PRODUCT_INDUSTRY = "Tobacco";
export const PRODUCT_DIVISION = "Tobacco";
export const PRODUCT_HQ = "Aevum";           // products are designed in one city, sold everywhere
export const PRODUCT_PREFIX = "Prod";

/** Research to buy, in priority order (Lab first -- it multiplies research; then the TA pricing pair). */
export const RESEARCH_PRIORITY = ["Hi-Tech R&D Laboratory", "Market-TA.I", "Market-TA.II"];

/** Next unused product name, e.g. "Prod-0", "Prod-1", ... derived from existing names. Pure. */
export function nextProductName(existingNames, prefix = PRODUCT_PREFIX) {
  let max = -1;
  for (const n of existingNames) {
    const m = /-(\d+)$/.exec(n);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return prefix + "-" + (max + 1);
}

/** The product with the lowest effectiveRating (the churn candidate). Pure. */
export function lowestRated(products) {
  return products.reduce((w, p) => (!w || p.effectiveRating < w.effectiveRating ? p : w), null);
}

/** Decide the next product action given current products and the division's product cap. Pure.
 *  products: [{ name, developmentProgress, effectiveRating }]. Returns one of:
 *    { action: "wait", name }                       -- a product is still being designed
 *    { action: "make", name }                       -- room for another product
 *    { action: "replace", discontinue, make }        -- at cap: churn the weakest for a fresh one */
export function planProduct(products, maxProducts) {
  const developing = products.find((p) => p.developmentProgress < 100);
  if (developing) return { action: "wait", name: developing.name };
  const names = products.map((p) => p.name);
  if (products.length < maxProducts) return { action: "make", name: nextProductName(names) };
  const worst = lowestRated(products);
  return { action: "replace", discontinue: worst.name, make: nextProductName(names) };
}

/** Cost to raise a warehouse from `level` by `n` levels.
 *  Actions.ts:420 -- sum of warehouseSizeUpgradeCostBase * 1.07^(level+1+i), base 1e9. Pure. */
export function warehouseUpgradeCost(level, n, base = 1e9) {
  if (!(n > 0) || !Number.isFinite(level)) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) total += base * Math.pow(1.07, level + 1 + i);
  return total;
}

/** How many warehouse levels to buy now. Returns 0 unless the warehouse is actually constrained --
 *  upgrading a half-empty warehouse buys nothing, since size only matters when it is the binding
 *  limit. Budget is a hard ceiling, so this never drains the treasury below what other ensures need.
 *  Pure. */
export function warehouseLevelsToBuy(wh, budget, cfg = DEFAULT_CORP_CFG) {
  if (!wh || !(wh.size > 0) || !(budget > 0)) return 0;
  if (wh.sizeUsed / wh.size < cfg.warehouseFillTrigger) return 0;
  let n = 0;
  while (warehouseUpgradeCost(wh.level, n + 1) <= budget) n++;
  return n;
}

/** Target office size given funds. Grows toward officeMaxSize but never faster than the budget
 *  allows. upgradeOfficeSize cost rises with size, so this asks for one step at a time and lets
 *  the next pass continue -- simpler and safer than solving the whole ramp at once. Pure. */
export function officeTarget(currentSize, funds, cfg = DEFAULT_CORP_CFG) {
  const max = cfg.officeMaxSize ?? 30;
  if (currentSize >= max) return currentSize;
  // grow in steps of 3 (one seat per job role) while the growth budget is non-trivial
  const budget = funds * (cfg.officeGrowthFrac ?? 0);
  if (budget < 1e9) return currentSize;
  return Math.min(max, currentSize + 3);
}

/** Is any city's warehouse at or past the fill trigger? While true the division is production-capped
 *  and spending anywhere else is buying capacity that cannot be used. Pure.
 *  `cities` is the per-city shape emitted to corp-data.txt: { whUsed, whSize }. */
export function warehouseStalled(cities, cfg = DEFAULT_CORP_CFG) {
  if (!Array.isArray(cities) || !cities.length) return false;
  return cities.some((ct) => ct && ct.whSize > 0 && ct.whUsed / ct.whSize >= cfg.warehouseFillTrigger);
}
